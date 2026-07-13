import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";
import { PlexClient } from "../src/server/integrations/plexClient";
import { SyncWorkerPool } from "../src/server/jobs/syncWorkerPool";
import { SearchWorkerPool } from "../src/server/search/searchWorkerPool";

describe("runtime health", () => {
  it("requires both liveness and worker readiness in the container healthcheck", () => {
    const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
    expect(dockerfile).toContain("r.ok&&h.ok===true&&h.ready===true");
    expect(dockerfile).not.toContain("process.exit(r.ok?0:1)");
  });

  it("keeps parent-owned startup repairs out of all worker runtimes", () => {
    for (const runtimePath of ["../src/server/jobs/syncWorkerRuntime.ts", "../src/server/search/searchWorkerRuntime.ts"]) {
      expect(readFileSync(new URL(runtimePath, import.meta.url), "utf8")).toContain(
        "new MediaRepository(db, { runStartupRepairs: false })"
      );
    }
  });

  it("reports package build information and probes database readiness", async () => {
    const db = createDatabase(":memory:");
    const app = createApp({ config: testConfig(), db });

    const healthy = await app.inject({ method: "GET", url: "/api/health" });
    expect(healthy.statusCode).toBe(200);
    expect(healthy.json()).toMatchObject({ ok: true, ready: true, state: "ready", database: "ok", version: "0.1.0-beta.1" });
    expect(healthy.headers["content-security-policy"]).toContain("default-src 'self'");

    db.close();
    const unavailable = await app.inject({ method: "GET", url: "/api/health" });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ ok: false, ready: false, state: "degraded", database: "error", version: "0.1.0-beta.1" });
    await app.close();
  });

  it("keeps sync progress, counts, and operational errors out of public health", async () => {
    const privateError = "private-library-title and upstream-operational-error";
    vi.spyOn(PlexClient.prototype, "syncLibrary").mockRejectedValueOnce(new Error(privateError));
    const db = createDatabase(":memory:");
    const config = {
      ...testConfig(),
      fixtureMode: false,
      plex: { baseUrl: "http://plex.example", token: "test-plex-token", webBaseUrl: "https://app.plex.tv/desktop" },
      knownSecrets: ["test-plex-token"]
    } satisfies AppConfig;
    const app = createApp({ config, db });

    expect((await app.inject({ method: "POST", url: "/api/library/sync" })).statusCode).toBe(202);
    let adminStatus = await app.inject({ method: "GET", url: "/api/admin/sync/status" });
    for (let attempt = 0; attempt < 20 && adminStatus.json<{ lastResult?: unknown }>().lastResult === undefined; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      adminStatus = await app.inject({ method: "GET", url: "/api/admin/sync/status" });
    }
    expect(adminStatus.body).toContain(privateError);

    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.body).not.toContain(privateError);
    expect(health.json().sync).toEqual({
      mode: "inline",
      ready: true,
      state: "ready",
      degraded: false,
      running: false,
      closed: false,
      workerCount: 0
    });
    expect(health.json().sync).not.toHaveProperty("progress");
    expect(health.json().sync).not.toHaveProperty("lastResult");

    await app.close();
  });

  it("grants finite startup grace before reporting required worker roles as degraded", async () => {
    const config = testConfig();
    const runtimeUrl = new URL("./fixtures/neverReadyWorker.ts", import.meta.url);
    const searchWorkers = new SearchWorkerPool(config, {
      runtimeUrl,
      workerReadyDeadlineMs: 25,
      maxWorkerReadyAttempts: 2
    });
    const syncWorker = new SyncWorkerPool(config, runtimeUrl, {
      workerReadyDeadlineMs: 25,
      maxWorkerReadyAttempts: 2
    });
    const db = createDatabase(":memory:");
    const app = createApp({ config, db, searchWorkersOverride: searchWorkers, syncWorkerOverride: syncWorker });

    const starting = await app.inject({ method: "GET", url: "/api/health" });
    expect(starting.statusCode).toBe(200);
    expect(starting.json()).toMatchObject({
      ok: true,
      ready: false,
      state: "starting",
      database: "ok",
      search: { state: "starting", degraded: false },
      sync: { state: "starting", degraded: false }
    });

    await waitUntil(() => {
      const searchStatus = searchWorkers.status();
      const syncStatus = syncWorker.status();
      return searchStatus.roles.search.state === "degraded"
        && searchStatus.roles.diagnostics.state === "degraded"
        && searchStatus.workerCount === 0
        && syncStatus.state === "degraded"
        && syncStatus.workerCount === 0;
    });
    const degraded = await app.inject({ method: "GET", url: "/api/health" });
    expect(degraded.statusCode).toBe(503);
    expect(degraded.json()).toMatchObject({
      ok: false,
      ready: false,
      state: "degraded",
      database: "ok",
      search: { state: "degraded", degraded: true, workerCount: 0 },
      sync: { state: "degraded", degraded: true, workerCount: 0 }
    });

    await app.close();
    db.close();
  });
});

function testConfig(): AppConfig {
  return {
    fixtureMode: true,
    dataDir: ".data",
    configPath: ".data/config.json",
    dbPath: ":memory:",
    apiPort: 4401,
    apiHost: "127.0.0.1",
    webOrigin: "http://127.0.0.1:5173",
    serveClient: false,
    requireAdminToken: false,
    adminAutoSession: false,
    plexAuth: { enabled: false, allowNewUsers: true, clientIdentifier: "health-test", productName: "Moodarr" },
    plex: { webBaseUrl: "https://app.plex.tv/desktop" },
    seerr: {},
    ai: {
      provider: "none",
      openaiModel: "gpt-5.5",
      openaiEmbeddingModel: "text-embedding-3-large",
      openaiReasoningEffort: "low"
    },
    sync: { intervalMinutes: 0, syncSeerr: false },
    search: { defaultResultLimit: 50 },
    reviewQueue: { retentionDays: 90, maxQueries: 500, captureRawQueries: false },
    knownSecrets: []
  };
}

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Worker health did not reach the expected state.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
