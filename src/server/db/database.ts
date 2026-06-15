import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SqliteDatabase = DatabaseSync;

export function createDatabase(dbPath: string): SqliteDatabase {
  if (dbPath !== ":memory:") {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  runMigrations(db);
  return db;
}

function runMigrations(db: SqliteDatabase) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  applyMigration(db, "001_initial_schema", `
    CREATE TABLE IF NOT EXISTS media_items (
      id TEXT PRIMARY KEY,
      media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
      title TEXT NOT NULL,
      normalized_title TEXT NOT NULL,
      year INTEGER,
      summary TEXT,
      runtime_minutes INTEGER,
      content_rating TEXT,
      poster_path TEXT,
      critic_rating REAL,
      audience_rating REAL,
      user_rating REAL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plex_items (
      id TEXT PRIMARY KEY,
      media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      rating_key TEXT,
      guid TEXT,
      library_title TEXT,
      library_type TEXT,
      plex_url TEXT,
      available INTEGER NOT NULL DEFAULT 1,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS seerr_items (
      id TEXT PRIMARY KEY,
      media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      tmdb_id INTEGER,
      tvdb_id INTEGER,
      imdb_id TEXT,
      seerr_media_id INTEGER,
      media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
      status TEXT NOT NULL,
      request_status TEXT,
      requestable INTEGER NOT NULL DEFAULT 0,
      seerr_url TEXT,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS external_ids (
      media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (source, value)
    );

    CREATE TABLE IF NOT EXISTS genres (
      media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      PRIMARY KEY (media_item_id, name)
    );

    CREATE TABLE IF NOT EXISTS people (
      media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY (media_item_id, name, role)
    );

    CREATE TABLE IF NOT EXISTS library_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      item_count INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS seerr_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      item_count INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
      media_id INTEGER NOT NULL,
      seasons_json TEXT,
      status TEXT NOT NULL,
      external_request_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS poster_cache (
      media_item_id TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
      content_type TEXT NOT NULL,
      body BLOB NOT NULL,
      fetched_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media_features (
      media_item_id TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
      feature_text TEXT NOT NULL,
      mood_terms_json TEXT NOT NULL,
      tone_terms_json TEXT NOT NULL,
      watchability_terms_json TEXT NOT NULL,
      vector_json TEXT NOT NULL,
      feature_version TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS media_embeddings (
      media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      feature_version TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_json TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (media_item_id, provider, model)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS media_feature_fts USING fts5(
      media_item_id UNINDEXED,
      title,
      feature_text,
      genres,
      people
    );

    CREATE TABLE IF NOT EXISTS search_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_hash TEXT NOT NULL,
      result_count INTEGER NOT NULL,
      used_ai INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recommendation_sessions (
      id TEXT PRIMARY KEY,
      query_hash TEXT NOT NULL,
      engine_version TEXT NOT NULL,
      model TEXT,
      watch_context TEXT NOT NULL,
      result_count INTEGER NOT NULL,
      candidate_count INTEGER NOT NULL,
      rerank_candidate_count INTEGER NOT NULL,
      used_ai INTEGER NOT NULL DEFAULT 0,
      seerr_augmented INTEGER NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS recommendation_results (
      session_id TEXT NOT NULL REFERENCES recommendation_sessions(id) ON DELETE CASCADE,
      media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      rank INTEGER NOT NULL,
      score INTEGER NOT NULL,
      score_breakdown_json TEXT NOT NULL,
      availability_group TEXT NOT NULL,
      PRIMARY KEY (session_id, media_item_id)
    );

    CREATE TABLE IF NOT EXISTS recommendation_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT REFERENCES recommendation_sessions(id) ON DELETE SET NULL,
      media_item_id TEXT REFERENCES media_items(id) ON DELETE CASCADE,
      watch_context TEXT NOT NULL,
      feedback TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS preference_profiles (
      id TEXT PRIMARY KEY,
      watch_context TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS preference_feature_weights (
      profile_id TEXT NOT NULL REFERENCES preference_profiles(id) ON DELETE CASCADE,
      feature TEXT NOT NULL,
      weight REAL NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, feature)
    );

    CREATE INDEX IF NOT EXISTS idx_media_items_normalized_title ON media_items(normalized_title);
    CREATE INDEX IF NOT EXISTS idx_media_items_media_type ON media_items(media_type);
    CREATE INDEX IF NOT EXISTS idx_plex_items_media_item_id ON plex_items(media_item_id);
    CREATE INDEX IF NOT EXISTS idx_seerr_items_media_item_id ON seerr_items(media_item_id);
    CREATE INDEX IF NOT EXISTS idx_recommendation_sessions_created_at ON recommendation_sessions(created_at);
    CREATE INDEX IF NOT EXISTS idx_recommendation_results_media_item_id ON recommendation_results(media_item_id);
    CREATE INDEX IF NOT EXISTS idx_media_embeddings_model ON media_embeddings(provider, model);
  `);

  applyMigration(db, "002_request_audit", `
    CREATE TABLE IF NOT EXISTS request_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_item_id TEXT REFERENCES media_items(id) ON DELETE SET NULL,
      action TEXT NOT NULL CHECK (action IN ('preview', 'create')),
      status TEXT NOT NULL CHECK (status IN ('allowed', 'blocked', 'created', 'failed')),
      media_type TEXT CHECK (media_type IN ('movie', 'tv')),
      media_id INTEGER,
      title TEXT,
      seasons_json TEXT,
      blocked_reason TEXT,
      external_request_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_request_audit_created_at ON request_audit(created_at);
    CREATE INDEX IF NOT EXISTS idx_request_audit_media_item_id ON request_audit(media_item_id);
  `);

  applyMigration(db, "003_media_source", `
    ALTER TABLE media_items ADD COLUMN source TEXT NOT NULL DEFAULT 'live';

    UPDATE media_items
    SET source = 'fixture'
    WHERE poster_path LIKE 'fixture://%'
      OR id IN (
        SELECT media_item_id
        FROM plex_items
        WHERE rating_key LIKE 'fixture-%'
          OR plex_url LIKE '%/fixture/%'
      )
      OR id IN (
        SELECT media_item_id
        FROM seerr_items
        WHERE seerr_url LIKE 'http://fixture-seerr.local/%'
      );

    CREATE INDEX IF NOT EXISTS idx_media_items_source ON media_items(source);
  `);

  applyMigration(db, "004_mood_feature_scores", `
    CREATE TABLE IF NOT EXISTS media_mood_feature_scores (
      media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      source_version TEXT NOT NULL,
      feature TEXT NOT NULL,
      score REAL NOT NULL CHECK (score >= 0 AND score <= 100),
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      updated_at TEXT NOT NULL,
      PRIMARY KEY (media_item_id, source, feature)
    );

    CREATE INDEX IF NOT EXISTS idx_mood_feature_scores_feature ON media_mood_feature_scores(feature, score DESC, confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_mood_feature_scores_media ON media_mood_feature_scores(media_item_id, source);
    CREATE INDEX IF NOT EXISTS idx_mood_feature_scores_source ON media_mood_feature_scores(source, source_version);
  `);

  applyMigration(db, "005_query_review_queue", `
    CREATE TABLE IF NOT EXISTS query_review_queue (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL UNIQUE REFERENCES recommendation_sessions(id) ON DELETE CASCADE,
      query_text TEXT NOT NULL,
      optimized_query TEXT,
      watch_context TEXT NOT NULL CHECK (watch_context IN ('solo', 'group')),
      result_count INTEGER NOT NULL DEFAULT 0,
      results_json TEXT NOT NULL,
      mood_fit_rating INTEGER CHECK (mood_fit_rating BETWEEN 1 AND 5),
      mood_feedback_text TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_query_review_queue_reviewed_at ON query_review_queue(reviewed_at, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_query_review_queue_created_at ON query_review_queue(created_at DESC);
  `);

  db.exec("PRAGMA user_version = 5");
}

function applyMigration(db: SqliteDatabase, id: string, sql: string) {
  const existing = db.prepare("SELECT 1 FROM schema_migrations WHERE id = ?").get(id) as unknown | undefined;
  if (existing) return;
  db.exec("BEGIN");
  try {
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run(id, new Date().toISOString());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
