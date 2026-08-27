import type { ProductEvalReport, ProductResponseMetrics } from "./moodrank-product-eval-contract";
import {
  openAiRankerDefaultMaxOutputTokens,
  openAiRankerSerializedCandidateLimit
} from "../src/server/ai/ranker";

const sha256Pattern = /^sha256:[0-9a-f]{64}$/;

export type ModelSelectionEvidenceStage = "screening" | "production";
export type ModelSelectionRole = "quality_reference" | "incumbent" | "challenger";
export type SelectionOrderKey =
  | "ndcgAt10_desc"
  | "ndcgAt3_desc"
  | "familyHitAt10_desc"
  | "productP95Ms_asc"
  | "providerP95Ms_asc"
  | "costPerCaseUsd_asc";

export interface ModelSelectionManifest {
  schemaVersion: "moodrank-model-selection-manifest-v1";
  decisionId: string;
  evidenceStage: ModelSelectionEvidenceStage;
  referenceConfigurationId: string;
  incumbentConfigurationId?: string;
  comparisonContract: {
    corpusId: string;
    judgmentVersion: string;
    catalogSnapshotId: string;
    evaluatedCases: number;
    engineVersion: string;
    sourceCommit: string;
    sourceTreeSha256: string;
    casesSha256: string;
    judgmentsSha256: string;
    catalogSha256: string;
    seed: number;
    bootstrapSamples: number;
    aiRunsPerCase: number;
    rankerMaxOutputTokens: number;
    prompt: { id: string; sha256: string };
    response: { id: string; sha256: string };
    evaluation: { id: string; sha256: string };
  };
  promotionGates?: {
    minimumCases?: number;
    maximumProductP95Ms?: number;
    maximumProviderP95Ms?: number;
    maximumCostPerCaseUsd?: number;
    minimumNdcgAt3?: number;
    minimumNdcgAt10?: number;
    minimumFamilyHitAt10?: number;
    minimumNdcgAt10RatioOfReference?: number;
    minimumNdcgAt10DeltaVsIncumbent?: number;
    minimumNdcgAt10DeltaVsReferenceLower95?: number;
    minimumNdcgAt10DeltaVsIncumbentLower95?: number;
    requireParetoFrontier?: boolean;
  };
  selectionOrder?: SelectionOrderKey[];
  configurations: ModelSelectionConfiguration[];
}

export interface ModelSelectionConfiguration {
  id: string;
  role: ModelSelectionRole;
  reportPath: string;
  expected: {
    model: string;
    reasoningEffort: string;
    requestedServiceTier: string;
    rankerTimeoutMs: number | null;
    rankerMaxOutputTokens: number;
    diagnosticOnly: boolean;
  };
  pricing: {
    inputUsdPerMillion: number;
    cachedInputUsdPerMillion: number;
    outputUsdPerMillion: number;
    serviceTierMultiplier: number;
  };
}

export interface ModelSelectionMetricSet {
  ndcgAt3: number | null;
  ndcgAt10: number | null;
  familyHitAt3: number | null;
  familyHitAt10: number | null;
  productLatencyMs: { p50: number; p95: number } | null;
  providerLatencyMs: { p50: number; p95: number } | null;
  completeness: {
    casesRequested: number;
    casesUsedAi: number;
    casesFallback: number;
    casesComplete: number;
    serializedCandidates: number;
    aiRankedCandidates: number;
    ratio: number;
  };
  cost: {
    totalUsd: number | null;
    perCaseUsd: number | null;
    responsesWithUsage: number;
  };
}

export interface ModelSelectionConfigurationResult {
  id: string;
  role: ModelSelectionRole;
  model: string;
  reasoningEffort: string;
  requestedServiceTier: string;
  rankerMaxOutputTokens: number;
  comparisonEligible: boolean;
  productionPromotionEligible: boolean;
  comparisonRejectionReasons: string[];
  productionRejectionReasons: string[];
  warnings: string[];
  metrics: ModelSelectionMetricSet;
  relativeToReference: {
    ndcgAt10Delta: number | null;
    ndcgAt10Ratio: number | null;
    productP95Speedup: number | null;
    costRatio: number | null;
    ndcgAt10PairedDelta: PairedQualityDelta | null;
  } | null;
  relativeToIncumbent: {
    ndcgAt10Delta: number | null;
    ndcgAt10PairedDelta: PairedQualityDelta | null;
  } | null;
  pareto: {
    onFrontier: boolean;
    dominatedBy: string[];
  };
}

export interface PairedQualityDelta {
  wins: number;
  losses: number;
  ties: number;
  contributingCases: number;
  meanDelta: number;
  ci95: { lower: number; upper: number } | null;
}

export interface ModelSelectionResult {
  schemaVersion: "moodrank-model-selection-result-v1";
  decisionId: string;
  evidenceStage: ModelSelectionEvidenceStage;
  referenceConfigurationId: string;
  incumbentConfigurationId: string | null;
  comparisonContract: ModelSelectionManifest["comparisonContract"];
  configurations: ModelSelectionConfigurationResult[];
  paretoFrontierConfigurationIds: string[];
  productionPromotionCandidateIds: string[];
  recommendedConfigurationId: string | null;
  decisionReasons: string[];
}

type ProductReportWithContracts = Omit<ProductEvalReport, "schemaVersion" | "evaluationStages" | "metrics" | "provenance"> & {
  schemaVersion: string;
  evaluationStages: ProductEvalReport["evaluationStages"] & {
    aiRerankedStrict?: "search_service_final_response";
  };
  metrics: ProductEvalReport["metrics"] & {
    allCases: ProductEvalReport["metrics"]["allCases"] & {
      aiRerankedStrict?: ProductResponseMetrics;
    };
  };
  provenance: Omit<ProductEvalReport["provenance"], "timingPolicy" | "executionPolicy"> & {
    timingPolicy: {
      diagnosticOnly: boolean;
      armOrder: string;
      aiFirstCases?: number;
      deterministicFirstCases?: number;
      rankerTimeoutMs: number | null;
    };
    executionPolicy?: ProductEvalReport["provenance"]["executionPolicy"] & {
      rankerMaxOutputTokens?: number;
    };
    contracts?: {
      prompt?: { id?: string; sha256?: string };
      response?: { id?: string; sha256?: string };
      evaluation?: { id?: string; sha256?: string };
    };
  };
};

