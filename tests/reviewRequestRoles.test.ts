import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository, type IngestMediaRecord } from "../src/server/db/mediaRepository";
import { NoopRanker, type AiRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { createReviewCandidateEngine, type reviewArms } from "../src/server/recommendation/review/candidateEngine";
import type { SearchFilters } from "../src/shared/types";

const databases: ReturnType<typeof createDatabase>[] = [];
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Request role tests must remain offline"); })));
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
function engine(arm: keyof typeof reviewArms, records: Partial<IngestMediaRecord>[], ranker: AiRanker = new NoopRanker()) {
  const db = createDatabase(":memory:"); databases.push(db);
  const repository = new MediaRepository(db);
  repository.upsertMany(records.map((record, index) => ({
    title: `Role observation ${index}`, mediaType: "movie", genres: ["Drama"], summary: "A warm and witty story.",
    runtimeMinutes: 80, year: 2005, contentRating: "PG", plex: { available: true, ratingKey: `request-role-${index}` }, ...record
  })));
  return createReviewCandidateEngine({ repository, ranker,
    seerrClient: { allowsDescriptiveContent: () => false } as unknown as SeerrClient }, arm);
}
const experiences = [
  { title: "Night Passage", genres: ["Horror"], summary: "An intense and terrifying horror film full of danger." },
  { title: "Evening Garden", summary: "A calm, soothing, low conflict and emotionally easy drama." },
  { title: "November Notes", summary: "A sad and cathartic drama about grief and loss." }
];

describe("governing user goals at the ordinary final engine", () => {
  it.each([
    "I'm anxious, but I never asked you to calm me down; I want an intense horror movie.",
    "I'm anxious, but I have no desire for a movie to calm me down; I want an intense horror movie.",
    "I'm not anxious, and I have no desire for a film to help me relax; I want an intense horror movie.",
    "We never asked for a movie to help me relax; we want an intense horror movie.",
    "I have no intention of asking a film to make me feel calmer; I want an intense horror movie.",
    "I don't want you to calm me down; I want an intense horror movie.",
    "I wonder whether a film would calm me down; I want an intense horror movie.",
    "My friend thinks a movie should calm me down, but I want an intense horror movie."
  ])("does not infer a calming request from a denied or unresolved goal: %s", async query => {
    const response = await engine("baseline", experiences).recommend({ query, useAi: false, resultLimit: 10 });
    expect(response.results.map(row => row.title)).toContain("Night Passage");
  });

  it.each([
    "I'm anxious; I want a movie to calm me down.",
    "I have a desire for a movie to help me relax.",
    "Please help me unwind.",
    "Please recommend a movie to calm me down.",
    "Can you recommend a movie to help me relax?",
    "I never asked a movie to make me cry, but I want a film to calm me down.",
    "I have no desire to make me cry and I want a movie to help me relax.",
    "My friend never asked for a film to help me relax, but I want a movie to calm me down."
  ])("preserves an affirmative calming goal and its eligibility boundary: %s", async query => {
    const response = await engine("baseline", experiences).recommend({ query, useAi: false, resultLimit: 10 });
    expect(response.results.map(row => row.title)).toContain("Evening Garden");
    expect(response.results.map(row => row.title)).not.toContain("Night Passage");
  });

  it("allows an explicitly requested sad experience despite current state and a denied coping goal", async () => {
    const response = await engine("baseline", experiences).recommend({
      query: "I'm sad. I have no desire for a film to cheer me up; I want a sad cathartic movie that lets me cry.",
      useAi: false, resultLimit: 10
    });
    expect(response.results.map(row => row.title)).toContain("November Notes");
  });

  it("lets a marked denial replace an earlier calming request", async () => {
    const response = await engine("baseline", experiences).recommend({
      query: "Please calm me down.\nFollow-up refinement: I have no desire for a movie to calm me down; I want an intense horror movie.",
      useAi: false, resultLimit: 10
    });
    expect(response.results.map(row => row.title)).toContain("Night Passage");
  });

  it("lets a marked affirmative goal replace an earlier denial", async () => {
    const response = await engine("baseline", experiences).recommend({
      query: "I never asked you to calm me down.\nFollow-up refinement: Please help me relax.",
      useAi: false, resultLimit: 10
    });
    expect(response.results.map(row => row.title)).toContain("Evening Garden");
    expect(response.results.map(row => row.title)).not.toContain("Night Passage");
  });

  it("preserves explicit desired candidates through an offline AI timeout after a zero-desire statement", async () => {
    const rank = vi.fn<AiRanker["rank"]>(async ({ candidates }) => ({
      usedAi: false, results: candidates, failureCategory: "timeout"
    }));
    const response = await engine("baseline", experiences, { rank }).recommend({
      query: "I'm anxious, but I have no desire for a film to calm me down; I want an intense horror movie.",
      useAi: true, resultLimit: 10
    });
    expect(rank).toHaveBeenCalledTimes(1);
    expect(rank.mock.calls[0][0].candidates.map(row => row.title)).toContain("Night Passage");
    expect(response.results.map(row => row.title)).toContain("Night Passage");
    expect(response.usedAi).toBe(false);
  });
});

const compositionArms = ["claimComposition", "claimCompositionEqualAmplitude", "claimCompositionCoverage", "claimCompositionCoverageEqualAmplitude"] as const;
interface OperationalCase {
  name: string;
  core: string;
  wrapped: string;
  filters: Partial<SearchFilters>;
  eligible: Partial<IngestMediaRecord>;
  excluded: Partial<IngestMediaRecord>;
  scaffolding: RegExp;
}
const operationalCases: OperationalCase[] = [
  { name: "release relation", core: "after 2000", wrapped: "released after 2000", filters: { minYear: 2001 },
    eligible: { year: 2005 }, excluded: { year: 1995 }, scaffolding: /not established[^.]*released/i },
  { name: "creation year relation", core: "after 2000", wrapped: "made after 2000", filters: { minYear: 2001 },
    eligible: { year: 2005 }, excluded: { year: 1995 }, scaffolding: /not established[^.]*made/i },
  { name: "relative release clause", core: "after 2000", wrapped: "which was released after 2000", filters: { minYear: 2001 },
    eligible: { year: 2005 }, excluded: { year: 1995 }, scaffolding: /not established[^.]*(?:which|released)/i },
  { name: "decade relation", core: "nineties", wrapped: "from the nineties", filters: { minYear: 1990, maxYear: 1999 },
    eligible: { year: 1995 }, excluded: { year: 2005 }, scaffolding: /not established[^.]*from/i },
  { name: "relative availability clause", core: "available in Plex", wrapped: "which is available in Plex", filters: { availability: ["available_in_plex"] },
    eligible: {}, excluded: { plex: { available: false, ratingKey: "outside-plex" } }, scaffolding: /not established[^.]*(?:which|plex)/i },
  { name: "relative duration clause", core: "under 90 minutes", wrapped: "which runs under 90 minutes", filters: { maxRuntimeMinutes: 90 },
    eligible: { runtimeMinutes: 80 }, excluded: { runtimeMinutes: 120 }, scaffolding: /not established[^.]*(?:which|runs|minutes)/i }
];

describe.each(compositionArms)("operational clause roles in %s", arm => {
  it.each(operationalCases)("preserves hard-filter membership and mood for $name", async scenario => {
    const source = engine(arm, [
      { title: "Eligible observation", ...scenario.eligible },
      { title: "Outside the boundary", ...scenario.excluded }
    ]);
    const base = await source.recommend({ query: "a warm and witty movie", useAi: false, resultLimit: 10 });
    const core = await source.recommend({ query: `a warm and witty movie ${scenario.core}`, useAi: false, resultLimit: 10 });
    const wrapped = await source.recommend({ query: `a warm and witty movie ${scenario.wrapped}`, useAi: false, resultLimit: 10 });
    expect(core.resolvedFilters).toEqual(expect.objectContaining(scenario.filters));
    expect(wrapped.resolvedFilters).toEqual(core.resolvedFilters);
    expect(core.results.map(row => row.title)).toEqual(["Eligible observation"]);
    expect(wrapped.results.map(row => row.title)).toEqual(["Eligible observation"]);
    const baselineMood = base.results.find(row => row.title === "Eligible observation")!.scoreBreakdown!.mood;
    expect(core.results[0].scoreBreakdown!.mood).toBe(baselineMood);
    expect(wrapped.results[0].scoreBreakdown!.mood).toBe(baselineMood);
    expect(wrapped.results[0].matchExplanation).not.toMatch(scenario.scaffolding);
  });

  it.each(["gentle", "winsome"])("retains unsupported desired %s beside an operational clause", async trait => {
    const source = engine(arm, [{ title: "Eligible observation" }]);
    const base = await source.recommend({ query: "a warm and witty movie after 2000", useAi: false });
    const response = await source.recommend({ query: `a warm and witty movie released after 2000 and ${trait}`, useAi: false });
    expect(response.resolvedFilters).toEqual(base.resolvedFilters);
    expect(response.results.map(row => row.title)).toEqual(["Eligible observation"]);
    expect(response.results[0].matchExplanation).toMatch(new RegExp(`not established[^.]*${trait}`, "i"));
    expect(response.results[0].matchExplanation).not.toMatch(/not established[^.]*released/i);
    if (arm.includes("Coverage")) expect(response.results[0].scoreBreakdown!.mood!).toBeLessThan(base.results[0].scoreBreakdown!.mood!);
  });

  it("preserves a real descriptive prohibition after an operational clause", async () => {
    const source = engine(arm, [
      { title: "Allowed", summary: "A warm and witty story." },
      { title: "Forbidden", summary: "A warm, witty and gentle story." }
    ]);
    const response = await source.recommend({
      query: "a warm and witty movie released after 2000, but not gentle", useAi: false, resultLimit: 10
    });
    expect(response.resolvedFilters.minYear).toBe(2001);
    expect(response.results.map(row => row.title)).toEqual(["Allowed"]);
  });
});
