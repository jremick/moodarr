import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";

describe("catalog search FTS health", () => {
  it("full-rebuilds equal-sized materialized and FTS projections with the wrong membership", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const searchableMediaItemId = repository.upsert({
      mediaType: "movie",
      title: "Quiet Lantern",
      summary: "A gentle fantasy adventure.",
      genres: ["Fantasy"]
    });
    const operationalMediaItemId = repository.upsert({
      mediaType: "movie",
      title: "Legacy Replica",
      summary: "Content awaiting trusted reconciliation."
    });

    db.prepare("UPDATE media_items SET source = 'operational' WHERE id = ?").run(operationalMediaItemId);
    db.prepare("DELETE FROM catalog_search_index WHERE media_item_id = ?").run(searchableMediaItemId);
    db.prepare("DELETE FROM catalog_search_index_fts").run();
    db.prepare(
      `INSERT INTO catalog_search_index_fts (media_item_id, title, search_text, mood_text)
       SELECT media_item_id, title, search_text, mood_text
       FROM catalog_search_index`
    ).run();
    expect(catalogSearchIds()).toEqual([operationalMediaItemId]);
    expect(catalogSearchFtsIds()).toEqual([operationalMediaItemId]);

    const restartedRepository = new MediaRepository(db);

    expect(catalogSearchIds()).toEqual([searchableMediaItemId]);
    expect(catalogSearchFtsIds()).toEqual([searchableMediaItemId]);
    expect(restartedRepository.catalogSearchCandidateIds("gentle fantasy", {}, 10)).toEqual([searchableMediaItemId]);
    db.close();

    function catalogSearchIds() {
      return (db.prepare("SELECT media_item_id FROM catalog_search_index ORDER BY media_item_id").all() as Array<{ media_item_id: string }>).map(
        (row) => row.media_item_id
      );
    }

    function catalogSearchFtsIds() {
      return (db.prepare("SELECT media_item_id FROM catalog_search_index_fts ORDER BY media_item_id").all() as Array<{ media_item_id: string }>).map(
        (row) => row.media_item_id
      );
    }
  });

  it("repairs a missing FTS projection from the materialized catalog index on startup", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const mediaItemId = repository.upsert({
      mediaType: "movie",
      title: "Quiet Lantern",
      summary: "A gentle fantasy adventure.",
      genres: ["Fantasy"]
    });

    expect(repository.catalogSearchIndexCount()).toBe(1);
    expect(catalogSearchFtsCount()).toBe(1);
    db.prepare("DELETE FROM catalog_search_index_fts").run();
    expect(catalogSearchFtsCount()).toBe(0);

    const restartedRepository = new MediaRepository(db);

    expect(catalogSearchFtsCount()).toBe(restartedRepository.catalogSearchIndexCount());
    expect(restartedRepository.catalogSearchCandidateIds("gentle fantasy", {}, 10)).toContain(
      mediaItemId
    );
    db.close();

    function catalogSearchFtsCount() {
      return (db.prepare("SELECT COUNT(*) AS value FROM catalog_search_index_fts").get() as { value: number }).value;
    }
  });
});

describe("catalog derived materialization closure", () => {
  it("accepts a complete derived projection and preserves first-row duplicate semantics", () => {
    const { db, repository, mediaItemId } = catalogClosureFixture();

    expect(repository.catalogDerivedMaterializationIssueCount([mediaItemId, mediaItemId])).toBe(0);

    db.prepare(
      `INSERT INTO catalog_search_index_fts (media_item_id, title, search_text, mood_text)
       VALUES (?, 'Later stale title', 'Later stale search', 'Later stale mood')`
    ).run(mediaItemId);
    expect(repository.catalogDerivedMaterializationIssueCount([mediaItemId])).toBe(0);

    db.prepare("DELETE FROM catalog_search_index_fts WHERE media_item_id = ?").run(mediaItemId);
    db.prepare(
      `INSERT INTO catalog_search_index_fts (media_item_id, title, search_text, mood_text)
       VALUES (?, 'Earlier stale title', 'Earlier stale search', 'Earlier stale mood')`
    ).run(mediaItemId);
    db.prepare(
      `INSERT INTO catalog_search_index_fts (media_item_id, title, search_text, mood_text)
       SELECT media_item_id, title, search_text, mood_text
       FROM catalog_search_index
       WHERE media_item_id = ?`
    ).run(mediaItemId);
    expect(repository.catalogDerivedMaterializationIssueCount([mediaItemId])).toBe(1);

    db.close();
  });

  it.each([
    ["missing row", "DELETE FROM catalog_search_index_fts WHERE media_item_id = ?"],
    ["title mismatch", "UPDATE catalog_search_index_fts SET title = title || ' stale' WHERE media_item_id = ?"],
    ["search-text mismatch", "UPDATE catalog_search_index_fts SET search_text = search_text || ' stale' WHERE media_item_id = ?"],
    ["mood-text mismatch", "UPDATE catalog_search_index_fts SET mood_text = mood_text || ' stale' WHERE media_item_id = ?"]
  ])("detects a catalog FTS %s", (_caseName, corruptionSql) => {
    const { db, repository, mediaItemId } = catalogClosureFixture();

    expect(repository.catalogDerivedMaterializationIssueCount([mediaItemId])).toBe(0);
    db.prepare(corruptionSql).run(mediaItemId);
    expect(repository.catalogDerivedMaterializationIssueCount([mediaItemId])).toBe(1);

    db.close();
  });

  it("detects a missing feature FTS projection", () => {
    const { db, repository, mediaItemId } = catalogClosureFixture();

    expect(repository.catalogDerivedMaterializationIssueCount([mediaItemId])).toBe(0);
    db.prepare("DELETE FROM media_feature_fts WHERE media_item_id = ?").run(mediaItemId);
    expect(repository.catalogDerivedMaterializationIssueCount([mediaItemId])).toBe(1);

    db.close();
  });

  it.each([
    [
      "catalog search FTS",
      `INSERT INTO catalog_search_index_fts (media_item_id, title, search_text, mood_text)
       VALUES (?, 'Forbidden operational title', 'Forbidden operational search', 'Forbidden operational mood')`
    ],
    [
      "media feature FTS",
      `INSERT INTO media_feature_fts (media_item_id, title, feature_text, genres, people)
       VALUES (?, 'Forbidden operational title', 'Forbidden operational feature', '', '')`
    ]
  ])("detects operational residue in %s", (_tableName, insertSql) => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db, { runStartupRepairs: false });
    const mediaItemId = repository.upsert({
      source: "operational",
      mediaType: "movie",
      title: "Operational Boundary Sentinel"
    });

    expect(repository.catalogDerivedMaterializationIssueCount([mediaItemId])).toBe(0);
    db.prepare(insertSql).run(mediaItemId);
    expect(repository.catalogDerivedMaterializationIssueCount([mediaItemId])).toBe(1);

    db.close();
  });
});

function catalogClosureFixture() {
  const db = createDatabase(":memory:");
  const repository = new MediaRepository(db, { runStartupRepairs: false });
  const mediaItemId = repository.upsert({
    source: "catalog",
    mediaType: "movie",
    title: "Catalog Closure Sentinel",
    year: 2026,
    summary: "A complete deterministic projection.",
    genres: ["Drama"]
  });
  return { db, repository, mediaItemId };
}
