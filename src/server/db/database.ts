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

    CREATE TABLE IF NOT EXISTS search_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query_hash TEXT NOT NULL,
      result_count INTEGER NOT NULL,
      used_ai INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_media_items_normalized_title ON media_items(normalized_title);
    CREATE INDEX IF NOT EXISTS idx_media_items_media_type ON media_items(media_type);
    CREATE INDEX IF NOT EXISTS idx_plex_items_media_item_id ON plex_items(media_item_id);
    CREATE INDEX IF NOT EXISTS idx_seerr_items_media_item_id ON seerr_items(media_item_id);
  `);
}
