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
  SeerrStatus,
  SyncRunSummary,
  WatchContext
} from "../../shared/types";
import { FEATURE_VERSION, buildMediaFeatureDocument, parseFeatureVector, vectorToJson } from "../recommendation/features";
import {
  deterministicMoodFeatureScores,
  moodFeatureScoreFromAggregate,
  normalizeMoodFeatureKey,
  type MoodFeatureScoreInput
} from "../recommendation/moodFeatureIndex";
import { recommendationEngineVersion } from "../recommendation/version";
import { buildFeelProfileAdjustment, itemProfileFeatureKeys, scoreFeelProfileFit, type FeelProfile } from "../recommendation/feelProfile";
import { normalizePlexWebUrl, plexAppUrlFromWebUrl } from "../integrations/plexLinks";
import type { SqliteDatabase } from "./database";

export interface IngestMediaRecord {
  source?: "live" | "fixture";
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
  source: "live" | "fixture";
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
  resultCount: number;
  candidateCount: number;
  rerankCandidateCount: number;
  usedAi: boolean;
  seerrAugmented: boolean;
  latencyMs: number;
  results: ItemSummary[];
  feedback?: {
    moreLikeItemIds?: string[];
    maybeItemIds?: string[];
    lessLikeItemIds?: string[];
    hiddenItemIds?: string[];
  };
  reviewQueue?: QueryReviewRetention;
}

export interface QueryReviewRetention {
  retentionDays: number;
  maxQueries: number;
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

export class MediaRepository {
  constructor(private readonly db: SqliteDatabase) {
    this.backfillFeatures();
    this.backfillMoodFeatureScores();
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

  upsert(record: IngestMediaRecord): string {
    const now = new Date().toISOString();
    const normalizedTitle = normalizeTitle(record.title);
    const externalIds = cleanExternalIds(record.externalIds);
    if (record.seerr?.tmdbId) externalIds.tmdb = String(record.seerr.tmdbId);
    if (record.seerr?.tvdbId) externalIds.tvdb = String(record.seerr.tvdbId);
    if (record.seerr?.imdbId) externalIds.imdb = record.seerr.imdbId;
    if (record.plex?.guid) externalIds.plex = record.plex.guid;

    const existingId = this.findExistingId(record.mediaType, normalizedTitle, record.year, externalIds);
    const id = existingId ?? makeMediaId(record.mediaType, normalizedTitle, record.year, externalIds);
    const existing = existingId
      ? this.db.prepare("SELECT title, normalized_title, runtime_minutes FROM media_items WHERE id = ?").get(existingId) as
          | Pick<MediaRow, "title" | "normalized_title" | "runtime_minutes">
          | undefined
      : undefined;
    const preserveExistingTitle = Boolean(existing && isSparseSeerrPlaceholder(record.title));
    const storedTitle = preserveExistingTitle ? existing!.title : record.title;
    const storedNormalizedTitle = preserveExistingTitle ? existing!.normalized_title : normalizedTitle;
    const preserveExistingRuntime = Boolean(record.seerr && !record.plex && existing?.runtime_minutes);
    const storedRuntimeMinutes = preserveExistingRuntime ? existing!.runtime_minutes : record.runtimeMinutes;

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
          title = excluded.title,
          normalized_title = excluded.normalized_title,
          year = COALESCE(excluded.year, media_items.year),
          summary = COALESCE(excluded.summary, media_items.summary),
          runtime_minutes = COALESCE(excluded.runtime_minutes, media_items.runtime_minutes),
          content_rating = COALESCE(excluded.content_rating, media_items.content_rating),
          poster_path = COALESCE(excluded.poster_path, media_items.poster_path),
          critic_rating = COALESCE(excluded.critic_rating, media_items.critic_rating),
          audience_rating = COALESCE(excluded.audience_rating, media_items.audience_rating),
          user_rating = COALESCE(excluded.user_rating, media_items.user_rating),
          source = CASE WHEN excluded.source = 'live' THEN 'live' ELSE media_items.source END,
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
        now
      });

    const genreUpdate = this.resolveGenreUpdate(id, record);
    if (genreUpdate) this.replaceList("genres", id, genreUpdate);
    if (record.cast !== undefined) this.replacePeople(id, record.cast, "cast");
    if (record.directors !== undefined) this.replacePeople(id, record.directors, "director");
    this.upsertExternalIds(id, externalIds);
    if (record.plex) this.upsertPlex(id, record.plex, now);
    if (record.seerr) this.upsertSeerr(id, record.mediaType, record.seerr, now);
    this.upsertFeature(id, now);
    return id;
  }

