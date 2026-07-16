import crypto, { randomUUID } from "node:crypto";
import type {
  AvailabilityGroup,
  FeelFeedbackAction,
  FeelFeedbackReliability,
  FeelFeedbackRequest,
  FeelFeedbackResponse,
  FeelFeedbackSource,
  FeelProfileExportResponse,
  FeelProfileResponse,
  FeelProfileRollbackResponse,
  FeelProfileResetResponse,
  FeelProfileTermSummary,
  ItemDetail,
  ItemSummary,
  MediaSource,
  MediaType,
  QueryReviewQueueItem,
  QueryReviewResultSnapshot,
  QueryReviewStatus,
  QueryReviewUpdate,
  RatingSet,
  ProfileReplayEvaluationResponse,
  RecommendationDiagnostics,
  RecommendationReplaySlate,
  ReplayCompactionSummary,
  ReplayRetentionPolicy,
  RequestAuditDiagnostics,
  SearchFilters,
  SeerrStatus,
  SyncRunSummary,
  WatchContext
} from "../../shared/types";
import { FEATURE_VERSION, buildMediaFeatureDocument, parseFeatureVector, vectorToJson, type MediaFeatureDocument } from "../recommendation/features";
import {
  CONTENT_FINGERPRINT_MOOD_SCORE_SOURCE,
  CONTENT_FINGERPRINT_MOOD_SCORE_VERSION,
  CONTENT_FINGERPRINT_VERSION,
  buildContentFingerprint,
  contentFingerprintMoodFeatureScores,
  fingerprintToJson,
  parseContentFingerprint,
  type ContentFingerprintV1
} from "../recommendation/contentFingerprint";
import {
  deterministicMoodFeatureScores,
  moodFeatureScoreFromAggregate,
  normalizeMoodFeatureKey,
  type MoodFeatureScoreInput
} from "../recommendation/moodFeatureIndex";
import { recommendationEngineVersion } from "../recommendation/version";
import { buildFeelProfileAdjustment, itemProfileFeatureKeys, scoreFeelProfileFit, type FeelProfile } from "../recommendation/feelProfile";
import { summarizeCatalogMetadataRows, type CatalogMetadataSourceRow } from "../recommendation/catalogMetadata";
import { normalizePlexWebUrl, plexAppUrlFromWebUrl } from "../integrations/plexLinks";
import type { SqliteDatabase } from "./database";
import type { RecommendationRunTraceRecord } from "../recommendation/tracing";
import { safeErrorMessage } from "../security/redact";
import { deriveRequestAttemptPolicy } from "../requests/requestAttemptPolicy";

const recommendationCandidateLimit = 3000;
const catalogDerivedRefreshBatchSize = 500;
const mediaIdentityConflictReason = "external_identity_conflict";
const maxNormalizedTraceProvenanceRows = 200;
const maxNormalizedTraceRejectionRows = 50;
const posterCacheMaxRows = 5_000;
const posterCacheMaxBytes = 512 * 1024 * 1024;
const posterCacheMaxAgeDays = 180;
const trustedCatalogRepairTargetExternalIdSources = new Set(["wikidata", "tmdb", "imdb", "tvdb"]);
const posterCacheExpiredSql = `julianday(fetched_at) IS NULL
  OR julianday(fetched_at) > julianday('now')
  OR julianday(fetched_at) <= julianday('now', '-${posterCacheMaxAgeDays} days')`;

export interface IngestMediaRecord {
  source?: MediaSource;
  mediaType: MediaType;
  title: string;
  year?: number;
  summary?: string;
  runtimeMinutes?: number;
  contentRating?: string;
  posterPath?: string;
  ratings?: RatingSet;
  genres?: string[];
  cast?: string[];
  directors?: string[];
  externalIds?: Record<string, string | number | undefined>;
  plex?: {
    ratingKey?: string;
    guid?: string;
    libraryTitle?: string;
    libraryType?: string;
    url?: string;
    available?: boolean;
  };
  seerr?: {
    tmdbId?: number;
    tvdbId?: number;
    imdbId?: string;
    seerrMediaId?: number;
    status: SeerrStatus;
    requestStatus?: string;
    requestable: boolean;
    url?: string;
  };
}

export interface IntegrationUpsertResult {
  mediaItemIds: string[];
  identityConflictCount: number;
}

export type RequestCreationAcquisitionResult =
  | "acquired"
  | "active-operation"
  | "existing-operation"
  | "stale-generation";

export class MediaIdentityConflictError extends Error {
  readonly statusCode = 409;
  readonly matchedMediaItemIds: readonly string[];

  constructor(matchedMediaItemIds: Iterable<string>) {
    super("Media identifiers resolve to multiple existing items.");
    this.name = "MediaIdentityConflictError";
    this.matchedMediaItemIds = Object.freeze(unique([...matchedMediaItemIds]).sort());
  }
}

interface MediaRow {
  id: string;
  media_type: MediaType;
  title: string;
  normalized_title: string;
  year?: number;
  summary?: string;
  runtime_minutes?: number;
  content_rating?: string;
  poster_path?: string;
  critic_rating?: number;
  audience_rating?: number;
  user_rating?: number;
  source: MediaSource;
}

interface PlexRow {
  available: number;
  plex_url?: string;
  library_title?: string;
}

interface SeerrRow {
  status: SeerrStatus;
  request_status?: string;
  requestable: number;
  seerr_url?: string;
  tmdb_id?: number;
}

interface QueryReviewQueueRow {
  id: string;
  session_id: string;
  query_text: string;
  optimized_query?: string | null;
  watch_context: WatchContext;
  result_count: number;
  results_json: string;
  mood_fit_rating?: number | null;
  mood_feedback_text?: string | null;
  reviewed_at?: string | null;
  created_at: string;
}

interface FeelFeedbackEventRow {
  id: number;
  action: FeelFeedbackAction;
  reliability: FeelFeedbackReliability;
  source: FeelFeedbackSource;
  watch_context: WatchContext;
  media_item_id?: string | null;
  compared_media_item_id?: string | null;
  mood_term?: string | null;
  reason?: string | null;
  profile_version: number;
  profile_update_applied: number;
  profile_holdout: number;
  created_at: string;
}

interface FeelFeedbackResponseRow {
  id: number;
  reliability: FeelFeedbackReliability;
  profile_version: number;
  profile_update_applied: number;
  profile_holdout: number;
}

interface FeelProfileTermRow {
  profile_id: string;
  watch_context: WatchContext;
  term: string;
  feature_weights_json: string;
  confidence: number;
  evidence_count: number;
  positive_count: number;
  negative_count: number;
  positive_weight: number;
  negative_weight: number;
  effective_evidence: number;
  conflict_score: number;
  version: number;
  updated_at: string;
}

interface FeelProfileCheckpointRow extends FeelProfileTermRow {
  event_id?: number | null;
  created_at: string;
}

export interface FeatureSearchHit {
  mediaItemId: string;
  rank: number;
}

export interface StoredMediaFeature {
  mediaItemId: string;
  featureText: string;
  moodTerms: string[];
  toneTerms: string[];
  watchabilityTerms: string[];
  vector: Record<string, number>;
  featureVersion: string;
}

export interface ContentFingerprintRebuildSummary {
  scanned: number;
  rebuilt: number;
  unchanged: number;
  fingerprintVersion: string;
}

export type { MoodFeatureScoreInput };

export interface MoodFeatureHit {
  mediaItemId: string;
  score: number;
  matchedFeatures: string[];
}

export interface MoodFeatureSourceSummary {
  source: string;
  sourceVersion: string;
  itemCount: number;
  scoreCount: number;
  updatedAt?: string;
}

export interface CatalogIngestRecord {
  source: string;
  sourceVersion: string;
  sourceItemId: string;
  sourceUrl?: string;
  licensePolicy: string;
  fetchedAt?: string;
  expiresAt?: string;
  payloadHash?: string;
  metadata?: Record<string, string | number | boolean | null | string[] | number[] | undefined>;
  media: Omit<IngestMediaRecord, "source" | "plex" | "seerr">;
  mainstreamScore?: number;
  metadataConfidence?: number;
  sitelinkCount?: number;
  externalIdCount?: number;
  awardCount?: number;
}

export interface CatalogUpsertResult {
  mediaItemIds: string[];
  inserted: number;
  changed: number;
  unchanged: number;
}

interface CatalogUpsertOptions {
  trustedRehydrateTypeRepairs?: ReadonlyMap<string, TrustedCatalogTypeRepairPlan>;
  trustedRehydrateRematerializations?: ReadonlySet<string>;
}

export interface CatalogExternalId {
  source: string;
  value: string;
}

function catalogExternalIdsEqual(left: readonly CatalogExternalId[], right: readonly CatalogExternalId[]) {
  if (left.length !== right.length) return false;
  return left.every((externalId, index) =>
    externalId.source === right[index]?.source && externalId.value === right[index]?.value
  );
}

export interface TrustedCatalogTypeRepairPlan {
  sourceItemId: string;
  expectedOldMediaItemId: string;
  expectedOldMediaType: MediaType;
  expectedOldSourceVersion: string;
  expectedOldLastSeenSourceVersion: string;
  expectedOldPayloadHash?: string;
  expectedContentHash: string;
  targetMediaItemId: string;
  targetMediaType: MediaType;
  targetAction: "existing" | "create";
  expectedTargetMediaSource?: MediaSource;
  expectedTargetExternalIds: readonly CatalogExternalId[];
  externalIdCleanup: readonly CatalogExternalId[];
}

export interface ActiveCatalogSourceTypeBinding {
  mediaItemId: string;
  mediaType: MediaType;
  mediaSource: MediaSource;
  sourceVersion: string;
  lastSeenSourceVersion: string;
  payloadHash?: string;
  contentHash?: string;
  sourceIdentityExternalIdBound: boolean;
}

export interface CatalogSourceSummary {
  source: string;
  sourceVersion: string;
  itemCount: number;
  activeItemCount?: number;
  inactiveItemCount?: number;
  averageMainstreamScore?: number;
  averageMetadataConfidence?: number;
  updatedAt?: string;
}

export interface CatalogSyncSummary {
  itemCount: number;
  mediaItemsUpserted: number;
  sourceRecordsUpserted: number;
  updateMode?: "incremental" | "full_snapshot";
  unchangedSourceRecords?: number;
  changedSourceRecords?: number;
  inactiveSourceRecords?: number;
}

export interface ProviderEmbeddingInput {
  mediaItemId: string;
  featureText: string;
  featureVersion: string;
  inputHash: string;
}

export interface StoredProviderEmbedding {
  mediaItemId: string;
  provider: string;
  model: string;
  dimensions: number;
  vector: number[];
  updatedAt: string;
}

export interface RecommendationRunRecord {
  query: string;
  optimizedQuery?: string;
  engineVersion: string;
  model?: string;
  watchContext: WatchContext;
  authUserId?: string;
  resultCount: number;
  candidateCount: number;
  rerankCandidateCount: number;
  usedAi: boolean;
  seerrAugmented: boolean;
  latencyMs: number;
  results: ItemSummary[];
  feedback?: {
    moreLikeItemIds?: string[];
    preferredExampleItemIds?: string[];
    maybeItemIds?: string[];
    lessLikeItemIds?: string[];
    hiddenItemIds?: string[];
  };
  reviewQueue?: QueryReviewRetention;
  trace?: RecommendationRunTraceRecord;
}

export interface QueryReviewRetention {
  retentionDays: number;
  maxQueries: number;
  captureRawQueries?: boolean;
}

export interface PosterCacheRecord {
  contentType: string;
  body: Buffer;
}

export interface RequestAuditRecord {
  mediaItemId?: string;
  authUserId?: string;
  action: "preview" | "create";
  status: "allowed" | "blocked" | "created" | "failed";
  mediaType?: MediaType;
  mediaId?: number;
  title?: string;
  seasons?: number[];
  blockedReason?: string;
  externalRequestId?: string;
}

export interface RequestCreationOperation {
  idempotencyKey?: string;
  requestFingerprint: string;
  status: "pending" | "created" | "failed" | "uncertain";
  response?: Record<string, unknown>;
  error?: string;
  updatedAt: string;
}

const positiveFeelActions = new Set<FeelFeedbackAction>(["swipe_right", "save", "more_like", "right_mood", "request_create"]);
const negativeFeelActions = new Set<FeelFeedbackAction>(["swipe_left", "less_like", "wrong_mood"]);
const profileLearningActions = new Set<FeelFeedbackAction>([
  "swipe_right",
  "swipe_left",
  "save",
  "hide",
  "more_like",
  "less_like",
  "right_mood",
  "wrong_mood",
  "pairwise_pick"
]);
const maxProfileUpdatesPerSessionTerm = 3;
const defaultReplayRetentionPolicy: ReplayRetentionPolicy = {
  retentionDays: 180,
  maxSessions: 1000,
  maxFeedbackEvents: 5000,
  maxCheckpointsPerTerm: 120
};
const maxAutomaticFeatureBackfillItems = 5_000;

export interface MediaRepositoryOptions {
  runStartupRepairs?: boolean;
}

export class MediaRepository {
  constructor(private readonly db: SqliteDatabase, options: MediaRepositoryOptions = {}) {
    this.db.function(
      "moodarr_sha256",
      { deterministic: true, directOnly: true },
      (value) => (typeof value === "string" ? hashText(value) : null)
    );
    if (options.runStartupRepairs !== false) {
      this.backfillFeatures();
      this.backfillMoodFeatureScores();
      this.backfillContentFingerprints();
      this.backfillContentFingerprintMoodFeatureScores();
      this.repairCatalogSearchIndexes();
    }
  }

  upsertMany(records: IngestMediaRecord[]) {
    const ids: string[] = [];
    this.db.exec("BEGIN");
    try {
      for (const record of records) {
        ids.push(this.upsert(record));
      }
      this.db.exec("COMMIT");
      return ids;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsertIntegrationRecords(records: IngestMediaRecord[]): IntegrationUpsertResult {
    const mediaItemIds: string[] = [];
    let identityConflictCount = 0;
    this.db.exec("BEGIN");
    try {
      for (const record of records) {
        this.db.exec("SAVEPOINT integration_record_upsert");
        try {
          mediaItemIds.push(this.upsert(record));
          this.db.exec("RELEASE SAVEPOINT integration_record_upsert");
        } catch (error) {
          this.db.exec("ROLLBACK TO SAVEPOINT integration_record_upsert");
          this.db.exec("RELEASE SAVEPOINT integration_record_upsert");
          if (!(error instanceof MediaIdentityConflictError)) throw error;
          this.quarantineMediaIdentityConflict(error.matchedMediaItemIds);
          identityConflictCount += 1;
        }
      }
      this.db.exec("COMMIT");
      return { mediaItemIds, identityConflictCount };
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  clearStaleMediaIdentityQuarantine(fullSyncStartedAt: string) {
    const cutoffMs = Date.parse(fullSyncStartedAt);
    if (!Number.isFinite(cutoffMs)) {
      throw new Error("Full-sync start must be a valid timestamp.");
    }
    const cutoff = new Date(cutoffMs).toISOString();
    const refreshedAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const affected = this.db
        .prepare(
          `SELECT media_item_id
           FROM media_identity_quarantine
           WHERE julianday(last_seen_at) < julianday(?)
           ORDER BY media_item_id`
        )
        .all(cutoff) as Array<{ media_item_id: string }>;
      const deleted = this.db
        .prepare("DELETE FROM media_identity_quarantine WHERE julianday(last_seen_at) < julianday(?)")
        .run(cutoff);
      if (Number(deleted.changes) !== affected.length) {
        throw new Error("Identity quarantine changed during atomic revalidation.");
      }
      for (const row of affected) {
        this.upsertCatalogSearchIndex(row.media_item_id, refreshedAt);
      }
      this.db.exec("COMMIT");
      return affected.length;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the original revalidation failure if SQLite has already ended the transaction.
      }
      throw error;
    }
  }

  upsertCatalogRecords(records: CatalogIngestRecord[]) {
    return this.upsertCatalogRecordsWithStats(records).mediaItemIds;
  }

  async withCatalogSnapshotTransaction<T>(operation: () => Promise<T>): Promise<T> {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = await operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Preserve the import failure if SQLite has already ended the transaction.
      }
      throw error;
    }
  }

  upsertCatalogRecordsWithStats(records: CatalogIngestRecord[], options: CatalogUpsertOptions = {}): CatalogUpsertResult {
    const ids: string[] = [];
    const derivedRefreshIds: string[] = [];
    const derivedResetIds = new Set<string>();
    let inserted = 0;
    let changed = 0;
    let unchanged = 0;
    this.db.exec("SAVEPOINT catalog_upsert_batch");
    try {
      for (const record of records) {
        const result = this.upsertCatalogRecordWithStatus(record, true, options);
        ids.push(result.mediaItemId);
        if (result.status === "inserted") {
          inserted += 1;
          derivedRefreshIds.push(result.mediaItemId);
        } else if (result.status === "changed") {
          changed += 1;
          derivedRefreshIds.push(result.mediaItemId);
        }
        else unchanged += 1;
        if (result.previousMediaItemId) derivedRefreshIds.push(result.previousMediaItemId);
        if (
          options.trustedRehydrateRematerializations?.has(record.sourceItemId)
          && this.mediaSource(result.mediaItemId) === "catalog"
        ) {
          derivedResetIds.add(result.mediaItemId);
        }
      }
      this.refreshCatalogDerivedItems(derivedRefreshIds, derivedResetIds);
      this.db.exec("RELEASE SAVEPOINT catalog_upsert_batch");
      return { mediaItemIds: ids, inserted, changed, unchanged };
    } catch (error) {
      try {
        this.db.exec("ROLLBACK TO SAVEPOINT catalog_upsert_batch");
        this.db.exec("RELEASE SAVEPOINT catalog_upsert_batch");
      } catch {
        // Preserve the write failure if SQLite has already ended the savepoint.
      }
      throw error;
    }
  }

  upsertCatalogRecord(record: CatalogIngestRecord): string {
    return this.upsertCatalogRecordWithStatus(record).mediaItemId;
  }

  private upsertCatalogRecordWithStatus(
    record: CatalogIngestRecord,
    deferDerivedRefresh = false,
    options: CatalogUpsertOptions = {}
  ): { mediaItemId: string; status: "inserted" | "changed" | "unchanged"; previousMediaItemId?: string } {
    const source = normalizeCatalogSource(record.source);
    const sourceVersion = cleanRequiredText(record.sourceVersion, 120, "Catalog source version");
    const sourceItemId = cleanRequiredText(record.sourceItemId, 180, "Catalog source item ID");
    const licensePolicy = cleanRequiredText(record.licensePolicy, 120, "Catalog license policy");
    const now = new Date().toISOString();
    const payloadHash = cleanOptionalText(record.payloadHash, 160);
    const contentHash = payloadHash;
    const existing = this.db
      .prepare(
        `SELECT r.media_item_id, r.source_version, r.last_seen_source_version, r.content_hash, r.payload_hash,
          r.content_version, r.active, r.materialization_stale,
          m.source AS media_source, m.media_type
         FROM catalog_source_records r
         LEFT JOIN media_items m ON m.id = r.media_item_id
         WHERE r.source = ? AND r.source_item_id = ?`
      )
      .get(source, sourceItemId) as
      | {
          media_item_id: string;
          source_version?: string | null;
          last_seen_source_version?: string | null;
          content_hash?: string | null;
          payload_hash?: string | null;
          content_version?: number | null;
          active?: number | null;
          materialization_stale?: number | null;
          media_source?: string | null;
          media_type?: MediaType | null;
        }
      | undefined;
    if (existing && (!existing.media_type || existing.media_type !== record.media.mediaType)) {
      const trustedRepair = options.trustedRehydrateTypeRepairs?.get(sourceItemId);
      if (
        trustedRepair
        && existing.active === 1
        && existing.media_type
        && existing.media_type !== record.media.mediaType
        && source === "wikidata"
        && contentHash
        && existing.media_item_id === trustedRepair.expectedOldMediaItemId
        && existing.media_type === trustedRepair.expectedOldMediaType
        && existing.source_version === trustedRepair.expectedOldSourceVersion
        && existing.last_seen_source_version === trustedRepair.expectedOldLastSeenSourceVersion
        && (existing.payload_hash ?? undefined) === trustedRepair.expectedOldPayloadHash
        && contentHash === trustedRepair.expectedContentHash
        && (existing.content_hash ?? existing.payload_hash ?? null) === trustedRepair.expectedContentHash
        && cleanExternalIds(record.media.externalIds).wikidata === sourceItemId
        && this.catalogSourceIdentityExternalIdOwner(existing.media_item_id, existing.media_type, sourceItemId)
        && trustedRepair.externalIdCleanup.some(
          (externalId) => externalId.source === "wikidata" && externalId.value === sourceItemId
        ) === true
      ) {
        const target = this.catalogTypeRepairTarget(record);
        const targetActionMatches = trustedRepair.targetAction === "existing" ? target.existed : !target.existed;
        const targetStateMatches = target.mediaSource === trustedRepair.expectedTargetMediaSource
          && catalogExternalIdsEqual(target.externalIds, trustedRepair.expectedTargetExternalIds);
        if (target.mediaItemId !== trustedRepair.targetMediaItemId || !targetActionMatches || !targetStateMatches) {
          throw Object.assign(new Error("Catalog type-repair target changed during trusted recovery."), { statusCode: 409 });
        }
        return this.rebindTrustedStaleCatalogType(record, {
          source,
          sourceItemId,
          previousMediaItemId: existing.media_item_id,
          previousMediaType: existing.media_type,
          previousContentHash: existing.content_hash ?? existing.payload_hash ?? null,
          previousContentVersion: Math.max(1, Number(existing.content_version ?? 1))
        }, deferDerivedRefresh, trustedRepair, options);
      }
      throw Object.assign(new Error("Catalog source identity no longer matches its bound media item."), { statusCode: 409 });
    }
    const existingHash = existing?.content_hash ?? existing?.payload_hash ?? null;
    const requiresRematerialization = existing?.materialization_stale === 1
      || existing?.media_source === "operational"
      || options.trustedRehydrateRematerializations?.has(sourceItemId) === true;
    const hashesMatch = Boolean(existing && contentHash && existingHash === contentHash);
    const isUnchanged = hashesMatch && !requiresRematerialization;

    if (existing && isUnchanged) {
      const fetchedAt = record.fetchedAt ?? now;
      this.db
        .prepare(
          `UPDATE catalog_source_records
           SET source_version = ?,
            last_seen_source_version = ?,
            source_url = COALESCE(?, source_url),
            license_policy = ?,
            payload_hash = COALESCE(?, payload_hash),
            content_hash = COALESCE(?, content_hash),
            fetched_at = ?,
            expires_at = ?,
            active = 1,
            materialization_stale = 0,
            deleted_at = NULL,
            updated_at = ?
           WHERE source = ? AND source_item_id = ?`
        )
        .run(
          sourceVersion,
          sourceVersion,
          cleanOptionalText(record.sourceUrl, 500),
          licensePolicy,
          payloadHash,
          contentHash,
          fetchedAt,
          record.expiresAt ?? null,
          now,
          source,
          sourceItemId
        );
      this.db
        .prepare("UPDATE catalog_rank_signals SET source_version = ?, updated_at = ? WHERE media_item_id = ? AND source = ?")
        .run(sourceVersion, now, existing.media_item_id, source);
      this.upsertCatalogSearchIndex(existing.media_item_id, now);
      return { mediaItemId: existing.media_item_id, status: "unchanged" };
    }

    const reboundRepair = !existing ? options.trustedRehydrateTypeRepairs?.get(sourceItemId) : undefined;
    const mediaItemId = this.upsertWithBoundId(
      { ...record.media, source: "catalog" },
      reboundRepair?.targetMediaItemId ?? existing?.media_item_id,
      true,
      options.trustedRehydrateRematerializations?.has(sourceItemId) === true,
      reboundRepair ? trustedCatalogRepairTargetExternalIdSources : undefined,
      reboundRepair?.targetAction === "create"
    );
    const fetchedAt = record.fetchedAt ?? now;
    const metadataJson = JSON.stringify(safeCatalogMetadata(record.metadata));
    const currentContentVersion = Math.max(1, Number(existing?.content_version ?? 1));
    const contentVersion = existing ? (requiresRematerialization && hashesMatch ? currentContentVersion : currentContentVersion + 1) : 1;

    this.db
      .prepare(
        `INSERT INTO catalog_source_records (
          media_item_id, source, source_version, source_item_id, source_url, license_policy,
          payload_hash, content_hash, content_version, metadata_json, fetched_at, expires_at,
          active, last_seen_source_version, materialization_stale, deleted_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 0, NULL, ?)
        ON CONFLICT(source, source_item_id) DO UPDATE SET
          source_version = excluded.source_version,
          last_seen_source_version = excluded.last_seen_source_version,
          source_url = excluded.source_url,
          license_policy = excluded.license_policy,
          payload_hash = excluded.payload_hash,
          content_hash = excluded.content_hash,
          content_version = excluded.content_version,
          metadata_json = excluded.metadata_json,
          fetched_at = excluded.fetched_at,
          expires_at = excluded.expires_at,
          active = 1,
          materialization_stale = 0,
          deleted_at = NULL,
          updated_at = excluded.updated_at`
      )
      .run(
        mediaItemId,
        source,
        sourceVersion,
        sourceItemId,
        cleanOptionalText(record.sourceUrl, 500),
        licensePolicy,
        payloadHash,
        contentHash,
        contentVersion,
        metadataJson,
        fetchedAt,
        record.expiresAt ?? null,
        sourceVersion,
        now
      );

    this.db
      .prepare(
        `INSERT INTO catalog_rank_signals (
          media_item_id, source, source_version, mainstream_score, metadata_confidence,
          sitelink_count, external_id_count, award_count, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(media_item_id, source) DO UPDATE SET
          source_version = excluded.source_version,
          mainstream_score = excluded.mainstream_score,
          metadata_confidence = excluded.metadata_confidence,
          sitelink_count = excluded.sitelink_count,
          external_id_count = excluded.external_id_count,
          award_count = excluded.award_count,
          updated_at = excluded.updated_at`
      )
      .run(
        mediaItemId,
        source,
        sourceVersion,
        clampNumber(record.mainstreamScore ?? 0, 0, 100),
        clampNumber(record.metadataConfidence ?? defaultCatalogMetadataConfidence(record), 0, 1),
        clampInteger(record.sitelinkCount ?? 0, 0, 1_000_000),
        clampInteger(record.externalIdCount ?? Object.keys(record.media.externalIds ?? {}).length, 0, 1_000_000),
        clampInteger(record.awardCount ?? 0, 0, 1_000_000),
        now
      );

    if (!deferDerivedRefresh) {
      const refreshedItem = this.findById(mediaItemId);
      if (refreshedItem) this.upsertFeatureForItem(refreshedItem, now);
    }
    return { mediaItemId, status: existing ? "changed" : "inserted" };
  }

  private catalogSourceIdentityExternalIdOwner(mediaItemId: string, mediaType: MediaType, sourceItemId: string) {
    const row = this.db
      .prepare(
        `SELECT media_item_id
         FROM external_ids
         WHERE source = 'wikidata' AND media_type = ? AND value = ?`
      )
      .get(mediaType, sourceItemId) as { media_item_id: string } | undefined;
    return row?.media_item_id === mediaItemId;
  }

  private rebindTrustedStaleCatalogType(
    record: CatalogIngestRecord,
    previous: {
      source: string;
      sourceItemId: string;
      previousMediaItemId: string;
      previousMediaType: MediaType;
      previousContentHash: string | null;
      previousContentVersion: number;
    },
    deferDerivedRefresh: boolean,
    repair: TrustedCatalogTypeRepairPlan,
    options: CatalogUpsertOptions
  ): { mediaItemId: string; status: "changed"; previousMediaItemId: string } {
    const removed = this.db
      .prepare(
        `DELETE FROM catalog_source_records
         WHERE source = ?
          AND source_item_id = ?
          AND media_item_id = ?
          AND active = 1`
      )
      .run(previous.source, previous.sourceItemId, previous.previousMediaItemId);
    if (Number(removed.changes) !== 1) {
      throw Object.assign(new Error("Catalog source identity changed during trusted recovery."), { statusCode: 409 });
    }

    const deleteExternalId = this.db.prepare(
      `DELETE FROM external_ids
       WHERE media_item_id = ? AND source = ? AND media_type = ? AND value = ?`
    );
    for (const externalId of repair.externalIdCleanup) {
      const deleted = deleteExternalId.run(
        previous.previousMediaItemId,
        externalId.source,
        previous.previousMediaType,
        externalId.value
      );
      if (Number(deleted.changes) !== 1) {
        throw Object.assign(new Error("Catalog external identity changed during trusted recovery."), { statusCode: 409 });
      }
    }

    const remainingSourceRelationship = this.db
      .prepare(
        `SELECT 1
         FROM catalog_source_records
         WHERE media_item_id = ? AND source = ? AND active = 1
         LIMIT 1`
      )
      .get(previous.previousMediaItemId, previous.source);
    if (!remainingSourceRelationship) {
      this.db
        .prepare("DELETE FROM catalog_rank_signals WHERE media_item_id = ? AND source = ?")
        .run(previous.previousMediaItemId, previous.source);
    }

    const rebound = this.upsertCatalogRecordWithStatus(record, deferDerivedRefresh, options);
    if (rebound.mediaItemId !== repair.targetMediaItemId) {
      throw Object.assign(new Error("Catalog type-repair target changed during trusted recovery."), { statusCode: 409 });
    }
    const nextContentHash = cleanOptionalText(record.payloadHash, 160);
    const contentVersion = nextContentHash && previous.previousContentHash === nextContentHash
      ? previous.previousContentVersion
      : previous.previousContentVersion + 1;
    const versionUpdate = this.db
      .prepare(
        `UPDATE catalog_source_records
         SET content_version = ?
         WHERE source = ? AND source_item_id = ? AND media_item_id = ?`
      )
      .run(contentVersion, previous.source, previous.sourceItemId, rebound.mediaItemId);
    if (Number(versionUpdate.changes) !== 1) {
      throw new Error("Trusted catalog source rebind did not persist its corrected identity.");
    }
    return { mediaItemId: rebound.mediaItemId, status: "changed", previousMediaItemId: previous.previousMediaItemId };
  }

  catalogTypeRepairTarget(record: CatalogIngestRecord) {
    const externalIds = cleanExternalIds(record.media.externalIds);
    const trustedTargetExternalIds = Object.fromEntries(
      Object.entries(externalIds).filter(([source]) => trustedCatalogRepairTargetExternalIdSources.has(source))
    );
    const resolvedId = this.findExistingId(
      record.media,
      normalizeTitle(record.media.title),
      record.media.year,
      trustedTargetExternalIds,
      false
    );
    const mediaItemId = resolvedId
      ?? makeMediaId(record.media.mediaType, normalizeTitle(record.media.title), record.media.year, trustedTargetExternalIds);
    const existing = this.db.prepare("SELECT media_type, source FROM media_items WHERE id = ?").get(mediaItemId) as {
      media_type: MediaType;
      source: MediaSource;
    } | undefined;
    if (existing && existing.media_type !== record.media.mediaType) {
      throw Object.assign(new Error("Catalog type-repair target has an incompatible media type."), { statusCode: 409 });
    }
    const existed = Boolean(existing);
    const targetExternalIds = existing
      ? this.db.prepare(
          `SELECT source, value
           FROM external_ids
           WHERE media_item_id = ? AND media_type = ?
           ORDER BY source, value`
        ).all(mediaItemId, record.media.mediaType) as unknown as CatalogExternalId[]
      : [];
    return { mediaItemId, existed, mediaSource: existing?.source, externalIds: targetExternalIds };
  }

