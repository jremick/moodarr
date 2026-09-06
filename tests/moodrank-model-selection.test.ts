import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ModelSelectionContractError,
  evaluateModelSelection,
  parseModelSelectionManifest,
  type ModelSelectionManifest
} from "../scripts/moodrank-model-selection-contract";
import {
  parseModelSelectionCliArgs,
  runModelSelectionCli
} from "../scripts/evaluate-moodrank-model-selection";

const sha = (digit: string) => `sha256:${digit.repeat(64)}`;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("MoodRank model-selection contract", () => {
  it("validates a data-defined matrix and explicit production policy", () => {
    expect(parseModelSelectionManifest(manifest())).toMatchObject({
      evidenceStage: "production",
      referenceConfigurationId: "sol-xhigh-reference",
      incumbentConfigurationId: "gpt-5.5-incumbent",
      comparisonContract: { rankerMaxOutputTokens: 2_400, rankerResponseMode: "evaluation_score_only" },
      configurations: [
        { id: "sol-xhigh-reference", expected: { rankerMaxOutputTokens: 2_400 } },
        { id: "gpt-5.5-incumbent", expected: { rankerMaxOutputTokens: 2_400 } },
        { id: "luna-medium-fast", expected: { rankerMaxOutputTokens: 2_400 } }
      ]
    });
    expect(() => parseModelSelectionManifest({ ...manifest(), promotionGates: undefined }))
      .toThrowError(new ModelSelectionContractError("production_promotion_gates_required"));
    expect(() => parseModelSelectionManifest({
      ...manifest(),
      comparisonContract: { ...manifest().comparisonContract, evaluatedCases: 30 },
      promotionGates: { ...manifest().promotionGates, minimumCases: 30 }
    })).toThrow(/production_requires_100_unique_cases/);
    const gatesWithoutReferenceConfidence = { ...manifest().promotionGates };
    delete gatesWithoutReferenceConfidence.minimumNdcgAt10DeltaVsReferenceLower95;
    expect(() => parseModelSelectionManifest({ ...manifest(), promotionGates: gatesWithoutReferenceConfidence }))
      .toThrow(/production_reference_confidence_gate_required/);
    expect(() => parseModelSelectionManifest({
      ...manifest(),
      configurations: [manifest().configurations[0], manifest().configurations[0]]
    })).toThrow(/duplicate_configuration_id/);
    expect(() => parseModelSelectionManifest({ ...manifest(), referenceConfigurationId: "missing" }))
      .toThrow(/reference_configuration_not_found/);
    const missingComparisonBudget: any = structuredClone(manifest());
    delete missingComparisonBudget.comparisonContract.rankerMaxOutputTokens;
    expect(() => parseModelSelectionManifest(missingComparisonBudget))
      .toThrow(/invalid_comparison_ranker_max_output_tokens/);
    const missingConfigurationBudget: any = structuredClone(manifest());
    delete missingConfigurationBudget.configurations[2].expected.rankerMaxOutputTokens;
    expect(() => parseModelSelectionManifest(missingConfigurationBudget))
      .toThrow(/configuration_2_ranker_max_output_tokens_invalid/);
    const driftedConfigurationBudget: any = structuredClone(manifest());
    driftedConfigurationBudget.configurations[2].expected.rankerMaxOutputTokens = 8_192;
    expect(() => parseModelSelectionManifest(driftedConfigurationBudget))
      .toThrow(/configuration_ranker_max_output_tokens_mismatch_comparison_contract/);
    const diagnosticBudgetAtProductionStage: any = structuredClone(manifest());
    diagnosticBudgetAtProductionStage.comparisonContract.rankerMaxOutputTokens = 4_096;
    for (const configuration of diagnosticBudgetAtProductionStage.configurations) {
      configuration.expected.rankerMaxOutputTokens = 4_096;
    }
    expect(() => parseModelSelectionManifest(diagnosticBudgetAtProductionStage))
      .toThrow(/production_requires_default_ranker_max_output_tokens/);
    const wrongResponseMode: any = structuredClone(manifest());
    wrongResponseMode.comparisonContract.rankerResponseMode = "production";
    expect(() => parseModelSelectionManifest(wrongResponseMode))
      .toThrow(/model_selection_requires_evaluation_score_only_response_mode/);
    const missingResponseMode: any = structuredClone(manifest());
    delete missingResponseMode.comparisonContract.rankerResponseMode;
    expect(() => parseModelSelectionManifest(missingResponseMode))
      .toThrow(/model_selection_requires_evaluation_score_only_response_mode/);
  });

  it("selects a strict challenger using declared gates and ordering", () => {
    const input = manifest();
    const result = evaluateModelSelection(input, {
      "sol-xhigh-reference": report({ model: "gpt-5.6-sol", effort: "xhigh", tier: "fast", ndcg10: 0.5, ndcg3: 0.45, family10: 0.8, p50: 18_000, p95: 21_000, inputTokens: 50_000, outputTokens: 20_000 }),
      "gpt-5.5-incumbent": report({ model: "gpt-5.5", effort: "low", tier: "default", ndcg10: 0.25, ndcg3: 0.2, family10: 0.5, p50: 25_000, p95: 30_000, inputTokens: 60_000, outputTokens: 20_000 }),
      "luna-medium-fast": report({ model: "gpt-5.6-luna", effort: "medium", tier: "fast", ndcg10: 0.48, ndcg3: 0.4, family10: 0.8, p50: 4_000, p95: 5_000, inputTokens: 45_000, outputTokens: 15_000 })
    }, productionAcceptanceReport());

    const luna = result.configurations.find((entry) => entry.id === "luna-medium-fast")!;
    expect(luna).toMatchObject({
      comparisonEligible: true,
      modelSelectionEligible: true,
      productionPromotionEligible: true,
      metrics: {
        ndcgAt10: 0.48,
        productLatencyMs: { p50: 4_000, p95: 5_000 },
        providerLatencyMs: { p50: 4_000, p95: 4_900 },
        completeness: { ratio: 1 },
        cost: { totalUsd: 0.054, perCaseUsd: 0.00054 }
      },
      relativeToReference: {
        ndcgAt10Delta: -0.02,
        ndcgAt10Ratio: 0.96,
        productP95Speedup: 4.2,
        ndcgAt10PairedDelta: {
          wins: 0,
          losses: 100,
          ties: 0,
          contributingCases: 100,
          meanDelta: -0.02,
          ci95: { lower: -0.02, upper: -0.02 }
        }
      },
      relativeToIncumbent: {
        ndcgAt10Delta: 0.23,
        ndcgAt10PairedDelta: { meanDelta: 0.23, ci95: { lower: 0.23, upper: 0.23 } }
      },
      pareto: { onFrontier: true }
    });
    expect(result.paretoFrontierConfigurationIds).toEqual(["luna-medium-fast", "sol-xhigh-reference"]);
    expect(result.modelSelectionWinnerId).toBe("luna-medium-fast");
    expect(result.productionAcceptance).toMatchObject({ configurationId: "luna-medium-fast", eligible: true });
    expect(result.productionPromotionCandidateIds).toEqual(["luna-medium-fast"]);
    expect(result.recommendedConfigurationId).toBe("luna-medium-fast");
  });

  it("selects a model winner without recommending production until acceptance exists", () => {
    const result = evaluateModelSelection(manifest(), validReports());

    expect(result.modelSelectionWinnerId).toBe("luna-medium-fast");
    expect(result.modelSelectionCandidateIds).toEqual(["luna-medium-fast"]);
    expect(result.productionAcceptance).toMatchObject({
      configurationId: "luna-medium-fast",
      eligible: false,
      rejectionReasons: ["production_acceptance_report_missing_or_invalid"]
    });
    expect(result.productionPromotionCandidateIds).toEqual([]);
    expect(result.recommendedConfigurationId).toBeNull();
    expect(result.decisionReasons).toContain("production_acceptance_failed");
  });

  it.each([
    ["evaluation response mode", (value: any) => { value.provenance.executionPolicy.rankerResponseMode = "evaluation_score_only"; }, "production_acceptance_response_mode_mismatch"],
    ["model", (value: any) => { value.provenance.model = "gpt-5.6-terra"; }, "production_acceptance_model_mismatch"],
    ["effort", (value: any) => { value.provenance.reasoningEffort = "low"; }, "production_acceptance_reasoning_effort_mismatch"],
    ["tier", (value: any) => { value.provenance.requestedServiceTier = "default"; }, "production_acceptance_service_tier_mismatch"],
    ["timeout", (value: any) => { value.provenance.timingPolicy.rankerTimeoutMs = 12_000; }, "production_acceptance_ranker_timeout_mismatch"],
    ["output budget", (value: any) => { value.provenance.executionPolicy.rankerMaxOutputTokens = 4_800; }, "production_acceptance_output_token_budget_mismatch"],
    ["source", (value: any) => { value.provenance.sourceTreeSha256 = sha("b"); }, "production_acceptance_source_tree_mismatch"],
    ["corpus", (value: any) => { value.corpusId = "different-corpus"; }, "production_acceptance_corpus_mismatch"],
    ["prompt", (value: any) => { value.provenance.contracts.prompt.sha256 = sha("c"); }, "production_acceptance_prompt_contract_hash_mismatch"],
    ["response", (value: any) => { value.provenance.contracts.response.sha256 = sha("d"); }, "production_acceptance_response_contract_hash_mismatch"],
    ["fallback", (value: any) => { value.aiRerankCompleteness.casesFallback = 1; }, "production_acceptance_fallback_observed"]
  ])("rejects production acceptance with %s drift", (_label, mutate, expectedReason) => {
    const acceptance = productionAcceptanceReport();
    mutate(acceptance);
    const result = evaluateModelSelection(manifest(), validReports(), acceptance);

    expect(result.modelSelectionWinnerId).toBe("luna-medium-fast");
    expect(result.productionAcceptance?.eligible).toBe(false);
    expect(result.productionAcceptance?.rejectionReasons).toContain(expectedReason);
    expect(result.recommendedConfigurationId).toBeNull();
  });

  it("uses production acceptance latency and cost for operational gates", () => {
    const selectionReports = validReports();
    selectionReports["luna-medium-fast"] = report({
      model: "gpt-5.6-luna", effort: "medium", tier: "fast", ndcg10: 0.48, ndcg3: 0.4, family10: 0.8, p50: 8_000, p95: 9_000
    });
    const accepted = evaluateModelSelection(manifest(), selectionReports, productionAcceptanceReport());
    expect(accepted.modelSelectionWinnerId).toBe("luna-medium-fast");
    expect(accepted.productionAcceptance?.metrics.productLatencyMs?.p95).toBe(5_000);
    expect(accepted.recommendedConfigurationId).toBe("luna-medium-fast");

    const slowProduction = productionAcceptanceReport();
    for (const detail of slowProduction.details) detail.aiAssisted.responseLatencyMs = 7_000;
    const rejected = evaluateModelSelection(manifest(), validReports(), slowProduction);
    expect(rejected.productionAcceptance?.rejectionReasons).toContain("production_acceptance_maximum_product_p95_latency_exceeded");
    expect(rejected.recommendedConfigurationId).toBeNull();

    const slowProvider = productionAcceptanceReport();
    for (const detail of slowProvider.details) detail.aiAssisted.providerDiagnostics.providerLatencyMs = 6_000;
    const providerRejected = evaluateModelSelection(manifest(), validReports(), slowProvider);
    expect(providerRejected.productionAcceptance?.rejectionReasons).toContain("production_acceptance_maximum_provider_p95_latency_exceeded_or_missing");

    const expensiveProduction = productionAcceptanceReport();
    expensiveProduction.aiRerankCompleteness.providerUsage.outputTokens = 2_000_000;
    const costRejected = evaluateModelSelection(manifest(), validReports(), expensiveProduction);
    expect(costRejected.productionAcceptance?.rejectionReasons).toContain("production_acceptance_maximum_cost_per_case_exceeded_or_missing");
  });

  it("rejects a challenger when paired case uncertainty breaches the precommitted reference margin", () => {
    const reports = validReports();
    const challenger = reports["luna-medium-fast"];
    challenger.details.forEach((detail: any, index: number) => {
      detail.aiAssisted.metrics.ndcgAt10 = index < 50 ? 0.38 : 0.58;
    });

    const result = evaluateHarness(manifest(), reports);
    const evaluated = result.configurations.find((entry) => entry.id === "luna-medium-fast")!;

    expect(evaluated.relativeToReference?.ndcgAt10PairedDelta?.meanDelta).toBe(-0.02);
    expect(evaluated.relativeToReference?.ndcgAt10PairedDelta?.ci95?.lower).toBeLessThan(-0.02);
    expect(evaluated.modelSelectionEligible).toBe(false);
    expect(evaluated.modelSelectionRejectionReasons).toContain("minimum_reference_quality_delta_lower_95_not_met_or_missing");
  });

  it("keeps diagnostic quality references comparable but never promotes diagnostic challengers", () => {
    const input = manifest();
    input.configurations[0]!.expected.diagnosticOnly = true;
    input.configurations[0]!.expected.rankerTimeoutMs = 120_000;
    const diagnosticReference = report({ model: "gpt-5.6-sol", effort: "xhigh", tier: "fast", ndcg10: 0.5 });
    diagnosticReference.status = "incomplete";
    diagnosticReference.provenance.providerEvidenceEligible = false;
    diagnosticReference.provenance.timingPolicy.diagnosticOnly = true;
    diagnosticReference.provenance.timingPolicy.rankerTimeoutMs = 120_000;
    const diagnosticChallenger = report({ model: "gpt-5.6-luna", effort: "medium", tier: "fast", ndcg10: 0.48 });
    diagnosticChallenger.status = "incomplete";
    diagnosticChallenger.provenance.providerEvidenceEligible = false;
    diagnosticChallenger.provenance.timingPolicy.diagnosticOnly = true;
    const incumbent = report({ model: "gpt-5.5", effort: "low", tier: "default", ndcg10: 0.25 });

    const result = evaluateModelSelection(input, {
      "sol-xhigh-reference": diagnosticReference,
      "gpt-5.5-incumbent": incumbent,
      "luna-medium-fast": diagnosticChallenger
    }, productionAcceptanceReport());
    const reference = result.configurations.find((entry) => entry.id === "sol-xhigh-reference")!;
    const challenger = result.configurations.find((entry) => entry.id === "luna-medium-fast")!;
    expect(reference.comparisonEligible).toBe(true);
    expect(reference.warnings).toContain("diagnostic_screening_report_not_provider_evidence_complete");
    expect(challenger.comparisonEligible).toBe(false);
    expect(challenger.modelSelectionRejectionReasons).toEqual(expect.arrayContaining([
      "diagnostic_timing_policy_ineligible",
      "provider_evidence_ineligible",
      "report_not_completed"
    ]));
    expect(result.recommendedConfigurationId).toBeNull();
  });

  it.each([
    ["fallback", (value: any) => { value.aiRerankCompleteness.casesFallback = 1; }, "fallback_observed"],
    ["case coverage", (value: any) => { value.aiRerankCompleteness.casesCompleteForResponseComparison = 99; }, "incomplete_final_response_ai_coverage"],
    ["candidate coverage", (value: any) => { value.aiRerankCompleteness.aiRankedCandidateCount = 5_999; }, "incomplete_serialized_candidate_ai_coverage"],
    ["provider failure", (value: any) => { value.aiRerankCompleteness.failureCategories.timeout = 1; }, "provider_failure_observed"],
    ["tier readback", (value: any) => { value.aiRerankCompleteness.serviceTierReadbackVerified = false; }, "service_tier_readback_not_verified"],
    ["provider evidence", (value: any) => { value.provenance.providerEvidenceEligible = false; }, "provider_evidence_ineligible"],
    ["diagnostic timing", (value: any) => { value.provenance.timingPolicy.diagnosticOnly = true; }, "diagnostic_timing_policy_ineligible"],
    ["fixed arm order", (value: any) => {
      value.provenance.timingPolicy.armOrder = "deterministic_then_ai";
      delete value.provenance.timingPolicy.aiFirstCases;
      delete value.provenance.timingPolicy.deterministicFirstCases;
    }, "production_arm_order_not_seeded_balanced"]
  ])("fails promotion loudly for %s", (_label, mutate, expectedReason) => {
    const reports = validReports();
    mutate(reports["luna-medium-fast"]);
    const result = evaluateHarness(manifest(), reports);
    const challenger = result.configurations.find((entry) => entry.id === "luna-medium-fast")!;
    expect(challenger.modelSelectionEligible).toBe(false);
    expect(challenger.modelSelectionRejectionReasons).toContain(expectedReason);
    expect(result.recommendedConfigurationId).toBeNull();
  });

  it.each([
    ["corpus", (value: any) => { value.corpusId = "other"; }, "corpus_mismatch"],
    ["source tree", (value: any) => { value.provenance.sourceTreeSha256 = sha("9"); }, "source_tree_mismatch"],
    ["prompt contract", (value: any) => { value.provenance.contracts.prompt.sha256 = sha("8"); }, "prompt_contract_hash_mismatch"],
    ["response contract", (value: any) => { delete value.provenance.contracts.response; }, "response_contract_metadata_missing"],
    ["evaluation contract", (value: any) => { delete value.provenance.contracts.evaluation; }, "evaluation_contract_metadata_missing"],
    ["output-token budget", (value: any) => { value.provenance.executionPolicy.rankerMaxOutputTokens = 8_192; }, "ranker_max_output_tokens_mismatch"],
    ["missing output-token budget", (value: any) => { delete value.provenance.executionPolicy.rankerMaxOutputTokens; }, "ranker_max_output_tokens_mismatch"],
    ["production response mode", (value: any) => { value.provenance.executionPolicy.rankerResponseMode = "production"; }, "ranker_response_mode_mismatch"],
    ["missing response mode", (value: any) => { delete value.provenance.executionPolicy.rankerResponseMode; }, "ranker_response_mode_mismatch"],
    ["model", (value: any) => { value.provenance.model = "wrong-model"; }, "model_mismatch"],
    ["strict stage", (value: any) => { delete value.evaluationStages.aiRerankedStrict; }, "strict_evaluation_stage_missing"]
  ])("rejects non-comparable %s evidence", (_label, mutate, expectedReason) => {
    const reports = validReports();
    mutate(reports["luna-medium-fast"]);
    const result = evaluateHarness(manifest(), reports);
    const challenger = result.configurations.find((entry) => entry.id === "luna-medium-fast")!;
    expect(challenger.comparisonEligible).toBe(false);
    expect(challenger.comparisonRejectionReasons).toContain(expectedReason);
  });

  it("cannot recommend a challenger when the incumbent evidence is ineligible", () => {
    const reports = validReports();
    reports["gpt-5.5-incumbent"].aiRerankCompleteness.failureCategories.timeout = 1;

    const result = evaluateHarness(manifest(), reports);
    const challenger = result.configurations.find((entry) => entry.id === "luna-medium-fast")!;

    expect(challenger.modelSelectionEligible).toBe(false);
    expect(challenger.modelSelectionRejectionReasons).toContain("incumbent_not_model_selection_eligible");
    expect(result.productionPromotionCandidateIds).toEqual([]);
    expect(result.recommendedConfigurationId).toBeNull();
    expect(result.decisionReasons).toContain("incumbent_not_model_selection_eligible");
  });

  it("uses complete response latency rather than the ranking-stage subtotal", () => {
    const reports = validReports();
    reports["luna-medium-fast"].metrics.allCases.aiRerankedStrict.timingMs.rankingAndRerank = {
      count: 100,
      p50: 50,
      p95: 75
    };

    const result = evaluateHarness(manifest(), reports);
    const challenger = result.configurations.find((entry) => entry.id === "luna-medium-fast")!;

    expect(challenger.metrics.productLatencyMs).toEqual({ p50: 4_000, p95: 5_000 });
  });

  it("marks dominated configurations and lets selection policy remain a manifest-only change", () => {
    const reports = validReports();
    const qualityFirst = evaluateHarness(manifest(), reports);
    const secondChallenger = {
      id: "second-challenger", role: "challenger" as const, reportPath: "terra.json",
      expected: { model: "gpt-5.6-terra", reasoningEffort: "none", requestedServiceTier: "fast", rankerTimeoutMs: 6_000, rankerMaxOutputTokens: 2_400, diagnosticOnly: false },
      pricing: { inputUsdPerMillion: 0.4, cachedInputUsdPerMillion: 0.04, outputUsdPerMillion: 2, serviceTierMultiplier: 2 }
    };
    const matrix = { ...manifest(), configurations: [...manifest().configurations, secondChallenger] };
    const expandedReports = {
      ...reports,
      "second-challenger": report({ model: "gpt-5.6-terra", effort: "none", tier: "fast", ndcg10: 0.49, p95: 5_500 })
    };
    const qualityOrdered = evaluateHarness(matrix, expandedReports);
    const costFirst = evaluateHarness({
      ...matrix,
      selectionOrder: ["costPerCaseUsd_asc", "ndcgAt10_desc"]
    }, expandedReports);

    const incumbent = qualityFirst.configurations.find((entry) => entry.id === "gpt-5.5-incumbent")!;
    expect(incumbent.pareto).toMatchObject({ onFrontier: false, dominatedBy: ["luna-medium-fast"] });
    expect(qualityOrdered.modelSelectionWinnerId).toBe("second-challenger");
    expect(qualityOrdered.recommendedConfigurationId).toBeNull();
    expect(qualityOrdered.productionAcceptance?.rejectionReasons).toContain("production_acceptance_configuration_not_model_selection_winner");
    expect(costFirst.modelSelectionWinnerId).toBe("luna-medium-fast");
    expect(costFirst.recommendedConfigurationId).toBe("luna-medium-fast");
  });

  it("does not turn screening evidence into a production decision", () => {
    const screening = { ...manifest(), evidenceStage: "screening" as const, promotionGates: undefined };
    const result = evaluateHarness(screening, validReports());
    expect(result.productionPromotionCandidateIds).toEqual([]);
    expect(result.recommendedConfigurationId).toBeNull();
    expect(result.decisionReasons).toContain("screening_evidence_cannot_select_production_default");
    expect(result.configurations.every((entry) => !entry.productionPromotionEligible)).toBe(true);
  });
});

