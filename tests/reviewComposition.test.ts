import { afterEach, expect, it, vi } from "vitest";
import { buildRecommendationBrief } from "../src/server/recommendation/brief";
import { parseRecommendationIntent } from "../src/server/recommendation/intent";
import { projectViewingBrief } from "../src/server/recommendation/viewingIntent";
import { scoreReviewItem } from "../src/server/recommendation/review/score";
import type { ReviewFacet, ReviewItem } from "../src/server/recommendation/review/types";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { NoopRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { createReviewCandidateEngine } from "../src/server/recommendation/review/candidateEngine";
import { evaluateTracePersistence } from "../scripts/evaluate-moodrank-traces";

const item = (summary?: string, overrides: Partial<ReviewItem> = {}): ReviewItem => ({ id: "candidate", title: "Observation", summary,
  genres: [], mediaType: "movie", ratings: {}, availabilityGroup: "available_in_plex", ...overrides });
const facet = (term: string, polarity: ReviewFacet["polarity"] = "prefer"): ReviewFacet => ({ term, polarity, source: "explicit" });
function project(query: string) {
  const intent = parseRecommendationIntent(query);
  const brief = buildRecommendationBrief({ query }, intent, intent.hardFilters, "solo", 10);
  return projectViewingBrief(query, brief, intent, {}, { scopedComparatives: true }).intent.viewingIntent!;
}
function score(summary: string | undefined, facets: ReviewFacet[], reference?: ReviewItem) {
  return scoreReviewItem(item(summary), { facets, softGenres: [], positiveQuery: "", reference,
    evidenceContract: true, separatedComposition: true });
}

it.each([
  ["less bleak and more grounded", "bleak", "reduce", "grounded", "prefer"],
  ["less grim and much more gentle", "bleak", "reduce", "gentle", "prefer"],
  ["more grounded and less bleak", "grounded", "prefer", "bleak", "reduce"],
  ["less bleak and intense", "bleak", "reduce", "intense", "reduce"],
  ["not more violent and gentle", "violent", "avoid", "gentle", "avoid"]
])("interprets independently scoped comparative clauses: %s", (query, a, pa, b, pb) => {
  const result = project(query);
  expect(result.facets).toContainEqual(expect.objectContaining({ term: a, polarity: pa }));
  expect(result.facets).toContainEqual(expect.objectContaining({ term: b, polarity: pb }));
});
it.each(["light movie but not comedy, just emotionally easy", "a film with low emotional effort", "easy on the emotions, no comedy"])("keeps emotional effort compound and distinct from genre: %s", query => {
  const result = project(query);
  expect(result.facets).toContainEqual({ term: "emotionally easy", polarity: "prefer", source: "explicit" });
  expect(result.facets.some(value => ["just", "emotionally", "easy", "effort", "emotions"].includes(value.term))).toBe(false);
});
it("retains marked refinement precedence with the revised clause scope", () => {
  expect(project("less bleak and more grounded\nFollow-up refinement: not grounded").facets)
    .toContainEqual({ term: "grounded", polarity: "avoid", source: "explicit" });
});
it("does not dilute a reduction when an unknown request is added", () => {
  const base = score("A bleak story.", [facet("bleak", "reduce")]);
  const extra = score("A bleak story.", [facet("bleak", "reduce"), facet("unmapped experience")]);
  expect(extra.features.mood).toBe(base.features.mood);
  expect(extra.composition?.reductionPenalty).toBe(base.composition?.reductionPenalty);
  expect(extra.composition?.unknownTerms).toContain("unmapped experience");
});
it("does not dilute a reduction when supported positive facets are added", () => {
  const base = score("A bleak but warm story.", [facet("bleak", "reduce")]);
  const extra = score("A bleak but warm story.", [facet("bleak", "reduce"), facet("warm")]);
  expect(base.composition?.reductionPenalty).toBeGreaterThan(0);
  expect(extra.composition?.reductionPenalty).toBe(base.composition?.reductionPenalty);
  expect(extra.features.mood).toBeGreaterThan(base.features.mood);
});
it("does not give duplicate synonyms another contribution", () => {
  const base = score("A grim but warm story.", [facet("bleak", "reduce"), facet("warm")]);
  const repeated = score("A grim but warm story.", [facet("bleak", "reduce"), facet("grim", "reduce"), facet("warm")]);
  expect(repeated.features).toEqual(base.features);
  expect(repeated.composition).toEqual(base.composition);
});
it("retains uncertainty when a binary reference match cannot establish relative intensity", () => {
  const result = score("A bleak story.", [facet("bleak", "reduce")], item("A bleak story.", { id: "reference" }));
  expect(result.composition?.referenceTransformation).toBe(0);
  expect(result.composition?.unknownReferenceTerms).toEqual(["bleak"]);
  expect(result.explanation).toMatch(/relative intensity.*not established/i);
});
it("compares only explicit intensity on a common scale", () => {
  const ref = item("A very bleak story.", { id: "reference" });
  const milder = score("A mildly bleak story.", [facet("bleak", "reduce")], ref);
  const stronger = score("An extremely bleak story.", [facet("bleak", "reduce")], ref);
  expect(milder.composition?.referenceTransformation).toBeGreaterThan(stronger.composition!.referenceTransformation);
  expect(milder.composition?.unknownReferenceTerms).toEqual([]);
});
it("does not turn missing, mixed or character-scoped evidence into mood certainty", () => {
  for (const summary of [undefined, "A character feels bleak.", "A bleak story that is not bleak."]) {
    const result = score(summary, [facet("bleak", "reduce")]);
    expect(result.features.mood).toBe(50);
    expect(result.composition?.unknownTerms).toEqual(["bleak"]);
  }
});
it("keeps an explicit descriptive exclusion authoritative over secondary contributions", () => {
  const result = scoreReviewItem(item("A violent story.", { ratings: { critic: 100 } }), { facets: [facet("violent", "avoid")], softGenres: [],
    positiveQuery: "", preferenceScore: 100, feedbackScore: 100, lexicalScore: 100, semanticScore: 100, evidenceContract: true, separatedComposition: true });
  expect(result.rejected).toBe(true);
});
it("preserves the original evidence scorer as the matched extraction control", () => {
  const request = { facets: [facet("bleak", "reduce"), facet("unknown")], softGenres: [], positiveQuery: "" };
  const legacy = scoreReviewItem(item("A bleak story."), request);
  const extraction = scoreReviewItem(item("A bleak story."), { ...request, evidenceContract: true });
  // Extraction changes the reliability cap (.85 -> .70), while both retain
  // the old half-penalty and two-term denominator in this matched control.
  expect(legacy.features.mood).toBe(39.375);
  expect(extraction.features.mood).toBe(41.25);
  expect(extraction.composition).toBeUndefined();
});

const databases: ReturnType<typeof createDatabase>[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.unstubAllEnvs(); });
it("runs the revised final engine with exclusions, emotional effort, hidden IDs and trace accounting", async () => {
  vi.stubEnv("MOODRANK_TRACE_WRITE", "strict");
  const db = createDatabase(":memory:"); databases.push(db);
  const repository = new MediaRepository(db);
  repository.upsertMany([
    { title: "Eligible easy", genres: ["Drama"], summary: "An emotionally easy, gentle story.", runtimeMinutes: 85 },
    { title: "Hidden easy", genres: ["Drama"], summary: "An emotionally easy, gentle story.", runtimeMinutes: 85 },
    { title: "Wrong format", genres: ["Comedy"], summary: "An emotionally easy comedy.", runtimeMinutes: 85 },
    { title: "Too long", genres: ["Drama"], summary: "An emotionally easy story.", runtimeMinutes: 190 },
    { title: "Unknown effort", genres: ["Drama"], summary: "An observer records journeys.", runtimeMinutes: 85 }
  ].map(record => ({ ...record, mediaType: "movie" as const, plex: { available: true, ratingKey: record.title } })));
  const hidden = repository.list().find(value => value.title === "Hidden easy")!.id;
  const engine = createReviewCandidateEngine({ repository, seerrClient: { allowsDescriptiveContent: () => false } as unknown as SeerrClient, ranker: new NoopRanker() }, "revisedCombined");
  const response = await engine.recommend({ query: "emotionally easy movie, not comedy, under 100 minutes", useAi: false, resultLimit: 10, feedbackContext: { hiddenItemIds: [hidden] } });
  expect(response.results[0].title).toBe("Eligible easy");
  expect(response.results.map(value => value.title)).toEqual(["Eligible easy", "Unknown effort"]);
  expect(response.results[1].matchExplanation).toMatch(/not established/);
  const traces = db.prepare("SELECT score_trace_json FROM recommendation_results WHERE session_id = ?").all(response.sessionId!) as { score_trace_json: string }[];
  expect(traces.length).toBe(response.results.length);
  for (const row of traces) {
    const trace = JSON.parse(row.score_trace_json);
    expect(JSON.stringify(trace)).not.toMatch(/NaN|Infinity/);
  }
  const traceReport = evaluateTracePersistence(db, { minTraces: 1, sampleTraces: 1 }, ":memory:");
  expect(traceReport.assertionFailures).toEqual([]);
  expect(traceReport.ok).toBe(true);
});
