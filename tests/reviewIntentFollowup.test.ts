import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository, type IngestMediaRecord } from "../src/server/db/mediaRepository";
import { NoopRanker, type AiRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { createReviewCandidateEngine, type reviewArms } from "../src/server/recommendation/review/candidateEngine";

const databases: ReturnType<typeof createDatabase>[] = [];
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Follow-up tests must remain offline"); })));
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.unstubAllGlobals(); });
function engine(arm: keyof typeof reviewArms, records: Partial<IngestMediaRecord>[], ranker: AiRanker = new NoopRanker()) {
  const db = createDatabase(":memory:"); databases.push(db);
  const repository = new MediaRepository(db);
  repository.upsertMany(records.map((record, index) => ({ title: `Observation ${index}`, mediaType: "movie", genres: ["Drama"],
    runtimeMinutes: 80, year: 2005, contentRating: "PG", plex: { available: true, ratingKey: `followup-${index}` }, ...record })));
  return createReviewCandidateEngine({ repository, ranker, seerrClient: { allowsDescriptiveContent: () => false } as unknown as SeerrClient }, arm);
}
const experiences = [
  { title: "Sable Night", genres: ["Horror"], summary: "An intense and terrifying horror film full of danger." },
  { title: "Willow Morning", summary: "A calm, soothing, low conflict and emotionally easy drama." },
  { title: "November Letter", summary: "A sad and cathartic drama about grief and loss." }
];

describe("denied viewing effects at the final engine boundary", () => {
  it.each([
    "I'm anxious, but I don't want you to calm me down; I want an intense horror movie.",
    "I'm anxious. I don't want a film to help me relax. I want an intense horror movie.",
    "I don't want you to calm me down; I want an intense horror movie.",
    "I don't want a film to help me relax. I want an intense horror movie.",
    "I don't want the film to make me feel calmer. I want an intense horror movie.",
    "I do not want the movie to help me unwind; I want an intense horror movie.",
    "Don't calm me down; I want an intense horror movie."
  ])("does not turn a denied goal into a default horror veto: %s", async query => {
    const response = await engine("baseline", experiences).recommend({ query, useAi: false, resultLimit: 10 });
    expect(response.results.map(row => row.title)).toContain("Sable Night");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "I'm anxious; I want a film to help me relax.",
    "I don't want horror; I want you to calm me down.",
    "I don't want to cry and I want a movie to help me relax.",
    "We don't want to cry and we want a movie to help me relax.",
    "I don't want you to make me cry, but help me relax.",
    "I want a film to not only calm me down but help me relax.",
    "I don't want you to calm me down. Actually, help me relax."
  ])("keeps separately requested calming effects authoritative: %s", async query => {
    const response = await engine("baseline", experiences).recommend({ query, useAi: false, resultLimit: 10 });
    expect(response.results.map(row => row.title)).toContain("Willow Morning");
    expect(response.results.map(row => row.title)).not.toContain("Sable Night");
  });

  it("preserves denied effects through a provider timeout without inventing a coping fallback", async () => {
    const rank = vi.fn<AiRanker["rank"]>(async ({ candidates }) => ({ usedAi: false, results: candidates, failureCategory: "timeout" }));
    const response = await engine("baseline", experiences, { rank }).recommend({
      query: "I'm anxious, but I don't want you to calm me down; I want an intense horror movie.", useAi: true, resultLimit: 10
    });
    expect(rank).toHaveBeenCalledTimes(1);
    expect(rank.mock.calls[0][0].candidates.map(row => row.title)).toContain("Sable Night");
    expect(response.results.map(row => row.title)).toContain("Sable Night");
    expect(response.usedAi).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

const compositionArms = ["claimComposition", "claimCompositionEqualAmplitude", "claimCompositionCoverage", "claimCompositionCoverageEqualAmplitude"] as const;
describe.each(compositionArms)("operational constraints stay outside experience facets in %s", arm => {
  const record = { title: "Copper Lantern", summary: "A warm and witty story." };
  it.each([
    ["under 90 minutes", { maxRuntimeMinutes: 90 }, /minutes/],
    ["between 70 and 90 minutes", { minRuntimeMinutes: 70, maxRuntimeMinutes: 90 }, /minutes/],
    ["under ninety minutes", { maxRuntimeMinutes: 90 }, /ninety|minutes/],
    ["under twenty five minutes", { maxRuntimeMinutes: 25 }, /twenty|five|minutes/],
    ["twenty five minutes max", { maxRuntimeMinutes: 25 }, /twenty|five|minutes/],
    ["under 1.5 hours", { maxRuntimeMinutes: 90 }, /hours/],
    ["available in Plex", { availability: ["available_in_plex"] }, /plex/],
    ["available locally", { availability: ["available_in_plex"] }, /locally/],
    ["since 2000", { minYear: 2000 }, /since|2000/]
  ] as const)("preserves final mood while applying %s", async (suffix, filter, operational) => {
    const source = engine(arm, [{ ...record, runtimeMinutes: "maxRuntimeMinutes" in filter && filter.maxRuntimeMinutes === 25 ? 20 : 80 }]);
    const base = await source.recommend({ query: "a warm and witty movie", useAi: false });
    const result = await source.recommend({ query: `a warm and witty movie ${suffix}`, useAi: false });
    expect(result.results).toHaveLength(1);
    expect(result.resolvedFilters).toEqual(expect.objectContaining(filter));
    expect(result.results[0].scoreBreakdown?.mood).toBe(base.results[0].scoreBreakdown?.mood);
    expect(result.results[0].matchExplanation).not.toMatch(operational);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("retains genuinely unsupported experience traits and masks reference-title words", async () => {
    const source = engine(arm, [record]);
    const base = await source.recommend({ query: "a warm and witty movie", useAi: false });
    const gentle = await source.recommend({ query: "a warm, witty, and gentle movie", useAi: false });
    const reference = await source.recommend({ query: "a warm and witty movie. More like Copper Lantern.", useAi: false });
    expect(gentle.results[0].matchExplanation).toMatch(/not established[^.]*gentle/i);
    if (arm.includes("Coverage")) expect(gentle.results[0].scoreBreakdown!.mood!).toBeLessThan(base.results[0].scoreBreakdown!.mood!);
    expect(reference.results[0].scoreBreakdown?.mood).toBe(base.results[0].scoreBreakdown?.mood);
    expect(reference.results[0].matchExplanation).not.toMatch(/not established[^.]*copper|not established[^.]*lantern/i);
  });
});