describe("MoodRank model-selection CLI", () => {
  it("reads only private inputs and writes a private aggregate without report paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "moodrank-model-selection-test-"));
    temporaryDirectories.push(directory);
    const input = manifest();
    const reports = validReports();
    for (const configuration of input.configurations) {
      const reportPath = join(directory, `${configuration.id}.json`);
      writeFileSync(reportPath, JSON.stringify(reports[configuration.id]), { mode: 0o600 });
      configuration.reportPath = `${configuration.id}.json`;
    }
    writeFileSync(join(directory, "luna-production.json"), JSON.stringify(productionAcceptanceReport()), { mode: 0o600 });
    const manifestPath = join(directory, "manifest.json");
    const outputPath = join(directory, "result.json");
    writeFileSync(manifestPath, JSON.stringify(input), { mode: 0o600 });

    const result = runModelSelectionCli({ manifestPath, outputPath });
    const saved = readFileSync(outputPath, "utf8");
    expect(result.recommendedConfigurationId).toBe("luna-medium-fast");
    expect(result.modelSelectionWinnerId).toBe("luna-medium-fast");
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    expect(saved).not.toContain("reportPath");
    expect(saved).not.toContain("details");
    expect(() => runModelSelectionCli({ manifestPath, outputPath })).toThrow(/EEXIST/);
  });

  it("rejects non-private evidence files and malformed options", () => {
    const directory = mkdtempSync(join(tmpdir(), "moodrank-model-selection-permissions-"));
    temporaryDirectories.push(directory);
    const manifestPath = join(directory, "manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest()), { mode: 0o600 });
    chmodSync(manifestPath, 0o644);
    expect(() => runModelSelectionCli({ manifestPath, outputPath: join(directory, "result.json") }))
      .toThrow(/manifest_permissions_must_be_0600_or_stricter/);
    expect(parseModelSelectionCliArgs(["--manifest", "a", "--output", "b"])).toMatchObject({
      manifestPath: expect.stringMatching(/\/a$/),
      outputPath: expect.stringMatching(/\/b$/)
    });
    expect(() => parseModelSelectionCliArgs(["--manifest", "a", "--unknown", "b"])).toThrow(/unknown_option/);
  });
});

