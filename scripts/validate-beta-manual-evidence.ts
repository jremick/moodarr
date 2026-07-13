import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { aiOffResponsivenessCheckCodes } from "./beta-responsiveness-contract";

const schemaVersion = "moodarr-beta-manual-evidence-v1";
const expectedBetaVersion = "0.1.0-beta.1";
const placeholderRecordedAt = "2026-01-01T00:00:00.000Z";
const expectedCatalogVersion = "wikidata-20260622-min5-v1";
const expectedCatalogSha256 = "dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a";
const expectedCatalogRecords = 90_397;
const expectedCatalogRequestAttemptEligibleRecords = 82_865;
const maximumEvidenceBytes = 64 * 1024;
const maximumResponsivenessReportBytes = 8 * 1024 * 1024;
const maximumResponsivenessHarnessBytes = 1024 * 1024;
const responsivenessHarnessGitPath = "scripts/benchmark-beta-responsiveness.ts";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const betaManualEvidenceMaximumAgeMs = 14 * 24 * 60 * 60 * 1_000;
const revisionSchema = z.string().regex(/^[0-9a-f]{40}$/);
const digestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const hashSchema = z.string().regex(/^[0-9a-f]{64}$/);
const betaVersionSchema = z.string().regex(/^0\.1\.0-beta\.[0-9]+$/);
const numericVersionSchema = z.string().min(1).max(48).regex(/^[0-9]+(?:\.[0-9]+){1,4}(?:-[A-Za-z0-9]+)?$/);
const utcTimestampSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/).refine(
  (value) => {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) return false;
    const normalizedInput = value.includes(".") ? value : value.replace(/Z$/, ".000Z");
    return parsed.toISOString() === normalizedInput;
  },
  "invalid UTC timestamp"
);

const passFailSchema = z.boolean();
const unraidChecksSchema = z.object({
  cleanTemplateImport: passFailSchema,
  exactDigest: passFailSchema,
  nonRootUser: passFailSchema,
  readOnlyRoot: passFailSchema,
  noNewPrivileges: passFailSchema,
  capabilitiesDropped: passFailSchema,
  resourceLimits: passFailSchema,
  healthy: passFailSchema,
  exactOriginSession: passFailSchema,
  restartPersistence: passFailSchema,
  priorVersionUpdate: passFailSchema,
  cleanupComplete: passFailSchema
}).strict();

const integrationChecksSchema = z.object({
  plexLibrarySync: passFailSchema,
  plexSignIn: passFailSchema,
  plexCapabilityDefaults: passFailSchema,
  plexPosterAndLink: passFailSchema,
  plexWatchlistAction: passFailSchema,
  seerrStateSync: passFailSchema,
  requestPreview: passFailSchema,
  controlledRequestCreatedOnce: passFailSchema,
  idempotentRetry: passFailSchema,
  uncertainOutcomeReconciledWithoutResend: passFailSchema,
  upstreamCleanupComplete: passFailSchema
}).strict();

const catalogChecksSchema = z.object({
  exactAsset: passFailSchema,
  networklessFullSnapshotImport: passFailSchema,
  genericSearchIsolation: passFailSchema,
  requestAttemptDisclosure: passFailSchema
}).strict();

const browserChecksSchema = z.object({
  signIn: passFailSchema,
  search: passFailSchema,
  resultActions: passFailSchema,
  requestConfirmation: passFailSchema,
  adminAccess: passFailSchema,
  keyboardNavigation: passFailSchema,
  visibleFocus: passFailSchema,
  mobileWidthLayout: passFailSchema,
  reducedMotion: passFailSchema
}).strict();

const browserSchema = z.object({
  family: z.enum(["chrome", "edge", "firefox", "safari"]),
  version: numericVersionSchema,
  platform: z.enum(["linux", "macos", "windows"]),
  platformVersion: numericVersionSchema,
  consoleErrorCount: z.number().int().nonnegative().max(10_000),
  checks: browserChecksSchema
}).strict();