export class ModelSelectionContractError extends Error {}

export function parseModelSelectionManifest(value: unknown): ModelSelectionManifest {
  const manifest = requireRecord(value, "manifest_not_object");
  if (manifest.schemaVersion !== "moodrank-model-selection-manifest-v1") fail("unsupported_manifest_schema");
  const evidenceStage = requireEnum(manifest.evidenceStage, ["screening", "production"], "invalid_evidence_stage");
  const comparison = requireRecord(manifest.comparisonContract, "comparison_contract_missing");
  const configurationsValue = manifest.configurations;
  if (!Array.isArray(configurationsValue) || configurationsValue.length < 2) fail("at_least_two_configurations_required");

  const configurations = configurationsValue.map((entry, index) => parseConfiguration(entry, index));
  const configurationIds = configurations.map((entry) => entry.id);
  if (new Set(configurationIds).size !== configurationIds.length) fail("duplicate_configuration_id");
  if (new Set(configurations.map((entry) => entry.reportPath)).size !== configurations.length) fail("duplicate_report_path");
  const referenceConfigurationId = requireText(manifest.referenceConfigurationId, "reference_configuration_id_missing");
  const reference = configurations.find((entry) => entry.id === referenceConfigurationId);
  if (!reference) fail("reference_configuration_not_found");
  if (reference.role !== "quality_reference") fail("reference_configuration_role_mismatch");
  const incumbentConfigurationId = optionalText(manifest.incumbentConfigurationId, "invalid_incumbent_configuration_id");
  if (incumbentConfigurationId !== undefined) {
    const incumbent = configurations.find((entry) => entry.id === incumbentConfigurationId);
    if (!incumbent) fail("incumbent_configuration_not_found");
    if (incumbent.role !== "incumbent") fail("incumbent_configuration_role_mismatch");
  }
  if (configurations.filter((entry) => entry.role === "quality_reference").length !== 1) fail("exactly_one_quality_reference_required");
  if (configurations.filter((entry) => entry.role === "incumbent").length > 1) fail("at_most_one_incumbent_allowed");

  const parsed: ModelSelectionManifest = {
    schemaVersion: "moodrank-model-selection-manifest-v1",
    decisionId: requireText(manifest.decisionId, "decision_id_missing"),
    evidenceStage,
    referenceConfigurationId,
    ...(incumbentConfigurationId !== undefined ? { incumbentConfigurationId } : {}),
    comparisonContract: {
      corpusId: requireText(comparison.corpusId, "comparison_corpus_id_missing"),
      judgmentVersion: requireText(comparison.judgmentVersion, "comparison_judgment_version_missing"),
      catalogSnapshotId: requireText(comparison.catalogSnapshotId, "comparison_catalog_snapshot_id_missing"),
      evaluatedCases: requirePositiveInteger(comparison.evaluatedCases, "invalid_comparison_case_count"),
      engineVersion: requireText(comparison.engineVersion, "comparison_engine_version_missing"),
      sourceCommit: requireText(comparison.sourceCommit, "comparison_source_commit_missing"),
      sourceTreeSha256: requireSha256(comparison.sourceTreeSha256, "invalid_comparison_source_tree_hash"),
      casesSha256: requireSha256(comparison.casesSha256, "invalid_comparison_cases_hash"),
      judgmentsSha256: requireSha256(comparison.judgmentsSha256, "invalid_comparison_judgments_hash"),
      catalogSha256: requireSha256(comparison.catalogSha256, "invalid_comparison_catalog_hash"),
      seed: requireNonNegativeInteger(comparison.seed, "invalid_comparison_seed"),
      bootstrapSamples: requirePositiveInteger(comparison.bootstrapSamples, "invalid_comparison_bootstrap_samples"),
      aiRunsPerCase: requirePositiveInteger(comparison.aiRunsPerCase, "invalid_comparison_ai_runs_per_case"),
      rankerMaxOutputTokens: requirePositiveInteger(comparison.rankerMaxOutputTokens, "invalid_comparison_ranker_max_output_tokens"),
      prompt: parseNamedContract(comparison.prompt, "prompt"),
      response: parseNamedContract(comparison.response, "response"),
      evaluation: parseNamedContract(comparison.evaluation, "evaluation")
    },
    configurations
  };
  if (manifest.promotionGates !== undefined) parsed.promotionGates = parsePromotionGates(manifest.promotionGates);
  if (manifest.selectionOrder !== undefined) parsed.selectionOrder = parseSelectionOrder(manifest.selectionOrder);
  if (parsed.configurations.some((configuration) =>
    configuration.expected.rankerMaxOutputTokens !== parsed.comparisonContract.rankerMaxOutputTokens
  )) fail("configuration_ranker_max_output_tokens_mismatch_comparison_contract");
  if (evidenceStage === "production") {
    if (parsed.comparisonContract.rankerMaxOutputTokens !== openAiRankerDefaultMaxOutputTokens) {
      fail("production_requires_default_ranker_max_output_tokens");
    }
    if (!parsed.promotionGates) fail("production_promotion_gates_required");
    if (parsed.comparisonContract.evaluatedCases < 100 || (parsed.promotionGates.minimumCases ?? 0) < 100) {
      fail("production_requires_100_unique_cases");
    }
    if (parsed.promotionGates.minimumNdcgAt10DeltaVsReferenceLower95 === undefined) {
      fail("production_reference_confidence_gate_required");
    }
    if (incumbentConfigurationId !== undefined
      && parsed.promotionGates.minimumNdcgAt10DeltaVsIncumbentLower95 === undefined) {
      fail("production_incumbent_confidence_gate_required");
    }
  }
  return parsed;
}

