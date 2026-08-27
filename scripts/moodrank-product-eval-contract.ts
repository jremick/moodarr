import type { AiRankerResult } from "../src/server/ai/ranker";
import {
  IndependentEvalContractError,
  aggregateIndependentEvalMetrics,
  defaultBootstrapSamples,
  defaultIndependentEvalSeed,
  evidenceStatusForCaseCount,
  type IndependentEvalCaseObservation,
  type MetricEstimate
} from "./moodrank-independent-eval-contract";

export type ProductMetricKey =
  | "ndcgAt3"
  | "ndcgAt10"
  | "acceptableFamilyHitAt3"
  | "acceptableFamilyHitAt10"
  | "pairwiseCoverage"
  | "pairwiseAccuracy"
  | "constraintExpectedMatchRate";

export type ProductMetricEstimate = MetricEstimate & {
  evidenceStatus: ReturnType<typeof evidenceStatusForCaseCount>;
};

export interface ProductResponseMetrics {
  ndcgAt3: ProductMetricEstimate;
  ndcgAt10: ProductMetricEstimate;
  acceptableFamilyHitAt3: ProductMetricEstimate;
  acceptableFamilyHitAt10: ProductMetricEstimate;
  pairwiseCoverage: ProductMetricEstimate;
  pairwiseAccuracy: ProductMetricEstimate;
  constraints: {
    counts: Record<"pass" | "fail" | "unknown", number>;
    rates: Record<"pass" | "fail" | "unknown", ProductMetricEstimate>;
    expectedMatchCount: number;
    total: number;
  };
  timingMs: {
    retrieval: { count: number; p50: number; p95: number };
    rankingAndRerank: { count: number; p50: number; p95: number };
  };
}

export interface PairedMetricComparison {
  wins: number;
  losses: number;
  ties: number;
  contributingCases: number;
  meanDelta: number | null;
  meanDeltaCi95: { lower: number; upper: number } | null;
  evidenceStatus: ReturnType<typeof evidenceStatusForCaseCount>;
}

export interface ProductCaseResult {
  usedAi: boolean;
  responseItemCount: number;
  judgedRanks: Array<{ itemRef: string; rank: number }>;
  metrics: ProductCaseMetrics;
  responseLatencyMs: number;
}

export type ProductCaseMetrics = Omit<IndependentEvalCaseObservation, "preRerankRecall">;

export interface ProductEvalCaseDetail {
  caseId: string;
  deterministic: ProductCaseResult;
  aiAssisted: ProductCaseResult & {
    fallback: boolean;
    rerank: {
      requested: true;
      offeredCandidateCount: number;
      serializedCandidateCount: number;
      aiRankedCandidateCount: number;
      offeredWindowComplete: boolean;
      serializedPayloadComplete: boolean;
      finalResponseItemCount: number;
      finalResponseAiCoveredCount: number;
      finalResponseComplete: boolean;
      completeForResponseComparison: boolean;
    };
  };
}

export interface ProductEvalReport {
  schemaVersion: "moodrank-product-eval-report-v1";
  status: "completed" | "incomplete" | "simulated";
  completeCaseSetEvidenceStatus: ReturnType<typeof evidenceStatusForCaseCount>;
  corpusId: string;
  judgmentVersion: string;
  catalogSnapshotId: string;
  evaluatedCases: number;
  evaluationStages: {
    deterministic: "search_service_final_response";
    aiRequestedFailSoft: "search_service_final_response";
    finalSearchServiceResponseEvaluated: true;
    runtimeConfigurationParity: "controlled";
    retrievalMetricsReported: false;
  };
  metrics: {
    allCases: {
      deterministic: ProductResponseMetrics;
      aiRequestedFailSoft: ProductResponseMetrics;
    };
    completeAiCases: {
      caseCount: number;
      deterministic: ProductResponseMetrics | null;
      aiReranked: ProductResponseMetrics | null;
      pairedComparisons: Record<ProductMetricKey, PairedMetricComparison> | null;
    };
  };
  aiRerankCompleteness: {
    casesRequested: number;
    casesUsedAi: number;
    casesFallback: number;
    casesCompleteForResponseComparison: number;
    offeredCandidateCount: number;
    serializedCandidateCount: number;
    aiRankedCandidateCount: number;
    finalResponseItemCount: number;
    finalResponseAiCoveredCount: number;
    externalRequestCount: number;
  };
  provenance: {
    engineVersion: string;
    executionMode: "external" | "simulated";
    provider: "openai" | "simulated";
    model: string;
    reasoningEffort: string;
    providerEvidenceEligible: boolean;
    sourceCommit: string;
    sourceDirty: boolean | "unknown";
    sourceTreeSha256: string;
    nodeVersion: string;
    platform: NodeJS.Platform;
    architecture: string;
    seed: number;
    bootstrapSamples: number;
    database: {
      sourceSha256: string;
      workSha256: string;
      workDatabaseRetained: true;
      sourceUnchanged: true;
      schemaMigrationCount: number;
      schema32MigrationPresent: true;
    };
    contentHashes: {
      cases: string;
      judgments: string;
      catalog: string;
      evaluationInput: string;
    };
    executionPolicy: {
      externalProcessingConfirmed: true;
      networkScope: "openai_responses_rerank_only";
      plannedExternalRequests: number;
      maxExternalRequests: number;
      disposableDatabase: true;
      sourceDatabaseReadOnly: true;
      startupRepairsDisabled: true;
      plexDisabled: true;
      seerrDisabled: true;
      descriptiveAugmentationDisabled: true;
      providerEmbeddingsDisabled: true;
      providerEmbeddingBackfillDisabled: true;
      aiBriefParsingDisabled: true;
      aiQueryOptimizationDisabled: true;
      aiTasteScoutDisabled: true;
      personalizationStateCleared: true;
      importedAuthRequestAndTelemetryStateCleared: true;
      strictTraceWritesRequired: true;
      rawQueriesWrittenToStdout: false;
      rawCandidatePayloadsWrittenToStdout: false;
      releaseThresholdDefined: false;
    };
    inferencePolicy: {
      armMetricCiMethod: "case_percentile_bootstrap";
      pairedDeltaCiMethod: "paired_case_percentile_bootstrap";
      aiRunsPerCase: 1;
      intervalsConditionalOnSingleProviderRun: true;
    };
    timingPolicy: {
      diagnosticOnly: true;
      armOrder: "deterministic_then_ai";
    };
    generatedAt: string;
    durationMs: number;
  };
  details?: ProductEvalCaseDetail[];
}