const responsivenessReportSchema = z.object({
  schemaVersion: z.literal("moodarr-beta-responsiveness-v3"),
  aiMode: z.enum(["none", "openai"]),
  status: z.enum(["passed", "failed", "incomplete"]),
  startedAt: utcTimestampSchema,
  finishedAt: utcTimestampSchema,
  candidate: z.object({
    digest: digestSchema,
    expectedRevision: revisionSchema,
    expectedVersion: betaVersionSchema,
    healthRevision: revisionSchema,
    healthVersion: betaVersionSchema,
    aiProviderPolicy: z.enum(["none", "configurable"]),
    tmdbContentPolicy: z.enum(["none", "configurable"]),
    harnessRevision: revisionSchema,
    harnessSha256: hashSchema
  }).passthrough(),
  environment: z.object({
    architecture: z.string().min(1),
    operatingSystem: z.string().min(1),
    localDockerDaemon: z.boolean(),
    cpuLimit: z.number().positive(),
    memoryMiB: z.number().positive(),
    imageDigestMatched: z.boolean()
  }).passthrough(),
  checks: z.array(z.object({
    code: z.string().min(1),
    status: z.enum(["passed", "failed", "incomplete"])
  }).strict()).min(1),
  failures: z.array(z.string()),
  incompleteReasons: z.array(z.string())
}).passthrough();

export const betaManualEvidenceSchema = z.object({
  schemaVersion: z.literal(schemaVersion),
  candidate: z.object({
    version: betaVersionSchema,
    revision: revisionSchema,
    digest: digestSchema
  }).strict(),
  recordedAt: utcTimestampSchema,
  operatorRole: z.enum(["maintainer", "release-delegate"]),
  unraid: z.object({
    version: numericVersionSchema,
    dockerVersion: numericVersionSchema,
    architecture: z.literal("amd64"),
    imageVersion: betaVersionSchema,
    imageRevision: revisionSchema,
    imageDigest: digestSchema,
    checks: unraidChecksSchema
  }).strict(),
  integrations: z.object({
    plex: z.object({ product: z.literal("Plex Media Server"), version: numericVersionSchema }).strict(),
    seerr: z.object({ product: z.enum(["Seerr", "Jellyseerr"]), version: numericVersionSchema }).strict(),
    checks: integrationChecksSchema
  }).strict(),
  catalog: z.object({
    version: z.string().min(1).max(64),
    assetSha256: hashSchema,
    records: z.number().int().nonnegative(),
    requestAttemptEligibleRecords: z.number().int().nonnegative(),
    checks: catalogChecksSchema
  }).strict(),
  responsiveness: z.object({
    reportSha256: hashSchema,
    status: z.enum(["passed", "failed", "incomplete"]),
    operatingSystem: z.literal("linux"),
    architecture: z.literal("amd64"),
    native: z.boolean(),
    cpuLimit: z.literal(2),
    memoryMiB: z.literal(2048)
  }).strict(),
  browsers: z.array(browserSchema).length(4)
}).strict();

export type BetaManualEvidence = z.infer<typeof betaManualEvidenceSchema>;
type ResponsivenessReport = z.infer<typeof responsivenessReportSchema>;

export interface BetaManualEvidenceBindings {
  expectedRevision: string;
  expectedDigest: string;
  expectedHarnessSha256: string;
  responsivenessReport: Buffer;
  now?: Date;
}

export interface BetaManualEvidenceArguments {
  inputPath: string;
  expectedRevision: string;
  expectedDigest: string;
  responsivenessReportPath: string;
}

export class BetaManualEvidenceError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export function validateBetaManualEvidence(value: unknown, bindings?: BetaManualEvidenceBindings) {
  const parsed = betaManualEvidenceSchema.safeParse(value);
  if (!parsed.success) throw new BetaManualEvidenceError("evidence_schema_invalid");
  const evidence = parsed.data;
  const failures: string[] = [];

  if (evidence.candidate.version !== expectedBetaVersion) failures.push("candidate_version_unsupported");
  if (isZeroHex(evidence.candidate.revision)) failures.push("candidate_revision_placeholder");
  if (isZeroHex(evidence.candidate.digest.slice("sha256:".length))) failures.push("candidate_digest_placeholder");
  if (evidence.recordedAt === placeholderRecordedAt) failures.push("recorded_at_placeholder");
  if (evidence.unraid.imageVersion !== evidence.candidate.version) failures.push("unraid_version_mismatch");
  if (evidence.unraid.imageRevision !== evidence.candidate.revision) failures.push("unraid_revision_mismatch");
  if (evidence.unraid.imageDigest !== evidence.candidate.digest) failures.push("unraid_digest_mismatch");
  addPlaceholderVersion(failures, "unraid_version_placeholder", evidence.unraid.version);
  addPlaceholderVersion(failures, "docker_version_placeholder", evidence.unraid.dockerVersion);
  addPlaceholderVersion(failures, "plex_version_placeholder", evidence.integrations.plex.version);
  addPlaceholderVersion(failures, "seerr_version_placeholder", evidence.integrations.seerr.version);
  addFailedBooleans(failures, "unraid", evidence.unraid.checks);
  addFailedBooleans(failures, "integration", evidence.integrations.checks);
  if (evidence.catalog.version !== expectedCatalogVersion) failures.push("catalog_version_mismatch");
  if (evidence.catalog.assetSha256 !== expectedCatalogSha256) failures.push("catalog_asset_hash_mismatch");
  if (evidence.catalog.records !== expectedCatalogRecords) failures.push("catalog_record_count_mismatch");
  if (evidence.catalog.requestAttemptEligibleRecords !== expectedCatalogRequestAttemptEligibleRecords) {
    failures.push("catalog_request_attempt_eligible_count_mismatch");
  }
  addFailedBooleans(failures, "catalog", evidence.catalog.checks);

