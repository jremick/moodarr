import crypto from "node:crypto";
import net from "node:net";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { releaseBundleScanScript } from "./release-bundle-policy";

export const cleanInstallSchema = "moodarr-beta-clean-install-v1" as const;
export const expectedPosterSha256 = "431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460";

const officialImagePattern = /^ghcr\.io\/jremick\/moodarr@sha256:[0-9a-f]{64}$/;
const localImagePattern = /^[a-z0-9][a-z0-9._/-]{0,180}(?::[A-Za-z0-9][A-Za-z0-9._-]{0,127})?$/;
const revisionPattern = /^[0-9a-f]{40}$/;
const expectedBetaVersion = "0.1.0-beta.1";
const ownerLabel = "io.moodarr.beta-install.owner";
const helperImage = "node:24-bookworm-slim@sha256:0778d035a13f3f3833b7f2cb750e0df6cbce45583e84fd822f499f0c902a6c74";
const helperCanonicalDigest = "node@sha256:0778d035a13f3f3833b7f2cb750e0df6cbce45583e84fd822f499f0c902a6c74";
const expectedMemory = 2 * 1024 * 1024 * 1024;
const expectedCpus = 2_000_000_000;
const expectedPids = 128;
const commandTimeoutMs = 30_000;
const phaseBudgetMs = 4 * 60_000;
const maximumOutputBytes = 4 * 1024 * 1024;
const maximumResponseBytes = 2 * 1024 * 1024;
const syntheticCatalogVersion = "beta-install-wikidata-full-snapshot-v1";
const syntheticCatalogTitle = "Beta Catalog Moonlit Orchard";
const syntheticCatalogTmdbId = 8_888_101;
const syntheticCatalogRecord = {
  id: "Q8888101",
  mediaType: "film",
  label: syntheticCatalogTitle,
  description: "A quiet synthetic fantasy film about friends restoring a moonlit orchard.",
  publicationDate: "2025-01-01",
  genreLabels: ["Fantasy"],
  tmdbMovieId: syntheticCatalogTmdbId,
  tmdbTvId: 9_999_101,
  sitelinkCount: 12,
  hasEnglishWikipedia: true
} as const;
const syntheticCatalogFixtureBody = `${JSON.stringify(syntheticCatalogRecord)}\n`;
export const syntheticCatalogFileSha256 = crypto.createHash("sha256").update(syntheticCatalogFixtureBody).digest("hex");
const lifecycleCheckCodes = [
  "runtime_hardening_ok", "health_identity_ok", "settings_persisted_ok", "production_adapters_ok",
  "owned_sync_ok", "ai_build_policy_ok", "tmdb_content_policy_ok", "request_attempt_preview_ok",
  "request_attempt_create_ok", "request_attempt_idempotency_ok", "ai_off_search_ok", "exact_png_ok",
  "redaction_ok", "sqlite_integrity_ok", "sqlite_foreign_keys_ok", "catalog_request_attempt_discovery_ok",
  "catalog_request_attempt_disclosure_ok", "catalog_request_attempt_generic_isolation_ok",
  "catalog_request_attempt_verified_filter_isolation_ok"
] as const;
export const requiredInstallModeCheckCodes = [
  ...lifecycleCheckCodes,
  "catalog_full_snapshot_bootstrap_ok",
  "request_uncertain_outcome_ok",
  "request_uncertain_reconciliation_ok",
  "request_reconciliation_durable_audit_ok",
  "catalog_persisted_before_sync_ok",
  "deterministic_stub_calls_ok"
] as const;
const expectedInstallModeCheckCount = 25;
const requiredInstallModeCheckCodeSet = new Set<string>(requiredInstallModeCheckCodes);
const sourceFiles = {
  harness: "scripts/validate-beta-install.ts",
  bundle_policy: "scripts/release-bundle-policy.ts",
  stub: "scripts/fixtures/beta-install-integrations.mjs",
  compose: "docker-compose.example.yml"
} as const;
const trustedBinaryDirectories = ["/usr/local/bin", "/usr/bin", "/bin", "/opt/homebrew/bin"] as const;

export class InstallValidationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "InstallValidationError";
  }
}

export interface InstallOptions {
  candidateImage: string;
  expectedRevision: string;
  expectedVersion: string;
  official: boolean;
  allowLocalImage: boolean;
  allowDirty: boolean;
  allowEmulation: boolean;
}

export interface SourceBindingInput {
  expectedRevision: string;
  headRevision: string;
  clean: boolean;
  committedMatches: Record<keyof typeof sourceFiles, boolean>;
  allowDirty: boolean;
}

export interface SyncEvidence {
  accepted: boolean;
  acceptedStartedAt?: string;
  baselineFingerprint?: string;
  observedRunning: boolean;
  observedProgressStartedAt?: string;
  result?: {
    ok?: boolean;
    startedAt?: string;
    finishedAt?: string;
    plexItems?: number;
    seerrItems?: number;
  };
  resultFingerprint?: string;
}

export interface CatalogSnapshot {
  totalItems: number;
  plexItems: number;
  seerrItems: number;
  identitySha256: string;
}

export type RequestCreationEvidencePhase = "normal" | "uncertain" | "reconciled";
export type RequestValidationLifecyclePhase = "none" | "create-and-reconcile" | "verify-durable-after-recreate";

export function requestValidationPhaseForCompletedLifecycles(completedLifecycles: number): RequestValidationLifecyclePhase {
  if (completedLifecycles === 1) return "create-and-reconcile";
  if (completedLifecycles === 2) return "verify-durable-after-recreate";
  return "none";
}

export function requestAttemptIdempotencyKeyForLifecycle(owner: string, completedLifecycles: number) {
  if (!/^[0-9a-f]{36}$/.test(owner) || !Number.isSafeInteger(completedLifecycles) || completedLifecycles < 0 || completedLifecycles > 2) {
    throw new InstallValidationError("request_attempt_lifecycle_identity_invalid");
  }
  return `beta-install-${owner}-lifecycle-${completedLifecycles + 1}`;
}

export interface RequestCreationEvidence {
  operationCount: number;
  operationStatus?: string;
  operationErrorPresent: boolean;
  operationResponseConfirmed: boolean;
  operationResponseReconciled: boolean;
  requestCount: number;
  requestStatus?: string;
  requestHasExternalId: boolean;
  createdAudits: number;
  failedAudits: number;
  reconciliationAudits: number;
}

export function validateRequestCreationEvidence(
  evidence: RequestCreationEvidence,
  phase: RequestCreationEvidencePhase,
  expectedOperationCount = 1
) {
  if (!Number.isSafeInteger(expectedOperationCount) || expectedOperationCount < 1 || evidence.operationCount !== expectedOperationCount) return false;
  if (phase === "normal") {
    return evidence.operationStatus === "created"
      && !evidence.operationErrorPresent
      && evidence.operationResponseConfirmed
      && !evidence.operationResponseReconciled
      && evidence.requestCount === 1
      && evidence.requestStatus === "approved"
      && evidence.requestHasExternalId
      && evidence.createdAudits === expectedOperationCount
      && evidence.failedAudits === 0
      && evidence.reconciliationAudits === 0;
  }
  if (phase === "uncertain") {
    return evidence.operationStatus === "uncertain"
      && evidence.operationErrorPresent
      && !evidence.operationResponseConfirmed
      && !evidence.operationResponseReconciled
      && evidence.requestCount === 0
      && evidence.requestStatus === undefined
      && !evidence.requestHasExternalId
      && evidence.createdAudits === 0
      && evidence.failedAudits === 1
      && evidence.reconciliationAudits === 0;
  }
  return evidence.operationStatus === "created"
    && !evidence.operationErrorPresent
    && !evidence.operationResponseConfirmed
    && evidence.operationResponseReconciled
    && evidence.requestCount === 1
    && evidence.requestStatus === "approved"
    && !evidence.requestHasExternalId
    && evidence.createdAudits === 1
    && evidence.failedAudits === 1
    && evidence.reconciliationAudits === 1;
}

export function validateUncertainCreateResponse(value: unknown) {
  const response = asRecord(value);
  return typeof response?.error === "string"
    && response.error.includes("will reconcile before any retry")
    && response.error.includes("will not resend automatically");
}

export function catalogSnapshotsMatch(before: CatalogSnapshot, after: CatalogSnapshot) {
  return before.totalItems === after.totalItems
    && before.plexItems === after.plexItems
    && before.seerrItems === after.seerrItems
    && before.identitySha256 === after.identitySha256;
}

export interface RuntimeEvidence {
  running: boolean;
  healthStatus?: string | null;
  oomKilled: boolean;
  restartCount: number;
  imageRef: string;
  imageIdMatches: boolean;
  versionLabel?: string;
  revisionLabel?: string;
  aiProviderPolicyLabel?: string;
  tmdbContentPolicyLabel?: string;
  user: string;
  readonly: boolean;
  init: boolean;
  privileged: boolean;
  capAdd: string[];
  capDrop: string[];
  securityOpt: string[];
  pidsLimit: number;
  memory: number;
  memorySwap: number;
  nanoCpus: number;
  restartPolicy: string;
  stopTimeout: number;
  tmpfs: Record<string, string>;
  portBindings: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
  mounts: Array<{ Type: string; Name?: string; Destination: string; RW: boolean }>;
  expectedImageRef: string;
  expectedVersion: string;
  expectedRevision: string;
  expectedVolume: string;
  expectedPort: number;
  expectedRestartPolicy: "no" | "unless-stopped";
}

export interface ModeResult {
  passed: boolean;
  checkCodes: string[];
  counts: {
    lifecycles: number;
    plexItems: number;
    seerrItems: number;
    searchResults: number;
    posterBytes: number;
    stubCalls: number;
  };
  failures: string[];
  incomplete: string[];
}

export interface SafeReportInput {
  official: boolean;
  candidateDigest?: string;
  expectedVersion: string;
  expectedRevision: string;
  sourceHashes?: Partial<Record<keyof typeof sourceFiles, string>>;
  platform?: Partial<PlatformEvidence>;
  docker: ModeResult;
  compose: ModeResult;
  releaseEligible: boolean;
  incomplete?: string[];
}

interface PlatformEvidence {
  endpointLocalUnix: boolean;
  dockerClientVersion: string;
  dockerServerVersion: string;
  composeVersion: string;
  daemonOs: string;
  daemonArch: string;
  imageOs: string;
  imageArch: string;
  native: boolean;
}

interface DockerClient {
  endpoint: string;
  env: NodeJS.ProcessEnv;
  run(args: string[], timeoutMs?: number): string;
  tryRun(args: string[], timeoutMs?: number): { ok: boolean; stdout: string };
}

interface ResourceSet {
  owner: string;
  volume: string;
  network: string;
  frontNetwork?: string;
  composeNetwork?: string;
  container: string;
  stub: string;
  project?: string;
  tempDir: string;
  appEnv: string;
  stubEnv: string;
  composeOverride: string;
  catalogFixture: string;
  port: number;
  plexToken: string;
  seerrKey: string;
  openAiKey: string;
  adminToken: string;
  stubCounts: StubCounts;
}

export interface StubCounts {
  plexIdentity: number;
  plexSections: number;
  plexLibraryPages: number;
  plexPoster: number;
  seerrStatus: number;
  seerrRequests: number;
  seerrCreates: number;
  seerrDroppedResponses: number;
  seerrDetails: number;
  rejected: number;
  unknown: number;
}

export interface CatalogRequestAttemptEvidence {
  genericSearch: unknown;
  attemptSearch: unknown;
  verifiedRequestableSearch: unknown;
  preview: unknown;
}

export const requiredInstallStubCounts: Readonly<StubCounts> = Object.freeze({
  plexIdentity: 6,
  plexSections: 3,
  plexLibraryPages: 6,
  plexPoster: 1,
  seerrStatus: 3,
  seerrRequests: 12,
  seerrCreates: 4,
  seerrDroppedResponses: 1,
  seerrDetails: 0,
  rejected: 0,
  unknown: 0
});

