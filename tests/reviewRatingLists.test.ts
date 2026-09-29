import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { createReviewCandidateEngine } from "../src/server/recommendation/review/candidateEngine";
import { refinementOperationalPromises } from "../src/server/recommendation/refinementPromises";
import type { AiRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import type { RefinementOption, SearchFilters } from "../src/shared/types";

const databases: ReturnType<typeof createDatabase>[] = [];
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Rating-list tests stay offline."); })));
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.unstubAllGlobals(); });
type Arm = "baseline" | "revisedCombined";
async function recommend(arm: Arm, option: RefinementOption, filters: SearchFilters = { contentRating: "PG" }) {
  const db = createDatabase(":memory:"); databases.push(db);
  const repository = new MediaRepository(db);
  repository.upsertMany([{ title: "Amber Ledger", mediaType: "movie", genres: ["Drama"], contentRating: "PG", runtimeMinutes: 80,
    summary: "A thoughtful account of an investigation.", plex: { available: true, ratingKey: "rating-lists" } }]);
  const rank = vi.fn<AiRanker["rank"]>(async ({ candidates }) => ({ usedAi: true, results: candidates, refinementOptions: [option] }));
  const engine = createReviewCandidateEngine({ repository, ranker: { rank },
    seerrClient: { allowsDescriptiveContent: () => false } as unknown as SeerrClient }, arm);
  const result = await engine.recommend({ query: "a movie", filters, useAi: true, resultLimit: 10 });
  expect(rank).toHaveBeenCalledTimes(1);
  expect(result.aiRerank.status).toBe("applied");
  expect(result.results.map(item => item.title)).toContain("Amber Ledger");
  expect(result.resolvedFilters).toMatchObject(filters);
  expect(fetch).not.toHaveBeenCalled();
  return result.refinementOptions;
}

interface RatingCase {
  name: string;
  statement: string;
  positive: string[];
  excluded: string[];
  state: "resolved" | "unresolved";
  compatible: boolean;
}
const ratingCases: RatingCase[] = [
  { name: "active rating last", statement: "Show movies neither rated R nor PG.", positive: [], excluded: ["R", "PG"], state: "resolved", compatible: false },
  { name: "active rating first", statement: "Show movies neither rated PG nor R.", positive: [], excluded: ["PG", "R"], state: "resolved", compatible: false },
  { name: "repeated predicate active last", statement: "Show movies neither rated R nor rated PG.", positive: [], excluded: ["R", "PG"], state: "resolved", compatible: false },
  { name: "repeated predicate active first", statement: "Show movies neither rated PG nor rated R.", positive: [], excluded: ["PG", "R"], state: "resolved", compatible: false },
  { name: "harmless exclusions", statement: "Show movies neither rated R nor NC-17.", positive: [], excluded: ["R", "NC-17"], state: "resolved", compatible: true },
  { name: "permuted repeated harmless exclusions", statement: "Show movies neither rated NC-17 nor rated R.", positive: [], excluded: ["NC-17", "R"], state: "resolved", compatible: true },
  { name: "all three exclusions survive", statement: "Show movies neither rated R nor NC-17 nor PG.", positive: [], excluded: ["R", "NC-17", "PG"], state: "resolved", compatible: false },
  { name: "not-or negative list", statement: "Show movies not rated R or PG.", positive: [], excluded: ["R", "PG"], state: "resolved", compatible: false },
  { name: "positive value and negative continuation", statement: "Show movies rated PG, not R or NC-17.", positive: ["PG"], excluded: ["R", "NC-17"], state: "resolved", compatible: true },
  { name: "negative list followed by positive value", statement: "Show movies neither rated R nor NC-17, but rated PG.", positive: ["PG"], excluded: ["R", "NC-17"], state: "resolved", compatible: true },
  { name: "positive value cannot erase later exclusion", statement: "Show movies rated PG, but neither rated R nor PG.", positive: ["PG"], excluded: ["R", "PG"], state: "resolved", compatible: false },
  { name: "positive incompatible alternative", statement: "Show movies rated PG or R.", positive: ["PG", "R"], excluded: [], state: "resolved", compatible: false },
  { name: "not-only remains positive", statement: "Show movies not only rated PG.", positive: ["PG"], excluded: [], state: "resolved", compatible: true },
  { name: "unsupported negative continuation", statement: "Show movies neither rated R nor BBFC 12A.", positive: [], excluded: ["R"], state: "unresolved", compatible: false },
  { name: "unsupported repeated negative predicate", statement: "Show movies neither rated R nor rated BBFC 12A.", positive: [], excluded: ["R"], state: "unresolved", compatible: false },
  { name: "unsupported positive continuation", statement: "Show movies rated PG or BBFC 12A.", positive: ["PG"], excluded: [], state: "unresolved", compatible: false },
  { name: "unsupported repeated positive predicate", statement: "Show movies rated PG or rated BBFC 12A.", positive: ["PG"], excluded: [], state: "unresolved", compatible: false },
  { name: "unsupported implicit certificate code", statement: "Show movies rated PG or 12A.", positive: ["PG"], excluded: [], state: "unresolved", compatible: false },
  { name: "neutral story continuation", statement: "Show movies rated PG and focus on friendship.", positive: ["PG"], excluded: [], state: "resolved", compatible: true },
  { name: "neutral comma continuation", statement: "Show movies rated PG, with an unusual story.", positive: ["PG"], excluded: [], state: "resolved", compatible: true }
];