export function evaluateModelSelection(
  rawManifest: unknown,
  reportsByConfigurationId: Readonly<Record<string, unknown>>
): ModelSelectionResult {
  const manifest = parseModelSelectionManifest(rawManifest);
  const evaluated = manifest.configurations.map((configuration) => evaluateConfiguration(
    manifest,
    configuration,
    reportsByConfigurationId[configuration.id]
  ));
  const reference = evaluated.find((entry) => entry.id === manifest.referenceConfigurationId)!;
  const incumbent = manifest.incumbentConfigurationId
    ? evaluated.find((entry) => entry.id === manifest.incumbentConfigurationId) ?? null
    : null;

  const withRelativeMetrics = evaluated.map((entry) => ({
    ...entry,
    relativeToReference: {
      ...relativeMetrics(entry.metrics, reference.metrics),
      ndcgAt10PairedDelta: pairedNdcgAt10Delta(
        reportsByConfigurationId[entry.id],
        reportsByConfigurationId[reference.id],
        manifest.comparisonContract.seed,
        manifest.comparisonContract.bootstrapSamples
      )
    },
    relativeToIncumbent: incumbent
      ? {
          ndcgAt10Delta: entry.metrics.ndcgAt10 !== null && incumbent.metrics.ndcgAt10 !== null
            ? roundMetric(entry.metrics.ndcgAt10 - incumbent.metrics.ndcgAt10)
            : null,
          ndcgAt10PairedDelta: pairedNdcgAt10Delta(
            reportsByConfigurationId[entry.id],
            reportsByConfigurationId[incumbent.id],
            manifest.comparisonContract.seed ^ 0x55a,
            manifest.comparisonContract.bootstrapSamples
          )
        }
      : null
  }));
  const comparable = withRelativeMetrics.filter((entry) => entry.comparisonEligible);
  const withPareto = withRelativeMetrics.map((entry) => {
    const dominatedBy = entry.comparisonEligible
      ? comparable.filter((other) => other.id !== entry.id && dominates(other.metrics, entry.metrics)).map((other) => other.id).sort()
      : [];
    return { ...entry, pareto: { onFrontier: entry.comparisonEligible && dominatedBy.length === 0, dominatedBy } };
  });
  const gated = withPareto.map((entry) => applyPromotionGates(manifest, entry, reference, incumbent));
  const frontierIds = gated.filter((entry) => entry.pareto.onFrontier).map((entry) => entry.id).sort();
  const promotionCandidates = gated
    .filter((entry) => entry.role === "challenger" && entry.productionPromotionEligible)
    .sort((left, right) => compareBySelectionOrder(left, right, manifest.selectionOrder ?? []));
  const decisionReasons: string[] = [];
  let recommendedConfigurationId: string | null = null;
  if (manifest.evidenceStage !== "production") {
    decisionReasons.push("screening_evidence_cannot_select_production_default");
  } else if (!reference.productionPromotionEligible) {
    decisionReasons.push("quality_reference_not_production_eligible");
  } else if (incumbent && !incumbent.productionPromotionEligible) {
    decisionReasons.push("incumbent_not_production_eligible");
  } else if (promotionCandidates.length === 0) {
    decisionReasons.push("no_challenger_passed_production_promotion_gates");
  } else if (!manifest.selectionOrder || manifest.selectionOrder.length === 0) {
    decisionReasons.push("selection_order_required_to_choose_among_passing_challengers");
  } else {
    recommendedConfigurationId = promotionCandidates[0]!.id;
    decisionReasons.push("recommended_challenger_passed_all_gates_and_selection_policy");
  }

  return {
    schemaVersion: "moodrank-model-selection-result-v1",
    decisionId: manifest.decisionId,
    evidenceStage: manifest.evidenceStage,
    referenceConfigurationId: manifest.referenceConfigurationId,
    incumbentConfigurationId: manifest.incumbentConfigurationId ?? null,
    comparisonContract: manifest.comparisonContract,
    configurations: gated,
    paretoFrontierConfigurationIds: frontierIds,
    productionPromotionCandidateIds: promotionCandidates.map((entry) => entry.id),
    recommendedConfigurationId,
    decisionReasons
  };
}