interface InspectSourceResult {
  input: SourceBindingInput;
  hashes: Record<keyof typeof sourceFiles, string>;
}

const emptyCounts = (): StubCounts => ({
  plexIdentity: 0,
  plexSections: 0,
  plexLibraryPages: 0,
  plexPoster: 0,
  seerrStatus: 0,
  seerrRequests: 0,
  seerrCreates: 0,
  seerrDroppedResponses: 0,
  seerrDetails: 0,
  rejected: 0,
  unknown: 0
});

export function validateProtocolStubCounts(counts: StubCounts) {
  return (Object.keys(requiredInstallStubCounts) as Array<keyof StubCounts>)
    .every((key) => counts[key] === requiredInstallStubCounts[key]);
}

export function validateCatalogBootstrapImportSummary(value: unknown) {
  const summary = asRecord(value);
  return summary?.source === "wikidata"
    && summary.sourceVersion === syntheticCatalogVersion
    && summary.records === 1
    && summary.imported === 1
    && summary.skipped === 0
    && summary.mediaItemsUpserted === 1
    && summary.sourceRecordsUpserted === 1
    && summary.changedSourceRecords === 1
    && summary.unchangedSourceRecords === 0
    && summary.inactiveSourceRecords === 0
    && stableJson(summary.skippedReasons) === "{}"
    && summary.ignoredNotRequired === 0
    && summary.dryRun === false
    && summary.rehydrateRequired === false
    && summary.expectedRefreshRequired === undefined
    && summary.expectedSourceRecords === 1
    && summary.expectedFileSha256 === syntheticCatalogFileSha256
    && summary.fileSha256 === syntheticCatalogFileSha256
    && summary.uniqueImportableSourceRecords === 1
    && summary.refreshRequiredBefore === 0
    && summary.refreshRequiredSourceRecordsBefore === 0
    && summary.refreshRequiredRemaining === 0
    && summary.refreshRequiredSourceRecordsRemaining === 0
    && summary.mode === "full_snapshot"
    && summary.batchSize === 1
    && summary.limit === undefined;
}

export function validateCatalogRequestAttemptEvidence(evidence: CatalogRequestAttemptEvidence) {
  const generic = asRecord(evidence.genericSearch);
  const attempt = asRecord(evidence.attemptSearch);
  const verified = asRecord(evidence.verifiedRequestableSearch);
  const preview = asRecord(evidence.preview);
  const genericResults = Array.isArray(generic?.results) ? generic.results : undefined;
  const attemptResults = Array.isArray(attempt?.results) ? attempt.results : undefined;
  const verifiedResults = Array.isArray(verified?.results) ? verified.results : undefined;
  const attemptMatches = attemptResults?.filter((entry) => asRecord(entry)?.title === syntheticCatalogTitle) ?? [];
  const row = attemptMatches.length === 1 ? asRecord(attemptMatches[0]) : undefined;
  const requestAttempt = asRecord(row?.requestAttempt);
  const metadata = asRecord(row?.metadata);
  const previewRequest = asRecord(preview?.request);
  const previewItem = asRecord(preview?.item);
  const previewAttempt = asRecord(previewItem?.requestAttempt);
  const explanation = optionalString(row?.availabilityExplanation) ?? "";
  const failures: string[] = [];

  if (
    attempt?.usedAi !== false
    || !attemptResults
    || !row
    || typeof row.id !== "string"
    || !row.id
    || row.availabilityGroup !== "unavailable"
    || metadata?.source !== "catalog"
    || metadata.catalogSourceCount !== 1
    || row.seerr !== undefined
  ) failures.push("catalog_request_attempt_discovery_mismatch");

  if (
    !row
    || requestAttempt?.available !== true
    || requestAttempt.seerrAvailabilityChecked !== false
    || Object.keys(requestAttempt).sort().join(",") !== "available,seerrAvailabilityChecked"
    || !explanation.includes("has not checked Seerr availability")
    || !explanation.includes("one request attempt")
    || preview?.canRequest !== true
    || preview.requestMode !== "attempt"
    || preview.seerrAvailabilityChecked !== false
    || preview.requiresConfirmation !== true
    || preview.confirmationPhrase !== `REQUEST ${syntheticCatalogTitle.toUpperCase()}`
    || typeof preview.confirmationToken !== "string"
    || !/^[0-9a-f]{64}$/.test(preview.confirmationToken)
    || previewRequest?.mediaType !== "movie"
    || previewRequest.mediaId !== syntheticCatalogTmdbId
    || previewRequest.title !== syntheticCatalogTitle
    || previewItem?.id !== row.id
    || previewItem?.availabilityGroup !== "unavailable"
    || previewAttempt?.available !== true
    || previewAttempt.seerrAvailabilityChecked !== false
  ) failures.push("catalog_request_attempt_disclosure_mismatch");

  if (
    generic?.usedAi !== false
    || !genericResults
    || genericResults.some((entry) => asRecord(entry)?.title === syntheticCatalogTitle)
  ) failures.push("catalog_request_attempt_generic_isolation_mismatch");

  if (
    verified?.usedAi !== false
    || !verifiedResults
    || verifiedResults.some((entry) => asRecord(entry)?.title === syntheticCatalogTitle)
  ) failures.push("catalog_request_attempt_verified_filter_isolation_mismatch");

  return { valid: failures.length === 0, failures };
}

export function parseInstallArgs(values: string[]): InstallOptions {
  const parsed = new Map<string, string>();
  const flags = new Set<string>();
  const valueOptions = new Set(["--candidate-image", "--expected-revision", "--expected-version"]);
  const flagOptions = new Set(["--allow-local-image", "--allow-dirty", "--allow-emulation"]);
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index]!;
    if (flagOptions.has(key)) {
      if (flags.has(key)) throw new InstallValidationError("duplicate_option");
      flags.add(key);
      continue;
    }
    if (!valueOptions.has(key)) throw new InstallValidationError("unknown_option");
    const value = values[++index];
    if (!value || value.startsWith("--")) throw new InstallValidationError("missing_option_value");
    if (parsed.has(key)) throw new InstallValidationError("duplicate_option");
    parsed.set(key, value);
  }
  const candidateImage = parsed.get("--candidate-image");
  const expectedRevision = parsed.get("--expected-revision");
  const expectedVersion = parsed.get("--expected-version");
  if (!candidateImage || !expectedRevision || !expectedVersion) throw new InstallValidationError("missing_required_option");
  if (!revisionPattern.test(expectedRevision)) throw new InstallValidationError("invalid_expected_revision");
  if (expectedVersion !== expectedBetaVersion) throw new InstallValidationError("invalid_expected_version");
  const official = officialImagePattern.test(candidateImage);
  const allowLocalImage = flags.has("--allow-local-image");
  const allowDirty = flags.has("--allow-dirty");
  const allowEmulation = flags.has("--allow-emulation");
  if (official && (allowLocalImage || allowDirty || allowEmulation)) throw new InstallValidationError("rehearsal_flags_rejected_for_official_candidate");
  if (!official) {
    if (!localImagePattern.test(candidateImage) || candidateImage.includes("@")) throw new InstallValidationError("invalid_candidate_image");
    if (!allowLocalImage) throw new InstallValidationError("local_rehearsal_requires_explicit_flags");
  }
  return { candidateImage, expectedRevision, expectedVersion, official, allowLocalImage, allowDirty, allowEmulation };
}

export function validateSourceBinding(input: SourceBindingInput) {
  const failures: string[] = [];
  if (input.headRevision !== input.expectedRevision) failures.push("source_revision_mismatch");
  if (!input.clean && !input.allowDirty) failures.push("source_dirty");
  if (!input.allowDirty) {
    for (const [name, matches] of Object.entries(input.committedMatches)) {
      if (!matches) failures.push(`source_${name}_mismatch`);
    }
  }
  return { eligible: failures.length === 0 && !input.allowDirty, failures };
}

export function validateSyncEvidence(evidence: SyncEvidence, expected = { plexItems: 2, seerrItems: 3 }) {
  const failures: string[] = [];
  const acceptedAt = Date.parse(evidence.acceptedStartedAt ?? "");
  const resultStartedAt = Date.parse(evidence.result?.startedAt ?? "");
  const resultFinishedAt = Date.parse(evidence.result?.finishedAt ?? "");
  if (!evidence.accepted || !Number.isFinite(acceptedAt)) failures.push("sync_not_accepted");
  if (!evidence.observedRunning) failures.push("sync_ownership_unproven");
  if (!evidence.result || evidence.resultFingerprint === evidence.baselineFingerprint) failures.push("sync_result_stale");
  if (!evidence.result?.ok) failures.push("sync_result_failed");
  if (!Number.isFinite(resultStartedAt) || resultStartedAt < acceptedAt || !Number.isFinite(resultFinishedAt) || resultFinishedAt < resultStartedAt) {
    failures.push("sync_timestamp_mismatch");
  }
  if (evidence.observedProgressStartedAt && evidence.observedProgressStartedAt !== evidence.result?.startedAt) failures.push("sync_progress_result_mismatch");
  if (evidence.result?.plexItems !== expected.plexItems || evidence.result?.seerrItems !== expected.seerrItems) failures.push("sync_count_mismatch");
  return { valid: failures.length === 0, failures };
}

export function validateConnectionEvidence(value: unknown) {
  const body = asRecord(value);
  return body?.ok === true && body.mode === "live";
}

export function validatePosterEvidence(contentType: string | null | undefined, body: Uint8Array, expectedHash = expectedPosterSha256) {
  if (contentType?.split(";")[0]?.trim().toLowerCase() !== "image/png") return false;
  if (body.byteLength < 8 || Buffer.from(body.subarray(0, 8)).toString("hex") !== "89504e470d0a1a0a") return false;
  return sha256(body) === expectedHash;
}

export function validateResourceOwnership(actual: string | undefined | null, expected: string) {
  return actual === expected;
}

export function validatePlatformEvidence(platform: PlatformEvidence, allowEmulation: boolean) {
  const failures: string[] = [];
  const incomplete: string[] = [];
  if (!platform.endpointLocalUnix) failures.push("docker_endpoint_not_local_unix");
  if (platform.daemonOs !== "linux" || platform.imageOs !== "linux") failures.push("platform_not_linux");
  if (platform.imageArch !== "amd64") failures.push("image_not_amd64");
  if (!new Set(["amd64", "x86_64"]).has(platform.daemonArch)) {
    if (allowEmulation && platform.imageArch === "amd64" && platform.daemonOs === "linux") incomplete.push("platform_emulated_not_release_evidence");
    else failures.push("daemon_not_native_amd64");
  }
  return { valid: failures.length === 0, failures, incomplete };
}