function manifest(): ModelSelectionManifest {
  const basePricing = {
    inputUsdPerMillion: 1,
    cachedInputUsdPerMillion: 0.1,
    outputUsdPerMillion: 2,
    serviceTierMultiplier: 1
  };
  return {
    schemaVersion: "moodrank-model-selection-manifest-v2",
    decisionId: "moodrank-default-2026-08-27",
    evidenceStage: "production",
    referenceConfigurationId: "sol-xhigh-reference",
    incumbentConfigurationId: "gpt-5.5-incumbent",
    comparisonContract: {
      corpusId: "private-corpus-v1",
      judgmentVersion: "judgments-v1",
      catalogSnapshotId: "catalog-v1",
      evaluatedCases: 100,
      engineVersion: "moodrank-v1",
      sourceCommit: "abc123",
      sourceTreeSha256: sha("1"),
      casesSha256: sha("2"),
      judgmentsSha256: sha("3"),
      catalogSha256: sha("4"),
      seed: 42,
      bootstrapSamples: 2_000,
      aiRunsPerCase: 1,
      rankerMaxOutputTokens: 2_400,
      rankerResponseMode: "evaluation_score_only",
      prompt: { id: "moodrank-evaluation-score-prompt-v1", sha256: sha("5") },
      response: { id: "moodrank-evaluation-score-response-v1", sha256: sha("8") },
      evaluation: { id: "moodrank-strict-eval-v2", sha256: sha("6") }
    },
    promotionGates: {
      minimumCases: 100,
      maximumProductP95Ms: 6_000,
      maximumProviderP95Ms: 5_000,
      maximumCostPerCaseUsd: 0.01,
      minimumNdcgAt10: 0.4,
      minimumNdcgAt10RatioOfReference: 0.9,
      minimumNdcgAt10DeltaVsIncumbent: 0.05,
      minimumNdcgAt10DeltaVsReferenceLower95: -0.02,
      minimumNdcgAt10DeltaVsIncumbentLower95: 0.05,
      requireParetoFrontier: true
    },
    selectionOrder: ["ndcgAt10_desc", "productP95Ms_asc", "costPerCaseUsd_asc"],
    configurations: [
      {
        id: "sol-xhigh-reference", role: "quality_reference", reportPath: "sol.json",
        expected: { model: "gpt-5.6-sol", reasoningEffort: "xhigh", requestedServiceTier: "fast", rankerTimeoutMs: 6_000, rankerMaxOutputTokens: 2_400, diagnosticOnly: false },
        pricing: { ...basePricing, inputUsdPerMillion: 4, cachedInputUsdPerMillion: 0.4, outputUsdPerMillion: 20, serviceTierMultiplier: 2 }
      },
      {
        id: "gpt-5.5-incumbent", role: "incumbent", reportPath: "gpt55.json",
        expected: { model: "gpt-5.5", reasoningEffort: "low", requestedServiceTier: "default", rankerTimeoutMs: 6_000, rankerMaxOutputTokens: 2_400, diagnosticOnly: false },
        pricing: { ...basePricing, inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 30 }
      },
      {
        id: "luna-medium-fast", role: "challenger", reportPath: "luna.json",
        expected: { model: "gpt-5.6-luna", reasoningEffort: "medium", requestedServiceTier: "fast", rankerTimeoutMs: 6_000, rankerMaxOutputTokens: 2_400, diagnosticOnly: false },
        pricing: { ...basePricing, inputUsdPerMillion: 0.2, cachedInputUsdPerMillion: 0.02, outputUsdPerMillion: 1.2, serviceTierMultiplier: 2 }
      }
    ],
    productionAcceptance: {
      configurationId: "luna-medium-fast",
      reportPath: "luna-production.json",
      prompt: { id: "moodrank-production-prompt-v4", sha256: sha("9") },
      response: { id: "moodrank-production-response-v4", sha256: sha("a") }
    }
  };
}

