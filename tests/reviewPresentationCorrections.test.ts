import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository, type IngestMediaRecord } from "../src/server/db/mediaRepository";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import { NoopRanker, type AiRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { diversifyFinalSlate } from "../src/server/recommendation/review/finalSlate";
import { createReviewCandidateEngine } from "../src/server/recommendation/review/candidateEngine";
import type { ReviewItem } from "../src/server/recommendation/review/types";
import type { RefinementOption, SearchRequest } from "../src/shared/types";

const databases: ReturnType<typeof createDatabase>[] = [];
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Presentation tests must remain offline."); })));
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.unstubAllGlobals(); });
const seerr = { allowsDescriptiveContent: () => false } as unknown as SeerrClient;
const row = (index: number, summary: string): ReviewItem => ({ id: `row-${index}`, title: `Record ${String(index).padStart(2, "0")}`,
  summary, genres: ["Drama"], mediaType: "movie", ratings: {}, availabilityGroup: "available_in_plex" });
const slate = (replacement: string) => Array.from({ length: 20 }, (_, index) => row(index, index === 5 ? replacement : "A calm film."));
function repository(records: IngestMediaRecord[]) {
  const db = createDatabase(":memory:"); databases.push(db);
  const result = new MediaRepository(db); result.upsertMany(records); return result;
}

describe("selected evidence contract in final presentation", () => {
  it.each(["A character feels bleak about tomorrow.", "A film that is bleak in one part but not bleak in another."])("does not give unsupported tone a diversity advantage: %s", summary => {
    const unknown = slate("A character walks home.");
    const changed = slate(summary);
    expect(diversifyFinalSlate(changed, { evidenceContract: true }).map(item => item.id))
      .toEqual(diversifyFinalSlate(unknown, { evidenceContract: true }).map(item => item.id));
  });

  it("retains legacy ordering as a control and preserves membership, protection, displacement and determinism", () => {
    const input = slate("A character feels bleak about tomorrow.");
    const legacy = diversifyFinalSlate(input);
    expect(diversifyFinalSlate(input, { evidenceContract: false })).toEqual(legacy);
    const options = { evidenceContract: true, maximumRankDisplacement: 3, lambda: 0.1 };
    const result = diversifyFinalSlate(input, options);
    expect(result.slice(0, 3)).toEqual(input.slice(0, 3));
    expect(result.map(item => item.id).sort()).toEqual(input.map(item => item.id).sort());
    for (const [position, item] of result.entries()) expect(Math.abs(input.indexOf(item) - position)).toBeLessThanOrEqual(3);
    expect(diversifyFinalSlate(input, options)).toEqual(result);
    const renamed = input.map(item => ({ ...item, title: `Bleak Intense ${item.title}` }));
    expect(diversifyFinalSlate(renamed, options).map(item => item.id)).toEqual(result.map(item => item.id));
  });

  it("uses the selected contract after an actual engine rerank while retaining its first three positions", async () => {
    const records = Array.from({ length: 20 }, (_, index) => ({
      title: `Observation ${String(index).padStart(2, "0")}`, mediaType: "movie" as const,
      summary: index === 14 ? "A character walks home." : "A calm film.", genres: ["Drama"], runtimeMinutes: 90,
      plex: { available: true, ratingKey: `observation-${index}` }
    }));
    const source = repository(records);
    const rankedOrders: string[][] = [];
    const ranker: AiRanker = { rank: async ({ candidates }) => {
      const results = [...candidates].sort((a, b) => b.title.localeCompare(a.title));
      rankedOrders.push(results.map(item => item.title));
      return { usedAi: true, results };
    } };
    const engine = createReviewCandidateEngine({ repository: source, seerrClient: seerr, ranker }, "revisedCombined");
    const first = await engine.recommend({ query: "a movie", useAi: true, resultLimit: 20 });
    source.upsert({ ...records[14], summary: "A character feels bleak about tomorrow." });
    const second = await engine.recommend({ query: "a movie", useAi: true, resultLimit: 20 });
    expect(rankedOrders).toHaveLength(2);
    expect(rankedOrders[0]).toHaveLength(20);
    expect(rankedOrders[1]).toEqual(rankedOrders[0]);
    expect(first.results.slice(0, 3).map(item => item.title)).toEqual(rankedOrders[0].slice(0, 3));
    expect(second.results.map(item => item.title)).toEqual(first.results.map(item => item.title));
  });
});

