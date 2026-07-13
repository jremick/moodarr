import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { accessSync, chmodSync, constants as fsConstants, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const alphaIndexImage = "ghcr.io/jremick/moodarr@sha256:b7b5c254448a5ca28cac15c7970ee401a814357ac7b8707b0eda4d97b38936d6";
export const alphaPlatformDigest = "sha256:7be437d1a9b83c648b5b4aac7f67232d1919b925e1e149440530e01bcbf59c36";
export const alphaRevision = "4ac3b7672cfa4402ef0105243fc67b341c789e59";
const archiveHelperImage = "node:24-bookworm-slim@sha256:0778d035a13f3f3833b7f2cb750e0df6cbce45583e84fd822f499f0c902a6c74";
const ownerLabel = "dev.moodarr.beta-upgrade-owner";
const commandTimeoutMs = 120_000;
const maxCommandBuffer = 64 * 1024 * 1024;
const syntheticRows = 79_990;
const syntheticPosterId = "synthetic-000001";
const trustedBinaryDirectories = ["/usr/local/bin", "/usr/bin", "/bin", "/opt/homebrew/bin"] as const;
const alphaMigrationIds = [
  "001_initial_schema", "002_request_audit", "003_media_source", "004_mood_feature_scores", "005_query_review_queue",
  "006_feel_feedback_events", "007_feel_profile_terms", "008_feel_feedback_reliability", "009_profile_replay_metadata",
  "010_profile_confidence_evidence", "011_replay_logging_holdout", "012_feel_profile_checkpoints", "013_plex_user_auth",
  "014_request_auth_attribution", "015_feel_feedback_client_event_id", "016_store_plex_user_token", "017_open_catalog_backbone",
  "018_catalog_update_metadata", "019_catalog_search_index", "020_content_fingerprints", "021_moodrank_trace_foundation"
];
const candidateMigrationIds = [...alphaMigrationIds,
  "022_media_type_aware_external_ids", "023_user_scoped_feel_profiles", "024_request_creation_idempotency", "025_user_capabilities",
  "026_durable_auth_and_request_reconciliation", "027_bounded_poster_cache", "028_catalog_diagnostics_indexes"
];

export class UpgradeValidationError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "UpgradeValidationError"; }
}

export interface UpgradeOptions {
  candidateImage: string; expectedVersion: string; expectedRevision: string; official: boolean;
  allowDirty: boolean; allowLocalImage: boolean; allowEmulation: boolean;
}
export interface SourceSnapshot { headRevision: string; dirty: boolean; scriptMatchesHead: boolean; packageVersion: string }
export interface AggregateState {
  catalog: { total: number; plex: number; seerr: number };
  settings: { fixtureMode: boolean; syncInterval: number; resultLimit: number; retentionDays: number; maxQueries: number };
  profile: { id: string; terms: number; maxVersion: number; feedback: number };
  requests: { total: number; previews: number; creates: number; blocked: number; failed: number };
}
interface CanonicalHashes {
  config: string; configRaw: string; profiles: string; checkpoints: string; feedback: string; requestAudits: string;
  mediaExternalIds: string; catalogRelationships: string; recommendations: string; userSessions: string; poster: string; posterBody: string;
}
export interface DatabaseObservation {
  schemaVersion: number; integrity: string; integrityOk?: boolean; foreignKeysOk?: boolean;
  migrationCount?: number; migrationIdsExact?: boolean; totalItems: number; plexItems?: number; seerrItems?: number; externalIds?: number;
  externalMediaTypesValid?: boolean;
  requestAudits: number; attributedRequestAudits?: number; feedbackEvents: number; profileTerms?: number; profileCheckpoints?: number;
  groupDefaultProfiles: number; groupSharedProfiles: number; groupDefaultRecommendationSessions?: number; groupSharedRecommendationSessions?: number;
  appUsers?: number; userSessions?: number;
  syntheticUserCapabilities?: boolean; posterRows?: number; posterSvgRows?: number; posterPngJpegRows?: number;
  posterByteSizeBackfilled?: boolean; posterLastAccessBackfilled?: boolean;
  configJsonValid: boolean; configMode0600?: boolean; configOwner999?: boolean; canonical?: CanonicalHashes;
}
export interface TransitionAssessment { checks: string[]; failures: string[]; incomplete: string[] }
export interface ReportInput {
  options: UpgradeOptions; candidatePlatformDigest?: string; archiveSha256?: string;
  before?: AggregateState; candidate?: AggregateState; restarted?: AggregateState; rollback?: AggregateState;
  beforeDatabase?: DatabaseObservation; candidateDatabase?: DatabaseObservation; restartedDatabase?: DatabaseObservation; rollbackDatabase?: DatabaseObservation;
  checks?: string[]; failures?: string[]; incomplete?: string[];
}

export function parseUpgradeArgs(args: string[]): UpgradeOptions {
  const values = new Map<string, string>(); const flags = new Set<string>();
  const valueKeys = new Set(["--candidate-image", "--expected-version", "--expected-revision"]);
  const flagKeys = new Set(["--allow-local-image", "--allow-dirty", "--allow-emulation"]);
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index]!;
    if (valueKeys.has(key)) {
      const value = args[index + 1];
      if (!value || value.startsWith("--") || values.has(key)) throw new UpgradeValidationError("invalid_arguments");
      values.set(key, value); index += 1;
    } else if (flagKeys.has(key)) {
      if (flags.has(key)) throw new UpgradeValidationError("invalid_arguments"); flags.add(key);
    } else throw new UpgradeValidationError("invalid_arguments");
  }
  const candidateImage = values.get("--candidate-image") ?? "";
  const expectedVersion = values.get("--expected-version") ?? "";
  const expectedRevision = values.get("--expected-revision") ?? "";
  if (!/^\d+\.\d+\.\d+-beta\.\d+$/.test(expectedVersion)) throw new UpgradeValidationError("invalid_beta_version");
  if (!/^[0-9a-f]{40}$/.test(expectedRevision)) throw new UpgradeValidationError("invalid_revision");
  const official = /^ghcr\.io\/jremick\/moodarr@sha256:[0-9a-f]{64}$/.test(candidateImage);
  const allowLocalImage = flags.has("--allow-local-image"), allowDirty = flags.has("--allow-dirty"), allowEmulation = flags.has("--allow-emulation");
  if (official && (allowLocalImage || allowDirty || allowEmulation)) throw new UpgradeValidationError("official_overrides_rejected");
  if (!official) {
    if (!candidateImage || candidateImage.includes("@sha256:") || !/^[a-zA-Z0-9][a-zA-Z0-9._/:-]{0,199}$/.test(candidateImage)) throw new UpgradeValidationError("invalid_candidate_image");
    if (!allowLocalImage || !allowDirty) throw new UpgradeValidationError("local_rehearsal_acknowledgements_required");
  }
  return { candidateImage, expectedVersion, expectedRevision, official, allowDirty, allowLocalImage, allowEmulation };
}

export function validateSourceSnapshot(options: UpgradeOptions, source: SourceSnapshot) {
  if (source.packageVersion !== options.expectedVersion) throw new UpgradeValidationError("package_version_mismatch");
  if (!options.official) return;
  if (source.dirty) throw new UpgradeValidationError("dirty_worktree");
  if (!source.scriptMatchesHead) throw new UpgradeValidationError("script_not_bound_to_head");
  if (source.headRevision !== options.expectedRevision) throw new UpgradeValidationError("revision_not_head");
}