  const families = new Set(evidence.browsers.map((browser) => browser.family));
  if (families.size !== 4) failures.push("browser_matrix_incomplete");
  for (const family of ["chrome", "edge", "firefox", "safari"] as const) {
    const browser = evidence.browsers.find((entry) => entry.family === family);
    if (!browser) continue;
    if (family === "safari" && browser.platform !== "macos") failures.push("safari_platform_invalid");
    addPlaceholderVersion(failures, `${family}_version_placeholder`, browser.version);
    addPlaceholderVersion(failures, `${family}_platform_version_placeholder`, browser.platformVersion);
    if (browser.consoleErrorCount !== 0) failures.push(`${family}_console_errors`);
    addFailedBooleans(failures, family, browser.checks);
  }

  if (evidence.responsiveness.status !== "passed") failures.push("responsiveness_not_passed");
  if (!evidence.responsiveness.native) failures.push("responsiveness_not_native");
  if (isZeroHex(evidence.responsiveness.reportSha256)) failures.push("responsiveness_report_hash_placeholder");
  if (!bindings) {
    failures.push("candidate_binding_missing", "responsiveness_report_binding_missing");
  } else {
    const report = parseResponsivenessReport(bindings.responsivenessReport);
    addBindingFailures(failures, evidence, report, bindings);
  }
  return { evidence, failures: [...new Set(failures)].sort(), passed: failures.length === 0 };
}

export function buildBetaManualEvidenceSummary(raw: string, bindings?: BetaManualEvidenceBindings) {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BetaManualEvidenceError("evidence_json_invalid");
  }
  const result = validateBetaManualEvidence(value, bindings);
  return {
    schemaVersion,
    status: result.passed ? "passed" as const : "failed" as const,
    candidate: result.evidence.candidate,
    recordedAt: result.evidence.recordedAt,
    operatorRole: result.evidence.operatorRole,
    environments: {
      unraid: result.evidence.unraid.version,
      docker: result.evidence.unraid.dockerVersion,
      plex: result.evidence.integrations.plex.version,
      seerrProduct: result.evidence.integrations.seerr.product,
      seerr: result.evidence.integrations.seerr.version,
      browsers: result.evidence.browsers.map(({ family, version, platform, platformVersion }) => ({ family, version, platform, platformVersion }))
    },
    catalog: result.evidence.catalog,
    responsiveness: result.evidence.responsiveness,
    evidenceSha256: crypto.createHash("sha256").update(raw).digest("hex"),
    failures: result.failures
  };
}

function isZeroHex(value: string) {
  return /^0+$/.test(value);
}

function addPlaceholderVersion(failures: string[], code: string, value: string) {
  const numericPart = value.split("-", 1)[0]!;
  if (numericPart.split(".").every((component) => Number(component) === 0)) failures.push(code);
}

function addFailedBooleans(failures: string[], prefix: string, values: Record<string, boolean>) {
  for (const [code, passed] of Object.entries(values)) {
    if (!passed) failures.push(`${prefix}_${camelToSnake(code)}`);
  }
}

function camelToSnake(value: string) {
  return value.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}

function parseResponsivenessReport(bytes: Buffer): ResponsivenessReport {
  let value: unknown;
  try {
    const raw = bytes.toString("utf8");
    if (!Buffer.from(raw, "utf8").equals(bytes)) throw new Error("invalid_utf8");
    value = JSON.parse(raw);
  } catch {
    throw new BetaManualEvidenceError("responsiveness_report_json_invalid");
  }
  const parsed = responsivenessReportSchema.safeParse(value);
  if (!parsed.success) throw new BetaManualEvidenceError("responsiveness_report_schema_invalid");
  return parsed.data;
}

