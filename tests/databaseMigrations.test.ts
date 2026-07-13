import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { importWikidataCatalogRecords } from "../src/server/catalog/wikidataCatalogImporter";
import { createDatabase, runMigrations } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";

const migrationsThroughV21 = [
  "001_initial_schema",
  "002_request_audit",
  "003_media_source",
  "004_mood_feature_scores",
  "005_query_review_queue",
  "006_feel_feedback_events",
  "007_feel_profile_terms",
  "008_feel_feedback_reliability",
  "009_profile_replay_metadata",
  "010_profile_confidence_evidence",
  "011_replay_logging_holdout",
  "012_feel_profile_checkpoints",
  "013_plex_user_auth",
  "014_request_auth_attribution",
  "015_feel_feedback_client_event_id",
  "016_store_plex_user_token",
  "017_open_catalog_backbone",
  "018_catalog_update_metadata",
  "019_catalog_search_index",
  "020_content_fingerprints",
  "021_moodrank_trace_foundation"
];

describe("database upgrade migrations", () => {
  it("upgrades a populated v21 identity/profile/user fixture without losing its relationships", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    createV21Fixture(db);

    runMigrations(db);

    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(30);
    expect(db.prepare("SELECT media_item_id, media_type FROM external_ids WHERE source = 'tmdb' AND value = '42'").get()).toEqual({
      media_item_id: "movie:42",
      media_type: "movie"
    });
    expect(db.prepare("SELECT id, auth_user_id FROM preference_profiles WHERE id = 'group:shared'").get()).toEqual({
      id: "group:shared",
      auth_user_id: null
    });
    expect(db.prepare("SELECT profile_id FROM preference_feature_weights WHERE feature = 'mood:cozy'").get()).toEqual({ profile_id: "group:shared" });
    expect(db.prepare("SELECT can_request, can_use_ai FROM app_users WHERE id = 'user-1'").get()).toEqual({ can_request: 1, can_use_ai: 1 });
    expect((db.prepare("SELECT COUNT(*) AS value FROM request_creation_operations").get() as { value: number }).value).toBe(0);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plex_auth_challenges'").get()).toEqual({
      name: "plex_auth_challenges"
    });
  });

  it("upgrades a populated v25 request operation without losing its recovery state", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    createV25RequestFixture(db);

    runMigrations(db);

    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(30);
    expect(db.prepare("SELECT idempotency_key, status, response_json FROM request_creation_operations").get()).toEqual({
      idempotency_key: "operation-1",
      status: "pending",
      response_json: null
    });
    db.prepare("UPDATE request_creation_operations SET status = 'uncertain' WHERE idempotency_key = 'operation-1'").run();
    expect(db.prepare("SELECT status FROM request_creation_operations WHERE idempotency_key = 'operation-1'").get()).toEqual({ status: "uncertain" });
  });

  it("upgrades schema 29 with deterministic retrieval indexes and remains idempotent", () => {
    const db = createDatabase(":memory:");
    db.exec(`
      DROP INDEX idx_mood_feature_scores_feature_media;
      DROP INDEX idx_catalog_search_index_summary_rank;
      DROP INDEX idx_genres_normalized_name_media;
      DROP INDEX idx_seerr_items_request_status_media;
      CREATE INDEX idx_mood_feature_scores_feature
        ON media_mood_feature_scores(feature, score DESC, confidence DESC);
      DELETE FROM schema_migrations WHERE id = '030_retrieval_performance_indexes';
      PRAGMA user_version = 29;
    `);

    runMigrations(db);

    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(30);
    expect(db.prepare("SELECT id FROM schema_migrations WHERE id = '030_retrieval_performance_indexes'").get()).toEqual({
      id: "030_retrieval_performance_indexes"
    });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_mood_feature_scores_feature'").get()).toBeUndefined();
    const indexes = db
      .prepare(
        `SELECT name, sql
         FROM sqlite_master
         WHERE type = 'index' AND name IN (
          'idx_mood_feature_scores_feature_media',
          'idx_catalog_search_index_summary_rank',
          'idx_genres_normalized_name_media',
          'idx_seerr_items_request_status_media'
         )
         ORDER BY name`
      )
      .all() as Array<{ name: string; sql: string }>;
    expect(indexes.map((index) => index.name)).toEqual([
      "idx_catalog_search_index_summary_rank",
      "idx_genres_normalized_name_media",
      "idx_mood_feature_scores_feature_media",
      "idx_seerr_items_request_status_media"
    ]);
    const definitions = Object.fromEntries(indexes.map((index) => [index.name, index.sql.replace(/\s+/g, " ")]));
    expect(definitions.idx_mood_feature_scores_feature_media).toContain("(feature, media_item_id, score, confidence)");
    expect(definitions.idx_catalog_search_index_summary_rank).toContain("(rank_score DESC, title, media_item_id) WHERE has_summary = 1");
    expect(definitions.idx_genres_normalized_name_media).toContain("(lower(name), media_item_id)");
    expect(definitions.idx_seerr_items_request_status_media).toContain("(request_status, media_item_id) WHERE request_status IS NOT NULL");
    expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);

    const first = JSON.stringify(indexes);
    runMigrations(db);
    expect(
      JSON.stringify(
        db
          .prepare(
            `SELECT name, sql
             FROM sqlite_master
             WHERE type = 'index' AND name IN (
              'idx_mood_feature_scores_feature_media',
              'idx_catalog_search_index_summary_rank',
              'idx_genres_normalized_name_media',
              'idx_seerr_items_request_status_media'
             )
             ORDER BY name`
          )
          .all()
      )
    ).toBe(first);
  });

  it("sanitizes legacy Seerr-linked descriptive replicas while preserving operational and profile state", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const sentinel = "forbidden-tmdb-description-sentinel";
    const mediaItemId = repository.upsert({
      mediaType: "movie",
      title: sentinel,
      year: 2024,
      summary: sentinel,
      runtimeMinutes: 117,
      posterPath: "tmdb://w500/forbidden-sentinel.jpg",
      genres: [sentinel],
      externalIds: { tmdb: 424242, imdb: "tt424242" },
      seerr: {
        tmdbId: 424242,
        seerrMediaId: 9001,
        status: "unknown",
        requestStatus: "approved",
        requestable: false
      }
    });
    const catalogItemId = repository.upsertCatalogRecord({
      source: "wikidata",
      sourceVersion: "safe-catalog-v1",
      sourceItemId: "Q515151",
      licensePolicy: "wikidata-cc0",
      media: {
        mediaType: "movie",
        title: "Safe Catalog Harbor",
        externalIds: { wikidata: "Q515151", tmdb: 515151 }
      }
    });
    const catalogItemBefore = db.prepare("SELECT * FROM media_items WHERE id = ?").get(catalogItemId);
    const item = repository.findById(mediaItemId)!;
    repository.savePosterCache(mediaItemId, "legacy-tmdb-cache", "image/jpeg", Buffer.from(sentinel));
    repository.recordRequestAudit({
      mediaItemId,
      action: "preview",
      status: "allowed",
      mediaType: "movie",
      mediaId: 424242,
      title: sentinel
    });
    expect(repository.beginRequestCreationOperation("operation-sentinel", "fingerprint-sentinel", "admin", mediaItemId)).toBe(true);
    repository.completeRequestCreationOperation("operation-sentinel", {
      ok: true,
      request: { mediaType: "movie", mediaId: 424242, title: sentinel },
      seerr: {
        id: 73,
        status: "approved",
        media: { title: sentinel, overview: sentinel },
        requestedBy: { email: "private@example.com", plexToken: "upstream-user-token-secret" }
      },
      apiKey: "upstream-api-key-secret"
    });
    expect(repository.beginRequestCreationOperation("operation-malformed", "fingerprint-malformed", "admin", mediaItemId)).toBe(true);
    repository.completeRequestCreationOperation("operation-malformed", { ok: true });
    db.prepare("UPDATE request_creation_operations SET response_json = '{malformed' WHERE idempotency_key = 'operation-malformed'").run();
    expect(repository.beginRequestCreationOperation("operation-invalid-shape", "fingerprint-invalid-shape", "admin", mediaItemId)).toBe(true);
    repository.completeRequestCreationOperation("operation-invalid-shape", {
      ok: true,
      request: { mediaType: "person", mediaId: "not-a-number" },
      seerr: { id: 75, status: "approved" }
    });
    expect(repository.beginRequestCreationOperation("operation-safe-catalog", "fingerprint-safe-catalog", "admin", catalogItemId)).toBe(true);
    repository.completeRequestCreationOperation("operation-safe-catalog", {
      ok: true,
      request: { mediaType: "movie", mediaId: 515151, title: "Safe Catalog Harbor" },
      seerr: {
        id: 74,
        status: "approved",
        requestedBy: { email: "catalog-private@example.com", plexToken: "catalog-upstream-token-secret" }
      }
    });
    repository.recordRecommendationRun({
      query: "warm fantasy",
      engineVersion: "migration-test",
      watchContext: "solo",
      resultCount: 1,
      candidateCount: 1,
      rerankCandidateCount: 1,
      usedAi: false,
      seerrAugmented: true,
      latencyMs: 1,
      results: [{ ...item, title: sentinel, summary: sentinel, genres: [sentinel] }],
      reviewQueue: { retentionDays: 30, maxQueries: 10, captureRawQueries: false }
    });
    const embeddingInput = repository.missingProviderEmbeddingInputs("test", "test", 2, 1)[0];
    expect(embeddingInput).toBeDefined();
    repository.upsertProviderEmbeddings("test", "test", 2, [embeddingInput!], [[0.5, 0.5]]);
    repository.saveRequest(mediaItemId, "movie", 424242, undefined, "approved", "request-424242");
    db.prepare(
      "INSERT INTO preference_profiles (id, watch_context, label, created_at, updated_at) VALUES ('profile-preserved', 'solo', 'Preserved', ?, ?)"
    ).run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    db.prepare("DELETE FROM schema_migrations WHERE id = '029_strict_tmdb_content_boundary'").run();
    db.exec("PRAGMA user_version = 28");
    runMigrations(db);

    expect(db.prepare("SELECT title, year, summary, runtime_minutes, poster_path, source FROM media_items WHERE id = ?").get(mediaItemId)).toEqual({
      title: "Movie 424242",
      year: null,
      summary: null,
      runtime_minutes: null,
      poster_path: null,
      source: "operational"
    });
    for (const table of [
      "genres",
      "poster_cache",
      "media_features",
      "media_embeddings",
      "media_mood_feature_scores",
      "media_content_fingerprints",
      "media_feature_fts",
      "catalog_search_index",
      "catalog_search_index_fts"
    ]) {
      expect((db.prepare(`SELECT COUNT(*) AS value FROM ${table} WHERE media_item_id = ?`).get(mediaItemId) as { value: number }).value, table).toBe(0);
    }
    expect(db.prepare("SELECT title FROM request_audit WHERE media_item_id = ?").get(mediaItemId)).toEqual({ title: null });
    expect(db.prepare("SELECT result_count, results_json FROM query_review_queue").get()).toEqual({ result_count: 0, results_json: "[]" });
    expect(db.prepare("SELECT status, response_json FROM request_creation_operations WHERE idempotency_key = 'operation-sentinel'").get()).toEqual({
      status: "created",
      response_json: JSON.stringify({ ok: true, request: { mediaType: "movie", mediaId: 424242 }, seerr: { id: 73, status: "approved" } })
    });
    const migratedOperation = new MediaRepository(db).requestCreationOperation("operation-sentinel");
    expect(migratedOperation).toMatchObject({
      status: "created",
      response: { ok: true, request: { mediaType: "movie", mediaId: 424242 }, seerr: { id: 73, status: "approved" } }
    });
    expect(JSON.stringify(migratedOperation?.response)).not.toContain(sentinel);
    expect(JSON.stringify(migratedOperation?.response)).not.toContain("private@example.com");
    expect(JSON.stringify(migratedOperation?.response)).not.toContain("secret");
    expect(db.prepare("SELECT status, response_json FROM request_creation_operations WHERE idempotency_key = 'operation-malformed'").get()).toEqual({
      status: "created",
      response_json: null
    });
    expect(db.prepare("SELECT status, response_json FROM request_creation_operations WHERE idempotency_key = 'operation-invalid-shape'").get()).toEqual({
      status: "created",
      response_json: null
    });
    expect(db.prepare("SELECT * FROM media_items WHERE id = ?").get(catalogItemId)).toEqual(catalogItemBefore);
    expect(new MediaRepository(db).requestCreationOperation("operation-safe-catalog")).toMatchObject({
      status: "created",
      response: { ok: true, request: { mediaType: "movie", mediaId: 515151 }, seerr: { id: 74, status: "approved" } }
    });
    const safeCatalogResponse = (db.prepare("SELECT response_json FROM request_creation_operations WHERE idempotency_key = 'operation-safe-catalog'").get() as { response_json: string }).response_json;
    expect(safeCatalogResponse).not.toContain("Safe Catalog Harbor");
    expect(safeCatalogResponse).not.toContain("catalog-private@example.com");
    expect(safeCatalogResponse).not.toContain("secret");
    expect(db.prepare("SELECT tmdb_id, seerr_media_id, request_status FROM seerr_items WHERE media_item_id = ?").get(mediaItemId)).toEqual({
      tmdb_id: 424242,
      seerr_media_id: 9001,
      request_status: "approved"
    });
    expect(db.prepare("SELECT value FROM external_ids WHERE media_item_id = ? AND source = 'tmdb'").get(mediaItemId)).toEqual({ value: "424242" });
    expect((db.prepare("SELECT COUNT(*) AS value FROM requests WHERE media_item_id = ?").get(mediaItemId) as { value: number }).value).toBe(1);
    expect(db.prepare("SELECT label FROM preference_profiles WHERE id = 'profile-preserved'").get()).toEqual({ label: "Preserved" });
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(30);

    const snapshot = JSON.stringify(db.prepare("SELECT * FROM media_items WHERE id = ?").get(mediaItemId));
    runMigrations(db);
    expect(JSON.stringify(db.prepare("SELECT * FROM media_items WHERE id = ?").get(mediaItemId))).toBe(snapshot);
  });

  it("fails closed for ambiguous trusted overlaps and restores discovery only from trusted refreshes", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const catalogRecord = {
      id: "Q999029",
      mediaType: "film",
      label: "Trusted Catalog Lantern",
      description: "A trusted catalog fantasy comedy about a lantern festival.",
      publicationDate: "2025-02-14",
      genreLabels: ["Fantasy", "Comedy"],
      tmdbMovieId: 429029,
      sitelinkCount: 80,
      hasEnglishWikipedia: true
    };
    const preservedCatalogRecord = {
      id: "Q999030",
      mediaType: "film",
      label: "Catalog Authored Harbor",
      description: "A catalog-authored gentle harbor mystery.",
      publicationDate: "2024-04-12",
      genreLabels: ["Mystery"],
      tmdbMovieId: 429030,
      sitelinkCount: 70,
      hasEnglishWikipedia: true
    };
    importWikidataCatalogRecords(repository, [catalogRecord, preservedCatalogRecord], { sourceVersion: "trusted-catalog-v1" });

    const catalogItemId = repository.findByExternalId("wikidata", "Q999029")!.id;
    const preservedCatalogItemId = repository.findByExternalId("wikidata", "Q999030")!.id;
    for (const source of ["deterministic", "moodarr-wikidata-rules", "arbitrary-import"] as const) {
      repository.upsertMoodFeatureScores(catalogItemId, source, "legacy-v1", [{ feature: `mood:${source}`, score: 75, confidence: 0.9 }]);
    }
    expect(
      db
        .prepare(
          "SELECT source FROM media_mood_feature_scores WHERE media_item_id = ? AND source IN ('deterministic', 'moodarr wikidata rules', 'arbitrary import') ORDER BY source"
        )
        .all(catalogItemId)
    ).toEqual([{ source: "arbitrary import" }, { source: "deterministic" }, { source: "moodarr wikidata rules" }]);
    const catalogProvenanceBefore = db
      .prepare("SELECT payload_hash, content_hash, content_version FROM catalog_source_records WHERE media_item_id = ?")
      .get(catalogItemId);
    const catalogMetadataBefore = db.prepare("SELECT metadata_json FROM catalog_source_records WHERE media_item_id = ?").get(catalogItemId);
    const catalogRankBefore = db.prepare("SELECT * FROM catalog_rank_signals WHERE media_item_id = ?").get(catalogItemId);
    const forbiddenCatalogText = "forbidden-seerr-catalog-description-sentinel";
    repository.upsert({
      source: "live",
      mediaType: "movie",
      title: "Forbidden Seerr Catalog Title",
      year: 1988,
      summary: forbiddenCatalogText,
      runtimeMinutes: 222,
      posterPath: "tmdb://w500/forbidden-catalog.jpg",
      genres: [forbiddenCatalogText],
      externalIds: { wikidata: "Q999029", tmdb: 429029 },
      seerr: { tmdbId: 429029, status: "unknown", requestable: true }
    });

    const plexRecord = {
      source: "live" as const,
      mediaType: "movie" as const,
      title: "Trusted Plex Harbor",
      year: 2023,
      summary: "A locally supplied Plex adventure.",
      runtimeMinutes: 101,
      genres: ["Adventure"],
      externalIds: { tmdb: 429031, plex: "plex://movie/trusted-refresh" },
      plex: {
        ratingKey: "trusted-refresh-rating",
        guid: "plex://movie/trusted-refresh",
        libraryTitle: "Trusted Local Library",
        libraryType: "movie",
        available: true
      }
    };
    const plexItemId = repository.upsert(plexRecord);
    const forbiddenPlexText = "forbidden-seerr-plex-description-sentinel";
    repository.upsert({
      source: "live",
      mediaType: "movie",
      title: "Forbidden Seerr Plex Title",
      year: 1989,
      summary: forbiddenPlexText,
      runtimeMinutes: 223,
      posterPath: "tmdb://w500/forbidden-plex.jpg",
      genres: [forbiddenPlexText],
      externalIds: { tmdb: 429031, plex: "plex://movie/trusted-refresh" },
      seerr: { tmdbId: 429031, status: "unknown", requestable: true }
    });

    const seerrOnlyItemId = repository.upsert({
      source: "live",
      mediaType: "movie",
      title: "Forbidden Seerr Only Title",
      summary: "forbidden-seerr-only-description-sentinel",
      genres: ["forbidden-seerr-only-genre-sentinel"],
      externalIds: { tmdb: 429032 },
      seerr: { tmdbId: 429032, status: "unknown", requestable: true }
    });

    repository.upsert({
      source: "operational",
      mediaType: "movie",
      title: "Movie 429030",
      externalIds: { wikidata: "Q999030", tmdb: 429030 },
      seerr: { tmdbId: 429030, status: "unknown", requestable: true }
    });
    const preservedCatalogBefore = db.prepare("SELECT * FROM media_items WHERE id = ?").get(preservedCatalogItemId);
    const preservedCatalogFeatureBefore = db.prepare("SELECT * FROM media_features WHERE media_item_id = ?").get(preservedCatalogItemId);
    const preservedCatalogHashBefore = db
      .prepare("SELECT payload_hash, content_hash, content_version, materialization_stale FROM catalog_source_records WHERE media_item_id = ?")
      .get(preservedCatalogItemId);

    db.prepare("DELETE FROM schema_migrations WHERE id = '029_strict_tmdb_content_boundary'").run();
    db.exec("PRAGMA user_version = 28");
    runMigrations(db);

    for (const [mediaItemId, tmdbId] of [
      [catalogItemId, 429029],
      [plexItemId, 429031],
      [seerrOnlyItemId, 429032]
    ] as const) {
      expect(db.prepare("SELECT title, normalized_title, year, summary, runtime_minutes, poster_path, source FROM media_items WHERE id = ?").get(mediaItemId)).toEqual({
        title: `Movie ${tmdbId}`,
        normalized_title: `movie ${tmdbId}`,
        year: null,
        summary: null,
        runtime_minutes: null,
        poster_path: null,
        source: "operational"
      });
      for (const table of [
        "genres",
        "media_features",
        "media_embeddings",
        "media_mood_feature_scores",
        "media_content_fingerprints",
        "media_feature_fts",
        "catalog_search_index",
        "catalog_search_index_fts"
      ]) {
        expect((db.prepare(`SELECT COUNT(*) AS value FROM ${table} WHERE media_item_id = ?`).get(mediaItemId) as { value: number }).value, `${table}:${mediaItemId}`).toBe(0);
      }
    }

    expect(db.prepare("SELECT * FROM media_items WHERE id = ?").get(preservedCatalogItemId)).toEqual(preservedCatalogBefore);
    expect(db.prepare("SELECT * FROM media_features WHERE media_item_id = ?").get(preservedCatalogItemId)).toEqual(preservedCatalogFeatureBefore);
    expect(db.prepare("SELECT payload_hash, content_hash, content_version, materialization_stale FROM catalog_source_records WHERE media_item_id = ?").get(preservedCatalogItemId)).toEqual(
      preservedCatalogHashBefore
    );
    expect(db.prepare("SELECT payload_hash, content_hash, content_version, materialization_stale, source_version, source_item_id, license_policy, metadata_json FROM catalog_source_records WHERE media_item_id = ?").get(catalogItemId)).toMatchObject({
      ...(catalogProvenanceBefore as Record<string, unknown>),
      materialization_stale: 1,
      source_version: "trusted-catalog-v1",
      source_item_id: "Q999029",
      license_policy: "wikidata-cc0"
    });
    expect(db.prepare("SELECT metadata_json FROM catalog_source_records WHERE media_item_id = ?").get(catalogItemId)).toEqual(catalogMetadataBefore);
    expect(db.prepare("SELECT * FROM catalog_rank_signals WHERE media_item_id = ?").get(catalogItemId)).toEqual(catalogRankBefore);
    expect((db.prepare("SELECT COUNT(*) AS value FROM plex_items WHERE media_item_id = ? AND available = 1").get(plexItemId) as { value: number }).value).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS value FROM seerr_items WHERE media_item_id IN (?, ?, ?) AND requestable = 1").get(catalogItemId, plexItemId, seerrOnlyItemId) as { value: number }).value).toBe(3);

    const afterMigration = new MediaRepository(db);
    expect(afterMigration.catalogSourceItemIdsRequiringRefresh("wikidata")).toEqual(new Set(["Q999029"]));
    db.prepare(
      `INSERT INTO catalog_source_records (
        media_item_id, source, source_version, source_item_id, source_url, license_policy,
        payload_hash, content_hash, content_version, metadata_json, fetched_at, expires_at,
        active, last_seen_source_version, materialization_stale, deleted_at, updated_at
      )
      SELECT media_item_id, source, source_version, 'Q9990291', source_url, license_policy,
        payload_hash, content_hash, content_version, metadata_json, fetched_at, expires_at,
        active, last_seen_source_version, materialization_stale, deleted_at, updated_at
      FROM catalog_source_records WHERE media_item_id = ? AND source_item_id = 'Q999029'`
    ).run(catalogItemId);
    expect(afterMigration.catalogRefreshRequirement("wikidata")).toEqual({
      sourceItemIds: new Set(["Q999029", "Q9990291"]),
      mediaItemCount: 1
    });
    db.prepare("DELETE FROM catalog_source_records WHERE source = 'wikidata' AND source_item_id = 'Q9990291'").run();
    db.prepare("UPDATE media_items SET source = 'operational' WHERE id = ?").run(preservedCatalogItemId);
    expect(afterMigration.catalogSourceItemIdsRequiringRefresh("wikidata")).toEqual(new Set(["Q999029", "Q999030"]));
    importWikidataCatalogRecords(afterMigration, [preservedCatalogRecord], { sourceVersion: "trusted-catalog-v1" });
    expect(db.prepare("SELECT source FROM media_items WHERE id = ?").get(preservedCatalogItemId)).toEqual({ source: "catalog" });
    expect(db.prepare("SELECT payload_hash, content_hash, content_version, materialization_stale FROM catalog_source_records WHERE media_item_id = ?").get(preservedCatalogItemId)).toEqual(
      preservedCatalogHashBefore
    );
    expect(afterMigration.catalogSourceItemIdsRequiringRefresh("wikidata")).toEqual(new Set(["Q999029"]));
    expect(afterMigration.catalogDiagnostics()).toMatchObject({
      trustedRefreshRequiredItems: 2,
      requestableTrustedRefreshRequiredItems: 2,
      catalogRefreshRequiredItems: 1,
      plexRefreshRequiredItems: 1,
      operationalOnlyItems: 1,
      requestableOperationalOnlyItems: 1
    });
    expect(afterMigration.catalogSearchCandidateIds("trusted catalog fantasy comedy", { availability: ["not_in_plex_requestable"] }, 10)).not.toContain(catalogItemId);

    afterMigration.upsert(plexRecord);
    expect(afterMigration.catalogDiagnostics()).toMatchObject({
      trustedRefreshRequiredItems: 1,
      requestableTrustedRefreshRequiredItems: 1,
      catalogRefreshRequiredItems: 1,
      plexRefreshRequiredItems: 0,
      operationalOnlyItems: 1,
      requestableOperationalOnlyItems: 1
    });
    importWikidataCatalogRecords(afterMigration, [catalogRecord], { sourceVersion: "trusted-catalog-v1" });

    expect(afterMigration.findById(catalogItemId)).toMatchObject({
      title: "Trusted Catalog Lantern",
      summary: "A trusted catalog fantasy comedy about a lantern festival.",
      genres: expect.arrayContaining(["Fantasy", "Comedy"]),
      availabilityGroup: "not_in_plex_requestable",
      metadata: { source: "catalog" }
    });
    expect(afterMigration.findById(plexItemId)).toMatchObject({
      title: "Trusted Plex Harbor",
      summary: "A locally supplied Plex adventure.",
      genres: ["Adventure"],
      metadata: { source: "live" }
    });
    expect(afterMigration.findById(seerrOnlyItemId)).toMatchObject({ title: "Movie 429032", metadata: { source: "operational" } });
    expect(afterMigration.catalogSearchCandidateIds("trusted catalog fantasy comedy", { availability: ["not_in_plex_requestable"] }, 10)).toContain(catalogItemId);
    expect(afterMigration.catalogDiagnostics()).toMatchObject({
      trustedRefreshRequiredItems: 0,
      requestableTrustedRefreshRequiredItems: 0,
      catalogRefreshRequiredItems: 0,
      plexRefreshRequiredItems: 0,
      operationalOnlyItems: 1,
      requestableOperationalOnlyItems: 1
    });
    expect(db.prepare("SELECT payload_hash, content_hash, content_version, materialization_stale FROM catalog_source_records WHERE media_item_id = ?").get(catalogItemId)).toEqual({
      ...(catalogProvenanceBefore as Record<string, unknown>),
      materialization_stale: 0
    });

    const restartedRepository = new MediaRepository(db);
    expect(restartedRepository.catalogSearchCandidateIds("trusted catalog fantasy comedy", { availability: ["not_in_plex_requestable"] }, 10)).toContain(catalogItemId);
    expect(restartedRepository.catalogDiagnostics().trustedRefreshRequiredItems).toBe(0);

    const recoveredProvenance = db
      .prepare("SELECT payload_hash, content_hash, content_version FROM catalog_source_records WHERE media_item_id = ?")
      .get(catalogItemId) as { payload_hash: string; content_hash: string; content_version: number };
    db.prepare("UPDATE catalog_source_records SET materialization_stale = 1 WHERE media_item_id = ?").run(catalogItemId);
    importWikidataCatalogRecords(
      restartedRepository,
      [{ ...catalogRecord, description: "A materially changed trusted catalog description." }],
      { sourceVersion: "trusted-catalog-v2" }
    );
    const changedProvenance = db
      .prepare("SELECT payload_hash, content_hash, content_version, materialization_stale FROM catalog_source_records WHERE media_item_id = ?")
      .get(catalogItemId) as { payload_hash: string; content_hash: string; content_version: number; materialization_stale: number };
    expect(changedProvenance).toMatchObject({
      content_version: recoveredProvenance.content_version + 1,
      materialization_stale: 0
    });
    expect(changedProvenance.payload_hash).not.toBe(recoveredProvenance.payload_hash);
    expect(changedProvenance.content_hash).not.toBe(recoveredProvenance.content_hash);
  });
});

