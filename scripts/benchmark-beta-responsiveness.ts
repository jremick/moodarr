import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { seerrSyncCountSource } from "../src/server/jobs/syncRunner";

const schemaVersion = "moodarr-beta-responsiveness-v4";
const expectedCpuLimit = 2_000_000_000;
const expectedMemoryBytes = 2 * 1024 * 1024 * 1024;
const expectedPidLimit = 128;
const expectedHealthcheckIntervalNs = 30_000_000_000;
const expectedHealthcheckTimeoutNs = 15_000_000_000;
const expectedHealthcheckStartPeriodNs = 20_000_000_000;
const expectedHealthcheckRetries = 3;
const expectedHealthcheckTest = [
  "CMD",
  "/nodejs/bin/node",
  "-e",
  "fetch('http://127.0.0.1:4401/api/health').then(async(r)=>{const h=await r.json();process.exit(r.ok&&h.ok===true&&h.ready===true?0:1)}).catch(()=>process.exit(1))"
] as const;
const minimumCatalogFloor = 80_000;
const minimumHealthSamples = 100;
const minimumSearchSamples = 20;
const minimumDiagnosticsSamples = 5;
const minimumPhaseHealthSamples = 20;
const healthP99LimitMs = 250;
const searchP95LimitMs = 5_000;
const overallTimeoutMs = 30 * 60_000;
const maximumLogBytes = 8 * 1024 * 1024;

const benchmarkQueries = [
  "feel-good comedy already in Plex",
  "requestable gentle fantasy under two hours not already available",
  "bleak mystery but not horror",
  "background sitcom episode under 30 minutes",
  "weird slow-burn science fiction"
] as const;

const aiModeSchema = z.enum(["none", "openai"]);
const syncStageSchema = z.enum([
  "starting",
  "fetching_plex",
  "ingesting_plex",
  "finalizing_plex",
  "fetching_seerr",
  "ingesting_seerr",
  "warming_embeddings"
]);
const measuredSyncStages = [
  "fetching_plex",
  "ingesting_plex",
  "finalizing_plex",
  "fetching_seerr",
  "ingesting_seerr",
  "warming_embeddings"
] as const;
const timestampSchema = z.string().refine((value) => Number.isFinite(Date.parse(value)));

const syncStageDurationsSchema = z.object({
  fetching_plex: z.number().nonnegative().optional(),
  ingesting_plex: z.number().nonnegative().optional(),
  finalizing_plex: z.number().nonnegative().optional(),
  fetching_seerr: z.number().nonnegative().optional(),
  ingesting_seerr: z.number().nonnegative().optional(),
  warming_embeddings: z.number().nonnegative().optional()
}).strict();

const embeddingStatusSchema = z.object({
  configured: z.boolean(),
  attempted: z.number().int().nonnegative(),
  embedded: z.number().int().nonnegative(),
  compatibleCount: z.number().int().nonnegative().optional(),
  staleCount: z.number().int().nonnegative().optional(),
  hasMore: z.boolean(),
  error: z.string().optional()
}).passthrough();

const syncCompletionSchema = z.object({
  ok: z.boolean(),
  plexItems: z.number().int().nonnegative().optional(),
  plexMediaItems: z.number().int().nonnegative().optional(),
  seerrItems: z.number().int().nonnegative().optional(),
  seerrMediaItems: z.number().int().nonnegative().optional(),
  providerEmbeddings: embeddingStatusSchema.optional(),
  error: z.string().optional(),
  startedAt: timestampSchema,
  finishedAt: timestampSchema,
  durationMs: z.number().nonnegative(),
  stageDurationsMs: syncStageDurationsSchema
}).passthrough();

const syncRunSummarySchema = z.object({
  source: z.string(),
  status: z.string(),
  itemCount: z.number().int().nonnegative()
}).passthrough();

const syncStatusSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.number(),
  syncSeerr: z.boolean(),
  running: z.boolean(),
  worker: z.object({
    mode: z.enum(["worker", "inline"]),
    ready: z.boolean(),
    running: z.boolean(),
    closed: z.boolean(),
    workerCount: z.number().int().nonnegative()
  }).optional(),
  progress: z.object({
    stage: syncStageSchema,
    startedAt: timestampSchema,
    updatedAt: timestampSchema
  }).passthrough().optional(),
  lastResult: syncCompletionSchema.optional(),
  history: z.object({
    library: z.array(syncRunSummarySchema),
    seerr: z.array(syncRunSummarySchema)
  }).passthrough().optional()
}).passthrough();

const healthSchema = z.object({
  ok: z.literal(true),
  fixtureMode: z.literal(false),
  version: z.string(),
  revision: z.string(),
  database: z.literal("ok"),
  policies: z.object({
    aiProvider: z.enum(["none", "configurable"]),
    tmdbContent: z.enum(["none", "configurable"])
  }),
  search: z.object({
    mode: z.enum(["worker", "inline"]),
    ready: z.literal(true),
    closed: z.literal(false),
    workerCount: z.number().int().positive()
  }).passthrough(),
  sync: z.object({
    mode: z.enum(["worker", "inline"]),
    ready: z.literal(true),
    closed: z.literal(false),
    workerCount: z.number().int().positive()
  }).passthrough()
}).passthrough();

const configStatusSchema = z.object({
  fixtureMode: z.literal(false),
  plex: z.object({ configured: z.boolean() }).passthrough(),
  seerr: z.object({ configured: z.boolean(), tmdbContentPolicy: z.enum(["none", "configurable"]) }).passthrough(),
  ai: z.object({ providerPolicy: z.enum(["none", "configurable"]), provider: z.enum(["none", "openai"]), configured: z.boolean() }).passthrough(),
  admin: z.object({ authRequired: z.boolean(), configured: z.boolean(), autoSession: z.boolean() }).passthrough(),
  runtime: z.object({ syncIntervalMinutes: z.number(), syncSeerr: z.boolean() }).passthrough()
}).passthrough();

const libraryStatsSchema = z.object({
  totalItems: z.number().int().nonnegative(),
  plexItems: z.number().int().nonnegative(),
  seerrItems: z.number().int().nonnegative(),
  alreadyRequested: z.number().int().nonnegative(),
  movies: z.number().int().nonnegative(),
  tv: z.number().int().nonnegative()
}).passthrough();

const catalogSourceEvidenceSchema = z.object({
  activeSourceRecords: z.number().int().nonnegative(),
  identitySha256: z.string().regex(/^[0-9a-f]{64}$/)
}).strict();

const syncAcceptedSchema = z.object({
  accepted: z.literal(true),
  running: z.literal(true),
  startedAt: timestampSchema
}).passthrough();

const searchResponseSchema = z.object({
  query: z.string().min(1),
  optimizedQuery: z.string().min(1),
  usedAi: z.literal(false),
  summary: z.string(),
  resultLimit: z.literal(20),
  diagnostics: z.object({
    engineVersion: z.string().min(1),
    seerrAugmented: z.boolean(),
    latencyMs: z.number().nonnegative()
  }),
  results: z.array(z.object({ id: z.string().min(1), title: z.string().min(1) })).min(1)
});
const diagnosticsResponseSchema = z.object({
  engineVersion: z.string().min(1),
  sessions: z.object({ total: z.number().int().nonnegative(), withAi: z.number().int().nonnegative() }),
  features: z.object({
    mediaFeatureCount: z.number().int().nonnegative(),
    providerEmbeddingCount: z.number().int().nonnegative(),
    embeddingModels: z.array(z.object({ provider: z.string(), model: z.string(), count: z.number().int().nonnegative() }))
  })
});
const dockerStringArraySchema = z.preprocess((value) => value === null ? [] : value, z.array(z.string()));

const containerObservationSchema = z.object({
  containerId: z.string().min(1),
  imageRef: z.string(),
  imageId: z.string(),
  user: z.string(),
  running: z.boolean(),
  startedAt: timestampSchema,
  restartCount: z.number().int().nonnegative(),
  oomKilled: z.boolean(),
  cpuLimit: z.number().int().nonnegative(),
  memoryBytes: z.number().int().nonnegative(),
  pidsLimit: z.number().int(),
  memorySwapBytes: z.number().int(),
  initEnabled: z.boolean(),
  readOnly: z.boolean(),
  privileged: z.boolean(),
  capAdd: dockerStringArraySchema,
  capDrop: dockerStringArraySchema,
  securityOpt: dockerStringArraySchema,
  tmpfs: z.record(z.string(), z.string()),
  portBindings: z.record(z.string(), z.array(z.object({ HostIp: z.string(), HostPort: z.string() }))),
  mounts: z.array(z.object({ type: z.string(), name: z.string(), destination: z.string(), rw: z.boolean() })),
  disposableLabel: z.string().nullable(),
  versionLabel: z.string().nullable(),
  revisionLabel: z.string().nullable(),
  aiProviderPolicyLabel: z.string().nullable(),
  tmdbContentPolicyLabel: z.string().nullable(),
  architecture: z.string(),
  imageOperatingSystem: z.string(),
  daemonArchitecture: z.string(),
  daemonOperatingSystem: z.string(),
  localDockerDaemon: z.boolean(),
  volumeDisposableLabel: z.string().nullable(),
  volumeExclusiveToContainer: z.boolean(),
  healthStatus: z.string().nullable(),
  healthFailingStreak: z.number().int().nonnegative(),
  healthcheckTest: z.array(z.string()),
  healthcheckIntervalNs: z.number().int().positive(),
  healthcheckTimeoutNs: z.number().int().positive(),
  healthcheckStartPeriodNs: z.number().int().nonnegative(),
  healthcheckRetries: z.number().int().positive(),
  healthChecks: z.array(z.object({ startedAt: timestampSchema, exitCode: z.number().int() }))
});
const dockerHealthSnapshotSchema = z.object({
  status: z.string().nullable(),
  failingStreak: z.number().int().nonnegative(),
  checks: z.array(z.object({ startedAt: timestampSchema, exitCode: z.number().int() }))
});

