import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { createReviewCandidateEngine } from "../src/server/recommendation/review/candidateEngine";
import type { AiRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import type { RefinementOption, SearchRequest } from "../src/shared/types";

const databases: ReturnType<typeof createDatabase>[] = [];
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Refinement follow-up tests must stay offline."); })));
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.unstubAllGlobals(); });
type Arm = "baseline" | "revisedCombined";
async function response(arm: Arm, request: SearchRequest, option: RefinementOption) {
  const db = createDatabase(":memory:"); databases.push(db);
  const repository = new MediaRepository(db);
  repository.upsertMany([{ title: "Copper Ledger", mediaType: "movie", genres: ["Drama"], contentRating: "PG",
    summary: "A thoughtful account of an investigation.", runtimeMinutes: 80, plex: { available: true, ratingKey: "refinement-followup" } }]);
  const rank = vi.fn<AiRanker["rank"]>(async ({ candidates }) => ({ usedAi: true, results: candidates, refinementOptions: [option] }));
  const engine = createReviewCandidateEngine({ repository, ranker: { rank },
    seerrClient: { allowsDescriptiveContent: () => false } as unknown as SeerrClient }, arm);
  const result = await engine.recommend({ ...request, useAi: true, resultLimit: 10 });
  expect(rank).toHaveBeenCalledTimes(1);
  expect(result.aiRerank.status).toBe("applied");
  expect(result.results.map(item => item.title)).toContain("Copper Ledger");
  expect(fetch).not.toHaveBeenCalled();
  return result;
}
interface Conflict { name: string; request: SearchRequest; label: string; prompt: string }
const conflicts: Conflict[] = [
  { name: "violence noun to adjective", request: { query: "a movie, no violence" }, label: "Violent options", prompt: "Show violent films." },
  { name: "violent adjective to noun", request: { query: "a movie, not violent" }, label: "Violence on screen", prompt: "Show films with violence." },
  { name: "different rating", request: { query: "a movie", filters: { contentRating: "PG" } }, label: "R-rated", prompt: "Show R-rated movies." },
  { name: "rating is equality rather than ceiling", request: { query: "a movie", filters: { contentRating: "PG" } }, label: "G-rated", prompt: "Show G-rated movies." },
  { name: "rating prefix is not equality", request: { query: "a movie", filters: { contentRating: "PG" } }, label: "PG-13 picks", prompt: "Show movies rated PG-13." },
  { name: "exact minutes exceed upper bound", request: { query: "a movie under 90 minutes" }, label: "120-minute movies", prompt: "Show 120-minute movies." },
  { name: "exact hours exceed upper bound", request: { query: "a movie under 90 minutes" }, label: "2-hour movies", prompt: "Show 2-hour movies." },
  { name: "exact minutes below lower bound", request: { query: "a movie", filters: { minRuntimeMinutes: 75, maxRuntimeMinutes: 90 } }, label: "60-minute movies", prompt: "Show 60-minute movies." }
];
const surfaces = ["label", "prompt", "both"] as const;

describe.each(["baseline", "revisedCombined"] as const)("F5 final refinement promises in %s", arm => {
  for (const conflict of conflicts) {
    it.each(surfaces)(`screens ${conflict.name} in %s`, async surface => {
      const option = { label: surface === "prompt" ? "Another selection" : conflict.label,
        prompt: surface === "label" ? "Keep the same feeling." : conflict.prompt };
      const result = await response(arm, conflict.request, option);
      expect(result.refinementOptions).not.toContainEqual(option);
    });
  }

  it.each(["Show films lasting 120 minutes.", "Show movies that run for two hours."])("screens ordinary exact-duration promise: %s", async prompt => {
    const option = { label: "Another selection", prompt };
    const result = await response(arm, { query: "a movie under 90 minutes" }, option);
    expect(result.refinementOptions).not.toContainEqual(option);
  });

  it.each([
    { label: "PG or R", prompt: "Keep the same feeling." },
    { label: "Another selection", prompt: "Show movies rated PG or R." }
  ])("screens each promised rating in a coordinated list: $label / $prompt", async option => {
    const result = await response(arm, { query: "a movie", filters: { contentRating: "PG" } }, option);
    expect(result.refinementOptions).not.toContainEqual(option);
  });

  it("preserves a compatible rating with a separately negated alternative", async () => {
    const option = { label: "Keep the rating", prompt: "Show movies rated PG, not R." };
    const result = await response(arm, { query: "a movie", filters: { contentRating: "PG" } }, option);
    expect(result.refinementOptions).toContainEqual(option);
  });

  it.each([
    { label: "Violent options", prompt: "Avoid violence." },
    { label: "No violence", prompt: "Show violent films." }
  ])("does not let one negated surface conceal the other: $label / $prompt", async option => {
    const result = await response(arm, { query: "a movie, no violence" }, option);
    expect(result.refinementOptions).not.toContainEqual(option);
  });

  it.each<{ name: string; request: SearchRequest; option: RefinementOption }>([
    { name: "matching rating", request: { query: "a movie", filters: { contentRating: "PG" } }, option: { label: "PG-rated", prompt: "Show movies rated PG." } },
    { name: "negated different rating", request: { query: "a movie", filters: { contentRating: "PG" } }, option: { label: "Keep the rating", prompt: "Avoid R-rated films." } },
    { name: "no active rating", request: { query: "a movie" }, option: { label: "R-rated", prompt: "Show R-rated movies." } },
    { name: "exact duration inside range", request: { query: "a movie under 90 minutes" }, option: { label: "80-minute movies", prompt: "Show films lasting 80 minutes." } },
    { name: "duration at inclusive upper bound", request: { query: "a movie under 90 minutes" }, option: { label: "90-minute movies", prompt: "Show 90-minute movies." } },
    { name: "word-form hours inside range", request: { query: "a movie under 90 minutes" }, option: { label: "One-hour movies", prompt: "Show one-hour movies." } },
    { name: "spaced compound quantity inside range", request: { query: "a movie", filters: { minRuntimeMinutes: 20, maxRuntimeMinutes: 90 } }, option: { label: "Twenty five minute movies", prompt: "Show twenty five minute movies." } },
    { name: "compatible bounded range", request: { query: "a movie", filters: { minRuntimeMinutes: 75, maxRuntimeMinutes: 90 } }, option: { label: "A nearby length", prompt: "Show movies between 80 and 85 minutes." } },
    { name: "no active duration", request: { query: "a movie" }, option: { label: "120-minute movies", prompt: "Show 120-minute movies." } },
    { name: "nonviolent content", request: { query: "a movie, no violence" }, option: { label: "Nonviolent movies", prompt: "Avoid violent films." } },
    { name: "suspense without Horror", request: { query: "a movie, no horror" }, option: { label: "More tension", prompt: "Show suspenseful movies without horror." } },
    { name: "music subject without musical format", request: { query: "a movie, not a musical" }, option: { label: "Music biographies", prompt: "Show biographies about music." } },
    { name: "negated horror", request: { query: "a movie, no horror" }, option: { label: "No horror", prompt: "Avoid scary films." } }
  ])("preserves $name", async ({ request, option }) => {
    const result = await response(arm, request, option);
    expect(result.refinementOptions).toContainEqual(option);
  });
});
