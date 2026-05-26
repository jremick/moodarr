import { describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { fixturePlexItems, fixtureSeerrItems } from "../src/server/fixtures/media";
import { parseRecommendationIntent } from "../src/server/recommendation/intent";
import { scoreLibraryCandidates } from "../src/server/recommendation/scoring";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import type { AiRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { evaluateRecommendationResults, goldenRecommendationCases } from "../src/server/recommendation/evaluation";
import { deriveChatCriteria } from "../src/client/chatCriteria";

function repositoryWithFixtures(records = [...fixturePlexItems, ...fixtureSeerrItems]) {
  const db = createDatabase(":memory:");
  const repository = new MediaRepository(db);
  repository.upsertMany(records);
  return { db, repository };
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
});

describe("recommendation scoring", () => {
  it("enforces hard runtime filters while keeping query genres as soft signals", () => {
    const { repository } = repositoryWithFixtures();
    const scored = scoreLibraryCandidates(repository.list(), "funny fantasy movie under two hours", {}, "group");

    expect(scored.results.every((item) => item.mediaType === "movie")).toBe(true);
    expect(scored.results.every((item) => !item.runtimeMinutes || item.runtimeMinutes <= 120)).toBe(true);
    expect(scored.results.some((item) => item.title === "The Princess Bride")).toBe(true);
    expect(scored.results.some((item) => item.title === "Stardust")).toBe(false);
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

    expect(seerrClient.search).toHaveBeenCalled();
    expect(response.results.some((item) => item.title === "The Princess Bride")).toBe(true);
    expect(response.summary).toContain("I’m looking for");
    expect(response.resolvedFilters).toBeDefined();
    expect(ranker.rank).toHaveBeenCalled();
    expect(event.query_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(event)).not.toContain("Princess Bride requestable");
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