  private mediaSource(mediaItemId: string) {
    return (this.db.prepare("SELECT source FROM media_items WHERE id = ?").get(mediaItemId) as {
      source: MediaSource;
    } | undefined)?.source;
  }

  private refreshCatalogDerivedItems(ids: string[], resetIds: ReadonlySet<string> = new Set()) {
    const uniqueIds = unique(ids);
    const now = new Date().toISOString();
    for (let offset = 0; offset < uniqueIds.length; offset += catalogDerivedRefreshBatchSize) {
      const batchIds = uniqueIds.slice(offset, offset + catalogDerivedRefreshBatchSize);
      const scope = scopedMediaPredicate(batchIds);
      const rows = this.db
        .prepare(`SELECT * FROM media_items WHERE id IN (${scope.placeholders})`)
        .all(...scope.values) as unknown as MediaRow[];
      for (const row of rows) {
        if (row.source === "operational") {
          this.deleteStrictBoundaryDerivedState(row.id);
          continue;
        }
        if (resetIds.has(row.id)) this.deleteRebuildableCatalogDerivedState(row.id);
        const item = this.inflate(row);
        this.upsertFeatureForItem(item, now);
      }
    }
  }

  private deleteRebuildableCatalogDerivedState(mediaItemId: string) {
    for (const table of [
      "poster_cache",
      "media_embeddings",
      "media_feature_fts",
      "media_features",
      "media_mood_feature_scores",
      "media_content_fingerprints",
      "catalog_search_index_fts",
      "catalog_search_index"
    ]) {
      this.db.prepare(`DELETE FROM ${table} WHERE media_item_id = ?`).run(mediaItemId);
    }
  }

  private deleteStrictBoundaryDerivedState(mediaItemId: string) {
    for (const table of [
      "poster_cache",
      "media_embeddings",
      "media_feature_fts",
      "media_features",
      "media_mood_feature_scores",
      "media_content_fingerprints",
      "catalog_search_index_fts",
      "catalog_search_index",
      "genres"
    ]) {
      this.db.prepare(`DELETE FROM ${table} WHERE media_item_id = ?`).run(mediaItemId);
    }
  }

  markCatalogRecordsInactiveExcept(source: string, sourceVersion: string, activeSourceItemIds: string[]) {
    const normalizedSource = normalizeCatalogSource(source);
    cleanRequiredText(sourceVersion, 120, "Catalog source version");
    const now = new Date().toISOString();
    this.db.exec("SAVEPOINT catalog_inactive_marking");
    try {
      this.db.exec("CREATE TEMP TABLE IF NOT EXISTS current_catalog_source_ids (source_item_id TEXT PRIMARY KEY)");
      this.db.exec("DELETE FROM current_catalog_source_ids");
      const insert = this.db.prepare("INSERT OR IGNORE INTO current_catalog_source_ids (source_item_id) VALUES (?)");
      for (const id of activeSourceItemIds) {
        const cleaned = cleanOptionalText(id, 180);
        if (cleaned) insert.run(cleaned);
      }
      const result = this.db
        .prepare(
          `UPDATE catalog_source_records
           SET active = 0,
            deleted_at = COALESCE(deleted_at, ?),
            last_seen_source_version = COALESCE(last_seen_source_version, source_version),
            updated_at = ?
           WHERE source = ?
            AND active = 1
            AND source_item_id NOT IN (SELECT source_item_id FROM current_catalog_source_ids)`
        )
        .run(now, now, normalizedSource);
      this.db
        .prepare(
          `DELETE FROM catalog_search_index_fts
           WHERE media_item_id IN (
            SELECT r.media_item_id
            FROM catalog_source_records r
            LEFT JOIN plex_items p ON p.media_item_id = r.media_item_id AND p.available = 1
            LEFT JOIN seerr_items s ON s.media_item_id = r.media_item_id
            WHERE r.source = ?
             AND r.active = 0
             AND p.media_item_id IS NULL
             AND s.media_item_id IS NULL
           )`
        )
        .run(normalizedSource);
      this.db
        .prepare(
          `DELETE FROM catalog_search_index
           WHERE media_item_id IN (
            SELECT r.media_item_id
            FROM catalog_source_records r
            LEFT JOIN plex_items p ON p.media_item_id = r.media_item_id AND p.available = 1
            LEFT JOIN seerr_items s ON s.media_item_id = r.media_item_id
            WHERE r.source = ?
             AND r.active = 0
             AND p.media_item_id IS NULL
             AND s.media_item_id IS NULL
           )`
        )
        .run(normalizedSource);
      this.db.exec("DELETE FROM current_catalog_source_ids");
      this.db.exec("RELEASE SAVEPOINT catalog_inactive_marking");
      return Number(result.changes);
    } catch (error) {
      try {
        this.db.exec("ROLLBACK TO SAVEPOINT catalog_inactive_marking");
        this.db.exec("RELEASE SAVEPOINT catalog_inactive_marking");
      } catch {
        // Preserve the write failure if SQLite has already ended the savepoint.
      }
      throw error;
    }
  }

