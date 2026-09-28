import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { NoopRanker, type AiRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { createReviewCandidateEngine } from "../src/server/recommendation/review/candidateEngine";
import { interpretViewingEffects } from "../src/server/recommendation/viewingEffects";

const databases: ReturnType<typeof createDatabase>[] = [];
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Goal modifier checks must remain offline"); })));
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});

function engine(ranker: AiRanker) {
  const db = createDatabase(":memory:"); databases.push(db);
  const repository = new MediaRepository(db);
  repository.upsertMany([
    { title: "Evening Garden", genres: ["Drama"], summary: "A calm, soothing, low conflict and emotionally easy drama." },
    { title: "Night Passage", genres: ["Horror"], summary: "An intense and terrifying horror film full of danger." }
  ].map((record, index) => ({ ...record, mediaType: "movie", runtimeMinutes: 80, year: 2005,
    contentRating: "PG", plex: { available: true, ratingKey: `goal-modifier-${index}` } })));
  return createReviewCandidateEngine({ repository, ranker,
    seerrClient: { allowsDescriptiveContent: () => false } as unknown as SeerrClient }, "baseline");
}

interface GoalCase {
  name: string;
  query: string;
  role: "requested" | "denied" | "unresolved";
}
const goalCases: GoalCase[] = [
  { name: "direct control", query: "I want a movie to help me relax.", role: "requested" },
  { name: "direct denial control", query: "I don't want a movie to help me relax; I want an intense horror movie.", role: "denied" },
  { name: "reported control", query: "My friend wants a movie to help me relax; I want an intense horror movie.", role: "unresolved" },
  { name: "uncertain control", query: "I wonder whether I want a movie to help me relax; I want an intense horror movie.", role: "unresolved" },
  { name: "really affirmative", query: "I really want a movie to help me relax.", role: "requested" },
  { name: "really before denial", query: "I really don't want a movie to help me relax; I want an intense horror movie.", role: "denied" },
  { name: "really after denial", query: "I don't really want a movie to help me relax; I want an intense horror movie.", role: "denied" },
  { name: "really reported", query: "My friend really wants a movie to help me relax; I want an intense horror movie.", role: "unresolved" },
  { name: "really uncertain", query: "I wonder whether I really want a movie to help me relax; I want an intense horror movie.", role: "unresolved" },
  { name: "just affirmative", query: "I just want a movie to help me relax.", role: "requested" },
  { name: "just before denial", query: "I just don't want a movie to help me relax; I want an intense horror movie.", role: "denied" },
  { name: "just reported", query: "My friend just wants a movie to help me relax; I want an intense horror movie.", role: "unresolved" },
  { name: "just uncertain", query: "I wonder whether I just want a movie to help me relax; I want an intense horror movie.", role: "unresolved" },
  { name: "polite affirmative", query: "Could you please recommend a movie to help me relax?", role: "requested" },
  { name: "polite denial", query: "Could you please not recommend a movie to help me relax; I want an intense horror movie.", role: "denied" },
  { name: "polite reported", query: "My friend asked whether you could please recommend a movie to help me relax; I want an intense horror movie.", role: "unresolved" },
  { name: "polite uncertain", query: "I wonder whether you could please recommend a movie to help me relax; I want an intense horror movie.", role: "unresolved" }
];

describe.each(["provider-free", "timeout fallback"] as const)("governing goal modifier invariance: %s", mode => {
  it.each(goalCases)("preserves $name authority and final eligibility", async scenario => {
    const rank = vi.fn<AiRanker["rank"]>(async ({ candidates }) => ({
      usedAi: false, results: candidates, failureCategory: "timeout"
    }));
    const fallback = mode === "timeout fallback";
    const response = await engine(fallback ? { rank } : new NoopRanker()).recommend({
      query: scenario.query, useAi: fallback, resultLimit: 10
    });
    const effect = interpretViewingEffects(scenario.query);
    const expectsCalming = scenario.role === "requested";
    expect({
      requested: effect.requested, denied: effect.denied, unresolved: effect.unresolved,
      horrorReturned: response.results.some(row => row.title === "Night Passage"), usedAi: response.usedAi
    }).toEqual({
      requested: expectsCalming ? ["calm"] : [],
      denied: scenario.role === "denied" ? ["calm"] : [],
      unresolved: scenario.role === "unresolved" ? ["calm"] : [],
      horrorReturned: !expectsCalming, usedAi: false
    });
    if (expectsCalming) expect(response.results.map(row => row.title)).toContain("Evening Garden");
    expect(rank).toHaveBeenCalledTimes(fallback ? 1 : 0);
    if (fallback) {
      const titles = rank.mock.calls[0][0].candidates.map(row => row.title);
      expect(titles.includes("Night Passage")).toBe(!expectsCalming);
      if (expectsCalming) expect(titles).toContain("Evening Garden");
    }
  });
});