export function validateRuntimeEvidence(value: RuntimeEvidence) {
  const failures: string[] = [];
  if (!value.running || value.healthStatus !== "healthy") failures.push("container_unhealthy");
  if (value.oomKilled || value.restartCount !== 0) failures.push("container_runtime_instability");
  if (value.imageRef !== value.expectedImageRef || !value.imageIdMatches) failures.push("container_image_mismatch");
  if (
    value.versionLabel !== value.expectedVersion
    || value.revisionLabel !== value.expectedRevision
    || value.aiProviderPolicyLabel !== "none"
    || value.tmdbContentPolicyLabel !== "none"
  ) {
    failures.push("container_identity_mismatch");
  }
  if (value.user !== "999:999" || !value.readonly || !value.init || value.privileged) failures.push("container_hardening_mismatch");
  if (value.capAdd.length !== 0 || value.capDrop.length !== 1 || value.capDrop[0] !== "ALL") failures.push("container_capabilities_mismatch");
  if (value.securityOpt.length !== 1 || !new Set(["no-new-privileges", "no-new-privileges:true"]).has(value.securityOpt[0] ?? "")) {
    failures.push("container_nnp_mismatch");
  }
  if (value.pidsLimit !== expectedPids || value.memory !== expectedMemory || value.memorySwap !== expectedMemory || value.nanoCpus !== expectedCpus) {
    failures.push("container_resource_limits_mismatch");
  }
  if (value.restartPolicy !== value.expectedRestartPolicy || value.stopTimeout !== 30) failures.push("container_lifecycle_policy_mismatch");
  const tmpfs = new Set((value.tmpfs["/tmp"] ?? "").split(","));
  if (
    tmpfs.size !== 6
    || !["rw", "nosuid", "nodev", "noexec", "mode=1777"].every((entry) => tmpfs.has(entry))
    || (!tmpfs.has("size=512m") && !tmpfs.has("size=536870912"))
  ) failures.push("container_tmpfs_mismatch");
  const ports = value.portBindings["4401/tcp"] ?? [];
  if (Object.keys(value.portBindings).length !== 1 || ports?.length !== 1 || ports[0]?.HostIp !== "127.0.0.1" || Number(ports[0]?.HostPort) !== value.expectedPort) {
    failures.push("container_port_mismatch");
  }
  const mount = value.mounts.find((entry) => entry.Destination === "/data");
  if (value.mounts.length !== 1 || mount?.Type !== "volume" || mount.Name !== value.expectedVolume || !mount.RW) failures.push("container_data_mount_mismatch");
  return { valid: failures.length === 0, failures };
}

export function validatePersistenceEvidence(input: { before: unknown; after: unknown; configMode: number; integrity: string; foreignKeysOk: boolean }) {
  const failures: string[] = [];
  if (stableJson(input.before) !== stableJson(input.after)) failures.push("settings_persistence_drift");
  if (input.configMode !== 0o600) failures.push("config_mode_mismatch");
  if (input.integrity !== "ok") failures.push("sqlite_integrity_failed");
  if (input.foreignKeysOk !== true) failures.push("sqlite_foreign_keys_failed");
  return { valid: failures.length === 0, failures };
}

export function buildSafeReport(input: SafeReportInput) {
  const docker = sanitizeMode(input.docker);
  const compose = sanitizeMode(input.compose);
  const passed = docker.passed && compose.passed;
  return {
    schema: cleanInstallSchema,
    candidate: {
      kind: input.official ? "official-digest" : "local-rehearsal",
      ...(input.candidateDigest ? { digest: safeDigest(input.candidateDigest) } : {}),
      version: safeVersion(input.expectedVersion),
      revision: safeRevision(input.expectedRevision)
    },
    sourceHashes: {
      harness: safeHash(input.sourceHashes?.harness),
      bundlePolicy: safeHash(input.sourceHashes?.bundle_policy),
      stub: safeHash(input.sourceHashes?.stub),
      compose: safeHash(input.sourceHashes?.compose)
    },
    platform: {
      endpointLocalUnix: input.platform?.endpointLocalUnix === true,
      dockerClientVersion: safeToolVersion(input.platform?.dockerClientVersion),
      dockerServerVersion: safeToolVersion(input.platform?.dockerServerVersion),
      composeVersion: safeToolVersion(input.platform?.composeVersion),
      daemonOs: safePlatformName(input.platform?.daemonOs),
      daemonArch: safePlatformName(input.platform?.daemonArch),
      imageOs: safePlatformName(input.platform?.imageOs),
      imageArch: safePlatformName(input.platform?.imageArch),
      native: input.platform?.native === true
    },
    modes: {
      docker,
      compose
    },
    passed,
    releaseEligible: input.official && input.releaseEligible && passed,
    incomplete: safeCodes(input.incomplete ?? [])
  };
}

export async function runCleanInstallValidation(options: InstallOptions) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const empty = () => emptyModeResult();
  let source: InspectSourceResult | undefined;
  let sourceValidation = { eligible: false, failures: ["source_inspection_incomplete"] };
  let platform: PlatformEvidence | undefined;
  let platformIncomplete: string[] = [];
  let dockerResult = empty();
  let composeResult = empty();
  const topIncomplete: string[] = [];

  try {
    source = inspectSource(repoRoot, options);
    sourceValidation = validateSourceBinding(source.input);
    if (sourceValidation.failures.length > 0) topIncomplete.push(...sourceValidation.failures);
  } catch (error) {
    topIncomplete.push(errorCode(error, "source_inspection_incomplete"));
  }

  let docker: DockerClient | undefined;
  try {
    docker = discoverDockerClient();
    const image = inspectCandidateImage(docker, options);
    inspectHelperImage(docker);
    platform = inspectPlatform(docker, image);
    const checked = validatePlatformEvidence(platform, options.allowEmulation && !options.official);
    if (!checked.valid) topIncomplete.push(...checked.failures);
    platformIncomplete = checked.incomplete;
    topIncomplete.push(...checked.incomplete);
    if (checked.valid) {
      dockerResult = await withElapsedPhaseBudget(runDockerMode(docker, repoRoot, options, image.id), phaseBudgetMs, "docker_phase_budget_exceeded");
      composeResult = await withElapsedPhaseBudget(runComposeMode(docker, repoRoot, options, image.id), phaseBudgetMs, "compose_phase_budget_exceeded");
    }
  } catch (error) {
    const code = errorCode(error, "docker_preflight_incomplete");
    topIncomplete.push(code);
    if (!dockerResult.passed && dockerResult.failures.length === 0) dockerResult.incomplete.push(code);
    if (!composeResult.passed && composeResult.failures.length === 0) composeResult.incomplete.push(code);
  }

  const releaseEligible = Boolean(
    options.official
    && sourceValidation.eligible
    && platform?.native
    && platformIncomplete.length === 0
    && dockerResult.passed
    && composeResult.passed
    && topIncomplete.length === 0
  );
  const digest = options.official ? options.candidateImage.slice(options.candidateImage.indexOf("@") + 1) : undefined;
  return buildSafeReport({
    official: options.official,
    candidateDigest: digest,
    expectedVersion: options.expectedVersion,
    expectedRevision: options.expectedRevision,
    sourceHashes: source?.hashes,
    platform,
    docker: dockerResult,
    compose: composeResult,
    releaseEligible,
    incomplete: uniqueCodes(topIncomplete)
  });
}

async function runDockerMode(docker: DockerClient, repoRoot: string, options: InstallOptions, imageId: string): Promise<ModeResult> {
  const result = emptyModeResult();
  const resources = await prepareResources("docker", options);
  let settingsSnapshot: unknown;
  let catalogSnapshot: CatalogSnapshot | undefined;
  try {
    assertResourcesAbsent(docker, resources, false);
    docker.run(["volume", "create", "--label", `${ownerLabel}=${resources.owner}`, resources.volume]);
    docker.run(["network", "create", "--label", `${ownerLabel}=${resources.owner}`, "--internal", resources.network]);
    docker.run(["network", "create", "--label", `${ownerLabel}=${resources.owner}`, resources.frontNetwork!]);
    importSyntheticCatalogSnapshot(docker, resources, options, result);
    startStub(docker, repoRoot, resources, options);
    startRawContainer(docker, resources, options);
    await waitForHealthy(docker, resources.container, options, imageId, resources, result);
    settingsSnapshot = await configureInstall(resources);
    catalogSnapshot = await validateLifecycle(docker, resources, options, imageId, settingsSnapshot, result, catalogSnapshot);

    docker.run(["restart", "--time", "30", resources.container], 45_000);
    await waitForHealthy(docker, resources.container, options, imageId, resources, result);
    catalogSnapshot = await validateLifecycle(docker, resources, options, imageId, settingsSnapshot, result, catalogSnapshot);

    removeOwnedContainer(docker, resources.container, resources.owner);
    startRawContainer(docker, resources, options);
    await waitForHealthy(docker, resources.container, options, imageId, resources, result);
    await validateLifecycle(docker, resources, options, imageId, settingsSnapshot, result, catalogSnapshot);
    result.passed = result.failures.length === 0 && result.incomplete.length === 0 && result.counts.lifecycles === 3;
  } catch (error) {
    result.failures.push(errorCode(error, "docker_mode_failed"));
  } finally {
    collectAndStopStub(docker, resources, result);
    cleanupRawResources(docker, resources, result);
    cleanupTemp(resources, result);
  }
  result.passed = result.failures.length === 0 && result.incomplete.length === 0 && result.counts.lifecycles === 3;
  return finalizeMode(result);
}

async function runComposeMode(docker: DockerClient, repoRoot: string, options: InstallOptions, imageId: string): Promise<ModeResult> {
  const result = emptyModeResult();
  const resources = await prepareResources("compose", options);
  const composeFile = join(resources.tempDir, "docker-compose.example.yml");
  copyFileSync(join(repoRoot, sourceFiles.compose), composeFile);
  chmodSync(composeFile, 0o600);
  let settingsSnapshot: unknown;
  let catalogSnapshot: CatalogSnapshot | undefined;
  try {
    assertResourcesAbsent(docker, resources, true);
    docker.run(["volume", "create", "--label", `${ownerLabel}=${resources.owner}`, resources.volume]);
    docker.run(["network", "create", "--label", `${ownerLabel}=${resources.owner}`, "--internal", resources.network]);
    importSyntheticCatalogSnapshot(docker, resources, options, result);
    composeCreate(docker, resources, options);
    validateComposeOwnership(docker, resources);
    startStub(docker, repoRoot, resources, options);
    composeRun(docker, resources, ["start", "moodarr"]);
    await waitForHealthy(docker, resources.container, options, imageId, resources, result);
    settingsSnapshot = await configureInstall(resources);
    catalogSnapshot = await validateLifecycle(docker, resources, options, imageId, settingsSnapshot, result, catalogSnapshot);

    composeRun(docker, resources, ["restart", "--timeout", "30", "moodarr"], 45_000);
    await waitForHealthy(docker, resources.container, options, imageId, resources, result);
    catalogSnapshot = await validateLifecycle(docker, resources, options, imageId, settingsSnapshot, result, catalogSnapshot);

    validateComposeOwnership(docker, resources);
    composeRun(docker, resources, ["down", "--remove-orphans"], 45_000);
    assertOwnedVolume(docker, resources);
    composeCreate(docker, resources, options);
    validateComposeOwnership(docker, resources);
    composeRun(docker, resources, ["start", "moodarr"]);
    await waitForHealthy(docker, resources.container, options, imageId, resources, result);
    await validateLifecycle(docker, resources, options, imageId, settingsSnapshot, result, catalogSnapshot);
  } catch (error) {
    result.failures.push(errorCode(error, "compose_mode_failed"));
  } finally {
    collectAndStopStub(docker, resources, result);
    cleanupComposeResources(docker, resources, result);
    cleanupTemp(resources, result);
  }
  result.passed = result.failures.length === 0 && result.incomplete.length === 0 && result.counts.lifecycles === 3;
  return finalizeMode(result);
}