function evaluateConfiguration(
  manifest: ModelSelectionManifest,
  configuration: ModelSelectionConfiguration,
  rawReport: unknown
): ModelSelectionConfigurationResult {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (!rawReport || typeof rawReport !== "object" || Array.isArray(rawReport)) {
    return emptyConfigurationResult(configuration, ["report_missing_or_invalid"]);
  }
  const report = rawReport as ProductReportWithContracts;
  const expected = manifest.comparisonContract;
  compare(reasons, report.schemaVersion, "moodrank-product-eval-report-v2", "report_schema_mismatch");
  compare(reasons, report.evaluationStages?.aiRerankedStrict, "search_service_final_response", "strict_evaluation_stage_missing");
  compare(reasons, report.corpusId, expected.corpusId, "corpus_mismatch");
  compare(reasons, report.judgmentVersion, expected.judgmentVersion, "judgment_version_mismatch");
  compare(reasons, report.catalogSnapshotId, expected.catalogSnapshotId, "catalog_snapshot_mismatch");
  compare(reasons, report.evaluatedCases, expected.evaluatedCases, "evaluated_case_count_mismatch");
  compare(reasons, report.provenance?.engineVersion, expected.engineVersion, "engine_version_mismatch");
  compare(reasons, report.provenance?.sourceCommit, expected.sourceCommit, "source_commit_mismatch");
  compare(reasons, report.provenance?.sourceTreeSha256, expected.sourceTreeSha256, "source_tree_mismatch");
  compare(reasons, report.provenance?.contentHashes?.cases, expected.casesSha256, "cases_hash_mismatch");
  compare(reasons, report.provenance?.contentHashes?.judgments, expected.judgmentsSha256, "judgments_hash_mismatch");
  compare(reasons, report.provenance?.contentHashes?.catalog, expected.catalogSha256, "catalog_hash_mismatch");
  compare(reasons, report.provenance?.seed, expected.seed, "seed_mismatch");
  compare(reasons, report.provenance?.bootstrapSamples, expected.bootstrapSamples, "bootstrap_samples_mismatch");
  compare(reasons, report.provenance?.inferencePolicy?.aiRunsPerCase, expected.aiRunsPerCase, "ai_runs_per_case_mismatch");
  compareContract(reasons, report.provenance?.contracts?.prompt, expected.prompt, "prompt_contract");
  compareContract(reasons, report.provenance?.contracts?.response, expected.response, "response_contract");
  compareContract(reasons, report.provenance?.contracts?.evaluation, expected.evaluation, "evaluation_contract");
  compare(reasons, report.provenance?.model, configuration.expected.model, "model_mismatch");
  compare(reasons, report.provenance?.reasoningEffort, configuration.expected.reasoningEffort, "reasoning_effort_mismatch");
  compare(reasons, report.provenance?.requestedServiceTier, configuration.expected.requestedServiceTier, "requested_service_tier_mismatch");
  compare(reasons, report.provenance?.timingPolicy?.rankerTimeoutMs, configuration.expected.rankerTimeoutMs, "ranker_timeout_mismatch");
  compare(
    reasons,
    report.provenance?.executionPolicy?.rankerMaxOutputTokens,
    configuration.expected.rankerMaxOutputTokens,
    "ranker_max_output_tokens_mismatch"
  );
  compare(reasons, report.provenance?.timingPolicy?.diagnosticOnly, configuration.expected.diagnosticOnly, "diagnostic_policy_mismatch");
  compare(reasons, report.provenance?.executionMode, "external", "execution_mode_not_external");
  compare(reasons, report.provenance?.provider, "openai", "provider_not_openai");

  const completeness = report.aiRerankCompleteness;
  if (!completeness) {
    reasons.push("ai_completeness_missing");
  } else {
    if (completeness.casesRequested !== report.evaluatedCases) reasons.push("ai_request_count_mismatch");
    if (completeness.externalRequestCount !== report.evaluatedCases) reasons.push("external_request_count_mismatch");
    if (completeness.casesUsedAi !== report.evaluatedCases) reasons.push("not_all_cases_used_ai");
    if (completeness.casesFallback !== 0) reasons.push("fallback_observed");
    if (completeness.casesCompleteForResponseComparison !== report.evaluatedCases) reasons.push("incomplete_final_response_ai_coverage");
    if (completeness.serializedCandidateCount <= 0 || completeness.aiRankedCandidateCount !== completeness.serializedCandidateCount) {
      reasons.push("incomplete_serialized_candidate_ai_coverage");
    }
    const details = report.details ?? [];
    if (details.length !== report.evaluatedCases || details.some((detail) => {
      const rerank = detail.aiAssisted?.rerank;
      return !rerank
        || rerank.serializedCandidateCount !== Math.min(rerank.offeredCandidateCount, openAiRankerSerializedCandidateLimit)
        || rerank.aiRankedCandidateCount !== rerank.serializedCandidateCount
        || !rerank.serializedPayloadComplete;
    })) reasons.push("incomplete_serialized_candidate_window");
    if (!completeness.serviceTierReadbackVerified) reasons.push("service_tier_readback_not_verified");
    const expectedReceivedTier = configuration.expected.requestedServiceTier === "fast" ? "priority" : "default";
    const receivedTiers = completeness.receivedServiceTiers ?? {};
    if (Object.keys(receivedTiers).length !== 1 || receivedTiers[expectedReceivedTier] !== report.evaluatedCases) {
      reasons.push("received_service_tier_mismatch");
    }
    if (Object.values(completeness.failureCategories ?? {}).some((count) => count !== 0)) reasons.push("provider_failure_observed");
  }

  const metrics = extractMetrics(report, configuration);
  if (metrics.ndcgAt3 === null || metrics.ndcgAt10 === null) reasons.push("ranking_quality_metrics_missing");
  const caseNdcgAt10 = caseNdcgAt10ById(report);
  if (!caseNdcgAt10 || caseNdcgAt10.size !== report.evaluatedCases || metrics.ndcgAt10 === null) {
    reasons.push("case_ndcg_at_10_evidence_missing");
  } else {
    const caseMean = [...caseNdcgAt10.values()].reduce((total, value) => total + value, 0) / caseNdcgAt10.size;
    if (Math.abs(caseMean - metrics.ndcgAt10) > 0.000001) reasons.push("case_ndcg_at_10_aggregate_mismatch");
  }
  if (metrics.familyHitAt3 === null || metrics.familyHitAt10 === null) reasons.push("family_hit_metrics_missing");
  if (!metrics.productLatencyMs) reasons.push("product_latency_missing");
  if (metrics.cost.totalUsd === null) reasons.push("complete_provider_usage_missing");
  if (report.status !== "completed") {
    if (manifest.evidenceStage === "production" && configuration.role !== "quality_reference") reasons.push("report_not_completed");
    else warnings.push("diagnostic_screening_report_not_provider_evidence_complete");
  }
  if (report.provenance?.sourceDirty !== false) reasons.push("source_not_clean");

  const productionReasons = [...reasons];
  if (manifest.evidenceStage !== "production") productionReasons.push("screening_evidence_not_production_evidence");
  if (report.provenance?.providerEvidenceEligible !== true) productionReasons.push("provider_evidence_ineligible");
  if (report.provenance?.timingPolicy?.diagnosticOnly !== false) productionReasons.push("diagnostic_timing_policy_ineligible");
  const timingPolicy = report.provenance?.timingPolicy;
  const aiFirstCases = timingPolicy?.aiFirstCases;
  const deterministicFirstCases = timingPolicy?.deterministicFirstCases;
  if (
    timingPolicy?.armOrder !== "seeded_balanced"
    || typeof aiFirstCases !== "number"
    || typeof deterministicFirstCases !== "number"
    || !Number.isSafeInteger(aiFirstCases)
    || !Number.isSafeInteger(deterministicFirstCases)
    || aiFirstCases + deterministicFirstCases !== report.evaluatedCases
    || Math.abs(aiFirstCases - deterministicFirstCases) > 1
  ) productionReasons.push("production_arm_order_not_seeded_balanced");

  return {
    id: configuration.id,
    role: configuration.role,
    model: configuration.expected.model,
    reasoningEffort: configuration.expected.reasoningEffort,
    requestedServiceTier: configuration.expected.requestedServiceTier,
    rankerMaxOutputTokens: configuration.expected.rankerMaxOutputTokens,
    comparisonEligible: reasons.length === 0,
    productionPromotionEligible: productionReasons.length === 0,
    comparisonRejectionReasons: uniqueSorted(reasons),
    productionRejectionReasons: uniqueSorted(productionReasons),
    warnings: uniqueSorted(warnings),
    metrics,
    relativeToReference: null,
    relativeToIncumbent: null,
    pareto: { onFrontier: false, dominatedBy: [] }
  };
}

