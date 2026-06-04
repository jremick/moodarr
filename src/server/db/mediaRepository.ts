import crypto, { randomUUID } from "node:crypto";
import type {
  AvailabilityGroup,
  ItemDetail,
  ItemSummary,
  MediaType,
  RatingSet,
  RecommendationDiagnostics,
  RequestAuditDiagnostics,
  SeerrStatus,
  SyncRunSummary,
  WatchContext
} from "../../shared/types";
import { buildMediaFeatureDocument, parseFeatureVector, vectorToJson } from "../recommendation/features";
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
    lessLikeItemIds?: string[];
    hiddenItemIds?: string[];
  };
}

export interface PosterCacheRecord {
  contentType: string;
  body: Buffer;
}

export interface RequestAuditRecord {
  mediaItemId?: string;
  action: "preview" | "create";
  status: "allowed" | "blocked" | "created" | "failed";
  mediaType?: MediaType;
  mediaId?: number;
  title?: string;
  seasons?: number[];
  blockedReason?: string;
  externalRequestId?: string;
}

export class MediaRepository {
  constructor(private readonly db: SqliteDatabase) {
    this.backfillFeatures();
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
          media_item_id, action, status, media_type, media_id, title, seasons_json, blocked_reason, external_request_id, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.mediaItemId ?? null,
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
    this.db.exec("BEGIN");
    try {
      this.db
        .prepare(
          `INSERT INTO recommendation_sessions (
            id, query_hash, engine_version, model, watch_context, result_count, candidate_count, rerank_candidate_count,
            used_ai, seerr_augmented, latency_ms, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
          now
        );
      const insertResult = this.db.prepare(
        `INSERT INTO recommendation_results (
          session_id, media_item_id, rank, score, score_breakdown_json, availability_group
        ) VALUES (?, ?, ?, ?, ?, ?)`
      );
      record.results.forEach((item, index) => {
        insertResult.run(id, item.id, index + 1, item.score, JSON.stringify(item.scoreBreakdown ?? {}), item.availabilityGroup);
      });
      this.recordFeedbackRows(id, record.watchContext, record.feedback);
      this.db.exec("COMMIT");
      return id;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
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
          used_ai, seerr_augmented, latency_ms, created_at
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
      created_at: string;
    }>;

    return {
      engineVersion: "hybrid-v2",
      sessions: {
        total: sessions.total,
        withAi: sessions.with_ai,
        withSeerrAugmentation: sessions.with_seerr_augmentation,
        averageLatencyMs: Math.round(sessions.average_latency_ms)
      },
      features: {
        mediaFeatureCount: featureCount,
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
      recentRuns: recentRuns.map((run) => ({
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
        createdAt: run.created_at
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
        `SELECT id, action, status, title, media_type, media_id, seasons_json, blocked_reason, created_at
         FROM request_audit
         ORDER BY created_at DESC, id DESC
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
  }

  private backfillFeatures() {
    const mediaCount = (this.db.prepare("SELECT COUNT(*) AS value FROM media_items").get() as { value: number }).value;
    if (mediaCount === 0) return;
    const featureCount = (this.db.prepare("SELECT COUNT(*) AS value FROM media_features").get() as { value: number }).value;
    if (featureCount >= mediaCount) return;
    const rows = this.db.prepare("SELECT id FROM media_items").all() as { id: string }[];
    const now = new Date().toISOString();
    for (const row of rows) this.upsertFeature(row.id, now);
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
            url: plex.plex_url,
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
    for (const itemId of feedback.lessLikeItemIds ?? []) run(itemId, "down");
    for (const itemId of feedback.hiddenItemIds ?? []) run(itemId, "hidden");
    this.updatePreferenceWeights(watchContext, feedback);
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
}

export function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
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
