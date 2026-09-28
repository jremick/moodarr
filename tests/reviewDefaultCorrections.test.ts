import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository, type IngestMediaRecord } from "../src/server/db/mediaRepository";
import { NoopRanker, type AiRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { createReviewCandidateEngine } from "../src/server/recommendation/review/candidateEngine";

const databases: DatabaseSync[] = [];
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Synthetic review must stay offline"); })));
afterEach(() => { for (const database of databases.splice(0)) database.close(); vi.unstubAllGlobals(); });
type RecordInput = Pick<IngestMediaRecord, "title"> & Partial<IngestMediaRecord>;
function setup(records: RecordInput[], arm: "baseline" | "revisedCombined" = "baseline", ranker: AiRanker = new NoopRanker()) {
  const db = createDatabase(":memory:"); databases.push(db);
  const repository = new MediaRepository(db);
  repository.upsertMany(records.map((record, index) => ({ mediaType: "movie", runtimeMinutes: 90, genres: ["Drama"],
    ratings: { critic: 80 }, plex: { available: true, ratingKey: `default-correction-${index}` }, ...record })));
  return createReviewCandidateEngine({ repository, ranker,
    seerrClient: { allowsDescriptiveContent: () => false } as unknown as SeerrClient }, arm);
}
const experiences: RecordInput[] = [
  { title: "Sable Night", genres: ["Horror"], summary: "An intense and terrifying horror film full of danger." },
  { title: "Willow Morning", summary: "A calm, soothing, low conflict and emotionally easy drama." },
  { title: "November Letter", summary: "A sad and cathartic drama about grief and loss." }
];

describe("ordinary requested experience versus current feeling", () => {
  it.each([
    "I'm anxious, but I want an intense horror movie.",
    "I am feeling anxious, and I want a scary horror movie.",
    "We're anxious; we want intense horror.",
    "I’m not anxious; I want intense horror.",
    "I do not feel anxious; I want intense horror.",
    "I'm anxious, but don't calm me down; I want intense horror.",
    "I'm anxious; I don't want a calming film. I want intense horror.",
    "I'm anxious, but I want an anxious, tense horror film."
  ])("does not remove desired horror for an unrelated state clause: %s", async query => {
    const response = await setup(experiences).recommend({ query, useAi: false, resultLimit: 10 });
    expect(response.results.map(item => item.title)).toContain("Sable Night");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps explicitly desired cathartic sadness after a current anxious state", async () => {
    const response = await setup(experiences).recommend({ query: "I'm anxious, but I want a sad cathartic drama.", useAi: false, resultLimit: 10 });
    expect(response.results.map(item => item.title)).toContain("November Letter");
  });

  it.each([
    "I'm anxious; help me unwind with a calming movie.",
    "I'm anxious; help me relax.",
    "I’m not anxious, but I want something calming.",
    "An emotionally easy sick-day movie."
  ])("preserves explicitly requested coping and calm: %s", async query => {
    const response = await setup(experiences).recommend({ query, useAi: false, resultLimit: 10 });
    const titles = response.results.map(item => item.title);
    expect(titles).toContain("Willow Morning");
    expect(titles).not.toContain("Sable Night");
  });

  it("retains an explicit horror prohibition while removing the unrequested coping assumption", async () => {
    const response = await setup(experiences).recommend({ query: "I'm anxious but want an intense movie, no horror.", useAi: false, resultLimit: 10 });
    expect(response.resolvedFilters.excludedGenres).toContain("Horror");
    expect(response.results.map(item => item.title)).not.toContain("Sable Night");
  });

  it("passes desired horror to AI and preserves it through a provider-free timeout fallback", async () => {
    const rank = vi.fn<AiRanker["rank"]>(async ({ candidates }) => ({ usedAi: false, results: candidates, failureCategory: "timeout" }));
    const response = await setup(experiences, "baseline", { rank }).recommend({
      query: "I'm anxious, but I want an intense horror movie.", useAi: true, resultLimit: 10
    });
    expect(rank).toHaveBeenCalledTimes(1);
    expect(rank.mock.calls[0][0].candidates.map(item => item.title)).toContain("Sable Night");
    expect(response.results.map(item => item.title)).toContain("Sable Night");
    expect(response.usedAi).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe.each(["baseline", "revisedCombined"] as const)("musical format boundaries through %s final responses", arm => {
  it.each([
    ["a movie, not a musical", "A detective reaches the final stage of an investigation.", ["Drama"]],
    ["a movie, not a musical", "A detective studies a recording of an interrogation.", ["Drama"]],
    ["a movie, not a musical", "A band of police officers searches for a lost ledger.", ["Drama"]],
    ["a movie, not a musical", "A biography follows a musician through family disputes.", ["Drama", "Music"]],
    ["a movie, not a musical", "An archivist studies music theory and its history.", ["Drama", "Music"]],
    ["music is fine, but not a musical", "A biography follows a musician through family disputes.", ["Drama", "Music"]],
    ["a movie, not a musical", "", ["Music"]],
    ["a movie, not a musical", "A dramatic film without songs or musical numbers.", ["Drama"]]
  ] as const)("does not infer musical format from incidental or subject-only evidence: %s / %s", async (query, summary, genres) => {
    const response = await setup([{ title: "Copper Ledger", summary, genres: [...genres] }], arm)
      .recommend({ query, useAi: false, resultLimit: 10 });
    expect(response.results.map(item => item.title)).toContain("Copper Ledger");
  });

  it("allows a concert documentary under a musical-format-only exclusion", async () => {
    const response = await setup([{ title: "Festival Archive", genres: ["Documentary", "Music"],
      summary: "A concert documentary records a singer performing songs for an audience." }], arm)
      .recommend({ query: "a documentary, not a musical", useAi: false, resultLimit: 10 });
    expect(response.results.map(item => item.title)).toContain("Festival Archive");
  });

  it.each([
    ["A musical drama with original songs and choreographed musical numbers.", ["Drama"]],
    ["A dramatic story about a voyage.", ["Musical"]],
    ["A singer performs songs with a band on stage.", ["Music"]]
  ] as const)("preserves affirmative musical-format exclusion: %s", async (summary, genres) => {
    const response = await setup([{ title: "Chorus Register", summary, genres: [...genres] },
      { title: "Copper Ledger", summary: "A detective works through an investigation." }], arm)
      .recommend({ query: "a movie, no musicals", useAi: false, resultLimit: 10 });
    expect(response.results.map(item => item.title)).toContain("Copper Ledger");
    expect(response.results.map(item => item.title)).not.toContain("Chorus Register");
  });

  it.each(["no musical numbers", "no songs"])("retains the separate performed-song boundary: %s", async exclusion => {
    const response = await setup([{ title: "Onstage Journal", genres: ["Drama"],
      summary: "A musician starts performing songs in front of a crowd." },
      { title: "Copper Ledger", summary: "A detective studies a recording of an interrogation." }], arm)
      .recommend({ query: `a movie, ${exclusion}`, useAi: false, resultLimit: 10 });
    expect(response.results.map(item => item.title)).not.toContain("Onstage Journal");
    expect(response.results.map(item => item.title)).toContain("Copper Ledger");
  });

  it("retains an explicit broad music-content exclusion", async () => {
    const response = await setup([{ title: "Music Historian", genres: ["Drama", "Music"], summary: "A biography about music theory." },
      { title: "Copper Ledger", summary: "A detective studies a recording of an interrogation." }], arm)
      .recommend({ query: "a movie, no music", useAi: false, resultLimit: 10 });
    expect(response.results.map(item => item.title)).not.toContain("Music Historian");
    expect(response.results.map(item => item.title)).toContain("Copper Ledger");
  });
});
