import { describe, expect, it } from "vitest";
import { rerankTraceHasMismatch, scoreTraceHasMismatch } from "../scripts/evaluate-moodrank-traces";

const validScoreTrace = {
  scoreTraceVersion: "score-trace-v2",
  finalScore: 52,
  buckets: [
    { bucket: "query", value: 80, weight: 0.5, contribution: 40 },
    { bucket: "mood", value: 50, weight: 0.2, contribution: 10 }
  ],
  deterministic: {
    score: 52,
    unroundedScore: 52,
    disqualified: false,
    adjustments: [{ adjustment: "profile_delta", value: 62.5, contribution: 2 }]
  },
  scores: {
    deterministic: 52,
    preResponse: 52,
    response: 52,
    responseClampDelta: 0
  },
  ranks: {
    preDiversity: 1,
    postDiversity: 1,
    postScoringFallback: 1,
    postRerank: 1,
    postScout: 1,
    postMerge: 1,
    response: 1
  },
  orderingReason: "pre_diversity",
  explanationSource: "deterministic",
  diversity: {
    strategy: "small_pool",
    score: 100,
    rankMovement: 0
  }
};

const validRerankTrace = {
  rerankTraceVersion: "rerank-trace-v2",
  offeredCandidateCount: 7,
  serializedCandidateLimit: 7,
  rerankWindowCandidateCount: 7,
  rerankRequested: true,
  serializedCandidateCount: 7,
  aiRankedCandidateCount: 2,
  postRerankCandidateCount: 7,
  usedAi: true,
  resultCount: 7
};
const persistedScore = { score: 52, rank: 1, usedAiRerank: false };

describe("MoodRank trace evaluator contracts", () => {
  it("rejects false weighted attribution even when the contribution sum is unchanged", () => {
    expect(scoreTraceHasMismatch(validScoreTrace, persistedScore)).toBe(false);

    const corrupted = structuredClone(validScoreTrace);
    corrupted.buckets[0]!.contribution = 39;
    corrupted.buckets[1]!.contribution = 11;

    expect(scoreTraceHasMismatch(corrupted, persistedScore)).toBe(true);
  });

  it("rejects a deterministic score-domain mismatch", () => {
    const corrupted = structuredClone(validScoreTrace);
    corrupted.scores.deterministic = 51;

    expect(scoreTraceHasMismatch(corrupted, persistedScore)).toBe(true);
  });

  it("accepts only explicit known score trace versions", () => {
    const validV1 = {
      scoreTraceVersion: "score-trace-v1",
      finalScore: 52,
      buckets: [{ bucket: "query", value: 52, contribution: 52 }]
    };

    expect(scoreTraceHasMismatch(validV1, persistedScore)).toBe(false);
    expect(scoreTraceHasMismatch({ ...validV1, scoreTraceVersion: undefined }, persistedScore)).toBe(true);
    expect(scoreTraceHasMismatch({ ...validV1, scoreTraceVersion: "score-trace-v3" }, persistedScore)).toBe(true);
  });

  it("rejects invalid V2 enums, non-finite fields, and non-positive stage ranks", () => {
    expect(
      scoreTraceHasMismatch(
        { ...validScoreTrace, orderingReason: "provider_score" },
        persistedScore
      )
    ).toBe(true);
    expect(
      scoreTraceHasMismatch(
        { ...validScoreTrace, explanationSource: "scout" },
        persistedScore
      )
    ).toBe(true);
    expect(
      scoreTraceHasMismatch(
        {
          ...validScoreTrace,
          deterministic: {
            ...validScoreTrace.deterministic,
            adjustments: [{ ...validScoreTrace.deterministic.adjustments[0]!, adjustment: "manual_boost" }]
          }
        },
        persistedScore
      )
    ).toBe(true);
    expect(
      scoreTraceHasMismatch(
        { ...validScoreTrace, diversity: { ...validScoreTrace.diversity, strategy: "random" } },
        persistedScore
      )
    ).toBe(true);
    expect(
      scoreTraceHasMismatch(
        { ...validScoreTrace, diversity: { ...validScoreTrace.diversity, mmr: Number.NaN } },
        persistedScore
      )
    ).toBe(true);
    expect(
      scoreTraceHasMismatch(
        { ...validScoreTrace, ranks: { ...validScoreTrace.ranks, postScout: 0 } },
        persistedScore
      )
    ).toBe(true);
  });

  it("validates Scout and diversity deltas", () => {
    const withScout = {
      ...validScoreTrace,
      scores: {
        ...validScoreTrace.scores,
        scout: 100,
        scoutOrderingDelta: 12,
        postScoutOrderingScore: 64
      },
      scoutAppliedToOrdering: true
    };
    expect(scoreTraceHasMismatch(withScout, persistedScore)).toBe(false);
    expect(
      scoreTraceHasMismatch(
        { ...withScout, scores: { ...withScout.scores, scoutOrderingDelta: 11 } },
        persistedScore
      )
    ).toBe(true);
    expect(
      scoreTraceHasMismatch(
        { ...validScoreTrace, diversity: { ...validScoreTrace.diversity, rankMovement: 1 } },
        persistedScore
      )
    ).toBe(true);
  });

  it("derives the ordering reason from the recorded stage ranks", () => {
    expect(
      scoreTraceHasMismatch(
        { ...validScoreTrace, orderingReason: "diversity" },
        persistedScore
      )
    ).toBe(true);

    const reranked = {
      ...validScoreTrace,
      ranks: { ...validScoreTrace.ranks, postRerank: 2, postScout: 2, postMerge: 2, response: 2 },
      orderingReason: "rerank_stage"
    };
    expect(scoreTraceHasMismatch(reranked, { score: 52, rank: 2, usedAiRerank: true })).toBe(false);
  });

  it("requires finite integer V2 rerank result counts", () => {
    expect(rerankTraceHasMismatch(validRerankTrace, 7)).toBe(false);

    const missingResultCounts = structuredClone(validRerankTrace) as Partial<typeof validRerankTrace>;
    delete missingResultCounts.postRerankCandidateCount;
    delete missingResultCounts.resultCount;
    expect(rerankTraceHasMismatch(missingResultCounts, 7)).toBe(true);

    expect(
      rerankTraceHasMismatch({ ...validRerankTrace, postRerankCandidateCount: Number.NaN }, 7)
    ).toBe(true);
  });

  it("accepts only explicit known rerank trace versions and validates V2 flags", () => {
    const validV1 = {
      rerankTraceVersion: "rerank-trace-v1",
      offeredCandidateCount: 7,
      serializedCandidateLimit: 7,
      usedAi: false,
      resultCount: 7
    };

    expect(rerankTraceHasMismatch(validV1, 7)).toBe(false);
    expect(rerankTraceHasMismatch({ ...validV1, rerankTraceVersion: undefined }, 7)).toBe(true);
    expect(rerankTraceHasMismatch({ ...validV1, rerankTraceVersion: "rerank-trace-v3" }, 7)).toBe(true);
    expect(rerankTraceHasMismatch({ ...validRerankTrace, usedAi: undefined }, 7)).toBe(true);
    expect(rerankTraceHasMismatch({ ...validRerankTrace, serializedCandidateCount: Number.POSITIVE_INFINITY }, 7)).toBe(true);
  });
});
