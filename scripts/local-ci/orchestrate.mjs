// Orchestrator behind scripts/local-ci.sh. Plain dependency-free ESM: it must run before `npm ci` and keep
// running while `npm ci` replaces node_modules. See docs/LOCAL_CI.md for the contract.
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { scanEvidence, writeEvidenceManifest } from "./evidence.mjs";

const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "..", ".."));
const jobsScript = join(root, "scripts", "local-ci", "jobs.sh");

const runIdPattern = /^[a-z0-9][a-z0-9-]{6,46}[a-z0-9]$/;
const shaPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const terminationGraceMs = 30_000;

const validations = ["clean-install", "alpha21-upgrade-rollback", "beta1-upgrade-rollback", "beta2-upgrade-rollback", "beta3-upgrade-rollback", "beta4-upgrade-rollback", "beta5-upgrade-rollback", "beta6-upgrade-rollback"];
const nativeSubjobs = validations.map((validation) => `native-${validation}`);
const officialSubjobs = validations.map((validation) => `official-${validation}`);
const verifySubjobs = ["audit", "verify-release", "container-scan", ...nativeSubjobs, "codeql"];

// Gates run first, in order; a failed gate skips everything after it. Gates always run for their mode.
const modes = {
  verify: { gates: [], subjobs: verifySubjobs, required: [] },
  "release-check": { gates: ["release-source", "release-policy"], subjobs: verifySubjobs, required: ["LOCAL_CI_SOURCE_SHA", "LOCAL_CI_MAIN_SHA"] },
  "candidate-check": {
    gates: ["candidate-source", "anonymous-pull", "attestation"],
    subjobs: [...officialSubjobs, "supply-chain"],
    required: ["LOCAL_CI_SOURCE_SHA", "LOCAL_CI_MAIN_SHA", "LOCAL_CI_CANDIDATE_DIGEST"]
  },
  "release-build": { gates: ["release-source", "release-policy"], subjobs: ["release-image"], required: ["LOCAL_CI_SOURCE_SHA", "LOCAL_CI_MAIN_SHA"] },
  "scheduled-security": { gates: [], subjobs: ["dependency-audit", "container-scan"], required: [] },
  // Standalone CodeQL for the weekly schedule: the existing subjob as a complete mode. It creates no
  // Docker resources, so it needs no Docker cleanup.
  codeql: { gates: [], subjobs: ["codeql"], required: [], dockerResources: false },
  cleanup: { gates: [], subjobs: [], required: [] }
};

const needsInstall = new Set(["verify-release", ...nativeSubjobs, ...officialSubjobs]);

const deadlineSeconds = (name) => {
  if (name === "install" || name === "audit" || name === "dependency-audit" || name === "cleanup") return 600;
  if (name.endsWith("-source") || name === "release-policy" || name === "anonymous-pull" || name === "attestation") return 300;
  if (name === "codeql") return 1200;
  if (name.startsWith("native-") && name !== "native-image") return 2700;
  if (name.startsWith("official-")) return 2700;
  if (name === "release-image") return 3600;
  return 1800;
};

const forwardedEnvironment = [
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "LC_MESSAGES", "TZ", "TMPDIR", "DOCKER_CONFIG",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "npm_config_cache", "NPM_CONFIG_CACHE", "XDG_CACHE_HOME", "TRIVY_CACHE_DIR", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"
];

const refuse = (message) => {
  process.stderr.write(`local-ci: ${message}\n`);
  process.exit(2);
};

const now = () => new Date().toISOString();

const printUsage = () => {
  const lines = ["usage: scripts/local-ci.sh <mode> [subjob ...]", "       scripts/local-ci.sh list [mode]", ""];
  for (const [name, mode] of Object.entries(modes)) lines.push(`${name}: ${[...mode.gates, ...mode.subjobs].join(" ") || "(no subjobs)"}`);
  process.stdout.write(`${lines.join("\n")}\n`);
};

const [modeName, ...requestedSubjobs] = process.argv.slice(2);
if (modeName === "list" || modeName === "--help" || modeName === "-h") {
  printUsage();
  process.exit(0);
}
if (!modeName || !Object.hasOwn(modes, modeName)) refuse(`unknown mode ${JSON.stringify(modeName ?? "")}; run scripts/local-ci.sh list`);
const mode = modes[modeName];
const selectable = new Set(mode.subjobs);
for (const name of requestedSubjobs) {
  if (!selectable.has(name) && !mode.gates.includes(name)) refuse(`unknown ${modeName} subjob ${JSON.stringify(name)}`);
}
const selected = requestedSubjobs.length === 0 ? [...mode.subjobs] : mode.subjobs.filter((name) => requestedSubjobs.includes(name));
const complete = selected.length === mode.subjobs.length;

