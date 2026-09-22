import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

export const assetVersion = "wikidata-20260622-min5-v1";
export const assetSha256 = "dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a";
export const tableOrder = {
  schema_migrations: "id", media_items: "id", catalog_source_records: "source, source_item_id",
  catalog_sync_runs: "id", catalog_rank_signals: "media_item_id, source", external_ids: "source, media_type, value",
  genres: "media_item_id, name", people: "media_item_id, name, role", media_features: "media_item_id",
  media_feature_fts: "media_item_id", media_mood_feature_scores: "media_item_id, source, feature",
  media_content_fingerprints: "media_item_id", catalog_search_index: "media_item_id",
  catalog_search_index_fts: "media_item_id"
} as const;
const projectionColumns = ["media_item_id", "title", "media_type", "year", "source", "rank_score", "availability_group",
  "plex_available", "seerr_requestable", "has_seerr", "has_summary", "search_text", "mood_text"];
type Identity = { version: string; revision: string; digest: string; imageId: string };
type Row = Record<string, any>;

export function validateIdentity(identity: Identity) {
  assert.equal(identity.version, "0.1.0-beta.4");
  assert.match(identity.revision, /^[a-f0-9]{40}$/);
  assert.match(identity.digest, /^sha256:[a-f0-9]{64}$/);
  assert.match(identity.imageId, /^sha256:[a-f0-9]{64}$/);
  return { version: identity.version, revision: identity.revision, digest: identity.digest, imageId: identity.imageId };
}

function hashQuery(db: DatabaseSync, sql: string) {
  const hash = createHash("sha256");
  for (const row of db.prepare(sql).iterate()) hash.update(JSON.stringify(row) + "\n");
  return hash.digest("hex");
}

