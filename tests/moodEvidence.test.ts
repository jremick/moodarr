import { describe, expect, it } from "vitest";
import { buildFeelProfileAdjustment, type FeelProfile } from "../src/server/recommendation/feelProfile";
import { buildMediaFeatureDocument } from "../src/server/recommendation/features";
import { scoreLibraryCandidates } from "../src/server/recommendation/scoring";
import type { ItemDetail } from "../src/shared/types";

function profile(term: string): FeelProfile {
  return { id: "test:meaning", label: "Test", watchContext: "solo", terms: [{ term, featureWeights: { "genre:comedy": 2 }, confidence: 0.9, evidenceCount: 20 }] };
}

const neutral: ItemDetail = {
  id: "test:neutral", title: "The Observatory", mediaType: "movie", year: 2024,
  runtimeMinutes: 90, summary: "A documentary about the construction of an observatory.", genres: ["Documentary"],
  cast: [], directors: ["Lance Smith"], externalIds: {}, ratings: {}, posterUrl: "/fixture.svg",
  availabilityGroup: "available_in_plex", availabilityExplanation: "Available", plex: { available: true }, matchExplanation: "", score: 0
};

function score(item: ItemDetail, query = "cozy", features = true) {
  return scoreLibraryCandidates([item], query, {}, "solo", {
    ...(features ? { features: new Map([[item.id, buildMediaFeatureDocument(item)]]) } : {})
  }).results[0]!;
}

describe("mood evidence and learned term meaning", () => {
  it.each(["a lighthouse documentary", "delightful", "slightly interesting"])("does not match light inside another word: %s", (query) => {
    expect(buildFeelProfileAdjustment(profile("light"), query)).toBeUndefined();
  });
  it.each(["not cozy", "not too cozy", "without cozy stories", "nothing cozy", "not dark or cozy", "rather than cozy", "I don't want cozy"])("does not activate a negated mood profile: %s", (query) => {
    expect(buildFeelProfileAdjustment(profile("cozy"), query)).toBeUndefined();
  });
  it.each(["cozy movie", "not dark, cozy", "not dark but cozy", "not only cozy", "cozy, not violent"])("retains positive mood evidence: %s", (query) => {
    expect(buildFeelProfileAdjustment(profile("cozy"), query)?.matchedTerms).toEqual(["cozy"]);
  });
  it("matches complete calibrated phrases with punctuation normalization", () => {
    expect(buildFeelProfileAdjustment(profile("feel good"), "a feel-good movie")?.matchedTerms).toEqual(["feel good"]);
    expect(buildFeelProfileAdjustment(profile("feel good"), "not feel-good")).toBeUndefined();
  });
  it.each([true, false])("does not turn cast or director names into mood evidence, features=%s", (features) => {
    const baseline = score(neutral, "cozy", features);
    for (const changed of [
      { ...neutral, directors: ["Lance Comfort"] },
      { ...neutral, cast: ["Alex Cozy"] },
      { ...neutral, summary: neutral.summary + " Directed by Lance Comfort." }
    ]) {
      const result = score(changed, "cozy", features);
      expect(result.scoreBreakdown?.mood).toBe(baseline.scoreBreakdown?.mood);
      expect(result.scoreBreakdown?.query).toBe(baseline.scoreBreakdown?.query);
    }
  });
  it("retains descriptive mood evidence and explicit person search", () => {
    const baseline = score(neutral);
    expect(score({ ...neutral, summary: "A cozy story of gentle friendship and comfort." }).scoreBreakdown!.mood).toBeGreaterThan(baseline.scoreBreakdown!.mood!);
    expect(score({ ...neutral, directors: ["Lance Comfort"] }, "Lance Comfort").scoreBreakdown!.query).toBeGreaterThan(score(neutral, "Lance Comfort").scoreBreakdown!.query);
  });
});
