import { DatabaseSync } from "node:sqlite";
import { preparePrivateFile, repairPrivateFile } from "../security/filePermissions";

export type SqliteDatabase = DatabaseSync;

export function createDatabase(dbPath: string): SqliteDatabase {
  if (dbPath !== ":memory:") {
    preparePrivateFile(dbPath);
  }

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  if (dbPath !== ":memory:") repairPrivateFile(dbPath);
  runMigrations(db);
  return db;
}

export function runMigrations(db: SqliteDatabase) {
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

  applyMigration(db, "006_feel_feedback_events", `
    CREATE TABLE IF NOT EXISTS feel_feedback_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT REFERENCES recommendation_sessions(id) ON DELETE SET NULL,
      media_item_id TEXT REFERENCES media_items(id) ON DELETE SET NULL,
      compared_media_item_id TEXT REFERENCES media_items(id) ON DELETE SET NULL,
      watch_context TEXT NOT NULL CHECK (watch_context IN ('solo', 'group')),
      source TEXT NOT NULL CHECK (source IN ('web', 'ios', 'admin')),
      action TEXT NOT NULL CHECK (
        action IN (
          'swipe_right', 'swipe_left', 'swipe_skip', 'open', 'expand', 'save', 'hide',
          'more_like', 'less_like', 'right_mood', 'wrong_mood', 'pairwise_pick',
          'request_preview', 'request_create'
        )
      ),
      mood_term TEXT,
      reason TEXT,
      strength INTEGER CHECK (strength IS NULL OR strength BETWEEN 1 AND 5),
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_feel_feedback_events_created_at ON feel_feedback_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feel_feedback_events_session ON feel_feedback_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_feel_feedback_events_item ON feel_feedback_events(media_item_id);
    CREATE INDEX IF NOT EXISTS idx_feel_feedback_events_action ON feel_feedback_events(action, created_at DESC);
  `);

  applyMigration(db, "007_feel_profile_terms", `
    CREATE TABLE IF NOT EXISTS feel_profile_terms (
      profile_id TEXT NOT NULL REFERENCES preference_profiles(id) ON DELETE CASCADE,
      watch_context TEXT NOT NULL CHECK (watch_context IN ('solo', 'group')),
      term TEXT NOT NULL,
      feature_weights_json TEXT NOT NULL,
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      evidence_count INTEGER NOT NULL DEFAULT 0,
      positive_count INTEGER NOT NULL DEFAULT 0,
      negative_count INTEGER NOT NULL DEFAULT 0,
      last_event_id INTEGER REFERENCES feel_feedback_events(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, term)
    );

    CREATE INDEX IF NOT EXISTS idx_feel_profile_terms_context ON feel_profile_terms(watch_context, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_feel_profile_terms_term ON feel_profile_terms(term);
  `);

  applyMigration(db, "008_feel_feedback_reliability", `
    ALTER TABLE feel_feedback_events
      ADD COLUMN reliability TEXT NOT NULL DEFAULT 'diagnostic'
      CHECK (reliability IN ('high', 'medium', 'weak', 'diagnostic'));

    CREATE INDEX IF NOT EXISTS idx_feel_feedback_events_reliability ON feel_feedback_events(reliability, created_at DESC);
  `);

  applyMigration(db, "009_profile_replay_metadata", `
    ALTER TABLE recommendation_sessions
      ADD COLUMN profile_id TEXT;

    ALTER TABLE recommendation_sessions
      ADD COLUMN profile_version INTEGER NOT NULL DEFAULT 0;

    ALTER TABLE feel_feedback_events
      ADD COLUMN profile_version INTEGER NOT NULL DEFAULT 0;

    ALTER TABLE feel_feedback_events
      ADD COLUMN profile_update_applied INTEGER NOT NULL DEFAULT 0
      CHECK (profile_update_applied IN (0, 1));

    ALTER TABLE feel_profile_terms
      ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

    CREATE INDEX IF NOT EXISTS idx_recommendation_sessions_profile ON recommendation_sessions(profile_id, profile_version);
    CREATE INDEX IF NOT EXISTS idx_feel_feedback_events_profile_version ON feel_feedback_events(mood_term, profile_version);
    CREATE INDEX IF NOT EXISTS idx_feel_feedback_events_session_term_updates ON feel_feedback_events(session_id, mood_term, profile_update_applied);
  `);

  applyMigration(db, "010_profile_confidence_evidence", `
    ALTER TABLE feel_profile_terms
      ADD COLUMN positive_weight REAL NOT NULL DEFAULT 0;

    ALTER TABLE feel_profile_terms
      ADD COLUMN negative_weight REAL NOT NULL DEFAULT 0;

    ALTER TABLE feel_profile_terms
      ADD COLUMN effective_evidence REAL NOT NULL DEFAULT 0;

    ALTER TABLE feel_profile_terms
      ADD COLUMN conflict_score REAL NOT NULL DEFAULT 0
      CHECK (conflict_score >= 0 AND conflict_score <= 1);

    UPDATE feel_profile_terms
    SET positive_weight = positive_count,
        negative_weight = negative_count,
        effective_evidence = evidence_count,
        conflict_score = 0
    WHERE effective_evidence = 0;
  `);

  applyMigration(db, "011_replay_logging_holdout", `
    ALTER TABLE recommendation_results
      ADD COLUMN feature_version TEXT;

    ALTER TABLE feel_feedback_events
      ADD COLUMN profile_holdout INTEGER NOT NULL DEFAULT 0
      CHECK (profile_holdout IN (0, 1));

    UPDATE recommendation_results
    SET feature_version = (
      SELECT feature_version
      FROM media_features
      WHERE media_features.media_item_id = recommendation_results.media_item_id
    )
    WHERE feature_version IS NULL;

    CREATE INDEX IF NOT EXISTS idx_recommendation_results_session_rank ON recommendation_results(session_id, rank);
    CREATE INDEX IF NOT EXISTS idx_feel_feedback_events_holdout ON feel_feedback_events(profile_holdout, created_at DESC);
  `);

  applyMigration(db, "012_feel_profile_checkpoints", `
    CREATE TABLE IF NOT EXISTS feel_profile_checkpoints (
      profile_id TEXT NOT NULL REFERENCES preference_profiles(id) ON DELETE CASCADE,
      watch_context TEXT NOT NULL CHECK (watch_context IN ('solo', 'group')),
      term TEXT NOT NULL,
      version INTEGER NOT NULL,
      feature_weights_json TEXT NOT NULL,
      confidence REAL NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
      evidence_count INTEGER NOT NULL DEFAULT 0,
      positive_count INTEGER NOT NULL DEFAULT 0,
      negative_count INTEGER NOT NULL DEFAULT 0,
      positive_weight REAL NOT NULL DEFAULT 0,
      negative_weight REAL NOT NULL DEFAULT 0,
      effective_evidence REAL NOT NULL DEFAULT 0,
      conflict_score REAL NOT NULL DEFAULT 0 CHECK (conflict_score >= 0 AND conflict_score <= 1),
      event_id INTEGER REFERENCES feel_feedback_events(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (profile_id, term, version)
    );

    INSERT OR IGNORE INTO feel_profile_checkpoints (
      profile_id, watch_context, term, version, feature_weights_json, confidence, evidence_count,
      positive_count, negative_count, positive_weight, negative_weight, effective_evidence,
      conflict_score, event_id, created_at
    )
    SELECT profile_id, watch_context, term, version, feature_weights_json, confidence, evidence_count,
      positive_count, negative_count, positive_weight, negative_weight, effective_evidence,
      conflict_score, last_event_id, updated_at
    FROM feel_profile_terms
    WHERE version > 0;

    CREATE INDEX IF NOT EXISTS idx_feel_profile_checkpoints_context ON feel_profile_checkpoints(watch_context, term, version);
  `);

  applyMigration(db, "013_plex_user_auth", `
    CREATE TABLE IF NOT EXISTS app_users (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL CHECK (provider IN ('plex')),
      provider_user_id TEXT NOT NULL,
      username TEXT,
      display_name TEXT,
      email TEXT,
      avatar_url TEXT,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_login_at TEXT,
      UNIQUE(provider, provider_user_id)
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_app_users_provider ON app_users(provider, provider_user_id);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at ON user_sessions(expires_at);
  `);

  applyMigration(db, "014_request_auth_attribution", `
    ALTER TABLE request_audit
      ADD COLUMN auth_user_id TEXT;

    CREATE INDEX IF NOT EXISTS idx_request_audit_auth_user ON request_audit(auth_user_id, created_at DESC);
  `);

  applyMigration(db, "015_feel_feedback_client_event_id", `
    ALTER TABLE feel_feedback_events
      ADD COLUMN client_event_id TEXT;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_feel_feedback_events_client_event
      ON feel_feedback_events(source, client_event_id)
      WHERE client_event_id IS NOT NULL;
  `);

  applyMigration(db, "016_store_plex_user_token", `
    ALTER TABLE app_users
      ADD COLUMN plex_token TEXT;
  `);

  applyMigration(db, "017_open_catalog_backbone", `
    CREATE TABLE IF NOT EXISTS catalog_source_records (
      media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      source_version TEXT NOT NULL,
      source_item_id TEXT NOT NULL,
      source_url TEXT,
      license_policy TEXT NOT NULL,
      payload_hash TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      fetched_at TEXT NOT NULL,
      expires_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (source, source_item_id)
    );

    CREATE INDEX IF NOT EXISTS idx_catalog_source_records_media ON catalog_source_records(media_item_id, source);
    CREATE INDEX IF NOT EXISTS idx_catalog_source_records_source_version ON catalog_source_records(source, source_version);

    CREATE TABLE IF NOT EXISTS catalog_rank_signals (
      media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      source_version TEXT NOT NULL,
      mainstream_score REAL NOT NULL CHECK (mainstream_score >= 0 AND mainstream_score <= 100),
      metadata_confidence REAL NOT NULL CHECK (metadata_confidence >= 0 AND metadata_confidence <= 1),
      sitelink_count INTEGER NOT NULL DEFAULT 0,
      external_id_count INTEGER NOT NULL DEFAULT 0,
      award_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (media_item_id, source)
    );

    CREATE INDEX IF NOT EXISTS idx_catalog_rank_signals_mainstream ON catalog_rank_signals(mainstream_score DESC, metadata_confidence DESC);
    CREATE INDEX IF NOT EXISTS idx_catalog_rank_signals_source ON catalog_rank_signals(source, source_version);

    CREATE TABLE IF NOT EXISTS catalog_sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      source_version TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      item_count INTEGER NOT NULL DEFAULT 0,
      media_items_upserted INTEGER NOT NULL DEFAULT 0,
      source_records_upserted INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_catalog_sync_runs_source ON catalog_sync_runs(source, started_at DESC);
  `);

  applyMigration(db, "018_catalog_update_metadata", `
    ALTER TABLE catalog_source_records
      ADD COLUMN active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1));

    ALTER TABLE catalog_source_records
      ADD COLUMN last_seen_source_version TEXT;

    ALTER TABLE catalog_source_records
      ADD COLUMN content_hash TEXT;

    ALTER TABLE catalog_source_records
      ADD COLUMN content_version INTEGER NOT NULL DEFAULT 1;

    ALTER TABLE catalog_source_records
      ADD COLUMN deleted_at TEXT;

    ALTER TABLE catalog_sync_runs
      ADD COLUMN update_mode TEXT NOT NULL DEFAULT 'incremental';

    ALTER TABLE catalog_sync_runs
      ADD COLUMN changed_source_records INTEGER NOT NULL DEFAULT 0;

    ALTER TABLE catalog_sync_runs
      ADD COLUMN unchanged_source_records INTEGER NOT NULL DEFAULT 0;

    ALTER TABLE catalog_sync_runs
      ADD COLUMN inactive_source_records INTEGER NOT NULL DEFAULT 0;

    UPDATE catalog_source_records
    SET last_seen_source_version = COALESCE(last_seen_source_version, source_version),
        content_hash = COALESCE(content_hash, payload_hash),
        content_version = CASE WHEN content_version < 1 THEN 1 ELSE content_version END,
        active = 1
    WHERE last_seen_source_version IS NULL
       OR content_hash IS NULL
       OR content_version < 1
       OR active IS NULL;

    CREATE INDEX IF NOT EXISTS idx_catalog_source_records_active ON catalog_source_records(source, active, source_version);
    CREATE INDEX IF NOT EXISTS idx_catalog_source_records_last_seen ON catalog_source_records(source, last_seen_source_version);
  `);

  applyMigration(db, "019_catalog_search_index", `
    CREATE TABLE IF NOT EXISTS catalog_search_index (
      media_item_id TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
      year INTEGER,
      source TEXT NOT NULL,
      rank_score REAL NOT NULL DEFAULT 0,
      availability_group TEXT NOT NULL CHECK (
        availability_group IN ('available_in_plex', 'not_in_plex_requestable', 'already_requested', 'partially_available', 'unavailable')
      ),
      plex_available INTEGER NOT NULL DEFAULT 0 CHECK (plex_available IN (0, 1)),
      seerr_requestable INTEGER NOT NULL DEFAULT 0 CHECK (seerr_requestable IN (0, 1)),
      has_seerr INTEGER NOT NULL DEFAULT 0 CHECK (has_seerr IN (0, 1)),
      has_summary INTEGER NOT NULL DEFAULT 0 CHECK (has_summary IN (0, 1)),
      search_text TEXT NOT NULL,
      mood_text TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_catalog_search_index_type_rank ON catalog_search_index(media_type, rank_score DESC);
    CREATE INDEX IF NOT EXISTS idx_catalog_search_index_availability_rank ON catalog_search_index(availability_group, rank_score DESC);
    CREATE INDEX IF NOT EXISTS idx_catalog_search_index_year_rank ON catalog_search_index(year, rank_score DESC);
    CREATE INDEX IF NOT EXISTS idx_catalog_search_index_source ON catalog_search_index(source, rank_score DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS catalog_search_index_fts USING fts5(
      media_item_id UNINDEXED,
      title,
      search_text,
      mood_text
    );

    DELETE FROM catalog_search_index_fts;
  `);

  applyMigration(db, "020_content_fingerprints", `
    CREATE TABLE IF NOT EXISTS media_content_fingerprints (
      media_item_id TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
      schema_version TEXT NOT NULL,
      fingerprint_version TEXT NOT NULL,
      source TEXT NOT NULL,
      source_version TEXT NOT NULL,
      input_hash TEXT NOT NULL CHECK (length(input_hash) = 64),
      fingerprint_json TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_media_content_fingerprints_version
      ON media_content_fingerprints(fingerprint_version);

    CREATE INDEX IF NOT EXISTS idx_media_content_fingerprints_input_hash
      ON media_content_fingerprints(input_hash);
  `);

  applyMigration(db, "021_moodrank_trace_foundation", `
    ALTER TABLE recommendation_sessions
      ADD COLUMN trace_schema_version TEXT;

    ALTER TABLE recommendation_sessions
      ADD COLUMN trace_flags_json TEXT;

    ALTER TABLE recommendation_sessions
      ADD COLUMN brief_trace_json TEXT;

    ALTER TABLE recommendation_sessions
      ADD COLUMN retrieval_trace_json TEXT;

    ALTER TABLE recommendation_sessions
      ADD COLUMN rerank_trace_json TEXT;

    ALTER TABLE recommendation_results
      ADD COLUMN provenance_json TEXT;

    ALTER TABLE recommendation_results
      ADD COLUMN score_trace_json TEXT;

    CREATE TABLE IF NOT EXISTS recommendation_candidate_provenance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES recommendation_sessions(id) ON DELETE CASCADE,
      media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      score REAL NOT NULL,
      source_rank INTEGER,
      detail_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_recommendation_candidate_provenance_session
      ON recommendation_candidate_provenance(session_id, media_item_id);

    CREATE TABLE IF NOT EXISTS recommendation_rejections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES recommendation_sessions(id) ON DELETE CASCADE,
      media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      reason_code TEXT NOT NULL,
      score REAL,
      detail_json TEXT,
      sampled INTEGER NOT NULL DEFAULT 0 CHECK (sampled IN (0, 1)),
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_recommendation_rejections_session
      ON recommendation_rejections(session_id, stage, reason_code);

    CREATE TABLE IF NOT EXISTS recommendation_impressions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES recommendation_sessions(id) ON DELETE CASCADE,
      media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      rank_shown INTEGER NOT NULL,
      surface TEXT NOT NULL DEFAULT 'search_results',
      visibility TEXT NOT NULL DEFAULT 'server_returned',
      action TEXT NOT NULL DEFAULT 'none',
      dwell_ms INTEGER,
      metadata_json TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_recommendation_impressions_session
      ON recommendation_impressions(session_id, rank_shown);

    CREATE INDEX IF NOT EXISTS idx_recommendation_sessions_trace
      ON recommendation_sessions(trace_schema_version, created_at DESC, id);
  `);

  applyMigration(db, "022_media_type_aware_external_ids", `
    CREATE TABLE external_ids_v2 (
      media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      media_type TEXT NOT NULL CHECK (media_type IN ('movie', 'tv')),
      value TEXT NOT NULL,
      PRIMARY KEY (source, media_type, value)
    );

    INSERT INTO external_ids_v2 (media_item_id, source, media_type, value)
    SELECT e.media_item_id, e.source, m.media_type, e.value
    FROM external_ids e
    JOIN media_items m ON m.id = e.media_item_id;

    DROP TABLE external_ids;
    ALTER TABLE external_ids_v2 RENAME TO external_ids;
    CREATE INDEX idx_external_ids_media_item ON external_ids(media_item_id, source);
  `);

  applyMigration(db, "023_user_scoped_feel_profiles", `
    ALTER TABLE preference_profiles
      ADD COLUMN auth_user_id TEXT REFERENCES app_users(id) ON DELETE CASCADE;

    ALTER TABLE recommendation_sessions
      ADD COLUMN auth_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL;

    ALTER TABLE feel_feedback_events
      ADD COLUMN auth_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL;

    DROP INDEX idx_feel_feedback_events_client_event;
    CREATE UNIQUE INDEX idx_feel_feedback_events_client_event
      ON feel_feedback_events(source, COALESCE(auth_user_id, ''), client_event_id)
      WHERE client_event_id IS NOT NULL;

    INSERT INTO preference_profiles (id, watch_context, label, created_at, updated_at, auth_user_id)
    SELECT 'group:shared', watch_context, label, created_at, updated_at, NULL
    FROM preference_profiles
    WHERE id = 'group:default';

    UPDATE preference_feature_weights SET profile_id = 'group:shared' WHERE profile_id = 'group:default';
    UPDATE feel_profile_terms SET profile_id = 'group:shared' WHERE profile_id = 'group:default';
    UPDATE feel_profile_checkpoints SET profile_id = 'group:shared' WHERE profile_id = 'group:default';
    UPDATE recommendation_sessions SET profile_id = 'group:shared' WHERE profile_id = 'group:default';
    DELETE FROM preference_profiles WHERE id = 'group:default';

    CREATE INDEX idx_preference_profiles_auth_user ON preference_profiles(auth_user_id, watch_context);
    CREATE INDEX idx_recommendation_sessions_auth_user ON recommendation_sessions(auth_user_id, created_at DESC);
    CREATE INDEX idx_feel_feedback_events_auth_user ON feel_feedback_events(auth_user_id, created_at DESC);
  `);

  applyMigration(db, "024_request_creation_idempotency", `
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
  `);

  applyMigration(db, "025_user_capabilities", `
    ALTER TABLE app_users
      ADD COLUMN can_request INTEGER NOT NULL DEFAULT 1 CHECK (can_request IN (0, 1));

    ALTER TABLE app_users
      ADD COLUMN can_use_ai INTEGER NOT NULL DEFAULT 1 CHECK (can_use_ai IN (0, 1));
  `);

  applyMigration(db, "026_durable_auth_and_request_reconciliation", `
    DROP INDEX idx_request_creation_operations_updated_at;
    ALTER TABLE request_creation_operations RENAME TO request_creation_operations_v25;

    CREATE TABLE request_creation_operations (
      idempotency_key TEXT PRIMARY KEY,
      request_fingerprint TEXT NOT NULL,
      auth_scope TEXT NOT NULL,
      media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('pending', 'created', 'failed', 'uncertain')),
      response_json TEXT,
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    INSERT INTO request_creation_operations (
      idempotency_key, request_fingerprint, auth_scope, media_item_id, status,
      response_json, error, created_at, updated_at
    )
    SELECT
      idempotency_key, request_fingerprint, auth_scope, media_item_id, status,
      response_json, error, created_at, updated_at
    FROM request_creation_operations_v25;

    DROP TABLE request_creation_operations_v25;
    CREATE INDEX idx_request_creation_operations_updated_at
      ON request_creation_operations(updated_at DESC);
    CREATE INDEX idx_request_creation_operations_fingerprint
      ON request_creation_operations(auth_scope, request_fingerprint, updated_at DESC);

    CREATE TABLE plex_auth_challenges (
      pin_id TEXT PRIMARY KEY,
      code TEXT NOT NULL,
      state_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      consumed_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX idx_plex_auth_challenges_expires_at
      ON plex_auth_challenges(expires_at);
  `);

  applyMigration(db, "027_bounded_poster_cache", `
    CREATE TABLE IF NOT EXISTS poster_cache (
      media_item_id TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
      content_type TEXT NOT NULL,
      body BLOB NOT NULL,
      fetched_at TEXT NOT NULL
    );

    ALTER TABLE poster_cache ADD COLUMN source_key TEXT;
    ALTER TABLE poster_cache ADD COLUMN byte_size INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE poster_cache ADD COLUMN last_accessed_at TEXT;

    UPDATE poster_cache
    SET byte_size = length(body),
        last_accessed_at = fetched_at;

    CREATE INDEX idx_poster_cache_last_accessed
      ON poster_cache(last_accessed_at, fetched_at, media_item_id);
  `);

  applyMigration(db, "028_catalog_diagnostics_indexes", `
    CREATE INDEX idx_catalog_source_records_active_media_source
      ON catalog_source_records(media_item_id, source)
      WHERE active = 1;

    CREATE INDEX idx_catalog_source_records_inactive_media
      ON catalog_source_records(media_item_id)
      WHERE active = 0;

    CREATE INDEX idx_plex_items_available_media
      ON plex_items(media_item_id)
      WHERE available = 1;

    CREATE INDEX idx_seerr_items_requestable_media
      ON seerr_items(media_item_id)
      WHERE requestable = 1;
  `);

  db.exec("PRAGMA user_version = 28");
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