interface HarnessObservation {
  revision: string;
  scriptSha256: string;
  clean: boolean;
}

type DockerHealthSnapshot = z.infer<typeof dockerHealthSnapshotSchema>;

export interface BenchmarkOptions {
  baseUrl: string;
  container: string;
  dataVolume: string;
  candidateDigest: string;
  expectedRevision: string;
  expectedVersion: string;
  catalogLabel: string;
  minimumCatalogItems: number;
  aiMode: z.infer<typeof aiModeSchema>;
  adminToken: string;
  confirmedDisposableData: boolean;
  confirmedExternalProcessing: boolean;
}

export type ProbeErrorCategory = "timeout" | "network" | "invalid_json" | "contract" | `http_${number}`;

export interface ProbeSample {
  offsetMs: number;
  latencyMs: number;
  statusCode: number;
  ok: boolean;
  errorCategory?: ProbeErrorCategory;
  stage?: z.infer<typeof syncStageSchema>;
  diagnosticsActive?: boolean;
}

export interface LatencySummary {
  count: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export type ContainerObservation = z.infer<typeof containerObservationSchema>;

export interface LogObservation {
  bytesScanned: number;
  sqliteBusyCount: number;
  server5xxCount: number;
  oomMarkerCount: number;
  fatalMarkerCount: number;
}

export interface BenchmarkCheck {
  code: string;
  status: "passed" | "failed" | "incomplete";
}

export interface BenchmarkReport {
  schemaVersion: typeof schemaVersion;
  aiMode: z.infer<typeof aiModeSchema>;
  status: "passed" | "failed" | "incomplete";
  startedAt: string;
  finishedAt: string;
  candidate: {
    digest: string;
    expectedRevision: string;
    expectedVersion: string;
    healthRevision: string;
    healthVersion: string;
    aiProviderPolicy: "none" | "configurable";
    tmdbContentPolicy: "none" | "configurable";
    harnessRevision: string;
    harnessSha256: string;
  };
  environment: {
    catalogLabelSha256: string;
    originClass: "loopback";
    architecture: string;
    operatingSystem: string;
    localDockerDaemon: boolean;
    cpuLimit: number;
    memoryMiB: number;
    pidLimit: number;
    readOnlyRoot: boolean;
    imageDigestMatched: boolean;
    disposableVolumeVerified: boolean;
    disposableDataConfirmed: boolean;
    externalProcessingConfirmed: boolean;
  };
  catalog: {
    minimumItems: number;
    before: CatalogCounts;
    after: CatalogCounts;
  };
  workload: {
    querySetSha256: string;
    queryCount: number;
    sync: {
      durationMs: number;
      plexItems: number;
      plexMediaItems: number;
      seerrItems: number;
      seerrMediaItems: number;
      baselineSeerrItems?: number;
      stageDurationsMs: Record<string, number>;
      observedStages: string[];
      embedding: {
        configured: boolean;
        attempted: number;
        embedded: number;
        compatibleCount?: number;
        staleCount?: number;
        hasMore: boolean;
        errorPresent: boolean;
      };
    };
  };
  thresholds: {
    healthP99Ms: number;
    searchP95Ms: number;
    minimumHealthSamples: number;
    minimumSearchSamples: number;
    minimumDiagnosticsSamples: number;
    minimumPhaseHealthSamples: number;
    percentileMethod: "nearest-rank";
  };
  metrics: {
    health?: LatencySummary;
    healthDuringEmbedding?: LatencySummary;
    healthDuringDiagnostics?: LatencySummary;
    search?: LatencySummary;
    diagnostics?: LatencySummary;
    errors: Record<string, number>;
  };
  observability: {
    container: {
      restartCountBefore: number;
      restartCountAfter: number;
      startedAtChanged: boolean;
      oomKilled: boolean;
      healthStatusBefore: string | null;
      healthStatusAfter: string | null;
      observedFailedHealthChecksDuringRun: number;
      unhealthyDockerStateObservations: number;
    };
    logs: LogObservation;
  };
  checks: BenchmarkCheck[];
  failures: string[];
  incompleteReasons: string[];
  samples: {
    health: ProbeSample[];
    search: ProbeSample[];
    diagnostics: ProbeSample[];
  };
}

interface CatalogCounts {
  totalItems: number;
  activeCatalogSourceRecords: number;
  plexItems: number;
  seerrItems: number;
  seerrRequestedItems: number;
  movies: number;
  tv: number;
}

export interface BenchmarkState {
  done: boolean;
  syncActive: boolean;
  stage?: z.infer<typeof syncStageSchema>;
  diagnosticsActive: boolean;
  observedStages: Set<string>;
}

export interface BenchmarkDependencies {
  fetch: typeof fetch;
  inspectHarnessSource: () => HarnessObservation;
  inspectContainer: (name: string) => ContainerObservation;
  inspectContainerHealth: (name: string) => DockerHealthSnapshot;
  readContainerLogs: (name: string, since: string) => LogObservation;
  monotonicNow: () => number;
  wallClockNow: () => Date;
  sleep: (ms: number, signal: AbortSignal) => Promise<void>;
}

export const defaultBenchmarkDependencies: BenchmarkDependencies = {
  fetch,
  inspectHarnessSource,
  inspectContainer,
  inspectContainerHealth,
  readContainerLogs,
  monotonicNow: () => performance.now(),
  wallClockNow: () => new Date(),
  sleep: async (ms, signal) => {
    try {
      await delay(ms, undefined, { signal });
    } catch (error) {
      if (!signal.aborted) throw error;
    }
  }
};

export class IncompleteBenchmarkError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "IncompleteBenchmarkError";
  }
}

export function parseBenchmarkArgs(values: string[], env: NodeJS.ProcessEnv = process.env): BenchmarkOptions {
  const parsed = new Map<string, string>();
  const flags = new Set<string>();
  const valueOptions = new Set([
    "--base-url",
    "--container",
    "--data-volume",
    "--candidate-digest",
    "--expected-revision",
    "--expected-version",
    "--catalog-label",
    "--min-catalog-items",
    "--ai-mode"
  ]);
  const flagOptions = new Set(["--confirm-disposable-data", "--confirm-external-processing"]);

  for (let index = 0; index < values.length; index += 1) {
    const key = values[index]!;
    if (key.toLowerCase().includes("token")) throw new IncompleteBenchmarkError("token_cli_argument_rejected");
    if (flagOptions.has(key)) {
      if (flags.has(key)) throw new IncompleteBenchmarkError("duplicate_option");
      flags.add(key);
      continue;
    }
    if (!valueOptions.has(key)) throw new IncompleteBenchmarkError("unknown_option");
    const value = values[++index];
    if (!value || value.startsWith("--")) throw new IncompleteBenchmarkError("missing_option_value");
    if (parsed.has(key)) throw new IncompleteBenchmarkError("duplicate_option");
    parsed.set(key, value);
  }

  const baseUrl = parsed.get("--base-url");
  const container = parsed.get("--container");
  const dataVolume = parsed.get("--data-volume");
  const candidateDigest = parsed.get("--candidate-digest");
  const expectedRevision = parsed.get("--expected-revision");
  const expectedVersion = parsed.get("--expected-version");
  const catalogLabel = parsed.get("--catalog-label");
  const minimumCatalogItems = Number(parsed.get("--min-catalog-items"));
  const parsedAiMode = parsed.get("--ai-mode");
  const adminToken = env.MOODARR_BENCH_ADMIN_TOKEN;

  if (!baseUrl || !container || !dataVolume || !candidateDigest || !expectedRevision || !expectedVersion || !catalogLabel || !parsedAiMode) {
    throw new IncompleteBenchmarkError("missing_required_option");
  }
  const aiModeResult = aiModeSchema.safeParse(parsedAiMode);
  if (!aiModeResult.success) throw new IncompleteBenchmarkError("invalid_ai_mode");
  const aiMode = aiModeResult.data;
  validateLoopbackOrigin(baseUrl);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(container)) throw new IncompleteBenchmarkError("invalid_container_name");
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(dataVolume)) throw new IncompleteBenchmarkError("invalid_data_volume_name");
  if (!/^sha256:[a-f0-9]{64}$/.test(candidateDigest)) throw new IncompleteBenchmarkError("invalid_candidate_digest");
  if (!/^[a-f0-9]{40}$/.test(expectedRevision)) throw new IncompleteBenchmarkError("invalid_expected_revision");
  if (!/^0\.1\.0-beta\.\d+$/.test(expectedVersion)) throw new IncompleteBenchmarkError("invalid_expected_version");
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(catalogLabel) || catalogLabel.length > 64) {
    throw new IncompleteBenchmarkError("invalid_catalog_label");
  }
  if (!Number.isSafeInteger(minimumCatalogItems) || minimumCatalogItems < minimumCatalogFloor) {
    throw new IncompleteBenchmarkError("invalid_minimum_catalog_items");
  }
  if (!adminToken) throw new IncompleteBenchmarkError("missing_admin_token_environment");
  if (!flags.has("--confirm-disposable-data")) throw new IncompleteBenchmarkError("disposable_data_not_confirmed");
  const confirmedExternalProcessing = flags.has("--confirm-external-processing");
  if (aiMode === "openai" && !confirmedExternalProcessing) {
    throw new IncompleteBenchmarkError("external_processing_not_confirmed");
  }
  if (aiMode === "none" && confirmedExternalProcessing) {
    throw new IncompleteBenchmarkError("external_processing_confirmation_not_allowed");
  }

  return {
    baseUrl: new URL(baseUrl).origin,
    container,
    dataVolume,
    candidateDigest,
    expectedRevision,
    expectedVersion,
    catalogLabel,
    minimumCatalogItems,
    aiMode,
    adminToken,
    confirmedDisposableData: true,
    confirmedExternalProcessing
  };
}

