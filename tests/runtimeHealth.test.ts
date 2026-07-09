import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";

describe("runtime health", () => {
  it("reports package build information and probes database readiness", async () => {
    const db = createDatabase(":memory:");
    const app = createApp({ config: testConfig(), db });

    const healthy = await app.inject({ method: "GET", url: "/api/health" });
    expect(healthy.statusCode).toBe(200);
    expect(healthy.json()).toMatchObject({ ok: true, database: "ok", version: "0.1.0-alpha.21" });
    expect(healthy.headers["content-security-policy"]).toContain("default-src 'self'");

    db.close();
    const unavailable = await app.inject({ method: "GET", url: "/api/health" });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toMatchObject({ ok: false, database: "error", version: "0.1.0-alpha.21" });
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
