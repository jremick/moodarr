import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";
import { PlexClient } from "../src/server/integrations/plexClient";

describe("runtime health", () => {
  it("reports package build information and probes database readiness", async () => {
    const db = createDatabase(":memory:");
    const app = createApp({ config: testConfig(), db });

    const healthy = await app.inject({ method: "GET", url: "/api/health" });
    expect(healthy.statusCode).toBe(200);
    expect(healthy.json()).toMatchObject({ ok: true, database: "ok", version: "0.1.0-beta.1" });
    expect(healthy.headers["content-security-policy"]).toContain("default-src 'self'");

    db.close();
    const unavailable = await app.inject({ method: "GET", url: "/api/health" });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ ok: false, database: "error", version: "0.1.0-beta.1" });
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
    expect(health.json().sync).toEqual({ mode: "inline", ready: true, running: false, closed: false, workerCount: 0 });
    expect(health.json().sync).not.toHaveProperty("progress");
    expect(health.json().sync).not.toHaveProperty("lastResult");

    await app.close();
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
