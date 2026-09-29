import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { createReviewCandidateEngine } from "../src/server/recommendation/review/candidateEngine";
import { refinementOperationalPromises } from "../src/server/recommendation/refinementPromises";
import type { AiRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import type { RefinementOption, SearchFilters } from "../src/shared/types";

const databases: ReturnType<typeof createDatabase>[] = [];
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Rating keyword tests stay offline."); })));
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.unstubAllGlobals(); });
type Arm = "baseline" | "revisedCombined";
async function recommend(arm: Arm, option: RefinementOption, filters: SearchFilters = { contentRating: "PG" }) {
  const db = createDatabase(":memory:"); databases.push(db);
  const repository = new MediaRepository(db);
  repository.upsertMany([{ title: "Amber Ledger", mediaType: "movie", genres: ["Drama"], contentRating: "PG", runtimeMinutes: 80,
    summary: "A thoughtful account of an investigation.", plex: { available: true, ratingKey: "rating-keywords" } }]);
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

interface KeywordCase {
  name: string;
  statement: string;
  positive: string[];
  excluded: string[];
  state: "resolved" | "unresolved";
  compatible: boolean;
}
const keywordCases: KeywordCase[] = [
  { name: "lowercase unknown positive connector", statement: "Show movies rated PG or FSK 16.", positive: ["PG"], excluded: [], state: "unresolved", compatible: false },
  { name: "uppercase unknown positive connector", statement: "Show movies rated PG OR FSK 16.", positive: ["PG"], excluded: [], state: "unresolved", compatible: false },
  { name: "mixed connector and authority", statement: "Show movies rated PG oR fSk 16.", positive: ["PG"], excluded: [], state: "unresolved", compatible: false },
  { name: "lowercase negative repeated predicate", statement: "Show movies neither rated R nor rated FSK 16.", positive: [], excluded: ["R"], state: "unresolved", compatible: false },
  { name: "uppercase keywords lowercase authority", statement: "Show movies NEITHER RATED R NOR RATED fsk 16.", positive: [], excluded: ["R"], state: "unresolved", compatible: false },
  { name: "mixed negative continuation keywords", statement: "Show movies NeItHeR RaTeD R nOr RaTeD FsK 16.", positive: [], excluded: ["R"], state: "unresolved", compatible: false },
  { name: "lowercase known exclusions", statement: "Show movies neither rated R nor PG.", positive: [], excluded: ["R", "PG"], state: "resolved", compatible: false },
  { name: "uppercase known exclusions", statement: "Show movies NEITHER RATED R NOR RATED PG.", positive: [], excluded: ["R", "PG"], state: "resolved", compatible: false },
  { name: "mixed known exclusions", statement: "Show movies NeItHeR RaTeD R nOr RaTeD PG.", positive: [], excluded: ["R", "PG"], state: "resolved", compatible: false },
  { name: "lowercase harmless exclusions", statement: "Show movies neither rated R nor NC-17.", positive: [], excluded: ["R", "NC-17"], state: "resolved", compatible: true },
  { name: "uppercase harmless exclusions", statement: "Show movies NEITHER RATED R NOR RATED NC-17.", positive: [], excluded: ["R", "NC-17"], state: "resolved", compatible: true },
  { name: "mixed harmless exclusions", statement: "Show movies NeItHeR RaTeD R nOr RaTeD NC-17.", positive: [], excluded: ["R", "NC-17"], state: "resolved", compatible: true },
  { name: "uppercase mixed sign compatible", statement: "Show movies RATED PG AND NOT R.", positive: ["PG"], excluded: ["R"], state: "resolved", compatible: true },
  { name: "mixed case positive cannot cancel exclusion", statement: "Show movies RaTeD PG AnD nOt PG.", positive: ["PG"], excluded: ["PG"], state: "resolved", compatible: false },
  { name: "neutral narrative continuation", statement: "Show movies rated PG and focus on friendship.", positive: ["PG"], excluded: [], state: "resolved", compatible: true },
  { name: "uppercase connector is not lowercase code authority", statement: "Show movies rated PG AND gentle.", positive: ["PG"], excluded: [], state: "resolved", compatible: true },
  { name: "mixed connector is not lowercase code authority", statement: "Show movies rated PG AnD gentle.", positive: ["PG"], excluded: [], state: "resolved", compatible: true },
  { name: "uppercase I renewed prose", statement: "Show movies rated PG AND I want a story about friendship.", positive: ["PG"], excluded: [], state: "resolved", compatible: true },
  { name: "uppercase A renewed prose", statement: "Show movies rated PG, A story about friendship would be welcome.", positive: ["PG"], excluded: [], state: "resolved", compatible: true },
  { name: "uppercase repeated predicate lowercase BBFC", statement: "Show movies rated PG OR RATED bbfc 12A.", positive: ["PG"], excluded: [], state: "unresolved", compatible: false }
];

describe("J3 signed rating state across keyword case", () => {
  it.each(keywordCases)("retains semantic state: $name", ({ statement, positive, excluded, state }) => {
    const result = refinementOperationalPromises(statement);
    expect(result.contentRatings.toSorted()).toEqual(positive.toSorted());
    expect(result.excludedContentRatings.toSorted()).toEqual(excluded.toSorted());
    expect(result.contentRatingState).toBe(state);
  });
});

describe.each(["baseline", "revisedCombined"] as const)("J3 final keyword-case promises through %s", arm => {
  for (const scenario of keywordCases) {
    it.each(["label", "prompt"] as const)(`${scenario.name} on %s`, async surface => {
      const option = { label: surface === "label" ? scenario.statement : "PG-rated movies",
        prompt: surface === "prompt" ? scenario.statement : "Show movies rated PG." };
      const options = await recommend(arm, option);
      if (scenario.compatible) expect(options).toContainEqual(option);
      else expect(options).not.toContainEqual(option);
    });
  }

  for (const statement of ["Show movies rated PG OR FSK 16.", "Show movies NeItHeR RaTeD R nOr RaTeD FsK 16."]) {
    it.each(["label", "prompt"] as const)(`does not invent an active rating constraint for ${statement} on %s`, async surface => {
      const option = { label: surface === "label" ? statement : "Another direction",
        prompt: surface === "prompt" ? statement : "Keep the same feeling." };
      expect(await recommend(arm, option, {})).toContainEqual(option);
    });
  }
});
