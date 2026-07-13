import crypto from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const schemaVersion = "moodarr-beta-manual-evidence-v1";
const maximumEvidenceBytes = 64 * 1024;
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

export class BetaManualEvidenceError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export function validateBetaManualEvidence(value: unknown) {
  const parsed = betaManualEvidenceSchema.safeParse(value);
  if (!parsed.success) throw new BetaManualEvidenceError("evidence_schema_invalid");
  const evidence = parsed.data;
  const failures: string[] = [];

  if (evidence.unraid.imageVersion !== evidence.candidate.version) failures.push("unraid_version_mismatch");
  if (evidence.unraid.imageRevision !== evidence.candidate.revision) failures.push("unraid_revision_mismatch");
  if (evidence.unraid.imageDigest !== evidence.candidate.digest) failures.push("unraid_digest_mismatch");
  addFailedBooleans(failures, "unraid", evidence.unraid.checks);
  addFailedBooleans(failures, "integration", evidence.integrations.checks);

  const families = new Set(evidence.browsers.map((browser) => browser.family));
  if (families.size !== 4) failures.push("browser_matrix_incomplete");
  for (const family of ["chrome", "edge", "firefox", "safari"] as const) {
    const browser = evidence.browsers.find((entry) => entry.family === family);
    if (!browser) continue;
    if (family === "safari" && browser.platform !== "macos") failures.push("safari_platform_invalid");
    if (browser.consoleErrorCount !== 0) failures.push(`${family}_console_errors`);
    addFailedBooleans(failures, family, browser.checks);
  }

  if (evidence.responsiveness.status !== "passed") failures.push("responsiveness_not_passed");
  if (!evidence.responsiveness.native) failures.push("responsiveness_not_native");
  return { evidence, failures: [...new Set(failures)].sort(), passed: failures.length === 0 };
}

export function buildBetaManualEvidenceSummary(raw: string) {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BetaManualEvidenceError("evidence_json_invalid");
  }
  const result = validateBetaManualEvidence(value);
  return {
    schemaVersion,
    status: result.passed ? "passed" as const : "failed" as const,
    candidate: result.evidence.candidate,
    recordedAt: result.evidence.recordedAt,
    environments: {
      unraid: result.evidence.unraid.version,
      docker: result.evidence.unraid.dockerVersion,
      plex: result.evidence.integrations.plex.version,
      seerrProduct: result.evidence.integrations.seerr.product,
      seerr: result.evidence.integrations.seerr.version,
      browsers: result.evidence.browsers.map(({ family, version, platform, platformVersion }) => ({ family, version, platform, platformVersion }))
    },
    evidenceSha256: crypto.createHash("sha256").update(raw).digest("hex"),
    failures: result.failures
  };
}

function addFailedBooleans(failures: string[], prefix: string, values: Record<string, boolean>) {
  for (const [code, passed] of Object.entries(values)) {
    if (!passed) failures.push(`${prefix}_${camelToSnake(code)}`);
  }
}

function camelToSnake(value: string) {
  return value.replace(/[A-Z]/g, (character) => `_${character.toLowerCase()}`);
}

function parseInputPath(values: string[]) {
  if (values.length !== 2 || values[0] !== "--input" || !values[1]) throw new BetaManualEvidenceError("input_argument_invalid");
  return resolve(values[1]);
}

function readEvidence(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maximumEvidenceBytes) {
    throw new BetaManualEvidenceError("evidence_file_invalid");
  }
  return readFileSync(path, "utf8");
}

async function main() {
  try {
    const path = parseInputPath(process.argv.slice(2));
    const summary = buildBetaManualEvidenceSummary(readEvidence(path));
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
