export interface CatalogSearchBenchmarkArgs {
  enforceAdvisoryTargets: boolean;
  limit?: number;
  iterations: number;
  skipEngine: boolean;
}

export interface CatalogBenchmarkSample {
  caseId: string;
  totalLocalMs: number;
  engineMs?: number;
  scoredItemCount: number;
}

export interface CatalogBenchmarkThresholds {
  localP50Ms: number;
  localP95Ms: number;
  engineP95Ms: number;
}

export class CatalogBenchmarkArgumentError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CatalogBenchmarkArgumentError";
  }
}

export function parseCatalogSearchBenchmarkArgs(values: string[]): CatalogSearchBenchmarkArgs {
  const parsed: CatalogSearchBenchmarkArgs = {
    enforceAdvisoryTargets: false,
    iterations: 3,
    skipEngine: false
  };
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index]!;
    if (seen.has(key)) throw new CatalogBenchmarkArgumentError("duplicate_option");
    seen.add(key);
    if (key === "--skip-engine") {
      parsed.skipEngine = true;
      continue;
    }
    if (key === "--enforce-advisory-targets") {
      parsed.enforceAdvisoryTargets = true;
      continue;
    }
    if (key !== "--limit" && key !== "--iterations") {
      throw new CatalogBenchmarkArgumentError("unknown_option");
    }
    const value = values[++index];
    if (value === undefined || value.startsWith("--")) throw new CatalogBenchmarkArgumentError("missing_option_value");
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) throw new CatalogBenchmarkArgumentError("invalid_positive_integer");
    if (key === "--limit") parsed.limit = number;
    else parsed.iterations = number;
  }
  return parsed;
}

export function evaluateCatalogBenchmarkContract<T extends CatalogBenchmarkSample>(input: {
  caseIds: string[];
  iterations: number;
  samples: T[];
  finalIndexHealthy: boolean;
  measureEngine: boolean;
  enforceAdvisoryTargets: boolean;
  thresholds: CatalogBenchmarkThresholds;
}) {
  if (!Number.isSafeInteger(input.iterations) || input.iterations < 1) throw new Error("invalid_iterations");
  if (input.caseIds.length === 0 || new Set(input.caseIds).size !== input.caseIds.length) throw new Error("invalid_case_ids");
  const caseIdSet = new Set(input.caseIds);
  const samplesIndividuallyValid =
    input.samples.length === input.caseIds.length * input.iterations &&
    input.samples.every(
      (sample) =>
        caseIdSet.has(sample.caseId) &&
        Number.isFinite(sample.totalLocalMs) &&
        sample.totalLocalMs >= 0 &&
        Number.isSafeInteger(sample.scoredItemCount) &&
        sample.scoredItemCount >= 0 &&
        (sample.engineMs === undefined || (Number.isFinite(sample.engineMs) && sample.engineMs >= 0))
    );

  const sampleCountsByCase = new Map<string, number>();
  const scoredSampleCountsByCase = new Map<string, number>();
  for (const sample of input.samples) {
    sampleCountsByCase.set(sample.caseId, (sampleCountsByCase.get(sample.caseId) ?? 0) + 1);
    if (sample.scoredItemCount > 0) {
      scoredSampleCountsByCase.set(sample.caseId, (scoredSampleCountsByCase.get(sample.caseId) ?? 0) + 1);
    }
  }
  const sampleSetValid =
    samplesIndividuallyValid && input.caseIds.every((caseId) => sampleCountsByCase.get(caseId) === input.iterations);

  const consistentlyScoredCaseIds = input.caseIds.filter(
    (caseId) => sampleCountsByCase.get(caseId) === input.iterations && scoredSampleCountsByCase.get(caseId) === input.iterations
  );
  const consistentlyZeroCaseIds = input.caseIds.filter(
    (caseId) => sampleCountsByCase.get(caseId) === input.iterations && (scoredSampleCountsByCase.get(caseId) ?? 0) === 0
  );
  const unstableCoverageCaseIds = input.caseIds.filter(
    (caseId) => !consistentlyScoredCaseIds.includes(caseId) && !consistentlyZeroCaseIds.includes(caseId)
  );
  const requiredScoredCases = Math.max(1, Math.ceil(input.caseIds.length * 0.8));
  const scoringCoverageValid =
    sampleSetValid &&
    consistentlyScoredCaseIds.length >= requiredScoredCases && unstableCoverageCaseIds.length === 0;
  const engineCoverageValid =
    sampleSetValid &&
    (!input.measureEngine || input.samples.every((sample) => typeof sample.engineMs === "number" && Number.isFinite(sample.engineMs)));
  const scoredSamples = input.samples.filter((sample) => sample.scoredItemCount > 0);
  const allLocal = input.samples.map((sample) => sample.totalLocalMs);
  const scoredLocal = scoredSamples.map((sample) => sample.totalLocalMs);
  const allEngine = input.samples.flatMap((sample) => (sample.engineMs === undefined ? [] : [sample.engineMs]));
  const scoredEngine = scoredSamples.flatMap((sample) => (sample.engineMs === undefined ? [] : [sample.engineMs]));

  const validityStatus = {
    sampleSet: sampleSetValid ? "pass" : "invalid_sample_set",
    catalogIndexHealth: input.finalIndexHealthy ? "pass" : "fail",
    scoringCoverage: scoringCoverageValid ? "pass" : "invalid_insufficient_scored_coverage",
    engineCoverage: engineCoverageValid ? "pass" : "invalid_incomplete_engine_coverage"
  } as const;
  const advisoryTargetStatus = {
    localNoAiP50: !scoringCoverageValid
      ? "invalid_insufficient_scored_coverage"
      : worstPercentile(allLocal, scoredLocal, 0.5) <= input.thresholds.localP50Ms
        ? "pass"
        : "fail",
    localNoAiP95: !scoringCoverageValid
      ? "invalid_insufficient_scored_coverage"
      : worstPercentile(allLocal, scoredLocal, 0.95) <= input.thresholds.localP95Ms
        ? "pass"
        : "fail",
    engineNoAiNoRemoteP95: !input.measureEngine
      ? "skipped"
      : !scoringCoverageValid || !engineCoverageValid
        ? "invalid_incomplete_engine_evidence"
        : worstPercentile(allEngine, scoredEngine, 0.95) <= input.thresholds.engineP95Ms
          ? "pass"
          : "fail"
  } as const;
  const validityFailed = Object.values(validityStatus).some((status) => status !== "pass");
  const advisoryFailed = Object.values(advisoryTargetStatus).some((status) => status === "fail");

  return {
    scoredSamples,
    scoringCoverage: {
      valid: scoringCoverageValid,
      scoredCases: consistentlyScoredCaseIds.length,
      requiredScoredCases,
      totalCases: input.caseIds.length,
      consistentlyScoredCaseIds,
      consistentlyZeroCaseIds,
      unstableCoverageCaseIds,
      scoredSamples: scoredSamples.length,
      zeroResultSamples: input.samples.length - scoredSamples.length,
      totalScoredResults: scoredSamples.reduce((total, sample) => total + sample.scoredItemCount, 0)
    },
    validityStatus,
    advisoryTargetStatus,
    exitCode: validityFailed || (input.enforceAdvisoryTargets && advisoryFailed) ? 1 : 0
  } as const;
}

function worstPercentile(all: number[], scored: number[], percentileValue: number) {
  return Math.max(nearestRankPercentile(all, percentileValue), nearestRankPercentile(scored, percentileValue));
}

function nearestRankPercentile(values: number[], percentileValue: number) {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)]!;
}