export function readCatalogSnapshot(db: DatabaseSync, identity: Identity, expectedRecords = 90397, expectedAudits: Row[] = []) {
  const candidate = validateIdentity(identity);
  const count = (sql: string) => Number(db.prepare(sql).get()!.n);
  assert.deepEqual(db.prepare("PRAGMA integrity_check").all().map(row => row.integrity_check), ["ok"]);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(count("SELECT COUNT(*) AS n FROM catalog_source_records"), expectedRecords);
  assert.equal(count("SELECT COUNT(DISTINCT source_item_id) AS n FROM catalog_source_records"), expectedRecords);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM catalog_source_records WHERE source = 'wikidata'
    AND source_version = ? AND last_seen_source_version = ? AND active = 1
    AND materialization_stale = 0 AND deleted_at IS NULL`).get(assetVersion, assetVersion)!.n, expectedRecords);
  for (const table of ["plex_items", "seerr_items", "media_embeddings", "poster_cache", "requests", "request_creation_operations", "app_users", "user_sessions"]) {
    assert.equal(count(`SELECT COUNT(*) AS n FROM ${table}`), 0, `Unexpected disposable data: ${table}`);
  }
  const audits = db.prepare(`SELECT media_item_id AS itemId,action,status,media_type AS mediaType,media_id AS mediaId,
    seasons_json AS seasonsJson,external_request_id AS externalRequestId FROM request_audit ORDER BY id`).all().map(row => ({ ...row }));
  assert.deepEqual(audits, expectedAudits, "Unexpected request audit or create effect");
  assert.equal(count("SELECT COUNT(*) AS n FROM media_items WHERE source != 'catalog'"), 0);
  assert.equal(count(`SELECT COUNT(*) AS n FROM media_items m WHERE NOT EXISTS
    (SELECT 1 FROM catalog_source_records r WHERE r.media_item_id = m.id AND r.active = 1)`), 0);
  const counts = Object.fromEntries(Object.keys(tableOrder).map(table => [table, count(`SELECT COUNT(*) AS n FROM ${table}`)]));
  assert.ok(counts.media_items > 0 && counts.media_items <= expectedRecords);
  assert.equal(counts.catalog_sync_runs, 1);
  for (const table of ["media_features", "media_content_fingerprints", "catalog_search_index"]) {
    assert.equal(counts[table], counts.media_items, `Incomplete ${table}`);
    assert.equal(count(`SELECT COUNT(*) AS n FROM (SELECT id FROM media_items EXCEPT SELECT media_item_id FROM ${table})`), 0);
  }
  assert.equal(count(`SELECT COUNT(*) AS n FROM media_features f WHERE NOT EXISTS
    (SELECT 1 FROM media_mood_feature_scores s WHERE s.media_item_id = f.media_item_id AND s.source = 'deterministic')
    AND (${["mood_terms_json", "tone_terms_json", "watchability_terms_json"].map(field =>
    `CASE WHEN json_valid(f.${field}) THEN json_type(f.${field}) = 'array' AND json_array_length(f.${field}) = 0 ELSE 0 END`
  ).join(" AND ")}) IS NOT 1`), 0,
  "Missing deterministic scores require empty mood/tone/watchability arrays");
  assert.equal(count(`SELECT COUNT(*) AS n FROM media_mood_feature_scores s LEFT JOIN media_features f ON f.media_item_id = s.media_item_id
    WHERE f.media_item_id IS NULL OR s.score <= 0 OR s.score > 100 OR s.confidence <= 0 OR s.confidence > 1
      OR (s.source = 'deterministic' AND s.source_version != f.feature_version)`), 0);
  const moodCoverage = Object.fromEntries(["deterministic", "content fingerprint", "any"].map(source => [source,
    count(`SELECT COUNT(*) AS n FROM media_features f WHERE NOT EXISTS (SELECT 1 FROM media_mood_feature_scores s
      WHERE s.media_item_id = f.media_item_id ${source === "any" ? "" : `AND s.source = '${source}'`})`)]));
  for (const [fts, relational] of [["media_feature_fts", "media_features"], ["catalog_search_index_fts", "catalog_search_index"]]) {
    assert.equal(counts[fts], counts[relational]);
    assert.equal(count(`SELECT COUNT(*) AS n FROM (SELECT media_item_id FROM ${relational} EXCEPT SELECT media_item_id FROM ${fts})`), 0);
    assert.equal(count(`SELECT COUNT(*) AS n FROM (SELECT media_item_id FROM ${fts} EXCEPT SELECT media_item_id FROM ${relational})`), 0);
    assert.equal(count(`SELECT COUNT(*) AS n FROM (SELECT media_item_id FROM ${fts} GROUP BY media_item_id HAVING COUNT(*) != 1)`), 0);
  }
  for (const [left, right] of [["catalog_search_index", "catalog_search_index_fts"], ["catalog_search_index_fts", "catalog_search_index"]]) {
    assert.equal(count(`SELECT COUNT(*) AS n FROM (SELECT media_item_id,title,search_text,mood_text FROM ${left}
      EXCEPT SELECT media_item_id,title,search_text,mood_text FROM ${right})`), 0, "Catalog FTS content mismatch");
  }
  assert.equal(count(`SELECT COUNT(*) AS n FROM media_feature_fts x JOIN media_features f USING(media_item_id)
    JOIN media_items m ON m.id = x.media_item_id WHERE x.feature_text IS NOT f.feature_text OR x.title IS NOT m.title
    OR x.genres IS NOT COALESCE((SELECT group_concat(name, ' ') FROM (SELECT name FROM genres WHERE media_item_id = m.id ORDER BY name)), '')
    OR x.people IS NOT COALESCE((SELECT group_concat(name, ' ') FROM (SELECT name FROM people WHERE media_item_id = m.id
      AND role IN ('cast','director') ORDER BY CASE role WHEN 'cast' THEN 0 ELSE 1 END, name)), '')`), 0, "Feature FTS content mismatch");
  assert.equal(count(`SELECT COUNT(*) AS n FROM catalog_search_index x JOIN media_items m ON m.id = x.media_item_id
    WHERE x.title IS NOT m.title OR x.media_type IS NOT m.media_type OR x.year IS NOT m.year OR x.source IS NOT m.source`), 0);
  assert.deepEqual({ ...db.prepare("SELECT source,source_version,status,update_mode,item_count,error FROM catalog_sync_runs").get() },
    { source: "wikidata", source_version: assetVersion, status: "ok", update_mode: "full_snapshot", item_count: expectedRecords, error: null });
  const matches = Object.fromEntries(["media_feature_fts", "catalog_search_index_fts"].map(table => [table,
    Object.fromEntries(["star", "comedy", "family"].map(term => {
      const n = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${table} MATCH ?`).get(term)!.n);
      assert.ok(n > 0, `${table}: missing MATCH ${term}`);
      return [term, n];
    }))]));
  // Reject schema drift instead of silently excluding a newly added projection field.
  assert.deepEqual(db.prepare("PRAGMA table_info(catalog_search_index)").all().map(row => row.name).sort(), [...projectionColumns, "updated_at"].sort());
  const hashes = Object.fromEntries(Object.entries(tableOrder).map(([table, order]) => [table, hashQuery(db, `SELECT * FROM ${table} ORDER BY ${order}`)]));
  return { schema: "moodarr-beta4-catalog-cold-v1", candidate, counts, moodCoverage, matches, hashes,
    projectionContentSha256: hashQuery(db, `SELECT ${projectionColumns.join(",")} FROM catalog_search_index ORDER BY media_item_id`),
    projectionUpdatedAt: db.prepare("SELECT media_item_id,updated_at FROM catalog_search_index ORDER BY media_item_id").all(),
    checks: { sqliteIntegrity: true, foreignKeys: true, membership: true, indexContent: true, scoreSemantics: true },
    localWrites: { requests: 0, requestCreationOperations: 0, previewAudits: audits.length } };
}

