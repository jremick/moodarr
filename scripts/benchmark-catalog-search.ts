import { performance } from "node:perf_hooks";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { NoopRanker } from "../src/server/ai/ranker";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import { buildRecommendationBrief } from "../src/server/recommendation/brief";
import { mergeHardFilters, parseRecommendationIntent } from "../src/server/recommendation/intent";
import { scoreRankIndexedLibrary } from "../src/server/recommendation/rankIndex";
import { retrieveRecommendationCandidates } from "../src/server/recommendation/retrieval";
import { loadConfig } from "../src/server/config";
import type { SearchRequest } from "../src/shared/types";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import {
  benchmarkCasesForProfile,
  evaluateCatalogBenchmarkContract,
  evaluateCatalogBenchmarkCorpusPreflight,
  parseCatalogSearchBenchmarkArgs
} from "./catalog-search-benchmark-contract";

interface TimingSample {
  iteration: number;
  caseId: string;
  query: string;
  retrievalMs: number;
  scoringMs: number;
  totalLocalMs: number;
  engineMs?: number;
  engineResultCount?: number;
  engineStageLatencyMs?: Record<string, number>;
  candidateCount: number;
  scoredItemCount: number;
  resultCount: number;
  topResults: string[];
}

const requestAttemptProbeLimit = 96;
const advisoryThresholds = { localP50Ms: 250, localP95Ms: 750, engineP95Ms: 1000 };
const args = parseCatalogSearchBenchmarkArgs(process.argv.slice(2));
const selectedCases = benchmarkCasesForProfile(args.profile).slice(0, args.limit ?? Number.POSITIVE_INFINITY);
const config = loadConfig();
const db = createDatabase(config.dbPath);
const indexStartedAt = performance.now();
const searchableMediaItemCount = (
  db.prepare("SELECT COUNT(*) AS value FROM media_items WHERE source != 'operational'").get() as { value: number }
).value;
const rawIndexCount = (db.prepare("SELECT COUNT(*) AS value FROM catalog_search_index").get() as { value: number }).value;
const rawFtsIndexCount = (
  db.prepare("SELECT COUNT(*) AS value FROM catalog_search_index_fts").get() as { value: number }
).value;
const rawIndexMembershipHealthy = catalogIndexMembershipMatches(db);
const rawFtsMembershipHealthy = catalogFtsMembershipMatches(db);
const rawIndexHealthy =
  rawIndexCount === searchableMediaItemCount &&
  rawFtsIndexCount === rawIndexCount &&
  rawIndexMembershipHealthy &&
  rawFtsMembershipHealthy;
const repository = new MediaRepository(db);
const startupIndexCount = repository.catalogSearchIndexCount();
const startupFtsIndexCount = (
  db.prepare("SELECT COUNT(*) AS value FROM catalog_search_index_fts").get() as { value: number }
).value;
const startupIndexMembershipHealthy = catalogIndexMembershipMatches(db);
const startupFtsMembershipHealthy = catalogFtsMembershipMatches(db);
const startupIndexHealthy =
  startupIndexCount === searchableMediaItemCount &&
  startupFtsIndexCount === startupIndexCount &&
  startupIndexMembershipHealthy &&
  startupFtsMembershipHealthy;
const indexNeedsManualRebuild = !startupIndexHealthy;
const rebuiltIndexCount = indexNeedsManualRebuild ? repository.rebuildCatalogSearchIndex() : startupIndexCount;
const rebuiltFtsIndexCount = (
  db.prepare("SELECT COUNT(*) AS value FROM catalog_search_index_fts").get() as { value: number }
).value;
const finalIndexMembershipHealthy = catalogIndexMembershipMatches(db);
const finalFtsMembershipHealthy = catalogFtsMembershipMatches(db);
const finalIndexHealthy =
  rebuiltIndexCount === searchableMediaItemCount &&
  rebuiltFtsIndexCount === rebuiltIndexCount &&
  finalIndexMembershipHealthy &&
  finalFtsMembershipHealthy;
