import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { NoopRanker, type AiRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { createReviewCandidateEngine } from "../src/server/recommendation/review/candidateEngine";
import { interpretViewingEffects } from "../src/server/recommendation/viewingEffects";
import type { SearchFilters } from "../src/shared/types";

const databases: ReturnType<typeof createDatabase>[] = [];
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Goal ownership checks must remain offline"); })));
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
const filters: SearchFilters = { maxRuntimeMinutes: 90, availability: ["available_in_plex"] };
function engine(ranker: AiRanker) {
  const db = createDatabase(":memory:"); databases.push(db);
  const repository = new MediaRepository(db);
  const experiences = [
    { title: "Evening Garden", genres: ["Drama"], summary: "A calm, soothing, low conflict and emotionally easy drama. A character says 'help me relax'." },
    { title: "Night Passage", genres: ["Horror"], summary: "An intense and terrifying horror film full of danger. A character says 'help me relax'." }
  ];
  repository.upsertMany([{ runtimeMinutes: 80, available: true }, { runtimeMinutes: 110, available: true }, { runtimeMinutes: 80, available: false }]
    .flatMap(({ runtimeMinutes, available }) => experiences.map((record, index) => ({
    ...record, title: !available ? `Unavailable ${record.title}` : runtimeMinutes === 80 ? record.title : `Long ${record.title}`, mediaType: "movie" as const,
    runtimeMinutes, year: 2005, contentRating: "PG", plex: { available, ratingKey: `goal-owner-${available}-${runtimeMinutes}-${index}` }
  }))));
  return createReviewCandidateEngine({ repository, ranker,
    seerrClient: { allowsDescriptiveContent: () => false } as unknown as SeerrClient }, "baseline");
}

interface GoalCase {
  name: string;
  query: string;
  role: "requested" | "denied" | "content" | "unresolved";
  additionalContent?: boolean;
  checkSpan?: boolean;
}
const goalCases: GoalCase[] = [
  { name: "bare viewer purpose", query: "I want a movie to help me relax.", role: "requested" },
  { name: "bare quoted viewer purpose", query: "I want a movie to 'help me relax'.", role: "requested", checkSpan: true },
  { name: "bare character dialogue", query: "I want an intense horror movie where a character says 'help me relax'.", role: "content", checkSpan: true },
  { name: "really viewer purpose", query: "I really want a movie to help me relax.", role: "requested" },
  { name: "really quoted viewer purpose", query: "I really want a movie to 'help me relax'.", role: "requested" },
  { name: "really character dialogue", query: "I really want an intense horror movie where a character says 'help me relax'.", role: "content" },
  { name: "just viewer purpose", query: "I just want a movie to help me relax.", role: "requested" },
  { name: "just quoted viewer purpose", query: "I just want a movie to 'help me relax'.", role: "requested" },
  { name: "just character dialogue", query: "I just want an intense horror movie where a character says 'help me relax'.", role: "content" },
  { name: "direct imperative control", query: "Please help me relax.", role: "requested" },
  { name: "polite quoted viewer request", query: "Could you please recommend a movie to 'help me relax'?", role: "requested" },
  { name: "recommendation for dialogue", query: "Please recommend an intense horror movie where a character says 'help me relax'.", role: "content" },
  { name: "genuine goal before content quote", query: "I want a movie to help me relax, where a character says 'help me relax'.", role: "requested", additionalContent: true },
  { name: "won't outcome", query: "I want a movie that won't help me relax; I want intense horror.", role: "denied" },
  { name: "will not outcome with modifier", query: "I really want a movie that will not help me relax; I want intense horror.", role: "denied" },
  { name: "quoted won't outcome", query: "I just want a movie that won't 'help me relax'; I want intense horror.", role: "denied" },
  { name: "quoted not outcome", query: "I want a movie to 'not help me relax'; I want an intense horror movie.", role: "denied" },
  { name: "quoted never outcome", query: "I want a movie to 'never help me relax'; I want an intense horror movie.", role: "denied" },
  { name: "quoted not-only outcome", query: "I want a movie to 'not only help me relax'.", role: "requested" },
  { name: "quoted content denial", query: "I want an intense horror movie where a character says 'not help me relax'.", role: "content" },
  { name: "polite denied outcome", query: "Could you please recommend a movie that won't help me relax? I want intense horror.", role: "denied" },
  { name: "unresolved discussion complement", query: "I want a movie discussing 'help me relax'; I want intense horror.", role: "unresolved" },
  { name: "another person's quoted goal", query: "My friend wants a movie to 'help me relax'; I want intense horror.", role: "unresolved" },
  { name: "unresolved viewer question", query: "I wonder whether a film would help me relax; I want intense horror.", role: "unresolved" }
];

describe.each(["provider-free", "timeout fallback"] as const)("effect complement ownership: %s", mode => {
  it.each(goalCases)("preserves $name roles and final eligibility", async scenario => {
    const rank = vi.fn<AiRanker["rank"]>(async ({ candidates }) => ({ usedAi: false, results: candidates, failureCategory: "timeout" }));
    const fallback = mode === "timeout fallback";
    const response = await engine(fallback ? { rank } : new NoopRanker()).recommend({ query: scenario.query, filters, useAi: fallback, resultLimit: 10 });
    const effect = interpretViewingEffects(scenario.query);
    const calming = scenario.role === "requested";
    expect({
      requested: effect.requested, denied: effect.denied, unresolved: effect.unresolved,
      horrorReturned: response.results.some(row => row.title === "Night Passage"), usedAi: response.usedAi
    }).toEqual({
      requested: calming ? ["calm"] : [], denied: scenario.role === "denied" ? ["calm"] : [],
      unresolved: scenario.role === "unresolved" ? ["calm"] : [], horrorReturned: !calming, usedAi: false
    });
    if (scenario.role === "content" || scenario.additionalContent) expect(effect).toMatchObject({ content: ["calm"] });
    if (scenario.checkSpan) {
      const start = scenario.query.indexOf("help me relax");
      expect(effect).toMatchObject({ occurrences: [{ effect: "calm", role: scenario.role, start, end: start + "help me relax".length }] });
    }
    expect(response.resolvedFilters).toEqual(expect.objectContaining(filters));
    expect(response.results.some(row => row.title.startsWith("Long "))).toBe(false);
    expect(response.results.some(row => row.title.startsWith("Unavailable "))).toBe(false);
    if (calming) expect(response.results.map(row => row.title)).toContain("Evening Garden");
    expect(rank).toHaveBeenCalledTimes(fallback ? 1 : 0);
    if (fallback) {
      const titles = rank.mock.calls[0][0].candidates.map(row => row.title);
      expect(titles.includes("Night Passage")).toBe(!calming);
      expect(titles.some(title => title.startsWith("Long "))).toBe(false);
      expect(titles.some(title => title.startsWith("Unavailable "))).toBe(false);
      if (calming) expect(titles).toContain("Evening Garden");
    }
  });
});