const baseRecord: IngestMediaRecord = {
  title: "Copper Ledger", mediaType: "movie", summary: "A thoughtful account of an investigation.", genres: ["Drama"],
  runtimeMinutes: 90, plex: { available: true, ratingKey: "copper-ledger" }
};
async function response(request: SearchRequest, suggestions?: RefinementOption[], records = [baseRecord]) {
  const source = repository(records);
  const ranker: AiRanker = suggestions ? { rank: async ({ candidates }) => ({ usedAi: true, results: candidates, refinementOptions: suggestions }) } : new NoopRanker();
  const engine = new RecommendationEngine(source, seerr, ranker);
  return engine.recommend({ ...request, useAi: suggestions !== undefined });
}

describe("returned refinements respect the original request", () => {
  it.each(["a drama, not comedy", "I'm anxious, but I want a drama, not comedy", "I'm not anxious, I want a drama, not comedy"])("keeps built-in options consistent with %s", async query => {
    const result = await response({ query });
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.refinementOptions.length).toBeGreaterThanOrEqual(3);
    expect(result.refinementOptions.map(option => option.label)).not.toContain("Warmer laughs");
    expect(result.refinementOptions.map(option => option.label)).not.toContain("Sharper comedy");
  });

  it("does not offer more suspense when the original coordination excludes it", async () => {
    const result = await response({ query: "a drama, no horror or suspense" });
    expect(result.refinementOptions.map(option => option.label)).not.toContain("More tension");
    expect(result.refinementOptions.length).toBeGreaterThanOrEqual(3);
  });

  it("screens conflicting injected suggestions and fills the returned set with compatible alternatives", async () => {
    const result = await response({ query: "a drama, no horror or suspense and not comedy" }, [
      { label: "More horror", prompt: "Make the next set scarier, with horror films." },
      { label: "Sharper comedy", prompt: "Make the next set funny and full of comedy." },
      { label: "More tension", prompt: "Turn up the suspense in the next set." }
    ]);
    expect(result.aiRerank.status).toBe("applied");
    expect(result.refinementOptions.length).toBeGreaterThanOrEqual(3);
    expect(result.refinementOptions.map(option => option.label)).not.toEqual(expect.arrayContaining(["More horror", "Sharper comedy", "More tension"]));
    for (const option of result.refinementOptions) expect(`${option.label} ${option.prompt}`).not.toMatch(/\b(?:horror|comedy|suspense|scarier)\b/i);
  });

  it("does not confuse a Horror exclusion with a prohibition of suspense", async () => {
    const result = await response({ query: "a drama, no horror" }, [
      { label: "More tension", prompt: "Turn up the suspense without horror." },
      { label: "Keep horror out", prompt: "Keep the next set free of horror and focus on human drama." }
    ]);
    expect(result.refinementOptions.map(option => option.label)).toContain("More tension");
  });

  it("honours explicit filter exclusions even when the query and leading genres invite comedy", async () => {
    const result = await response({ query: "funny mystery", filters: { excludedGenres: ["Comedy"] } }, [
      { label: "Comic turn", prompt: "Add some comedy to the next set." }
    ]);
    expect(result.refinementOptions.map(option => option.label)).not.toContain("Comic turn");
    expect(result.refinementOptions.map(option => option.label)).not.toContain("Warmer laughs");
    expect(result.refinementOptions.map(option => option.label)).not.toContain("Sharper comedy");
  });

  it("does not recommend relaxing an explicit availability or media-type constraint", async () => {
    const result = await response({ query: "a drama", filters: { availability: ["available_in_plex"], mediaTypes: ["movie"] } }, [
      { label: "Try a series", prompt: "Show me TV series instead." },
      { label: "Request films", prompt: "Show me Seerr-requestable movies instead." }
    ]);
    expect(result.refinementOptions.map(option => option.label)).not.toContain("Try a series");
    expect(result.refinementOptions.map(option => option.label)).not.toContain("Request films");
    expect(result.refinementOptions.map(option => option.label)).not.toContain("Include requests");
  });
});
