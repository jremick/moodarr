import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { fixturePlexItems, fixtureSeerrItems } from "../src/server/fixtures/media";
import { parseRecommendationIntent } from "../src/server/recommendation/intent";
import { scoreLibraryCandidates, seerrSearchQueries, selectRerankCandidates } from "../src/server/recommendation/scoring";
import { RecommendationEngine, selectCatalogVerificationCandidates } from "../src/server/recommendation/engine";
import { buildRecommendationBrief } from "../src/server/recommendation/brief";
import { scoreMoodRankV3RetrievedCandidates, scoreRankIndexedLibrary } from "../src/server/recommendation/rankIndex";
import { evaluateRankIndexCoverageCases } from "../src/server/recommendation/rankIndexEvaluation";
import { retrieveRecommendationCandidates } from "../src/server/recommendation/retrieval";
import { buildFeelProfileAdjustment, syntheticFeelProfiles } from "../src/server/recommendation/feelProfile";
import { evaluateSyntheticFeelJourneys } from "../src/server/recommendation/profileJourneyEvaluation";
import { syntheticAdversarialEvalCatalog, syntheticProfileEvalCatalog } from "../src/server/recommendation/profileEvalFixtures";
import type { AiRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import {
  adversarialRecommendationCases,
  evaluateAdversarialRecommendationResults,
  evaluateProfileRecommendationResults,
  evaluateRecommendationResults,
  goldenRecommendationCases,
  profileRecommendationCases
} from "../src/server/recommendation/evaluation";
import { buildConversationQuery, deriveChatCriteria, maxSearchQueryLength } from "../src/client/chatCriteria";
import type { EmbeddingProvider } from "../src/server/ai/embeddings";
import { OpenAiBriefParser } from "../src/server/ai/briefParser";
import type { BriefParser } from "../src/server/ai/briefParser";
import type { QueryOptimizer } from "../src/server/ai/queryOptimizer";
import type { TasteScout } from "../src/server/ai/tasteScout";
import type { AppConfig } from "../src/server/config";
import { importWikidataCatalogRecords, toCatalogIngestRecord } from "../src/server/catalog/wikidataCatalogImporter";
import { buildCatalogMoodEnrichment } from "../src/server/recommendation/catalogMoodEnrichment";
import { importMoodSeedRecords } from "../src/server/recommendation/moodSeedImporter";
import { warmProviderEmbeddings } from "../src/server/recommendation/embeddingWarmup";
import {
  mapMovieLensTag,
  parseCsvLine,
  parseMovieLensTitle,
  summarizeMovieLensTagGenomeFiles
} from "../src/server/recommendation/movieLensTagGenome";
import type { ItemSummary } from "../src/shared/types";

afterEach(() => {
  vi.unstubAllGlobals();
});

function repositoryWithFixtures(records = [...fixturePlexItems, ...fixtureSeerrItems]) {
  const db = createDatabase(":memory:");
  const repository = new MediaRepository(db);
  repository.upsertMany(records);
  return { db, repository };
}

function requireTitle<T extends { title: string }>(items: T[], title: string) {
  const item = items.find((candidate) => candidate.title === title);
  expect(item).toBeDefined();
  return item as T;
}

function sentenceCount(value: string) {
  return value.match(/[^.!?]+[.!?]+/g)?.length ?? 0;
}

function recommendationTestConfig(): AppConfig {
  return {
    fixtureMode: true,
    dataDir: ".data-test",
    configPath: ".data-test/config.json",
    dbPath: ":memory:",
    apiPort: 0,
    apiHost: "127.0.0.1",
    webOrigin: "http://127.0.0.1:5173",
    serveClient: false,
    requireAdminToken: false,
    adminAutoSession: false,
    plexAuth: {
      enabled: false,
      allowNewUsers: true,
      clientIdentifier: "moodarr-test",
      productName: "Moodarr Test"
    },
    plex: { webBaseUrl: "https://app.plex.tv/desktop" },
    seerr: {},
    ai: {
      provider: "openai",
      openaiApiKey: "test-openai-key-secret",
      openaiModel: "gpt-5.5",
      openaiEmbeddingModel: "text-embedding-3-large",
      openaiReasoningEffort: "low"
    },
    sync: { intervalMinutes: 0, syncSeerr: true },
    search: { defaultResultLimit: 50 },
    reviewQueue: { retentionDays: 90, maxQueries: 500 },
    knownSecrets: ["test-openai-key-secret"]
  };
}

function itemSummaryFixture(index: number): ItemSummary {
  return {
    id: `item-${index}`,
    mediaType: "movie",
    title: `Item ${index}`,
    genres: ["Comedy"],
    ratings: {},
    posterUrl: "",
    availabilityGroup: "available_in_plex",
    availabilityExplanation: "Available.",
    matchExplanation: "A plausible match.",
    score: 100 - index
  };
}

describe("recommendation intent", () => {
  it("separates hard filters from soft taste signals", () => {
    const intent = parseRecommendationIntent("funny fantasy movie under two hours");

    expect(intent.hardFilters).toMatchObject({ mediaTypes: ["movie"], maxRuntimeMinutes: 120 });
    expect(intent.softGenres).toEqual(expect.arrayContaining(["Comedy", "Fantasy"]));
    expect(intent.moods).toContain("funny");
  });

  it("extracts reference titles and requestability intent", () => {
    expect(parseRecommendationIntent("something like Stardust").referenceTitle).toBe("Stardust");
    expect(parseRecommendationIntent("More like Stardust. Less like The Do-Over.").referenceTitle).toBe("Stardust");
    expect(parseRecommendationIntent("if we don't have it, show requestable options").wantsRequestOptions).toBe(true);
  });

  it("treats negated animation as an exclusion, not a positive genre signal", () => {
    const intent = parseRecommendationIntent("funny fantasy movies that are not animated");

    expect(intent.hardFilters.excludedGenres).toEqual(["Animation"]);
    expect(intent.softGenres).not.toContain("Animation");
    expect(intent.terms).not.toContain("animated");
  });

  it("parses broader negated genres without negating unrelated positive terms", () => {
    const notComedy = parseRecommendationIntent("light movie but not comedy, just emotionally easy");
    const lessHorror = parseRecommendationIntent("dark like Midnight Chainsaw Club but less horror and more grounded");
    const romantic = parseRecommendationIntent("romantic but not cheesy or sentimental");

    expect(notComedy.hardFilters.excludedGenres).toEqual(["Comedy"]);
    expect(lessHorror.hardFilters.excludedGenres).toEqual(["Horror"]);
    expect(romantic.softGenres).toContain("Romance");
    expect(romantic.hardFilters.excludedGenres ?? []).not.toContain("Romance");
  });

  it("lets a later non-animated refinement override an earlier animation request for Seerr lookup", () => {
    const intent = parseRecommendationIntent("animated fantasy movie\nFollow-up refinement: not animated");

    expect(intent.hardFilters.excludedGenres).toEqual(["Animation"]);
    expect(seerrSearchQueries(intent).join(" ").toLowerCase()).not.toContain("animated");
  });
});

describe("chat criteria", () => {
  it("keeps chat genre words as soft recommendation signals", () => {
    const criteria = deriveChatCriteria("fantasy movie under two hours", { availability: ["available_in_plex"] }, 20, "solo");

    expect(criteria.filters).toMatchObject({ mediaTypes: ["movie"], maxRuntimeMinutes: 120, availability: ["available_in_plex"] });
    expect(criteria.filters.genres).toBeUndefined();
  });

  it("accepts natural-language runtime ranges outside the dropdown presets", () => {
    const criteria = deriveChatCriteria("movie between 95 and 110 minutes", { availability: ["available_in_plex"] }, 20, "solo");

    expect(criteria.filters).toMatchObject({
      mediaTypes: ["movie"],
      minRuntimeMinutes: 95,
      maxRuntimeMinutes: 110,
      availability: ["available_in_plex"]
    });
  });

  it("preserves explicit dropdown genre filters until the user clears style", () => {
    const withDropdownGenre = deriveChatCriteria("funny movie under two hours", { genres: ["Fantasy"], availability: ["available_in_plex"] }, 20, "solo");
    const cleared = deriveChatCriteria("any style funny movie", { genres: ["Fantasy"], availability: ["available_in_plex"] }, 20, "solo");

    expect(withDropdownGenre.filters.genres).toEqual(["Fantasy"]);
    expect(cleared.filters.genres).toBeUndefined();
  });

  it("captures non-animated as a hard exclusion in chat refinements", () => {
    const criteria = deriveChatCriteria("not animated", { mediaTypes: ["movie"] }, 20, "solo");

    expect(criteria.filters).toMatchObject({ mediaTypes: ["movie"], excludedGenres: ["Animation"] });
  });

  it("carries the original watch mood into conversational refinements", () => {
    const query = buildConversationQuery("not animated", "funny fantasy movies under two hours");

    expect(query).toBe("funny fantasy movies under two hours\nFollow-up refinement: not animated");
  });

  it("keeps conversational refinements within the search query limit", () => {
    const query = buildConversationQuery("not animated", "funny fantasy ".repeat(200));

    expect(query).toHaveLength(maxSearchQueryLength);
    expect(query).toContain("Follow-up refinement: not animated");
  });

  it("trims overlong single prompts to the search query limit", () => {
    const query = buildConversationQuery("x".repeat(maxSearchQueryLength + 1), "");

    expect(query).toHaveLength(maxSearchQueryLength);
  });

  it("accepts three-digit result counts up to the search cap", () => {
    const criteria = deriveChatCriteria("show 200 funny movies", {}, 20, "solo");
    const clamped = deriveChatCriteria("show 250 funny movies", {}, 20, "solo");

    expect(criteria.resultLimit).toBe(200);
    expect(clamped.resultLimit).toBe(200);
  });
});

describe("recommendation scoring", () => {
  it("creates feature rows and FTS entries without private URLs or fixture poster paths", () => {
    const { db, repository } = repositoryWithFixtures();

    const featureRows = db.prepare("SELECT * FROM media_features").all() as Array<{
      feature_text: string;
      mood_terms_json: string;
      tone_terms_json: string;
      watchability_terms_json: string;
      vector_json: string;
      feature_version: string;
    }>;
    expect(featureRows.length).toBe(repository.list().length);
    expect(featureRows.every((row) => Object.keys(JSON.parse(row.vector_json)).length > 0)).toBe(true);
    expect(featureRows.some((row) => JSON.parse(row.mood_terms_json).length > 0)).toBe(true);
    expect(featureRows.some((row) => JSON.parse(row.watchability_terms_json).length > 0)).toBe(true);
    expect(featureRows.every((row) => row.feature_version.startsWith("moodrank-v0.4"))).toBe(true);
    const moodScoreCount = (db.prepare("SELECT COUNT(*) AS value FROM media_mood_feature_scores").get() as { value: number }).value;
    expect(moodScoreCount).toBeGreaterThan(0);
    const indexedMoodHits = repository.searchMoodFeatureScores(["mood:feel-good", "mood:funny"], 10);
    expect(indexedMoodHits.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(featureRows);
    expect(serialized).not.toContain("https://app.plex.tv");
    expect(serialized).not.toContain("http://fixture-seerr.local");
    expect(serialized).not.toContain("fixture://");

    const ftsHits = repository.searchFeatureIds("witty fantasy romance", 10);
    const hitTitles = ftsHits.map((hit) => repository.findById(hit.mediaItemId)?.title);
    expect(hitTitles).toEqual(expect.arrayContaining(["Stardust", "The Princess Bride"]));
  });

  it("imports external mood seed scores by title/year without affecting catalog truth", () => {
    const { repository } = repositoryWithFixtures();
    const summary = importMoodSeedRecords(
      repository,
      [
        {
          title: "Hunt for the Wilderpeople",
          year: 2016,
          mediaType: "movie",
          features: {
            "mood:feel-good": 0.98,
            "tone:offbeat": 0.92
          }
        },
        {
          title: "Missing Seed",
          year: 2024,
          mediaType: "movie",
          features: { "mood:cozy": 0.9 }
        }
      ],
      { source: "fixture-seed", sourceVersion: "v1" }
    );
    const hits = repository.searchMoodFeatureScores(["mood:feel-good", "tone:offbeat"], 5);
    const titles = hits.map((hit) => repository.findById(hit.mediaItemId)?.title);

    expect(summary).toMatchObject({ records: 2, matched: 1, unmatched: 1, scoresImported: 2 });
    expect(titles).toContain("Hunt for the Wilderpeople");
    expect(repository.findByTitleYear("Hunt for the Wilderpeople", 2016, "movie")?.summary).toContain("New Zealand bush");
  });

  it("caps duplicate mood feature matches across enrichment sources", () => {
    const { repository } = repositoryWithFixtures([]);
    repository.upsertMany([
      {
        mediaType: "movie",
        title: "Quiet Test",
        year: 2026,
        summary: "Plain metadata fixture.",
        genres: ["Drama"]
      }
    ]);
    const item = repository.findByTitleYear("Quiet Test", 2026, "movie");
    expect(item).toBeDefined();

    repository.upsertMoodFeatureScores(item!.id, "fixture-a", "v1", [{ feature: "mood:cozy", score: 25, confidence: 1 }]);
    repository.upsertMoodFeatureScores(item!.id, "fixture-b", "v1", [{ feature: "mood:cozy", score: 25, confidence: 1 }]);
    const [hit] = repository.searchMoodFeatureScores(["mood:cozy"], 5);

    expect(hit).toMatchObject({ mediaItemId: item!.id, score: 70, matchedFeatures: ["mood:cozy"] });
  });

  it("derives catalog mood enrichment scores from Wikidata-style metadata", () => {
    const enrichment = buildCatalogMoodEnrichment({
      id: "catalog-test",
      mediaType: "movie",
      title: "Open Harbor",
      summary: "A heartwarming fantasy adventure about friendship, gentle magic, and a quiet seaside town.",
      genres: ["Fantasy", "Adventure"],
      cast: [],
      directors: []
    });
    const features = enrichment.scores.map((score) => score.feature);

    expect(features).toEqual(expect.arrayContaining(["mood:adventurous", "mood:feel-good", "mood:magical", "mood:warm", "tone:whimsical"]));
    expect(enrichment.featureCount).toBeGreaterThanOrEqual(5);
    expect(enrichment.nonGenreFeatureCount).toBeGreaterThan(0);

    const directorNameOnly = buildCatalogMoodEnrichment({
      id: "catalog-director-name-test",
      mediaType: "movie",
      title: "Bedelia",
      summary: "1946 film by Lance Comfort",
      genres: ["Drama"],
      cast: [],
      directors: []
    });
    expect(directorNameOnly.scores.map((score) => score.feature)).not.toEqual(expect.arrayContaining(["mood:cozy", "mood:feel-good", "mood:warm"]));
  });

  it("does not infer comfort mood features from Wikidata credit boilerplate", () => {
    const { repository } = repositoryWithFixtures([]);
    repository.upsert({
      mediaType: "movie",
      title: "Bedelia",
      year: 1946,
      summary: "1946 film by Lance Comfort",
      genres: ["Drama"],
      directors: ["Lance Comfort"]
    });
    const item = repository.findByTitleYear("Bedelia", 1946, "movie");
    const feature = item ? repository.featureMap().get(item.id) : undefined;

    expect(feature?.moodTerms).not.toEqual(expect.arrayContaining(["cozy", "feel-good", "warm"]));
    expect(feature?.watchabilityTerms).not.toEqual(expect.arrayContaining(["background-friendly"]));
  });

  it("stores open catalog provenance while keeping catalog-only rows out of recommendation eligibility", () => {
    const { db, repository } = repositoryWithFixtures([]);
    const [catalogItemId] = repository.upsertCatalogRecords([
      {
        source: "wikidata",
        sourceVersion: "2026-06-29-dump",
        sourceItemId: "Q123456789",
        sourceUrl: "https://www.wikidata.org/wiki/Q123456789",
        licensePolicy: "wikidata-cc0",
        media: {
          mediaType: "movie",
          title: "Open Harbor",
          year: 2024,
          runtimeMinutes: 96,
          summary: "A warm fantasy adventure about friendship, gentle magic, and a quiet seaside town.",
          genres: ["Fantasy", "Adventure"],
          cast: ["Example Actor"],
          directors: ["Example Director"],
          posterPath: "wikidata://Q123456789/poster-not-used",
          externalIds: {
            wikidata: "Q123456789",
            tmdb: 1234567
          }
        },
        mainstreamScore: 61,
        sitelinkCount: 42,
        externalIdCount: 2,
        awardCount: 1,
        metadata: {
          has_enwiki: true,
          dump: "wikidatawiki-20260629"
        }
      }
    ]);
    const catalogItem = repository.findByExternalId("wikidata", "Q123456789");

    expect(catalogItem?.id).toBe(catalogItemId);
    expect(catalogItem?.metadata).toMatchObject({ source: "catalog", catalogSourceCount: 1 });
    expect(repository.catalogSourceSummaries()).toEqual([
      expect.objectContaining({
        source: "wikidata",
        sourceVersion: "2026-06-29-dump",
        itemCount: 1,
        averageMainstreamScore: 61
      })
    ]);
    expect((db.prepare("SELECT license_policy FROM catalog_source_records WHERE source = 'wikidata'").get() as { license_policy: string }).license_policy).toBe(
      "wikidata-cc0"
    );

    const catalogOnlyTitles = scoreLibraryCandidates(repository.list(), "warm fantasy friendship", {}, "solo").results.map((item) => item.title);
    expect(catalogOnlyTitles).not.toContain("Open Harbor");

    repository.upsert({
      mediaType: "movie",
      title: "Open Harbor",
      year: 2024,
      runtimeMinutes: 96,
      summary: "A warm fantasy adventure about friendship, gentle magic, and a quiet seaside town.",
      genres: ["Fantasy", "Adventure"],
      posterPath: "tmdb://w500/open-harbor.jpg",
      externalIds: {
        wikidata: "Q123456789",
        tmdb: 1234567
      },
      seerr: {
        tmdbId: 1234567,
        status: "unknown",
        requestable: true,
        url: "http://fixture-seerr.local/movie/1234567"
      }
    });

    const requestableTitles = scoreLibraryCandidates(repository.list(), "warm fantasy friendship requestable", {}, "solo").results.map((item) => item.title);
    expect(requestableTitles).toContain("Open Harbor");
    expect(repository.findByExternalId("wikidata", "Q123456789")?.metadata?.source).toBe("live");
  });

  it("imports normalized Wikidata catalog records without raw source payloads", () => {
    const { db, repository } = repositoryWithFixtures([]);
    const summary = importWikidataCatalogRecords(
      repository,
      [
        {
          id: "Q999001",
          mediaType: "film",
          labels: { en: "Lantern Picnic" },
          descriptions: { en: "fantasy comedy film" },
          publicationDate: "2025-02-14",
          genreLabels: ["Fantasy", "Comedy"],
          castLabels: ["Example Lead"],
          directorLabels: ["Example Director"],
          countryLabels: ["New Zealand"],
          languageLabels: ["English"],
          franchiseLabels: ["Lantern Stories"],
          imdbId: "tt999001",
          tmdbMovieId: 999001,
          sitelinkCount: 38,
          awardCount: 2,
          hasEnglishWikipedia: true
        },
        {
          id: "not-a-qid",
          mediaType: "film",
          label: "Bad Row"
        }
      ],
      { sourceVersion: "wikidata-2026-06-29" }
    );
    const item = repository.findByExternalId("wikidata", "Q999001");
    const sourceRecord = db.prepare("SELECT payload_hash, metadata_json FROM catalog_source_records WHERE source_item_id = ?").get("Q999001") as {
      payload_hash: string;
      metadata_json: string;
    };
    const syncRun = db.prepare("SELECT item_count, media_items_upserted, source_records_upserted FROM catalog_sync_runs WHERE source = ?").get("wikidata") as {
      item_count: number;
      media_items_upserted: number;
      source_records_upserted: number;
    };

    expect(summary).toMatchObject({
      source: "wikidata",
      sourceVersion: "wikidata-2026-06-29",
      records: 2,
      imported: 1,
      skipped: 1,
      skippedReasons: { missing_wikidata_id: 1 }
    });
    expect(syncRun).toEqual({ item_count: 2, media_items_upserted: 1, source_records_upserted: 1 });
    expect(item).toMatchObject({
      title: "Lantern Picnic",
      year: 2025,
      mediaType: "movie",
      cast: ["Example Lead"],
      directors: ["Example Director"],
      externalIds: expect.objectContaining({ wikidata: "Q999001", imdb: "tt999001", tmdb: "999001" })
    });
    expect(item?.genres).toEqual(expect.arrayContaining(["Fantasy", "Comedy"]));
    expect(sourceRecord.payload_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(sourceRecord.metadata_json).toContain("Lantern Stories");
    expect(sourceRecord.metadata_json).not.toContain("fantasy comedy film");
    expect(repository.catalogDiagnostics()).toMatchObject({ totalCatalogItems: 1, catalogOnlyItems: 1, seerrVerifiedItems: 0 });
    expect(repository.catalogDiagnostics().verificationCandidates[0]).toMatchObject({
      title: "Lantern Picnic",
      mediaType: "movie",
      year: 2025,
      hasSummary: true
    });
  });

  it("updates catalog source-version metadata without re-versioning unchanged payloads", () => {
    const { db, repository } = repositoryWithFixtures([]);
    const row = {
      id: "Q999101",
      mediaType: "film",
      labels: { en: "Still Lantern" },
      descriptions: { en: "gentle fantasy film" },
      publicationDate: "2024-01-01",
      genreLabels: ["Fantasy"],
      tmdbMovieId: 999101,
      sitelinkCount: 40,
      hasEnglishWikipedia: true
    };

    const first = importWikidataCatalogRecords(repository, [row], { sourceVersion: "wikidata-snapshot-a" });
    const second = importWikidataCatalogRecords(repository, [row], { sourceVersion: "wikidata-snapshot-b" });
    const sourceRecord = db
      .prepare(
        `SELECT source_version, last_seen_source_version, content_version, active, deleted_at
         FROM catalog_source_records
         WHERE source_item_id = ?`
      )
      .get("Q999101") as {
      source_version: string;
      last_seen_source_version: string;
      content_version: number;
      active: number;
      deleted_at?: string | null;
    };
    const latestRun = repository.catalogDiagnostics().latestRun;

    expect(first).toMatchObject({ changedSourceRecords: 1, unchangedSourceRecords: 0 });
    expect(second).toMatchObject({ changedSourceRecords: 0, unchangedSourceRecords: 1 });
    expect(sourceRecord).toEqual({
      source_version: "wikidata-snapshot-b",
      last_seen_source_version: "wikidata-snapshot-b",
      content_version: 1,
      active: 1,
      deleted_at: null
    });
    expect(latestRun).toMatchObject({
      source: "wikidata",
      sourceVersion: "wikidata-snapshot-b",
      status: "ok",
      changedSourceRecords: 0,
      unchangedSourceRecords: 1
    });
  });

  it("marks rows missing from a full catalog snapshot inactive without hard deletion", () => {
    const { db, repository } = repositoryWithFixtures([]);
    importWikidataCatalogRecords(
      repository,
      [
        {
          id: "Q999201",
          mediaType: "film",
          label: "Active Lantern",
          description: "warm fantasy film",
          publicationDate: "2024-01-01",
          genreLabels: ["Fantasy"],
          tmdbMovieId: 999201,
          sitelinkCount: 80,
          hasEnglishWikipedia: true
        },
        {
          id: "Q999202",
          mediaType: "film",
          label: "Missing Lantern",
          description: "warm fantasy film",
          publicationDate: "2024-01-01",
          genreLabels: ["Fantasy"],
          tmdbMovieId: 999202,
          sitelinkCount: 80,
          hasEnglishWikipedia: true
        }
      ],
      { sourceVersion: "wikidata-full-a" }
    );
    const inactive = repository.markCatalogRecordsInactiveExcept("wikidata", "wikidata-full-b", ["Q999201"]);
    repository.recordCatalogSync("wikidata", "wikidata-full-b", "ok", {
      itemCount: 1,
      mediaItemsUpserted: 1,
      sourceRecordsUpserted: 1,
      updateMode: "full_snapshot",
      changedSourceRecords: 0,
      unchangedSourceRecords: 1,
      inactiveSourceRecords: inactive
    });

    const rows = db.prepare("SELECT source_item_id, active, deleted_at FROM catalog_source_records ORDER BY source_item_id").all() as Array<{
      source_item_id: string;
      active: number;
      deleted_at?: string | null;
    }>;
    const missing = repository.findByExternalId("wikidata", "Q999202");
    const diagnostics = repository.catalogDiagnostics();

    expect(inactive).toBe(1);
    expect(rows).toEqual([
      { source_item_id: "Q999201", active: 1, deleted_at: null },
      { source_item_id: "Q999202", active: 0, deleted_at: expect.any(String) }
    ]);
    expect(missing).toBeDefined();
    expect(repository.catalogRankScoreMap().has(missing!.id)).toBe(false);
    expect(repository.catalogVerificationCandidates(10).map((item) => item.title)).not.toContain("Missing Lantern");
    expect(diagnostics).toMatchObject({
      totalCatalogItems: 2,
      activeCatalogItems: 1,
      inactiveCatalogItems: 1,
      catalogOnlyItems: 1,
      latestRun: {
        sourceVersion: "wikidata-full-b",
        updateMode: "full_snapshot",
        inactiveSourceRecords: 1
      }
    });
  });

  it("normalizes Wikidata TV series and rejects unsupported entity classes", () => {
    const tv = toCatalogIngestRecord(
      {
        wikidataId: "Q888002",
        instanceOf: ["television series"],
        label: "Quiet Lanterns",
        publicationDate: "2022-09-01",
        genreLabels: ["Mystery"]
      },
      { source: "wikidata", sourceVersion: "test" }
    );
    const unsupported = toCatalogIngestRecord({ wikidataId: "Q888003", label: "Novel", instanceOf: ["novel"] }, { source: "wikidata", sourceVersion: "test" });

    expect(tv).toMatchObject({ ok: true, record: { media: { mediaType: "tv", title: "Quiet Lanterns", year: 2022 } } });
    expect(unsupported).toEqual({ ok: false, reason: "unsupported_media_type" });
  });

  it("does not erase live metadata when Wikidata catalog records match existing items", () => {
    const { repository } = repositoryWithFixtures([]);
    repository.upsert({
      mediaType: "movie",
      title: "Existing Harbor",
      year: 2020,
      summary: "The local Plex summary should remain authoritative.",
      genres: ["Drama", "Mystery"],
      cast: ["Local Lead"],
      directors: ["Local Director"],
      externalIds: {
        wikidata: "Q321321321",
        tmdb: 321321
      },
      plex: {
        ratingKey: "321321",
        guid: "plex://movie/321321",
        available: true
      }
    });

    importWikidataCatalogRecords(
      repository,
      [
        {
          id: "Q321321321",
          mediaType: "film",
          label: "Existing Harbor",
          description: "Catalog summary should not replace live metadata.",
          tmdbMovieId: 321321,
          genreLabels: [],
          castLabels: [],
          directorLabels: [],
          sitelinkCount: 48,
          hasEnglishWikipedia: true
        }
      ],
      { sourceVersion: "wikidata-2026-06-30" }
    );

    const item = repository.findByExternalId("wikidata", "Q321321321");
    expect(item).toMatchObject({
      title: "Existing Harbor",
      summary: "The local Plex summary should remain authoritative.",
      genres: ["Drama", "Mystery"],
      cast: ["Local Lead"],
      directors: ["Local Director"],
      metadata: {
        source: "live",
        catalogSourceCount: 1
      }
    });
  });

  it("validates local MovieLens Tag Genome files without writing derived outputs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moodarr-movielens-"));
    try {
      writeFileSync(join(dir, "movies.csv"), 'movieId,title,genres\n1,"Harbor, The (2024)",Comedy\n2,"Quiet County Fair (2023)",Comedy\n');
      writeFileSync(join(dir, "genome-tags.csv"), "tagId,tag\n10,witty comedy\n11,dark violent\n12,box office\n13,family friendly\n");
      writeFileSync(join(dir, "genome-scores.csv"), "movieId,tagId,relevance\n1,10,0.95\n1,11,0.60\n2,13,0.80\n999,10,0.90\n2,12,0.99\n");
      const beforeFiles = readdirSync(dir).sort();

      expect(parseMovieLensTitle("Harbor, The (2024)")).toEqual({ title: "The Harbor", year: 2024 });
      expect(parseCsvLine('1,"A, ""quoted"" title",Comedy')).toEqual(["1", 'A, "quoted" title', "Comedy"]);
      expect(mapMovieLensTag("quirky witty family comedy")).toEqual(
        expect.arrayContaining(["mood:funny", "mood:weird", "tone:offbeat", "watch:family-friendly", "watch:shared-screen"])
      );

      const summary = await summarizeMovieLensTagGenomeFiles({ dir, threshold: 0.7 });

      expect(summary).toMatchObject({
        source: "movielens-tag-genome",
        threshold: 0.7,
        movieRows: 2,
        tagRows: 4,
        mappedTagRows: 3,
        scoreRowsRead: 5,
        scoreRowsAboveThreshold: 4,
        mappedScoreRows: 2,
        mappedMovieIds: 2,
        mappedFeatures: 3
      });
      expect(summary.topMappedFeatures).toEqual(
        expect.arrayContaining([
          { feature: "mood:funny", scoreRows: 1 },
          { feature: "watch:family-friendly", scoreRows: 1 },
          { feature: "watch:shared-screen", scoreRows: 1 }
        ])
      );
      expect(readdirSync(dir).sort()).toEqual(beforeFiles);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retrieves a broad hybrid candidate pool before AI reranking", async () => {
    const { repository } = repositoryWithFixtures();
    const intent = parseRecommendationIntent("something like Stardust but more witty and short");
    const filters = intent.hardFilters;
    const brief = buildRecommendationBrief({ query: intent.query, watchContext: "group" }, intent, filters, "group", 20);

    const retrieved = await retrieveRecommendationCandidates(repository, brief);
    const titles = retrieved.candidates.map((item) => item.title);

    expect(retrieved.context.sourceCounts.lexical).toBeGreaterThan(0);
    expect(retrieved.context.sourceCounts.semantic).toBe(repository.list().length);
    expect(retrieved.context.sourceCounts.mood).toBeGreaterThan(0);
    expect(titles).toEqual(expect.arrayContaining(["Stardust", "The Princess Bride"]));
  });

  it("uses catalog rank signals to pull high-signal catalog rows into the search-test candidate pool", async () => {
    const { repository } = repositoryWithFixtures([]);
    importWikidataCatalogRecords(
      repository,
      [
        ...Array.from({ length: 540 }, (_, index) => ({
          id: `Q${800000 + index}`,
          mediaType: "film",
          label: `A Catalog Decoy ${String(index).padStart(3, "0")}`,
          description: "Plain imported catalog record.",
          publicationDate: "2020-01-01",
          genreLabels: ["Drama"],
          sitelinkCount: 1
        })),
        {
          id: "Q900999",
          mediaType: "film",
          label: "Z Search Test Lantern",
          description: "Plain imported catalog record.",
          publicationDate: "2024-01-01",
          genreLabels: ["Drama"],
          tmdbMovieId: 900999,
          sitelinkCount: 800,
          awardCount: 4,
          hasEnglishWikipedia: true
        }
      ],
      { sourceVersion: "wikidata-search-alpha" }
    );
    const query = "requestable options";
    const intent = parseRecommendationIntent(query);
    const brief = buildRecommendationBrief({ query, watchContext: "solo" }, intent, intent.hardFilters, "solo", 10);

    const retrieved = await retrieveRecommendationCandidates(repository, brief);
    const target = repository.findByExternalId("wikidata", "Q900999");

    expect(target).toBeDefined();
    expect(repository.list().slice(0, 500).map((item) => item.title)).not.toContain("Z Search Test Lantern");
    expect(retrieved.context.sourceCounts.selected).toBe(500);
    expect(retrieved.context.sourceCounts.catalogRank).toBe(500);
    expect(retrieved.context.catalogRankScores.get(target!.id)).toBeGreaterThan(50);
    expect(retrieved.candidates.map((item) => item.title)).toContain("Z Search Test Lantern");
    expect(repository.catalogDiagnostics()).toMatchObject({
      totalCatalogItems: 541,
      rankSignalItems: 541,
      featureIndexedItems: 541,
      moodIndexedItems: 541,
      rankedSearchReadyItems: 541
    });
  });

  it("applies resolved media-type filters to catalog verification candidates", async () => {
    const { repository } = repositoryWithFixtures([]);
    importWikidataCatalogRecords(
      repository,
      [
        {
          id: "Q910001",
          mediaType: "film",
          label: "Popular Movie Decoy",
          description: "popular drama film",
          publicationDate: "2024-01-01",
          genreLabels: ["Drama"],
          sitelinkCount: 900,
          hasEnglishWikipedia: true
        },
        {
          id: "Q910002",
          mediaType: "television series",
          label: "Popular Show Target",
          description: "popular television series",
          publicationDate: "2024-01-01",
          genreLabels: ["Drama"],
          sitelinkCount: 50,
          hasEnglishWikipedia: true
        }
      ],
      { sourceVersion: "wikidata-verification-filters" }
    );
    const query = "requestable popular shows not in Plex";
    const intent = parseRecommendationIntent(query);
    const brief = buildRecommendationBrief({ query, watchContext: "solo" }, intent, intent.hardFilters, "solo", 10);
    const retrieved = await retrieveRecommendationCandidates(repository, brief);
    const candidates = selectCatalogVerificationCandidates(retrieved, intent.hardFilters, brief, 10);

    expect(candidates.map((candidate) => candidate.title)).toContain("Popular Show Target");
    expect(candidates.every((candidate) => candidate.mediaType === "tv")).toBe(true);
  });

  it("filters horror-coded catalog rows from not-scary verification candidates", async () => {
    const { repository } = repositoryWithFixtures([]);
    importWikidataCatalogRecords(
      repository,
      [
        {
          id: "Q920001",
          mediaType: "film",
          label: "Scary Dark Decoy",
          description: "dark scary horror film",
          publicationDate: "2024-01-01",
          genreLabels: ["Horror", "Dark fantasy"],
          sitelinkCount: 900,
          hasEnglishWikipedia: true
        },
        {
          id: "Q920002",
          mediaType: "film",
          label: "Dark Mystery Target",
          description: "dark mystery drama film",
          publicationDate: "2024-01-01",
          genreLabels: ["Mystery", "Drama"],
          sitelinkCount: 50,
          hasEnglishWikipedia: true
        },
        {
          id: "Q920003",
          mediaType: "film",
          label: "Shadow Splatter Decoy",
          description: "dark action thriller film",
          publicationDate: "2024-01-01",
          genreLabels: ["Crime", "Splatter film"],
          sitelinkCount: 950,
          hasEnglishWikipedia: true
        }
      ],
      { sourceVersion: "wikidata-verification-not-scary" }
    );
    const query = "dark but not scary";
    const intent = parseRecommendationIntent(query);
    const brief = buildRecommendationBrief({ query, watchContext: "solo" }, intent, intent.hardFilters, "solo", 10);
    const retrieved = await retrieveRecommendationCandidates(repository, brief);
    const titles = selectCatalogVerificationCandidates(retrieved, intent.hardFilters, brief, 10).map((candidate) => candidate.title);

    expect(titles).toContain("Dark Mystery Target");
    expect(titles).not.toContain("Scary Dark Decoy");
    expect(titles).not.toContain("Shadow Splatter Decoy");
  });

  it("prefers supportive comfort metadata over title-only comfort accidents", async () => {
    const { repository } = repositoryWithFixtures([]);
    importWikidataCatalogRecords(
      repository,
      [
        {
          id: "Q930001",
          mediaType: "film",
          label: "Southern Comfort",
          description: "action thriller war film",
          publicationDate: "1981-01-01",
          genreLabels: ["Action", "Thriller", "War"],
          sitelinkCount: 900,
          hasEnglishWikipedia: true
        },
        {
          id: "Q930002",
          mediaType: "film",
          label: "Comfort and Joy",
          description: "warm Christmas comedy film",
          publicationDate: "1984-01-01",
          genreLabels: ["Comedy", "Christmas film"],
          sitelinkCount: 50,
          hasEnglishWikipedia: true
        }
      ],
      { sourceVersion: "wikidata-verification-comfort" }
    );
    const query = "low-commitment comfort watch";
    const intent = parseRecommendationIntent(query);
    const brief = buildRecommendationBrief({ query, watchContext: "solo" }, intent, intent.hardFilters, "solo", 10);
    const retrieved = await retrieveRecommendationCandidates(repository, brief);
    const [first] = selectCatalogVerificationCandidates(retrieved, intent.hardFilters, brief, 10);

    expect(first?.title).toBe("Comfort and Joy");
  });

  it("passes up to 100 deterministic candidates to the AI reranker", () => {
    const selected = selectRerankCandidates(
      Array.from({ length: 120 }, (_, index) => itemSummaryFixture(index))
    );

    expect(selected).toHaveLength(100);
    expect(selected[0]?.id).toBe("item-0");
    expect(selected.at(-1)?.id).toBe("item-99");
  });

  it("keeps rank-index scoring bounded to the selected candidate pool under candidate-first retrieval", async () => {
    const records = [
      ...Array.from({ length: 540 }, (_, index) => ({
        mediaType: "movie" as const,
        title: `A Funny Fantasy Decoy ${String(index).padStart(3, "0")}`,
        year: 2000 + (index % 20),
        runtimeMinutes: 181,
        contentRating: "PG",
        summary: "A funny fantasy adventure comedy with magic, jokes, romance, and quests, but it is too long for the requested runtime.",
        genres: ["Adventure", "Fantasy", "Comedy"],
        cast: ["Fixture Actor"],
        directors: ["Fixture Director"],
        ratings: { critic: 88, audience: 88, user: 7.4 },
        posterPath: `fixture://decoy-${index}`,
        externalIds: { tmdb: 900000 + index }
      })),
      {
        mediaType: "movie" as const,
        title: "Z Hidden Lantern",
        year: 2024,
        runtimeMinutes: 94,
        contentRating: "PG",
        summary: "A breezy lantern quest with playful banter, romance, and a concise shape.",
        genres: ["Adventure", "Romance"],
        cast: ["Fixture Actor"],
        directors: ["Fixture Director"],
        ratings: { critic: 80, audience: 82, user: 7.1 },
        posterPath: "fixture://hidden-lantern",
        externalIds: { tmdb: 999999 }
      }
    ];
    const { repository } = repositoryWithFixtures(records);
    const query = "funny fantasy movie under two hours";
    const intent = parseRecommendationIntent(query);
    const brief = buildRecommendationBrief({ query, watchContext: "group" }, intent, intent.hardFilters, "group", 10);
    const retrieved = await retrieveRecommendationCandidates(repository, brief);

    const v3 = scoreMoodRankV3RetrievedCandidates(retrieved, { query, watchContext: "group", resultLimit: 10, useAi: false }, "group");
    const v4 = scoreRankIndexedLibrary(retrieved, { query, watchContext: "group", resultLimit: 10, useAi: false }, "group");

    expect(retrieved.context.sourceCounts.selected).toBe(500);
    expect(retrieved.candidates.map((item) => item.title)).toContain("Z Hidden Lantern");
    expect(v4.rankIndex.libraryItemCount).toBe(541);
    expect(v4.rankIndex.indexedItemCount).toBe(500);
    expect(v4.rankIndex.scoredItemCount).toBe(1);
    expect(v3.results[0]?.title).toBe("Z Hidden Lantern");
    expect(v4.results[0]?.title).toBe("Z Hidden Lantern");
  });

  it("uses configured provider embeddings as an additive semantic source", async () => {
    const { db, repository } = repositoryWithFixtures();
    const intent = parseRecommendationIntent("whimsical fantasy adventure");
    const brief = buildRecommendationBrief({ query: intent.query, watchContext: "solo" }, intent, intent.hardFilters, "solo", 20);
    const provider: EmbeddingProvider = {
      providerName: "test-provider",
      modelName: "test-embedding",
      configured: true,
      embed: vi.fn(async (inputs: string[]) => inputs.map((input) => (input.toLowerCase().includes("fantasy") ? [1, 0] : [0, 1])))
    };

    const retrieved = await retrieveRecommendationCandidates(repository, brief, provider);
    const embeddingRows = db.prepare("SELECT provider, model, dimensions FROM media_embeddings").all() as Array<{
      provider: string;
      model: string;
      dimensions: number;
    }>;

    expect(provider.embed).toHaveBeenCalled();
    expect(retrieved.context.sourceCounts.providerEmbedding).toBeGreaterThan(0);
    expect(retrieved.context.providerEmbeddingBackfillCount).toBeGreaterThan(0);
    expect(retrieved.context.embeddingModel).toBe("test-embedding");
    expect(embeddingRows[0]).toMatchObject({ provider: "test-provider", model: "test-embedding", dimensions: 2 });
  });

  it("warms provider embeddings outside the live search path", async () => {
    const { db, repository } = repositoryWithFixtures();
    const provider: EmbeddingProvider = {
      providerName: "test-provider",
      modelName: "test-embedding",
      configured: true,
      embed: vi.fn(async (inputs: string[]) => inputs.map((input) => (input.toLowerCase().includes("fantasy") ? [1, 0] : [0, 1])))
    };

    const result = await warmProviderEmbeddings(repository, provider, { limit: 3, batchSize: 2 });
    const embeddingRows = db.prepare("SELECT provider, model, dimensions FROM media_embeddings").all() as Array<{
      provider: string;
      model: string;
      dimensions: number;
    }>;

    expect(provider.embed).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ configured: true, attempted: 3, embedded: 3, hasMore: true });
    expect(embeddingRows).toHaveLength(3);
    expect(embeddingRows[0]).toMatchObject({ provider: "test-provider", model: "test-embedding", dimensions: 2 });
  });

  it("enforces hard runtime filters while keeping query genres as soft signals", () => {
    const { repository } = repositoryWithFixtures();
    const scored = scoreLibraryCandidates(repository.list(), "funny fantasy movie under two hours", {}, "group");

    expect(scored.results.every((item) => item.mediaType === "movie")).toBe(true);
    expect(scored.results.every((item) => !item.runtimeMinutes || item.runtimeMinutes <= 120)).toBe(true);
    expect(scored.results.some((item) => item.title === "The Princess Bride")).toBe(true);
    expect(scored.results.some((item) => item.title === "Stardust")).toBe(false);
  });

  it("excludes negated animation and sparse Seerr-only catalog rows from recommendations", () => {
    const { repository } = repositoryWithFixtures([
      ...fixturePlexItems,
      {
        mediaType: "movie",
        title: "Daily Fantasy",
        year: 2021,
        runtimeMinutes: 90,
        summary: "A live-action fantasy comedy with romantic caper energy.",
        genres: ["Comedy", "Fantasy", "Romance"],
        posterPath: "tmdb://w500/daily-fantasy.jpg",
        externalIds: { tmdb: 869536 },
        seerr: {
          tmdbId: 869536,
          status: "unknown",
          requestable: true,
          url: "http://fixture-seerr.local/movie/869536"
        }
      },
      {
        mediaType: "movie",
        title: "Animated Hair Cartoon, No. 5",
        year: 1926,
        runtimeMinutes: 6,
        summary: "An animated short.",
        genres: ["Animation", "Comedy"],
        externalIds: { tmdb: 1460981 },
        seerr: {
          tmdbId: 1460981,
          status: "unknown",
          requestable: true,
          url: "http://fixture-seerr.local/movie/1460981"
        }
      },
      {
        mediaType: "movie",
        title: "Movie 1280672",
        externalIds: { tmdb: 1280672 },
        seerr: {
          tmdbId: 1280672,
          status: "unknown",
          requestable: true,
          url: "http://fixture-seerr.local/movie/1280672"
        }
      }
    ]);

    const scored = scoreLibraryCandidates(repository.list(), "funny fantasy movie not animated requestable", {}, "solo");
    const titles = scored.results.map((item) => item.title);

    expect(scored.filters.excludedGenres).toEqual(["Animation"]);
    expect(titles).toContain("Daily Fantasy");
    expect(titles).not.toContain("Animated Hair Cartoon, No. 5");
    expect(titles).not.toContain("Movie 1280672");
    expect(scored.results.every((item) => !item.genres.includes("Animation"))).toBe(true);
  });

  it("uses text evidence to exclude animation when genre metadata is missing", () => {
    const { repository } = repositoryWithFixtures([
      {
        mediaType: "movie",
        title: "Live Action Fantasy",
        year: 2024,
        runtimeMinutes: 92,
        summary: "A playful fantasy comedy about a real-world adventure.",
        genres: ["Comedy", "Fantasy"],
        posterPath: "tmdb://w500/live-action-fantasy.jpg",
        externalIds: { tmdb: 9001 },
        seerr: {
          tmdbId: 9001,
          status: "unknown",
          requestable: true
        }
      },
      {
        mediaType: "movie",
        title: "Animated Fantasy",
        year: 2024,
        runtimeMinutes: 88,
        summary: "An animated fantasy comedy about a magical forest.",
        posterPath: "tmdb://w500/animated-fantasy.jpg",
        externalIds: { tmdb: 9002 },
        seerr: {
          tmdbId: 9002,
          status: "unknown",
          requestable: true
        }
      }
    ]);

    const titles = scoreLibraryCandidates(repository.list(), "funny fantasy movie not animated requestable", {}, "solo").results.map((item) => item.title);

    expect(titles).toContain("Live Action Fantasy");
    expect(titles).not.toContain("Animated Fantasy");
  });

  it("enforces custom runtime ranges from natural language", () => {
    const { repository } = repositoryWithFixtures();
    const scored = scoreLibraryCandidates(repository.list(), "movie between 100 and 110 minutes", {}, "solo");

    expect(scored.filters).toMatchObject({ mediaTypes: ["movie"], minRuntimeMinutes: 100, maxRuntimeMinutes: 110 });
    expect(scored.results.length).toBeGreaterThan(0);
    expect(scored.results.every((item) => !item.runtimeMinutes || (item.runtimeMinutes >= 100 && item.runtimeMinutes <= 110))).toBe(true);
  });

  it("uses separate group-watch taste signals", () => {
    const { repository } = repositoryWithFixtures();
    const solo = scoreLibraryCandidates(repository.list(), "feel-good comedy for tonight", {}, "solo").results;
    const group = scoreLibraryCandidates(repository.list(), "feel-good comedy for tonight", {}, "group").results;

    expect(group.findIndex((item) => item.title === "Paddington 2")).toBeLessThan(group.findIndex((item) => item.title === "The Do-Over"));
    expect(solo[0].scoreBreakdown).toMatchObject({
      query: expect.any(Number),
      mood: expect.any(Number),
      taste: expect.any(Number),
      availability: expect.any(Number),
      quality: expect.any(Number),
      friction: expect.any(Number),
      diversity: expect.any(Number)
    });
  });

  it("does not give generic genre matches perfect query and mood buckets", () => {
    const { repository } = repositoryWithFixtures();
    const scored = scoreLibraryCandidates(repository.list(), "funny adventure comedy movie", {}, "solo").results;
    const doOver = scored.find((item) => item.title === "The Do-Over");
    const paddington = scored.find((item) => item.title === "Paddington 2");

    expect(doOver?.scoreBreakdown?.query).toBeLessThan(95);
    expect(doOver?.scoreBreakdown?.mood).toBeLessThan(95);
    expect(paddington?.scoreBreakdown?.query).toBeLessThan(95);
    expect(paddington?.scoreBreakdown?.mood).toBeLessThan(95);
  });

  it("scores reference, mood, friction, and diversity as separate MoodRank v0.4 signals", () => {
    const { repository } = repositoryWithFixtures();
    const scored = scoreLibraryCandidates(repository.list(), "something like Stardust but shorter and cozy", {}, "group");
    const princessBride = scored.results.find((item) => item.title === "The Princess Bride");

    expect(princessBride?.scoreBreakdown).toMatchObject({
      reference: expect.any(Number),
      mood: expect.any(Number),
      friction: expect.any(Number),
      diversity: expect.any(Number)
    });
    expect(princessBride?.scoreBreakdown?.reference ?? 0).toBeGreaterThan(0);
  });

  it("builds a profile adjustment only when the query uses a calibrated mood term", () => {
    const adjustment = buildFeelProfileAdjustment(syntheticFeelProfiles.cozyWittyLowStakes, "cozy movie");

    expect(adjustment?.matchedTerms).toEqual(["cozy"]);
    expect(adjustment?.confidence).toBeGreaterThan(0.8);
    expect(adjustment?.weights.get("genre:comedy")).toBeGreaterThan(0);
    expect(buildFeelProfileAdjustment(syntheticFeelProfiles.cozyWittyLowStakes, "tense thriller")).toBeUndefined();
  });

  it("scales profile adjustments by effective evidence and conflict", () => {
    const lowEvidence = buildFeelProfileAdjustment(
      {
        id: "test:low-evidence",
        label: "Low evidence cozy",
        watchContext: "solo",
        terms: [
          {
            term: "cozy",
            confidence: 0.9,
            evidenceCount: 1,
            effectiveEvidence: 1,
            conflictScore: 0,
            featureWeights: { "genre:comedy": 4 }
          }
        ]
      },
      "cozy movie"
    );
    const highEvidence = buildFeelProfileAdjustment(
      {
        id: "test:high-evidence",
        label: "High evidence cozy",
        watchContext: "solo",
        terms: [
          {
            term: "cozy",
            confidence: 0.9,
            evidenceCount: 8,
            effectiveEvidence: 8,
            conflictScore: 0,
            featureWeights: { "genre:comedy": 4 }
          }
        ]
      },
      "cozy movie"
    );
    const conflicted = buildFeelProfileAdjustment(
      {
        id: "test:conflicted",
        label: "Conflicted cozy",
        watchContext: "solo",
        terms: [
          {
            term: "cozy",
            confidence: 0.9,
            evidenceCount: 8,
            effectiveEvidence: 8,
            conflictScore: 0.9,
            featureWeights: { "genre:comedy": 4 }
          }
        ]
      },
      "cozy movie"
    );

    expect(highEvidence?.confidence ?? 0).toBeGreaterThan(lowEvidence?.confidence ?? 0);
    expect(conflicted?.confidence ?? 0).toBeLessThan(highEvidence?.confidence ?? 0);
    expect(highEvidence?.weights.get("genre:comedy") ?? 0).toBeGreaterThan(lowEvidence?.weights.get("genre:comedy") ?? 0);
    expect(conflicted?.weights.get("genre:comedy") ?? 0).toBeLessThan(highEvidence?.weights.get("genre:comedy") ?? 0);
  });

  it("applies different personal meanings for the same mood word", () => {
    const { repository } = repositoryWithFixtures();
    const features = repository.featureMap();
    const generic = scoreLibraryCandidates(repository.list(), "cozy movie", {}, "solo", { features }).results;
    const wittyLowStakes = scoreLibraryCandidates(repository.list(), "cozy movie", {}, "solo", {
      features,
      feelProfile: syntheticFeelProfiles.cozyWittyLowStakes
    }).results;
    const fantasyComfort = scoreLibraryCandidates(repository.list(), "cozy movie", {}, "solo", {
      features,
      feelProfile: syntheticFeelProfiles.cozyFantasyAdventure
    }).results;

    const genericPaddington = requireTitle(generic, "Paddington 2");
    const wittyPaddington = requireTitle(wittyLowStakes, "Paddington 2");
    const wittyStardust = requireTitle(wittyLowStakes, "Stardust");
    const fantasyPaddington = requireTitle(fantasyComfort, "Paddington 2");
    const fantasyPrincessBride = requireTitle(fantasyComfort, "The Princess Bride");

    expect(genericPaddington.scoreBreakdown?.profile).toBeUndefined();
    expect(wittyLowStakes[0]?.title).toBe("Paddington 2");
    expect(fantasyComfort[0]?.title).toBe("The Princess Bride");
    expect(wittyPaddington.scoreBreakdown?.profile ?? 0).toBeGreaterThan(wittyStardust.scoreBreakdown?.profile ?? 0);
    expect(fantasyPrincessBride.scoreBreakdown?.profile ?? 0).toBeGreaterThan(fantasyPaddington.scoreBreakdown?.profile ?? 0);
    expect(wittyPaddington.score).toBeGreaterThan(genericPaddington.score);
  });

  it("keeps fallback explanations focused on fit instead of repeated metadata", () => {
    const { repository } = repositoryWithFixtures();
    const scored = scoreLibraryCandidates(repository.list(), "funny fantasy movie under two hours", {}, "group");

    for (const item of scored.results.slice(0, 5)) {
      expect(item.matchExplanation.toLowerCase().startsWith(item.title.toLowerCase())).toBe(false);
      expect(item.matchExplanation.toLowerCase()).not.toMatch(/\bruntime\b|\bcritic\b|\baudience\b|\buser rating\b|\b\d+\s*min\b/);
      expect(item.matchExplanation).not.toMatch(/good fit because|It is already available in Plex/i);
      expect(item.matchExplanation).not.toMatch(/clearest overlap|near the brief|keeps it close to the requested mood|recommendation focused|right lane/i);
      expect(sentenceCount(item.matchExplanation)).toBe(3);
    }
  });

  it("keeps direct title and genre explanations concise without repeating the lead genre", () => {
    const { repository } = repositoryWithFixtures([
      {
        mediaType: "movie",
        title: "Everest",
        year: 2015,
        runtimeMinutes: 121,
        summary: "Climbers fight to survive a dangerous expedition on Mount Everest.",
        genres: ["Adventure", "Drama"],
        posterPath: "fixture://everest",
        externalIds: { tmdb: 253412 },
        plex: {
          ratingKey: "fixture-plex-everest",
          guid: "tmdb://253412",
          libraryTitle: "Movies",
          libraryType: "movie",
          available: true
        }
      }
    ]);

    const scored = scoreLibraryCandidates(repository.list(), "adventure everest", {}, "solo");
    const everest = requireTitle(scored.results, "Everest");
    const explanation = everest.matchExplanation;

    expect(sentenceCount(explanation)).toBe(3);
    expect(explanation).not.toMatch(/clearest overlap|near the brief|requested mood|recommendation focused|right lane|exact ".+" cue/i);
    expect(explanation).toMatch(/direct title match|title hits directly/i);
    expect(explanation.toLowerCase().match(/\badventure\b/g) ?? []).toHaveLength(1);
    expect(explanation.length).toBeLessThan(230);
  });

  it("preserves richer Plex metadata when sparse Seerr records merge by external id", () => {
    const { repository } = repositoryWithFixtures([fixturePlexItems[0]]);

    repository.upsert({
      mediaType: "movie",
      title: "Movie 2270",
      externalIds: { tmdb: 2270 },
      seerr: {
        tmdbId: 2270,
        status: "unknown",
        requestable: false
      }
    });

    const item = repository.list().find((candidate) => candidate.externalIds.tmdb === "2270");
    expect(item?.title).toBe("Stardust");
    expect(item?.genres).toEqual(expect.arrayContaining(["Adventure", "Fantasy", "Comedy"]));
  });

  it("fills missing runtime and genres from Seerr without replacing cached Plex values", () => {
    const { repository } = repositoryWithFixtures([
      {
        mediaType: "movie",
        title: "The Princess Bride",
        year: 1987,
        summary: "Cached Plex summary.",
        externalIds: { tmdb: 2493 },
        plex: {
          ratingKey: "fixture-plex-princess-bride",
          guid: "tmdb://2493",
          libraryTitle: "Movies",
          libraryType: "movie",
          url: "https://app.plex.tv/desktop/#!/server/fixture/details?key=%2Flibrary%2Fmetadata%2Ffixture-plex-princess-bride",
          available: true
        }
      }
    ]);

    repository.upsert({
      mediaType: "movie",
      title: "The Princess Bride",
      year: 1987,
      runtimeMinutes: 98,
      genres: ["Adventure", "Comedy", "Romance"],
      externalIds: { tmdb: 2493 },
      seerr: {
        tmdbId: 2493,
        status: "available",
        requestable: false
      }
    });

    const item = repository.list().find((candidate) => candidate.externalIds.tmdb === "2493");
    expect(item?.plex?.available).toBe(true);
    expect(item?.runtimeMinutes).toBe(98);
    expect(item?.genres).toEqual(["Adventure", "Comedy", "Romance"]);

    repository.upsert({
      mediaType: "movie",
      title: "The Princess Bride",
      year: 1987,
      runtimeMinutes: 99,
      genres: ["Different"],
      externalIds: { tmdb: 2493 },
      seerr: {
        tmdbId: 2493,
        status: "available",
        requestable: false
      }
    });

    const updated = repository.list().find((candidate) => candidate.externalIds.tmdb === "2493");
    expect(updated?.runtimeMinutes).toBe(98);
    expect(updated?.genres).toEqual(["Adventure", "Comedy", "Romance"]);
  });
});

