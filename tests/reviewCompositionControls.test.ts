import { expect, it } from "vitest";
import { scoreReviewItem, type ReviewScoringInput } from "../src/server/recommendation/review/score";
import type { ReviewFacet, ReviewItem } from "../src/server/recommendation/review/types";
import { resolveRankingExperiments } from "../src/server/recommendation/rankingExperiments";
import { createReviewCandidateEngine } from "../src/server/recommendation/review/candidateEngine";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { NoopRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";

const item = (summary: string): ReviewItem => ({ id: "record", title: "Observation", summary, genres: [],
  mediaType: "movie", ratings: {}, availabilityGroup: "available_in_plex" });
const facet = (term: string, polarity: ReviewFacet["polarity"] = "prefer"): ReviewFacet => ({ term, polarity, source: "explicit" });
const base = { softGenres: [], positiveQuery: "", evidenceContract: true, separatedComposition: true };
function score(summary: string, facets: ReviewFacet[], options: Partial<ReviewScoringInput> = {}) {
  return scoreReviewItem(item(summary), { ...base, facets, ...options });
}

it("isolates composition structure at the original single-facet amplitude", () => {
  const legacy = score("A warm story.", [facet("warm")], { separatedComposition: false });
  const half = score("A warm story.", [facet("warm")]);
  const equal = score("A warm story.", [facet("warm")], { equalAmplitudeComposition: true });
  expect(legacy.features.mood).toBe(85);
  expect(half.features.mood).toBe(67.5);
  expect(equal.features.mood).toBe(85);
  expect(equal.contributions.find(value => value.feature === "mood")?.weight).toBe(0.23);
});

it("rewards independent requested coverage while retaining the maximum-support control", () => {
  const facets = [facet("warm"), facet("witty")];
  const partial = score("A warm story.", facets, { coverageComposition: true });
  const full = score("A warm and witty story.", facets, { coverageComposition: true });
  expect(partial.features.mood).toBe(58.75);
  expect(full.features.mood).toBe(67.5);
  expect(score("A warm story.", facets).features.mood).toBe(score("A warm and witty story.", facets).features.mood);
  expect(score("A warm story.", facets, { coverageComposition: true, equalAmplitudeComposition: true }).features.mood).toBe(67.5);
});

it("does not dilute contradiction or reduction when coverage includes unknown facets", () => {
  for (const polarity of ["prefer", "reduce"] as const) {
    const summary = polarity === "prefer" ? "A movie that is not warm." : "A bleak movie.";
    const requested = [facet(polarity === "prefer" ? "warm" : "bleak", polarity)];
    for (const equalAmplitudeComposition of [false, true]) {
      const options = { coverageComposition: true, equalAmplitudeComposition };
      const one = score(summary, requested, options);
      const unknown = score(summary, [...requested, facet("unmapped sensation")], options);
      expect(one.features.mood).toBeLessThan(50);
      expect(unknown.features.mood).toBe(one.features.mood);
    }
  }
});

it("counts canonical requested facets once and never credits repeated statements twice", () => {
  const options = { coverageComposition: true };
  const ordinary = score("A calm story.", [facet("calm"), facet("witty")], options);
  const duplicated = score("A calm, calming story. A calm story.", [facet("calm"), facet("calming"), facet("witty")], options);
  expect(ordinary.features.mood).toBe(58.75);
  expect(duplicated.features).toEqual(ordinary.features);
});

it("holds reduction and reference budgets fixed in the desired-amplitude comparison", () => {
  const facets = [facet("warm"), facet("bleak", "reduce")];
  const reference = { ...item("A very bleak movie."), id: "reference" };
  const ordinary = score("A warm and mildly bleak movie.", facets, { reference });
  const equal = score("A warm and mildly bleak movie.", facets, { reference, equalAmplitudeComposition: true });
  expect(ordinary.composition!.reductionPenalty).toBeGreaterThan(0);
  expect(ordinary.composition!.referenceTransformation).toBeGreaterThan(0);
  expect(equal.composition!.reductionPenalty).toBe(ordinary.composition!.reductionPenalty);
  expect(equal.features.reference).toBe(ordinary.features.reference);
});

it("explains unsupported and contradicted facets even when another requested facet is supported", () => {
  const unknown = score("A warm story.", [facet("warm"), facet("witty")]);
  const contradicted = score("A warm movie that is not witty.", [facet("warm"), facet("witty")]);
  expect(unknown.explanation).toMatch(/not established[^.]*witty/i);
  expect(contradicted.explanation).toMatch(/contradicted[^.]*witty/i);
  expect(unknown.explanation).not.toMatch(/not established[^.]*warm/i);
});

it("keeps inferred enrichment out of requested coverage and requested-facet explanations", () => {
  const requested = [facet("warm"), facet("witty")];
  const ordinary = score("A warm story.", requested, { coverageComposition: true });
  const enriched = score("A warm story.", [...requested, { term: "gentle", polarity: "prefer", source: "enrichment" }], { coverageComposition: true });
  expect(enriched.features.mood).toBe(ordinary.features.mood);
  expect(enriched.explanation).not.toMatch(/gentle/);
});

it("bounds stronger composition when combined contradictions exceed the mood budget", () => {
  const result = score("A movie that is not warm but is bleak.", [facet("warm"), facet("bleak", "reduce")], { equalAmplitudeComposition: true });
  expect(result.features.mood).toBe(0);
  expect(result.composition!.desiredContribution).toBe(-35);
  expect(result.composition!.reductionPenalty).toBe(17.5);
});

it("rejects unsupported composition control combinations and retains an empty default", () => {
  expect(resolveRankingExperiments()).toEqual({});
  for (const flag of ["equalAmplitudeComposition", "coverageComposition"] as const) {
    expect(() => resolveRankingExperiments({ [flag]: true })).toThrow(/composition_control_requires_separated_composition/);
  }
});

it("carries separate coverage and amplitude controls through the actual engine", async () => {
  const db = createDatabase(":memory:");
  try {
    const repository = new MediaRepository(db);
    repository.upsertMany([
      { title: "A partial", summary: "A warm story." },
      { title: "Z complete", summary: "A warm and witty story." }
    ].map(record => ({ ...record, mediaType: "movie" as const, genres: [], plex: { available: true, ratingKey: record.title } })));
    const dependencies = { repository, seerrClient: { allowsDescriptiveContent: () => false } as unknown as SeerrClient, ranker: new NoopRanker() };
    const maximum = await createReviewCandidateEngine(dependencies, "claimComposition").recommend({ query: "warm and witty movie", useAi: false });
    const coverage = await createReviewCandidateEngine(dependencies, "claimCompositionCoverage").recommend({ query: "warm and witty movie", useAi: false });
    const equal = await createReviewCandidateEngine(dependencies, "claimCompositionEqualAmplitude").recommend({ query: "warm and witty movie", useAi: false });
    const both = await createReviewCandidateEngine(dependencies, "claimCompositionCoverageEqualAmplitude").recommend({ query: "warm and witty movie", useAi: false });
    expect(coverage.results[0].title).toBe("Z complete");
    const partial = (result: typeof maximum) => result.results.find(value => value.title === "A partial")!.scoreBreakdown!.mood!;
    expect(partial(coverage)).toBeLessThan(partial(maximum));
    expect(partial(equal)).toBeGreaterThan(partial(maximum));
    expect(partial(both)).toBe(partial(maximum));
    expect(both.results[0].title).toBe("Z complete");
  } finally { db.close(); }
});
