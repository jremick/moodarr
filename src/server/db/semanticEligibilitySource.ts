import type { SqliteDatabase } from "./database";

const initialized = new WeakSet<SqliteDatabase>();

/** Connection-local change journal. Installed only for the offline experiment.
 * TEMP triggers also observe direct SQL and writes by another repository on the
 * connection. Other connections are conservatively invalidated by data_version.
 * Journal entries are retained per ID so independent readers cannot consume one
 * another's invalidation. No persistent schema or ordinary-path work is added.
 */
export function semanticEligibilitySourceRevision(db: SqliteDatabase) {
  if (db.isTransaction) throw new Error("semantic_projection_uncommitted_source");
  const queryOnly = (db.prepare("PRAGMA query_only").get() as { query_only: number }).query_only === 1;
  if (queryOnly) {
    // Frozen evaluation connections prohibit even TEMP writes. External commits
    // remain visible through data_version (unless the caller explicitly opened an
    // immutable snapshot). total_changes detects a temporary query_only disable,
    // write and re-enable; mode pinning detects a switch left writable.
    const revision = (db.prepare("SELECT total_changes() AS revision").get() as { revision: number }).revision;
    const dataVersion = (db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
    return { revision, dataVersion, mode: "query-only" as const };
  }
  if (!initialized.has(db)) {
    db.exec(`CREATE TEMP TABLE moodrank_semantic_revision (revision INTEGER NOT NULL);
      INSERT INTO moodrank_semantic_revision VALUES (0);
      CREATE TEMP TABLE moodrank_semantic_dirty (item_id TEXT PRIMARY KEY, revision INTEGER NOT NULL);
      CREATE INDEX moodrank_semantic_dirty_revision ON moodrank_semantic_dirty(revision);`);
    for (const table of ["media_items", "media_features", "genres", "people", "external_ids", "plex_items", "seerr_items",
      "catalog_source_records", "catalog_rank_signals", "media_identity_quarantine"]) {
      const key = table === "media_items" ? "id" : "media_item_id";
      for (const action of ["INSERT", "UPDATE", "DELETE"]) {
        const ids = action === "UPDATE" ? [`OLD.${key}`, `NEW.${key}`] : [`${action === "DELETE" ? "OLD" : "NEW"}.${key}`];
        db.exec(`CREATE TEMP TRIGGER moodrank_semantic_${table}_${action.toLowerCase()} AFTER ${action} ON main.${table}
          BEGIN
            UPDATE moodrank_semantic_revision SET revision = revision + 1;
            ${ids.map(id => `INSERT INTO moodrank_semantic_dirty (item_id, revision)
              VALUES (${id}, (SELECT revision FROM moodrank_semantic_revision))
              ON CONFLICT(item_id) DO UPDATE SET revision = excluded.revision;`).join("\n")}
          END;`);
      }
    }
    initialized.add(db);
  }
  const revision = (db.prepare("SELECT revision FROM moodrank_semantic_revision").get() as { revision: number }).revision;
  const dataVersion = (db.prepare("PRAGMA data_version").get() as { data_version: number }).data_version;
  return { revision, dataVersion, mode: "journal" as const };
}

export function semanticEligibilityChangedIds(db: SqliteDatabase, afterRevision: number) {
  return (db.prepare("SELECT item_id FROM moodrank_semantic_dirty WHERE revision > ?").all(afterRevision) as Array<{ item_id: string }>).map(row => row.item_id);
}

export function semanticEligibilityExpiries(db: SqliteDatabase, ids: string[]) {
  if (!ids.length) return new Map<string, number>();
  const rows = db.prepare(`SELECT media_item_id, MIN((julianday(expires_at) - 2440587.5) * 86400000) AS expires
    FROM catalog_source_records WHERE media_item_id IN (${ids.map(() => "?").join(",")})
      AND active = 1 AND julianday(expires_at) > julianday('now') GROUP BY media_item_id`).all(...ids) as Array<{ media_item_id: string; expires: number }>;
  return new Map(rows.map(row => [row.media_item_id, row.expires]));
}
