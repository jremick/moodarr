import { afterEach, describe, expect, it } from "vitest";
import { createDatabase, runMigrations, type SqliteDatabase } from "../src/server/db/database";

const migrationId = "033_feel_feedback_replacement";
const databases: SqliteDatabase[] = [];
const now = "2026-09-05T00:00:00.000Z";

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

describe("feedback replacement migration", () => {
  it("preserves populated feedback, child references, indexes, triggers and retry ownership", () => {
    const db = legacyDatabase();
    seedLinkedFeedback(db);
    db.exec(`
      CREATE TABLE feedback_insert_probe (event_id INTEGER NOT NULL);
      CREATE INDEX feedback_reason_probe ON feel_feedback_events(reason) WHERE reason IS NOT NULL;
      CREATE TRIGGER feedback_insert_probe_trigger AFTER INSERT ON feel_feedback_events
      BEGIN INSERT INTO feedback_insert_probe(event_id) VALUES (NEW.id); END;
    `);
    const before = db.prepare("SELECT * FROM feel_feedback_events").get() as Record<string, unknown>;
    const indexesBefore = db.prepare("SELECT name, sql FROM sqlite_schema WHERE tbl_name = 'feel_feedback_events' AND type = 'index' ORDER BY name").all();

    runMigrations(db);

    expect(db.prepare("SELECT * FROM feel_feedback_events").get()).toEqual({
      ...before, request_json: null, learning_journal_json: null, superseded_by_event_id: null, replaces_event_id: null
    });
    expect(db.prepare("SELECT last_event_id FROM feel_profile_terms").get()).toEqual({ last_event_id: 10 });
    expect(db.prepare("SELECT event_id FROM feel_profile_checkpoints").get()).toEqual({ event_id: 10 });
    expect(db.prepare("SELECT name, sql FROM sqlite_schema WHERE tbl_name = 'feel_feedback_events' AND type = 'index' ORDER BY name").all()).toEqual(indexesBefore);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() => insertFeedback(db, "more_like", "existing-event", "user-a")).toThrow(/UNIQUE/);
    expect(insertFeedback(db, "more_like", "existing-event", "user-b")).toBeGreaterThan(10);
    expect(db.prepare("SELECT COUNT(*) AS count FROM feedback_insert_probe").get()).toEqual({ count: 1 });
    expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
  });

  it.each([false, true])("keeps the next event ID after compaction, all rows removed: %s", (removeAll) => {
    const db = legacyDatabase();
    insertFeedback(db, "open", "retained");
    db.prepare("INSERT INTO feel_feedback_events (id, watch_context, source, action, created_at) VALUES (?, 'solo', 'web', 'open', ?)").run(100, now);
    db.exec(removeAll ? "DELETE FROM feel_feedback_events" : "DELETE FROM feel_feedback_events WHERE id = 100");

    runMigrations(db);

    expect(insertFeedback(db, "open", "after-compaction")).toBe(101);
    expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'feel_feedback_events'").get()).toEqual({ seq: 101 });
  });

  it("adds clear feedback while retaining action constraints and durable supersession IDs", () => {
    const db = legacyDatabase();
    expect(() => insertFeedback(db, "clear_feedback", "before-upgrade")).toThrow(/CHECK/);

    runMigrations(db);

    expect(insertFeedback(db, "clear_feedback", "clear-event")).toBe(1);
    expect(() => insertFeedback(db, "not_an_action", "invalid-event")).toThrow(/CHECK/);
    db.prepare("UPDATE feel_feedback_events SET request_json = ?, learning_journal_json = ?, replaces_event_id = 200, superseded_by_event_id = 300 WHERE id = 1")
      .run('{"action":"clear_feedback"}', '{"version":1}');
    const before = db.prepare("SELECT * FROM feel_feedback_events").all();
    runMigrations(db);
    expect(db.prepare("SELECT * FROM feel_feedback_events").all()).toEqual(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?").get(migrationId)).toEqual({ count: 1 });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 34 });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rolls back a failed migration and restores foreign keys, child links and sequence history", () => {
    const db = legacyDatabase();
    seedLinkedFeedback(db);
    db.prepare("INSERT INTO feel_feedback_events (id, watch_context, source, action, created_at) VALUES (100, 'solo', 'web', 'open', ?)").run(now);
    db.exec("DELETE FROM feel_feedback_events WHERE id = 100");
    db.exec(`
      CREATE TRIGGER reject_feedback_migration BEFORE INSERT ON schema_migrations
      WHEN NEW.id = '${migrationId}' BEGIN SELECT RAISE(ABORT, 'injected migration failure'); END;
    `);
    const before = db.prepare("SELECT * FROM feel_feedback_events").all();

    expect(() => runMigrations(db)).toThrow("injected migration failure");

    expect(db.isTransaction).toBe(false);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 32 });
    expect(db.prepare("SELECT id FROM schema_migrations WHERE id = ?").get(migrationId)).toBeUndefined();
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'feel_feedback_events_v33'").get()).toBeUndefined();
    expect(db.prepare("SELECT * FROM feel_feedback_events").all()).toEqual(before);
    expect(db.prepare("SELECT last_event_id FROM feel_profile_terms").get()).toEqual({ last_event_id: 10 });
    expect(db.prepare("SELECT event_id FROM feel_profile_checkpoints").get()).toEqual({ event_id: 10 });
    expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'feel_feedback_events'").get()).toEqual({ seq: 100 });
    db.exec("DROP TRIGGER reject_feedback_migration");
    runMigrations(db);
    expect(insertFeedback(db, "clear_feedback", "recovered")).toBe(101);
  });

  it("rejects a foreign key violation before commit and retains the original database", () => {
    const db = legacyDatabase();
    db.exec("PRAGMA foreign_keys = OFF");
    db.prepare("INSERT INTO feel_feedback_events (media_item_id, watch_context, source, action, created_at) VALUES ('missing-item', 'solo', 'web', 'open', ?)").run(now);
    db.exec("PRAGMA foreign_keys = ON");

    expect(() => runMigrations(db)).toThrow("Schema 33 feedback migration failed foreign key validation.");

    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 32 });
    expect(db.prepare("SELECT id FROM schema_migrations WHERE id = ?").get(migrationId)).toBeUndefined();
    expect((db.prepare("PRAGMA table_info(feel_feedback_events)").all() as Array<{ name: string }>).some((column) => column.name === "request_json")).toBe(false);
  });

  it("preserves an explicitly disabled foreign key setting", () => {
    const db = legacyDatabase();
    db.exec("PRAGMA foreign_keys = OFF");
    runMigrations(db);
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 0 });
  });
});

