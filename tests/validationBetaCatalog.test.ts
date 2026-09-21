import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { assetVersion, compareCatalogSnapshots, readCatalogSnapshot, validateIdentity } from "../scripts/validation/beta-catalog-check";

const identity = { version: "0.1.0-beta.3", revision: "a".repeat(40), digest: `sha256:${"b".repeat(64)}`, imageId: `sha256:${"c".repeat(64)}` };
const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = createDatabase(":memory:");
  databases.push(db);
  const repository = new MediaRepository(db, { runStartupRepairs: false });
  const id = repository.upsertCatalogRecord({
    source: "wikidata", sourceVersion: assetVersion, sourceItemId: "Q1", licensePolicy: "wikidata-cc0", payloadHash: "one",
    media: { mediaType: "movie", title: "Star Family Comedy", summary: "A gentle comedy about family.", genres: ["Comedy"],
      cast: ["Alice"], directors: ["Bob"], externalIds: { tmdb: 1 } }
  });
  repository.recordCatalogSync("wikidata", assetVersion, "ok", { itemCount: 1, mediaItemsUpserted: 1, sourceRecordsUpserted: 1, updateMode: "full_snapshot" });
  return { db, id, snapshot: () => readCatalogSnapshot(db, identity, 1) };
}

describe("public exact-candidate catalog checker", () => {
  it("reads a complete catalog without changing the database and retains all table hashes", () => {
    const { db, snapshot } = fixture();
    const beforeChanges = db.prepare("SELECT total_changes() AS n").get()!.n;
    const result = snapshot();
    expect(db.prepare("SELECT total_changes() AS n").get()!.n).toBe(beforeChanges);
    expect(Object.keys(result.hashes)).toHaveLength(14);
    expect(result.counts.catalog_source_records).toBe(1);
    expect(compareCatalogSnapshots(result, snapshot())).toMatchObject({ restartContentParity: true, projectionUpdatedAtChanges: 0 });
  });

  it("permits only projection timestamps to change and retains their raw hash", () => {
    const { db, snapshot } = fixture();
    const before = snapshot();
    db.exec("UPDATE catalog_search_index SET updated_at = '2030-01-01T00:00:00Z'");
    const after = snapshot();
    expect(after.hashes.catalog_search_index).not.toBe(before.hashes.catalog_search_index);
    expect(compareCatalogSnapshots(before, after)).toMatchObject({ projectionUpdatedAtChanges: 1 });
    db.exec("UPDATE catalog_search_index SET rank_score = rank_score + 1");
    expect(() => compareCatalogSnapshots(before, snapshot())).toThrow("content changed");
  });

  it("rejects changes in a non-projection table even when its row count is unchanged", () => {
    const { db, snapshot } = fixture();
    const before = snapshot();
    db.exec("UPDATE catalog_source_records SET payload_hash = 'changed'");
    expect(() => compareCatalogSnapshots(before, snapshot())).toThrow("content changed");
  });

  it.each([
    "DELETE FROM catalog_search_index_fts",
    "INSERT INTO catalog_search_index_fts SELECT * FROM catalog_search_index_fts",
    "UPDATE catalog_search_index_fts SET search_text = 'wrong content'",
    "UPDATE media_feature_fts SET people = 'wrong order or names'",
    "UPDATE media_mood_feature_scores SET score = 0",
    "DELETE FROM media_mood_feature_scores WHERE source = 'deterministic'",
    "ALTER TABLE catalog_search_index ADD COLUMN unreviewed_field TEXT"
  ])("fails closed for corrupt or unreviewed state: %s", sql => {
    const { db, snapshot } = fixture();
    db.exec(sql);
    expect(snapshot).toThrow();
  });

  it.each(["{}", "null", '"not an array"', "invalid json"])("rejects missing-score terms with malformed shape: %s", value => {
    const { db, snapshot } = fixture();
    db.exec("DELETE FROM media_mood_feature_scores WHERE source = 'deterministic'");
    db.exec("UPDATE media_features SET mood_terms_json = '[]', tone_terms_json = '[]', watchability_terms_json = '[]'");
    expect(snapshot().checks.scoreSemantics).toBe(true);
    for (const field of ["mood_terms_json", "tone_terms_json", "watchability_terms_json"]) {
      db.prepare(`UPDATE media_features SET ${field} = ?`).run(value);
      expect(snapshot).toThrow("Missing deterministic scores require empty mood/tone/watchability arrays");
      db.exec(`UPDATE media_features SET ${field} = '[]'`);
    }
  });

  it("rejects unexpected local request audits and accepts only the exact expected preview receipt", () => {
    const { db, id, snapshot } = fixture();
    db.prepare(`INSERT INTO request_audit (media_item_id,action,status,media_type,media_id,created_at)
      VALUES (?,'preview','allowed','movie',1,'2026-09-21')`).run(id);
    expect(snapshot).toThrow("Unexpected request audit");
    const expected = [{ itemId: id, action: "preview", status: "allowed", mediaType: "movie", mediaId: 1, seasonsJson: null, externalRequestId: null }];
    expect(readCatalogSnapshot(db, identity, 1, expected).localWrites.previewAudits).toBe(1);
    db.exec("UPDATE request_audit SET action = 'create'");
    expect(() => readCatalogSnapshot(db, identity, 1, expected)).toThrow("Unexpected request audit");
  });

  it("rejects the wrong candidate or an inherited baseline", () => {
    expect(() => validateIdentity({ ...identity, revision: "HEAD" })).toThrow();
    expect(() => validateIdentity({ ...identity, version: "0.1.0-beta.2" })).toThrow();
    const { snapshot } = fixture();
    const before = snapshot();
    expect(() => compareCatalogSnapshots(before, { ...before, candidate: { ...identity, digest: `sha256:${"d".repeat(64)}` } })).toThrow();
  });
});
