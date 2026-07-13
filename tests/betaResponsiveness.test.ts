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

describe("beta responsiveness benchmark", () => {
  it("parses a strict loopback candidate invocation without accepting a CLI token", () => {
    const options = parseBenchmarkArgs(validArgs(), { MOODARR_BENCH_ADMIN_TOKEN: "private-admin-value" });

    expect(options).toMatchObject({
      baseUrl: "http://127.0.0.1:4401",
      container: "moodarr-beta-candidate",
      dataVolume: "moodarr-beta-benchmark-data",
      expectedVersion: "0.1.0-beta.1",
      minimumCatalogItems: 80_000,
      confirmedDisposableData: true,
      confirmedExternalProcessing: true
    });
    expect(options.adminToken).toBe("private-admin-value");

    expect(() => parseBenchmarkArgs([...validArgs(), "--admin-token", "unsafe"], { MOODARR_BENCH_ADMIN_TOKEN: "x" }))
      .toThrowError(expect.objectContaining({ code: "token_cli_argument_rejected" }));
    const undersized = validArgs();
    undersized[undersized.indexOf("--min-catalog-items") + 1] = "79999";
    expect(() => parseBenchmarkArgs(undersized, { MOODARR_BENCH_ADMIN_TOKEN: "x" }))
      .toThrowError(expect.objectContaining({ code: "invalid_minimum_catalog_items" }));
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
    expect(report.metrics.health?.p99Ms).toBe(249);
    expect(report.metrics.search?.p95Ms).toBe(5_000);
    for (const forbidden of [
      "private-admin-value",
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
    const inspectMock = vi.fn(containerObservation);

    await expect(runBetaResponsivenessBenchmark(benchmarkOptions(), {
      ...fakeDependencies(fetchMock as typeof fetch),
      inspectHarnessSource: () => ({ revision: "d".repeat(40), scriptSha256: "e".repeat(64), clean: false }),
      inspectContainer: inspectMock
    })).rejects.toMatchObject({ code: "harness_source_mismatch" });
    expect(inspectMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("runs the bounded HTTP workload through only the release-evidence route allowlist", async () => {
    const oldResult = completion("2026-07-12T00:00:00.000Z", "2026-07-12T00:01:00.000Z");
    const newResult = completion();
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
          search: { mode: "worker", ready: true, closed: false, workerCount: 2 },
          sync: { mode: "worker", ready: true, closed: false, workerCount: 1 }
        });
      }
      if (url.pathname === "/api/config/status") {
        return jsonResponse({
          fixtureMode: false,
          plex: { configured: true },
          seerr: { configured: true },
          ai: { provider: "openai", configured: true },
          admin: { authRequired: true, configured: true, autoSession: false },
          runtime: { syncIntervalMinutes: 0, syncSeerr: true }
        });
      }
      if (url.pathname === "/api/library/stats") {
        return token === "private-admin-value"
          ? jsonResponse({ totalItems: 87_034, plexItems: 3_188, seerrItems: 4_172, alreadyRequested: 2_500, movies: 74_006, tv: 13_028 })
          : jsonResponse({ error: "unauthorized" }, 401);
      }
      if (url.pathname === "/api/admin/sync/status") {
        if (token !== "private-admin-value") return jsonResponse({ error: "unauthorized" }, 401);
        if (!accepted) return jsonResponse(syncStatus(false, oldResult));
        const workloadComplete = healthCalls >= 101 && searchCalls >= 20 && diagnosticsCalls >= 5;
        return jsonResponse(workloadComplete
          ? syncStatus(false, newResult)
          : syncStatus(true, oldResult, healthCalls >= 60 ? "warming_embeddings" : "ingesting_plex"));
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
          features: { mediaFeatureCount: 87_034, providerEmbeddingCount: 9_000, embeddingModels: [] }
        });
      }
      return jsonResponse({ error: "unexpected route" }, 599);
    });
    let monotonic = 0;
    const dependencies: BenchmarkDependencies = {
      fetch: fetchMock as typeof fetch,
      inspectHarnessSource: harnessObservation,
      inspectContainer: containerObservation,
      inspectContainerHealth: containerHealthObservation,
      readContainerLogs: logs,
      monotonicNow: () => monotonic++,
      wallClockNow: () => new Date("2026-07-13T00:00:00.000Z"),
      sleep: async () => {}
    };

    const report = await runBetaResponsivenessBenchmark(benchmarkOptions(), dependencies);

    expect(report.incompleteReasons).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(report.status).toBe("passed");
    expect(report.samples.health.length).toBeGreaterThanOrEqual(100);
    expect(report.samples.search.length).toBeGreaterThanOrEqual(20);
    expect(report.samples.diagnostics.length).toBeGreaterThanOrEqual(5);
    expect(calls.some((call) => call.method === "POST" && call.path === "/api/admin/sync/run" && call.body === "{}")).toBe(true);
    expect(new Set(calls.map((call) => call.path))).toEqual(new Set([
      "/api/health",
      "/api/config/status",
      "/api/library/stats",
      "/api/admin/sync/status",
      "/api/admin/sync/run",
      "/api/search",
      "/api/admin/recommendations/diagnostics?fresh=true"
    ]));
  });
});

function validArgs() {
  return [
    "--base-url", "http://127.0.0.1:4401",
    "--container", "moodarr-beta-candidate",
    "--data-volume", "moodarr-beta-benchmark-data",
    "--candidate-digest", `sha256:${"a".repeat(64)}`,
    "--expected-revision", "b".repeat(40),
    "--expected-version", "0.1.0-beta.1",
    "--catalog-label", "production-clone-2026-07",
    "--min-catalog-items", "80000",
    "--confirm-disposable-data",
    "--confirm-external-processing"
  ];
}

function benchmarkOptions(): BenchmarkOptions {
  return {
    baseUrl: "http://127.0.0.1:4401",
    container: "moodarr-beta-candidate",
    dataVolume: "moodarr-beta-benchmark-data",
    candidateDigest: `sha256:${"a".repeat(64)}`,
    expectedRevision: "b".repeat(40),
    expectedVersion: "0.1.0-beta.1",
    catalogLabel: "production-clone-2026-07",
    minimumCatalogItems: 80_000,
    adminToken: "private-admin-value",
    confirmedDisposableData: true,
    confirmedExternalProcessing: true
  };
}

function sample(latencyMs: number, overrides: Partial<ProbeSample> = {}): ProbeSample {
  return { offsetMs: 1, latencyMs, statusCode: 200, ok: true, diagnosticsActive: true, ...overrides };
}

function containerObservation(): ContainerObservation {
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

function completion(startedAt = "2026-07-13T00:00:00.010Z", finishedAt = "2026-07-13T00:10:00.000Z") {
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

function syncStatus(running: boolean, lastResult = completion(), stage?: "ingesting_plex" | "warming_embeddings") {
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

function reportInput() {
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
      search: { mode: "worker" as const, ready: true as const, closed: false as const, workerCount: 2 },
      sync: { mode: "worker" as const, ready: true as const, closed: false as const, workerCount: 1 }
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

function fakeDependencies(fetchImplementation: typeof fetch): BenchmarkDependencies {
  return {
    fetch: fetchImplementation,
    inspectHarnessSource: harnessObservation,
    inspectContainer: containerObservation,
    inspectContainerHealth: containerHealthObservation,
    readContainerLogs: logs,
    monotonicNow: () => 0,
    wallClockNow: () => new Date("2026-07-13T00:00:00.000Z"),
    sleep: async () => {}
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
