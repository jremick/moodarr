import { execFileSync, spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildSafeReport, requiredInstallModeCheckCodes, beta3UpgradeCheckCodes, beta3UpgradeIdentity, beta4UpgradeCheckCodes, beta4UpgradeIdentity, beta5UpgradeCheckCodes, beta5UpgradeIdentity, beta6UpgradeCheckCodes, beta6UpgradeIdentity, beta7UpgradeCheckCodes, beta7UpgradeIdentity } from "../scripts/validate-beta-install";

// End-to-end runs of scripts/local-ci.sh in a throwaway Git checkout. Node, Git, jq and Bash are real;
// Docker, npm, Trivy, CodeQL and gh are replaced by recording fakes so no container or network call runs.

type Json = Record<string, any>;

const root = process.cwd();
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const scratch = mkdtempSync(join(tmpdir(), "moodarr-local-ci-e2e-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const runId = "e2e-fixture-0001";
const otherRunTag = "moodarr-local-ci:other-run-00000001-scan";
const sentinelTag = "moodarr:sentinel";
const tokenLike = ["gh", "p_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"].join("");

let sequence = 0;
const freshDirectory = (prefix: string) => mkdtempSync(join(scratch, `${prefix}-${sequence++}-`));

const writeExecutable = (path: string, contents: string) => {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
};

const git = (repo: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], {
  cwd: repo,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
}).trim();

const commitAll = (repo: string, message: string) => {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
};

const createRepo = (adjust?: (repo: string) => void) => {
  const repo = freshDirectory("repo");
  for (const path of ["scripts", ".vex", ".github/release-revocations.json", ".github/release-trust.json", ".github/release-signers", "package.json", ".gitignore", "CHANGELOG.md", "README.md", "SECURITY.md", "SUPPORT.md", "docs/UNRAID.md", "docs/RELEASE.md", "docs/COMPATIBILITY.md"]) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    cpSync(join(root, path), join(repo, path), { recursive: true });
  }
  symlinkSync(join(root, "node_modules"), join(repo, "node_modules"));
  adjust?.(repo);
  git(repo, "-c", "init.defaultBranch=main", "init", "-q");
  const sha = commitAll(repo, "fixture");
  return { repo, sha };
};

const nativePlatform = { endpointLocalUnix: true, dockerClientVersion: "28.3.0", dockerServerVersion: "28.3.0", composeVersion: "2.38.2", daemonOs: "linux", daemonArch: "x86_64", imageOs: "linux", imageArch: "amd64", native: true };
const passingMode = () => ({ passed: true, checkCodes: [...requiredInstallModeCheckCodes], counts: { lifecycles: 3, plexItems: 2, seerrItems: 3, searchResults: 1, posterBytes: 68, stubCalls: 35 }, failures: [], incomplete: [] });
const rehearsalCleanInstall = (sha: string) => buildSafeReport({
  official: false,
  expectedVersion: version,
  expectedRevision: sha,
  sourceHashes: { harness: "1".repeat(64), bundle_policy: "2".repeat(64), stub: "3".repeat(64), compose: "4".repeat(64) },
  platform: nativePlatform,
  docker: passingMode(),
  compose: passingMode(),
  releaseEligible: false,
  incomplete: []
});
const rehearsalBeta5 = (sha: string) => ({
  schema: "moodarr-beta5-upgrade-v1",
  passed: true,
  releaseEligible: false,
  sourceHashes: { harness: "1".repeat(64), bundlePolicy: "2".repeat(64), stub: "3".repeat(64), compose: "4".repeat(64) },
  platform: nativePlatform,
  baseline: { ...beta5UpgradeIdentity },
  candidate: { image: `moodarr-local-ci:${runId}-native`, version, revision: sha },
  archiveSha256: "6".repeat(64),
  checks: [...beta5UpgradeCheckCodes],
  lifecycle: passingMode(),
  incomplete: ["local_image_rehearsal"]
});

type Fakes = { bin: string; scenario: string; state: string };

