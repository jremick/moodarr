import { describe, expect, it } from "vitest";
import {
  evaluateCatalogBenchmarkContract,
  parseCatalogSearchBenchmarkArgs,
  type CatalogBenchmarkSample
} from "../scripts/catalog-search-benchmark-contract";

const caseIds = ["a", "b", "c", "d", "e"];
const thresholds = { localP50Ms: 250, localP95Ms: 750, engineP95Ms: 1000 };

describe("catalog search benchmark contract", () => {
  it("strictly parses supported flags and positive integer values", () => {
    expect(parseCatalogSearchBenchmarkArgs([])).toEqual({
      enforceAdvisoryTargets: false,
      iterations: 3,
      skipEngine: false
    });
    expect(
      parseCatalogSearchBenchmarkArgs([
        "--limit",
        "12",
        "--iterations",
        "4",
        "--skip-engine",
        "--enforce-advisory-targets"
      ])
    ).toEqual({ enforceAdvisoryTargets: true, iterations: 4, limit: 12, skipEngine: true });

    for (const values of [
      ["--unknown"],
      ["--limit"],
      ["--limit", "0"],
      ["--iterations", "1.5"],
      ["--iterations", "2", "--iterations", "3"]
    ]) {
      expect(() => parseCatalogSearchBenchmarkArgs(values)).toThrow();
    }
  });

  it("accepts stable 80-percent scored coverage and a repaired final index", () => {
    const result = evaluate({ samples: stableSamples(), finalIndexHealthy: true });

    expect(result.scoringCoverage).toMatchObject({
      valid: true,
      scoredCases: 4,
      consistentlyZeroCaseIds: ["e"],
      unstableCoverageCaseIds: []
    });
    expect(result.validityStatus).toEqual({
      sampleSet: "pass",
      catalogIndexHealth: "pass",
      scoringCoverage: "pass",
      engineCoverage: "pass"
    });
    expect(result.advisoryTargetStatus).toEqual({
      localNoAiP50: "pass",
      localNoAiP95: "pass",
      engineNoAiNoRemoteP95: "pass"
    });
    expect(result.exitCode).toBe(0);
  });

  it("invalidates all-zero, partial, and iteration-unstable scored coverage", () => {
    const allZero = stableSamples().map((sample) => ({ ...sample, scoredItemCount: 0 }));
    expect(evaluate({ samples: allZero }).validityStatus.scoringCoverage).toBe("invalid_insufficient_scored_coverage");

    const partial = stableSamples().map((sample) => ({
      ...sample,
      scoredItemCount: new Set(["a", "b", "c"]).has(sample.caseId) ? 10 : 0
    }));
    expect(evaluate({ samples: partial }).scoringCoverage.scoredCases).toBe(3);
    expect(evaluate({ samples: partial }).exitCode).toBe(1);

    const unstable = stableSamples().map((sample, index) =>
      sample.caseId === "d" && index >= caseIds.length ? { ...sample, scoredItemCount: 0 } : sample
    );
    expect(evaluate({ samples: unstable }).scoringCoverage.unstableCoverageCaseIds).toEqual(["d"]);
    expect(evaluate({ samples: unstable }).exitCode).toBe(1);
  });

  it("includes slow zero-result paths in advisory percentiles", () => {
    const samples = stableSamples().map((sample) =>
      sample.caseId === "e" ? { ...sample, totalLocalMs: 2_000, engineMs: 2_000 } : sample
    );
    const advisory = evaluate({ samples, enforceAdvisoryTargets: false });
    expect(advisory.advisoryTargetStatus.localNoAiP95).toBe("fail");
    expect(advisory.advisoryTargetStatus.engineNoAiNoRemoteP95).toBe("fail");
    expect(advisory.exitCode).toBe(0);

    expect(evaluate({ samples, enforceAdvisoryTargets: true }).exitCode).toBe(1);
  });

  it("fails unhealthy final indexes and incomplete required engine timing", () => {
    expect(evaluate({ samples: stableSamples().slice(1) }).validityStatus.sampleSet).toBe("invalid_sample_set");

    const duplicateAndMissingCase = stableSamples();
    duplicateAndMissingCase[1] = { ...duplicateAndMissingCase[1]!, caseId: "a" };
    expect(evaluate({ samples: duplicateAndMissingCase }).validityStatus.sampleSet).toBe("invalid_sample_set");
    expect(evaluate({ samples: duplicateAndMissingCase }).exitCode).toBe(1);

    expect(evaluate({ samples: stableSamples(), finalIndexHealthy: false }).validityStatus.catalogIndexHealth).toBe("fail");
    expect(evaluate({ samples: stableSamples(), finalIndexHealthy: false }).exitCode).toBe(1);

    const incompleteEngine = stableSamples();
    incompleteEngine[0] = { ...incompleteEngine[0], engineMs: undefined };
    expect(evaluate({ samples: incompleteEngine }).validityStatus.engineCoverage).toBe("invalid_incomplete_engine_coverage");
    expect(evaluate({ samples: incompleteEngine }).exitCode).toBe(1);

    expect(evaluate({ samples: incompleteEngine, measureEngine: false }).validityStatus.engineCoverage).toBe("pass");
  });
});

function stableSamples(): CatalogBenchmarkSample[] {
  return Array.from({ length: 2 }, () =>
    caseIds.map((caseId) => ({
      caseId,
      totalLocalMs: 100,
      engineMs: 200,
      scoredItemCount: caseId === "e" ? 0 : 10
    }))
  ).flat();
}

function evaluate(options: {
  samples: CatalogBenchmarkSample[];
  finalIndexHealthy?: boolean;
  measureEngine?: boolean;
  enforceAdvisoryTargets?: boolean;
}) {
  return evaluateCatalogBenchmarkContract({
    caseIds,
    iterations: 2,
    samples: options.samples,
    finalIndexHealthy: options.finalIndexHealthy ?? true,
    measureEngine: options.measureEngine ?? true,
    enforceAdvisoryTargets: options.enforceAdvisoryTargets ?? false,
    thresholds
  });
}