function createV25RequestFixture(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE media_items (id TEXT PRIMARY KEY, media_type TEXT NOT NULL);
    CREATE TABLE catalog_source_records (media_item_id TEXT NOT NULL, source TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE plex_items (media_item_id TEXT NOT NULL, available INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE seerr_items (media_item_id TEXT NOT NULL, request_status TEXT, requestable INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE genres (media_item_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (media_item_id, name));
    CREATE TABLE media_mood_feature_scores (
      media_item_id TEXT NOT NULL,
      source TEXT NOT NULL,
      source_version TEXT NOT NULL,
      feature TEXT NOT NULL,
      score REAL NOT NULL,
      confidence REAL NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (media_item_id, source, feature)
    );
    CREATE TABLE catalog_search_index (
      media_item_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      rank_score REAL NOT NULL,
      has_summary INTEGER NOT NULL
    );
    CREATE TABLE poster_cache (
      media_item_id TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
      content_type TEXT NOT NULL,
      body BLOB NOT NULL,
      fetched_at TEXT NOT NULL
    );
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
    INSERT INTO media_items (id, media_type) VALUES ('movie:42', 'movie');
    INSERT INTO request_creation_operations (
      idempotency_key, request_fingerprint, auth_scope, media_item_id, status,
      response_json, error, created_at, updated_at
    ) VALUES (
      'operation-1', 'fingerprint-1', 'admin', 'movie:42', 'pending',
      NULL, NULL, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
    );
    PRAGMA user_version = 25;
  `);
  const insert = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, '2026-01-01T00:00:00.000Z')");
  for (const id of [...migrationsThroughV21, "022_media_type_aware_external_ids", "023_user_scoped_feel_profiles", "024_request_creation_idempotency", "025_user_capabilities"]) {
    insert.run(id);
  }
}

function createV21Fixture(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE schema_migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL);
    CREATE TABLE media_items (id TEXT PRIMARY KEY, media_type TEXT NOT NULL);
    CREATE TABLE catalog_source_records (media_item_id TEXT NOT NULL, source TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE plex_items (media_item_id TEXT NOT NULL, available INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE seerr_items (media_item_id TEXT NOT NULL, request_status TEXT, requestable INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE genres (media_item_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (media_item_id, name));
    CREATE TABLE media_mood_feature_scores (
      media_item_id TEXT NOT NULL,
      source TEXT NOT NULL,
      source_version TEXT NOT NULL,
      feature TEXT NOT NULL,
      score REAL NOT NULL,
      confidence REAL NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (media_item_id, source, feature)
    );
    CREATE TABLE catalog_search_index (
      media_item_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      rank_score REAL NOT NULL,
      has_summary INTEGER NOT NULL
    );
    CREATE TABLE poster_cache (
      media_item_id TEXT PRIMARY KEY REFERENCES media_items(id) ON DELETE CASCADE,
      content_type TEXT NOT NULL,
      body BLOB NOT NULL,
      fetched_at TEXT NOT NULL
    );
    CREATE TABLE external_ids (
      media_item_id TEXT NOT NULL REFERENCES media_items(id) ON DELETE CASCADE,
      source TEXT NOT NULL,
      value TEXT NOT NULL,
      PRIMARY KEY (source, value)
    );
    CREATE TABLE app_users (id TEXT PRIMARY KEY);
    CREATE TABLE preference_profiles (
      id TEXT PRIMARY KEY,
      watch_context TEXT NOT NULL,
      label TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE recommendation_sessions (
      id TEXT PRIMARY KEY,
      profile_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE feel_feedback_events (
      id INTEGER PRIMARY KEY,
      source TEXT NOT NULL,
      client_event_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX idx_feel_feedback_events_client_event
      ON feel_feedback_events(source, client_event_id)
      WHERE client_event_id IS NOT NULL;
    CREATE TABLE preference_feature_weights (
      profile_id TEXT NOT NULL REFERENCES preference_profiles(id) ON DELETE CASCADE,
      feature TEXT NOT NULL,
      weight REAL NOT NULL,
      PRIMARY KEY (profile_id, feature)
    );
    CREATE TABLE feel_profile_terms (
      profile_id TEXT NOT NULL REFERENCES preference_profiles(id) ON DELETE CASCADE,
      term TEXT NOT NULL,
      PRIMARY KEY (profile_id, term)
    );
    CREATE TABLE feel_profile_checkpoints (
      profile_id TEXT NOT NULL REFERENCES preference_profiles(id) ON DELETE CASCADE,
      term TEXT NOT NULL,
      version INTEGER NOT NULL,
      PRIMARY KEY (profile_id, term, version)
    );
    INSERT INTO media_items (id, media_type) VALUES ('movie:42', 'movie');
    INSERT INTO external_ids (media_item_id, source, value) VALUES ('movie:42', 'tmdb', '42');
    INSERT INTO app_users (id) VALUES ('user-1');
    INSERT INTO preference_profiles (id, watch_context, label, created_at, updated_at)
      VALUES ('group:default', 'group', 'Together', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    INSERT INTO preference_feature_weights (profile_id, feature, weight) VALUES ('group:default', 'mood:cozy', 0.5);
    INSERT INTO recommendation_sessions (id, profile_id, created_at)
      VALUES ('session-1', 'group:default', '2026-01-01T00:00:00.000Z');
    PRAGMA user_version = 21;
  `);
  const insert = db.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, '2026-01-01T00:00:00.000Z')");
  for (const id of migrationsThroughV21) insert.run(id);
}