function applyPromotionGates(
  manifest: ModelSelectionManifest,
  entry: ModelSelectionConfigurationResult,
  reference: ModelSelectionConfigurationResult,
  incumbent: ModelSelectionConfigurationResult | null
): ModelSelectionConfigurationResult {
  const reasons = [...entry.productionRejectionReasons];
  const gates = manifest.promotionGates;
  if (!gates) return { ...entry, productionPromotionEligible: false, productionRejectionReasons: uniqueSorted([...reasons, "promotion_gates_missing"]) };
  if (!reference.productionPromotionEligible) reasons.push("quality_reference_not_production_eligible");
  if (incumbent && !incumbent.productionPromotionEligible) reasons.push("incumbent_not_production_eligible");
  const metrics = entry.metrics;
  if (gates.minimumCases !== undefined && metrics.completeness.casesRequested < gates.minimumCases) reasons.push("minimum_case_count_not_met");
  if (gates.maximumProductP95Ms !== undefined && !atMost(metrics.productLatencyMs?.p95, gates.maximumProductP95Ms)) reasons.push("maximum_product_p95_latency_exceeded");
  if (gates.maximumProviderP95Ms !== undefined && !atMost(metrics.providerLatencyMs?.p95, gates.maximumProviderP95Ms)) reasons.push("maximum_provider_p95_latency_exceeded_or_missing");
  if (gates.maximumCostPerCaseUsd !== undefined && !atMost(metrics.cost.perCaseUsd, gates.maximumCostPerCaseUsd)) reasons.push("maximum_cost_per_case_exceeded_or_missing");
  if (gates.minimumNdcgAt3 !== undefined && !atLeast(metrics.ndcgAt3, gates.minimumNdcgAt3)) reasons.push("minimum_ndcg_at_3_not_met");
  if (gates.minimumNdcgAt10 !== undefined && !atLeast(metrics.ndcgAt10, gates.minimumNdcgAt10)) reasons.push("minimum_ndcg_at_10_not_met");
  if (gates.minimumFamilyHitAt10 !== undefined && !atLeast(metrics.familyHitAt10, gates.minimumFamilyHitAt10)) reasons.push("minimum_family_hit_at_10_not_met");
  if (gates.minimumNdcgAt10RatioOfReference !== undefined) {
    const ratio = relativeMetrics(metrics, reference.metrics).ndcgAt10Ratio;
    if (!atLeast(ratio, gates.minimumNdcgAt10RatioOfReference)) reasons.push("minimum_reference_quality_ratio_not_met");
  }
  if (gates.minimumNdcgAt10DeltaVsIncumbent !== undefined) {
    const incumbentNdcgAt10 = incumbent?.metrics.ndcgAt10 ?? null;
    const delta = incumbentNdcgAt10 !== null && metrics.ndcgAt10 !== null
      ? metrics.ndcgAt10 - incumbentNdcgAt10
      : null;
    if (!atLeast(delta, gates.minimumNdcgAt10DeltaVsIncumbent)) reasons.push("minimum_incumbent_quality_delta_not_met");
  }
  if (gates.minimumNdcgAt10DeltaVsReferenceLower95 !== undefined) {
    const lower = entry.relativeToReference?.ndcgAt10PairedDelta?.ci95?.lower;
    if (!atLeast(lower, gates.minimumNdcgAt10DeltaVsReferenceLower95)) {
      reasons.push("minimum_reference_quality_delta_lower_95_not_met_or_missing");
    }
  }
  if (gates.minimumNdcgAt10DeltaVsIncumbentLower95 !== undefined) {
    const lower = entry.relativeToIncumbent?.ndcgAt10PairedDelta?.ci95?.lower;
    if (!atLeast(lower, gates.minimumNdcgAt10DeltaVsIncumbentLower95)) {
      reasons.push("minimum_incumbent_quality_delta_lower_95_not_met_or_missing");
    }
  }
  if (gates.requireParetoFrontier && !entry.pareto.onFrontier) reasons.push("not_on_pareto_frontier");
  return {
    ...entry,
    productionPromotionEligible: reasons.length === 0,
    productionRejectionReasons: uniqueSorted(reasons)
  };
}

