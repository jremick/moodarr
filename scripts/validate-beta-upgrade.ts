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
const syntheticRows = 79_995;
const syntheticPosterId = "synthetic-000001";
const integrationFixturePath = "scripts/fixtures/beta-install-integrations.mjs";
const integrationBaseUrl = "http://integrations:4700";
export const integrationStubReadyMarker = "MOODARR_BETA_STUB_READY";
const integrationListenFixtureContract = `server.listen(port, "0.0.0.0");`;
const upgradeIntegrationListenFixtureContract = `server.listen(port, "0.0.0.0", () => {
  process.stdout.write("${integrationStubReadyMarker}\\n");
});`;
const plexRefreshTmdbId = 7_002;
const plexRefreshTitle = "Beta Candidate Lantern";
const plexRefreshSummary = "Friends follow a lantern through a quiet fantasy adventure.";
const plexRefreshQuery = "beta candidate lantern";
const plexRefreshLibrary = "Candidate Library";
const plexRefreshUrl = "https://app.plex.tv/desktop/#!/server/candidate-stub-machine/details?key=%2Flibrary%2Fmetadata%2F1002";
const plexRefreshAppUrl = "plex://play/?metadataKey=%2Flibrary%2Fmetadata%2F1002&server=candidate-stub-machine";
const paginatedPlexFixtureContract = `  if (url.pathname === "/library/sections/1/all") {
    calls.plexLibraryPages += 1;
    if (!acceptsJson(request) || request.headers["x-plex-container-size"] !== "500") return rejectContract(response, "invalid_pagination");
    const start = Number(request.headers["x-plex-container-start"] ?? "0");
    if (!Number.isSafeInteger(start) || !new Set([0, 1]).has(start)) return rejectContract(response, "invalid_pagination");
    const metadata = [plexItems[start]];
    return sendJson(response, 200, { MediaContainer: { totalSize: plexItems.length, offset: start, size: metadata.length, Metadata: metadata } });
  }`;
const upgradePlexFixtureContract = `  if (url.pathname === "/library/sections/1/all") {
    calls.plexLibraryPages += 1;
    const pageSize = request.headers["x-plex-container-size"];
    const startHeader = request.headers["x-plex-container-start"];
    const alphaUnpaged = pageSize === undefined && startHeader === undefined;
    if (!acceptsJson(request) || (!alphaUnpaged && pageSize !== "500")) return rejectContract(response, "invalid_pagination");
    const start = alphaUnpaged ? 0 : Number(startHeader ?? "0");
    if (!Number.isSafeInteger(start) || !new Set([0, 1]).has(start)) return rejectContract(response, "invalid_pagination");
    const metadata = alphaUnpaged ? plexItems : [plexItems[start]];
    return sendJson(response, 200, { MediaContainer: { totalSize: plexItems.length, offset: start, size: metadata.length, Metadata: metadata } });
  }`;
const legacyTmdbBoundaryId = "legacy-tmdb-boundary-sentinel";
const legacyTmdbBoundaryTitle = "Legacy TMDB Boundary Sentinel";
const legacyTmdbBoundarySummary = "Legacy descriptive metadata that the schema-29 boundary must remove.";
const legacyTmdbBoundaryTmdbId = 987_654_321;
const legacyTmdbBoundarySessionId = "legacy-tmdb-boundary-session";
const trustedRefreshId = "trusted-refresh-sentinel";
const trustedRefreshLegacyTitle = "Legacy Seerr Catalog Overlap Sentinel";
const trustedRefreshLegacySummary = "Legacy descriptive metadata that must not survive the strict boundary.";
const trustedRefreshCatalogTitle = "Synthetic Trusted Catalog Recovery Sentinel";
const trustedRefreshCatalogSummary = "Self-authored trusted catalog metadata restored by the packaged importer.";
const trustedRefreshCatalogQuery = "synthetic trusted catalog recovery sentinel";
const trustedRefreshWikidataId = "Q987654320";
const trustedRefreshTmdbId = 987_654_320;
const trustedRefreshCatalogVersion = "synthetic-trusted-refresh-v2";
const trustedRefreshCatalogPath = "/data/trusted-refresh-catalog.jsonl";
const trustedRefreshCatalogRecord = {
  wikidataId: trustedRefreshWikidataId,
  mediaType: "movie",
  title: trustedRefreshCatalogTitle,
  description: trustedRefreshCatalogSummary,
  year: 1994,
  genreLabels: ["Synthetic recovery drama"],
  sitelinkCount: 42,
  awardCount: 1,
  hasEnglishWikipedia: true
};
const catalogCollisionOldId = "catalog-collision-tv";
const catalogCollisionTargetId = "catalog-collision-movie";
const catalogCollisionWrongWikidataId = "Q987654322";
const catalogCollisionCompanionWikidataId = "Q987654323";
const catalogCollisionSharedTmdbId = 987_654_322;
const catalogCollisionTargetImdbId = "tt98765432";
const catalogCollisionWrongRecord = {
  wikidataId: catalogCollisionWrongWikidataId,
  mediaType: "movie",
  title: "Synthetic Shared TMDB Movie",
  year: 1995,
  tmdbMovieId: catalogCollisionSharedTmdbId,
  imdbId: catalogCollisionTargetImdbId,
  genreLabels: ["Synthetic movie"]
};
const catalogCollisionCompanionRecord = {
  wikidataId: catalogCollisionCompanionWikidataId,
  mediaType: "television series",
  title: "Synthetic Shared TMDB Series",
  year: 1996,
  tmdbTvId: catalogCollisionSharedTmdbId,
  genreLabels: ["Synthetic television"]
};
const trustedRefreshCatalogRecords = [
  trustedRefreshCatalogRecord,
  catalogCollisionWrongRecord,
  catalogCollisionCompanionRecord
];
const trustedRefreshCatalogBody = `${trustedRefreshCatalogRecords.map((record) => JSON.stringify(record)).join("\n")}\n`;
const trustedRefreshCatalogFileSha256 = createHash("sha256").update(trustedRefreshCatalogBody).digest("hex");
const trustedRefreshCatalogPayloadHash = createHash("sha256").update(JSON.stringify(trustedRefreshCatalogRecord)).digest("hex");
const catalogCollisionWrongPayloadHash = createHash("sha256").update(JSON.stringify(catalogCollisionWrongRecord)).digest("hex");
const catalogCollisionCompanionPayloadHash = createHash("sha256").update(JSON.stringify(catalogCollisionCompanionRecord)).digest("hex");
const trustedBinaryDirectories = ["/usr/local/bin", "/usr/bin", "/bin", "/opt/homebrew/bin"] as const;
const alphaMigrationIds = [
  "001_initial_schema", "002_request_audit", "003_media_source", "004_mood_feature_scores", "005_query_review_queue",
  "006_feel_feedback_events", "007_feel_profile_terms", "008_feel_feedback_reliability", "009_profile_replay_metadata",
  "010_profile_confidence_evidence", "011_replay_logging_holdout", "012_feel_profile_checkpoints", "013_plex_user_auth",
  "014_request_auth_attribution", "015_feel_feedback_client_event_id", "016_store_plex_user_token", "017_open_catalog_backbone",
  "018_catalog_update_metadata", "019_catalog_search_index", "020_content_fingerprints", "021_moodrank_trace_foundation"
];
export const candidateMigrationIds = [...alphaMigrationIds,
  "022_media_type_aware_external_ids", "023_user_scoped_feel_profiles", "024_request_creation_idempotency", "025_user_capabilities",
  "026_durable_auth_and_request_reconciliation", "027_bounded_poster_cache", "028_catalog_diagnostics_indexes",
  "029_strict_tmdb_content_boundary", "030_retrieval_performance_indexes", "031_integration_identity_quarantine"
];

export class UpgradeValidationError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "UpgradeValidationError"; }
}

export function buildUpgradeIntegrationFixture(source: string) {
  const first = source.indexOf(paginatedPlexFixtureContract);
  const listen = source.indexOf(integrationListenFixtureContract);
  if (first < 0 || first !== source.lastIndexOf(paginatedPlexFixtureContract)
    || listen < 0 || listen !== source.lastIndexOf(integrationListenFixtureContract)
    || source.includes(integrationStubReadyMarker)) {
    throw new UpgradeValidationError("integration_fixture_contract_mismatch");
  }
  return source
    .replace(paginatedPlexFixtureContract, upgradePlexFixtureContract)
    .replace(integrationListenFixtureContract, upgradeIntegrationListenFixtureContract);
}

export function assessIntegrationStubReadiness(logs: string, state: unknown): "ready" | "waiting" | "not_running" {
  const value = state && typeof state === "object" && !Array.isArray(state) ? state as JsonObject : undefined;
  if (value?.Running !== true || value.Restarting === true || value.OOMKilled === true) return "not_running";
  return logs.split(/\r?\n/).includes(integrationStubReadyMarker) ? "ready" : "waiting";
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
  requestAuditFacts: string; requests: string; mediaExternalIds: string; mediaIdentityFacts: string; catalogRelationships: string;
  recommendations: string; userSessions: string; poster: string; posterSafe: string; posterBody: string;
  legacyBoundary: string; legacyBoundaryFacts: string; queryReview: string;
}
export interface StrictTmdbBoundaryObservation {
  mediaRows: number; legacyDescriptiveRows: number; sanitizedRows: number;
  factualExternalIdRows: number; seerrRelationshipRows: number; plexRelationshipRows: number;
  requestRows: number; requestAuditRows: number; requestAuditDescriptiveRows: number;
  derivedRows: number; derivedSurfaceRows: DerivedSurfaceObservation; legacyDerivedReplicas: DerivedSurfaceObservation;
  posterRows: number; reviewQueueRows: number; reviewQueueDescriptiveRows: number;
  requestOperationsTable: boolean; requestOperationRows: number; requestOperationDescriptiveRows: number;
}
export interface DerivedSurfaceObservation {
  genres: number; mediaFeatures: number; mediaEmbeddings: number; mediaMoodFeatureScores: number;
  mediaContentFingerprints: number; mediaFeatureFts: number; catalogSearchIndex: number; catalogSearchIndexFts: number;
}
export interface TrustedRefreshObservation {
  mediaRows: number; legacyDescriptiveRows: number; sanitizedOperationalRows: number; rehydratedCatalogRows: number;
  activeCatalogRelationships: number; trustedCatalogProvenanceRows: number; staleCatalogRelationships: number;
  requestableSeerrRelationships: number; refreshRequiredRows: number;
  legacyDerivedReplicaRows: number; catalogSearchIndexRows: number; catalogSearchIndexFtsRows: number;
}
export interface PlexRefreshObservation {
  mediaRows: number; descriptiveLiveRows: number; sanitizedOperationalRows: number;
  plexRelationshipRows: number; seerrRelationshipRows: number; refreshRequiredRows: number;
  genreRows: number; mediaFeatureRows: number; catalogSearchIndexRows: number; catalogSearchIndexFtsRows: number;
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
  strictTmdbBoundary?: StrictTmdbBoundaryObservation;
  trustedRefresh?: TrustedRefreshObservation;
  plexRefresh?: PlexRefreshObservation;
  configJsonValid: boolean; configMode0600?: boolean; configOwner999?: boolean; canonical?: CanonicalHashes;
}
export interface TransitionAssessment { checks: string[]; failures: string[]; incomplete: string[] }
export interface ReportInput {
  options: UpgradeOptions; candidatePlatformDigest?: string; archiveSha256?: string;
  before?: AggregateState; candidate?: AggregateState; restarted?: AggregateState; rollback?: AggregateState;
  beforeDatabase?: DatabaseObservation; candidateDatabase?: DatabaseObservation; plexRefreshedDatabase?: DatabaseObservation;
  restartedDatabase?: DatabaseObservation; rollbackDatabase?: DatabaseObservation;
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
    if (!allowLocalImage) throw new UpgradeValidationError("local_rehearsal_acknowledgements_required");
  }
  return { candidateImage, expectedVersion, expectedRevision, official, allowDirty, allowLocalImage, allowEmulation };
}

export function validateSourceSnapshot(options: UpgradeOptions, source: SourceSnapshot) {
  if (source.packageVersion !== options.expectedVersion) throw new UpgradeValidationError("package_version_mismatch");
  if (source.headRevision !== options.expectedRevision) throw new UpgradeValidationError("revision_not_head");
  if (!options.allowDirty && source.dirty) throw new UpgradeValidationError("dirty_worktree");
  if (!options.allowDirty && !source.scriptMatchesHead) throw new UpgradeValidationError("script_not_bound_to_head");
}

function validCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function validSha256(value: unknown) { return typeof value === "string" && /^[0-9a-f]{64}$/.test(value); }
const derivedSurfaceKeys = ["genres", "mediaFeatures", "mediaEmbeddings", "mediaMoodFeatureScores", "mediaContentFingerprints",
  "mediaFeatureFts", "catalogSearchIndex", "catalogSearchIndexFts"] as const;
function validDerivedSurfaces(value: DerivedSurfaceObservation | undefined) {
  return Boolean(value && derivedSurfaceKeys.every((key) => validCount(value[key])));
}
function validateAggregate(state: AggregateState, expectedProfile: "group:default" | "group:shared") {
  const counts = [state.catalog.total, state.catalog.plex, state.catalog.seerr, state.settings.syncInterval, state.settings.resultLimit,
    state.settings.retentionDays, state.settings.maxQueries, state.profile.terms, state.profile.maxVersion, state.profile.feedback,
    state.requests.total, state.requests.previews, state.requests.creates, state.requests.blocked, state.requests.failed];
  return state.settings.fixtureMode === false && state.profile.id === expectedProfile && counts.every(validCount);
}

export function validateDatabaseObservation(observation: DatabaseObservation, expectedSchema: 21 | 31) {
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
  const boundary = observation.strictTmdbBoundary;
  if (!boundary || ![
    boundary.mediaRows, boundary.legacyDescriptiveRows, boundary.sanitizedRows, boundary.factualExternalIdRows,
    boundary.seerrRelationshipRows, boundary.plexRelationshipRows, boundary.requestRows, boundary.requestAuditRows,
    boundary.requestAuditDescriptiveRows, boundary.derivedRows, boundary.posterRows, boundary.reviewQueueRows,
    boundary.reviewQueueDescriptiveRows, boundary.requestOperationRows, boundary.requestOperationDescriptiveRows
  ].every(validCount) || !validDerivedSurfaces(boundary?.derivedSurfaceRows) || !validDerivedSurfaces(boundary?.legacyDerivedReplicas)
    || typeof boundary?.requestOperationsTable !== "boolean") failures.push("strict_tmdb_boundary");
  const trustedRefresh = observation.trustedRefresh;
  if (!trustedRefresh || ![
    trustedRefresh.mediaRows, trustedRefresh.legacyDescriptiveRows, trustedRefresh.sanitizedOperationalRows,
    trustedRefresh.rehydratedCatalogRows, trustedRefresh.activeCatalogRelationships,
    trustedRefresh.trustedCatalogProvenanceRows, trustedRefresh.staleCatalogRelationships,
    trustedRefresh.requestableSeerrRelationships, trustedRefresh.refreshRequiredRows,
    trustedRefresh.legacyDerivedReplicaRows, trustedRefresh.catalogSearchIndexRows,
    trustedRefresh.catalogSearchIndexFtsRows
  ].every(validCount)) failures.push("trusted_refresh");
  const plexRefresh = observation.plexRefresh;
  if (!plexRefresh || ![
    plexRefresh.mediaRows, plexRefresh.descriptiveLiveRows, plexRefresh.sanitizedOperationalRows,
    plexRefresh.plexRelationshipRows, plexRefresh.seerrRelationshipRows,
    plexRefresh.refreshRequiredRows, plexRefresh.genreRows, plexRefresh.mediaFeatureRows,
    plexRefresh.catalogSearchIndexRows, plexRefresh.catalogSearchIndexFtsRows
  ].every(validCount)) failures.push("plex_refresh");
  if (!observation.canonical || !Object.values(observation.canonical).every(validSha256)) failures.push("canonical_hashes");
  return failures;
}

