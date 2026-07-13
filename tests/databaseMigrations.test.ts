import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createDatabase, runMigrations } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";

const migrationsThroughV21 = [
  "001_initial_schema",
  "002_request_audit",
  "003_media_source",
  "004_mood_feature_scores",
  "005_query_review_queue",
  "006_feel_feedback_events",
  "007_feel_profile_terms",
  "008_feel_feedback_reliability",
  "009_profile_replay_metadata",
  "010_profile_confidence_evidence",
  "011_replay_logging_holdout",
  "012_feel_profile_checkpoints",
  "013_plex_user_auth",
  "014_request_auth_attribution",
  "015_feel_feedback_client_event_id",
  "016_store_plex_user_token",
  "017_open_catalog_backbone",
  "018_catalog_update_metadata",
  "019_catalog_search_index",
  "020_content_fingerprints",
  "021_moodrank_trace_foundation"
];

describe("database upgrade migrations", () => {
  it("upgrades a populated v21 identity/profile/user fixture without losing its relationships", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    createV21Fixture(db);

    runMigrations(db);

    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(29);
    expect(db.prepare("SELECT media_item_id, media_type FROM external_ids WHERE source = 'tmdb' AND value = '42'").get()).toEqual({
      media_item_id: "movie:42",
      media_type: "movie"
    });
    expect(db.prepare("SELECT id, auth_user_id FROM preference_profiles WHERE id = 'group:shared'").get()).toEqual({
      id: "group:shared",
      auth_user_id: null
    });
    expect(db.prepare("SELECT profile_id FROM preference_feature_weights WHERE feature = 'mood:cozy'").get()).toEqual({ profile_id: "group:shared" });
    expect(db.prepare("SELECT can_request, can_use_ai FROM app_users WHERE id = 'user-1'").get()).toEqual({ can_request: 1, can_use_ai: 1 });
    expect((db.prepare("SELECT COUNT(*) AS value FROM request_creation_operations").get() as { value: number }).value).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plex_auth_challenges'").get()).toEqual({
      name: "plex_auth_challenges"
    });
  });

  it("upgrades a populated v25 request operation without losing its recovery state", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    createV25RequestFixture(db);

    runMigrations(db);

    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(29);
    expect(db.prepare("SELECT idempotency_key, status, response_json FROM request_creation_operations").get()).toEqual({
      idempotency_key: "operation-1",
      status: "pending",
      response_json: null
    });
    db.prepare("UPDATE request_creation_operations SET status = 'uncertain' WHERE idempotency_key = 'operation-1'").run();
    expect(db.prepare("SELECT status FROM request_creation_operations WHERE idempotency_key = 'operation-1'").get()).toEqual({ status: "uncertain" });
  });

  it("sanitizes legacy Seerr-linked descriptive replicas while preserving operational and profile state", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const sentinel = "forbidden-tmdb-description-sentinel";
    const mediaItemId = repository.upsert({
      mediaType: "movie",
      title: sentinel,
      year: 2024,
      summary: sentinel,
      runtimeMinutes: 117,
      posterPath: "tmdb://w500/forbidden-sentinel.jpg",
      genres: [sentinel],
      externalIds: { tmdb: 424242, imdb: "tt424242" },
      seerr: {
        tmdbId: 424242,
        seerrMediaId: 9001,
        status: "unknown",
        requestStatus: "approved",
        requestable: false
      }
    });
    const item = repository.findById(mediaItemId)!;
    repository.savePosterCache(mediaItemId, "legacy-tmdb-cache", "image/jpeg", Buffer.from(sentinel));
    repository.recordRequestAudit({
      mediaItemId,
      action: "preview",
      status: "allowed",
      mediaType: "movie",
      mediaId: 424242,
      title: sentinel
    });
    expect(repository.beginRequestCreationOperation("operation-sentinel", "fingerprint-sentinel", "admin", mediaItemId)).toBe(true);
    repository.completeRequestCreationOperation("operation-sentinel", {
      ok: true,
      request: { mediaType: "movie", mediaId: 424242, title: sentinel },
      seerr: { status: "approved" }
    });
    repository.recordRecommendationRun({
      query: "warm fantasy",
      engineVersion: "migration-test",
      watchContext: "solo",
      resultCount: 1,
      candidateCount: 1,
      rerankCandidateCount: 1,
      usedAi: false,
      seerrAugmented: true,
      latencyMs: 1,
      results: [{ ...item, title: sentinel, summary: sentinel, genres: [sentinel] }],
      reviewQueue: { retentionDays: 30, maxQueries: 10, captureRawQueries: false }
    });
    const embeddingInput = repository.missingProviderEmbeddingInputs("test", "test", 2, 1)[0];
    expect(embeddingInput).toBeDefined();
    repository.upsertProviderEmbeddings("test", "test", 2, [embeddingInput!], [[0.5, 0.5]]);
    repository.saveRequest(mediaItemId, "movie", 424242, undefined, "approved", "request-424242");
    db.prepare(
      "INSERT INTO preference_profiles (id, watch_context, label, created_at, updated_at) VALUES ('profile-preserved', 'solo', 'Preserved', ?, ?)"
    ).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    db.prepare("DELETE FROM schema_migrations WHERE id = '029_strict_tmdb_content_boundary'").run();
    db.exec("PRAGMA user_version = 28");
    runMigrations(db);

    expect(db.prepare("SELECT title, year, summary, runtime_minutes, poster_path, source FROM media_items WHERE id = ?").get(mediaItemId)).toEqual({
      title: "Movie 424242",
      year: null,
      summary: null,
      runtime_minutes: null,
      poster_path: null,
      source: "operational"
    });
    for (const table of [
      "genres",
      "poster_cache",
      "media_features",
      "media_embeddings",
      "media_mood_feature_scores",
      "media_content_fingerprints",
      "media_feature_fts",
      "catalog_search_index",
      "catalog_search_index_fts"
    ]) {
      expect((db.prepare(`SELECT COUNT(*) AS value FROM ${table} WHERE media_item_id = ?`).get(mediaItemId) as { value: number }).value, table).toBe(0);
    }
    expect(db.prepare("SELECT title FROM request_audit WHERE media_item_id = ?").get(mediaItemId)).toEqual({ title: null });
    expect(db.prepare("SELECT result_count, results_json FROM query_review_queue").get()).toEqual({ result_count: 0, results_json: "[]" });
    expect(db.prepare("SELECT status, response_json FROM request_creation_operations WHERE idempotency_key = 'operation-sentinel'").get()).toEqual({
      status: "created",
      response_json: JSON.stringify({ ok: true, request: { mediaType: "movie", mediaId: 424242 }, seerr: { status: "approved" } })
    });
    expect(db.prepare("SELECT tmdb_id, seerr_media_id, request_status FROM seerr_items WHERE media_item_id = ?").get(mediaItemId)).toEqual({
      tmdb_id: 424242,
      seerr_media_id: 9001,
      request_status: "approved"
    });
    expect(db.prepare("SELECT value FROM external_ids WHERE media_item_id = ? AND source = 'tmdb'").get(mediaItemId)).toEqual({ value: "424242" });
    expect((db.prepare("SELECT COUNT(*) AS value FROM requests WHERE media_item_id = ?").get(mediaItemId) as { value: number }).value).toBe(1);
    expect(db.prepare("SELECT label FROM preference_profiles WHERE id = 'profile-preserved'").get()).toEqual({ label: "Preserved" });
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(29);

    const snapshot = JSON.stringify(db.prepare("SELECT * FROM media_items WHERE id = ?").get(mediaItemId));
    runMigrations(db);
    expect(JSON.stringify(db.prepare("SELECT * FROM media_items WHERE id = ?").get(mediaItemId))).toBe(snapshot);
  });
});

