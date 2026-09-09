import { describe, expect, it } from "vitest";
import type { RecommendationBrief } from "../src/server/recommendation/brief";
import { parseRecommendationIntent } from "../src/server/recommendation/intent";
import { deterministicMoodFeatureScores, moodFeatureKeysForBrief, normalizeMoodFeatureKey } from "../src/server/recommendation/moodFeatureIndex";

function brief(query: string, watchContext: "solo" | "group" = "solo"): RecommendationBrief {
  const intent = parseRecommendationIntent(query);
  return {
    query, watchContext, resultLimit: 10, hardFilters: intent.hardFilters,
    softSignals: {
      terms: intent.terms, genres: intent.softGenres, moods: intent.moods,
      wantsBetter: intent.wantsBetter, wantsRequestOptions: intent.wantsRequestOptions,
      wantsRequestAttempt: intent.wantsRequestAttempt, referenceTitle: intent.referenceTitle
    },
    feedback: { moreLikeTitles: [], preferredExampleTitles: [], lessLikeTitles: [] }
  };
}

const avoidedCases: Array<[string, string[]]> = [
  ["not romantic", ["mood:romantic"]],
  ["no music", ["theme:music", "mood:expressive"]],
  ["not slow burn", ["pacing:slow-burn", "watch:attention-heavy"]],
  ["not slow-burn", ["pacing:slow-burn", "watch:attention-heavy"]],
  ["not bleak", ["tone:bleak"]],
  ["not light", ["tone:light", "mood:light", "watch:low-commitment"]],
  ["not cozy", ["mood:cozy", "mood:feel-good", "watch:low-commitment"]],
  ["no music or romance", ["theme:music", "mood:expressive", "mood:romantic"]],
  ["time travel but no romance", ["mood:romantic", "microgenre:time-travel-romance"]],
  ["romance but no time travel", ["theme:time-travel", "microgenre:time-travel-romance"]]
];

const positiveCases: Array<[string, string[]]> = [
  ["romantic", ["mood:romantic"]],
  ["music", ["theme:music", "mood:expressive"]],
  ["slow burn", ["pacing:slow-burn", "watch:attention-heavy"]],
  ["bleak", ["tone:bleak"]],
  ["not only romantic but also warm", ["mood:romantic", "mood:warm"]],
  ["no music or romance but cozy", ["mood:cozy"]],
  ["not dark, cozy", ["mood:cozy"]],
  ["quiet meditative slow-burn film", ["pacing:slow-burn", "watch:attention-heavy"]],
  ["time travel romance", ["theme:time-travel", "mood:romantic", "microgenre:time-travel-romance"]]
];

describe("mood-index retrieval does not invert negative preferences", () => {
  it.each(avoidedCases)("does not attract avoided features: %s", (query, features) => {
    const keys = moodFeatureKeysForBrief(brief(query));
    for (const feature of features) expect(keys).not.toContain(normalizeMoodFeatureKey(feature));
  });

  it.each(positiveCases)("retains positive controls: %s", (query, features) => {
    const keys = moodFeatureKeysForBrief(brief(query));
    for (const feature of features) expect(keys).toContain(normalizeMoodFeatureKey(feature));
  });

  it("does not let a related positive term reintroduce an explicitly avoided quality", () => {
    const keys = moodFeatureKeysForBrief(brief("cozy but not feel-good"));
    expect(keys).toContain("mood:cozy");
    expect(keys).not.toContain("mood:feel-good");
  });

  it("filters stale raw soft signals as well as raw-query regex matches", () => {
    const input = brief("not romantic; not slow burn; no music");
    input.softSignals.moods.push("romantic");
    input.softSignals.terms.push("music", "slow-burn");
    input.softSignals.genres.push("Music", "Romance");
    const keys = moodFeatureKeysForBrief(input);
    for (const key of ["mood:romantic", "theme:music", "mood:expressive", "pacing:slow-burn", "watch:attention-heavy"]) {
      expect(keys).not.toContain(key);
    }
  });

  it("keeps legitimate unmentioned enrichment", () => {
    const input = brief("a film please");
    input.softSignals.terms = ["magical"];
    expect(moodFeatureKeysForBrief(input)).toContain("tone:whimsical");
  });

  it("does not reinterpret less as a new hard exclusion", () => {
    const input = brief("less bleak");
    const before = structuredClone(input);
    expect(moodFeatureKeysForBrief(input)).not.toContain("tone:bleak");
    expect(input).toEqual(before);
    expect(input.hardFilters.excludedGenres).toBeUndefined();
  });

  it("uses marked refinement polarity without changing resolved constraints", () => {
    const input = brief("romantic film under 120 minutes. Follow-up refinement: not romantic, something weird");
    const before = structuredClone(input);
    const keys = moodFeatureKeysForBrief(input);
    expect(keys).not.toContain("mood:romantic");
    expect(keys).toContain("mood:weird");
    expect(input).toEqual(before);
    expect(input.hardFilters.maxRuntimeMinutes).toBe(120);
  });

  it("does not restore retired genre exclusions after an explicit clear", () => {
    const input = brief("not romantic. Follow-up refinement: clear genre, romantic please");
    expect(input.hardFilters.excludedGenres).not.toContain("Romance");
    expect(moodFeatureKeysForBrief(input)).toContain("mood:romantic");
  });

  it("preserves context-only retrieval cues and feature namespace semantics", () => {
    expect(moodFeatureKeysForBrief(brief("not romantic", "group"))).toEqual(["watch:group-friendly", "watch:shared-screen"]);
    expect(normalizeMoodFeatureKey("watch:low-commitment")).toBe("watch:low-commitment");
  });

  it("does not change stored deterministic feature score generation", () => {
    expect(deterministicMoodFeatureScores({ moodTerms: ["cozy"], toneTerms: ["dry"], watchabilityTerms: ["low-commitment"] })).toEqual([
      { feature: "mood:cozy", score: 86, confidence: 0.74 },
      { feature: "tone:dry", score: 78, confidence: 0.7 },
      { feature: "watch:low-commitment", score: 74, confidence: 0.68 }
    ]);
  });
});