  upsert(record: IngestMediaRecord): string {
    this.db.exec("SAVEPOINT strict_record_upsert");
    try {
      const id = this.upsertWithBoundId(record);
      this.db.exec("RELEASE SAVEPOINT strict_record_upsert");
      return id;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK TO SAVEPOINT strict_record_upsert");
        this.db.exec("RELEASE SAVEPOINT strict_record_upsert");
      } catch {
        // Preserve the original write failure if SQLite has already ended the savepoint.
      }
      throw error;
    }
  }

  private upsertWithBoundId(
    record: IngestMediaRecord,
    boundId?: string,
    deferDerivedRefresh = false,
    trustedCatalogRematerialization = false,
    identityExternalIdSources?: ReadonlySet<string>,
    allowMissingBoundId = false
  ): string {
    const now = new Date().toISOString();
    const normalizedTitle = normalizeTitle(record.title);
    const externalIds = cleanExternalIds(record.externalIds);
    if (record.seerr?.tmdbId) externalIds.tmdb = String(record.seerr.tmdbId);
    if (record.seerr?.tvdbId) externalIds.tvdb = String(record.seerr.tvdbId);
    if (record.seerr?.imdbId) externalIds.imdb = record.seerr.imdbId;
    if (record.plex?.guid) externalIds.plex = record.plex.guid;

    const resolutionExternalIds = identityExternalIdSources
      ? Object.fromEntries(Object.entries(externalIds).filter(([source]) => identityExternalIdSources.has(source)))
      : externalIds;
    const resolvedId = this.findExistingId(
      record,
      normalizedTitle,
      record.year,
      resolutionExternalIds,
      record.source !== "catalog"
    );
    if (boundId && resolvedId && resolvedId !== boundId) {
      throw Object.assign(new Error("Catalog source identity conflicts with another media item."), { statusCode: 409 });
    }
    const id = boundId ?? resolvedId ?? makeMediaId(record.mediaType, normalizedTitle, record.year, resolutionExternalIds);
    const existing = this.db.prepare("SELECT title, normalized_title, runtime_minutes, source FROM media_items WHERE id = ?").get(id) as
          | Pick<MediaRow, "title" | "normalized_title" | "runtime_minutes" | "source">
          | undefined;
    if (boundId && !existing && !allowMissingBoundId) {
      throw Object.assign(new Error("Catalog source identity no longer has a bound media item."), { statusCode: 409 });
    }
    const preserveExistingTitle = Boolean(existing && isSparseSeerrPlaceholder(record.title));
    const storedTitle = preserveExistingTitle ? existing!.title : record.title;
    const storedNormalizedTitle = preserveExistingTitle ? existing!.normalized_title : normalizedTitle;
    const preserveExistingRuntime = Boolean(record.seerr && !record.plex && existing?.runtime_minutes);
    const storedRuntimeMinutes = preserveExistingRuntime ? existing!.runtime_minutes : record.runtimeMinutes;
    const replaceCatalogValues = trustedCatalogRematerialization
      && record.source === "catalog"
      && (existing?.source === "catalog" || existing?.source === "operational");

    this.db
      .prepare(
        `INSERT INTO media_items (
          id, media_type, title, normalized_title, year, summary, runtime_minutes, content_rating,
          poster_path, critic_rating, audience_rating, user_rating, source, created_at, updated_at
        ) VALUES (
          @id, @mediaType, @title, @normalizedTitle, @year, @summary, @runtimeMinutes, @contentRating,
          @posterPath, @criticRating, @audienceRating, @userRating, @source, @now, @now
        )
        ON CONFLICT(id) DO UPDATE SET
          title = CASE
            WHEN @replaceCatalogValues = 1 THEN excluded.title
            WHEN excluded.source = 'operational' THEN media_items.title
            WHEN excluded.source = 'catalog' AND media_items.source NOT IN ('catalog', 'operational') THEN media_items.title
            ELSE excluded.title
          END,
          normalized_title = CASE
            WHEN @replaceCatalogValues = 1 THEN excluded.normalized_title
            WHEN excluded.source = 'operational' THEN media_items.normalized_title
            WHEN excluded.source = 'catalog' AND media_items.source NOT IN ('catalog', 'operational') THEN media_items.normalized_title
            ELSE excluded.normalized_title
          END,
          year = CASE
            WHEN @replaceCatalogValues = 1 THEN excluded.year
            WHEN excluded.source = 'operational' THEN media_items.year
            WHEN excluded.source = 'catalog' AND media_items.source NOT IN ('catalog', 'operational') THEN COALESCE(media_items.year, excluded.year)
            ELSE COALESCE(excluded.year, media_items.year)
          END,
          summary = CASE
            WHEN @replaceCatalogValues = 1 THEN excluded.summary
            WHEN excluded.source = 'operational' THEN media_items.summary
            WHEN excluded.source = 'catalog' AND media_items.source NOT IN ('catalog', 'operational') THEN COALESCE(media_items.summary, excluded.summary)
            ELSE COALESCE(excluded.summary, media_items.summary)
          END,
          runtime_minutes = CASE
            WHEN @replaceCatalogValues = 1 THEN excluded.runtime_minutes
            WHEN excluded.source = 'operational' THEN media_items.runtime_minutes
            WHEN excluded.source = 'catalog' AND media_items.source NOT IN ('catalog', 'operational') THEN COALESCE(media_items.runtime_minutes, excluded.runtime_minutes)
            ELSE COALESCE(excluded.runtime_minutes, media_items.runtime_minutes)
          END,
          content_rating = CASE
            WHEN @replaceCatalogValues = 1 THEN excluded.content_rating
            WHEN excluded.source = 'operational' THEN media_items.content_rating
            WHEN excluded.source = 'catalog' AND media_items.source NOT IN ('catalog', 'operational') THEN COALESCE(media_items.content_rating, excluded.content_rating)
            ELSE COALESCE(excluded.content_rating, media_items.content_rating)
          END,
          poster_path = CASE
            WHEN @replaceCatalogValues = 1 THEN excluded.poster_path
            WHEN excluded.source = 'operational' THEN media_items.poster_path
            WHEN excluded.source = 'catalog' AND media_items.source NOT IN ('catalog', 'operational') THEN COALESCE(media_items.poster_path, excluded.poster_path)
            ELSE COALESCE(excluded.poster_path, media_items.poster_path)
          END,
          critic_rating = CASE
            WHEN @replaceCatalogValues = 1 THEN excluded.critic_rating
            WHEN excluded.source = 'operational' THEN media_items.critic_rating
            WHEN excluded.source = 'catalog' AND media_items.source NOT IN ('catalog', 'operational') THEN COALESCE(media_items.critic_rating, excluded.critic_rating)
            ELSE COALESCE(excluded.critic_rating, media_items.critic_rating)
          END,
          audience_rating = CASE
            WHEN @replaceCatalogValues = 1 THEN excluded.audience_rating
            WHEN excluded.source = 'operational' THEN media_items.audience_rating
            WHEN excluded.source = 'catalog' AND media_items.source NOT IN ('catalog', 'operational') THEN COALESCE(media_items.audience_rating, excluded.audience_rating)
            ELSE COALESCE(excluded.audience_rating, media_items.audience_rating)
          END,
          user_rating = CASE
            WHEN @replaceCatalogValues = 1 THEN excluded.user_rating
            WHEN excluded.source = 'operational' THEN media_items.user_rating
            WHEN excluded.source = 'catalog' AND media_items.source NOT IN ('catalog', 'operational') THEN COALESCE(media_items.user_rating, excluded.user_rating)
            ELSE COALESCE(excluded.user_rating, media_items.user_rating)
          END,
          source = CASE
            WHEN excluded.source = 'live' THEN 'live'
            WHEN media_items.source = 'operational' AND excluded.source = 'catalog' THEN 'catalog'
            ELSE media_items.source
          END,
          updated_at = excluded.updated_at`
      )
      .run({
        id,
        mediaType: record.mediaType,
        title: storedTitle,
        normalizedTitle: storedNormalizedTitle,
        year: record.year ?? null,
        summary: record.summary ?? null,
        runtimeMinutes: storedRuntimeMinutes ?? null,
        contentRating: record.contentRating ?? null,
        posterPath: record.posterPath ?? null,
        criticRating: record.ratings?.critic ?? null,
        audienceRating: record.ratings?.audience ?? null,
        userRating: record.ratings?.user ?? null,
        source: record.source ?? "live",
        replaceCatalogValues: replaceCatalogValues ? 1 : 0,
        now
      });

    const genreUpdate = this.resolveGenreUpdate(id, record, replaceCatalogValues);
    if (genreUpdate) this.replaceList("genres", id, genreUpdate);
    const castUpdate = this.resolvePeopleUpdate(id, record, "cast", replaceCatalogValues);
    if (castUpdate) this.replacePeople(id, castUpdate, "cast");
    const directorUpdate = this.resolvePeopleUpdate(id, record, "director", replaceCatalogValues);
    if (directorUpdate) this.replacePeople(id, directorUpdate, "director");
    this.upsertExternalIds(id, record.mediaType, externalIds);
    if (record.plex) this.upsertPlex(id, record.plex, now);
    if (record.seerr) this.upsertSeerr(id, record.mediaType, record.seerr, now);
    const storedSource = (this.db.prepare("SELECT source FROM media_items WHERE id = ?").get(id) as { source: MediaSource }).source;
    if (storedSource === "operational") {
      this.deleteCatalogSearchIndex(id);
    } else if (!deferDerivedRefresh) {
      this.upsertFeature(id, now);
    }
    return id;
  }

  list(): ItemDetail[] {
    const rows = this.db.prepare("SELECT * FROM media_items ORDER BY title, id").all() as unknown as MediaRow[];
    const items: ItemDetail[] = [];
    for (let offset = 0; offset < rows.length; offset += catalogDerivedRefreshBatchSize) {
      items.push(...this.inflateMany(rows.slice(offset, offset + catalogDerivedRefreshBatchSize), true));
    }
    return items;
  }

  count() {
    return (this.db.prepare("SELECT COUNT(*) AS value FROM media_items").get() as { value: number }).value;
  }

  catalogSearchIndexCount() {
    return (this.db.prepare("SELECT COUNT(*) AS value FROM catalog_search_index").get() as { value: number }).value;
  }

  private repairCatalogSearchIndexes() {
    const materializedMembershipMismatch = Boolean(
      this.db
        .prepare(
          `SELECT 1 AS mismatch
           WHERE EXISTS (
             SELECT id AS media_item_id FROM media_items WHERE source != 'operational'
             EXCEPT
             SELECT media_item_id FROM catalog_search_index
           )
           OR EXISTS (
             SELECT media_item_id FROM catalog_search_index
             EXCEPT
             SELECT id AS media_item_id FROM media_items WHERE source != 'operational'
           )`
        )
        .get()
    );
    if (materializedMembershipMismatch) {
      this.rebuildCatalogSearchIndex();
      return;
    }

    const indexCount = this.catalogSearchIndexCount();
    const ftsCount = (this.db.prepare("SELECT COUNT(*) AS value FROM catalog_search_index_fts").get() as { value: number }).value;
    const ftsMembershipMismatch =
      ftsCount !== indexCount ||
      Boolean(
        this.db
          .prepare(
            `SELECT 1 AS mismatch
             WHERE EXISTS (
               SELECT media_item_id FROM catalog_search_index
               EXCEPT
               SELECT media_item_id FROM catalog_search_index_fts
             )
             OR EXISTS (
               SELECT media_item_id FROM catalog_search_index_fts
               EXCEPT
               SELECT media_item_id FROM catalog_search_index
             )`
          )
          .get()
      );
    if (!ftsMembershipMismatch) return;

    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM catalog_search_index_fts").run();
      this.db
        .prepare(
          `INSERT INTO catalog_search_index_fts (media_item_id, title, search_text, mood_text)
           SELECT media_item_id, title, search_text, mood_text
           FROM catalog_search_index`
        )
        .run();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  inflateByIds(ids: string[]): ItemDetail[] {
    const uniqueIds = unique(ids).slice(0, recommendationCandidateLimit);
    if (uniqueIds.length === 0) return [];
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT * FROM media_items WHERE id IN (${placeholders})`).all(...uniqueIds) as unknown as MediaRow[];
    const itemById = new Map(this.inflateMany(rows, true).map((item) => [item.id, item]));
    return uniqueIds.flatMap((id) => {
      const item = itemById.get(id);
      return item ? [item] : [];
    });
  }

  findById(id: string): ItemDetail | undefined {
    const row = this.db.prepare("SELECT * FROM media_items WHERE id = ?").get(id) as MediaRow | undefined;
    return row ? this.inflate(row) : undefined;
  }

  trustedLocalRequestMediaId(item: ItemDetail) {
    if (item.catalogIdentityAmbiguous) return undefined;
    const tmdbRows = this.db
      .prepare("SELECT value FROM external_ids WHERE media_item_id = ? AND source = 'tmdb' AND media_type = ? ORDER BY value")
      .all(item.id, item.mediaType) as Array<{ value: string }>;
    const parsedTmdbId = tmdbRows.length === 1 ? Number(tmdbRows[0]!.value) : undefined;
    const unambiguousTmdbId = Number.isSafeInteger(parsedTmdbId) && parsedTmdbId! > 0 ? parsedTmdbId : undefined;
    return deriveRequestAttemptPolicy({
      externalTmdbId: unambiguousTmdbId,
      hasActiveNonStaleCatalogSource: this.trustedUnambiguousActiveCatalogItemIds([item.id]).has(item.id),
      hasPlexSource: Boolean(item.plex),
      plexAvailable: Boolean(item.plex?.available),
      summary: item.summary,
      genres: item.genres,
      seerr: item.seerr
    }).trustedLocalMediaId;
  }

  findByExternalId(source: string, value: string, mediaType?: MediaType): ItemDetail | undefined {
    const rows = this.db
      .prepare(
        `SELECT media_item_id
         FROM external_ids
         WHERE source = ? AND value = ?
          AND (? IS NULL OR media_type = ?)
         LIMIT 2`
      )
      .all(source.toLowerCase(), value, mediaType ?? null, mediaType ?? null) as Array<{ media_item_id: string }>;
    if (rows.length > 1) {
      throw Object.assign(new Error("External media identifier is ambiguous without a media type."), { statusCode: 409 });
    }
    return rows[0] ? this.findById(rows[0].media_item_id) : undefined;
  }

  findByTitleYear(title: string, year: number | undefined, mediaType?: MediaType): ItemDetail | undefined {
    const normalizedTitle = normalizeTitle(title);
    const rows = this.db
      .prepare(
        `SELECT *
         FROM media_items
         WHERE normalized_title = ?
          AND (? IS NULL OR media_type = ?)
          AND (? IS NULL OR year IS NULL OR ABS(year - ?) <= 1)
         ORDER BY CASE WHEN year = ? THEN 0 ELSE 1 END, title, id
         LIMIT 1`
      )
      .all(normalizedTitle, mediaType ?? null, mediaType ?? null, year ?? null, year ?? null, year ?? null) as unknown as MediaRow[];
    return rows[0] ? this.inflate(rows[0]) : undefined;
  }

  getPosterPath(id: string): string | undefined {
    const row = this.db.prepare("SELECT poster_path FROM media_items WHERE id = ?").get(id) as { poster_path?: string } | undefined;
    return row?.poster_path;
  }

  saveRequest(mediaItemId: string, mediaType: MediaType, mediaId: number, seasons: number[] | undefined, status: string, externalRequestId?: string) {
    const now = new Date().toISOString();
    const seasonsJson = seasons ? JSON.stringify([...new Set(seasons)].sort((left, right) => left - right)) : null;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO requests (media_item_id, media_type, media_id, seasons_json, status, external_request_id, created_at)
           SELECT ?, ?, ?, ?, ?, ?, ?
           WHERE NOT EXISTS (
             SELECT 1
             FROM requests
             WHERE media_item_id = ?
               AND media_type = ?
               AND media_id = ?
               AND COALESCE(seasons_json, '') = COALESCE(?, '')
           )`
        )
        .run(
          mediaItemId,
          mediaType,
          mediaId,
          seasonsJson,
          status,
          externalRequestId ?? null,
          now,
          mediaItemId,
          mediaType,
          mediaId,
          seasonsJson
        );
      const requestStatus = normalizeCreatedRequestStatus(status);
      const operationalUpdate = this.db
        .prepare(
          `UPDATE seerr_items
           SET request_status = ?, requestable = 0, status = CASE WHEN status = 'available' THEN status ELSE 'requested' END, last_seen_at = ?
           WHERE media_item_id = ?`
        )
        .run(requestStatus, now, mediaItemId);
      if (Number(operationalUpdate.changes) === 0) {
        this.db
          .prepare(
            `INSERT INTO seerr_items (
              id, media_item_id, tmdb_id, tvdb_id, imdb_id, seerr_media_id, media_type,
              status, request_status, requestable, seerr_url, last_seen_at
            ) VALUES (?, ?, ?, NULL, NULL, NULL, ?, 'requested', ?, 0, NULL, ?)
            ON CONFLICT(id) DO UPDATE SET
              media_item_id = excluded.media_item_id,
              tmdb_id = excluded.tmdb_id,
              media_type = excluded.media_type,
              status = CASE WHEN seerr_items.status = 'available' THEN seerr_items.status ELSE 'requested' END,
              request_status = excluded.request_status,
              requestable = 0,
              last_seen_at = excluded.last_seen_at`
          )
          .run(`seerr:${mediaType}:${mediaId}`, mediaItemId, mediaId, mediaType, requestStatus, now);
      }
      this.upsertCatalogSearchIndex(mediaItemId, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  requestCreationOperation(idempotencyKey: string): RequestCreationOperation | undefined {
    const row = this.db
      .prepare("SELECT idempotency_key, request_fingerprint, status, response_json, error, updated_at FROM request_creation_operations WHERE idempotency_key = ?")
      .get(idempotencyKey) as
      | { idempotency_key: string; request_fingerprint: string; status: RequestCreationOperation["status"]; response_json?: string | null; error?: string | null; updated_at: string }
      | undefined;
    if (!row) return undefined;
    return {
      idempotencyKey: row.idempotency_key,
      requestFingerprint: row.request_fingerprint,
      status: row.status,
      response: parseJsonRecord(row.response_json),
      error: row.error ?? undefined,
      updatedAt: row.updated_at
    };
  }

  activeRequestCreationOperation(authScope: string, requestFingerprint: string): RequestCreationOperation | undefined {
    const row = this.db
      .prepare(
        `SELECT idempotency_key, request_fingerprint, status, response_json, error, updated_at
         FROM request_creation_operations
         WHERE auth_scope = ?
           AND request_fingerprint = ?
           AND status IN ('pending', 'uncertain')
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(authScope, requestFingerprint) as
      | { idempotency_key: string; request_fingerprint: string; status: RequestCreationOperation["status"]; response_json?: string | null; error?: string | null; updated_at: string }
      | undefined;
    if (!row) return undefined;
    return {
      idempotencyKey: row.idempotency_key,
      requestFingerprint: row.request_fingerprint,
      status: row.status,
      response: parseJsonRecord(row.response_json),
      error: row.error ?? undefined,
      updatedAt: row.updated_at
    };
  }

  activeRequestCreationOperationForItem(mediaItemId: string): RequestCreationOperation | undefined {
    const row = this.db
      .prepare(
        `SELECT idempotency_key, request_fingerprint, status, response_json, error, updated_at
         FROM request_creation_operations
         WHERE media_item_id = ?
           AND status IN ('pending', 'uncertain')
         ORDER BY updated_at DESC
         LIMIT 1`
      )
      .get(mediaItemId) as
      | { idempotency_key: string; request_fingerprint: string; status: RequestCreationOperation["status"]; response_json?: string | null; error?: string | null; updated_at: string }
      | undefined;
    if (!row) return undefined;
    return {
      idempotencyKey: row.idempotency_key,
      requestFingerprint: row.request_fingerprint,
      status: row.status,
      response: parseJsonRecord(row.response_json),
      error: row.error ?? undefined,
      updatedAt: row.updated_at
    };
  }

  requestCreationGenerationForItem(mediaItemId: string) {
    const item = this.findById(mediaItemId);
    const createdOperations = this.db
      .prepare(
        `SELECT idempotency_key
         FROM request_creation_operations
         WHERE media_item_id = ?
           AND status = 'created'
         ORDER BY idempotency_key`
      )
      .all(mediaItemId) as Array<{ idempotency_key: string }>;
    const mediaIdentity = this.db
      .prepare(
        `SELECT id, media_type, title, normalized_title, year, summary, source
         FROM media_items
         WHERE id = ?`
      )
      .get(mediaItemId);
    const genres = this.db
      .prepare("SELECT name FROM genres WHERE media_item_id = ? ORDER BY name")
      .all(mediaItemId);
    const externalIds = this.db
      .prepare(
        `SELECT source, media_type, value
         FROM external_ids
         WHERE media_item_id = ?
         ORDER BY source, media_type, value`
      )
      .all(mediaItemId);
    const plex = this.db
      .prepare(
        `SELECT id, rating_key, guid, available
         FROM plex_items
         WHERE media_item_id = ?
         ORDER BY id`
      )
      .all(mediaItemId);
    const seerr = this.db
      .prepare(
        `SELECT id, tmdb_id, tvdb_id, imdb_id, seerr_media_id, media_type, status, request_status, requestable
         FROM seerr_items
         WHERE media_item_id = ?
         ORDER BY id`
      )
      .all(mediaItemId);
    const catalog = this.db
      .prepare(
        `SELECT source, source_version, source_item_id, license_policy, expires_at, active,
          last_seen_source_version, content_hash, content_version, deleted_at, materialization_stale
         FROM catalog_source_records
         WHERE media_item_id = ?
         ORDER BY source, source_item_id`
      )
      .all(mediaItemId);
    const quarantine = this.db
      .prepare(
        `SELECT reason_code, first_seen_at, last_seen_at, occurrence_count
         FROM media_identity_quarantine
         WHERE media_item_id = ?`
      )
      .get(mediaItemId);
    const requestPolicy = item
      ? {
          availabilityGroup: item.availabilityGroup,
          catalogIdentityAmbiguous: Boolean(item.catalogIdentityAmbiguous),
          plexAvailable: Boolean(item.plex?.available),
          seerr: item.seerr
            ? {
                mediaId: item.seerr.mediaId ?? null,
                status: item.seerr.status,
                requestStatus: item.seerr.requestStatus ?? null,
                requestable: item.seerr.requestable
              }
            : null,
          trustedLocalMediaId: this.trustedLocalRequestMediaId(item) ?? null,
          requestAttemptAvailable: Boolean(item.requestAttempt?.available)
        }
      : null;
    return crypto
      .createHash("sha256")
      .update(
        JSON.stringify({
          mediaIdentity: mediaIdentity ?? null,
          genres,
          externalIds,
          plex,
          seerr,
          catalog,
          quarantine: quarantine ?? null,
          requestPolicy,
          createdOperations: createdOperations.map((row) => row.idempotency_key)
        })
      )
      .digest("hex");
  }

  beginRequestCreationOperation(
    idempotencyKey: string,
    requestFingerprint: string,
    authScope: string,
    mediaItemId: string,
    expectedRequestCreationGeneration: string
  ): RequestCreationAcquisitionResult {
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.requestCreationGenerationForItem(mediaItemId) !== expectedRequestCreationGeneration) {
        this.db.exec("COMMIT");
        return "stale-generation";
      }
      this.db
        .prepare("DELETE FROM request_creation_operations WHERE status = 'failed' AND julianday(updated_at) < julianday('now', '-90 days')")
        .run();
      const active = this.db
        .prepare(
          `SELECT 1
           FROM request_creation_operations
           WHERE media_item_id = ?
             AND status IN ('pending', 'uncertain')
           LIMIT 1`
        )
        .get(mediaItemId);
      if (active) {
        this.db.exec("COMMIT");
        return "active-operation";
      }
      const recovered = this.db
        .prepare(
          `UPDATE request_creation_operations
           SET request_fingerprint = ?, auth_scope = ?, media_item_id = ?, status = 'pending',
             response_json = NULL, error = NULL, updated_at = ?
           WHERE idempotency_key = ? AND status = 'failed'`
        )
        .run(requestFingerprint, authScope, mediaItemId, now, idempotencyKey);
      if (Number(recovered.changes) > 0) {
        this.db.exec("COMMIT");
        return "acquired";
      }
      const inserted = this.db
        .prepare(
          `INSERT OR IGNORE INTO request_creation_operations (
            idempotency_key, request_fingerprint, auth_scope, media_item_id, status, response_json, error, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, ?, ?)`
        )
        .run(idempotencyKey, requestFingerprint, authScope, mediaItemId, now, now);
      this.db.exec("COMMIT");
      return Number(inserted.changes) > 0 ? "acquired" : "existing-operation";
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  completeRequestCreationOperation(idempotencyKey: string, response: Record<string, unknown>) {
    this.db
      .prepare("UPDATE request_creation_operations SET status = 'created', response_json = ?, error = NULL, updated_at = ? WHERE idempotency_key = ?")
      .run(JSON.stringify(response), new Date().toISOString(), idempotencyKey);
  }

  failRequestCreationOperation(idempotencyKey: string, error: string) {
    this.db
      .prepare("UPDATE request_creation_operations SET status = 'failed', response_json = NULL, error = ?, updated_at = ? WHERE idempotency_key = ?")
      .run(error.slice(0, 500), new Date().toISOString(), idempotencyKey);
  }

  markRequestCreationOperationUncertain(idempotencyKey: string, error: string) {
    this.db
      .prepare("UPDATE request_creation_operations SET status = 'uncertain', response_json = NULL, error = ?, updated_at = ? WHERE idempotency_key = ?")
      .run(error.slice(0, 500), new Date().toISOString(), idempotencyKey);
  }

  purgeExpiredPosterCache() {
    const result = this.db.prepare(`DELETE FROM poster_cache WHERE ${posterCacheExpiredSql}`).run();
    return Number(result.changes);
  }

  getPosterCache(mediaItemId: string, sourceKey: string): PosterCacheRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT content_type, body, source_key,
          CASE WHEN ${posterCacheExpiredSql} THEN 1 ELSE 0 END AS expired
         FROM poster_cache
         WHERE media_item_id = ?`
      )
      .get(mediaItemId) as
      | { content_type: string; body: Uint8Array; source_key?: string | null; expired: number }
      | undefined;
    if (!row) return undefined;
    if (row.expired === 1) {
      this.db.prepare("DELETE FROM poster_cache WHERE media_item_id = ?").run(mediaItemId);
      return undefined;
    }
    if (row.source_key !== sourceKey) {
      this.db.prepare("DELETE FROM poster_cache WHERE media_item_id = ?").run(mediaItemId);
      return undefined;
    }
    this.db
      .prepare("UPDATE poster_cache SET last_accessed_at = ? WHERE media_item_id = ? AND julianday(last_accessed_at) < julianday('now', '-1 day')")
      .run(new Date().toISOString(), mediaItemId);
    return {
      contentType: row.content_type,
      body: Buffer.from(row.body)
    };
  }

  savePosterCache(mediaItemId: string, sourceKey: string, contentType: string, body: Buffer) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO poster_cache (media_item_id, content_type, body, fetched_at, source_key, byte_size, last_accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(media_item_id) DO UPDATE SET
          content_type = excluded.content_type,
          body = excluded.body,
          fetched_at = excluded.fetched_at,
          source_key = excluded.source_key,
          byte_size = excluded.byte_size,
          last_accessed_at = excluded.last_accessed_at`
      )
      .run(mediaItemId, contentType, body, now, sourceKey, body.byteLength, now);
    this.purgeExpiredPosterCache();
    this.evictPosterCache();
  }

  recordRequestAudit(record: RequestAuditRecord) {
    this.db
      .prepare(
        `INSERT INTO request_audit (
          media_item_id, auth_user_id, action, status, media_type, media_id, title, seasons_json, blocked_reason, external_request_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.mediaItemId ?? null,
        record.authUserId ?? null,
        record.action,
        record.status,
        record.mediaType ?? null,
        record.mediaId ?? null,
        record.title ?? null,
        record.seasons ? JSON.stringify(record.seasons) : null,
        record.blockedReason ?? null,
        record.externalRequestId ?? null,
        new Date().toISOString()
      );
  }

  recordSync(kind: "library" | "seerr", source: string, status: string, itemCount: number, error?: string) {
    const table = kind === "library" ? "library_sync_runs" : "seerr_sync_runs";
    const now = new Date().toISOString();
    const persistedError = error === undefined ? undefined : safeErrorMessage(error);
    this.db
      .prepare(`INSERT INTO ${table} (source, status, started_at, finished_at, item_count, error) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(source, status, now, now, itemCount, persistedError ?? null);
  }

  recordCatalogSync(source: string, sourceVersion: string, status: string, summary: CatalogSyncSummary, error?: string) {
    const now = new Date().toISOString();
    const persistedError = error === undefined ? undefined : safeErrorMessage(error);
    this.db
      .prepare(
        `INSERT INTO catalog_sync_runs (
          source, source_version, status, started_at, finished_at, item_count, media_items_upserted, source_records_upserted,
          update_mode, changed_source_records, unchanged_source_records, inactive_source_records, error
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        normalizeCatalogSource(source),
        sourceVersion,
        status,
        now,
        now,
        summary.itemCount,
        summary.mediaItemsUpserted,
        summary.sourceRecordsUpserted,
        summary.updateMode ?? "incremental",
        summary.changedSourceRecords ?? summary.sourceRecordsUpserted,
        summary.unchangedSourceRecords ?? 0,
        summary.inactiveSourceRecords ?? 0,
        persistedError ?? null
      );
  }

  markPlexUnavailableExceptRatingKeys(ratingKeys: string[]) {
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db.exec("CREATE TEMP TABLE IF NOT EXISTS current_plex_sync_rating_keys (rating_key TEXT PRIMARY KEY)");
      this.db.exec("DELETE FROM current_plex_sync_rating_keys");
      const insert = this.db.prepare("INSERT OR IGNORE INTO current_plex_sync_rating_keys (rating_key) VALUES (?)");
      for (const ratingKey of ratingKeys) insert.run(ratingKey);
      const affected = this.db
        .prepare(
          `SELECT DISTINCT media_item_id
           FROM plex_items
           WHERE available = 1
            AND NOT EXISTS (
              SELECT 1
              FROM current_plex_sync_rating_keys current
              WHERE current.rating_key = plex_items.rating_key
            )`
        )
        .all() as Array<{ media_item_id: string }>;
      const result = this.db
        .prepare(
          `UPDATE plex_items
           SET available = 0
           WHERE available = 1
            AND NOT EXISTS (
              SELECT 1
              FROM current_plex_sync_rating_keys current
              WHERE current.rating_key = plex_items.rating_key
            )`
        )
        .run();
      for (const row of affected) this.upsertCatalogSearchIndex(row.media_item_id, now);
      this.db.exec("DELETE FROM current_plex_sync_rating_keys");
      this.db.exec("COMMIT");
      return Number(result.changes);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  posterCacheDiagnostics() {
    const row = this.db
      .prepare("SELECT COUNT(*) AS row_count, COALESCE(SUM(byte_size), 0) AS byte_count FROM poster_cache")
      .get() as { row_count: number; byte_count: number };
    return {
      rows: row.row_count,
      bytes: row.byte_count,
      maxRows: posterCacheMaxRows,
      maxBytes: posterCacheMaxBytes
    };
  }

  purgeFixtureData() {
    const result = this.db.prepare("DELETE FROM media_items WHERE source = 'fixture'").run();
    return Number(result.changes);
  }

  syncHistory(limit = 8): { library: SyncRunSummary[]; seerr: SyncRunSummary[] } {
    return {
      library: this.syncRuns("library_sync_runs", limit),
      seerr: this.syncRuns("seerr_sync_runs", limit)
    };
  }

  recordSearch(query: string, resultCount: number, usedAi: boolean) {
    const hash = crypto.createHash("sha256").update(query.toLowerCase().trim()).digest("hex");
    this.db
      .prepare("INSERT INTO search_events (query_hash, result_count, used_ai, created_at) VALUES (?, ?, ?, ?)")
      .run(hash, resultCount, usedAi ? 1 : 0, new Date().toISOString());
  }

  withTelemetryWriteBudget<T>(operation: () => T, timeoutMs = 25) {
    const normalizedTimeout = Math.max(0, Math.min(250, Math.floor(timeoutMs)));
    this.db.exec(`PRAGMA busy_timeout = ${normalizedTimeout}`);
    try {
      return operation();
    } finally {
      this.db.exec("PRAGMA busy_timeout = 5000");
    }
  }

  recordRecommendationRun(record: RecommendationRunRecord) {
    const now = new Date().toISOString();
    const id = randomUUID();
    const queryHash = crypto.createHash("sha256").update(record.query.toLowerCase().trim()).digest("hex");
    const profileId = preferenceProfileId(record.watchContext, record.authUserId);
    const profileVersion = this.currentProfileVersion(record.watchContext, record.authUserId);
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO recommendation_sessions (
            id, query_hash, engine_version, model, watch_context, result_count, candidate_count, rerank_candidate_count,
            used_ai, seerr_augmented, latency_ms, profile_id, profile_version, auth_user_id, trace_schema_version, trace_flags_json,
            brief_trace_json, retrieval_trace_json, rerank_trace_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          id,
          queryHash,
          record.engineVersion,
          record.model ?? null,
          record.watchContext,
          record.resultCount,
          record.candidateCount,
          record.rerankCandidateCount,
          record.usedAi ? 1 : 0,
          record.seerrAugmented ? 1 : 0,
          record.latencyMs,
          profileId,
          profileVersion,
          record.authUserId ?? null,
          record.trace?.schemaVersion ?? null,
          record.trace ? JSON.stringify(record.trace.flags) : null,
          record.trace ? JSON.stringify(record.trace.brief) : null,
          record.trace ? JSON.stringify(record.trace.retrieval) : null,
          record.trace?.rerank ? JSON.stringify(record.trace.rerank) : null,
          now
        );
      const insertResult = this.db.prepare(
        `INSERT INTO recommendation_results (
          session_id, media_item_id, rank, score, score_breakdown_json, availability_group, feature_version,
          provenance_json, score_trace_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      const featureVersion = this.db.prepare("SELECT feature_version FROM media_features WHERE media_item_id = ?");
      record.results.forEach((item, index) => {
        const featureRow = featureVersion.get(item.id) as { feature_version?: string } | undefined;
        insertResult.run(
          id,
          item.id,
          index + 1,
          item.score,
          JSON.stringify(item.scoreBreakdown ?? {}),
          item.availabilityGroup,
          featureRow?.feature_version ?? null,
          record.trace?.provenanceByItemId[item.id] ? JSON.stringify(record.trace.provenanceByItemId[item.id]) : null,
          record.trace?.scoreTraceByItemId[item.id] ? JSON.stringify(record.trace.scoreTraceByItemId[item.id]) : null
        );
      });
      if (record.trace) {
        this.runOptionalTraceWrite(record.trace.flags.traceWrite === "strict", () => {
          this.recordRecommendationTraceRows(id, record.trace!, now);
          if (record.trace?.flags.exposureLogging === "server_returned") {
            this.recordRecommendationImpressionRows(id, record.results, now);
          }
        });
      }
      this.recordFeedbackRows(id, record.watchContext, record.feedback, record.authUserId);
      if (record.reviewQueue) this.recordQueryReviewRow(id, record, record.reviewQueue, now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.compactReplayData();
    return id;
  }

  queryReviewQueue(status: QueryReviewStatus = "pending", limit = 50) {
    const normalizedStatus = status === "reviewed" || status === "all" ? status : "pending";
    const normalizedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const where = queryReviewWhereClause(normalizedStatus);
    const total = (this.db.prepare(`SELECT COUNT(*) AS value FROM query_review_queue ${where}`).get() as { value: number }).value;
    const rows = this.db
      .prepare(
        `SELECT id, session_id, query_text, optimized_query, watch_context, result_count, results_json,
          mood_fit_rating, mood_feedback_text, reviewed_at, created_at
         FROM query_review_queue
         ${where}
         ORDER BY COALESCE(reviewed_at, '') ASC, created_at DESC, id DESC
         LIMIT ?`
      )
      .all(normalizedLimit) as unknown as QueryReviewQueueRow[];
    return {
      status: normalizedStatus,
      count: total,
      items: rows.map(inflateQueryReviewQueueItem)
    };
  }

  updateQueryReviewQueueItem(id: string, update: QueryReviewUpdate): QueryReviewQueueItem | undefined {
    const now = new Date().toISOString();
    const feedbackText = update.moodFeedbackText?.trim();
    const result = this.db
      .prepare(
        `UPDATE query_review_queue
         SET mood_fit_rating = ?, mood_feedback_text = ?, reviewed_at = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(update.moodFitRating, feedbackText ? feedbackText : null, now, now, id);
    if (Number(result.changes) === 0) return undefined;
    const row = this.db
      .prepare(
        `SELECT id, session_id, query_text, optimized_query, watch_context, result_count, results_json,
          mood_fit_rating, mood_feedback_text, reviewed_at, created_at
         FROM query_review_queue
         WHERE id = ?`
      )
      .get(id) as QueryReviewQueueRow | undefined;
    return row ? inflateQueryReviewQueueItem(row) : undefined;
  }

  recordFeelFeedback(input: FeelFeedbackRequest, authUserId?: string): FeelFeedbackResponse {
    const now = new Date().toISOString();
    const watchContext = input.watchContext ?? "solo";
    const source = input.source ?? "web";
    const itemId = cleanOptionalId(input.itemId);
    const comparedItemId = cleanOptionalId(input.comparedItemId);
    const sessionId = cleanOptionalId(input.sessionId);
    const clientEventId = cleanShortText(input.clientEventId, 120, false);
    const moodTerm = cleanShortText(input.moodTerm, 80, true);
    const reason = normalizeFeelReason(input.reason);
    const reliability = feelFeedbackReliability(input.action);
    const initialProfileVersion = this.currentProfileVersion(watchContext, authUserId);
    this.db.exec("SAVEPOINT record_feel_feedback");
    try {
      const duplicate = clientEventId ? this.findFeelFeedbackByClientEventId(source, clientEventId, authUserId) : undefined;
      if (duplicate) {
        this.db.exec("RELEASE record_feel_feedback");
        return feelFeedbackResponseFromRow(duplicate, true);
      }

      if (itemId && !this.mediaItemExists(itemId)) {
        throw Object.assign(new Error("Feel feedback itemId must reference a known item."), { statusCode: 400 });
      }
      if (comparedItemId && !this.mediaItemExists(comparedItemId)) {
        throw Object.assign(new Error("Feel feedback comparedItemId must reference a known item."), { statusCode: 400 });
      }
      if (sessionId) this.validateFeedbackSession(sessionId, authUserId, itemId, comparedItemId);

      const result = this.db
        .prepare(
          `INSERT INTO feel_feedback_events (
            session_id, media_item_id, compared_media_item_id, watch_context, source, client_event_id, action, reliability, mood_term, reason,
            strength, metadata_json, profile_version, profile_update_applied, profile_holdout, auth_user_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          sessionId ?? null,
          itemId ?? null,
          comparedItemId ?? null,
          watchContext,
          source,
          clientEventId,
          input.action,
          reliability,
          moodTerm,
          reason,
          input.strength ?? null,
          JSON.stringify(safeFeelMetadata(input.metadata)),
          initialProfileVersion,
          0,
          0,
          authUserId ?? null,
          now
        );

      const eventId = Number(result.lastInsertRowid);
      const appliedPreferenceSignal = this.applyFeelFeedbackPreferenceSignal(watchContext, input.action, itemId, comparedItemId, authUserId);
      const profileHoldout = shouldHoldoutProfileSignal(reliability, moodTerm, eventId);
      if (profileHoldout) {
        this.db.prepare("UPDATE feel_feedback_events SET profile_holdout = 1 WHERE id = ?").run(eventId);
      }
      const profileSignal = profileHoldout
        ? ({ applied: false } as const)
        : this.applyFeelFeedbackProfileSignal(
            watchContext,
            input.action,
            reliability,
            sessionId,
            itemId,
            comparedItemId,
            moodTerm,
            reason,
            eventId,
            input.strength,
            authUserId
          );
      if (profileSignal.applied) {
        this.db
          .prepare("UPDATE feel_feedback_events SET profile_version = ?, profile_update_applied = 1 WHERE id = ?")
          .run(profileSignal.profileVersion, eventId);
      }
      this.compactReplayData();
      this.db.exec("RELEASE record_feel_feedback");
      return {
        ok: true,
        eventId,
        reliability,
        profileVersion: profileSignal.applied ? profileSignal.profileVersion : initialProfileVersion,
        profileHoldout,
        appliedPreferenceSignal,
        appliedProfileSignal: profileSignal.applied
      };
    } catch (error) {
      this.db.exec("ROLLBACK TO record_feel_feedback");
      this.db.exec("RELEASE record_feel_feedback");
      throw error;
    }
  }

  private findFeelFeedbackByClientEventId(source: FeelFeedbackSource, clientEventId: string, authUserId?: string): FeelFeedbackResponseRow | undefined {
    return this.db
      .prepare(
        `SELECT id, reliability, profile_version, profile_update_applied, profile_holdout
         FROM feel_feedback_events
         WHERE source = ? AND client_event_id = ?
          AND COALESCE(auth_user_id, '') = COALESCE(?, '')
         LIMIT 1`
      )
      .get(source, clientEventId, authUserId ?? null) as FeelFeedbackResponseRow | undefined;
  }

  featureMap(): Map<string, StoredMediaFeature> {
    const rows = this.db.prepare("SELECT * FROM media_features").all() as Array<{
      media_item_id: string;
      feature_text: string;
      mood_terms_json: string;
      tone_terms_json: string;
      watchability_terms_json: string;
      vector_json: string;
      feature_version: string;
    }>;
    return new Map(rows.map((row) => [row.media_item_id, inflateFeature(row)]));
  }

  featureMapByIds(ids: string[]): Map<string, StoredMediaFeature> {
    const uniqueIds = unique(ids).slice(0, recommendationCandidateLimit);
    if (uniqueIds.length === 0) return new Map();
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT * FROM media_features WHERE media_item_id IN (${placeholders})`).all(...uniqueIds) as Array<{
      media_item_id: string;
      feature_text: string;
      mood_terms_json: string;
      tone_terms_json: string;
      watchability_terms_json: string;
      vector_json: string;
      feature_version: string;
    }>;
    return new Map(rows.map((row) => [row.media_item_id, inflateFeature(row)]));
  }

  contentFingerprintForItem(mediaItemId: string): ContentFingerprintV1 | undefined {
    const row = this.db
      .prepare("SELECT fingerprint_json FROM media_content_fingerprints WHERE media_item_id = ?")
      .get(mediaItemId) as { fingerprint_json: string } | undefined;
    return parseContentFingerprint(row?.fingerprint_json);
  }

  contentFingerprintCount() {
    return (this.db.prepare("SELECT COUNT(*) AS value FROM media_content_fingerprints").get() as { value: number }).value;
  }

  contentFingerprintDiagnostics(): NonNullable<RecommendationDiagnostics["features"]["contentFingerprints"]> {
    const projectionSource = normalizeTitle(CONTENT_FINGERPRINT_MOOD_SCORE_SOURCE);
    const totalItems = (this.db.prepare("SELECT COUNT(*) AS value FROM media_items").get() as { value: number }).value;
    const aggregate = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN fingerprint_version = ? THEN 1 ELSE 0 END), 0) AS current,
          COALESCE(SUM(CASE WHEN fingerprint_version != ? THEN 1 ELSE 0 END), 0) AS stale,
          COALESCE(SUM(CASE WHEN json_extract(fingerprint_json, '$.sourceQuality.summary') = 'missing' THEN 1 ELSE 0 END), 0) AS summary_missing,
          COALESCE(SUM(CASE WHEN json_extract(fingerprint_json, '$.sourceQuality.summary') = 'thin' THEN 1 ELSE 0 END), 0) AS summary_thin,
          COALESCE(SUM(CASE WHEN json_extract(fingerprint_json, '$.sourceQuality.genres') = 'missing' THEN 1 ELSE 0 END), 0) AS genre_missing,
          COALESCE(SUM(CASE WHEN json_extract(fingerprint_json, '$.sourceQuality.genres') = 'thin' THEN 1 ELSE 0 END), 0) AS genre_thin,
          COALESCE(SUM(CASE WHEN json_extract(fingerprint_json, '$.sourceQuality.people') = 'missing' THEN 1 ELSE 0 END), 0) AS people_missing,
          COALESCE(SUM(CASE WHEN json_extract(fingerprint_json, '$.sourceQuality.ratings') = 'missing' THEN 1 ELSE 0 END), 0) AS ratings_missing,
          COALESCE(SUM(json_array_length(fingerprint_json, '$.sourceQuality.warnings')), 0) AS warning_count,
          COALESCE(SUM(CASE WHEN fingerprint_json LIKE '%catalog_only_unverified%' THEN 1 ELSE 0 END), 0) AS catalog_only_unverified
         FROM media_content_fingerprints`
      )
      .get(CONTENT_FINGERPRINT_VERSION, CONTENT_FINGERPRINT_VERSION) as {
      total: number;
      current: number;
      stale: number;
      summary_missing: number;
      summary_thin: number;
      genre_missing: number;
      genre_thin: number;
      people_missing: number;
      ratings_missing: number;
      warning_count: number;
      catalog_only_unverified: number;
    };
    const projected = this.db
      .prepare(
        `SELECT COUNT(DISTINCT media_item_id) AS item_count, COUNT(*) AS score_count
         FROM media_mood_feature_scores
         WHERE source = ? AND source_version = ?`
      )
      .get(projectionSource, CONTENT_FINGERPRINT_MOOD_SCORE_VERSION) as { item_count: number; score_count: number };
    return {
      total: aggregate.total,
      current: aggregate.current,
      stale: aggregate.stale,
      missing: Math.max(0, totalItems - aggregate.total),
      projectedItemCount: projected.item_count,
      projectedScoreCount: projected.score_count,
      summaryMissing: aggregate.summary_missing,
      summaryThin: aggregate.summary_thin,
      genreMissing: aggregate.genre_missing,
      genreThin: aggregate.genre_thin,
      peopleMissing: aggregate.people_missing,
      ratingsMissing: aggregate.ratings_missing,
      warningCount: aggregate.warning_count,
      catalogOnlyUnverified: aggregate.catalog_only_unverified
    };
  }

  rebuildContentFingerprints(options: { limit?: number; batchSize?: number; staleOnly?: boolean } = {}): ContentFingerprintRebuildSummary {
    const batchSize = normalizeSqlLimit(options.batchSize ?? 500, 1, 5000);
    const limit = options.limit ? Math.max(1, Math.floor(options.limit)) : undefined;
    const staleOnly = options.staleOnly ?? true;
    const totalLimit = limit ?? Number.POSITIVE_INFINITY;
    let scanned = 0;
    let rebuilt = 0;
    let unchanged = 0;
    let offset = 0;

    while (scanned < totalLimit) {
      const remaining = Math.min(batchSize, totalLimit - scanned);
      const rows = this.contentFingerprintRebuildRows(staleOnly, remaining, staleOnly ? 0 : offset);
      if (rows.length === 0) break;
      const items = this.inflateMany(rows);
      const now = new Date().toISOString();
      this.db.exec("BEGIN");
      try {
        for (const item of items) {
          const changed = this.upsertContentFingerprintForItem(item, now);
          if (changed) rebuilt += 1;
          else unchanged += 1;
        }
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      scanned += rows.length;
      if (!staleOnly) offset += rows.length;
      if (rows.length < remaining) break;
    }

    return { scanned, rebuilt, unchanged, fingerprintVersion: CONTENT_FINGERPRINT_VERSION };
  }

  searchMoodFeatureScores(features: string[], limit = 240): MoodFeatureHit[] {
    const normalizedFeatures = unique(features.map(normalizeMoodFeatureKey));
    if (normalizedFeatures.length === 0) return [];
    const placeholders = normalizedFeatures.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT media_item_id, SUM(feature_score) AS aggregate_score, GROUP_CONCAT(feature) AS matched_features
         FROM (
          SELECT media_item_id, feature, MAX(score * confidence) AS feature_score
          FROM media_mood_feature_scores
          WHERE feature IN (${placeholders})
          GROUP BY media_item_id, feature
         )
         GROUP BY media_item_id
         ORDER BY aggregate_score DESC, media_item_id
         LIMIT ?`
      )
      .all(...normalizedFeatures, limit) as Array<{ media_item_id: string; aggregate_score: number; matched_features?: string }>;
    return rows.map((row) => ({
      mediaItemId: row.media_item_id,
      score: moodFeatureScoreFromAggregate(row.aggregate_score, normalizedFeatures.length),
      matchedFeatures: unique((row.matched_features ?? "").split(","))
    }));
  }

  upsertMoodFeatureScores(
    mediaItemId: string,
    source: string,
    sourceVersion: string,
    scores: MoodFeatureScoreInput[],
    refreshSearchIndex = true
  ) {
    const now = new Date().toISOString();
    const normalizedSource = normalizeTitle(source);
    const normalizedScores = scores
      .map((score) => ({
        feature: normalizeMoodFeatureKey(score.feature),
        score: clampNumber(score.score, 0, 100),
        confidence: clampNumber(score.confidence ?? 1, 0, 1)
      }))
      .filter((score) => score.feature.length > 0 && score.score > 0 && score.confidence > 0);
    const insert = this.db.prepare(
      `INSERT INTO media_mood_feature_scores (
        media_item_id, source, source_version, feature, score, confidence, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(media_item_id, source, feature) DO UPDATE SET
        source_version = excluded.source_version,
        score = excluded.score,
        confidence = excluded.confidence,
        updated_at = excluded.updated_at`
    );
    this.db.exec("SAVEPOINT mood_feature_score_upsert");
    try {
      this.db.prepare("DELETE FROM media_mood_feature_scores WHERE media_item_id = ? AND source = ?").run(mediaItemId, normalizedSource);
      for (const score of normalizedScores) {
        insert.run(mediaItemId, normalizedSource, sourceVersion, score.feature, score.score, score.confidence, now);
      }
      this.db.exec("RELEASE mood_feature_score_upsert");
    } catch (error) {
      this.db.exec("ROLLBACK TO mood_feature_score_upsert");
      this.db.exec("RELEASE mood_feature_score_upsert");
      throw error;
    }
    if (refreshSearchIndex) this.upsertCatalogSearchIndex(mediaItemId, now);
  }

  private upsertCatalogSearchIndex(mediaItemId: string, now = new Date().toISOString(), knownItem?: ItemDetail) {
    const item = knownItem ?? this.findById(mediaItemId);
    if (!item) {
      this.deleteCatalogSearchIndex(mediaItemId);
      return;
    }
    if (item.metadata?.source === "operational") {
      this.deleteCatalogSearchIndex(mediaItemId);
      return;
    }
    const activeCatalogSources = (this.db.prepare("SELECT COUNT(*) AS value FROM catalog_source_records WHERE media_item_id = ? AND active = 1").get(mediaItemId) as {
      value: number;
    }).value;
    const totalCatalogSources = (this.db.prepare("SELECT COUNT(*) AS value FROM catalog_source_records WHERE media_item_id = ?").get(mediaItemId) as { value: number }).value;
    const unverifiedInactiveCatalogOnly =
      item.metadata?.source === "catalog" &&
      totalCatalogSources > 0 &&
      activeCatalogSources === 0 &&
      item.availabilityGroup === "unavailable";
    if (unverifiedInactiveCatalogOnly) {
      this.deleteCatalogSearchIndex(mediaItemId);
      return;
    }

    const feature = this.storedFeatureForItem(mediaItemId);
    const rankScore = this.catalogRankScoreMapByIds([mediaItemId]).get(mediaItemId) ?? 0;
    const searchText = [
      item.title,
      item.summary,
      feature?.featureText,
      catalogMetadataSearchText(item.metadata?.catalog),
      ...item.genres,
      ...item.cast,
      ...item.directors
    ].filter((entry): entry is string => Boolean(entry?.trim())).join(" ");
    const moodText = [
      ...(feature?.moodTerms ?? []),
      ...(feature?.toneTerms ?? []),
      ...(feature?.watchabilityTerms ?? []),
      ...catalogMetadataMoodTerms(item.metadata?.catalog)
    ].join(" ");

    this.db
      .prepare(
        `INSERT INTO catalog_search_index (
          media_item_id, title, media_type, year, source, rank_score, availability_group,
          plex_available, seerr_requestable, has_seerr, has_summary, search_text, mood_text, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(media_item_id) DO UPDATE SET
          title = excluded.title,
          media_type = excluded.media_type,
          year = excluded.year,
          source = excluded.source,
          rank_score = excluded.rank_score,
          availability_group = excluded.availability_group,
          plex_available = excluded.plex_available,
          seerr_requestable = excluded.seerr_requestable,
          has_seerr = excluded.has_seerr,
          has_summary = excluded.has_summary,
          search_text = excluded.search_text,
          mood_text = excluded.mood_text,
          updated_at = excluded.updated_at`
      )
      .run(
        mediaItemId,
        item.title,
        item.mediaType,
        item.year ?? null,
        item.metadata?.source ?? "live",
        rankScore,
        item.availabilityGroup,
        item.plex?.available ? 1 : 0,
        item.seerr?.requestable ? 1 : 0,
        item.seerr ? 1 : 0,
        item.summary?.trim() ? 1 : 0,
        searchText.trim(),
        moodText.trim(),
        now
      );
    this.db.prepare("DELETE FROM catalog_search_index_fts WHERE media_item_id = ?").run(mediaItemId);
    this.db
      .prepare("INSERT INTO catalog_search_index_fts (media_item_id, title, search_text, mood_text) VALUES (?, ?, ?, ?)")
      .run(mediaItemId, item.title, searchText.trim(), moodText.trim());
  }

  private evictPosterCache() {
    const rows = this.db
      .prepare(
        `SELECT media_item_id, byte_size
         FROM poster_cache
         ORDER BY COALESCE(last_accessed_at, fetched_at), fetched_at, media_item_id`
      )
      .all() as Array<{ media_item_id: string; byte_size: number }>;
    let remainingRows = rows.length;
    let remainingBytes = rows.reduce((total, row) => total + Math.max(0, row.byte_size), 0);
    const remove = this.db.prepare("DELETE FROM poster_cache WHERE media_item_id = ?");
    for (const row of rows) {
      if (remainingRows <= posterCacheMaxRows && remainingBytes <= posterCacheMaxBytes) break;
      remove.run(row.media_item_id);
      remainingRows -= 1;
      remainingBytes -= Math.max(0, row.byte_size);
    }
  }

  private deleteCatalogSearchIndex(mediaItemId: string) {
    this.db.prepare("DELETE FROM catalog_search_index WHERE media_item_id = ?").run(mediaItemId);
    this.db.prepare("DELETE FROM catalog_search_index_fts WHERE media_item_id = ?").run(mediaItemId);
  }

  moodFeatureSourceSummaries(): MoodFeatureSourceSummary[] {
    const rows = this.db
      .prepare(
        `SELECT source, source_version, COUNT(DISTINCT media_item_id) AS item_count, COUNT(*) AS score_count, MAX(updated_at) AS updated_at
         FROM media_mood_feature_scores
         GROUP BY source, source_version
         ORDER BY score_count DESC, source`
      )
      .all() as Array<{ source: string; source_version: string; item_count: number; score_count: number; updated_at?: string }>;
    return rows.map((row) => ({
      source: row.source,
      sourceVersion: row.source_version,
      itemCount: row.item_count,
      scoreCount: row.score_count,
      updatedAt: row.updated_at
    }));
  }

  catalogSourceSummaries(): CatalogSourceSummary[] {
    const rows = this.db
      .prepare(
        `SELECT
          r.source,
          r.source_version,
          COUNT(DISTINCT r.media_item_id) AS item_count,
          COUNT(DISTINCT CASE WHEN r.active = 1 THEN r.media_item_id END) AS active_item_count,
          COUNT(DISTINCT CASE WHEN r.active = 0 THEN r.media_item_id END) AS inactive_item_count,
          AVG(s.mainstream_score) AS average_mainstream_score,
          AVG(s.metadata_confidence) AS average_metadata_confidence,
          MAX(r.updated_at) AS updated_at
         FROM catalog_source_records r
         LEFT JOIN catalog_rank_signals s
          ON s.media_item_id = r.media_item_id AND s.source = r.source AND r.active = 1
         GROUP BY r.source, r.source_version
         ORDER BY active_item_count DESC, item_count DESC, r.source`
      )
      .all() as Array<{
      source: string;
      source_version: string;
      item_count: number;
      active_item_count: number;
      inactive_item_count: number;
      average_mainstream_score?: number | null;
      average_metadata_confidence?: number | null;
      updated_at?: string;
    }>;
    return rows.map((row) => ({
      source: row.source,
      sourceVersion: row.source_version,
      itemCount: row.item_count,
      activeItemCount: row.active_item_count,
      inactiveItemCount: row.inactive_item_count,
      averageMainstreamScore: row.average_mainstream_score === null || row.average_mainstream_score === undefined ? undefined : Number(row.average_mainstream_score.toFixed(1)),
      averageMetadataConfidence:
        row.average_metadata_confidence === null || row.average_metadata_confidence === undefined ? undefined : Number(row.average_metadata_confidence.toFixed(3)),
      updatedAt: row.updated_at
    }));
  }

  catalogSourceItemIdsRequiringRefresh(source: string) {
    return this.catalogRefreshRequirement(source).sourceItemIds;
  }

  activeCatalogSourceTypeBindings(source: string) {
    const normalizedSource = normalizeCatalogSource(source);
    const rows = this.db
      .prepare(
        `SELECT r.source_item_id, r.media_item_id, r.source_version, r.last_seen_source_version,
          r.content_hash, r.payload_hash, m.media_type, m.source AS media_source,
          CASE WHEN e.media_item_id = m.id THEN 1 ELSE 0 END AS source_identity_external_id_bound
         FROM catalog_source_records r
         JOIN media_items m ON m.id = r.media_item_id
         LEFT JOIN external_ids e
          ON e.source = 'wikidata'
          AND e.media_type = m.media_type
          AND e.value = r.source_item_id
         WHERE r.source = ? AND r.active = 1
         ORDER BY r.source_item_id`
      )
      .all(normalizedSource) as Array<{
        source_item_id: string;
        media_item_id: string;
        source_version: string;
        last_seen_source_version: string;
        content_hash?: string | null;
        payload_hash?: string | null;
        media_type: MediaType;
        media_source: MediaSource;
        source_identity_external_id_bound: number;
      }>;
    return new Map<string, ActiveCatalogSourceTypeBinding>(rows.map((row) => [
      row.source_item_id,
      {
        mediaItemId: row.media_item_id,
        mediaType: row.media_type,
        mediaSource: row.media_source,
        sourceVersion: row.source_version,
        lastSeenSourceVersion: row.last_seen_source_version,
        payloadHash: row.payload_hash ?? undefined,
        contentHash: row.content_hash ?? undefined,
        sourceIdentityExternalIdBound: row.source_identity_external_id_bound === 1
      }
    ]));
  }

  externalIdsForMediaItems(mediaItemIds: Iterable<string>) {
    const result = new Map<string, CatalogExternalId[]>();
    const select = this.db.prepare(
      `SELECT source, value
       FROM external_ids
       WHERE media_item_id = ?
       ORDER BY source, value`
    );
    for (const mediaItemId of new Set(mediaItemIds)) {
      result.set(mediaItemId, select.all(mediaItemId) as unknown as CatalogExternalId[]);
    }
    return result;
  }

  operationalExternalIdEvidenceForMediaItems(mediaItemIds: Iterable<string>) {
    const result = new Map<string, CatalogExternalId[]>();
    const selectSeerr = this.db.prepare(
      `SELECT tmdb_id, tvdb_id, imdb_id
       FROM seerr_items
       WHERE media_item_id = ?
       ORDER BY id`
    );
    const selectPlex = this.db.prepare(
      `SELECT guid
       FROM plex_items
       WHERE media_item_id = ? AND guid IS NOT NULL AND TRIM(guid) <> ''
       ORDER BY id`
    );
    const selectRequestTmdb = this.db.prepare(
      `SELECT CAST(media_id AS TEXT) AS value
       FROM requests
       WHERE media_item_id = ? AND media_id IS NOT NULL
       UNION
       SELECT CAST(media_id AS TEXT) AS value
       FROM request_audit
       WHERE media_item_id = ? AND media_id IS NOT NULL
       UNION
       SELECT CAST(
         CASE WHEN json_valid(response_json) THEN json_extract(response_json, '$.request.mediaId') END
         AS TEXT
       ) AS value
       FROM request_creation_operations
       WHERE media_item_id = ? AND response_json IS NOT NULL
       ORDER BY value`
    );
    const selectOperationBoundTmdb = this.db.prepare(
      `SELECT DISTINCT e.value
       FROM request_creation_operations o
       JOIN external_ids e ON e.media_item_id = o.media_item_id AND e.source = 'tmdb'
       WHERE o.media_item_id = ?
         AND o.status IN ('pending', 'uncertain')
       ORDER BY e.value`
    );
    for (const mediaItemId of new Set(mediaItemIds)) {
      const evidence = new Map<string, CatalogExternalId>();
      for (const row of selectSeerr.all(mediaItemId) as Array<{
        tmdb_id?: number | null;
        tvdb_id?: number | null;
        imdb_id?: string | null;
      }>) {
        for (const [source, value] of [
          ["tmdb", row.tmdb_id],
          ["tvdb", row.tvdb_id],
          ["imdb", row.imdb_id]
        ] as const) {
          if (value === undefined || value === null || String(value).length === 0) continue;
          const externalId = { source, value: String(value) };
          evidence.set(`${externalId.source}\u0000${externalId.value}`, externalId);
        }
      }
      for (const row of selectPlex.all(mediaItemId) as Array<{ guid: string }>) {
        const externalId = { source: "plex", value: row.guid };
        evidence.set(`${externalId.source}\u0000${externalId.value}`, externalId);
      }
      for (const row of selectRequestTmdb.all(mediaItemId, mediaItemId, mediaItemId) as Array<{ value?: string | null }>) {
        if (!row.value) continue;
        const externalId = { source: "tmdb", value: row.value };
        evidence.set(`${externalId.source}\u0000${externalId.value}`, externalId);
      }
      for (const row of selectOperationBoundTmdb.all(mediaItemId) as Array<{ value: string }>) {
        const externalId = { source: "tmdb", value: row.value };
        evidence.set(`${externalId.source}\u0000${externalId.value}`, externalId);
      }
      result.set(mediaItemId, [...evidence.values()]);
    }
    return result;
  }

  catalogDerivedMaterializationIssueCount(mediaItemIds: Iterable<string>) {
    const uniqueMediaItemIds = new Set(mediaItemIds);
    if (uniqueMediaItemIds.size === 0) return 0;

    type CatalogSearchFtsSnapshot = {
      title: string;
      search_text: string;
      mood_text: string;
      count: number;
    };
    const catalogSearchFtsByMediaItemId = new Map<string, CatalogSearchFtsSnapshot>();
    const catalogSearchFtsRows = this.db
      .prepare(
        `SELECT media_item_id, title, search_text, mood_text
         FROM catalog_search_index_fts
         ORDER BY rowid`
      )
      .iterate() as IterableIterator<{
        media_item_id: string;
        title: string;
        search_text: string;
        mood_text: string;
      }>;
    for (const row of catalogSearchFtsRows) {
      if (!uniqueMediaItemIds.has(row.media_item_id)) continue;
      const existing = catalogSearchFtsByMediaItemId.get(row.media_item_id);
      if (existing) {
        existing.count += 1;
      } else {
        catalogSearchFtsByMediaItemId.set(row.media_item_id, {
          title: row.title,
          search_text: row.search_text,
          mood_text: row.mood_text,
          count: 1
        });
      }
    }

    const mediaFeatureFtsCountByMediaItemId = new Map<string, number>();
    const mediaFeatureFtsRows = this.db
      .prepare("SELECT media_item_id FROM media_feature_fts ORDER BY rowid")
      .iterate() as IterableIterator<{ media_item_id: string }>;
    for (const row of mediaFeatureFtsRows) {
      if (!uniqueMediaItemIds.has(row.media_item_id)) continue;
      mediaFeatureFtsCountByMediaItemId.set(
        row.media_item_id,
        (mediaFeatureFtsCountByMediaItemId.get(row.media_item_id) ?? 0) + 1
      );
    }

    const select = this.db.prepare(
      `SELECT m.source, m.media_type, m.title, m.year,
        i.media_type AS indexed_media_type, i.title AS indexed_title, i.year AS indexed_year,
        i.source AS indexed_source, i.search_text AS indexed_search_text, i.mood_text AS indexed_mood_text,
        (SELECT COUNT(*) FROM genres g WHERE g.media_item_id = m.id)
          + (SELECT COUNT(*) FROM media_features mf WHERE mf.media_item_id = m.id)
          + (SELECT COUNT(*) FROM media_embeddings me WHERE me.media_item_id = m.id)
          + (SELECT COUNT(*) FROM media_mood_feature_scores ms WHERE ms.media_item_id = m.id)
          + (SELECT COUNT(*) FROM media_content_fingerprints cf WHERE cf.media_item_id = m.id)
          + (SELECT COUNT(*) FROM catalog_search_index ci WHERE ci.media_item_id = m.id)
          + (SELECT COUNT(*) FROM poster_cache pc WHERE pc.media_item_id = m.id) AS strict_derived_rows,
        CASE WHEN mf.media_item_id IS NULL THEN 0 ELSE 1 END AS has_media_features,
        CASE WHEN ms.media_item_id IS NULL THEN 0 ELSE 1 END AS has_mood_scores,
        CASE WHEN cf.media_item_id IS NULL THEN 0 ELSE 1 END AS has_content_fingerprint,
        (SELECT COUNT(*) FROM poster_cache pc WHERE pc.media_item_id = m.id) AS poster_rows,
        (SELECT COUNT(*) FROM media_embeddings me WHERE me.media_item_id = m.id) AS provider_embedding_rows
       FROM media_items m
       LEFT JOIN catalog_search_index i ON i.media_item_id = m.id
       LEFT JOIN media_features mf ON mf.media_item_id = m.id
       LEFT JOIN media_mood_feature_scores ms ON ms.media_item_id = m.id
       LEFT JOIN media_content_fingerprints cf ON cf.media_item_id = m.id
       WHERE m.id = ?`
    );
    let issues = 0;
    for (const mediaItemId of uniqueMediaItemIds) {
      const catalogSearchFts = catalogSearchFtsByMediaItemId.get(mediaItemId);
      const mediaFeatureFtsCount = mediaFeatureFtsCountByMediaItemId.get(mediaItemId) ?? 0;
      const row = select.get(mediaItemId) as {
        source: MediaSource;
        media_type: MediaType;
        title: string;
        year?: number | null;
        indexed_media_type?: MediaType | null;
        indexed_title?: string | null;
        indexed_year?: number | null;
        indexed_source?: MediaSource | null;
        indexed_search_text?: string | null;
        indexed_mood_text?: string | null;
        strict_derived_rows: number;
        has_media_features: number;
        has_mood_scores: number;
        has_content_fingerprint: number;
        poster_rows: number;
        provider_embedding_rows: number;
      } | undefined;
      if (!row) {
        issues += 1;
      } else if (row.source === "operational") {
        if (row.strict_derived_rows + (catalogSearchFts?.count ?? 0) + mediaFeatureFtsCount !== 0) issues += 1;
      } else if (
        !row.indexed_media_type
        || row.indexed_media_type !== row.media_type
        || row.indexed_title !== row.title
        || (row.indexed_year ?? null) !== (row.year ?? null)
        || row.indexed_source !== row.source
        || catalogSearchFts?.title !== row.indexed_title
        || catalogSearchFts?.search_text !== row.indexed_search_text
        || catalogSearchFts?.mood_text !== row.indexed_mood_text
        || !catalogSearchFts
        || row.has_media_features !== 1
        || mediaFeatureFtsCount === 0
        || row.has_mood_scores !== 1
        || row.has_content_fingerprint !== 1
      ) {
        issues += 1;
      } else if (row.source === "catalog" && (row.poster_rows !== 0 || row.provider_embedding_rows !== 0)) {
        issues += 1;
      }
    }
    return issues;
  }

  catalogRefreshRequirement(source: string) {
    const normalizedSource = normalizeCatalogSource(source);
    const rows = this.db
      .prepare(
        `SELECT r.source_item_id, r.media_item_id
         FROM catalog_source_records r
         JOIN media_items m ON m.id = r.media_item_id
         WHERE r.source = ?
          AND r.active = 1
          AND (r.materialization_stale = 1 OR m.source = 'operational')
         ORDER BY r.source_item_id`
      )
      .all(normalizedSource) as Array<{ source_item_id: string; media_item_id: string }>;
    return {
      sourceItemIds: new Set(rows.map((row) => row.source_item_id)),
      mediaItemCount: new Set(rows.map((row) => row.media_item_id)).size
    };
  }

  catalogDiagnostics(): NonNullable<RecommendationDiagnostics["features"]["catalog"]> {
    const one = <T>(sql: string, ...values: Array<string | number | null>) => (this.db.prepare(sql).get(...values) as { value: T }).value;
    const now = new Date().toISOString();
    const latestRun = this.db
      .prepare(
        `SELECT source, source_version, status, update_mode, item_count, changed_source_records, unchanged_source_records,
          inactive_source_records, finished_at, error
         FROM catalog_sync_runs
         ORDER BY id DESC
         LIMIT 1`
      )
      .get() as
      | {
          source: string;
          source_version: string;
          status: string;
          update_mode?: string;
          item_count: number;
          changed_source_records?: number;
          unchanged_source_records?: number;
          inactive_source_records?: number;
          finished_at?: string | null;
          error?: string | null;
        }
      | undefined;
    const verificationCandidates = this.catalogVerificationCandidates(8).map((item) => ({
      id: item.id,
      mediaType: item.mediaType,
      title: item.title,
      year: item.year,
      catalogSourceCount: item.metadata?.catalogSourceCount,
      hasSummary: Boolean(item.summary?.trim())
    }));
    return {
      totalCatalogItems: one<number>("SELECT COUNT(DISTINCT media_item_id) AS value FROM catalog_source_records"),
      activeCatalogItems: one<number>("SELECT COUNT(DISTINCT media_item_id) AS value FROM catalog_source_records WHERE active = 1"),
      inactiveCatalogItems: one<number>("SELECT COUNT(DISTINCT media_item_id) AS value FROM catalog_source_records WHERE active = 0"),
      catalogOnlyItems: one<number>(
        `SELECT COUNT(DISTINCT r.media_item_id) AS value
         FROM catalog_source_records r
         LEFT JOIN plex_items p ON p.media_item_id = r.media_item_id AND p.available = 1
         LEFT JOIN seerr_items s ON s.media_item_id = r.media_item_id
         WHERE r.active = 1
          AND p.media_item_id IS NULL
          AND s.media_item_id IS NULL`
      ),
      plexVerifiedItems: one<number>(
        `SELECT COUNT(DISTINCT r.media_item_id) AS value
         FROM catalog_source_records r
         JOIN plex_items p ON p.media_item_id = r.media_item_id AND p.available = 1
         WHERE r.active = 1`
      ),
      seerrVerifiedItems: one<number>(
        `SELECT COUNT(DISTINCT r.media_item_id) AS value
         FROM catalog_source_records r
         JOIN seerr_items s ON s.media_item_id = r.media_item_id
         WHERE r.active = 1`
      ),
      requestableVerifiedItems: one<number>(
        `SELECT COUNT(DISTINCT r.media_item_id) AS value
         FROM catalog_source_records r
         JOIN seerr_items s ON s.media_item_id = r.media_item_id AND s.requestable = 1
         WHERE r.active = 1`
      ),
      trustedRefreshRequiredItems: one<number>(
        `SELECT COUNT(DISTINCT m.id) AS value
         FROM media_items m
         WHERE EXISTS (
            SELECT 1 FROM catalog_source_records r
            WHERE r.media_item_id = m.id
              AND r.active = 1
              AND (m.source = 'operational' OR r.materialization_stale = 1)
          )
          OR (
            m.source = 'operational'
            AND EXISTS (
              SELECT 1 FROM plex_items p
              WHERE p.media_item_id = m.id AND p.available = 1
            )
          )`
      ),
      requestableTrustedRefreshRequiredItems: one<number>(
        `SELECT COUNT(DISTINCT m.id) AS value
         FROM media_items m
         JOIN seerr_items s ON s.media_item_id = m.id AND s.requestable = 1
         WHERE EXISTS (
            SELECT 1 FROM catalog_source_records r
            WHERE r.media_item_id = m.id
              AND r.active = 1
              AND (m.source = 'operational' OR r.materialization_stale = 1)
          )
          OR (
            m.source = 'operational'
            AND EXISTS (
              SELECT 1 FROM plex_items p
              WHERE p.media_item_id = m.id AND p.available = 1
            )
          )`
      ),
      catalogRefreshRequiredItems: one<number>(
        `SELECT COUNT(DISTINCT m.id) AS value
         FROM media_items m
         JOIN catalog_source_records r ON r.media_item_id = m.id AND r.active = 1
         WHERE m.source = 'operational'
            OR r.materialization_stale = 1`
      ),
      plexRefreshRequiredItems: one<number>(
        `SELECT COUNT(DISTINCT m.id) AS value
         FROM media_items m
         JOIN plex_items p ON p.media_item_id = m.id AND p.available = 1
         WHERE m.source = 'operational'`
      ),
      operationalOnlyItems: one<number>(
        `SELECT COUNT(DISTINCT m.id) AS value
         FROM media_items m
         JOIN seerr_items s ON s.media_item_id = m.id
         WHERE m.source = 'operational'
          AND NOT EXISTS (
            SELECT 1 FROM catalog_source_records r
            WHERE r.media_item_id = m.id AND r.active = 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM plex_items p
            WHERE p.media_item_id = m.id AND p.available = 1
          )`
      ),
      requestableOperationalOnlyItems: one<number>(
        `SELECT COUNT(DISTINCT m.id) AS value
         FROM media_items m
         JOIN seerr_items s ON s.media_item_id = m.id AND s.requestable = 1
         WHERE m.source = 'operational'
          AND NOT EXISTS (
            SELECT 1 FROM catalog_source_records r
            WHERE r.media_item_id = m.id AND r.active = 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM plex_items p
            WHERE p.media_item_id = m.id AND p.available = 1
          )`
      ),
      staleSourceRecords: one<number>("SELECT COUNT(*) AS value FROM catalog_source_records WHERE active = 1 AND expires_at IS NOT NULL AND expires_at < ?", now),
      rankSignalItems: one<number>(
        `SELECT COUNT(DISTINCT s.media_item_id) AS value
         FROM catalog_rank_signals s
         JOIN catalog_source_records r ON r.media_item_id = s.media_item_id AND r.source = s.source
         WHERE r.active = 1`
      ),
      featureIndexedItems: one<number>(
        `SELECT COUNT(DISTINCT r.media_item_id) AS value
         FROM catalog_source_records r
         JOIN media_features f ON f.media_item_id = r.media_item_id
         WHERE r.active = 1`
      ),
      moodIndexedItems: one<number>(
        `SELECT COUNT(DISTINCT r.media_item_id) AS value
         FROM catalog_source_records r
         JOIN media_mood_feature_scores s ON s.media_item_id = r.media_item_id
         WHERE r.active = 1`
      ),
      rankedSearchReadyItems: one<number>(
        `SELECT COUNT(*) AS value
         FROM catalog_search_index i
         JOIN media_features f ON f.media_item_id = i.media_item_id
         JOIN (
           SELECT DISTINCT media_item_id
           FROM media_mood_feature_scores
         ) m ON m.media_item_id = i.media_item_id
         WHERE i.has_summary = 1
          AND EXISTS (
            SELECT 1
            FROM catalog_rank_signals s
            JOIN catalog_source_records r
              ON r.media_item_id = s.media_item_id AND r.source = s.source
            WHERE s.media_item_id = i.media_item_id
              AND r.active = 1
              AND s.mainstream_score > 0
              AND s.metadata_confidence >= 0.35
          )`
      ),
      latestRun: latestRun
        ? {
            source: latestRun.source,
            sourceVersion: latestRun.source_version,
            status: latestRun.status,
            updateMode: latestRun.update_mode,
            itemCount: latestRun.item_count,
            changedSourceRecords: latestRun.changed_source_records,
            unchangedSourceRecords: latestRun.unchanged_source_records,
            inactiveSourceRecords: latestRun.inactive_source_records,
            finishedAt: latestRun.finished_at ?? undefined,
            ageSeconds: latestRun.finished_at ? Math.max(0, Math.floor((Date.parse(now) - Date.parse(latestRun.finished_at)) / 1000)) : undefined,
            error: latestRun.error ?? undefined
          }
        : undefined,
      verificationCandidateCount: verificationCandidates.length,
      verificationCandidates
    };
  }

  catalogRankScoreMap(): Map<string, number> {
    const rows = this.db
      .prepare(
        `SELECT s.media_item_id, MAX(s.mainstream_score * s.metadata_confidence) AS score
         FROM catalog_rank_signals s
         JOIN catalog_source_records r ON r.media_item_id = s.media_item_id AND r.source = s.source
         WHERE r.active = 1
         GROUP BY s.media_item_id`
      )
      .all() as Array<{ media_item_id: string; score: number }>;
    return new Map(rows.map((row) => [row.media_item_id, clampNumber(row.score, 0, 100)]));
  }

  rebuildCatalogSearchIndex() {
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM catalog_search_index").run();
      this.db.prepare("DELETE FROM catalog_search_index_fts").run();
      this.db
        .prepare(
          `INSERT INTO catalog_search_index (
            media_item_id, title, media_type, year, source, rank_score, availability_group,
            plex_available, seerr_requestable, has_seerr, has_summary, search_text, mood_text, updated_at
          )
          WITH active_rank AS (
            SELECT s.media_item_id, MAX(s.mainstream_score * s.metadata_confidence) AS rank_score
            FROM catalog_rank_signals s
            JOIN catalog_source_records r ON r.media_item_id = s.media_item_id AND r.source = s.source
            WHERE r.active = 1
            GROUP BY s.media_item_id
          ),
          catalog_terms AS (
            SELECT
              r.media_item_id,
              GROUP_CONCAT(r.source, ' ') AS source_text,
              GROUP_CONCAT(r.metadata_json, ' ') AS metadata_text,
              MAX(s.mainstream_score) AS mainstream_score,
              MAX(s.award_count) AS award_count
            FROM catalog_source_records r
            LEFT JOIN catalog_rank_signals s ON s.media_item_id = r.media_item_id AND s.source = r.source
            WHERE r.active = 1
            GROUP BY r.media_item_id
          ),
          plex_status AS (
            SELECT media_item_id, MAX(available) AS available
            FROM plex_items
            GROUP BY media_item_id
          ),
          seerr_status AS (
            SELECT
              media_item_id,
              MAX(requestable) AS requestable,
              MAX(CASE WHEN status = 'partially_available' THEN 1 ELSE 0 END) AS partially_available,
              MAX(CASE WHEN request_status IS NOT NULL OR status IN ('requested', 'pending', 'approved', 'processing') THEN 1 ELSE 0 END) AS already_requested,
              COUNT(*) AS seerr_count
            FROM seerr_items
            GROUP BY media_item_id
          )
          SELECT
            m.id,
            m.title,
            m.media_type,
            m.year,
            m.source,
            COALESCE(active_rank.rank_score, 0),
            CASE
              WHEN COALESCE(plex_status.available, 0) = 1 THEN 'available_in_plex'
              WHEN COALESCE(seerr_status.partially_available, 0) = 1 THEN 'partially_available'
              WHEN COALESCE(seerr_status.already_requested, 0) = 1 THEN 'already_requested'
              WHEN COALESCE(seerr_status.requestable, 0) = 1 THEN 'not_in_plex_requestable'
              ELSE 'unavailable'
            END,
            COALESCE(plex_status.available, 0),
            COALESCE(seerr_status.requestable, 0),
            CASE WHEN COALESCE(seerr_status.seerr_count, 0) > 0 THEN 1 ELSE 0 END,
            CASE WHEN m.summary IS NOT NULL AND m.summary != '' THEN 1 ELSE 0 END,
            trim(
              COALESCE(m.title, '') || ' ' ||
              COALESCE(m.summary, '') || ' ' ||
              COALESCE(f.feature_text, '') || ' ' ||
              COALESCE(catalog_terms.source_text, '') || ' ' ||
              COALESCE(catalog_terms.metadata_text, '') || ' ' ||
              CASE WHEN COALESCE(catalog_terms.mainstream_score, 0) >= 76 THEN 'mainstream friendly popular recognizable' ELSE '' END || ' ' ||
              CASE WHEN COALESCE(catalog_terms.award_count, 0) >= 2 THEN 'award recognized acclaimed' ELSE '' END
            ),
            trim(
              COALESCE(f.mood_terms_json, '') || ' ' ||
              COALESCE(f.tone_terms_json, '') || ' ' ||
              COALESCE(f.watchability_terms_json, '') || ' ' ||
              CASE WHEN COALESCE(catalog_terms.mainstream_score, 0) >= 76 THEN 'mainstream-friendly recognizable' ELSE '' END || ' ' ||
              CASE WHEN COALESCE(catalog_terms.award_count, 0) >= 2 THEN 'award-recognized' ELSE '' END
            ),
            ?
          FROM media_items m
          LEFT JOIN media_features f ON f.media_item_id = m.id
          LEFT JOIN active_rank ON active_rank.media_item_id = m.id
          LEFT JOIN catalog_terms ON catalog_terms.media_item_id = m.id
          LEFT JOIN plex_status ON plex_status.media_item_id = m.id
          LEFT JOIN seerr_status ON seerr_status.media_item_id = m.id
          WHERE m.source != 'operational'`
        )
        .run(now);
      this.db
        .prepare(
          `INSERT INTO catalog_search_index_fts (media_item_id, title, search_text, mood_text)
           SELECT media_item_id, title, search_text, mood_text
           FROM catalog_search_index`
        )
        .run();
      const count = (this.db.prepare("SELECT COUNT(*) AS value FROM catalog_search_index").get() as { value: number }).value;
      this.db.exec("COMMIT");
      return count;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  catalogRankScoreMapByIds(ids: string[]): Map<string, number> {
    const uniqueIds = unique(ids).slice(0, recommendationCandidateLimit);
    if (uniqueIds.length === 0) return new Map();
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT s.media_item_id, MAX(s.mainstream_score * s.metadata_confidence) AS score
         FROM catalog_rank_signals s
         JOIN catalog_source_records r ON r.media_item_id = s.media_item_id AND r.source = s.source
         WHERE r.active = 1
          AND s.media_item_id IN (${placeholders})
         GROUP BY s.media_item_id`
      )
      .all(...uniqueIds) as Array<{ media_item_id: string; score: number }>;
    return new Map(rows.map((row) => [row.media_item_id, clampNumber(row.score, 0, 100)]));
  }

  catalogSearchCandidateIds(query: string, filters: SearchFilters = {}, limit = 240): string[] {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return this.catalogRankCandidateIds(filters, limit);
    const normalizedLimit = normalizeSqlLimit(limit, 1, recommendationCandidateLimit);
    const { where, values } = catalogSearchFilterClause(filters, "i");
    const rows = this.db
      .prepare(
        `SELECT i.media_item_id, bm25(catalog_search_index_fts) AS rank
         FROM catalog_search_index_fts
         JOIN catalog_search_index i ON i.media_item_id = catalog_search_index_fts.media_item_id
         WHERE catalog_search_index_fts MATCH ?
         ${where}
         ORDER BY rank, i.rank_score DESC, i.title, i.media_item_id
         LIMIT ?`
      )
      .all(ftsQuery, ...values, normalizedLimit) as Array<{ media_item_id: string }>;
    return rows.map((row) => row.media_item_id);
  }

  catalogRankCandidateIds(filters: SearchFilters = {}, limit = 240): string[] {
    const normalizedLimit = normalizeSqlLimit(limit, 1, recommendationCandidateLimit);
    const { where, values } = catalogSearchFilterClause(filters, "i");
    const indexHint = filters.availability?.length && !filters.availability.includes("unavailable")
      ? "INDEXED BY idx_catalog_search_index_availability_rank"
      : "INDEXED BY idx_catalog_search_index_summary_rank";
    const rows = this.db
      .prepare(
        `SELECT i.media_item_id
         FROM catalog_search_index i ${indexHint}
         WHERE i.has_summary = 1
         ${where}
         ORDER BY i.rank_score DESC, i.title, i.media_item_id
         LIMIT ?`
      )
      .all(...values, normalizedLimit) as Array<{ media_item_id: string }>;
    return rows.map((row) => row.media_item_id);
  }

  availabilityCandidateIds(groups: AvailabilityGroup[], filters: SearchFilters = {}, limit = 120): string[] {
    const normalizedGroups = groups.filter(isAvailabilityGroup);
    if (normalizedGroups.length === 0) return [];
    const normalizedLimit = normalizeSqlLimit(limit, 1, recommendationCandidateLimit);
    const groupPlaceholders = normalizedGroups.map(() => "?").join(", ");
    const { where, values } = catalogSearchFilterClause({ ...filters, availability: undefined }, "i");
    const rows = this.db
      .prepare(
        `SELECT i.media_item_id
         FROM catalog_search_index i
         WHERE i.availability_group IN (${groupPlaceholders})
         ${where}
         ORDER BY i.rank_score DESC, i.title, i.media_item_id
         LIMIT ?`
      )
      .all(...normalizedGroups, ...values, normalizedLimit) as Array<{ media_item_id: string }>;
    return rows.map((row) => row.media_item_id);
  }

  filteredCandidateIds(filters: SearchFilters = {}, limit = 160, options: { requireSummary?: boolean } = {}): string[] {
    if (!hasSelectiveSearchFilters(filters)) return [];
    const normalizedLimit = normalizeSqlLimit(limit, 1, recommendationCandidateLimit);
    const clauses: string[] = [];
    const values: Array<string | number> = [];

    if (options.requireSummary) clauses.push("i.has_summary = 1");

    if (filters.mediaTypes?.length) {
      clauses.push(`i.media_type IN (${filters.mediaTypes.map(() => "?").join(", ")})`);
      values.push(...filters.mediaTypes);
    }
    if (typeof filters.minRuntimeMinutes === "number") {
      clauses.push("m.runtime_minutes >= ?");
      values.push(filters.minRuntimeMinutes);
    }
    if (typeof filters.maxRuntimeMinutes === "number") {
      clauses.push("m.runtime_minutes <= ?");
      values.push(filters.maxRuntimeMinutes);
    }
    if (typeof filters.minYear === "number") {
      clauses.push("(i.year IS NULL OR i.year >= ?)");
      values.push(filters.minYear);
    }
    if (typeof filters.maxYear === "number") {
      clauses.push("(i.year IS NULL OR i.year <= ?)");
      values.push(filters.maxYear);
    }
    if (filters.contentRating) {
      clauses.push("m.content_rating = ?");
      values.push(filters.contentRating);
    }
    if (filters.availability?.length) {
      clauses.push(`i.availability_group IN (${filters.availability.map(() => "?").join(", ")})`);
      values.push(...filters.availability);
    }
    if (filters.requestStatus?.length) {
      clauses.push(`i.media_item_id IN (
        SELECT se.media_item_id
        FROM seerr_items se
        WHERE se.request_status IN (${filters.requestStatus.map(() => "?").join(", ")})
      )`);
      values.push(...filters.requestStatus);
    }
    if (filters.genres?.length) {
      clauses.push(`EXISTS (
        SELECT 1
        FROM genres g
        WHERE g.media_item_id = i.media_item_id
         AND lower(g.name) IN (${filters.genres.map(() => "?").join(", ")})
      )`);
      values.push(...filters.genres.map((genre) => genre.toLowerCase()));
    }
    for (const genre of filters.excludedGenres ?? []) {
      clauses.push("NOT EXISTS (SELECT 1 FROM genres g WHERE g.media_item_id = i.media_item_id AND lower(g.name) = lower(?))");
      values.push(genre);
    }

    const rows = this.db
      .prepare(
        `SELECT i.media_item_id
         FROM catalog_search_index i ${options.requireSummary ? "INDEXED BY idx_catalog_search_index_summary_rank" : ""}
         JOIN media_items m ON m.id = i.media_item_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY i.rank_score DESC, i.title, i.media_item_id
         LIMIT ?`
      )
      .all(...values, normalizedLimit) as Array<{ media_item_id: string }>;
    return rows.map((row) => row.media_item_id);
  }

  findReferenceIdsByTitle(titles: string[], limit = 40): string[] {
    const ids = new Set<string>();
    for (const title of unique(titles).slice(0, 8)) {
      const normalizedTitle = normalizeTitle(title);
      if (!normalizedTitle) continue;
      const rows = this.db
        .prepare(
          `SELECT id
           FROM media_items
           WHERE normalized_title = ?
              OR normalized_title LIKE ?
           ORDER BY CASE WHEN normalized_title = ? THEN 0 ELSE 1 END, title, id
           LIMIT ?`
        )
        .all(normalizedTitle, `%${normalizedTitle}%`, normalizedTitle, Math.max(1, Math.min(limit, 40))) as Array<{ id: string }>;
      for (const row of rows) ids.add(row.id);
    }
    return [...ids].slice(0, limit);
  }

  catalogVerificationCandidates(limit = 8): ItemDetail[] {
    const normalizedLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `SELECT m.*
         FROM catalog_search_index i
         JOIN media_items m ON m.id = i.media_item_id
         WHERE i.availability_group = 'unavailable'
          AND i.has_summary = 1
          AND EXISTS (
            SELECT 1 FROM catalog_source_records r
            WHERE r.media_item_id = i.media_item_id AND r.active = 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM plex_items p
            WHERE p.media_item_id = i.media_item_id AND p.available = 1
          )
          AND NOT EXISTS (
            SELECT 1 FROM seerr_items se
            WHERE se.media_item_id = i.media_item_id
          )
         ORDER BY i.rank_score DESC, i.title, i.media_item_id
         LIMIT ?`
      )
      .all(normalizedLimit) as unknown as MediaRow[];
    return rows.map((row) => this.inflate(row));
  }

  searchFeatureIds(query: string, limit = 120): FeatureSearchHit[] {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];
    const rows = this.db
      .prepare(
        `SELECT media_item_id, bm25(media_feature_fts) AS rank
         FROM media_feature_fts
         WHERE media_feature_fts MATCH ?
         ORDER BY rank, media_item_id
         LIMIT ?`
      )
      .all(ftsQuery, limit) as Array<{ media_item_id: string; rank: number }>;
    return rows.map((row) => ({ mediaItemId: row.media_item_id, rank: row.rank }));
  }

  providerEmbeddingMapByIds(provider: string, model: string, dimensions: number, ids: string[]): Map<string, StoredProviderEmbedding> {
    const uniqueIds = unique(ids).slice(0, recommendationCandidateLimit);
    if (uniqueIds.length === 0) return new Map();
    const placeholders = uniqueIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT e.media_item_id, e.provider, e.model, e.dimensions, e.vector_json, e.updated_at
         FROM media_embeddings e
         JOIN media_features f ON f.media_item_id = e.media_item_id
         WHERE e.provider = ? AND e.model = ? AND e.dimensions = ?
          AND e.feature_version = f.feature_version
          AND e.input_hash = moodarr_sha256(f.feature_text)
          AND e.updated_at >= f.updated_at
          AND e.media_item_id IN (${placeholders})`
      )
      .all(provider, model, dimensions, ...uniqueIds) as Array<{
      media_item_id: string;
      provider: string;
      model: string;
      dimensions: number;
      vector_json: string;
      updated_at: string;
    }>;
    return new Map(
      rows.flatMap((row) => {
        const vector = parseNumberArray(row.vector_json);
        return isUsableEmbeddingVector(vector, dimensions)
          ? [
              [
                row.media_item_id,
                {
                  mediaItemId: row.media_item_id,
                  provider: row.provider,
                  model: row.model,
                  dimensions: row.dimensions,
                  vector,
                  updatedAt: row.updated_at
                }
              ] as const
            ]
          : [];
      })
    );
  }

  missingProviderEmbeddingInputs(provider: string, model: string, dimensions: number, limit = 240): ProviderEmbeddingInput[] {
    const normalizedLimit = normalizeSqlLimit(limit, 1, 2_000);
    const rows = this.db
      .prepare(
        `SELECT f.media_item_id, f.feature_text, f.feature_version, e.input_hash, e.feature_version AS embedding_feature_version
         FROM media_features f
         LEFT JOIN media_embeddings e
          ON e.media_item_id = f.media_item_id AND e.provider = ? AND e.model = ?
         WHERE e.media_item_id IS NULL
            OR e.dimensions != ?
            OR NOT (${usableEmbeddingVectorSql("e")})
            OR e.feature_version != f.feature_version
            OR e.input_hash != moodarr_sha256(f.feature_text)
            OR e.updated_at < f.updated_at
         ORDER BY CASE WHEN e.media_item_id IS NULL THEN 1 ELSE 0 END, f.updated_at DESC
         LIMIT ?`
      )
      .all(provider, model, dimensions, normalizedLimit) as Array<{
      media_item_id: string;
      feature_text: string;
      feature_version: string;
      input_hash?: string;
      embedding_feature_version?: string;
    }>;
    return rows.map((row) => ({
        mediaItemId: row.media_item_id,
        featureText: row.feature_text,
        featureVersion: row.feature_version,
        inputHash: hashText(row.feature_text)
      }));
  }

  providerEmbeddingCount(provider: string, model: string, dimensions: number) {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS value
           FROM media_embeddings e
           JOIN media_features f ON f.media_item_id = e.media_item_id
           WHERE e.provider = ? AND e.model = ? AND e.dimensions = ?
            AND ${usableEmbeddingVectorSql("e")}
            AND e.feature_version = f.feature_version
            AND e.input_hash = moodarr_sha256(f.feature_text)
            AND e.updated_at >= f.updated_at`
        )
        .get(provider, model, dimensions) as { value: number }
    ).value;
  }

  providerEmbeddingStaleCount(provider: string, model: string, dimensions: number) {
    return (
      this.db
        .prepare(
          `SELECT COUNT(*) AS value
           FROM media_embeddings e
           LEFT JOIN media_features f ON f.media_item_id = e.media_item_id
           WHERE e.provider = ? AND e.model = ?
            AND NOT (
              e.dimensions = ?
              AND ${usableEmbeddingVectorSql("e")}
              AND f.media_item_id IS NOT NULL
              AND e.feature_version = f.feature_version
              AND e.input_hash = moodarr_sha256(f.feature_text)
              AND e.updated_at >= f.updated_at
            )`
        )
        .get(provider, model, dimensions) as { value: number }
    ).value;
  }

  pruneProviderEmbeddings(provider: string, model: string, dimensions: number, maxRows: number) {
    this.db.prepare("DELETE FROM media_embeddings WHERE provider != ? OR model != ?").run(provider, model);
    const normalizedMaxRows = Math.max(0, Math.floor(maxRows));
    const result = this.db
      .prepare(
        `DELETE FROM media_embeddings
         WHERE provider = ? AND model = ?
          AND media_item_id NOT IN (
            SELECT media_item_id
            FROM media_embeddings
            WHERE provider = ? AND model = ?
            ORDER BY CASE WHEN dimensions = ? AND ${usableEmbeddingVectorSql("media_embeddings")}
              AND EXISTS (
                SELECT 1 FROM media_features f
                WHERE f.media_item_id = media_embeddings.media_item_id
                  AND f.feature_version = media_embeddings.feature_version
                  AND media_embeddings.input_hash = moodarr_sha256(f.feature_text)
                  AND media_embeddings.updated_at >= f.updated_at
              ) THEN 0 ELSE 1 END,
              updated_at DESC, media_item_id
            LIMIT ?
          )`
      )
      .run(provider, model, provider, model, dimensions, normalizedMaxRows);
    return Number(result.changes);
  }

  upsertProviderEmbeddings(provider: string, model: string, dimensions: number, inputs: ProviderEmbeddingInput[], vectors: number[][]) {
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT INTO media_embeddings (
        media_item_id, provider, model, feature_version, input_hash, dimensions, vector_json, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(media_item_id, provider, model) DO UPDATE SET
        feature_version = excluded.feature_version,
        input_hash = excluded.input_hash,
        dimensions = excluded.dimensions,
        vector_json = excluded.vector_json,
        updated_at = excluded.updated_at`
    );
    this.db.exec("BEGIN");
    try {
      inputs.forEach((input, index) => {
        const vector = vectors[index] ?? [];
        if (isUsableEmbeddingVector(vector, dimensions)) {
          insert.run(input.mediaItemId, provider, model, input.featureVersion, input.inputHash, dimensions, JSON.stringify(vector), now);
        }
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  preferenceWeights(watchContext: WatchContext, authUserId?: string): Map<string, number> {
    const profileId = preferenceProfileId(watchContext, authUserId);
    const rows = this.db.prepare("SELECT feature, weight FROM preference_feature_weights WHERE profile_id = ?").all(profileId) as Array<{
      feature: string;
      weight: number;
    }>;
    return new Map(rows.map((row) => [row.feature, row.weight]));
  }

  feelProfile(watchContext: WatchContext, authUserId?: string): FeelProfileResponse {
    const profileId = preferenceProfileId(watchContext, authUserId);
    const rows = this.db
      .prepare(
        `SELECT profile_id, watch_context, term, feature_weights_json, confidence, evidence_count,
          positive_count, negative_count, positive_weight, negative_weight, effective_evidence, conflict_score,
          version, updated_at
         FROM feel_profile_terms
         WHERE profile_id = ?
         ORDER BY confidence DESC, evidence_count DESC, updated_at DESC, term
         LIMIT 80`
      )
      .all(profileId) as unknown as FeelProfileTermRow[];
    return {
      id: profileId,
      label: watchContext === "group" ? "Together" : "For Me",
      watchContext,
      terms: rows.map(inflateFeelProfileTerm)
    };
  }

  feelProfiles(authUserId?: string): Record<WatchContext, FeelProfileResponse> {
    return {
      solo: this.feelProfile("solo", authUserId),
      group: this.feelProfile("group")
    };
  }

  resetFeelProfile(watchContext?: WatchContext, term?: string, authUserId?: string): FeelProfileResetResponse {
    const normalizedTerm = cleanShortText(term, 80, true);
    let termResult: { changes: number | bigint };
    let checkpointResult: { changes: number | bigint };
    if (authUserId) {
      const profileId = preferenceProfileId("solo", authUserId);
      if (normalizedTerm) {
        termResult = this.db.prepare("DELETE FROM feel_profile_terms WHERE profile_id = ? AND term = ?").run(profileId, normalizedTerm);
        checkpointResult = this.db.prepare("DELETE FROM feel_profile_checkpoints WHERE profile_id = ? AND term = ?").run(profileId, normalizedTerm);
      } else {
        termResult = this.db.prepare("DELETE FROM feel_profile_terms WHERE profile_id = ?").run(profileId);
        checkpointResult = this.db.prepare("DELETE FROM feel_profile_checkpoints WHERE profile_id = ?").run(profileId);
      }
    } else if (watchContext && normalizedTerm) {
      const profileId = preferenceProfileId(watchContext);
      termResult = this.db.prepare("DELETE FROM feel_profile_terms WHERE profile_id = ? AND term = ?").run(profileId, normalizedTerm);
      checkpointResult = this.db.prepare("DELETE FROM feel_profile_checkpoints WHERE profile_id = ? AND term = ?").run(profileId, normalizedTerm);
    } else if (watchContext) {
      const profileId = preferenceProfileId(watchContext);
      termResult = this.db.prepare("DELETE FROM feel_profile_terms WHERE profile_id = ?").run(profileId);
      checkpointResult = this.db.prepare("DELETE FROM feel_profile_checkpoints WHERE profile_id = ?").run(profileId);
    } else if (normalizedTerm) {
      termResult = this.db.prepare("DELETE FROM feel_profile_terms WHERE term = ?").run(normalizedTerm);
      checkpointResult = this.db.prepare("DELETE FROM feel_profile_checkpoints WHERE term = ?").run(normalizedTerm);
    } else {
      termResult = this.db.prepare("DELETE FROM feel_profile_terms").run();
      checkpointResult = this.db.prepare("DELETE FROM feel_profile_checkpoints").run();
    }
    return {
      ok: true,
      watchContext,
      term: normalizedTerm ?? undefined,
      deletedTerms: Number(termResult.changes),
      deletedCheckpoints: Number(checkpointResult.changes)
    };
  }

  rollbackFeelProfileTerm(watchContext: WatchContext, term: string, version?: number, authUserId?: string): FeelProfileRollbackResponse {
    const normalizedTerm = cleanShortText(term, 80, true);
    if (!normalizedTerm) {
      throw Object.assign(new Error("Feel Profile rollback requires a term."), { statusCode: 400 });
    }
    this.ensurePreferenceProfile(watchContext, authUserId);
    const profileId = preferenceProfileId(watchContext, authUserId);
    const current = this.db
      .prepare("SELECT version FROM feel_profile_terms WHERE profile_id = ? AND term = ?")
      .get(profileId, normalizedTerm) as { version: number } | undefined;
    const maxTargetVersion = typeof version === "number" && Number.isFinite(version)
      ? Math.floor(version)
      : Math.max(0, (current?.version ?? 0) - 1);
    if (maxTargetVersion <= 0) {
      throw Object.assign(new Error("No earlier Feel Profile checkpoint is available for rollback."), { statusCode: 404 });
    }
    const checkpoint = this.profileCheckpoint(profileId, normalizedTerm, "<=", maxTargetVersion);
    if (!checkpoint) {
      throw Object.assign(new Error("No matching Feel Profile checkpoint is available for rollback."), { statusCode: 404 });
    }

    const now = new Date().toISOString();
    const nextVersion = this.currentProfileVersion(watchContext, authUserId) + 1;
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO feel_profile_terms (
            profile_id, watch_context, term, feature_weights_json, confidence, evidence_count,
            positive_count, negative_count, positive_weight, negative_weight, effective_evidence, conflict_score,
            version, last_event_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(profile_id, term) DO UPDATE SET
            feature_weights_json = excluded.feature_weights_json,
            confidence = excluded.confidence,
            evidence_count = excluded.evidence_count,
            positive_count = excluded.positive_count,
            negative_count = excluded.negative_count,
            positive_weight = excluded.positive_weight,
            negative_weight = excluded.negative_weight,
            effective_evidence = excluded.effective_evidence,
            conflict_score = excluded.conflict_score,
            version = excluded.version,
            last_event_id = excluded.last_event_id,
            updated_at = excluded.updated_at`
        )
        .run(
          profileId,
          watchContext,
          normalizedTerm,
          checkpoint.feature_weights_json,
          checkpoint.confidence,
          checkpoint.evidence_count,
          checkpoint.positive_count,
          checkpoint.negative_count,
          checkpoint.positive_weight,
          checkpoint.negative_weight,
          checkpoint.effective_evidence,
          checkpoint.conflict_score,
          nextVersion,
          null,
          now,
          now
        );
      this.db
        .prepare(
          `INSERT OR REPLACE INTO feel_profile_checkpoints (
            profile_id, watch_context, term, version, feature_weights_json, confidence, evidence_count,
            positive_count, negative_count, positive_weight, negative_weight, effective_evidence,
            conflict_score, event_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          profileId,
          watchContext,
          normalizedTerm,
          nextVersion,
          checkpoint.feature_weights_json,
          checkpoint.confidence,
          checkpoint.evidence_count,
          checkpoint.positive_count,
          checkpoint.negative_count,
          checkpoint.positive_weight,
          checkpoint.negative_weight,
          checkpoint.effective_evidence,
          checkpoint.conflict_score,
          null,
          now
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      ok: true,
      watchContext,
      term: normalizedTerm,
      restoredVersion: checkpoint.version,
      profileVersion: nextVersion,
      checkpointEventId: checkpoint.event_id ?? undefined
    };
  }

  exportFeelProfiles(limit = 20, authUserId?: string): FeelProfileExportResponse {
    const feedbackWhere = authUserId ? "WHERE auth_user_id = ?" : "";
    const feedbackValues = authUserId ? [authUserId] : [];
    const summary = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          COALESCE(SUM(profile_holdout), 0) AS holdouts,
          COALESCE(SUM(profile_update_applied), 0) AS applied_profile_updates
         FROM feel_feedback_events
         ${feedbackWhere}`
      )
      .get(...feedbackValues) as { total: number; holdouts: number; applied_profile_updates: number };
    const byReliability = this.db
      .prepare(
        `SELECT reliability, COUNT(*) AS count
         FROM feel_feedback_events
         ${feedbackWhere}
         GROUP BY reliability
         ORDER BY count DESC, reliability`
      )
      .all(...feedbackValues) as Array<{ reliability: FeelFeedbackReliability; count: number }>;
    return {
      schemaVersion: "feel-profile-export-v1",
      exportedAt: new Date().toISOString(),
      engineVersion: recommendationEngineVersion,
      profiles: this.feelProfiles(authUserId),
      preferences: {
        solo: this.preferenceDiagnostics("solo", authUserId),
        group: this.preferenceDiagnostics("group")
      },
      feedbackSummary: {
        total: summary.total,
        byReliability,
        holdouts: summary.holdouts,
        appliedProfileUpdates: summary.applied_profile_updates
      },
      recentSlates: this.recentRecommendationSlates(limit, authUserId)
    };
  }

  profileReplayEvaluation(limit = 100): ProfileReplayEvaluationResponse {
    const normalizedLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const events = this.db
      .prepare(
        `SELECT id, session_id, media_item_id, action, watch_context, mood_term, profile_version, auth_user_id, created_at
         FROM feel_feedback_events
         WHERE profile_holdout = 1
          AND mood_term IS NOT NULL
          AND media_item_id IS NOT NULL
         ORDER BY created_at DESC, id DESC
         LIMIT ?`
      )
      .all(normalizedLimit) as Array<{
      id: number;
      session_id?: string | null;
      media_item_id?: string | null;
      action: FeelFeedbackAction;
      watch_context: WatchContext;
      mood_term?: string | null;
      profile_version: number;
      auth_user_id?: string | null;
      created_at: string;
    }>;
    const skipped: Record<string, number> = {};
    const skip = (reason: string) => {
      skipped[reason] = (skipped[reason] ?? 0) + 1;
    };
    const cases: ProfileReplayEvaluationResponse["cases"] = [];

    for (const event of events) {
      const sessionId = event.session_id ?? undefined;
      const itemId = event.media_item_id ?? undefined;
      const moodTerm = event.mood_term ?? undefined;
      const polarity = feedbackEvidencePolarity(event.action);
      if (!sessionId) {
        skip("missing_session");
        continue;
      }
      if (!itemId || !moodTerm) {
        skip("missing_item_or_term");
        continue;
      }
      if (polarity === 0) {
        skip("unsupported_action");
        continue;
      }
      const slateRow = this.db
        .prepare("SELECT rank FROM recommendation_results WHERE session_id = ? AND media_item_id = ?")
        .get(sessionId, itemId) as { rank: number } | undefined;
      if (!slateRow) {
        skip("item_not_in_slate");
        continue;
      }
      const item = this.findById(itemId);
      if (!item) {
        skip("missing_item");
        continue;
      }
      const profileId = preferenceProfileId(event.watch_context, event.auth_user_id ?? undefined);
      const before = this.profileCheckpoint(profileId, moodTerm, "<=", event.profile_version);
      const after = this.profileCheckpoint(profileId, moodTerm, ">", event.profile_version);
      if (!after) {
        skip("missing_next_checkpoint");
        continue;
      }
      const feature = this.storedFeatureForItem(itemId);
      const beforeProfileScore = this.replayProfileScore(item, feature, before);
      const afterProfileScore = this.replayProfileScore(item, feature, after);
      const delta = afterProfileScore - beforeProfileScore;
      const outcome = Math.abs(delta) < 0.001 ? "tie" : (polarity > 0 ? delta > 0 : delta < 0) ? "win" : "loss";
      cases.push({
        eventId: event.id,
        sessionId,
        itemId,
        action: event.action,
        watchContext: event.watch_context,
        moodTerm,
        slateRank: slateRow.rank,
        eventProfileVersion: event.profile_version,
        nextProfileVersion: after.version,
        beforeProfileScore,
        afterProfileScore,
        outcome
      });
    }

    return {
      engineVersion: recommendationEngineVersion,
      generatedAt: new Date().toISOString(),
      holdoutEvents: events.length,
      compared: cases.length,
      wins: cases.filter((entry) => entry.outcome === "win").length,
      losses: cases.filter((entry) => entry.outcome === "loss").length,
      ties: cases.filter((entry) => entry.outcome === "tie").length,
      skipped,
      cases
    };
  }

  compactReplayData(policyOverrides: Partial<ReplayRetentionPolicy> = {}): ReplayCompactionSummary {
    const policy = replayRetentionPolicy(policyOverrides);
    const cutoff = new Date(Date.now() - policy.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const oldSessions = this.db.prepare("DELETE FROM recommendation_sessions WHERE created_at < ?").run(cutoff);
    const extraSessions = this.db
      .prepare(
        `DELETE FROM recommendation_sessions
         WHERE id NOT IN (
          SELECT id
          FROM recommendation_sessions
          ORDER BY created_at DESC, id DESC
          LIMIT ?
         )`
      )
      .run(policy.maxSessions);
    const oldFeedbackEvents = this.db.prepare("DELETE FROM feel_feedback_events WHERE created_at < ?").run(cutoff);
    const extraFeedbackEvents = this.db
      .prepare(
        `DELETE FROM feel_feedback_events
         WHERE id NOT IN (
          SELECT id
          FROM feel_feedback_events
          ORDER BY created_at DESC, id DESC
          LIMIT ?
         )`
      )
      .run(policy.maxFeedbackEvents);
    const extraCheckpoints = this.db
      .prepare(
        `DELETE FROM feel_profile_checkpoints
         WHERE (
          SELECT COUNT(*)
          FROM feel_profile_checkpoints newer
          WHERE newer.profile_id = feel_profile_checkpoints.profile_id
           AND newer.term = feel_profile_checkpoints.term
           AND newer.version > feel_profile_checkpoints.version
         ) >= ?`
      )
      .run(policy.maxCheckpointsPerTerm);
    return {
      policy,
      deletedSessions: Number(oldSessions.changes) + Number(extraSessions.changes),
      deletedFeedbackEvents: Number(oldFeedbackEvents.changes) + Number(extraFeedbackEvents.changes),
      deletedCheckpoints: Number(extraCheckpoints.changes)
    };
  }

  recommendationDiagnostics(): RecommendationDiagnostics {
    const sessions = this.db.prepare(
      `SELECT
        COUNT(*) AS total,
        COALESCE(SUM(used_ai), 0) AS with_ai,
        COALESCE(SUM(seerr_augmented), 0) AS with_seerr_augmentation,
        COALESCE(AVG(latency_ms), 0) AS average_latency_ms
       FROM recommendation_sessions`
    ).get() as { total: number; with_ai: number; with_seerr_augmentation: number; average_latency_ms: number };
    const featureCount = (this.db.prepare("SELECT COUNT(*) AS value FROM media_features").get() as { value: number }).value;
    const contentFingerprintCoverage = this.contentFingerprintDiagnostics();
    const contentFingerprintCount = contentFingerprintCoverage.total;
    const moodFeatureScoreCount = (this.db.prepare("SELECT COUNT(*) AS value FROM media_mood_feature_scores").get() as { value: number }).value;
    const providerEmbeddingCount = (this.db.prepare("SELECT COUNT(*) AS value FROM media_embeddings").get() as { value: number }).value;
    const embeddingModels = this.db
      .prepare(
        `SELECT provider, model, dimensions, COUNT(*) AS count, MAX(updated_at) AS last_updated_at
         FROM media_embeddings
         GROUP BY provider, model, dimensions
         ORDER BY count DESC, provider, model, dimensions`
      )
      .all() as Array<{ provider: string; model: string; count: number; dimensions?: number; last_updated_at?: string }>;
    const recentRuns = this.db
      .prepare(
        `SELECT id, engine_version, model, watch_context, result_count, candidate_count, rerank_candidate_count,
          used_ai, seerr_augmented, latency_ms, profile_id, profile_version, created_at
         FROM recommendation_sessions
         ORDER BY created_at DESC
         LIMIT 8`
      )
      .all() as Array<{
      id: string;
      engine_version: string;
      model?: string;
      watch_context: WatchContext;
      result_count: number;
      candidate_count: number;
      rerank_candidate_count: number;
      used_ai: number;
      seerr_augmented: number;
      latency_ms: number;
      profile_id?: string | null;
      profile_version: number;
      created_at: string;
    }>;

    const mappedRecentRuns = recentRuns.map((run) => ({
      id: run.id,
      engineVersion: run.engine_version,
      model: run.model ?? undefined,
      watchContext: run.watch_context,
      resultCount: run.result_count,
      candidateCount: run.candidate_count,
      rerankCandidateCount: run.rerank_candidate_count,
      usedAi: Boolean(run.used_ai),
      seerrAugmented: Boolean(run.seerr_augmented),
      latencyMs: run.latency_ms,
      profileId: run.profile_id ?? undefined,
      profileVersion: run.profile_version,
      createdAt: run.created_at
    }));
    const feelProfiles = this.feelProfiles();
    const feelProfileDrift = this.feelProfileDriftDiagnostics();
    const replayStorage = this.replayStorageDiagnostics();
    const feelSignals = this.feelSignalDiagnostics();
    const replayEvaluation = this.profileReplayEvaluation(100);

    return {
      engineVersion: recommendationEngineVersion,
      sessions: {
        total: sessions.total,
        withAi: sessions.with_ai,
        withSeerrAugmentation: sessions.with_seerr_augmentation,
        averageLatencyMs: Math.round(sessions.average_latency_ms)
      },
      features: {
        mediaFeatureCount: featureCount,
        contentFingerprintCount,
        contentFingerprints: contentFingerprintCoverage,
        moodFeatureScoreCount,
        moodFeatureSources: this.moodFeatureSourceSummaries(),
        catalogSources: this.catalogSourceSummaries(),
        catalog: this.catalogDiagnostics(),
        providerEmbeddingCount,
        embeddingModels: embeddingModels.map((row) => ({
          provider: row.provider,
          model: row.model,
          count: row.count,
          dimensions: row.dimensions,
          lastUpdatedAt: row.last_updated_at
        }))
      },
      preferences: {
        solo: this.preferenceDiagnostics("solo"),
        group: this.preferenceDiagnostics("group")
      },
      usageReadiness: this.feelProfileUsageReadiness({
        feelProfiles,
        feelProfileDrift,
        replayStorage,
        feelSignals,
        replayEvaluation,
        recentRuns: mappedRecentRuns
      }),
      feelProfiles,
      feelProfileTimeline: this.feelProfileTimelineDiagnostics(),
      feelProfileDrift,
      replayStorage,
      feelSignals,
      recentRuns: mappedRecentRuns
    };
  }

  private feelProfileUsageReadiness(input: {
    feelProfiles: Record<WatchContext, FeelProfileResponse>;
    feelProfileDrift: NonNullable<RecommendationDiagnostics["feelProfileDrift"]>;
    replayStorage: NonNullable<RecommendationDiagnostics["replayStorage"]>;
    feelSignals: NonNullable<RecommendationDiagnostics["feelSignals"]>;
    replayEvaluation: ProfileReplayEvaluationResponse;
    recentRuns: RecommendationDiagnostics["recentRuns"];
  }): NonNullable<RecommendationDiagnostics["usageReadiness"]> {
    const targetAppliedProfileUpdates = 10;
    const targetHoldouts = 1;
    const targetReplayComparisons = 1;
    const appliedProfileUpdates = (this.db.prepare("SELECT COALESCE(SUM(profile_update_applied), 0) AS value FROM feel_feedback_events").get() as { value: number }).value;
    const learnedTerms = input.feelProfiles.solo.terms.length + input.feelProfiles.group.terms.length;
    const soloVersion = Math.max(0, ...input.feelProfiles.solo.terms.map((term) => term.version));
    const groupVersion = Math.max(0, ...input.feelProfiles.group.terms.map((term) => term.version));
    const rollbackRecommended = input.feelProfileDrift.alerts.some((alert) => alert.recommendation === "review_or_rollback");
    const signalProgress = {
      total: input.feelSignals.total,
      appliedProfileUpdates,
      targetAppliedProfileUpdates,
      holdouts: input.replayStorage.holdoutEvents,
      targetHoldouts,
      replayComparisons: input.replayEvaluation.compared,
      targetReplayComparisons
    };

    if (input.feelProfileDrift.totalAlerts > 0) {
      return {
        status: "review_needed",
        label: "Review needed",
        ready: false,
        nextAction: rollbackRecommended ? "Review drift alerts and roll back conflicted terms if the checkpoint looks better." : "Review drift alerts before trusting more profile learning.",
        signalProgress,
        profileVersions: { solo: soloVersion, group: groupVersion, max: Math.max(soloVersion, groupVersion), learnedTerms },
        review: { driftAlerts: input.feelProfileDrift.totalAlerts, rollbackRecommended },
        recentActivity: {
          lastSignalAt: input.feelSignals.recent[0]?.createdAt,
          lastRunAt: input.recentRuns[0]?.createdAt
        }
      };
    }

    if (input.feelSignals.total === 0) {
      return {
        status: "cold_start",
        label: "Waiting for feel signals",
        ready: false,
        nextAction: "Use Finder normally and mark a few results as more like, less like, right mood, or wrong mood.",
        signalProgress,
        profileVersions: { solo: soloVersion, group: groupVersion, max: Math.max(soloVersion, groupVersion), learnedTerms },
        review: { driftAlerts: 0, rollbackRecommended: false },
        recentActivity: {
          lastRunAt: input.recentRuns[0]?.createdAt
        }
      };
    }

    if (
      appliedProfileUpdates >= targetAppliedProfileUpdates &&
      input.replayStorage.holdoutEvents >= targetHoldouts &&
      input.replayEvaluation.compared >= targetReplayComparisons
    ) {
      return {
        status: "replay_ready",
        label: "Replay ready",
        ready: true,
        nextAction: "Keep using the app and review replay or drift after each small batch of new signals.",
        signalProgress,
        profileVersions: { solo: soloVersion, group: groupVersion, max: Math.max(soloVersion, groupVersion), learnedTerms },
        review: { driftAlerts: 0, rollbackRecommended: false },
        recentActivity: {
          lastSignalAt: input.feelSignals.recent[0]?.createdAt,
          lastRunAt: input.recentRuns[0]?.createdAt
        }
      };
    }

    const nextAction =
      appliedProfileUpdates < targetAppliedProfileUpdates
        ? `Collect ${targetAppliedProfileUpdates - appliedProfileUpdates} more applied profile update${targetAppliedProfileUpdates - appliedProfileUpdates === 1 ? "" : "s"} across normal searches.`
        : input.replayStorage.holdoutEvents < targetHoldouts
          ? "Collect more eligible mood feedback until at least one holdout exists."
          : "Run one more search and feedback cycle after the holdout so replay can compare profile versions.";
    return {
      status: "collecting",
      label: "Collecting signal",
      ready: false,
      nextAction,
      signalProgress,
      profileVersions: { solo: soloVersion, group: groupVersion, max: Math.max(soloVersion, groupVersion), learnedTerms },
      review: { driftAlerts: 0, rollbackRecommended: false },
      recentActivity: {
        lastSignalAt: input.feelSignals.recent[0]?.createdAt,
        lastRunAt: input.recentRuns[0]?.createdAt
      }
    };
  }

  private feelSignalDiagnostics() {
    const summary = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN action IN ('swipe_right', 'save', 'more_like', 'right_mood', 'request_create') THEN 1 ELSE 0 END), 0) AS positive,
          COALESCE(SUM(CASE WHEN action IN ('swipe_left', 'less_like', 'wrong_mood', 'hide') THEN 1 ELSE 0 END), 0) AS negative,
          COALESCE(SUM(CASE WHEN action = 'pairwise_pick' THEN 1 ELSE 0 END), 0) AS pairwise
         FROM feel_feedback_events`
      )
      .get() as { total: number; positive: number; negative: number; pairwise: number };
    const byAction = this.db
      .prepare(
        `SELECT action, COUNT(*) AS count
         FROM feel_feedback_events
         GROUP BY action
         ORDER BY count DESC, action`
      )
      .all() as Array<{ action: FeelFeedbackAction; count: number }>;
    const byReliability = this.db
      .prepare(
        `SELECT reliability, COUNT(*) AS count
         FROM feel_feedback_events
         GROUP BY reliability
         ORDER BY count DESC, reliability`
      )
      .all() as Array<{ reliability: FeelFeedbackReliability; count: number }>;
    const recent = this.db
      .prepare(
        `SELECT id, action, reliability, source, watch_context, media_item_id, compared_media_item_id, mood_term, reason,
          profile_version, profile_update_applied, profile_holdout, created_at
         FROM feel_feedback_events
         ORDER BY created_at DESC, id DESC
         LIMIT 8`
      )
      .all() as unknown as FeelFeedbackEventRow[];

    return {
      total: summary.total,
      positive: summary.positive,
      negative: summary.negative,
      pairwise: summary.pairwise,
      byReliability,
      byAction,
      recent: recent.map((row) => ({
        id: row.id,
        action: row.action,
        reliability: row.reliability,
        source: row.source,
        watchContext: row.watch_context,
        itemId: row.media_item_id ?? undefined,
        comparedItemId: row.compared_media_item_id ?? undefined,
        moodTerm: row.mood_term ?? undefined,
        reason: row.reason ?? undefined,
        profileVersion: row.profile_version,
        profileUpdateApplied: Boolean(row.profile_update_applied),
        profileHoldout: Boolean(row.profile_holdout),
        createdAt: row.created_at
      }))
    };
  }

  requestAuditDiagnostics(): RequestAuditDiagnostics {
    const summary = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          COALESCE(SUM(CASE WHEN action = 'preview' THEN 1 ELSE 0 END), 0) AS previews,
          COALESCE(SUM(CASE WHEN action = 'create' THEN 1 ELSE 0 END), 0) AS creates,
          COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked,
          COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed
         FROM request_audit`
      )
      .get() as { total: number; previews: number; creates: number; blocked: number; failed: number };
    const recent = this.db
      .prepare(
        `SELECT
          request_audit.id,
          request_audit.action,
          request_audit.status,
          request_audit.title,
          request_audit.media_type,
          request_audit.media_id,
          request_audit.seasons_json,
          request_audit.blocked_reason,
          request_audit.auth_user_id,
          request_audit.created_at,
          app_users.display_name AS auth_display_name,
          app_users.username AS auth_username
         FROM request_audit
         LEFT JOIN app_users ON app_users.id = request_audit.auth_user_id
         ORDER BY request_audit.created_at DESC, request_audit.id DESC
         LIMIT 12`
      )
      .all() as Array<{
      id: number;
      action: "preview" | "create";
      status: "allowed" | "blocked" | "created" | "failed";
      title?: string;
      media_type?: MediaType;
      media_id?: number;
      seasons_json?: string;
      blocked_reason?: string;
      auth_user_id?: string;
      auth_display_name?: string;
      auth_username?: string;
      created_at: string;
    }>;

    return {
      total: summary.total,
      previews: summary.previews,
      creates: summary.creates,
      blocked: summary.blocked,
      failed: summary.failed,
      recent: recent.map((row) => ({
        id: row.id,
        action: row.action,
        status: row.status,
        title: row.title ?? undefined,
        mediaType: row.media_type ?? undefined,
        mediaId: row.media_id ?? undefined,
        seasons: parseJsonNumberArray(row.seasons_json ?? "[]"),
        blockedReason: row.blocked_reason ?? undefined,
        authUser: row.auth_user_id
          ? {
              id: row.auth_user_id,
              displayName: row.auth_display_name ?? row.auth_username ?? "Plex user"
            }
          : undefined,
        createdAt: row.created_at
      }))
    };
  }

  stats() {
    const one = <T>(sql: string) => (this.db.prepare(sql).get() as { value: T }).value;
    const lastLibrarySync = this.lastSync("library_sync_runs");
    const lastSeerrSync = this.lastSync("seerr_sync_runs");
    return {
      totalItems: one<number>("SELECT COUNT(*) AS value FROM media_items"),
      plexItems: one<number>("SELECT COUNT(DISTINCT media_item_id) AS value FROM plex_items WHERE available = 1"),
      seerrItems: one<number>("SELECT COUNT(*) AS value FROM seerr_items"),
      movies: one<number>("SELECT COUNT(*) AS value FROM media_items WHERE media_type = 'movie'"),
      tv: one<number>("SELECT COUNT(*) AS value FROM media_items WHERE media_type = 'tv'"),
      availableInPlex: one<number>("SELECT COUNT(DISTINCT media_item_id) AS value FROM plex_items WHERE available = 1"),
      requestable: one<number>("SELECT COUNT(*) AS value FROM seerr_items WHERE requestable = 1"),
      alreadyRequested: one<number>(
        "SELECT COUNT(DISTINCT media_item_id) AS value FROM seerr_items WHERE request_status IS NOT NULL AND request_status != ''"
      ),
      partiallyAvailable: one<number>("SELECT COUNT(*) AS value FROM seerr_items WHERE status = 'partially_available'"),
      lastLibrarySync,
      lastSeerrSync
    };
  }

  activeCatalogSourceEvidence() {
    const identity = crypto.createHash("sha256");
    let activeSourceRecords = 0;
    const rows = this.db
      .prepare(
        `SELECT source, source_item_id, media_item_id
         FROM catalog_source_records
         WHERE active = 1
         ORDER BY source, source_item_id, media_item_id`
      )
      .iterate() as IterableIterator<{ source: string; source_item_id: string; media_item_id: string }>;
    for (const row of rows) {
      identity.update(JSON.stringify([row.source, row.source_item_id, row.media_item_id]));
      identity.update("\n");
      activeSourceRecords += 1;
    }
    return { activeSourceRecords, identitySha256: identity.digest("hex") };
  }

  private findExistingId(
    record: Pick<IngestMediaRecord, "mediaType" | "plex" | "seerr">,
    normalizedTitle: string,
    year: number | undefined,
    externalIds: Record<string, string>,
    allowTitleFallback = true
  ) {
    const { mediaType } = record;
    const matchedIds = new Set<string>();
    for (const [source, value] of Object.entries(externalIds)) {
      const row = this.db
        .prepare("SELECT media_item_id FROM external_ids WHERE source = ? AND media_type = ? AND value = ?")
        .get(source, mediaType, value) as
        | { media_item_id: string }
        | undefined;
      if (row) matchedIds.add(row.media_item_id);
    }
    const operationalOwners: Array<{ media_item_id: string; media_type: MediaType }> = [];
    if (record.plex?.ratingKey) {
      operationalOwners.push(
        ...(this.db
          .prepare(
            `SELECT DISTINCT p.media_item_id, m.media_type
             FROM plex_items p
             JOIN media_items m ON m.id = p.media_item_id
             WHERE p.rating_key = ? OR p.id = ?`
          )
          .all(record.plex.ratingKey, `plex:${record.plex.ratingKey}`) as Array<{ media_item_id: string; media_type: MediaType }>)
      );
    }
    if (record.seerr?.seerrMediaId !== undefined) {
      operationalOwners.push(
        ...(this.db
          .prepare(
            `SELECT DISTINCT s.media_item_id, m.media_type
             FROM seerr_items s
             JOIN media_items m ON m.id = s.media_item_id
             WHERE s.seerr_media_id = ? OR s.id = ?`
          )
          .all(record.seerr.seerrMediaId, `seerr:${record.seerr.seerrMediaId}`) as Array<{ media_item_id: string; media_type: MediaType }>)
      );
    }
    for (const owner of operationalOwners) matchedIds.add(owner.media_item_id);
    const incompatibleOwner = operationalOwners.find((owner) => owner.media_type !== mediaType);
    if (incompatibleOwner) {
      throw new MediaIdentityConflictError(matchedIds);
    }
    if (matchedIds.size > 1) {
      throw new MediaIdentityConflictError(matchedIds);
    }
    const [matchedId] = matchedIds;
    if (matchedId) return matchedId;
    if (!allowTitleFallback) return undefined;

    const row = this.db
      .prepare("SELECT id FROM media_items WHERE media_type = ? AND normalized_title = ? AND COALESCE(year, 0) = COALESCE(?, 0)")
      .get(mediaType, normalizedTitle, year ?? null) as { id: string } | undefined;
    return row?.id;
  }

  private quarantineMediaIdentityConflict(mediaItemIds: readonly string[]) {
    const now = new Date().toISOString();
    const quarantine = this.db.prepare(
      `INSERT INTO media_identity_quarantine (
        media_item_id, reason_code, first_seen_at, last_seen_at, occurrence_count
      ) VALUES (?, ?, ?, ?, 1)
      ON CONFLICT(media_item_id) DO UPDATE SET
        reason_code = excluded.reason_code,
        last_seen_at = excluded.last_seen_at,
        occurrence_count = media_identity_quarantine.occurrence_count + 1`
    );
    for (const mediaItemId of mediaItemIds) {
      quarantine.run(mediaItemId, mediaIdentityConflictReason, now, now);
    }
    for (const mediaItemId of mediaItemIds) {
      this.upsertCatalogSearchIndex(mediaItemId, now);
    }
  }

  private replaceList(table: "genres", mediaItemId: string, values: string[]) {
    this.db.prepare(`DELETE FROM ${table} WHERE media_item_id = ?`).run(mediaItemId);
    const insert = this.db.prepare(`INSERT OR IGNORE INTO ${table} (media_item_id, name) VALUES (?, ?)`);
    for (const value of unique(values)) {
      insert.run(mediaItemId, value);
    }
  }

  private resolveGenreUpdate(mediaItemId: string, record: IngestMediaRecord, replaceCatalogValues = false) {
    if (record.genres === undefined) return undefined;
    if (record.source === "operational") return undefined;
    if (record.source === "catalog") {
      if (replaceCatalogValues) return record.genres;
      const existing = this.existingGenres(mediaItemId);
      return existing.length > 0 ? undefined : record.genres;
    }
    if (!record.seerr || record.plex) return record.genres;

    const existing = this.existingGenres(mediaItemId);
    if (existing.length === 0) return record.genres;

    const classificationAdditions = record.genres.filter((genre) => genre.toLowerCase() === "animation" && !existing.some((entry) => entry.toLowerCase() === genre.toLowerCase()));
    return classificationAdditions.length ? [...existing, ...classificationAdditions] : undefined;
  }

  private existingGenres(mediaItemId: string) {
    return (this.db.prepare("SELECT name FROM genres WHERE media_item_id = ? ORDER BY name").all(mediaItemId) as { name: string }[]).map((entry) => entry.name);
  }

  private replacePeople(mediaItemId: string, values: string[], role: "cast" | "director") {
    this.db.prepare("DELETE FROM people WHERE media_item_id = ? AND role = ?").run(mediaItemId, role);
    const insert = this.db.prepare("INSERT OR IGNORE INTO people (media_item_id, name, role) VALUES (?, ?, ?)");
    for (const value of unique(values)) {
      insert.run(mediaItemId, value, role);
    }
  }

  private resolvePeopleUpdate(
    mediaItemId: string,
    record: IngestMediaRecord,
    role: "cast" | "director",
    replaceCatalogValues = false
  ) {
    const values = role === "cast" ? record.cast : record.directors;
    if (values === undefined) return undefined;
    if (record.source === "operational") return undefined;
    if (record.source !== "catalog") return values;
    if (replaceCatalogValues) return values;
    const existing = this.existingPeople(mediaItemId, role);
    return existing.length > 0 ? undefined : values;
  }

  private existingPeople(mediaItemId: string, role: "cast" | "director") {
    return (this.db.prepare("SELECT name FROM people WHERE media_item_id = ? AND role = ? ORDER BY name").all(mediaItemId, role) as { name: string }[]).map(
      (entry) => entry.name
    );
  }

  private upsertExternalIds(mediaItemId: string, mediaType: MediaType, externalIds: Record<string, string>) {
    const insert = this.db.prepare(
      `INSERT INTO external_ids (media_item_id, source, media_type, value)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(source, media_type, value) DO UPDATE SET media_item_id = excluded.media_item_id
       WHERE external_ids.media_item_id = excluded.media_item_id`
    );
    for (const [source, value] of Object.entries(externalIds)) {
      const owner = this.db
        .prepare("SELECT media_item_id FROM external_ids WHERE source = ? AND media_type = ? AND value = ?")
        .get(source, mediaType, value) as { media_item_id: string } | undefined;
      if (owner && owner.media_item_id !== mediaItemId) {
        throw new MediaIdentityConflictError([owner.media_item_id]);
      }
      const result = insert.run(mediaItemId, source, mediaType, value);
      if (Number(result.changes) === 0) {
        const persistedOwner = this.db
          .prepare("SELECT media_item_id FROM external_ids WHERE source = ? AND media_type = ? AND value = ?")
          .get(source, mediaType, value) as { media_item_id: string } | undefined;
        throw new MediaIdentityConflictError(persistedOwner ? [persistedOwner.media_item_id] : []);
      }
    }
  }

  private upsertPlex(mediaItemId: string, plex: NonNullable<IngestMediaRecord["plex"]>, now: string) {
    const id = `plex:${plex.ratingKey ?? plex.guid ?? mediaItemId}`;
    const owner = this.db.prepare("SELECT media_item_id FROM plex_items WHERE id = ?").get(id) as { media_item_id: string } | undefined;
    if (owner && owner.media_item_id !== mediaItemId) {
      throw new MediaIdentityConflictError([owner.media_item_id]);
    }
    const result = this.db
      .prepare(
        `INSERT INTO plex_items (id, media_item_id, rating_key, guid, library_title, library_type, plex_url, available, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          rating_key = excluded.rating_key,
          guid = excluded.guid,
          library_title = excluded.library_title,
          library_type = excluded.library_type,
          plex_url = excluded.plex_url,
          available = excluded.available,
          last_seen_at = excluded.last_seen_at
         WHERE plex_items.media_item_id = excluded.media_item_id`
      )
      .run(
        id,
        mediaItemId,
        plex.ratingKey ?? null,
        plex.guid ?? null,
        plex.libraryTitle ?? null,
        plex.libraryType ?? null,
        plex.url ?? null,
        plex.available === false ? 0 : 1,
        now
      );
    if (Number(result.changes) === 0) {
      const persistedOwner = this.db.prepare("SELECT media_item_id FROM plex_items WHERE id = ?").get(id) as { media_item_id: string } | undefined;
      throw new MediaIdentityConflictError(persistedOwner ? [persistedOwner.media_item_id] : []);
    }
  }

  private upsertSeerr(mediaItemId: string, mediaType: MediaType, seerr: NonNullable<IngestMediaRecord["seerr"]>, now: string) {
    const fallbackId = `seerr:${mediaType}:${seerr.tmdbId ?? mediaItemId}`;
    const id = seerr.seerrMediaId === undefined ? fallbackId : `seerr:${seerr.seerrMediaId}`;
    const fallback = id === fallbackId
      ? undefined
      : this.db
          .prepare(
            `SELECT request_status
             FROM seerr_items
             WHERE id = ? AND media_item_id = ?`
          )
          .get(fallbackId, mediaItemId) as { request_status?: string | null } | undefined;
    const requestStatus = seerr.requestStatus ?? fallback?.request_status ?? undefined;
    const requestable = seerr.requestable && (!requestStatus || requestStatus === "declined");
    const owner = this.db.prepare("SELECT media_item_id FROM seerr_items WHERE id = ?").get(id) as { media_item_id: string } | undefined;
    if (owner && owner.media_item_id !== mediaItemId) {
      throw new MediaIdentityConflictError([owner.media_item_id]);
    }
    const result = this.db
      .prepare(
        `INSERT INTO seerr_items (
          id, media_item_id, tmdb_id, tvdb_id, imdb_id, seerr_media_id, media_type, status, request_status, requestable, seerr_url, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          tmdb_id = excluded.tmdb_id,
          tvdb_id = excluded.tvdb_id,
          imdb_id = excluded.imdb_id,
          seerr_media_id = excluded.seerr_media_id,
          status = excluded.status,
          request_status = excluded.request_status,
          requestable = excluded.requestable,
          seerr_url = excluded.seerr_url,
          last_seen_at = excluded.last_seen_at
        WHERE seerr_items.media_item_id = excluded.media_item_id`
      )
      .run(
        id,
        mediaItemId,
        seerr.tmdbId ?? null,
        seerr.tvdbId ?? null,
        seerr.imdbId ?? null,
        seerr.seerrMediaId ?? null,
        mediaType,
        seerr.status,
        requestStatus ?? null,
        requestable ? 1 : 0,
        seerr.url ?? null,
        now
      );
    if (Number(result.changes) === 0) {
      const persistedOwner = this.db.prepare("SELECT media_item_id FROM seerr_items WHERE id = ?").get(id) as { media_item_id: string } | undefined;
      throw new MediaIdentityConflictError(persistedOwner ? [persistedOwner.media_item_id] : []);
    }
    if (id !== fallbackId) {
      this.db.prepare("DELETE FROM seerr_items WHERE id = ? AND media_item_id = ?").run(fallbackId, mediaItemId);
    }
  }

  private upsertFeature(mediaItemId: string, now: string) {
    const item = this.findById(mediaItemId);
    if (!item) return;
    this.upsertFeatureForItem(item, now);
  }

  private upsertFeatureForItem(item: ItemDetail, now: string) {
    const mediaItemId = item.id;
    const feature = buildMediaFeatureDocument(item);
    this.db
      .prepare(
        `INSERT INTO media_features (
          media_item_id, feature_text, mood_terms_json, tone_terms_json, watchability_terms_json, vector_json, feature_version, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(media_item_id) DO UPDATE SET
          feature_text = excluded.feature_text,
          mood_terms_json = excluded.mood_terms_json,
          tone_terms_json = excluded.tone_terms_json,
          watchability_terms_json = excluded.watchability_terms_json,
          vector_json = excluded.vector_json,
          feature_version = excluded.feature_version,
          updated_at = excluded.updated_at`
      )
      .run(
        mediaItemId,
        feature.featureText,
        JSON.stringify(feature.moodTerms),
        JSON.stringify(feature.toneTerms),
        JSON.stringify(feature.watchabilityTerms),
        vectorToJson(feature.vector),
        feature.version,
        now
      );
    this.db.prepare("DELETE FROM media_feature_fts WHERE media_item_id = ?").run(mediaItemId);
    this.db
      .prepare("INSERT INTO media_feature_fts (media_item_id, title, feature_text, genres, people) VALUES (?, ?, ?, ?, ?)")
      .run(mediaItemId, item.title, feature.featureText, item.genres.join(" "), [...item.cast, ...item.directors].join(" "));
    this.upsertMoodFeatureScores(mediaItemId, "deterministic", feature.version, deterministicMoodFeatureScores(feature), false);
    this.upsertContentFingerprintForItem(item, now, feature, false);
    this.upsertCatalogSearchIndex(mediaItemId, now, item);
  }

  private backfillFeatures() {
    const missingOrStaleCount = (
      this.db
        .prepare(
          `SELECT COUNT(*) AS value
           FROM media_items m
           LEFT JOIN media_features f ON f.media_item_id = m.id
           WHERE m.source != 'operational'
            AND (f.media_item_id IS NULL OR f.feature_version != ?)`
        )
        .get(FEATURE_VERSION) as { value: number }
    ).value;
    if (missingOrStaleCount === 0) return;
    const rows = this.db
      .prepare(
        `SELECT m.*
         FROM media_items m
         LEFT JOIN media_features f ON f.media_item_id = m.id
         WHERE m.source != 'operational'
          AND (f.media_item_id IS NULL OR f.feature_version != ?)`
      )
      .all(FEATURE_VERSION) as unknown as MediaRow[];
    if (rows.length === 0) return;
    if (rows.length > maxAutomaticFeatureBackfillItems) return;
    const now = new Date().toISOString();
    const items = this.inflateMany(rows);
    const upsertFeature = this.db.prepare(
      `INSERT INTO media_features (
        media_item_id, feature_text, mood_terms_json, tone_terms_json, watchability_terms_json, vector_json, feature_version, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(media_item_id) DO UPDATE SET
        feature_text = excluded.feature_text,
        mood_terms_json = excluded.mood_terms_json,
        tone_terms_json = excluded.tone_terms_json,
        watchability_terms_json = excluded.watchability_terms_json,
        vector_json = excluded.vector_json,
        feature_version = excluded.feature_version,
        updated_at = excluded.updated_at`
    );
    const deleteFts = this.db.prepare("DELETE FROM media_feature_fts WHERE media_item_id = ?");
    const insertFts = this.db.prepare("INSERT INTO media_feature_fts (media_item_id, title, feature_text, genres, people) VALUES (?, ?, ?, ?, ?)");
    const deleteMoodScores = this.db.prepare("DELETE FROM media_mood_feature_scores WHERE media_item_id = ? AND source = ?");
    const insertMoodScore = this.db.prepare(
      `INSERT INTO media_mood_feature_scores (
        media_item_id, source, source_version, feature, score, confidence, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    this.db.exec("BEGIN");
    try {
      for (const item of items) {
        const feature = buildMediaFeatureDocument(item);
        upsertFeature.run(
          item.id,
          feature.featureText,
          JSON.stringify(feature.moodTerms),
          JSON.stringify(feature.toneTerms),
          JSON.stringify(feature.watchabilityTerms),
          vectorToJson(feature.vector),
          feature.version,
          now
        );
        deleteFts.run(item.id);
        insertFts.run(item.id, item.title, feature.featureText, item.genres.join(" "), [...item.cast, ...item.directors].join(" "));
        deleteMoodScores.run(item.id, "deterministic");
        for (const score of deterministicMoodFeatureScores(feature)) {
          const normalizedFeature = normalizeMoodFeatureKey(score.feature);
          if (!normalizedFeature) continue;
          insertMoodScore.run(item.id, "deterministic", feature.version, normalizedFeature, clampNumber(score.score, 0, 100), clampNumber(score.confidence ?? 1, 0, 1), now);
        }
        this.upsertContentFingerprintForItem(item, now, feature);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private backfillMoodFeatureScores() {
    const rows = this.db
      .prepare(
        `SELECT f.media_item_id, f.feature_text, f.mood_terms_json, f.tone_terms_json, f.watchability_terms_json, f.vector_json, f.feature_version
         FROM media_features f
         LEFT JOIN (
          SELECT media_item_id, MAX(source_version) AS source_version, COUNT(*) AS score_count
          FROM media_mood_feature_scores
          WHERE source = 'deterministic'
          GROUP BY media_item_id
         ) s ON s.media_item_id = f.media_item_id
         WHERE s.score_count IS NULL OR s.source_version != ?`
      )
      .all(FEATURE_VERSION) as Array<{
      media_item_id: string;
      feature_text: string;
      mood_terms_json: string;
      tone_terms_json: string;
      watchability_terms_json: string;
      vector_json: string;
      feature_version: string;
    }>;
    if (rows.length > maxAutomaticFeatureBackfillItems) return;
    for (const row of rows) {
      const feature = inflateFeature(row);
      this.upsertMoodFeatureScores(feature.mediaItemId, "deterministic", feature.featureVersion, deterministicMoodFeatureScores(feature));
    }
  }

  private backfillContentFingerprints() {
    const rows = this.contentFingerprintRebuildRows(true, maxAutomaticFeatureBackfillItems + 1, 0);
    if (rows.length === 0 || rows.length > maxAutomaticFeatureBackfillItems) return;
    const items = this.inflateMany(rows);
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      for (const item of items) {
        this.upsertContentFingerprintForItem(item, now);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private backfillContentFingerprintMoodFeatureScores() {
    const source = normalizeTitle(CONTENT_FINGERPRINT_MOOD_SCORE_SOURCE);
    const rows = this.db
      .prepare(
        `SELECT f.media_item_id, f.fingerprint_json
         FROM media_content_fingerprints f
         LEFT JOIN (
          SELECT media_item_id, MAX(source_version) AS source_version, COUNT(*) AS score_count
          FROM media_mood_feature_scores
          WHERE source = ?
          GROUP BY media_item_id
         ) s ON s.media_item_id = f.media_item_id
         WHERE s.score_count IS NULL OR s.source_version != ?
         ORDER BY f.media_item_id
         LIMIT ?`
      )
      .all(source, CONTENT_FINGERPRINT_MOOD_SCORE_VERSION, maxAutomaticFeatureBackfillItems + 1) as Array<{ media_item_id: string; fingerprint_json: string }>;
    if (rows.length === 0 || rows.length > maxAutomaticFeatureBackfillItems) return;
    for (const row of rows) {
      const fingerprint = parseContentFingerprint(row.fingerprint_json);
      if (!fingerprint) continue;
      this.upsertMoodFeatureScores(row.media_item_id, CONTENT_FINGERPRINT_MOOD_SCORE_SOURCE, CONTENT_FINGERPRINT_MOOD_SCORE_VERSION, contentFingerprintMoodFeatureScores(fingerprint));
    }
  }

  private contentFingerprintRebuildRows(staleOnly: boolean, limit: number, offset: number) {
    const where = staleOnly
      ? "WHERE m.source != 'operational' AND (f.media_item_id IS NULL OR f.fingerprint_version != ?)"
      : "WHERE m.source != 'operational'";
    const values: Array<string | number> = staleOnly ? [CONTENT_FINGERPRINT_VERSION, limit, offset] : [limit, offset];
    return this.db
      .prepare(
        `SELECT m.*
         FROM media_items m
         LEFT JOIN media_content_fingerprints f ON f.media_item_id = m.id
         ${where}
         ORDER BY m.title, m.id
         LIMIT ?
         OFFSET ?`
      )
      .all(...values) as unknown as MediaRow[];
  }

  private upsertContentFingerprintForItem(
    item: ItemDetail,
    now: string,
    feature?: MediaFeatureDocument,
    refreshSearchIndex = true
  ) {
    const mediaFeature = feature ?? this.storedFeatureDocumentForItem(item.id) ?? buildMediaFeatureDocument(item);
    const fingerprint = buildContentFingerprint(item, mediaFeature, now);
    const existing = this.db
      .prepare("SELECT fingerprint_version, input_hash FROM media_content_fingerprints WHERE media_item_id = ?")
      .get(item.id) as { fingerprint_version: string; input_hash: string } | undefined;
    const changed = !existing || existing.fingerprint_version !== fingerprint.fingerprintVersion || existing.input_hash !== fingerprint.inputHash;
    if (changed) {
      this.db
        .prepare(
          `INSERT INTO media_content_fingerprints (
            media_item_id, schema_version, fingerprint_version, source, source_version,
            input_hash, fingerprint_json, generated_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(media_item_id) DO UPDATE SET
            schema_version = excluded.schema_version,
            fingerprint_version = excluded.fingerprint_version,
            source = excluded.source,
            source_version = excluded.source_version,
            input_hash = excluded.input_hash,
            fingerprint_json = excluded.fingerprint_json,
            generated_at = excluded.generated_at,
            updated_at = excluded.updated_at`
        )
        .run(
          item.id,
          fingerprint.schemaVersion,
          fingerprint.fingerprintVersion,
          fingerprint.source,
          fingerprint.sourceVersion,
          fingerprint.inputHash,
          fingerprintToJson(fingerprint),
          fingerprint.generatedAt,
          now
        );
    }
    this.upsertMoodFeatureScores(
      item.id,
      CONTENT_FINGERPRINT_MOOD_SCORE_SOURCE,
      CONTENT_FINGERPRINT_MOOD_SCORE_VERSION,
      contentFingerprintMoodFeatureScores(fingerprint),
      refreshSearchIndex
    );
    return changed;
  }

  private inflate(row: MediaRow): ItemDetail {
    const id = row.id;
    const genres = (this.db.prepare("SELECT name FROM genres WHERE media_item_id = ? ORDER BY name").all(id) as { name: string }[]).map((entry) => entry.name);
    const cast = (this.db.prepare("SELECT name FROM people WHERE media_item_id = ? AND role = 'cast' ORDER BY name").all(id) as { name: string }[]).map(
      (entry) => entry.name
    );
    const directors = (
      this.db.prepare("SELECT name FROM people WHERE media_item_id = ? AND role = 'director' ORDER BY name").all(id) as { name: string }[]
    ).map((entry) => entry.name);
    const externalIds = Object.fromEntries(
      (this.db.prepare("SELECT source, value FROM external_ids WHERE media_item_id = ? ORDER BY source, value").all(id) as { source: string; value: string }[]).map((entry) => [
        entry.source,
        entry.value
      ])
    );
    const plex = this.db
      .prepare(
        `SELECT available, plex_url, library_title
         FROM plex_items
         WHERE media_item_id = ?
         ORDER BY available DESC, last_seen_at DESC, id
         LIMIT 1`
      )
      .get(id) as PlexRow | undefined;
    const seerr = this.db.prepare("SELECT status, request_status, requestable, seerr_url, tmdb_id FROM seerr_items WHERE media_item_id = ? LIMIT 1").get(id) as
      | SeerrRow
      | undefined;
    const catalogMetadata = this.catalogMetadataForItems([id]).get(id);
    const hasActiveNonStaleCatalogSource = this.trustedUnambiguousActiveCatalogItemIds([id]).has(id);
    const hasAmbiguousCatalogIdentity = this.ambiguousActiveCatalogItemIds([id]).has(id);
    return this.inflateFromParts(row, {
      genres,
      cast,
      directors,
      externalIds,
      plex,
      seerr,
      catalogMetadata,
      hasActiveNonStaleCatalogSource,
      hasAmbiguousCatalogIdentity
    });
  }

  private inflateMany(rows: MediaRow[], scoped = false): ItemDetail[] {
    if (rows.length === 0) return [];
    const scope = scoped ? scopedMediaPredicate(rows.map((row) => row.id)) : undefined;
    const genresById = groupNameRows(
      this.db
        .prepare(`SELECT media_item_id, name FROM genres ${scope?.where ?? ""} ORDER BY media_item_id, name`)
        .all(...(scope?.values ?? [])) as Array<{ media_item_id: string; name: string }>
    );
    const people = this.db
      .prepare(
        `SELECT media_item_id, name, role
         FROM people
         WHERE role IN ('cast', 'director')
         ${scope ? `AND media_item_id IN (${scope.placeholders})` : ""}
         ORDER BY media_item_id, name, role`
      )
      .all(...(scope?.values ?? [])) as Array<{ media_item_id: string; name: string; role: "cast" | "director" }>;
    const castById = groupNameRows(people.filter((person) => person.role === "cast"));
    const directorsById = groupNameRows(people.filter((person) => person.role === "director"));
    const externalIdsById = new Map<string, Record<string, string>>();
    const externalIdRows = this.db
      .prepare(`SELECT media_item_id, source, value FROM external_ids ${scope?.where ?? ""} ORDER BY media_item_id, source, value`)
      .all(...(scope?.values ?? [])) as Array<{ media_item_id: string; source: string; value: string }>;
    for (const row of externalIdRows) {
      const ids = externalIdsById.get(row.media_item_id) ?? {};
      ids[row.source] = row.value;
      externalIdsById.set(row.media_item_id, ids);
    }
    const plexRows = this.db
      .prepare(
        `SELECT media_item_id, available, plex_url, library_title
         FROM plex_items
         ${scope?.where ?? ""}
         ORDER BY media_item_id, available DESC, last_seen_at DESC, id`
      )
      .all(...(scope?.values ?? [])) as unknown as Array<PlexRow & { media_item_id: string }>;
    const plexById = new Map<string, PlexRow>();
    for (const plexRow of plexRows) {
      if (!plexById.has(plexRow.media_item_id)) plexById.set(plexRow.media_item_id, plexRow);
    }
    const seerrById = new Map(
      (
        this.db
          .prepare(`SELECT media_item_id, status, request_status, requestable, seerr_url, tmdb_id FROM seerr_items ${scope?.where ?? ""} ORDER BY media_item_id`)
          .all(...(scope?.values ?? [])) as unknown as Array<SeerrRow & { media_item_id: string }>
      ).map((row) => [row.media_item_id, row])
    );
    const catalogMetadataById = this.catalogMetadataForItems(rows.map((row) => row.id));
    const activeNonStaleCatalogItemIds = this.trustedUnambiguousActiveCatalogItemIds(rows.map((row) => row.id));
    const ambiguousCatalogItemIds = this.ambiguousActiveCatalogItemIds(rows.map((row) => row.id));

    return rows.map((row) =>
      this.inflateFromParts(row, {
        genres: genresById.get(row.id) ?? [],
        cast: castById.get(row.id) ?? [],
        directors: directorsById.get(row.id) ?? [],
        externalIds: externalIdsById.get(row.id) ?? {},
        plex: plexById.get(row.id),
        seerr: seerrById.get(row.id),
        catalogMetadata: catalogMetadataById.get(row.id),
        hasActiveNonStaleCatalogSource: activeNonStaleCatalogItemIds.has(row.id),
        hasAmbiguousCatalogIdentity: ambiguousCatalogItemIds.has(row.id)
      })
    );
  }

  private ambiguousActiveCatalogItemIds(ids: string[]) {
    if (ids.length === 0) return new Set<string>();
    const scope = scopedMediaPredicate(ids);
    const ambiguousSourceRows = this.db
      .prepare(
        `SELECT media_item_id
         FROM catalog_source_records
         WHERE active = 1
          AND materialization_stale = 0
          AND media_item_id IN (${scope.placeholders})
         GROUP BY media_item_id
         HAVING COUNT(DISTINCT source || char(31) || source_item_id) > 1`
      )
      .all(...scope.values) as Array<{ media_item_id: string }>;
    const duplicateStrongIdRows = this.db
      .prepare(
        `SELECT e.media_item_id
         FROM external_ids e
         JOIN media_items m ON m.id = e.media_item_id
         WHERE e.media_item_id IN (${scope.placeholders})
          AND e.media_type = m.media_type
          AND e.source IN ('wikidata', 'imdb', 'tmdb', 'tvdb')
          AND EXISTS (
            SELECT 1
            FROM catalog_source_records r
            WHERE r.media_item_id = e.media_item_id
             AND r.active = 1
             AND r.materialization_stale = 0
          )
         GROUP BY e.media_item_id, e.source
         HAVING COUNT(DISTINCT e.value) > 1`
      )
      .all(...scope.values) as Array<{ media_item_id: string }>;
    const quarantinedRows = this.db
      .prepare(
        `SELECT media_item_id
         FROM media_identity_quarantine
         WHERE media_item_id IN (${scope.placeholders})`
      )
      .all(...scope.values) as Array<{ media_item_id: string }>;
    return new Set([...ambiguousSourceRows, ...duplicateStrongIdRows, ...quarantinedRows].map((row) => row.media_item_id));
  }

  private trustedUnambiguousActiveCatalogItemIds(ids: string[]) {
    if (ids.length === 0) return new Set<string>();
    const scope = scopedMediaPredicate(ids);
    const rows = this.db
      .prepare(
        `SELECT r.media_item_id
         FROM catalog_source_records r
         JOIN media_items m ON m.id = r.media_item_id
         JOIN external_ids e
          ON e.media_item_id = r.media_item_id
          AND e.media_type = m.media_type
          AND e.source = 'tmdb'
         WHERE r.active = 1
          AND r.materialization_stale = 0
          AND r.media_item_id IN (${scope.placeholders})
          AND NOT EXISTS (
            SELECT 1
            FROM media_identity_quarantine q
            WHERE q.media_item_id = r.media_item_id
          )
         GROUP BY r.media_item_id
         HAVING COUNT(DISTINCT r.source || char(31) || r.source_item_id) = 1
          AND COUNT(DISTINCT e.value) = 1
          AND MAX(
            CASE
              WHEN lower(r.license_policy) IN ('wikidata-cc0', 'cc0-1.0', 'operator-approved')
               AND (r.expires_at IS NULL OR julianday(r.expires_at) > julianday('now'))
              THEN 1 ELSE 0
            END
          ) = 1`
      )
      .all(...scope.values) as Array<{ media_item_id: string }>;
    return new Set(rows.map((row) => row.media_item_id));
  }

  private catalogMetadataForItems(ids: string[]) {
    if (ids.length === 0) return new Map<string, NonNullable<ItemDetail["metadata"]>["catalog"]>();
    const scope = scopedMediaPredicate(ids);
    const rows = this.db
      .prepare(
        `SELECT
          r.media_item_id AS mediaItemId,
          r.source,
          r.metadata_json AS metadataJson,
          s.mainstream_score AS mainstreamScore,
          s.metadata_confidence AS metadataConfidence,
          s.sitelink_count AS sitelinkCount,
          s.external_id_count AS externalIdCount,
          s.award_count AS awardCount
         FROM catalog_source_records r
         LEFT JOIN catalog_rank_signals s
          ON s.media_item_id = r.media_item_id AND s.source = r.source
         WHERE r.active = 1 AND r.media_item_id IN (${scope.placeholders})
         ORDER BY r.media_item_id, r.source`
      )
      .all(...scope.values) as unknown as CatalogMetadataSourceRow[];
    return summarizeCatalogMetadataRows(rows);
  }

  private inflateFromParts(
    row: MediaRow,
    parts: {
      genres: string[];
      cast: string[];
      directors: string[];
      externalIds: Record<string, string>;
      plex?: PlexRow;
      seerr?: SeerrRow;
      catalogMetadata?: NonNullable<ItemDetail["metadata"]>["catalog"];
      hasActiveNonStaleCatalogSource: boolean;
      hasAmbiguousCatalogIdentity: boolean;
    }
  ): ItemDetail {
    const id = row.id;
    const { genres, cast, directors, externalIds, plex, seerr, catalogMetadata, hasActiveNonStaleCatalogSource, hasAmbiguousCatalogIdentity } = parts;
    const quarantineAmbiguousCatalogIdentity = hasAmbiguousCatalogIdentity && row.source === "catalog";
    const availabilityGroup = quarantineAmbiguousCatalogIdentity ? "unavailable" : getAvailabilityGroup(plex, seerr);
    const requestAttemptPolicy = deriveRequestAttemptPolicy({
      externalTmdbId: externalIds.tmdb,
      hasActiveNonStaleCatalogSource: hasActiveNonStaleCatalogSource && !hasAmbiguousCatalogIdentity,
      hasPlexSource: Boolean(plex),
      plexAvailable: Boolean(plex?.available),
      summary: row.summary ?? undefined,
      genres,
      seerr: seerr
        ? {
            status: seerr.status,
            requestStatus: seerr.request_status,
            requestable: Boolean(seerr.requestable)
          }
        : undefined
    });
    const summary: ItemSummary = {
      id,
      mediaType: row.media_type,
      title: row.title,
      year: row.year ?? undefined,
      runtimeMinutes: row.runtime_minutes ?? undefined,
      summary: row.summary ?? undefined,
      genres,
      contentRating: row.content_rating ?? undefined,
      ratings: {
        critic: row.critic_rating ?? undefined,
        audience: row.audience_rating ?? undefined,
        user: row.user_rating ?? undefined
      },
      posterUrl: `/api/items/${encodeURIComponent(id)}/poster`,
      imdbUrl: imdbTitleUrl(externalIds.imdb),
      availabilityGroup,
      availabilityExplanation: quarantineAmbiguousCatalogIdentity
        ? "Quarantined because the catalog retains conflicting strong identity mappings. Finder and request actions are disabled for this item."
        : requestAttemptPolicy.requestAttempt
          ? "Not found in Plex. Moodarr has not checked Seerr availability; a confirmed request will make one request attempt."
          : explainAvailability(plex, seerr),
      requestAttempt: quarantineAmbiguousCatalogIdentity ? undefined : requestAttemptPolicy.requestAttempt,
      catalogIdentityAmbiguous: hasAmbiguousCatalogIdentity ? true : undefined,
      matchExplanation: "Matched by local metadata.",
      score: 0,
      metadata: {
        hasPoster: Boolean(row.poster_path),
        sparse: isSparseSeerrPlaceholder(row.title) || !row.summary?.trim(),
        source: row.source,
        catalogSourceCount: catalogMetadata?.sourceCount ?? 0,
        catalog: catalogMetadata
      },
      plex: plex
        ? {
            available: Boolean(plex.available),
            url: normalizePlexWebUrl(plex.plex_url),
            appUrl: plexAppUrlFromWebUrl(plex.plex_url),
            library: plex.library_title
          }
        : undefined,
      seerr: seerr
        ? {
            status: seerr.status,
            requestStatus: seerr.request_status,
            requestable: Boolean(seerr.requestable),
            url: seerr.seerr_url,
            mediaId: seerr.tmdb_id
          }
        : undefined
    };

    return {
      ...summary,
      cast,
      directors,
      externalIds
    };
  }

  private lastSync(table: "library_sync_runs" | "seerr_sync_runs"): string | undefined {
    const row = this.db.prepare(`SELECT finished_at FROM ${table} WHERE status = 'ok' ORDER BY id DESC LIMIT 1`).get() as
      | { finished_at?: string }
      | undefined;
    return row?.finished_at;
  }

  private syncRuns(table: "library_sync_runs" | "seerr_sync_runs", limit: number): SyncRunSummary[] {
    const rows = this.db
      .prepare(
        `SELECT id, source, status, started_at, finished_at, item_count, error
         FROM ${table}
         ORDER BY id DESC
         LIMIT ?`
      )
      .all(limit) as Array<{
      id: number;
      source: string;
      status: string;
      started_at: string;
      finished_at?: string;
      item_count: number;
      error?: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      source: row.source,
      status: row.status,
      startedAt: row.started_at,
      finishedAt: row.finished_at ?? undefined,
      itemCount: row.item_count,
      error: row.error ?? undefined
    }));
  }

  private recordQueryReviewRow(sessionId: string, record: RecommendationRunRecord, retention: QueryReviewRetention, now: string) {
    const snapshots = record.results.slice(0, 24).map(toQueryReviewSnapshot);
    const queryText = retention.captureRawQueries ? record.query : redactedQueryReviewLabel(record.query);
    const optimizedQuery = retention.captureRawQueries ? record.optimizedQuery ?? null : null;
    this.db
      .prepare(
        `INSERT INTO query_review_queue (
          id, session_id, query_text, optimized_query, watch_context, result_count, results_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          query_text = excluded.query_text,
          optimized_query = excluded.optimized_query,
          watch_context = excluded.watch_context,
          result_count = excluded.result_count,
          results_json = excluded.results_json,
          updated_at = excluded.updated_at`
      )
      .run(
        sessionId,
        sessionId,
        queryText,
        optimizedQuery,
        record.watchContext,
        record.resultCount,
        JSON.stringify(snapshots),
        now,
        now
      );
    this.pruneQueryReviewQueue(retention, now);
  }

  private pruneQueryReviewQueue(retention: QueryReviewRetention, now: string) {
    const retentionDays = Math.max(1, Math.floor(retention.retentionDays));
    const maxQueries = Math.max(1, Math.floor(retention.maxQueries));
    const cutoff = new Date(Date.parse(now) - retentionDays * 86_400_000).toISOString();
    this.db.prepare("DELETE FROM query_review_queue WHERE created_at < ?").run(cutoff);
    this.db
      .prepare(
        `DELETE FROM query_review_queue
         WHERE id NOT IN (
          SELECT id
          FROM query_review_queue
          ORDER BY created_at DESC, id DESC
          LIMIT ?
         )`
      )
      .run(maxQueries);
  }

  private runOptionalTraceWrite(strict: boolean, write: () => void) {
    this.db.exec("SAVEPOINT recommendation_trace_write");
    try {
      write();
      this.db.exec("RELEASE recommendation_trace_write");
    } catch (error) {
      this.db.exec("ROLLBACK TO recommendation_trace_write");
      this.db.exec("RELEASE recommendation_trace_write");
      if (strict) throw error;
    }
  }

  private recordRecommendationTraceRows(sessionId: string, trace: RecommendationRunTraceRecord, now: string) {
    const insertProvenance = this.db.prepare(
      `INSERT INTO recommendation_candidate_provenance (
        session_id, media_item_id, source, score, source_rank, detail_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    let provenanceRowCount = 0;
    for (const provenance of Object.values(trace.provenanceByItemId)) {
      for (const source of provenance.sources) {
        if (provenanceRowCount >= maxNormalizedTraceProvenanceRows) break;
        insertProvenance.run(sessionId, provenance.itemId, source.source, source.score, source.rank ?? null, JSON.stringify(source), now);
        provenanceRowCount += 1;
      }
      if (provenanceRowCount >= maxNormalizedTraceProvenanceRows) break;
    }

    const insertRejection = this.db.prepare(
      `INSERT INTO recommendation_rejections (
        session_id, media_item_id, stage, reason_code, score, detail_json, sampled, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const rejection of trace.rejections.slice(0, maxNormalizedTraceRejectionRows)) {
      insertRejection.run(
        sessionId,
        rejection.itemId,
        rejection.stage,
        rejection.reasonCode,
        rejection.score ?? null,
        JSON.stringify(rejection),
        rejection.sampled ? 1 : 0,
        now
      );
    }
  }

  private recordRecommendationImpressionRows(sessionId: string, results: ItemSummary[], now: string) {
    const insert = this.db.prepare(
      `INSERT INTO recommendation_impressions (
        session_id, media_item_id, rank_shown, surface, visibility, action, dwell_ms, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    results.forEach((item, index) => {
      insert.run(
        sessionId,
        item.id,
        index + 1,
        "search_results",
        "server_returned",
        "none",
        null,
        JSON.stringify({ availabilityGroup: item.availabilityGroup }),
        now
      );
    });
  }

  private recordFeedbackRows(sessionId: string, watchContext: WatchContext, feedback: RecommendationRunRecord["feedback"], authUserId?: string) {
    if (!feedback) return;
    const now = new Date().toISOString();
    const insert = this.db.prepare(
      "INSERT INTO recommendation_feedback (session_id, media_item_id, watch_context, feedback, created_at) VALUES (?, ?, ?, ?, ?)"
    );
    const exists = this.db.prepare("SELECT 1 FROM media_items WHERE id = ? LIMIT 1");
    const run = (itemId: string, value: string) => {
      if (exists.get(itemId)) insert.run(sessionId, itemId, watchContext, value, now);
    };
    for (const itemId of feedback.moreLikeItemIds ?? []) run(itemId, "up");
    for (const itemId of feedback.preferredExampleItemIds ?? []) run(itemId, "preferred");
    for (const itemId of feedback.maybeItemIds ?? []) run(itemId, "maybe");
    for (const itemId of feedback.lessLikeItemIds ?? []) run(itemId, "down");
    for (const itemId of feedback.hiddenItemIds ?? []) run(itemId, "hidden");
    this.updatePreferenceWeights(watchContext, feedback, authUserId);
  }

  private applyFeelFeedbackPreferenceSignal(
    watchContext: WatchContext,
    action: FeelFeedbackAction,
    itemId: string | undefined,
    comparedItemId: string | undefined,
    authUserId?: string
  ) {
    if (action === "pairwise_pick" && itemId && comparedItemId) {
      this.updatePreferenceWeights(watchContext, { moreLikeItemIds: [itemId], lessLikeItemIds: [comparedItemId] }, authUserId);
      return true;
    }
    if (!itemId) return false;
    if (positiveFeelActions.has(action)) {
      this.updatePreferenceWeights(watchContext, { moreLikeItemIds: [itemId] }, authUserId);
      return true;
    }
    if (negativeFeelActions.has(action)) {
      this.updatePreferenceWeights(watchContext, { lessLikeItemIds: [itemId] }, authUserId);
      return true;
    }
    if (action === "hide") {
      this.updatePreferenceWeights(watchContext, { hiddenItemIds: [itemId] }, authUserId);
      return true;
    }
    return false;
  }

  private applyFeelFeedbackProfileSignal(
    watchContext: WatchContext,
    action: FeelFeedbackAction,
    reliability: FeelFeedbackReliability,
    sessionId: string | undefined,
    itemId: string | undefined,
    comparedItemId: string | undefined,
    moodTerm: string | null,
    reason: string | null,
    eventId: number,
    strength: number | undefined,
    authUserId?: string
  ) {
    if (!moodTerm) return { applied: false } as const;
    if (!profileLearningActions.has(action)) return { applied: false } as const;
    if (reliability === "weak" || reliability === "diagnostic") return { applied: false } as const;
    if (sessionId && this.profileUpdatesForSessionTerm(sessionId, moodTerm) >= maxProfileUpdatesPerSessionTerm) return { applied: false } as const;
    const updates: { itemId: string; direction: 1 | -1 }[] = [];
    if (action === "pairwise_pick" && itemId && comparedItemId) {
      updates.push({ itemId, direction: 1 }, { itemId: comparedItemId, direction: -1 });
    } else if (itemId && positiveFeelActions.has(action)) {
      updates.push({ itemId, direction: 1 });
    } else if (itemId && (negativeFeelActions.has(action) || action === "hide")) {
      updates.push({ itemId, direction: -1 });
    }
    if (updates.length === 0) return { applied: false } as const;

    const deltas = new Map<string, number>();
    const reliabilityWeight = feelReliabilityWeight(reliability);
    const strengthScale = typeof strength === "number" ? 0.7 + clampNumber(strength, 1, 5) * 0.08 : 1;
    for (const update of updates) {
      for (const feature of this.feelProfileFeaturesForItem(update.itemId)) {
        const amount = Number((profileLearningRate(feature) * strengthScale * reliabilityWeight * update.direction).toFixed(3));
        deltas.set(feature, Number(((deltas.get(feature) ?? 0) + amount).toFixed(3)));
      }
    }
    const reasonDirection = feedbackDirection(action);
    if (reason && reasonDirection !== 0) {
      for (const [feature, weight] of reasonFeatureDeltas(reason)) {
        const amount = Number((profileLearningRate(feature) * strengthScale * reliabilityWeight * reasonDirection * weight).toFixed(3));
        deltas.set(feature, Number(((deltas.get(feature) ?? 0) + amount).toFixed(3)));
      }
    }
    if (deltas.size === 0) return { applied: false } as const;

    this.ensurePreferenceProfile(watchContext, authUserId);
    const profileId = preferenceProfileId(watchContext, authUserId);
    const now = new Date().toISOString();
    const nextVersion = this.currentProfileVersion(watchContext, authUserId) + 1;
    const existing = this.db
      .prepare(
        `SELECT profile_id, watch_context, term, feature_weights_json, confidence, evidence_count,
          positive_count, negative_count, positive_weight, negative_weight, effective_evidence, conflict_score,
          version, updated_at
         FROM feel_profile_terms
         WHERE profile_id = ? AND term = ?`
      )
      .get(profileId, moodTerm) as FeelProfileTermRow | undefined;
    const currentWeights = parseFeatureWeights(existing?.feature_weights_json ?? "{}");
    for (const [feature, delta] of deltas) {
      currentWeights[feature] = Number(clampNumber((currentWeights[feature] ?? 0) + delta, -6, 6).toFixed(3));
      if (Math.abs(currentWeights[feature]) < 0.001) delete currentWeights[feature];
    }
    const nextWeights = trimFeatureWeights(currentWeights);
    const evidenceCount = (existing?.evidence_count ?? 0) + 1;
    const positiveCount = (existing?.positive_count ?? 0) + (updates.some((update) => update.direction > 0) ? 1 : 0);
    const negativeCount = (existing?.negative_count ?? 0) + (updates.some((update) => update.direction < 0) ? 1 : 0);
    const evidencePolarity = feedbackEvidencePolarity(action);
    const positiveWeight = Number(((existing?.positive_weight ?? 0) + (evidencePolarity > 0 ? reliabilityWeight : 0)).toFixed(3));
    const negativeWeight = Number(((existing?.negative_weight ?? 0) + (evidencePolarity < 0 ? reliabilityWeight : 0)).toFixed(3));
    const conflictScore = profileConflictScore(positiveWeight, negativeWeight);
    const effectiveEvidence = profileEffectiveEvidence(positiveWeight, negativeWeight, conflictScore);
    this.db
      .prepare(
        `INSERT INTO feel_profile_terms (
          profile_id, watch_context, term, feature_weights_json, confidence, evidence_count,
          positive_count, negative_count, positive_weight, negative_weight, effective_evidence, conflict_score,
          version, last_event_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(profile_id, term) DO UPDATE SET
          feature_weights_json = excluded.feature_weights_json,
          confidence = excluded.confidence,
          evidence_count = excluded.evidence_count,
          positive_count = excluded.positive_count,
          negative_count = excluded.negative_count,
          positive_weight = excluded.positive_weight,
          negative_weight = excluded.negative_weight,
          effective_evidence = excluded.effective_evidence,
          conflict_score = excluded.conflict_score,
          version = excluded.version,
          last_event_id = excluded.last_event_id,
          updated_at = excluded.updated_at`
      )
      .run(
        profileId,
        watchContext,
        moodTerm,
        JSON.stringify(nextWeights),
        profileConfidence(effectiveEvidence),
        evidenceCount,
        positiveCount,
        negativeCount,
        positiveWeight,
        negativeWeight,
        effectiveEvidence,
        conflictScore,
        nextVersion,
        eventId,
        now,
        now
      );
    this.db
      .prepare(
        `INSERT OR REPLACE INTO feel_profile_checkpoints (
          profile_id, watch_context, term, version, feature_weights_json, confidence, evidence_count,
          positive_count, negative_count, positive_weight, negative_weight, effective_evidence,
          conflict_score, event_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        profileId,
        watchContext,
        moodTerm,
        nextVersion,
        JSON.stringify(nextWeights),
        profileConfidence(effectiveEvidence),
        evidenceCount,
        positiveCount,
        negativeCount,
        positiveWeight,
        negativeWeight,
        effectiveEvidence,
        conflictScore,
        eventId,
        now
      );
    return { applied: true, profileVersion: nextVersion } as const;
  }

  private updatePreferenceWeights(watchContext: WatchContext, feedback: RecommendationRunRecord["feedback"], authUserId?: string) {
    if (!feedback) return;
    this.ensurePreferenceProfile(watchContext, authUserId);
    const profileId = preferenceProfileId(watchContext, authUserId);
    const now = new Date().toISOString();
    const current = this.preferenceWeights(watchContext, authUserId);
    const deltas = new Map<string, number>();
    const addDeltas = (itemIds: string[] | undefined, direction: number) => {
      for (const itemId of itemIds ?? []) {
        for (const feature of this.preferenceFeaturesForItem(itemId)) {
          deltas.set(feature, (deltas.get(feature) ?? 0) + direction);
        }
      }
    };
    addDeltas(feedback.moreLikeItemIds, 0.22);
    addDeltas(feedback.preferredExampleItemIds, 0.38);
    addDeltas(feedback.lessLikeItemIds, -0.26);
    addDeltas(feedback.hiddenItemIds, -0.12);
    if (deltas.size === 0) return;

    const upsert = this.db.prepare(
      `INSERT INTO preference_feature_weights (profile_id, feature, weight, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(profile_id, feature) DO UPDATE SET
        weight = excluded.weight,
        updated_at = excluded.updated_at`
    );
    for (const [feature, delta] of deltas) {
      const nextWeight = Math.max(-6, Math.min(6, Number(((current.get(feature) ?? 0) + delta).toFixed(3))));
      upsert.run(profileId, feature, nextWeight, now);
    }
  }

  private ensurePreferenceProfile(watchContext: WatchContext, authUserId?: string) {
    const now = new Date().toISOString();
    const profileId = preferenceProfileId(watchContext, authUserId);
    const ownerUserId = watchContext === "solo" ? authUserId ?? null : null;
    this.db
      .prepare(
        `INSERT INTO preference_profiles (id, watch_context, label, created_at, updated_at, auth_user_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`
      )
      .run(profileId, watchContext, watchContext === "group" ? "Together" : "For Me", now, now, ownerUserId);
  }

  private preferenceDiagnostics(watchContext: WatchContext, authUserId?: string) {
    const weights = [...this.preferenceWeights(watchContext, authUserId).entries()].map(([feature, weight]) => ({ feature, weight }));
    return {
      positive: weights
        .filter((entry) => entry.weight > 0)
        .sort((a, b) => b.weight - a.weight || a.feature.localeCompare(b.feature))
        .slice(0, 8),
      negative: weights
        .filter((entry) => entry.weight < 0)
        .sort((a, b) => a.weight - b.weight || a.feature.localeCompare(b.feature))
        .slice(0, 8)
    };
  }

  private preferenceFeaturesForItem(itemId: string) {
    const item = this.findById(itemId);
    if (!item) return [];
    const row = this.db
      .prepare("SELECT mood_terms_json, tone_terms_json, watchability_terms_json FROM media_features WHERE media_item_id = ?")
      .get(itemId) as
      | {
          mood_terms_json: string;
          tone_terms_json: string;
          watchability_terms_json: string;
        }
      | undefined;
    const terms = [
      `media:${item.mediaType}`,
      ...item.genres.map((genre) => `genre:${normalizeTitle(genre)}`),
      ...parseJsonStringArray(row?.mood_terms_json ?? "[]").map((term) => `mood:${normalizeTitle(term)}`),
      ...parseJsonStringArray(row?.tone_terms_json ?? "[]").map((term) => `tone:${normalizeTitle(term)}`),
      ...parseJsonStringArray(row?.watchability_terms_json ?? "[]").map((term) => `watch:${normalizeTitle(term)}`),
      runtimePreferenceFeature(item.runtimeMinutes, item.mediaType),
      ratingPreferenceFeature(item.contentRating)
    ];
    return unique(terms.filter((term): term is string => Boolean(term)));
  }

  private feelProfileFeaturesForItem(itemId: string) {
    const item = this.findById(itemId);
    if (!item) return [];
    const feature = this.storedFeatureForItem(itemId);
    return itemProfileFeatureKeys(item, feature).filter(isLearnableFeelProfileFeature);
  }

  private storedFeatureForItem(itemId: string) {
    const row = this.db
      .prepare(
        `SELECT media_item_id, feature_text, mood_terms_json, tone_terms_json,
          watchability_terms_json, vector_json, feature_version
         FROM media_features
         WHERE media_item_id = ?`
      )
      .get(itemId) as
      | {
          media_item_id: string;
          feature_text: string;
          mood_terms_json: string;
          tone_terms_json: string;
          watchability_terms_json: string;
          vector_json: string;
          feature_version: string;
        }
      | undefined;
    return row ? inflateFeature(row) : undefined;
  }

  private storedFeatureDocumentForItem(itemId: string): MediaFeatureDocument | undefined {
    const stored = this.storedFeatureForItem(itemId);
    return stored
      ? {
          mediaItemId: stored.mediaItemId,
          featureText: stored.featureText,
          moodTerms: stored.moodTerms,
          toneTerms: stored.toneTerms,
          watchabilityTerms: stored.watchabilityTerms,
          vector: stored.vector,
          version: stored.featureVersion
        }
      : undefined;
  }

  private mediaItemExists(itemId: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM media_items WHERE id = ? LIMIT 1").get(itemId));
  }

  private validateFeedbackSession(sessionId: string, authUserId: string | undefined, itemId?: string, comparedItemId?: string) {
    const session = this.db.prepare("SELECT auth_user_id FROM recommendation_sessions WHERE id = ? LIMIT 1").get(sessionId) as
      | { auth_user_id?: string | null }
      | undefined;
    if (!session) {
      throw Object.assign(new Error("Feel feedback sessionId must reference a known recommendation session."), { statusCode: 400 });
    }
    if ((session.auth_user_id ?? undefined) !== authUserId) {
      throw Object.assign(new Error("Feel feedback session belongs to a different user."), { statusCode: 403 });
    }
    const belongsToSlate = this.db.prepare("SELECT 1 FROM recommendation_results WHERE session_id = ? AND media_item_id = ? LIMIT 1");
    if (itemId && !belongsToSlate.get(sessionId, itemId)) {
      throw Object.assign(new Error("Feel feedback itemId must belong to the referenced recommendation session."), { statusCode: 400 });
    }
    if (comparedItemId && !belongsToSlate.get(sessionId, comparedItemId)) {
      throw Object.assign(new Error("Feel feedback comparedItemId must belong to the referenced recommendation session."), { statusCode: 400 });
    }
  }

  private currentProfileVersion(watchContext: WatchContext, authUserId?: string) {
    const profileId = preferenceProfileId(watchContext, authUserId);
    const row = this.db.prepare("SELECT COALESCE(MAX(version), 0) AS value FROM feel_profile_terms WHERE profile_id = ?").get(profileId) as { value: number };
    return Number(row.value) || 0;
  }

  private profileUpdatesForSessionTerm(sessionId: string, moodTerm: string) {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS value
         FROM feel_feedback_events
         WHERE session_id = ?
          AND mood_term = ?
          AND profile_update_applied = 1`
      )
      .get(sessionId, moodTerm) as { value: number };
    return Number(row.value) || 0;
  }

  private profileCheckpoint(profileId: string, term: string, direction: "<=" | ">", version: number): FeelProfileCheckpointRow | undefined {
    const operator = direction === "<=" ? "<=" : ">";
    const order = direction === "<=" ? "DESC" : "ASC";
    return this.db
      .prepare(
        `SELECT profile_id, watch_context, term, feature_weights_json, confidence, evidence_count,
          positive_count, negative_count, positive_weight, negative_weight, effective_evidence,
          conflict_score, version, event_id, created_at, created_at AS updated_at
         FROM feel_profile_checkpoints
         WHERE profile_id = ?
          AND term = ?
          AND version ${operator} ?
         ORDER BY version ${order}
         LIMIT 1`
      )
      .get(profileId, term, version) as FeelProfileCheckpointRow | undefined;
  }

  private feelProfileTimelineDiagnostics(limit = 16) {
    const normalizedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const total = (this.db.prepare("SELECT COUNT(*) AS value FROM feel_profile_checkpoints").get() as { value: number }).value;
    const rows = this.db
      .prepare(
        `SELECT profile_id, watch_context, term, version, confidence, evidence_count,
          positive_weight, negative_weight, effective_evidence, conflict_score, event_id, created_at
         FROM feel_profile_checkpoints
         ORDER BY created_at DESC, version DESC, profile_id, term
         LIMIT ?`
      )
      .all(normalizedLimit) as Array<{
      profile_id: string;
      watch_context: WatchContext;
      term: string;
      version: number;
      confidence: number;
      evidence_count: number;
      positive_weight: number;
      negative_weight: number;
      effective_evidence: number;
      conflict_score: number;
      event_id?: number | null;
      created_at: string;
    }>;
    return {
      totalCheckpoints: total,
      recent: rows.map((row) => ({
        profileId: row.profile_id,
        watchContext: row.watch_context,
        term: row.term,
        version: row.version,
        confidence: row.confidence,
        evidenceCount: row.evidence_count,
        positiveWeight: row.positive_weight,
        negativeWeight: row.negative_weight,
        effectiveEvidence: row.effective_evidence,
        conflictScore: row.conflict_score,
        eventId: row.event_id ?? undefined,
        createdAt: row.created_at
      }))
    };
  }

  private feelProfileDriftDiagnostics(limit = 12) {
    const normalizedLimit = Math.max(1, Math.min(50, Math.floor(limit)));
    const rows = this.db
      .prepare(
        `SELECT profile_id, watch_context, term, version, evidence_count,
          positive_weight, negative_weight, effective_evidence, conflict_score, updated_at
         FROM feel_profile_terms
         WHERE evidence_count >= 4
          AND (
            conflict_score >= 0.35
            OR (
              positive_weight > 0
              AND negative_weight > 0
              AND effective_evidence < (positive_weight + negative_weight) * 0.72
            )
          )
         ORDER BY conflict_score DESC, updated_at DESC, profile_id, term
         LIMIT ?`
      )
      .all(normalizedLimit) as Array<{
      profile_id: string;
      watch_context: WatchContext;
      term: string;
      version: number;
      evidence_count: number;
      positive_weight: number;
      negative_weight: number;
      effective_evidence: number;
      conflict_score: number;
      updated_at: string;
    }>;
    return {
      totalAlerts: rows.length,
      alerts: rows.map((row) => ({
        profileId: row.profile_id,
        watchContext: row.watch_context,
        term: row.term,
        version: row.version,
        severity: row.conflict_score >= 0.55 ? "review" as const : "watch" as const,
        conflictScore: row.conflict_score,
        effectiveEvidence: row.effective_evidence,
        evidenceCount: row.evidence_count,
        positiveWeight: row.positive_weight,
        negativeWeight: row.negative_weight,
        recommendation: row.conflict_score >= 0.55 ? "review_or_rollback" as const : "monitor" as const,
        updatedAt: row.updated_at
      }))
    };
  }

  private replayStorageDiagnostics() {
    const sessions = (this.db.prepare("SELECT COUNT(*) AS value FROM recommendation_sessions").get() as { value: number }).value;
    const resultRows = (this.db.prepare("SELECT COUNT(*) AS value FROM recommendation_results").get() as { value: number }).value;
    const feedbackEvents = (this.db.prepare("SELECT COUNT(*) AS value FROM feel_feedback_events").get() as { value: number }).value;
    const holdoutEvents = (this.db.prepare("SELECT COALESCE(SUM(profile_holdout), 0) AS value FROM feel_feedback_events").get() as { value: number }).value;
    const checkpoints = (this.db.prepare("SELECT COUNT(*) AS value FROM feel_profile_checkpoints").get() as { value: number }).value;
    return {
      sessions,
      resultRows,
      feedbackEvents,
      holdoutEvents,
      checkpoints,
      retentionPolicy: defaultReplayRetentionPolicy
    };
  }

  private replayProfileScore(item: ItemDetail, feature: StoredMediaFeature | undefined, checkpoint: FeelProfileCheckpointRow | undefined) {
    if (!checkpoint) return 50;
    const profile: FeelProfile = {
      id: checkpoint.profile_id,
      label: "Replay checkpoint",
      watchContext: checkpoint.watch_context,
      terms: [
        {
          term: checkpoint.term,
          featureWeights: parseFeatureWeights(checkpoint.feature_weights_json),
          confidence: checkpoint.confidence,
          evidenceCount: checkpoint.evidence_count,
          positiveWeight: checkpoint.positive_weight,
          negativeWeight: checkpoint.negative_weight,
          effectiveEvidence: checkpoint.effective_evidence,
          conflictScore: checkpoint.conflict_score
        }
      ]
    };
    const adjustment = buildFeelProfileAdjustment(profile, checkpoint.term);
    return scoreFeelProfileFit(item, feature, adjustment) ?? 50;
  }

  private recentRecommendationSlates(limit: number, authUserId?: string): RecommendationReplaySlate[] {
    const normalizedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const authWhere = authUserId ? "WHERE auth_user_id = ?" : "";
    const authValues = authUserId ? [authUserId] : [];
    const sessions = this.db
      .prepare(
        `SELECT id, query_hash, engine_version, model, watch_context, result_count, candidate_count,
          rerank_candidate_count, used_ai, seerr_augmented, latency_ms, profile_id, profile_version, created_at
         FROM recommendation_sessions
         ${authWhere}
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(...authValues, normalizedLimit) as Array<{
      id: string;
      query_hash: string;
      engine_version: string;
      model?: string | null;
      watch_context: WatchContext;
      result_count: number;
      candidate_count: number;
      rerank_candidate_count: number;
      used_ai: number;
      seerr_augmented: number;
      latency_ms: number;
      profile_id?: string | null;
      profile_version: number;
      created_at: string;
    }>;
    if (sessions.length === 0) return [];

    const resultRows = this.db
      .prepare(
        `SELECT session_id, media_item_id, rank, score, score_breakdown_json, availability_group, feature_version
         FROM recommendation_results
         WHERE session_id IN (${sessions.map(() => "?").join(", ")})
         ORDER BY session_id, rank`
      )
      .all(...sessions.map((session) => session.id)) as Array<{
      session_id: string;
      media_item_id: string;
      rank: number;
      score: number;
      score_breakdown_json: string;
      availability_group: AvailabilityGroup;
      feature_version?: string | null;
    }>;
    const resultsBySession = new Map<string, typeof resultRows>();
    for (const row of resultRows) {
      const rows = resultsBySession.get(row.session_id) ?? [];
      rows.push(row);
      resultsBySession.set(row.session_id, rows);
    }

    return sessions.map((session) => ({
      sessionId: session.id,
      queryHash: session.query_hash,
      engineVersion: session.engine_version,
      model: session.model ?? undefined,
      watchContext: session.watch_context,
      resultCount: session.result_count,
      candidateCount: session.candidate_count,
      rerankCandidateCount: session.rerank_candidate_count,
      usedAi: Boolean(session.used_ai),
      seerrAugmented: Boolean(session.seerr_augmented),
      latencyMs: session.latency_ms,
      profileId: session.profile_id ?? undefined,
      profileVersion: session.profile_version,
      createdAt: session.created_at,
      results: (resultsBySession.get(session.id) ?? []).map((row) => ({
        itemId: row.media_item_id,
        rank: row.rank,
        score: row.score,
        scoreBreakdown: parseNumberRecord(row.score_breakdown_json),
        availabilityGroup: row.availability_group,
        featureVersion: row.feature_version ?? undefined
      }))
    }));
  }
}

export function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function redactedQueryReviewLabel(query: string) {
  const hash = crypto.createHash("sha256").update(query.toLowerCase().trim()).digest("hex").slice(0, 12);
  return `[redacted-query:${hash}]`;
}

function toQueryReviewSnapshot(item: ItemSummary): QueryReviewResultSnapshot {
  return {
    id: item.id,
    title: item.title,
    mediaType: item.mediaType,
    year: item.year,
    genres: item.genres.slice(0, 8),
    score: item.score,
    matchExplanation: item.matchExplanation,
    availabilityGroup: item.availabilityGroup
  };
}

function inflateQueryReviewQueueItem(row: QueryReviewQueueRow): QueryReviewQueueItem {
  return {
    id: row.id,
    sessionId: row.session_id,
    query: row.query_text,
    optimizedQuery: row.optimized_query ?? undefined,
    watchContext: row.watch_context,
    resultCount: row.result_count,
    results: parseQueryReviewSnapshots(row.results_json),
    moodFitRating: row.mood_fit_rating ?? undefined,
    moodFeedbackText: row.mood_feedback_text ?? undefined,
    reviewedAt: row.reviewed_at ?? undefined,
    createdAt: row.created_at
  };
}

function parseQueryReviewSnapshots(value: string): QueryReviewResultSnapshot[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry): QueryReviewResultSnapshot | undefined => {
        if (!entry || typeof entry !== "object") return undefined;
        const row = entry as Partial<QueryReviewResultSnapshot>;
        if (typeof row.id !== "string" || typeof row.title !== "string") return undefined;
        if (row.mediaType !== "movie" && row.mediaType !== "tv") return undefined;
        if (!isAvailabilityGroup(row.availabilityGroup)) return undefined;
        const snapshot: QueryReviewResultSnapshot = {
          id: row.id,
          title: row.title,
          mediaType: row.mediaType,
          genres: Array.isArray(row.genres) ? row.genres.filter((genre): genre is string => typeof genre === "string").slice(0, 8) : [],
          score: typeof row.score === "number" ? row.score : 0,
          matchExplanation: typeof row.matchExplanation === "string" ? row.matchExplanation : "",
          availabilityGroup: row.availabilityGroup
        };
        if (typeof row.year === "number") snapshot.year = row.year;
        return snapshot;
      })
      .filter((entry): entry is QueryReviewResultSnapshot => Boolean(entry))
      .slice(0, 24);
  } catch {
    return [];
  }
}

function isAvailabilityGroup(value: unknown): value is AvailabilityGroup {
  return (
    value === "available_in_plex" ||
    value === "not_in_plex_requestable" ||
    value === "already_requested" ||
    value === "partially_available" ||
    value === "unavailable"
  );
}

function queryReviewWhereClause(status: QueryReviewStatus) {
  if (status === "reviewed") return "WHERE reviewed_at IS NOT NULL";
  if (status === "pending") return "WHERE reviewed_at IS NULL";
  return "";
}

function cleanExternalIds(ids: IngestMediaRecord["externalIds"] = {}) {
  return Object.fromEntries(
    Object.entries(ids)
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== null && String(entry[1]).trim().length > 0)
      .map(([source, value]) => [source.toLowerCase(), String(value)])
  );
}

function imdbTitleUrl(value: string | undefined) {
  const id = value?.trim();
  if (!id || !/^tt\d{7,10}$/i.test(id)) return undefined;
  return `https://www.imdb.com/title/${id.toLowerCase()}/`;
}

function makeMediaId(mediaType: MediaType, normalizedTitle: string, year: number | undefined, externalIds: Record<string, string>) {
  const stableKey = externalIds.tmdb ?? externalIds.imdb ?? externalIds.tvdb ?? externalIds.wikidata ?? externalIds.plex ?? `${normalizedTitle}:${year ?? "unknown"}`;
  return `${mediaType}:${stableKey}`;
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function cleanOptionalId(value: string | undefined) {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function cleanShortText(value: string | undefined, maxLength: number, normalize: boolean) {
  const cleaned = value?.trim();
  if (!cleaned) return null;
  const bounded = cleaned.slice(0, maxLength);
  return normalize ? normalizeTitle(bounded) : bounded;
}

function cleanRequiredText(value: string | undefined, maxLength: number, label: string) {
  const cleaned = cleanOptionalText(value, maxLength);
  if (!cleaned) throw Object.assign(new Error(`${label} is required.`), { statusCode: 400 });
  return cleaned;
}

function cleanOptionalText(value: string | undefined, maxLength: number) {
  const cleaned = value?.trim();
  return cleaned ? cleaned.slice(0, maxLength) : null;
}

function normalizeCatalogSource(value: string) {
  const normalized = normalizeTitle(value);
  if (!normalized) throw Object.assign(new Error("Catalog source is required."), { statusCode: 400 });
  return normalized.slice(0, 80);
}

function safeCatalogMetadata(metadata: CatalogIngestRecord["metadata"]) {
  if (!metadata) return {};
  const safe: Record<string, string | number | boolean | null | string[] | number[]> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (Object.keys(safe).length >= 64) break;
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      const safeArray = value
        .filter((entry): entry is string | number => typeof entry === "string" || typeof entry === "number")
        .map((entry) => String(entry).slice(0, 160))
        .slice(0, 32);
      if (safeArray.length === 0) continue;
      const safeKey = normalizeTitle(key).slice(0, 80);
      if (!safeKey) continue;
      safe[safeKey] = safeArray;
      continue;
    }
    if (value !== null && !["string", "number", "boolean"].includes(typeof value)) continue;
    const safeKey = normalizeTitle(key).slice(0, 80);
    if (!safeKey) continue;
    safe[safeKey] = typeof value === "string" ? value.slice(0, 500) : value;
  }
  return safe;
}

function defaultCatalogMetadataConfidence(record: CatalogIngestRecord) {
  let confidence = 0.35;
  if (record.media.summary?.trim()) confidence += 0.16;
  if (record.media.genres?.length) confidence += 0.12;
  if (record.media.cast?.length || record.media.directors?.length) confidence += 0.08;
  if (Object.keys(record.media.externalIds ?? {}).length > 1) confidence += 0.08;
  if (record.sitelinkCount && record.sitelinkCount > 0) confidence += Math.min(0.16, record.sitelinkCount / 400);
  return Number(clampNumber(confidence, 0.2, 0.82).toFixed(3));
}

function catalogMetadataSearchText(catalog: NonNullable<ItemDetail["metadata"]>["catalog"] | undefined) {
  if (!catalog) return "";
  return [
    ...(catalog.sources ?? []),
    ...(catalog.aliases ?? []),
    ...(catalog.countries ?? []),
    ...(catalog.languages ?? []),
    ...(catalog.franchises ?? []),
    (catalog.mainstreamScore ?? 0) >= 76 ? "mainstream friendly popular recognizable" : "",
    (catalog.sitelinkCount ?? 0) >= 80 ? "well known" : "",
    (catalog.awardCount ?? 0) >= 2 ? "award recognized acclaimed" : "",
    catalog.hasEnglishWikipedia ? "english wikipedia" : ""
  ]
    .filter(Boolean)
    .join(" ");
}

function catalogMetadataMoodTerms(catalog: NonNullable<ItemDetail["metadata"]>["catalog"] | undefined) {
  if (!catalog) return [];
  return [
    (catalog.mainstreamScore ?? 0) >= 76 ? "mainstream-friendly" : "",
    (catalog.mainstreamScore ?? 0) >= 52 ? "recognizable" : "",
    (catalog.awardCount ?? 0) >= 2 ? "award-recognized" : "",
    catalog.franchises?.length ? "franchise-entry familiar-world" : "",
    ...(catalog.countries ?? []).map((country) => `country-${normalizeTitle(country).replace(/\s+/g, "-")}`),
    ...(catalog.languages ?? []).map((language) => `language-${normalizeTitle(language).replace(/\s+/g, "-")}`)
  ].filter(Boolean);
}

function normalizeFeelReason(value: string | undefined) {
  const cleaned = cleanShortText(value, 240, false);
  if (!cleaned) return null;
  return cleaned
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || null;
}

function feelFeedbackReliability(action: FeelFeedbackAction): FeelFeedbackReliability {
  if (action === "right_mood" || action === "wrong_mood" || action === "pairwise_pick") return "high";
  if (action === "swipe_right" || action === "swipe_left" || action === "save" || action === "hide" || action === "more_like" || action === "less_like") {
    return "medium";
  }
  if (action === "request_create") return "weak";
  return "diagnostic";
}

function feelReliabilityWeight(reliability: FeelFeedbackReliability) {
  if (reliability === "high") return 1;
  if (reliability === "medium") return 0.55;
  if (reliability === "weak") return 0.2;
  return 0;
}

function shouldHoldoutProfileSignal(reliability: FeelFeedbackReliability, moodTerm: string | null, eventId: number) {
  if (!moodTerm) return false;
  if (reliability !== "high" && reliability !== "medium") return false;
  return eventId > 0 && eventId % 10 === 0;
}

function replayRetentionPolicy(overrides: Partial<ReplayRetentionPolicy>): ReplayRetentionPolicy {
  return {
    retentionDays: boundedInteger(overrides.retentionDays, defaultReplayRetentionPolicy.retentionDays, 1, 3650),
    maxSessions: boundedInteger(overrides.maxSessions, defaultReplayRetentionPolicy.maxSessions, 1, 100000),
    maxFeedbackEvents: boundedInteger(overrides.maxFeedbackEvents, defaultReplayRetentionPolicy.maxFeedbackEvents, 1, 1000000),
    maxCheckpointsPerTerm: boundedInteger(overrides.maxCheckpointsPerTerm, defaultReplayRetentionPolicy.maxCheckpointsPerTerm, 1, 10000)
  };
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function feedbackDirection(action: FeelFeedbackAction): -1 | 0 | 1 {
  if (action === "swipe_right" || action === "save" || action === "more_like" || action === "right_mood") return 1;
  if (action === "swipe_left" || action === "hide" || action === "less_like" || action === "wrong_mood") return -1;
  return 0;
}

function feedbackEvidencePolarity(action: FeelFeedbackAction): -1 | 0 | 1 {
  if (action === "pairwise_pick") return 1;
  return feedbackDirection(action);
}

function reasonFeatureDeltas(reason: string): Array<[string, number]> {
  const features: Record<string, Array<[string, number]>> = {
    too_scary: [
      ["genre:horror", 1.8],
      ["mood:intense", 1.3],
      ["tone:suspenseful", 1.1],
      ["watch:high friction", 1.5],
      ["rating:r", 0.7]
    ],
    too_bleak: [
      ["mood:intense", 0.8],
      ["tone:bleak", 1.5],
      ["tone:dark", 1.1],
      ["watch:high friction", 1.1]
    ],
    too_slow: [
      ["watch:attention heavy", 1.5],
      ["watch:slow burn", 1.4],
      ["runtime:long movie", 1]
    ],
    too_silly: [
      ["genre:comedy", 1.4],
      ["mood:funny", 1.2],
      ["tone:quirky", 0.8]
    ],
    too_cute: [
      ["genre:family", 1.1],
      ["mood:feel good", 0.9],
      ["tone:sweet", 1.3]
    ],
    too_sentimental: [
      ["genre:romance", 0.8],
      ["mood:romantic", 1],
      ["tone:sweet", 1.3]
    ],
    wrong_kind_of_weird: [
      ["mood:weird", 0.8],
      ["watch:attention heavy", 1.2],
      ["watch:high friction", 1],
      ["genre:drama", 0.8]
    ],
    not_available_enough: []
  };
  return features[reason] ?? [];
}

function safeFeelMetadata(metadata: FeelFeedbackRequest["metadata"] = {}) {
  const allowedKeys = new Set(["surface", "gesture", "resultRank", "resultCount", "cardIndex", "calibration", "sourceVersion"]);
  const safeEntries = Object.entries(metadata)
    .filter(([key]) => allowedKeys.has(key))
    .map(([key, value]) => {
      if (typeof value === "string") return [key, value.slice(0, 120)] as const;
      if (typeof value === "number" && Number.isFinite(value)) return [key, value] as const;
      if (typeof value === "boolean" || value === null) return [key, value] as const;
      return undefined;
    })
    .filter((entry): entry is readonly [string, string | number | boolean | null] => Boolean(entry));
  return Object.fromEntries(safeEntries);
}

function feelFeedbackResponseFromRow(row: FeelFeedbackResponseRow, deduped: boolean): FeelFeedbackResponse {
  return {
    ok: true,
    eventId: row.id,
    deduped,
    reliability: row.reliability,
    profileVersion: row.profile_version,
    profileHoldout: Boolean(row.profile_holdout),
    appliedPreferenceSignal: false,
    appliedProfileSignal: Boolean(row.profile_update_applied)
  };
}

function clampNumber(value: number, min: number, max: number) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function clampInteger(value: number, min: number, max: number) {
  return Math.round(clampNumber(value, min, max));
}

function isSparseSeerrPlaceholder(title: string) {
  return /^(movie|tv)\s+\d+$/i.test(title.trim());
}

function getAvailabilityGroup(plex: PlexRow | undefined, seerr: SeerrRow | undefined): AvailabilityGroup {
  if (plex?.available) return "available_in_plex";
  if (seerr?.status === "partially_available") return "partially_available";
  if (seerr?.request_status || ["requested", "pending", "approved", "processing"].includes(seerr?.status ?? "")) return "already_requested";
  if (seerr?.requestable) return "not_in_plex_requestable";
  return "unavailable";
}

function explainAvailability(plex: PlexRow | undefined, seerr: SeerrRow | undefined): string {
  if (plex?.available && seerr?.status && seerr.status !== "available") {
    return `Plex reports this as available; Seerr reports ${seerr.status.replaceAll("_", " ")}.`;
  }
  if (plex?.available) return "Available in Plex.";
  if (seerr?.status === "partially_available") return "Seerr reports this as partially available; Plex did not report a full local match.";
  if (seerr?.request_status) return `Not found in Plex. Seerr request status is ${seerr.request_status}.`;
  if (seerr?.requestable) return "Not found in Plex and Seerr reports it can be requested.";
  return "Not found in Plex and no requestable Seerr status is cached.";
}

function groupNameRows(rows: Array<{ media_item_id: string; name: string }>) {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const values = grouped.get(row.media_item_id) ?? [];
    values.push(row.name);
    grouped.set(row.media_item_id, values);
  }
  return grouped;
}

function scopedMediaPredicate(ids: string[]) {
  const values = unique(ids);
  const placeholders = values.map(() => "?").join(", ");
  return {
    placeholders,
    where: `WHERE media_item_id IN (${placeholders})`,
    values
  };
}

function catalogSearchFilterClause(filters: SearchFilters, alias: string) {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  const column = (name: string) => `${alias}.${name}`;

  if (filters.mediaTypes?.length) {
    clauses.push(`${column("media_type")} IN (${filters.mediaTypes.map(() => "?").join(", ")})`);
    values.push(...filters.mediaTypes);
  }
  if (typeof filters.minYear === "number") {
    clauses.push(`(${column("year")} IS NULL OR ${column("year")} >= ?)`);
    values.push(filters.minYear);
  }
  if (typeof filters.maxYear === "number") {
    clauses.push(`(${column("year")} IS NULL OR ${column("year")} <= ?)`);
    values.push(filters.maxYear);
  }
  if (filters.availability?.length) {
    clauses.push(`${column("availability_group")} IN (${filters.availability.map(() => "?").join(", ")})`);
    values.push(...filters.availability);
  }
  for (const genre of filters.genres ?? []) {
    const normalizedGenre = normalizeTitle(genre);
    if (!normalizedGenre) continue;
    clauses.push(`lower(${column("search_text")}) LIKE ?`);
    values.push(`%${normalizedGenre}%`);
  }
  for (const genre of filters.excludedGenres ?? []) {
    const normalizedGenre = normalizeTitle(genre);
    if (!normalizedGenre) continue;
    clauses.push(`lower(${column("search_text")}) NOT LIKE ?`);
    values.push(`%${normalizedGenre}%`);
  }

  return {
    where: clauses.length ? `AND ${clauses.join(" AND ")}` : "",
    values
  };
}

function normalizeSqlLimit(value: number, min: number, max: number) {
  const parsed = Math.floor(value);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : min;
}

function hasSelectiveSearchFilters(filters: SearchFilters) {
  return Boolean(
    filters.mediaTypes?.length ||
      filters.minRuntimeMinutes !== undefined ||
      filters.maxRuntimeMinutes !== undefined ||
      filters.minYear !== undefined ||
      filters.maxYear !== undefined ||
      filters.genres?.length ||
      filters.excludedGenres?.length ||
      filters.contentRating ||
      filters.availability?.length ||
      filters.requestStatus?.length
  );
}

function inflateFeature(row: {
  media_item_id: string;
  feature_text: string;
  mood_terms_json: string;
  tone_terms_json: string;
  watchability_terms_json: string;
  vector_json: string;
  feature_version: string;
}): StoredMediaFeature {
  return {
    mediaItemId: row.media_item_id,
    featureText: row.feature_text,
    moodTerms: parseJsonStringArray(row.mood_terms_json),
    toneTerms: parseJsonStringArray(row.tone_terms_json),
    watchabilityTerms: parseJsonStringArray(row.watchability_terms_json),
    vector: parseFeatureVector(row.vector_json),
    featureVersion: row.feature_version
  };
}

function parseJsonStringArray(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonRecord(value: string | null | undefined): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function parseFeatureWeights(value: string): Record<string, number> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
        .map(([feature, weight]): [string, number] => [normalizeProfileFeatureKey(feature), clampNumber(weight, -6, 6)])
        .filter(([feature, weight]) => feature.length > 0 && Math.abs(weight) >= 0.001)
    );
  } catch {
    return {};
  }
}

function parseNumberRecord(value: string): Record<string, number> {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
    );
  } catch {
    return {};
  }
}

function inflateFeelProfileTerm(row: FeelProfileTermRow): FeelProfileTermSummary {
  return {
    term: row.term,
    featureWeights: trimFeatureWeights(parseFeatureWeights(row.feature_weights_json)),
    confidence: row.confidence,
    evidenceCount: row.evidence_count,
    positiveCount: row.positive_count,
    negativeCount: row.negative_count,
    positiveWeight: row.positive_weight,
    negativeWeight: row.negative_weight,
    effectiveEvidence: row.effective_evidence,
    conflictScore: row.conflict_score,
    version: row.version,
    updatedAt: row.updated_at
  };
}

function trimFeatureWeights(weights: Record<string, number>) {
  return Object.fromEntries(
    Object.entries(weights)
      .filter(([, weight]) => Math.abs(weight) >= 0.001)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]) || a[0].localeCompare(b[0]))
      .slice(0, 48)
      .map(([feature, weight]) => [feature, Number(weight.toFixed(3))])
  );
}

function profileConfidence(effectiveEvidence: number) {
  const evidence = Math.max(0, effectiveEvidence);
  return Number(Math.min(0.95, evidence / (evidence + 8)).toFixed(3));
}

function profileConflictScore(positiveWeight: number, negativeWeight: number) {
  const total = positiveWeight + negativeWeight;
  if (total <= 0) return 0;
  return Number(clampNumber((2 * Math.min(positiveWeight, negativeWeight)) / total, 0, 1).toFixed(3));
}

function profileEffectiveEvidence(positiveWeight: number, negativeWeight: number, conflictScore: number) {
  const total = positiveWeight + negativeWeight;
  return Number(Math.max(0, total * (1 - clampNumber(conflictScore, 0, 1) * 0.65)).toFixed(3));
}

function profileLearningRate(feature: string) {
  if (feature.startsWith("mood:") || feature.startsWith("tone:")) return 0.22;
  if (feature.startsWith("watch:")) return 0.18;
  if (feature.startsWith("genre:")) return 0.16;
  return 0.08;
}

function normalizeProfileFeatureKey(feature: string) {
  const [namespace, ...rest] = feature.split(":");
  const value = rest.join(":");
  if (!namespace || !value) return "";
  return `${normalizeTitle(namespace)}:${normalizeTitle(value)}`;
}

function isLearnableFeelProfileFeature(feature: string) {
  return !["watch:in plex", "watch:requestable"].includes(feature);
}

function parseNumberArray(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((entry): entry is number => typeof entry === "number" && Number.isFinite(entry))) {
      return [];
    }
    return parsed;
  } catch {
    return [];
  }
}

function isUsableEmbeddingVector(vector: number[], dimensions: number) {
  return dimensions > 0 && vector.length === dimensions && vector.every(Number.isFinite) && vector.some((value) => value !== 0);
}

function usableEmbeddingVectorSql(alias: string) {
  const safeJson = `CASE WHEN json_valid(${alias}.vector_json) THEN ${alias}.vector_json ELSE '[]' END`;
  return `${alias}.dimensions > 0
    AND json_valid(${alias}.vector_json)
    AND json_type(${alias}.vector_json) = 'array'
    AND json_array_length(${alias}.vector_json) = ${alias}.dimensions
    AND NOT EXISTS (
      SELECT 1 FROM json_each(${safeJson})
      WHERE type NOT IN ('integer', 'real') OR ABS(value) > 1.7976931348623157e308
    )
    AND EXISTS (
      SELECT 1 FROM json_each(${safeJson})
      WHERE type IN ('integer', 'real') AND value != 0
    )`;
}

function parseJsonNumberArray(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is number => Number.isInteger(entry) && entry > 0) : [];
  } catch {
    return [];
  }
}

function normalizeCreatedRequestStatus(status: string) {
  if (status === "created" || status === "created_fixture_request") return "pending";
  return status;
}

function buildFtsQuery(query: string) {
  const terms = normalizeTitle(query)
    .split(/\s+/)
    .filter((term) => term.length > 2)
    .slice(0, 8)
    .map((term) => `${term.replace(/"/g, "")}*`);
  return terms.length ? terms.join(" OR ") : "";
}

function hashText(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function preferenceProfileId(watchContext: WatchContext, authUserId?: string) {
  if (watchContext === "group") return "group:shared";
  return authUserId ? `solo:user:${authUserId}` : "solo:default";
}

function runtimePreferenceFeature(runtime: number | undefined, mediaType: MediaType) {
  if (!runtime) return undefined;
  if (mediaType === "tv") return runtime <= 600 ? "runtime:short-series" : "runtime:long-series";
  if (runtime <= 95) return "runtime:short-movie";
  if (runtime <= 125) return "runtime:normal-movie";
  return "runtime:long-movie";
}

function ratingPreferenceFeature(contentRating: string | undefined) {
  return contentRating ? `rating:${normalizeTitle(contentRating)}` : undefined;
}