function extractMetrics(report: ProductReportWithContracts, configuration: ModelSelectionConfiguration): ModelSelectionMetricSet {
  const completeness = report.aiRerankCompleteness;
  const strictMetrics = report.metrics?.allCases?.aiRerankedStrict ?? null;
  const requested = finiteInteger(completeness?.casesRequested);
  const serialized = finiteInteger(completeness?.serializedCandidateCount);
  const ranked = finiteInteger(completeness?.aiRankedCandidateCount);
  const usage = completeness?.providerUsage;
  const usageComplete = usage
    && requested > 0
    && usage.responsesWithUsage === requested
    && finiteNonNegative(usage.inputTokens)
    && finiteNonNegative(usage.cachedInputTokens)
    && usage.cachedInputTokens <= usage.inputTokens
    && finiteNonNegative(usage.outputTokens);
  const totalCost = usageComplete ? roundCost(
    (((usage.inputTokens - usage.cachedInputTokens) * configuration.pricing.inputUsdPerMillion)
      + (usage.cachedInputTokens * configuration.pricing.cachedInputUsdPerMillion)
      + (usage.outputTokens * configuration.pricing.outputUsdPerMillion))
      * configuration.pricing.serviceTierMultiplier / 1_000_000
  ) : null;
  const providerLatencies = report.details?.flatMap((detail) => {
    const latency = detail.aiAssisted.providerDiagnostics?.providerLatencyMs;
    return typeof latency === "number" && Number.isFinite(latency) && latency >= 0 ? [latency] : [];
  }) ?? [];
  const productLatencies = report.details?.flatMap((detail) => {
    const latency = detail.aiAssisted.responseLatencyMs;
    return typeof latency === "number" && Number.isFinite(latency) && latency >= 0 ? [latency] : [];
  }) ?? [];
  return {
    ndcgAt3: ratioMetricValue(strictMetrics?.ndcgAt3?.value),
    ndcgAt10: ratioMetricValue(strictMetrics?.ndcgAt10?.value),
    familyHitAt3: ratioMetricValue(strictMetrics?.acceptableFamilyHitAt3?.value),
    familyHitAt10: ratioMetricValue(strictMetrics?.acceptableFamilyHitAt10?.value),
    productLatencyMs: productLatencies.length === requested && requested > 0 ? timingSummary(productLatencies) : null,
    providerLatencyMs: providerLatencies.length === requested && requested > 0 ? timingSummary(providerLatencies) : null,
    completeness: {
      casesRequested: requested,
      casesUsedAi: finiteInteger(completeness?.casesUsedAi),
      casesFallback: finiteInteger(completeness?.casesFallback),
      casesComplete: finiteInteger(completeness?.casesCompleteForResponseComparison),
      serializedCandidates: serialized,
      aiRankedCandidates: ranked,
      ratio: serialized > 0 ? roundMetric(ranked / serialized) : 0
    },
    cost: {
      totalUsd: totalCost,
      perCaseUsd: totalCost !== null && requested > 0 ? roundCost(totalCost / requested) : null,
      responsesWithUsage: finiteInteger(usage?.responsesWithUsage)
    }
  };
}

function dominates(left: ModelSelectionMetricSet, right: ModelSelectionMetricSet) {
  const leftValues = paretoValues(left);
  const rightValues = paretoValues(right);
  if (!leftValues || !rightValues) return false;
  const noWorse = leftValues.ndcgAt10 >= rightValues.ndcgAt10
    && leftValues.familyHitAt10 >= rightValues.familyHitAt10
    && leftValues.productP95 <= rightValues.productP95
    && leftValues.costPerCase <= rightValues.costPerCase;
  const strictlyBetter = leftValues.ndcgAt10 > rightValues.ndcgAt10
    || leftValues.familyHitAt10 > rightValues.familyHitAt10
    || leftValues.productP95 < rightValues.productP95
    || leftValues.costPerCase < rightValues.costPerCase;
  return noWorse && strictlyBetter;
}

function paretoValues(metrics: ModelSelectionMetricSet) {
  if (metrics.ndcgAt10 === null || metrics.familyHitAt10 === null || !metrics.productLatencyMs || metrics.cost.perCaseUsd === null) return null;
  return {
    ndcgAt10: metrics.ndcgAt10,
    familyHitAt10: metrics.familyHitAt10,
    productP95: metrics.productLatencyMs.p95,
    costPerCase: metrics.cost.perCaseUsd
  };
}

function relativeMetrics(metrics: ModelSelectionMetricSet, reference: ModelSelectionMetricSet) {
  return {
    ndcgAt10Delta: metrics.ndcgAt10 !== null && reference.ndcgAt10 !== null
      ? roundMetric(metrics.ndcgAt10 - reference.ndcgAt10) : null,
    ndcgAt10Ratio: metrics.ndcgAt10 !== null && reference.ndcgAt10 !== null && reference.ndcgAt10 > 0
      ? roundMetric(metrics.ndcgAt10 / reference.ndcgAt10) : null,
    productP95Speedup: metrics.productLatencyMs && reference.productLatencyMs && metrics.productLatencyMs.p95 > 0
      ? roundMetric(reference.productLatencyMs.p95 / metrics.productLatencyMs.p95) : null,
    costRatio: metrics.cost.perCaseUsd !== null && reference.cost.perCaseUsd !== null && reference.cost.perCaseUsd > 0
      ? roundMetric(metrics.cost.perCaseUsd / reference.cost.perCaseUsd) : null
  };
}

function pairedNdcgAt10Delta(
  rawConfigurationReport: unknown,
  rawBaselineReport: unknown,
  seed: number,
  bootstrapSamples: number
): PairedQualityDelta | null {
  const configuration = caseNdcgAt10ById(rawConfigurationReport);
  const baseline = caseNdcgAt10ById(rawBaselineReport);
  if (!configuration || !baseline || configuration.size !== baseline.size || configuration.size === 0) return null;
  const caseIds = [...configuration.keys()].sort();
  if (caseIds.some((caseId) => !baseline.has(caseId))) return null;
  const deltas = caseIds.map((caseId) => configuration.get(caseId)! - baseline.get(caseId)!);
  const meanDelta = roundMetric(deltas.reduce((total, value) => total + value, 0) / deltas.length);
  const ci95 = deltas.length < 2 ? null : bootstrapMeanInterval(deltas, seed, bootstrapSamples);
  return {
    wins: deltas.filter((value) => value > 0).length,
    losses: deltas.filter((value) => value < 0).length,
    ties: deltas.filter((value) => value === 0).length,
    contributingCases: deltas.length,
    meanDelta,
    ci95
  };
}

