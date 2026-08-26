import { createHash } from "node:crypto";
import { createReadStream, existsSync, lstatSync, readFileSync, readlinkSync, statSync, writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import type { ItemDetail, SearchRequest } from "../src/shared/types";
import { optimizeQueryDeterministically } from "../src/server/ai/queryOptimizer";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { buildRecommendationBrief } from "../src/server/recommendation/brief";
import { applyExplicitRequestAttemptScope, mergeHardFilters, parseRecommendationIntent } from "../src/server/recommendation/intent";
import { scoreRankIndexedLibrary } from "../src/server/recommendation/rankIndex";
import { retrieveRecommendationCandidates } from "../src/server/recommendation/retrieval";
import { recommendationEngineVersion } from "../src/server/recommendation/version";
import {
  IndependentEvalContractError,
  aggregateIndependentEvalMetrics,
  calculateCaseObservation,
  defaultBootstrapSamples,
  defaultIndependentEvalSeed,
  evaluationInputDigest,
  evidenceStatusForCaseCount,
  evaluateConstraintSlate,
  parseBlindCaseSet,
  parseBlindJudgmentSet,
  sha256Text,
  validateBlindEvaluationInputs,
  type BlindCaseJudgmentV1,
  type BlindCaseSetV1,
  type BlindItemRegistryEntryV1,
  type IndependentEvalCaseObservation
} from "./moodrank-independent-eval-contract";

export interface IndependentEvalArgs {
  casesPath: string;
  judgmentsPath: string;
  catalogPath: string;
  outputPath?: string;
  seed: number;
}

export interface IndependentEvalCaseDetail {
  caseId: string;
  judgedRanks: Array<{ itemRef: string; rank: number; score: number }>;
  preRerankJudgedItemRefs: string[];
  metrics: IndependentEvalCaseObservation;
  constraintChecks: Array<{ id: string; expected: "pass" | "fail" | "unknown"; observed: "pass" | "fail" | "unknown" }>;
}

export interface IndependentEvalReport {
  schemaVersion: "moodrank-independent-eval-report-v1";
  status: "completed";
  evidenceStatus: ReturnType<typeof evidenceStatusForCaseCount>;
  corpusId: string;
  judgmentVersion: string;
  catalogSnapshotId: string;
  evaluatedCases: number;
  evaluationStages: {
    preRerank: "retrieved_candidates";
    ranked: "deterministic_rank_index_slate";
    productResponseParity: false;
  };
  metrics: ReturnType<typeof aggregateIndependentEvalMetrics>;
  provenance: {
    engineVersion: string;
    sourceCommit: string;
    sourceDirty: boolean | "unknown";
    sourceTreeSha256: string;
    nodeVersion: string;
    platform: NodeJS.Platform;
    architecture: string;
    seed: number;
    bootstrapSamples: number;
    contentHashes: {
      cases: string;
      judgments: string;
      catalog: string;
      evaluationInput: string;
    };
    executionPolicy: {
      databaseReadOnly: true;
      sqliteQueryOnly: true;
      startupRepairsDisabled: true;
      aiDisabled: true;
      providerEmbeddingsDisabled: true;
      personalizationDisabled: true;
      globalFetchBlocked: true;
      networkClientsInstantiated: false;
      recommendationSessionWritesDisabled: true;
    };
    generatedAt: string;
    durationMs: number;
  };
  details?: IndependentEvalCaseDetail[];
}

export class IndependentEvalArgumentError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "IndependentEvalArgumentError";
  }
}

let evaluationFetchGuardActive = false;

export function installIndependentEvaluationFetchGuard() {
  if (evaluationFetchGuardActive) throw new IndependentEvalContractError("concurrent_evaluation_not_supported");
  const originalFetch = globalThis.fetch;
  let restored = false;
  evaluationFetchGuardActive = true;
  globalThis.fetch = async () => {
    throw new IndependentEvalContractError("network_call_blocked");
  };
  return () => {
    if (restored) return;
    restored = true;
    globalThis.fetch = originalFetch;
    evaluationFetchGuardActive = false;
  };
}