function insertFeedback(db: SqliteDatabase, action: string, clientEventId: string, authUserId: string | null = null) {
  return Number(db.prepare("INSERT INTO feel_feedback_events (watch_context, source, action, client_event_id, auth_user_id, created_at) VALUES ('solo', 'web', ?, ?, ?, ?)")
    .run(action, clientEventId, authUserId, now).lastInsertRowid);
}

function legacyDatabase() {
  const db = createDatabase(":memory:");
  databases.push(db);
  const indexes = db.prepare("SELECT sql FROM sqlite_schema WHERE tbl_name = 'feel_feedback_events' AND type = 'index' AND sql IS NOT NULL").all() as Array<{ sql: string }>;
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TABLE feel_feedback_events;
    CREATE TABLE feel_feedback_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT REFERENCES recommendation_sessions(id) ON DELETE SET NULL,
      media_item_id TEXT REFERENCES media_items(id) ON DELETE SET NULL,
      compared_media_item_id TEXT REFERENCES media_items(id) ON DELETE SET NULL,
      watch_context TEXT NOT NULL CHECK (watch_context IN ('solo', 'group')),
      source TEXT NOT NULL CHECK (source IN ('web', 'ios', 'admin')),
      action TEXT NOT NULL CHECK (action IN (
        'swipe_right', 'swipe_left', 'swipe_skip', 'open', 'expand', 'save', 'hide',
        'more_like', 'less_like', 'right_mood', 'wrong_mood', 'pairwise_pick', 'request_preview', 'request_create'
      )),
      mood_term TEXT, reason TEXT,
      strength INTEGER CHECK (strength IS NULL OR strength BETWEEN 1 AND 5),
      metadata_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL,
      reliability TEXT NOT NULL DEFAULT 'diagnostic' CHECK (reliability IN ('high', 'medium', 'weak', 'diagnostic')),
      profile_version INTEGER NOT NULL DEFAULT 0,
      profile_update_applied INTEGER NOT NULL DEFAULT 0 CHECK (profile_update_applied IN (0, 1)),
      profile_holdout INTEGER NOT NULL DEFAULT 0 CHECK (profile_holdout IN (0, 1)),
      client_event_id TEXT,
      auth_user_id TEXT REFERENCES app_users(id) ON DELETE SET NULL
    );
    DELETE FROM schema_migrations WHERE id = '${migrationId}';
    PRAGMA user_version = 32;
    PRAGMA foreign_keys = ON;
  `);
  for (const index of indexes) db.exec(index.sql);
  return db;
}

function seedLinkedFeedback(db: SqliteDatabase) {
  db.prepare("INSERT INTO media_items (id, media_type, title, normalized_title, created_at, updated_at) VALUES ('movie-1', 'movie', 'Fixture Film', 'fixture film', ?, ?)").run(now, now);
  for (const userId of ["user-a", "user-b"]) {
    db.prepare("INSERT INTO app_users (id, provider, provider_user_id, created_at, updated_at) VALUES (?, 'plex', ?, ?, ?)").run(userId, userId, now, now);
  }
  db.prepare("INSERT INTO recommendation_sessions (id, query_hash, engine_version, watch_context, result_count, candidate_count, rerank_candidate_count, auth_user_id, created_at) VALUES ('session-1', 'fixture-query', 'fixture-engine', 'solo', 1, 1, 1, 'user-a', ?)").run(now);
  db.prepare("INSERT INTO preference_profiles (id, watch_context, label, auth_user_id, created_at, updated_at) VALUES ('solo:user-a', 'solo', 'Fixture', 'user-a', ?, ?)").run(now, now);
  db.prepare(`INSERT INTO feel_feedback_events (
    id, session_id, media_item_id, watch_context, source, action, mood_term, reason, strength,
    metadata_json, reliability, profile_version, profile_update_applied, profile_holdout, client_event_id, auth_user_id, created_at
  ) VALUES (10, 'session-1', 'movie-1', 'solo', 'web', 'more_like', 'cozy', 'too_slow', 4,
    '{"surface":"fixture"}', 'medium', 7, 1, 0, 'existing-event', 'user-a', ?)`).run(now);
  db.prepare(`INSERT INTO feel_profile_terms (
    profile_id, watch_context, term, feature_weights_json, confidence, evidence_count, last_event_id, version, created_at, updated_at
  ) VALUES ('solo:user-a', 'solo', 'cozy', '{"mood:cozy":0.22}', 0.4, 1, 10, 7, ?, ?)`).run(now, now);
  db.prepare(`INSERT INTO feel_profile_checkpoints (
    profile_id, watch_context, term, version, feature_weights_json, confidence, evidence_count, event_id, created_at
  ) VALUES ('solo:user-a', 'solo', 'cozy', 7, '{"mood:cozy":0.22}', 0.4, 1, 10, ?)`).run(now);
}