function addBindingFailures(
  failures: string[],
  evidence: BetaManualEvidence,
  report: ResponsivenessReport,
  bindings: BetaManualEvidenceBindings
) {
  if (!revisionSchema.safeParse(bindings.expectedRevision).success || isZeroHex(bindings.expectedRevision)) {
    throw new BetaManualEvidenceError("expected_revision_invalid");
  }
  if (!digestSchema.safeParse(bindings.expectedDigest).success || isZeroHex(bindings.expectedDigest.slice("sha256:".length))) {
    throw new BetaManualEvidenceError("expected_digest_invalid");
  }
  if (!hashSchema.safeParse(bindings.expectedHarnessSha256).success || isZeroHex(bindings.expectedHarnessSha256)) {
    throw new BetaManualEvidenceError("expected_harness_hash_invalid");
  }
  const now = bindings.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new BetaManualEvidenceError("validation_time_invalid");

  if (evidence.candidate.revision !== bindings.expectedRevision) failures.push("candidate_revision_expected_mismatch");
  if (evidence.candidate.digest !== bindings.expectedDigest) failures.push("candidate_digest_expected_mismatch");

  const recordedAt = Date.parse(evidence.recordedAt);
  if (recordedAt > now.getTime()) failures.push("recorded_at_future");
  if (now.getTime() - recordedAt > betaManualEvidenceMaximumAgeMs) failures.push("recorded_at_stale");

  const reportHash = crypto.createHash("sha256").update(bindings.responsivenessReport).digest("hex");
  if (evidence.responsiveness.reportSha256 !== reportHash) failures.push("responsiveness_report_hash_mismatch");
  if (report.status !== "passed" || report.failures.length > 0 || report.incompleteReasons.length > 0) {
    failures.push("responsiveness_report_not_passed");
  }
  const expectedCheckCodes = new Set<string>(aiOffResponsivenessCheckCodes);
  const observedCheckCounts = new Map<string, number>();
  for (const check of report.checks) observedCheckCounts.set(check.code, (observedCheckCounts.get(check.code) ?? 0) + 1);
  if (aiOffResponsivenessCheckCodes.some((code) => !observedCheckCounts.has(code))) {
    failures.push("responsiveness_report_checks_missing");
  }
  if ([...observedCheckCounts.values()].some((count) => count !== 1)) {
    failures.push("responsiveness_report_checks_duplicate");
  }
  if ([...observedCheckCounts.keys()].some((code) => !expectedCheckCodes.has(code))) {
    failures.push("responsiveness_report_checks_unknown");
  }
  if (report.checks.some((check) => check.status !== "passed")) failures.push("responsiveness_report_check_not_passed");
  if (report.aiMode !== "none" || report.candidate.aiProviderPolicy !== "none" || report.candidate.tmdbContentPolicy !== "none") {
    failures.push("responsiveness_report_provider_policy_mismatch");
  }
  if (
    report.environment.operatingSystem !== "linux"
    || report.environment.architecture !== "amd64"
    || !report.environment.localDockerDaemon
  ) {
    failures.push("responsiveness_report_not_native");
  }
  if (report.environment.cpuLimit !== 2 || report.environment.memoryMiB !== 2048) {
    failures.push("responsiveness_report_resource_limits_mismatch");
  }
  if (!report.environment.imageDigestMatched) failures.push("responsiveness_report_image_digest_unmatched");

  if (report.candidate.digest !== bindings.expectedDigest) failures.push("responsiveness_report_digest_mismatch");
  if (report.candidate.expectedRevision !== bindings.expectedRevision) failures.push("responsiveness_report_revision_mismatch");
  if (report.candidate.healthRevision !== bindings.expectedRevision) failures.push("responsiveness_report_health_revision_mismatch");
  if (report.candidate.harnessRevision !== bindings.expectedRevision) failures.push("responsiveness_report_harness_revision_mismatch");
  if (report.candidate.harnessSha256 !== bindings.expectedHarnessSha256) failures.push("responsiveness_report_harness_hash_mismatch");
  if (report.candidate.expectedVersion !== expectedBetaVersion || report.candidate.healthVersion !== expectedBetaVersion) {
    failures.push("responsiveness_report_version_mismatch");
  }
  if (Date.parse(report.startedAt) > Date.parse(report.finishedAt)) failures.push("responsiveness_report_time_order_invalid");
  if (Date.parse(report.finishedAt) > recordedAt) failures.push("responsiveness_report_finished_after_evidence");
}