const indexBuildMs = performance.now() - indexStartedAt;
const diagnostics = repository.recommendationDiagnostics();
const stats = repository.stats();
const catalogDiagnostics = diagnostics.features.catalog;
if (!catalogDiagnostics) throw new Error("Catalog diagnostics are unavailable for benchmark corpus preflight.");
const requestAttemptProbeIds = repository.catalogRankCandidateIds({ availability: ["unavailable"] }, requestAttemptProbeLimit);
const requestAttemptProbeCount = repository
  .inflateByIds(requestAttemptProbeIds)
  .filter((item) => item.requestAttempt?.available).length;
const corpusPreflight = evaluateCatalogBenchmarkCorpusPreflight(args.profile, {
  totalItems: stats.totalItems,
  catalogOnlyItems: catalogDiagnostics.catalogOnlyItems,
  plexVerifiedItems: catalogDiagnostics.plexVerifiedItems,
  seerrVerifiedItems: catalogDiagnostics.seerrVerifiedItems,
  requestableVerifiedItems: catalogDiagnostics.requestableVerifiedItems,
  requestAttemptProbeCount,
  requestAttemptProbeLimit
});

if (corpusPreflight.status === "fail") {
  console.log(JSON.stringify(
    {
      ...baseReport(),
      sampleCount: 0,
      measuredIterations: 0,
      corpusPreflight,
      validityStatus: {
        corpusPreflight: "fail",
        benchmark: "not_run"
      },
      samples: []
    },
    null,
    2
  ));
  process.exitCode = 1;
  db.close();
} else {
  await runBenchmark();
  db.close();
}