function validReports(): Record<string, any> {
  return {
    "sol-xhigh-reference": report({ model: "gpt-5.6-sol", effort: "xhigh", tier: "fast", ndcg10: 0.5, ndcg3: 0.45, family10: 0.8, p50: 18_000, p95: 21_000 }),
    "gpt-5.5-incumbent": report({ model: "gpt-5.5", effort: "low", tier: "default", ndcg10: 0.25, ndcg3: 0.2, family10: 0.5, p50: 25_000, p95: 30_000 }),
    "luna-medium-fast": report({ model: "gpt-5.6-luna", effort: "medium", tier: "fast", ndcg10: 0.48, ndcg3: 0.4, family10: 0.8, p50: 4_000, p95: 5_000 })
  };
}

function productionAcceptanceReport() {
  const value = report({ model: "gpt-5.6-luna", effort: "medium", tier: "fast", ndcg10: 0.48, ndcg3: 0.4, family10: 0.8, p50: 4_000, p95: 5_000 });
  value.provenance.executionPolicy.rankerResponseMode = "production";
  value.provenance.contracts.prompt = { id: "moodrank-production-prompt-v4", sha256: sha("9") };
  value.provenance.contracts.response = { id: "moodrank-production-response-v4", sha256: sha("a") };
  return value;
}