export function assessStateTransitions(before: AggregateState, candidate: AggregateState, restarted: AggregateState, rollback: AggregateState,
  databases: { before: DatabaseObservation; candidate: DatabaseObservation; plexRefreshed?: DatabaseObservation; restarted?: DatabaseObservation; rollback: DatabaseObservation }): TransitionAssessment {
  const failures = [
    ...validateDatabaseObservation(databases.before, 21).map((c) => `before_${c}`),
    ...validateDatabaseObservation(databases.candidate, 31).map((c) => `candidate_${c}`),
    ...(databases.plexRefreshed ? validateDatabaseObservation(databases.plexRefreshed, 31).map((c) => `plex_refreshed_${c}`) : []),
    ...(databases.restarted ? validateDatabaseObservation(databases.restarted, 31).map((c) => `restarted_${c}`) : []),
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
    ["appUsers", "app_users"], ["userSessions", "user_sessions"], ["posterSvgRows", "poster_svg_rows"]];
  for (const [key, code] of numericKeys) {
    const baseline = databases.before[key];
    const candidateValue = databases.candidate[key];
    if (validCount(baseline) && validCount(candidateValue) && baseline === candidateValue) checks.push(`database_${code}_preserved`);
    else failures.push(`database_${code}_preserved`);
    if (databases.restarted) {
      const restartedValue = databases.restarted[key];
      const expectedRestartedValue = key === "externalIds" && validCount(baseline) ? baseline + 1 : baseline;
      if (validCount(expectedRestartedValue) && validCount(restartedValue) && expectedRestartedValue === restartedValue) checks.push(`restart_database_${code}_preserved`);
      else failures.push(`restart_database_${code}_preserved`);
    }
    const rollbackValue = databases.rollback[key];
    if (validCount(baseline) && validCount(rollbackValue) && baseline === rollbackValue) checks.push(`rollback_database_${code}_preserved`);
    else failures.push(`rollback_database_${code}_preserved`);
  }
  if (
    databases.before.posterRows === 4 && databases.before.posterPngJpegRows === 3
    && databases.candidate.posterRows === 3 && databases.candidate.posterPngJpegRows === 2
    && databases.restarted?.posterRows === 1 && databases.restarted.posterPngJpegRows === 0
    && databases.rollback.posterRows === 4 && databases.rollback.posterPngJpegRows === 3
  ) checks.push("database_tmdb_poster_sanitized");
  else failures.push("database_tmdb_poster_sanitized");
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
  if (
    databases.candidate.posterByteSizeBackfilled
    && databases.candidate.posterLastAccessBackfilled
    && databases.candidate.strictTmdbBoundary?.posterRows === 0
  ) checks.push("synthetic_poster_blob_migrated");
  else failures.push("synthetic_poster_blob_migrated");
  const exactRelationships = (
    db: DatabaseObservation,
    phase: "legacy" | "sanitized" | "rehydrated"
  ) => db.totalItems === 80_002 && db.plexItems === 2 && db.seerrItems === 4
    && db.requestAudits === 4 && db.attributedRequestAudits === 2 && db.feedbackEvents === 1 && db.profileTerms === 1 && db.profileCheckpoints === 1
    && db.appUsers === 1 && db.userSessions === 1
    && db.posterRows === (phase === "legacy" ? 4 : phase === "sanitized" ? 3 : 1)
    && db.posterSvgRows === 1
    && db.posterPngJpegRows === (phase === "legacy" ? 3 : phase === "sanitized" ? 2 : 0)
    && db.externalMediaTypesValid === true && (phase !== "legacy"
      ? db.groupDefaultProfiles === 0 && db.groupSharedProfiles === 1 && db.syntheticUserCapabilities === true
      : db.groupDefaultProfiles === 1 && db.groupSharedProfiles === 0);
  for (const [label, db, phase] of [["before", databases.before, "legacy"], ["candidate", databases.candidate, "sanitized"],
    ...(databases.plexRefreshed ? [["plex_refreshed", databases.plexRefreshed, "sanitized"] as const] : []),
    ...(databases.restarted ? [["restarted", databases.restarted, "rehydrated"] as const] : []), ["rollback", databases.rollback, "legacy"]] as const) {
    if (exactRelationships(db, phase)) checks.push(`${label}_relationships_exact`); else failures.push(`${label}_relationships_exact`);
  }
  const boundaryExpected = (db: DatabaseObservation, migrated: boolean) => {
    const value = db.strictTmdbBoundary;
    const surfaces = value?.derivedSurfaceRows;
    const legacyReplicas = value?.legacyDerivedReplicas;
    const legacyReplicaStateValid = validDerivedSurfaces(legacyReplicas)
      && derivedSurfaceKeys.every((key) => migrated ? legacyReplicas![key] === 0 : legacyReplicas![key] > 0);
    return Boolean(value
      && value.mediaRows === 1
      && value.legacyDescriptiveRows === (migrated ? 0 : 1)
      && value.sanitizedRows === (migrated ? 1 : 0)
      && value.factualExternalIdRows === 1
      && value.seerrRelationshipRows === 1
      && value.plexRelationshipRows === 0
      && value.requestRows === 1
      && value.requestAuditRows === 1
      && value.requestAuditDescriptiveRows === (migrated ? 0 : 1)
      && validCount(value.derivedRows)
      && legacyReplicaStateValid
      && validDerivedSurfaces(surfaces)
      && value.posterRows === (migrated ? 0 : 1)
      && value.reviewQueueRows === 1
      && value.reviewQueueDescriptiveRows === (migrated ? 0 : 1)
      && value.requestOperationsTable === migrated
      && value.requestOperationRows === 0
      && value.requestOperationDescriptiveRows === 0);
  };
  for (const [label, db, migrated] of [["legacy_seeded", databases.before, false], ["candidate_sanitized", databases.candidate, true],
    ...(databases.plexRefreshed ? [["plex_refresh_preserved", databases.plexRefreshed, true] as const] : []),
    ...(databases.restarted ? [["restart_preserved", databases.restarted, true] as const] : []), ["rollback_restored", databases.rollback, false]] as const) {
    if (boundaryExpected(db, migrated)) checks.push(`strict_tmdb_boundary_${label}`); else failures.push(`strict_tmdb_boundary_${label}`);
  }
  const trustedRefreshExpected = (db: DatabaseObservation, phase: "legacy" | "sanitized" | "rehydrated") => {
    const value = db.trustedRefresh;
    return Boolean(value
      && value.mediaRows === 1
      && value.legacyDescriptiveRows === (phase === "legacy" ? 1 : 0)
      && value.sanitizedOperationalRows === (phase === "sanitized" ? 1 : 0)
      && value.rehydratedCatalogRows === (phase === "rehydrated" ? 1 : 0)
      && value.activeCatalogRelationships === 1
      && value.trustedCatalogProvenanceRows === 1
      && value.staleCatalogRelationships === (phase === "sanitized" ? 1 : 0)
      && value.requestableSeerrRelationships === 1
      && value.refreshRequiredRows === (phase === "sanitized" ? 1 : 0)
      && value.legacyDerivedReplicaRows === (phase === "legacy" ? 3 : 0)
      && value.catalogSearchIndexRows === (phase === "sanitized" ? 0 : 1)
      && value.catalogSearchIndexFtsRows === (phase === "sanitized" ? 0 : 1));
  };
  for (const [label, db, phase] of [
    ["legacy_seeded", databases.before, "legacy"],
    ["candidate_sanitized", databases.candidate, "sanitized"],
    ...(databases.plexRefreshed ? [["plex_refresh_preserved", databases.plexRefreshed, "sanitized"] as const] : []),
    ...(databases.restarted ? [["catalog_rehydrated", databases.restarted, "rehydrated"] as const] : []),
    ["rollback_restored", databases.rollback, "legacy"]
  ] as const) {
    if (trustedRefreshExpected(db, phase)) checks.push(`trusted_refresh_${label}`); else failures.push(`trusted_refresh_${label}`);
  }
  const plexRefreshExpected = (db: DatabaseObservation, phase: "legacy" | "sanitized" | "rehydrated") => {
    const value = db.plexRefresh;
    const materialized = phase !== "sanitized";
    return Boolean(value
      && value.mediaRows === 1
      && value.descriptiveLiveRows === (materialized ? 1 : 0)
      && value.sanitizedOperationalRows === (phase === "sanitized" ? 1 : 0)
      && value.plexRelationshipRows === 1
      && value.seerrRelationshipRows === 1
      && value.refreshRequiredRows === (phase === "sanitized" ? 1 : 0)
      && value.genreRows === (materialized ? 2 : 0)
      && value.mediaFeatureRows === (materialized ? 1 : 0)
      && value.catalogSearchIndexRows === (materialized ? 1 : 0)
      && value.catalogSearchIndexFtsRows === (materialized ? 1 : 0));
  };
  for (const [label, db, phase] of [
    ["legacy_seeded", databases.before, "legacy"],
    ["candidate_sanitized", databases.candidate, "sanitized"],
    ...(databases.plexRefreshed ? [["full_sync_rehydrated", databases.plexRefreshed, "rehydrated"] as const] : []),
    ...(databases.restarted ? [["restart_preserved", databases.restarted, "rehydrated"] as const] : []),
    ["rollback_restored", databases.rollback, "legacy"]
  ] as const) {
    if (plexRefreshExpected(db, phase)) checks.push(`plex_refresh_${label}`); else failures.push(`plex_refresh_${label}`);
  }
  const hashChecks: Array<[keyof CanonicalHashes, string]> = [
    ["profiles", "canonical_profiles_preserved"], ["checkpoints", "canonical_checkpoints_preserved"], ["feedback", "canonical_feedback_preserved"],
    ["requestAuditFacts", "canonical_request_audits_preserved"], ["requests", "canonical_request_state_preserved"],
    ["mediaIdentityFacts", "canonical_media_external_ids_preserved"], ["catalogRelationships", "canonical_catalog_relationships_preserved"],
    ["recommendations", "canonical_recommendations_preserved"], ["userSessions", "canonical_user_sessions_preserved"],
    ["posterSafe", "canonical_poster_preserved"], ["legacyBoundaryFacts", "canonical_legacy_facts_preserved"]
  ];
  for (const [key, code] of hashChecks) {
    const hash = databases.before.canonical?.[key];
    const posterBodyHash = databases.before.canonical?.posterBody;
    const posterBodyMatches = key !== "posterSafe" || (validSha256(posterBodyHash) && posterBodyHash === databases.candidate.canonical?.posterBody
      && posterBodyHash === databases.restarted?.canonical?.posterBody && posterBodyHash === databases.rollback.canonical?.posterBody);
    if (validSha256(hash) && posterBodyMatches && hash === databases.candidate.canonical?.[key] && hash === databases.restarted?.canonical?.[key] && hash === databases.rollback.canonical?.[key]) checks.push(code);
    else failures.push(code);
  }
  for (const [key, code] of [
    ["requestAudits", "canonical_request_audits_sanitized"],
    ["poster", "canonical_poster_cache_sanitized"], ["legacyBoundary", "canonical_legacy_boundary_sanitized"],
    ["queryReview", "canonical_query_review_sanitized"]
  ] as const) {
    const beforeHash = databases.before.canonical?.[key];
    const candidateHash = databases.candidate.canonical?.[key];
    if (validSha256(beforeHash) && validSha256(candidateHash) && beforeHash !== candidateHash
      && candidateHash === databases.restarted?.canonical?.[key] && beforeHash === databases.rollback.canonical?.[key]) checks.push(code);
    else failures.push(code);
  }
  const beforeMediaHash = databases.before.canonical?.mediaExternalIds;
  const candidateMediaHash = databases.candidate.canonical?.mediaExternalIds;
  const restartedMediaHash = databases.restarted?.canonical?.mediaExternalIds;
  const rollbackMediaHash = databases.rollback.canonical?.mediaExternalIds;
  if (validSha256(beforeMediaHash) && validSha256(candidateMediaHash) && beforeMediaHash !== candidateMediaHash
    && beforeMediaHash === rollbackMediaHash) checks.push("canonical_media_descriptions_sanitized");
  else failures.push("canonical_media_descriptions_sanitized");
  if (validSha256(candidateMediaHash) && validSha256(restartedMediaHash) && candidateMediaHash !== restartedMediaHash
    && beforeMediaHash !== restartedMediaHash && beforeMediaHash === rollbackMediaHash) checks.push("canonical_trusted_descriptions_rehydrated");
  else failures.push("canonical_trusted_descriptions_rehydrated");
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
    posterLastAccessBackfilled: db.posterLastAccessBackfilled, strictTmdbBoundary: db.strictTmdbBoundary,
    trustedRefresh: db.trustedRefresh, plexRefresh: db.plexRefresh,
    configJsonValid: db.configJsonValid, configMode0600: db.configMode0600, configOwner999: db.configOwner999 };
}
const allowedIncomplete = new Set(["local_rehearsal", "amd64_emulation"]);
const preservationCodes = ["total_items", "plex_items", "seerr_items", "external_ids", "request_audits", "attributed_request_audits",
  "feedback_events", "profile_terms", "profile_checkpoints", "app_users", "user_sessions", "poster_svg_rows"];
export const requiredUpgradeCheckCodes = Object.freeze([
  "alpha_api_seed", "alpha_production_catalog_3_2_2", "cold_archive_sha256", "candidate_restart", "candidate_ai_policy_enforced", "rollback_fresh_volume",
  "candidate_tmdb_policy_enforced", "synthetic_poster_route_preserved", "candidate_catalog_preserved", "candidate_settings_preserved", "candidate_profile_migrated",
  "candidate_request_audits_preserved", "candidate_restart_preserved", "rollback_state_preserved", "representative_catalog_80000",
  "database_group_profile_migrated", "synthetic_user_capability_migrated", "synthetic_poster_blob_migrated",
  "recommendation_profile_sessions_migrated", "database_tmdb_poster_sanitized",
  "strict_tmdb_boundary_legacy_seeded", "strict_tmdb_boundary_candidate_sanitized", "strict_tmdb_boundary_plex_refresh_preserved", "strict_tmdb_boundary_restart_preserved", "strict_tmdb_boundary_rollback_restored",
  "trusted_refresh_legacy_seeded", "trusted_refresh_candidate_sanitized", "trusted_refresh_catalog_rehydrated", "trusted_refresh_rollback_restored",
  "trusted_refresh_plex_refresh_preserved",
  "plex_refresh_legacy_seeded", "plex_refresh_candidate_sanitized", "plex_refresh_full_sync_rehydrated", "plex_refresh_restart_preserved", "plex_refresh_rollback_restored",
  "production_plex_full_sync", "plex_refresh_required_cleared", "plex_recovery_search_restored",
  "packaged_trusted_catalog_refresh", "trusted_catalog_requestable_search_restored", "trusted_refresh_required_cleared",
  "before_relationships_exact", "candidate_relationships_exact", "plex_refreshed_relationships_exact", "restarted_relationships_exact", "rollback_relationships_exact",
  "canonical_profiles_preserved", "canonical_checkpoints_preserved", "canonical_feedback_preserved", "canonical_request_audits_preserved",
  "canonical_media_external_ids_preserved", "canonical_request_state_preserved", "canonical_catalog_relationships_preserved", "canonical_recommendations_preserved",
  "canonical_user_sessions_preserved", "canonical_poster_preserved", "canonical_legacy_facts_preserved", "canonical_request_audits_sanitized",
  "canonical_media_descriptions_sanitized", "canonical_poster_cache_sanitized", "canonical_legacy_boundary_sanitized", "canonical_query_review_sanitized",
  "canonical_trusted_descriptions_rehydrated",
  "config_hash_preserved", "config_raw_hash_preserved",
  "before_database_integrity", "candidate_database_integrity", "rollback_database_integrity", "before_foreign_keys", "candidate_foreign_keys", "rollback_foreign_keys",
  ...preservationCodes.flatMap((code) => [`database_${code}_preserved`, `restart_database_${code}_preserved`, `rollback_database_${code}_preserved`])
]);
const expectedUpgradeCheckCount = 107;
const knownCheckCodes = new Set<string>(requiredUpgradeCheckCodes);
const validationPrefixes = ["before", "candidate", "plex_refreshed", "restarted", "rollback"].flatMap((prefix) => ["schema_version", "database_integrity", "foreign_keys",
  "schema_migrations", "config_json", "config_mode", "config_owner", "external_media_types", "database_counts", "strict_tmdb_boundary", "trusted_refresh", "plex_refresh", "canonical_hashes"].map((code) => `${prefix}_${code}`));