export function validateLoopbackOrigin(value: string) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new IncompleteBenchmarkError("invalid_base_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new IncompleteBenchmarkError("invalid_base_url_protocol");
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new IncompleteBenchmarkError("base_url_must_be_origin_only");
  }
  if (!new Set(["127.0.0.1", "[::1]", "::1"]).has(url.hostname) || !url.port) {
    throw new IncompleteBenchmarkError("base_url_must_be_loopback");
  }
}

export function isValidDeterministicSearchResponse(value: unknown, expectedQuery?: string) {
  const parsed = searchResponseSchema.safeParse(value);
  return parsed.success && (expectedQuery === undefined || parsed.data.query === expectedQuery);
}

export function nearestRankPercentile(values: number[], percentile: number): number | undefined {
  if (values.length === 0 || percentile <= 0 || percentile > 1) return undefined;
  if (values.some((value) => !Number.isFinite(value) || value < 0)) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentile) - 1)];
}

export function summarizeLatencies(samples: ProbeSample[]): LatencySummary | undefined {
  const values = samples.map((sample) => sample.latencyMs);
  const p50 = nearestRankPercentile(values, 0.5);
  const p95 = nearestRankPercentile(values, 0.95);
  const p99 = nearestRankPercentile(values, 0.99);
  if (p50 === undefined || p95 === undefined || p99 === undefined) return undefined;
  return {
    count: values.length,
    minMs: round(Math.min(...values)),
    p50Ms: round(p50),
    p95Ms: round(p95),
    p99Ms: round(p99),
    maxMs: round(Math.max(...values))
  };
}

export async function runBetaResponsivenessBenchmark(
  options: BenchmarkOptions,
  dependencies: BenchmarkDependencies = defaultBenchmarkDependencies
): Promise<BenchmarkReport> {
  const startedAt = dependencies.wallClockNow();
  const startedMonotonic = dependencies.monotonicNow();
  const samples = { health: [] as ProbeSample[], search: [] as ProbeSample[], diagnostics: [] as ProbeSample[] };
  const dockerHealthEvidence = {
    checks: new Map<string, DockerHealthSnapshot["checks"][number]>(),
    unhealthyStateObservations: 0
  };
  const state: BenchmarkState = { done: false, syncActive: false, diagnosticsActive: false, observedStages: new Set() };
  const overallController = new AbortController();
  const samplerController = new AbortController();
  const samplerSignal = AbortSignal.any([overallController.signal, samplerController.signal]);
  const timeout = setTimeout(() => overallController.abort(), overallTimeoutMs);
  timeout.unref();
  let workers: Promise<void>[] = [];
  let workersSettled = false;
  try {
    const harness = dependencies.inspectHarnessSource();
    if (!harness.clean || harness.revision !== options.expectedRevision) {
      throw new IncompleteBenchmarkError("harness_source_mismatch");
    }
    const containerBefore = dependencies.inspectContainer(options.container);
    throwIfBenchmarkTimedOut(overallController.signal);
    validateContainer(containerBefore, options);

    const health = await strictJsonRequest(
      dependencies,
      `${options.baseUrl}/api/health`,
      { signal: overallController.signal },
      healthSchema,
      5_000
    );
    const config = await strictJsonRequest(
      dependencies,
      `${options.baseUrl}/api/config/status`,
      { signal: overallController.signal },
      configStatusSchema,
      5_000
    );
    const headers = adminHeaders(options.adminToken);
    await expectAuthenticationRejected(dependencies, `${options.baseUrl}/api/admin/sync/status`, overallController.signal);
    const statsBefore = await strictJsonRequest(
      dependencies,
      `${options.baseUrl}/api/library/stats`,
      { headers, signal: overallController.signal },
      libraryStatsSchema,
      10_000
    );
    await expectAuthenticationRejected(dependencies, `${options.baseUrl}/api/admin/catalog/evidence`, overallController.signal);
    const catalogBefore = await strictJsonRequest(
      dependencies,
      `${options.baseUrl}/api/admin/catalog/evidence`,
      { headers, signal: overallController.signal },
      catalogSourceEvidenceSchema,
      10_000
    );
    const baselineStatus = await strictJsonRequest(
      dependencies,
      `${options.baseUrl}/api/admin/sync/status`,
      { headers, signal: overallController.signal },
      syncStatusSchema,
      10_000
    );
    validatePreflight(health, config, statsBefore, catalogBefore, baselineStatus, options);

    workers = [
      sampleHealth(options, dependencies, state, samples.health, samplerSignal, startedMonotonic),
      sampleSearch(options, dependencies, state, samples.search, samplerSignal, startedMonotonic),
      sampleDiagnostics(options, dependencies, state, samples.diagnostics, samplerSignal, startedMonotonic),
      watchDockerHealth(options, dependencies, state, dockerHealthEvidence, samplerSignal)
    ];

    const accepted = await strictJsonRequest(
      dependencies,
      `${options.baseUrl}/api/admin/sync/run`,
      {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: "{}",
        signal: overallController.signal
      },
      syncAcceptedSchema,
      10_000,
      202
    );
    state.syncActive = true;

    let completion: z.infer<typeof syncCompletionSchema> | undefined;
    let completionError: unknown;
    try {
      completion = await waitForOwnedSyncCompletion(
        options,
        dependencies,
        baselineStatus,
        accepted,
        state,
        samplerSignal
      );
    } catch (error) {
      completionError = error;
    } finally {
      state.syncActive = false;
      state.done = true;
      samplerController.abort();
      const settled = await Promise.allSettled(workers);
      workersSettled = true;
      if (!completionError && settled.some((result) => result.status === "rejected")) {
        completionError = new IncompleteBenchmarkError("sampler_worker_failed");
      }
    }
    if (completionError) throw completionError;
    if (!completion) throw new IncompleteBenchmarkError("sync_completion_missing");

    throwIfBenchmarkTimedOut(overallController.signal);
    const statsAfter = await strictJsonRequest(
      dependencies,
      `${options.baseUrl}/api/library/stats`,
      { headers, signal: overallController.signal },
      libraryStatsSchema,
      10_000
    );
    const catalogAfter = await strictJsonRequest(
      dependencies,
      `${options.baseUrl}/api/admin/catalog/evidence`,
      { headers, signal: overallController.signal },
      catalogSourceEvidenceSchema,
      10_000
    );
    const containerAfter = dependencies.inspectContainer(options.container);
    throwIfBenchmarkTimedOut(overallController.signal);
    validateContainer(containerAfter, options);
    const logs = dependencies.readContainerLogs(options.container, startedAt.toISOString());
    throwIfBenchmarkTimedOut(overallController.signal);
    return buildPublicReport({
      options,
      startedAt: startedAt.toISOString(),
      finishedAt: dependencies.wallClockNow().toISOString(),
      health,
      config,
      harness,
      statsBefore,
      statsAfter,
      catalogBefore,
      catalogAfter,
      baselineSeerrItems: baselineStatus.history?.seerr.find(
        (run) => run.source === seerrSyncCountSource && run.status === "ok" && run.itemCount > 0
      )?.itemCount,
      completion,
      observedStages: [...state.observedStages].sort(),
      containerBefore,
      containerAfter,
      logs,
      dockerHealthChecks: [...dockerHealthEvidence.checks.values()],
      dockerUnhealthyStateObservations: dockerHealthEvidence.unhealthyStateObservations,
      samples
    });
  } finally {
    state.syncActive = false;
    state.done = true;
    samplerController.abort();
    if (!workersSettled) await Promise.allSettled(workers);
    clearTimeout(timeout);
    overallController.abort();
  }
}

