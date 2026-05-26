import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { fixturePlexItems, fixtureSeerrItems } from "../src/server/fixtures/media";
import { parseRecommendationIntent } from "../src/server/recommendation/intent";
import { scoreLibraryCandidates, seerrSearchQueries } from "../src/server/recommendation/scoring";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import { buildRecommendationBrief } from "../src/server/recommendation/brief";
import { retrieveRecommendationCandidates } from "../src/server/recommendation/retrieval";
import type { AiRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { evaluateRecommendationResults, goldenRecommendationCases } from "../src/server/recommendation/evaluation";
import { buildConversationQuery, deriveChatCriteria } from "../src/client/chatCriteria";
import type { EmbeddingProvider } from "../src/server/ai/embeddings";
import { OpenAiBriefParser } from "../src/server/ai/briefParser";
import type { BriefParser } from "../src/server/ai/briefParser";
import type { AppConfig } from "../src/server/config";

afterEach(() => {
  vi.unstubAllGlobals();
});

function repositoryWithFixtures(records = [...fixturePlexItems, ...fixtureSeerrItems]) {
  const db = createDatabase(":memory:");
  const repository = new MediaRepository(db);
  repository.upsertMany(records);
  return { db, repository };
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
    plex: { webBaseUrl: "https://app.plex.tv/desktop" },
    seerr: {},
    ai: {
      provider: "openai",
      openaiApiKey: "test-openai-key-secret",
      openaiModel: "gpt-5.5",
      openaiEmbeddingModel: "text-embedding-3-large"
    },
    sync: { intervalMinutes: 0, syncSeerr: true },
    knownSecrets: ["test-openai-key-secret"]
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
});

describe("recommendation scoring", () => {
  it("creates feature rows and FTS entries without private URLs or fixture poster paths", () => {
    const { db, repository } = repositoryWithFixtures();

    const featureRows = db.prepare("SELECT * FROM media_features").all() as Array<{ feature_text: string; vector_json: string }>;
    expect(featureRows.length).toBe(repository.list().length);
    expect(featureRows.every((row) => Object.keys(JSON.parse(row.vector_json)).length > 0)).toBe(true);
    const serialized = JSON.stringify(featureRows);
    expect(serialized).not.toContain("https://app.plex.tv");
    expect(serialized).not.toContain("http://fixture-seerr.local");
    expect(serialized).not.toContain("fixture://");

    const ftsHits = repository.searchFeatureIds("witty fantasy romance", 10);
    const hitTitles = ftsHits.map((hit) => repository.findById(hit.mediaItemId)?.title);
    expect(hitTitles).toEqual(expect.arrayContaining(["Stardust", "The Princess Bride"]));
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
    expect(titles).toEqual(expect.arrayContaining(["Stardust", "The Princess Bride"]));
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
      taste: expect.any(Number),
      availability: expect.any(Number),
      quality: expect.any(Number)
    });
  });

  it("keeps fallback explanations focused on fit instead of repeated metadata", () => {
    const { repository } = repositoryWithFixtures();
    const scored = scoreLibraryCandidates(repository.list(), "funny fantasy movie under two hours", {}, "group");

    for (const item of scored.results.slice(0, 5)) {
      expect(item.matchExplanation.toLowerCase().startsWith(item.title.toLowerCase())).toBe(false);
      expect(item.matchExplanation.toLowerCase()).not.toMatch(/\bruntime\b|\bcritic\b|\baudience\b|\buser rating\b|\b\d+\s*min\b/);
    }
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
      engineVersion: "hybrid-v2",
      candidateCount: expect.any(Number),
      rerankCandidateCount: expect.any(Number),
      seerrAugmented: true
    });
  });

  it("uses session feedback context without leaking raw prompt text", async () => {
    const { db, repository } = repositoryWithFixtures();
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const ranker: AiRanker = { rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates })) };
    const liked = repository.list().find((item) => item.title === "Paddington 2");
    const disliked = repository.list().find((item) => item.title === "The Do-Over");
    expect(liked).toBeTruthy();
    expect(disliked).toBeTruthy();

    const response = await new RecommendationEngine(repository, seerrClient, ranker).recommend({
      query: "feel-good comedy for tonight",
      watchContext: "group",
      feedbackContext: {
        moreLikeItemIds: [liked!.id],
        lessLikeItemIds: [disliked!.id],
        hiddenItemIds: [disliked!.id]
      }
    });

    expect(response.results.some((item) => item.id === disliked!.id)).toBe(false);
    const feedbackRows = db.prepare("SELECT feedback FROM recommendation_feedback ORDER BY id").all() as { feedback: string }[];
    expect(feedbackRows.map((row) => row.feedback)).toEqual(["up", "down", "hidden"]);
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

    const response = await new RecommendationEngine(repository, seerrClient, ranker).recommend({
      query: "feel-good comedy",
      useAi: false
    });

    expect(response.usedAi).toBe(false);
    expect(ranker.rank).not.toHaveBeenCalled();
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
    expect(result.failures).toEqual([]);
    expect(result.constraintAccuracy).toBe(1);
  });
});