const installFakes = (options: { trivy?: boolean } = {}): Fakes => {
  const bin = freshDirectory("fakes");
  const scenario = join(bin, "scenario");
  const state = join(bin, "state");
  mkdirSync(scenario);
  mkdirSync(join(state, "images"), { recursive: true });
  mkdirSync(join(state, "volumes"));
  mkdirSync(join(state, "active"));
  const toolBin = join(bin, "tools");
  mkdirSync(toolBin);
  symlinkSync(process.execPath, join(toolBin, "node"));
  for (const tag of [sentinelTag, otherRunTag]) writeFileSync(join(state, "images", tag.replace(/[/:@]/g, "_")), `${version}\n${"0".repeat(40)}\nnone\nnone\n`);
  writeExecutable(join(bin, "docker"), `#!/usr/bin/env bash
set -u
here="$(cd "$(dirname "$0")" && pwd)"
scenario="$here/scenario"
state="$here/state"
printf '%s\\n' "$*" >> "$here/docker.calls"
key() { printf '%s' "$1" | tr '/:@' '___'; }
case "\${1:-}" in
  build)
    shift
    tag=""; version=""; revision=""; ai=""; tmdb=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --tag|-t) tag="$2"; shift 2 ;;
        --build-arg)
          case "$2" in
            MOODARR_VERSION=*) version="\${2#*=}" ;;
            MOODARR_BUILD_REVISION=*) revision="\${2#*=}" ;;
            MOODARR_BUILD_AI_PROVIDER_POLICY=*) ai="\${2#*=}" ;;
            MOODARR_BUILD_TMDB_CONTENT_POLICY=*) tmdb="\${2#*=}" ;;
          esac
          shift 2 ;;
        *) shift ;;
      esac
    done
    if [ -f "$scenario/revision-label" ]; then revision="$(cat "$scenario/revision-label")"; fi
    printf '%s\\n%s\\n%s\\n%s\\n' "$version" "$revision" "$ai" "$tmdb" > "$state/images/$(key "$tag")" ;;
  image)
    case "\${2:-}" in
      inspect)
        shift 2; format=""
        if [ "\${1:-}" = "--format" ]; then format="$2"; shift 2; fi
        file="$state/images/$(key "$1")"
        [ -f "$file" ] || { echo "No such image: $1" >&2; exit 1; }
        case "$format" in
          "{{.Id}}") echo "sha256:$(printf '%064d' 7)" ;;
          "{{.Os}}") echo linux ;;
          "{{.Architecture}}") echo amd64 ;;
          *org.opencontainers.image.version*) sed -n 1p "$file" ;;
          *org.opencontainers.image.revision*) sed -n 2p "$file" ;;
          *io.moodarr.ai-provider-policy*) sed -n 3p "$file" ;;
          *io.moodarr.tmdb-content-policy*) sed -n 4p "$file" ;;
          *) echo "unexpected inspect format: $format" >&2; exit 64 ;;
        esac ;;
      rm) rm -f "$state/images/$(key "$3")" ;;
      *) echo "unexpected fake docker image invocation: $*" >&2; exit 64 ;;
    esac ;;
  ps|volume|network)
    kind="$1"; if [ "$kind" = ps ]; then kind=container; fi
    if [ "$kind" = volume ] && [ "\${2:-}" = inspect ]; then
      shift 2; if [ "\${1:-}" = --format ]; then shift 2; fi
      [ -f "$state/volumes/$1" ] || exit 1
      cut -d= -f2 "$state/volumes/$1"
      exit 0
    fi
    if [ "$kind" = volume ] && [ "\${2:-}" = rm ]; then
      shift 2; if [ "\${1:-}" = -- ]; then shift; fi
      rm "$state/volumes/$1"
      exit 0
    fi
    filter=""
    while [ $# -gt 0 ]; do
      if [ "$1" = --filter ]; then filter="\${2#label=}"; shift 2; else shift; fi
    done
    if [ "$kind" = volume ]; then
      for resource in "$state/volumes/"*; do
        [ -f "$resource" ] || continue
        owner="$(cat "$resource")"
        if [ "$owner" = "$filter" ] || [ "\${owner%%=*}" = "$filter" ]; then basename "$resource"; fi
      done
    fi
    if [ -f "$scenario/leftover-$kind" ]; then cat "$scenario/leftover-$kind"; fi ;;
  info) echo "linux/x86_64" ;;
  buildx)
    case "\${2:-}" in
      inspect) [ -f "$state/builder-$3" ] || exit 1 ;;
      rm) rm -f "$state/builder-$3" ;;
      *) echo "unexpected fake buildx invocation: $*" >&2; exit 64 ;;
    esac ;;
  *) echo "unexpected fake docker invocation: $*" >&2; exit 64 ;;
esac
`);
  writeExecutable(join(bin, "npm"), `#!/usr/bin/env bash
set -u
here="$(cd "$(dirname "$0")" && pwd)"
scenario="$here/scenario"
printf '%s\\n' "$*" >> "$here/npm.calls"
name="$1"
if [ "$1" = run ]; then shift; if [ "\${1:-}" = --silent ]; then shift; fi; name="run-$1"; fi
case "$name" in
  run-validate:*)
    resource="$(printf '%s' "$name" | tr ':' '-')"
    owner="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0,36))' "$name")"
    printf 'io.moodarr.beta-install.owner=%s\\n' "$owner" > "$here/state/volumes/$resource"
    if [ -n "\${LCI_RESOURCE_OWNERS_FILE:-}" ]; then
      printf '{"label":"io.moodarr.beta-install.owner","owner":"%s"}\\n' "$owner" >> "$LCI_RESOURCE_OWNERS_FILE"
      if [ -f "$scenario/invalid-owner-record" ]; then echo '{"label":"foreign.owner","owner":"untrusted"}' >> "$LCI_RESOURCE_OWNERS_FILE"; fi
    fi
    touch "$here/state/active/$resource"
    printf 'start %s\\n' "$name" >> "$here/validation.events"
    finish_validation() {
      rm -f "$here/state/active/$resource"
      if [ ! -f "$scenario/validation-leak" ] && [ ! -f "$scenario/$name.leak" ]; then rm -f "$here/state/volumes/$resource"; fi
      printf 'end %s\\n' "$name" >> "$here/validation.events"
    }
    trap finish_validation EXIT
    if [ -f "$scenario/validation-barrier" ]; then
      attempts=0
      while [ ! -f "$scenario/barrier-released" ]; do
        count="$(find "$here/state/active" -type f | wc -l | tr -d ' ')"
        target="$(cat "$scenario/validation-barrier")"
        if [ "$count" -ge "\${target:-3}" ]; then touch "$scenario/barrier-released"; break; fi
        attempts=$((attempts + 1)); [ "$attempts" -lt 100 ] || exit 77
        sleep 0.02
      done
    fi
    if [ -f "$scenario/$name.delay" ]; then sleep "$(cat "$scenario/$name.delay")"; fi
    ;;
esac
if [ -f "$scenario/$name.sleep" ]; then
  sleep 60 &
  echo $! > "$scenario/$name.grandchild"
  echo started > "$scenario/$name.started"
  wait
fi
if [ -f "$scenario/$name.out" ]; then cat "$scenario/$name.out"; fi
exit "$(cat "$scenario/$name.exit" 2>/dev/null || echo 0)"
`);
  if (options.trivy !== false) {
    writeExecutable(join(bin, "trivy"), `#!/usr/bin/env bash
set -u
here="$(cd "$(dirname "$0")" && pwd)"
scenario="$here/scenario"
printf '%s\\n' "$*" >> "$here/trivy.calls"
if [ "\${1:-}" = "--version" ]; then cat "$scenario/trivy-version" 2>/dev/null || printf 'Version: 0.70.0\\n'; exit 0; fi
output=""; code=0
while [ $# -gt 0 ]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --exit-code) code="$2"; shift 2 ;;
    *) shift ;;
  esac
done
vulnerabilities=null
if [ -f "$scenario/trivy-actionable" ]; then vulnerabilities='[{"VulnerabilityID":"CVE-FIXTURE","PkgName":"fixture","Severity":"HIGH","FixedVersion":"2.0.0"}]'; fi
printf '{"SchemaVersion":2,"Results":[{"Target":"debian","Vulnerabilities":%s}]}\\n' "$vulnerabilities" > "$output"
if [ "$vulnerabilities" != null ] && [ "$code" = 1 ]; then exit 1; fi
exit 0
`);
  }
  writeExecutable(join(bin, "codeql"), `#!/usr/bin/env bash
set -u
here="$(cd "$(dirname "$0")" && pwd)"
scenario="$here/scenario"
printf '%s\\n' "$*" >> "$here/codeql.calls"
case "\${1:-} \${2:-}" in
  "version --format=json") printf '{"productName":"CodeQL","version":"%s"}\\n' "$(cat "$scenario/codeql-version" 2>/dev/null || echo 2.27.1)" ;;
  "database create") mkdir -p "$3" ;;
  "database analyze")
    output=""
    for argument in "$@"; do case "$argument" in --output=*) output="\${argument#--output=}" ;; esac; done
    results='[]'
    if [ -f "$scenario/codeql-result" ]; then results='[{"ruleId":"js/fixture","message":{"text":"fixture"}}]'; fi
    printf '{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"CodeQL","semanticVersion":"2.27.1"},"extensions":[{"name":"codeql/javascript-queries","locations":[{"uri":"file:///private/toolchains/codeql/qlpacks/javascript-queries/"}]}]},"originalUriBaseIds":{"%%SRCROOT%%":{"uri":"file:///private/checkout/"}},"automationDetails":{"id":"/language:javascript-typescript/"},"results":%s}]}\\n' "$results" > "$output" ;;
  *) echo "unexpected fake codeql invocation: $*" >&2; exit 64 ;;
esac
`);
  for (const tool of ["gh", "curl"]) {
    writeExecutable(join(bin, tool), `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> "$(cd "$(dirname "$0")" && pwd)/${tool}.calls"\nexit 1\n`);
  }
  return { bin, scenario, state };
};