const productMetricSelectors: Array<{
  key: ProductMetricKey;
  salt: number;
  select: (observation: IndependentEvalCaseObservation) => number | null;
}> = [
  { key: "ndcgAt3", salt: 0x301, select: (observation) => observation.ndcgAt3 },
  { key: "ndcgAt10", salt: 0x302, select: (observation) => observation.ndcgAt10 },
  { key: "acceptableFamilyHitAt3", salt: 0x303, select: (observation) => observation.acceptableFamilyHitAt3 },
  { key: "acceptableFamilyHitAt10", salt: 0x304, select: (observation) => observation.acceptableFamilyHitAt10 },
  { key: "pairwiseCoverage", salt: 0x305, select: (observation) => observation.pairwiseCoverage },
  { key: "pairwiseAccuracy", salt: 0x306, select: (observation) => observation.pairwiseAccuracy },
  {
    key: "constraintExpectedMatchRate",
    salt: 0x307,
    select: (observation) => observation.constraintTotal === 0
      ? null
      : observation.constraintExpectedMatches / observation.constraintTotal
  }
];

export function productRerankCoverage(input: {
  usedAi: boolean;
  offeredCandidateCount: number;
  finalResponseItemIds: string[];
  rankerResult?: AiRankerResult;
}) {
  const serializedCandidateCount = input.rankerResult?.trace?.serializedCandidateCount ?? 0;
  const rankedItemIds = input.rankerResult?.trace?.rankedItems.map((item) => item.itemId) ?? [];
  const aiRankedIds = new Set(rankedItemIds);
  const finalResponseItemCount = input.finalResponseItemIds.length;
  const finalResponseAiCoveredCount = input.finalResponseItemIds.filter((itemId) => aiRankedIds.has(itemId)).length;
  const serializedPayloadComplete = serializedCandidateCount > 0
    && rankedItemIds.length === serializedCandidateCount;
  const finalResponseComplete = finalResponseItemCount > 0
    && finalResponseAiCoveredCount === finalResponseItemCount;
  return {
    offeredWindowComplete: input.offeredCandidateCount > 0
      && serializedCandidateCount === input.offeredCandidateCount,
    serializedPayloadComplete,
    finalResponseItemCount,
    finalResponseAiCoveredCount,
    finalResponseComplete,
    completeForResponseComparison: input.usedAi && serializedPayloadComplete && finalResponseComplete
  };
}

export function aggregateSafeProductReport(report: ProductEvalReport) {
  const aggregate: ProductEvalReport = { ...report };
  delete aggregate.details;
  return aggregate;
}