function caseNdcgAt10ById(rawReport: unknown) {
  if (!rawReport || typeof rawReport !== "object" || Array.isArray(rawReport)) return null;
  const details = (rawReport as { details?: unknown }).details;
  if (!Array.isArray(details)) return null;
  const values = new Map<string, number>();
  for (const detail of details) {
    if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
    const caseId = (detail as { caseId?: unknown }).caseId;
    const ndcgAt10 = (detail as { aiAssisted?: { metrics?: { ndcgAt10?: unknown } } }).aiAssisted?.metrics?.ndcgAt10;
    if (typeof caseId !== "string" || caseId.length === 0 || values.has(caseId) || !finiteNonNegative(ndcgAt10) || ndcgAt10 > 1) {
      return null;
    }
    values.set(caseId, ndcgAt10);
  }
  return values;
}

function bootstrapMeanInterval(values: number[], seed: number, samples: number) {
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
    lower: roundMetric(percentile(means, 0.025)),
    upper: roundMetric(percentile(means, 0.975))
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

function compareBySelectionOrder(
  left: ModelSelectionConfigurationResult,
  right: ModelSelectionConfigurationResult,
  order: SelectionOrderKey[]
) {
  for (const key of order) {
    const leftValue = selectionValue(left.metrics, key);
    const rightValue = selectionValue(right.metrics, key);
    if (leftValue === rightValue) continue;
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    return key.endsWith("_desc") ? rightValue - leftValue : leftValue - rightValue;
  }
  return left.id.localeCompare(right.id);
}

function selectionValue(metrics: ModelSelectionMetricSet, key: SelectionOrderKey) {
  switch (key) {
    case "ndcgAt10_desc": return metrics.ndcgAt10;
    case "ndcgAt3_desc": return metrics.ndcgAt3;
    case "familyHitAt10_desc": return metrics.familyHitAt10;
    case "productP95Ms_asc": return metrics.productLatencyMs?.p95 ?? null;
    case "providerP95Ms_asc": return metrics.providerLatencyMs?.p95 ?? null;
    case "costPerCaseUsd_asc": return metrics.cost.perCaseUsd;
  }
}

function emptyConfigurationResult(configuration: ModelSelectionConfiguration, reasons: string[]): ModelSelectionConfigurationResult {
  return {
    id: configuration.id,
    role: configuration.role,
    model: configuration.expected.model,
    reasoningEffort: configuration.expected.reasoningEffort,
    requestedServiceTier: configuration.expected.requestedServiceTier,
    rankerMaxOutputTokens: configuration.expected.rankerMaxOutputTokens,
    comparisonEligible: false,
    productionPromotionEligible: false,
    comparisonRejectionReasons: reasons,
    productionRejectionReasons: reasons,
    warnings: [],
    metrics: {
      ndcgAt3: null,
      ndcgAt10: null,
      familyHitAt3: null,
      familyHitAt10: null,
      productLatencyMs: null,
      providerLatencyMs: null,
      completeness: { casesRequested: 0, casesUsedAi: 0, casesFallback: 0, casesComplete: 0, serializedCandidates: 0, aiRankedCandidates: 0, ratio: 0 },
      cost: { totalUsd: null, perCaseUsd: null, responsesWithUsage: 0 }
    },
    relativeToReference: null,
    relativeToIncumbent: null,
    pareto: { onFrontier: false, dominatedBy: [] }
  };
}

function parseConfiguration(value: unknown, index: number): ModelSelectionConfiguration {
  const entry = requireRecord(value, `configuration_${index}_not_object`);
  const expected = requireRecord(entry.expected, `configuration_${index}_expected_missing`);
  const pricing = requireRecord(entry.pricing, `configuration_${index}_pricing_missing`);
  return {
    id: requireText(entry.id, `configuration_${index}_id_missing`),
    role: requireEnum(entry.role, ["quality_reference", "incumbent", "challenger"], `configuration_${index}_role_invalid`),
    reportPath: requireText(entry.reportPath, `configuration_${index}_report_path_missing`),
    expected: {
      model: requireText(expected.model, `configuration_${index}_model_missing`),
      reasoningEffort: requireText(expected.reasoningEffort, `configuration_${index}_reasoning_effort_missing`),
      requestedServiceTier: requireEnum(expected.requestedServiceTier, ["default", "fast"], `configuration_${index}_service_tier_invalid`),
      rankerTimeoutMs: expected.rankerTimeoutMs === null
        ? null
        : requirePositive(expected.rankerTimeoutMs, `configuration_${index}_ranker_timeout_invalid`),
      rankerMaxOutputTokens: requirePositiveInteger(
        expected.rankerMaxOutputTokens,
        `configuration_${index}_ranker_max_output_tokens_invalid`
      ),
      diagnosticOnly: requireBoolean(expected.diagnosticOnly, `configuration_${index}_diagnostic_policy_invalid`)
    },
    pricing: {
      inputUsdPerMillion: requireNonNegative(pricing.inputUsdPerMillion, `configuration_${index}_input_price_invalid`),
      cachedInputUsdPerMillion: requireNonNegative(pricing.cachedInputUsdPerMillion, `configuration_${index}_cached_input_price_invalid`),
      outputUsdPerMillion: requireNonNegative(pricing.outputUsdPerMillion, `configuration_${index}_output_price_invalid`),
      serviceTierMultiplier: requirePositive(pricing.serviceTierMultiplier, `configuration_${index}_tier_multiplier_invalid`)
    }
  };
}

function parsePromotionGates(value: unknown): NonNullable<ModelSelectionManifest["promotionGates"]> {
  const gates = requireRecord(value, "promotion_gates_not_object");
  return {
    ...(gates.minimumCases !== undefined ? { minimumCases: requirePositiveInteger(gates.minimumCases, "invalid_minimum_cases") } : {}),
    ...(gates.maximumProductP95Ms !== undefined ? { maximumProductP95Ms: requirePositive(gates.maximumProductP95Ms, "invalid_maximum_product_p95") } : {}),
    ...(gates.maximumProviderP95Ms !== undefined ? { maximumProviderP95Ms: requirePositive(gates.maximumProviderP95Ms, "invalid_maximum_provider_p95") } : {}),
    ...(gates.maximumCostPerCaseUsd !== undefined ? { maximumCostPerCaseUsd: requireNonNegative(gates.maximumCostPerCaseUsd, "invalid_maximum_cost_per_case") } : {}),
    ...(gates.minimumNdcgAt3 !== undefined ? { minimumNdcgAt3: requireRatio(gates.minimumNdcgAt3, "invalid_minimum_ndcg_at_3") } : {}),
    ...(gates.minimumNdcgAt10 !== undefined ? { minimumNdcgAt10: requireRatio(gates.minimumNdcgAt10, "invalid_minimum_ndcg_at_10") } : {}),
    ...(gates.minimumFamilyHitAt10 !== undefined ? { minimumFamilyHitAt10: requireRatio(gates.minimumFamilyHitAt10, "invalid_minimum_family_hit_at_10") } : {}),
    ...(gates.minimumNdcgAt10RatioOfReference !== undefined ? { minimumNdcgAt10RatioOfReference: requireRatio(gates.minimumNdcgAt10RatioOfReference, "invalid_reference_quality_ratio") } : {}),
    ...(gates.minimumNdcgAt10DeltaVsIncumbent !== undefined ? { minimumNdcgAt10DeltaVsIncumbent: requireFinite(gates.minimumNdcgAt10DeltaVsIncumbent, "invalid_incumbent_quality_delta") } : {}),
    ...(gates.minimumNdcgAt10DeltaVsReferenceLower95 !== undefined ? { minimumNdcgAt10DeltaVsReferenceLower95: requireFinite(gates.minimumNdcgAt10DeltaVsReferenceLower95, "invalid_reference_quality_delta_lower_95") } : {}),
    ...(gates.minimumNdcgAt10DeltaVsIncumbentLower95 !== undefined ? { minimumNdcgAt10DeltaVsIncumbentLower95: requireFinite(gates.minimumNdcgAt10DeltaVsIncumbentLower95, "invalid_incumbent_quality_delta_lower_95") } : {}),
    ...(gates.requireParetoFrontier !== undefined ? { requireParetoFrontier: requireBoolean(gates.requireParetoFrontier, "invalid_require_pareto_frontier") } : {})
  };
}

function parseSelectionOrder(value: unknown): SelectionOrderKey[] {
  if (!Array.isArray(value) || value.length === 0) fail("selection_order_must_be_nonempty_array");
  const allowed: SelectionOrderKey[] = [
    "ndcgAt10_desc", "ndcgAt3_desc", "familyHitAt10_desc", "productP95Ms_asc", "providerP95Ms_asc", "costPerCaseUsd_asc"
  ];
  const result = value.map((entry) => requireEnum(entry, allowed, "invalid_selection_order_key"));
  if (new Set(result).size !== result.length) fail("duplicate_selection_order_key");
  return result;
}

function parseNamedContract(value: unknown, name: string) {
  const contract = requireRecord(value, `${name}_contract_missing`);
  return {
    id: requireText(contract.id, `${name}_contract_id_missing`),
    sha256: requireSha256(contract.sha256, `invalid_${name}_contract_hash`)
  };
}

function compareContract(reasons: string[], actual: { id?: string; sha256?: string } | undefined, expected: { id: string; sha256: string }, name: string) {
  if (!actual) {
    reasons.push(`${name}_metadata_missing`);
    return;
  }
  compare(reasons, actual.id, expected.id, `${name}_id_mismatch`);
  compare(reasons, actual.sha256, expected.sha256, `${name}_hash_mismatch`);
}

function compare(reasons: string[], actual: unknown, expected: unknown, reason: string) {
  if (actual !== expected) reasons.push(reason);
}

function timingSummary(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return { p50: percentile(sorted, 0.5), p95: percentile(sorted, 0.95) };
}

function percentile(sorted: number[], quantile: number) {
  const position = (sorted.length - 1) * quantile;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (position - lower);
}

function ratioMetricValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

function atMost(value: number | null | undefined, maximum: number) {
  return typeof value === "number" && value <= maximum;
}

function atLeast(value: number | null | undefined, minimum: number) {
  return typeof value === "number" && value >= minimum;
}

function finiteInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function requireRecord(value: unknown, code: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(code);
  return value as Record<string, any>;
}

function requireText(value: unknown, code: string) {
  if (typeof value !== "string" || value.trim().length === 0) fail(code);
  return value;
}

function optionalText(value: unknown, code: string) {
  if (value === undefined) return undefined;
  return requireText(value, code);
}

function requireSha256(value: unknown, code: string) {
  const text = requireText(value, code);
  if (!sha256Pattern.test(text)) fail(code);
  return text;
}

function requireEnum<T extends string>(value: unknown, allowed: readonly T[], code: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) fail(code);
  return value as T;
}

function requirePositiveInteger(value: unknown, code: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) fail(code);
  return value;
}

function requireNonNegativeInteger(value: unknown, code: string) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail(code);
  return value;
}

function requireFinite(value: unknown, code: string) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(code);
  return value;
}

function requireNonNegative(value: unknown, code: string) {
  const number = requireFinite(value, code);
  if (number < 0) fail(code);
  return number;
}

function requirePositive(value: unknown, code: string) {
  const number = requireFinite(value, code);
  if (number <= 0) fail(code);
  return number;
}

function requireRatio(value: unknown, code: string) {
  const number = requireFinite(value, code);
  if (number < 0 || number > 1) fail(code);
  return number;
}

function requireBoolean(value: unknown, code: string) {
  if (typeof value !== "boolean") fail(code);
  return value;
}

function uniqueSorted(values: string[]) {
  return [...new Set(values)].sort();
}

function roundMetric(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function roundCost(value: number) {
  return Math.round(value * 100_000_000) / 100_000_000;
}

function fail(code: string): never {
  throw new ModelSelectionContractError(code);
}
