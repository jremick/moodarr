import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  constants as fsConstants,
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import type { ItemDetail } from "../src/shared/types";
import { DeterministicBriefParser } from "../src/server/ai/briefParser";
import type { AiRanker, AiRankerResult } from "../src/server/ai/ranker";
import {
  aiRankerFailureCategories,
  getOpenAiRankerContractIdentity,
  NoopRanker,
  openAiRankerDefaultMaxOutputTokens,
  openAiRankerMaxOutputTokenLimit,
  openAiRankerPromptIdentity,
  openAiRankerResponseContractIdentity,
  OpenAiRanker,
  type OpenAiServiceTier
} from "../src/server/ai/ranker";
import { DeterministicQueryOptimizer } from "../src/server/ai/queryOptimizer";
import { NoopTasteScout } from "../src/server/ai/tasteScout";
import { loadConfig, type AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { moodRankTraceSchemaVersion } from "../src/server/recommendation/tracing";
import { recommendationEngineVersion } from "../src/server/recommendation/version";
import { SearchService } from "../src/server/search/searchService";
import {
  IndependentEvalContractError,
  calculateCaseObservation,
  defaultBootstrapSamples,
  defaultIndependentEvalSeed,
  evidenceStatusForCaseCount,
  parseBlindCaseSet,
  parseBlindJudgmentSet,
  sha256Text,
  validateBlindEvaluationInputs,
  type BlindCaseSetV1,
  type BlindItemRegistryEntryV1,
  type IndependentEvalCaseObservation
} from "./moodrank-independent-eval-contract";
import {
  aggregatePairedComparisons,
  aggregateSafeProductReport,
  assertStrictProductEvaluationRerank,
  productCaseMetrics,
  productRerankCoverage,
  productResponseMetrics,
  strictProductEvaluationContractIdentity,
  sumProductValues,
  type ProductCaseResult,
  type ProductEvalCaseDetail,
  type ProductEvalReport
} from "./moodrank-product-eval-contract";

export interface ProductEvalArgs {
  casesPath: string;
  judgmentsPath: string;
  catalogPath: string;
  configPath: string;
  workDatabasePath: string;
  outputPath: string;
  seed: number;
  maxExternalRequests: number;
  diagnosticRankerTimeoutMs?: number;
  diagnosticRankerMaxOutputTokens?: number;
  serviceTier: OpenAiServiceTier;
  confirmExternalProcessing: true;
}

export interface ProductEvalDependencies {
  createAiRanker?: (config: AppConfig) => AiRanker;
}

const defaultMaxExternalRequests = 100;
let productEvaluationActive = false;
let productEvaluationNetworkGuardActive = false;

export class ProductEvalArgumentError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ProductEvalArgumentError";
  }
}


export function parseProductEvalArgs(values: string[]): ProductEvalArgs {
  const parsed: Partial<ProductEvalArgs> = {
    seed: defaultIndependentEvalSeed,
    maxExternalRequests: defaultMaxExternalRequests,
    serviceTier: "default"
  };
  const seen = new Set<string>();
  const valueOptions = new Set([
    "--cases",
    "--judgments",
    "--catalog",
    "--config",
    "--work-db",
    "--output",
    "--seed",
    "--max-external-requests",
    "--diagnostic-ranker-timeout-ms",
    "--diagnostic-ranker-max-output-tokens",
    "--openai-service-tier"
  ]);
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index]!;
    if (key === "--confirm-external-processing") {
      if (seen.has(key)) throw new ProductEvalArgumentError("duplicate_option");
      seen.add(key);
      parsed.confirmExternalProcessing = true;
      continue;
    }
    if (!valueOptions.has(key)) throw new ProductEvalArgumentError("unknown_option");
    if (seen.has(key)) throw new ProductEvalArgumentError("duplicate_option");
    seen.add(key);
    const value = values[++index];
    if (value === undefined || value.startsWith("--")) throw new ProductEvalArgumentError("missing_option_value");
    if (key === "--cases") parsed.casesPath = resolve(value);
    else if (key === "--judgments") parsed.judgmentsPath = resolve(value);
    else if (key === "--catalog") parsed.catalogPath = resolve(value);
    else if (key === "--config") parsed.configPath = resolve(value);
    else if (key === "--work-db") parsed.workDatabasePath = resolve(value);
    else if (key === "--output") parsed.outputPath = resolve(value);
    else if (key === "--seed") {
      const seed = Number(value);
      if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
        throw new ProductEvalArgumentError("invalid_seed");
      }
      parsed.seed = seed;
    } else if (key === "--max-external-requests") {
      const maxExternalRequests = Number(value);
      parsed.maxExternalRequests = validateMaxExternalRequests(maxExternalRequests);
    } else if (key === "--diagnostic-ranker-timeout-ms") {
      const timeoutMs = Number(value);
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) {
        throw new ProductEvalArgumentError("invalid_diagnostic_ranker_timeout");
      }
      parsed.diagnosticRankerTimeoutMs = timeoutMs;
    } else if (key === "--diagnostic-ranker-max-output-tokens") {
      const maxOutputTokens = Number(value);
      if (
        !Number.isSafeInteger(maxOutputTokens)
        || maxOutputTokens < 1
        || maxOutputTokens > openAiRankerMaxOutputTokenLimit
      ) {
        throw new ProductEvalArgumentError("invalid_diagnostic_ranker_max_output_tokens");
      }
      parsed.diagnosticRankerMaxOutputTokens = maxOutputTokens;
    } else {
      if (value !== "default" && value !== "fast") {
        throw new ProductEvalArgumentError("invalid_openai_service_tier");
      }
      parsed.serviceTier = value;
    }
  }
  if (!parsed.casesPath || !parsed.judgmentsPath || !parsed.catalogPath || !parsed.configPath || !parsed.workDatabasePath || !parsed.outputPath) {
    throw new ProductEvalArgumentError("missing_required_option");
  }
  if (parsed.confirmExternalProcessing !== true) {
    throw new ProductEvalArgumentError("external_processing_confirmation_required");
  }
  return parsed as ProductEvalArgs;
}