describe("recommendation engine", () => {
  it("verifies high-ranking catalog candidates through Seerr before recommending them", async () => {
    const { repository } = repositoryWithFixtures([]);
    importWikidataCatalogRecords(
      repository,
      [
        {
          id: "Q700001",
          mediaType: "film",
          label: "Open Harbor",
          description: "warm fantasy adventure film",
          publicationDate: "2024-01-01",
          genreLabels: ["Fantasy", "Adventure"],
          tmdbMovieId: 1234567,
          sitelinkCount: 75,
          hasEnglishWikipedia: true
        }
      ],
      { sourceVersion: "wikidata-2026-06-29" }
    );
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };
    const seerrClient = {
      search: vi.fn(async (query: string) =>
        query === "Open Harbor"
          ? [
              {
                mediaType: "movie",
                title: "Open Harbor",
                year: 2024,
                runtimeMinutes: 96,
                summary: "A warm fantasy adventure about friendship, gentle magic, and a quiet seaside town.",
                genres: ["Fantasy", "Adventure"],
                posterPath: "tmdb://w500/open-harbor.jpg",
                externalIds: { wikidata: "Q700001", tmdb: 1234567 },
                seerr: {
                  tmdbId: 1234567,
                  status: "unknown",
                  requestable: true,
                  url: "http://fixture-seerr.local/movie/1234567"
                }
              }
            ]
          : []
      )
    } as unknown as SeerrClient;

    const response = await new RecommendationEngine(repository, seerrClient, ranker).recommend({
      query: "warm fantasy friendship requestable",
      resultLimit: 5,
      useAi: false
    });

    expect(seerrClient.search).toHaveBeenCalledWith("Open Harbor");
    expect(response.diagnostics?.catalogVerificationCount).toBe(1);
    expect(response.results.some((item) => item.title === "Open Harbor" && item.availabilityGroup === "not_in_plex_requestable")).toBe(true);
    expect(repository.catalogDiagnostics()).toMatchObject({
      totalCatalogItems: 1,
      catalogOnlyItems: 0,
      seerrVerifiedItems: 1,
      requestableVerifiedItems: 1,
      verificationCandidateCount: 0
    });
  });

  it("searches Seerr when local candidates are weak and records only a query hash", async () => {
    const { db, repository } = repositoryWithFixtures(fixturePlexItems);
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: true, results: candidates })) };
    const seerrClient = {
      search: vi.fn(async () => fixtureSeerrItems)
    } as unknown as SeerrClient;
    const engine = new RecommendationEngine(repository, seerrClient, ranker);

    const response = await engine.recommend({ query: "Princess Bride requestable", resultLimit: 5 });
    const event = db.prepare("SELECT * FROM search_events LIMIT 1").get() as { query_hash: string; result_count: number };
    const session = db.prepare("SELECT * FROM recommendation_sessions LIMIT 1").get() as {
      query_hash: string;
      result_count: number;
      candidate_count: number;
      rerank_candidate_count: number;
      seerr_augmented: number;
    };

    expect(seerrClient.search).toHaveBeenCalled();
    expect(response.results.some((item) => item.title === "The Princess Bride")).toBe(true);
    expect(response.summary).toContain("I’d steer this toward");
    expect(response.refinementOptions.length).toBeGreaterThan(0);
    expect(response.optimizedQuery).toBe("Princess Bride requestable");
    expect(response.resolvedFilters).toBeDefined();
    expect(ranker.rank).toHaveBeenCalled();
    expect(event.query_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(event)).not.toContain("Princess Bride requestable");
    expect(session.query_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(session.result_count).toBe(response.results.length);
    expect(session.candidate_count).toBeGreaterThanOrEqual(response.results.length);
    expect(session.rerank_candidate_count).toBeGreaterThanOrEqual(response.results.length);
    expect(session.seerr_augmented).toBe(1);
    expect(JSON.stringify(session)).not.toContain("Princess Bride requestable");
    expect(response.diagnostics).toMatchObject({
      engineVersion: "moodrank-v0.4",
      candidateCount: expect.any(Number),
      rerankCandidateCount: expect.any(Number),
      moodCandidateCount: expect.any(Number),
      diversityApplied: true,
      seerrAugmented: true
    });
  });

  it("returns three to five contextual refinement options that vary by response", async () => {
    const { repository } = repositoryWithFixtures(fixturePlexItems);
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };
    const engine = new RecommendationEngine(repository, seerrClient, ranker);

    const fantasy = await engine.recommend({ query: "funny fantasy movie under two hours", resultLimit: 5, watchContext: "group", useAi: false });
    const magical = await engine.recommend({ query: "Lean into the magical, whimsical side of this mood.", resultLimit: 5, watchContext: "solo", useAi: false });
    const cozy = await engine.recommend({ query: "cozy gentle comfort watch", resultLimit: 5, watchContext: "solo", useAi: false });

    expect(fantasy.refinementOptions.length).toBeGreaterThanOrEqual(3);
    expect(fantasy.refinementOptions.length).toBeLessThanOrEqual(5);
    expect(cozy.refinementOptions.length).toBeGreaterThanOrEqual(3);
    expect(cozy.refinementOptions.length).toBeLessThanOrEqual(5);
    expect(fantasy.refinementOptions.map((option) => option.label)).not.toEqual(cozy.refinementOptions.map((option) => option.label));
    expect(new Set(fantasy.refinementOptions.map((option) => option.label.toLowerCase())).size).toBe(fantasy.refinementOptions.length);
    expect(fantasy.refinementOptions.some((option) => /group|crowd/i.test(`${option.label} ${option.prompt}`))).toBe(true);
    expect(magical.refinementOptions.map((option) => option.label)).toContain("More adventure");
    expect(magical.refinementOptions.map((option) => option.label)).not.toContain("More magical");
  });

  it("returns a reusable optimized query instead of saving raw follow-up scaffolding", async () => {
    const { repository } = repositoryWithFixtures();
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };

    const response = await new RecommendationEngine(repository, seerrClient, ranker).recommend({
      query: "funny fantasy movies under two hours\nFollow-up refinement: not animated\nFollow-up refinement: more magical",
      resultLimit: 5,
      useAi: false
    });

    expect(response.optimizedQuery).toBe("funny fantasy movies under two hours; not animated; more magical");
  });

  it("skips the AI query optimizer on normal-length searches", async () => {
    const { repository } = repositoryWithFixtures();
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: true, results: candidates })) };
    const queryOptimizer: QueryOptimizer = {
      optimize: vi.fn(async () => ({ usedAi: true, query: "ai-optimized query" }))
    };

    const response = await new RecommendationEngine(repository, seerrClient, ranker, undefined, undefined, undefined, queryOptimizer).recommend({
      query: "feel-good comedy",
      resultLimit: 5
    });

    expect(queryOptimizer.optimize).not.toHaveBeenCalled();
    expect(response.optimizedQuery).toBe("feel-good comedy");
    expect(response.diagnostics?.queryOptimized).toBe(false);
  });

  it("skips taste scout on simple searches without feedback examples", async () => {
    const { repository } = repositoryWithFixtures();
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: true, results: candidates })) };
    const tasteScout: TasteScout = {
      scout: vi.fn(async () => ({ usedAi: true, recommendations: [{ id: "unused", score: 100 }] }))
    };

    const response = await new RecommendationEngine(repository, seerrClient, ranker, undefined, undefined, tasteScout).recommend({
      query: "feel-good comedy",
      resultLimit: 5
    });

    expect(tasteScout.scout).not.toHaveBeenCalled();
    expect(response.diagnostics?.tasteScoutUsed).toBe(false);
  });

  it("can force AI reranking explicitly", async () => {
    const { repository } = repositoryWithFixtures();
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: true, results: candidates })) };

    const response = await new RecommendationEngine(repository, seerrClient, ranker).recommend({
      query: "feel-good comedy",
      resultLimit: 5,
      useAi: true
    });

    expect(ranker.rank).toHaveBeenCalled();
    expect(response.usedAi).toBe(true);
  });

  it("uses session feedback context without leaking raw prompt text", async () => {
    const { db, repository } = repositoryWithFixtures();
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };
    const liked = repository.list().find((item) => item.title === "Paddington 2");
    const disliked = repository.list().find((item) => item.title === "The Do-Over");
    const maybe = repository.list().find((item) => item.title === "Over the Garden Wall");
    expect(liked).toBeTruthy();
    expect(disliked).toBeTruthy();
    expect(maybe).toBeTruthy();

    const response = await new RecommendationEngine(repository, seerrClient, ranker).recommend({
      query: "feel-good comedy for tonight",
      watchContext: "group",
      feedbackContext: {
        moreLikeItemIds: [liked!.id],
        maybeItemIds: [maybe!.id],
        lessLikeItemIds: [disliked!.id],
        hiddenItemIds: [disliked!.id]
      }
    });

    expect(response.results.some((item) => item.id === disliked!.id)).toBe(false);
    const feedbackRows = db.prepare("SELECT feedback FROM recommendation_feedback ORDER BY id").all() as { feedback: string }[];
    expect(feedbackRows.map((row) => row.feedback)).toEqual(["up", "maybe", "down", "hidden"]);
    expect(repository.preferenceWeights("group").size).toBeGreaterThan(0);
    expect(repository.preferenceWeights("solo").size).toBe(0);
    const session = db.prepare("SELECT * FROM recommendation_sessions LIMIT 1").get();
    expect(JSON.stringify(session)).not.toContain("feel-good comedy for tonight");
  });

  it("backfills Seerr genre metadata before enforcing excluded animation", async () => {
    const { repository } = repositoryWithFixtures([
      {
        mediaType: "movie",
        title: "Princess Mononoke",
        year: 1997,
        runtimeMinutes: 134,
        summary: "A fantasy adventure about a forest spirit conflict.",
        genres: ["Adventure", "Fantasy"],
        posterPath: "fixture://princess-mononoke",
        externalIds: { plex: "plex://movie/princess-mononoke" },
        plex: {
          ratingKey: "fixture-princess-mononoke",
          guid: "plex://movie/princess-mononoke",
          libraryTitle: "Movies",
          libraryType: "movie",
          available: true
        }
      },
      {
        mediaType: "movie",
        title: "Stardust",
        year: 2007,
        runtimeMinutes: 127,
        summary: "A live-action fantasy adventure.",
        genres: ["Adventure", "Fantasy"],
        posterPath: "fixture://stardust",
        externalIds: { plex: "plex://movie/stardust" },
        plex: {
          ratingKey: "fixture-stardust",
          guid: "plex://movie/stardust",
          libraryTitle: "Movies",
          libraryType: "movie",
          available: true
        }
      }
    ]);
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };
    const seerrClient = {
      search: vi.fn(async (query: string) =>
        query.includes("Princess Mononoke")
          ? [
              {
                mediaType: "movie",
                title: "Princess Mononoke",
                year: 1997,
                runtimeMinutes: 134,
                summary: "A fantasy anime feature.",
                genres: ["Animation", "Adventure", "Fantasy"],
                externalIds: { tmdb: 128 },
                seerr: {
                  tmdbId: 128,
                  status: "available",
                  requestable: false
                }
              }
            ]
          : []
      )
    } as unknown as SeerrClient;

    const response = await new RecommendationEngine(repository, seerrClient, ranker).recommend({
      query: "fantasy movie not animated",
      resultLimit: 10
    });

    expect(seerrClient.search).toHaveBeenCalledWith("Princess Mononoke");
    expect(response.results.map((item) => item.title)).not.toContain("Princess Mononoke");
    expect(response.results.map((item) => item.title)).toContain("Stardust");
  });

  it("can use an AI-parsed brief without letting it expose secrets", async () => {
    const { repository } = repositoryWithFixtures();
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };
    const config = recommendationTestConfig();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
        expect(String(init?.body)).not.toContain("test-openai-key-secret");
        return new Response(
          JSON.stringify({
            output: [
              {
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      terms: ["quick", "cozy"],
                      softGenres: ["Comedy"],
                      moods: ["cozy"],
                      referenceTitle: null,
                      hardFilters: {
                        mediaTypes: ["movie"],
                        minRuntimeMinutes: null,
                        maxRuntimeMinutes: 120,
                        minYear: null,
                        maxYear: null,
                        genres: [],
                        contentRating: null,
                        availability: [],
                        requestStatus: []
                      },
                      wantsBetter: false,
                      wantsRequestOptions: false
                    })
                  }
                ]
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      })
    );

    const response = await new RecommendationEngine(repository, seerrClient, ranker, undefined, new OpenAiBriefParser(config)).recommend({
      query: "quick cozy options",
      resultLimit: 5
    });

    expect(response.diagnostics?.aiBriefParsed).toBe(true);
    expect(response.resolvedFilters).toMatchObject({ mediaTypes: ["movie"], maxRuntimeMinutes: 120 });
    expect(response.results.every((item) => item.mediaType === "movie")).toBe(true);
    expect(JSON.stringify(response)).not.toContain("test-openai-key-secret");
  });

  it("treats requestable wording as augmentation unless the user asks for requestable only", async () => {
    const { repository } = repositoryWithFixtures();
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };
    const parser: BriefParser = {
      async parse() {
        return {
          usedAi: true,
          signals: {
            hardFilters: { mediaTypes: ["movie"], availability: ["not_in_plex_requestable"] },
            wantsRequestOptions: true
          }
        };
      }
    };

    const response = await new RecommendationEngine(repository, seerrClient, ranker, undefined, parser).recommend({
      query: "funny fantasy movie with requestable options",
      resultLimit: 10
    });

    expect(response.results.some((item) => item.title === "Stardust" && item.availabilityGroup === "available_in_plex")).toBe(true);
    expect(response.results.some((item) => item.title === "The Princess Bride" && item.availabilityGroup === "not_in_plex_requestable")).toBe(true);
  });

  it("can bypass provider reranking explicitly", async () => {
    const { repository } = repositoryWithFixtures();
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: true, results: candidates })) };
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const provider: EmbeddingProvider = {
      providerName: "test-provider",
      modelName: "test-embedding",
      configured: true,
      embed: vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0]))
    };

    const response = await new RecommendationEngine(repository, seerrClient, ranker, provider).recommend({
      query: "feel-good comedy",
      useAi: false
    });

    expect(response.usedAi).toBe(false);
    expect(ranker.rank).not.toHaveBeenCalled();
    expect(provider.embed).not.toHaveBeenCalled();
    expect(response.diagnostics?.providerEmbeddingCount).toBe(0);
  });

  it("uses cached provider embeddings during search without lazy backfill", async () => {
    const { db, repository } = repositoryWithFixtures();
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const provider: EmbeddingProvider = {
      providerName: "test-provider",
      modelName: "test-embedding",
      configured: true,
      embed: vi.fn(async (inputs: string[]) => inputs.map((input) => (input.toLowerCase().includes("fantasy") ? [1, 0] : [0, 1])))
    };

    const response = await new RecommendationEngine(repository, seerrClient, ranker, provider).recommend({
      query: "whimsical fantasy adventure",
      resultLimit: 5
    });
    const embeddingCount = (db.prepare("SELECT COUNT(*) AS value FROM media_embeddings").get() as { value: number }).value;

    expect(provider.embed).toHaveBeenCalledTimes(1);
    expect(provider.embed).toHaveBeenCalledWith([expect.stringContaining("whimsical fantasy adventure")]);
    expect(embeddingCount).toBe(0);
    expect(response.diagnostics?.providerEmbeddingBackfillCount).toBe(0);
  });

  it("has a fixture-based golden prompt evaluation harness", async () => {
    const { repository } = repositoryWithFixtures();
    const seerrClient = { search: vi.fn(async () => fixtureSeerrItems) } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };
    const engine = new RecommendationEngine(repository, seerrClient, ranker);
    const outputs = new Map();

    for (const testCase of goldenRecommendationCases) {
      const response = await engine.recommend({ query: testCase.query, watchContext: testCase.watchContext, resultLimit: 10, useAi: false });
      outputs.set(testCase.id, response.results);
    }

    const result = evaluateRecommendationResults(goldenRecommendationCases, outputs);
    expect(result.cases).toBeGreaterThanOrEqual(16);
    expect(result.failures).toEqual([]);
    expect(result.constraintAccuracy).toBe(1);
    expect(result.ndcgAt3).toBeGreaterThan(0.7);
    expect(result.top3AnyHitRate).toBe(1);
    expect(result.failureBreakdown.score_miss).toBe(0);
  });

  it("has a synthetic profile-aware personalization eval", () => {
    const { repository } = repositoryWithFixtures(syntheticProfileEvalCatalog);
    const features = repository.featureMap();
    const genericOutputs = new Map();
    const personalizedOutputs = new Map();

    for (const testCase of profileRecommendationCases) {
      genericOutputs.set(
        testCase.id,
        scoreLibraryCandidates(repository.list(), testCase.query, {}, testCase.watchContext, {
          allItems: repository.list(),
          features
        }).results
      );
      personalizedOutputs.set(
        testCase.id,
        scoreLibraryCandidates(repository.list(), testCase.query, {}, testCase.watchContext, {
          allItems: repository.list(),
          features,
          feelProfile: testCase.profile
        }).results
      );
    }

    const result = evaluateProfileRecommendationResults(profileRecommendationCases, genericOutputs, personalizedOutputs);
    expect(result.failures).toEqual([]);
    expect(result.personalizationLiftAt3).toBeGreaterThanOrEqual(0.65);
    expect(result.personalizedNdcgAt3).toBeGreaterThan(result.genericNdcgAt3);
    expect(result.termBreakdown.map((entry) => entry.term).sort()).toEqual(["cozy", "dark", "light", "weird"]);
    expect(result.termBreakdown.every((entry) => entry.losses === 0)).toBe(true);
  });

  it("has an adversarial mood/feel robustness eval harness", () => {
    const { repository } = repositoryWithFixtures(syntheticAdversarialEvalCatalog);
    const features = repository.featureMap();
    const outputs = new Map();

    for (const testCase of adversarialRecommendationCases) {
      outputs.set(
        testCase.id,
        scoreLibraryCandidates(repository.list(), testCase.query, {}, testCase.watchContext, {
          allItems: repository.list(),
          features
        }).results
      );
    }

    const result = evaluateAdversarialRecommendationResults(adversarialRecommendationCases, outputs);
    expect(result.cases).toBeGreaterThanOrEqual(40);
    expect(result.gatingCases).toBe(7);
    expect(result.gatingPassRate).toBe(1);
    expect(result.priorityBreakdown.find((entry) => entry.priority === "P0")?.failures).toBe(0);
  });

  it("has a rank-index coverage eval that protects candidate-first hard-filter breadth", async () => {
    const result = await evaluateRankIndexCoverageCases();

    expect(result.cases).toBeGreaterThanOrEqual(4);
    expect(result.failures).toEqual([]);
    expect(result.candidateHits).toBe(result.cases);
    expect(result.retrievalCapMisses).toBe(0);
    expect(result.caseResults.some((testCase) => testCase.retrievalCandidateCount === 500)).toBe(true);
    expect(result.caseResults.every((testCase) => testCase.targetInRetrievedCandidates)).toBe(true);
  });

  it("evaluates synthetic feel-profile journeys with replay holdouts and drift alerts", async () => {
    const result = await evaluateSyntheticFeelJourneys();

    expect(result.failures).toEqual([]);
    expect(result.journeys).toBe(7);
    expect(result.steps).toBe(89);
    expect(result.holdoutEvents).toBe(7);
    expect(result.replayCompared).toBe(7);
    expect(result.consistentJourneyReplayLosses).toBe(0);
    expect(result.driftAlerts).toBeGreaterThanOrEqual(1);
    expect(result.journeyResults.find((journey) => journey.id === "dark-conflicting-drift")).toMatchObject({
      expectedDriftAlert: true,
      driftAlerts: expect.any(Number)
    });
    const weakJourney = result.journeyResults.find((journey) => journey.id === "weak-actions-do-not-train");
    expect(weakJourney).toBeDefined();
    expect(weakJourney).toMatchObject({
      expectedProfileTraining: false,
      checkpoints: 0,
      holdoutEvents: 0,
      replayCompared: 0,
      finalProfileVersion: 0,
      finalEffectiveEvidence: 0
    });
    expect(weakJourney!.stepResults.every((step) => step.appliedProfileSignal === false)).toBe(true);

    const pairwiseJourney = result.journeyResults.find((journey) => journey.id === "pairwise-cozy-contrast");
    expect(pairwiseJourney).toBeDefined();
    expect(pairwiseJourney).toMatchObject({
      expectedProfileTraining: true,
      holdoutEvents: 1,
      replayCompared: 1,
      replayLosses: 0
    });
    expect(pairwiseJourney!.stepResults.every((step) => step.action !== "pairwise_pick" || Boolean(step.comparedTitle))).toBe(true);

    const contextJourney = result.journeyResults.find((journey) => journey.id === "context-isolated-cozy");
    expect(contextJourney).toBeDefined();
    expect(contextJourney).toMatchObject({
      holdoutEvents: 2,
      replayCompared: 2,
      replayLosses: 0,
      contextIsolation: {
        checked: true,
        isolated: true,
        term: "cozy"
      }
    });
    expect(contextJourney!.contextIsolation?.contexts.map((context) => context.watchContext).sort()).toEqual(["group", "solo"]);
    expect(contextJourney!.contextIsolation?.contexts.every((context) => context.version >= 10 && context.effectiveEvidence >= 10)).toBe(true);
  });
});
