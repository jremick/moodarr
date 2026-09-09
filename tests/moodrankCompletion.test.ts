import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import { NoopRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import type { DatabaseSync } from "node:sqlite";
import { buildRecommendationBrief } from "../src/server/recommendation/brief";
import { mergeHardFilters, parseRecommendationIntent, relaxDegreeGenreFilters } from "../src/server/recommendation/intent";
import { projectViewingBrief, conflictsWithViewingIntent, strictViewingQuery } from "../src/server/recommendation/viewingIntent";
import { createContentCueMatcher } from "../src/server/recommendation/queryCuePolarity";
import { scoreLibraryCandidates } from "../src/server/recommendation/scoring";
import { retrieveRecommendationCandidates } from "../src/server/recommendation/retrieval";
import { reviewCandidateRankingExperiments } from "../src/server/recommendation/rankingExperiments";
import { scoreTraceHasMismatch } from "../scripts/evaluate-moodrank-traces";
import type { SearchFilters } from "../src/shared/types";

const databases: DatabaseSync[] = [];
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Offline test"); })));
afterEach(() => { databases.splice(0).forEach((db) => db.close()); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function project(query: string, filters: SearchFilters = {}) {
  const original = parseRecommendationIntent(query);
  const resolved = mergeHardFilters(original.hardFilters, filters);
  return projectViewingBrief(query, buildRecommendationBrief({ query, filters }, original, resolved, "solo", 10), original, filters);
}
function setup() {
  const db = createDatabase(":memory:"); databases.push(db);
  const repository = new MediaRepository(db);
  repository.upsertMany([
    { title: "Pattern Walk", summary: "An offbeat, non-exhausting comedy with dry jokes and ordinary human relationships.", genres: ["Comedy"] },
    { title: "Pattern Dream", summary: "An offbeat surreal drama with dream imagery and strange rituals.", genres: ["Drama"] },
    { title: "Night Shadows", summary: "A spooky horror story with controlled tension and mild scares.", genres: ["Horror"] }
  ].map((record) => ({ ...record, mediaType: "movie" as const, runtimeMinutes: 88, year: 2024, contentRating: "PG-13", plex: { available: true, ratingKey: record.title } })));
  const seerr = { allowsDescriptiveContent: () => false } as unknown as SeerrClient;
  const engine = new RecommendationEngine(repository, seerr, new NoopRanker(), undefined, undefined, undefined, undefined, undefined, undefined, reviewCandidateRankingExperiments);
  return { db, repository, engine };
}

describe("surface-preserving shared intent", () => {
  it.each(["feel-good comedy for tonight", "a quiet meditative slow-burn film", "warm story for us tonight"])("preserves affirmative surface and context: %s", (query) => {
    expect(project(query).brief.viewingIntent!.positiveQuery).toBe(query);
  });
  it.each(["I'm not sad", "I am not feeling sad", "I don't feel sad", "We're not anxious"])("treats denied current emotion as state context, not a content exclusion: %s", (query) => {
    const intent = project(query).brief.viewingIntent!;
    expect(intent.currentFeelings).toEqual([]);
    expect(intent.deniedCurrentFeelings).toHaveLength(1);
    expect(intent.facets).toEqual([]);
    expect(intent.positiveQuery).toBe("");
    expect(intent.ambiguous).toBe(true);
  });
  it("retains desired sadness even when current sadness is denied", () => {
    const intent = project("I'm not sad, but I want a sad film").brief.viewingIntent!;
    expect(intent.currentFeelings).toEqual([]);
    expect(intent.facets).toContainEqual(expect.objectContaining({ term: "sad", polarity: "prefer" }));
    expect(intent.positiveQuery).toContain("sad film");
  });
  it.each(["I don't want something to make me cry", "not something to cheer me up"])("does not use negated effects as attracting tokens: %s", (query) => {
    const { brief } = project(query);
    expect(brief.viewingIntent!.requestedEffect).toBe("unspecified");
    expect(brief.viewingIntent!.positiveQuery).not.toMatch(/\b(?:cry|sad|cheer|feel-good)\b/);
    expect(brief.softSignals.terms).not.toContain("cry");
  });
  it("keeps lack of mood-index hits from restoring a negated fallback cue", async () => {
    const { repository } = setup();
    vi.spyOn(repository, "searchMoodFeatureScores").mockReturnValue([]);
    const f = repository.featureMap();
    for (const value of f.values()) { value.moodTerms = ["romantic"]; value.toneTerms = []; value.watchabilityTerms = []; value.featureText = "romantic"; }
    vi.spyOn(repository, "featureMapByIds").mockReturnValue(f);
    const found = await retrieveRecommendationCandidates(repository, project("not romantic").brief);
    expect([...found.context.moodScores.values()]).toEqual([50, 50, 50]);
  });
});

describe("direct prohibitions and degree-aware constraints", () => {
  it.each(["no surreal imagery", "not surreal"])("excludes affirmative contrary evidence through default scoring: %s", (query) => {
    const { repository } = setup();
    const scored = scoreLibraryCandidates(repository.list(), `offbeat story; ${query}`, {}, "solo", { features: repository.featureMap(), captureScoreTrace: true });
    expect(scored.results.map((item) => item.title)).toContain("Pattern Walk");
    expect(scored.results.map((item) => item.title)).not.toContain("Pattern Dream");
    expect([...scored.scoreTrace!.computationByItemId.values()].some((trace) => trace.disqualified)).toBe(true);
  });
  it("does not claim a reduced preference or missing/title-only evidence is a prohibition", () => {
    expect(conflictsWithViewingIntent(project("less surreal").brief.viewingIntent, "A surreal story")).toBe(false);
    expect(conflictsWithViewingIntent(project("not surreal").brief.viewingIntent, undefined)).toBe(false);
    expect(conflictsWithViewingIntent(project("not surreal").brief.viewingIntent, "A story without surreal imagery")).toBe(false);
    expect(conflictsWithViewingIntent(project("not surreal").brief.viewingIntent, "A surreal story")).toBe(true);
  });
  it.each(["less horror", "not too scary", "not overly scary"])("does not hard-exclude a genre from degree language: %s", (query) => {
    const projected = project(query);
    expect(projected.brief.hardFilters.excludedGenres ?? []).not.toContain("Horror");
    expect(strictViewingQuery(projected.brief.viewingIntent, query)).not.toMatch(/horror|scary/);
  });
  it("preserves separate explicit exclusions, UI filters, bounds and the original object", () => {
    const filters = { excludedGenres: ["Horror", "Romance"], maxRuntimeMinutes: 90 };
    expect(relaxDegreeGenreFilters("less horror", filters, { excludedGenres: ["Horror"] })).toEqual(filters);
    expect(relaxDegreeGenreFilters("less horror, but absolutely no horror", filters, {})).toEqual(filters);
    expect(relaxDegreeGenreFilters("less horror", filters, {})).toEqual({ excludedGenres: ["Romance"], maxRuntimeMinutes: 90 });
    expect(filters.excludedGenres).toEqual(["Horror", "Romance"]);
  });
  it("preserves the difference through final recommendations and explicit UI overrides", async () => {
    const { engine } = setup();
    const reduced = await engine.recommend({ query: "less horror", useAi: false });
    const prohibited = await engine.recommend({ query: "no horror", useAi: false });
    const explicit = await engine.recommend({ query: "less horror", useAi: false, filters: { excludedGenres: ["Horror"] } });
    expect(reduced.results.map((item) => item.title)).toContain("Night Shadows");
    expect(prohibited.results.map((item) => item.title)).not.toContain("Night Shadows");
    expect(explicit.results.map((item) => item.title)).not.toContain("Night Shadows");
  });
  it.each(["A non-exhausting story", "Atmosphere instead of supernatural horror", "A romance-free story"])("keeps negative descriptive morphology out of positive evidence: %s", (text) => {
    const cue = text.includes("exhausting") ? /\bexhausting\b/i : text.includes("horror") ? /\bhorror\b/i : /\bromance\b/i;
    expect(createContentCueMatcher(text).has(cue)).toBe(false);
    expect(createContentCueMatcher(text + "; horror and romance and exhausting material elsewhere").has(cue)).toBe(true);
  });
});

describe("audit useful personalisation instead of activating a harmful fixed cap", () => {
  it.each([-6, 6])("preserves score, rank and nontrivial learned effect for weight %s", (weight) => {
    const { repository } = setup();
    const items = repository.list();
    const f = repository.featureMap();
    const context = { features: f, preferenceWeights: new Map([["genre:comedy", weight]]), feelProfile: { id: "test", label: "test", watchContext: "solo" as const,
      terms: [{ term: "cozy", confidence: 1, evidenceCount: 100, featureWeights: { "genre:comedy": weight, "mood:funny": weight } }] } };
    const baseline = scoreLibraryCandidates(items, "cozy", {}, "solo", context);
    const audited = scoreLibraryCandidates(items, "cozy", {}, "solo", { ...context, rankingExperiments: { personalizationAudit: true } });
    expect(audited.results).toEqual(baseline.results);
    const traces = [...audited.scoreTrace!.computationByItemId.values()];
    expect(traces.some((trace) => Math.abs(trace.personalization!.proposedDelta) > 8)).toBe(true);
    for (const trace of traces) {
      expect(trace.personalization!.policy).toBe("audit-only");
      expect(trace.personalization!.appliedDelta).toBe(trace.personalization!.proposedDelta);
      expect(trace.adjustments.some((value) => value.adjustment === "personalization_budget")).toBe(false);
    }
  });
  it("keeps the fixed-eight control out of the independent-review candidate", () => {
    expect(reviewCandidateRankingExperiments.boundedPersonalization).not.toBe(true);
    expect(reviewCandidateRankingExperiments.personalizationAudit).toBe(true);
    expect(Object.isFrozen(reviewCandidateRankingExperiments)).toBe(true);
  });
  it("validates audit arithmetic and rejects tampering without recording denied feeling text", async () => {
    vi.stubEnv("MOODRANK_TRACE_WRITE", "strict");
    const { db, engine } = setup();
    const response = await engine.recommend({ query: "I'm not sad; offbeat story", useAi: false, resultLimit: 1 });
    const row = db.prepare("SELECT score_trace_json FROM recommendation_results WHERE session_id = ?").get(response.sessionId!) as { score_trace_json: string };
    const counts = db.prepare("SELECT candidate_count, rerank_candidate_count, brief_trace_json FROM recommendation_sessions WHERE id = ?").get(response.sessionId!) as { candidate_count: number; rerank_candidate_count: number; brief_trace_json: string };
    const persisted = { itemId: response.results[0].id, score: response.results[0].score, rank: 1, usedAiRerank: false, candidateCount: counts.candidate_count, rerankCandidateCount: counts.rerank_candidate_count, aiRankedCandidateCount: 0, serializedCandidateCount: 0, resultCount: 1 };
    const trace = JSON.parse(row.score_trace_json);
    expect(trace.deterministic.personalization.policy).toBe("audit-only");
    expect(scoreTraceHasMismatch(trace, persisted)).toBe(false);
    trace.deterministic.personalization.appliedDelta += 1;
    expect(scoreTraceHasMismatch(trace, persisted)).toBe(true);
    expect(counts.brief_trace_json).not.toContain("sad");
    expect(fetch).not.toHaveBeenCalled();
  });
});