async function prepareResources(mode: "docker" | "compose", options: InstallOptions): Promise<ResourceSet> {
  const owner = crypto.randomBytes(18).toString("hex");
  const prefix = `moodarrbeta${owner.slice(0, 20)}`;
  const tempDir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  chmodSync(tempDir, 0o700);
  const port = await findFreeLoopbackPort();
  const adminToken = crypto.randomBytes(32).toString("base64url");
  const plexToken = crypto.randomBytes(32).toString("base64url");
  const seerrKey = crypto.randomBytes(32).toString("base64url");
  const openAiKey = crypto.randomBytes(32).toString("base64url");
  const appEnv = join(tempDir, "app.env");
  const stubEnv = join(tempDir, "stub.env");
  const composeOverride = join(tempDir, "beta-policy.override.yml");
  const catalogFixture = join(tempDir, "beta-install-wikidata.jsonl");
  const volume = `${prefix}-data`;
  const project = mode === "compose" ? `${prefix}compose` : undefined;
  const container = project ? `${project}-moodarr-1` : `${prefix}-app`;
  const network = `${prefix}-integrations`;
  const frontNetwork = mode === "docker" ? `${prefix}-front` : undefined;
  const composeNetwork = project ? `${project}_default` : undefined;
  const stub = `${prefix}-stub`;
  writePrivateEnv(appEnv, [
    ["MOODARR_IMAGE", options.candidateImage],
    ["MOODARR_ADMIN_TOKEN", adminToken],
    ["MOODARR_WEB_ORIGIN", `http://127.0.0.1:${port}`],
    ["MOODARR_PORT", `127.0.0.1:${port}`],
    ["MOODARR_DATA_VOLUME", volume],
    ["MOODARR_BETA_INSTALL_OWNER", owner],
    ["PLEX_BASE_URL", ""],
    ["PLEX_TOKEN", ""],
    ["SEERR_BASE_URL", ""],
    ["SEERR_API_KEY", ""],
    ["AI_PROVIDER", "openai"],
    ["OPENAI_API_KEY", openAiKey],
    ["MOODARR_TMDB_CONTENT_POLICY", "configurable"]
  ]);
  writeFileSync(
    composeOverride,
    "services:\n  moodarr:\n    labels:\n      io.moodarr.beta-install.owner: ${MOODARR_BETA_INSTALL_OWNER}\n    environment:\n      AI_PROVIDER: ${AI_PROVIDER}\n      OPENAI_API_KEY: ${OPENAI_API_KEY}\n      MOODARR_TMDB_CONTENT_POLICY: ${MOODARR_TMDB_CONTENT_POLICY}\nnetworks:\n  default:\n    labels:\n      io.moodarr.beta-install.owner: ${MOODARR_BETA_INSTALL_OWNER}\n",
    { mode: 0o600 }
  );
  writePrivateEnv(stubEnv, [
    ["MOODARR_BETA_STUB_PLEX_TOKEN", plexToken],
    ["MOODARR_BETA_STUB_SEERR_KEY", seerrKey],
    ["MOODARR_BETA_STUB_UNCERTAIN_CREATE", "drop-first-response"]
  ]);
  writeFileSync(catalogFixture, syntheticCatalogFixtureBody, { mode: 0o644, flag: "wx" });
  return { owner, volume, network, frontNetwork, composeNetwork, container, stub, project, tempDir, appEnv, stubEnv, composeOverride, catalogFixture, port, plexToken, seerrKey, openAiKey, adminToken, stubCounts: emptyCounts() };
}

function importSyntheticCatalogSnapshot(docker: DockerClient, resources: ResourceSet, options: InstallOptions, result: ModeResult) {
  let summary: unknown;
  try {
    const output = docker.run([
      "run", "--rm", "--platform", "linux/amd64", "--network", "none", "--read-only", "--privileged=false",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "128",
      "--memory", "2g", "--memory-swap", "2g", "--cpus", "2", "--user", "999:999",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777", "--label", `${ownerLabel}=${resources.owner}`,
      "--mount", `type=volume,src=${resources.volume},dst=/data`,
      "--mount", `type=bind,src=${realpathSync(resources.catalogFixture)},dst=/catalog/beta-install-wikidata.jsonl,readonly`,
      "--env", "NODE_ENV=production", "--env", "MOODARR_DATA_DIR=/data", "--env", "MOODARR_CONFIG_PATH=/data/config.json",
      "--env", "MOODARR_DB_PATH=/data/moodarr.sqlite", options.candidateImage,
      "dist/server/importWikidataCatalog.js", "--file", "/catalog/beta-install-wikidata.jsonl", "--version", syntheticCatalogVersion,
      "--source", "wikidata", "--mode", "full-snapshot", "--expected-source-records", "1",
      "--expected-file-sha256", syntheticCatalogFileSha256, "--batch-size", "1"
    ], options.allowEmulation ? 90_000 : 45_000);
    summary = JSON.parse(output.trim()) as unknown;
  } catch {
    throw new InstallValidationError("catalog_full_snapshot_bootstrap_failed");
  }
  if (!validateCatalogBootstrapImportSummary(summary)) {
    throw new InstallValidationError("catalog_full_snapshot_bootstrap_mismatch");
  }
  addCodes(result.checkCodes, ["catalog_full_snapshot_bootstrap_ok"]);
}

function startStub(docker: DockerClient, repoRoot: string, resources: ResourceSet, options: InstallOptions) {
  const fixture = realpathSync(join(repoRoot, sourceFiles.stub));
  docker.run([
    "run", "--detach", "--name", resources.stub,
    "--label", `${ownerLabel}=${resources.owner}`,
    "--platform", "linux/amd64",
    "--network", resources.network,
    "--network-alias", "integrations",
    "--env-file", resources.stubEnv,
    "--read-only", "--init",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--pids-limit", "64", "--memory", "256m", "--memory-swap", "256m", "--cpus", "0.5",
    "--user", "1000:1000",
    "--mount", `type=bind,src=${fixture},dst=/fixture/beta-install-integrations.mjs,readonly`,
    helperImage,
    "node", "/fixture/beta-install-integrations.mjs"
  ], options.allowEmulation ? 60_000 : commandTimeoutMs);
}

function startRawContainer(docker: DockerClient, resources: ResourceSet, options: InstallOptions) {
  docker.run([
    "run", "--detach", "--name", resources.container,
    "--label", `${ownerLabel}=${resources.owner}`,
    "--platform", "linux/amd64",
    "--network", resources.frontNetwork!,
    "--env-file", resources.appEnv,
    "--env", "MOODARR_API_HOST=0.0.0.0",
    "--env", "MOODARR_API_PORT=4401",
    "--env", "MOODARR_SERVE_CLIENT=true",
    "--env", "MOODARR_DATA_DIR=/data",
    "--env", "MOODARR_CONFIG_PATH=/data/config.json",
    "--env", "MOODARR_DB_PATH=/data/moodarr.sqlite",
    "--env", "MOODARR_REQUIRE_ADMIN_TOKEN=true",
    "--env", "MOODARR_ADMIN_AUTO_SESSION=false",
    "--read-only", "--init",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--pids-limit", String(expectedPids),
    "--memory", "2g", "--memory-swap", "2g", "--cpus", "2",
    "--stop-timeout", "30",
    "--publish", `127.0.0.1:${resources.port}:4401`,
    "--mount", `type=volume,src=${resources.volume},dst=/data`,
    options.candidateImage
  ], options.allowEmulation ? 60_000 : commandTimeoutMs);
  docker.run(["network", "connect", resources.network, resources.container]);
}

function composeCreate(docker: DockerClient, resources: ResourceSet, options: InstallOptions) {
  composeRun(docker, resources, ["create", "--no-build", "--pull", "never", "moodarr"], options.allowEmulation ? 90_000 : 45_000);
  docker.run(["network", "connect", resources.network, resources.container]);
}

function composeRun(docker: DockerClient, resources: ResourceSet, args: string[], timeoutMs = commandTimeoutMs) {
  if (!resources.project) throw new InstallValidationError("compose_project_missing");
  return docker.run([
    "compose", "--project-name", resources.project,
    "--file", join(resources.tempDir, "docker-compose.example.yml"),
    "--file", resources.composeOverride,
    "--env-file", resources.appEnv,
    ...args
  ], timeoutMs);
}

async function configureInstall(resources: ResourceSet) {
  await requestJson(resources, "/api/admin/settings", {
    method: "PUT",
    body: JSON.stringify({ ai: { provider: "openai", openaiApiKey: resources.openAiKey } })
  }, 400);
  const response = await requestJson(resources, "/api/admin/settings", {
    method: "PUT",
    body: JSON.stringify({
      fixtureMode: false,
      plex: { baseUrl: "http://integrations:4700", token: resources.plexToken },
      seerr: { baseUrl: "http://integrations:4700", apiKey: resources.seerrKey },
      ai: { provider: "none" },
      sync: { intervalMinutes: 360, syncSeerr: true },
      search: { defaultResultLimit: 50 },
      reviewQueue: { retentionDays: 91, maxQueries: 123, captureRawQueries: false },
      plexAuth: { enabled: false, allowNewUsers: false }
    })
  }, 200, 30_000);
  validateSettings(response);
  const serialized = JSON.stringify(response);
  if (serialized.includes(resources.plexToken) || serialized.includes(resources.seerrKey) || serialized.includes(resources.adminToken)) {
    throw new InstallValidationError("settings_secret_disclosure");
  }
  return response;
}