export function buildPublicReport(input: {
  options: BenchmarkOptions;
  startedAt: string;
  finishedAt: string;
  health: z.infer<typeof healthSchema>;
  config: z.infer<typeof configStatusSchema>;
  harness: HarnessObservation;
  statsBefore: z.infer<typeof libraryStatsSchema>;
  statsAfter: z.infer<typeof libraryStatsSchema>;
  catalogBefore: z.infer<typeof catalogSourceEvidenceSchema>;
  catalogAfter: z.infer<typeof catalogSourceEvidenceSchema>;
  baselineSeerrItems?: number;
  completion: z.infer<typeof syncCompletionSchema>;
  observedStages: string[];
  containerBefore: ContainerObservation;
  containerAfter: ContainerObservation;
  logs: LogObservation;
  dockerHealthChecks: DockerHealthSnapshot["checks"];
  dockerUnhealthyStateObservations: number;
  samples: { health: ProbeSample[]; search: ProbeSample[]; diagnostics: ProbeSample[] };
}): BenchmarkReport {
  const { options, completion, samples, containerBefore, containerAfter, logs } = input;
  const embedding = completion.providerEmbeddings;
  const healthDuringEmbedding = samples.health.filter((sample) => sample.stage === "warming_embeddings");
  const healthDuringDiagnostics = samples.health.filter((sample) => sample.diagnosticsActive);
  const observedDockerHealthChecks = new Map<string, DockerHealthSnapshot["checks"][number]>();
  for (const entry of [...input.dockerHealthChecks, ...containerAfter.healthChecks]) {
    observedDockerHealthChecks.set(`${entry.startedAt}|${entry.exitCode}`, entry);
  }
  const observedFailedHealthChecksDuringRun = [...observedDockerHealthChecks.values()].filter(
    (entry) => entry.exitCode !== 0 && Date.parse(entry.startedAt) >= Date.parse(input.startedAt)
  ).length;
  const checks: BenchmarkCheck[] = [];
  const expectedAiPolicy = options.aiMode === "none" ? "none" : "configurable";

  addCheck(
    checks,
    "ai_provider_policy_identity",
    input.health.policies.aiProvider === expectedAiPolicy
      && input.config.ai.providerPolicy === expectedAiPolicy
      && containerBefore.aiProviderPolicyLabel === expectedAiPolicy
      && containerAfter.aiProviderPolicyLabel === expectedAiPolicy,
    "failed"
  );
  addCheck(
    checks,
    "tmdb_content_policy_none",
    input.health.policies.tmdbContent === "none"
      && input.config.seerr.tmdbContentPolicy === "none"
      && containerBefore.tmdbContentPolicyLabel === "none"
      && containerAfter.tmdbContentPolicyLabel === "none",
    "failed"
  );

  addCheck(checks, "health_samples", samples.health.length >= minimumHealthSamples, "incomplete");
  addCheck(checks, "search_samples", samples.search.length >= minimumSearchSamples, "incomplete");
  addCheck(checks, "diagnostics_samples", samples.diagnostics.length >= minimumDiagnosticsSamples, "incomplete");
  addCheck(checks, "health_overlapped_diagnostics", healthDuringDiagnostics.length >= minimumPhaseHealthSamples, "incomplete");
  if (options.aiMode === "openai") {
    addCheck(
      checks,
      "ai_provider_configured",
      input.config.ai.provider === "openai" && input.config.ai.configured,
      "failed"
    );
    addCheck(checks, "external_processing_confirmed", options.confirmedExternalProcessing, "incomplete");
    addCheck(checks, "embedding_stage_observed", input.observedStages.includes("warming_embeddings"), "incomplete");
    addCheck(checks, "health_overlapped_embedding", healthDuringEmbedding.length >= minimumPhaseHealthSamples, "incomplete");
    addCheck(checks, "embedding_configured", Boolean(embedding?.configured), "incomplete");
    addCheck(checks, "embedding_attempted", Boolean(embedding && embedding.attempted > 0), "incomplete");
    checks.push({
      code: "embedding_completed",
      status:
        !embedding?.configured || embedding.attempted === 0
          ? "incomplete"
          : embedding.embedded === embedding.attempted && embedding.embedded > 0 && !embedding.error
            ? "passed"
            : "failed"
    });
  } else {
    addCheck(
      checks,
      "ai_provider_disabled",
      input.config.ai.provider === "none"
        && !input.config.ai.configured
        && (!embedding || (!embedding.configured && embedding.attempted === 0 && embedding.embedded === 0)),
      "failed"
    );
    addCheck(
      checks,
      "external_processing_confirmation_absent",
      !options.confirmedExternalProcessing,
      "failed"
    );
  }
  addCheck(checks, "sync_completed", completion.ok, "failed");
  addCheck(checks, "full_sync_counts", (completion.plexItems ?? 0) > 0 && (completion.seerrItems ?? 0) > 0, "failed");
  addCheck(checks, "plex_media_count_reported", (completion.plexMediaItems ?? 0) > 0, "incomplete");
  addCheck(checks, "seerr_media_count_reported", (completion.seerrMediaItems ?? 0) > 0, "incomplete");
  addCheck(checks, "seerr_baseline_snapshot_available", (input.baselineSeerrItems ?? 0) > 0, "incomplete");
  addCheck(
    checks,
    "plex_snapshot_cardinality_valid",
    completion.plexItems !== undefined && completion.plexMediaItems !== undefined && completion.plexItems >= completion.plexMediaItems,
    "failed"
  );
  addCheck(
    checks,
    "seerr_snapshot_cardinality_valid",
    completion.seerrItems !== undefined && completion.seerrMediaItems !== undefined && completion.seerrItems >= completion.seerrMediaItems,
    "failed"
  );
  addCheck(
    checks,
    "seerr_snapshot_preserved",
    input.baselineSeerrItems === undefined ||
      (completion.seerrItems !== undefined && countsReconciledWithinFivePercent(completion.seerrItems, input.baselineSeerrItems)),
    "failed"
  );
  for (const stage of measuredSyncStages) {
    if (options.aiMode === "none" && stage === "warming_embeddings") continue;
    addCheck(checks, `sync_stage_${stage}`, completion.stageDurationsMs[stage] !== undefined, "incomplete");
  }
  addCheck(checks, "catalog_after_minimum", input.statsAfter.totalItems >= options.minimumCatalogItems, "failed");
  addCheck(checks, "catalog_preserved", input.statsAfter.totalItems >= input.statsBefore.totalItems, "failed");
  addCheck(
    checks,
    "catalog_source_baseline",
    input.catalogBefore.activeSourceRecords >= options.minimumCatalogItems,
    "failed"
  );
  addCheck(
    checks,
    "catalog_source_records_preserved",
    input.catalogAfter.activeSourceRecords === input.catalogBefore.activeSourceRecords
      && input.catalogAfter.identitySha256 === input.catalogBefore.identitySha256,
    "failed"
  );
  addCheck(checks, "plex_catalog_preserved", countsReconciledWithinFivePercent(input.statsAfter.plexItems, input.statsBefore.plexItems), "failed");
  addCheck(checks, "seerr_catalog_preserved", countsReconciledWithinFivePercent(input.statsAfter.seerrItems, input.statsBefore.seerrItems), "failed");
  addCheck(
    checks,
    "seerr_requested_catalog_preserved",
    countsReconciledWithinFivePercent(input.statsAfter.alreadyRequested, input.statsBefore.alreadyRequested),
    "failed"
  );
  addCheck(
    checks,
    "plex_sync_count_preserved",
    countsReconciledWithinFivePercent(completion.plexMediaItems ?? 0, input.statsBefore.plexItems),
    "failed"
  );
  addCheck(
    checks,
    "plex_sync_reconciled",
    countsReconciledWithinFivePercent(input.statsAfter.plexItems, completion.plexMediaItems),
    "failed"
  );
  // SeerrClient returns one conservative record per upstream media. Reconcile
  // that snapshot with the distinct Moodarr IDs returned by the ingest itself;
  // the durable table may legitimately retain conservative historical rows.
  addCheck(
    checks,
    "seerr_sync_reconciled",
    countsReconciledWithinFivePercent(completion.seerrMediaItems ?? 0, completion.seerrItems),
    "failed"
  );
  addCheck(
    checks,
    "seerr_sync_stored",
    countCoversWithinFivePercent(input.statsAfter.alreadyRequested, completion.seerrMediaItems),
    "failed"
  );

  const healthSummary = summarizeLatencies(samples.health);
  const searchSummary = summarizeLatencies(samples.search);
  const embeddingHealthSummary = summarizeLatencies(healthDuringEmbedding);
  const diagnosticsHealthSummary = summarizeLatencies(healthDuringDiagnostics);
  addMetricThresholdCheck(checks, "health_p99", healthSummary?.p99Ms, healthP99LimitMs);
  if (options.aiMode === "openai") {
    addMetricThresholdCheck(checks, "health_embedding_p99", embeddingHealthSummary?.p99Ms, healthP99LimitMs);
  }
  addMetricThresholdCheck(checks, "health_diagnostics_p99", diagnosticsHealthSummary?.p99Ms, healthP99LimitMs);
  addMetricThresholdCheck(checks, "search_p95", searchSummary?.p95Ms, searchP95LimitMs);
  addCheck(checks, "probe_http", [...samples.health, ...samples.search, ...samples.diagnostics].every((sample) => sample.ok), "failed");
  addCheck(checks, "log_observability", logs.bytesScanned > 0, "incomplete");
  addCheck(checks, "no_sqlite_lock", logs.sqliteBusyCount === 0, "failed");
  addCheck(checks, "no_server_5xx", logs.server5xxCount === 0, "failed");
  addCheck(checks, "no_fatal_log_marker", logs.fatalMarkerCount === 0, "failed");
  addCheck(checks, "no_restart", containerBefore.restartCount === containerAfter.restartCount && containerBefore.startedAt === containerAfter.startedAt, "failed");
  addCheck(checks, "no_oom", !containerBefore.oomKilled && !containerAfter.oomKilled && logs.oomMarkerCount === 0, "failed");
  addCheck(checks, "container_envelope_stable", containerEnvelopeFingerprint(containerBefore) === containerEnvelopeFingerprint(containerAfter), "failed");
  addCheck(checks, "docker_health_healthy", containerBefore.healthStatus === "healthy" && containerAfter.healthStatus === "healthy", "failed");
  addCheck(
    checks,
    "docker_health_no_observed_failure",
    observedFailedHealthChecksDuringRun === 0
      && input.dockerUnhealthyStateObservations === 0
      && containerAfter.healthFailingStreak === 0,
    "failed"
  );

  const failures = checks.filter((check) => check.status === "failed").map((check) => check.code);
  const incompleteReasons = checks.filter((check) => check.status === "incomplete").map((check) => check.code);
  const status = failures.length > 0 ? "failed" : incompleteReasons.length > 0 ? "incomplete" : "passed";

  return {
    schemaVersion,
    aiMode: options.aiMode,
    status,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    candidate: {
      digest: options.candidateDigest,
      expectedRevision: options.expectedRevision,
      expectedVersion: options.expectedVersion,
      healthRevision: input.health.revision,
      healthVersion: input.health.version,
      aiProviderPolicy: input.health.policies.aiProvider,
      tmdbContentPolicy: input.health.policies.tmdbContent,
      harnessRevision: input.harness.revision,
      harnessSha256: input.harness.scriptSha256
    },
    environment: {
      catalogLabelSha256: sha256(options.catalogLabel),
      originClass: "loopback",
      architecture: containerBefore.architecture,
      operatingSystem: containerBefore.imageOperatingSystem,
      localDockerDaemon: containerBefore.localDockerDaemon,
      cpuLimit: containerBefore.cpuLimit / 1_000_000_000,
      memoryMiB: containerBefore.memoryBytes / 1024 / 1024,
      pidLimit: containerBefore.pidsLimit,
      readOnlyRoot: containerBefore.readOnly,
      imageDigestMatched: containerBefore.imageRef.endsWith(`@${options.candidateDigest}`),
      disposableVolumeVerified:
        containerBefore.mounts.length === 1
        && containerBefore.mounts[0]?.name === options.dataVolume
        && containerBefore.volumeDisposableLabel === "true"
        && containerBefore.volumeExclusiveToContainer,
      disposableDataConfirmed: options.confirmedDisposableData,
      externalProcessingConfirmed: options.aiMode === "openai" && options.confirmedExternalProcessing
    },
    catalog: {
      minimumItems: options.minimumCatalogItems,
      before: catalogCounts(input.statsBefore, input.catalogBefore),
      after: catalogCounts(input.statsAfter, input.catalogAfter)
    },
    workload: {
      querySetSha256: sha256(JSON.stringify(benchmarkQueries)),
      queryCount: benchmarkQueries.length,
      sync: {
        durationMs: completion.durationMs,
        plexItems: completion.plexItems ?? 0,
        plexMediaItems: completion.plexMediaItems ?? 0,
        seerrItems: completion.seerrItems ?? 0,
        seerrMediaItems: completion.seerrMediaItems ?? 0,
        baselineSeerrItems: input.baselineSeerrItems,
        stageDurationsMs: fixedStageDurations(completion.stageDurationsMs),
        observedStages: input.observedStages,
        embedding: {
          configured: embedding?.configured ?? false,
          attempted: embedding?.attempted ?? 0,
          embedded: embedding?.embedded ?? 0,
          compatibleCount: embedding?.compatibleCount,
          staleCount: embedding?.staleCount,
          hasMore: embedding?.hasMore ?? false,
          errorPresent: Boolean(embedding?.error)
        }
      }
    },
    thresholds: {
      healthP99Ms: healthP99LimitMs,
      searchP95Ms: searchP95LimitMs,
      minimumHealthSamples,
      minimumSearchSamples,
      minimumDiagnosticsSamples,
      minimumPhaseHealthSamples,
      percentileMethod: "nearest-rank"
    },
    metrics: {
      health: healthSummary,
      ...(options.aiMode === "openai" ? { healthDuringEmbedding: embeddingHealthSummary } : {}),
      healthDuringDiagnostics: diagnosticsHealthSummary,
      search: searchSummary,
      diagnostics: summarizeLatencies(samples.diagnostics),
      errors: errorCounts(samples)
    },
    observability: {
      container: {
        restartCountBefore: containerBefore.restartCount,
        restartCountAfter: containerAfter.restartCount,
        startedAtChanged: containerBefore.startedAt !== containerAfter.startedAt,
        oomKilled: containerBefore.oomKilled || containerAfter.oomKilled,
        healthStatusBefore: containerBefore.healthStatus,
        healthStatusAfter: containerAfter.healthStatus,
        observedFailedHealthChecksDuringRun,
        unhealthyDockerStateObservations: input.dockerUnhealthyStateObservations
      },
      logs
    },
    checks,
    failures,
    incompleteReasons,
    samples
  };
}