type Snapshot = ReturnType<typeof readCatalogSnapshot>;
export function compareCatalogSnapshots(before: Snapshot, after: Snapshot) {
  const semantic = (snapshot: Snapshot) => ({ schema: snapshot.schema, candidate: snapshot.candidate, counts: snapshot.counts,
    moodCoverage: snapshot.moodCoverage, matches: snapshot.matches, projectionContentSha256: snapshot.projectionContentSha256,
    hashes: { ...snapshot.hashes, catalog_search_index: "updated_at counted separately" }, checks: snapshot.checks });
  assert.deepEqual(semantic(after), semantic(before), "Catalog or index content changed across startup/restart");
  assert.equal(after.projectionUpdatedAt.length, before.projectionUpdatedAt.length);
  let projectionUpdatedAtChanges = 0;
  after.projectionUpdatedAt.forEach((row, index) => {
    assert.equal(row.media_item_id, before.projectionUpdatedAt[index].media_item_id);
    if (row.updated_at !== before.projectionUpdatedAt[index].updated_at) projectionUpdatedAtChanges++;
  });
  return { restartContentParity: true, projectionUpdatedAtChanges, timestampException: "catalog_search_index.updated_at only" };
}

// Read-only CLI. FTS5's transactional postings check is a separate documented command.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [manifestPath, databasePath, beforePath, receiptPath] = process.argv.slice(2);
  assert.ok(manifestPath && databasePath, "Usage: node beta-catalog-check.ts manifest.json database.sqlite [before.json [boundaries.json]]");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.assetSha256, assetSha256);
  assert.equal(manifest.assetRecords, 90397);
  const before = beforePath ? JSON.parse(readFileSync(beforePath, "utf8")) : undefined;
  const receipt = receiptPath ? JSON.parse(readFileSync(receiptPath, "utf8")) : undefined;
  if (receipt) {
    assert.deepEqual(receipt.candidate, validateIdentity(manifest));
    assert.equal(receipt.ok, true);
    assert.equal(receipt.expectedAudits?.length, 3);
    assert.ok(receipt.expectedAudits.every((row: Row) => row.action === "preview" && row.externalRequestId === null));
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const snapshot = readCatalogSnapshot(db, manifest, 90397, receipt?.expectedAudits);
    console.log(JSON.stringify({ ...snapshot, ...(before ? compareCatalogSnapshots(before, snapshot) : { restartContentParity: false }) }));
  } finally { db.close(); }
}
