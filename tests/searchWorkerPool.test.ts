import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import type { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { SearchWorkerPool } from "../src/server/search/searchWorkerPool";

describe("SearchWorkerPool", () => {
  it("keeps the parent event loop responsive and bounds concurrent search admission", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-search-worker-"));
    const config = createTestConfig(directory);
    const db = createDatabase(config.dbPath);
    const repository = new MediaRepository(db);
    repository.upsertMany(
      Array.from({ length: 120 }, (_, index) => ({
        mediaType: "movie" as const,
        title: `Worker Movie ${index}`,
        year: 2000 + (index % 20),
        summary: "A cozy synthetic adventure with warm humor.",
        genres: ["Adventure", "Comedy"]
      }))
    );
    db.close();

    const pool = new SearchWorkerPool(config);
    try {
      await waitUntil(() => pool.status().ready);
      const startedAt = performance.now();
      const eventLoopTick = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - startedAt), 20));
      const searches = [1, 2, 3].map(() => pool.search({ query: "cozy adventure", useAi: false, resultLimit: 5 }));
      await expect(pool.search({ query: "overflow", useAi: false })).rejects.toMatchObject({ statusCode: 503 });

      expect(await eventLoopTick).toBeLessThan(200);
      const results = await Promise.all(searches);
      expect(results.every((result) => result.results.length > 0)).toBe(true);

      const diagnosticsStartedAt = performance.now();
      const diagnosticsTick = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - diagnosticsStartedAt), 20));
      const diagnostics = pool.recommendationDiagnostics();
      expect(pool.recommendationDiagnostics()).toBe(diagnostics);
      expect(await diagnosticsTick).toBeLessThan(200);
      await expect(diagnostics).resolves.toMatchObject({
        engineVersion: expect.any(String),
        features: { mediaFeatureCount: 120 }
      });
      const cachedDiagnosticsStartedAt = performance.now();
      await expect(pool.recommendationDiagnostics()).resolves.toMatchObject({ features: { mediaFeatureCount: 120 } });
      expect(performance.now() - cachedDiagnosticsStartedAt).toBeLessThan(200);
      const verificationDb = createDatabase(config.dbPath);
      expect((verificationDb.prepare("SELECT COUNT(*) AS value FROM preference_profiles").get() as { value: number }).value).toBe(0);
      verificationDb.close();

      await Promise.all(Array.from({ length: 20 }, () => pool.restart(config)));
      await waitUntil(() => pool.status().ready);
      expect(pool.status()).toMatchObject({
        closed: false,
        ready: true,
        workerCount: 2,
        capacity: 4,
        roles: {
          search: { ready: true, running: false, queued: 0, capacity: 3 },
          diagnostics: { ready: true, running: false, queued: 0, capacity: 1 }
        }
      });

      const closingRestarts = Array.from({ length: 20 }, () => pool.restart(config));
      await Promise.all([...closingRestarts, pool.close()]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pool.status()).toMatchObject({ closed: true, ready: false, running: false, queued: 0, workerCount: 0 });
    } finally {
      await pool.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it.each([
    { behavior: "crash-once" as const, expectedStatusCode: 503 },
    { behavior: "timeout-once" as const, expectedStatusCode: 504 }
  ])("recovers diagnostics capacity after a $behavior fault without rejecting an active search or leaking workers", async ({ behavior, expectedStatusCode }) => {
    const directory = mkdtempSync(join(tmpdir(), `moodarr-search-worker-${behavior}-`));
    const config = createTestConfig(directory);
    const runtimeUrl = createTestWorkerRuntime(directory, behavior);
    const pool = new SearchWorkerPool(config, {
      runtimeUrl,
      ...(behavior === "timeout-once" ? { recommendationDiagnosticsDeadlineMs: 25, workerTerminationGraceMs: 5 } : {})
    });

    try {
      await waitUntil(() => pool.status().ready);
      const query = `search survives diagnostics ${behavior}`;
      const search = pool.search({ query, useAi: false, resultLimit: 5 });
      await waitUntil(() => pool.status().roles.search.running);

      const diagnostics = pool.recommendationDiagnostics({ fresh: true });
      expect(pool.status()).toMatchObject({
        running: true,
        runningCount: 2,
        queued: 0,
        capacity: 4,
        roles: {
          search: { running: true, capacity: 3 },
          diagnostics: { running: true, capacity: 1 }
        }
      });
      await expect(diagnostics).rejects.toMatchObject({ statusCode: expectedStatusCode });
      await expect(search).resolves.toMatchObject({ query });

      await waitUntil(() => pool.status().ready && pool.status().workerCount === 2);
      await expect(pool.recommendationDiagnostics({ fresh: true })).resolves.toMatchObject({ engineVersion: "test-diagnostics" });
      expect(pool.status()).toMatchObject({
        ready: true,
        running: false,
        queued: 0,
        workerCount: 2,
        roles: {
          search: { ready: true, capacity: 3 },
          diagnostics: { ready: true, capacity: 1 }
        }
      });
    } finally {
      await pool.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("bounds readiness retries for both roles, rejects queued work, and stops without leaking workers", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-search-worker-never-ready-"));
    const config = createTestConfig(directory);
    const pool = new SearchWorkerPool(config, {
      runtimeUrl: new URL("./fixtures/neverReadyWorker.ts", import.meta.url),
      workerReadyDeadlineMs: 25,
      maxWorkerReadyAttempts: 2
    });

    try {
      const search = pool.search({ query: "queued while starting", useAi: false });
      const diagnostics = pool.recommendationDiagnostics({ fresh: true });
      await Promise.all([
        expect(search).rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining("did not become ready") }),
        expect(diagnostics).rejects.toMatchObject({ statusCode: 503, message: expect.stringContaining("did not become ready") })
      ]);
      await waitUntil(() => pool.status().state === "degraded" && pool.status().workerCount === 0);
      expect(pool.status()).toMatchObject({
        ready: false,
        state: "degraded",
        degraded: true,
        running: false,
        queued: 0,
        workerCount: 0,
        roles: {
          search: { ready: false, state: "degraded", degraded: true, queued: 0 },
          diagnostics: { ready: false, state: "degraded", degraded: true, queued: 0 }
        }
      });
      await expect(pool.search({ query: "rejected after degradation", useAi: false })).rejects.toMatchObject({ statusCode: 503 });
      await expect(pool.recommendationDiagnostics({ fresh: true })).rejects.toMatchObject({ statusCode: 503 });
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(pool.status().workerCount).toBe(0);
    } finally {
      await pool.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("ignores stale role failures after a full restart has replaced both worker generations", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-search-worker-stale-reset-"));
    const config = createTestConfig(directory);
    const pool = new SearchWorkerPool(config, {
      runtimeUrl: new URL("./fixtures/neverReadyWorker.ts", import.meta.url),
      workerReadyDeadlineMs: 60_000
    });
    const internals = pool as unknown as {
      lifecycle: Promise<void>;
      worker: Worker | undefined;
      diagnosticsWorker: Worker | undefined;
      searchReadinessFailures: number;
      diagnosticsReadinessFailures: number;
      spawnWorker: (runtimeUrl: URL, sourceRuntime: boolean, role: "search" | "diagnostics") => Worker;
      onWorkerFailure: (worker: Worker, error: Error) => Promise<void>;
    };

    try {
      const oldSearchWorker = internals.worker;
      const oldDiagnosticsWorker = internals.diagnosticsWorker;
      expect(oldSearchWorker).toBeDefined();
      expect(oldDiagnosticsWorker).toBeDefined();

      let releaseLifecycle!: () => void;
      internals.lifecycle = new Promise<void>((resolve) => {
        releaseLifecycle = resolve;
      });
      const spawned: Array<{ worker: Worker; role: "search" | "diagnostics" }> = [];
      const spawnWorker = internals.spawnWorker.bind(pool);
      internals.spawnWorker = (runtimeUrl, sourceRuntime, role) => {
        const worker = spawnWorker(runtimeUrl, sourceRuntime, role);
        spawned.push({ worker, role });
        return worker;
      };

      const restart = pool.restart(config);
      const staleSearchFailure = internals.onWorkerFailure(oldSearchWorker!, new Error("Stale search worker failure."));
      const staleDiagnosticsFailure = internals.onWorkerFailure(oldDiagnosticsWorker!, new Error("Stale diagnostics worker failure."));
      releaseLifecycle();
      await Promise.all([restart, staleSearchFailure, staleDiagnosticsFailure]);

      expect(spawned.map(({ role }) => role)).toEqual(["search", "diagnostics"]);
      expect(internals.worker).toBe(spawned[0]?.worker);
      expect(internals.diagnosticsWorker).toBe(spawned[1]?.worker);
      expect(internals.searchReadinessFailures).toBe(0);
      expect(internals.diagnosticsReadinessFailures).toBe(0);
      expect(pool.status()).toMatchObject({ ready: false, state: "starting", degraded: false, workerCount: 2 });
    } finally {
      await pool.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects active diagnostics and cleans up both worker roles across restart and close", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-search-worker-lifecycle-"));
    const config = createTestConfig(directory);
    const runtimeUrl = createTestWorkerRuntime(directory, "hang");
    const pool = new SearchWorkerPool(config, { runtimeUrl });

    try {
      await waitUntil(() => pool.status().ready);
      const restartingDiagnostics = pool.recommendationDiagnostics({ fresh: true });
      await waitUntil(() => pool.status().roles.diagnostics.running);
      const restartRejection = expect(restartingDiagnostics).rejects.toMatchObject({ statusCode: 503 });
      await Promise.all([restartRejection, pool.restart(config)]);

      await waitUntil(() => pool.status().ready && pool.status().workerCount === 2);
      const closingDiagnostics = pool.recommendationDiagnostics({ fresh: true });
      await waitUntil(() => pool.status().roles.diagnostics.running);
      const closeRejection = expect(closingDiagnostics).rejects.toMatchObject({ statusCode: 503 });
      await Promise.all([closeRejection, pool.close()]);

      expect(pool.status()).toMatchObject({
        closed: true,
        ready: false,
        running: false,
        runningCount: 0,
        queued: 0,
        workerCount: 0,
        roles: {
          search: { ready: false, running: false, queued: 0 },
          diagnostics: { ready: false, running: false, queued: 0 }
        }
      });
    } finally {
      await pool.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});

function createTestConfig(directory: string) {
  return loadConfig({
    MOODARR_DATA_DIR: directory,
    MOODARR_DB_PATH: join(directory, "moodarr.sqlite"),
    MOODARR_CONFIG_PATH: join(directory, "config.json"),
    MOODARR_FIXTURE_MODE: "true",
    MOODARR_REQUIRE_ADMIN_TOKEN: "false",
    MOODARR_API_HOST: "127.0.0.1",
    MOODARR_SYNC_INTERVAL_MINUTES: "0"
  });
}

function createTestWorkerRuntime(directory: string, diagnosticsBehavior: "crash-once" | "timeout-once" | "hang") {
  const runtimePath = join(directory, `search-worker-${diagnosticsBehavior}.mjs`);
  const crashMarkerPath = join(directory, "diagnostics-crashed");
  writeFileSync(
    runtimePath,
    `
      import { existsSync, writeFileSync } from "node:fs";
      import { parentPort, workerData } from "node:worker_threads";

      const behavior = ${JSON.stringify(diagnosticsBehavior)};
      const crashMarkerPath = ${JSON.stringify(crashMarkerPath)};
      const emptyGroups = {
        available_in_plex: [],
        not_in_plex_requestable: [],
        already_requested: [],
        partially_available: [],
        unavailable: []
      };

      parentPort.on("message", (message) => {
        if (workerData.role === "search" && message.type === "search") {
          setTimeout(() => parentPort.postMessage({
            type: "searchResult",
            id: message.id,
            result: {
              query: message.request.query,
              optimizedQuery: message.request.query,
              usedAi: false,
              summary: "Synthetic worker result.",
              refinementOptions: [],
              resolvedFilters: {},
              watchContext: "solo",
              resultLimit: message.request.resultLimit ?? 5,
              groups: emptyGroups,
              results: []
            }
          }), 150);
          return;
        }
        if (workerData.role !== "diagnostics" || message.type !== "recommendationDiagnostics") return;
        if (behavior === "hang") return;
        if (!existsSync(crashMarkerPath)) {
          writeFileSync(crashMarkerPath, "crashed");
          if (behavior === "crash-once") process.exit(19);
          return;
        }
        parentPort.postMessage({
          type: "recommendationDiagnosticsResult",
          id: message.id,
          result: { engineVersion: "test-diagnostics" }
        });
      });

      parentPort.postMessage({ type: "ready", role: workerData.role });
    `
  );
  expect(existsSync(runtimePath)).toBe(true);
  return pathToFileURL(runtimePath);
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Search worker did not become ready.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
