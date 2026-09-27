/** Repository-level integration tests. Run under the supported Node 24 Vitest suite. */
import { describe, it } from "vitest";
import assert from "node:assert/strict";
import type { ItemDetail } from "../src/shared/types";
import { scoreLibraryCandidates } from "../src/server/recommendation/scoring";
import { parseRecommendationIntent, mergeHardFilters } from "../src/server/recommendation/intent";
import { buildRecommendationBrief } from "../src/server/recommendation/brief";
import { projectViewingBrief } from "../src/server/recommendation/viewingIntent";
import { resolveRankingExperiments } from "../src/server/recommendation/rankingExperiments";
import { reviewArms } from "../src/server/recommendation/review/candidateEngine";
import { prepareReviewScoringContext, reviewSemanticScore } from "../src/server/recommendation/review/adapter";
const item = (id: string, changes: Partial<ItemDetail> = {}): ItemDetail => ({
  id, title: id, mediaType: "movie", genres: [], ratings: {}, score: 0,
  posterUrl: "", availabilityExplanation: "Available", availabilityGroup: "available_in_plex",
  matchExplanation: "", plex: { available: true }, cast: [], directors: [], externalIds: {}, ...changes
});
function rank(query: string, items: ItemDetail[], filters = {}) {
  const intent = parseRecommendationIntent(query);
  const brief = buildRecommendationBrief({ query, filters }, intent, mergeHardFilters(intent.hardFilters, filters), "solo", 10);
  const projected = projectViewingBrief(query, brief, intent, filters);
  return scoreLibraryCandidates(items, query, projected.brief.hardFilters, "solo", {
    resolvedIntent: projected.intent, rankingExperiments: reviewArms.combined,
    allItems: items, captureScoreTrace: true
  });
}
describe("review candidate wiring", () => {
  it("retains a candidate with unknown aesthetic evidence", () => assert.ok(rank("visually dark movie", [item("unknown")]).results.some(result => result.id === "unknown")));
  it("keeps an explicit genre exclusion authoritative", () => assert.ok(!rank("no horror movie", [item("horror", { genres: ["Horror"], summary: "A coastal journey." })]).results.length));
  it("rejects explicit descriptive avoidance", () => assert.ok(!rank("no surreal movie", [item("surreal", { summary: "A surreal journey." })]).results.length));
  it("preserves explicit runtime filters", () => assert.ok(!rank("gentle movie", [item("long", { runtimeMinutes: 180 })], { maxRuntimeMinutes: 90 }).results.length));
  it("requires the shared-intent contract for evidence scoring", () => assert.throws(() => resolveRankingExperiments({ evidenceAwareScoring: true })));
  it("does not revive the rejected fixed-eight control", () => assert.throws(() => resolveRankingExperiments({ sharedIntent: true, evidenceAwareScoring: true, boundedPersonalization: true })));
  it("does not reuse semantic ranks across request-local snapshots", () => {
    const source = { rankingExperiments: { semanticRankFusion: true }, semanticScores: new Map([["a", 1], ["b", 0.5]]) };
    const first = prepareReviewScoringContext(source);
    source.semanticScores.set("b", 2);
    const second = prepareReviewScoringContext(source);
    assert.ok(reviewSemanticScore(first, "a")! > reviewSemanticScore(first, "b")!);
    assert.ok(reviewSemanticScore(second, "b")! > reviewSemanticScore(second, "a")!);
  });
  it("keeps contribution accounting consistent with the computed score", () => {
    const result = rank("gentle movie", [item("gentle", { summary: "A gentle and quiet story." })]);
    const trace = result.scoreTrace!.computationByItemId.get("gentle")!;
    assert.equal(Math.round(trace.buckets.reduce((sum, bucket) => sum + bucket.contribution, 0)), trace.deterministicScore);
  });
});