const knownFailureCodes = new Set([...knownCheckCodes, ...validationPrefixes,
  "missing_evidence", "before_api_schema", "candidate_api_schema", "restarted_api_schema", "rollback_api_schema", "unexpected_failure",
  "invalid_arguments", "invalid_beta_version", "invalid_revision", "official_overrides_rejected", "invalid_candidate_image",
  "local_rehearsal_acknowledgements_required", "package_version_mismatch", "dirty_worktree", "script_not_bound_to_head", "revision_not_head", "required_upgrade_check_codes_missing",
  "trusted_docker_not_found", "trusted_git_not_found",
  "invalid_fixture_timestamp", "integration_fixture_contract_mismatch",
  "integration_stub_observation_failed", "integration_stub_not_running", "integration_stub_readiness_timeout",
  "docker_endpoint_not_local_unix", "native_linux_amd64_required", "image_platform_mismatch", "alpha_oci_labels_mismatch",
  "candidate_oci_identity_mismatch", "alpha_platform_manifest_mismatch", "amd64_manifest_missing", "manifest_digest_missing",
  "resource_collision", "alpha_migrated_volume_start_blocked", "container_metadata_missing", "container_hardening_mismatch",
  "alpha_settings_seed_failed", "alpha_sync_seed_failed", "alpha_native_stats_failed", "alpha_search_seed_failed", "alpha_profile_seed_failed",
  "alpha_requestable_seed_missing", "alpha_request_preview_failed", "alpha_request_create_failed", "alpha_native_relationships_failed",
  "api_profile_schema_failed", "api_aggregate_schema_failed", "search_schema_failed", "search_result_schema_failed", "deterministic_search_failed",
  "candidate_trusted_refresh_state_failed", "candidate_recovery_diagnostics_failed", "candidate_plex_sync_failed", "candidate_plex_recovery_failed",
  "trusted_catalog_import_failed", "trusted_catalog_requestable_search_failed", "trusted_refresh_diagnostics_failed",
  "candidate_ai_policy_failed", "candidate_tmdb_policy_failed",
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
  const assessment = input.before && input.candidate && input.restarted && input.rollback && input.beforeDatabase && input.candidateDatabase
    && input.plexRefreshedDatabase && input.restartedDatabase && input.rollbackDatabase
    ? assessStateTransitions(input.before, input.candidate, input.restarted, input.rollback, {
        before: input.beforeDatabase, candidate: input.candidateDatabase, plexRefreshed: input.plexRefreshedDatabase,
        restarted: input.restartedDatabase, rollback: input.rollbackDatabase
      })
    : { checks: [], failures: ["missing_evidence"], incomplete: [] };
  const checks = safeChecks([...(input.checks ?? []), ...assessment.checks]);
  const checkContractComplete = requiredUpgradeCheckCodes.length === expectedUpgradeCheckCount
    && knownCheckCodes.size === expectedUpgradeCheckCount
    && checks.length === expectedUpgradeCheckCount
    && requiredUpgradeCheckCodes.every((code) => checks.includes(code));
  const failures = safeFailures([
    ...(input.failures ?? []),
    ...assessment.failures,
    ...(!checkContractComplete ? ["required_upgrade_check_codes_missing"] : [])
  ]);
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
    database: { before: publicDatabase(input.beforeDatabase), candidate: publicDatabase(input.candidateDatabase),
      plexRefreshed: publicDatabase(input.plexRefreshedDatabase), restarted: publicDatabase(input.restartedDatabase), rollback: publicDatabase(input.rollbackDatabase) },
    checks, failures, incomplete
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

export function validateCandidateReleaseLabels(labels: Record<string, unknown>, version: string, revision: string) {
  return labels["org.opencontainers.image.version"] === version
    && labels["org.opencontainers.image.revision"] === revision
    && labels["io.moodarr.ai-provider-policy"] === "none"
    && labels["io.moodarr.tmdb-content-policy"] === "none";
}

export function validateCandidateTmdbPolicySurfaces(health: unknown, publicConfig: unknown, settings: unknown) {
  const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined;
  const healthRecord = record(health), configRecord = record(publicConfig), settingsRecord = record(settings);
  return record(healthRecord?.policies)?.tmdbContent === "none"
    && record(configRecord?.seerr)?.tmdbContentPolicy === "none"
    && record(settingsRecord?.seerr)?.tmdbContentPolicy === "none";
}

export function upgradeFixtureTimestamp(nowMs = Date.now()) {
  const timestamp = new Date(nowMs);
  if (!Number.isFinite(timestamp.getTime())) throw new UpgradeValidationError("invalid_fixture_timestamp");
  return timestamp.toISOString();
}

export function validatePlexRecoverySearchResults(value: unknown) {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const result = value[0];
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const row = result as Record<string, unknown>;
  const plex = row.plex;
  if (!plex || typeof plex !== "object" || Array.isArray(plex)) return false;
  const projection = plex as Record<string, unknown>;
  return row.title === plexRefreshTitle
    && row.year === 2023
    && row.summary === plexRefreshSummary
    && row.availabilityGroup === "available_in_plex"
    && projection.available === true
    && projection.library === plexRefreshLibrary
    && projection.url === plexRefreshUrl
    && projection.appUrl === plexRefreshAppUrl;
}

export function validateTrustedCatalogRecoverySearchResults(value: unknown) {
  if (!Array.isArray(value) || value.length !== 1) return false;
  const result = value[0];
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const row = result as Record<string, unknown>;
  const metadata = row.metadata;
  const seerr = row.seerr;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
    || !seerr || typeof seerr !== "object" || Array.isArray(seerr)) return false;
  const metadataProjection = metadata as Record<string, unknown>;
  const seerrProjection = seerr as Record<string, unknown>;
  return row.id === trustedRefreshId
    && row.title === trustedRefreshCatalogTitle
    && row.year === 1994
    && row.summary === trustedRefreshCatalogSummary
    && row.availabilityGroup === "not_in_plex_requestable"
    && metadataProjection.source === "catalog"
    && metadataProjection.catalogSourceCount === 1
    && seerrProjection.requestable === true
    && seerrProjection.mediaId === trustedRefreshTmdbId;
}

export function validateTrustedRefreshClearedDiagnostics(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const features = (value as Record<string, unknown>).features;
  if (!features || typeof features !== "object" || Array.isArray(features)) return false;
  const catalog = (features as Record<string, unknown>).catalog;
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) return false;
  const projection = catalog as Record<string, unknown>;
  return projection.trustedRefreshRequiredItems === 0
    && projection.requestableTrustedRefreshRequiredItems === 0
    && projection.catalogRefreshRequiredItems === 0
    && projection.plexRefreshRequiredItems === 0;
}

export function ownedResourceListArgs(kind: "container" | "volume" | "network", owner: string) {
  return kind === "container"
    ? ["ps", "-a", "--filter", `label=${ownerLabel}=${owner}`, "--format", "{{.Names}}"]
    : kind === "network"
      ? ["network", "ls", "--filter", `label=${ownerLabel}=${owner}`, "--format", "{{.Name}}"]
      : ["volume", "ls", "--filter", `label=${ownerLabel}=${owner}`, "--format", "{{.Name}}"];
}

class Harness {
  private readonly owner = randomBytes(16).toString("hex");
  private readonly token = randomBytes(32).toString("hex");
  private readonly legacyOpenAiKey = randomBytes(32).toString("base64url");
  private readonly hostileOpenAiKey = randomBytes(32).toString("base64url");
  private readonly prefix = `moodarr-upgrade-${randomBytes(8).toString("hex")}`;
  private readonly originalVolume = `${this.prefix}-original`;
  private readonly rollbackVolume = `${this.prefix}-rollback`;
  private readonly integrationNetwork = `${this.prefix}-integrations`;
  private readonly integrationStub = `${this.prefix}-stub`;
  private readonly alphaContainer = `${this.prefix}-alpha`;
  private readonly candidateContainer = `${this.prefix}-candidate`;
  private readonly rollbackContainer = `${this.prefix}-rollback`;
  private readonly createdVolumes = new Set<string>();
  private readonly createdNetworks = new Set<string>();
  private readonly createdContainers = new Set<string>();
  private readonly migratedVolumes = new Set<string>();
  private readonly metadata = new Map<string, { port: number; volume: string; image: string }>();
  private baselineRecommendationSessionId?: string;
  private readonly plexToken = randomBytes(32).toString("base64url");
  private readonly seerrKey = randomBytes(32).toString("base64url");
  private readonly temporaryDirectory = mkdtempSync(resolve(tmpdir(), "moodarr-upgrade-"));
  private readonly archivePath = resolve(this.temporaryDirectory, "alpha-data.tar");
  private readonly phaseDeadline = Date.now() + 20 * 60_000;
  private phase = "preflight";
  constructor(private readonly options: UpgradeOptions) { chmodSync(this.temporaryDirectory, 0o700); }

  run() {
    const evidence: ReportInput = { options: this.options, checks: [], failures: [], incomplete: [] };
    try {
      this.preflight(evidence); this.phase = "alpha_baseline"; this.startIntegrationHarness(); this.createVolume(this.originalVolume);
      const alphaPort = this.availablePort(); this.startApp(this.alphaContainer, alphaIndexImage, this.originalVolume, alphaPort, true);
      this.waitForHealth(this.alphaContainer, alphaPort); this.seedAlpha(alphaPort, evidence); this.stopForTransition(this.alphaContainer);
      this.augmentStoppedAlpha(); this.startExisting(this.alphaContainer); this.waitForHealth(this.alphaContainer, alphaPort);
      evidence.before = this.captureState(alphaPort, "group:default"); this.assertSyntheticPoster(alphaPort);
      this.stopForTransition(this.alphaContainer); evidence.beforeDatabase = this.inspectDatabase(this.originalVolume, 21);
      const archive = this.createColdArchive(); evidence.archiveSha256 = createHash("sha256").update(archive).digest("hex"); this.removeStopped(this.alphaContainer);

      this.phase = "candidate_upgrade"; const candidatePort = this.availablePort(); this.migratedVolumes.add(this.originalVolume);
      this.startApp(this.candidateContainer, this.options.candidateImage, this.originalVolume, candidatePort, false);
      this.waitForHealth(this.candidateContainer, candidatePort, this.options.expectedVersion, this.options.expectedRevision); this.waitForCandidateSyncIdle(candidatePort); this.assertCandidateAiPolicy(candidatePort);
      evidence.candidate = this.captureState(candidatePort, "group:shared"); this.assertSearch(candidatePort); this.stopForTransition(this.candidateContainer);
      evidence.candidateDatabase = this.inspectDatabase(this.originalVolume, 31);
      this.assertCandidateTrustedRefreshState(evidence.candidateDatabase);
      this.startExisting(this.candidateContainer); this.waitForHealth(this.candidateContainer, candidatePort, this.options.expectedVersion, this.options.expectedRevision); this.assertCandidateAiPolicy(candidatePort);
      this.assertRecoveryDiagnostics(candidatePort, { trusted: 2, requestable: 1, catalog: 1, plex: 1 });
      this.runCandidatePlexRefresh(candidatePort); this.assertPlexRecovery(candidatePort);
      this.assertRecoveryDiagnostics(candidatePort, { trusted: 1, requestable: 1, catalog: 1, plex: 0 });
      evidence.checks!.push("production_plex_full_sync", "plex_refresh_required_cleared", "plex_recovery_search_restored");
      this.stopForTransition(this.candidateContainer); evidence.plexRefreshedDatabase = this.inspectDatabase(this.originalVolume, 31);
      this.runPackagedTrustedCatalogRefresh(); evidence.checks!.push("packaged_trusted_catalog_refresh");
      this.startExisting(this.candidateContainer); this.waitForHealth(this.candidateContainer, candidatePort, this.options.expectedVersion, this.options.expectedRevision); this.assertCandidateAiPolicy(candidatePort);
      evidence.restarted = this.captureState(candidatePort, "group:shared"); this.assertSearch(candidatePort); this.stopForTransition(this.candidateContainer);
      evidence.restartedDatabase = this.inspectDatabase(this.originalVolume, 31);
      this.startExisting(this.candidateContainer); this.waitForHealth(this.candidateContainer, candidatePort, this.options.expectedVersion, this.options.expectedRevision); this.assertCandidateAiPolicy(candidatePort);
      this.assertTrustedCatalogRecovery(candidatePort); this.assertSyntheticPoster(candidatePort);
      evidence.checks!.push("trusted_catalog_requestable_search_restored", "trusted_refresh_required_cleared");
      this.stopForTransition(this.candidateContainer); this.removeStopped(this.candidateContainer);

      this.phase = "rollback_restore"; this.createVolume(this.rollbackVolume); this.restoreColdArchive(archive);
      evidence.rollbackDatabase = this.inspectDatabase(this.rollbackVolume, 21);
      this.phase = "rollback_runtime"; const rollbackPort = this.availablePort(); this.startApp(this.rollbackContainer, alphaIndexImage, this.rollbackVolume, rollbackPort, false);
      this.waitForHealth(this.rollbackContainer, rollbackPort); evidence.rollback = this.captureState(rollbackPort, "group:default"); this.assertSearch(rollbackPort); this.assertSyntheticPoster(rollbackPort);
      this.stopForTransition(this.rollbackContainer); this.removeStopped(this.rollbackContainer);
      evidence.checks!.push("alpha_api_seed", "cold_archive_sha256", "candidate_restart", "candidate_ai_policy_enforced", "candidate_tmdb_policy_enforced", "rollback_fresh_volume", "synthetic_poster_route_preserved");
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
    } else if (!validateCandidateReleaseLabels(labels, version ?? "", revision ?? "")) {
      throw new UpgradeValidationError("candidate_oci_identity_mismatch");
    }
    if (!image.includes("@sha256:")) return undefined;
    const digest = resolveAmd64ManifestDigest(this.docker(["buildx", "imagetools", "inspect", image, "--raw"]), image);
    if (expectedPlatformDigest && digest !== expectedPlatformDigest) throw new UpgradeValidationError("alpha_platform_manifest_mismatch"); return digest;
  }

