import { describe, expect, it } from "vitest";
import {
  benchmarkCasesForProfile,
  evaluateCatalogBenchmarkContract,
  evaluateCatalogBenchmarkCorpusPreflight,
  parseCatalogSearchBenchmarkArgs,
  type CatalogBenchmarkCorpus,
  type CatalogBenchmarkSample
} from "../scripts/catalog-search-benchmark-contract";
import { parseRecommendationIntent } from "../src/server/recommendation/intent";

const caseIds = ["a", "b", "c", "d", "e"];
const thresholds = { localP50Ms: 250, localP95Ms: 750, engineP95Ms: 1000 };

describe("catalog search benchmark contract", () => {
  it("strictly parses supported flags, profiles, and positive integer values", () => {
    expect(parseCatalogSearchBenchmarkArgs([])).toEqual({
      enforceAdvisoryTargets: false,
      iterations: 3,
      profile: "operational",
      skipEngine: false
    });
    expect(
      parseCatalogSearchBenchmarkArgs([
        "--limit",
        "12",
        "--iterations",
        "4",
        "--profile",
        "catalog-request-attempt",
        "--skip-engine",
        "--enforce-advisory-targets"
      ])
    ).toEqual({
      enforceAdvisoryTargets: true,
      iterations: 4,
      limit: 12,
      profile: "catalog-request-attempt",
      skipEngine: true
    });

    for (const values of [
      ["--unknown"],
      ["--limit"],
      ["--profile"],
      ["--profile", "automatic"],
      ["--limit", "0"],
      ["--iterations", "1.5"],
      ["--profile", "operational", "--profile", "catalog-request-attempt"],
      ["--iterations", "2", "--iterations", "3"]
    ]) {
      expect(() => parseCatalogSearchBenchmarkArgs(values)).toThrow();
    }
  });

  it("defines an explicit catalog request-attempt corpus with bounded isolation cases", () => {
    const profile = benchmarkCasesForProfile("catalog-request-attempt");
    const actionCases = profile.filter((testCase) => testCase.expectedResult === "scored");
    const isolationCases = profile.filter((testCase) => testCase.expectedResult === "zero");

    expect(actionCases.length).toBeGreaterThanOrEqual(20);
    expect(isolationCases.length).toBeGreaterThan(0);
    expect(isolationCases.length).toBeLessThanOrEqual(5);
    expect(actionCases.every((testCase) => parseRecommendationIntent(testCase.query).wantsRequestAttempt)).toBe(true);
    expect(isolationCases.every((testCase) => !parseRecommendationIntent(testCase.query).wantsRequestAttempt)).toBe(true);
    expect(new Set(profile.map((testCase) => testCase.id)).size).toBe(profile.length);
  });

  it("preflights operational and isolated catalog corpora without auto-selecting a profile", () => {
    expect(evaluateCatalogBenchmarkCorpusPreflight("operational", mixedOperationalCorpus())).toMatchObject({
      profile: "operational",
      status: "pass",
      failures: []
    });
    expect(evaluateCatalogBenchmarkCorpusPreflight("operational", isolatedCatalogCorpus())).toMatchObject({
      status: "fail",
      failures: ["missing_plex_verified_items", "missing_seerr_verified_items"]
    });
    expect(evaluateCatalogBenchmarkCorpusPreflight("catalog-request-attempt", isolatedCatalogCorpus())).toMatchObject({
      profile: "catalog-request-attempt",
      status: "pass",
      failures: []
    });
    expect(evaluateCatalogBenchmarkCorpusPreflight("catalog-request-attempt", mixedOperationalCorpus())).toMatchObject({
      status: "fail",
      failures: ["operational_items_contaminate_isolation_corpus"]
    });
    expect(
      evaluateCatalogBenchmarkCorpusPreflight("catalog-request-attempt", {
        ...isolatedCatalogCorpus(),
        requestAttemptProbeCount: 0
      })
    ).toMatchObject({ status: "fail", failures: ["missing_request_attempt_candidates"] });
  });

  it("accepts stable 80-percent scored coverage with honest engine and no-remote evidence", () => {
    const result = evaluate({ samples: stableSamples(), finalIndexHealthy: true });

    expect(result.scoringCoverage).toMatchObject({
      valid: true,
      expectationMode: "minimum-80-percent",
      scoredCases: 4,
      consistentlyZeroCaseIds: ["e"],
      unstableCoverageCaseIds: []
    });
    expect(result.engineCoverage).toMatchObject({
      valid: true,
      measured: true,
      samplesWithTiming: 10,
      samplesWithResultCount: 10,
      resultPresenceMismatchCaseIds: []
    });
    expect(result.noRemoteBoundary).toEqual({
      valid: true,
      descriptiveContentAllowed: false,
      searchCalls: 0
    });
    expect(result.validityStatus).toEqual({
      corpusPreflight: "pass",
      sampleSet: "pass",
      catalogIndexHealth: "pass",
      scoringCoverage: "pass",
      engineCoverage: "pass",
      noRemoteBoundary: "pass"
    });
    expect(result.advisoryTargetStatus).toEqual({
      localNoAiP50: "pass",
      localNoAiP95: "pass",
      engineNoAiNoRemoteP95: "pass"
    });
    expect(result.exitCode).toBe(0);
  });

  it("enforces explicit scored and intentional-zero case expectations", () => {
    const expected = evaluate({ samples: stableSamples(), expectedZeroCaseIds: ["e"] });
    expect(expected.scoringCoverage).toMatchObject({
      valid: true,
      expectationMode: "explicit",
      requiredScoredCases: 4,
      expectedScoredCaseIds: ["a", "b", "c", "d"],
      expectedZeroCaseIds: ["e"]
    });

    const unexpectedIsolationResult = stableSamples().map((sample) =>
      sample.caseId === "e" ? { ...sample, scoredItemCount: 3, engineResultCount: 3 } : sample
    );
    expect(evaluate({ samples: unexpectedIsolationResult, expectedZeroCaseIds: ["e"] }).scoringCoverage.valid).toBe(false);

    const missingActionResult = stableSamples().map((sample) =>
      sample.caseId === "d" ? { ...sample, scoredItemCount: 0, engineResultCount: 0 } : sample
    );
    expect(evaluate({ samples: missingActionResult, expectedZeroCaseIds: ["e"] }).scoringCoverage.valid).toBe(false);
  });

  it("invalidates all-zero, partial, and iteration-unstable scored coverage", () => {
    const allZero = stableSamples().map((sample) => ({ ...sample, scoredItemCount: 0, engineResultCount: 0 }));
    expect(evaluate({ samples: allZero }).validityStatus.scoringCoverage).toBe("invalid_insufficient_scored_coverage");

    const partial = stableSamples().map((sample) => ({
      ...sample,
      scoredItemCount: new Set(["a", "b", "c"]).has(sample.caseId) ? 10 : 0,
      engineResultCount: new Set(["a", "b", "c"]).has(sample.caseId) ? 5 : 0
    }));
    expect(evaluate({ samples: partial }).scoringCoverage.scoredCases).toBe(3);
    expect(evaluate({ samples: partial }).exitCode).toBe(1);

    const unstable = stableSamples().map((sample, index) =>
      sample.caseId === "d" && index >= caseIds.length ? { ...sample, scoredItemCount: 0, engineResultCount: 0 } : sample
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

  it("fails unhealthy indexes, corpus mismatch, remote calls, and incomplete engine evidence", () => {
    expect(evaluate({ samples: stableSamples().slice(1) }).validityStatus.sampleSet).toBe("invalid_sample_set");

    const duplicateAndMissingCase = stableSamples();
    duplicateAndMissingCase[1] = { ...duplicateAndMissingCase[1]!, caseId: "a" };
    expect(evaluate({ samples: duplicateAndMissingCase }).validityStatus.sampleSet).toBe("invalid_sample_set");

    expect(evaluate({ samples: stableSamples(), finalIndexHealthy: false }).validityStatus.catalogIndexHealth).toBe("fail");
    expect(evaluate({ samples: stableSamples(), corpusPreflightPassed: false }).validityStatus.corpusPreflight).toBe("fail");
    expect(evaluate({ samples: stableSamples(), noRemoteSearchCalls: 1 }).validityStatus.noRemoteBoundary).toBe("fail");
    expect(evaluate({ samples: stableSamples(), noRemoteDescriptiveContentAllowed: true }).validityStatus.noRemoteBoundary).toBe("fail");

    const incompleteEngine = stableSamples();
    incompleteEngine[0] = { ...incompleteEngine[0], engineMs: undefined };
    expect(evaluate({ samples: incompleteEngine }).validityStatus.engineCoverage).toBe(
      "invalid_incomplete_or_inconsistent_engine_coverage"
    );

    const missingEngineCount = stableSamples();
    missingEngineCount[0] = { ...missingEngineCount[0], engineResultCount: undefined };
    expect(evaluate({ samples: missingEngineCount }).engineCoverage.valid).toBe(false);

    const zeroEngineResults = stableSamples().map((sample) => ({ ...sample, engineResultCount: 0 }));
    const zeroEngineResult = evaluate({ samples: zeroEngineResults });
    expect(zeroEngineResult.engineCoverage.valid).toBe(false);
    expect(zeroEngineResult.engineCoverage.resultPresenceMismatchCaseIds).toEqual(["a", "b", "c", "d"]);
    expect(zeroEngineResult.validityStatus.engineCoverage).toBe("invalid_incomplete_or_inconsistent_engine_coverage");

    const skippedEngine = evaluate({ samples: incompleteEngine, measureEngine: false });
    expect(skippedEngine.validityStatus.engineCoverage).toBe("pass");
    expect(skippedEngine.engineCoverage.resultPresenceMismatchCaseIds).toEqual([]);
  });
});

function stableSamples(): CatalogBenchmarkSample[] {
  return Array.from({ length: 2 }, () =>
    caseIds.map((caseId) => ({
      caseId,
      totalLocalMs: 100,
      engineMs: 200,
      engineResultCount: caseId === "e" ? 0 : 5,
      scoredItemCount: caseId === "e" ? 0 : 10
    }))
  ).flat();
}

function mixedOperationalCorpus(): CatalogBenchmarkCorpus {
  return {
    totalItems: 100,
    catalogOnlyItems: 70,
    plexVerifiedItems: 20,
    seerrVerifiedItems: 10,
    requestableVerifiedItems: 5,
    requestAttemptProbeCount: 8,
    requestAttemptProbeLimit: 96
  };
}

function isolatedCatalogCorpus(): CatalogBenchmarkCorpus {
  return {
    totalItems: 100,
    catalogOnlyItems: 100,
    plexVerifiedItems: 0,
    seerrVerifiedItems: 0,
    requestableVerifiedItems: 0,
    requestAttemptProbeCount: 8,
    requestAttemptProbeLimit: 96
  };
}

function evaluate(options: {
  samples: CatalogBenchmarkSample[];
  expectedZeroCaseIds?: string[];
  finalIndexHealthy?: boolean;
  corpusPreflightPassed?: boolean;
  measureEngine?: boolean;
  noRemoteDescriptiveContentAllowed?: boolean;
  noRemoteSearchCalls?: number;
  enforceAdvisoryTargets?: boolean;
}) {
  return evaluateCatalogBenchmarkContract({
    caseIds,
    expectedZeroCaseIds: options.expectedZeroCaseIds,
    iterations: 2,
    samples: options.samples,
    finalIndexHealthy: options.finalIndexHealthy ?? true,
    corpusPreflightPassed: options.corpusPreflightPassed ?? true,
    measureEngine: options.measureEngine ?? true,
    noRemoteDescriptiveContentAllowed: options.noRemoteDescriptiveContentAllowed ?? false,
    noRemoteSearchCalls: options.noRemoteSearchCalls ?? 0,
    enforceAdvisoryTargets: options.enforceAdvisoryTargets ?? false,
    thresholds
  });
}
