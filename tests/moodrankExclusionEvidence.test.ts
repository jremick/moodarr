import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { NoopRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import { buildRecommendationBrief } from "../src/server/recommendation/brief";
import { parseRecommendationIntent } from "../src/server/recommendation/intent";
import { reviewCandidateRankingExperiments, type RankingExperiments } from "../src/server/recommendation/rankingExperiments";
import { allowsViewingTerm, conflictsWithViewingIntent, projectViewingBrief } from "../src/server/recommendation/viewingIntent";

const databases: DatabaseSync[] = [];
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Exclusion regressions must remain offline"); })));
afterEach(() => { databases.splice(0).forEach((db) => db.close()); vi.unstubAllGlobals(); });

function engineFor(summaries: string[], genres: string[], flags?: RankingExperiments) {
  const db = createDatabase(":memory:"); databases.push(db);
  const repository = new MediaRepository(db);
  repository.upsertMany(summaries.map((summary, index) => ({ title: `Observer ${index}`, summary, genres,
    mediaType: "movie" as const, year: 2024, runtimeMinutes: 85,
    plex: { available: true, ratingKey: String(index) } })));
  return new RecommendationEngine(repository, { allowsDescriptiveContent: () => false } as unknown as SeerrClient,
    new NoopRanker(), undefined, undefined, undefined, undefined, undefined, undefined, flags);
}

function viewingIntent(query: string) {
  const intent = parseRecommendationIntent(query);
  return projectViewingBrief(query, buildRecommendationBrief({ query }, intent, intent.hardFilters, "solo", 10), intent).brief.viewingIntent!;
}

describe("director credits are not prohibited content", () => {
  it.each([
    { name: "default", flags: undefined },
    { name: "review candidate", flags: reviewCandidateRankingExperiments }
  ])("preserves harmless credits and rejects actual gore through the $name engine", async ({ flags }) => {
    const engine = engineFor([
      "Two brothers try to evict a mouse from an old house.",
      "Two brothers try to evict a mouse from an old house. Directed by Gore Verbinski.",
      "A comedy with explicit gore throughout. Directed by Gore Verbinski."
    ], ["Comedy"], flags);
    const response = await engine.recommend({ query: "comedy, no gore", useAi: false });
    expect(response.results.map((item) => item.title).sort()).toEqual(["Observer 0", "Observer 1"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("applies the same evidence boundary when checking a viewing intent directly", () => {
    expect(conflictsWithViewingIntent(viewingIntent("no gore"), "A family adventure. Directed by Gore Verbinski.")).toBe(false);
    expect(conflictsWithViewingIntent(viewingIntent("no gore"), "Gore throughout. Directed by Gore Verbinski.")).toBe(true);
  });
});

describe("compound exclusions keep their complete meaning", () => {
  it.each([
    { query: "documentary with no true crime", genres: ["Documentary"],
      acceptable: "A true story about a gentle community gardening project.",
      prohibited: "A documentary investigating a true crime case.",
      negated: "A study of a community garden without true crime." },
    { query: "no time travel", genres: ["Drama"],
      acceptable: "Two friends spend time together in a cafe.",
      prohibited: "An experiment in time travel changes two friends' lives.",
      negated: "Two friends share a journey without time travel." },
    { query: "comedy with no dark comedy", genres: ["Comedy"],
      acceptable: "An upbeat comedy about people working after dark.",
      prohibited: "A dark comedy about two neighbours.",
      negated: "A light comedy without dark comedy." },
    { query: "a story with no jump scares", genres: ["Drama"],
      acceptable: "A jump into a new career brings unexpected friendships.",
      prohibited: "A story full of jump scares.",
      negated: "An adventure without jump scares." },
    { query: "no police violence", genres: ["Drama"],
      acceptable: "The police study a lost painting.",
      prohibited: "A drama about police violence.",
      negated: "An investigation without police violence." }
  ])("keeps matching individual words eligible for $query", async ({ query, genres, acceptable, prohibited, negated }) => {
    const engine = engineFor([acceptable, prohibited, negated], genres, reviewCandidateRankingExperiments);
    const response = await engine.recommend({ query, useAi: false });
    expect(response.results.map((item) => item.title).sort()).toEqual(["Observer 0", "Observer 2"]);
  });

  it("keeps a separately preferred word outside the excluded phrase", () => {
    const intent = viewingIntent("no time travel; time together");
    expect(conflictsWithViewingIntent(intent, "Two friends spend time together.")).toBe(false);
    expect(conflictsWithViewingIntent(intent, "Two friends discover time travel.")).toBe(true);
    expect(allowsViewingTerm(intent, "time")).toBe(true);
    expect(intent.positiveQuery).toContain("time together");
  });

  it("keeps coordinated single-word prohibitions after a compound", () => {
    expect(conflictsWithViewingIntent(viewingIntent("no time travel and gore"), "Gore throughout.")).toBe(true);
  });

  it("preserves direct cues followed by generic content nouns", () => {
    expect(conflictsWithViewingIntent(viewingIntent("no surreal imagery"), "A surreal drama with dream imagery.")).toBe(true);
  });

  it("preserves reduction, affirmative not-only mentions and marked refinements", () => {
    for (const query of ["less time travel", "not only time travel but romance", "no time travel. Follow-up refinement: time travel"]) {
      expect(conflictsWithViewingIntent(viewingIntent(query), "A time travel adventure.")).toBe(false);
    }
    const intent = viewingIntent("time travel. Follow-up refinement: no time travel");
    expect(conflictsWithViewingIntent(intent, "A time travel adventure.")).toBe(true);
    expect(conflictsWithViewingIntent(intent, "Friends spend time together.")).toBe(false);
    expect(intent.positiveQuery).not.toContain("time travel");
  });
});