const environment = process.env;
const runId = environment.LOCAL_CI_RUN_ID ?? "";
if (!runIdPattern.test(runId)) refuse("LOCAL_CI_RUN_ID must be 8-48 lowercase letters, digits or hyphens, starting and ending with a letter or digit");
for (const name of mode.required) if (!environment[name]) refuse(`${name} is required for ${modeName}`);
const suppliedSha = environment.LOCAL_CI_SOURCE_SHA || "";
if (suppliedSha && !shaPattern.test(suppliedSha)) refuse("LOCAL_CI_SOURCE_SHA must be a full lowercase commit SHA");
const mainSha = environment.LOCAL_CI_MAIN_SHA || "";
if (mainSha && !shaPattern.test(mainSha)) refuse("LOCAL_CI_MAIN_SHA must be a full lowercase commit SHA");
const candidateDigest = environment.LOCAL_CI_CANDIDATE_DIGEST || "";
if (candidateDigest && !digestPattern.test(candidateDigest)) refuse("LOCAL_CI_CANDIDATE_DIGEST must be sha256:<64 lowercase hex>");
const inputFiles = {};
for (const name of ["LOCAL_CI_ATTESTATION_BUNDLE", "LOCAL_CI_SIGNED_STATEMENT", "LOCAL_CI_SIGNATURE_BUNDLE"]) {
  const value = environment[name] || "";
  if (!value) continue;
  if (!isAbsolute(value) || !existsSync(value) || !statSync(value).isFile()) refuse(`${name} must be an absolute path to an existing file`);
  const resolved = realpathSync(value);
  if (resolved === root || resolved.startsWith(`${root}${sep}`)) refuse(`${name} must be outside the source checkout`);
  inputFiles[name] = resolved;
}
let timeoutOverride = 0;
if (environment.LOCAL_CI_SUBJOB_TIMEOUT_SECONDS !== undefined && environment.LOCAL_CI_SUBJOB_TIMEOUT_SECONDS !== "") {
  const value = environment.LOCAL_CI_SUBJOB_TIMEOUT_SECONDS;
  if (!/^[0-9]{1,5}$/.test(value) || Number(value) < 1 || Number(value) > 14_400) refuse("LOCAL_CI_SUBJOB_TIMEOUT_SECONDS must be an integer from 1 to 14400");
  timeoutOverride = Number(value);
}

// Evidence directory: absolute, outside the checkout after resolving symlinks, absent or empty.
const evidenceInput = environment.LOCAL_CI_EVIDENCE_DIR ?? "";
if (!evidenceInput || !isAbsolute(evidenceInput)) refuse("LOCAL_CI_EVIDENCE_DIR must be an absolute path");
const resolveThroughExisting = (path) => {
  let existing = path;
  const remainder = [];
  while (!existsSync(existing)) {
    remainder.unshift(basename(existing));
    const parent = dirname(existing);
    if (parent === existing) break;
    existing = parent;
  }
  return join(realpathSync(existing), ...remainder);
};
const evidenceResolved = resolveThroughExisting(resolve(evidenceInput));
if (evidenceResolved === root || evidenceResolved.startsWith(`${root}${sep}`)) refuse("LOCAL_CI_EVIDENCE_DIR must be outside the source checkout");
if (existsSync(evidenceResolved)) {
  if (!lstatSync(evidenceResolved).isDirectory()) refuse("LOCAL_CI_EVIDENCE_DIR must be a directory");
  if (readdirSync(evidenceResolved).length > 0) refuse("LOCAL_CI_EVIDENCE_DIR must be empty");
} else {
  mkdirSync(evidenceResolved, { recursive: true, mode: 0o700 });
}
const evidenceDir = evidenceResolved;
mkdirSync(join(evidenceDir, "logs"), { mode: 0o700 });