const toolPath = (fakes: Fakes) => `${fakes.bin}:${join(fakes.bin, "tools")}:/usr/bin:/bin`;

type RunOptions = { repo: string; fakes: Fakes; args: string[]; env?: Record<string, string | undefined>; evidence?: string };

const runEntrypoint = ({ repo, fakes, args, env = {}, evidence }: RunOptions) => {
  const evidenceDir = evidence ?? join(freshDirectory("evidence"), "out");
  const result = spawnSync("bash", [join(repo, "scripts/local-ci.sh"), ...args], {
    cwd: repo,
    encoding: "utf8",
    timeout: 90_000,
    env: {
      PATH: toolPath(fakes),
      HOME: process.env.HOME,
      TMPDIR: process.env.TMPDIR,
      LOCAL_CI_RUN_ID: runId,
      LOCAL_CI_EVIDENCE_DIR: evidenceDir,
      LOCAL_CI_VALIDATION_CONCURRENCY: "3",
      ...env
    } as NodeJS.ProcessEnv
  });
  return { result, evidenceDir };
};

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Json;
const output = (result: SpawnSyncReturns<string>) => `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(-2_000);
const callLog = (fakes: Fakes, tool: string) => existsSync(join(fakes.bin, `${tool}.calls`)) ? readFileSync(join(fakes.bin, `${tool}.calls`), "utf8") : "";
const subjob = (result: Json, name: string) => (result.subjobs as Json[]).find((entry) => entry.name === name);
const writeScenario = (fakes: Fakes, name: string, contents = "") => writeFileSync(join(fakes.scenario, name), contents);

const parallelValidationNames = ["native-clean-install", "native-beta3-upgrade-rollback", "native-beta4-upgrade-rollback", "native-beta5-upgrade-rollback", "native-beta6-upgrade-rollback", "native-beta7-upgrade-rollback"];
const parallelValidationCommands = ["run-validate:beta-install", "run-validate:beta3-upgrade", "run-validate:beta4-upgrade", "run-validate:beta5-upgrade", "run-validate:beta6-upgrade", "run-validate:beta7-upgrade"];
const prepareParallelValidations = (fakes: Fakes, sha: string) => {
  const reports = [rehearsalCleanInstall(sha),
    { ...rehearsalBeta5(sha), schema: "moodarr-beta3-upgrade-v1", baseline: beta3UpgradeIdentity, checks: [...beta3UpgradeCheckCodes] },
    { ...rehearsalBeta5(sha), schema: "moodarr-beta4-upgrade-v1", baseline: beta4UpgradeIdentity, checks: [...beta4UpgradeCheckCodes] }, rehearsalBeta5(sha),
    { ...rehearsalBeta5(sha), schema: "moodarr-beta6-upgrade-v1", baseline: beta6UpgradeIdentity, checks: [...beta6UpgradeCheckCodes] },
    { ...rehearsalBeta5(sha), schema: "moodarr-beta7-upgrade-v1", baseline: beta7UpgradeIdentity, checks: [...beta7UpgradeCheckCodes] }];
  parallelValidationCommands.forEach((command, index) => {
    writeScenario(fakes, `${command}.out`, JSON.stringify(reports[index]));
    writeScenario(fakes, `${command}.exit`, "1");
    writeScenario(fakes, `${command}.delay`, index === 0 ? "0.1" : "0.3");
  });
};

const peakValidations = (fakes: Fakes) => {
  const events = readFileSync(join(fakes.bin, "validation.events"), "utf8").trim().split("\n");
  let active = 0;
  let peak = 0;
  for (const event of events) {
    active += event.startsWith("start ") ? 1 : -1;
    peak = Math.max(active, peak);
    expect(active).toBeGreaterThanOrEqual(0);
  }
  expect(active).toBe(0);
  return peak;
};

// Parallel-scenario failure cases, written before the implementation:
// - serialization or unbounded launch; one finished validator mistakes a live sibling for a leak;
// - a failed scenario loses the remaining checks, their ordered results, or hashed evidence;
// - failed prerequisites start dependent validators, or malformed concurrency starts any work;
// - timeout/cancellation leaves active process groups, launches queued scenarios, or cleans too early;
// - interrupted validators leak owned resources; cleanup removes a foreign resource or trusts a bad owner record.
describe("local CI bounded parallel validations", () => {
  it.each([3, 4, 5])("overlaps exactly %i validators, refills the slot, and preserves all results and evidence", (concurrency) => {
    const { repo, sha } = createRepo();
    const fakes = installFakes();
    prepareParallelValidations(fakes, sha);
    writeScenario(fakes, "validation-barrier", String(concurrency));
    const { result, evidenceDir } = runEntrypoint({ repo, fakes, args: ["verify", ...parallelValidationNames, "codeql"], env: { LOCAL_CI_SOURCE_SHA: sha, LOCAL_CI_VALIDATION_CONCURRENCY: String(concurrency) } });
    expect(result.status, output(result)).toBe(0);
    expect(peakValidations(fakes)).toBe(concurrency);
    const summary = readJson(join(evidenceDir, "result.json"));
    expect(summary).toMatchObject({ status: "passed", gating: false, complete: false, cleanup: { status: "passed" } });
    expect(summary.subjobs.map((entry: Json) => [entry.name, entry.status])).toEqual(["install", "native-image", ...parallelValidationNames, "codeql"].map((name) => [name, "passed"]));
    const manifest = readJson(join(evidenceDir, "evidence-manifest.json"));
    for (const name of parallelValidationNames) {
      for (const file of ["report.json", "resource-owners.jsonl"]) {
        const path = `${name}/${file}`;
        expect(manifest.files.find((entry: Json) => entry.path === path)?.sha256).toBe(createHash("sha256").update(readFileSync(join(evidenceDir, path))).digest("hex"));
      }
    }
    expect(readdirSync(join(fakes.state, "volumes"))).toEqual([]);
  }, 60_000);

  it.each([3, 5])("keeps every independent check after one of %i parallel validators fails", (concurrency) => {
    const { repo, sha } = createRepo();
    const fakes = installFakes();
    prepareParallelValidations(fakes, sha);
    writeScenario(fakes, "validation-barrier", String(concurrency));
    writeScenario(fakes, "run-validate:beta6-upgrade.exit", "0");
    const { result, evidenceDir } = runEntrypoint({ repo, fakes, args: ["verify", ...parallelValidationNames, "codeql"], env: { LOCAL_CI_SOURCE_SHA: sha, LOCAL_CI_VALIDATION_CONCURRENCY: String(concurrency) } });
    expect(result.status, output(result)).toBe(1);
    const summary = readJson(join(evidenceDir, "result.json"));
    expect(summary).toMatchObject({ status: "failed", gating: false, cleanup: { status: "passed" } });
    expect(subjob(summary, "native-beta6-upgrade-rollback")?.status).toBe("failed");
    for (const name of [...parallelValidationNames.filter((name) => !name.includes("beta6")), "codeql"]) expect(subjob(summary, name)?.status, name).toBe("passed");
    expect(peakValidations(fakes)).toBe(concurrency);
  }, 60_000);

  it("supports serial execution and refuses invalid bounds before starting work", () => {
    const { repo, sha } = createRepo();
    const fakes = installFakes();
    prepareParallelValidations(fakes, sha);
    const serial = runEntrypoint({ repo, fakes, args: ["verify", ...parallelValidationNames], env: { LOCAL_CI_SOURCE_SHA: sha, LOCAL_CI_VALIDATION_CONCURRENCY: "1" } });
    expect(serial.result.status, output(serial.result) + readFileSync(join(serial.evidenceDir, "logs/native-clean-install.log"), "utf8")).toBe(0);
    expect(peakValidations(fakes)).toBe(1);
    for (const value of ["0", "6", "-1", "1.5", "three"]) {
      const invalidFakes = installFakes();
      const invalid = runEntrypoint({ repo, fakes: invalidFakes, args: ["verify", "audit"], env: { LOCAL_CI_VALIDATION_CONCURRENCY: value } });
      expect(invalid.result.status, `${value}: ${output(invalid.result)}`).toBe(2);
      expect(callLog(invalidFakes, "npm") + callLog(invalidFakes, "docker")).toBe("");
    }
  }, 60_000);

  it("skips all dependent validators after installation fails but still runs CodeQL", () => {
    const { repo, sha } = createRepo();
    const fakes = installFakes();
    writeScenario(fakes, "ci.exit", "1");
    const { result, evidenceDir } = runEntrypoint({ repo, fakes, args: ["verify", ...parallelValidationNames, "codeql"], env: { LOCAL_CI_SOURCE_SHA: sha } });
    expect(result.status, output(result)).toBe(1);
    const summary = readJson(join(evidenceDir, "result.json"));
    for (const name of parallelValidationNames) expect(subjob(summary, name)?.status, name).toBe("skipped");
    expect(subjob(summary, "codeql")?.status).toBe("passed");
    expect(callLog(fakes, "npm")).not.toContain("validate:");
  }, 60_000);

  it.each([["deadline", 3], ["SIGTERM", 3], ["deadline", 5], ["SIGTERM", 5]] as const)("stops every active validator on %s at concurrency %i, then removes only its recorded resources", async (termination, concurrency) => {
    const { repo, sha } = createRepo();
    const fakes = installFakes();
    prepareParallelValidations(fakes, sha);
    for (const command of parallelValidationCommands.slice(0, concurrency)) {
      writeScenario(fakes, `${command}.sleep`);
      writeScenario(fakes, `${command}.leak`);
    }
    writeFileSync(join(fakes.state, "volumes", "unrelated-volume"), "unrelated.owner=keep\n");
    const evidenceDir = join(freshDirectory("parallel-stop"), "out");
    const child = spawn("bash", [join(repo, "scripts/local-ci.sh"), "verify", ...parallelValidationNames], {
      cwd: repo,
      env: { PATH: toolPath(fakes), HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LOCAL_CI_RUN_ID: runId,
        LOCAL_CI_EVIDENCE_DIR: evidenceDir, LOCAL_CI_SOURCE_SHA: sha, LOCAL_CI_VALIDATION_CONCURRENCY: String(concurrency),
        ...(termination === "deadline" ? { LOCAL_CI_SUBJOB_TIMEOUT_SECONDS: "2" } : {}) },
      stdio: "ignore"
    });
    const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
    try {
      const ready = () => parallelValidationCommands.slice(0, concurrency).every((command) => existsSync(join(fakes.scenario, `${command}.started`)));
      const deadline = Date.now() + 15_000;
      while (!ready() && child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
      expect(ready()).toBe(true);
      if (termination === "SIGTERM") child.kill("SIGTERM");
      const [code, signal] = await exited;
      expect({ code, signal }).toEqual({ code: termination === "SIGTERM" ? 143 : 1, signal: null });
      const summary = readJson(join(evidenceDir, "result.json"));
      expect(summary.cleanup.status).toBe("passed");
      expect(summary.gating).toBe(false);
      for (const name of parallelValidationNames.slice(0, concurrency)) expect(subjob(summary, name)).toMatchObject(termination === "SIGTERM" ? { status: "cancelled" } : { status: "failed", reason: "timeout" });
      expect(subjob(summary, parallelValidationNames[concurrency])?.status).toBe(termination === "SIGTERM" ? "cancelled" : "passed");
      for (const command of parallelValidationCommands.slice(0, concurrency)) {
        const pid = Number(readFileSync(join(fakes.scenario, `${command}.grandchild`), "utf8"));
        expect(() => process.kill(pid, 0)).toThrow();
      }
      expect(readdirSync(join(fakes.state, "volumes"))).toEqual(["unrelated-volume"]);
      expect(callLog(fakes, "docker")).not.toContain("volume rm -- unrelated-volume");
    } finally {
      if (child.exitCode === null) { child.kill("SIGTERM"); await exited; }
    }
  }, 60_000);

  it("fails closed on an invalid ownership record and preserves unknown validator resources", () => {
    const { repo, sha } = createRepo();
    const fakes = installFakes();
    prepareParallelValidations(fakes, sha);
    writeScenario(fakes, "validation-leak");
    writeScenario(fakes, "invalid-owner-record");
    writeFileSync(join(fakes.state, "volumes", "foreign-validator-volume"), `io.moodarr.beta-install.owner=${"f".repeat(36)}\n`);
    const { result, evidenceDir } = runEntrypoint({ repo, fakes, args: ["verify", "native-clean-install"], env: { LOCAL_CI_SOURCE_SHA: sha } });
    expect(result.status, output(result)).toBe(1);
    expect(readJson(join(evidenceDir, "result.json"))).toMatchObject({ status: "failed", gating: false, cleanup: { status: "failed" } });
    expect(callLog(fakes, "docker")).not.toContain("volume rm");
    expect(existsSync(join(fakes.state, "volumes", "foreign-validator-volume"))).toBe(true);
  }, 60_000);
});

describe("local CI entrypoint input refusal", () => {
  it("refuses unsafe run IDs before creating evidence or running a tool", () => {
    const { repo } = createRepo();
    for (const unsafe of ["", "short", "UPPER-case-run", "../escape-run-id", "trailing-hyphen-", "a".repeat(49), "dotted.run.id"]) {
      const fakes = installFakes();
      const { result, evidenceDir } = runEntrypoint({ repo, fakes, args: ["verify", "audit"], env: { LOCAL_CI_RUN_ID: unsafe } });
      expect(result.status, `${unsafe}: ${output(result)}`).toBe(2);
      expect(existsSync(evidenceDir)).toBe(false);
      expect(callLog(fakes, "npm") + callLog(fakes, "docker")).toBe("");
    }
  }, 60_000);

  it("refuses relative, in-source, symlinked-into-source and non-empty evidence directories", () => {
    const { repo } = createRepo();
    const nonEmpty = freshDirectory("evidence");
    writeFileSync(join(nonEmpty, "previous-result.json"), "{}");
    const linkParent = freshDirectory("evidence-link");
    symlinkSync(join(repo, "scripts"), join(linkParent, "into-source"));
    for (const evidence of ["relative/evidence", join(repo, "evidence"), join(repo, "scripts", "nested"), join(linkParent, "into-source", "out"), nonEmpty]) {
      const fakes = installFakes();
      const { result } = runEntrypoint({ repo, fakes, args: ["verify", "audit"], evidence });
      expect(result.status, `${evidence}: ${output(result)}`).toBe(2);
      expect(callLog(fakes, "npm")).toBe("");
    }
    expect(existsSync(join(repo, "evidence"))).toBe(false);
    expect(existsSync(join(repo, "scripts", "nested"))).toBe(false);
    expect(readdirSync(nonEmpty)).toEqual(["previous-result.json"]);
  }, 60_000);

  it("records a refusal without running checks when the supplied source is not the clean HEAD", () => {
    const { repo, sha } = createRepo();
    const mismatch = installFakes();
    const wrongSha = runEntrypoint({ repo, fakes: mismatch, args: ["verify", "audit"], env: { LOCAL_CI_SOURCE_SHA: "f".repeat(40) } });
    expect(wrongSha.result.status, output(wrongSha.result)).toBe(2);
    expect(readJson(join(wrongSha.evidenceDir, "result.json"))).toMatchObject({ status: "refused", runId, mode: "verify" });
    expect(callLog(mismatch, "npm")).toBe("");

    writeFileSync(join(repo, "untracked-change.txt"), "dirty\n");
    const dirty = installFakes();
    const dirtyRun = runEntrypoint({ repo, fakes: dirty, args: ["verify", "audit"], env: { LOCAL_CI_SOURCE_SHA: sha } });
    expect(dirtyRun.result.status, output(dirtyRun.result)).toBe(2);
    expect(readJson(join(dirtyRun.evidenceDir, "result.json")).status).toBe("refused");
    expect(callLog(dirty, "npm")).toBe("");
  }, 60_000);

  it("requires source and main identities for release and candidate checks and rejects malformed inputs", () => {
    const { repo, sha } = createRepo();
    for (const [args, env] of [
      [["release-check", "release-source"], {}],
      [["release-check", "release-source"], { LOCAL_CI_SOURCE_SHA: sha }],
      [["candidate-check", "candidate-source"], { LOCAL_CI_SOURCE_SHA: sha, LOCAL_CI_MAIN_SHA: sha }],
      [["candidate-check", "candidate-source"], { LOCAL_CI_SOURCE_SHA: sha, LOCAL_CI_MAIN_SHA: sha, LOCAL_CI_CANDIDATE_DIGEST: "sha256:short" }],
      [["verify", "no-such-subjob"], {}],
      [["publish"], {}],
      [["verify", "audit"], { LOCAL_CI_SUBJOB_TIMEOUT_SECONDS: "0" }]
    ] as Array<[string[], Record<string, string>]>) {
      const fakes = installFakes();
      const { result } = runEntrypoint({ repo, fakes, args, env });
      expect(result.status, `${args.join(" ")} ${JSON.stringify(env)}: ${output(result)}`).toBe(2);
      expect(callLog(fakes, "npm") + callLog(fakes, "docker") + callLog(fakes, "gh") + callLog(fakes, "curl")).toBe("");
    }
  }, 60_000);
});

describe("local CI verify runs", () => {
  it("passes only with complete evidence, exact cleanup and no private paths in the result", () => {
    const { repo, sha } = createRepo();
    const fakes = installFakes();
    writeScenario(fakes, "run-validate:beta-install.out", JSON.stringify(rehearsalCleanInstall(sha)));
    writeScenario(fakes, "run-validate:beta-install.exit", "1");
    const { result, evidenceDir } = runEntrypoint({ repo, fakes, args: ["verify", "audit", "container-scan", "native-clean-install", "codeql"], env: { LOCAL_CI_SOURCE_SHA: sha } });
    expect(result.status, output(result)).toBe(0);
    const summary = readJson(join(evidenceDir, "result.json"));
    expect(summary).toMatchObject({ schemaVersion: "moodarr-local-ci-result-v1", status: "passed", runId, mode: "verify", complete: false, gating: false });
    expect(summary.gatingBlockers).toContain("partial_subjob_selection");
    expect(summary.source).toMatchObject({ headSha: sha, suppliedSha: sha, clean: true });
    expect((summary.subjobs as Json[]).map((entry) => [entry.name, entry.status])).toEqual([
      ["install", "passed"],
      ["audit", "passed"],
      ["container-scan", "passed"],
      ["native-image", "passed"],
      ["native-clean-install", "passed"],
      ["codeql", "passed"]
    ]);
    for (const entry of summary.subjobs as Json[]) expect(existsSync(join(evidenceDir, entry.log))).toBe(true);
    expect(summary.cleanup.status).toBe("passed");
    expect(summary.evidenceScan.status).toBe("passed");

    const manifest = readJson(join(evidenceDir, "evidence-manifest.json"));
    const listed = new Map((manifest.files as Json[]).map((file) => [file.path, file.sha256]));
    for (const required of [
      "container-scan/image-identity.json",
      "container-scan/trivy-high-critical.json",
      "container-scan/trivy-actionable.json",
      "native-clean-install/report.json",
      "native-clean-install/image-identity.json",
      "codeql/results.sarif",
      "codeql/codeql-summary.json"
    ]) {
      expect(listed.get(required), required).toBe(createHash("sha256").update(readFileSync(join(evidenceDir, required))).digest("hex"));
    }
    expect(summary.evidenceManifestSha256).toBe(createHash("sha256").update(readFileSync(join(evidenceDir, "evidence-manifest.json"))).digest("hex"));
    expect(readJson(join(evidenceDir, "container-scan/image-identity.json"))).toMatchObject({ schemaVersion: "moodarr-container-scan-v2", sourceRevision: sha, policies: { aiProvider: "none", tmdbContent: "none" } });
    expect(readJson(join(evidenceDir, "native-clean-install/image-identity.json"))).toMatchObject({ schema: "moodarr-native-source-image-v1", validation: "clean-install", sourceRevision: sha, platform: { os: "linux", architecture: "amd64" } });
    expect(readJson(join(evidenceDir, "codeql/codeql-summary.json"))).toMatchObject({ codeqlVersion: "2.27.1", category: "/language:javascript-typescript", resultCount: 0 });
    expect(readFileSync(join(evidenceDir, "codeql/results.sarif"), "utf8")).not.toContain("file://");
    expect(readJson(join(evidenceDir, "codeql/results.sarif")).runs[0].automationDetails.id).toBe("/language:javascript-typescript/");

    const removed = callLog(fakes, "docker").split("\n").filter((line) => line.startsWith("image rm "));
    expect(removed.sort()).toEqual([`image rm moodarr-local-ci:${runId}-native`, `image rm moodarr-local-ci:${runId}-scan`]);
    expect(callLog(fakes, "docker")).not.toMatch(/prune|system |rmi|-f /);
    for (const tag of [sentinelTag, otherRunTag]) expect(existsSync(join(fakes.state, "images", tag.replace(/[/:@]/g, "_")))).toBe(true);
    for (const record of ["result.json", "run.json"]) {
      const text = readFileSync(join(evidenceDir, record), "utf8");
      expect(text).not.toContain(evidenceDir);
      expect(text).not.toContain(repo);
    }
    expect(readdirSync(dirname(evidenceDir))).toEqual(["out"]);
  }, 90_000);

  it("marks only a complete run from a supplied clean source on Node 24 as gating", () => {
    const { repo, sha } = createRepo();
    const nodeBlockers = process.versions.node.split(".")[0] === "24" ? [] : ["node_major_not_24"];
    const supplied = runEntrypoint({ repo, fakes: installFakes(), args: ["scheduled-security"], env: { LOCAL_CI_SOURCE_SHA: sha } });
    expect(supplied.result.status, output(supplied.result)).toBe(0);
    const suppliedSummary = readJson(join(supplied.evidenceDir, "result.json"));
    expect(suppliedSummary).toMatchObject({ status: "passed", complete: true, gating: nodeBlockers.length === 0, gatingBlockers: nodeBlockers });
    expect((suppliedSummary.subjobs as Json[]).map((entry) => entry.name)).toEqual(["dependency-audit", "container-scan"]);

    const unsupplied = runEntrypoint({ repo, fakes: installFakes(), args: ["scheduled-security"] });
    expect(unsupplied.result.status, output(unsupplied.result)).toBe(0);
    expect(readJson(join(unsupplied.evidenceDir, "result.json"))).toMatchObject({ status: "passed", complete: true, gating: false, gatingBlockers: ["source_sha_not_supplied", ...nodeBlockers] });
  }, 90_000);

  it("interprets the rehearsal exit through the report contract and still runs later subjobs", () => {
    const { repo, sha } = createRepo();
    const fakes = installFakes();
    writeScenario(fakes, "run-validate:beta-install.out", JSON.stringify(rehearsalCleanInstall(sha)));
    writeScenario(fakes, "run-validate:beta-install.exit", "0");
    writeScenario(fakes, "run-validate:beta5-upgrade.out", JSON.stringify(rehearsalBeta5(sha)));
    writeScenario(fakes, "run-validate:beta5-upgrade.exit", "1");
    const { result, evidenceDir } = runEntrypoint({ repo, fakes, args: ["verify", "native-clean-install", "native-beta5-upgrade-rollback"], env: { LOCAL_CI_SOURCE_SHA: sha } });
    expect(result.status, output(result)).toBe(1);
    const summary = readJson(join(evidenceDir, "result.json"));
    expect(summary.status).toBe("failed");
    expect(subjob(summary, "native-clean-install")?.status).toBe("failed");
    expect(subjob(summary, "native-beta5-upgrade-rollback")?.status).toBe("passed");
    expect(existsSync(join(evidenceDir, "native-clean-install/report.json"))).toBe(true);
  }, 90_000);

  it("fails a native subjob when validator-owned resources remain", () => {
    const { repo, sha } = createRepo();
    const fakes = installFakes();
    writeScenario(fakes, "run-validate:beta-install.out", JSON.stringify(rehearsalCleanInstall(sha)));
    writeScenario(fakes, "run-validate:beta-install.exit", "1");
    writeScenario(fakes, "leftover-volume", "moodarrbetaleftover-volume\n");
    const { result, evidenceDir } = runEntrypoint({ repo, fakes, args: ["verify", "native-clean-install"], env: { LOCAL_CI_SOURCE_SHA: sha } });
    expect(result.status, output(result)).toBe(1);
    const summary = readJson(join(evidenceDir, "result.json"));
    expect(subjob(summary, "native-clean-install")?.status).toBe("failed");
    expect(summary.cleanup.status).toBe("failed");
    expect(callLog(fakes, "docker")).not.toContain("volume rm");
  }, 90_000);

  it("fails the image scan on a revision label mismatch, a fixable finding or a missing scanner", () => {
    for (const scenario of ["revision-label", "trivy-actionable", "no-trivy", "trivy-version"] as const) {
      const { repo, sha } = createRepo();
      const fakes = installFakes({ trivy: scenario !== "no-trivy" });
      if (scenario === "revision-label") writeScenario(fakes, "revision-label", "b".repeat(40));
      if (scenario === "trivy-actionable") writeScenario(fakes, "trivy-actionable");
      if (scenario === "trivy-version") writeScenario(fakes, "trivy-version", "Version: 0.69.3\n");
      const { result, evidenceDir } = runEntrypoint({ repo, fakes, args: ["verify", "container-scan"], env: { LOCAL_CI_SOURCE_SHA: sha } });
      expect(result.status, `${scenario}: ${output(result)}`).toBe(1);
      expect(subjob(readJson(join(evidenceDir, "result.json")), "container-scan")?.status, scenario).toBe("failed");
    }
  }, 90_000);

  it("fails CodeQL on any result or a different CLI version", () => {
    for (const scenario of ["codeql-result", "codeql-version"] as const) {
      const { repo, sha } = createRepo();
      const fakes = installFakes();
      writeScenario(fakes, scenario, scenario === "codeql-version" ? "2.26.0" : "");
      const { result, evidenceDir } = runEntrypoint({ repo, fakes, args: ["verify", "codeql"], env: { LOCAL_CI_SOURCE_SHA: sha } });
      expect(result.status, `${scenario}: ${output(result)}`).toBe(1);
      expect(subjob(readJson(join(evidenceDir, "result.json")), "codeql")?.status).toBe("failed");
    }
  }, 60_000);

  it("fails and redacts evidence that contains a credential-shaped value", () => {
    const { repo, sha } = createRepo();
    const fakes = installFakes();
    writeScenario(fakes, "audit.out", `advisory fetch used ${tokenLike}\n`);
    const { result, evidenceDir } = runEntrypoint({ repo, fakes, args: ["verify", "audit"], env: { LOCAL_CI_SOURCE_SHA: sha } });
    expect(result.status, output(result)).toBe(1);
    const summary = readJson(join(evidenceDir, "result.json"));
    expect(subjob(summary, "audit")?.status).toBe("passed");
    expect(summary.evidenceScan.status).toBe("failed");
    expect(summary.evidenceScan.findings).toContainEqual(expect.objectContaining({ file: "logs/audit.log", kind: "GitHub token" }));
    expect(readFileSync(join(evidenceDir, "logs/audit.log"), "utf8")).not.toContain(tokenLike);
    expect(readFileSync(join(evidenceDir, "result.json"), "utf8")).not.toContain(tokenLike);
    expect(`${result.stdout}${result.stderr}`).not.toContain(tokenLike);
  }, 60_000);

  it("stops a subjob at its deadline and kills its whole process group", () => {
    const { repo, sha } = createRepo();
    const fakes = installFakes();
    writeScenario(fakes, "audit.sleep");
    const started = Date.now();
    const { result, evidenceDir } = runEntrypoint({ repo, fakes, args: ["verify", "audit"], env: { LOCAL_CI_SOURCE_SHA: sha, LOCAL_CI_SUBJOB_TIMEOUT_SECONDS: "2" } });
    expect(result.status, output(result)).toBe(1);
    expect(Date.now() - started).toBeLessThan(45_000);
    expect(subjob(readJson(join(evidenceDir, "result.json")), "audit")).toMatchObject({ status: "failed", reason: "timeout" });
    const grandchild = Number(readFileSync(join(fakes.scenario, "audit.grandchild"), "utf8"));
    expect(() => process.kill(grandchild, 0)).toThrow();
  }, 90_000);

  it("cancels on SIGTERM, records a cancelled result and still cleans up", async () => {
    const { repo, sha } = createRepo();
    const fakes = installFakes();
    writeScenario(fakes, "audit.sleep");
    const evidenceDir = join(freshDirectory("evidence"), "out");
    const child = spawn("bash", [join(repo, "scripts/local-ci.sh"), "verify", "audit", "container-scan"], {
      cwd: repo,
      env: { PATH: toolPath(fakes), HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, LOCAL_CI_RUN_ID: runId, LOCAL_CI_EVIDENCE_DIR: evidenceDir, LOCAL_CI_SOURCE_SHA: sha },
      stdio: "ignore"
    });
    const deadline = Date.now() + 30_000;
    while (!existsSync(join(fakes.scenario, "audit.started")) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(existsSync(join(fakes.scenario, "audit.started"))).toBe(true);
    child.kill("SIGTERM");
    const [code, signal] = await once(child, "exit") as [number | null, NodeJS.Signals | null];
    expect({ code, signal }).toEqual({ code: 143, signal: null });
    const summary = readJson(join(evidenceDir, "result.json"));
    expect(summary.status).toBe("cancelled");
    expect(subjob(summary, "audit")?.status).toBe("cancelled");
    expect(subjob(summary, "container-scan")?.status).toBe("cancelled");
    expect(callLog(fakes, "docker").split("\n").filter((line) => line.startsWith("build "))).toEqual([]);
    expect(callLog(fakes, "docker")).toContain(`moodarr-local-ci:${runId}-scan`);
    const grandchild = Number(readFileSync(join(fakes.scenario, "audit.grandchild"), "utf8"));
    expect(() => process.kill(grandchild, 0)).toThrow();
    expect(existsSync(join(evidenceDir, "result.json.tmp"))).toBe(false);
  }, 90_000);
});

describe("local CI standalone CodeQL mode", () => {
  // Failure cases for the weekly CodeQL schedule, written before the mode existed:
  // - it needs a complete, gating CodeQL-only run for an exact clean source on Node 24;
  // - it runs only the existing CodeQL subjob: no install, no image build and no Docker call;
  // - a CodeQL result or another CLI version fails the run, which is then never gating;
  // - source identity refusals still apply, and other subjobs cannot be added;
  // - `verify codeql` stays a partial, non-gating selection.
  const nodeBlockers = process.versions.node.split(".")[0] === "24" ? [] : ["node_major_not_24"];

  it("runs only the existing CodeQL subjob and is complete and gating for a clean supplied source", () => {
    const { repo, sha } = createRepo();
    const fakes = installFakes();
    const { result, evidenceDir } = runEntrypoint({ repo, fakes, args: ["codeql"], env: { LOCAL_CI_SOURCE_SHA: sha } });
    expect(result.status, output(result)).toBe(0);
    const summary = readJson(join(evidenceDir, "result.json"));
    expect(summary).toMatchObject({ mode: "codeql", status: "passed", complete: true, gating: nodeBlockers.length === 0, gatingBlockers: nodeBlockers, selectedSubjobs: ["codeql"] });
    expect((summary.subjobs as Json[]).map((entry) => [entry.name, entry.status])).toEqual([["codeql", "passed"]]);
    expect(summary.cleanup.status).toBe("passed");
    expect(readJson(join(evidenceDir, "codeql/codeql-summary.json"))).toMatchObject({ sourceRevision: sha, resultCount: 0, category: "/language:javascript-typescript" });
    expect(readFileSync(join(evidenceDir, "codeql/results.sarif"), "utf8")).not.toContain("file://");
    expect(callLog(fakes, "codeql")).toMatch(/^database analyze /m);
    expect(callLog(fakes, "docker")).toBe("");
    expect(callLog(fakes, "npm")).toBe("");
  }, 60_000);

  it("fails and is not gating when CodeQL reports a result or is another version", () => {
    for (const scenario of ["codeql-result", "codeql-version"] as const) {
      const { repo, sha } = createRepo();
      const fakes = installFakes();
      writeScenario(fakes, scenario, scenario === "codeql-version" ? "2.26.0" : "");
      const { result, evidenceDir } = runEntrypoint({ repo, fakes, args: ["codeql"], env: { LOCAL_CI_SOURCE_SHA: sha } });
      expect(result.status, `${scenario}: ${output(result)}`).toBe(1);
      expect(readJson(join(evidenceDir, "result.json")), scenario).toMatchObject({ mode: "codeql", status: "failed", gating: false });
      expect(callLog(fakes, "docker"), scenario).toBe("");
    }
  }, 60_000);

  it("keeps source identity refusals and rejects other subjobs", () => {
    const { repo, sha } = createRepo();
    const mismatch = installFakes();
    const wrongSource = runEntrypoint({ repo, fakes: mismatch, args: ["codeql"], env: { LOCAL_CI_SOURCE_SHA: "f".repeat(40) } });
    expect(wrongSource.result.status, output(wrongSource.result)).toBe(2);
    expect(output(wrongSource.result)).toMatch(/LOCAL_CI_SOURCE_SHA does not match HEAD/);
    expect(callLog(mismatch, "codeql")).toBe("");
    const other = installFakes();
    const extra = runEntrypoint({ repo, fakes: other, args: ["codeql", "audit"], env: { LOCAL_CI_SOURCE_SHA: sha } });
    expect(extra.result.status, output(extra.result)).toBe(2);
    expect(output(extra.result)).toMatch(/unknown codeql subjob "audit"/);
    expect(callLog(other, "npm") + callLog(other, "codeql")).toBe("");
  }, 60_000);

  it("keeps verify codeql a partial, non-gating selection", () => {
    const { repo, sha } = createRepo();
    const { result, evidenceDir } = runEntrypoint({ repo, fakes: installFakes(), args: ["verify", "codeql"], env: { LOCAL_CI_SOURCE_SHA: sha } });
    expect(result.status, output(result)).toBe(0);
    const summary = readJson(join(evidenceDir, "result.json"));
    expect(summary).toMatchObject({ mode: "verify", status: "passed", complete: false, gating: false });
    expect(summary.gatingBlockers).toContain("partial_subjob_selection");
  }, 60_000);
});

describe("local CI release and candidate gates", () => {
  const releaseRun = (repo: string, sha: string, mainSha: string) => {
    const fakes = installFakes();
    const run = runEntrypoint({ repo, fakes, args: ["release-check", "release-source", "release-policy"], env: { LOCAL_CI_SOURCE_SHA: sha, LOCAL_CI_MAIN_SHA: mainSha } });
    return { ...run, summary: readJson(join(run.evidenceDir, "result.json")), fakes };
  };

  it("accepts a main-reachable, unrevoked source with published-copy release text", () => {
    const { repo, sha } = createRepo();
    const { result, summary } = releaseRun(repo, sha, sha);
    expect(result.status, output(result)).toBe(0);
    expect((summary.subjobs as Json[]).map((entry) => [entry.name, entry.status])).toEqual([["release-source", "passed"], ["release-policy", "passed"]]);
  }, 60_000);

  it("rejects a source that is not reachable from the supplied main and skips later gates", () => {
    const { repo, sha } = createRepo();
    git(repo, "checkout", "-q", "--orphan", "unrelated");
    writeFileSync(join(repo, "unrelated.txt"), "unrelated history\n");
    const unrelated = commitAll(repo, "unrelated");
    git(repo, "checkout", "-q", "--detach", sha);
    const { result, summary } = releaseRun(repo, sha, unrelated);
    expect(result.status, output(result)).toBe(1);
    expect(subjob(summary, "release-source")?.status).toBe("failed");
    expect(subjob(summary, "release-policy")?.status).toBe("skipped");
  }, 60_000);

  it("rejects a source revoked by the current main policy", () => {
    const { repo, sha } = createRepo();
    const policyPath = join(repo, ".github/release-revocations.json");
    const policy = readJson(policyPath);
    policy.candidates.push({ revision: sha, digest: `sha256:${"0".repeat(64)}`, reason: "Fixture revocation." });
    writeFileSync(policyPath, `${JSON.stringify(policy, null, 2)}\n`);
    const main = commitAll(repo, "revoke fixture");
    git(repo, "checkout", "-q", "--detach", sha);
    const { result, summary } = releaseRun(repo, sha, main);
    expect(result.status, output(result)).toBe(1);
    expect(subjob(summary, "release-source")?.status).toBe("passed");
    expect(subjob(summary, "release-policy")?.status).toBe("failed");
  }, 60_000);

  it("rejects unpublished-candidate release copy", () => {
    const { repo, sha } = createRepo((fixture) => {
      const changelog = join(fixture, "CHANGELOG.md");
      writeFileSync(changelog, readFileSync(changelog, "utf8").replace(`## ${version}\n`, `## ${version} - Unreleased\n`));
    });
    const { result, summary } = releaseRun(repo, sha, sha);
    expect(result.status, output(result)).toBe(1);
    expect(subjob(summary, "release-policy")?.status).toBe("failed");
  }, 60_000);

  it("stops candidate validation before any registry or attestation call when the source is not on main", () => {
    const { repo, sha } = createRepo();
    git(repo, "checkout", "-q", "--orphan", "unrelated");
    writeFileSync(join(repo, "unrelated.txt"), "unrelated history\n");
    const unrelated = commitAll(repo, "unrelated");
    git(repo, "checkout", "-q", "--detach", sha);
    const fakes = installFakes();
    const { result, evidenceDir } = runEntrypoint({
      repo,
      fakes,
      args: ["candidate-check"],
      env: { LOCAL_CI_SOURCE_SHA: sha, LOCAL_CI_MAIN_SHA: unrelated, LOCAL_CI_CANDIDATE_DIGEST: `sha256:${"c".repeat(64)}` }
    });
    expect(result.status, output(result)).toBe(1);
    const summary = readJson(join(evidenceDir, "result.json"));
    expect(subjob(summary, "candidate-source")?.status).toBe("failed");
    for (const entry of summary.subjobs as Json[]) if (entry.name !== "candidate-source") expect(entry.status, entry.name).toBe("skipped");
    expect(callLog(fakes, "curl") + callLog(fakes, "gh") + callLog(fakes, "npm")).toBe("");
  }, 60_000);
});

