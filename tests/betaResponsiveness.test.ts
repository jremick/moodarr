import { describe, expect, it, vi } from "vitest";
import {
  buildPublicReport,
  IncompleteBenchmarkError,
  isValidDeterministicSearchResponse,
  nearestRankPercentile,
  parseBenchmarkArgs,
  runBetaResponsivenessBenchmark,
  summarizeLatencies,
  validateLoopbackOrigin,
  waitForOwnedSyncCompletion,
  type BenchmarkDependencies,
  type BenchmarkOptions,
  type BenchmarkState,
  type ContainerObservation,
  type LogObservation,
  type ProbeSample
} from "../scripts/benchmark-beta-responsiveness";

const testAdminToken = "test-admin-token";
type ReportInput = Parameters<typeof buildPublicReport>[0];
type CompletionFixture = ReportInput["completion"];
const embeddingCheckCodes = [
  "embedding_stage_observed",
  "health_overlapped_embedding",
  "embedding_configured",
  "embedding_attempted",
  "embedding_completed",
  "sync_stage_warming_embeddings",
  "health_embedding_p99"
] as const;

describe("beta responsiveness benchmark", () => {
  it("parses a strict loopback candidate invocation without accepting a CLI token", () => {
    const options = parseBenchmarkArgs(validArgs(), { MOODARR_BENCH_ADMIN_TOKEN: testAdminToken });

    expect(options).toMatchObject({
      baseUrl: "http://127.0.0.1:4401",
      container: "moodarr-beta-candidate",
      dataVolume: "moodarr-beta-benchmark-data",
      expectedVersion: "0.1.0-beta.1",
      minimumCatalogItems: 80_000,
      aiMode: "openai",
      confirmedDisposableData: true,
      confirmedExternalProcessing: true
    });
    expect(options.adminToken).toBe(testAdminToken);

    expect(() => parseBenchmarkArgs([...validArgs(), "--admin-token", "unsafe"], { MOODARR_BENCH_ADMIN_TOKEN: "x" }))
      .toThrowError(expect.objectContaining({ code: "token_cli_argument_rejected" }));
    const undersized = validArgs();
    undersized[undersized.indexOf("--min-catalog-items") + 1] = "79999";
    expect(() => parseBenchmarkArgs(undersized, { MOODARR_BENCH_ADMIN_TOKEN: "x" }))
      .toThrowError(expect.objectContaining({ code: "invalid_minimum_catalog_items" }));
  });

  it("requires an explicit AI mode and applies mode-specific external-processing confirmation rules", () => {
    const noAiArgs = validArgs("none");
    const noAiOptions = parseBenchmarkArgs(noAiArgs, { MOODARR_BENCH_ADMIN_TOKEN: testAdminToken });

    expect(noAiOptions).toMatchObject({ aiMode: "none", confirmedExternalProcessing: false });
    expect(() => parseBenchmarkArgs(
      [...noAiArgs, "--confirm-external-processing"],
      { MOODARR_BENCH_ADMIN_TOKEN: testAdminToken }
    )).toThrowError(expect.objectContaining({ code: "external_processing_confirmation_not_allowed" }));

    const openAiWithoutConfirmation = validArgs("openai").filter((value) => value !== "--confirm-external-processing");
    expect(() => parseBenchmarkArgs(openAiWithoutConfirmation, { MOODARR_BENCH_ADMIN_TOKEN: testAdminToken }))
      .toThrowError(expect.objectContaining({ code: "external_processing_not_confirmed" }));

    const missingMode = validArgs().filter((value, index, values) => value !== "--ai-mode" && values[index - 1] !== "--ai-mode");
    expect(() => parseBenchmarkArgs(missingMode, { MOODARR_BENCH_ADMIN_TOKEN: testAdminToken }))
      .toThrowError(expect.objectContaining({ code: "missing_required_option" }));

    const invalidMode = validArgs();
    invalidMode[invalidMode.indexOf("--ai-mode") + 1] = "local";
    expect(() => parseBenchmarkArgs(invalidMode, { MOODARR_BENCH_ADMIN_TOKEN: testAdminToken }))
      .toThrowError(expect.objectContaining({ code: "invalid_ai_mode" }));
  });

  it("rejects non-loopback, credential-bearing, and path-bearing origins", () => {
    for (const value of [
      "https://moodarr.example.com",
      "http://user:password@127.0.0.1:4401",
      "http://127.0.0.1:4401/api",
      "http://localhost:4401",
      "file:///tmp/moodarr"
    ]) {
      expect(() => validateLoopbackOrigin(value)).toThrow(IncompleteBenchmarkError);
    }
    expect(() => validateLoopbackOrigin("http://127.0.0.1:4401")).not.toThrow();
    expect(() => validateLoopbackOrigin("http://[::1]:4401")).not.toThrow();
  });

  it("requires a successful deterministic search contract", () => {
    const valid = {
      query: "generic benchmark query",
      optimizedQuery: "generic benchmark query",
      usedAi: false,
      summary: "Deterministic benchmark response.",
      resultLimit: 20,
      diagnostics: { engineVersion: "moodrank-test", seerrAugmented: false, latencyMs: 10 },
      results: [{ id: "redacted", title: "Redacted result" }]
    };

    expect(isValidDeterministicSearchResponse(valid)).toBe(true);
    expect(isValidDeterministicSearchResponse({ ...valid, usedAi: true })).toBe(false);
    expect(isValidDeterministicSearchResponse({ ...valid, results: [] })).toBe(false);
    expect(isValidDeterministicSearchResponse(null)).toBe(false);
  });

  it("uses nearest-rank percentiles without mutating input or false-passing empty data", () => {
    const values = Array.from({ length: 100 }, (_, index) => 100 - index);
    const original = [...values];

    expect(nearestRankPercentile(values, 0.5)).toBe(50);
    expect(nearestRankPercentile(values, 0.95)).toBe(95);
    expect(nearestRankPercentile(values, 0.99)).toBe(99);
    expect(nearestRankPercentile([4, 1, 3, 2], 0.95)).toBe(4);
    expect(nearestRankPercentile([], 0.95)).toBeUndefined();
    expect(nearestRankPercentile([1, Number.NaN], 0.95)).toBeUndefined();
    expect(nearestRankPercentile([-1], 0.95)).toBeUndefined();
    expect(values).toEqual(original);
  });

  it("summarizes valid samples and rejects invalid latency evidence", () => {
    const samples = [1, 2, 3, 4].map((latencyMs) => sample(latencyMs));
    expect(summarizeLatencies(samples)).toEqual({ count: 4, minMs: 1, p50Ms: 2, p95Ms: 4, p99Ms: 4, maxMs: 4 });
    expect(summarizeLatencies([])).toBeUndefined();
    expect(summarizeLatencies([sample(Number.POSITIVE_INFINITY)])).toBeUndefined();
  });

  it("passes only complete threshold evidence and emits an allowlisted public report", () => {
    const report = buildPublicReport(reportInput());
    const serialized = JSON.stringify(report);

    expect(report.incompleteReasons).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(report.status).toBe("passed");
    expect(report.schemaVersion).toBe("moodarr-beta-responsiveness-v2");
    expect(report.aiMode).toBe("openai");
    expect(report.environment.externalProcessingConfirmed).toBe(true);
    expect(report.checks).toEqual(expect.arrayContaining([
      { code: "ai_provider_configured", status: "passed" },
      { code: "embedding_completed", status: "passed" },
      { code: "health_embedding_p99", status: "passed" }
    ]));
    expect(report.metrics.health?.p99Ms).toBe(249);
    expect(report.metrics.search?.p95Ms).toBe(5_000);
    for (const forbidden of [
      testAdminToken,
      "http://127.0.0.1:4401",
      "moodarr-beta-candidate",
      "private.registry.local",
      "production-clone-2026-07",
      "/mnt/user/appdata",
      "Secret Movie Title",
      "feel-good comedy already in Plex"
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("passes AI-off evidence without embedding gates while preserving all common gates", () => {
    const report = buildPublicReport(noAiReportInput());
    const checkCodes = report.checks.map((check) => check.code);

    expect(report.status).toBe("passed");
    expect(report.schemaVersion).toBe("moodarr-beta-responsiveness-v2");
    expect(report.aiMode).toBe("none");
    expect(report.environment.externalProcessingConfirmed).toBe(false);
    expect(report.workload.sync.embedding).toMatchObject({ configured: false, attempted: 0, embedded: 0 });
    expect(report.metrics.healthDuringEmbedding).toBeUndefined();
    expect(report.checks).toEqual(expect.arrayContaining([
      { code: "ai_provider_disabled", status: "passed" },
      { code: "external_processing_confirmation_absent", status: "passed" },
      { code: "sync_completed", status: "passed" },
      { code: "full_sync_counts", status: "passed" },
      { code: "health_overlapped_diagnostics", status: "passed" },
      { code: "health_p99", status: "passed" },
      { code: "search_p95", status: "passed" },
      { code: "container_envelope_stable", status: "passed" },
      { code: "no_sqlite_lock", status: "passed" }
    ]));
    for (const code of embeddingCheckCodes) expect(checkCodes).not.toContain(code);
  });

  it("does not let direct report construction bypass AI mode or confirmation evidence", () => {
    const noAiWithOpenAi = noAiReportInput();
    noAiWithOpenAi.config.ai = { providerPolicy: "configurable", provider: "openai", configured: true };
    noAiWithOpenAi.options.confirmedExternalProcessing = true;
    const noAiReport = buildPublicReport(noAiWithOpenAi);
    expect(noAiReport.failures).toEqual(expect.arrayContaining([
      "ai_provider_disabled",
      "external_processing_confirmation_absent"
    ]));
    expect(noAiReport.environment.externalProcessingConfirmed).toBe(false);

    const noAiWithUnexpectedEmbedding = noAiReportInput();
    noAiWithUnexpectedEmbedding.completion.providerEmbeddings = {
      configured: true,
      attempted: 1,
      embedded: 1,
      hasMore: false
    };
    expect(buildPublicReport(noAiWithUnexpectedEmbedding).failures).toContain("ai_provider_disabled");

    const openAiWithoutProviderOrConfirmation = reportInput();
    openAiWithoutProviderOrConfirmation.config.ai = { providerPolicy: "none", provider: "none", configured: false };
    openAiWithoutProviderOrConfirmation.options.confirmedExternalProcessing = false;
    const openAiReport = buildPublicReport(openAiWithoutProviderOrConfirmation);
    expect(openAiReport.failures).toContain("ai_provider_configured");
    expect(openAiReport.incompleteReasons).toContain("external_processing_confirmed");
  });

  it("fails closed and reports the observed TMDB policy instead of claiming none", () => {
    const input = reportInput();
    input.health.policies.tmdbContent = "configurable";

    const report = buildPublicReport(input);

    expect(report.status).toBe("failed");
    expect(report.failures).toContain("tmdb_content_policy_none");
    expect(report.candidate.tmdbContentPolicy).toBe("configurable");
  });

  it("fails latency, HTTP, SQLite, restart, and OOM regressions", () => {
    const input = reportInput();
    input.samples.health[98] = sample(251, { stage: "warming_embeddings" });
    input.samples.health[99] = sample(251, { stage: "warming_embeddings" });
    input.samples.search[18] = sample(5_001);
    input.samples.search[19] = sample(5_001);
    input.samples.search[0] = sample(10, { ok: false, statusCode: 500, errorCategory: "http_500" });
    input.logs.sqliteBusyCount = 1;
    input.containerAfter.restartCount = 1;
    input.containerAfter.oomKilled = true;
    input.dockerHealthChecks = [{ startedAt: "2026-07-13T00:05:00.000Z", exitCode: 1 }];
    input.dockerUnhealthyStateObservations = 1;

    const report = buildPublicReport(input);

    expect(report.status).toBe("failed");
    expect(report.failures).toEqual(expect.arrayContaining([
      "health_p99",
      "search_p95",
      "probe_http",
      "no_sqlite_lock",
      "no_restart",
      "no_oom",
      "docker_health_no_observed_failure"
    ]));
  });

  it("marks missing sample and embedding evidence incomplete", () => {
    const input = reportInput();
    input.samples.health = input.samples.health.slice(0, 99);
    input.samples.search = input.samples.search.slice(0, 19);
    input.samples.diagnostics = input.samples.diagnostics.slice(0, 4);
    input.completion.providerEmbeddings = {
      configured: false,
      attempted: 0,
      embedded: 0,
      compatibleCount: 0,
      staleCount: 0,
      hasMore: false
    };
    input.observedStages = input.observedStages.filter((stage) => stage !== "warming_embeddings");

    const report = buildPublicReport(input);

    expect(report.status).toBe("incomplete");
    expect(report.incompleteReasons).toEqual(expect.arrayContaining([
      "health_samples",
      "search_samples",
      "diagnostics_samples",
      "embedding_stage_observed",
      "embedding_configured",
      "embedding_attempted"
    ]));
    expect(report.incompleteReasons).toContain("embedding_completed");
  });

  it("does not false-pass thin phase evidence or a materially shrunken catalog", () => {
    const input = reportInput();
    input.samples.health = input.samples.health.map((entry, index) => ({
      ...entry,
      stage: index === 0 ? "warming_embeddings" as const : "ingesting_plex" as const,
      diagnosticsActive: index === 0
    }));
    input.statsAfter.totalItems = Math.floor(input.statsBefore.totalItems * 0.94);

    const report = buildPublicReport(input);

    expect(report.status).toBe("failed");
    expect(report.incompleteReasons).toEqual(expect.arrayContaining([
      "health_overlapped_embedding",
      "health_overlapped_diagnostics"
    ]));
    expect(report.failures).toContain("catalog_preserved");
  });

  it("fails partial embedding storage and source-specific catalog loss", () => {
    const input = reportInput();
    input.completion.providerEmbeddings!.embedded = input.completion.providerEmbeddings!.attempted - 1;
    input.statsAfter.plexItems = Math.floor(input.statsBefore.plexItems * 0.94);
    input.statsAfter.seerrItems = Math.floor(input.statsBefore.seerrItems * 0.94);

    const report = buildPublicReport(input);

    expect(report.status).toBe("failed");
    expect(report.failures).toEqual(expect.arrayContaining([
      "embedding_completed",
      "plex_catalog_preserved",
      "seerr_catalog_preserved"
    ]));
  });

  it("fails an implausibly low Seerr sync without confusing request rows with unique media", () => {
    const low = reportInput();
    low.completion.seerrItems = 1;
    expect(buildPublicReport(low).failures).toContain("seerr_sync_count_preserved");

    const duplicateRequests = reportInput();
    duplicateRequests.completion.seerrItems = 10_000;
    expect(buildPublicReport(duplicateRequests).status).toBe("passed");
  });

  it("marks an empty log stream as incomplete evidence", () => {
    const input = reportInput();
    input.logs.bytesScanned = 0;

    const report = buildPublicReport(input);

    expect(report.status).toBe("incomplete");
    expect(report.incompleteReasons).toContain("log_observability");
  });

  it("ignores a stale result and owns the newly accepted sync completion", async () => {
    const oldResult = completion("2026-07-12T00:00:00.000Z", "2026-07-12T00:01:00.000Z");
    const newResult = completion("2026-07-13T00:00:00.010Z", "2026-07-13T00:01:00.000Z");
    const responses = [
      syncStatus(true, oldResult, "ingesting_plex"),
      syncStatus(false, oldResult),
      syncStatus(false, newResult)
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(responses.shift()), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    const dependencies = fakeDependencies(fetchMock as typeof fetch);
    const state: BenchmarkState = { done: false, syncActive: true, diagnosticsActive: false, observedStages: new Set() };

    const result = await waitForOwnedSyncCompletion(
      benchmarkOptions(),
      dependencies,
      syncStatus(false, oldResult),
      { accepted: true, running: true, startedAt: "2026-07-13T00:00:00.000Z" },
      state,
      new AbortController().signal
    );

    expect(result.finishedAt).toBe(newResult.finishedAt);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(state.observedStages).toContain("ingesting_plex");
  });

  it("rejects an unobserved terminal result as unproven sync ownership", async () => {
    const oldResult = completion("2026-07-12T00:00:00.000Z", "2026-07-12T00:01:00.000Z");
    const fetchMock = vi.fn(async () => jsonResponse(syncStatus(false, completion())));
    const state: BenchmarkState = { done: false, syncActive: true, diagnosticsActive: false, observedStages: new Set() };

    await expect(waitForOwnedSyncCompletion(
      benchmarkOptions(),
      fakeDependencies(fetchMock as typeof fetch),
      syncStatus(false, oldResult),
      { accepted: true, running: true, startedAt: "2026-07-13T00:00:00.000Z" },
      state,
      new AbortController().signal
    )).rejects.toMatchObject({ code: "sync_ownership_unproven" });
  });

  it("rejects mismatched candidate port, volume, and privilege envelopes before HTTP work", async () => {
    for (const mutate of [
      (container: ContainerObservation) => { container.portBindings["4401/tcp"]![0]!.HostPort = "4402"; },
      (container: ContainerObservation) => { container.mounts[0]!.name = "unexpected-volume"; },
      (container: ContainerObservation) => { container.capAdd = ["NET_ADMIN"]; },
      (container: ContainerObservation) => { container.tmpfs["/tmp"] += ",exec"; },
      (container: ContainerObservation) => { container.initEnabled = false; },
      (container: ContainerObservation) => { container.healthcheckIntervalNs = 1_000_000_000; },
      (container: ContainerObservation) => { container.localDockerDaemon = false; },
      (container: ContainerObservation) => { container.volumeExclusiveToContainer = false; }
    ]) {
      const container = containerObservation();
      mutate(container);
      const fetchMock = vi.fn();

      await expect(runBetaResponsivenessBenchmark(benchmarkOptions(), {
        ...fakeDependencies(fetchMock as typeof fetch),
        inspectContainer: () => container
      })).rejects.toBeInstanceOf(IncompleteBenchmarkError);
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it("rejects a dirty or stale harness checkout before container or HTTP work", async () => {
    const fetchMock = vi.fn();
    const inspectMock = vi.fn(() => containerObservation());

    await expect(runBetaResponsivenessBenchmark(benchmarkOptions(), {
      ...fakeDependencies(fetchMock as typeof fetch),
      inspectHarnessSource: () => ({ revision: "d".repeat(40), scriptSha256: "e".repeat(64), clean: false }),
      inspectContainer: inspectMock
    })).rejects.toMatchObject({ code: "harness_source_mismatch" });
    expect(inspectMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects AI runtime mode, provider readiness, and confirmation mismatches during preflight", async () => {
    const cases: Array<{
      options: BenchmarkOptions;
      runtimeAi: ReportInput["config"]["ai"];
      expectedCode: string;
    }> = [
      {
        options: benchmarkOptions("openai"),
        runtimeAi: { providerPolicy: "none", provider: "none", configured: false },
        expectedCode: "ai_mode_mismatch"
      },
      {
        options: benchmarkOptions("none"),
        runtimeAi: { providerPolicy: "configurable", provider: "openai", configured: true },
        expectedCode: "ai_mode_mismatch"
      },
      {
        options: benchmarkOptions("openai"),
        runtimeAi: { providerPolicy: "configurable", provider: "openai", configured: false },
        expectedCode: "embedding_provider_not_configured"
      },
      {
        options: benchmarkOptions("none"),
        runtimeAi: { providerPolicy: "none", provider: "none", configured: true },
        expectedCode: "ai_provider_not_disabled"
      },
      {
        options: { ...benchmarkOptions("openai"), confirmedExternalProcessing: false },
        runtimeAi: { providerPolicy: "configurable", provider: "openai", configured: true },
        expectedCode: "external_processing_not_confirmed"
      },
      {
        options: { ...benchmarkOptions("none"), confirmedExternalProcessing: true },
        runtimeAi: { providerPolicy: "none", provider: "none", configured: false },
        expectedCode: "external_processing_confirmation_not_allowed"
      }
    ];

    for (const entry of cases) {
      const fetchMock = preflightFetch(entry.runtimeAi);
      await expect(runBetaResponsivenessBenchmark(entry.options, {
        ...fakeDependencies(fetchMock as typeof fetch, entry.options.aiMode)
      })).rejects.toMatchObject({ code: entry.expectedCode });
      expect(fetchMock.mock.calls.some(([input, init]) => {
        const url = new URL(String(input));
        return url.pathname === "/api/admin/sync/run" && (init?.method ?? "GET") === "POST";
      })).toBe(false);
    }
  });

  it("runs the AI-on workload through only the release-evidence route allowlist", async () => {
    const fixture = workloadFixture("openai");
    const report = await runBetaResponsivenessBenchmark(benchmarkOptions("openai"), fixture.dependencies);

    expectCompleteWorkloadReport(report, fixture.calls);
    expect(report.aiMode).toBe("openai");
    expect(report.checks).toEqual(expect.arrayContaining([
      { code: "ai_provider_configured", status: "passed" },
      { code: "embedding_completed", status: "passed" },
      { code: "health_embedding_p99", status: "passed" }
    ]));
  });

  it("runs the full AI-off workload without requiring embedding evidence", async () => {
    const fixture = workloadFixture("none");
    const report = await runBetaResponsivenessBenchmark(benchmarkOptions("none"), fixture.dependencies);

    expectCompleteWorkloadReport(report, fixture.calls);
    expect(report.aiMode).toBe("none");
    expect(report.environment.externalProcessingConfirmed).toBe(false);
    expect(report.samples.health.some((sample) => sample.stage === "warming_embeddings")).toBe(true);
    expect(report.metrics.healthDuringEmbedding).toBeUndefined();
    expect(report.checks).toContainEqual({ code: "ai_provider_disabled", status: "passed" });
    for (const code of embeddingCheckCodes) {
      expect(report.checks.some((check) => check.code === code)).toBe(false);
    }
  });
});

function validArgs(aiMode: BenchmarkOptions["aiMode"] = "openai") {
  const args = [
    "--base-url", "http://127.0.0.1:4401",
    "--container", "moodarr-beta-candidate",
    "--data-volume", "moodarr-beta-benchmark-data",
    "--candidate-digest", `sha256:${"a".repeat(64)}`,
    "--expected-revision", "b".repeat(40),
    "--expected-version", "0.1.0-beta.1",
    "--catalog-label", "production-clone-2026-07",
    "--min-catalog-items", "80000",
    "--ai-mode", aiMode,
    "--confirm-disposable-data"
  ];
  if (aiMode === "openai") args.push("--confirm-external-processing");
  return args;
}

function benchmarkOptions(aiMode: BenchmarkOptions["aiMode"] = "openai"): BenchmarkOptions {
  return {
    baseUrl: "http://127.0.0.1:4401",
    container: "moodarr-beta-candidate",
    dataVolume: "moodarr-beta-benchmark-data",
    candidateDigest: `sha256:${"a".repeat(64)}`,
    expectedRevision: "b".repeat(40),
    expectedVersion: "0.1.0-beta.1",
    catalogLabel: "production-clone-2026-07",
    minimumCatalogItems: 80_000,
    aiMode,
    adminToken: testAdminToken,
    confirmedDisposableData: true,
    confirmedExternalProcessing: aiMode === "openai"
  };
}

function sample(latencyMs: number, overrides: Partial<ProbeSample> = {}): ProbeSample {
  return { offsetMs: 1, latencyMs, statusCode: 200, ok: true, diagnosticsActive: true, ...overrides };
}

function containerObservation(aiMode: BenchmarkOptions["aiMode"] = "openai"): ContainerObservation {
  return {
    containerId: "a".repeat(64),
    imageRef: `private.registry.local/moodarr@sha256:${"a".repeat(64)}`,
    imageId: "sha256:private-image-id",
    user: "999:999",
    running: true,
    startedAt: "2026-07-13T00:00:00.000Z",
    restartCount: 0,
    oomKilled: false,
    cpuLimit: 2_000_000_000,
    memoryBytes: 2 * 1024 * 1024 * 1024,
    memorySwapBytes: 2 * 1024 * 1024 * 1024,
    initEnabled: true,
    pidsLimit: 128,
    readOnly: true,
    privileged: false,
    capAdd: [],
    capDrop: ["ALL"],
    securityOpt: ["no-new-privileges:true"],
    tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=536870912,mode=1777" },
    portBindings: { "4401/tcp": [{ HostIp: "127.0.0.1", HostPort: "4401" }] },
    mounts: [{ type: "volume", name: "moodarr-beta-benchmark-data", destination: "/data", rw: true }],
    disposableLabel: "true",
    versionLabel: "0.1.0-beta.1",
    revisionLabel: "b".repeat(40),
    aiProviderPolicyLabel: aiMode === "none" ? "none" : "configurable",
    tmdbContentPolicyLabel: "none",
    architecture: "amd64",
    imageOperatingSystem: "linux",
    daemonArchitecture: "amd64",
    daemonOperatingSystem: "linux",
    localDockerDaemon: true,
    volumeDisposableLabel: "true",
    volumeExclusiveToContainer: true,
    healthStatus: "healthy",
    healthFailingStreak: 0,
    healthcheckTest: [
      "CMD",
      "/nodejs/bin/node",
      "-e",
      "fetch('http://127.0.0.1:4401/api/health').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
    ],
    healthcheckIntervalNs: 30_000_000_000,
    healthcheckTimeoutNs: 15_000_000_000,
    healthcheckStartPeriodNs: 20_000_000_000,
    healthcheckRetries: 3,
    healthChecks: [{ startedAt: "2026-07-13T00:00:00.000Z", exitCode: 0 }]
  };
}

function logs(): LogObservation {
  return { bytesScanned: 100, sqliteBusyCount: 0, server5xxCount: 0, oomMarkerCount: 0, fatalMarkerCount: 0 };
}

function harnessObservation() {
  return { revision: "b".repeat(40), scriptSha256: "c".repeat(64), clean: true };
}

function containerHealthObservation() {
  return {
    status: "healthy",
    failingStreak: 0,
    checks: [{ startedAt: "2026-07-13T00:00:00.000Z", exitCode: 0 }]
  };
}

function completion(
  startedAt = "2026-07-13T00:00:00.010Z",
  finishedAt = "2026-07-13T00:10:00.000Z"
): CompletionFixture {
  return {
    ok: true,
    plexItems: 3_188,
    seerrItems: 2_500,
    providerEmbeddings: {
      configured: true,
      attempted: 256,
      embedded: 256,
      compatibleCount: 9_000,
      staleCount: 0,
      hasMore: true
    },
    startedAt,
    finishedAt,
    durationMs: 600_000,
    stageDurationsMs: {
      fetching_plex: 1_000,
      ingesting_plex: 300_000,
      finalizing_plex: 10,
      fetching_seerr: 1_000,
      ingesting_seerr: 250_000,
      warming_embeddings: 48_000
    }
  };
}

function noAiCompletion(
  startedAt = "2026-07-13T00:00:00.010Z",
  finishedAt = "2026-07-13T00:10:00.000Z"
): CompletionFixture {
  const value = completion(startedAt, finishedAt);
  value.providerEmbeddings = {
    configured: false,
    attempted: 0,
    embedded: 0,
    hasMore: false
  };
  value.stageDurationsMs.warming_embeddings = 1;
  return value;
}

function syncStatus(
  running: boolean,
  lastResult: CompletionFixture = completion(),
  stage?: "ingesting_plex" | "warming_embeddings"
) {
  return {
    enabled: false,
    intervalMinutes: 0,
    syncSeerr: true,
    running,
    worker: { mode: "worker" as const, ready: true, running, closed: false, workerCount: 1 },
    progress: stage
      ? { stage, startedAt: "2026-07-13T00:00:00.010Z", updatedAt: "2026-07-13T00:00:30.000Z" }
      : undefined,
    lastResult
  };
}

function reportInput(): ReportInput {
  const options = benchmarkOptions();
  const containerBefore = containerObservation();
  const containerAfter = containerObservation();
  const health = Array.from({ length: 100 }, (_, index) => sample(index >= 98 ? 249 : 10, {
    stage: index < 20 ? "warming_embeddings" : "ingesting_plex"
  }));
  const search = Array.from({ length: 20 }, (_, index) => sample(index >= 18 ? 5_000 : 100));
  const diagnostics = Array.from({ length: 5 }, () => sample(1_000));
  return {
    options,
    startedAt: "2026-07-13T00:00:00.000Z",
    finishedAt: "2026-07-13T00:10:00.000Z",
    harness: harnessObservation(),
    health: {
      ok: true as const,
      fixtureMode: false as const,
      version: options.expectedVersion,
      revision: options.expectedRevision,
      database: "ok" as const,
      policies: { aiProvider: "configurable" as const, tmdbContent: "none" as const },
      search: { mode: "worker" as const, ready: true as const, closed: false as const, workerCount: 2 },
      sync: { mode: "worker" as const, ready: true as const, closed: false as const, workerCount: 1 }
    },
    config: {
      fixtureMode: false as const,
      plex: { configured: true },
      seerr: { configured: true, tmdbContentPolicy: "none" as const },
      ai: { providerPolicy: "configurable" as const, provider: "openai" as const, configured: true },
      admin: { authRequired: true, configured: true, autoSession: false },
      runtime: { syncIntervalMinutes: 0, syncSeerr: true }
    },
    statsBefore: { totalItems: 87_034, plexItems: 3_188, seerrItems: 4_172, alreadyRequested: 2_500, movies: 74_006, tv: 13_028 },
    statsAfter: { totalItems: 87_034, plexItems: 3_188, seerrItems: 4_172, alreadyRequested: 2_500, movies: 74_006, tv: 13_028 },
    completion: completion(),
    observedStages: [
      "fetching_plex",
      "ingesting_plex",
      "finalizing_plex",
      "fetching_seerr",
      "ingesting_seerr",
      "warming_embeddings"
    ],
    containerBefore,
    containerAfter,
    logs: logs(),
    dockerHealthChecks: containerHealthObservation().checks,
    dockerUnhealthyStateObservations: 0,
    samples: { health, search, diagnostics }
  };
}

function noAiReportInput(): ReportInput {
  const input = reportInput();
  input.options = benchmarkOptions("none");
  input.config.ai = { providerPolicy: "none", provider: "none", configured: false };
  input.health.policies.aiProvider = "none";
  input.containerBefore.aiProviderPolicyLabel = "none";
  input.containerAfter.aiProviderPolicyLabel = "none";
  input.completion = noAiCompletion();
  input.observedStages = input.observedStages.filter((stage) => stage !== "warming_embeddings");
  input.samples.health = input.samples.health.map((entry) => ({ ...entry, stage: "ingesting_plex" }));
  return input;
}

function fakeDependencies(fetchImplementation: typeof fetch, aiMode: BenchmarkOptions["aiMode"] = "openai"): BenchmarkDependencies {
  return {
    fetch: fetchImplementation,
    inspectHarnessSource: harnessObservation,
    inspectContainer: () => containerObservation(aiMode),
    inspectContainerHealth: containerHealthObservation,
    readContainerLogs: logs,
    monotonicNow: () => 0,
    wallClockNow: () => new Date("2026-07-13T00:00:00.000Z"),
    sleep: async () => {}
  };
}

function preflightFetch(runtimeAi: ReportInput["config"]["ai"]) {
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const token = new Headers(init.headers).get("X-Moodarr-Admin-Token");
    if (url.pathname === "/api/health") {
      return jsonResponse({
        ok: true,
        fixtureMode: false,
        version: "0.1.0-beta.1",
        revision: "b".repeat(40),
        database: "ok",
        policies: { aiProvider: runtimeAi.providerPolicy, tmdbContent: "none" },
        search: { mode: "worker", ready: true, closed: false, workerCount: 2 },
        sync: { mode: "worker", ready: true, closed: false, workerCount: 1 }
      });
    }
    if (url.pathname === "/api/config/status") {
      return jsonResponse({
        fixtureMode: false,
        plex: { configured: true },
        seerr: { configured: true, tmdbContentPolicy: "none" },
        ai: runtimeAi,
        admin: { authRequired: true, configured: true, autoSession: false },
        runtime: { syncIntervalMinutes: 0, syncSeerr: true }
      });
    }
    if (url.pathname === "/api/library/stats") {
      return token === testAdminToken
        ? jsonResponse({ totalItems: 87_034, plexItems: 3_188, seerrItems: 4_172, alreadyRequested: 2_500, movies: 74_006, tv: 13_028 })
        : jsonResponse({ error: "unauthorized" }, 401);
    }
    if (url.pathname === "/api/admin/sync/status") {
      return token === testAdminToken
        ? jsonResponse(syncStatus(false))
        : jsonResponse({ error: "unauthorized" }, 401);
    }
    return jsonResponse({ error: "unexpected route" }, 599);
  });
}

function workloadFixture(aiMode: BenchmarkOptions["aiMode"]) {
  const oldResult = aiMode === "openai"
    ? completion("2026-07-12T00:00:00.000Z", "2026-07-12T00:01:00.000Z")
    : noAiCompletion("2026-07-12T00:00:00.000Z", "2026-07-12T00:01:00.000Z");
  const newResult = aiMode === "openai" ? completion() : noAiCompletion();
  let accepted = false;
  let healthCalls = 0;
  let searchCalls = 0;
  let diagnosticsCalls = 0;
  const calls: Array<{ method: string; path: string; body?: string }> = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? "GET";
    const token = new Headers(init.headers).get("X-Moodarr-Admin-Token");
    calls.push({ method, path: `${url.pathname}${url.search}`, body: typeof init.body === "string" ? init.body : undefined });

    if (url.pathname === "/api/health") {
      healthCalls += 1;
      return jsonResponse({
        ok: true,
        fixtureMode: false,
        version: "0.1.0-beta.1",
        revision: "b".repeat(40),
        database: "ok",
        policies: { aiProvider: aiMode === "openai" ? "configurable" : "none", tmdbContent: "none" },
        search: { mode: "worker", ready: true, closed: false, workerCount: 2 },
        sync: { mode: "worker", ready: true, closed: false, workerCount: 1 }
      });
    }
    if (url.pathname === "/api/config/status") {
      return jsonResponse({
        fixtureMode: false,
        plex: { configured: true },
        seerr: { configured: true, tmdbContentPolicy: "none" },
        ai: { providerPolicy: aiMode === "openai" ? "configurable" : "none", provider: aiMode, configured: aiMode === "openai" },
        admin: { authRequired: true, configured: true, autoSession: false },
        runtime: { syncIntervalMinutes: 0, syncSeerr: true }
      });
    }
    if (url.pathname === "/api/library/stats") {
      return token === testAdminToken
        ? jsonResponse({ totalItems: 87_034, plexItems: 3_188, seerrItems: 4_172, alreadyRequested: 2_500, movies: 74_006, tv: 13_028 })
        : jsonResponse({ error: "unauthorized" }, 401);
    }
    if (url.pathname === "/api/admin/sync/status") {
      if (token !== testAdminToken) return jsonResponse({ error: "unauthorized" }, 401);
      if (!accepted) return jsonResponse(syncStatus(false, oldResult));
      const workloadComplete = healthCalls >= 101 && searchCalls >= 20 && diagnosticsCalls >= 5;
      const stage = healthCalls >= 60 ? "warming_embeddings" : "ingesting_plex";
      return jsonResponse(workloadComplete
        ? syncStatus(false, newResult)
        : syncStatus(true, oldResult, stage));
    }
    if (url.pathname === "/api/admin/sync/run" && method === "POST") {
      accepted = true;
      return jsonResponse({ accepted: true, running: true, startedAt: "2026-07-13T00:00:00.000Z" }, 202);
    }
    if (url.pathname === "/api/search" && method === "POST") {
      searchCalls += 1;
      expect(JSON.parse(String(init.body))).toMatchObject({ useAi: false, resultLimit: 20, watchContext: "solo" });
      return jsonResponse({
        query: "generic benchmark query",
        optimizedQuery: "generic benchmark query",
        usedAi: false,
        summary: "Deterministic benchmark response.",
        resultLimit: 20,
        diagnostics: { engineVersion: "moodrank-test", seerrAugmented: false, latencyMs: 10 },
        results: [{ id: "redacted", title: "Redacted result" }]
      });
    }
    if (url.pathname === "/api/admin/recommendations/diagnostics") {
      diagnosticsCalls += 1;
      await Promise.resolve();
      await Promise.resolve();
      return jsonResponse({
        engineVersion: "moodrank-test",
        sessions: { total: 1, withAi: 0 },
        features: {
          mediaFeatureCount: 87_034,
          providerEmbeddingCount: aiMode === "openai" ? 9_000 : 0,
          embeddingModels: []
        }
      });
    }
    return jsonResponse({ error: "unexpected route" }, 599);
  });
  let monotonic = 0;
  const dependencies: BenchmarkDependencies = {
    fetch: fetchMock as typeof fetch,
    inspectHarnessSource: harnessObservation,
    inspectContainer: () => containerObservation(aiMode),
    inspectContainerHealth: containerHealthObservation,
    readContainerLogs: logs,
    monotonicNow: () => monotonic++,
    wallClockNow: () => new Date("2026-07-13T00:00:00.000Z"),
    sleep: async () => {}
  };
  return { calls, dependencies };
}

function expectCompleteWorkloadReport(
  report: Awaited<ReturnType<typeof runBetaResponsivenessBenchmark>>,
  calls: Array<{ method: string; path: string; body?: string }>
) {
  expect(report.incompleteReasons).toEqual([]);
  expect(report.failures).toEqual([]);
  expect(report.status).toBe("passed");
  expect(report.samples.health.length).toBeGreaterThanOrEqual(100);
  expect(report.samples.search.length).toBeGreaterThanOrEqual(20);
  expect(report.samples.diagnostics.length).toBeGreaterThanOrEqual(5);
  expect(calls.some((call) => call.method === "POST" && call.path === "/api/admin/sync/run" && call.body === "{}"))
    .toBe(true);
  expect(new Set(calls.map((call) => call.path))).toEqual(new Set([
    "/api/health",
    "/api/config/status",
    "/api/library/stats",
    "/api/admin/sync/status",
    "/api/admin/sync/run",
    "/api/search",
    "/api/admin/recommendations/diagnostics?fresh=true"
  ]));
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