export async function waitForOwnedSyncCompletion(
  options: BenchmarkOptions,
  dependencies: BenchmarkDependencies,
  baseline: z.infer<typeof syncStatusSchema>,
  accepted: z.infer<typeof syncAcceptedSchema>,
  state: BenchmarkState,
  signal: AbortSignal
) {
  const baselineFingerprint = syncFingerprint(baseline.lastResult);
  const acceptedAt = Date.parse(accepted.startedAt);
  if (!Number.isFinite(acceptedAt)) throw new IncompleteBenchmarkError("invalid_accepted_timestamp");
  let observedRunning = false;

  while (!signal.aborted) {
    const status = await strictJsonRequest(
      dependencies,
      `${options.baseUrl}/api/admin/sync/status`,
      { headers: adminHeaders(options.adminToken), signal },
      syncStatusSchema,
      10_000
    );
    if (!status.worker?.ready || status.worker.closed) throw new IncompleteBenchmarkError("sync_worker_unavailable");
    const progressStartedAt = status.progress ? Date.parse(status.progress.startedAt) : Number.NaN;
    if (status.running && status.progress && progressStartedAt >= acceptedAt) {
      observedRunning = true;
      state.stage = status.progress.stage;
      state.observedStages.add(status.progress.stage);
    } else if (!status.running) {
      state.stage = undefined;
    }
    const completion = status.lastResult;
    if (!status.running && completion && syncFingerprint(completion) !== baselineFingerprint) {
      if (!observedRunning) throw new IncompleteBenchmarkError("sync_ownership_unproven");
      const started = Date.parse(completion.startedAt);
      const finished = Date.parse(completion.finishedAt);
      if (!Number.isFinite(started) || !Number.isFinite(finished) || started < acceptedAt || finished < started) {
        throw new IncompleteBenchmarkError("sync_completion_timestamp_mismatch");
      }
      return completion;
    }
    await dependencies.sleep(250, signal);
  }
  throw new IncompleteBenchmarkError("benchmark_timeout");
}

async function sampleHealth(
  options: BenchmarkOptions,
  dependencies: BenchmarkDependencies,
  state: BenchmarkState,
  samples: ProbeSample[],
  signal: AbortSignal,
  startedAt: number
) {
  while (!state.done && !signal.aborted) {
    const observation = await probeJson(
      dependencies,
      `${options.baseUrl}/api/health`,
      {},
      healthSchema,
      2_000,
      signal,
      startedAt,
      state
    );
    if (observation.wasSyncActive && !signal.aborted) samples.push(observation.sample);
    await dependencies.sleep(100, signal);
  }
}

async function sampleSearch(
  options: BenchmarkOptions,
  dependencies: BenchmarkDependencies,
  state: BenchmarkState,
  samples: ProbeSample[],
  signal: AbortSignal,
  startedAt: number
) {
  let index = 0;
  while (!state.done && !signal.aborted) {
    const expectedQuery = benchmarkQueries[index % benchmarkQueries.length]!;
    const observation = await probeJson(
      dependencies,
      `${options.baseUrl}/api/search`,
      {
        method: "POST",
        headers: { ...adminHeaders(options.adminToken), "Content-Type": "application/json" },
        body: JSON.stringify({ query: expectedQuery, watchContext: "solo", resultLimit: 20, useAi: false })
      },
      searchResponseSchema,
      20_000,
      signal,
      startedAt,
      state
    );
    if (observation.value && !isValidDeterministicSearchResponse(observation.value, expectedQuery)) {
      observation.sample.ok = false;
      observation.sample.errorCategory = "contract";
    }
    if (observation.wasSyncActive && !signal.aborted) samples.push(observation.sample);
    index += 1;
    await dependencies.sleep(2_000, signal);
  }
}

async function sampleDiagnostics(
  options: BenchmarkOptions,
  dependencies: BenchmarkDependencies,
  state: BenchmarkState,
  samples: ProbeSample[],
  signal: AbortSignal,
  startedAt: number
) {
  while (!state.done && !signal.aborted) {
    state.diagnosticsActive = true;
    try {
      const observation = await probeJson(
        dependencies,
        `${options.baseUrl}/api/admin/recommendations/diagnostics?fresh=true`,
        { headers: adminHeaders(options.adminToken) },
        diagnosticsResponseSchema,
        35_000,
        signal,
        startedAt,
        state
      );
      if (observation.wasSyncActive && !signal.aborted) samples.push(observation.sample);
    } finally {
      state.diagnosticsActive = false;
    }
    await dependencies.sleep(2_000, signal);
  }
}

async function watchDockerHealth(
  options: BenchmarkOptions,
  dependencies: BenchmarkDependencies,
  state: BenchmarkState,
  evidence: {
    checks: Map<string, DockerHealthSnapshot["checks"][number]>;
    unhealthyStateObservations: number;
  },
  signal: AbortSignal
) {
  while (!state.done && !signal.aborted) {
    const snapshot = dependencies.inspectContainerHealth(options.container);
    if (snapshot.status !== "healthy" || snapshot.failingStreak > 0) evidence.unhealthyStateObservations += 1;
    for (const entry of snapshot.checks) evidence.checks.set(`${entry.startedAt}|${entry.exitCode}`, entry);
    await dependencies.sleep(10_000, signal);
  }
}