function validCount(value: unknown) { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function validSha256(value: unknown) { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
function validateAggregate(state: AggregateState, expectedProfile: "group:default" | "group:shared") {
  const counts = [state.catalog.total, state.catalog.plex, state.catalog.seerr, state.settings.syncInterval, state.settings.resultLimit,
    state.settings.retentionDays, state.settings.maxQueries, state.profile.terms, state.profile.maxVersion, state.profile.feedback,
    state.requests.total, state.requests.previews, state.requests.creates, state.requests.blocked, state.requests.failed];
  return state.settings.fixtureMode === true && state.profile.id === expectedProfile && counts.every(validCount);
}

export function validateDatabaseObservation(observation: DatabaseObservation, expectedSchema: 21 | 28) {
  const failures: string[] = [];
  if (observation.schemaVersion !== expectedSchema) failures.push("schema_version");
  if (observation.integrityOk !== true || observation.integrity !== "ok") failures.push("database_integrity");
  if (observation.foreignKeysOk !== true) failures.push("foreign_keys");
  if (observation.migrationIdsExact !== true || observation.migrationCount !== expectedSchema) failures.push("schema_migrations");
  if (observation.configJsonValid !== true) failures.push("config_json");
  if (observation.configMode0600 !== true) failures.push("config_mode");
  if (observation.configOwner999 !== true) failures.push("config_owner");
  if (observation.externalMediaTypesValid !== true) failures.push("external_media_types");
  const counts = [
    observation.totalItems, observation.plexItems, observation.seerrItems, observation.externalIds,
    observation.requestAudits, observation.attributedRequestAudits, observation.feedbackEvents,
    observation.profileTerms, observation.profileCheckpoints, observation.groupDefaultProfiles,
    observation.groupSharedProfiles, observation.groupDefaultRecommendationSessions,
    observation.groupSharedRecommendationSessions, observation.appUsers, observation.userSessions,
    observation.posterRows, observation.posterSvgRows, observation.posterPngJpegRows
  ];
  if (!counts.every(validCount)) failures.push("database_counts");
  if (typeof observation.syntheticUserCapabilities !== "boolean" || typeof observation.posterByteSizeBackfilled !== "boolean"
    || typeof observation.posterLastAccessBackfilled !== "boolean") failures.push("database_counts");
  if (!observation.canonical || !Object.values(observation.canonical).every(validSha256)) failures.push("canonical_hashes");
  return failures;
}

export function assessStateTransitions(before: AggregateState, candidate: AggregateState, restarted: AggregateState, rollback: AggregateState,
  databases: { before: DatabaseObservation; candidate: DatabaseObservation; restarted?: DatabaseObservation; rollback: DatabaseObservation }): TransitionAssessment {
  const failures = [
    ...validateDatabaseObservation(databases.before, 21).map((c) => `before_${c}`),
    ...validateDatabaseObservation(databases.candidate, 28).map((c) => `candidate_${c}`),
    ...(databases.restarted ? validateDatabaseObservation(databases.restarted, 28).map((c) => `restarted_${c}`) : []),
    ...validateDatabaseObservation(databases.rollback, 21).map((c) => `rollback_${c}`)
  ];
  const checks: string[] = [];
  const same = (left: unknown, right: unknown, code: string) => { if (JSON.stringify(left) === JSON.stringify(right)) checks.push(code); else failures.push(code); };
  if (!validateAggregate(before, "group:default")) failures.push("before_api_schema");
  if (!validateAggregate(candidate, "group:shared")) failures.push("candidate_api_schema");
  if (!validateAggregate(restarted, "group:shared")) failures.push("restarted_api_schema");
  if (!validateAggregate(rollback, "group:default")) failures.push("rollback_api_schema");
  same(before.catalog, candidate.catalog, "candidate_catalog_preserved");
  same(before.settings, candidate.settings, "candidate_settings_preserved");
  same({ ...before.profile, id: "group:shared" }, candidate.profile, "candidate_profile_migrated");
  same(before.requests, candidate.requests, "candidate_request_audits_preserved");
  same(candidate, restarted, "candidate_restart_preserved");
  same(before, rollback, "rollback_state_preserved");
  const numericKeys: Array<[keyof DatabaseObservation, string]> = [["totalItems", "total_items"], ["plexItems", "plex_items"], ["seerrItems", "seerr_items"],
    ["externalIds", "external_ids"], ["requestAudits", "request_audits"], ["attributedRequestAudits", "attributed_request_audits"],
    ["feedbackEvents", "feedback_events"], ["profileTerms", "profile_terms"], ["profileCheckpoints", "profile_checkpoints"],
    ["appUsers", "app_users"], ["userSessions", "user_sessions"], ["posterRows", "poster_rows"], ["posterSvgRows", "poster_svg_rows"],
    ["posterPngJpegRows", "poster_png_jpeg_rows"]];
  for (const [key, code] of numericKeys) {
    const baseline = databases.before[key];
    const candidateValue = databases.candidate[key];
    if (validCount(baseline) && validCount(candidateValue) && baseline === candidateValue) checks.push(`database_${code}_preserved`);
    else failures.push(`database_${code}_preserved`);
    if (databases.restarted) {
      const restartedValue = databases.restarted[key];
      if (validCount(baseline) && validCount(restartedValue) && baseline === restartedValue) checks.push(`restart_database_${code}_preserved`);
      else failures.push(`restart_database_${code}_preserved`);
    }
    const rollbackValue = databases.rollback[key];
    if (validCount(baseline) && validCount(rollbackValue) && baseline === rollbackValue) checks.push(`rollback_database_${code}_preserved`);
    else failures.push(`rollback_database_${code}_preserved`);
  }
  if (databases.before.totalItems >= 80_000) checks.push("representative_catalog_80000"); else failures.push("representative_catalog_80000");
  if (databases.before.groupDefaultProfiles > 0 && databases.candidate.groupDefaultProfiles === 0 && databases.candidate.groupSharedProfiles > 0) checks.push("database_group_profile_migrated");
  else failures.push("database_group_profile_migrated");
  if (
    validCount(databases.before.groupDefaultRecommendationSessions)
    && databases.before.groupDefaultRecommendationSessions! > 0
    && databases.before.groupSharedRecommendationSessions === 0
    && databases.candidate.groupDefaultRecommendationSessions === 0
    && validCount(databases.candidate.groupSharedRecommendationSessions)
    && databases.candidate.groupSharedRecommendationSessions! >= databases.before.groupDefaultRecommendationSessions!
    && databases.restarted?.groupDefaultRecommendationSessions === 0
    && validCount(databases.restarted.groupSharedRecommendationSessions)
    && databases.restarted.groupSharedRecommendationSessions! >= databases.candidate.groupSharedRecommendationSessions!
    && databases.rollback.groupDefaultRecommendationSessions === databases.before.groupDefaultRecommendationSessions
    && databases.rollback.groupSharedRecommendationSessions === 0
  ) checks.push("recommendation_profile_sessions_migrated");
  else failures.push("recommendation_profile_sessions_migrated");
  if (databases.candidate.syntheticUserCapabilities && databases.restarted?.syntheticUserCapabilities) checks.push("synthetic_user_capability_migrated");
  else failures.push("synthetic_user_capability_migrated");
  if (databases.candidate.posterByteSizeBackfilled && databases.candidate.posterLastAccessBackfilled && databases.candidate.posterPngJpegRows === 0) checks.push("synthetic_poster_blob_migrated");
  else failures.push("synthetic_poster_blob_migrated");
  const exactRelationships = (db: DatabaseObservation, migrated: boolean) => db.totalItems === 80_000 && db.plexItems === 6 && db.seerrItems === 4
    && db.requestAudits === 3 && db.attributedRequestAudits === 1 && db.feedbackEvents === 1 && db.profileTerms === 1 && db.profileCheckpoints === 1
    && db.appUsers === 1 && db.userSessions === 1 && db.posterRows === 1 && db.posterSvgRows === 1 && db.posterPngJpegRows === 0
    && db.externalMediaTypesValid === true && (migrated
      ? db.groupDefaultProfiles === 0 && db.groupSharedProfiles === 1 && db.syntheticUserCapabilities === true
      : db.groupDefaultProfiles === 1 && db.groupSharedProfiles === 0);
  for (const [label, db, migrated] of [["before", databases.before, false], ["candidate", databases.candidate, true],
    ...(databases.restarted ? [["restarted", databases.restarted, true] as const] : []), ["rollback", databases.rollback, false]] as const) {
    if (exactRelationships(db, migrated)) checks.push(`${label}_relationships_exact`); else failures.push(`${label}_relationships_exact`);
  }
  const hashChecks: Array<[keyof CanonicalHashes, string]> = [
    ["profiles", "canonical_profiles_preserved"], ["checkpoints", "canonical_checkpoints_preserved"], ["feedback", "canonical_feedback_preserved"],
    ["requestAudits", "canonical_request_audits_preserved"], ["mediaExternalIds", "canonical_media_external_ids_preserved"],
    ["catalogRelationships", "canonical_catalog_relationships_preserved"], ["recommendations", "canonical_recommendations_preserved"],
    ["userSessions", "canonical_user_sessions_preserved"], ["poster", "canonical_poster_preserved"]
  ];
  for (const [key, code] of hashChecks) {
    const hash = databases.before.canonical?.[key];
    const posterBodyHash = databases.before.canonical?.posterBody;
    const posterBodyMatches = key !== "poster" || (validSha256(posterBodyHash) && posterBodyHash === databases.candidate.canonical?.posterBody
      && posterBodyHash === databases.restarted?.canonical?.posterBody && posterBodyHash === databases.rollback.canonical?.posterBody);
    if (validSha256(hash) && posterBodyMatches && hash === databases.candidate.canonical?.[key] && hash === databases.restarted?.canonical?.[key] && hash === databases.rollback.canonical?.[key]) checks.push(code);
    else failures.push(code);
  }
  const configHash = databases.before.canonical?.config;
  if (validSha256(configHash) && configHash === databases.candidate.canonical?.config && configHash === databases.restarted?.canonical?.config && configHash === databases.rollback.canonical?.config) checks.push("config_hash_preserved");
  else failures.push("config_hash_preserved");
  const configRawHash = databases.before.canonical?.configRaw;
  if (validSha256(configRawHash) && configRawHash === databases.candidate.canonical?.configRaw && configRawHash === databases.restarted?.canonical?.configRaw && configRawHash === databases.rollback.canonical?.configRaw) checks.push("config_raw_hash_preserved");
  else failures.push("config_raw_hash_preserved");
  for (const [label, db] of [["before", databases.before], ["candidate", databases.candidate], ["rollback", databases.rollback]] as const) {
    if (db.integrityOk === true && db.integrity === "ok") checks.push(`${label}_database_integrity`); else failures.push(`${label}_database_integrity`);
    if (db.foreignKeysOk === true) checks.push(`${label}_foreign_keys`); else failures.push(`${label}_foreign_keys`);
  }
  return { checks, failures: [...new Set(failures)], incomplete: [] };
}

function publicState(state?: AggregateState) {
  if (!state) return undefined;
  return { catalog: state.catalog, settings: state.settings, profile: { terms: state.profile.terms, maxVersion: state.profile.maxVersion, feedback: state.profile.feedback }, requests: state.requests };
}
function publicDatabase(db?: DatabaseObservation) {
  if (!db) return undefined;
  return { schemaVersion: db.schemaVersion, integrityOk: db.integrityOk ?? db.integrity === "ok", foreignKeysOk: db.foreignKeysOk,
    migrationCount: db.migrationCount, migrationIdsExact: db.migrationIdsExact, totalItems: db.totalItems, plexItems: db.plexItems, seerrItems: db.seerrItems,
    externalIds: db.externalIds, externalMediaTypesValid: db.externalMediaTypesValid, requestAudits: db.requestAudits, attributedRequestAudits: db.attributedRequestAudits, feedbackEvents: db.feedbackEvents,
    profileTerms: db.profileTerms, profileCheckpoints: db.profileCheckpoints, groupDefaultProfiles: db.groupDefaultProfiles, groupSharedProfiles: db.groupSharedProfiles,
    groupDefaultRecommendationSessions: db.groupDefaultRecommendationSessions, groupSharedRecommendationSessions: db.groupSharedRecommendationSessions,
    appUsers: db.appUsers, userSessions: db.userSessions, syntheticUserCapabilities: db.syntheticUserCapabilities, posterRows: db.posterRows,
    posterSvgRows: db.posterSvgRows, posterPngJpegRows: db.posterPngJpegRows, posterByteSizeBackfilled: db.posterByteSizeBackfilled,
    posterLastAccessBackfilled: db.posterLastAccessBackfilled, configJsonValid: db.configJsonValid, configMode0600: db.configMode0600, configOwner999: db.configOwner999 };
}
const allowedIncomplete = new Set(["local_rehearsal", "amd64_emulation"]);
const preservationCodes = ["total_items", "plex_items", "seerr_items", "external_ids", "request_audits", "attributed_request_audits",
  "feedback_events", "profile_terms", "profile_checkpoints", "app_users", "user_sessions", "poster_rows", "poster_svg_rows", "poster_png_jpeg_rows"];
const knownCheckCodes = new Set([
  "alpha_api_seed", "alpha_native_catalog_10_6_4", "cold_archive_sha256", "candidate_restart", "rollback_fresh_volume",
  "synthetic_poster_route_preserved", "candidate_catalog_preserved", "candidate_settings_preserved", "candidate_profile_migrated",
  "candidate_request_audits_preserved", "candidate_restart_preserved", "rollback_state_preserved", "representative_catalog_80000",
  "database_group_profile_migrated", "synthetic_user_capability_migrated", "synthetic_poster_blob_migrated",
  "recommendation_profile_sessions_migrated",
  "before_relationships_exact", "candidate_relationships_exact", "restarted_relationships_exact", "rollback_relationships_exact",
  "canonical_profiles_preserved", "canonical_checkpoints_preserved", "canonical_feedback_preserved", "canonical_request_audits_preserved",
  "canonical_media_external_ids_preserved", "canonical_catalog_relationships_preserved", "canonical_recommendations_preserved", "canonical_user_sessions_preserved", "canonical_poster_preserved", "config_hash_preserved", "config_raw_hash_preserved",
  "before_database_integrity", "candidate_database_integrity", "rollback_database_integrity", "before_foreign_keys", "candidate_foreign_keys", "rollback_foreign_keys",
  ...preservationCodes.flatMap((code) => [`database_${code}_preserved`, `restart_database_${code}_preserved`, `rollback_database_${code}_preserved`])
]);
const validationPrefixes = ["before", "candidate", "restarted", "rollback"].flatMap((prefix) => ["schema_version", "database_integrity", "foreign_keys",
  "schema_migrations", "config_json", "config_mode", "config_owner", "external_media_types", "database_counts", "canonical_hashes"].map((code) => `${prefix}_${code}`));
const knownFailureCodes = new Set([...knownCheckCodes, ...validationPrefixes,
  "missing_evidence", "before_api_schema", "candidate_api_schema", "restarted_api_schema", "rollback_api_schema", "unexpected_failure",
  "invalid_arguments", "invalid_beta_version", "invalid_revision", "official_overrides_rejected", "invalid_candidate_image",
  "local_rehearsal_acknowledgements_required", "package_version_mismatch", "dirty_worktree", "script_not_bound_to_head", "revision_not_head",
  "trusted_docker_not_found", "trusted_git_not_found",
  "docker_endpoint_not_local_unix", "native_linux_amd64_required", "image_platform_mismatch", "alpha_oci_labels_mismatch",
  "candidate_oci_identity_mismatch", "alpha_platform_manifest_mismatch", "amd64_manifest_missing", "manifest_digest_missing",
  "resource_collision", "alpha_migrated_volume_start_blocked", "container_metadata_missing", "container_hardening_mismatch",
  "alpha_settings_seed_failed", "alpha_sync_seed_failed", "alpha_native_stats_failed", "alpha_search_seed_failed", "alpha_profile_seed_failed",
  "alpha_requestable_seed_missing", "alpha_request_preview_failed", "alpha_request_create_failed", "alpha_native_relationships_failed",
  "api_profile_schema_failed", "api_aggregate_schema_failed", "search_schema_failed", "search_result_schema_failed", "deterministic_search_failed",
  "synthetic_poster_route_failed", "database_observation_failed", "archive_checksum_mismatch", "health_timeout", "docker_health_failed",
  "docker_health_timeout", "candidate_runtime_identity_mismatch", "candidate_sync_schema_failed", "candidate_sync_timeout", "container_runtime_state_failed",
  "container_stop_still_running", "container_stop_oom", "container_stop_restart", "container_stop_exit_nonzero", "container_stop_state_error", "container_not_stopped",
  "owned_cleanup_incomplete", "resource_ownership_uncertain", "api_object_schema_failed", "finite_integer_required", "api_contract_failed", "api_json_failed",
  "overall_timeout", "phase_failure_preflight", "phase_failure_alpha_baseline", "phase_failure_candidate_upgrade", "phase_failure_rollback_restore",
  "phase_failure_rollback_runtime", "public_report_safety_failure"
]);
function safeChecks(values: string[]) { return [...new Set(values.filter((value) => knownCheckCodes.has(value)))].sort(); }
function safeFailures(values: string[]) {
  const result = values.map((value) => knownFailureCodes.has(value) ? value : "unexpected_failure");
  return [...new Set(result)].sort();
}

export function buildPublicReport(input: ReportInput) {
  const assessment = input.before && input.candidate && input.restarted && input.rollback && input.beforeDatabase && input.candidateDatabase && input.rollbackDatabase
    ? assessStateTransitions(input.before, input.candidate, input.restarted, input.rollback, { before: input.beforeDatabase, candidate: input.candidateDatabase, restarted: input.restartedDatabase, rollback: input.rollbackDatabase })
    : { checks: [], failures: ["missing_evidence"], incomplete: [] };
  const failures = safeFailures([...(input.failures ?? []), ...assessment.failures]);
  const incomplete = [...new Set([...(input.incomplete ?? []), ...assessment.incomplete, ...(!input.options.official ? ["local_rehearsal"] : []), ...(input.options.allowEmulation ? ["amd64_emulation"] : [])].filter((code) => allowedIncomplete.has(code)))].sort();
  return {
    schema: "moodarr-beta-upgrade-validation-v1" as const,
    status: failures.length ? "failed" as const : incomplete.length ? "incomplete" as const : "passed" as const,
    mode: input.options.official ? "official-candidate" as const : "local-rehearsal" as const,
    releaseEligible: input.options.official && failures.length === 0 && incomplete.length === 0,
    images: { alpha: { indexDigest: alphaIndexImage.split("@")[1], platformDigest: alphaPlatformDigest, revision: alphaRevision },
      candidate: { indexDigest: input.options.official ? input.options.candidateImage.split("@")[1] : undefined, platformDigest: input.candidatePlatformDigest,
        version: input.options.expectedVersion, revision: input.options.expectedRevision } },
    archive: input.archiveSha256 ? { sha256: input.archiveSha256 } : undefined,
    state: { before: publicState(input.before), candidate: publicState(input.candidate), restarted: publicState(input.restarted), rollback: publicState(input.rollback) },
    database: { before: publicDatabase(input.beforeDatabase), candidate: publicDatabase(input.candidateDatabase), restarted: publicDatabase(input.restartedDatabase), rollback: publicDatabase(input.rollbackDatabase) },
    checks: safeChecks([...(input.checks ?? []), ...assessment.checks]), failures, incomplete
  };
}

export function findForbiddenPublicEvidence(value: unknown): string[] {
  const forbiddenKeys = /(?:^|_)(?:token|secret|password|url|path|container|volume|resource|title|query|response|log|logs|name|canonical|integrity)$/i;
  const unsafeString = /(?:\b[a-z][a-z0-9+.-]*:\/\/|(?:^|\s)\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+|[A-Za-z]:\\|Bearer\s|\b(?:ghp_|github_pat_|sk-|xox[baprs]-)[-A-Za-z0-9_]{8,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/i;
  const hits: string[] = [];
  const visit = (entry: unknown, key = "root") => {
    if (entry && typeof entry === "object") for (const [childKey, child] of Object.entries(entry as Record<string, unknown>)) {
      if (forbiddenKeys.test(childKey)) hits.push(childKey); visit(child, childKey);
    } else if (typeof entry === "string" && unsafeString.test(entry)) hits.push(key);
  };
  visit(value); return hits;
}

type JsonObject = Record<string, any>;

export function appContainerSecurityArgs(volume: string, port: number) {
  return ["--platform", "linux/amd64", "--init", "--read-only", "--privileged=false", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
    "--pids-limit", "128", "--memory", "2g", "--memory-swap", "2g", "--cpus", "2", "--user", "999:999",
    "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777", "--stop-timeout", "30", "--publish", `127.0.0.1:${port}:4401`,
    "--mount", `type=volume,src=${volume},dst=/data`];
}

export function normalizeDockerPlatform(value: string) {
  const [os = "", architecture = ""] = value.trim().toLowerCase().split("/", 2);
  const normalizedArchitecture = architecture === "x86_64" || architecture === "x86-64" || architecture === "x64"
    ? "amd64"
    : architecture === "aarch64" ? "arm64" : architecture;
  return `${os}/${normalizedArchitecture}`;
}

export function resolveTrustedHostExecutable(command: "git" | "docker", directories: readonly string[] = trustedBinaryDirectories) {
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
  throw new UpgradeValidationError(`trusted_${command}_not_found`);
}

function controlledHostEnvironment() {
  return Object.fromEntries(Object.entries({
    PATH: trustedBinaryDirectories.join(":"),
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONFIG: process.env.DOCKER_CONFIG,
    DOCKER_CONTEXT: process.env.DOCKER_CONTEXT
  }).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

export function isAcceptedGracefulStopExit(image: string, exitCode: number) {
  return image === alphaIndexImage ? exitCode === 0 || exitCode === 143 : exitCode === 0;
}

export function validateSearchResponseShape(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return Array.isArray(response.results)
    && typeof response.sessionId === "string"
    && response.sessionId.length > 0
    && response.usedAi === false;
}

export function validateRequestCreationResponse(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  const request = response.request;
  const seerr = response.seerr;
  if (!request || typeof request !== "object" || Array.isArray(request) || !seerr || typeof seerr !== "object" || Array.isArray(seerr)) return false;
  const requestRecord = request as Record<string, unknown>;
  const seerrRecord = seerr as Record<string, unknown>;
  const seerrId = seerrRecord.id;
  const seerrStatus = seerrRecord.status;
  return response.ok === true
    && (requestRecord.mediaType === "movie" || requestRecord.mediaType === "tv")
    && typeof requestRecord.mediaId === "number"
    && Number.isSafeInteger(requestRecord.mediaId)
    && requestRecord.mediaId > 0
    && typeof requestRecord.title === "string"
    && requestRecord.title.length > 0
    && ((typeof seerrId === "string" && seerrId.length > 0) || (typeof seerrId === "number" && Number.isSafeInteger(seerrId)))
    && ((typeof seerrStatus === "string" && seerrStatus.length > 0) || (typeof seerrStatus === "number" && Number.isFinite(seerrStatus)));
}

class Harness {
  private readonly owner = randomBytes(16).toString("hex");
  private readonly token = randomBytes(32).toString("hex");
  private readonly prefix = `moodarr-upgrade-${randomBytes(8).toString("hex")}`;
  private readonly originalVolume = `${this.prefix}-original`;
  private readonly rollbackVolume = `${this.prefix}-rollback`;
  private readonly alphaContainer = `${this.prefix}-alpha`;
  private readonly candidateContainer = `${this.prefix}-candidate`;
  private readonly rollbackContainer = `${this.prefix}-rollback`;
  private readonly createdVolumes = new Set<string>();
  private readonly createdContainers = new Set<string>();
  private readonly migratedVolumes = new Set<string>();
  private readonly metadata = new Map<string, { port: number; volume: string; image: string }>();
  private baselineRecommendationSessionId?: string;
  private readonly temporaryDirectory = mkdtempSync(resolve(tmpdir(), "moodarr-upgrade-"));
  private readonly archivePath = resolve(this.temporaryDirectory, "alpha-data.tar");
  private readonly phaseDeadline = Date.now() + 20 * 60_000;
  private phase = "preflight";
  constructor(private readonly options: UpgradeOptions) { chmodSync(this.temporaryDirectory, 0o700); }

  run() {
    const evidence: ReportInput = { options: this.options, checks: [], failures: [], incomplete: [] };
    try {
      this.preflight(evidence); this.phase = "alpha_baseline"; this.createVolume(this.originalVolume);
      const alphaPort = this.availablePort(); this.startApp(this.alphaContainer, alphaIndexImage, this.originalVolume, alphaPort, true);
      this.waitForHealth(this.alphaContainer, alphaPort); this.seedAlpha(alphaPort, evidence); this.stopForTransition(this.alphaContainer);
      this.augmentStoppedAlpha(); this.startExisting(this.alphaContainer); this.waitForHealth(this.alphaContainer, alphaPort);
      evidence.before = this.captureState(alphaPort, "group:default"); this.assertSyntheticPoster(alphaPort);
      this.stopForTransition(this.alphaContainer); evidence.beforeDatabase = this.inspectDatabase(this.originalVolume, 21);
      const archive = this.createColdArchive(); evidence.archiveSha256 = createHash("sha256").update(archive).digest("hex"); this.removeStopped(this.alphaContainer);

      this.phase = "candidate_upgrade"; const candidatePort = this.availablePort(); this.migratedVolumes.add(this.originalVolume);
      this.startApp(this.candidateContainer, this.options.candidateImage, this.originalVolume, candidatePort, false);
      this.waitForHealth(this.candidateContainer, candidatePort, this.options.expectedVersion, this.options.expectedRevision); this.waitForCandidateSyncIdle(candidatePort);
      evidence.candidate = this.captureState(candidatePort, "group:shared"); this.assertSearch(candidatePort); this.stopForTransition(this.candidateContainer);
      evidence.candidateDatabase = this.inspectDatabase(this.originalVolume, 28);
      this.startExisting(this.candidateContainer); this.waitForHealth(this.candidateContainer, candidatePort, this.options.expectedVersion, this.options.expectedRevision);
      evidence.restarted = this.captureState(candidatePort, "group:shared"); this.assertSearch(candidatePort); this.stopForTransition(this.candidateContainer);
      evidence.restartedDatabase = this.inspectDatabase(this.originalVolume, 28);
      this.startExisting(this.candidateContainer); this.waitForHealth(this.candidateContainer, candidatePort, this.options.expectedVersion, this.options.expectedRevision);
      this.assertSyntheticPoster(candidatePort); this.stopForTransition(this.candidateContainer); this.removeStopped(this.candidateContainer);

      this.phase = "rollback_restore"; this.createVolume(this.rollbackVolume); this.restoreColdArchive(archive);
      evidence.rollbackDatabase = this.inspectDatabase(this.rollbackVolume, 21);
      this.phase = "rollback_runtime"; const rollbackPort = this.availablePort(); this.startApp(this.rollbackContainer, alphaIndexImage, this.rollbackVolume, rollbackPort, false);
      this.waitForHealth(this.rollbackContainer, rollbackPort); evidence.rollback = this.captureState(rollbackPort, "group:default"); this.assertSearch(rollbackPort); this.assertSyntheticPoster(rollbackPort);
      this.stopForTransition(this.rollbackContainer); this.removeStopped(this.rollbackContainer);
      evidence.checks!.push("alpha_api_seed", "cold_archive_sha256", "candidate_restart", "rollback_fresh_volume", "synthetic_poster_route_preserved");
    } catch (error) { evidence.failures!.push(error instanceof UpgradeValidationError ? error.code : `phase_failure_${this.phase}`); }
    finally { if (this.cleanup()) evidence.failures!.push("owned_cleanup_incomplete"); }
    return buildPublicReport(evidence);
  }

  private preflight(evidence: ReportInput) {
    const endpoint = process.env.DOCKER_HOST?.trim() || this.docker(["context", "inspect", "--format", "{{(index .Endpoints \"docker\").Host}}"]).trim();
    if (!endpoint.startsWith("unix://")) throw new UpgradeValidationError("docker_endpoint_not_local_unix");
    const daemon = normalizeDockerPlatform(this.docker(["info", "--format", "{{.OSType}}/{{.Architecture}}"]));
    if (daemon !== "linux/amd64") { if (this.options.official || !this.options.allowEmulation) throw new UpgradeValidationError("native_linux_amd64_required"); evidence.incomplete!.push("amd64_emulation"); }
    validateSourceSnapshot(this.options, currentSourceSnapshot());
    this.docker(["pull", "--platform", "linux/amd64", alphaIndexImage]); this.docker(["pull", "--platform", "linux/amd64", archiveHelperImage]);
    if (this.options.official) this.docker(["pull", "--platform", "linux/amd64", this.options.candidateImage]);
    this.verifyImage(alphaIndexImage, undefined, undefined, alphaPlatformDigest);
    evidence.candidatePlatformDigest = this.verifyImage(this.options.candidateImage, this.options.expectedVersion, this.options.expectedRevision);
  }

  private verifyImage(image: string, version?: string, revision?: string, expectedPlatformDigest?: string) {
    const observation = JSON.parse(this.docker(["image", "inspect", image, "--format", "{{json .}}"])) as JsonObject;
    if (observation.Os !== "linux" || observation.Architecture !== "amd64") throw new UpgradeValidationError("image_platform_mismatch");
    const labels = observation.Config?.Labels ?? {};
    if (image === alphaIndexImage) {
      if (labels["org.opencontainers.image.source"] !== "https://github.com/jremick/moodarr" || labels["org.opencontainers.image.licenses"] !== "Apache-2.0"
        || labels["org.opencontainers.image.version"] !== "v0.1.0-alpha.21" || labels["org.opencontainers.image.revision"] !== alphaRevision) throw new UpgradeValidationError("alpha_oci_labels_mismatch");
    } else if (labels["org.opencontainers.image.version"] !== version || labels["org.opencontainers.image.revision"] !== revision) throw new UpgradeValidationError("candidate_oci_identity_mismatch");
    if (!image.includes("@sha256:")) return undefined;
    const digest = resolveAmd64ManifestDigest(this.docker(["buildx", "imagetools", "inspect", image, "--raw"]), image);
    if (expectedPlatformDigest && digest !== expectedPlatformDigest) throw new UpgradeValidationError("alpha_platform_manifest_mismatch"); return digest;
  }

  private createVolume(volume: string) { if (this.exists("volume", volume)) throw new UpgradeValidationError("resource_collision"); this.docker(["volume", "create", "--label", `${ownerLabel}=${this.owner}`, volume]); this.createdVolumes.add(volume); }
  private startApp(name: string, image: string, volume: string, port: number, seedSettings: boolean) {
    if (image === alphaIndexImage && this.migratedVolumes.has(volume)) throw new UpgradeValidationError("alpha_migrated_volume_start_blocked");
    if (this.exists("container", name)) throw new UpgradeValidationError("resource_collision");
    const env = ["NODE_ENV=production", "MOODARR_API_HOST=0.0.0.0", "MOODARR_API_PORT=4401", `MOODARR_WEB_ORIGIN=http://127.0.0.1:${port}`,
      "MOODARR_SERVE_CLIENT=true", "MOODARR_DATA_DIR=/data", "MOODARR_CONFIG_PATH=/data/config.json", "MOODARR_DB_PATH=/data/moodarr.sqlite",
      "MOODARR_REQUIRE_ADMIN_TOKEN=true", "MOODARR_ADMIN_AUTO_SESSION=false", `MOODARR_ADMIN_TOKEN=${this.token}`, "AI_PROVIDER=none",
      ...(seedSettings ? ["MOODARR_FIXTURE_MODE=true", "MOODARR_SYNC_INTERVAL_MINUTES=0"] : [])];
    this.docker(["run", "--detach", "--name", name, "--label", `${ownerLabel}=${this.owner}`, ...appContainerSecurityArgs(volume, port), ...env.flatMap((value) => ["--env", value]), image]);
    this.createdContainers.add(name); this.metadata.set(name, { port, volume, image }); this.verifyHardening(name);
  }

  private verifyHardening(name: string) {
    const expected = this.metadata.get(name); if (!expected) throw new UpgradeValidationError("container_metadata_missing");
    const value = JSON.parse(this.docker(["container", "inspect", name, "--format", "{{json .}}"])) as JsonObject, host = value.HostConfig ?? {};
    const binding = host.PortBindings?.["4401/tcp"]?.[0], mounts = Array.isArray(value.Mounts) ? value.Mounts : [], tmpfs = String(host.Tmpfs?.["/tmp"] ?? "");
    const tmpfsTokens = new Set(tmpfs.split(","));
    if (value.Config?.User !== "999:999" || !host.ReadonlyRootfs || host.Privileged !== false || value.Config?.StopTimeout !== 30 || host.Memory !== 2_147_483_648
      || host.MemorySwap !== 2_147_483_648 || host.NanoCpus !== 2_000_000_000 || host.PidsLimit !== 128 || host.Init !== true
      || JSON.stringify(host.CapDrop) !== JSON.stringify(["ALL"]) || (Array.isArray(host.CapAdd) && host.CapAdd.length > 0)
      || JSON.stringify(host.SecurityOpt) !== JSON.stringify(["no-new-privileges:true"]) || binding?.HostIp !== "127.0.0.1" || Number(binding?.HostPort) !== expected.port
      || mounts.length !== 1 || mounts[0]?.Type !== "volume" || mounts[0]?.Name !== expected.volume || mounts[0]?.Destination !== "/data" || mounts[0]?.RW !== true
      || !["rw", "nosuid", "nodev", "noexec", "size=512m", "mode=1777"].every((token) => tmpfsTokens.has(token)) || tmpfsTokens.size !== 6) throw new UpgradeValidationError("container_hardening_mismatch");
  }

  private seedAlpha(port: number, evidence: ReportInput) {
    const settings = this.object(this.json(port, "/api/admin/settings", { method: "PUT", headers: this.headers(), body: JSON.stringify({ fixtureMode: true, sync: { intervalMinutes: 0, syncSeerr: true }, search: { defaultResultLimit: 37 }, reviewQueue: { retentionDays: 45, maxQueries: 321, captureRawQueries: false }, plexAuth: { enabled: false, allowNewUsers: false } }) }));
    if (settings.fixtureMode !== true || this.integer(settings.sync?.intervalMinutes) !== 0) throw new UpgradeValidationError("alpha_settings_seed_failed");
    const sync = this.object(this.json(port, "/api/admin/sync/run", { method: "POST", headers: this.headers(), body: "{}" }));
    if (sync.ok !== true || this.integer(sync.plexItems) !== 6 || this.integer(sync.seerrItems) !== 4) throw new UpgradeValidationError("alpha_sync_seed_failed");
    const stats = this.catalogStats(port); if (stats.total !== 10 || stats.plex !== 6 || stats.seerr !== 4) throw new UpgradeValidationError("alpha_native_stats_failed");
    const search = this.search(port, 10); if (search.results.length < 2) throw new UpgradeValidationError("alpha_search_seed_failed");
    this.baselineRecommendationSessionId = search.sessionId;
    const first = search.results[0]!, second = search.results[1]!;
    const feedback = this.object(this.json(port, "/api/feel-feedback", { method: "POST", headers: this.headers(), body: JSON.stringify({ action: "pairwise_pick", source: "web", clientEventId: randomBytes(12).toString("hex"), watchContext: "group", sessionId: search.sessionId, itemId: first.id, comparedItemId: second.id, moodTerm: "cozy" }) }));
    if (this.integer(feedback.profileVersion) !== 1) throw new UpgradeValidationError("alpha_profile_seed_failed");
    const requestable = search.results.find((entry) => entry.seerr?.requestable === true); if (!requestable) throw new UpgradeValidationError("alpha_requestable_seed_missing");
    const preview = this.object(this.json(port, "/api/requests/preview", { method: "POST", headers: this.headers(), body: JSON.stringify({ itemId: requestable.id }) }));
    if (typeof preview.confirmationPhrase !== "string" || !preview.confirmationPhrase) throw new UpgradeValidationError("alpha_request_preview_failed");
    const created = this.json(port, "/api/requests/create", { method: "POST", headers: this.headers(), body: JSON.stringify({ itemId: requestable.id, confirmed: true, confirmationPhrase: preview.confirmationPhrase }) });
    if (!validateRequestCreationResponse(created)) throw new UpgradeValidationError("alpha_request_create_failed");
    const state = this.captureState(port, "group:default");
    if (state.catalog.total !== 10 || state.catalog.plex !== 6 || state.catalog.seerr !== 4 || state.profile.terms < 1 || state.profile.feedback < 1
      || state.requests.total !== 2 || state.requests.previews !== 1 || state.requests.creates !== 1) throw new UpgradeValidationError("alpha_native_relationships_failed");
    evidence.checks!.push("alpha_native_catalog_10_6_4");
  }

  private augmentStoppedAlpha() {
    const svg = syntheticPosterSvg(); const script = `const{DatabaseSync}=require('node:sqlite'),crypto=require('node:crypto');const db=new DatabaseSync('/data/moodarr.sqlite');db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000');const v=Number(db.prepare('PRAGMA user_version').get().user_version);if(v!==21)process.exit(21);const total=Number(db.prepare('SELECT COUNT(*) value FROM media_items').get().value);if(total!==10)process.exit(22);const now='2026-01-01T00:00:00.000Z';const media=db.prepare('INSERT INTO media_items(id,media_type,title,normalized_title,year,summary,runtime_minutes,content_rating,poster_path,critic_rating,audience_rating,user_rating,created_at,updated_at,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');const ext=db.prepare('INSERT INTO external_ids(media_item_id,source,value) VALUES(?,?,?)');db.exec('BEGIN IMMEDIATE');try{for(let n=1;n<=${syntheticRows};n++){const p=String(n).padStart(6,'0'),id='synthetic-'+p,title=n===1?'Synthetic Poster':'Synthetic Media '+p;media.run(id,n%2?'movie':'tv',title,title.toLowerCase(),2000+n%25,'Self-authored upgrade validation fixture.',90,'NR',n===1?'fixture://synthetic-poster':null,null,null,null,now,now,'fixture');ext.run(id,'synthetic','self-'+p)}db.prepare('INSERT INTO app_users(id,provider,provider_user_id,username,display_name,email,avatar_url,enabled,created_at,updated_at,last_login_at,plex_token) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run('synthetic-user','plex','synthetic-provider-user','synthetic-user','Synthetic User',null,null,1,now,now,now,null);db.prepare('INSERT INTO user_sessions(id,user_id,token_hash,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?,?)').run('synthetic-session','synthetic-user',crypto.createHash('sha256').update('self-authored-session').digest('hex'),now,'2099-01-01T00:00:00.000Z',now);db.prepare("INSERT INTO request_audit(media_item_id,action,status,media_type,media_id,title,seasons_json,blocked_reason,external_request_id,created_at,auth_user_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)").run('${syntheticPosterId}','preview','allowed','movie',900001,'Synthetic Poster',null,null,null,now,'synthetic-user');db.prepare('INSERT INTO poster_cache(media_item_id,content_type,body,fetched_at) VALUES(?,?,?,?)').run('${syntheticPosterId}','image/svg+xml; charset=utf-8',Buffer.from(${JSON.stringify(svg)}),now);db.exec('COMMIT')}catch(e){db.exec('ROLLBACK');throw e}db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();`;
    this.runHelper(alphaIndexImage, this.originalVolume, "node", script, false);
  }

  private captureState(port: number, expectedId: "group:default" | "group:shared"): AggregateState {
    const stats = this.catalogStats(port), settings = this.object(this.json(port, "/api/admin/settings", { headers: this.headers() }));
    const profile = this.object(this.json(port, "/api/admin/feel-profiles?watchContext=group", { headers: this.headers() }));
    const exported = this.object(this.json(port, "/api/admin/feel-profiles/export", { headers: this.headers() }));
    const support = this.object(this.json(port, "/api/admin/support-bundle", { headers: this.headers() }));
    if (profile.id !== expectedId || !Array.isArray(profile.terms)) throw new UpgradeValidationError("api_profile_schema_failed");
    const state: AggregateState = { catalog: stats, settings: { fixtureMode: settings.fixtureMode === true, syncInterval: this.integer(settings.sync?.intervalMinutes), resultLimit: this.integer(settings.search?.defaultResultLimit), retentionDays: this.integer(settings.reviewQueue?.retentionDays), maxQueries: this.integer(settings.reviewQueue?.maxQueries) },
      profile: { id: profile.id, terms: profile.terms.length, maxVersion: profile.terms.reduce((max: number, term: JsonObject) => Math.max(max, this.integer(term.version)), 0), feedback: this.integer(exported.feedbackSummary?.total) },
      requests: { total: this.integer(support.requests?.total), previews: this.integer(support.requests?.previews), creates: this.integer(support.requests?.creates), blocked: this.integer(support.requests?.blocked), failed: this.integer(support.requests?.failed) } };
    if (!validateAggregate(state, expectedId)) throw new UpgradeValidationError("api_aggregate_schema_failed"); return state;
  }

  private catalogStats(port: number) { const stats = this.object(this.json(port, "/api/library/stats", { headers: this.headers() })); return { total: this.integer(stats.totalItems), plex: this.integer(stats.plexItems), seerr: this.integer(stats.seerrItems) }; }
  private search(port: number, limit: number): { sessionId: string; results: JsonObject[] } {
    const body = this.object(this.json(port, "/api/search", { method: "POST", headers: this.headers(), body: JSON.stringify({ query: "funny fantasy", resultLimit: limit, useAi: false, watchContext: "group" }) }));
    if (!validateSearchResponseShape(body)) throw new UpgradeValidationError("search_schema_failed");
    const results = (body.results as unknown[]).map((entry: unknown) => { const row = this.object(entry); if (typeof row.id !== "string" || !row.id || typeof row.posterUrl !== "string" || !row.posterUrl.startsWith("/api/items/")) throw new UpgradeValidationError("search_result_schema_failed"); return row; });
    return { sessionId: body.sessionId as string, results };
  }
  private assertSearch(port: number) { if (!this.search(port, 3).results.length) throw new UpgradeValidationError("deterministic_search_failed"); }
  private assertSyntheticPoster(port: number) { const response = this.fetchBinary(port, `/api/items/${syntheticPosterId}/poster`); if (!response.ok || response.contentType !== "image/svg+xml; charset=utf-8" || createHash("sha256").update(response.body).digest("hex") !== createHash("sha256").update(syntheticPosterSvg()).digest("hex")) throw new UpgradeValidationError("synthetic_poster_route_failed"); }

  private inspectDatabase(volume: string, expectedSchema: 21 | 28): DatabaseObservation {
    if (!this.baselineRecommendationSessionId) throw new UpgradeValidationError("database_observation_failed");
    const ids = expectedSchema === 21 ? alphaMigrationIds : candidateMigrationIds;
    const script = databaseInspectionScriptV2(ids, expectedSchema, this.baselineRecommendationSessionId);
    // SQLite's read-only connection still needs directory access for WAL/shared-memory
    // locking. The pinned helper opens the database read-only; the mount remains writable
    // so the observation includes committed WAL content instead of using unsafe immutable mode.
    const output = this.runHelper(archiveHelperImage, volume, "node", script, false);
    const parsed = JSON.parse(output.trim()) as DatabaseObservation;
    if (validateDatabaseObservation(parsed, expectedSchema).length) throw new UpgradeValidationError("database_observation_failed"); return parsed;
  }

  private runHelper(image: string, volume: string, entrypoint: string, script: string, readOnly: boolean) {
    return this.docker(["run", "--rm", "--platform", "linux/amd64", "--network", "none", "--read-only", "--privileged=false", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "128", "--memory", "2g", "--memory-swap", "2g", "--cpus", "2", "--user", "999:999", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777", "--label", `${ownerLabel}=${this.owner}`, "--mount", `type=volume,src=${volume},dst=/data${readOnly ? ",readonly" : ""}`, "--entrypoint", entrypoint, image, "-e", script]);
  }

  private createColdArchive() { const archive = this.dockerBuffer(["run", "--rm", "--platform", "linux/amd64", "--network", "none", "--read-only", "--privileged=false", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true", "--pids-limit", "128", "--memory", "2g", "--memory-swap", "2g", "--cpus", "2", "--user", "999:999", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777", "--label", `${ownerLabel}=${this.owner}`, "--mount", `type=volume,src=${this.originalVolume},dst=/source,readonly`, archiveHelperImage, "tar", "-C", "/source", "-cf", "-", "."]); writeFileSync(this.archivePath, archive, { mode: 0o600, flag: "wx" }); chmodSync(this.archivePath, 0o600); return archive; }
  private restoreColdArchive(archive: Buffer) {
    if (createHash("sha256").update(readFileSync(this.archivePath)).digest("hex") !== createHash("sha256").update(archive).digest("hex")) throw new UpgradeValidationError("archive_checksum_mismatch");
    this.dockerWithInput(["run", "--rm", "--interactive", "--platform", "linux/amd64", "--network", "none", "--read-only", "--privileged=false", "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE", "--security-opt", "no-new-privileges:true", "--pids-limit", "128", "--memory", "2g", "--memory-swap", "2g", "--cpus", "2", "--user", "0:0", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777", "--label", `${ownerLabel}=${this.owner}`, "--mount", `type=volume,src=${this.rollbackVolume},dst=/target`, archiveHelperImage, "tar", "--no-same-owner", "-C", "/target", "-xf", "-"], archive);
    this.docker(["run", "--rm", "--platform", "linux/amd64", "--network", "none", "--read-only", "--privileged=false", "--cap-drop", "ALL", "--cap-add", "CHOWN", "--security-opt", "no-new-privileges:true", "--pids-limit", "128", "--memory", "2g", "--memory-swap", "2g", "--cpus", "2", "--user", "0:0", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777", "--label", `${ownerLabel}=${this.owner}`, "--mount", `type=volume,src=${this.rollbackVolume},dst=/target`, archiveHelperImage, "chown", "-R", "999:999", "/target"]);
  }

  private waitForHealth(name: string, port: number, version?: string, revision?: string) {
    const deadline = Date.now() + 60_000; while (Date.now() < deadline) { try { const response = this.fetch(port, "/api/health"); if (response.ok) { const body = this.object(JSON.parse(response.body)); if (version && (body.version !== version || body.revision !== revision)) throw new UpgradeValidationError("candidate_runtime_identity_mismatch"); this.waitForDockerHealth(name); this.assertRuntimeState(name); return; } } catch (error) { if (error instanceof UpgradeValidationError && error.code === "candidate_runtime_identity_mismatch") throw error; } Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); } throw new UpgradeValidationError("health_timeout");
  }
  private waitForDockerHealth(name: string) { const deadline = Date.now() + 60_000; while (Date.now() < deadline) { const status = this.docker(["container", "inspect", name, "--format", "{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}"]).trim(); if (status === "healthy") return; if (status === "unhealthy" || status === "missing") throw new UpgradeValidationError("docker_health_failed"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); } throw new UpgradeValidationError("docker_health_timeout"); }
  private waitForCandidateSyncIdle(port: number) { const deadline = Date.now() + 30_000; while (Date.now() < deadline) { const body = this.object(this.json(port, "/api/admin/sync/status", { headers: this.headers() })); if (typeof body.running !== "boolean") throw new UpgradeValidationError("candidate_sync_schema_failed"); if (!body.running) return; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); } throw new UpgradeValidationError("candidate_sync_timeout"); }
  private assertRuntimeState(name: string) { const state = JSON.parse(this.docker(["container", "inspect", name, "--format", "{{json .State}}"])) as JsonObject; const restarts = this.integer(Number(this.docker(["container", "inspect", name, "--format", "{{.RestartCount}}"]).trim())); if (!state.Running || state.OOMKilled || state.Restarting || restarts !== 0 || state.Health?.Status !== "healthy") throw new UpgradeValidationError("container_runtime_state_failed"); }
  private stopForTransition(name: string) { this.verifyHardening(name); this.assertRuntimeState(name); this.docker(["stop", "--time", "30", name]); const state = JSON.parse(this.docker(["container", "inspect", name, "--format", "{{json .State}}"])) as JsonObject; const restarts = Number(this.docker(["container", "inspect", name, "--format", "{{.RestartCount}}"]).trim());
    if (state.Running) throw new UpgradeValidationError("container_stop_still_running");
    if (state.OOMKilled) throw new UpgradeValidationError("container_stop_oom");
    if (state.Restarting || restarts !== 0) throw new UpgradeValidationError("container_stop_restart");
    const image = this.metadata.get(name)?.image;
    if (!image || !isAcceptedGracefulStopExit(image, Number(state.ExitCode))) throw new UpgradeValidationError("container_stop_exit_nonzero");
    if (state.Error && String(state.Error).trim()) throw new UpgradeValidationError("container_stop_state_error");
  }
  private startExisting(name: string) { this.docker(["start", name]); }
  private removeStopped(name: string) { if (!this.createdContainers.has(name)) return; this.assertOwned("container", name); const running = this.docker(["container", "inspect", name, "--format", "{{.State.Running}}"]).trim(); if (running !== "false") throw new UpgradeValidationError("container_not_stopped"); this.docker(["rm", name]); this.createdContainers.delete(name); this.metadata.delete(name); }

  private cleanup() {
    let failed = false;
    let discoveredContainers: string[] = [];
    try { discoveredContainers = this.listOwned("container"); } catch { failed = true; }
    const containers = new Set([...this.createdContainers, ...discoveredContainers]);
    for (const name of containers) try { this.assertOwnedCleanup("container", name); this.dockerCleanup(["rm", "--force", name]); } catch { failed = true; }
    let discoveredVolumes: string[] = [];
    try { discoveredVolumes = this.listOwned("volume"); } catch { failed = true; }
    const volumes = new Set([...this.createdVolumes, ...discoveredVolumes]);
    for (const name of volumes) try { this.assertOwnedCleanup("volume", name); this.dockerCleanup(["volume", "rm", "--force", name]); } catch { failed = true; }
    try { if (this.listOwned("container").length || this.listOwned("volume").length) failed = true; } catch { failed = true; }
    try { rmSync(this.temporaryDirectory, { recursive: true, force: true }); } catch { failed = true; }
    return failed;
  }
  private listOwned(kind: "container" | "volume") { const args = kind === "container" ? ["ps", "-a", "--filter", `label=${ownerLabel}=${this.owner}`, "--format", "{{.Names}}"] : ["volume", "ls", "-q", "--filter", `label=${ownerLabel}=${this.owner}`]; return this.dockerCleanup(args).split(/\r?\n/).map((v) => v.trim()).filter(Boolean); }
  private assertOwned(kind: "container" | "volume", name: string) { const labelPath = kind === "container" ? ".Config.Labels" : ".Labels"; if (this.docker([kind, "inspect", name, "--format", `{{index ${labelPath} "${ownerLabel}"}}`]).trim() !== this.owner) throw new UpgradeValidationError("resource_ownership_uncertain"); }
  private assertOwnedCleanup(kind: "container" | "volume", name: string) { const labelPath = kind === "container" ? ".Config.Labels" : ".Labels"; if (this.dockerCleanup([kind, "inspect", name, "--format", `{{index ${labelPath} "${ownerLabel}"}}`]).trim() !== this.owner) throw new Error("ownership"); }
  private exists(kind: "container" | "volume", name: string) { try { this.docker([kind, "inspect", name]); return true; } catch { return false; } }
  private availablePort() { const script = "const n=require('node:net'),s=n.createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; return Number(execFileSync(process.execPath, ["-e", script], { encoding: "utf8", timeout: 5_000 }).trim()); }
  private headers() { return { "Content-Type": "application/json", "X-Moodarr-Admin-Token": this.token }; }
  private object(value: unknown): JsonObject { if (!value || typeof value !== "object" || Array.isArray(value)) throw new UpgradeValidationError("api_object_schema_failed"); return value as JsonObject; }
  private integer(value: unknown) { if (!validCount(value)) throw new UpgradeValidationError("finite_integer_required"); return value as number; }
  private json(port: number, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) { const response = this.fetch(port, path, init); if (!response.ok) throw new UpgradeValidationError("api_contract_failed"); try { return JSON.parse(response.body) as unknown; } catch { throw new UpgradeValidationError("api_json_failed"); } }
  private fetch(port: number, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) { const script = `const u=process.argv[1],i=JSON.parse(process.argv[2]);fetch(u,{...i,signal:AbortSignal.timeout(15000)}).then(async r=>console.log(JSON.stringify({ok:r.ok,status:r.status,headers:Object.fromEntries(r.headers),body:await r.text()}))).catch(()=>process.exit(2))`; const output = execFileSync(process.execPath, ["-e", script, `http://127.0.0.1:${port}${path}`, JSON.stringify(init)], { encoding: "utf8", timeout: 20_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); return JSON.parse(output.trim()) as { ok: boolean; status: number; headers: Record<string, string>; body: string }; }
  private fetchBinary(port: number, path: string) { const script = `const u=process.argv[1],h=JSON.parse(process.argv[2]);fetch(u,{headers:h,signal:AbortSignal.timeout(15000)}).then(async r=>{const b=Buffer.from(await r.arrayBuffer());console.log(JSON.stringify({ok:r.ok,contentType:r.headers.get('content-type'),body:b.toString('base64')}))}).catch(()=>process.exit(2))`; const output = execFileSync(process.execPath, ["-e", script, `http://127.0.0.1:${port}${path}`, JSON.stringify(this.headers())], { encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] }); const parsed = JSON.parse(output.trim()) as { ok: boolean; contentType: string; body: string }; return { ok: parsed.ok, contentType: parsed.contentType, body: Buffer.from(parsed.body, "base64") }; }
  private docker(args: string[]) { this.checkDeadline(); return execFileSync(resolveTrustedHostExecutable("docker"), args, { encoding: "utf8", env: controlledHostEnvironment(), timeout: commandTimeoutMs, maxBuffer: maxCommandBuffer, stdio: ["ignore", "pipe", "pipe"] }); }
  private dockerBuffer(args: string[]) { this.checkDeadline(); return execFileSync(resolveTrustedHostExecutable("docker"), args, { env: controlledHostEnvironment(), timeout: commandTimeoutMs, maxBuffer: maxCommandBuffer, stdio: ["ignore", "pipe", "pipe"] }) as Buffer; }
  private dockerWithInput(args: string[], input: Buffer) { this.checkDeadline(); return execFileSync(resolveTrustedHostExecutable("docker"), args, { input, encoding: "utf8", env: controlledHostEnvironment(), timeout: commandTimeoutMs, maxBuffer: maxCommandBuffer, stdio: ["pipe", "pipe", "pipe"] }); }
  private dockerCleanup(args: string[]) { return execFileSync(resolveTrustedHostExecutable("docker"), args, { encoding: "utf8", env: controlledHostEnvironment(), timeout: 30_000, maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }); }
  private checkDeadline() { if (Date.now() > this.phaseDeadline) throw new UpgradeValidationError("overall_timeout"); }
}

function syntheticPosterSvg() { const title = "Synthetic Poster"; return `<svg xmlns="http://www.w3.org/2000/svg" width="500" height="750" viewBox="0 0 500 750" role="img" aria-label="${title} poster">
    <defs>
      <linearGradient id="bg" x1="0%" x2="100%" y1="0%" y2="100%">
        <stop offset="0%" stop-color="#f1d78a"/>
        <stop offset="55%" stop-color="#5bb7a8"/>
        <stop offset="100%" stop-color="#32302f"/>
      </linearGradient>
    </defs>
    <rect width="500" height="750" fill="url(#bg)"/>
    <rect x="42" y="52" width="416" height="646" rx="18" fill="rgba(255,255,255,0.18)" stroke="rgba(255,255,255,0.55)" stroke-width="3"/>
    <text x="250" y="325" text-anchor="middle" font-family="Satoshi, Geist, Helvetica Neue, sans-serif" font-size="42" font-weight="800" fill="#ffffff">
      ${title}
    </text>
    <text x="250" y="392" text-anchor="middle" font-family="Satoshi, Geist, Helvetica Neue, sans-serif" font-size="22" fill="#ffffff">Moodarr fixture</text>
  </svg>`; }

function databaseInspectionScriptV2(expectedIds: string[], schema: 21 | 28, recommendationSessionId: string) {
  const profileAuth = schema === 28 ? "auth_user_id" : "NULL AS auth_user_id";
  const externalType = schema === 28 ? "e.media_type" : "m.media_type";
  const capabilities = schema === 28 ? "u.can_request,u.can_use_ai" : "1 AS can_request,1 AS can_use_ai";
  const sessionAuth = schema === 28 ? "s.auth_user_id" : "NULL";
  const posterExtras = schema === 28
    ? "source_key,byte_size,last_accessed_at"
    : "NULL AS source_key,length(body) AS byte_size,fetched_at AS last_accessed_at";
  const capabilityGate = schema === 28
    ? "one(\"SELECT COUNT(*) value FROM app_users WHERE id='synthetic-user' AND can_request=1 AND can_use_ai=1\")===1"
    : "false";
  const externalTypeGate = schema === 28
    ? "one('SELECT COUNT(*) value FROM external_ids e JOIN media_items m ON m.id=e.media_item_id WHERE e.media_type<>m.media_type')===0"
    : "true";
  return `
const {DatabaseSync}=require('node:sqlite'),fs=require('node:fs'),crypto=require('node:crypto');
const db=new DatabaseSync('/data/moodarr.sqlite',{readOnly:true});
const one=q=>Number(db.prepare(q).get().value),all=q=>[...db.prepare(q).iterate()];
const encode=v=>v instanceof Uint8Array?{$blobSha256:crypto.createHash('sha256').update(v).digest('hex'),$byteLength:v.byteLength}:typeof v==='bigint'?{$bigint:String(v)}:v;
const hashParts=parts=>{const h=crypto.createHash('sha256');for(const [tag,sql,params=[]] of parts){h.update(tag+'\\n');for(const row of db.prepare(sql).iterate(...params))h.update(JSON.stringify(Object.fromEntries(Object.entries(row).map(([k,v])=>[k,encode(v)])))+'\\n')}return h.digest('hex')};
const baselineRecommendationSessionId=${JSON.stringify(recommendationSessionId)};
const logical="CASE WHEN id='group:default' THEN 'group:shared' ELSE id END";
const logicalProfile="CASE WHEN profile_id='group:default' THEN 'group:shared' ELSE profile_id END";
const integrity=all('PRAGMA integrity_check'),fk=all('PRAGMA foreign_key_check'),ids=all('SELECT id FROM schema_migrations ORDER BY id').map(r=>r.id);
let config,configJsonValid=false,configMode0600=false,configOwner999=false,configHash='',configRawHash='';
try{const raw=fs.readFileSync('/data/config.json');config=JSON.parse(raw.toString('utf8'));configJsonValid=!!config&&!Array.isArray(config)&&typeof config==='object';const stat=fs.statSync('/data/config.json');configMode0600=(stat.mode&511)===384;configOwner999=stat.uid===999&&stat.gid===999;const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;configHash=crypto.createHash('sha256').update(JSON.stringify(canonical(config))).digest('hex');configRawHash=crypto.createHash('sha256').update(raw).digest('hex')}catch{}
const poster=db.prepare("SELECT content_type,body,fetched_at,${posterExtras} FROM poster_cache WHERE media_item_id='${syntheticPosterId}'").get(),posterBody=poster?Buffer.from(poster.body):Buffer.alloc(0);
const result={
 schemaVersion:Number(db.prepare('PRAGMA user_version').get().user_version),integrity:integrity.length===1?String(integrity[0].integrity_check):'failed',integrityOk:integrity.length===1&&integrity[0].integrity_check==='ok',foreignKeysOk:fk.length===0,
 migrationCount:ids.length,migrationIdsExact:JSON.stringify(ids)===JSON.stringify(${JSON.stringify(expectedIds)}),
 totalItems:one('SELECT COUNT(*) value FROM media_items'),plexItems:one('SELECT COUNT(*) value FROM plex_items WHERE available=1'),seerrItems:one('SELECT COUNT(*) value FROM seerr_items'),externalIds:one('SELECT COUNT(*) value FROM external_ids'),externalMediaTypesValid:${externalTypeGate},
 requestAudits:one('SELECT COUNT(*) value FROM request_audit'),attributedRequestAudits:one('SELECT COUNT(*) value FROM request_audit WHERE auth_user_id IS NOT NULL'),feedbackEvents:one('SELECT COUNT(*) value FROM feel_feedback_events'),profileTerms:one('SELECT COUNT(*) value FROM feel_profile_terms'),profileCheckpoints:one('SELECT COUNT(*) value FROM feel_profile_checkpoints'),
 groupDefaultProfiles:one("SELECT COUNT(*) value FROM preference_profiles WHERE id='group:default'"),groupSharedProfiles:one("SELECT COUNT(*) value FROM preference_profiles WHERE id='group:shared'"),groupDefaultRecommendationSessions:one("SELECT COUNT(*) value FROM recommendation_sessions WHERE profile_id='group:default'"),groupSharedRecommendationSessions:one("SELECT COUNT(*) value FROM recommendation_sessions WHERE profile_id='group:shared'"),appUsers:one('SELECT COUNT(*) value FROM app_users'),userSessions:one('SELECT COUNT(*) value FROM user_sessions'),syntheticUserCapabilities:${capabilityGate},
 posterRows:one('SELECT COUNT(*) value FROM poster_cache'),posterSvgRows:one("SELECT COUNT(*) value FROM poster_cache WHERE content_type LIKE 'image/svg+xml%'"),posterPngJpegRows:one("SELECT COUNT(*) value FROM poster_cache WHERE content_type LIKE 'image/png%' OR content_type LIKE 'image/jpeg%'"),
 posterByteSizeBackfilled:!!poster&&poster.byte_size===posterBody.length&&posterBody.length>0,posterLastAccessBackfilled:!!poster&&poster.last_accessed_at===poster.fetched_at,
 configJsonValid,configMode0600,configOwner999,
	 canonical:{
	  config:configHash,
	  configRaw:configRawHash,
  profiles:hashParts([
   ['profiles',\`SELECT \${logical} AS logical_id,watch_context,label,created_at,updated_at,${profileAuth} FROM preference_profiles ORDER BY logical_id\`],
   ['weights',\`SELECT \${logicalProfile} AS logical_profile_id,feature,weight,updated_at FROM preference_feature_weights ORDER BY logical_profile_id,feature\`],
   ['terms',\`SELECT \${logicalProfile} AS logical_profile_id,watch_context,term,feature_weights_json,confidence,evidence_count,positive_count,negative_count,last_event_id,created_at,updated_at,version,positive_weight,negative_weight,effective_evidence,conflict_score FROM feel_profile_terms ORDER BY logical_profile_id,term\`]
  ]),
  checkpoints:hashParts([['checkpoints',\`SELECT \${logicalProfile} AS logical_profile_id,watch_context,term,version,feature_weights_json,confidence,evidence_count,positive_count,negative_count,positive_weight,negative_weight,effective_evidence,conflict_score,event_id,created_at FROM feel_profile_checkpoints ORDER BY logical_profile_id,term,version\`]]),
  feedback:hashParts([['feedback','SELECT id,session_id,media_item_id,compared_media_item_id,watch_context,source,action,mood_term,reason,strength,metadata_json,created_at,reliability,profile_version,profile_update_applied,profile_holdout,client_event_id FROM feel_feedback_events ORDER BY id']]),
  requestAudits:hashParts([['request-audits','SELECT id,media_item_id,action,status,media_type,media_id,title,seasons_json,blocked_reason,external_request_id,created_at,auth_user_id FROM request_audit ORDER BY id']]),
  mediaExternalIds:hashParts([['media-external',\`SELECT m.id,m.media_type,m.title,m.normalized_title,m.year,m.summary,m.runtime_minutes,m.content_rating,m.poster_path,m.critic_rating,m.audience_rating,m.user_rating,m.created_at,m.updated_at,m.source,e.source AS external_source,e.value AS external_value,${externalType} AS external_media_type FROM media_items m LEFT JOIN external_ids e ON e.media_item_id=m.id ORDER BY m.id,e.source,e.value\`]]),
  catalogRelationships:hashParts([
   ['plex-items','SELECT id,media_item_id,rating_key,guid,library_title,library_type,plex_url,available,last_seen_at FROM plex_items ORDER BY id'],
   ['seerr-items','SELECT id,media_item_id,tmdb_id,tvdb_id,imdb_id,seerr_media_id,media_type,status,request_status,requestable,seerr_url,last_seen_at FROM seerr_items ORDER BY id']
  ]),
  recommendations:hashParts([
   ['sessions',\`SELECT s.id,s.query_hash,s.engine_version,s.model,s.watch_context,s.result_count,s.candidate_count,s.rerank_candidate_count,s.used_ai,s.seerr_augmented,s.latency_ms,CASE WHEN s.profile_id='group:default' THEN 'group:shared' ELSE s.profile_id END AS logical_profile_id,s.profile_version,${sessionAuth} AS auth_user_id,s.trace_schema_version,s.trace_flags_json,s.brief_trace_json,s.retrieval_trace_json,s.rerank_trace_json,s.created_at FROM recommendation_sessions s WHERE s.id=?\`,[baselineRecommendationSessionId]],
   ['results','SELECT session_id,media_item_id,rank,score,score_breakdown_json,availability_group,feature_version,provenance_json,score_trace_json FROM recommendation_results WHERE session_id=? ORDER BY media_item_id',[baselineRecommendationSessionId]],
   ['feedback','SELECT id,session_id,media_item_id,watch_context,feedback,created_at FROM recommendation_feedback WHERE session_id=? ORDER BY id',[baselineRecommendationSessionId]],
   ['provenance','SELECT id,session_id,media_item_id,source,score,source_rank,detail_json,created_at FROM recommendation_candidate_provenance WHERE session_id=? ORDER BY id',[baselineRecommendationSessionId]],
   ['rejections','SELECT id,session_id,media_item_id,stage,reason_code,score,detail_json,sampled,created_at FROM recommendation_rejections WHERE session_id=? ORDER BY id',[baselineRecommendationSessionId]],
   ['impressions','SELECT id,session_id,media_item_id,rank_shown,surface,visibility,action,dwell_ms,metadata_json,created_at FROM recommendation_impressions WHERE session_id=? ORDER BY id',[baselineRecommendationSessionId]]
  ]),
  userSessions:hashParts([
   ['users',\`SELECT u.id,u.provider,u.provider_user_id,u.username,u.display_name,u.email,u.avatar_url,u.enabled,u.created_at,u.updated_at,u.last_login_at,u.plex_token,${capabilities} FROM app_users u ORDER BY u.id\`],
   ['sessions','SELECT id,user_id,token_hash,created_at,expires_at,last_seen_at FROM user_sessions ORDER BY id']
  ]),
  poster:hashParts([['posters',\`SELECT media_item_id,content_type,body,fetched_at,${posterExtras} FROM poster_cache ORDER BY media_item_id\`]]),
  posterBody:crypto.createHash('sha256').update(posterBody).digest('hex')
 }};
console.log(JSON.stringify(result));db.close();`;
}

export function resolveAmd64ManifestDigest(raw: string, image: string) { const digest = image.split("@")[1]; const manifest = JSON.parse(raw) as JsonObject; if (Array.isArray(manifest.manifests)) { const selected = manifest.manifests.find((entry: JsonObject) => entry.platform?.os === "linux" && entry.platform?.architecture === "amd64"); if (!selected?.digest) throw new UpgradeValidationError("amd64_manifest_missing"); return String(selected.digest); } if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new UpgradeValidationError("manifest_digest_missing"); return digest; }
export function currentSourceSnapshot(): SourceSnapshot { const gitExecutable = resolveTrustedHostExecutable("git"); const git = (args: string[]) => execFileSync(gitExecutable, args, { encoding: "utf8", env: controlledHostEnvironment(), timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }).trim(); const scriptPath = "scripts/validate-beta-upgrade.ts", headRevision = git(["rev-parse", "HEAD"]); let scriptMatchesHead = false; try { scriptMatchesHead = readFileSync(scriptPath).equals(execFileSync(gitExecutable, ["show", `HEAD:${scriptPath}`], { env: controlledHostEnvironment(), timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] })); } catch { scriptMatchesHead = false; } const packageVersion = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version; return { headRevision, dirty: Boolean(git(["status", "--porcelain"])), scriptMatchesHead, packageVersion }; }
export function runBetaUpgradeValidation(options: UpgradeOptions) { return new Harness(options).run(); }

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) { try { const report = runBetaUpgradeValidation(parseUpgradeArgs(process.argv.slice(2))); if (findForbiddenPublicEvidence(report).length) throw new UpgradeValidationError("public_report_safety_failure"); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); if (report.status !== "passed") process.exitCode = 1; } catch (error) { const code = error instanceof UpgradeValidationError ? error.code : "unexpected_failure"; process.stdout.write(`${JSON.stringify({ schema: "moodarr-beta-upgrade-validation-v1", status: "failed", releaseEligible: false, failures: [code] })}\n`); process.exitCode = 1; } }
