import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository, type StoredMediaFeature } from "../src/server/db/mediaRepository";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import { NoopRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import type { ItemDetail } from "../src/shared/types";
import { buildMediaFeatureDocument } from "../src/server/recommendation/features";
import { normalizedExampleScores } from "../src/server/recommendation/feedbackAggregation";
import { scoreLibraryCandidates, type DeterministicScoreComputationTrace } from "../src/server/recommendation/scoring";
import { contributionExplanation, experientialSimilarity } from "../src/server/recommendation/rankingPresentation";
import type { RankingExperiments } from "../src/server/recommendation/rankingExperiments";
import { retrieveRecommendationCandidates } from "../src/server/recommendation/retrieval";
import { projectViewingBrief } from "../src/server/recommendation/viewingIntent";
import { buildRecommendationBrief } from "../src/server/recommendation/brief";
import { parseRecommendationIntent } from "../src/server/recommendation/intent";
import { scoreTraceHasMismatch } from "../scripts/evaluate-moodrank-traces";

const databases: DatabaseSync[] = [];
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Ranking experiment tests must remain offline"); })));
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function item(id: string, overrides: Partial<ItemDetail> = {}): ItemDetail {
  return { id, title: id, mediaType: "movie", year: 2024, summary: "A warm gentle story about friendship.", genres: ["Drama"], cast: [], directors: [],
    externalIds: {}, ratings: {}, posterUrl: "/fixture.svg", availabilityGroup: "available_in_plex", availabilityExplanation: "Available", plex: { available: true }, matchExplanation: "", score: 0, ...overrides };
}
function features(items: ItemDetail[]) {
  return new Map(items.map((item) => { const f = buildMediaFeatureDocument(item); return [item.id, { ...f, featureVersion: f.version }] as [string, StoredMediaFeature]; }));
}
const allFlags: RankingExperiments = { sharedIntent: true, normalizedFeedback: true, boundedPersonalization: true, experientialDiversity: true, groundedExplanations: true };
function engineFor(flags?: RankingExperiments) {
  const db = createDatabase(":memory:"); databases.push(db);
  const repository = new MediaRepository(db);
  const records = [
    { title: "Harbour Friends", summary: "A warm feel-good gentle comedy about kindness, hopeful friendship and lighthearted community life.", genres: ["Comedy"], runtimeMinutes: 85 },
    { title: "Autumn Farewell", summary: "A sad emotional drama about melancholy memories, grief and poignant farewells.", genres: ["Drama"], runtimeMinutes: 85 },
    { title: "Night Pursuit", summary: "A terrifying horror story full of gore and supernatural danger.", genres: ["Horror"], runtimeMinutes: 80 },
    { title: "Long Harbour Visit", summary: "A warm feel-good comedy about hopeful friendship.", genres: ["Comedy"], runtimeMinutes: 160 }
  ];
  repository.upsertMany(records.map((record) => ({ ...record, mediaType: "movie" as const, year: 2024, ratings: {}, plex: { available: true, ratingKey: record.title } })));
  const seerr = { allowsDescriptiveContent: () => false } as unknown as SeerrClient;
  return { db, repository, engine: new RecommendationEngine(repository, seerr, new NoopRanker(), undefined, undefined, undefined, undefined, undefined, undefined, flags) };
}

describe("normalised example feedback", () => {
  const target = item("target"); const a = item("a"); const b = item("b");
  const f = features([target, a, b]);
  f.get(target.id)!.vector = { a: 1 }; f.get(a.id)!.vector = { a: 0.2, b: Math.sqrt(0.96) }; f.get(b.id)!.vector = { ...f.get(a.id)!.vector };
  it("is invariant to repeated IDs within or across positive classes", () => {
    const once = normalizedExampleScores([target], f, [a], [], []);
    expect(normalizedExampleScores([target], f, [a, a], [a, a], [])).toEqual(once);
  });
  it("does not saturate merely because more equally weak examples are supplied", () => {
    const once = normalizedExampleScores([target], f, [], [a], []).get(target.id);
    expect(normalizedExampleScores([target], f, [], [a, b], []).get(target.id)).toBe(once);
    expect(once).toBeLessThan(70);
  });
  it("neutralises contradictory examples rather than selecting a hidden precedence", () => {
    expect(normalizedExampleScores([target], f, [a], [], [a]).get(target.id)).toBe(50);
  });
  it("does not invent similarity or type support for missing vectors", () => {
    expect(normalizedExampleScores([target], new Map([[target.id, f.get(target.id)!]]), [a], [], []).get(target.id)).toBe(50);
  });
  it("retains the direction of positive and negative examples", () => {
    expect(normalizedExampleScores([target], f, [], [a], []).get(target.id)).toBeGreaterThan(50);
    expect(normalizedExampleScores([target], f, [], [], [a]).get(target.id)).toBeLessThan(50);
  });
  it("keeps scores bounded for many references", () => {
    const result = normalizedExampleScores([target], f, [target, a, b], [a], [b]);
    expect(result.get(target.id)).toBeGreaterThanOrEqual(0); expect(result.get(target.id)).toBeLessThanOrEqual(100);
  });
});
describe("total personalization budget and explanations", () => {
  it.each([-6, 6])("caps all learned paths together with signed weights %s", (weight) => {
    const candidate = item("candidate"); const f = features([candidate]);
    const neutral = scoreLibraryCandidates([candidate], "cozy", {}, "solo", { features: f }).results[0];
    const profile = { id: "test", label: "test", watchContext: "solo" as const, terms: [{ term: "cozy", confidence: 1, evidenceCount: 100, featureWeights: { "genre:drama": weight, "mood:cozy": weight, "mood:feel good": weight } }] };
    const result = scoreLibraryCandidates([candidate], "cozy", {}, "solo", { features: f, feelProfile: profile, preferenceWeights: new Map([["genre:drama", weight]]), rankingExperiments: { boundedPersonalization: true } });
    const uncapped = scoreLibraryCandidates([candidate], "cozy", {}, "solo", { features: f, feelProfile: profile, preferenceWeights: new Map([["genre:drama", weight]]) }).results[0];
    expect(Math.abs(uncapped.score - neutral.score)).toBeGreaterThan(8);
    expect(Math.abs(result.results[0].score - neutral.score)).toBeLessThanOrEqual(8);
    const trace = result.scoreTrace!.computationByItemId.get(candidate.id)!;
    expect(trace.adjustments).toContainEqual(expect.objectContaining({ adjustment: "personalization_budget", value: neutral.score }));
    const sum = trace.buckets.reduce((sum, bucket) => sum + bucket.contribution, 0) + trace.adjustments.reduce((sum, value) => sum + value.contribution, 0);
    expect(sum).toBeCloseTo(trace.unroundedScore, 8);
  });
  it("does not allow personalization to reintroduce a hard-filter failure", () => {
    const candidate = item("candidate", { genres: ["Horror"] });
    expect(scoreLibraryCandidates([candidate], "not horror", {}, "solo", { features: features([candidate]), preferenceWeights: new Map([["genre:horror", 6]]), rankingExperiments: { boundedPersonalization: true } }).results).toEqual([]);
  });
  it("selects large actual contributions rather than generated reason order", () => {
    const trace: DeterministicScoreComputationTrace = { itemId: "test", deterministicScore: 50, unroundedScore: 50, disqualified: false, adjustments: [], buckets: [
      { bucket: "mood", value: 65, weight: 0.1, contribution: 6.5 }, { bucket: "query", value: 90, weight: 0.3, contribution: 27 }, { bucket: "quality", value: 95, weight: 0.2, contribution: 19 }
    ] };
    const explanation = contributionExplanation(item("test"), trace);
    expect(explanation).toContain("textual relevance and stored ratings");
    expect(explanation).not.toContain("mood-related relevance");
    expect(explanation).toContain("available in Plex");
  });
  it("does not assert experiential certainty for a missing summary", () => {
    const trace = { buckets: [] } as unknown as DeterministicScoreComputationTrace;
    expect(contributionExplanation(item("unknown", { summary: undefined }), trace)).toContain("uncertain");
  });
});
describe("experience-based diversity", () => {
  const a = { moodTerms: ["cozy"], toneTerms: ["gentle"], watchabilityTerms: ["easy"] };
  const b = { moodTerms: ["bleak"], toneTerms: ["tense"], watchabilityTerms: ["attention-heavy"] };
  it("distinguishes similar genres that deliver different experiences", () => {
    expect(experientialSimilarity(a, b, 1)).toBeLessThan(experientialSimilarity(a, a, 1));
  });
  it("does not reward missing experiential evidence as novelty", () => {
    expect(experientialSimilarity(undefined, b, 0.8)).toBe(0.8);
    expect(experientialSimilarity({ moodTerms: [], toneTerms: [], watchabilityTerms: [] }, b, 0.8)).toBe(0.8);
  });
  it("does not mistake availability tags for experiential overlap", () => {
    expect(experientialSimilarity({ moodTerms: [], toneTerms: [], watchabilityTerms: ["in-plex"] }, b, 0.5)).toBe(0.5);
  });
});
describe("actual engine experiment wiring", () => {
  it("keeps default and all-false results identical", async () => {
    const { engine } = engineFor(); const { engine: disabled } = engineFor({ sharedIntent: false });
    const request = { query: "warm comedy", useAi: false };
    const left = await engine.recommend(request); const right = await disabled.recommend(request);
    expect(right.results).toEqual(left.results);
    expect(right.diagnostics?.engineVersion).toBe(left.diagnostics?.engineVersion);
    expect(right.diagnostics?.rankingExperiments).toBeUndefined();
  });
  it("distinguishes desired uplift from desired sadness in the final response", async () => {
    const { engine } = engineFor({ sharedIntent: true });
    const uplift = await engine.recommend({ query: "I'm sad, cheer me up", useAi: false });
    const catharsis = await engine.recommend({ query: "I'm sad, let me cry", useAi: false });
    expect(uplift.results[0].title).toBe("Harbour Friends");
    expect(catharsis.results[0].title).toBe("Autumn Farewell");
    expect(uplift.diagnostics?.viewingIntent?.currentFeelingCount).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([undefined, allFlags])("preserves late original filters and hidden items, flags %s", async (flags) => {
    const { engine, repository } = engineFor(flags);
    const query = `${"a story about warm friendship ".repeat(24)}; under 90 minutes; not horror; in Plex`;
    const hidden = repository.list().find((item) => item.title === "Harbour Friends")!.id;
    const response = await engine.recommend({ query, useAi: false, feedbackContext: { hiddenItemIds: [hidden] } });
    expect(response.resolvedFilters.maxRuntimeMinutes).toBe(90);
    expect(response.resolvedFilters.excludedGenres).toContain("Horror");
    expect(response.results.every((item) => item.runtimeMinutes! <= 90 && item.id !== hidden && !item.genres.includes("Horror"))).toBe(true);
  });
  it("uses transient explanation computation without enabling persistent traces", async () => {
    vi.stubEnv("MOODRANK_TRACE_WRITE", "off");
    const { db, engine } = engineFor({ groundedExplanations: true });
    const response = await engine.recommend({ query: "warm comedy", useAi: false });
    expect(response.results[0].matchExplanation).toContain("scoring signals");
    const row = db.prepare("SELECT brief_trace_json FROM recommendation_sessions WHERE id = ?").get(response.sessionId!) as { brief_trace_json: string | null };
    expect(row.brief_trace_json).toBeNull();
  });
  it("persists only count-level intent metadata and validates corrected contribution traces", async () => {
    vi.stubEnv("MOODRANK_TRACE_WRITE", "strict");
    const { db, engine } = engineFor(allFlags);
    const response = await engine.recommend({ query: "I'm sad, cheer me up, no horror", useAi: false, resultLimit: 1 });
    const row = db.prepare("SELECT engine_version, brief_trace_json FROM recommendation_sessions WHERE id = ?").get(response.sessionId!) as { engine_version: string; brief_trace_json: string };
    expect(row.engine_version).toContain("+intent-ranking-v1-31");
    expect(row.brief_trace_json).not.toContain("sad");
    expect(row.brief_trace_json).not.toContain("cheer");
    expect(JSON.parse(row.brief_trace_json).viewingIntent.currentFeelingCount).toBe(1);
    const result = db.prepare("SELECT score_trace_json FROM recommendation_results WHERE session_id = ?").get(response.sessionId!) as { score_trace_json: string };
    const counts = db.prepare("SELECT candidate_count, rerank_candidate_count FROM recommendation_sessions WHERE id = ?").get(response.sessionId!) as { candidate_count: number; rerank_candidate_count: number };
    const persisted = { itemId: response.results[0].id, score: response.results[0].score, rank: 1, usedAiRerank: false, candidateCount: counts.candidate_count, rerankCandidateCount: counts.rerank_candidate_count, aiRankedCandidateCount: 0, serializedCandidateCount: 0, resultCount: 1 };
    expect(scoreTraceHasMismatch(JSON.parse(result.score_trace_json), persisted)).toBe(false);
    const corrupt = JSON.parse(result.score_trace_json); corrupt.deterministic.adjustments.find((adjustment: { adjustment: string }) => adjustment.adjustment === "personalization_budget").value -= 100;
    expect(scoreTraceHasMismatch(corrupt, persisted)).toBe(true);
    const duplicate = JSON.parse(result.score_trace_json);
    duplicate.deterministic.adjustments.push(duplicate.deterministic.adjustments.find((adjustment: { adjustment: string }) => adjustment.adjustment === "personalization_budget"));
    expect(scoreTraceHasMismatch(duplicate, persisted)).toBe(true);
    const unknown = JSON.parse(result.score_trace_json);
    unknown.deterministic.adjustments.push({ adjustment: "unknown-adjustment", contribution: 0 });
    expect(scoreTraceHasMismatch(unknown, persisted)).toBe(true);
  });
});

describe("shared projection and diversity integration", () => {
  it("uses the signed positive query for actual lexical retrieval, without negative-example attraction", async () => {
    const { repository } = engineFor();
    const query = "warm, not romantic, no music";
    const intent = parseRecommendationIntent(query);
    const projected = projectViewingBrief(query, buildRecommendationBrief({ query }, intent, intent.hardFilters, "solo", 5), intent);
    const search = vi.spyOn(repository, "searchFeatureIds");
    await retrieveRecommendationCandidates(repository, projected.brief);
    expect(search).toHaveBeenCalledWith(projected.brief.viewingIntent!.positiveQuery, 180);
    const used = search.mock.calls[0][0];
    expect(used).toContain("warm"); expect(used).not.toMatch(/romantic|romance|music/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not fall back to the negative raw text when positive intent is empty", async () => {
    const { repository } = engineFor();
    const query = "no music, not romantic";
    const intent = parseRecommendationIntent(query);
    const projected = projectViewingBrief(query, buildRecommendationBrief({ query }, intent, intent.hardFilters, "solo", 5), intent);
    const search = vi.spyOn(repository, "searchFeatureIds");
    await retrieveRecommendationCandidates(repository, projected.brief);
    expect(search.mock.calls[0][0]).toBe("");
  });
  it("keeps the protected prefix and limits every experiential promotion to eight points", () => {
    const items = Array.from({ length: 18 }, (_, index) => item(`choice-${String(index).padStart(2, "0")}`, { ratings: { critic: 98 - index * 4 } }));
    const f = features(items);
    for (const [index, candidate] of items.entries()) {
      f.get(candidate.id)!.moodTerms = index % 2 ? ["bleak"] : ["cozy"];
      f.get(candidate.id)!.toneTerms = index % 2 ? ["suspenseful"] : ["gentle"];
    }
    const context = { features: f, captureScoreTrace: true };
    const legacy = scoreLibraryCandidates(items, "ideas", {}, "solo", context);
    const experimental = scoreLibraryCandidates(items, "ideas", {}, "solo", { ...context, rankingExperiments: { experientialDiversity: true } });
    expect(experimental.results[0].id).toBe(legacy.results[0].id);
    expect(experimental.results.map((candidate) => candidate.id).sort()).toEqual(items.map((candidate) => candidate.id).sort());
    for (let rank = 1; rank < experimental.results.length; rank += 1) {
      const selected = experimental.results[rank];
      const bestRemaining = Math.max(...experimental.results.slice(rank).map((candidate) => candidate.score));
      expect(selected.score).toBeGreaterThanOrEqual(bestRemaining - 8);
    }
    expect([...experimental.scoreTrace!.rankByItemId.values()].filter((trace) => trace.diversity?.strategy === "mmr").length).toBeGreaterThan(0);
  });
  it("rejects unknown experiment switches before recommendation work", async () => {
    const { engine } = engineFor({ unsafe: true } as RankingExperiments);
    await expect(engine.recommend({ query: "warm comedy" })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