async function validateLifecycle(
  docker: DockerClient,
  resources: ResourceSet,
  options: InstallOptions,
  imageId: string,
  settingsSnapshot: unknown,
  result: ModeResult,
  expectedCatalog?: CatalogSnapshot
) {
  const requestValidationPhase = requestValidationPhaseForCompletedLifecycles(result.counts.lifecycles);
  const runtime = inspectRuntime(docker, resources.container, options, imageId, resources);
  const runtimeValidation = validateRuntimeEvidence(runtime);
  if (!runtimeValidation.valid) throw new InstallValidationError(runtimeValidation.failures[0]!);

  const health = asRecord(await requestJson(resources, "/api/health"));
  if (
    health?.ok !== true || health.database !== "ok" || health.fixtureMode !== false
    || health.version !== options.expectedVersion || health.revision !== options.expectedRevision
  ) throw new InstallValidationError("health_identity_or_database_mismatch");
  const healthPolicies = asRecord(health?.policies);
  if (healthPolicies?.aiProvider !== "none" || healthPolicies?.tmdbContent !== "none") {
    throw new InstallValidationError("health_policy_mismatch");
  }

  const settings = await requestJson(resources, "/api/admin/settings");
  validateSettings(settings);
  const config = await requestJson(resources, "/api/config/status");
  validatePublicConfig(config);
  assertSecretsRedacted([settings, config], resources);

  await requestJson(resources, "/api/admin/embeddings/warmup", {
    method: "POST",
    body: JSON.stringify({ limit: 1 })
  }, 409);

  const storageBeforeSync = inspectStorage(docker, resources.container);
  if (
    result.counts.lifecycles === 0
    && (storageBeforeSync.catalog.totalItems !== 1 || storageBeforeSync.catalog.plexItems !== 0 || storageBeforeSync.catalog.seerrItems !== 0)
  ) throw new InstallValidationError("catalog_full_snapshot_runtime_bootstrap_mismatch");
  if (expectedCatalog && !catalogSnapshotsMatch(expectedCatalog, storageBeforeSync.catalog)) {
    throw new InstallValidationError("catalog_persistence_before_sync_failed");
  }
  if (expectedCatalog) addCodes(result.checkCodes, ["catalog_persisted_before_sync_ok"]);
  if (
    requestValidationPhase === "verify-durable-after-recreate"
    && !hasDurableRequestCreationEvidence(storageBeforeSync, result.counts.lifecycles)
  ) {
    throw new InstallValidationError("request_reconciliation_durable_audit_mismatch_before_sync");
  }

  await validateSyntheticCatalogRequestAttempt(resources, result);

  const plex = await requestJson(resources, "/api/plex/test", { method: "POST", body: "{}" });
  const seerr = await requestJson(resources, "/api/seerr/test", { method: "POST", body: "{}" });
  if (!validateConnectionEvidence(plex) || !validateConnectionEvidence(seerr)) throw new InstallValidationError("connection_test_failed");

  const completion = await runOwnedSync(resources);
  const stats = asRecord(await requestJson(resources, "/api/library/stats"));
  if (stats?.totalItems !== 5 || stats.plexItems !== 2 || stats.seerrItems !== 3) throw new InstallValidationError("library_count_mismatch");

  const preview = asRecord(await requestJson(resources, "/api/requests/preview", {
    method: "POST",
    body: JSON.stringify({ mediaType: "movie", tmdbId: 7003 })
  }));
  const previewRequest = asRecord(preview?.request);
  if (
    preview?.canRequest !== true
    || preview.requestMode !== "attempt"
    || preview.seerrAvailabilityChecked !== false
    || preview.requiresConfirmation !== true
    || typeof preview.confirmationPhrase !== "string"
    || typeof preview.confirmationToken !== "string"
    || !/^[0-9a-f]{64}$/.test(preview.confirmationToken)
    || previewRequest?.mediaType !== "movie"
    || previewRequest.mediaId !== 7003
  ) throw new InstallValidationError("request_attempt_preview_mismatch");
  const createPayload = {
    mediaType: "movie",
    tmdbId: 7003,
    confirmed: true,
    confirmationPhrase: preview.confirmationPhrase,
    confirmationToken: preview.confirmationToken
  };
  const idempotencyKey = requestAttemptIdempotencyKeyForLifecycle(resources.owner, result.counts.lifecycles);
  const created = asRecord(await requestJson(resources, "/api/requests/create", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(createPayload)
  }));
  const createdRequest = asRecord(created?.request);
  const createdSeerr = asRecord(created?.seerr);
  if (created?.ok !== true || createdRequest?.mediaId !== 7003 || createdSeerr?.id !== 9003) {
    throw new InstallValidationError("request_attempt_create_mismatch");
  }
  const repeated = await requestJson(resources, "/api/requests/create", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(createPayload)
  });
  if (stableJson(repeated) !== stableJson(created)) throw new InstallValidationError("request_attempt_idempotency_mismatch");
  if (requestValidationPhase === "create-and-reconcile") await validateUncertainRequestReconciliation(docker, resources, result);

  const search = asRecord(await requestJson(resources, "/api/search", {
    method: "POST",
    body: JSON.stringify({ query: "Beta Candidate Harbor", resultLimit: 1, useAi: true, watchContext: "solo" })
  }, 200, 30_000));
  const searchResults = Array.isArray(search?.results) ? search.results : [];
  const first = asRecord(searchResults[0]);
  if (search?.usedAi !== false || searchResults.length !== 1 || typeof first?.posterUrl !== "string" || !first.posterUrl.startsWith("/api/items/")) {
    throw new InstallValidationError("ai_off_search_mismatch");
  }
  const poster = await requestBytes(resources, first.posterUrl);
  if (!validatePosterEvidence(poster.contentType, poster.body)) throw new InstallValidationError("poster_not_exact_png");

  const support = await requestJson(resources, "/api/admin/support-bundle", {}, 200, 35_000);
  assertSecretsRedacted([support], resources);
  const storage = inspectStorage(docker, resources.container);
  const persistence = validatePersistenceEvidence({ before: settingsSnapshot, after: settings, configMode: storage.configMode, integrity: storage.integrity, foreignKeysOk: storage.foreignKeysOk });
  if (!persistence.valid) throw new InstallValidationError(persistence.failures[0]!);
  if (!storage.configObject) throw new InstallValidationError("persisted_config_invalid");
  if (storage.catalog.totalItems !== 5 || storage.catalog.plexItems !== 2 || storage.catalog.seerrItems !== 3) {
    throw new InstallValidationError("catalog_storage_mismatch");
  }
  if (requestValidationPhase === "verify-durable-after-recreate") {
    if (!hasDurableRequestCreationEvidence(storage, result.counts.lifecycles + 1)) {
      throw new InstallValidationError("request_reconciliation_durable_audit_mismatch_after_sync");
    }
    addCodes(result.checkCodes, ["request_reconciliation_durable_audit_ok"]);
  }
  result.counts.lifecycles += 1;
  result.counts.plexItems = numberValue(completion.plexItems);
  result.counts.seerrItems = numberValue(completion.seerrItems);
  result.counts.searchResults = searchResults.length;
  result.counts.posterBytes = poster.body.byteLength;
  addCodes(result.checkCodes, [...lifecycleCheckCodes]);
  return storage.catalog;
}

async function validateSyntheticCatalogRequestAttempt(resources: ResourceSet, result: ModeResult) {
  const search = (query: string, filters?: Record<string, unknown>) => requestJson(resources, "/api/search", {
    method: "POST",
    body: JSON.stringify({ query, resultLimit: 10, useAi: false, watchContext: "solo", ...(filters ? { filters } : {}) })
  }, 200, 30_000);
  const genericSearch = await search("beta catalog moonlit orchard");
  const attemptSearch = await search("I want to request Beta Catalog Moonlit Orchard");
  const attemptBody = asRecord(attemptSearch);
  const attemptResults = Array.isArray(attemptBody?.results) ? attemptBody.results : [];
  const attemptRow = attemptResults.map(asRecord).find((entry) => entry?.title === syntheticCatalogTitle);
  if (typeof attemptRow?.id !== "string" || !attemptRow.id) {
    throw new InstallValidationError("catalog_request_attempt_discovery_mismatch");
  }
  const verifiedRequestableSearch = await search("I want to request Beta Catalog Moonlit Orchard", {
    availability: ["not_in_plex_requestable"]
  });
  const preview = await requestJson(resources, "/api/requests/preview", {
    method: "POST",
    body: JSON.stringify({ itemId: attemptRow.id })
  });
  const checked = validateCatalogRequestAttemptEvidence({ genericSearch, attemptSearch, verifiedRequestableSearch, preview });
  if (!checked.valid) throw new InstallValidationError(checked.failures[0]!);
  addCodes(result.checkCodes, [
    "catalog_request_attempt_discovery_ok",
    "catalog_request_attempt_disclosure_ok",
    "catalog_request_attempt_generic_isolation_ok",
    "catalog_request_attempt_verified_filter_isolation_ok"
  ]);
}

function hasDurableRequestCreationEvidence(storage: {
  normalRequest: RequestCreationEvidence;
  uncertainRequest: RequestCreationEvidence;
}, expectedNormalOperations: number) {
  return validateRequestCreationEvidence(storage.normalRequest, "normal", expectedNormalOperations)
    && validateRequestCreationEvidence(storage.uncertainRequest, "reconciled");
}

async function validateUncertainRequestReconciliation(docker: DockerClient, resources: ResourceSet, result: ModeResult) {
  const preview = asRecord(await requestJson(resources, "/api/requests/preview", {
    method: "POST",
    body: JSON.stringify({ mediaType: "movie", tmdbId: 7004 })
  }));
  const request = asRecord(preview?.request);
  if (
    preview?.canRequest !== true
    || preview.requestMode !== "attempt"
    || preview.requiresConfirmation !== true
    || typeof preview.confirmationPhrase !== "string"
    || typeof preview.confirmationToken !== "string"
    || !/^[0-9a-f]{64}$/.test(preview.confirmationToken)
    || request?.mediaType !== "movie"
    || request.mediaId !== 7004
  ) throw new InstallValidationError("request_uncertain_preview_mismatch");

  const payload = {
    mediaType: "movie",
    tmdbId: 7004,
    confirmed: true,
    confirmationPhrase: preview.confirmationPhrase,
    confirmationToken: preview.confirmationToken
  };
  const idempotencyKey = `beta-install-uncertain-${resources.owner}`;
  const uncertain = asRecord(await requestJson(resources, "/api/requests/create", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(payload)
  }, 409));
  if (!validateUncertainCreateResponse(uncertain)) {
    throw new InstallValidationError("request_uncertain_response_mismatch");
  }
  const uncertainStorage = inspectStorage(docker, resources.container);
  if (!validateRequestCreationEvidence(uncertainStorage.uncertainRequest, "uncertain")) {
    throw new InstallValidationError("request_uncertain_storage_mismatch");
  }
  addCodes(result.checkCodes, ["request_uncertain_outcome_ok"]);

  const reconciled = asRecord(await requestJson(resources, "/api/requests/create", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(payload)
  }));
  const reconciledRequest = asRecord(reconciled?.request);
  const reconciledSeerr = asRecord(reconciled?.seerr);
  if (
    reconciled?.ok !== true
    || reconciled.reconciled !== true
    || reconciledRequest?.mediaType !== "movie"
    || reconciledRequest.mediaId !== 7004
    || reconciledSeerr?.status !== "approved"
    || reconciledSeerr.reconciled !== true
  ) throw new InstallValidationError("request_uncertain_reconciliation_mismatch");
  const repeated = await requestJson(resources, "/api/requests/create", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify(payload)
  });
  if (stableJson(repeated) !== stableJson(reconciled)) {
    throw new InstallValidationError("request_uncertain_reconciliation_idempotency_mismatch");
  }
  const reconciledStorage = inspectStorage(docker, resources.container);
  if (!validateRequestCreationEvidence(reconciledStorage.uncertainRequest, "reconciled")) {
    throw new InstallValidationError("request_uncertain_reconciliation_storage_mismatch");
  }
  addCodes(result.checkCodes, ["request_uncertain_reconciliation_ok"]);
}

async function runOwnedSync(resources: ResourceSet) {
  const baseline = asRecord(await requestJson(resources, "/api/admin/sync/status"));
  const baselineResult = baseline?.lastResult;
  const baselineFingerprint = baselineResult ? stableJson(baselineResult) : undefined;
  const accepted = asRecord(await requestJson(resources, "/api/admin/sync/run", { method: "POST", body: "{}" }, 202));
  const acceptedStartedAt = typeof accepted?.startedAt === "string" ? accepted.startedAt : undefined;
  let observedRunning = false;
  let observedProgressStartedAt: string | undefined;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const status = asRecord(await requestJson(resources, "/api/admin/sync/status"));
    const progress = asRecord(status?.progress);
    if (status?.running === true) {
      observedRunning = true;
      if (typeof progress?.startedAt === "string") observedProgressStartedAt = progress.startedAt;
    }
    const lastResult = asRecord(status?.lastResult);
    const fingerprint = lastResult ? stableJson(lastResult) : undefined;
    if (status?.running === false && lastResult && fingerprint !== baselineFingerprint) {
      const checked = validateSyncEvidence({
        accepted: accepted?.accepted === true,
        acceptedStartedAt,
        baselineFingerprint,
        observedRunning,
        observedProgressStartedAt,
        result: lastResult,
        resultFingerprint: fingerprint
      });
      if (!checked.valid) throw new InstallValidationError(checked.failures[0]!);
      return lastResult;
    }
    await delay(250);
  }
  throw new InstallValidationError("sync_timeout");
}

async function waitForHealthy(
  docker: DockerClient,
  container: string,
  options: InstallOptions,
  imageId: string,
  resources: ResourceSet,
  result: ModeResult
) {
  const deadline = Date.now() + 150_000;
  let apiHealthy = false;
  while (Date.now() < deadline) {
    const inspected = inspectRuntime(docker, container, options, imageId, resources);
    try {
      const health = asRecord(await requestJson(resources, "/api/health", {}, 200, 5_000));
      apiHealthy = health?.ok === true && health.database === "ok" && health.version === options.expectedVersion && health.revision === options.expectedRevision;
    } catch {
      apiHealthy = false;
    }
    if (apiHealthy && inspected.healthStatus === "healthy") return;
    if (!inspected.running || inspected.oomKilled || inspected.restartCount !== 0 || inspected.healthStatus === "unhealthy") {
      throw new InstallValidationError("container_unhealthy");
    }
    await delay(1_000);
  }
  if (apiHealthy) result.incomplete.push("docker_health_not_healthy_despite_http");
  throw new InstallValidationError("container_health_timeout");
}

