import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  evaluateTracePersistence,
  persistedResultRanksHaveMismatch,
  provenanceTraceHasMismatch,
  rerankTraceHasMismatch,
  scoreTraceStageRanksHaveDuplicate,
  scoreTraceHasMismatch,
  traceJsonContainsPrivateMaterial
} from "../scripts/evaluate-moodrank-traces";
import { moodRankTraceSchemaVersion } from "../src/server/recommendation/tracing";

const validScoreTrace = {
  schemaVersion: moodRankTraceSchemaVersion,
  scoreTraceVersion: "score-trace-v2",
  itemId: "movie:1",
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
  schemaVersion: moodRankTraceSchemaVersion,
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
const persistedScore = {
  itemId: "movie:1",
  score: 52,
  rank: 1,
  usedAiRerank: false,
  candidateCount: 7,
  rerankCandidateCount: 7,
  resultCount: 7,
  serializedCandidateCount: 7,
  aiRankedCandidateCount: 7
};

describe("MoodRank trace evaluator contracts", () => {
  it("reports missing queried columns as a structured schema failure", () => {
    const database = new DatabaseSync(":memory:");
    try {
      for (const table of [
        "recommendation_sessions",
        "recommendation_results",
        "recommendation_candidate_provenance",
        "recommendation_rejections",
        "recommendation_impressions",
        "query_review_queue"
      ]) {
        database.exec(`CREATE TABLE ${table} (id TEXT)`);
      }
      expect(evaluateTracePersistence(database, { minTraces: 1, sampleTraces: 1 }, ":memory:")).toMatchObject({
        ok: false,
        status: "trace_schema_invalid"
      });
    } finally {
      database.close();
    }
  });

  it("does not mistake numeric score traces for private 10.x network addresses", () => {
    expect(traceJsonContainsPrivateMaterial(JSON.stringify({
      score: 10.25,
      buckets: [{ value: 10.5 }, { value: 8.25 }, { value: 7.75 }]
    }))).toBe(false);
  });

  it("rejects private network addresses, URLs, and secret-like keys in structured trace text", () => {
    expect(traceJsonContainsPrivateMaterial(JSON.stringify({ detail: "host 10.1.2.3" }))).toBe(true);
    expect(traceJsonContainsPrivateMaterial(JSON.stringify({ detail: "https://example.test/private" }))).toBe(true);
    expect(traceJsonContainsPrivateMaterial(JSON.stringify({ api_token: "redacted" }))).toBe(true);
  });

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
      schemaVersion: moodRankTraceSchemaVersion,
      scoreTraceVersion: "score-trace-v1",
      itemId: "movie:1",
      finalScore: 52,
      buckets: [{ bucket: "query", value: 52, contribution: 52 }]
    };

    expect(scoreTraceHasMismatch(validV1, persistedScore)).toBe(false);
    expect(scoreTraceHasMismatch({ ...validV1, scoreTraceVersion: undefined }, persistedScore)).toBe(true);
    expect(scoreTraceHasMismatch({ ...validV1, scoreTraceVersion: "score-trace-v3" }, persistedScore)).toBe(true);
  });

  it("binds score traces to the persisted schema and item", () => {
    expect(scoreTraceHasMismatch({ ...validScoreTrace, schemaVersion: "moodrank-trace-v999" }, persistedScore)).toBe(true);
    expect(scoreTraceHasMismatch({ ...validScoreTrace, itemId: "movie:other" }, persistedScore)).toBe(true);
  });

  it("binds provenance traces to the persisted schema and item", () => {
    const valid = { schemaVersion: moodRankTraceSchemaVersion, itemId: "movie:1", sources: [{ source: "lexical_fts" }] };
    expect(provenanceTraceHasMismatch(valid, "movie:1")).toBe(false);
    expect(provenanceTraceHasMismatch({ ...valid, schemaVersion: "moodrank-trace-v999" }, "movie:1")).toBe(true);
    expect(provenanceTraceHasMismatch({ ...valid, itemId: "movie:other" }, "movie:1")).toBe(true);
  });

  it("rejects out-of-range AI scores and stage ranks", () => {
    const impossibleAi = {
      ...validScoreTrace,
      scores: { ...validScoreTrace.scores, ai: 999 },
      ranks: { ...validScoreTrace.ranks, ai: 999 },
      explanationSource: "ai"
    };
    expect(scoreTraceHasMismatch(impossibleAi, { ...persistedScore, usedAiRerank: true })).toBe(true);
    expect(
      scoreTraceHasMismatch(
        { ...validScoreTrace, ranks: { ...validScoreTrace.ranks, preDiversity: 10_000 } },
        persistedScore
      )
    ).toBe(true);
  });

  it("bounds an AI rank by the number of items the provider actually ranked", () => {
    const impossibleAiRank = {
      ...validScoreTrace,
      scores: { ...validScoreTrace.scores, ai: 50 },
      ranks: { ...validScoreTrace.ranks, ai: 60 },
      explanationSource: "ai"
    };
    expect(scoreTraceHasMismatch(impossibleAiRank, {
      ...persistedScore,
      usedAiRerank: true,
      candidateCount: 60,
      rerankCandidateCount: 60,
      serializedCandidateCount: 60,
      aiRankedCandidateCount: 1
    })).toBe(true);
  });

  it("requires persisted result ranks to be unique and contiguous", () => {
    expect(persistedResultRanksHaveMismatch({
      result_count: 2,
      row_count: 2,
      distinct_rank_count: 2,
      min_rank: 1,
      max_rank: 2
    })).toBe(false);
    expect(persistedResultRanksHaveMismatch({
      result_count: 2,
      row_count: 2,
      distinct_rank_count: 1,
      min_rank: 1,
      max_rank: 1
    })).toBe(true);
    expect(persistedResultRanksHaveMismatch({
      result_count: 1,
      row_count: 1,
      distinct_rank_count: 1,
      min_rank: 10_000,
      max_rank: 10_000
    })).toBe(true);
  });

  it("rejects duplicate intermediate ranks across persisted score traces", () => {
    const second = {
      ...validScoreTrace,
      itemId: "movie:2",
      ranks: { ...validScoreTrace.ranks, response: 2 }
    };
    expect(scoreTraceStageRanksHaveDuplicate([validScoreTrace, second])).toBe(true);
    second.ranks = Object.fromEntries(
      Object.entries(second.ranks).map(([stage, rank]) => [stage, Number(rank) + 1])
    ) as typeof second.ranks;
    expect(scoreTraceStageRanksHaveDuplicate([validScoreTrace, second])).toBe(false);
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
    expect(scoreTraceHasMismatch(reranked, { ...persistedScore, rank: 2, usedAiRerank: true })).toBe(false);
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

  it("distinguishes the provider-exposed count from the larger rerank window", () => {
    expect(rerankTraceHasMismatch({
      ...validRerankTrace,
      offeredCandidateCount: 100,
      serializedCandidateLimit: 60,
      rerankWindowCandidateCount: 100,
      serializedCandidateCount: 60,
      aiRankedCandidateCount: 60,
      postRerankCandidateCount: 100,
      resultCount: 100
    }, 100)).toBe(false);
    expect(rerankTraceHasMismatch({
      ...validRerankTrace,
      offeredCandidateCount: 60,
      serializedCandidateLimit: 60,
      rerankWindowCandidateCount: 100,
      serializedCandidateCount: 60,
      aiRankedCandidateCount: 60,
      postRerankCandidateCount: 100,
      resultCount: 100
    }, 100)).toBe(true);
  });

  it("accepts only explicit known rerank trace versions and validates V2 flags", () => {
    const validV1 = {
      schemaVersion: moodRankTraceSchemaVersion,
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
    expect(rerankTraceHasMismatch({ ...validRerankTrace, schemaVersion: "moodrank-trace-v999" }, 7)).toBe(true);
    expect(rerankTraceHasMismatch({ ...validRerankTrace, serializedCandidateCount: Number.POSITIVE_INFINITY }, 7)).toBe(true);
    expect(rerankTraceHasMismatch({
      ...validRerankTrace,
      serializedCandidateCount: undefined,
      aiRankedCandidateCount: undefined
    }, 7)).toBe(true);
  });
});