async function probeJson<T extends z.ZodType>(
  dependencies: BenchmarkDependencies,
  url: string,
  init: RequestInit,
  schema: T,
  timeoutMs: number,
  rootSignal: AbortSignal,
  benchmarkStartedAt: number,
  state: BenchmarkState
): Promise<{ sample: ProbeSample; value?: z.infer<T>; wasSyncActive: boolean }> {
  const startedAt = dependencies.monotonicNow();
  const stageAtStart = state.stage;
  const diagnosticsActiveAtStart = state.diagnosticsActive;
  const syncActiveAtStart = state.syncActive;
  let statusCode = 0;
  let errorCategory: ProbeErrorCategory | undefined;
  let value: z.infer<T> | undefined;
  try {
    const response = await dependencies.fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([rootSignal, AbortSignal.timeout(timeoutMs)])
    });
    statusCode = response.status;
    if (!response.ok) {
      errorCategory = `http_${response.status}`;
    } else {
      let json: unknown;
      try {
        json = await response.json();
      } catch {
        errorCategory = "invalid_json";
      }
      if (!errorCategory) {
        const parsed = schema.safeParse(json);
        if (parsed.success) value = parsed.data;
        else errorCategory = "contract";
      }
    }
  } catch (error) {
    errorCategory = rootSignal.aborted || isAbortError(error) ? "timeout" : "network";
  }
  const sample: ProbeSample = {
    offsetMs: round(startedAt - benchmarkStartedAt),
    latencyMs: round(dependencies.monotonicNow() - startedAt),
    statusCode,
    ok: !errorCategory,
    errorCategory,
    stage: stageAtStart,
    diagnosticsActive: diagnosticsActiveAtStart
  };
  return { sample, value, wasSyncActive: syncActiveAtStart };
}

async function strictJsonRequest<T extends z.ZodType>(
  dependencies: BenchmarkDependencies,
  url: string,
  init: RequestInit,
  schema: T,
  timeoutMs: number,
  expectedStatus = 200
): Promise<z.infer<T>> {
  let response: Response;
  try {
    response = await dependencies.fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.any([init.signal ?? new AbortController().signal, AbortSignal.timeout(timeoutMs)])
    });
  } catch {
    if (init.signal?.aborted) throw new IncompleteBenchmarkError("benchmark_timeout");
    throw new IncompleteBenchmarkError("request_unavailable");
  }
  if (response.status !== expectedStatus) throw new IncompleteBenchmarkError(`unexpected_http_${response.status}`);
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    throw new IncompleteBenchmarkError("invalid_json_response");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new IncompleteBenchmarkError("response_contract_mismatch");
  return parsed.data;
}

async function expectAuthenticationRejected(dependencies: BenchmarkDependencies, url: string, signal: AbortSignal) {
  const attempts: Array<Record<string, string>> = [{}, { "X-Moodarr-Admin-Token": "invalid-benchmark-token" }];
  for (const headers of attempts) {
    let response: Response;
    try {
      response = await dependencies.fetch(url, {
        headers,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)])
      });
    } catch {
      if (signal.aborted) throw new IncompleteBenchmarkError("benchmark_timeout");
      throw new IncompleteBenchmarkError("auth_preflight_unavailable");
    }
    if (response.status !== 401) throw new IncompleteBenchmarkError("admin_auth_boundary_unexpected");
  }
}

function validatePreflight(
  health: z.infer<typeof healthSchema>,
  config: z.infer<typeof configStatusSchema>,
  stats: z.infer<typeof libraryStatsSchema>,
  catalog: z.infer<typeof catalogSourceEvidenceSchema>,
  sync: z.infer<typeof syncStatusSchema>,
  options: BenchmarkOptions
) {
  if (health.version !== options.expectedVersion || health.revision !== options.expectedRevision) {
    throw new IncompleteBenchmarkError("health_identity_mismatch");
  }
  if (!config.plex.configured || !config.seerr.configured) throw new IncompleteBenchmarkError("integrations_not_configured");
  if (config.ai.provider !== options.aiMode) throw new IncompleteBenchmarkError("ai_mode_mismatch");
  if (config.ai.providerPolicy !== (options.aiMode === "none" ? "none" : "configurable")) {
    throw new IncompleteBenchmarkError("ai_provider_policy_mismatch");
  }
  if (health.policies.aiProvider !== config.ai.providerPolicy || health.policies.tmdbContent !== "none") {
    throw new IncompleteBenchmarkError("health_policy_mismatch");
  }
  if (config.seerr.tmdbContentPolicy !== "none") throw new IncompleteBenchmarkError("tmdb_content_policy_mismatch");
  if (options.aiMode === "openai" && !options.confirmedExternalProcessing) {
    throw new IncompleteBenchmarkError("external_processing_not_confirmed");
  }
  if (options.aiMode === "openai" && !config.ai.configured) {
    throw new IncompleteBenchmarkError("embedding_provider_not_configured");
  }
  if (options.aiMode === "none" && options.confirmedExternalProcessing) {
    throw new IncompleteBenchmarkError("external_processing_confirmation_not_allowed");
  }
  if (options.aiMode === "none" && config.ai.configured) {
    throw new IncompleteBenchmarkError("ai_provider_not_disabled");
  }
  if (!config.admin.authRequired || !config.admin.configured || config.admin.autoSession) {
    throw new IncompleteBenchmarkError("unsafe_admin_configuration");
  }
  if (config.runtime.syncIntervalMinutes !== 0 || !config.runtime.syncSeerr || sync.enabled || sync.intervalMinutes !== 0) {
    throw new IncompleteBenchmarkError("scheduled_sync_not_disabled");
  }
  if (sync.running) throw new IncompleteBenchmarkError("sync_already_running");
  if (!sync.worker?.ready || sync.worker.closed) throw new IncompleteBenchmarkError("sync_worker_unavailable");
  if (stats.totalItems < options.minimumCatalogItems) throw new IncompleteBenchmarkError("catalog_baseline_below_minimum");
  if (catalog.activeSourceRecords < options.minimumCatalogItems) {
    throw new IncompleteBenchmarkError("catalog_source_baseline_below_minimum");
  }
  if (!sync.history?.seerr.some((run) => run.source === seerrSyncCountSource && run.status === "ok" && run.itemCount > 0)) {
    throw new IncompleteBenchmarkError("seerr_baseline_snapshot_missing");
  }
}

function validateContainer(container: ContainerObservation, options: BenchmarkOptions) {
  if (!container.running) throw new IncompleteBenchmarkError("container_not_running");
  if (!container.localDockerDaemon) throw new IncompleteBenchmarkError("remote_docker_daemon_rejected");
  if (container.architecture !== "amd64" || !new Set(["amd64", "x86_64"]).has(container.daemonArchitecture)) {
    throw new IncompleteBenchmarkError("container_not_native_amd64");
  }
  if (container.imageOperatingSystem !== "linux" || container.daemonOperatingSystem !== "linux") {
    throw new IncompleteBenchmarkError("container_not_native_linux");
  }
  if (!container.imageRef.endsWith(`@${options.candidateDigest}`)) throw new IncompleteBenchmarkError("candidate_digest_mismatch");
  if (
    container.revisionLabel !== options.expectedRevision
    || container.versionLabel !== options.expectedVersion
    || container.aiProviderPolicyLabel !== (options.aiMode === "none" ? "none" : "configurable")
    || container.tmdbContentPolicyLabel !== "none"
  ) {
    throw new IncompleteBenchmarkError("container_identity_mismatch");
  }
  if (
    container.cpuLimit !== expectedCpuLimit
    || container.memoryBytes !== expectedMemoryBytes
    || container.memorySwapBytes !== expectedMemoryBytes
    || container.pidsLimit !== expectedPidLimit
  ) {
    throw new IncompleteBenchmarkError("resource_budget_mismatch");
  }
  if (!container.initEnabled || !container.readOnly || container.user !== "999:999") {
    throw new IncompleteBenchmarkError("container_hardening_mismatch");
  }
  if (
    container.privileged
    || container.capAdd.length > 0
    || container.capDrop.length !== 1
    || container.capDrop[0] !== "ALL"
    || container.securityOpt.length !== 1
    || !new Set(["no-new-privileges", "no-new-privileges:true"]).has(container.securityOpt[0] ?? "")
  ) {
    throw new IncompleteBenchmarkError("container_privilege_hardening_mismatch");
  }
  const tmpfsOptions = new Set((container.tmpfs["/tmp"] ?? "").split(","));
  if (
    tmpfsOptions.size !== 6
    || !["rw", "nosuid", "nodev", "noexec", "size=536870912", "mode=1777"].every((value) => tmpfsOptions.has(value))
  ) {
    throw new IncompleteBenchmarkError("container_tmpfs_mismatch");
  }
  const portKeys = Object.keys(container.portBindings);
  const portBindings = container.portBindings["4401/tcp"] ?? [];
  const target = new URL(options.baseUrl);
  const targetHost = target.hostname.replace(/^\[|\]$/g, "");
  if (
    portKeys.length !== 1
    || portKeys[0] !== "4401/tcp"
    || portBindings.length !== 1
    || portBindings[0]?.HostIp !== targetHost
    || portBindings[0]?.HostPort !== target.port
  ) throw new IncompleteBenchmarkError("container_port_target_mismatch");
  const dataMount = container.mounts[0];
  if (
    container.mounts.length !== 1
    || dataMount?.type !== "volume"
    || dataMount.name !== options.dataVolume
    || dataMount.destination !== "/data"
    || !dataMount.rw
  ) throw new IncompleteBenchmarkError("disposable_data_volume_mismatch");
  if (container.disposableLabel !== "true") throw new IncompleteBenchmarkError("disposable_container_label_missing");
  if (container.volumeDisposableLabel !== "true" || !container.volumeExclusiveToContainer) {
    throw new IncompleteBenchmarkError("disposable_data_volume_unproven");
  }
  if (container.oomKilled) throw new IncompleteBenchmarkError("container_preflight_oom");
  if (container.healthStatus !== "healthy" || container.healthFailingStreak !== 0) {
    throw new IncompleteBenchmarkError("container_health_unavailable");
  }
  if (
    JSON.stringify(container.healthcheckTest) !== JSON.stringify(expectedHealthcheckTest)
    || container.healthcheckIntervalNs !== expectedHealthcheckIntervalNs
    || container.healthcheckTimeoutNs !== expectedHealthcheckTimeoutNs
    || container.healthcheckStartPeriodNs !== expectedHealthcheckStartPeriodNs
    || container.healthcheckRetries !== expectedHealthcheckRetries
  ) throw new IncompleteBenchmarkError("container_healthcheck_configuration_mismatch");
}

