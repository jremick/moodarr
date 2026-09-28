import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { createReviewCandidateEngine } from "../src/server/recommendation/review/candidateEngine";
import type { AiRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import type { RefinementOption, SearchFilters } from "../src/shared/types";

const databases: ReturnType<typeof createDatabase>[] = [];
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Operational refinement tests stay offline."); })));
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.unstubAllGlobals(); });
type Arm = "baseline" | "revisedCombined";
const constrained: SearchFilters = { maxRuntimeMinutes: 90, contentRating: "PG" };
async function recommend(arm: Arm, option: RefinementOption, filters: SearchFilters = constrained) {
  const db = createDatabase(":memory:"); databases.push(db);
  const repository = new MediaRepository(db);
  repository.upsertMany([{ title: "Amber Ledger", mediaType: "movie", genres: ["Drama"], contentRating: "PG", runtimeMinutes: 80,
    summary: "A thoughtful account of an investigation.", plex: { available: true, ratingKey: "operational-promises" } }]);
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

describe.each(["baseline", "revisedCombined"] as const)("G3 operational promises through %s", arm => {
  for (const statement of [
    "Show movies that last 120 minutes.",
    "Show movies that are 120 minutes in length.",
    "Show movies with an R rating.",
    "Show movies with a PG-13 rating."
  ]) {
    it.each(["label", "prompt", "both"] as const)(`screens ${statement} on %s`, async surface => {
      const option = { label: surface === "prompt" ? "Another direction" : statement,
        prompt: surface === "label" ? "Keep the same feeling." : statement };
      expect(await recommend(arm, option)).not.toContainEqual(option);
    });
  }

  for (const statement of [
    "Show movies that last two and a half hours.",
    "Show movies that clock in at 120 minutes.",
    "Show movies with a BBFC 12A rating.",
    "Show PG-rated movies or movies with a BBFC 12A rating."
  ]) {
    it.each(["label", "prompt"] as const)(`does not treat unresolved operational declaration as compatible: ${statement} / %s`, async surface => {
      const option = { label: surface === "label" ? statement : "Another direction",
        prompt: surface === "prompt" ? statement : "Keep the same feeling." };
      expect(await recommend(arm, option)).not.toContainEqual(option);
    });
  }

  it.each([
    { label: "Movies that last 120 minutes", prompt: "Avoid 120-minute movies." },
    { label: "Not an R rating", prompt: "Show movies with an R rating." }
  ])("does not let a negated surface cancel the other promise: $label", async option => {
    expect(await recommend(arm, option)).not.toContainEqual(option);
  });

  it("keeps a not-only duration declaration affirmative", async () => {
    const option = { label: "Another direction", prompt: "Show movies that are not only 120 minutes in length." };
    expect(await recommend(arm, option)).not.toContainEqual(option);
  });

  it.each([
    { prompt: "Show movies that aren't 120 minutes in length.", compatible: true },
    { prompt: "Show a movie that isn’t 120 minutes in length.", compatible: true },
    { prompt: "Show movies that aren't only 80 minutes in length.", compatible: true },
    { prompt: "Show movies that aren’t only 120 minutes in length.", compatible: false }
  ])("preserves contracted copular polarity: $prompt", async ({ prompt, compatible }) => {
    const option = { label: "Another direction", prompt };
    const options = await recommend(arm, option);
    if (compatible) expect(options).toContainEqual(option);
    else expect(options).not.toContainEqual(option);
  });

  it.each([
    "Show movies that last 80 minutes.",
    "Show movies that last 90 minutes.",
    "Show movies that are 80 minutes in length.",
    "Show movies lasting 80 minutes.",
    "Show movies with a PG rating.",
    "Show movies with a PG rating, not an R rating.",
    "Avoid movies with an R rating.",
    "Show movies that do not last 120 minutes.",
    "Show movies that are not 120 minutes in length.",
    "Show movies lasting 80 minutes, not 120 minutes.",
    "Show stories about 120 lost letters.",
    "Show stories about a rescue operation lasting 120 minutes.",
    "Show movies set 120 minutes before a rescue.",
    "Show an enigmatic story with an unusual structure.",
    "Keep the same feeling."
  ])("preserves compatible promises or non-operational prose: %s", async prompt => {
    const option = { label: "Another direction", prompt };
    expect(await recommend(arm, option)).toContainEqual(option);
  });

  it.each([
    { prompt: "Show movies between 75 and 85 minutes.", compatible: true },
    { prompt: "Show movies no more than 90 minutes.", compatible: true },
    { prompt: "Show movies not over 90 minutes.", compatible: true },
    { prompt: "Show movies between 100 and 120 minutes.", compatible: false },
    { prompt: "Show movies at least 120 minutes.", compatible: false }
  ])("preserves shared range/bound semantics: $prompt", async ({ prompt, compatible }) => {
    const option = { label: "Another direction", prompt };
    const options = await recommend(arm, option);
    if (compatible) expect(options).toContainEqual(option);
    else expect(options).not.toContainEqual(option);
  });

  it.each(["Show movies that last two and a half hours.", "Show movies with a BBFC 12A rating."])("does not invent an active filter for %s", async prompt => {
    const option = { label: "Another direction", prompt };
    expect(await recommend(arm, option, {})).toContainEqual(option);
  });
});
