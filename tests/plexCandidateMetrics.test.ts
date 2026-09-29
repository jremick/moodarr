import { describe, expect, it } from "vitest";
import { compareFrozenRecall } from "../scripts/lib/plexCandidateMetrics";

describe("Plex reservation frozen-pool accounting", () => {
  it("retains simultaneous catalogue gains and losses against one frozen denominator", () => {
    const result = compareFrozenRecall(["a", "b", "c", "d"], ["a", "b", "outside"], ["b", "c"]);
    expect(result).toEqual({
      denominator: 4, baselineRetained: ["a", "b"], retained: ["b", "c"],
      gained: ["c"], lost: ["a"], recall: 0.5, baselineRecall: 0.5,
      gainedRecall: 0.25, lostRecall: 0.25, netRecall: 0
    });
  });

  it("reports undefined recalls when the frozen relevant pool is empty", () => {
    expect(compareFrozenRecall([], ["a"], ["b"])).toEqual({
      denominator: 0, baselineRetained: [], retained: [], gained: [], lost: [],
      recall: null, baselineRecall: null, gainedRecall: null, lostRecall: null, netRecall: null
    });
  });

  it("counts canonical IDs once and does not count irrelevant window changes", () => {
    expect(compareFrozenRecall(["a", "a", "b"], ["a", "a", "outside"], ["b", "b", "other"]))
      .toEqual({ denominator: 2, baselineRetained: ["a"], retained: ["b"], gained: ["b"], lost: ["a"],
        recall: 0.5, baselineRecall: 0.5, gainedRecall: 0.5, lostRecall: 0.5, netRecall: 0 });
  });
});
