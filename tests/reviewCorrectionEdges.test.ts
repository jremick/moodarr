import { expect, it } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { NoopRanker, type AiRanker } from "../src/server/ai/ranker";
import type { BriefParser } from "../src/server/ai/briefParser";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { createReviewCandidateEngine } from "../src/server/recommendation/review/candidateEngine";

const seerrClient = { allowsDescriptiveContent: () => false } as unknown as SeerrClient;
async function run(query: string, summaries: Record<string, string>, options: {
  arm?: "baseline" | "revisedCombined"; ranker?: AiRanker; briefParser?: BriefParser
} = {}) {
  const db = createDatabase(":memory:");
  try {
    const repository = new MediaRepository(db);
    repository.upsertMany(Object.entries(summaries).map(([title, summary]) => ({ title, summary, genres: ["Drama"],
      mediaType: "movie" as const, runtimeMinutes: 80, plex: { available: true, ratingKey: title } })));
    const engine = createReviewCandidateEngine({ repository, seerrClient, ranker: options.ranker ?? new NoopRanker(), briefParser: options.briefParser }, options.arm ?? "revisedCombined");
    return await engine.recommend({ query, useAi: !!(options.ranker || options.briefParser), resultLimit: 10 });
  } finally { db.close(); }
}

it("rejects denied absence while keeping direct absence and unknown content eligible", async () => {
  const result = await run("a movie, no violence", {
    "Denial one": "The movie is not nonviolent.", "Denial two": "The movie is not violence-free.",
    "Denial three": "The film is not without violence.", "Denial four": "The movie does not lack violence.",
    "Absent": "A nonviolent film.", "Unknown": "A village meeting."
  });
  expect(new Set(result.results.map(row => row.title))).toEqual(new Set(["Absent", "Unknown"]));
});

it("does not let AI-enriched synonyms cancel an explicit avoidance", async () => {
  const briefParser: BriefParser = { parse: async () => ({ usedAi: true, signals: { moods: ["heartwarming"] } }) };
  const result = await run("a drama, not warm", { "Warm": "A warm story.", "Neutral": "A village meeting." }, { briefParser });
  expect(result.results.map(row => row.title)).not.toContain("Warm");
  expect(result.results.map(row => row.title)).toContain("Neutral");
});

it("uses explicit absence evidence when explaining a literal content avoidance", async () => {
  const result = await run("a movie, no gore", { "Absent": "A film without gore.", "Unknown": "A village meeting." });
  const absent = result.results.find(row => row.title === "Absent")!;
  const unknown = result.results.find(row => row.title === "Unknown")!;
  expect(absent.matchExplanation).not.toMatch(/not established[^.]*gore/i);
  expect(unknown.matchExplanation).toMatch(/not established[^.]*gore/i);
});

it("screens constraints promised only in suggestion labels", async () => {
  const ranker: AiRanker = { rank: async ({ candidates }) => ({ usedAi: true, results: candidates, refinementOptions: [
    { label: "TV only", prompt: "Keep the same mood." },
    { label: "Over 180 minutes", prompt: "Keep the same mood." }
  ] }) };
  const result = await run("a movie under 90 minutes", { "Eligible": "A village meeting." }, { arm: "baseline", ranker });
  expect(result.refinementOptions.map(option => option.label)).not.toContain("TV only");
  expect(result.refinementOptions.map(option => option.label)).not.toContain("Over 180 minutes");
});

it.each(["baseline", "revisedCombined"] as const)("recognises an explicit musical noun without confusing instruments in %s", async arm => {
  const result = await run("a movie, no musicals", {
    "Musical": "A musical with original songs and elaborate choreography.",
    "Instruments": "A detective studies musical instruments found in a warehouse."
  }, { arm });
  expect(result.results.map(row => row.title)).not.toContain("Musical");
  expect(result.results.map(row => row.title)).toContain("Instruments");
});