  list(): ItemDetail[] {
    const rows = this.db.prepare("SELECT * FROM media_items ORDER BY title").all() as unknown as MediaRow[];
    return rows.map((row) => this.inflate(row));
  }

  findById(id: string): ItemDetail | undefined {
    const row = this.db.prepare("SELECT * FROM media_items WHERE id = ?").get(id) as MediaRow | undefined;
    return row ? this.inflate(row) : undefined;
  }

  findByExternalId(source: string, value: string): ItemDetail | undefined {
    const row = this.db.prepare("SELECT media_item_id FROM external_ids WHERE source = ? AND value = ?").get(source.toLowerCase(), value) as
      | { media_item_id: string }
      | undefined;
    return row ? this.findById(row.media_item_id) : undefined;
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
         ORDER BY CASE WHEN year = ? THEN 0 ELSE 1 END, title
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
    this.db
      .prepare(
        `INSERT INTO requests (media_item_id, media_type, media_id, seasons_json, status, external_request_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(mediaItemId, mediaType, mediaId, seasons ? JSON.stringify(seasons) : null, status, externalRequestId ?? null, now);
    this.db
      .prepare(
        `UPDATE seerr_items
         SET request_status = ?, requestable = 0, status = CASE WHEN status = 'available' THEN status ELSE 'requested' END, last_seen_at = ?
         WHERE media_item_id = ?`
      )
      .run(normalizeCreatedRequestStatus(status), now, mediaItemId);
  }

  getPosterCache(mediaItemId: string): PosterCacheRecord | undefined {
    const row = this.db.prepare("SELECT content_type, body FROM poster_cache WHERE media_item_id = ?").get(mediaItemId) as
      | { content_type: string; body: Uint8Array }
      | undefined;
    if (!row) return undefined;
    return {
      contentType: row.content_type,
      body: Buffer.from(row.body)
    };
  }

  savePosterCache(mediaItemId: string, contentType: string, body: Buffer) {
    this.db
      .prepare(
        `INSERT INTO poster_cache (media_item_id, content_type, body, fetched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(media_item_id) DO UPDATE SET
          content_type = excluded.content_type,
          body = excluded.body,
          fetched_at = excluded.fetched_at`
      )
      .run(mediaItemId, contentType, body, new Date().toISOString());
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
    this.db
      .prepare(`INSERT INTO ${table} (source, status, started_at, finished_at, item_count, error) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(source, status, now, now, itemCount, error ?? null);
  }

  markPlexUnavailableExcept(mediaItemIds: string[]) {
    const now = new Date().toISOString();
    this.db.exec("BEGIN");
    try {
      this.db.exec("CREATE TEMP TABLE IF NOT EXISTS current_plex_sync_ids (media_item_id TEXT PRIMARY KEY)");
      this.db.exec("DELETE FROM current_plex_sync_ids");
      const insert = this.db.prepare("INSERT OR IGNORE INTO current_plex_sync_ids (media_item_id) VALUES (?)");
      for (const mediaItemId of mediaItemIds) insert.run(mediaItemId);
      const result = this.db
        .prepare(
          `UPDATE plex_items
           SET available = 0, last_seen_at = ?
           WHERE available = 1
            AND media_item_id NOT IN (SELECT media_item_id FROM current_plex_sync_ids)`
        )
        .run(now);
      this.db.exec("DELETE FROM current_plex_sync_ids");
      this.db.exec("COMMIT");
      return Number(result.changes);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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

  recordRecommendationRun(record: RecommendationRunRecord) {
    const now = new Date().toISOString();
    const id = randomUUID();
    const queryHash = crypto.createHash("sha256").update(record.query.toLowerCase().trim()).digest("hex");
    const profileId = preferenceProfileId(record.watchContext);
    const profileVersion = this.currentProfileVersion(record.watchContext);
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO recommendation_sessions (
            id, query_hash, engine_version, model, watch_context, result_count, candidate_count, rerank_candidate_count,
            used_ai, seerr_augmented, latency_ms, profile_id, profile_version, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          now
        );
      const insertResult = this.db.prepare(
        `INSERT INTO recommendation_results (
          session_id, media_item_id, rank, score, score_breakdown_json, availability_group, feature_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const featureVersion = this.db.prepare("SELECT feature_version FROM media_features WHERE media_item_id = ?");
      record.results.forEach((item, index) => {
        const featureRow = featureVersion.get(item.id) as { feature_version?: string } | undefined;
        insertResult.run(id, item.id, index + 1, item.score, JSON.stringify(item.scoreBreakdown ?? {}), item.availabilityGroup, featureRow?.feature_version ?? null);
      });
      this.recordFeedbackRows(id, record.watchContext, record.feedback);
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

  recordFeelFeedback(input: FeelFeedbackRequest): FeelFeedbackResponse {
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
    const initialProfileVersion = this.currentProfileVersion(watchContext);
    const duplicate = clientEventId ? this.findFeelFeedbackByClientEventId(source, clientEventId) : undefined;
    if (duplicate) return feelFeedbackResponseFromRow(duplicate, true);

    if (itemId && !this.mediaItemExists(itemId)) {
      throw Object.assign(new Error("Feel feedback itemId must reference a known item."), { statusCode: 400 });
    }
    if (comparedItemId && !this.mediaItemExists(comparedItemId)) {
      throw Object.assign(new Error("Feel feedback comparedItemId must reference a known item."), { statusCode: 400 });
    }
    if (sessionId && !this.recommendationSessionExists(sessionId)) {
      throw Object.assign(new Error("Feel feedback sessionId must reference a known recommendation session."), { statusCode: 400 });
    }

    const result = this.db
      .prepare(
        `INSERT INTO feel_feedback_events (
          session_id, media_item_id, compared_media_item_id, watch_context, source, client_event_id, action, reliability, mood_term, reason,
          strength, metadata_json, profile_version, profile_update_applied, profile_holdout, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        now
      );

    const eventId = Number(result.lastInsertRowid);
    const appliedPreferenceSignal = this.applyFeelFeedbackPreferenceSignal(watchContext, input.action, itemId, comparedItemId);
    const profileHoldout = shouldHoldoutProfileSignal(reliability, moodTerm, eventId);
    if (profileHoldout) {
      this.db.prepare("UPDATE feel_feedback_events SET profile_holdout = 1 WHERE id = ?").run(eventId);
    }
    const profileSignal = profileHoldout
      ? ({ applied: false } as const)
      : this.applyFeelFeedbackProfileSignal(watchContext, input.action, reliability, sessionId, itemId, comparedItemId, moodTerm, reason, eventId, input.strength);
    if (profileSignal.applied) {
      this.db
        .prepare("UPDATE feel_feedback_events SET profile_version = ?, profile_update_applied = 1 WHERE id = ?")
        .run(profileSignal.profileVersion, eventId);
    }
    this.compactReplayData();
    return {
      ok: true,
      eventId,
      reliability,
      profileVersion: profileSignal.applied ? profileSignal.profileVersion : initialProfileVersion,
      profileHoldout,
      appliedPreferenceSignal,
      appliedProfileSignal: profileSignal.applied
    };
  }

  private findFeelFeedbackByClientEventId(source: FeelFeedbackSource, clientEventId: string): FeelFeedbackResponseRow | undefined {
    return this.db
      .prepare(
        `SELECT id, reliability, profile_version, profile_update_applied, profile_holdout
         FROM feel_feedback_events
         WHERE source = ? AND client_event_id = ?
         LIMIT 1`
      )
      .get(source, clientEventId) as FeelFeedbackResponseRow | undefined;
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

  searchMoodFeatureScores(features: string[], limit = 240): MoodFeatureHit[] {
    const normalizedFeatures = unique(features.map(normalizeMoodFeatureKey));
    if (normalizedFeatures.length === 0) return [];
    const placeholders = normalizedFeatures.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT media_item_id, SUM(score * confidence) AS aggregate_score, GROUP_CONCAT(feature) AS matched_features
         FROM media_mood_feature_scores
         WHERE feature IN (${placeholders})
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

  upsertMoodFeatureScores(mediaItemId: string, source: string, sourceVersion: string, scores: MoodFeatureScoreInput[]) {
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

  searchFeatureIds(query: string, limit = 120): FeatureSearchHit[] {
    const ftsQuery = buildFtsQuery(query);
    if (!ftsQuery) return [];
    const rows = this.db
      .prepare(
        `SELECT media_item_id, bm25(media_feature_fts) AS rank
         FROM media_feature_fts
         WHERE media_feature_fts MATCH ?
         ORDER BY rank
         LIMIT ?`
      )
      .all(ftsQuery, limit) as Array<{ media_item_id: string; rank: number }>;
    return rows.map((row) => ({ mediaItemId: row.media_item_id, rank: row.rank }));
  }

  providerEmbeddingMap(provider: string, model: string): Map<string, StoredProviderEmbedding> {
    const rows = this.db
      .prepare(
        `SELECT media_item_id, provider, model, dimensions, vector_json, updated_at
         FROM media_embeddings
         WHERE provider = ? AND model = ?`
      )
      .all(provider, model) as Array<{
      media_item_id: string;
      provider: string;
      model: string;
      dimensions: number;
      vector_json: string;
      updated_at: string;
    }>;
    return new Map(
      rows.map((row) => [
        row.media_item_id,
        {
          mediaItemId: row.media_item_id,
          provider: row.provider,
          model: row.model,
          dimensions: row.dimensions,
          vector: parseNumberArray(row.vector_json),
          updatedAt: row.updated_at
        }
      ])
    );
  }

  missingProviderEmbeddingInputs(provider: string, model: string, limit = 240): ProviderEmbeddingInput[] {
    const rows = this.db
      .prepare(
        `SELECT f.media_item_id, f.feature_text, f.feature_version, e.input_hash, e.feature_version AS embedding_feature_version
         FROM media_features f
         LEFT JOIN media_embeddings e
          ON e.media_item_id = f.media_item_id AND e.provider = ? AND e.model = ?
         ORDER BY f.updated_at DESC`
      )
      .all(provider, model) as Array<{
      media_item_id: string;
      feature_text: string;
      feature_version: string;
      input_hash?: string;
      embedding_feature_version?: string;
    }>;
    return rows
      .map((row) => ({
        mediaItemId: row.media_item_id,
        featureText: row.feature_text,
        featureVersion: row.feature_version,
        inputHash: hashText(row.feature_text)
      }))
      .filter((row, index) => rows[index].input_hash !== row.inputHash || rows[index].embedding_feature_version !== row.featureVersion)
      .slice(0, limit);
  }

  upsertProviderEmbeddings(provider: string, model: string, inputs: ProviderEmbeddingInput[], vectors: number[][]) {
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
        if (vector.length > 0) {
          insert.run(input.mediaItemId, provider, model, input.featureVersion, input.inputHash, vector.length, JSON.stringify(vector), now);
        }
      });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  preferenceWeights(watchContext: WatchContext): Map<string, number> {
    const profileId = preferenceProfileId(watchContext);
    const rows = this.db.prepare("SELECT feature, weight FROM preference_feature_weights WHERE profile_id = ?").all(profileId) as Array<{
      feature: string;
      weight: number;
    }>;
    return new Map(rows.map((row) => [row.feature, row.weight]));
  }

  feelProfile(watchContext: WatchContext): FeelProfileResponse {
    this.ensurePreferenceProfile(watchContext);
    const profileId = preferenceProfileId(watchContext);
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

  feelProfiles(): Record<WatchContext, FeelProfileResponse> {
    return {
      solo: this.feelProfile("solo"),
      group: this.feelProfile("group")
    };
  }

  resetFeelProfile(watchContext?: WatchContext, term?: string): FeelProfileResetResponse {
    const normalizedTerm = cleanShortText(term, 80, true);
    let termResult: { changes: number | bigint };
    let checkpointResult: { changes: number | bigint };
    if (watchContext && normalizedTerm) {
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

  rollbackFeelProfileTerm(watchContext: WatchContext, term: string, version?: number): FeelProfileRollbackResponse {
    const normalizedTerm = cleanShortText(term, 80, true);
    if (!normalizedTerm) {
      throw Object.assign(new Error("Feel Profile rollback requires a term."), { statusCode: 400 });
    }
    this.ensurePreferenceProfile(watchContext);
    const profileId = preferenceProfileId(watchContext);
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
    const nextVersion = this.currentProfileVersion(watchContext) + 1;
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

  exportFeelProfiles(limit = 20): FeelProfileExportResponse {
    const summary = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          COALESCE(SUM(profile_holdout), 0) AS holdouts,
          COALESCE(SUM(profile_update_applied), 0) AS applied_profile_updates
         FROM feel_feedback_events`
      )
      .get() as { total: number; holdouts: number; applied_profile_updates: number };
    const byReliability = this.db
      .prepare(
        `SELECT reliability, COUNT(*) AS count
         FROM feel_feedback_events
         GROUP BY reliability
         ORDER BY count DESC, reliability`
      )
      .all() as Array<{ reliability: FeelFeedbackReliability; count: number }>;
    return {
      schemaVersion: "feel-profile-export-v1",
      exportedAt: new Date().toISOString(),
      engineVersion: recommendationEngineVersion,
      profiles: this.feelProfiles(),
      preferences: {
        solo: this.preferenceDiagnostics("solo"),
        group: this.preferenceDiagnostics("group")
      },
      feedbackSummary: {
        total: summary.total,
        byReliability,
        holdouts: summary.holdouts,
        appliedProfileUpdates: summary.applied_profile_updates
      },
      recentSlates: this.recentRecommendationSlates(limit)
    };
  }

  profileReplayEvaluation(limit = 100): ProfileReplayEvaluationResponse {
    const normalizedLimit = Math.max(1, Math.min(1000, Math.floor(limit)));
    const events = this.db
      .prepare(
        `SELECT id, session_id, media_item_id, action, watch_context, mood_term, profile_version, created_at
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
      const profileId = preferenceProfileId(event.watch_context);
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
    const moodFeatureScoreCount = (this.db.prepare("SELECT COUNT(*) AS value FROM media_mood_feature_scores").get() as { value: number }).value;
    const providerEmbeddingCount = (this.db.prepare("SELECT COUNT(*) AS value FROM media_embeddings").get() as { value: number }).value;
    const embeddingModels = this.db
      .prepare(
        `SELECT provider, model, COUNT(*) AS count, MAX(dimensions) AS dimensions, MAX(updated_at) AS last_updated_at
         FROM media_embeddings
         GROUP BY provider, model
         ORDER BY count DESC, provider, model`
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
        moodFeatureScoreCount,
        moodFeatureSources: this.moodFeatureSourceSummaries(),
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
      plexItems: one<number>("SELECT COUNT(*) AS value FROM plex_items WHERE available = 1"),
      seerrItems: one<number>("SELECT COUNT(*) AS value FROM seerr_items"),
      movies: one<number>("SELECT COUNT(*) AS value FROM media_items WHERE media_type = 'movie'"),
      tv: one<number>("SELECT COUNT(*) AS value FROM media_items WHERE media_type = 'tv'"),
      availableInPlex: one<number>("SELECT COUNT(*) AS value FROM plex_items WHERE available = 1"),
      requestable: one<number>("SELECT COUNT(*) AS value FROM seerr_items WHERE requestable = 1"),
      alreadyRequested: one<number>("SELECT COUNT(*) AS value FROM seerr_items WHERE request_status IS NOT NULL AND request_status != ''"),
      partiallyAvailable: one<number>("SELECT COUNT(*) AS value FROM seerr_items WHERE status = 'partially_available'"),
      lastLibrarySync,
      lastSeerrSync
    };
  }

  private findExistingId(mediaType: MediaType, normalizedTitle: string, year: number | undefined, externalIds: Record<string, string>) {
    for (const [source, value] of Object.entries(externalIds)) {
      const row = this.db.prepare("SELECT media_item_id FROM external_ids WHERE source = ? AND value = ?").get(source, value) as
        | { media_item_id: string }
        | undefined;
      if (row) return row.media_item_id;
    }

    const row = this.db
      .prepare("SELECT id FROM media_items WHERE media_type = ? AND normalized_title = ? AND COALESCE(year, 0) = COALESCE(?, 0)")
      .get(mediaType, normalizedTitle, year ?? null) as { id: string } | undefined;
    return row?.id;
  }

  private replaceList(table: "genres", mediaItemId: string, values: string[]) {
    this.db.prepare(`DELETE FROM ${table} WHERE media_item_id = ?`).run(mediaItemId);
    const insert = this.db.prepare(`INSERT OR IGNORE INTO ${table} (media_item_id, name) VALUES (?, ?)`);
    for (const value of unique(values)) {
      insert.run(mediaItemId, value);
    }
  }

  private resolveGenreUpdate(mediaItemId: string, record: IngestMediaRecord) {
    if (record.genres === undefined) return undefined;
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

  private upsertExternalIds(mediaItemId: string, externalIds: Record<string, string>) {
    const insert = this.db.prepare("INSERT OR REPLACE INTO external_ids (media_item_id, source, value) VALUES (?, ?, ?)");
    for (const [source, value] of Object.entries(externalIds)) {
      insert.run(mediaItemId, source, value);
    }
  }

  private upsertPlex(mediaItemId: string, plex: NonNullable<IngestMediaRecord["plex"]>, now: string) {
    const id = `plex:${plex.ratingKey ?? plex.guid ?? mediaItemId}`;
    this.db
      .prepare(
        `INSERT INTO plex_items (id, media_item_id, rating_key, guid, library_title, library_type, plex_url, available, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          media_item_id = excluded.media_item_id,
          rating_key = excluded.rating_key,
          guid = excluded.guid,
          library_title = excluded.library_title,
          library_type = excluded.library_type,
          plex_url = excluded.plex_url,
          available = excluded.available,
          last_seen_at = excluded.last_seen_at`
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
  }

  private upsertSeerr(mediaItemId: string, mediaType: MediaType, seerr: NonNullable<IngestMediaRecord["seerr"]>, now: string) {
    const id = `seerr:${seerr.seerrMediaId ?? `${mediaType}:${seerr.tmdbId ?? mediaItemId}`}`;
    this.db
      .prepare(
        `INSERT INTO seerr_items (
          id, media_item_id, tmdb_id, tvdb_id, imdb_id, seerr_media_id, media_type, status, request_status, requestable, seerr_url, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          media_item_id = excluded.media_item_id,
          tmdb_id = excluded.tmdb_id,
          tvdb_id = excluded.tvdb_id,
          imdb_id = excluded.imdb_id,
          seerr_media_id = excluded.seerr_media_id,
          status = excluded.status,
          request_status = excluded.request_status,
          requestable = excluded.requestable,
          seerr_url = excluded.seerr_url,
          last_seen_at = excluded.last_seen_at`
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
        seerr.requestStatus ?? null,
        seerr.requestable ? 1 : 0,
        seerr.url ?? null,
        now
      );
  }

  private upsertFeature(mediaItemId: string, now: string) {
    const item = this.findById(mediaItemId);
    if (!item) return;
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
    this.upsertMoodFeatureScores(mediaItemId, "deterministic", feature.version, deterministicMoodFeatureScores(feature));
  }

  private backfillFeatures() {
    const mediaCount = (this.db.prepare("SELECT COUNT(*) AS value FROM media_items").get() as { value: number }).value;
    if (mediaCount === 0) return;
    const featureCount = (this.db.prepare("SELECT COUNT(*) AS value FROM media_features").get() as { value: number }).value;
    const staleFeatureCount = (this.db.prepare("SELECT COUNT(*) AS value FROM media_features WHERE feature_version != ?").get(FEATURE_VERSION) as { value: number }).value;
    if (featureCount >= mediaCount && staleFeatureCount === 0) return;
    const rows = this.db
      .prepare(
        `SELECT m.id
         FROM media_items m
         LEFT JOIN media_features f ON f.media_item_id = m.id
         WHERE f.media_item_id IS NULL OR f.feature_version != ?`
      )
      .all(FEATURE_VERSION) as { id: string }[];
    const now = new Date().toISOString();
    for (const row of rows) this.upsertFeature(row.id, now);
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
    for (const row of rows) {
      const feature = inflateFeature(row);
      this.upsertMoodFeatureScores(feature.mediaItemId, "deterministic", feature.featureVersion, deterministicMoodFeatureScores(feature));
    }
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
      (this.db.prepare("SELECT source, value FROM external_ids WHERE media_item_id = ?").all(id) as { source: string; value: string }[]).map((entry) => [
        entry.source,
        entry.value
      ])
    );
    const plex = this.db.prepare("SELECT available, plex_url, library_title FROM plex_items WHERE media_item_id = ? LIMIT 1").get(id) as PlexRow | undefined;
    const seerr = this.db.prepare("SELECT status, request_status, requestable, seerr_url, tmdb_id FROM seerr_items WHERE media_item_id = ? LIMIT 1").get(id) as
      | SeerrRow
      | undefined;
    const availabilityGroup = getAvailabilityGroup(plex, seerr);
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
      availabilityGroup,
      availabilityExplanation: explainAvailability(plex, seerr),
      matchExplanation: "Matched by local metadata.",
      score: 0,
      metadata: {
        hasPoster: Boolean(row.poster_path),
        sparse: isSparseSeerrPlaceholder(row.title) || !row.summary?.trim(),
        source: row.source
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
        record.query,
        record.optimizedQuery ?? null,
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

  private recordFeedbackRows(sessionId: string, watchContext: WatchContext, feedback: RecommendationRunRecord["feedback"]) {
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
    for (const itemId of feedback.maybeItemIds ?? []) run(itemId, "maybe");
    for (const itemId of feedback.lessLikeItemIds ?? []) run(itemId, "down");
    for (const itemId of feedback.hiddenItemIds ?? []) run(itemId, "hidden");
    this.updatePreferenceWeights(watchContext, feedback);
  }

  private applyFeelFeedbackPreferenceSignal(
    watchContext: WatchContext,
    action: FeelFeedbackAction,
    itemId: string | undefined,
    comparedItemId: string | undefined
  ) {
    if (action === "pairwise_pick" && itemId && comparedItemId) {
      this.updatePreferenceWeights(watchContext, { moreLikeItemIds: [itemId], lessLikeItemIds: [comparedItemId] });
      return true;
    }
    if (!itemId) return false;
    if (positiveFeelActions.has(action)) {
      this.updatePreferenceWeights(watchContext, { moreLikeItemIds: [itemId] });
      return true;
    }
    if (negativeFeelActions.has(action)) {
      this.updatePreferenceWeights(watchContext, { lessLikeItemIds: [itemId] });
      return true;
    }
    if (action === "hide") {
      this.updatePreferenceWeights(watchContext, { hiddenItemIds: [itemId] });
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
    strength: number | undefined
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

    this.ensurePreferenceProfile(watchContext);
    const profileId = preferenceProfileId(watchContext);
    const now = new Date().toISOString();
    const nextVersion = this.currentProfileVersion(watchContext) + 1;
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

  private updatePreferenceWeights(watchContext: WatchContext, feedback: RecommendationRunRecord["feedback"]) {
    if (!feedback) return;
    this.ensurePreferenceProfile(watchContext);
    const profileId = preferenceProfileId(watchContext);
    const now = new Date().toISOString();
    const current = this.preferenceWeights(watchContext);
    const deltas = new Map<string, number>();
    const addDeltas = (itemIds: string[] | undefined, direction: number) => {
      for (const itemId of itemIds ?? []) {
        for (const feature of this.preferenceFeaturesForItem(itemId)) {
          deltas.set(feature, (deltas.get(feature) ?? 0) + direction);
        }
      }
    };
    addDeltas(feedback.moreLikeItemIds, 0.22);
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

  private ensurePreferenceProfile(watchContext: WatchContext) {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO preference_profiles (id, watch_context, label, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`
      )
      .run(preferenceProfileId(watchContext), watchContext, watchContext === "group" ? "Together" : "For Me", now, now);
  }

  private preferenceDiagnostics(watchContext: WatchContext) {
    const weights = [...this.preferenceWeights(watchContext).entries()].map(([feature, weight]) => ({ feature, weight }));
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

  private mediaItemExists(itemId: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM media_items WHERE id = ? LIMIT 1").get(itemId));
  }

  private recommendationSessionExists(sessionId: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM recommendation_sessions WHERE id = ? LIMIT 1").get(sessionId));
  }

  private currentProfileVersion(watchContext: WatchContext) {
    const profileId = preferenceProfileId(watchContext);
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

  private recentRecommendationSlates(limit: number): RecommendationReplaySlate[] {
    const normalizedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const sessions = this.db
      .prepare(
        `SELECT id, query_hash, engine_version, model, watch_context, result_count, candidate_count,
          rerank_candidate_count, used_ai, seerr_augmented, latency_ms, profile_id, profile_version, created_at
         FROM recommendation_sessions
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .all(normalizedLimit) as Array<{
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

function makeMediaId(mediaType: MediaType, normalizedTitle: string, year: number | undefined, externalIds: Record<string, string>) {
  const stableKey = externalIds.tmdb ?? externalIds.imdb ?? externalIds.tvdb ?? externalIds.plex ?? `${normalizedTitle}:${year ?? "unknown"}`;
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
  return Math.max(min, Math.min(max, value));
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
    return Array.isArray(parsed) ? parsed.filter((entry): entry is number => typeof entry === "number" && Number.isFinite(entry)) : [];
  } catch {
    return [];
  }
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

function preferenceProfileId(watchContext: WatchContext) {
  return `${watchContext}:default`;
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
