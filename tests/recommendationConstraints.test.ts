import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository, type IngestMediaRecord } from "../src/server/db/mediaRepository";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import { parseRecommendationIntent } from "../src/server/recommendation/intent";
import { scoreLibraryCandidates } from "../src/server/recommendation/scoring";
import { NoopRanker } from "../src/server/ai/ranker";
import type { BriefParser } from "../src/server/ai/briefParser";
import type { QueryOptimizer } from "../src/server/ai/queryOptimizer";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { extractRuntimeRange } from "../src/shared/runtime";

const databases: DatabaseSync[] = [];

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Constraint tests must remain offline."); }));
});

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.unstubAllGlobals();
});

function record(title: string, overrides: Partial<IngestMediaRecord> = {}): IngestMediaRecord {
  return {
    title,
    mediaType: "movie",
    year: 2018,
    runtimeMinutes: 80,
    summary: "A gentle comedy about friendship.",
    genres: ["Comedy"],
    cast: [],
    directors: [],
    ratings: {},
    externalIds: {},
    plex: { ratingKey: title, guid: `test:${title}`, libraryTitle: "Test", libraryType: "movie", available: true },
    ...overrides
  };
}

function engineFor(records: IngestMediaRecord[], queryOptimizer?: QueryOptimizer, briefParser?: BriefParser) {
  const db = createDatabase(":memory:");
  databases.push(db);
  const repository = new MediaRepository(db);
  repository.upsertMany(records);
  const seerr = {
    allowsDescriptiveContent: () => false,
    search: vi.fn(async () => { throw new Error("Constraint tests must not search Seerr."); })
  } as unknown as SeerrClient;
  return {
    repository,
    engine: new RecommendationEngine(repository, seerr, new NoopRanker(), undefined, briefParser, undefined, queryOptimizer)
  };
}

describe("authoritative constraint parsing", () => {
  it.each([
    ["over 120 minutes and under 90 minutes", { minRuntimeMinutes: 120, maxRuntimeMinutes: 90 }],
    ["under two hours and under 90 minutes", { maxRuntimeMinutes: 90 }],
    ["no more than 90 minutes", { maxRuntimeMinutes: 90 }],
    ["no less than 90 minutes", { minRuntimeMinutes: 90 }],
    ["between 95 and 110 minutes, under 100 minutes", { minRuntimeMinutes: 95, maxRuntimeMinutes: 100 }],
    ["90 minutes maximum", { maxRuntimeMinutes: 90 }]
  ])("intersects explicit runtime bounds in %s", (query, expected) => {
    expect(extractRuntimeRange(query)).toEqual(expected);
  });

  it("retains contradictory year bounds and the strictest repeated bound", () => {
    expect(parseRecommendationIntent("movie since 2020 and before 2010").hardFilters).toMatchObject({ minYear: 2020, maxYear: 2009 });
    expect(parseRecommendationIntent("movie since 2000 and after 2010").hardFilters.minYear).toBe(2011);
  });

  it("replaces only the facet named in a marked refinement", () => {
    const intent = parseRecommendationIntent(
      "movie under 90 minutes, not horror, since 2010, in Plex\nFollow-up refinement: under 120 minutes\nFollow-up refinement: make it warmer"
    );
    expect(intent.hardFilters).toMatchObject({
      mediaTypes: ["movie"], maxRuntimeMinutes: 120, excludedGenres: ["Horror"], minYear: 2010, availability: ["available_in_plex"]
    });
  });

  it("keeps the TV scope for a runtime-only refinement", () => {
    expect(parseRecommendationIntent("a TV series\nFollow-up refinement: under 30 minutes").hardFilters).toMatchObject({
      mediaTypes: ["tv"], maxRuntimeMinutes: 30
    });
    expect(parseRecommendationIntent("short comedy series").hardFilters.maxRuntimeMinutes).toBe(45);
    expect(parseRecommendationIntent("short comedy series under 30 minutes").hardFilters.maxRuntimeMinutes).toBe(30);
  });

  it("retains constraints when a later relaxation is not explicit", () => {
    expect(parseRecommendationIntent("movie under 90 minutes, not horror\nFollow-up refinement: maybe loosen things up").hardFilters).toMatchObject({
      maxRuntimeMinutes: 90, excludedGenres: ["Horror"]
    });
  });

  it("supports existing explicit clear commands without clearing other facets", () => {
    const intent = parseRecommendationIntent(
      "movie under 90 minutes, not horror, since 2010, in Plex\nFollow-up refinement: any runtime; any genre; clear availability"
    );
    expect(intent.hardFilters).toMatchObject({ mediaTypes: ["movie"], minYear: 2010 });
    expect(intent.hardFilters.maxRuntimeMinutes).toBeUndefined();
    expect(intent.hardFilters.excludedGenres).toEqual([]);
    expect(intent.hardFilters.availability).toBeUndefined();
    expect(intent.guardrailQuery).not.toContain("not horror");
  });
});

