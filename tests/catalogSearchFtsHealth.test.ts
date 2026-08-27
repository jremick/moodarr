import { describe, expect, it } from "vitest";
import { refreshCatalogSearchProjection } from "../src/server/db/catalogSearchProjection";
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

  it("keeps only allowlisted catalog metadata searchable across incremental and full rebuilds", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const mediaItemId = repository.upsertCatalogRecord({
      source: "operator catalog",
      sourceVersion: "catalog-search-projection-v1",
      sourceItemId: "catalog-search-projection-sentinel",
      licensePolicy: "operator-approved",
      metadata: {
        aliases: [
          "Zulu Keeper Alias",
          "Allowed Lantern Alias",
          "Alias 02",
          "Alias 03",
          "Alias 04",
          "Alias 05",
          "Alias 06",
          "Alias 07",
          "Alias 08",
          "Alias 09",
          "Alias 10",
          "Alias 11",
          "November Dropped Alias"
        ],
        countries: ["Côte d'Ivoire"],
        languages: ["Português"],
        franchises: ["Lantern Stories"],
        has_english_wikipedia: true,
        private_notes: "forbidden-metadata-sentinel"
      },
      mainstreamScore: 80,
      sitelinkCount: 100,
      awardCount: 2,
      media: {
        mediaType: "movie",
        title: "Catalog Projection Film",
        summary: "A neutral catalog summary.",
        genres: ["Drama"],
        cast: [],
        directors: [],
        externalIds: { tmdb: "987654" }
      }
    });
    repository.upsertCatalogRecord({
      source: "second operator catalog",
      sourceVersion: "catalog-search-projection-v1",
      sourceItemId: "catalog-search-projection-second-source",
      licensePolicy: "operator-approved",
      metadata: {
        aliases: ["Second Source Dropped Alias", "Zulu Keeper Alias"],
        countries: ["Côte d'Ivoire"],
        private_notes: "second-forbidden-metadata-sentinel"
      },
      media: {
        mediaType: "movie",
        title: "Catalog Projection Film",
        summary: "A neutral catalog summary.",
        genres: ["Drama"],
        cast: [],
        directors: [],
        externalIds: { tmdb: "987654" }
      }
    });
    const sourceMetadataBefore = db
      .prepare("SELECT source, metadata_json FROM catalog_source_records WHERE media_item_id = ? ORDER BY source")
      .all(mediaItemId);

    const incrementalProjection = assertProjection();
    repository.rebuildCatalogSearchIndex();
    expect(assertProjection()).toEqual(incrementalProjection);
    expect(db.prepare("SELECT source, metadata_json FROM catalog_source_records WHERE media_item_id = ? ORDER BY source").all(mediaItemId))
      .toEqual(sourceMetadataBefore);
    db.close();

    function assertProjection() {
      const materialized = db.prepare("SELECT search_text, mood_text FROM catalog_search_index WHERE media_item_id = ?").get(mediaItemId) as {
        search_text: string;
        mood_text: string;
      };
      const fts = db.prepare("SELECT search_text, mood_text FROM catalog_search_index_fts WHERE media_item_id = ?").get(mediaItemId);
      expect(materialized.search_text).toContain("Allowed Lantern Alias");
      expect(materialized.search_text).toContain("Zulu Keeper Alias");
      expect(materialized.search_text).not.toContain("November Dropped Alias");
      expect(materialized.search_text).not.toContain("Second Source Dropped Alias");
      expect(materialized.search_text).toContain("Côte d'Ivoire");
      expect(materialized.search_text).toContain("Português");
      expect(materialized.search_text).toContain("Lantern Stories");
      expect(materialized.search_text).toContain("mainstream friendly popular recognizable");
      expect(materialized.search_text).toContain("well known");
      expect(materialized.search_text).toContain("award recognized acclaimed");
      expect(materialized.search_text).toContain("english wikipedia");
      expect(materialized.search_text).not.toContain("private notes");
      expect(materialized.search_text).not.toContain("forbidden-metadata-sentinel");
      expect(materialized.search_text).not.toContain("second-forbidden-metadata-sentinel");
      expect(materialized.mood_text).toContain("mainstream-friendly recognizable");
      expect(materialized.mood_text).toContain("franchise-entry familiar-world");
      expect(materialized.mood_text).toContain("country-cote-d-ivoire");
      expect(materialized.mood_text).toContain("language-portugues");
      expect(fts).toEqual(materialized);
      expect(repository.catalogSearchCandidateIds("Allowed Lantern Alias", {}, 10)).toEqual([mediaItemId]);
      expect(repository.catalogSearchCandidateIds("Lantern Stories", {}, 10)).toEqual([mediaItemId]);
      expect(repository.catalogSearchCandidateIds("forbidden metadata sentinel", {}, 10)).toEqual([]);
      return { materialized, fts };
    }
  });

  it("refreshes a shared item's projection when one catalog source is retired", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const mediaItemId = repository.upsertCatalogRecord({
      source: "alpha catalog",
      sourceVersion: "shared-v1",
      sourceItemId: "alpha-shared-item",
      licensePolicy: "operator-approved",
      metadata: { aliases: ["ZXQRETIRESOURCEALIAS"] },
      media: {
        mediaType: "movie",
        title: "Shared Catalog Target",
        summary: "A neutral shared-source summary.",
        genres: ["Drama"],
        cast: [],
        directors: [],
        externalIds: { tmdb: 991001 }
      }
    });
    expect(repository.upsertCatalogRecord({
      source: "beta catalog",
      sourceVersion: "shared-v1",
      sourceItemId: "beta-shared-item",
      licensePolicy: "operator-approved",
      metadata: { aliases: ["ZXQSURVIVINGSOURCEALIAS"] },
      media: {
        mediaType: "movie",
        title: "Shared Catalog Target",
        summary: "A neutral shared-source summary.",
        genres: ["Drama"],
        cast: [],
        directors: [],
        externalIds: { tmdb: 991001 }
      }
    })).toBe(mediaItemId);

    repository.markCatalogRecordsInactiveExcept("alpha catalog", "shared-v2", []);

    const incrementalProjection = projection();
    expect(incrementalProjection.search_text).not.toContain("ZXQRETIRESOURCEALIAS");
    expect(incrementalProjection.search_text).toContain("ZXQSURVIVINGSOURCEALIAS");
    expect(repository.catalogSearchCandidateIds("ZXQRETIRESOURCEALIAS", {}, 10)).toEqual([]);
    expect(repository.catalogSearchCandidateIds("ZXQSURVIVINGSOURCEALIAS", {}, 10)).toEqual([mediaItemId]);
    expect(
      db.prepare("SELECT COUNT(*) AS value FROM catalog_source_records WHERE media_item_id = ? AND active = 1")
        .get(mediaItemId)
    ).toEqual({ value: 1 });

    repository.rebuildCatalogSearchIndex();
    expect(projection()).toEqual(incrementalProjection);
    db.close();

    function projection() {
      const materialized = db
        .prepare(
          `SELECT title, media_type, source, availability_group, plex_available,
                  seerr_requestable, has_seerr, has_summary, search_text, mood_text
           FROM catalog_search_index
           WHERE media_item_id = ?`
        )
        .get(mediaItemId) as Record<string, unknown>;
      expect(
        db.prepare("SELECT title, search_text, mood_text FROM catalog_search_index_fts WHERE media_item_id = ?")
          .get(mediaItemId)
      ).toEqual({
        title: materialized.title,
        search_text: materialized.search_text,
        mood_text: materialized.mood_text
      });
      return materialized;
    }
  });

  it("keeps a Plex-retained item indexed without aliases from a retired catalog source", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const mediaItemId = repository.upsertCatalogRecord({
      source: "alpha catalog",
      sourceVersion: "plex-retained-v1",
      sourceItemId: "plex-retained-catalog-item",
      licensePolicy: "operator-approved",
      metadata: { aliases: ["ZXQRETIREDPLEXALIAS"] },
      media: {
        mediaType: "movie",
        title: "Plex Retained Target",
        summary: "A neutral Plex-retained summary.",
        genres: ["Drama"],
        cast: [],
        directors: [],
        externalIds: { tmdb: 991002 }
      }
    });
    expect(repository.upsert({
      source: "live",
      mediaType: "movie",
      title: "Plex Retained Target",
      summary: "A neutral Plex-retained summary.",
      genres: ["Drama"],
      externalIds: { tmdb: 991002 },
      plex: {
        ratingKey: "991002",
        guid: "tmdb://991002",
        libraryTitle: "Movies",
        libraryType: "movie",
        available: true
      }
    })).toBe(mediaItemId);

    repository.markCatalogRecordsInactiveExcept("alpha catalog", "plex-retained-v2", []);

    const incrementalProjection = projection();
    expect(incrementalProjection).toMatchObject({ availability_group: "available_in_plex", plex_available: 1 });
    expect(incrementalProjection.search_text).not.toContain("ZXQRETIREDPLEXALIAS");
    expect(repository.catalogSearchCandidateIds("ZXQRETIREDPLEXALIAS", {}, 10)).toEqual([]);
    expect(
      db.prepare("SELECT COUNT(*) AS value FROM catalog_source_records WHERE media_item_id = ? AND active = 1")
        .get(mediaItemId)
    ).toEqual({ value: 0 });

    repository.rebuildCatalogSearchIndex();
    expect(projection()).toEqual(incrementalProjection);
    db.close();

    function projection() {
      const materialized = db
        .prepare(
          `SELECT title, media_type, source, availability_group, plex_available,
                  seerr_requestable, has_seerr, has_summary, search_text, mood_text
           FROM catalog_search_index
           WHERE media_item_id = ?`
        )
        .get(mediaItemId) as Record<string, unknown>;
      expect(
        db.prepare("SELECT title, search_text, mood_text FROM catalog_search_index_fts WHERE media_item_id = ?")
          .get(mediaItemId)
      ).toEqual({
        title: materialized.title,
        search_text: materialized.search_text,
        mood_text: materialized.mood_text
      });
      return materialized;
    }
  });

  it("does not restore retired catalog-only items during a full rebuild", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const mediaItemId = repository.upsertCatalogRecord({
      source: "wikidata",
      sourceVersion: "retired-v1",
      sourceItemId: "Q-retired",
      licensePolicy: "wikidata-cc0",
      media: {
        mediaType: "movie",
        title: "Retired Catalog Sentinel",
        genres: [],
        cast: [],
        directors: [],
        externalIds: {}
      }
    });

    expect(repository.catalogSearchCandidateIds("Retired Catalog Sentinel", {}, 10)).toEqual([mediaItemId]);
    repository.markCatalogRecordsInactiveExcept("wikidata", "retired-v2", []);
    expect(db.prepare("SELECT media_item_id FROM catalog_search_index WHERE media_item_id = ?").get(mediaItemId)).toBeUndefined();

    const activeMediaItemId = repository.upsertCatalogRecord({
      source: "operator catalog",
      sourceVersion: "active-v1",
      sourceItemId: "active-after-retirement",
      licensePolicy: "operator-approved",
      media: {
        mediaType: "movie",
        title: "Active Catalog Sentinel",
        genres: [],
        cast: [],
        directors: [],
        externalIds: {}
      }
    });
    const stableRebuildSentinelId = repository.upsert({
      source: "live",
      mediaType: "movie",
      title: "Stable Rebuild Sentinel",
      year: 2026,
      summary: "A complete deterministic projection used to detect a full rebuild.",
      genres: ["Drama"],
      externalIds: { tmdb: 991003 }
    });

    repository.rebuildCatalogSearchIndex();
    expect(db.prepare("SELECT media_item_id FROM catalog_search_index WHERE media_item_id = ?").get(mediaItemId)).toBeUndefined();
    expect(db.prepare("SELECT media_item_id FROM catalog_search_index_fts WHERE media_item_id = ?").get(mediaItemId)).toBeUndefined();
    expect(repository.catalogSearchCandidateIds("Retired Catalog Sentinel", {}, 10)).not.toContain(mediaItemId);
    db.exec(`
      CREATE TEMP TRIGGER reject_unnecessary_catalog_rebuild
      BEFORE DELETE ON catalog_search_index
      WHEN OLD.media_item_id = '${stableRebuildSentinelId}'
      BEGIN
        SELECT RAISE(ABORT, 'unexpected catalog rebuild');
      END;
    `);
    expect(() => new MediaRepository(db)).not.toThrow();
    expect(db.prepare("SELECT media_item_id FROM catalog_search_index WHERE media_item_id = ?").get(activeMediaItemId)).toEqual({
      media_item_id: activeMediaItemId
    });
    expect(db.prepare("SELECT media_item_id FROM catalog_search_index WHERE media_item_id = ?").get(stableRebuildSentinelId)).toEqual({
      media_item_id: stableRebuildSentinelId
    });
    db.exec("DROP TRIGGER reject_unnecessary_catalog_rebuild");
    db.close();
  });

  it("scopes a single-item projection before evaluating catalog metadata", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const targetId = repository.upsertCatalogRecord({
      source: "operator catalog",
      sourceVersion: "target-v1",
      sourceItemId: "target-item",
      licensePolicy: "operator-approved",
      metadata: { countries: ["New Zealand"], languages: ["English"] },
      media: {
        mediaType: "movie",
        title: "Scoped Projection Target",
        genres: [],
        cast: [],
        directors: [],
        externalIds: {}
      }
    });
    const timestamp = "2026-08-26T00:00:00.000Z";
    const insertMedia = db.prepare(
      "INSERT INTO media_items (id, media_type, title, normalized_title, created_at, updated_at, source) VALUES (?, 'movie', ?, ?, ?, ?, 'catalog')"
    );
    const insertSource = db.prepare(
      `INSERT INTO catalog_source_records (
        media_item_id, source, source_version, source_item_id, license_policy, metadata_json,
        fetched_at, updated_at, active, last_seen_source_version, materialization_stale
      ) VALUES (?, 'operator catalog', 'unrelated-v1', ?, 'operator-approved', ?, ?, ?, 1, 'unrelated-v1', 0)`
    );
    db.exec("BEGIN");
    for (let index = 0; index < 100; index += 1) {
      const id = `unrelated-projection:${index}`;
      const title = `Unrelated Projection ${index}`;
      insertMedia.run(id, title, title.toLowerCase(), timestamp, timestamp);
      insertSource.run(id, `unrelated-${index}`, JSON.stringify({ countries: ["Australia"], languages: ["French"] }), timestamp, timestamp);
    }
    db.exec("COMMIT");

    let normalizationCalls = 0;
    db.function("moodarr_normalize_title", { deterministic: true, directOnly: true }, (value) => {
      normalizationCalls += 1;
      return String(value ?? "").toLowerCase();
    });
    const before = db.prepare("SELECT * FROM catalog_search_index WHERE media_item_id = ?").get(targetId);
    refreshCatalogSearchProjection(db, targetId, timestamp);

    expect(normalizationCalls).toBeLessThanOrEqual(8);
    expect(db.prepare("SELECT * FROM catalog_search_index WHERE media_item_id = ?").get(targetId)).toEqual({
      ...(before as Record<string, unknown>),
      updated_at: timestamp
    });
    db.close();
  });

  it("ignores malformed and wrong-shaped catalog metadata during a full rebuild", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const mediaItemId = repository.upsertCatalogRecord({
      source: "operator catalog",
      sourceVersion: "catalog-search-malformed-v1",
      sourceItemId: "catalog-search-malformed-sentinel",
      licensePolicy: "operator-approved",
      media: {
        mediaType: "movie",
        title: "Malformed Metadata Film",
        summary: "A stable searchable summary.",
        genres: [],
        cast: [],
        directors: [],
        externalIds: {}
      }
    });

    db.prepare("UPDATE catalog_source_records SET metadata_json = ? WHERE media_item_id = ?")
      .run(JSON.stringify({ aliases: "forbidden-scalar-alias", countries: [{ nested: "forbidden-nested-country" }], unknown: ["forbidden-unknown-value"] }), mediaItemId);
    expect(() => repository.rebuildCatalogSearchIndex()).not.toThrow();
    expect(repository.catalogSearchCandidateIds("stable searchable summary", {}, 10)).toEqual([mediaItemId]);
    expect(repository.catalogSearchCandidateIds("forbidden scalar alias", {}, 10)).toEqual([]);
    expect(repository.catalogSearchCandidateIds("forbidden nested country", {}, 10)).toEqual([]);
    expect(repository.catalogSearchCandidateIds("forbidden unknown value", {}, 10)).toEqual([]);

    db.prepare("UPDATE catalog_source_records SET metadata_json = ? WHERE media_item_id = ?").run('{"aliases":', mediaItemId);
    expect(() => repository.rebuildCatalogSearchIndex()).not.toThrow();
    expect(repository.catalogSearchCandidateIds("stable searchable summary", {}, 10)).toEqual([mediaItemId]);
    db.close();
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