describe("local CI cleanup mode", () => {
  it("removes only this run's exact image tags and builder", () => {
    const { repo } = createRepo();
    const fakes = installFakes();
    for (const tag of [`moodarr-local-ci:${runId}-scan`, `moodarr-local-ci:${runId}-native`]) {
      writeFileSync(join(fakes.state, "images", tag.replace(/[/:@]/g, "_")), `${version}\n${"0".repeat(40)}\nnone\nnone\n`);
    }
    writeFileSync(join(fakes.state, `builder-moodarr-lci-${runId}`), "");
    writeFileSync(join(fakes.state, "builder-moodarr-lci-other-run-00000001"), "");
    const { result, evidenceDir } = runEntrypoint({ repo, fakes, args: ["cleanup"] });
    expect(result.status, output(result)).toBe(0);
    expect(readJson(join(evidenceDir, "result.json"))).toMatchObject({ mode: "cleanup", status: "passed" });
    expect(readdirSync(join(fakes.state, "images")).sort()).toEqual([otherRunTag, sentinelTag].map((tag) => tag.replace(/[/:@]/g, "_")).sort());
    expect(existsSync(join(fakes.state, `builder-moodarr-lci-${runId}`))).toBe(false);
    expect(existsSync(join(fakes.state, "builder-moodarr-lci-other-run-00000001"))).toBe(true);
  }, 60_000);
});
