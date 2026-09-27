import { describe, expect, it } from "vitest";
import { rankMapFromScores } from "../src/server/recommendation/rankEvidence";
import { buildLibraryRankIndex } from "../src/server/recommendation/rankIndex";
import type { ItemDetail } from "../src/shared/types";
import type { RetrievalContext } from "../src/server/recommendation/retrieval";

describe("tie-aware rank evidence", () => {
  it("preserves ordinal ranks for strictly different observations", () => {
    expect(rankMapFromScores(new Map([["low", 1], ["high", 3], ["middle", 2]])))
      .toEqual(new Map([["high", 1], ["middle", 2], ["low", 3]]));
  });

  it("assigns midranks to a tie without changing later ordinal ranks", () => {
    expect(rankMapFromScores(new Map([["a", 90], ["b", 90], ["c", 70], ["d", 10]])))
      .toEqual(new Map([["a", 1.5], ["b", 1.5], ["c", 3], ["d", 4]]));
  });

  it.each([0, 50, 100])("assigns identical evidence equal ranks at score %s", (score) => {
    expect([...rankMapFromScores(new Map([["z", score], ["a", score], ["m", score]])).values()])
      .toEqual([2, 2, 2]);
  });

  it("excludes non-finite values and does not mutate input", () => {
    const scores = new Map([["valid", 0], ["nan", NaN], ["infinity", Infinity], ["negative-infinity", -Infinity]]);
    expect(rankMapFromScores(scores)).toEqual(new Map([["valid", 1]]));
    expect(scores.size).toBe(4);
  });

  it("preserves total rank mass", () => {
    const scores = new Map(Array.from({ length: 100 }, (_, index) => [String(index), Math.floor(index / 10)]));
    expect([...rankMapFromScores(scores).values()].reduce((sum, rank) => sum + rank, 0)).toBe(5050);
  });

  it("handles empty and singleton channels", () => {
    expect(rankMapFromScores(new Map()).size).toBe(0);
    expect(rankMapFromScores(new Map([["only", 50]]))).toEqual(new Map([["only", 1]]));
  });

  it("does not give otherwise identical candidates different rank-index scores", () => {
    // Only the ID and availability fields are read by buildLibraryRankIndex.
    const items = ["z", "a", "m"].map((id) => ({ id, availabilityGroup: "available_in_plex" }) as ItemDetail);
    const equal = () => new Map(items.map((item) => [item.id, 50]));
    const context: RetrievalContext = {
      features: new Map(), lexicalRanks: equal(), semanticScores: equal(), providerEmbeddingScores: equal(),
      catalogRankScores: equal(), moodScores: equal(), feedbackScores: equal(), qualityScores: equal(),
      sourceCounts: { all: 3, lexical: 3, semantic: 3, mood: 3, reference: 0, feedback: 0, quality: 3,
        availability: 3, catalogRank: 3, providerEmbedding: 3, selected: 3 },
      providerEmbeddingBackfillCount: 0
    };
    const index = buildLibraryRankIndex(items, context);
    expect(new Set(index.rankIndexScores.values()).size).toBe(1);
    // Stable final tie breaking is still allowed; it must not alter score evidence.
    expect(index.topItemIds).toEqual(["a", "m", "z"]);
    expect(index.rankIndexRanks).toEqual(new Map([["a", 2], ["m", 2], ["z", 2]]));

    context.qualityScores.set("z", 100);
    const withLeader = buildLibraryRankIndex(items, context);
    expect(withLeader.topItemIds).toEqual(["z", "a", "m"]);
    expect(withLeader.rankIndexRanks).toEqual(new Map([["z", 1], ["a", 2.5], ["m", 2.5]]));
  });
});