const startedAt = now();
const gitEnvironment = { PATH: environment.PATH ?? "", HOME: environment.HOME ?? "", LANG: "C" };
const git = (...args) => {
  const result = spawnSync("git", args, { cwd: root, env: gitEnvironment, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: result.status === 0, stdout: (result.stdout ?? "").trim() };
};

const writeAtomic = (path, value) => {
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
};

const nodeMajor = Number(process.versions.node.split(".")[0]);
const host = { platform: process.platform, arch: process.arch, node: process.version };
const source = { headSha: null, suppliedSha: suppliedSha || null, clean: false, mainSha: mainSha || null };
const records = [];
let finalStatus = "passed";
let finalReason = null;

const finish = async (status, reason, exitCode, cleanup) => {
  const scan = await scanEvidence(evidenceDir);
  const manifest = writeEvidenceManifest(evidenceDir, runId);
  const gatingBlockers = [];
  if (!suppliedSha) gatingBlockers.push("source_sha_not_supplied");
  if (!complete) gatingBlockers.push("partial_subjob_selection");
  if (nodeMajor !== 24) gatingBlockers.push("node_major_not_24");
  let effectiveStatus = status;
  let effectiveExit = exitCode;
  if (status === "passed" && (cleanup.status !== "passed" || scan.status !== "passed")) {
    effectiveStatus = "failed";
    effectiveExit = 1;
  }
  writeAtomic(join(evidenceDir, "result.json"), {
    schemaVersion: "moodarr-local-ci-result-v1",
    runId,
    mode: modeName,
    status: effectiveStatus,
    reason,
    exitCode: effectiveExit,
    complete,
    gating: effectiveStatus === "passed" && gatingBlockers.length === 0,
    gatingBlockers,
    startedAt,
    finishedAt: now(),
    source,
    host,
    selectedSubjobs: selected,
    subjobs: records,
    cleanup,
    evidenceScan: scan,
    evidenceManifestSha256: manifest
  });
  process.stdout.write(`local-ci: ${modeName} ${effectiveStatus}${reason ? ` (${reason})` : ""}; result.json written\n`);
  process.exit(effectiveExit);
};

const refuseWithRecord = async (reason) => {
  process.stderr.write(`local-ci: refused: ${reason}\n`);
  await finish("refused", reason, 2, { status: "passed", reason: "no subjob ran" });
};

// Source identity. A supplied SHA makes this a gating candidate, which also requires a clean tree.
const topLevel = git("rev-parse", "--show-toplevel");
if (!topLevel.ok || realpathSync(topLevel.stdout) !== root) await refuseWithRecord("the entrypoint is not at the root of a Git checkout");
const head = git("rev-parse", "HEAD");
if (!head.ok || !shaPattern.test(head.stdout)) await refuseWithRecord("HEAD does not resolve to a full commit SHA");
source.headSha = head.stdout;
const status = git("status", "--porcelain=v1", "--untracked-files=all");
source.clean = status.ok && status.stdout === "";
if (suppliedSha && suppliedSha !== source.headSha) await refuseWithRecord("LOCAL_CI_SOURCE_SHA does not match HEAD");
if (suppliedSha && !source.clean) await refuseWithRecord("the checkout has modified or untracked files");
if (nodeMajor < 24) await refuseWithRecord("Node.js 24 or newer is required");

writeFileSync(join(evidenceDir, "run.json"), `${JSON.stringify({
  schemaVersion: "moodarr-local-ci-run-v1",
  runId,
  mode: modeName,
  startedAt,
  selectedSubjobs: selected,
  complete,
  source,
  host
}, null, 2)}\n`, { mode: 0o600 });

const workDir = mkdtempSync(join(tmpdir(), `moodarr-local-ci-${runId}-`));

const childEnvironment = (name) => {
  const env = {};
  for (const key of forwardedEnvironment) if (environment[key] !== undefined) env[key] = environment[key];
  Object.assign(env, {
    CI: "true",
    LCI_RUN_ID: runId,
    LCI_MODE: modeName,
    LCI_SUBJOB: name,
    LCI_SUBJOB_DIR: join(evidenceDir, name),
    LCI_EVIDENCE_DIR: evidenceDir,
    LCI_WORK_DIR: workDir,
    LCI_SOURCE_SHA: source.headSha,
    LCI_MAIN_SHA: mainSha,
    LCI_CANDIDATE_DIGEST: candidateDigest,
    LCI_ATTESTATION_BUNDLE: inputFiles.LOCAL_CI_ATTESTATION_BUNDLE ?? "",
    LCI_SIGNED_STATEMENT: inputFiles.LOCAL_CI_SIGNED_STATEMENT ?? "",
    LCI_SIGNATURE_BUNDLE: inputFiles.LOCAL_CI_SIGNATURE_BUNDLE ?? ""
  });
  return env;
};

let current = null;
let cancelSignal = null;
let acceptingSignals = true;
const signalNumbers = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 };

const killGroup = (child, signal) => {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group has already exited.
  }
};