export function aggregatePairedComparisons(
  deterministicObservations: IndependentEvalCaseObservation[],
  aiObservations: IndependentEvalCaseObservation[],
  seed = defaultIndependentEvalSeed,
  bootstrapSamples = defaultBootstrapSamples
): Record<ProductMetricKey, PairedMetricComparison> {
  if (deterministicObservations.length !== aiObservations.length) {
    throw new IndependentEvalContractError("paired_case_count_mismatch");
  }
  const deterministicByCaseId = new Map(deterministicObservations.map((observation) => [observation.caseId, observation]));
  const aiByCaseId = new Map(aiObservations.map((observation) => [observation.caseId, observation]));
  const caseIds = [...deterministicByCaseId.keys()].sort();
  if (caseIds.some((caseId) => !aiByCaseId.has(caseId)) || aiByCaseId.size !== caseIds.length) {
    throw new IndependentEvalContractError("paired_case_id_mismatch");
  }
  return Object.fromEntries(productMetricSelectors.map(({ key, select, salt }) => {
    const deltas = caseIds.flatMap((caseId) => {
      const deterministicValue = select(deterministicByCaseId.get(caseId)!);
      const aiValue = select(aiByCaseId.get(caseId)!);
      return deterministicValue === null || aiValue === null || !Number.isFinite(deterministicValue) || !Number.isFinite(aiValue)
        ? []
        : [aiValue - deterministicValue];
    });
    const interval = deterministicBootstrapMean(deltas, seed ^ salt, bootstrapSamples);
    return [key, {
      wins: deltas.filter((delta) => delta > 0).length,
      losses: deltas.filter((delta) => delta < 0).length,
      ties: deltas.filter((delta) => delta === 0).length,
      contributingCases: deltas.length,
      meanDelta: interval.value,
      meanDeltaCi95: interval.ci95,
      evidenceStatus: evidenceStatusForCaseCount(deltas.length)
    } satisfies PairedMetricComparison];
  })) as Record<ProductMetricKey, PairedMetricComparison>;
}

export function productCaseMetrics(observation: IndependentEvalCaseObservation): ProductCaseMetrics {
  return {
    caseId: observation.caseId,
    ndcgAt3: observation.ndcgAt3,
    ndcgAt10: observation.ndcgAt10,
    acceptableFamilyHitAt3: observation.acceptableFamilyHitAt3,
    acceptableFamilyHitAt10: observation.acceptableFamilyHitAt10,
    pairwiseCoverage: observation.pairwiseCoverage,
    pairwiseAccuracy: observation.pairwiseAccuracy,
    pairwiseTieCount: observation.pairwiseTieCount,
    constraintCounts: observation.constraintCounts,
    constraintExpectedMatches: observation.constraintExpectedMatches,
    constraintTotal: observation.constraintTotal,
    retrievalMs: observation.retrievalMs,
    scoringMs: observation.scoringMs
  };
}

export function productResponseMetrics(
  observations: IndependentEvalCaseObservation[],
  seed: number
): ProductResponseMetrics {
  const aggregate = aggregateIndependentEvalMetrics(observations, seed);
  return {
    ndcgAt3: productMetricEstimate(aggregate.ndcgAt3),
    ndcgAt10: productMetricEstimate(aggregate.ndcgAt10),
    acceptableFamilyHitAt3: productMetricEstimate(aggregate.acceptableFamilyHitAt3),
    acceptableFamilyHitAt10: productMetricEstimate(aggregate.acceptableFamilyHitAt10),
    pairwiseCoverage: productMetricEstimate(aggregate.pairwiseCoverage),
    pairwiseAccuracy: productMetricEstimate(aggregate.pairwiseAccuracy),
    constraints: {
      ...aggregate.constraints,
      rates: {
        pass: productMetricEstimate(aggregate.constraints.rates.pass),
        fail: productMetricEstimate(aggregate.constraints.rates.fail),
        unknown: productMetricEstimate(aggregate.constraints.rates.unknown)
      }
    },
    timingMs: {
      retrieval: aggregate.timingMs.retrieval,
      rankingAndRerank: aggregate.timingMs.scoring
    }
  };
}

export function sumProductValues(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}

function productMetricEstimate(estimate: MetricEstimate): ProductMetricEstimate {
  return {
    ...estimate,
    ci95: estimate.contributingCases < 2 ? null : estimate.ci95,
    evidenceStatus: evidenceStatusForCaseCount(estimate.contributingCases)
  };
}

function deterministicBootstrapMean(values: number[], seed: number, samples: number) {
  if (!Number.isSafeInteger(samples) || samples < 1) throw new IndependentEvalContractError("invalid_bootstrap_samples");
  if (values.length === 0) return { value: null, ci95: null };
  const value = roundMetric(sumProductValues(values) / values.length);
  if (values.length === 1) return { value, ci95: null };
  const random = mulberry32(seed >>> 0);
  const means: number[] = [];
  for (let sample = 0; sample < samples; sample += 1) {
    let total = 0;
    for (let index = 0; index < values.length; index += 1) {
      total += values[Math.floor(random() * values.length)]!;
    }
    means.push(total / values.length);
  }
  means.sort((left, right) => left - right);
  return {
    value,
    ci95: {
      lower: roundMetric(percentile(means, 0.025)),
      upper: roundMetric(percentile(means, 0.975))
    }
  };
}

function mulberry32(seed: number) {
  let state = seed;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sorted: number[], quantile: number) {
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function roundMetric(value: number) {
  const rounded = Math.round(value * 1_000_000) / 1_000_000;
  return Object.is(rounded, -0) ? 0 : rounded;
}
