import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { NoopRanker, type AiRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { createReviewCandidateEngine } from "../src/server/recommendation/review/candidateEngine";
import type { SearchFilters } from "../src/shared/types";

const databases: ReturnType<typeof createDatabase>[] = [];
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Compound duration checks stay offline"); })));
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.unstubAllGlobals(); });
const durations = [30, 45, 60, 80, 90, 91, 120, 125, 150];
function engine(arm: "baseline" | "revisedCombined", ranker: AiRanker = new NoopRanker()) {
  const db = createDatabase(":memory:"); databases.push(db);
  const repository = new MediaRepository(db);
  repository.upsertMany(durations.map(minutes => ({ title: `Duration ${minutes}`, mediaType: "movie" as const, genres: ["Drama"],
    summary: "A warm and witty account of an investigation.", runtimeMinutes: minutes, year: 2005,
    plex: { available: true, ratingKey: `compound-${minutes}` } })));
  return createReviewCandidateEngine({ repository, ranker,
    seerrClient: { allowsDescriptiveContent: () => false } as unknown as SeerrClient }, arm);
}

// Predeclared arithmetic oracle: descending hour/minute quantities add; explicit
// between/from and to/hyphen ranges retain endpoints. Expected bounds are data,
// not values obtained from the parser under test. Filters and final membership
// protect the hard eligibility contract, including the inclusive boundary.
const cases: Array<[string, SearchFilters]> = [
  ["under 1 hour and 30 minutes", { maxRuntimeMinutes: 90 }],
  ["under one hour and thirty minutes", { maxRuntimeMinutes: 90 }],
  ["under 1 hr and 30 mins", { maxRuntimeMinutes: 90 }],
  ["under 1h 30m", { maxRuntimeMinutes: 90 }],
  ["under 1 hour 30 minutes", { maxRuntimeMinutes: 90 }],
  ["under 90 minutes", { maxRuntimeMinutes: 90 }],
  ["not under 1 hour and 30 minutes", { minRuntimeMinutes: 90 }],
  ["not over 1 hour and 30 minutes", { maxRuntimeMinutes: 90 }],
  ["that doesn't run over 1 hour and 30 minutes", { maxRuntimeMinutes: 90 }],
  ["no more than one hour and thirty minutes", { maxRuntimeMinutes: 90 }],
  ["at least 1 hour and 30 minutes", { minRuntimeMinutes: 90 }],
  ["1 hour and 30 minutes maximum", { maxRuntimeMinutes: 90 }],
  ["under two hours and five minutes", { maxRuntimeMinutes: 125 }],
  ["between 30 minutes and 1 hour", { minRuntimeMinutes: 30, maxRuntimeMinutes: 60 }],
  ["between 1 hour and 30 minutes", { minRuntimeMinutes: 30, maxRuntimeMinutes: 60 }],
  ["from 30 minutes to 1 hour", { minRuntimeMinutes: 30, maxRuntimeMinutes: 60 }],
  ["30 to 90 minutes", { minRuntimeMinutes: 30, maxRuntimeMinutes: 90 }],
  ["from 1 hour and 30 minutes to 2 hours", { minRuntimeMinutes: 90, maxRuntimeMinutes: 120 }],
  ["between 1 hour and 30 minutes and 2 hours", { minRuntimeMinutes: 90, maxRuntimeMinutes: 120 }],
  ["over 1 hour and 30 minutes and under 2 hours and 5 minutes", { minRuntimeMinutes: 90, maxRuntimeMinutes: 125 }],
  ["under 1 hour and 30 minutes and over 2 hours", { minRuntimeMinutes: 120, maxRuntimeMinutes: 90 }]
];

describe.each(["baseline", "revisedCombined"] as const)("compound duration grammar through %s", arm => {
  it.each(cases)("resolves and applies %s", async (clause, filters) => {
    const response = await engine(arm).recommend({ query: `a movie ${clause}`, useAi: false, resultLimit: 10 });
    expect(response.resolvedFilters.minRuntimeMinutes).toBe(filters.minRuntimeMinutes);
    expect(response.resolvedFilters.maxRuntimeMinutes).toBe(filters.maxRuntimeMinutes);
    expect(response.results.map(row => row.runtimeMinutes).sort((a, b) => a! - b!))
      .toEqual(durations.filter(n => n >= (filters.minRuntimeMinutes ?? 0) && n <= (filters.maxRuntimeMinutes ?? Infinity)));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves explicit filter authority over a compound request", async () => {
    const response = await engine(arm).recommend({ query: "a movie under 1 hour and 30 minutes",
      filters: { minRuntimeMinutes: 120, maxRuntimeMinutes: 125 }, useAi: false, resultLimit: 10 });
    expect(response.results.map(row => row.runtimeMinutes).sort((a, b) => a! - b!)).toEqual([120, 125]);
  });

  it("replaces a compound bound with a marked compound correction and then clears it", async () => {
    const source = engine(arm);
    const query = "a movie under 1 hour and 30 minutes\nFollow-up refinement: not under 2 hours and 5 minutes";
    const corrected = await source.recommend({ query, useAi: false, resultLimit: 10 });
    expect(corrected.resolvedFilters.minRuntimeMinutes).toBe(125);
    expect(corrected.resolvedFilters.maxRuntimeMinutes).toBeUndefined();
    expect(corrected.results.map(row => row.runtimeMinutes).sort((a, b) => a! - b!)).toEqual([125, 150]);
    const cleared = await source.recommend({ query: query + "\nFollow-up refinement: any runtime", useAi: false, resultLimit: 10 });
    expect(cleared.resolvedFilters.minRuntimeMinutes).toBeUndefined();
    expect(cleared.resolvedFilters.maxRuntimeMinutes).toBeUndefined();
    expect(cleared.results.map(row => row.runtimeMinutes).sort((a, b) => a! - b!)).toEqual(durations);
  });

  it("does not turn additive quantity words into mood facets", async () => {
    const source = engine(arm);
    const simple = await source.recommend({ query: "a warm and witty movie under 90 minutes", useAi: false, resultLimit: 10 });
    const compound = await source.recommend({ query: "a warm and witty movie under 1 hour and 30 minutes", useAi: false, resultLimit: 10 });
    expect(compound.resolvedFilters).toEqual(simple.resolvedFilters);
    expect(compound.results.map(row => ({ title: row.title, mood: row.scoreBreakdown?.mood })))
      .toEqual(simple.results.map(row => ({ title: row.title, mood: row.scoreBreakdown?.mood })));
    expect(compound.results.some(row => /not established[^.]*(?:hour|minutes|thirty)/i.test(row.matchExplanation ?? ""))).toBe(false);
  });
});

it("retains compound eligibility through an offline timeout", async () => {
  const rank = vi.fn<AiRanker["rank"]>(async ({ candidates }) => ({ usedAi: false, results: candidates, failureCategory: "timeout" }));
  const response = await engine("baseline", { rank }).recommend({ query: "a movie under 1 hour and 30 minutes", useAi: true, resultLimit: 10 });
  expect(rank).toHaveBeenCalledTimes(1);
  expect(rank.mock.calls[0][0].candidates.map(row => row.runtimeMinutes).sort((a, b) => a! - b!)).toEqual([30, 45, 60, 80, 90]);
  expect(response.results.map(row => row.runtimeMinutes).sort((a, b) => a! - b!)).toEqual([30, 45, 60, 80, 90]);
  expect(response.usedAi).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});