const runSubjob = async (name, { cancellable = true } = {}) => {
  const subjobDir = join(evidenceDir, name);
  mkdirSync(subjobDir, { recursive: true, mode: 0o700 });
  const log = join(evidenceDir, "logs", `${name}.log`);
  const descriptor = openSync(log, "a", 0o600);
  const record = { name, status: "running", reason: null, exitCode: null, startedAt: now(), finishedAt: null, durationSeconds: null, log: `logs/${name}.log` };
  process.stdout.write(`local-ci: ${name} started\n`);
  const started = Date.now();
  const child = spawn("bash", [jobsScript, name], { cwd: root, env: childEnvironment(name), stdio: ["ignore", descriptor, descriptor], detached: true });
  closeSync(descriptor);
  current = child;
  let timedOut = false;
  let graceTimer = null;
  const deadline = setTimeout(() => {
    timedOut = true;
    killGroup(child, "SIGTERM");
    graceTimer = setTimeout(() => killGroup(child, "SIGKILL"), terminationGraceMs);
  }, (timeoutOverride || deadlineSeconds(name)) * 1000);
  let code = null;
  let signal = null;
  let spawnError = null;
  try {
    [code, signal] = await once(child, "exit");
  } catch (error) {
    spawnError = error instanceof Error ? error.message : String(error);
  }
  clearTimeout(deadline);
  if (graceTimer) clearTimeout(graceTimer);
  // Stop anything the subjob left running in its process group.
  killGroup(child, "SIGKILL");
  current = null;
  record.exitCode = code;
  record.finishedAt = now();
  record.durationSeconds = Math.round((Date.now() - started) / 100) / 10;
  if (cancellable && cancelSignal) Object.assign(record, { status: "cancelled", reason: `cancelled by ${cancelSignal}` });
  else if (spawnError) Object.assign(record, { status: "failed", reason: "subjob could not start" });
  else if (timedOut) Object.assign(record, { status: "failed", reason: "timeout" });
  else if (code === 0) record.status = "passed";
  else Object.assign(record, { status: "failed", reason: signal ? `signal ${signal}` : `exit ${code}` });
  try {
    rmdirSync(subjobDir);
  } catch {
    // Keep subjob directories that contain evidence.
  }
  process.stdout.write(`local-ci: ${name} ${record.status}${record.reason ? ` (${record.reason})` : ""}\n`);
  return record;
};

const onSignal = (signal) => {
  if (!acceptingSignals || cancelSignal) return;
  cancelSignal = signal;
  process.stdout.write(`local-ci: received ${signal}; stopping the active subjob\n`);
  if (current) {
    const child = current;
    killGroup(child, "SIGTERM");
    setTimeout(() => killGroup(child, "SIGKILL"), terminationGraceMs).unref();
  }
};
for (const signal of Object.keys(signalNumbers)) process.on(signal, () => onSignal(signal));

const plan = [];
for (const gate of mode.gates) plan.push({ name: gate, gate: true });
if (selected.some((name) => needsInstall.has(name))) plan.push({ name: "install", prerequisite: "install" });
let nativeImagePlanned = false;
for (const name of selected) {
  if (name.startsWith("native-") && !nativeImagePlanned) {
    plan.push({ name: "native-image", prerequisite: "native-image" });
    nativeImagePlanned = true;
  }
  plan.push({ name });
}

let blockedBy = null;
const failedPrerequisites = new Set();
for (const step of plan) {
  if (cancelSignal) {
    records.push({ name: step.name, status: "cancelled", reason: `cancelled by ${cancelSignal}`, exitCode: null, log: null });
    continue;
  }
  const dependency = blockedBy
    ?? (failedPrerequisites.has("install") && needsInstall.has(step.name) ? "install" : null)
    ?? (failedPrerequisites.has("native-image") && step.name.startsWith("native-") ? "native-image" : null);
  if (dependency) {
    records.push({ name: step.name, status: "skipped", reason: `prerequisite ${dependency} did not pass`, exitCode: null, log: null });
    continue;
  }
  const record = await runSubjob(step.name);
  records.push(record);
  if (record.status !== "passed") {
    if (step.gate) blockedBy = step.name;
    if (step.prerequisite) failedPrerequisites.add(step.prerequisite);
  }
}

// Cleanup always runs, even after cancellation, and later signals no longer interrupt it.
acceptingSignals = false;
const cancelledBy = cancelSignal;
const cleanupRecord = mode.dockerResources === false
  ? { status: "passed", reason: "this mode creates no Docker resources", log: null }
  : await runSubjob("cleanup", { cancellable: false });
rmSync(workDir, { recursive: true, force: true });
const cleanup = { status: cleanupRecord.status, reason: cleanupRecord.reason, log: cleanupRecord.log };

if (cancelledBy) {
  finalStatus = "cancelled";
  finalReason = `cancelled by ${cancelledBy}`;
  await finish(finalStatus, finalReason, 128 + signalNumbers[cancelledBy], cleanup);
}
if (records.some((record) => record.status !== "passed")) {
  finalStatus = "failed";
  finalReason = records.filter((record) => record.status !== "passed").map((record) => `${record.name}: ${record.status}`).join(", ");
}
await finish(finalStatus, finalReason, finalStatus === "passed" ? 0 : 1, cleanup);
