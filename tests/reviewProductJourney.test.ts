import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository, type IngestMediaRecord } from "../src/server/db/mediaRepository";
import { NoopRanker, type AiRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { createReviewCandidateEngine } from "../src/server/recommendation/review/candidateEngine";
import { evaluateTracePersistence } from "../scripts/evaluate-moodrank-traces";
import { UserRepository } from "../src/server/auth/userRepository";

const databases: DatabaseSync[] = [];
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("No provider or integration calls"); })));
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function setup(records: Partial<IngestMediaRecord>[], ranker: AiRanker = new NoopRanker()) {
  const db = createDatabase(":memory:"); databases.push(db);
  const repository = new MediaRepository(db);
  records.forEach((record, index) => repository.upsert({
    title: `Synthetic observation ${index}`, mediaType: "movie", year: 2020, runtimeMinutes: 90,
    summary: "An observer records changes in the landscape.", genres: [],
    plex: { available: true, ratingKey: `item-${index}`, libraryTitle: "Synthetic", libraryType: "movie" }, ...record
  }));
  const engine = createReviewCandidateEngine({ repository, seerrClient: { allowsDescriptiveContent: () => false } as unknown as SeerrClient, ranker }, "combined");
  return { db, repository, engine };
}

describe("experimental candidate final product journeys", () => {
  it("keeps adult group requests distinct from explicit family content filters", async () => {
    const { engine } = setup([
      { title: "Adult record", genres: ["Horror"], contentRating: "R", summary: "A dark and intense horror story for adults." },
      { title: "Family record", genres: ["Family"], contentRating: "G", summary: "A gentle and warm story for children." }
    ]);
    const adults = await engine.recommend({ query: "dark horror movie for adults", watchContext: "group", useAi: false });
    expect(adults.results.map(item => item.title)).toContain("Adult record");
    const family = await engine.recommend({ query: "gentle family movie", watchContext: "group", useAi: false,
      filters: { contentRating: "G", excludedGenres: ["Horror"] } });
    expect(family.results.map(item => item.title)).toEqual(["Family record"]);
  });
  it("keeps user feedback isolated and group learning explicitly shared", async () => {
    const { engine, repository, db } = setup([{ genres: ["Comedy"], summary: "A cozy and gentle story." }]);
    const users = new UserRepository(db);
    const alice = users.upsertPlexUser({ providerUserId: "synthetic-a", username: "alice" }, true);
    const bob = users.upsertPlexUser({ providerUserId: "synthetic-b", username: "bob" }, true);
    const solo = await engine.recommend({ query: "cozy movie", watchContext: "solo", useAi: false }, { authUserId: alice.id });
    const feedback = { action: "right_mood" as const, sessionId: solo.sessionId!, itemId: solo.results[0].id,
      watchContext: "solo" as const, moodTerm: solo.feedbackMoodTerm };
    expect(() => repository.recordFeelFeedback(feedback, bob.id)).toThrow();
    repository.recordFeelFeedback(feedback, alice.id);
    expect(repository.feelProfile("solo", alice.id).terms).toHaveLength(1);
    expect(repository.feelProfile("solo", bob.id).terms).toHaveLength(0);
    const group = await engine.recommend({ query: "cozy movie", watchContext: "group", useAi: false }, { authUserId: bob.id });
    repository.recordFeelFeedback({ ...feedback, sessionId: group.sessionId!, itemId: group.results[0].id, watchContext: "group" }, bob.id);
    expect(repository.feelProfile("group", alice.id)).toEqual(repository.feelProfile("group", bob.id));
    expect(repository.feelProfile("group", alice.id).terms).toHaveLength(1);
    expect(repository.feelProfile("solo", bob.id).terms).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("deduplicates before presentation and preserves verified requestability before attempts", async () => {
    const ranker: AiRanker = { rank: async ({ candidates }) => ({ usedAi: true,
      results: [...candidates].sort((a, b) => Number(Boolean(b.requestAttempt?.available)) - Number(Boolean(a.requestAttempt?.available))) }) };
    const { engine, repository } = setup([], ranker);
    const ids = ["Q930001", "Q930002", "Q930003"].map((qid, index) => repository.upsertCatalogRecord({
      source: "wikidata", sourceVersion: "synthetic-request-v1", sourceItemId: qid, licensePolicy: "wikidata-cc0",
      media: { title: index === 0 ? "Attempt record" : "Equivalent record", year: 2020, mediaType: "movie",
        genres: ["Drama"], summary: "A gentle story about a journey.", externalIds: { wikidata: qid, tmdb: 930001 + index } }
    }));
    for (const tmdb of [930002, 930003]) repository.upsert({ source: "operational", mediaType: "movie", title: `Movie ${tmdb}`,
      externalIds: { tmdb }, seerr: { tmdbId: tmdb, status: "unknown", requestable: true } });
    const response = await engine.recommend({ query: "I want to request a gentle movie", useAi: true, resultLimit: 10 });
    expect(response.results.map(item => item.title)).toEqual(["Equivalent record", "Attempt record"]);
    expect(response.results[0].availabilityGroup).toBe("not_in_plex_requestable");
    expect(response.results[1].id).toBe(ids[0]);
    expect(response.results[1].requestAttempt).toMatchObject({ available: true, seerrAvailabilityChecked: false });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["adult animation movie", { genres: ["Comedy"], summary: "A live action comedy about adults." }, { genres: ["Animation"], summary: "An animated comedy for adults." }],
    ["animated movie", { genres: ["Adventure"], summary: "A live action adventure." }, { genres: ["Animation"], summary: "An animated adventure." }],
    ["no musicals movie", { genres: ["Music"], summary: "A singer performs songs with a band on stage." }, { genres: ["Drama"], summary: "An observer records a journey." }],
    ["documentary movie", { genres: ["Drama"], summary: "A fictional story about a documentary crew." }, { genres: ["Documentary"], summary: "A nonfiction study of geology." }],
    ["documentary without true crime", { genres: ["Documentary"], summary: "A true crime investigation of a serial killer." }, { genres: ["Documentary"], summary: "A nonfiction study of geology." }]
  ] as const)("keeps explicit content boundaries: %s", async (query, excluded, allowed) => {
    const { engine } = setup([{ ...excluded, genres: [...excluded.genres], title: "Excluded record" }, { ...allowed, genres: [...allowed.genres], title: "Allowed record" }]);
    const response = await engine.recommend({ query, useAi: false });
    expect(response.results.map(item => item.title)).toContain("Allowed record");
    expect(response.results.map(item => item.title)).not.toContain("Excluded record");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps hidden IDs and year/runtime/availability filters through the full combined path", async () => {
    const { engine, repository } = setup([{ title: "Hidden record" }, { title: "Allowed record" }, { title: "Old record", year: 1980 }, { title: "Long record", runtimeMinutes: 190 }]);
    const hidden = repository.list().find(item => item.title === "Hidden record")!.id;
    const response = await engine.recommend({ query: "movie", useAi: false, filters: { minYear: 2000, maxRuntimeMinutes: 100, availability: ["available_in_plex"] }, feedbackContext: { hiddenItemIds: [hidden] } });
    expect(response.results.map(item => item.title)).toEqual(["Allowed record"]);
  });
  it("protects the reranked prefix, bounds final diversification and records its own stage", async () => {
    vi.stubEnv("MOODRANK_TRACE_WRITE", "strict");
    let rerankedIds: string[] = [];
    const ranker: AiRanker = { rank: async ({ candidates }) => {
      const results = [...candidates].reverse(); rerankedIds = results.map(item => item.id);
      return { usedAi: true, results, trace: { serializedCandidateCount: results.length, rankedItems: results.map((item, index) => ({ itemId: item.id, aiRank: index + 1, aiScore: item.score })) } };
    } };
    const { engine, db } = setup(Array.from({ length: 12 }, (_, index) => ({ summary: index === 0 ? "A bleak and sad story." : "A gentle and quiet story." })), ranker);
    const response = await engine.recommend({ query: "movie", useAi: true, resultLimit: 12 });
    const ids = response.results.map(item => item.id);
    expect(ids.slice(0, 3)).toEqual(rerankedIds.slice(0, 3));
    expect(new Set(ids)).toEqual(new Set(rerankedIds));
    expect(ids).not.toEqual(rerankedIds);
    expect(ids.every((id, rank) => Math.abs(rank - rerankedIds.indexOf(id)) <= 8)).toBe(true);
    const rows = db.prepare("SELECT score_trace_json FROM recommendation_results WHERE session_id = ?").all(response.sessionId!) as { score_trace_json: string }[];
    expect(rows).toHaveLength(12);
    for (const row of rows) expect(JSON.parse(row.score_trace_json).ranks.postPresentation).toBeTypeOf("number");
    expect(evaluateTracePersistence(db, { minTraces: 1, sampleTraces: 1 }, ":memory:")).toMatchObject({ ok: true });
    expect(fetch).not.toHaveBeenCalled();
  });
});