describe("constraints in the final recommendation response", () => {
  const longQuery = `${"a warm funny story about friendship ".repeat(25)}; under 90 minutes; not horror; since 2010; in Plex`;
  const boundedCatalog = () => [
    record("Eligible choice"),
    record("Too long", { runtimeMinutes: 130 }),
    record("Excluded genre", { genres: ["Horror"] }),
    record("Too old", { year: 2000 }),
    record("Unknown runtime", { runtimeMinutes: undefined }),
    record("Unknown year", { year: undefined })
  ];

  it("preserves late hard constraints after deterministic query shortening", async () => {
    const { engine } = engineFor(boundedCatalog());
    const response = await engine.recommend({ query: longQuery, useAi: false, resultLimit: 10 });
    expect(response.optimizedQuery.length).toBeLessThanOrEqual(600);
    expect(response.resolvedFilters).toMatchObject({ maxRuntimeMinutes: 90, excludedGenres: ["Horror"], minYear: 2010, availability: ["available_in_plex"] });
    expect(response.results.map((item) => item.title)).toEqual(["Eligible choice"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("ignores weakened constraints from optimization and AI brief parsing", async () => {
    const optimizer: QueryOptimizer = { optimize: vi.fn(async () => ({ usedAi: true, query: "a long horror movie" })) };
    const parser: BriefParser = {
      parse: vi.fn<BriefParser["parse"]>(async () => ({
        usedAi: true,
        signals: { hardFilters: { maxRuntimeMinutes: 240, excludedGenres: [], minYear: 1900, availability: ["unavailable"] } }
      }))
    };
    const { engine } = engineFor(boundedCatalog(), optimizer, parser);
    const response = await engine.recommend({ query: longQuery, useAi: true, resultLimit: 10 });
    expect(parser.parse).toHaveBeenCalledWith(expect.objectContaining({ query: longQuery }));
    expect(response.optimizedQuery).toBe("a long horror movie");
    expect(response.resolvedFilters).toMatchObject({ maxRuntimeMinutes: 90, excludedGenres: ["Horror"], minYear: 2010, availability: ["available_in_plex"] });
    expect(response.results.map((item) => item.title)).toEqual(["Eligible choice"]);
  });

  it("honors a deliberate later runtime correction in scoring as well as retrieval", async () => {
    const { engine } = engineFor([record("Longer choice", { runtimeMinutes: 110 })]);
    const response = await engine.recommend({
      query: "comedy movie under 90 minutes, not horror\nFollow-up refinement: under 120 minutes",
      useAi: false
    });
    expect(response.resolvedFilters.maxRuntimeMinutes).toBe(120);
    expect(response.results.map((item) => item.title)).toEqual(["Longer choice"]);
  });

  it("lets explicit UI filters override inferred type, runtime and year", async () => {
    const { engine } = engineFor([record("Explicit TV choice", { mediaType: "tv", year: 2005, runtimeMinutes: 110 })]);
    const response = await engine.recommend({
      query: "comedy movie under 90 minutes since 2010",
      filters: { mediaTypes: ["tv"], maxRuntimeMinutes: 120, minYear: 2000 },
      useAi: false
    });
    expect(response.resolvedFilters).toMatchObject({ mediaTypes: ["tv"], maxRuntimeMinutes: 120, minYear: 2000 });
    expect(response.results.map((item) => item.title)).toEqual(["Explicit TV choice"]);
  });

  it.each([false, true])("does not reintroduce cleared constraints while scoring the shortened query (AI: %s)", async (useAi) => {
    const parser: BriefParser = {
      parse: vi.fn(async () => ({ usedAi: true, signals: { hardFilters: { maxRuntimeMinutes: 90, excludedGenres: ["Horror"] } } }))
    };
    const { engine } = engineFor([record("Long choice", { runtimeMinutes: 130, genres: ["Horror"] })], undefined, parser);
    const response = await engine.recommend({
      query: `comedy movie under 90 minutes, not horror; ${"a film about friendship ".repeat(30)}\nFollow-up refinement: any runtime; any genre`,
      useAi
    });
    expect(response.optimizedQuery).toContain("under 90 minutes");
    expect(response.resolvedFilters.maxRuntimeMinutes).toBeUndefined();
    expect(response.resolvedFilters.excludedGenres).toBeUndefined();
    expect(response.results.map((item) => item.title)).toEqual(["Long choice"]);
  });

  it.each(["over 120 minutes and under 90 minutes", "since 2020 and before 2010"])("returns no result for conflicting constraints: %s", async (constraints) => {
    const { engine } = engineFor([record("Candidate", { runtimeMinutes: 80 }), record("Other candidate", { runtimeMinutes: 140, year: 2024 })]);
    const response = await engine.recommend({ query: `comedy movie ${constraints}`, useAi: false });
    expect(response.results).toEqual([]);
  });

  it("never restores a disqualified candidate for a negative-only query", async () => {
    const { engine, repository } = engineFor([record("A Horror Movie", { genres: ["Drama"], summary: "A scary haunted-house story with supernatural terror." })]);
    const scored = scoreLibraryCandidates(repository.list(), "not scary", {}, "solo", { captureScoreTrace: true });
    expect(scored.intent.terms).toEqual([]);
    expect([...scored.scoreTrace!.computationByItemId.values()]).toEqual([expect.objectContaining({ disqualified: true })]);
    expect(scored.results).toEqual([]);
    const response = await engine.recommend({ query: "not scary", useAi: false });
    expect(response.sessionId).toBeDefined();
    expect(response.results).toEqual([]);
  });

  it("preserves late text guardrails when sparse metadata cannot enforce the genre filter", async () => {
    const { engine } = engineFor([record("A Horror Movie", { genres: ["Drama"], summary: "A scary haunted-house story with supernatural terror." })]);
    const response = await engine.recommend({ query: `${"watch something ".repeat(50)}not scary`, useAi: false });
    expect(response.optimizedQuery).not.toContain("not scary");
    expect(response.results).toEqual([]);
  });
});