  private createVolume(volume: string) { if (this.exists("volume", volume)) throw new UpgradeValidationError("resource_collision"); this.docker(["volume", "create", "--label", `${ownerLabel}=${this.owner}`, volume]); this.createdVolumes.add(volume); }
  private startIntegrationHarness() {
    if (this.exists("network", this.integrationNetwork) || this.exists("container", this.integrationStub)) throw new UpgradeValidationError("resource_collision");
    this.docker(["network", "create", "--internal", "--label", `${ownerLabel}=${this.owner}`, this.integrationNetwork]);
    this.createdNetworks.add(this.integrationNetwork);
    const fixture = join(this.temporaryDirectory, "beta-upgrade-integrations.mjs");
    const fixtureSource = readFileSync(realpathSync(integrationFixturePath), "utf8");
    writeFileSync(fixture, buildUpgradeIntegrationFixture(fixtureSource), { mode: 0o644, flag: "wx" });
    this.docker([
      "run", "--detach", "--name", this.integrationStub, "--label", `${ownerLabel}=${this.owner}`,
      "--platform", "linux/amd64", "--network", this.integrationNetwork, "--network-alias", "integrations",
      "--read-only", "--init", "--privileged=false", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--pids-limit", "64", "--memory", "256m", "--memory-swap", "256m", "--cpus", "0.5", "--user", "1000:1000",
      "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777",
      "--env", `MOODARR_BETA_STUB_PLEX_TOKEN=${this.plexToken}`, "--env", `MOODARR_BETA_STUB_SEERR_KEY=${this.seerrKey}`,
      "--mount", `type=bind,src=${fixture},dst=/fixture/beta-install-integrations.mjs,readonly`,
      archiveHelperImage, "node", "/fixture/beta-install-integrations.mjs"
    ]);
    this.createdContainers.add(this.integrationStub);
    this.waitForIntegrationHarness();
  }
  private waitForIntegrationHarness() {
    const deadline = Math.min(Date.now() + 30_000, this.phaseDeadline);
    while (Date.now() < deadline) {
      let readiness: ReturnType<typeof assessIntegrationStubReadiness>;
      try {
        const logs = this.dockerReadiness(["logs", "--tail", "20", this.integrationStub]);
        const state = JSON.parse(this.dockerReadiness(["container", "inspect", this.integrationStub, "--format", "{{json .State}}"]));
        readiness = assessIntegrationStubReadiness(logs, state);
      } catch (error) {
        if (error instanceof UpgradeValidationError) throw error;
        throw new UpgradeValidationError("integration_stub_observation_failed");
      }
      if (readiness === "ready") return;
      if (readiness === "not_running") throw new UpgradeValidationError("integration_stub_not_running");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    this.checkDeadline();
    throw new UpgradeValidationError("integration_stub_readiness_timeout");
  }
  private startApp(name: string, image: string, volume: string, port: number, seedSettings: boolean) {
    if (image === alphaIndexImage && this.migratedVolumes.has(volume)) throw new UpgradeValidationError("alpha_migrated_volume_start_blocked");
    if (this.exists("container", name)) throw new UpgradeValidationError("resource_collision");
    const isCandidate = image === this.options.candidateImage;
    const env = ["NODE_ENV=production", "MOODARR_API_HOST=0.0.0.0", "MOODARR_API_PORT=4401", `MOODARR_WEB_ORIGIN=http://127.0.0.1:${port}`,
      "MOODARR_SERVE_CLIENT=true", "MOODARR_DATA_DIR=/data", "MOODARR_CONFIG_PATH=/data/config.json", "MOODARR_DB_PATH=/data/moodarr.sqlite",
      "MOODARR_REQUIRE_ADMIN_TOKEN=true", "MOODARR_ADMIN_AUTO_SESSION=false", `MOODARR_ADMIN_TOKEN=${this.token}`,
      isCandidate ? "AI_PROVIDER=openai" : "AI_PROVIDER=none",
      ...(isCandidate ? [`OPENAI_API_KEY=${this.hostileOpenAiKey}`] : []),
      ...(isCandidate ? ["MOODARR_TMDB_CONTENT_POLICY=configurable"] : []),
      ...(seedSettings ? ["MOODARR_SYNC_INTERVAL_MINUTES=0"] : [])];
    this.docker(["run", "--detach", "--name", name, "--label", `${ownerLabel}=${this.owner}`, ...appContainerSecurityArgs(volume, port), ...env.flatMap((value) => ["--env", value]), image]);
    this.createdContainers.add(name); this.metadata.set(name, { port, volume, image });
    this.docker(["network", "connect", this.integrationNetwork, name]); this.verifyHardening(name);
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
    const settings = this.object(this.json(port, "/api/admin/settings", { method: "PUT", headers: this.headers(), body: JSON.stringify({
      fixtureMode: false,
      plex: { baseUrl: integrationBaseUrl, token: this.plexToken },
      seerr: { baseUrl: integrationBaseUrl, apiKey: this.seerrKey },
      sync: { intervalMinutes: 0, syncSeerr: true }, search: { defaultResultLimit: 37 },
      reviewQueue: { retentionDays: 45, maxQueries: 321, captureRawQueries: false }, plexAuth: { enabled: false, allowNewUsers: false }
    }) }));
    if (settings.fixtureMode !== false || settings.plex?.tokenConfigured !== true || settings.seerr?.apiKeyConfigured !== true
      || this.integer(settings.sync?.intervalMinutes) !== 0) throw new UpgradeValidationError("alpha_settings_seed_failed");
    const plexConnection = this.object(this.json(port, "/api/plex/test", { method: "POST", headers: this.headers(), body: "{}" }));
    const seerrConnection = this.object(this.json(port, "/api/seerr/test", { method: "POST", headers: this.headers(), body: "{}" }));
    if (plexConnection.ok !== true || plexConnection.mode !== "live" || seerrConnection.ok !== true || seerrConnection.mode !== "live") {
      throw new UpgradeValidationError("alpha_settings_seed_failed");
    }
    const sync = this.object(this.json(port, "/api/admin/sync/run", { method: "POST", headers: this.headers(), body: "{}" }));
    if (sync.ok !== true || this.integer(sync.plexItems) !== 2 || this.integer(sync.seerrItems) !== 2) throw new UpgradeValidationError("alpha_sync_seed_failed");
    const stats = this.catalogStats(port); if (stats.total !== 3 || stats.plex !== 2 || stats.seerr !== 2) throw new UpgradeValidationError("alpha_native_stats_failed");
    const search = this.search(port, 10); if (search.results.length < 2) throw new UpgradeValidationError("alpha_search_seed_failed");
    this.baselineRecommendationSessionId = search.sessionId;
    const first = search.results[0]!, second = search.results[1]!;
    const feedback = this.object(this.json(port, "/api/feel-feedback", { method: "POST", headers: this.headers(), body: JSON.stringify({ action: "pairwise_pick", source: "web", clientEventId: randomBytes(12).toString("hex"), watchContext: "group", sessionId: search.sessionId, itemId: first.id, comparedItemId: second.id, moodTerm: "cozy" }) }));
    if (this.integer(feedback.profileVersion) !== 1) throw new UpgradeValidationError("alpha_profile_seed_failed");
    const preview = this.object(this.json(port, "/api/requests/preview", { method: "POST", headers: this.headers(), body: JSON.stringify({ mediaType: "movie", tmdbId: 7_003 }) }));
    if (typeof preview.confirmationPhrase !== "string" || !preview.confirmationPhrase) throw new UpgradeValidationError("alpha_request_preview_failed");
    const created = this.json(port, "/api/requests/create", { method: "POST", headers: this.headers(), body: JSON.stringify({ mediaType: "movie", tmdbId: 7_003, confirmed: true, confirmationPhrase: preview.confirmationPhrase }) });
    if (!validateRequestCreationResponse(created)) throw new UpgradeValidationError("alpha_request_create_failed");
    const state = this.captureState(port, "group:default");
    if (state.catalog.total !== 3 || state.catalog.plex !== 2 || state.catalog.seerr !== 2 || state.profile.terms < 1 || state.profile.feedback < 1
      || state.requests.total !== 2 || state.requests.previews !== 1 || state.requests.creates !== 1) throw new UpgradeValidationError("alpha_native_relationships_failed");
    evidence.checks!.push("alpha_production_catalog_3_2_2");
  }

  private augmentStoppedAlpha() {
    const svg = syntheticPosterSvg();
    const fixtureTimestamp = upgradeFixtureTimestamp();
    const script = `
const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const db = new DatabaseSync('/data/moodarr.sqlite');
db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000');
if (Number(db.prepare('PRAGMA user_version').get().user_version) !== 21) process.exit(21);
if (Number(db.prepare('SELECT COUNT(*) value FROM media_items').get().value) !== 3) process.exit(22);
const now = ${JSON.stringify(fixtureTimestamp)};
const legacyId = ${JSON.stringify(legacyTmdbBoundaryId)};
const legacyTitle = ${JSON.stringify(legacyTmdbBoundaryTitle)};
const legacySummary = ${JSON.stringify(legacyTmdbBoundarySummary)};
const legacyTmdbId = ${legacyTmdbBoundaryTmdbId};
const media = db.prepare('INSERT INTO media_items(id,media_type,title,normalized_title,year,summary,runtime_minutes,content_rating,poster_path,critic_rating,audience_rating,user_rating,created_at,updated_at,source) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
const ext = db.prepare('INSERT INTO external_ids(media_item_id,source,value) VALUES(?,?,?)');
db.exec('BEGIN IMMEDIATE');
try {
  for (let n = 1; n <= ${syntheticRows}; n += 1) {
    const suffix = String(n).padStart(6, '0');
    const id = 'synthetic-' + suffix;
    const title = n === 1 ? 'Synthetic Poster' : 'Synthetic Media ' + suffix;
    media.run(id, n % 2 ? 'movie' : 'tv', title, title.toLowerCase(), 2000 + n % 25, 'Self-authored upgrade validation fixture.', 90, 'NR', n === 1 ? 'fixture://synthetic-poster' : null, null, null, null, now, now, 'live');
    ext.run(id, 'synthetic', 'self-' + suffix);
  }
  media.run(legacyId, 'movie', legacyTitle, legacyTitle.toLowerCase(), 1987, legacySummary, 123, 'PG', 'tmdb://w500/legacy-boundary-sentinel.jpg', 7.1, 7.2, 7.3, now, now, 'live');
  ext.run(legacyId, 'tmdb', String(legacyTmdbId));
  db.prepare('INSERT INTO seerr_items(id,media_item_id,tmdb_id,tvdb_id,imdb_id,seerr_media_id,media_type,status,request_status,requestable,seerr_url,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('legacy-boundary-seerr', legacyId, legacyTmdbId, null, 'tt9876543', 987654, 'movie', 'pending', 'approved', 0, 'https://seerr.invalid/movie/' + legacyTmdbId, now);
  db.prepare('INSERT INTO genres(media_item_id,name) VALUES(?,?)').run(legacyId, legacyTitle);
  db.prepare('INSERT INTO media_features(media_item_id,feature_text,mood_terms_json,tone_terms_json,watchability_terms_json,vector_json,feature_version,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(legacyId, legacySummary, JSON.stringify([legacyTitle]), JSON.stringify([legacyTitle]), JSON.stringify([legacyTitle]), JSON.stringify([0.25, 0.75]), 'legacy-boundary-v1', now);
  db.prepare('INSERT INTO media_embeddings(media_item_id,provider,model,feature_version,input_hash,dimensions,vector_json,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(legacyId, 'legacy', 'legacy-boundary', 'legacy-boundary-v1', crypto.createHash('sha256').update(legacySummary).digest('hex'), 2, JSON.stringify([0.25, 0.75]), now);
  db.prepare('INSERT INTO media_feature_fts(media_item_id,title,feature_text,genres,people) VALUES(?,?,?,?,?)').run(legacyId, legacyTitle, legacySummary, legacyTitle, legacyTitle);
  db.prepare('INSERT INTO media_mood_feature_scores(media_item_id,source,source_version,feature,score,confidence,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run(legacyId, 'legacy', 'legacy-boundary-v1', legacyTitle, 80, 0.9, now);
  db.prepare('INSERT INTO media_content_fingerprints(media_item_id,schema_version,fingerprint_version,source,source_version,input_hash,fingerprint_json,generated_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(legacyId, 'legacy', 'legacy-boundary-v1', 'legacy', 'legacy-boundary-v1', crypto.createHash('sha256').update(legacyTitle).digest('hex'), JSON.stringify({ legacy: legacySummary }), now, now);
  db.prepare('INSERT INTO catalog_search_index(media_item_id,title,media_type,year,source,rank_score,availability_group,plex_available,seerr_requestable,has_seerr,has_summary,search_text,mood_text,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(legacyId, legacyTitle, 'movie', 1987, 'live', 1, 'unavailable', 0, 0, 1, 1, legacyTitle + ' ' + legacySummary, legacyTitle, now);
  db.prepare('INSERT INTO catalog_search_index_fts(media_item_id,title,search_text,mood_text) VALUES(?,?,?,?)').run(legacyId, legacyTitle, legacyTitle + ' ' + legacySummary, legacyTitle);
  const refreshId = ${JSON.stringify(trustedRefreshId)};
  const refreshLegacyTitle = ${JSON.stringify(trustedRefreshLegacyTitle)};
  const refreshLegacySummary = ${JSON.stringify(trustedRefreshLegacySummary)};
  const refreshWikidataId = ${JSON.stringify(trustedRefreshWikidataId)};
  const refreshTmdbId = ${trustedRefreshTmdbId};
  media.run(refreshId, 'movie', refreshLegacyTitle, refreshLegacyTitle.toLowerCase(), 1993, refreshLegacySummary, 111, 'PG-13', null, 6.1, 6.2, 6.3, now, now, 'live');
  ext.run(refreshId, 'wikidata', refreshWikidataId);
  db.prepare('INSERT INTO seerr_items(id,media_item_id,tmdb_id,tvdb_id,imdb_id,seerr_media_id,media_type,status,request_status,requestable,seerr_url,last_seen_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('trusted-refresh-seerr', refreshId, refreshTmdbId, null, null, 987653, 'movie', 'unknown', null, 1, 'https://seerr.invalid/movie/' + refreshTmdbId, now);
  db.prepare('INSERT INTO catalog_source_records(media_item_id,source,source_version,source_item_id,source_url,license_policy,payload_hash,metadata_json,fetched_at,expires_at,updated_at,active,last_seen_source_version,content_hash,content_version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(refreshId, 'wikidata', ${JSON.stringify(trustedRefreshCatalogVersion)}, refreshWikidataId, 'https://www.wikidata.org/wiki/' + refreshWikidataId, 'wikidata-cc0', ${JSON.stringify(trustedRefreshCatalogPayloadHash)}, '{}', now, null, now, 1, ${JSON.stringify(trustedRefreshCatalogVersion)}, ${JSON.stringify(trustedRefreshCatalogPayloadHash)}, 1, null);
  db.prepare('INSERT INTO catalog_rank_signals(media_item_id,source,source_version,mainstream_score,metadata_confidence,sitelink_count,external_id_count,award_count,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(refreshId, 'wikidata', ${JSON.stringify(trustedRefreshCatalogVersion)}, 50, 0.5, 10, 1, 0, now);
  db.prepare('INSERT INTO genres(media_item_id,name) VALUES(?,?)').run(refreshId, refreshLegacyTitle);
  db.prepare('INSERT INTO catalog_search_index(media_item_id,title,media_type,year,source,rank_score,availability_group,plex_available,seerr_requestable,has_seerr,has_summary,search_text,mood_text,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(refreshId, refreshLegacyTitle, 'movie', 1993, 'live', 1, 'not_in_plex_requestable', 0, 1, 1, 1, refreshLegacyTitle + ' ' + refreshLegacySummary, refreshLegacyTitle, now);
  db.prepare('INSERT INTO catalog_search_index_fts(media_item_id,title,search_text,mood_text) VALUES(?,?,?,?)')
    .run(refreshId, refreshLegacyTitle, refreshLegacyTitle + ' ' + refreshLegacySummary, refreshLegacyTitle);
  const collisionOldId = ${JSON.stringify(catalogCollisionOldId)};
  const collisionTargetId = ${JSON.stringify(catalogCollisionTargetId)};
  const collisionSharedTmdbId = ${catalogCollisionSharedTmdbId};
  const collisionWrongWikidataId = ${JSON.stringify(catalogCollisionWrongWikidataId)};
  const collisionCompanionWikidataId = ${JSON.stringify(catalogCollisionCompanionWikidataId)};
  media.run(collisionOldId, 'tv', 'Stale Shared TMDB Series', 'stale shared tmdb series', 1994, 'Stale television companion.', 99, 'WRONG', 'fixture://stale-collision-series', 1, 2, 3, now, now, 'catalog');
  media.run(collisionTargetId, 'movie', 'Stale Shared TMDB Movie', 'stale shared tmdb movie', 1994, 'Stale uniquely typed movie target.', 199, 'WRONG', 'fixture://stale-collision-movie', 1, 2, 3, now, now, 'catalog');
  ext.run(collisionOldId, 'tmdb', String(collisionSharedTmdbId));
  ext.run(collisionOldId, 'wikidata', collisionWrongWikidataId);
  ext.run(collisionOldId, 'wikidata', collisionCompanionWikidataId);
  ext.run(collisionTargetId, 'imdb', ${JSON.stringify(catalogCollisionTargetImdbId)});
  const insertCollisionCatalogSource = db.prepare('INSERT INTO catalog_source_records(media_item_id,source,source_version,source_item_id,source_url,license_policy,payload_hash,metadata_json,fetched_at,expires_at,updated_at,active,last_seen_source_version,content_hash,content_version,deleted_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  insertCollisionCatalogSource.run(collisionOldId, 'wikidata', ${JSON.stringify(trustedRefreshCatalogVersion)}, collisionWrongWikidataId, 'https://www.wikidata.org/wiki/' + collisionWrongWikidataId, 'wikidata-cc0', ${JSON.stringify(catalogCollisionWrongPayloadHash)}, '{}', now, null, now, 1, ${JSON.stringify(trustedRefreshCatalogVersion)}, ${JSON.stringify(catalogCollisionWrongPayloadHash)}, 4, null);
  insertCollisionCatalogSource.run(collisionOldId, 'wikidata', ${JSON.stringify(trustedRefreshCatalogVersion)}, collisionCompanionWikidataId, 'https://www.wikidata.org/wiki/' + collisionCompanionWikidataId, 'wikidata-cc0', ${JSON.stringify(catalogCollisionCompanionPayloadHash)}, '{}', now, null, now, 1, ${JSON.stringify(trustedRefreshCatalogVersion)}, ${JSON.stringify(catalogCollisionCompanionPayloadHash)}, 2, null);
  db.prepare('INSERT INTO catalog_rank_signals(media_item_id,source,source_version,mainstream_score,metadata_confidence,sitelink_count,external_id_count,award_count,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(collisionOldId, 'wikidata', ${JSON.stringify(trustedRefreshCatalogVersion)}, 40, 0.5, 5, 2, 0, now);
  db.prepare('INSERT INTO genres(media_item_id,name) VALUES(?,?)').run(collisionOldId, 'Stale collision television genre');
  db.prepare('INSERT INTO genres(media_item_id,name) VALUES(?,?)').run(collisionTargetId, 'Stale collision movie genre');
  db.prepare('INSERT INTO app_users(id,provider,provider_user_id,username,display_name,email,avatar_url,enabled,created_at,updated_at,last_login_at,plex_token) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
    .run('synthetic-user', 'plex', 'synthetic-provider-user', 'synthetic-user', 'Synthetic User', null, null, 1, now, now, now, null);
  db.prepare('INSERT INTO user_sessions(id,user_id,token_hash,created_at,expires_at,last_seen_at) VALUES(?,?,?,?,?,?)')
    .run('synthetic-session', 'synthetic-user', crypto.createHash('sha256').update('self-authored-session').digest('hex'), now, '2099-01-01T00:00:00.000Z', now);
  db.prepare('INSERT INTO requests(media_item_id,media_type,media_id,seasons_json,status,external_request_id,created_at) VALUES(?,?,?,?,?,?,?)')
    .run(legacyId, 'movie', legacyTmdbId, null, 'approved', 'legacy-boundary-request', now);
  db.prepare('INSERT INTO request_audit(media_item_id,action,status,media_type,media_id,title,seasons_json,blocked_reason,external_request_id,created_at,auth_user_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('${syntheticPosterId}', 'preview', 'allowed', 'movie', 900001, 'Synthetic Poster', null, null, null, now, 'synthetic-user');
  db.prepare('INSERT INTO request_audit(media_item_id,action,status,media_type,media_id,title,seasons_json,blocked_reason,external_request_id,created_at,auth_user_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(legacyId, 'create', 'created', 'movie', legacyTmdbId, legacyTitle, null, null, 'legacy-boundary-request', now, 'synthetic-user');
  db.prepare('INSERT INTO poster_cache(media_item_id,content_type,body,fetched_at) VALUES(?,?,?,?)').run('${syntheticPosterId}', 'image/svg+xml; charset=utf-8', Buffer.from(${JSON.stringify(svg)}), now);
  db.prepare('INSERT INTO poster_cache(media_item_id,content_type,body,fetched_at) VALUES(?,?,?,?)').run(legacyId, 'image/jpeg', Buffer.from(legacyTitle + ':' + legacySummary), now);
  db.prepare('INSERT INTO poster_cache(media_item_id,content_type,body,fetched_at) VALUES(?,?,?,?)').run(collisionOldId, 'image/jpeg', Buffer.from('stale-collision-series-poster'), now);
  db.prepare('INSERT INTO poster_cache(media_item_id,content_type,body,fetched_at) VALUES(?,?,?,?)').run(collisionTargetId, 'image/jpeg', Buffer.from('stale-collision-movie-poster'), now);
  const insertStaleCollisionEmbedding = db.prepare('INSERT INTO media_embeddings(media_item_id,provider,model,feature_version,input_hash,dimensions,vector_json,updated_at) VALUES(?,?,?,?,?,?,?,?)');
  insertStaleCollisionEmbedding.run(collisionOldId, 'stale-collision', 'stale-collision-series', 'stale-collision-v1', crypto.createHash('sha256').update('stale-collision-series').digest('hex'), 1, '[0.1]', now);
  insertStaleCollisionEmbedding.run(collisionTargetId, 'stale-collision', 'stale-collision-movie', 'stale-collision-v1', crypto.createHash('sha256').update('stale-collision-movie').digest('hex'), 1, '[0.2]', now);
  db.prepare('INSERT INTO recommendation_sessions(id,query_hash,engine_version,watch_context,result_count,candidate_count,rerank_candidate_count,used_ai,seerr_augmented,latency_ms,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(${JSON.stringify(legacyTmdbBoundarySessionId)}, crypto.createHash('sha256').update('legacy-boundary-query').digest('hex'), 'legacy-boundary', 'solo', 1, 1, 1, 0, 1, 1, now);
  db.prepare('INSERT INTO recommendation_results(session_id,media_item_id,rank,score,score_breakdown_json,availability_group) VALUES(?,?,?,?,?,?)')
    .run(${JSON.stringify(legacyTmdbBoundarySessionId)}, legacyId, 1, 100, '{}', 'unavailable');
  db.prepare('INSERT INTO query_review_queue(id,session_id,query_text,optimized_query,watch_context,result_count,results_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run('legacy-boundary-review', ${JSON.stringify(legacyTmdbBoundarySessionId)}, 'legacy boundary query', null, 'solo', 1, JSON.stringify([{ id: legacyId, title: legacyTitle, summary: legacySummary }]), now, now);
  db.exec('COMMIT');
} catch (error) {
  try { db.exec('ROLLBACK'); } catch { /* Preserve the fixture write failure. */ }
  throw error;
}
db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
db.close();
fs.writeFileSync(${JSON.stringify(trustedRefreshCatalogPath)}, ${JSON.stringify(trustedRefreshCatalogBody)}, { mode: 0o600 });
const configPath = '/data/config.json';
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
config.ai = { ...(config.ai || {}), provider: 'openai', openaiApiKey: ${JSON.stringify(this.legacyOpenAiKey)} };
config.seerr = { ...(config.seerr || {}), tmdbContentPolicy: 'configurable' };
fs.writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
fs.chmodSync(configPath, 0o600);
`;
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
  private search(port: number, limit: number) { return this.searchFor(port, "beta candidate", limit); }
  private searchFor(port: number, query: string, limit: number): { sessionId: string; results: JsonObject[] } {
    const body = this.object(this.json(port, "/api/search", { method: "POST", headers: this.headers(), body: JSON.stringify({ query, resultLimit: limit, useAi: false, watchContext: "group" }) }));
    if (!validateSearchResponseShape(body)) throw new UpgradeValidationError("search_schema_failed");
    const results = (body.results as unknown[]).map((entry: unknown) => { const row = this.object(entry); if (typeof row.id !== "string" || !row.id || typeof row.posterUrl !== "string" || !row.posterUrl.startsWith("/api/items/")) throw new UpgradeValidationError("search_result_schema_failed"); return row; });
    return { sessionId: body.sessionId as string, results };
  }
  private assertSearch(port: number) { if (!this.search(port, 3).results.length) throw new UpgradeValidationError("deterministic_search_failed"); }
  private assertCandidateTrustedRefreshState(database: DatabaseObservation) {
    const value = database.trustedRefresh;
    if (!value || value.mediaRows !== 1 || value.legacyDescriptiveRows !== 0 || value.sanitizedOperationalRows !== 1
      || value.rehydratedCatalogRows !== 0 || value.activeCatalogRelationships !== 1 || value.trustedCatalogProvenanceRows !== 1
      || value.requestableSeerrRelationships !== 1
      || value.staleCatalogRelationships !== 1 || value.refreshRequiredRows !== 1 || value.legacyDerivedReplicaRows !== 0 || value.catalogSearchIndexRows !== 0
      || value.catalogSearchIndexFtsRows !== 0) throw new UpgradeValidationError("candidate_trusted_refresh_state_failed");
    const plex = database.plexRefresh;
    if (!plex || plex.mediaRows !== 1 || plex.descriptiveLiveRows !== 0 || plex.sanitizedOperationalRows !== 1
      || plex.plexRelationshipRows !== 1 || plex.seerrRelationshipRows !== 1
      || plex.refreshRequiredRows !== 1 || plex.genreRows !== 0 || plex.mediaFeatureRows !== 0
      || plex.catalogSearchIndexRows !== 0 || plex.catalogSearchIndexFtsRows !== 0) {
      throw new UpgradeValidationError("candidate_trusted_refresh_state_failed");
    }
  }
  private assertRecoveryDiagnostics(port: number, expected: { trusted: number; requestable: number; catalog: number; plex: number }) {
    const diagnostics = this.object(this.json(port, "/api/admin/recommendations/diagnostics?fresh=true", { headers: this.headers() }));
    const catalog = this.object(this.object(diagnostics.features).catalog);
    if (this.integer(catalog.trustedRefreshRequiredItems) !== expected.trusted
      || this.integer(catalog.requestableTrustedRefreshRequiredItems) !== expected.requestable
      || this.integer(catalog.catalogRefreshRequiredItems) !== expected.catalog
      || this.integer(catalog.plexRefreshRequiredItems) !== expected.plex) {
      throw new UpgradeValidationError("candidate_recovery_diagnostics_failed");
    }
  }
  private runCandidatePlexRefresh(port: number) {
    const baseline = this.object(this.json(port, "/api/admin/sync/status", { headers: this.headers() }));
    const baselineResult = baseline.lastResult === undefined ? undefined : JSON.stringify(baseline.lastResult);
    const accepted = this.object(this.json(port, "/api/library/sync", { method: "POST", headers: this.headers(), body: "{}" }));
    if (accepted.accepted !== true || typeof accepted.startedAt !== "string" || !accepted.startedAt) {
      throw new UpgradeValidationError("candidate_plex_sync_failed");
    }
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      const status = this.object(this.json(port, "/api/admin/sync/status", { headers: this.headers() }));
      if (typeof status.running !== "boolean") throw new UpgradeValidationError("candidate_sync_schema_failed");
      const result = status.lastResult && typeof status.lastResult === "object" && !Array.isArray(status.lastResult)
        ? this.object(status.lastResult)
        : undefined;
      if (!status.running && result && JSON.stringify(result) !== baselineResult) {
        if (result.ok !== true || result.startedAt !== accepted.startedAt || this.integer(result.plexItems) !== 2
          || this.integer(result.seerrItems) !== 0 || this.integer(result.plexUnavailable) !== 0) {
          throw new UpgradeValidationError("candidate_plex_sync_failed");
        }
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
    throw new UpgradeValidationError("candidate_sync_timeout");
  }
  private assertPlexRecovery(port: number) {
    const results = this.searchFor(port, plexRefreshQuery, 1).results;
    if (!validatePlexRecoverySearchResults(results)) throw new UpgradeValidationError("candidate_plex_recovery_failed");
  }
  private runPackagedTrustedCatalogRefresh() {
    let discovered: JsonObject;
    let summary: JsonObject;
    try {
      const runImport = (extra: string[], readOnlyData: boolean) => this.object(JSON.parse(this.docker([
        "run", "--rm", "--platform", "linux/amd64", "--network", "none", "--read-only", "--privileged=false", "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges:true", "--pids-limit", "128", "--memory", "2g", "--memory-swap", "2g", "--cpus", "2",
        "--user", "999:999", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777", "--label", `${ownerLabel}=${this.owner}`,
        "--mount", `type=volume,src=${this.originalVolume},dst=/data${readOnlyData ? ",readonly" : ""}`,
        "--env", "NODE_ENV=production", "--env", "MOODARR_DATA_DIR=/data", "--env", "MOODARR_CONFIG_PATH=/data/config.json",
        "--env", "MOODARR_DB_PATH=/data/moodarr.sqlite", this.options.candidateImage,
        "dist/server/importWikidataCatalog.js", "--file", trustedRefreshCatalogPath, "--version", trustedRefreshCatalogVersion,
        "--source", "wikidata", "--mode", "incremental", "--rehydrate-required", "--expected-refresh-required", "1",
        "--expected-source-records", "3", "--expected-file-sha256", trustedRefreshCatalogFileSha256, "--batch-size", "1",
        ...extra
      ]).trim()));
      discovered = runImport(["--dry-run"], true);
      summary = runImport([
        "--expected-type-repairs", "1",
        "--expected-refresh-source-records", String(discovered.refreshRequiredSourceRecordsBefore),
        "--expected-recovery-source-records", "3",
        "--expected-recovery-plan-sha256", String(discovered.recoveryPlanSha256)
      ], false);
    } catch {
      throw new UpgradeValidationError("trusted_catalog_import_failed");
    }
    if (discovered.dryRun !== true || discovered.uniqueImportableSourceRecords !== 3
      || discovered.refreshRequiredSourceRecordsBefore !== 1
      || discovered.typeRepairSourceRecordsBefore !== 1 || discovered.recoverySourceRecordsPlanned !== 3
      || discovered.typeRepairExternalIdsPlanned !== 1 || discovered.typeRepairExternalIdsRemoved !== 0
      || discovered.recoverySourceRecordsSelected !== 3 || discovered.recoverySourceRecordsImported !== 0
      || discovered.fileSha256 !== trustedRefreshCatalogFileSha256) {
      throw new UpgradeValidationError("trusted_catalog_import_failed");
    }
    if (summary.source !== "wikidata" || summary.sourceVersion !== trustedRefreshCatalogVersion || summary.records !== 3
      || summary.imported !== 3 || summary.skipped !== 0 || summary.mediaItemsUpserted !== 3 || summary.sourceRecordsUpserted !== 3
      || summary.recoverySourceRecordsImported !== 3 || summary.changedSourceRecords !== 3 || summary.unchangedSourceRecords !== 0 || summary.inactiveSourceRecords !== 0
      || summary.ignoredNotRequired !== 0 || summary.dryRun !== false || summary.rehydrateRequired !== true
      || summary.expectedRefreshRequired !== 1 || summary.expectedRefreshSourceRecords !== 1 || summary.expectedSourceRecords !== 3
      || summary.expectedTypeRepairs !== 1 || summary.expectedRecoverySourceRecords !== 3
      || summary.expectedRecoveryPlanSha256 !== discovered.recoveryPlanSha256
      || summary.recoveryPlanSha256 !== discovered.recoveryPlanSha256
      || summary.uniqueImportableSourceRecords !== 3 || summary.fileSha256 !== trustedRefreshCatalogFileSha256
      || summary.refreshRequiredBefore !== 1 || summary.refreshRequiredSourceRecordsBefore !== 1
      || summary.refreshRequiredRemaining !== 0 || summary.refreshRequiredSourceRecordsRemaining !== 0
      || summary.typeRepairSourceRecordsBefore !== 1 || summary.typeRepairSourceRecordsRebound !== 1
      || summary.typeRepairSourceRecordsRemaining !== 0 || summary.typeRepairAffectedBindingsRemaining !== 0
      || summary.typeRepairExternalIdsPlanned !== 1 || summary.typeRepairExternalIdsRemoved !== 1
      || summary.typeRepairDerivedItemsRemaining !== 0 || summary.recoveryDerivedItemsRemaining !== 0
      || summary.recoverySourceRecordsPlanned !== 3 || summary.recoverySourceRecordsRemaining !== 0
      || summary.mode !== "incremental" || summary.batchSize !== 1 || summary.limit !== undefined) {
      throw new UpgradeValidationError("trusted_catalog_import_failed");
    }
    this.assertCatalogCollisionRepair();
  }
  private assertCatalogCollisionRepair() {
    const script = `
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('/data/moodarr.sqlite', { readOnly: true });
const one = (sql, ...values) => Number(db.prepare(sql).get(...values).value);
const repairedSource = db.prepare('SELECT r.media_item_id,r.source,r.source_version,r.last_seen_source_version,r.payload_hash,r.content_hash,r.content_version,r.materialization_stale,m.media_type,m.title,m.normalized_title,m.year,m.summary,m.runtime_minutes,m.content_rating,m.poster_path,m.critic_rating,m.audience_rating,m.user_rating,m.source AS media_source FROM catalog_source_records r JOIN media_items m ON m.id=r.media_item_id WHERE r.source=? AND r.source_item_id=? AND r.active=1').get('wikidata', ${JSON.stringify(catalogCollisionWrongWikidataId)});
const companionSource = db.prepare('SELECT r.media_item_id,r.source,r.source_version,r.last_seen_source_version,r.payload_hash,r.content_hash,r.content_version,r.materialization_stale,m.media_type,m.title,m.normalized_title,m.year,m.summary,m.runtime_minutes,m.content_rating,m.poster_path,m.critic_rating,m.audience_rating,m.user_rating,m.source AS media_source FROM catalog_source_records r JOIN media_items m ON m.id=r.media_item_id WHERE r.source=? AND r.source_item_id=? AND r.active=1').get('wikidata', ${JSON.stringify(catalogCollisionCompanionWikidataId)});
const sharedTmdbRows = one("SELECT COUNT(*) value FROM external_ids WHERE source='tmdb' AND value=? AND ((media_type='movie' AND media_item_id=?) OR (media_type='tv' AND media_item_id=?))", String(${catalogCollisionSharedTmdbId}), ${JSON.stringify(catalogCollisionTargetId)}, ${JSON.stringify(catalogCollisionOldId)});
const exactQidRows = one("SELECT COUNT(*) value FROM external_ids WHERE source='wikidata' AND ((media_type='movie' AND value=? AND media_item_id=?) OR (media_type='tv' AND value=? AND media_item_id=?))", ${JSON.stringify(catalogCollisionWrongWikidataId)}, ${JSON.stringify(catalogCollisionTargetId)}, ${JSON.stringify(catalogCollisionCompanionWikidataId)}, ${JSON.stringify(catalogCollisionOldId)});
const repairedGenres = db.prepare('SELECT name FROM genres WHERE media_item_id=? ORDER BY name').all(${JSON.stringify(catalogCollisionTargetId)}).map(row => row.name);
const companionGenres = db.prepare('SELECT name FROM genres WHERE media_item_id=? ORDER BY name').all(${JSON.stringify(catalogCollisionOldId)}).map(row => row.name);
const repairedSearch = db.prepare('SELECT title,media_type,source,search_text,mood_text FROM catalog_search_index WHERE media_item_id=?').get(${JSON.stringify(catalogCollisionTargetId)});
const companionSearch = db.prepare('SELECT title,media_type,source,search_text,mood_text FROM catalog_search_index WHERE media_item_id=?').get(${JSON.stringify(catalogCollisionOldId)});
const repairedSearchFts = db.prepare('SELECT title,search_text,mood_text FROM catalog_search_index_fts WHERE media_item_id=?').get(${JSON.stringify(catalogCollisionTargetId)});
const companionSearchFts = db.prepare('SELECT title,search_text,mood_text FROM catalog_search_index_fts WHERE media_item_id=?').get(${JSON.stringify(catalogCollisionOldId)});
const requiredDerivedRows = one("SELECT COUNT(*) value FROM media_items m WHERE m.id IN (?,?) AND EXISTS(SELECT 1 FROM media_features f WHERE f.media_item_id=m.id) AND EXISTS(SELECT 1 FROM media_feature_fts f WHERE f.media_item_id=m.id) AND EXISTS(SELECT 1 FROM media_mood_feature_scores s WHERE s.media_item_id=m.id) AND EXISTS(SELECT 1 FROM media_content_fingerprints f WHERE f.media_item_id=m.id) AND EXISTS(SELECT 1 FROM catalog_search_index i WHERE i.media_item_id=m.id) AND EXISTS(SELECT 1 FROM catalog_search_index_fts i WHERE i.media_item_id=m.id)", ${JSON.stringify(catalogCollisionTargetId)}, ${JSON.stringify(catalogCollisionOldId)});
const stalePosterRows = one('SELECT COUNT(*) value FROM poster_cache WHERE media_item_id IN (?,?)', ${JSON.stringify(catalogCollisionTargetId)}, ${JSON.stringify(catalogCollisionOldId)});
const staleProviderEmbeddingRows = one("SELECT COUNT(*) value FROM media_embeddings WHERE media_item_id IN (?,?) AND provider='stale-collision'", ${JSON.stringify(catalogCollisionTargetId)}, ${JSON.stringify(catalogCollisionOldId)});
console.log(JSON.stringify({ repairedSource, companionSource, sharedTmdbRows, exactQidRows, repairedGenres, companionGenres, repairedSearch, companionSearch, repairedSearchFts, companionSearchFts, requiredDerivedRows, stalePosterRows, staleProviderEmbeddingRows }));
db.close();`;
    let observation: JsonObject;
    try {
      observation = this.object(JSON.parse(this.runHelper(archiveHelperImage, this.originalVolume, "node", script, false).trim()));
    } catch {
      throw new UpgradeValidationError("trusted_catalog_import_failed");
    }
    const repairedSource = this.object(observation.repairedSource);
    const companionSource = this.object(observation.companionSource);
    const repairedSearch = this.object(observation.repairedSearch);
    const companionSearch = this.object(observation.companionSearch);
    const repairedSearchFts = this.object(observation.repairedSearchFts);
    const companionSearchFts = this.object(observation.companionSearchFts);
    const exactCatalogMedia = (
      value: JsonObject,
      expected: { id: string; mediaType: "movie" | "tv"; title: string; year: number; contentVersion: number; payloadHash: string }
    ) => value.media_item_id === expected.id && value.source === "wikidata"
      && value.source_version === trustedRefreshCatalogVersion && value.last_seen_source_version === trustedRefreshCatalogVersion
      && value.payload_hash === expected.payloadHash && value.content_hash === expected.payloadHash
      && value.content_version === expected.contentVersion && value.materialization_stale === 0
      && value.media_type === expected.mediaType && value.title === expected.title
      && value.normalized_title === expected.title.toLowerCase() && value.year === expected.year
      && value.summary === null && value.runtime_minutes === null && value.content_rating === null && value.poster_path === null
      && value.critic_rating === null && value.audience_rating === null && value.user_rating === null && value.media_source === "catalog";
    const exactSearch = (value: JsonObject, expectedType: "movie" | "tv", expectedTitle: string, expectedGenre: string) =>
      value.title === expectedTitle && value.media_type === expectedType && value.source === "catalog"
      && typeof value.search_text === "string" && value.search_text.includes(expectedTitle) && value.search_text.includes(expectedGenre)
      && !value.search_text.includes("Stale collision")
      && typeof value.mood_text === "string";
    const exactFts = (value: JsonObject, expectedTitle: string, expectedGenre: string) =>
      value.title === expectedTitle && typeof value.search_text === "string"
      && value.search_text.includes(expectedTitle) && value.search_text.includes(expectedGenre)
      && !value.search_text.includes("Stale collision") && typeof value.mood_text === "string";
    if (!exactCatalogMedia(repairedSource, {
      id: catalogCollisionTargetId, mediaType: "movie", title: catalogCollisionWrongRecord.title,
      year: catalogCollisionWrongRecord.year, contentVersion: 4, payloadHash: catalogCollisionWrongPayloadHash
    }) || !exactCatalogMedia(companionSource, {
      id: catalogCollisionOldId, mediaType: "tv", title: catalogCollisionCompanionRecord.title,
      year: catalogCollisionCompanionRecord.year, contentVersion: 2, payloadHash: catalogCollisionCompanionPayloadHash
    }) || JSON.stringify(observation.repairedGenres) !== JSON.stringify(catalogCollisionWrongRecord.genreLabels)
      || JSON.stringify(observation.companionGenres) !== JSON.stringify(catalogCollisionCompanionRecord.genreLabels)
      || !exactSearch(repairedSearch, "movie", catalogCollisionWrongRecord.title, catalogCollisionWrongRecord.genreLabels[0]!)
      || !exactSearch(companionSearch, "tv", catalogCollisionCompanionRecord.title, catalogCollisionCompanionRecord.genreLabels[0]!)
      || !exactFts(repairedSearchFts, catalogCollisionWrongRecord.title, catalogCollisionWrongRecord.genreLabels[0]!)
      || !exactFts(companionSearchFts, catalogCollisionCompanionRecord.title, catalogCollisionCompanionRecord.genreLabels[0]!)
      || observation.sharedTmdbRows !== 2 || observation.exactQidRows !== 2 || observation.requiredDerivedRows !== 2
      || observation.stalePosterRows !== 0 || observation.staleProviderEmbeddingRows !== 0) {
      throw new UpgradeValidationError("trusted_catalog_import_failed");
    }
  }
  private assertTrustedCatalogRecovery(port: number) {
    const results = this.searchFor(port, trustedRefreshCatalogQuery, 1).results;
    if (!validateTrustedCatalogRecoverySearchResults(results)) throw new UpgradeValidationError("trusted_catalog_requestable_search_failed");
    const diagnostics = this.json(port, "/api/admin/recommendations/diagnostics?fresh=true", { headers: this.headers() });
    if (!validateTrustedRefreshClearedDiagnostics(diagnostics)) throw new UpgradeValidationError("trusted_refresh_diagnostics_failed");
  }
  private assertCandidateAiPolicy(port: number) {
    const health = this.object(this.json(port, "/api/health"));
    const policies = this.object(health.policies);
    if (policies.aiProvider !== "none" || policies.tmdbContent !== "none") {
      throw new UpgradeValidationError(policies.tmdbContent !== "none" ? "candidate_tmdb_policy_failed" : "candidate_ai_policy_failed");
    }
    const publicConfig = this.object(this.json(port, "/api/config/status"));
    const publicAi = this.object(publicConfig.ai);
    if (publicAi.providerPolicy !== "none" || publicAi.provider !== "none" || publicAi.configured !== false) {
      throw new UpgradeValidationError("candidate_ai_policy_failed");
    }
    const publicSeerr = this.object(publicConfig.seerr);
    if (publicSeerr.tmdbContentPolicy !== "none") throw new UpgradeValidationError("candidate_tmdb_policy_failed");

    const settings = this.object(this.json(port, "/api/admin/settings", { headers: this.headers() }));
    const settingsAi = this.object(settings.ai);
    if (settingsAi.providerPolicy !== "none" || settingsAi.provider !== "none" || settingsAi.openaiApiKeyConfigured !== true) {
      throw new UpgradeValidationError("candidate_ai_policy_failed");
    }
    const settingsSeerr = this.object(settings.seerr);
    if (settingsSeerr.tmdbContentPolicy !== "none") throw new UpgradeValidationError("candidate_tmdb_policy_failed");
    if (!validateCandidateTmdbPolicySurfaces(health, publicConfig, settings)) throw new UpgradeValidationError("candidate_tmdb_policy_failed");

    const rejectedUpdate = this.fetch(port, "/api/admin/settings", {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify({ ai: { provider: "openai", openaiApiKey: this.hostileOpenAiKey } })
    });
    if (rejectedUpdate.status !== 400) throw new UpgradeValidationError("candidate_ai_policy_failed");

    const rejectedWarmup = this.fetch(port, "/api/admin/embeddings/warmup", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ limit: 1 })
    });
    if (rejectedWarmup.status !== 409) throw new UpgradeValidationError("candidate_ai_policy_failed");

    const search = this.object(this.json(port, "/api/search", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ query: "beta candidate", resultLimit: 3, useAi: true, watchContext: "group" })
    }));
    if (search.usedAi !== false || !Array.isArray(search.results) || search.results.length === 0) {
      throw new UpgradeValidationError("candidate_ai_policy_failed");
    }
  }
  private assertSyntheticPoster(port: number) { const response = this.fetchBinary(port, `/api/items/${syntheticPosterId}/poster`); if (!response.ok || response.contentType !== "image/svg+xml; charset=utf-8" || createHash("sha256").update(response.body).digest("hex") !== createHash("sha256").update(syntheticPosterSvg()).digest("hex")) throw new UpgradeValidationError("synthetic_poster_route_failed"); }

  private inspectDatabase(volume: string, expectedSchema: 21 | 31): DatabaseObservation {
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
    let discoveredNetworks: string[] = [];
    try { discoveredNetworks = this.listOwned("network"); } catch { failed = true; }
    const networks = new Set([...this.createdNetworks, ...discoveredNetworks]);
    for (const name of networks) try { this.assertOwnedCleanup("network", name); this.dockerCleanup(["network", "rm", name]); } catch { failed = true; }
    try { if (this.listOwned("container").length || this.listOwned("volume").length || this.listOwned("network").length) failed = true; } catch { failed = true; }
    try { rmSync(this.temporaryDirectory, { recursive: true, force: true }); } catch { failed = true; }
    return failed;
  }
  private listOwned(kind: "container" | "volume" | "network") { const args = ownedResourceListArgs(kind, this.owner);
    return this.dockerCleanup(args).split(/\r?\n/).map((v) => v.trim()).filter(Boolean); }
  private assertOwned(kind: "container" | "volume" | "network", name: string) { const labelPath = kind === "container" ? ".Config.Labels" : ".Labels"; if (this.docker([kind, "inspect", name, "--format", `{{index ${labelPath} "${ownerLabel}"}}`]).trim() !== this.owner) throw new UpgradeValidationError("resource_ownership_uncertain"); }
  private assertOwnedCleanup(kind: "container" | "volume" | "network", name: string) { const labelPath = kind === "container" ? ".Config.Labels" : ".Labels"; if (this.dockerCleanup([kind, "inspect", name, "--format", `{{index ${labelPath} "${ownerLabel}"}}`]).trim() !== this.owner) throw new Error("ownership"); }
  private exists(kind: "container" | "volume" | "network", name: string) { try { this.docker([kind, "inspect", name]); return true; } catch { return false; } }
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
  private dockerReadiness(args: string[]) { this.checkDeadline(); return execFileSync(resolveTrustedHostExecutable("docker"), args, { encoding: "utf8", env: controlledHostEnvironment(), timeout: Math.max(1, Math.min(5_000, this.phaseDeadline - Date.now())), maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"] }); }
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

export function databaseInspectionScriptV2(expectedIds: string[], schema: 21 | 31, recommendationSessionId: string) {
  const modernSchema = schema >= 30;
  const profileAuth = modernSchema ? "auth_user_id" : "NULL AS auth_user_id";
  const externalType = modernSchema ? "e.media_type" : "m.media_type";
  const capabilities = modernSchema ? "u.can_request,u.can_use_ai" : "1 AS can_request,1 AS can_use_ai";
  const sessionAuth = modernSchema ? "s.auth_user_id" : "NULL";
  const posterExtras = modernSchema
    ? "source_key,byte_size,last_accessed_at"
    : "NULL AS source_key,length(body) AS byte_size,fetched_at AS last_accessed_at";
  const capabilityGate = modernSchema
    ? "one(\"SELECT COUNT(*) value FROM app_users WHERE id='synthetic-user' AND can_request=1 AND can_use_ai=1\")===1"
    : "false";
  const externalTypeGate = modernSchema
    ? "one('SELECT COUNT(*) value FROM external_ids e JOIN media_items m ON m.id=e.media_item_id WHERE e.media_type<>m.media_type')===0"
    : "true";
  const plexRefreshIdLookup = modernSchema
    ? "SELECT media_item_id FROM external_ids WHERE source='tmdb' AND media_type='movie' AND value=?"
    : "SELECT media_item_id FROM external_ids WHERE source='tmdb' AND value=?";
  return `
const {DatabaseSync}=require('node:sqlite'),fs=require('node:fs'),crypto=require('node:crypto');
const db=new DatabaseSync('/data/moodarr.sqlite',{readOnly:true});
const one=(q,...params)=>Number(db.prepare(q).get(...params).value),all=q=>[...db.prepare(q).iterate()];
const encode=v=>v instanceof Uint8Array?{$blobSha256:crypto.createHash('sha256').update(v).digest('hex'),$byteLength:v.byteLength}:typeof v==='bigint'?{$bigint:String(v)}:v;
const hashParts=parts=>{const h=crypto.createHash('sha256');for(const [tag,sql,params=[]] of parts){h.update(tag+'\\n');for(const row of db.prepare(sql).iterate(...params))h.update(JSON.stringify(Object.fromEntries(Object.entries(row).map(([k,v])=>[k,encode(v)])))+'\\n')}return h.digest('hex')};
const baselineRecommendationSessionId=${JSON.stringify(recommendationSessionId)};
const legacyId=${JSON.stringify(legacyTmdbBoundaryId)},legacyTitle=${JSON.stringify(legacyTmdbBoundaryTitle)},legacySummary=${JSON.stringify(legacyTmdbBoundarySummary)},legacyTmdbId=${legacyTmdbBoundaryTmdbId};
const legacySessionId=${JSON.stringify(legacyTmdbBoundarySessionId)},requestOperationsTable=${modernSchema};
const refreshId=${JSON.stringify(trustedRefreshId)},refreshLegacyTitle=${JSON.stringify(trustedRefreshLegacyTitle)},refreshLegacySummary=${JSON.stringify(trustedRefreshLegacySummary)};
const refreshCatalogTitle=${JSON.stringify(trustedRefreshCatalogTitle)},refreshCatalogSummary=${JSON.stringify(trustedRefreshCatalogSummary)};
const refreshWikidataId=${JSON.stringify(trustedRefreshWikidataId)},refreshTmdbId=${trustedRefreshTmdbId};
const plexRefreshTmdbId=${plexRefreshTmdbId},plexRefreshTitle=${JSON.stringify(plexRefreshTitle)},plexRefreshSummary=${JSON.stringify(plexRefreshSummary)};
const plexRefreshId=String(db.prepare(${JSON.stringify(plexRefreshIdLookup)}).get(String(plexRefreshTmdbId))?.media_item_id||'');
const logical="CASE WHEN id='group:default' THEN 'group:shared' ELSE id END";
const logicalProfile="CASE WHEN profile_id='group:default' THEN 'group:shared' ELSE profile_id END";
const integrity=all('PRAGMA integrity_check'),fk=all('PRAGMA foreign_key_check'),ids=all('SELECT id FROM schema_migrations ORDER BY id').map(r=>r.id);
let config,configJsonValid=false,configMode0600=false,configOwner999=false,configHash='',configRawHash='';
try{const raw=fs.readFileSync('/data/config.json');config=JSON.parse(raw.toString('utf8'));configJsonValid=!!config&&!Array.isArray(config)&&typeof config==='object';const stat=fs.statSync('/data/config.json');configMode0600=(stat.mode&511)===384;configOwner999=stat.uid===999&&stat.gid===999;const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;configHash=crypto.createHash('sha256').update(JSON.stringify(canonical(config))).digest('hex');configRawHash=crypto.createHash('sha256').update(raw).digest('hex')}catch{}
const poster=db.prepare("SELECT content_type,body,fetched_at,${posterExtras} FROM poster_cache WHERE media_item_id='${syntheticPosterId}'").get(),posterBody=poster?Buffer.from(poster.body):Buffer.alloc(0);
const legacyVersion='legacy-boundary-v1',legacyTitleHash=crypto.createHash('sha256').update(legacyTitle).digest('hex'),legacySummaryHash=crypto.createHash('sha256').update(legacySummary).digest('hex');
const derivedSurfaceRows={
 genres:one('SELECT COUNT(*) value FROM genres WHERE media_item_id=?',legacyId),
 mediaFeatures:one('SELECT COUNT(*) value FROM media_features WHERE media_item_id=?',legacyId),
 mediaEmbeddings:one('SELECT COUNT(*) value FROM media_embeddings WHERE media_item_id=?',legacyId),
 mediaMoodFeatureScores:one('SELECT COUNT(*) value FROM media_mood_feature_scores WHERE media_item_id=?',legacyId),
 mediaContentFingerprints:one('SELECT COUNT(*) value FROM media_content_fingerprints WHERE media_item_id=?',legacyId),
 mediaFeatureFts:one('SELECT COUNT(*) value FROM media_feature_fts WHERE media_item_id=?',legacyId),
 catalogSearchIndex:one('SELECT COUNT(*) value FROM catalog_search_index WHERE media_item_id=?',legacyId),
 catalogSearchIndexFts:one('SELECT COUNT(*) value FROM catalog_search_index_fts WHERE media_item_id=?',legacyId)
};
const legacyDerivedReplicas={
 genres:one('SELECT COUNT(*) value FROM genres WHERE media_item_id=? AND name=?',legacyId,legacyTitle),
 mediaFeatures:one("SELECT COUNT(*) value FROM media_features WHERE media_item_id=? AND (feature_version=? OR instr(COALESCE(feature_text,''),?)>0 OR instr(COALESCE(mood_terms_json,''),?)>0 OR instr(COALESCE(tone_terms_json,''),?)>0 OR instr(COALESCE(watchability_terms_json,''),?)>0)",legacyId,legacyVersion,legacySummary,legacyTitle,legacyTitle,legacyTitle),
 mediaEmbeddings:one("SELECT COUNT(*) value FROM media_embeddings WHERE media_item_id=? AND (provider='legacy' OR model='legacy-boundary' OR feature_version=? OR input_hash=?)",legacyId,legacyVersion,legacySummaryHash),
 mediaMoodFeatureScores:one("SELECT COUNT(*) value FROM media_mood_feature_scores WHERE media_item_id=? AND (source='legacy' OR source_version=? OR feature=?)",legacyId,legacyVersion,legacyTitle),
 mediaContentFingerprints:one("SELECT COUNT(*) value FROM media_content_fingerprints WHERE media_item_id=? AND (schema_version='legacy' OR fingerprint_version=? OR source='legacy' OR source_version=? OR input_hash=? OR instr(COALESCE(fingerprint_json,''),?)>0)",legacyId,legacyVersion,legacyVersion,legacyTitleHash,legacySummary),
 mediaFeatureFts:one("SELECT COUNT(*) value FROM media_feature_fts WHERE media_item_id=? AND (title=? OR instr(COALESCE(feature_text,''),?)>0 OR instr(COALESCE(genres,''),?)>0 OR instr(COALESCE(people,''),?)>0)",legacyId,legacyTitle,legacySummary,legacyTitle,legacyTitle),
 catalogSearchIndex:one("SELECT COUNT(*) value FROM catalog_search_index WHERE media_item_id=? AND (title=? OR year=1987 OR instr(COALESCE(search_text,''),?)>0 OR instr(COALESCE(search_text,''),?)>0 OR instr(COALESCE(mood_text,''),?)>0)",legacyId,legacyTitle,legacyTitle,legacySummary,legacyTitle),
 catalogSearchIndexFts:one("SELECT COUNT(*) value FROM catalog_search_index_fts WHERE media_item_id=? AND (title=? OR instr(COALESCE(search_text,''),?)>0 OR instr(COALESCE(search_text,''),?)>0 OR instr(COALESCE(mood_text,''),?)>0)",legacyId,legacyTitle,legacyTitle,legacySummary,legacyTitle)
};
const strictTmdbBoundary={
 mediaRows:one('SELECT COUNT(*) value FROM media_items WHERE id=?',legacyId),
 legacyDescriptiveRows:one('SELECT COUNT(*) value FROM media_items WHERE id=? AND title=? AND normalized_title=? AND year=1987 AND summary=? AND runtime_minutes=123 AND poster_path=? AND source=?',legacyId,legacyTitle,legacyTitle.toLowerCase(),legacySummary,'tmdb://w500/legacy-boundary-sentinel.jpg','live'),
 sanitizedRows:one('SELECT COUNT(*) value FROM media_items WHERE id=? AND title=? AND normalized_title=? AND year IS NULL AND summary IS NULL AND runtime_minutes IS NULL AND poster_path IS NULL AND source=?',legacyId,'Movie '+legacyTmdbId,'movie '+legacyTmdbId,'operational'),
 factualExternalIdRows:one("SELECT COUNT(*) value FROM external_ids WHERE media_item_id=? AND source='tmdb' AND value=?",legacyId,String(legacyTmdbId)),
 seerrRelationshipRows:one("SELECT COUNT(*) value FROM seerr_items WHERE media_item_id=? AND tmdb_id=? AND imdb_id='tt9876543' AND seerr_media_id=987654 AND media_type='movie' AND status='pending' AND request_status='approved' AND requestable=0",legacyId,legacyTmdbId),
 plexRelationshipRows:one("SELECT COUNT(*) value FROM plex_items WHERE media_item_id=? AND rating_key='legacy-boundary-rating' AND guid='plex://movie/legacy-boundary' AND available=1",legacyId),
 requestRows:one("SELECT COUNT(*) value FROM requests WHERE media_item_id=? AND media_type='movie' AND media_id=? AND status='approved' AND external_request_id='legacy-boundary-request'",legacyId,legacyTmdbId),
 requestAuditRows:one("SELECT COUNT(*) value FROM request_audit WHERE media_item_id=? AND action='create' AND status='created' AND media_type='movie' AND media_id=? AND external_request_id='legacy-boundary-request' AND auth_user_id='synthetic-user'",legacyId,legacyTmdbId),
 requestAuditDescriptiveRows:one('SELECT COUNT(*) value FROM request_audit WHERE media_item_id=? AND title=?',legacyId,legacyTitle),
 derivedRows:Object.values(derivedSurfaceRows).reduce((sum,value)=>sum+value,0),derivedSurfaceRows,legacyDerivedReplicas,
 posterRows:one('SELECT COUNT(*) value FROM poster_cache WHERE media_item_id=?',legacyId),
 reviewQueueRows:one('SELECT COUNT(*) value FROM query_review_queue WHERE session_id=?',legacySessionId),
 reviewQueueDescriptiveRows:one("SELECT COUNT(*) value FROM query_review_queue WHERE session_id=? AND result_count=1 AND instr(results_json,?)>0",legacySessionId,legacyTitle),
 requestOperationsTable,
 requestOperationRows:requestOperationsTable?one('SELECT COUNT(*) value FROM request_creation_operations WHERE media_item_id=?',legacyId):0,
 requestOperationDescriptiveRows:requestOperationsTable?one("SELECT COUNT(*) value FROM request_creation_operations WHERE media_item_id=? AND instr(COALESCE(response_json,''),?)>0",legacyId,legacyTitle):0
};
const trustedRefresh={
 mediaRows:one('SELECT COUNT(*) value FROM media_items WHERE id=?',refreshId),
 legacyDescriptiveRows:one('SELECT COUNT(*) value FROM media_items WHERE id=? AND title=? AND normalized_title=? AND year=1993 AND summary=? AND runtime_minutes=111 AND source=?',refreshId,refreshLegacyTitle,refreshLegacyTitle.toLowerCase(),refreshLegacySummary,'live'),
 sanitizedOperationalRows:one('SELECT COUNT(*) value FROM media_items WHERE id=? AND title=? AND normalized_title=? AND year IS NULL AND summary IS NULL AND runtime_minutes IS NULL AND source=?',refreshId,'Movie '+refreshTmdbId,'movie '+refreshTmdbId,'operational'),
 rehydratedCatalogRows:one('SELECT COUNT(*) value FROM media_items WHERE id=? AND title=? AND normalized_title=? AND year=1994 AND summary=? AND runtime_minutes IS NULL AND source=?',refreshId,refreshCatalogTitle,refreshCatalogTitle.toLowerCase(),refreshCatalogSummary,'catalog'),
 activeCatalogRelationships:one("SELECT COUNT(*) value FROM catalog_source_records WHERE media_item_id=? AND source='wikidata' AND source_item_id=? AND active=1",refreshId,refreshWikidataId),
 trustedCatalogProvenanceRows:one("SELECT COUNT(*) value FROM catalog_source_records WHERE media_item_id=? AND source='wikidata' AND source_version=? AND last_seen_source_version=? AND source_item_id=? AND payload_hash=? AND content_hash=? AND content_version=1 AND active=1",refreshId,${JSON.stringify(trustedRefreshCatalogVersion)},${JSON.stringify(trustedRefreshCatalogVersion)},refreshWikidataId,${JSON.stringify(trustedRefreshCatalogPayloadHash)},${JSON.stringify(trustedRefreshCatalogPayloadHash)}),
 staleCatalogRelationships:requestOperationsTable?one("SELECT COUNT(*) value FROM catalog_source_records WHERE media_item_id=? AND source='wikidata' AND source_item_id=? AND active=1 AND materialization_stale=1",refreshId,refreshWikidataId):0,
 requestableSeerrRelationships:one("SELECT COUNT(*) value FROM seerr_items WHERE media_item_id=? AND tmdb_id=? AND media_type='movie' AND requestable=1",refreshId,refreshTmdbId),
 refreshRequiredRows:requestOperationsTable?one("SELECT COUNT(*) value FROM media_items m JOIN catalog_source_records r ON r.media_item_id=m.id AND r.active=1 AND r.materialization_stale=1 JOIN seerr_items s ON s.media_item_id=m.id AND s.requestable=1 WHERE m.id=? AND m.source='operational'",refreshId):0,
 legacyDerivedReplicaRows:
  one('SELECT COUNT(*) value FROM genres WHERE media_item_id=? AND name=?',refreshId,refreshLegacyTitle)
  +one("SELECT COUNT(*) value FROM catalog_search_index WHERE media_item_id=? AND (title=? OR year=1993 OR instr(COALESCE(search_text,''),?)>0 OR instr(COALESCE(search_text,''),?)>0 OR instr(COALESCE(mood_text,''),?)>0)",refreshId,refreshLegacyTitle,refreshLegacyTitle,refreshLegacySummary,refreshLegacyTitle)
  +one("SELECT COUNT(*) value FROM catalog_search_index_fts WHERE media_item_id=? AND (title=? OR instr(COALESCE(search_text,''),?)>0 OR instr(COALESCE(search_text,''),?)>0 OR instr(COALESCE(mood_text,''),?)>0)",refreshId,refreshLegacyTitle,refreshLegacyTitle,refreshLegacySummary,refreshLegacyTitle),
 catalogSearchIndexRows:one('SELECT COUNT(*) value FROM catalog_search_index WHERE media_item_id=?',refreshId),
 catalogSearchIndexFtsRows:one('SELECT COUNT(*) value FROM catalog_search_index_fts WHERE media_item_id=?',refreshId)
};
const plexRefresh={
 mediaRows:one('SELECT COUNT(*) value FROM media_items WHERE id=?',plexRefreshId),
 descriptiveLiveRows:one('SELECT COUNT(*) value FROM media_items WHERE id=? AND title=? AND normalized_title=? AND year=2023 AND summary=? AND runtime_minutes=100 AND source=?',plexRefreshId,plexRefreshTitle,plexRefreshTitle.toLowerCase(),plexRefreshSummary,'live'),
 sanitizedOperationalRows:one('SELECT COUNT(*) value FROM media_items WHERE id=? AND title=? AND normalized_title=? AND year IS NULL AND summary IS NULL AND runtime_minutes IS NULL AND source=?',plexRefreshId,'Movie '+plexRefreshTmdbId,'movie '+plexRefreshTmdbId,'operational'),
 plexRelationshipRows:one("SELECT COUNT(*) value FROM plex_items WHERE media_item_id=? AND rating_key='1002' AND guid='plex://movie/candidate-lantern' AND available=1",plexRefreshId),
 seerrRelationshipRows:one("SELECT COUNT(*) value FROM seerr_items WHERE media_item_id=? AND tmdb_id=? AND seerr_media_id=8001 AND media_type='movie' AND status='pending' AND request_status='approved' AND requestable=0",plexRefreshId,plexRefreshTmdbId),
 refreshRequiredRows:one("SELECT COUNT(*) value FROM media_items m JOIN plex_items p ON p.media_item_id=m.id AND p.available=1 WHERE m.id=? AND m.source='operational'",plexRefreshId),
 genreRows:one('SELECT COUNT(*) value FROM genres WHERE media_item_id=?',plexRefreshId),
 mediaFeatureRows:one('SELECT COUNT(*) value FROM media_features WHERE media_item_id=?',plexRefreshId),
 catalogSearchIndexRows:one('SELECT COUNT(*) value FROM catalog_search_index WHERE media_item_id=?',plexRefreshId),
 catalogSearchIndexFtsRows:one('SELECT COUNT(*) value FROM catalog_search_index_fts WHERE media_item_id=?',plexRefreshId)
};
const legacyBoundaryParts=[
 ['media','SELECT * FROM media_items WHERE id=?',[legacyId]],['external','SELECT * FROM external_ids WHERE media_item_id=? ORDER BY source,value',[legacyId]],
 ['plex','SELECT * FROM plex_items WHERE media_item_id=?',[legacyId]],['seerr','SELECT * FROM seerr_items WHERE media_item_id=?',[legacyId]],
 ['requests','SELECT * FROM requests WHERE media_item_id=?',[legacyId]],['audits','SELECT * FROM request_audit WHERE media_item_id=?',[legacyId]],
 ...['genres','media_features','media_embeddings','media_mood_feature_scores','media_content_fingerprints','media_feature_fts','catalog_search_index','catalog_search_index_fts','poster_cache'].map(table=>[table,'SELECT * FROM '+table+' WHERE media_item_id=?',[legacyId]]),
 ['review','SELECT * FROM query_review_queue WHERE session_id=?',[legacySessionId]],
 ...(requestOperationsTable?[['request-operations','SELECT * FROM request_creation_operations WHERE media_item_id=?',[legacyId]]]:[])
];
const result={
 schemaVersion:Number(db.prepare('PRAGMA user_version').get().user_version),integrity:integrity.length===1?String(integrity[0].integrity_check):'failed',integrityOk:integrity.length===1&&integrity[0].integrity_check==='ok',foreignKeysOk:fk.length===0,
 migrationCount:ids.length,migrationIdsExact:JSON.stringify(ids)===JSON.stringify(${JSON.stringify(expectedIds)}),
 totalItems:one('SELECT COUNT(*) value FROM media_items'),plexItems:one('SELECT COUNT(*) value FROM plex_items WHERE available=1'),seerrItems:one('SELECT COUNT(*) value FROM seerr_items'),externalIds:one('SELECT COUNT(*) value FROM external_ids'),externalMediaTypesValid:${externalTypeGate},
 requestAudits:one('SELECT COUNT(*) value FROM request_audit'),attributedRequestAudits:one('SELECT COUNT(*) value FROM request_audit WHERE auth_user_id IS NOT NULL'),feedbackEvents:one('SELECT COUNT(*) value FROM feel_feedback_events'),profileTerms:one('SELECT COUNT(*) value FROM feel_profile_terms'),profileCheckpoints:one('SELECT COUNT(*) value FROM feel_profile_checkpoints'),
 groupDefaultProfiles:one("SELECT COUNT(*) value FROM preference_profiles WHERE id='group:default'"),groupSharedProfiles:one("SELECT COUNT(*) value FROM preference_profiles WHERE id='group:shared'"),groupDefaultRecommendationSessions:one("SELECT COUNT(*) value FROM recommendation_sessions WHERE profile_id='group:default'"),groupSharedRecommendationSessions:one("SELECT COUNT(*) value FROM recommendation_sessions WHERE profile_id='group:shared'"),appUsers:one('SELECT COUNT(*) value FROM app_users'),userSessions:one('SELECT COUNT(*) value FROM user_sessions'),syntheticUserCapabilities:${capabilityGate},
 posterRows:one('SELECT COUNT(*) value FROM poster_cache'),posterSvgRows:one("SELECT COUNT(*) value FROM poster_cache WHERE content_type LIKE 'image/svg+xml%'"),posterPngJpegRows:one("SELECT COUNT(*) value FROM poster_cache WHERE content_type LIKE 'image/png%' OR content_type LIKE 'image/jpeg%'"),
 posterByteSizeBackfilled:!!poster&&poster.byte_size===posterBody.length&&posterBody.length>0,posterLastAccessBackfilled:!!poster&&poster.last_accessed_at===poster.fetched_at,
 strictTmdbBoundary,trustedRefresh,plexRefresh,configJsonValid,configMode0600,configOwner999,
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
  requestAuditFacts:hashParts([['request-audit-facts','SELECT id,media_item_id,action,status,media_type,media_id,seasons_json,blocked_reason,external_request_id,created_at,auth_user_id FROM request_audit ORDER BY id']]),
  requests:hashParts([['requests','SELECT id,media_item_id,media_type,media_id,seasons_json,status,external_request_id,created_at FROM requests ORDER BY id']]),
  mediaExternalIds:hashParts([['media-external',\`SELECT m.id,m.media_type,m.title,m.normalized_title,m.year,m.summary,m.runtime_minutes,m.content_rating,m.poster_path,m.critic_rating,m.audience_rating,m.user_rating,m.created_at,m.updated_at,m.source,e.source AS external_source,e.value AS external_value,${externalType} AS external_media_type FROM media_items m LEFT JOIN external_ids e ON e.media_item_id=m.id WHERE m.id NOT IN (?,?) ORDER BY m.id,e.source,e.value\`,[${JSON.stringify(catalogCollisionOldId)},${JSON.stringify(catalogCollisionTargetId)}]]]),
  mediaIdentityFacts:hashParts([['media-identity-facts',\`SELECT m.id,m.media_type,m.created_at,e.source AS external_source,e.value AS external_value,${externalType} AS external_media_type FROM media_items m LEFT JOIN external_ids e ON e.media_item_id=m.id WHERE m.id NOT IN (?,?) ORDER BY m.id,e.source,e.value\`,[${JSON.stringify(catalogCollisionOldId)},${JSON.stringify(catalogCollisionTargetId)}]]]),
  catalogRelationships:hashParts([
   ['plex-items','SELECT id,media_item_id,rating_key,guid,library_title,library_type,available FROM plex_items ORDER BY id'],
   ['seerr-items','SELECT id,media_item_id,tmdb_id,tvdb_id,imdb_id,seerr_media_id,media_type,status,request_status,requestable FROM seerr_items ORDER BY id']
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
  poster:hashParts([['posters',\`SELECT media_item_id,content_type,body,fetched_at,${posterExtras} FROM poster_cache WHERE media_item_id NOT IN (?,?) ORDER BY media_item_id\`,[${JSON.stringify(catalogCollisionOldId)},${JSON.stringify(catalogCollisionTargetId)}]]]),
  posterSafe:hashParts([['safe-poster',\`SELECT media_item_id,content_type,body,fetched_at,${posterExtras} FROM poster_cache WHERE media_item_id='${syntheticPosterId}'\`]]),
  posterBody:crypto.createHash('sha256').update(posterBody).digest('hex'),
  legacyBoundary:hashParts(legacyBoundaryParts),
  legacyBoundaryFacts:hashParts([
   ['media-facts','SELECT id,media_type,created_at FROM media_items WHERE id=?',[legacyId]],
   ['external-facts',\`SELECT e.media_item_id,e.source,e.value,${externalType} AS media_type FROM external_ids e JOIN media_items m ON m.id=e.media_item_id WHERE e.media_item_id=? ORDER BY e.source,e.value\`,[legacyId]],
   ['plex-facts','SELECT id,media_item_id,rating_key,guid,library_title,library_type,plex_url,available,last_seen_at FROM plex_items WHERE media_item_id=?',[legacyId]],
   ['seerr-facts','SELECT id,media_item_id,tmdb_id,tvdb_id,imdb_id,seerr_media_id,media_type,status,request_status,requestable,seerr_url,last_seen_at FROM seerr_items WHERE media_item_id=?',[legacyId]],
   ['request-facts','SELECT id,media_item_id,media_type,media_id,seasons_json,status,external_request_id,created_at FROM requests WHERE media_item_id=?',[legacyId]],
   ['audit-facts','SELECT id,media_item_id,action,status,media_type,media_id,seasons_json,blocked_reason,external_request_id,created_at,auth_user_id FROM request_audit WHERE media_item_id=?',[legacyId]],
   ['recommendation-relation','SELECT session_id,media_item_id,rank,score,availability_group FROM recommendation_results WHERE session_id=?',[legacySessionId]]
  ]),
  queryReview:hashParts([['query-review','SELECT id,session_id,query_text,optimized_query,watch_context,result_count,results_json,mood_fit_rating,mood_feedback_text,reviewed_at,created_at,updated_at FROM query_review_queue WHERE session_id=?',[legacySessionId]]])
 }};
console.log(JSON.stringify(result));db.close();`;
}

export function resolveAmd64ManifestDigest(raw: string, image: string) { const digest = image.split("@")[1]; const manifest = JSON.parse(raw) as JsonObject; if (Array.isArray(manifest.manifests)) { const selected = manifest.manifests.find((entry: JsonObject) => entry.platform?.os === "linux" && entry.platform?.architecture === "amd64"); if (!selected?.digest) throw new UpgradeValidationError("amd64_manifest_missing"); return String(selected.digest); } if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) throw new UpgradeValidationError("manifest_digest_missing"); return digest; }
export function currentSourceSnapshot(): SourceSnapshot { const gitExecutable = resolveTrustedHostExecutable("git"); const git = (args: string[]) => execFileSync(gitExecutable, args, { encoding: "utf8", env: controlledHostEnvironment(), timeout: 10_000, maxBuffer: 2 * 1024 * 1024 }).trim(); const scriptPath = "scripts/validate-beta-upgrade.ts", headRevision = git(["rev-parse", "HEAD"]); let scriptMatchesHead = false; try { scriptMatchesHead = readFileSync(scriptPath).equals(execFileSync(gitExecutable, ["show", `HEAD:${scriptPath}`], { env: controlledHostEnvironment(), timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] })); } catch { scriptMatchesHead = false; } const packageVersion = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version; return { headRevision, dirty: Boolean(git(["status", "--porcelain"])), scriptMatchesHead, packageVersion }; }
export function runBetaUpgradeValidation(options: UpgradeOptions) { return new Harness(options).run(); }

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) { try { const report = runBetaUpgradeValidation(parseUpgradeArgs(process.argv.slice(2))); if (findForbiddenPublicEvidence(report).length) throw new UpgradeValidationError("public_report_safety_failure"); process.stdout.write(`${JSON.stringify(report, null, 2)}\n`); if (report.status !== "passed") process.exitCode = 1; } catch (error) { const code = error instanceof UpgradeValidationError ? error.code : "unexpected_failure"; process.stdout.write(`${JSON.stringify({ schema: "moodarr-beta-upgrade-validation-v1", status: "failed", releaseEligible: false, failures: [code] })}\n`); process.exitCode = 1; } }
