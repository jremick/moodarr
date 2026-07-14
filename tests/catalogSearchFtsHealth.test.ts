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