export async function runProductEvaluation(
  args: ProductEvalArgs,
  dependencies: ProductEvalDependencies = {}
): Promise<ProductEvalReport> {
  if (productEvaluationActive) throw new IndependentEvalContractError("product_evaluation_already_active");
  productEvaluationActive = true;
  try {
    return await runProductEvaluationExclusive(args, dependencies);
  } finally {
    productEvaluationActive = false;
  }
}

async function runProductEvaluationExclusive(
  args: ProductEvalArgs,
  dependencies: ProductEvalDependencies
): Promise<ProductEvalReport> {
  const startedAt = performance.now();
  const executionMode = dependencies.createAiRanker ? "simulated" : "external";
  const serviceTier = args.serviceTier ?? "default";
  const rankerMaxOutputTokens = args.diagnosticRankerMaxOutputTokens ?? openAiRankerDefaultMaxOutputTokens;
  if (args.confirmExternalProcessing !== true) throw new ProductEvalArgumentError("external_processing_confirmation_required");
  const maxExternalRequests = validateMaxExternalRequests(args.maxExternalRequests ?? defaultMaxExternalRequests);
  assertInputFile(args.casesPath, "cases_file_missing");
  assertInputFile(args.judgmentsPath, "judgments_file_missing");
  assertColdDatabase(args.catalogPath);
  assertPrivateConfig(args.configPath);
  assertPrivateOutputOutsideRepository(args.outputPath);
  assertPrivateOutputOutsideRepository(args.workDatabasePath);
  if (canonicalOutputTarget(args.outputPath) === canonicalOutputTarget(args.workDatabasePath)) {
    throw new IndependentEvalContractError("output_and_work_database_paths_alias");
  }
  if (existsSync(args.outputPath)) throw new IndependentEvalContractError("output_file_already_exists");
  if (existsSync(args.workDatabasePath)) throw new IndependentEvalContractError("work_database_already_exists");

  const casesRaw = readFileSync(args.casesPath, "utf8");
  const judgmentsRaw = readFileSync(args.judgmentsPath, "utf8");
  const caseSet = parseBlindCaseSet(casesRaw);
  const judgmentSet = parseBlindJudgmentSet(judgmentsRaw);
  validateBlindEvaluationInputs(caseSet, judgmentSet);
  if (caseSet.cases.length > maxExternalRequests) {
    throw new IndependentEvalContractError("external_request_budget_exceeded");
  }
  const sourceState = currentSourceState();
  if (executionMode === "external" && (
    sourceState.commit === "unknown"
    || sourceState.dirty !== false
    || sourceState.treeSha256 === "unknown"
  )) {
    throw new IndependentEvalContractError("clean_source_required_for_external_evidence");
  }
  const sourceDatabaseSha256 = `sha256:${await sha256File(args.catalogPath)}`;
  if (caseSet.catalogSnapshotId !== sourceDatabaseSha256) {
    throw new IndependentEvalContractError("catalog_snapshot_hash_mismatch");
  }

  const temporaryDirectory = mkdtempSync(join(tmpdir(), "moodrank-product-eval-"));
  const workDatabasePath = join(temporaryDirectory, "moodarr-eval.sqlite");
  let database: ReturnType<typeof createDatabase> | undefined;
  let restoreNetwork: (() => void) | undefined;
  let restoreTraceMode: (() => void) | undefined;
  let workDatabaseSha256 = "";
  let retainedDatabaseCreated = false;
  let keepRetainedDatabase = false;
  try {
    copyFileSync(args.catalogPath, workDatabasePath, fsConstants.COPYFILE_FICLONE);
    chmodSync(workDatabasePath, 0o600);
    if (`sha256:${await sha256File(workDatabasePath)}` !== sourceDatabaseSha256) {
      throw new IndependentEvalContractError("source_catalog_changed_during_copy");
    }
    database = createDatabase(workDatabasePath);
    const migrationState = assertSchema32(database);
    clearImportedPrivateState(database);
    assertImportedPrivateStateCleared(database);
    const config = loadProjectEvaluationConfig(args.configPath, workDatabasePath);
    if (config.ai.provider !== "openai" || !config.ai.openaiApiKey) {
      throw new IndependentEvalContractError("openai_provider_not_configured");
    }

    const repository = new MediaRepository(database, { runStartupRepairs: false });
    const itemByRef = resolveJudgmentItems(database, repository, judgmentSet.items);
    const itemIdByRef = new Map([...itemByRef].map(([itemRef, item]) => [itemRef, item.id]));
    const refByItemId = new Map([...itemByRef].map(([itemRef, item]) => [item.id, itemRef]));
    const judgmentByCaseId = new Map(judgmentSet.cases.map((judgment) => [judgment.caseId, judgment]));
    const networkGuard = installProductEvaluationNetworkGuard(maxExternalRequests);
    restoreNetwork = networkGuard.restore;
    restoreTraceMode = installStrictTraceMode();

    const deterministicService = createEvaluationSearchService(repository, new NoopRanker());
    const recordingRanker = new RecordingRanker((dependencies.createAiRanker ?? ((value) => new OpenAiRanker(
      value,
      args.diagnosticRankerTimeoutMs ?? 6_000,
      serviceTier,
      rankerMaxOutputTokens
    )))(config));
    const aiService = createEvaluationSearchService(repository, recordingRanker);
    const deterministicObservations: IndependentEvalCaseObservation[] = [];
    const aiObservations: IndependentEvalCaseObservation[] = [];
    const details: ProductEvalCaseDetail[] = [];
    const renderedContracts: Array<{
      caseId: string;
      prompt: { id: string; sha256: string };
      response: { id: string; sha256: string };
    }> = [];
    const sessionIds: string[] = [];
    let expectedResultRows = 0;
    const aiFirstCaseIds = seededBalancedAiFirstCaseIds(caseSet.cases.map((testCase) => testCase.id), args.seed);

    for (const testCase of caseSet.cases) {
      const judgment = judgmentByCaseId.get(testCase.id)!;
      const runDeterministic = () => evaluateProductCase(
        deterministicService, testCase, judgment, itemIdByRef, refByItemId, false
      );
      const runAiAssisted = () => evaluateProductCase(
        aiService, testCase, judgment, itemIdByRef, refByItemId, true
      );
      let deterministic: Awaited<ReturnType<typeof runDeterministic>>;
      let aiAssisted: Awaited<ReturnType<typeof runAiAssisted>>;
      if (aiFirstCaseIds.has(testCase.id)) {
        aiAssisted = await runAiAssisted();
        deterministic = await runDeterministic();
      } else {
        deterministic = await runDeterministic();
        aiAssisted = await runAiAssisted();
      }
      const rankerInvocation = recordingRanker.takeLastInvocation();
      const rankerResult = rankerInvocation?.result;
      const offeredCandidateCount = aiAssisted.response.diagnostics?.rerankCandidateCount ?? 0;
      const serializedCandidateCount = rankerResult?.trace?.serializedCandidateCount ?? 0;
      const aiRankedCandidateCount = rankerResult?.trace?.rankedItems.length ?? 0;
      const coverage = productRerankCoverage({
        usedAi: aiAssisted.result.usedAi,
        offeredCandidateCount,
        finalResponseItemIds: aiAssisted.response.results.map((item) => item.id),
        rankerResult
      });

      assertStrictProductEvaluationRerank({
        responseUsedAi: aiAssisted.result.usedAi,
        offeredCandidateIds: rankerInvocation?.offeredCandidateIds ?? [],
        finalResponseItemIds: aiAssisted.response.results.map((item) => item.id),
        requestedServiceTier: serviceTier,
        requireServiceTierReadback: executionMode === "external",
        rankerResult
      });
      const contractIdentity = getOpenAiRankerContractIdentity(serializedCandidateCount, testCase.resultLimit);
      renderedContracts.push({
        caseId: testCase.id,
        prompt: contractIdentity.prompt,
        response: contractIdentity.responseContract
      });

      if (!deterministic.response.sessionId || !aiAssisted.response.sessionId) {
        throw new IndependentEvalContractError("strict_trace_session_missing", testCase.id);
      }
      sessionIds.push(deterministic.response.sessionId, aiAssisted.response.sessionId);
      expectedResultRows += deterministic.response.results.length + aiAssisted.response.results.length;

      deterministicObservations.push(deterministic.observation);
      aiObservations.push(aiAssisted.observation);
      details.push({
        caseId: testCase.id,
        deterministic: deterministic.result,
        aiAssisted: {
          ...aiAssisted.result,
          fallback: !aiAssisted.result.usedAi,
          failureCategory: rankerResult?.failureCategory ?? null,
          providerDiagnostics: rankerResult?.providerDiagnostics ?? null,
          rerank: {
            requested: true,
            offeredCandidateCount,
            serializedCandidateCount,
            aiRankedCandidateCount,
            ...coverage
          }
        }
      });
    }

    assertProductEvaluationTraceEvidence(database, sessionIds, expectedResultRows);
    clearNonEvidencePrivateState(database);
    assertImportedPrivateStateCleared(database);

    database.close();
    database = undefined;
    restoreNetwork();
    restoreNetwork = undefined;
    restoreTraceMode();
    restoreTraceMode = undefined;
    assertColdDatabase(workDatabasePath);
    workDatabaseSha256 = `sha256:${await sha256File(workDatabasePath)}`;
    await assertSourceDatabaseUnchanged(args.catalogPath, sourceDatabaseSha256);
    copyFileSync(
      workDatabasePath,
      args.workDatabasePath,
      fsConstants.COPYFILE_EXCL | fsConstants.COPYFILE_FICLONE
    );
    retainedDatabaseCreated = true;
    chmodSync(args.workDatabasePath, 0o600);
    if (`sha256:${await sha256File(args.workDatabasePath)}` !== workDatabaseSha256) {
      rmSync(args.workDatabasePath, { force: true });
      retainedDatabaseCreated = false;
      throw new IndependentEvalContractError("retained_work_database_hash_mismatch");
    }

    const completeCaseIndexes = details.flatMap((detail, index) =>
      detail.aiAssisted.rerank.completeForResponseComparison ? [index] : []
    );
    const completeDeterministicObservations = completeCaseIndexes.map((index) => deterministicObservations[index]!);
    const completeAiObservations = completeCaseIndexes.map((index) => aiObservations[index]!);
    const sourceStateAfter = currentSourceState();
    if (JSON.stringify(sourceStateAfter) !== JSON.stringify(sourceState)) {
      throw new IndependentEvalContractError("source_state_changed_during_evaluation");
    }
    const casesSha256 = sha256Text(casesRaw);
    const judgmentsSha256 = sha256Text(judgmentsRaw);
    const actualModel = recordingRanker.modelName ?? config.ai.openaiModel;
    const rankerTimeoutMs = recordingRanker.requestTimeoutMs ?? null;
    const renderedPromptContract = aggregateRenderedContractIdentity(
      `${openAiRankerPromptIdentity.id}:case-set-v1`, renderedContracts, "prompt"
    );
    const renderedResponseContract = aggregateRenderedContractIdentity(
      `${openAiRankerResponseContractIdentity.id}:case-set-v1`, renderedContracts, "response"
    );
    const evaluationInput = sha256Text(JSON.stringify({
      casesSha256,
      judgmentsSha256,
      catalogSha256: sourceDatabaseSha256,
      engineVersion: recommendationEngineVersion,
      executionMode,
      provider: executionMode === "external" ? "openai" : "simulated",
      model: actualModel,
      reasoningEffort: config.ai.openaiReasoningEffort,
      requestedServiceTier: serviceTier,
      rankerTimeoutMs,
      rankerMaxOutputTokens,
      renderedPromptContract,
      renderedResponseContract,
      armOrder: "seeded_balanced",
      sourceCommit: sourceState.commit,
      sourceDirty: sourceState.dirty,
      sourceTreeSha256: sourceState.treeSha256,
      seed: args.seed,
      maxExternalRequests
    }));
    const externalRequestCount = networkGuard.requestCount();
    const serviceTierReadbackVerified = hasExpectedServiceTierReadback(details, serviceTier);
    await assertSourceDatabaseUnchanged(args.catalogPath, sourceDatabaseSha256);
    const providerEvidenceEligible = executionMode === "external"
      && args.diagnosticRankerTimeoutMs === undefined
      && args.diagnosticRankerMaxOutputTokens === undefined
      && completeCaseIndexes.length === caseSet.cases.length
      && externalRequestCount === caseSet.cases.length
      && serviceTierReadbackVerified
      && sourceState.dirty === false;
    const report: ProductEvalReport = {
      schemaVersion: "moodrank-product-eval-report-v2",
      status: executionMode === "simulated" ? "simulated" : providerEvidenceEligible ? "completed" : "incomplete",
      completeCaseSetEvidenceStatus: evidenceStatusForCaseCount(providerEvidenceEligible ? completeCaseIndexes.length : 0),
      corpusId: caseSet.corpusId,
      judgmentVersion: judgmentSet.judgmentVersion,
      catalogSnapshotId: caseSet.catalogSnapshotId,
      evaluatedCases: caseSet.cases.length,
      evaluationStages: {
        deterministic: "search_service_final_response",
        aiRerankedStrict: "search_service_final_response",
        finalSearchServiceResponseEvaluated: true,
        runtimeConfigurationParity: "controlled",
        retrievalMetricsReported: false
      },
      metrics: {
        allCases: {
          deterministic: productResponseMetrics(deterministicObservations, args.seed),
          aiRerankedStrict: productResponseMetrics(aiObservations, args.seed)
        },
        completeAiCases: {
          caseCount: completeCaseIndexes.length,
          deterministic: completeCaseIndexes.length > 0
            ? productResponseMetrics(completeDeterministicObservations, args.seed)
            : null,
          aiReranked: completeCaseIndexes.length > 0
            ? productResponseMetrics(completeAiObservations, args.seed)
            : null,
          pairedComparisons: completeCaseIndexes.length > 0
            ? aggregatePairedComparisons(completeDeterministicObservations, completeAiObservations, args.seed)
            : null
        }
      },
      aiRerankCompleteness: {
        casesRequested: details.length,
        casesUsedAi: details.filter((detail) => detail.aiAssisted.usedAi).length,
        casesFallback: details.filter((detail) => detail.aiAssisted.fallback).length,
        casesCompleteForResponseComparison: completeCaseIndexes.length,
        offeredCandidateCount: sumProductValues(details.map((detail) => detail.aiAssisted.rerank.offeredCandidateCount)),
        serializedCandidateCount: sumProductValues(details.map((detail) => detail.aiAssisted.rerank.serializedCandidateCount)),
        aiRankedCandidateCount: sumProductValues(details.map((detail) => detail.aiAssisted.rerank.aiRankedCandidateCount)),
        finalResponseItemCount: sumProductValues(details.map((detail) => detail.aiAssisted.rerank.finalResponseItemCount)),
        finalResponseAiCoveredCount: sumProductValues(details.map((detail) => detail.aiAssisted.rerank.finalResponseAiCoveredCount)),
        externalRequestCount,
        serviceTierReadbackVerified,
        failureCategories: Object.fromEntries(aiRankerFailureCategories.map((category) => [
          category,
          details.filter((detail) => detail.aiAssisted.failureCategory === category).length
        ])) as ProductEvalReport["aiRerankCompleteness"]["failureCategories"],
        receivedServiceTiers: countReceivedServiceTiers(details),
        providerUsage: aggregateProviderUsage(details)
      },
      provenance: {
        engineVersion: recommendationEngineVersion,
        executionMode,
        provider: executionMode === "external" ? "openai" : "simulated",
        model: actualModel,
        reasoningEffort: config.ai.openaiReasoningEffort,
        requestedServiceTier: serviceTier,
        providerEvidenceEligible,
        contracts: {
          prompt: renderedPromptContract,
          response: renderedResponseContract,
          evaluation: strictProductEvaluationContractIdentity()
        },
        sourceCommit: sourceState.commit,
        sourceDirty: sourceState.dirty,
        sourceTreeSha256: sourceState.treeSha256,
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        seed: args.seed,
        bootstrapSamples: defaultBootstrapSamples,
        database: {
          sourceSha256: sourceDatabaseSha256,
          workSha256: workDatabaseSha256,
          workDatabaseRetained: true,
          sourceUnchanged: true,
          schemaMigrationCount: migrationState.count,
          schema32MigrationPresent: true
        },
        contentHashes: {
          cases: casesSha256,
          judgments: judgmentsSha256,
          catalog: sourceDatabaseSha256,
          evaluationInput
        },
        executionPolicy: {
          externalProcessingConfirmed: true,
          networkScope: "openai_responses_rerank_only",
          plannedExternalRequests: caseSet.cases.length,
          maxExternalRequests,
          rankerMaxOutputTokens,
          disposableDatabase: true,
          sourceDatabaseReadOnly: true,
          startupRepairsDisabled: true,
          plexDisabled: true,
          seerrDisabled: true,
          descriptiveAugmentationDisabled: true,
          providerEmbeddingsDisabled: true,
          providerEmbeddingBackfillDisabled: true,
          aiBriefParsingDisabled: true,
          aiQueryOptimizationDisabled: true,
          aiTasteScoutDisabled: true,
          personalizationStateCleared: true,
          importedAuthRequestAndTelemetryStateCleared: true,
          strictTraceWritesRequired: true,
          rawQueriesWrittenToStdout: false,
          rawCandidatePayloadsWrittenToStdout: false,
          releaseThresholdDefined: false
        },
        inferencePolicy: {
          armMetricCiMethod: "case_percentile_bootstrap",
          pairedDeltaCiMethod: "paired_case_percentile_bootstrap",
          aiRunsPerCase: 1,
          intervalsConditionalOnSingleProviderRun: true
        },
        timingPolicy: {
          diagnosticOnly: args.diagnosticRankerTimeoutMs !== undefined
            || args.diagnosticRankerMaxOutputTokens !== undefined,
          armOrder: "seeded_balanced",
          aiFirstCases: aiFirstCaseIds.size,
          deterministicFirstCases: caseSet.cases.length - aiFirstCaseIds.size,
          rankerTimeoutMs
        },
        generatedAt: new Date().toISOString(),
        durationMs: roundTiming(performance.now() - startedAt)
      },
      details
    };
    writePrivateReport(args.outputPath, report);
    keepRetainedDatabase = true;
    return report;
  } finally {
    restoreNetwork?.();
    restoreTraceMode?.();
    database?.close();
    if (retainedDatabaseCreated && !keepRetainedDatabase) rmSync(args.workDatabasePath, { force: true });
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

async function evaluateProductCase(
  service: SearchService,
  testCase: BlindCaseSetV1["cases"][number],
  judgment: Parameters<typeof calculateCaseObservation>[0]["judgment"],
  itemIdByRef: Map<string, string>,
  refByItemId: Map<string, string>,
  useAi: boolean
) {
  const startedAt = performance.now();
  const response = await service.search({
    query: testCase.query,
    filters: testCase.filters,
    useAi,
    resultLimit: testCase.resultLimit,
    watchContext: testCase.watchContext
  });
  const responseLatencyMs = roundTiming(performance.now() - startedAt);
  const observation = calculateCaseObservation({
    caseId: testCase.id,
    judgment,
    itemIdByRef,
    // Product responses do not expose the pre-rerank pool. This placeholder is
    // used only to reuse the shared ranked-slate metric implementation; the
    // product report deliberately omits the resulting retrieval-recall field.
    preRerankItemIds: response.results.map((item) => item.id),
    rankedItems: response.results,
    retrievalMs: response.diagnostics?.stageLatencyMs?.retrieval ?? 0,
    scoringMs: (response.diagnostics?.stageLatencyMs?.scoring ?? 0) + (response.diagnostics?.stageLatencyMs?.rerank ?? 0)
  });
  const result: ProductCaseResult = {
    usedAi: response.usedAi,
    responseItemCount: response.results.length,
    judgedRanks: response.results.flatMap((item, index) => {
      const itemRef = refByItemId.get(item.id);
      return itemRef ? [{ itemRef, rank: index + 1 }] : [];
    }),
    metrics: productCaseMetrics(observation),
    responseLatencyMs
  };
  return { result, response, observation };
}

function createEvaluationSearchService(repository: MediaRepository, ranker: AiRanker) {
  const disabledSeerr = {
    allowsDescriptiveContent: () => false,
    search: async () => {
      throw new IndependentEvalContractError("seerr_disabled_for_product_evaluation");
    }
  } as unknown as SeerrClient;
  return new SearchService(
    repository,
    disabledSeerr,
    ranker,
    undefined,
    new DeterministicBriefParser(),
    new NoopTasteScout(),
    new DeterministicQueryOptimizer(),
    undefined
  );
}

function countReceivedServiceTiers(details: ProductEvalCaseDetail[]) {
  const counts: Record<string, number> = {};
  for (const detail of details) {
    const tier = detail.aiAssisted.providerDiagnostics?.receivedServiceTier;
    if (!tier) continue;
    counts[tier] = (counts[tier] ?? 0) + 1;
  }
  return counts;
}

function seededBalancedAiFirstCaseIds(caseIds: string[], seed: number) {
  const ordered = [...caseIds].sort((left, right) => {
    const leftKey = createHash("sha256").update(`${seed}\u0000${left}`).digest("hex");
    const rightKey = createHash("sha256").update(`${seed}\u0000${right}`).digest("hex");
    return leftKey.localeCompare(rightKey) || left.localeCompare(right);
  });
  return new Set(ordered.slice(0, Math.floor(ordered.length / 2)));
}

function aggregateRenderedContractIdentity(
  id: string,
  contracts: Array<{
    caseId: string;
    prompt: { id: string; sha256: string };
    response: { id: string; sha256: string };
  }>,
  kind: "prompt" | "response"
) {
  const rendered = contracts
    .map((contract) => ({ caseId: contract.caseId, ...contract[kind] }))
    .sort((left, right) => left.caseId.localeCompare(right.caseId));
  return { id, sha256: sha256Text(JSON.stringify(rendered)) };
}

function hasExpectedServiceTierReadback(details: ProductEvalCaseDetail[], requestedServiceTier: OpenAiServiceTier) {
  if (details.length === 0) return false;
  const expectedServiceTier = requestedServiceTier === "fast" ? "priority" : "default";
  return details.every((detail) =>
    detail.aiAssisted.providerDiagnostics?.receivedServiceTier === expectedServiceTier
  );
}

function aggregateProviderUsage(details: ProductEvalCaseDetail[]) {
  const usage = {
    responsesWithUsage: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0
  };
  for (const detail of details) {
    const provider = detail.aiAssisted.providerDiagnostics;
    if (!provider) continue;
    if (
      provider.inputTokens !== undefined
      || provider.cachedInputTokens !== undefined
      || provider.outputTokens !== undefined
      || provider.reasoningTokens !== undefined
      || provider.totalTokens !== undefined
    ) usage.responsesWithUsage += 1;
    usage.inputTokens += provider.inputTokens ?? 0;
    usage.cachedInputTokens += provider.cachedInputTokens ?? 0;
    usage.outputTokens += provider.outputTokens ?? 0;
    usage.reasoningTokens += provider.reasoningTokens ?? 0;
    usage.totalTokens += provider.totalTokens ?? 0;
  }
  return usage;
}

class RecordingRanker implements AiRanker {
  readonly modelName?: string;
  readonly requestTimeoutMs?: number;
  private lastInvocation?: { result: AiRankerResult; offeredCandidateIds: string[] };

  constructor(private readonly delegate: AiRanker) {
    this.modelName = delegate.modelName;
    this.requestTimeoutMs = delegate.requestTimeoutMs;
  }

  async rank(input: Parameters<AiRanker["rank"]>[0]) {
    const result = await this.delegate.rank(input);
    this.lastInvocation = {
      result,
      offeredCandidateIds: input.candidates.map((candidate) => candidate.id)
    };
    return result;
  }

  takeLastInvocation() {
    const invocation = this.lastInvocation;
    this.lastInvocation = undefined;
    return invocation;
  }
}

function loadProjectEvaluationConfig(configPath: string, workDatabasePath: string): AppConfig {
  const loaded = loadConfig({
    MOODARR_CONFIG_PATH: configPath,
    MOODARR_DATA_DIR: dirname(workDatabasePath),
    MOODARR_DB_PATH: workDatabasePath,
    MOODARR_FIXTURE_MODE: "true",
    MOODARR_REQUIRE_ADMIN_TOKEN: "false",
    AI_PROVIDER: "openai"
  });
  if (loaded.ai.provider !== "openai" || !loaded.ai.openaiApiKey) {
    throw new IndependentEvalContractError("openai_provider_not_configured");
  }
  return {
    ...loaded,
    fixtureMode: false,
    dbPath: workDatabasePath,
    adminToken: undefined,
    requireAdminToken: false,
    adminAutoSession: false,
    plexAuth: { ...loaded.plexAuth, enabled: false },
    plex: { webBaseUrl: loaded.plex.webBaseUrl },
    seerr: { tmdbContentPolicy: "none" },
    ai: {
      ...loaded.ai,
      providerPolicy: "configurable",
      provider: "openai"
    },
    sync: { intervalMinutes: 0, syncSeerr: false },
    reviewQueue: { ...loaded.reviewQueue, captureRawQueries: false },
    knownSecrets: [loaded.ai.openaiApiKey]
  };
}

function resolveJudgmentItems(
  database: DatabaseSync,
  repository: MediaRepository,
  registry: BlindItemRegistryEntryV1[]
) {
  const result = new Map<string, ItemDetail>();
  const refByResolvedItemId = new Map<string, string>();
  for (const entry of registry) {
    const candidateIds = entry.externalId.source === "moodarr"
      ? [entry.externalId.value]
      : (
          database.prepare(
            `SELECT media_item_id
             FROM external_ids
             WHERE source = ? AND value = ?
             ${entry.mediaType ? "AND media_type = ?" : ""}
             ORDER BY media_item_id`
          ).all(...(entry.mediaType
            ? [entry.externalId.source, entry.externalId.value, entry.mediaType]
            : [entry.externalId.source, entry.externalId.value])) as Array<{ media_item_id: string }>
        ).map((row) => row.media_item_id);
    const items = repository.inflateByIds(candidateIds).filter((item) => !entry.mediaType || item.mediaType === entry.mediaType);
    if (items.length === 0) throw new IndependentEvalContractError("unresolved_item_ref", entry.ref);
    if (items.length > 1) throw new IndependentEvalContractError("ambiguous_item_ref", entry.ref);
    const item = items[0]!;
    if (entry.title !== undefined && entry.title !== item.title) throw new IndependentEvalContractError("item_ref_title_mismatch", entry.ref);
    if (entry.year !== undefined && entry.year !== item.year) throw new IndependentEvalContractError("item_ref_year_mismatch", entry.ref);
    if (entry.mediaType !== undefined && entry.mediaType !== item.mediaType) {
      throw new IndependentEvalContractError("item_ref_media_type_mismatch", entry.ref);
    }
    const previousRef = refByResolvedItemId.get(item.id);
    if (previousRef) throw new IndependentEvalContractError("duplicate_resolved_item_ref", `${previousRef},${entry.ref}`);
    refByResolvedItemId.set(item.id, entry.ref);
    result.set(entry.ref, item);
  }
  return result;
}

export function installProductEvaluationNetworkGuard(maxExternalRequests: number) {
  if (productEvaluationNetworkGuardActive) {
    throw new IndependentEvalContractError("product_evaluation_network_guard_already_active");
  }
  validateMaxExternalRequests(maxExternalRequests);
  const originalFetch = globalThis.fetch;
  let restored = false;
  let requests = 0;
  const guardedFetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (url.href !== "https://api.openai.com/v1/responses" || method !== "POST") {
      throw new IndependentEvalContractError("network_call_blocked");
    }
    if (requests >= maxExternalRequests) {
      throw new IndependentEvalContractError("external_request_budget_exceeded");
    }
    requests += 1;
    return originalFetch(input, { ...init, redirect: "error" });
  };
  productEvaluationNetworkGuardActive = true;
  globalThis.fetch = guardedFetch;
  return {
    requestCount: () => requests,
    restore: () => {
      if (restored) return;
      restored = true;
      globalThis.fetch = originalFetch;
      productEvaluationNetworkGuardActive = false;
    }
  };
}

function installStrictTraceMode() {
  const previous = process.env.MOODRANK_TRACE_WRITE;
  process.env.MOODRANK_TRACE_WRITE = "strict";
  return () => {
    if (previous === undefined) delete process.env.MOODRANK_TRACE_WRITE;
    else process.env.MOODRANK_TRACE_WRITE = previous;
  };
}

function assertSchema32(database: DatabaseSync): { count: number } {
  const count = Number((database.prepare("SELECT COUNT(*) AS value FROM schema_migrations").get() as { value: number }).value);
  const migration = database.prepare(
    "SELECT 1 AS value FROM schema_migrations WHERE id = '032_catalog_search_allowlisted_projection'"
  ).get();
  if (count < 32 || !migration) throw new IndependentEvalContractError("work_database_missing_schema_32");
  return { count };
}

const importedPrivateStateTables = [
  "app_users",
  "feel_feedback_events",
  "feel_profile_checkpoints",
  "feel_profile_terms",
  "library_sync_runs",
  "catalog_sync_runs",
  "plex_auth_challenges",
  "preference_feature_weights",
  "preference_profiles",
  "query_review_queue",
  "recommendation_feedback",
  "request_audit",
  "request_creation_operations",
  "requests",
  "search_events",
  "seerr_sync_runs",
  "user_sessions"
] as const;

function clearImportedPrivateState(database: DatabaseSync) {
  database.exec("BEGIN");
  try {
    database.exec(`
      DELETE FROM query_review_queue;
      DELETE FROM feel_profile_checkpoints;
      DELETE FROM feel_profile_terms;
      DELETE FROM preference_feature_weights;
      DELETE FROM feel_feedback_events;
      DELETE FROM recommendation_feedback;
      DELETE FROM recommendation_sessions;
      DELETE FROM search_events;
      DELETE FROM request_creation_operations;
      DELETE FROM request_audit;
      DELETE FROM requests;
      DELETE FROM plex_auth_challenges;
      DELETE FROM user_sessions;
      DELETE FROM preference_profiles;
      DELETE FROM app_users;
      DELETE FROM library_sync_runs;
      DELETE FROM catalog_sync_runs;
      DELETE FROM seerr_sync_runs;
    `);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function clearNonEvidencePrivateState(database: DatabaseSync) {
  database.exec(`
    DELETE FROM query_review_queue;
    DELETE FROM feel_profile_checkpoints;
    DELETE FROM feel_profile_terms;
    DELETE FROM preference_feature_weights;
    DELETE FROM feel_feedback_events;
    DELETE FROM recommendation_feedback;
    DELETE FROM search_events;
    DELETE FROM request_creation_operations;
    DELETE FROM request_audit;
    DELETE FROM requests;
    DELETE FROM plex_auth_challenges;
    DELETE FROM user_sessions;
    DELETE FROM preference_profiles;
    DELETE FROM app_users;
    DELETE FROM library_sync_runs;
    DELETE FROM catalog_sync_runs;
    DELETE FROM seerr_sync_runs;
  `);
}

function assertImportedPrivateStateCleared(database: DatabaseSync) {
  for (const table of importedPrivateStateTables) {
    const count = Number((database.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as { value: number }).value);
    if (count !== 0) throw new IndependentEvalContractError("imported_private_state_not_cleared", table);
  }
  const storedPlexTokens = Number((database.prepare(
    "SELECT COUNT(*) AS value FROM app_users WHERE plex_token IS NOT NULL"
  ).get() as { value: number }).value);
  if (storedPlexTokens !== 0) throw new IndependentEvalContractError("stored_plex_token_retained");
  const attributedSessions = Number((database.prepare(
    "SELECT COUNT(*) AS value FROM recommendation_sessions WHERE auth_user_id IS NOT NULL"
  ).get() as { value: number }).value);
  if (attributedSessions !== 0) throw new IndependentEvalContractError("attributed_recommendation_session_retained");
}

function assertProductEvaluationTraceEvidence(database: DatabaseSync, sessionIds: string[], expectedResultRows: number) {
  if (new Set(sessionIds).size !== sessionIds.length) {
    throw new IndependentEvalContractError("duplicate_product_evaluation_session");
  }
  const placeholders = sessionIds.map(() => "?").join(", ");
  const sessions = database.prepare(
    `SELECT id, trace_schema_version, trace_flags_json
     FROM recommendation_sessions
     WHERE id IN (${placeholders})`
  ).all(...sessionIds) as Array<{ id: string; trace_schema_version: string | null; trace_flags_json: string | null }>;
  if (sessions.length !== sessionIds.length) throw new IndependentEvalContractError("strict_trace_session_missing");
  for (const session of sessions) {
    if (session.trace_schema_version !== moodRankTraceSchemaVersion || !session.trace_flags_json) {
      throw new IndependentEvalContractError("strict_trace_metadata_missing", session.id);
    }
    const flags = JSON.parse(session.trace_flags_json) as { traceWrite?: string };
    if (flags.traceWrite !== "strict") throw new IndependentEvalContractError("strict_trace_mode_not_recorded", session.id);
  }
  const resultState = database.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN score_trace_json IS NOT NULL THEN 1 ELSE 0 END) AS score_traced,
            SUM(CASE WHEN provenance_json IS NOT NULL THEN 1 ELSE 0 END) AS provenance_traced
     FROM recommendation_results
     WHERE session_id IN (${placeholders})`
  ).get(...sessionIds) as { total: number; score_traced: number | null; provenance_traced: number | null };
  if (
    Number(resultState.total) !== expectedResultRows
    || Number(resultState.score_traced ?? 0) !== expectedResultRows
    || Number(resultState.provenance_traced ?? 0) !== expectedResultRows
  ) {
    throw new IndependentEvalContractError("strict_trace_result_evidence_incomplete");
  }
}

function assertInputFile(path: string, code: string) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new IndependentEvalContractError(code);
}

function assertColdDatabase(path: string) {
  if (!existsSync(path)) throw new IndependentEvalContractError("catalog_file_missing");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new IndependentEvalContractError("catalog_file_not_regular");
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecarPath = `${path}${suffix}`;
    if (existsSync(sidecarPath)) {
      throw new IndependentEvalContractError("catalog_snapshot_not_cold", suffix);
    }
  }
}

async function assertSourceDatabaseUnchanged(path: string, expectedSha256: string) {
  assertColdDatabase(path);
  const actualSha256 = `sha256:${await sha256File(path)}`;
  assertColdDatabase(path);
  if (actualSha256 !== expectedSha256) {
    throw new IndependentEvalContractError("source_catalog_changed_during_evaluation");
  }
}

function assertPrivateConfig(path: string) {
  if (!existsSync(path)) throw new IndependentEvalContractError("config_file_missing");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new IndependentEvalContractError("config_file_not_regular");
  if ((stat.mode & 0o777) !== 0o600) throw new IndependentEvalContractError("config_file_mode_not_0600");
}

async function sha256File(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function roundTiming(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));

function currentSourceState(): { commit: string; dirty: boolean | "unknown"; treeSha256: string } {
  let commit = "unknown";
  let dirty: boolean | "unknown" = "unknown";
  try {
    commit = gitOutput(["rev-parse", "HEAD"]).trim();
    dirty = gitOutput(["status", "--porcelain=v1", "--untracked-files=all"]).length > 0;
  } catch {
    commit = "unknown";
    dirty = "unknown";
  }
  try {
    const files = gitOutput(["ls-files", "--cached", "--others", "--exclude-standard", "-z"])
      .split("\u0000")
      .filter(Boolean)
      .sort();
    const hash = createHash("sha256");
    for (const relativePath of files) {
      const absolutePath = resolve(repositoryRoot, relativePath);
      const stat = lstatSync(absolutePath);
      hash.update(relativePath);
      hash.update("\u0000");
      hash.update(stat.isSymbolicLink() ? readlinkSync(absolutePath) : readFileSync(absolutePath));
      hash.update("\u0000");
    }
    return { commit, dirty, treeSha256: `sha256:${hash.digest("hex")}` };
  } catch {
    return { commit, dirty, treeSha256: "unknown" };
  }
}

function gitOutput(args: string[]) {
  return execFileSync("git", ["-C", repositoryRoot, ...args], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"]
  });
}

function assertPrivateOutputOutsideRepository(path: string) {
  const canonicalParent = dirname(canonicalOutputTarget(path));
  const canonicalRepositoryRoot = realpathSync(repositoryRoot);
  const relativePath = relative(canonicalRepositoryRoot, canonicalParent);
  if (relativePath === "" || (!relativePath.startsWith(`..${sep}`) && relativePath !== ".." && !isAbsolute(relativePath))) {
    throw new IndependentEvalContractError("private_output_must_be_outside_repository");
  }
}

function canonicalOutputTarget(path: string) {
  const resolvedPath = resolve(path);
  const resolvedParent = dirname(resolvedPath);
  let existingParent = resolvedParent;
  while (!existsSync(existingParent)) {
    const parent = dirname(existingParent);
    if (parent === existingParent) throw new IndependentEvalContractError("private_output_parent_missing");
    existingParent = parent;
  }
  const canonicalParent = resolve(realpathSync(existingParent), relative(existingParent, resolvedParent));
  return resolve(canonicalParent, relative(resolvedParent, resolvedPath));
}

function validateMaxExternalRequests(value: number) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw new ProductEvalArgumentError("invalid_max_external_requests");
  }
  return value;
}

function writePrivateReport(path: string, report: ProductEvalReport) {
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function main() {
  try {
    const args = parseProductEvalArgs(process.argv.slice(2));
    const plannedExternalRequests = parseBlindCaseSet(readFileSync(args.casesPath, "utf8")).cases.length;
    if (plannedExternalRequests > args.maxExternalRequests) {
      throw new IndependentEvalContractError("external_request_budget_exceeded");
    }
    console.error(JSON.stringify({
      status: "preflight",
      plannedExternalRequests,
      maxExternalRequests: args.maxExternalRequests,
      rankerMaxOutputTokens: args.diagnosticRankerMaxOutputTokens ?? openAiRankerDefaultMaxOutputTokens,
      diagnosticOnly: args.diagnosticRankerTimeoutMs !== undefined
        || args.diagnosticRankerMaxOutputTokens !== undefined
    }));
    const report = await runProductEvaluation(args);
    console.log(JSON.stringify(aggregateSafeProductReport(report), null, 2));
  } catch (error) {
    const code = error instanceof ProductEvalArgumentError || error instanceof IndependentEvalContractError
      ? error.code
      : "product_eval_failed";
    console.error(JSON.stringify({ status: "failed", code }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
