import { describe, expect, it } from "vitest";
import { createDatabase, runMigrations } from "../src/server/db/database";

const migrationId = "034_seerr_snapshot_watermark";

function previousDatabase() {
  const db = createDatabase(":memory:");
  db.exec("DROP TABLE seerr_sync_state");
  db.prepare("DELETE FROM schema_migrations WHERE id = ?").run(migrationId);
  db.exec("PRAGMA user_version = 33");
  return db;
}

describe("Seerr snapshot watermark migration", () => {
  it("upgrades schema 33 with one durable singleton watermark and preserves it on rerun", () => {
    const db = previousDatabase();
    try {
      runMigrations(db);
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 34 });
      expect(db.prepare("SELECT * FROM seerr_sync_state").all()).toEqual([]);
      db.prepare("INSERT INTO seerr_sync_state VALUES (1, ?)").run("2026-01-01T00:00:00.000Z");
      expect(() => db.prepare("INSERT INTO seerr_sync_state VALUES (2, ?)").run("2026-01-02T00:00:00.000Z")).toThrow();
      runMigrations(db);
      expect(db.prepare("SELECT * FROM seerr_sync_state").all()).toEqual([{ id: 1, completed_snapshot_started_at: "2026-01-01T00:00:00.000Z" }]);
      expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE id = ?").get(migrationId)).toEqual({ count: 1 });
      expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("rolls back the table and migration marker when publication fails", () => {
    const db = previousDatabase();
    try {
      db.exec(`CREATE TRIGGER reject_watermark_migration BEFORE INSERT ON schema_migrations
        WHEN NEW.id = '${migrationId}' BEGIN SELECT RAISE(ABORT, 'synthetic migration failure'); END`);
      expect(() => runMigrations(db)).toThrow("synthetic migration failure");
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 33 });
      expect(db.prepare("SELECT name FROM sqlite_schema WHERE name = 'seerr_sync_state'").get()).toBeUndefined();
      expect(db.prepare("SELECT id FROM schema_migrations WHERE id = ?").get(migrationId)).toBeUndefined();
    } finally {
      db.close();
    }
  });
});