describe("I3 complete signed rating declarations", () => {
  it.each(ratingCases)("retains every signed value and state: $name", ({ statement, positive, excluded, state }) => {
    const result = refinementOperationalPromises(statement);
    expect(result.contentRatings.toSorted()).toEqual(positive.toSorted());
    expect(result.excludedContentRatings.toSorted()).toEqual(excluded.toSorted());
    expect(result.contentRatingState).toBe(state);
  });
});

describe.each(["baseline", "revisedCombined"] as const)("I3 final rating-list promises through %s", arm => {
  for (const scenario of ratingCases) {
    it.each(["label", "prompt"] as const)(`${scenario.name} on %s`, async surface => {
      const option = { label: surface === "label" ? scenario.statement : "Another direction",
        prompt: surface === "prompt" ? scenario.statement : "Keep the same feeling." };
      const options = await recommend(arm, option);
      if (scenario.compatible) expect(options).toContainEqual(option);
      else expect(options).not.toContainEqual(option);
    });
  }

  for (const scenario of [
    { name: "renewed first-person clause", statement: "Show movies rated PG, I want a story about friendship.", compatible: true },
    { name: "coordinated renewed clause", statement: "Show movies rated PG and We want a story about friendship.", compatible: true },
    { name: "capital-initial narrative clause", statement: "Show movies rated PG, A story about friendship would be welcome.", compatible: true },
    { name: "actual unknown certificate continuation", statement: "Show movies rated PG or BBFC 12A.", compatible: false }
  ]) {
    it.each(["label", "prompt"] as const)(`${scenario.name} on %s`, async surface => {
      const option = { label: surface === "label" ? scenario.statement : "PG-rated movies",
        prompt: surface === "prompt" ? scenario.statement : "Show movies rated PG." };
      const options = await recommend(arm, option);
      if (scenario.compatible) expect(options).toContainEqual(option);
      else expect(options).not.toContainEqual(option);
    });
  }

  it.each([
    { label: "PG-rated movies", prompt: "Show movies neither rated R nor PG.", compatible: false },
    { label: "Neither rated R nor PG", prompt: "Show movies rated PG.", compatible: false },
    { label: "PG-rated movies", prompt: "Show movies neither rated R nor NC-17.", compatible: true },
    { label: "Neither rated R nor NC-17", prompt: "Show movies rated PG.", compatible: true }
  ])("keeps signed promises on both surfaces: $label / $prompt", async ({ label, prompt, compatible }) => {
    const option = { label, prompt };
    const options = await recommend(arm, option);
    if (compatible) expect(options).toContainEqual(option);
    else expect(options).not.toContainEqual(option);
  });

  it.each([
    "Show movies neither rated R nor BBFC 12A.",
    "Show movies rated PG or BBFC 12A."
  ])("does not invent an active rating filter for an unresolved list: %s", async prompt => {
    const option = { label: "Another direction", prompt };
    expect(await recommend(arm, option, {})).toContainEqual(option);
  });
});