function inspectRuntime(
  docker: DockerClient,
  container: string,
  options: InstallOptions,
  imageId: string,
  resources: ResourceSet
): RuntimeEvidence {
  const rows = parseJsonArray(docker.run(["container", "inspect", container]), "container_inspect_invalid");
  const value = asRecord(rows[0]);
  const config = asRecord(value?.Config);
  const state = asRecord(value?.State);
  const health = asRecord(state?.Health);
  const host = asRecord(value?.HostConfig);
  const labels = asRecord(config?.Labels);
  const portBindings = (asRecord(host?.PortBindings) ?? {}) as RuntimeEvidence["portBindings"];
  const tmpfs = (asRecord(host?.Tmpfs) ?? {}) as Record<string, string>;
  const mounts = Array.isArray(value?.Mounts) ? value.Mounts.flatMap((row) => {
    const item = asRecord(row);
    return item && typeof item.Type === "string" && typeof item.Destination === "string"
      ? [{ Type: item.Type, Name: typeof item.Name === "string" ? item.Name : undefined, Destination: item.Destination, RW: item.RW === true }]
      : [];
  }) : [];
  return {
    running: state?.Running === true,
    healthStatus: typeof health?.Status === "string" ? health.Status : null,
    oomKilled: state?.OOMKilled === true,
    restartCount: numberValue(value?.RestartCount),
    imageRef: stringValue(config?.Image),
    imageIdMatches: value?.Image === imageId,
    versionLabel: optionalString(labels?.["org.opencontainers.image.version"]),
    revisionLabel: optionalString(labels?.["org.opencontainers.image.revision"]),
    aiProviderPolicyLabel: optionalString(labels?.["io.moodarr.ai-provider-policy"]),
    tmdbContentPolicyLabel: optionalString(labels?.["io.moodarr.tmdb-content-policy"]),
    user: stringValue(config?.User),
    readonly: host?.ReadonlyRootfs === true,
    init: host?.Init === true,
    privileged: host?.Privileged === true,
    capAdd: stringArray(host?.CapAdd),
    capDrop: stringArray(host?.CapDrop),
    securityOpt: stringArray(host?.SecurityOpt),
    pidsLimit: numberValue(host?.PidsLimit),
    memory: numberValue(host?.Memory),
    memorySwap: numberValue(host?.MemorySwap),
    nanoCpus: numberValue(host?.NanoCpus),
    restartPolicy: stringValue(asRecord(host?.RestartPolicy)?.Name),
    stopTimeout: numberValue(config?.StopTimeout),
    tmpfs,
    portBindings,
    mounts,
    expectedImageRef: options.candidateImage,
    expectedVersion: options.expectedVersion,
    expectedRevision: options.expectedRevision,
    expectedVolume: resources.volume,
    expectedPort: resources.port,
    expectedRestartPolicy: resources.project ? "unless-stopped" : "no"
  };
}

function inspectStorage(docker: DockerClient, container: string) {
  const script = [
    "import fs from 'node:fs';",
    "import crypto from 'node:crypto';",
    "import { DatabaseSync } from 'node:sqlite';",
    "const mode=fs.statSync('/data/config.json').mode&0o777;",
    "let configObject=false;try{const value=JSON.parse(fs.readFileSync('/data/config.json','utf8'));configObject=Boolean(value)&&typeof value==='object'&&!Array.isArray(value);}catch{}",
    "const db=new DatabaseSync('/data/moodarr.sqlite',{readOnly:true});",
    "const rows=db.prepare('PRAGMA integrity_check').all();",
    "const integrity=rows.length===1?String(Object.values(rows[0])[0]):'failed';",
    "const foreignKeysOk=db.prepare('PRAGMA foreign_key_check').all().length===0;",
    "const mediaRows=db.prepare('SELECT id FROM media_items ORDER BY id').all();",
    "const plexRows=db.prepare('SELECT id,media_item_id,rating_key,guid,library_title,library_type,plex_url,available,last_seen_at FROM plex_items ORDER BY id').all();",
    "const seerrRows=db.prepare('SELECT id,media_item_id,tmdb_id,tvdb_id,imdb_id,seerr_media_id,media_type,status,request_status,requestable,seerr_url,last_seen_at FROM seerr_items ORDER BY id').all();",
    "const one=q=>Number(Object.values(db.prepare(q).get())[0]);",
    "const parseOperationResponse=row=>{try{return row.response_json?JSON.parse(row.response_json):undefined;}catch{return undefined;}};",
    "const responseSeerr=response=>response&&typeof response.seerr==='object'&&!Array.isArray(response.seerr)?response.seerr:undefined;",
    "const isConfirmedResponse=response=>response?.ok===true&&response?.reconciled!==true&&responseSeerr(response)?.id===9003&&responseSeerr(response)?.status==='approved';",
    "const isReconciledResponse=response=>response?.ok===true&&response?.reconciled===true&&responseSeerr(response)?.reconciled===true&&responseSeerr(response)?.status==='approved';",
    "const requestEvidence=mediaId=>{const item=db.prepare(\"SELECT m.id FROM media_items m JOIN external_ids e ON e.media_item_id=m.id WHERE e.source='tmdb' AND e.media_type='movie' AND e.value=? LIMIT 1\").get(String(mediaId));if(!item)return {operationCount:0,operationErrorPresent:false,operationResponseConfirmed:false,operationResponseReconciled:false,requestCount:0,requestHasExternalId:false,createdAudits:0,failedAudits:0,reconciliationAudits:0};const operations=db.prepare('SELECT status,response_json,error FROM request_creation_operations WHERE media_item_id=? ORDER BY updated_at').all(item.id);const responses=operations.map(parseOperationResponse);const requests=db.prepare(\"SELECT status,external_request_id FROM requests WHERE media_item_id=? AND media_type='movie' AND media_id=? ORDER BY id\").all(item.id,mediaId);const audits=db.prepare(\"SELECT status,blocked_reason FROM request_audit WHERE media_item_id=? AND action='create' AND media_type='movie' AND media_id=? ORDER BY id\").all(item.id,mediaId);return {operationCount:operations.length,operationStatus:operations.length>0&&operations.every(row=>row.status===operations[0].status)?operations[0].status:undefined,operationErrorPresent:operations.some(row=>typeof row.error==='string'&&row.error.length>0),operationResponseConfirmed:operations.length>0&&responses.every(isConfirmedResponse),operationResponseReconciled:operations.length>0&&responses.every(isReconciledResponse),requestCount:requests.length,requestStatus:requests[0]?.status,requestHasExternalId:requests.some(row=>typeof row.external_request_id==='string'&&row.external_request_id.length>0),createdAudits:audits.filter(row=>row.status==='created').length,failedAudits:audits.filter(row=>row.status==='failed').length,reconciliationAudits:audits.filter(row=>row.status==='created'&&row.blocked_reason==='Recovered by Seerr reconciliation.').length};};",
    "const catalog={totalItems:mediaRows.length,plexItems:one('SELECT COUNT(*) FROM plex_items'),seerrItems:one('SELECT COUNT(*) FROM seerr_items'),identitySha256:crypto.createHash('sha256').update(JSON.stringify({mediaRows,plexRows,seerrRows})).digest('hex')};",
    "const normalRequest=requestEvidence(7003);const uncertainRequest=requestEvidence(7004);",
    "db.close();process.stdout.write(JSON.stringify({configMode:mode,configObject,integrity,foreignKeysOk,catalog,normalRequest,uncertainRequest}));"
  ].join("");
  const parsed = asRecord(JSON.parse(docker.run(["exec", container, "/nodejs/bin/node", "--input-type=module", "-e", script], 30_000)));
  const catalog = asRecord(parsed?.catalog);
  const identitySha256 = stringValue(catalog?.identitySha256);
  if (!/^[0-9a-f]{64}$/.test(identitySha256)) throw new InstallValidationError("catalog_identity_invalid");
  return {
    configMode: numberValue(parsed?.configMode),
    configObject: parsed?.configObject === true,
    integrity: stringValue(parsed?.integrity),
    foreignKeysOk: parsed?.foreignKeysOk === true,
    normalRequest: requestCreationEvidence(parsed?.normalRequest),
    uncertainRequest: requestCreationEvidence(parsed?.uncertainRequest),
    catalog: {
      totalItems: numberValue(catalog?.totalItems),
      plexItems: numberValue(catalog?.plexItems),
      seerrItems: numberValue(catalog?.seerrItems),
      identitySha256
    }
  };
}

function requestCreationEvidence(value: unknown): RequestCreationEvidence {
  const evidence = asRecord(value);
  return {
    operationCount: numberValue(evidence?.operationCount),
    operationStatus: optionalString(evidence?.operationStatus),
    operationErrorPresent: evidence?.operationErrorPresent === true,
    operationResponseConfirmed: evidence?.operationResponseConfirmed === true,
    operationResponseReconciled: evidence?.operationResponseReconciled === true,
    requestCount: numberValue(evidence?.requestCount),
    requestStatus: optionalString(evidence?.requestStatus),
    requestHasExternalId: evidence?.requestHasExternalId === true,
    createdAudits: numberValue(evidence?.createdAudits),
    failedAudits: numberValue(evidence?.failedAudits),
    reconciliationAudits: numberValue(evidence?.reconciliationAudits)
  };
}

function validateSettings(value: unknown) {
  const settings = asRecord(value);
  const plex = asRecord(settings?.plex);
  const seerr = asRecord(settings?.seerr);
  const ai = asRecord(settings?.ai);
  const sync = asRecord(settings?.sync);
  const search = asRecord(settings?.search);
  const review = asRecord(settings?.reviewQueue);
  const plexAuth = asRecord(settings?.plexAuth);
  if (
    settings?.fixtureMode !== false || plex?.tokenConfigured !== true || seerr?.apiKeyConfigured !== true
    || seerr?.tmdbContentPolicy !== "none"
    || ai?.providerPolicy !== "none" || ai.provider !== "none" || ai.openaiApiKeyConfigured !== false
    || sync?.intervalMinutes !== 360 || sync.syncSeerr !== true || search?.defaultResultLimit !== 50
    || review?.retentionDays !== 91 || review.maxQueries !== 123 || review.captureRawQueries !== false
    || plexAuth?.enabled !== false || plexAuth.allowNewUsers !== false
  ) throw new InstallValidationError("settings_contract_mismatch");
}

function validatePublicConfig(value: unknown) {
  const config = asRecord(value);
  const plex = asRecord(config?.plex);
  const seerr = asRecord(config?.seerr);
  const admin = asRecord(config?.admin);
  const ai = asRecord(config?.ai);
  if (
    config?.fixtureMode !== false || plex?.configured !== true || seerr?.configured !== true
    || seerr?.tmdbContentPolicy !== "none"
    || admin?.authRequired !== true || admin.configured !== true || admin.autoSession !== false
    || ai?.providerPolicy !== "none" || ai.provider !== "none" || ai.configured !== false
  ) throw new InstallValidationError("public_config_contract_mismatch");
}

function assertSecretsRedacted(values: unknown[], resources: ResourceSet) {
  const serialized = values.map((value) => JSON.stringify(value)).join("\n");
  for (const secret of [resources.adminToken, resources.plexToken, resources.seerrKey, resources.openAiKey]) {
    if (serialized.includes(secret)) throw new InstallValidationError("secret_redaction_failed");
  }
}

async function requestJson(resources: ResourceSet, path: string, init: RequestInit = {}, expectedStatus = 200, timeoutMs = 10_000) {
  const response = await boundedFetch(resources, path, init, timeoutMs);
  if (response.status !== expectedStatus) throw new InstallValidationError(`unexpected_http_${response.status}`);
  const text = Buffer.from(response.body).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InstallValidationError("invalid_json_response");
  }
}

async function requestBytes(resources: ResourceSet, path: string, init: RequestInit = {}, expectedStatus = 200, timeoutMs = 10_000) {
  const response = await boundedFetch(resources, path, init, timeoutMs);
  if (response.status !== expectedStatus) throw new InstallValidationError(`unexpected_http_${response.status}`);
  return { contentType: response.contentType, body: response.body };
}