export function inspectHarnessSource(): HarnessObservation {
  const env = childProcessEnvironment();
  try {
    const scriptPath = fileURLToPath(import.meta.url);
    const repoRoot = resolve(dirname(scriptPath), "..");
    const expectedScriptPath = resolve(repoRoot, "scripts/benchmark-beta-responsiveness.ts");
    const resolvedRepoRoot = realpathSync(repoRoot);
    const resolvedScriptPath = realpathSync(scriptPath);
    const resolvedExpectedScriptPath = realpathSync(expectedScriptPath);
    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
      maxBuffer: 1024 * 1024,
      timeout: 10_000
    }).trim();
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
      maxBuffer: 1024 * 1024,
      timeout: 10_000
    }).trim();
    const status = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd: repoRoot,
      encoding: "utf8",
      env,
      maxBuffer: 1024 * 1024,
      timeout: 10_000
    }).trim();
    const currentScript = readFileSync(scriptPath);
    const committedScript = execFileSync("git", ["show", "HEAD:scripts/benchmark-beta-responsiveness.ts"], {
      cwd: repoRoot,
      env,
      maxBuffer: 1024 * 1024,
      timeout: 10_000
    });
    return {
      revision,
      scriptSha256: crypto.createHash("sha256").update(currentScript).digest("hex"),
      clean:
        status.length === 0
        && realpathSync(gitRoot) === resolvedRepoRoot
        && resolvedScriptPath === resolvedExpectedScriptPath
        && currentScript.equals(committedScript)
    };
  } catch {
    throw new IncompleteBenchmarkError("harness_source_inspect_unavailable");
  }
}

export function inspectContainerHealth(name: string): DockerHealthSnapshot {
  const env = childProcessEnvironment();
  const format = [
    "{",
    '"status":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},',
    '"failingStreak":{{if .State.Health}}{{json .State.Health.FailingStreak}}{{else}}0{{end}}',
    "}"
  ].join("");
  try {
    const raw = execFileSync("docker", ["inspect", "--format", format, name], {
      encoding: "utf8",
      env,
      maxBuffer: 1024 * 1024,
      timeout: 10_000
    });
    const healthRows = execFileSync(
      "docker",
      ["inspect", "--format", '{{if .State.Health}}{{range .State.Health.Log}}{{printf "%s\\t%d\\n" .Start .ExitCode}}{{end}}{{end}}', name],
      { encoding: "utf8", env, maxBuffer: 1024 * 1024, timeout: 10_000 }
    );
    return dockerHealthSnapshotSchema.parse({ ...JSON.parse(raw), checks: parseHealthRows(healthRows) });
  } catch {
    throw new IncompleteBenchmarkError("container_health_inspect_unavailable");
  }
}