export function parseIndependentEvalArgs(values: string[]): IndependentEvalArgs {
  const parsed: Partial<IndependentEvalArgs> = { seed: defaultIndependentEvalSeed };
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index]!;
    if (!["--cases", "--judgments", "--catalog", "--output", "--seed"].includes(key)) {
      throw new IndependentEvalArgumentError("unknown_option");
    }
    if (seen.has(key)) throw new IndependentEvalArgumentError("duplicate_option");
    seen.add(key);
    const value = values[++index];
    if (value === undefined || value.startsWith("--")) throw new IndependentEvalArgumentError("missing_option_value");
    if (key === "--cases") parsed.casesPath = resolve(value);
    else if (key === "--judgments") parsed.judgmentsPath = resolve(value);
    else if (key === "--catalog") parsed.catalogPath = resolve(value);
    else if (key === "--output") parsed.outputPath = resolve(value);
    else {
      const seed = Number(value);
      if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new IndependentEvalArgumentError("invalid_seed");
      parsed.seed = seed;
    }
  }
  if (!parsed.casesPath || !parsed.judgmentsPath || !parsed.catalogPath) {
    throw new IndependentEvalArgumentError("missing_required_option");
  }
  return parsed as IndependentEvalArgs;
}

export async function runIndependentEvaluation(args: IndependentEvalArgs): Promise<IndependentEvalReport> {
  const startedAt = performance.now();
  assertInputFile(args.casesPath, "cases_file_missing");
  assertInputFile(args.judgmentsPath, "judgments_file_missing");
  if (args.outputPath && existsSync(args.outputPath)) throw new IndependentEvalContractError("output_file_already_exists");
  assertColdCatalogSnapshot(args.catalogPath);

  const casesRaw = readFileSync(args.casesPath, "utf8");
  const judgmentsRaw = readFileSync(args.judgmentsPath, "utf8");
  const caseSet = parseBlindCaseSet(casesRaw);
  const judgmentSet = parseBlindJudgmentSet(judgmentsRaw);
  validateBlindEvaluationInputs(caseSet, judgmentSet);
  const catalogSha256 = `sha256:${await sha256File(args.catalogPath)}`;
  if (caseSet.catalogSnapshotId !== catalogSha256) throw new IndependentEvalContractError("catalog_snapshot_hash_mismatch");
  const sourceState = currentSourceState();

  const immutableCatalogUri = `${pathToFileURL(args.catalogPath).href}?immutable=1`;
  const db = new DatabaseSync(immutableCatalogUri, {
    readOnly: true,
    timeout: 5_000,
    enableForeignKeyConstraints: true,
    allowExtension: false
  });
  let restoreFetch: (() => void) | undefined;
  try {
    db.exec("PRAGMA query_only = ON");
    const queryOnly = db.prepare("PRAGMA query_only").get() as { query_only: number };
    if (queryOnly.query_only !== 1) throw new IndependentEvalContractError("sqlite_query_only_not_enabled");
    const repository = new MediaRepository(db, { runStartupRepairs: false });
    restoreFetch = installIndependentEvaluationFetchGuard();
    const itemByRef = resolveJudgmentItems(db, repository, judgmentSet.items);
    const itemIdByRef = new Map([...itemByRef].map(([itemRef, item]) => [itemRef, item.id]));
    const refByItemId = new Map([...itemByRef].map(([itemRef, item]) => [item.id, itemRef]));
    const judgmentsByCaseId = new Map(judgmentSet.cases.map((judgment) => [judgment.caseId, judgment]));
    const observations: IndependentEvalCaseObservation[] = [];
    const details: IndependentEvalCaseDetail[] = [];
    for (const testCase of caseSet.cases) {
      const judgment = judgmentsByCaseId.get(testCase.id)!;
      const evaluated = await evaluateCase(repository, testCase, judgment, itemIdByRef);
      observations.push(evaluated.observation);
      details.push({
        caseId: testCase.id,
        judgedRanks: evaluated.rankedItems.flatMap((item, index) => {
          const itemRef = refByItemId.get(item.id);
          return itemRef ? [{ itemRef, rank: index + 1, score: item.score }] : [];
        }),
        preRerankJudgedItemRefs: evaluated.preRerankItemIds.flatMap((itemId) => {
          const itemRef = refByItemId.get(itemId);
          return itemRef ? [itemRef] : [];
        }),
        metrics: evaluated.observation,
        constraintChecks: evaluated.constraintChecks
      });
    }

    const casesSha256 = sha256Text(casesRaw);
    const judgmentsSha256 = sha256Text(judgmentsRaw);
    const contentHashes = {
      cases: casesSha256,
      judgments: judgmentsSha256,
      catalog: catalogSha256,
      evaluationInput: evaluationInputDigest({
        casesSha256,
        judgmentsSha256,
        catalogSha256,
        engineVersion: recommendationEngineVersion,
        sourceCommit: sourceState.commit,
        sourceDirty: sourceState.dirty,
        sourceTreeSha256: sourceState.treeSha256,
        seed: args.seed
      })
    };
    const report: IndependentEvalReport = {
      schemaVersion: "moodrank-independent-eval-report-v1",
      status: "completed",
      evidenceStatus: evidenceStatusForCaseCount(observations.length),
      corpusId: caseSet.corpusId,
      judgmentVersion: judgmentSet.judgmentVersion,
      catalogSnapshotId: caseSet.catalogSnapshotId,
      evaluatedCases: observations.length,
      evaluationStages: {
        preRerank: "retrieved_candidates",
        ranked: "deterministic_rank_index_slate",
        productResponseParity: false
      },
      metrics: aggregateIndependentEvalMetrics(observations, args.seed),
      provenance: {
        engineVersion: recommendationEngineVersion,
        sourceCommit: sourceState.commit,
        sourceDirty: sourceState.dirty,
        sourceTreeSha256: sourceState.treeSha256,
        nodeVersion: process.version,
        platform: process.platform,
        architecture: process.arch,
        seed: args.seed,
        bootstrapSamples: defaultBootstrapSamples,
        contentHashes,
        executionPolicy: {
          databaseReadOnly: true,
          sqliteQueryOnly: true,
          startupRepairsDisabled: true,
          aiDisabled: true,
          providerEmbeddingsDisabled: true,
          personalizationDisabled: true,
          globalFetchBlocked: true,
          networkClientsInstantiated: false,
          recommendationSessionWritesDisabled: true
        },
        generatedAt: new Date().toISOString(),
        durationMs: Math.round((performance.now() - startedAt) * 1_000) / 1_000
      },
      ...(args.outputPath ? { details } : {})
    };
    if (args.outputPath) writePrivateReport(args.outputPath, report);
    return report;
  } finally {
    restoreFetch?.();
    db.close();
  }
}