async function runBenchmark() {
  let noRemoteSeerrSearchCalls = 0;
  const seerrClient = {
    allowsDescriptiveContent() {
      return false;
    },
    async search() {
      noRemoteSeerrSearchCalls += 1;
      return [];
    }
  } as unknown as SeerrClient;
  const noRemoteDescriptiveContentAllowed = seerrClient.allowsDescriptiveContent();
  const engine = new RecommendationEngine(repository, seerrClient, new NoopRanker());
  const coldSamples = await collectSamples(1, false);
  const samples = await collectSamples(args.iterations, true);
  const expectedZeroCaseIds = args.profile === "catalog-request-attempt"
    ? selectedCases.filter((testCase) => testCase.expectedResult === "zero").map((testCase) => testCase.id)
    : undefined;
  const contract = evaluateCatalogBenchmarkContract({
    caseIds: selectedCases.map((testCase) => testCase.id),
    expectedZeroCaseIds,
    iterations: args.iterations,
    samples,
    finalIndexHealthy,
    corpusPreflightPassed: corpusPreflight.status === "pass",
    measureEngine: !args.skipEngine,
    noRemoteDescriptiveContentAllowed,
    noRemoteSearchCalls: noRemoteSeerrSearchCalls,
    enforceAdvisoryTargets: args.enforceAdvisoryTargets,
    thresholds: advisoryThresholds
  });

  const retrievalValues = samples.map((sample) => sample.retrievalMs);
  const scoringValues = samples.map((sample) => sample.scoringMs);
  const localValues = samples.map((sample) => sample.totalLocalMs);
  const engineValues = samples.flatMap((sample) => (sample.engineMs === undefined ? [] : [sample.engineMs]));
  const targetRetrievalValues = contract.scoredSamples.map((sample) => sample.retrievalMs);
  const targetScoringValues = contract.scoredSamples.map((sample) => sample.scoringMs);
  const targetLocalValues = contract.scoredSamples.map((sample) => sample.totalLocalMs);
  const targetEngineValues = contract.scoredSamples.flatMap((sample) => (sample.engineMs === undefined ? [] : [sample.engineMs]));

  console.log(JSON.stringify(
    {
      ...baseReport(),
      sampleCount: samples.length,
      measuredIterations: args.iterations,
      corpusPreflight,
      summary: {
        retrieval: summarize(retrievalValues),
        scoring: summarize(scoringValues),
        localRetrievalAndScoring: summarize(localValues),
        engineNoAiNoRemote: engineValues.length > 0 ? summarize(engineValues) : undefined
      },
      coldSummary: summarizeSamples(coldSamples),
      targetEligibleSummary: {
        retrieval: summarize(targetRetrievalValues),
        scoring: summarize(targetScoringValues),
        localRetrievalAndScoring: summarize(targetLocalValues),
        engineNoAiNoRemote: targetEngineValues.length > 0 ? summarize(targetEngineValues) : undefined
      },
      scoringCoverage: contract.scoringCoverage,
      engineCoverage: contract.engineCoverage,
      noRemoteBoundary: contract.noRemoteBoundary,
      validityStatus: contract.validityStatus,
      advisoryTargetStatus: contract.advisoryTargetStatus,
      samples
    },
    null,
    2
  ));

  process.exitCode = contract.exitCode;

  async function collectSamples(iterations: number, alternateOrder: boolean) {
    const collected: TimingSample[] = [];
    for (let iteration = 0; iteration < iterations; iteration += 1) {
      const cases = alternateOrder && iteration % 2 === 1 ? [...selectedCases].reverse() : selectedCases;
      for (const testCase of cases) {
        const request: SearchRequest = {
          query: testCase.query,
          watchContext: testCase.watchContext,
          filters: testCase.filters,
          resultLimit: 10,
          useAi: false
        };
        const intent = parseRecommendationIntent(testCase.query);
        const filters = mergeHardFilters(intent.hardFilters, testCase.filters ?? {});
        const brief = buildRecommendationBrief({ ...request, filters }, intent, filters, testCase.watchContext, 10);

        const retrievalStartedAt = performance.now();
        const retrieved = await retrieveForCase(brief);
        const retrievalMs = performance.now() - retrievalStartedAt;

        const scoringStartedAt = performance.now();
        const scored = scoreRankIndexedLibrary(retrieved, request, testCase.watchContext);
        const scoringMs = performance.now() - scoringStartedAt;

        let engineMs: number | undefined;
        let engineResultCount: number | undefined;
        let engineStageLatencyMs: Record<string, number> | undefined;
        if (!args.skipEngine) {
          const engineStartedAt = performance.now();
          const response = await engine.recommend(request);
          engineMs = performance.now() - engineStartedAt;
          engineResultCount = response.results.length;
          engineStageLatencyMs = response.diagnostics?.stageLatencyMs;
        }

        collected.push({
          iteration: iteration + 1,
          caseId: testCase.id,
          query: testCase.query,
          retrievalMs: round(retrievalMs),
          scoringMs: round(scoringMs),
          totalLocalMs: round(retrievalMs + scoringMs),
          engineMs: engineMs === undefined ? undefined : round(engineMs),
          engineResultCount,
          engineStageLatencyMs,
          candidateCount: retrieved.candidates.length,
          scoredItemCount: scored.results.length,
          resultCount: scored.results.slice(0, 10).length,
          topResults: scored.results.slice(0, 5).map((item) => `${item.title}${item.year ? ` (${item.year})` : ""}`)
        });
      }
    }
    return collected;
  }
}

function retrieveForCase(brief: Parameters<typeof retrieveRecommendationCandidates>[1]) {
  return retrieveRecommendationCandidates(repository, brief);
}

