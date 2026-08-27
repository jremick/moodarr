import { describe, expect, it } from "vitest";
import type { ItemSummary } from "../src/shared/types";
import { evaluateRecommendationResults, type GoldenRecommendationCase } from "../src/server/recommendation/evaluation";

describe("recommendation evaluation metrics", () => {
  it("counts each required top-three title instead of treating a partial case hit as complete", () => {
    const cases: GoldenRecommendationCase[] = [
      {
        id: "two-required",
        query: "two useful results",
        watchContext: "solo",
        mustIncludeTop3: ["First", "Second"]
      }
    ];
    const outputs = new Map([[cases[0].id, [item("First"), item("Other")]]]);

    const result = evaluateRecommendationResults(cases, outputs);

    expect(result.top3HitRate).toBe(0.5);
    expect(result.top3AnyHitRate).toBe(1);
    expect(result.failureBreakdown.score_miss).toBe(1);
  });

  it("measures constraint accuracy only across constrained cases and enforces year bounds", () => {
    const cases: GoldenRecommendationCase[] = [
      {
        id: "unconstrained",
        query: "anything",
        watchContext: "solo"
      },
      {
        id: "nineties",
        query: "a nineties movie",
        watchContext: "solo",
        constraints: { mediaTypes: ["movie"], minYear: 1990, maxYear: 1999 }
      }
    ];
    const outputs = new Map([
      [cases[0].id, [item("Anything", { year: 2020 })]],
      [cases[1].id, [item("Too New", { year: 2001 })]]
    ]);

    const result = evaluateRecommendationResults(cases, outputs);

    expect(result.constraintAccuracy).toBe(0);
    expect(result.failureBreakdown.constraint_miss).toBe(1);
  });

  it("fails explicit year constraints when result year metadata is unknown", () => {
    const cases: GoldenRecommendationCase[] = [
      {
        id: "unknown-year",
        query: "a movie from 2000 onward",
        watchContext: "solo",
        constraints: { minYear: 2000 }
      }
    ];

    const result = evaluateRecommendationResults(cases, new Map([[cases[0].id, [item("Unknown Year")]]]));

    expect(result.constraintAccuracy).toBe(0);
    expect(result.failureBreakdown.constraint_miss).toBe(1);
  });

  it("does not report a constraint failure when no case declares constraints", () => {
    const cases: GoldenRecommendationCase[] = [{ id: "plain", query: "anything", watchContext: "solo" }];

    const result = evaluateRecommendationResults(cases, new Map([[cases[0].id, []]]));

    expect(result.constraintAccuracy).toBe(1);
    expect(result.failureBreakdown.constraint_miss).toBe(0);
  });
});

function item(title: string, overrides: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: title.toLowerCase().replace(/\s+/g, "-"),
    mediaType: "movie",
    title,
    genres: [],
    ratings: {},
    posterUrl: "",
    availabilityGroup: "available_in_plex",
    availabilityExplanation: "Available in Plex.",
    matchExplanation: "Evaluation fixture.",
    score: 50,
    ...overrides
  };
}