export function aggregateSafeReport(report: IndependentEvalReport) {
  const aggregate: IndependentEvalReport = { ...report };
  delete aggregate.details;
  return aggregate;
}

async function evaluateCase(
  repository: MediaRepository,
  testCase: BlindCaseSetV1["cases"][number],
  judgment: BlindCaseJudgmentV1,
  itemIdByRef: Map<string, string>
) {
  const optimizedQuery = optimizeQueryDeterministically({
    query: testCase.query,
    filters: testCase.filters,
    watchContext: testCase.watchContext
  });
  const parsedIntent = parseRecommendationIntent(optimizedQuery);
  const filters = mergeHardFilters(parsedIntent.hardFilters, testCase.filters ?? {});
  const intent = applyExplicitRequestAttemptScope(parsedIntent, filters);
  const request: SearchRequest = {
    query: optimizedQuery,
    filters,
    useAi: false,
    resultLimit: testCase.resultLimit,
    watchContext: testCase.watchContext
  };
  const brief = buildRecommendationBrief(request, intent, filters, testCase.watchContext, testCase.resultLimit);
  const retrievalStartedAt = performance.now();
  const retrieved = await retrieveRecommendationCandidates(repository, brief, undefined, { backfillProviderEmbeddings: false });
  const retrievalMs = performance.now() - retrievalStartedAt;
  const scoringStartedAt = performance.now();
  const scored = scoreRankIndexedLibrary(retrieved, request, testCase.watchContext);
  const scoringMs = performance.now() - scoringStartedAt;
  const rankedItems = scored.results.slice(0, testCase.resultLimit);
  const observation = calculateCaseObservation({
    caseId: testCase.id,
    judgment,
    itemIdByRef,
    preRerankItemIds: retrieved.candidates.map((item) => item.id),
    rankedItems,
    retrievalMs,
    scoringMs
  });
  const constraintChecks = judgment.constraintChecks.map((check) => {
    const observed = evaluateConstraintSlate(rankedItems.slice(0, check.resultCutoff), check.filters);
    return { id: check.id, expected: check.expected, observed };
  });
  return {
    observation,
    rankedItems,
    preRerankItemIds: retrieved.candidates.map((item) => item.id),
    constraintChecks
  };
}