export function parseBetaManualEvidenceArgs(values: string[]): BetaManualEvidenceArguments {
  if (values.length !== 8) throw new BetaManualEvidenceError("arguments_invalid");
  const entries = new Map<string, string>();
  for (let index = 0; index < values.length; index += 2) {
    const name = values[index];
    const value = values[index + 1];
    if (!name || !value || entries.has(name)) throw new BetaManualEvidenceError("arguments_invalid");
    entries.set(name, value);
  }
  if ([...entries.keys()].some((name) => !new Set([
    "--input",
    "--expected-revision",
    "--expected-digest",
    "--responsiveness-report"
  ]).has(name))) throw new BetaManualEvidenceError("arguments_invalid");

  const input = entries.get("--input");
  const expectedRevision = entries.get("--expected-revision");
  const expectedDigest = entries.get("--expected-digest");
  const responsivenessReport = entries.get("--responsiveness-report");
  if (!input || !expectedRevision || !expectedDigest || !responsivenessReport) {
    throw new BetaManualEvidenceError("arguments_invalid");
  }
  if (!revisionSchema.safeParse(expectedRevision).success || isZeroHex(expectedRevision)) {
    throw new BetaManualEvidenceError("expected_revision_argument_invalid");
  }
  if (!digestSchema.safeParse(expectedDigest).success || isZeroHex(expectedDigest.slice("sha256:".length))) {
    throw new BetaManualEvidenceError("expected_digest_argument_invalid");
  }
  return {
    inputPath: resolve(input),
    expectedRevision,
    expectedDigest,
    responsivenessReportPath: resolve(responsivenessReport)
  };
}

function readBoundedRegularFile(path: string, maximumBytes: number, errorCode: string) {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size <= 0 || before.size > maximumBytes) throw new Error("unsafe_file");
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor);
    if (
      bytes.length !== before.size
      || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs
    ) throw new Error("file_changed");
    return bytes;
  } catch {
    throw new BetaManualEvidenceError(errorCode);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function readEvidence(path: string) {
  return readBoundedRegularFile(path, maximumEvidenceBytes, "evidence_file_invalid").toString("utf8");
}

export function readResponsivenessReport(path: string) {
  return readBoundedRegularFile(path, maximumResponsivenessReportBytes, "responsiveness_report_file_invalid");
}

export function readCanonicalResponsivenessHarnessSha256(expectedRevision: string, repoRoot = repositoryRoot) {
  if (!revisionSchema.safeParse(expectedRevision).success || isZeroHex(expectedRevision)) {
    throw new BetaManualEvidenceError("expected_revision_invalid");
  }
  try {
    const bytes = execFileSync(
      "git",
      ["--no-pager", "--no-replace-objects", "show", `${expectedRevision}:${responsivenessHarnessGitPath}`],
      {
        cwd: repoRoot,
        env: boundedGitEnvironment(),
        maxBuffer: maximumResponsivenessHarnessBytes,
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    if (bytes.length === 0 || bytes.length > maximumResponsivenessHarnessBytes) throw new Error("harness_blob_invalid");
    return crypto.createHash("sha256").update(bytes).digest("hex");
  } catch {
    throw new BetaManualEvidenceError("responsiveness_harness_source_unavailable");
  }
}

function boundedGitEnvironment() {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat", LC_ALL: "C" };
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(key)) delete env[key];
  }
  for (const key of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_COMMON_DIR",
    "GIT_CONFIG",
    "GIT_CONFIG_COUNT",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_REPLACE_REF_BASE",
    "GIT_WORK_TREE"
  ]) delete env[key];
  return env;
}

async function main() {
  try {
    const arguments_ = parseBetaManualEvidenceArgs(process.argv.slice(2));
    const summary = buildBetaManualEvidenceSummary(readEvidence(arguments_.inputPath), {
      expectedRevision: arguments_.expectedRevision,
      expectedDigest: arguments_.expectedDigest,
      expectedHarnessSha256: readCanonicalResponsivenessHarnessSha256(arguments_.expectedRevision),
      responsivenessReport: readResponsivenessReport(arguments_.responsivenessReportPath)
    });
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    process.exitCode = summary.status === "passed" ? 0 : 1;
  } catch (error) {
    const code = error instanceof BetaManualEvidenceError ? error.code : "evidence_validation_failed";
    process.stdout.write(`${JSON.stringify({ schemaVersion, status: "incomplete", failures: [], incompleteReasons: [code] }, null, 2)}\n`);
    process.exitCode = 2;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) void main();