async function boundedFetch(resources: ResourceSet, path: string, init: RequestInit, timeoutMs: number) {
  if (!path.startsWith("/") || path.startsWith("//")) throw new InstallValidationError("unsafe_request_path");
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${resources.port}${path}`, {
      ...init,
      redirect: "error",
      headers: {
        "X-Moodarr-Admin-Token": resources.adminToken,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers
      },
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch {
    throw new InstallValidationError("request_unavailable");
  }
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximumResponseBytes) throw new InstallValidationError("response_too_large");
  const body = await readBoundedResponseBody(response, maximumResponseBytes);
  return { status: response.status, contentType: response.headers.get("content-type"), body };
}

export async function readBoundedResponseBody(response: Response, maximumBytes: number) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) throw new InstallValidationError("invalid_response_limit");
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new InstallValidationError("response_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function assertResourcesAbsent(docker: DockerClient, resources: ResourceSet, compose: boolean) {
  const checks: Array<[string, string]> = [
    ["container", resources.container], ["container", resources.stub], ["volume", resources.volume], ["network", resources.network]
  ];
  if (resources.frontNetwork) checks.push(["network", resources.frontNetwork]);
  if (resources.composeNetwork) checks.push(["network", resources.composeNetwork]);
  for (const [type, name] of checks) {
    if (docker.tryRun([type, "inspect", name]).ok) throw new InstallValidationError("resource_preexists");
  }
  if (compose && !resources.project) throw new InstallValidationError("compose_project_missing");
}

function validateComposeOwnership(docker: DockerClient, resources: ResourceSet) {
  if (!resources.project) throw new InstallValidationError("compose_project_missing");
  const container = firstInspect(docker, "container", resources.container);
  if (!resources.composeNetwork) throw new InstallValidationError("compose_network_missing");
  const network = firstInspect(docker, "network", resources.composeNetwork);
  const containerLabels = asRecord(asRecord(container.Config)?.Labels);
  const networkLabels = asRecord(network.Labels);
  if (
    containerLabels?.["com.docker.compose.project"] !== resources.project
    || containerLabels?.["com.docker.compose.service"] !== "moodarr"
    || !validateResourceOwnership(optionalString(containerLabels?.[ownerLabel]), resources.owner)
    || networkLabels?.["com.docker.compose.project"] !== resources.project
    || !validateResourceOwnership(optionalString(networkLabels?.[ownerLabel]), resources.owner)
  ) throw new InstallValidationError("compose_resource_ownership_mismatch");
  const privateNetwork = firstInspect(docker, "network", resources.network);
  const privateLabels = asRecord(privateNetwork.Labels);
  if (!validateResourceOwnership(optionalString(privateLabels?.[ownerLabel]), resources.owner)) throw new InstallValidationError("network_ownership_mismatch");
  assertOwnedVolume(docker, resources);
}

function assertOwnedVolume(docker: DockerClient, resources: ResourceSet) {
  const volume = firstInspect(docker, "volume", resources.volume);
  const labels = asRecord(volume.Labels);
  if (!validateResourceOwnership(optionalString(labels?.[ownerLabel]), resources.owner)) throw new InstallValidationError("volume_ownership_mismatch");
}

function removeOwnedContainer(docker: DockerClient, name: string, owner: string) {
  const inspect = docker.tryRun(["container", "inspect", name]);
  if (!inspect.ok) return;
  const value = asRecord(parseJsonArray(inspect.stdout, "container_inspect_invalid")[0]);
  const labels = asRecord(asRecord(value?.Config)?.Labels);
  if (!validateResourceOwnership(optionalString(labels?.[ownerLabel]), owner)) throw new InstallValidationError("foreign_resource_rejected");
  docker.run(["container", "rm", "--force", name], 30_000);
}

function collectAndStopStub(docker: DockerClient, resources: ResourceSet, result: ModeResult) {
  const inspected = docker.tryRun(["container", "inspect", resources.stub]);
  if (!inspected.ok) return;
  let owned = false;
  try {
    const value = asRecord(parseJsonArray(inspected.stdout, "stub_inspect_invalid")[0]);
    const labels = asRecord(asRecord(value?.Config)?.Labels);
    if (!validateResourceOwnership(optionalString(labels?.[ownerLabel]), resources.owner)) throw new InstallValidationError("foreign_stub_rejected");
    owned = true;
    docker.run(["container", "stop", "--time", "3", resources.stub], 10_000);
    const logs = docker.run(["container", "logs", resources.stub]);
    const matches = [...logs.matchAll(/^MOODARR_BETA_STUB_COUNTS (\{[^\n]+\})$/gm)];
    const last = matches.at(-1)?.[1];
    if (!last) throw new InstallValidationError("stub_call_counts_missing");
    const counts = asRecord(JSON.parse(last));
    for (const key of Object.keys(resources.stubCounts) as Array<keyof StubCounts>) {
      resources.stubCounts[key] += numberValue(counts?.[key]);
    }
  } catch (error) {
    result.incomplete.push(errorCode(error, "stub_cleanup_uncertain"));
  } finally {
    if (owned) {
      try {
        removeOwnedContainer(docker, resources.stub, resources.owner);
      } catch (error) {
        result.incomplete.push(errorCode(error, "stub_cleanup_uncertain"));
      }
    }
  }
}

function cleanupRawResources(docker: DockerClient, resources: ResourceSet, result: ModeResult) {
  attemptCleanup(result, () => removeOwnedContainer(docker, resources.container, resources.owner));
  attemptCleanup(result, () => removeOwnedResource(docker, "network", resources.network, resources.owner));
  if (resources.frontNetwork) attemptCleanup(result, () => removeOwnedResource(docker, "network", resources.frontNetwork!, resources.owner));
  attemptCleanup(result, () => removeOwnedResource(docker, "volume", resources.volume, resources.owner));
  attemptCleanup(result, () => validateStubCounts(resources, result));
  verifyNoOwnedResources(docker, resources.owner, result);
}

function cleanupComposeResources(docker: DockerClient, resources: ResourceSet, result: ModeResult) {
  attemptCleanup(result, () => {
    if (resources.project) {
      const container = docker.tryRun(["container", "inspect", resources.container]);
      const network = resources.composeNetwork ? docker.tryRun(["network", "inspect", resources.composeNetwork]) : { ok: false, stdout: "" };
      if (container.ok || network.ok) {
        if (container.ok) {
          const value = asRecord(parseJsonArray(container.stdout, "container_inspect_invalid")[0]);
          const labels = asRecord(asRecord(value?.Config)?.Labels);
          if (
            labels?.["com.docker.compose.project"] !== resources.project
            || !validateResourceOwnership(optionalString(labels?.[ownerLabel]), resources.owner)
          ) throw new InstallValidationError("foreign_compose_resource_rejected");
        }
        if (network.ok) {
          const value = asRecord(parseJsonArray(network.stdout, "network_inspect_invalid")[0]);
          const labels = asRecord(value?.Labels);
          if (
            labels?.["com.docker.compose.project"] !== resources.project
            || !validateResourceOwnership(optionalString(labels?.[ownerLabel]), resources.owner)
          ) throw new InstallValidationError("foreign_compose_resource_rejected");
        }
        composeRun(docker, resources, ["down", "--remove-orphans"], 45_000);
      }
    }
  });
  attemptCleanup(result, () => removeResidualComposeResources(docker, resources));
  attemptCleanup(result, () => removeOwnedResource(docker, "network", resources.network, resources.owner));
  attemptCleanup(result, () => removeOwnedResource(docker, "volume", resources.volume, resources.owner));
  attemptCleanup(result, () => validateStubCounts(resources, result));
  verifyNoOwnedResources(docker, resources.owner, result);
}

function removeResidualComposeResources(docker: DockerClient, resources: ResourceSet) {
  if (!resources.project || !resources.composeNetwork) throw new InstallValidationError("compose_project_missing");

  const container = docker.tryRun(["container", "inspect", resources.container]);
  if (container.ok) {
    const value = asRecord(parseJsonArray(container.stdout, "container_inspect_invalid")[0]);
    const labels = asRecord(asRecord(value?.Config)?.Labels);
    if (
      labels?.["com.docker.compose.project"] !== resources.project
      || !validateResourceOwnership(optionalString(labels?.[ownerLabel]), resources.owner)
    ) throw new InstallValidationError("foreign_compose_resource_rejected");
    docker.run(["container", "rm", "--force", resources.container]);
  }

  const network = docker.tryRun(["network", "inspect", resources.composeNetwork]);
  if (network.ok) {
    const value = asRecord(parseJsonArray(network.stdout, "network_inspect_invalid")[0]);
    const labels = asRecord(value?.Labels);
    if (
      labels?.["com.docker.compose.project"] !== resources.project
      || !validateResourceOwnership(optionalString(labels?.[ownerLabel]), resources.owner)
    ) throw new InstallValidationError("foreign_compose_resource_rejected");
    docker.run(["network", "rm", resources.composeNetwork]);
  }

  const remainingContainer = docker.run([
    "container", "ls", "--all", "--quiet", "--filter", `name=^/${resources.container}$`
  ]).trim();
  const remainingNetwork = docker.run([
    "network", "ls", "--quiet", "--filter", `name=^${resources.composeNetwork}$`
  ]).trim();
  if (remainingContainer || remainingNetwork) throw new InstallValidationError("compose_resource_cleanup_incomplete");
}

function attemptCleanup(result: ModeResult, operation: () => void) {
  try {
    operation();
  } catch (error) {
    result.incomplete.push(errorCode(error, "cleanup_uncertain"));
  }
}

function verifyNoOwnedResources(docker: DockerClient, owner: string, result: ModeResult) {
  for (const [type, args] of [
    ["container", ["container", "ls", "--all", "--quiet", "--filter", `label=${ownerLabel}=${owner}`]],
    ["network", ["network", "ls", "--quiet", "--filter", `label=${ownerLabel}=${owner}`]],
    ["volume", ["volume", "ls", "--quiet", "--filter", `label=${ownerLabel}=${owner}`]]
  ] as const) {
    const remaining = docker.tryRun([...args]);
    if (!remaining.ok || remaining.stdout.trim()) result.incomplete.push(`owned_${type}_cleanup_incomplete`);
  }
}

function removeOwnedResource(docker: DockerClient, type: "volume" | "network", name: string, owner: string) {
  const inspected = docker.tryRun([type, "inspect", name]);
  if (!inspected.ok) return;
  const value = asRecord(parseJsonArray(inspected.stdout, `${type}_inspect_invalid`)[0]);
  const labels = asRecord(value?.Labels);
  if (!validateResourceOwnership(optionalString(labels?.[ownerLabel]), owner)) throw new InstallValidationError("foreign_resource_rejected");
  docker.run([type, "rm", name]);
}

function validateStubCounts(resources: ResourceSet, result: ModeResult) {
  const counts = resources.stubCounts;
  result.counts.stubCalls = Object.entries(counts)
    .filter(([key]) => key !== "rejected" && key !== "unknown" && key !== "seerrDroppedResponses")
    .reduce((sum, [, value]) => sum + value, 0);
  if (counts.rejected !== 0 || counts.unknown !== 0) result.failures.push("stub_unexpected_calls");
  if (!validateProtocolStubCounts(counts)) result.failures.push("stub_required_calls_missing");
  else addCodes(result.checkCodes, ["deterministic_stub_calls_ok"]);
}

function cleanupTemp(resources: ResourceSet, result: ModeResult) {
  try {
    rmSync(resources.tempDir, { recursive: true, force: true });
  } catch {
    result.incomplete.push("temp_cleanup_uncertain");
  }
}

function firstInspect(docker: DockerClient, type: "container" | "network" | "volume", name: string) {
  const rows = parseJsonArray(docker.run([type, "inspect", name]), `${type}_inspect_invalid`);
  const first = asRecord(rows[0]);
  if (!first) throw new InstallValidationError(`${type}_inspect_invalid`);
  return first;
}

function inspectSource(repoRoot: string, options: InstallOptions): InspectSourceResult {
  const gitRoot = runHostCommand("git", ["rev-parse", "--show-toplevel"], repoRoot).trim();
  if (realpathSync(gitRoot) !== realpathSync(repoRoot)) throw new InstallValidationError("source_repo_root_mismatch");
  const headRevision = runHostCommand("git", ["rev-parse", "HEAD"], repoRoot).trim();
  const clean = runHostCommand("git", ["status", "--porcelain=v1", "--untracked-files=all"], repoRoot).trim().length === 0;
  const committedMatches = {} as Record<keyof typeof sourceFiles, boolean>;
  const hashes = {} as Record<keyof typeof sourceFiles, string>;
  for (const [key, relative] of Object.entries(sourceFiles) as Array<[keyof typeof sourceFiles, string]>) {
    const path = resolve(repoRoot, relative);
    const localBlob = runHostCommand("git", ["hash-object", path], repoRoot).trim();
    const committed = runHostCommand("git", ["rev-parse", `HEAD:${relative}`], repoRoot, true).trim();
    committedMatches[key] = Boolean(committed) && localBlob === committed;
    hashes[key] = sha256(readFileSync(path));
  }
  return { input: { expectedRevision: options.expectedRevision, headRevision, clean, committedMatches, allowDirty: options.allowDirty }, hashes };
}

function discoverDockerClient(): DockerClient {
  const env = controlledEnvironment();
  const context = runCommand("docker", ["context", "show"], env).trim();
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(context)) throw new InstallValidationError("docker_context_invalid");
  const endpointJson = runCommand("docker", ["context", "inspect", context, "--format", "{{json .Endpoints.docker.Host}}"], env).trim();
  let endpoint: unknown;
  try {
    endpoint = JSON.parse(endpointJson);
  } catch {
    throw new InstallValidationError("docker_endpoint_invalid");
  }
  if (typeof endpoint !== "string" || !endpoint.startsWith("unix://")) throw new InstallValidationError("docker_endpoint_not_local_unix");
  const base = ["--host", endpoint];
  return {
    endpoint,
    env,
    run(args, timeoutMs = commandTimeoutMs) {
      return runCommand("docker", [...base, ...args], env, timeoutMs);
    },
    tryRun(args, timeoutMs = commandTimeoutMs) {
      return tryCommand("docker", [...base, ...args], env, timeoutMs);
    }
  };
}

function inspectCandidateImage(docker: DockerClient, options: InstallOptions) {
  if (options.official) docker.run(["image", "pull", "--platform", "linux/amd64", options.candidateImage], 3 * 60_000);
  const rows = parseJsonArray(docker.run(["image", "inspect", options.candidateImage]), "candidate_image_inspect_invalid");
  const image = asRecord(rows[0]);
  const config = asRecord(image?.Config);
  const labels = asRecord(config?.Labels);
  const repoDigests = stringArray(image?.RepoDigests);
  if (!image || typeof image.Id !== "string") throw new InstallValidationError("candidate_image_inspect_invalid");
  if (options.official && !repoDigests.includes(options.candidateImage)) throw new InstallValidationError("candidate_digest_not_loaded_exactly");
  if (labels?.["org.opencontainers.image.version"] !== options.expectedVersion || labels?.["org.opencontainers.image.revision"] !== options.expectedRevision) {
    throw new InstallValidationError("candidate_image_identity_mismatch");
  }
  if (labels?.["io.moodarr.ai-provider-policy"] !== "none") throw new InstallValidationError("candidate_ai_policy_mismatch");
  if (labels?.["io.moodarr.tmdb-content-policy"] !== "none") throw new InstallValidationError("candidate_tmdb_policy_mismatch");
  const bundleScan = docker.tryRun([
    "run", "--rm", "--platform", "linux/amd64", "--network", "none", "--read-only", "--privileged=false",
    "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--user", "999:999",
    "--entrypoint", "/nodejs/bin/node", options.candidateImage, "-e",
    releaseBundleScanScript()
  ], options.allowEmulation ? 60_000 : commandTimeoutMs);
  if (!bundleScan.ok) throw new InstallValidationError("candidate_ai_bundle_mismatch");
  return { id: image.Id, os: stringValue(image.Os), arch: stringValue(image.Architecture) };
}

function inspectHelperImage(docker: DockerClient) {
  docker.run(["image", "pull", "--platform", "linux/amd64", helperImage], 3 * 60_000);
  const rows = parseJsonArray(docker.run(["image", "inspect", helperImage]), "helper_image_inspect_invalid");
  const image = asRecord(rows[0]);
  if (
    image?.Os !== "linux" || image.Architecture !== "amd64"
    || !stringArray(image.RepoDigests).includes(helperCanonicalDigest)
  ) throw new InstallValidationError("helper_image_identity_or_platform_mismatch");
}

function inspectPlatform(docker: DockerClient, image: { os: string; arch: string }): PlatformEvidence {
  const version = asRecord(JSON.parse(docker.run(["version", "--format", "{{json .}}"])));
  const client = asRecord(version?.Client);
  const server = asRecord(version?.Server);
  const info = asRecord(JSON.parse(docker.run(["info", "--format", "{{json .}}"])));
  const daemonOs = stringValue(info?.OSType);
  const daemonArch = stringValue(info?.Architecture);
  const native = daemonOs === "linux" && image.os === "linux" && image.arch === "amd64" && new Set(["amd64", "x86_64"]).has(daemonArch);
  return {
    endpointLocalUnix: docker.endpoint.startsWith("unix://"),
    dockerClientVersion: stringValue(client?.Version),
    dockerServerVersion: stringValue(server?.Version),
    composeVersion: docker.run(["compose", "version", "--short"]).trim(),
    daemonOs,
    daemonArch,
    imageOs: image.os,
    imageArch: image.arch,
    native
  };
}

export function resolveTrustedExecutable(command: "git" | "docker", directories: readonly string[] = trustedBinaryDirectories) {
  for (const directory of directories) {
    const candidate = join(directory, command);
    try {
      accessSync(candidate, fsConstants.X_OK);
      const resolved = realpathSync(candidate);
      if (resolved.includes("/node_modules/") || resolved.includes("\\node_modules\\")) continue;
      return resolved;
    } catch {
      // Try the next fixed system directory.
    }
  }
  throw new InstallValidationError(`trusted_${command}_not_found`);
}

function runHostCommand(command: "git", args: string[], cwd: string, allowFailure = false) {
  const result = spawnSync(resolveTrustedExecutable(command), args, {
    cwd,
    env: controlledEnvironment(),
    encoding: "utf8",
    timeout: commandTimeoutMs,
    maxBuffer: maximumOutputBytes,
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.error || result.signal || result.status !== 0) {
    if (allowFailure) return "";
    throw new InstallValidationError("source_command_failed");
  }
  return result.stdout ?? "";
}

function runCommand(command: "docker", args: string[], env: NodeJS.ProcessEnv, timeoutMs = commandTimeoutMs) {
  const result = tryCommand(command, args, env, timeoutMs);
  if (!result.ok) throw new InstallValidationError("docker_command_failed");
  return result.stdout;
}

function tryCommand(command: "docker", args: string[], env: NodeJS.ProcessEnv, timeoutMs = commandTimeoutMs) {
  const result = spawnSync(resolveTrustedExecutable(command), args, {
    env,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: maximumOutputBytes,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return { ok: !result.error && !result.signal && result.status === 0, stdout: result.stdout ?? "" };
}

function controlledEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: trustedBinaryDirectories.join(":"),
    HOME: process.env.HOME,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    TMPDIR: process.env.TMPDIR,
    DOCKER_DEFAULT_PLATFORM: "linux/amd64"
  };
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

async function findFreeLoopbackPort() {
  return new Promise<number>((resolvePort, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => reject(new InstallValidationError("loopback_port_unavailable")));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") return reject(new InstallValidationError("loopback_port_unavailable"));
      server.close((error) => error ? reject(new InstallValidationError("loopback_port_unavailable")) : resolvePort(address.port));
    });
  });
}

function writePrivateEnv(path: string, entries: Array<[string, string]>) {
  const body = entries.map(([key, value]) => `${key}=${value.replaceAll("\\", "\\\\").replaceAll("\n", "\\n")}`).join("\n") + "\n";
  writeFileSync(path, body, { mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
  if ((statSync(path).mode & 0o777) !== 0o600) throw new InstallValidationError("secret_env_mode_mismatch");
}

// Suboperations have their own hard timeouts. This outer budget is checked only
// after a mode settles so cleanup can never continue in a detached Promise.race.
async function withElapsedPhaseBudget<T>(promise: Promise<T>, budgetMs: number, code: string) {
  const startedAt = Date.now();
  const result = await promise;
  if (Date.now() - startedAt > budgetMs) throw new InstallValidationError(code);
  return result;
}

function emptyModeResult(): ModeResult {
  return {
    passed: false,
    checkCodes: [],
    counts: { lifecycles: 0, plexItems: 0, seerrItems: 0, searchResults: 0, posterBytes: 0, stubCalls: 0 },
    failures: [],
    incomplete: []
  };
}

function finalizeMode(result: ModeResult): ModeResult {
  const checkCodes = uniqueCodes(result.checkCodes);
  const checkContractComplete = requiredInstallModeCheckCodes.length === expectedInstallModeCheckCount
    && requiredInstallModeCheckCodeSet.size === expectedInstallModeCheckCount
    && checkCodes.length === expectedInstallModeCheckCount
    && requiredInstallModeCheckCodes.every((code) => checkCodes.includes(code));
  const failures = uniqueCodes([
    ...result.failures,
    ...(result.passed && !checkContractComplete ? ["required_install_check_codes_missing"] : [])
  ]);
  const incomplete = uniqueCodes(result.incomplete);
  return {
    passed: result.passed && checkContractComplete && failures.length === 0 && incomplete.length === 0,
    checkCodes,
    counts: {
      lifecycles: safeCount(result.counts.lifecycles),
      plexItems: safeCount(result.counts.plexItems),
      seerrItems: safeCount(result.counts.seerrItems),
      searchResults: safeCount(result.counts.searchResults),
      posterBytes: safeCount(result.counts.posterBytes),
      stubCalls: safeCount(result.counts.stubCalls)
    },
    failures,
    incomplete
  };
}

function sanitizeMode(result: ModeResult) {
  return finalizeMode(result);
}

function parseJsonArray(value: string, code: string): unknown[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error();
    return parsed;
  } catch {
    throw new InstallValidationError(code);
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function optionalString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = asRecord(value);
  if (record) return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function sha256(value: crypto.BinaryLike) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function addCodes(target: string[], values: string[]) {
  for (const value of values) if (!target.includes(value)) target.push(value);
}

function uniqueCodes(values: string[]) {
  return [...new Set(safeCodes(values))];
}

function safeCodes(values: string[]) {
  return values.filter((value) => /^[a-z0-9][a-z0-9_]{0,95}$/.test(value)).slice(0, 64);
}

function safeHash(value: string | undefined) {
  return value && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

function safeDigest(value: string) {
  return /^sha256:[0-9a-f]{64}$/.test(value) ? value : null;
}

function safeRevision(value: string) {
  return revisionPattern.test(value) ? value : null;
}

function safeVersion(value: string) {
  return /^0\.1\.0-beta\.\d+$/.test(value) ? value : null;
}

function safeToolVersion(value: string | undefined) {
  return value && /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(value) ? value : null;
}

function safePlatformName(value: string | undefined) {
  return value && /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(value) ? value : null;
}

function safeCount(value: number) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function errorCode(error: unknown, fallback: string) {
  return error instanceof InstallValidationError && /^[a-z0-9][a-z0-9_]{0,95}$/.test(error.code) ? error.code : fallback;
}

async function main() {
  let report: ReturnType<typeof buildSafeReport>;
  try {
    const options = parseInstallArgs(process.argv.slice(2));
    report = await runCleanInstallValidation(options);
  } catch (error) {
    const code = errorCode(error, "validator_failed");
    report = buildSafeReport({
      official: false,
      expectedVersion: expectedBetaVersion,
      expectedRevision: "0".repeat(40),
      docker: { ...emptyModeResult(), failures: [code] },
      compose: { ...emptyModeResult(), incomplete: ["not_run"] },
      releaseEligible: false,
      incomplete: [code]
    });
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.releaseEligible ? 0 : 1;
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) void main();
