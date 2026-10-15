import { describe, expect, it } from "vitest";
import { exampleFeedbackScores } from "../src/server/recommendation/feedbackAggregation";
import { buildRetrievalQuery, buildSemanticQuery } from "../src/server/recommendation/retrievalQueries";
import type { ItemDetail } from "../src/shared/types";
import type { StoredMediaFeature } from "../src/server/db/mediaRepository";
import type { RecommendationBrief } from "../src/server/recommendation/brief";

// These scoring helpers consume only IDs, media types and feature vectors.
const item = (id: string) => ({ id, mediaType: "movie" }) as ItemDetail;
const feature = (mediaItemId: string, similarity: number): StoredMediaFeature => ({
  mediaItemId,
  featureText: "",
  moodTerms: [],
  toneTerms: [],
  watchabilityTerms: [],
  vector: { mood: similarity, other: Math.sqrt(1 - similarity ** 2) },
  featureVersion: "test-v1"
});
const target = item("target");
const examples = Array.from({ length: 4 }, (_, index) => item(`example-${index}`));
const features = new Map([[target.id, feature(target.id, 1)], ...examples.map((example) => [example.id, feature(example.id, 0.25)] as const)]);
const score = (preferred: ItemDetail[] = [], liked: ItemDetail[] = [], disliked: ItemDetail[] = []) =>
  exampleFeedbackScores([target], features, preferred, liked, disliked).get(target.id);

function brief(): RecommendationBrief {
  return {
    query: "warm", hardFilters: {}, watchContext: "solo", resultLimit: 10,
    softSignals: { terms: ["warm"], moods: ["warm"], genres: [], wantsBetter: false, wantsRequestOptions: false, wantsRequestAttempt: false },
    feedback: { preferredExampleTitles: [], moreLikeTitles: [], lessLikeTitles: [] }
  };
}

describe("multi-example feedback regression", () => {
  it("does not saturate from four moderately similar liked examples", () => {
    expect(score([], examples)).toBe(64);
    expect(score([], examples)).toBe(score([], examples.slice(0, 1)));
  });
  it("does not compound equivalent preferred examples", () => {
    expect(score(examples)).toBe(score(examples.slice(0, 1)));
    expect(score(examples)!).toBeGreaterThan(score([], examples)!);
  });
  it("does not compound equivalent negative examples", () => {
    expect(score([], [], examples)).toBe(40);
    expect(score([], [], examples)).toBe(score([], [], examples.slice(0, 1)));
  });
  it("does not count duplicate IDs twice", () => {
    expect(score([], [examples[0], examples[0], examples[0]])).toBe(score([], [examples[0]]));
  });
  it("does not count a preferred example again as an ordinary like", () => {
    expect(score([examples[0]], [examples[0]])).toBe(score([examples[0]]));
  });
  it("neutralizes an example with conflicting signs", () => {
    expect(score([], [examples[0]], [examples[0]])).toBe(50);
    expect(score([examples[0]], [], [examples[0]])).toBe(50);
  });
  it("remains neutral without examples or a candidate feature", () => {
    expect(score()).toBe(50);
    expect(exampleFeedbackScores([target], new Map(), examples, [], []).get(target.id)).toBe(50);
  });
  it("keeps duplicate sparse examples equivalent to a single sparse example", () => {
    const sparse = new Map([[target.id, feature(target.id, 1)]]);
    expect(exampleFeedbackScores([target], sparse, [], [examples[0], examples[0]], []).get(target.id)).toBe(54);
  });
  it("keeps preferred precedence when duplicate sparse evidence spans positive classes", () => {
    const sparse = new Map([[target.id, feature(target.id, 1)]]);
    expect(exampleFeedbackScores([target], sparse, [examples[0]], [examples[0]], []).get(target.id)).toBe(56);
  });
  it("preserves the old single-example sparse fallback unless explicitly normalized", () => {
    const sparse = new Map([[target.id, feature(target.id, 1)]]);
    expect(exampleFeedbackScores([target], sparse, [], [examples[0]], []).get(target.id)).toBe(54);
    expect(exampleFeedbackScores([target], sparse, [], [examples[0]], [], true).get(target.id)).toBe(50);
  });
});

describe("feedback query polarity", () => {
  it("does not append disliked titles to lexical or semantic positive expansion", () => {
    const input = brief();
    input.feedback.lessLikeTitles = ["Shadow Orbit"];
    expect(buildRetrievalQuery(input)).not.toContain("Shadow Orbit");
    expect(buildSemanticQuery(input)).not.toContain("Shadow Orbit");
    expect(input.feedback.lessLikeTitles).toEqual(["Shadow Orbit"]);
  });
  it("keeps positively supplied examples", () => {
    const input = brief();
    input.feedback.preferredExampleTitles = ["Meadow Voyage"];
    input.feedback.moreLikeTitles = ["Sunlit Harbour"];
    expect(buildRetrievalQuery(input)).toContain("Meadow Voyage");
    expect(buildRetrievalQuery(input)).toContain("Sunlit Harbour");
    expect(buildSemanticQuery(input)).toContain("preferred mood example Meadow Voyage");
    expect(buildSemanticQuery(input)).toContain("more like Sunlit Harbour");
  });
  it("deduplicates and neutralizes contradictory labels before expansion", () => {
    const input = brief();
    input.feedback.preferredExampleTitles = [" Meadow Voyage ", "Sunlit Harbour"];
    input.feedback.moreLikeTitles = ["meadow voyage", "Sunlit Harbour"];
    input.feedback.lessLikeTitles = [" SUNLIT HARBOUR "];
    expect(buildSemanticQuery(input)).not.toContain("Sunlit Harbour");
    expect(buildSemanticQuery(input).match(/meadow voyage/gi)).toHaveLength(1);
  });
  it("does not turn empty titles into example labels", () => {
    const input = brief();
    input.feedback.preferredExampleTitles = [""];
    input.feedback.moreLikeTitles = [" "];
    expect(buildSemanticQuery(input)).not.toContain("example");
    expect(buildSemanticQuery(input)).not.toContain("more like");
  });
  it("keeps the shared-intent positive-query contract", () => {
    const input = brief();
    input.viewingIntent = {
      version: "viewing-intent-v2", currentFeelings: [], deniedCurrentFeelings: [], desiredQuery: "calm",
      positiveQuery: "calm", facets: [], requestedEffect: "calm", ambiguous: false
    };
    input.feedback.moreLikeTitles = ["Meadow Voyage"];
    expect(buildSemanticQuery(input)).toBe("calm warm");
  });
});