function baseReport() {
  const expectedScoredCases = selectedCases.filter((testCase) => testCase.expectedResult === "scored").length;
  const expectedZeroCases = selectedCases.filter((testCase) => testCase.expectedResult === "zero").length;
  return {
    generatedAt: new Date().toISOString(),
    dbPath: config.dbPath,
    profile: args.profile,
    caseContract: {
      caseCount: selectedCases.length,
      expectationMode: args.profile === "catalog-request-attempt" ? "explicit" : "minimum-80-percent",
      expectedScoredCases: args.profile === "catalog-request-attempt" ? expectedScoredCases : undefined,
      intentionalIsolationZeroCases: args.profile === "catalog-request-attempt" ? expectedZeroCases : undefined
    },
    caseCount: selectedCases.length,
    coldPassExcludedFromTargets: true,
    advisoryTargetsEnforced: args.enforceAdvisoryTargets,
    itemCount: stats.totalItems,
    catalogSearchIndex: {
      beforeStartup: rawIndexCount,
      beforeStartupFts: rawFtsIndexCount,
      healthyBeforeStartup: rawIndexHealthy,
      membershipHealthyBeforeStartup: rawIndexMembershipHealthy,
      ftsMembershipHealthyBeforeStartup: rawFtsMembershipHealthy,
      afterStartup: startupIndexCount,
      afterStartupFts: startupFtsIndexCount,
      healthyAfterStartup: startupIndexHealthy,
      membershipHealthyAfterStartup: startupIndexMembershipHealthy,
      ftsMembershipHealthyAfterStartup: startupFtsMembershipHealthy,
      after: rebuiltIndexCount,
      afterFts: rebuiltFtsIndexCount,
      healthyAfterRepair: finalIndexHealthy,
      membershipHealthyAfterRepair: finalIndexMembershipHealthy,
      ftsMembershipHealthyAfterRepair: finalFtsMembershipHealthy,
      searchableItemCount: searchableMediaItemCount,
      repairedAtStartup: !rawIndexHealthy && !indexNeedsManualRebuild,
      manuallyRebuilt: indexNeedsManualRebuild,
      startupAndRepairMs: round(indexBuildMs)
    },
    catalog: catalogDiagnostics,
    advisoryTarget: {
      localNoAiP50Ms: advisoryThresholds.localP50Ms,
      localNoAiP95Ms: advisoryThresholds.localP95Ms,
      engineNoAiNoRemoteP95Ms: advisoryThresholds.engineP95Ms
    }
  };
}

function summarize(values: number[]) {
  if (values.length === 0) return undefined;
  return {
    min: round(Math.min(...values)),
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    max: round(Math.max(...values))
  };
}

function summarizeSamples(values: TimingSample[]) {
  const engine = values.flatMap((sample) => (sample.engineMs === undefined ? [] : [sample.engineMs]));
  return {
    retrieval: summarize(values.map((sample) => sample.retrievalMs)),
    scoring: summarize(values.map((sample) => sample.scoringMs)),
    localRetrievalAndScoring: summarize(values.map((sample) => sample.totalLocalMs)),
    engineNoAiNoRemote: engine.length > 0 ? summarize(engine) : undefined
  };
}

function catalogIndexMembershipMatches(database: ReturnType<typeof createDatabase>) {
  return !database
    .prepare(
      `SELECT 1 AS mismatch
       WHERE EXISTS (
         SELECT id AS media_item_id FROM media_items WHERE source != 'operational'
         EXCEPT
         SELECT media_item_id FROM catalog_search_index
       )
       OR EXISTS (
         SELECT media_item_id FROM catalog_search_index
         EXCEPT
         SELECT id AS media_item_id FROM media_items WHERE source != 'operational'
       )`
    )
    .get();
}

function catalogFtsMembershipMatches(database: ReturnType<typeof createDatabase>) {
  return !database
    .prepare(
      `SELECT 1 AS mismatch
       WHERE EXISTS (
         SELECT media_item_id FROM catalog_search_index
         EXCEPT
         SELECT media_item_id FROM catalog_search_index_fts
       )
       OR EXISTS (
         SELECT media_item_id FROM catalog_search_index_fts
         EXCEPT
         SELECT media_item_id FROM catalog_search_index
       )`
    )
    .get();
}

function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index];
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