function resolveJudgmentItems(
  db: DatabaseSync,
  repository: MediaRepository,
  registry: BlindItemRegistryEntryV1[]
) {
  const result = new Map<string, ItemDetail>();
  const refByResolvedItemId = new Map<string, string>();
  for (const entry of registry) {
    const candidateIds = entry.externalId.source === "moodarr"
      ? [entry.externalId.value]
      : (
          db.prepare(
            `SELECT media_item_id
             FROM external_ids
             WHERE source = ? AND value = ?
             ${entry.mediaType ? "AND media_type = ?" : ""}
             ORDER BY media_item_id`
          ).all(...(entry.mediaType ? [entry.externalId.source, entry.externalId.value, entry.mediaType] : [entry.externalId.source, entry.externalId.value])) as Array<{ media_item_id: string }>
        ).map((row) => row.media_item_id);
    const items = repository.inflateByIds(candidateIds).filter((item) => !entry.mediaType || item.mediaType === entry.mediaType);
    if (items.length === 0) throw new IndependentEvalContractError("unresolved_item_ref", entry.ref);
    if (items.length > 1) throw new IndependentEvalContractError("ambiguous_item_ref", entry.ref);
    const item = items[0]!;
    if (entry.title !== undefined && entry.title !== item.title) throw new IndependentEvalContractError("item_ref_title_mismatch", entry.ref);
    if (entry.year !== undefined && entry.year !== item.year) throw new IndependentEvalContractError("item_ref_year_mismatch", entry.ref);
    if (entry.mediaType !== undefined && entry.mediaType !== item.mediaType) throw new IndependentEvalContractError("item_ref_media_type_mismatch", entry.ref);
    const previousRef = refByResolvedItemId.get(item.id);
    if (previousRef) throw new IndependentEvalContractError("duplicate_resolved_item_ref", `${previousRef},${entry.ref}`);
    refByResolvedItemId.set(item.id, entry.ref);
    result.set(entry.ref, item);
  }
  return result;
}

function assertInputFile(path: string, code: string) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new IndependentEvalContractError(code);
}

function assertColdCatalogSnapshot(path: string) {
  assertInputFile(path, "catalog_file_missing");
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecarPath = `${path}${suffix}`;
    if (existsSync(sidecarPath) && statSync(sidecarPath).size > 0) {
      throw new IndependentEvalContractError("catalog_snapshot_not_cold", suffix);
    }
  }
}

async function sha256File(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
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

function writePrivateReport(path: string, report: IndependentEvalReport) {
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
}

async function main() {
  try {
    const args = parseIndependentEvalArgs(process.argv.slice(2));
    const report = await runIndependentEvaluation(args);
    console.log(JSON.stringify(aggregateSafeReport(report), null, 2));
  } catch (error) {
    const code = error instanceof IndependentEvalArgumentError || error instanceof IndependentEvalContractError ? error.code : "independent_eval_failed";
    console.error(JSON.stringify({ status: "failed", code }));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
