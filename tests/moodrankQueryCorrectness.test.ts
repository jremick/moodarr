import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { parseRecommendationIntent } from "../src/server/recommendation/intent";
import { buildRecommendationBrief } from "../src/server/recommendation/brief";
import { buildRetrievalQuery, buildSemanticQuery } from "../src/server/recommendation/retrievalQueries";
import { scoreLibraryCandidates } from "../src/server/recommendation/scoring";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import { NoopRanker } from "../src/server/ai/ranker";
import { FeedbackSessionController } from "../src/client/feedbackSession";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import type { ItemDetail } from "../src/shared/types";

const databases: DatabaseSync[] = [];
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Offline correctness check"); })));
afterEach(() => { databases.splice(0).forEach(db => db.close()); vi.unstubAllGlobals(); });
function setup() {
  const db = createDatabase(":memory:"); databases.push(db);
  const repository = new MediaRepository(db);
  for (const title of ["The Midnight Horror Revue", "Padlock", "Harbour Lights 2", "The Harbour Lights", "A Plain Record"]) {
    repository.upsert({ title, mediaType: "movie", summary: "An observer records daily life.", runtimeMinutes: 85,
      plex: { available: true, ratingKey: title, libraryTitle: "Synthetic", libraryType: "movie" } });
  }
  const seerr = { allowsDescriptiveContent: () => false } as unknown as SeerrClient;
  return { repository, engine: new RecommendationEngine(repository, seerr, new NoopRanker()) };
}

describe("query roles across parsing, retrieval and feedback", () => {
  it.each([
    ["something like Paddington", "Paddington"], ["More like Paddington.", "Paddington"],
    ["like Knives Out but lighter", "Knives Out"], ["cozy mystery, less like Knives Out", undefined],
    ["cozy mystery. Less like Knives Out.", undefined], ["I don't like horror, something funny", undefined],
    ["nothing like Saw", undefined], ["I'd like something cozy", undefined],
    ["I feel like something funny", undefined], ["feels like a rainy Sunday", undefined],
    ["I do not like horror. Something like Paddington", "Paddington"]
  ])("extracts only positive references: %s", (query, expected) => {
    expect(parseRecommendationIntent(query).referenceTitle).toBe(expected);
  });
  it.each(["cozy mystery. Less like Knives Out.", "cozy mystery, less like Knives Out"])("keeps negative reference words out of positive retrieval: %s", query => {
    const intent = parseRecommendationIntent(query);
    const brief = buildRecommendationBrief({ query }, intent, intent.hardFilters, "solo", 10);
    expect(brief.feedback.lessLikeTitles).toEqual(["Knives Out"]);
    expect(intent.terms).not.toEqual(expect.arrayContaining(["knives", "out"]));
    expect(buildRetrievalQuery(brief)).not.toMatch(/knives|\bout\b/i);
    expect(buildSemanticQuery(brief)).not.toMatch(/knives|\bout\b/i);
  });
  it("resolves exact titles before word-prefix sequels and rejects interior matches", () => {
    const { repository } = setup();
    const titles = (query: string) => repository.inflateByIds(repository.findReferenceIdsByTitle([query])).map(item => item.title);
    expect(titles("horror")).toEqual([]);
    expect(titles("lock")).toEqual([]);
    expect(titles("harbour lights")).toEqual(["The Harbour Lights"]);
    expect(titles("harbour")).toEqual(expect.arrayContaining(["The Harbour Lights", "Harbour Lights 2"]));
  });
  it.each([
    ["light, not dark", "light"], ["intense thriller tonight", "intense"],
    ["something slightly scary", undefined], ["a delightful romcom", undefined],
    ["nothing dark, just funny", "funny"], ["Twilight but for adults", undefined],
    ["low commitment comedy", "low commitment"], ["dark, but not dark; something funny", "dark"]
  ])("returns the positive feedback term from the real engine: %s", async (query, expected) => {
    const { engine } = setup();
    const response = await engine.recommend({ query, useAi: false });
    expect(response).toHaveProperty("feedbackMoodTerm", expected);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("sends the server-selected term with card feedback, without guessing from query text", async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, eventId: 1, reliability: "high", appliedPreferenceSignal: true });
    const controller = new FeedbackSessionController(send, () => "synthetic-event");
    const input = { principalKey: "user:synthetic", searchGeneration: 1, sessionId: "synthetic-search", watchContext: "solo" as const,
      query: "light, not dark", feedbackMoodTerm: "light", items: [{ id: "item", title: "A Plain Record" }] };
    await controller.choose(controller.activate(input), "item", { slot: "rating", action: "more_like" });
    expect(send).toHaveBeenLastCalledWith(expect.objectContaining({ moodTerm: "light" }));
    await controller.choose(controller.activate({ ...input, feedbackMoodTerm: undefined }), "item", { slot: "rating", action: "more_like" });
    expect(send.mock.calls.at(-1)?.[0].moodTerm).toBeUndefined();
  });
});

describe("ranking precision", () => {
  it("orders different fractional utilities before the alphabetical fallback, keeping public scores integral", () => {
    const item = (id: string, rating: number): ItemDetail => ({ id, title: id, mediaType: "movie", genres: [], ratings: { critic: rating },
      score: 0, posterUrl: "", availabilityExplanation: "Available", availabilityGroup: "available_in_plex", matchExplanation: "",
      plex: { available: true }, cast: [], directors: [], externalIds: {}, summary: "An observer records daily life." });
    const items = [item("A lower", 8), item("Z higher", 8.1)];
    const defaults = scoreLibraryCandidates(items, "movie", {}, "solo", { captureScoreTrace: true });
    expect(defaults.results.map(item => item.id)).toEqual(["A lower", "Z higher"]);
    const scored = scoreLibraryCandidates(items, "movie", {}, "solo", { captureScoreTrace: true, rankingExperiments: { fractionalUtility: true } });
    const traces = scored.scoreTrace!.computationByItemId;
    expect(traces.get("Z higher")!.unroundedScore).toBeGreaterThan(traces.get("A lower")!.unroundedScore);
    expect(scored.results.map(item => item.id)).toEqual(["Z higher", "A lower"]);
    expect(scored.results.every(item => Number.isInteger(item.score))).toBe(true);
  });
});
