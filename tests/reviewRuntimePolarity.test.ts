import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { NoopRanker, type AiRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { createReviewCandidateEngine } from "../src/server/recommendation/review/candidateEngine";
import type { SearchFilters } from "../src/shared/types";

const databases: ReturnType<typeof createDatabase>[] = [];
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Runtime polarity checks must remain offline"); })));
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.unstubAllGlobals(); });
const durations = [80, 89, 90, 91, 110];
function engine(arm: "baseline" | "revisedCombined", ranker: AiRanker = new NoopRanker()) {
  const db = createDatabase(":memory:"); databases.push(db);
  const repository = new MediaRepository(db);
  repository.upsertMany(durations.map(minutes => ({ title: `Duration ${minutes}`, mediaType: "movie" as const, genres: ["Drama"],
    summary: "A thoughtful account of an investigation.", runtimeMinutes: minutes, year: 2005,
    plex: { available: true, ratingKey: `duration-${minutes}` } })));
  return createReviewCandidateEngine({ repository, ranker,
    seerrClient: { allowsDescriptiveContent: () => false } as unknown as SeerrClient }, arm);
}

// The user's comparison and its denial are one constraint. Boundary equality
// follows the existing inclusive runtime contract, including negated operators.
const cases: Array<[string, SearchFilters, number[]]> = [
  ["not under 90 minutes", { minRuntimeMinutes: 90 }, [90, 91, 110]],
  ["not over 90 minutes", { maxRuntimeMinutes: 90 }, [80, 89, 90]],
  ["not below ninety minutes", { minRuntimeMinutes: 90 }, [90, 91, 110]],
  ["not less than 1.5 hours", { minRuntimeMinutes: 90 }, [90, 91, 110]],
  ["not more than 90 minutes", { maxRuntimeMinutes: 90 }, [80, 89, 90]],
  ["not shorter than 90 minutes", { minRuntimeMinutes: 90 }, [90, 91, 110]],
  ["not longer than 90 minutes", { maxRuntimeMinutes: 90 }, [80, 89, 90]],
  ["that isn't under 90 minutes", { minRuntimeMinutes: 90 }, [90, 91, 110]],
  ["that isn't over 90 minutes", { maxRuntimeMinutes: 90 }, [80, 89, 90]],
  ["that doesn't run over 90 minutes", { maxRuntimeMinutes: 90 }, [80, 89, 90]],
  ["never under 90 minutes", { minRuntimeMinutes: 90 }, [90, 91, 110]],
  ["no shorter than 90 minutes", { minRuntimeMinutes: 90 }, [90, 91, 110]],
  ["no longer than 90 minutes", { maxRuntimeMinutes: 90 }, [80, 89, 90]],
  ["that is not under 90 minutes", { minRuntimeMinutes: 90 }, [90, 91, 110]],
  ["not only under 90 minutes but also over 80 minutes", { minRuntimeMinutes: 80, maxRuntimeMinutes: 90 }, [80, 89, 90]],
  ["no more than 90 minutes", { maxRuntimeMinutes: 90 }, [80, 89, 90]],
  ["no less than 90 minutes", { minRuntimeMinutes: 90 }, [90, 91, 110]],
  ["at least 90 minutes", { minRuntimeMinutes: 90 }, [90, 91, 110]],
  ["under 90 minutes", { maxRuntimeMinutes: 90 }, [80, 89, 90]],
  ["not under 89 minutes and not over 91 minutes", { minRuntimeMinutes: 89, maxRuntimeMinutes: 91 }, [89, 90, 91]],
  ["not under 91 minutes and not over 89 minutes", { minRuntimeMinutes: 91, maxRuntimeMinutes: 89 }, []],
  ["between 80 and 110 minutes, not under 90 minutes", { minRuntimeMinutes: 90, maxRuntimeMinutes: 110 }, [90, 91, 110]]
];

describe.each(["baseline", "revisedCombined"] as const)("runtime comparison polarity through %s", arm => {
  it.each(cases)("applies %s before, at and after the inclusive boundary", async (clause, filters, expected) => {
    const result = await engine(arm).recommend({ query: `a movie ${clause}`, useAi: false, resultLimit: 10 });
    expect(result.resolvedFilters).toEqual(expect.objectContaining(filters));
    expect(result.results.map(row => row.runtimeMinutes).sort((a, b) => a! - b!)).toEqual(expected);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("allows a marked numeric correction to replace its earlier bound", async () => {
    const result = await engine(arm).recommend({ query: "a movie under 89 minutes\nFollow-up refinement: not under 90 minutes", useAi: false, resultLimit: 10 });
    expect(result.resolvedFilters.minRuntimeMinutes).toBe(90);
    expect(result.resolvedFilters.maxRuntimeMinutes).toBeUndefined();
    expect(result.results.map(row => row.runtimeMinutes).sort((a, b) => a! - b!)).toEqual([90, 91, 110]);
  });

  it("distinguishes an explicit runtime clear from a denied comparison", async () => {
    const result = await engine(arm).recommend({ query: "a movie not under 90 minutes\nFollow-up refinement: any runtime", useAi: false, resultLimit: 10 });
    expect(result.resolvedFilters.minRuntimeMinutes).toBeUndefined();
    expect(result.resolvedFilters.maxRuntimeMinutes).toBeUndefined();
    expect(result.results.map(row => row.runtimeMinutes).sort((a, b) => a! - b!)).toEqual(durations);
  });

  it("keeps explicit UI filters authoritative over a denied text bound", async () => {
    const result = await engine(arm).recommend({ query: "a movie not under 90 minutes", filters: { minRuntimeMinutes: 80, maxRuntimeMinutes: 89 }, useAi: false, resultLimit: 10 });
    expect(result.results.map(row => row.runtimeMinutes).sort((a, b) => a! - b!)).toEqual([80, 89]);
  });
});

it("preserves denied runtime bounds through an offline ranker timeout", async () => {
  const rank = vi.fn<AiRanker["rank"]>(async ({ candidates }) => ({ usedAi: false, results: candidates, failureCategory: "timeout" }));
  const result = await engine("baseline", { rank }).recommend({ query: "a movie not over 90 minutes", useAi: true, resultLimit: 10 });
  expect(rank).toHaveBeenCalledTimes(1);
  expect(rank.mock.calls[0][0].candidates.map(row => row.runtimeMinutes).sort((a, b) => a! - b!)).toEqual([80, 89, 90]);
  expect(result.results.map(row => row.runtimeMinutes).sort((a, b) => a! - b!)).toEqual([80, 89, 90]);
  expect(result.usedAi).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
});