function createV25RequestFixture(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE media_items (id TEXT PRIMARY KEY, media_type TEXT NOT NULL);
    CREATE TABLE catalog_source_records (media_item_id TEXT NOT NULL, source TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE plex_items (media_item_id TEXT NOT NULL, available INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE seerr_items (media_item_id TEXT NOT NULL, requestable INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE poster_cache (
      media_item_id TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
      content_type TEXT NOT NULL,
      body BLOB NOT NULL,
      fetched_at TEXT NOT NULL
    );
    CREATE TABLE request_creation_operations (
      idempotency_key TEXT PRIMARY KEY,
      request_fingerprint TEXT NOT NULL,
      auth_scope TEXT NOT NULL,
      media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'created', 'failed')),
      response_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX idx_request_creation_operations_updated_at
      ON request_creation_operations(updated_at DESC);
    INSERT INTO media_items (id, media_type) VALUES ('movie:42', 'movie');
    INSERT INTO request_creation_operations (
      idempotency_key, request_fingerprint, auth_scope, media_item_id, status,
      response_json, error, created_at, updated_at
    ) VALUES (
      'operation-1', 'fingerprint-1', 'admin', 'movie:42', 'pending',
      NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    PRAGMA user_version = 25;
  `);
  const insert = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, '2026-01-01T00:00:00.000Z')");
  for (const id of [...migrationsThroughV21, "022_media_type_aware_external_ids", "023_user_scoped_feel_profiles", "024_request_creation_idempotency", "025_user_capabilities"]) {
    insert.run(id);
  }
}

function createV21Fixture(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE media_items (id TEXT PRIMARY KEY, media_type TEXT NOT NULL);
    CREATE TABLE catalog_source_records (media_item_id TEXT NOT NULL, source TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE plex_items (media_item_id TEXT NOT NULL, available INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE seerr_items (media_item_id TEXT NOT NULL, requestable INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE poster_cache (
      media_item_id TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
      content_type TEXT NOT NULL,
      body BLOB NOT NULL,
      fetched_at TEXT NOT NULL
    );
    CREATE TABLE external_ids (
      media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (source, value)
    );
    CREATE TABLE app_users (id TEXT PRIMARY KEY);
    CREATE TABLE preference_profiles (
      id TEXT PRIMARY KEY,
      watch_context TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE recommendation_sessions (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE feel_feedback_events (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      client_event_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_feel_feedback_events_client_event
      ON feel_feedback_events(source, client_event_id)
      WHERE client_event_id IS NOT NULL;
    CREATE TABLE preference_feature_weights (
      profile_id TEXT NOT NULL REFERENCES preference_profiles(id) ON DELETE CASCADE,
      feature TEXT NOT NULL,
      weight REAL NOT NULL,
      PRIMARY KEY (profile_id, feature)
    );
    CREATE TABLE feel_profile_terms (
      profile_id TEXT NOT NULL REFERENCES preference_profiles(id) ON DELETE CASCADE,
      term TEXT NOT NULL,
      PRIMARY KEY (profile_id, term)
    );
    CREATE TABLE feel_profile_checkpoints (
      profile_id TEXT NOT NULL REFERENCES preference_profiles(id) ON DELETE CASCADE,
      term TEXT NOT NULL,
      version INTEGER NOT NULL,
      PRIMARY KEY (profile_id, term, version)
    );
    INSERT INTO media_items (id, media_type) VALUES ('movie:42', 'movie');
    INSERT INTO external_ids (media_item_id, source, value) VALUES ('movie:42', 'tmdb', '42');
    INSERT INTO app_users (id) VALUES ('user-1');
    INSERT INTO preference_profiles (id, watch_context, label, created_at, updated_at)
      VALUES ('group:default', 'group', 'Together', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO preference_feature_weights (profile_id, feature, weight) VALUES ('group:default', 'mood:cozy', 0.5);
    INSERT INTO recommendation_sessions (id, profile_id, created_at)
      VALUES ('session-1', 'group:default', '2026-01-01T00:00:00.000Z');
    PRAGMA user_version = 21;
  `);
  const insert = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, '2026-01-01T00:00:00.000Z')");
  for (const id of migrationsThroughV21) insert.run(id);
}
