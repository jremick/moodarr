import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { createReviewCandidateEngine } from "../src/server/recommendation/review/candidateEngine";
import type { AiRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import type { RefinementOption, SearchFilters } from "../src/shared/types";

const databases: ReturnType<typeof createDatabase>[] = [];
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Negative promise tests stay offline."); })));
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.unstubAllGlobals(); });
type Arm = "baseline" | "revisedCombined";
const exact: SearchFilters = { contentRating: "PG", minRuntimeMinutes: 80, maxRuntimeMinutes: 80 };
async function recommend(arm: Arm, option: RefinementOption, filters: SearchFilters = exact, runtimeMinutes = 80) {
  const db = createDatabase(":memory:"); databases.push(db);
  const repository = new MediaRepository(db);
  repository.upsertMany([{ title: "Amber Ledger", mediaType: "movie", genres: ["Drama"], contentRating: "PG", runtimeMinutes,
    summary: "A thoughtful account of an investigation.", plex: { available: true, ratingKey: "negative-promises" } }]);
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

interface Scenario {
  name: string;
  statement: string;
  compatible: boolean;
  filters?: SearchFilters;
  runtimeMinutes?: number;
}
const scenarios: Scenario[] = [
  { name: "excluded active rating", statement: "Show movies not rated PG.", compatible: false },
  { name: "excluded other rating", statement: "Show movies not rated R.", compatible: true },
  { name: "avoid active rating", statement: "Avoid PG-rated films.", compatible: false },
  { name: "avoid other rating", statement: "Avoid R-rated films.", compatible: true },
  { name: "excluded rating list includes active value", statement: "Avoid PG-13 and PG-rated films.", compatible: false },
  { name: "excluded rating list leaves active value", statement: "Avoid PG-13 and R-rated films.", compatible: true },
  { name: "denied reverse rating declaration", statement: "Avoid movies with a PG rating.", compatible: false },
  { name: "compatible reverse rating denial", statement: "Avoid movies with an R rating.", compatible: true },
  { name: "denied exact runtime", statement: "Show movies that do not last 80 minutes.", compatible: false },
  { name: "denied other runtime", statement: "Show movies that do not last 120 minutes.", compatible: true },
  { name: "denied copular exact runtime", statement: "Show movies that are not 80 minutes in length.", compatible: false },
  { name: "denied copular other runtime", statement: "Show movies that are not 120 minutes in length.", compatible: true },
  { name: "contracted exact runtime denial", statement: "Show movies that aren’t 80 minutes in length.", compatible: false },
  { name: "contracted other runtime denial", statement: "Show movies that aren't 120 minutes in length.", compatible: true },
  { name: "avoid exact attributed duration", statement: "Avoid 80-minute movies.", compatible: false },
  { name: "avoid other attributed duration", statement: "Avoid 120-minute movies.", compatible: true },
  { name: "masked bound preserves compatible positive duration", statement: "Show movies under 80 minutes lasting 80 minutes.", compatible: true },
  { name: "masked bound preserves conflicting positive duration", statement: "Show movies under 80 minutes lasting 120 minutes.", compatible: false },
  { name: "masked bound preserves conflicting negative duration", statement: "Show movies under 80 minutes that do not last 80 minutes.", compatible: false },
  { name: "masked bound preserves compatible negative duration", statement: "Show movies under 80 minutes that do not last 120 minutes.", compatible: true },
  { name: "excluded point leaves an interval", statement: "Show movies that do not last 80 minutes.", compatible: true,
    filters: { minRuntimeMinutes: 75, maxRuntimeMinutes: 85 } },
  { name: "excluded point leaves an upper bound", statement: "Avoid 80-minute movies.", compatible: true,
    filters: { maxRuntimeMinutes: 90 } },
  { name: "not-only active rating remains affirmative", statement: "Show movies not only rated PG.", compatible: true },
  { name: "not-only other rating remains affirmative", statement: "Show movies not only rated R.", compatible: false },
  { name: "not-only exact duration remains affirmative", statement: "Show movies that are not only 80 minutes in length.", compatible: true },
  { name: "not-only other duration remains affirmative", statement: "Show movies that are not only 120 minutes in length.", compatible: false },
  { name: "a denied narrative event is not film runtime", statement: "Show movies about a rescue that does not last 80 minutes.", compatible: true },
  { name: "a narrative number is not film runtime", statement: "Show movies about 80 lost letters.", compatible: true },
  { name: "unknown positive rating stays unresolved", statement: "Show movies with a BBFC 12A rating.", compatible: false },
  { name: "unknown positive runtime stays unresolved", statement: "Show movies that last two and a half hours.", compatible: false },
  { name: "negative rating does not invent an active filter", statement: "Avoid PG-rated films.", compatible: true, filters: {} },
  { name: "negative runtime does not invent an active filter", statement: "Show movies that do not last 80 minutes.", compatible: true, filters: {} },
  { name: "compound exact runtime exceeds maximum", statement: "Show movies that last 1 hour and 30 minutes.", compatible: false,
    filters: { maxRuntimeMinutes: 80 } },
  { name: "compound exact runtime fits maximum", statement: "Show movies that last 1 hour and 30 minutes.", compatible: true,
    filters: { maxRuntimeMinutes: 100 } },
  { name: "denied compound excludes active exact runtime", statement: "Show movies that do not last 1 hour and 30 minutes.", compatible: false,
    filters: { minRuntimeMinutes: 90, maxRuntimeMinutes: 90 }, runtimeMinutes: 90 }
];

describe.each(["baseline", "revisedCombined"] as const)("H3 negative operational promises through %s", arm => {
  for (const scenario of scenarios) {
    it.each(["label", "prompt"] as const)(`${scenario.name} on %s`, async surface => {
      const option = { label: surface === "label" ? scenario.statement : "Another direction",
        prompt: surface === "prompt" ? scenario.statement : "Keep the same feeling." };
      const options = await recommend(arm, option, scenario.filters, scenario.runtimeMinutes);
      if (scenario.compatible) expect(options).toContainEqual(option);
      else expect(options).not.toContainEqual(option);
    });
  }

  it.each([
    { label: "PG-rated movies", prompt: "Show movies not rated PG.", compatible: false },
    { label: "Avoid PG-rated films", prompt: "Show movies with a PG rating.", compatible: false },
    { label: "80-minute movies", prompt: "Show movies that do not last 80 minutes.", compatible: false },
    { label: "Avoid 80-minute movies", prompt: "Show movies that last 80 minutes.", compatible: false },
    { label: "PG-rated movies", prompt: "Show movies not rated R.", compatible: true },
    { label: "80-minute movies", prompt: "Show movies that do not last 120 minutes.", compatible: true }
  ])("keeps independent surface polarity: $label / $prompt", async ({ label, prompt, compatible }) => {
    const option = { label, prompt };
    const options = await recommend(arm, option);
    if (compatible) expect(options).toContainEqual(option);
    else expect(options).not.toContainEqual(option);
  });
});