function evaluateHarness(
  input: ModelSelectionManifest = manifest(),
  reports: Record<string, any> = validReports(),
  acceptance: unknown = productionAcceptanceReport()
) {
  return evaluateModelSelection(input, reports, acceptance);
}

function report(overrides: {
  model: string;
  effort: string;
  tier: string;
  ndcg10?: number;
  ndcg3?: number;
  family10?: number;
  p50?: number;
  p95?: number;
  inputTokens?: number;
  outputTokens?: number;
}) {
  const cases = 100;
  const metric = (value: number) => ({ value, ci95: { lower: value - 0.01, upper: value + 0.01 }, contributingCases: cases, evidenceStatus: "pilot" });
  const responseMetrics = {
    ndcgAt3: metric(overrides.ndcg3 ?? 0.4),
    ndcgAt10: metric(overrides.ndcg10 ?? 0.45),
    acceptableFamilyHitAt3: metric(0.6),
    acceptableFamilyHitAt10: metric(overrides.family10 ?? 0.8),
    pairwiseCoverage: metric(0.7),
    pairwiseAccuracy: metric(0.6),
    constraints: { counts: { pass: 10, fail: 0, unknown: 0 }, rates: { pass: metric(1), fail: metric(0), unknown: metric(0) }, expectedMatchCount: 10, total: 10 },
    timingMs: { retrieval: { count: cases, p50: 10, p95: 20 }, rankingAndRerank: { count: cases, p50: overrides.p50 ?? 4_000, p95: overrides.p95 ?? 5_000 } }
  };
  return {
    schemaVersion: "moodrank-product-eval-report-v2",
    status: "completed",
    completeCaseSetEvidenceStatus: "pilot",
    corpusId: "private-corpus-v1",
    judgmentVersion: "judgments-v1",
    catalogSnapshotId: "catalog-v1",
    evaluatedCases: cases,
    evaluationStages: {
      deterministic: "search_service_final_response",
      aiRerankedStrict: "search_service_final_response",
      finalSearchServiceResponseEvaluated: true,
      runtimeConfigurationParity: "controlled",
      retrievalMetricsReported: false
    },
    metrics: {
      allCases: { deterministic: responseMetrics, aiRerankedStrict: responseMetrics },
      completeAiCases: { caseCount: cases, deterministic: responseMetrics, aiReranked: responseMetrics, pairedComparisons: {} }
    },
    aiRerankCompleteness: {
      casesRequested: cases,
      casesUsedAi: cases,
      casesFallback: 0,
      casesCompleteForResponseComparison: cases,
      offeredCandidateCount: 6_000,
      serializedCandidateCount: 6_000,
      aiRankedCandidateCount: 6_000,
      finalResponseItemCount: 1_000,
      finalResponseAiCoveredCount: 1_000,
      externalRequestCount: cases,
      serviceTierReadbackVerified: true,
      failureCategories: { not_attempted: 0, timeout: 0, http_failure: 0, malformed_or_truncated_output: 0, empty_ranking: 0, request_failure: 0 },
      receivedServiceTiers: { [overrides.tier === "fast" ? "priority" : "default"]: cases },
      providerUsage: {
        responsesWithUsage: cases,
        inputTokens: overrides.inputTokens ?? 10_000,
        cachedInputTokens: 0,
        outputTokens: overrides.outputTokens ?? 5_000,
        reasoningTokens: 1_000,
        totalTokens: (overrides.inputTokens ?? 10_000) + (overrides.outputTokens ?? 5_000)
      }
    },
    provenance: {
      engineVersion: "moodrank-v1",
      executionMode: "external",
      provider: "openai",
      model: overrides.model,
      reasoningEffort: overrides.effort,
      requestedServiceTier: overrides.tier,
      providerEvidenceEligible: true,
      sourceCommit: "abc123",
      sourceDirty: false,
      sourceTreeSha256: sha("1"),
      seed: 42,
      bootstrapSamples: 2_000,
      inferencePolicy: { aiRunsPerCase: 1 },
      contentHashes: { cases: sha("2"), judgments: sha("3"), catalog: sha("4"), evaluationInput: sha("7") },
      contracts: {
        prompt: { id: "moodrank-evaluation-score-prompt-v1", sha256: sha("5") },
        response: { id: "moodrank-evaluation-score-response-v1", sha256: sha("8") },
        evaluation: { id: "moodrank-strict-eval-v2", sha256: sha("6") }
      },
      executionPolicy: { rankerMaxOutputTokens: 2_400, rankerResponseMode: "evaluation_score_only" },
      timingPolicy: {
        diagnosticOnly: false,
        armOrder: "seeded_balanced",
        aiFirstCases: 50,
        deterministicFirstCases: 50,
        rankerTimeoutMs: 6_000
      }
    },
    details: Array.from({ length: cases }, (_, index) => ({
      caseId: `case-${index + 1}`,
      aiAssisted: {
        responseLatencyMs: index < 94 ? (overrides.p50 ?? 4_000) : (overrides.p95 ?? 5_000),
        metrics: { ndcgAt10: overrides.ndcg10 ?? 0.45 },
        providerDiagnostics: { providerLatencyMs: 3_000 + index * (2_000 / (cases - 1)) },
        rerank: {
          requested: true,
          offeredCandidateCount: 60,
          serializedCandidateCount: 60,
          aiRankedCandidateCount: 60,
          offeredWindowComplete: true,
          serializedPayloadComplete: true,
          finalResponseItemCount: 10,
          finalResponseAiCoveredCount: 10,
          finalResponseComplete: true,
          completeForResponseComparison: true
        }
      }
    }))
  };
}
