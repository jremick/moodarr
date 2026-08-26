import { describe, expect, it } from "vitest";
import { scoreLibraryCandidates } from "../src/server/recommendation/scoring";
import { scoreTraceOrderingReason } from "../src/server/recommendation/tracing";
import type { ItemDetail } from "../src/shared/types";

function candidate(id: string, title: string, genres: string[], runtimeMinutes: number): ItemDetail {
  return {
    id,
    mediaType: "movie",
    title,
    year: 2020,
    runtimeMinutes,
    summary: `${title} is a warm, easy story with a distinct tone.`,
    genres,
    ratings: { critic: 78, audience: 80, user: 7.4 },
    posterUrl: `/api/items/${encodeURIComponent(id)}/poster`,
    availabilityGroup: "available_in_plex",
    availabilityExplanation: "Available in Plex.",
    matchExplanation: "Candidate.",
    score: 0,
    cast: [],
    directors: [],
    externalIds: {},
    plex: { available: true }
  };
}

describe("MoodRank score trace capture", () => {
  it("attributes diversity movement reversed by the scoring fallback to the fallback stage", () => {
    expect(
      scoreTraceOrderingReason(
        {
          preDiversity: 5,
          postDiversity: 4,
          postScoringFallback: 5,
          postRerank: 5,
          postScout: 5,
          postMerge: 5,
          response: 5
        },
        false
      )
    ).toBe("request_attempt_fallback");
  });

  it("captures exact weighted math and rank stages without changing recommendation output", () => {
    const items = [
      candidate("movie:a", "Amber Evening", ["Comedy", "Family"], 95),
      candidate("movie:b", "Breezy Evening", ["Comedy", "Family"], 96),
      candidate("movie:c", "Calm Horizon", ["Documentary"], 82),
      candidate("movie:d", "Dreaming Stars", ["Science Fiction"], 135)
    ];

    const withoutTrace = scoreLibraryCandidates(items, "warm easy options", {}, "group", { allItems: items });
    const withTrace = scoreLibraryCandidates(items, "warm easy options", {}, "group", {
      allItems: items,
      captureScoreTrace: true
    });

    expect(withTrace.results).toEqual(withoutTrace.results);
    expect(withoutTrace.scoreTrace).toBeUndefined();
    expect(JSON.stringify(withTrace.results)).not.toContain("computationByItemId");
    expect(withTrace.scoreTrace?.computationByItemId.size).toBe(withTrace.results.length);
    expect(withTrace.scoreTrace?.rankByItemId.size).toBe(withTrace.results.length);

    const first = withTrace.results[0]!;
    const computation = withTrace.scoreTrace!.computationByItemId.get(first.id)!;
    const reconstructed =
      computation.buckets.reduce((total, bucket) => total + bucket.contribution, 0) +
      computation.adjustments.reduce((total, adjustment) => total + adjustment.contribution, 0);

    expect(computation.buckets.some((bucket) => bucket.contribution !== bucket.value)).toBe(true);
    expect(computation.buckets.find((bucket) => bucket.bucket === "diversity")?.value).toBe(50);
    expect(reconstructed).toBeCloseTo(computation.unroundedScore, 10);
    expect(computation.deterministicScore).toBe(Math.round(reconstructed));
    expect(computation.deterministicScore).toBe(first.score);

    for (const item of withTrace.results) {
      expect(withTrace.scoreTrace!.rankByItemId.get(item.id)).toMatchObject({
        preDiversityRank: expect.any(Number),
        postDiversityRank: expect.any(Number),
        postScoringFallbackRank: expect.any(Number),
        diversity: {
          strategy: expect.any(String),
          score: expect.any(Number)
        }
      });
    }
  });
});