export function inspectContainer(name: string): ContainerObservation {
  const childEnv = childProcessEnvironment();
  const format = [
    "{",
    '"containerId":{{json .Id}},',
    '"imageRef":{{json .Config.Image}},',
    '"imageId":{{json .Image}},',
    '"user":{{json .Config.User}},',
    '"running":{{json .State.Running}},',
    '"startedAt":{{json .State.StartedAt}},',
    '"restartCount":{{json .RestartCount}},',
    '"oomKilled":{{json .State.OOMKilled}},',
    '"cpuLimit":{{json .HostConfig.NanoCpus}},',
    '"memoryBytes":{{json .HostConfig.Memory}},',
    '"memorySwapBytes":{{json .HostConfig.MemorySwap}},',
    '"initEnabled":{{json .HostConfig.Init}},',
    '"pidsLimit":{{json .HostConfig.PidsLimit}},',
    '"readOnly":{{json .HostConfig.ReadonlyRootfs}},',
    '"privileged":{{json .HostConfig.Privileged}},',
    '"capAdd":{{json .HostConfig.CapAdd}},',
    '"capDrop":{{json .HostConfig.CapDrop}},',
    '"securityOpt":{{json .HostConfig.SecurityOpt}},',
    '"tmpfs":{{json .HostConfig.Tmpfs}},',
    '"portBindings":{{json .HostConfig.PortBindings}},',
    '"healthStatus":{{if .State.Health}}{{json .State.Health.Status}}{{else}}null{{end}},',
    '"healthFailingStreak":{{if .State.Health}}{{json .State.Health.FailingStreak}}{{else}}0{{end}},',
    '"healthcheckTest":{{json .Config.Healthcheck.Test}},',
    '"healthcheckIntervalNs":{{json .Config.Healthcheck.Interval}},',
    '"healthcheckTimeoutNs":{{json .Config.Healthcheck.Timeout}},',
    '"healthcheckStartPeriodNs":{{json .Config.Healthcheck.StartPeriod}},',
    '"healthcheckRetries":{{json .Config.Healthcheck.Retries}},',
    '"disposableLabel":{{json (index .Config.Labels "io.moodarr.benchmark.disposable")}},',
    '"versionLabel":{{json (index .Config.Labels "org.opencontainers.image.version")}},',
    '"revisionLabel":{{json (index .Config.Labels "org.opencontainers.image.revision")}},',
    '"aiProviderPolicyLabel":{{json (index .Config.Labels "io.moodarr.ai-provider-policy")}},',
    '"tmdbContentPolicyLabel":{{json (index .Config.Labels "io.moodarr.tmdb-content-policy")}}',
    "}"
  ].join("");
  let raw: string;
  let mountRows: string;
  let healthRows: string;
  try {
    raw = execFileSync("docker", ["inspect", "--format", format, name], {
      encoding: "utf8",
      env: childEnv,
      maxBuffer: 1024 * 1024,
      timeout: 10_000
    });
    mountRows = execFileSync(
      "docker",
      ["inspect", "--format", '{{range .Mounts}}{{printf "%s\\t%s\\t%s\\t%t\\n" .Type .Name .Destination .RW}}{{end}}', name],
      { encoding: "utf8", env: childEnv, maxBuffer: 1024 * 1024, timeout: 10_000 }
    );
    healthRows = execFileSync(
      "docker",
      ["inspect", "--format", '{{if .State.Health}}{{range .State.Health.Log}}{{printf "%s\\t%d\\n" .Start .ExitCode}}{{end}}{{end}}', name],
      { encoding: "utf8", env: childEnv, maxBuffer: 1024 * 1024, timeout: 10_000 }
    );
  } catch {
    throw new IncompleteBenchmarkError("container_inspect_unavailable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new IncompleteBenchmarkError("container_inspect_invalid");
  }
  const mounts = parseMountRows(mountRows);
  const healthChecks = parseHealthRows(healthRows);
  const partial = containerObservationSchema.omit({
    architecture: true,
    imageOperatingSystem: true,
    daemonArchitecture: true,
    daemonOperatingSystem: true,
    localDockerDaemon: true,
    volumeDisposableLabel: true,
    volumeExclusiveToContainer: true,
    mounts: true,
    healthChecks: true
  }).safeParse(parsed);
  if (!partial.success) throw new IncompleteBenchmarkError("container_inspect_contract_mismatch");
  let architecture: string;
  let imageOperatingSystem: string;
  let daemonArchitecture: string;
  let daemonOperatingSystem: string;
  let localDockerDaemon: boolean;
  let volumeDisposableLabel: string | null = null;
  let volumeExclusiveToContainer = false;
  try {
    [architecture, imageOperatingSystem] = parseDockerPair(execFileSync(
      "docker",
      ["image", "inspect", partial.data.imageId, "--format", '{{printf "%s\\t%s" .Architecture .Os}}'],
      {
        encoding: "utf8",
        env: childEnv,
        maxBuffer: 1024 * 1024,
        timeout: 10_000
      }
    ));
    [daemonArchitecture, daemonOperatingSystem] = parseDockerPair(execFileSync(
      "docker",
      ["info", "--format", '{{printf "%s\\t%s" .Architecture .OSType}}'],
      {
        encoding: "utf8",
        env: childEnv,
        maxBuffer: 1024 * 1024,
        timeout: 10_000
      }
    ));
    localDockerDaemon = effectiveDockerEndpoint(childEnv).startsWith("unix://");
    const dataMount = mounts.find((mount) => mount.type === "volume" && mount.destination === "/data");
    if (dataMount) {
      const labelValue = JSON.parse(execFileSync(
        "docker",
        ["volume", "inspect", dataMount.name, "--format", '{{json (index .Labels "io.moodarr.benchmark.disposable")}}'],
        { encoding: "utf8", env: childEnv, maxBuffer: 1024 * 1024, timeout: 10_000 }
      )) as unknown;
      if (labelValue !== null && typeof labelValue !== "string") {
        throw new IncompleteBenchmarkError("volume_label_inspect_invalid");
      }
      volumeDisposableLabel = labelValue;
      const attachedContainerIds = execFileSync(
        "docker",
        ["ps", "--all", "--no-trunc", "--filter", `volume=${dataMount.name}`, "--format", "{{.ID}}"],
        { encoding: "utf8", env: childEnv, maxBuffer: 1024 * 1024, timeout: 10_000 }
      ).trim().split("\n").filter(Boolean);
      volumeExclusiveToContainer = attachedContainerIds.length === 1 && attachedContainerIds[0] === partial.data.containerId;
    }
  } catch {
    throw new IncompleteBenchmarkError("container_environment_inspect_unavailable");
  }
  return containerObservationSchema.parse({
    ...partial.data,
    architecture,
    imageOperatingSystem,
    daemonArchitecture,
    daemonOperatingSystem,
    localDockerDaemon,
    volumeDisposableLabel,
    volumeExclusiveToContainer,
    mounts,
    healthChecks
  });
}

export function readContainerLogs(name: string, since: string): LogObservation {
  const result = spawnSync("docker", ["logs", "--since", since, name], {
    encoding: "utf8",
    env: childProcessEnvironment(),
    maxBuffer: maximumLogBytes,
    timeout: 30_000
  });
  if (result.error || result.status !== 0) {
    throw new IncompleteBenchmarkError("container_logs_unavailable_or_too_large");
  }
  const logs = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return {
    bytesScanned: Buffer.byteLength(logs),
    sqliteBusyCount: countMatches(logs, /SQLITE_(?:BUSY|LOCKED)|database is locked/gi),
    server5xxCount: countMatches(logs, /"statusCode"\s*:\s*5\d\d/gi),
    oomMarkerCount: countMatches(logs, /out of memory|oom[-_ ]?killed/gi),
    fatalMarkerCount: countMatches(logs, /uncaught|unhandled|\bfatal\b/gi)
  };
}

function catalogCounts(
  stats: z.infer<typeof libraryStatsSchema>,
  evidence: z.infer<typeof catalogSourceEvidenceSchema>
): CatalogCounts {
  return {
    totalItems: stats.totalItems,
    activeCatalogSourceRecords: evidence.activeSourceRecords,
    plexItems: stats.plexItems,
    seerrItems: stats.seerrItems,
    seerrRequestedItems: stats.alreadyRequested,
    movies: stats.movies,
    tv: stats.tv
  };
}

function parseMountRows(value: string) {
  return value.trim().split("\n").filter(Boolean).map((row) => {
    const [type, name, destination, rw] = row.split("\t");
    if (!type || !name || !destination || (rw !== "true" && rw !== "false")) {
      throw new IncompleteBenchmarkError("container_mount_inspect_invalid");
    }
    return { type, name, destination, rw: rw === "true" };
  });
}

function parseHealthRows(value: string) {
  return value.trim().split("\n").filter(Boolean).map((row) => {
    const [startedAt, exitCodeValue] = row.split("\t");
    const exitCode = Number(exitCodeValue);
    if (!startedAt || !Number.isInteger(exitCode)) throw new IncompleteBenchmarkError("container_health_inspect_invalid");
    return { startedAt, exitCode };
  });
}

function parseDockerPair(value: string): [string, string] {
  const [left, right, extra] = value.trim().split("\t");
  if (!left || !right || extra !== undefined) throw new IncompleteBenchmarkError("docker_info_contract_mismatch");
  return [left, right];
}

function effectiveDockerEndpoint(env: NodeJS.ProcessEnv) {
  const configuredHost = env.DOCKER_HOST?.trim();
  if (configuredHost) return configuredHost;
  const context = execFileSync("docker", ["context", "show"], {
    encoding: "utf8",
    env,
    maxBuffer: 1024 * 1024,
    timeout: 10_000
  }).trim();
  if (!context) throw new IncompleteBenchmarkError("docker_context_unavailable");
  return execFileSync(
    "docker",
    ["context", "inspect", context, "--format", '{{(index .Endpoints "docker").Host}}'],
    { encoding: "utf8", env, maxBuffer: 1024 * 1024, timeout: 10_000 }
  ).trim();
}

function childProcessEnvironment() {
  const env = { ...process.env };
  delete env.MOODARR_BENCH_ADMIN_TOKEN;
  return env;
}

function fixedStageDurations(value: z.infer<typeof syncStageDurationsSchema>) {
  return Object.fromEntries(
    measuredSyncStages.flatMap((stage) => value[stage] === undefined ? [] : [[stage, value[stage]]])
  );
}

function containerEnvelopeFingerprint(container: ContainerObservation) {
  return JSON.stringify({
    containerId: container.containerId,
    imageRef: container.imageRef,
    imageId: container.imageId,
    user: container.user,
    cpuLimit: container.cpuLimit,
    memoryBytes: container.memoryBytes,
    memorySwapBytes: container.memorySwapBytes,
    initEnabled: container.initEnabled,
    pidsLimit: container.pidsLimit,
    readOnly: container.readOnly,
    privileged: container.privileged,
    capAdd: container.capAdd,
    capDrop: container.capDrop,
    securityOpt: container.securityOpt,
    tmpfs: container.tmpfs,
    portBindings: container.portBindings,
    mounts: container.mounts,
    disposableLabel: container.disposableLabel,
    versionLabel: container.versionLabel,
    revisionLabel: container.revisionLabel,
    aiProviderPolicyLabel: container.aiProviderPolicyLabel,
    tmdbContentPolicyLabel: container.tmdbContentPolicyLabel,
    architecture: container.architecture,
    imageOperatingSystem: container.imageOperatingSystem,
    daemonArchitecture: container.daemonArchitecture,
    daemonOperatingSystem: container.daemonOperatingSystem,
    localDockerDaemon: container.localDockerDaemon,
    volumeDisposableLabel: container.volumeDisposableLabel,
    volumeExclusiveToContainer: container.volumeExclusiveToContainer,
    healthcheckTest: container.healthcheckTest,
    healthcheckIntervalNs: container.healthcheckIntervalNs,
    healthcheckTimeoutNs: container.healthcheckTimeoutNs,
    healthcheckStartPeriodNs: container.healthcheckStartPeriodNs,
    healthcheckRetries: container.healthcheckRetries
  });
}

function throwIfBenchmarkTimedOut(signal: AbortSignal) {
  if (signal.aborted) throw new IncompleteBenchmarkError("benchmark_timeout");
}

function errorCounts(samples: { health: ProbeSample[]; search: ProbeSample[]; diagnostics: ProbeSample[] }) {
  const counts: Record<string, number> = {};
  for (const [probe, probeSamples] of Object.entries(samples)) {
    for (const sample of probeSamples) {
      if (!sample.errorCategory) continue;
      const key = `${probe}:${sample.errorCategory}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

function syncFingerprint(result: z.infer<typeof syncCompletionSchema> | undefined) {
  if (!result) return "none";
  return `${result.startedAt}|${result.finishedAt}|${result.durationMs}|${result.ok}`;
}

function addCheck(checks: BenchmarkCheck[], code: string, passed: boolean, failedStatus: "failed" | "incomplete") {
  checks.push({ code, status: passed ? "passed" : failedStatus });
}

function addMetricThresholdCheck(checks: BenchmarkCheck[], code: string, value: number | undefined, limit: number) {
  checks.push({ code, status: value === undefined ? "incomplete" : value <= limit ? "passed" : "failed" });
}

function countsReconciledWithinFivePercent(observed: number, expected: number | undefined) {
  if (expected === undefined) return false;
  if (expected === 0) return observed === 0;
  return observed >= expected * 0.95 && observed <= expected * 1.05;
}

function countCoversWithinFivePercent(observed: number, expected: number | undefined) {
  if (expected === undefined) return false;
  return observed >= expected * 0.95;
}

function adminHeaders(token: string) {
  return { "X-Moodarr-Admin-Token": token };
}

function countMatches(value: string, pattern: RegExp) {
  return [...value.matchAll(pattern)].length;
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function round(value: number) {
  return Math.round(value * 1_000) / 1_000;
}

function isAbortError(error: unknown) {
  return typeof error === "object"
    && error !== null
    && "name" in error
    && (error.name === "AbortError" || error.name === "TimeoutError");
}

async function main() {
  let options: BenchmarkOptions | undefined;
  try {
    options = parseBenchmarkArgs(process.argv.slice(2));
    console.error("Moodarr beta responsiveness benchmark started against a confirmed disposable candidate instance.");
    const report = await runBetaResponsivenessBenchmark(options);
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.status === "passed" ? 0 : report.status === "failed" ? 1 : 2;
  } catch (error) {
    const code = error instanceof IncompleteBenchmarkError ? error.code : "unexpected_error";
    const now = new Date().toISOString();
    console.log(JSON.stringify({
      schemaVersion,
      aiMode: options?.aiMode,
      status: "incomplete",
      startedAt: now,
      finishedAt: now,
      candidate: options
        ? { digest: options.candidateDigest, expectedRevision: options.expectedRevision, expectedVersion: options.expectedVersion }
        : undefined,
      failures: [],
      incompleteReasons: [code]
    }, null, 2));
    process.exitCode = 2;
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
