import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { getAiProviderPolicy, getTmdbContentPolicy, loadConfig, type AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { UserRepository } from "../src/server/auth/userRepository";
import { SeerrClient } from "../src/server/integrations/seerrClient";
import { posterCacheSourceKey } from "../src/server/posters/posterCacheKey";
import { maxOperationalErrorLength } from "../src/server/security/redact";
import type {
  FeelFeedbackResponse,
  FeelProfileExportResponse,
  FeelProfileResponse,
  FeelProfileRollbackResponse,
  FeelProfileResetResponse,
  ItemDetail,
  LibraryStats,
  QueryReviewQueueResponse,
  RecommendationDiagnostics,
  RequestPreview,
  SearchResponse,
  SyncStatus
} from "../src/shared/types";

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base: AppConfig = {
    fixtureMode: true,
    dataDir: ".data-test",
    configPath: ".data-test/config.json",
    dbPath: ":memory:",
    apiPort: 0,
    apiHost: "127.0.0.1",
    webOrigin: "http://127.0.0.1:5173",
    serveClient: false,
    adminToken: "test-admin-token-secret",
    requireAdminToken: false,
    adminAutoSession: false,
    plexAuth: {
      enabled: false,
      allowNewUsers: true,
      clientIdentifier: "moodarr-test-client",
      productName: "Moodarr Test"
    },
    plex: {
      baseUrl: "http://plex.example",
      token: "test-plex-token-secret",
      webBaseUrl: "https://app.plex.tv/desktop"
    },
    seerr: {
      baseUrl: "http://seerr.example",
      apiKey: "test-seerr-key-secret"
    },
    ai: {
      provider: "none",
      openaiApiKey: "test-openai-key-secret",
      openaiModel: "gpt-5.5",
      openaiEmbeddingModel: "text-embedding-3-large",
      openaiReasoningEffort: "low"
    },
    sync: {
      intervalMinutes: 0,
      syncSeerr: true
    },
    search: {
      defaultResultLimit: 50
    },
	    reviewQueue: {
	      retentionDays: 90,
	      maxQueries: 500,
	      captureRawQueries: false
	    },
    knownSecrets: ["test-plex-token-secret", "test-seerr-key-secret", "test-openai-key-secret", "test-admin-token-secret"]
  };
  return { ...base, ...overrides };
}

function makeApp(config = testConfig()) {
  return createApp({ config, db: createDatabase(":memory:") });
}

async function startPlexAuth(app: ReturnType<typeof makeApp>) {
  const response = await app.inject({
    method: "POST",
    url: "/api/auth/plex/start",
    payload: { returnUrl: "http://127.0.0.1:5173/" }
  });
  expect(response.statusCode).toBe(200);
  return {
    response,
    cookie: String(response.headers["set-cookie"]).split(";")[0]
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("Moodarr API", () => {
  it("loads Moodarr environment settings", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "moodarr-env-"));
    const config = loadConfig({
      MOODARR_DATA_DIR: dataDir,
      MOODARR_CONFIG_PATH: join(dataDir, "config.json"),
      MOODARR_DB_PATH: join(dataDir, "moodarr.sqlite"),
      MOODARR_API_PORT: "4410",
      MOODARR_SERVE_CLIENT: "true",
      MOODARR_ADMIN_TOKEN: "admin-token-secret",
      MOODARR_REQUIRE_ADMIN_TOKEN: "true",
      MOODARR_PLEX_AUTH_ENABLED: "true",
      MOODARR_PLEX_AUTH_ALLOW_NEW_USERS: "false",
      MOODARR_PLEX_AUTH_CLIENT_ID: "moodarr-env-test",
      MOODARR_SYNC_INTERVAL_MINUTES: "120",
      MOODARR_DEFAULT_RESULT_LIMIT: "75",
      MOODARR_REVIEW_RETENTION_DAYS: "30",
	      MOODARR_REVIEW_MAX_QUERIES: "25",
	      MOODARR_REVIEW_CAPTURE_RAW_QUERIES: "true"
    });

    expect(config.dataDir).toBe(dataDir);
    expect(config.dbPath).toBe(join(dataDir, "moodarr.sqlite"));
    expect(config.apiPort).toBe(4410);
    expect(config.adminToken).toBe("admin-token-secret");
    expect(config.requireAdminToken).toBe(true);
    expect(config.adminAutoSession).toBe(false);
    expect(config.plexAuth).toMatchObject({ enabled: true, allowNewUsers: false, clientIdentifier: "moodarr-env-test" });
    expect(config.ai.openaiReasoningEffort).toBe("low");
    expect(config.sync.intervalMinutes).toBe(120);
    expect(config.search.defaultResultLimit).toBe(75);
	    expect(config.reviewQueue).toEqual({ retentionDays: 30, maxQueries: 25, captureRawQueries: true });
  });

  it("loads explicit OpenAI reasoning effort from container env", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "moodarr-effort-"));
    const config = loadConfig({
      MOODARR_DATA_DIR: dataDir,
      MOODARR_CONFIG_PATH: join(dataDir, "config.json"),
      OPENAI_MODEL: "gpt-5.5",
      OPENAI_REASONING_EFFORT: "high"
    });

    expect(config.ai.openaiReasoningEffort).toBe("high");
  });

  it("fails closed on TMDB descriptive content unless a source run explicitly opts in", () => {
    const defaultDataDir = mkdtempSync(join(tmpdir(), "moodarr-tmdb-policy-default-"));
    const defaultConfig = loadConfig({
      MOODARR_DATA_DIR: defaultDataDir,
      MOODARR_CONFIG_PATH: join(defaultDataDir, "config.json")
    });
    const optInDataDir = mkdtempSync(join(tmpdir(), "moodarr-tmdb-policy-opt-in-"));
    const optInConfig = loadConfig({
      MOODARR_DATA_DIR: optInDataDir,
      MOODARR_CONFIG_PATH: join(optInDataDir, "config.json"),
      MOODARR_TMDB_CONTENT_POLICY: "configurable"
    });

    expect(getTmdbContentPolicy(defaultConfig)).toBe("none");
    expect(getTmdbContentPolicy(optInConfig)).toBe("configurable");
    expect(() =>
      loadConfig({
        MOODARR_DATA_DIR: mkdtempSync(join(tmpdir(), "moodarr-tmdb-policy-invalid-")),
        MOODARR_TMDB_CONTENT_POLICY: "hostile-widening-value"
      })
    ).toThrow("MOODARR_TMDB_CONTENT_POLICY must be configurable or none");
  });

  it("reports the effective TMDB content policy through health and config status", async () => {
    const config = testConfig({ seerr: { ...testConfig().seerr, tmdbContentPolicy: "none" } });
    const app = makeApp(config);

    const [health, status] = await Promise.all([
      app.inject({ method: "GET", url: "/api/health" }),
      app.inject({ method: "GET", url: "/api/config/status" })
    ]);

    expect(health.json()).toMatchObject({ policies: { tmdbContent: "none" } });
    expect(status.json()).toMatchObject({ seerr: { tmdbContentPolicy: "none" } });
  });

  it("keeps both environment and persisted provider keys in the redaction set", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "moodarr-provider-redaction-"));
    const configPath = join(dataDir, "config.json");
    const testEnvironmentKey = "test-environment-openai-key-secret";
    const persistedKey = "test-persisted-openai-key-secret";
    writeFileSync(configPath, JSON.stringify({ ai: { provider: "openai", openaiApiKey: persistedKey } }), { mode: 0o600 });

    const config = loadConfig({
      MOODARR_DATA_DIR: dataDir,
      MOODARR_CONFIG_PATH: configPath,
      OPENAI_API_KEY: testEnvironmentKey
    });

    expect(config.knownSecrets).toEqual(expect.arrayContaining([testEnvironmentKey, persistedKey]));
  });

  it("does not let stale settings or Admin writes widen a none provider policy", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "moodarr-ai-policy-"));
    const configPath = join(dataDir, "config.json");
    const storedKey = "test-legacy-openai-key-secret";
    const original = JSON.stringify({
      fixtureMode: true,
      ai: { provider: "openai", openaiApiKey: storedKey, openaiModel: "gpt-5.5" }
    }, null, 2);
    writeFileSync(configPath, original, { mode: 0o600 });
    const config = testConfig({
      dataDir,
      configPath,
      requireAdminToken: true,
      ai: {
        providerPolicy: "none",
        provider: "none",
        openaiApiKeyStored: true,
        openaiModel: "gpt-5.5",
        openaiEmbeddingModel: "text-embedding-3-large",
        openaiReasoningEffort: "low"
      },
      knownSecrets: [storedKey, "test-admin-token-secret"]
    });
    const app = makeApp(config);

    expect(getAiProviderPolicy(config)).toBe("none");
    const publicStatus = await app.inject({ method: "GET", url: "/api/config/status" });
    expect(publicStatus.json()).toMatchObject({ ai: { providerPolicy: "none", provider: "none", configured: false } });

    const rejected = await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: { ai: { provider: "openai", openaiApiKey: "test-rotated-openai-key-secret" } }
    });
    expect(rejected.statusCode).toBe(400);
    expect(readFileSync(configPath, "utf8")).toBe(original);

    const unrelatedUpdate = await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: { sync: { intervalMinutes: 120 } }
    });
    expect(unrelatedUpdate.statusCode).toBe(200);
    expect(config.knownSecrets).toContain(storedKey);
    expect(readFileSync(configPath, "utf8")).toContain(storedKey);

    const warmup = await app.inject({
      method: "POST",
      url: "/api/admin/embeddings/warmup",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: { limit: 1 }
    });
    expect(warmup.statusCode).toBe(409);

    const cleared = await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: { ai: { provider: "none", clearOpenaiApiKey: true } }
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ ai: { providerPolicy: "none", provider: "none", openaiApiKeyConfigured: false } });
    expect(readFileSync(configPath, "utf8")).not.toContain(storedKey);
    expect(config.knownSecrets).toContain(storedKey);
  });

  it("rejects unauthenticated live-mode startup on loopback", () => {
    expect(() =>
      loadConfig({
      MOODARR_FIXTURE_MODE: "false",
      MOODARR_REQUIRE_ADMIN_TOKEN: "false",
      MOODARR_API_HOST: "127.0.0.1",
      PLEX_BASE_URL: "http://plex.example",
      PLEX_TOKEN: "test-plex-token-secret",
      SEERR_BASE_URL: "http://seerr.example",
      SEERR_API_KEY: "test-seerr-key-secret"
      })
    ).toThrow("fixture mode is off");
  });

  it("rejects unauthenticated non-loopback binding", () => {
    expect(() =>
      loadConfig({
        MOODARR_FIXTURE_MODE: "true",
        MOODARR_REQUIRE_ADMIN_TOKEN: "false",
        MOODARR_API_HOST: "0.0.0.0"
      })
    ).toThrow("binding outside loopback");
  });

  it("rejects unauthenticated live-mode startup outside loopback", () => {
    expect(() =>
      loadConfig({
        MOODARR_FIXTURE_MODE: "false",
        MOODARR_REQUIRE_ADMIN_TOKEN: "false",
        MOODARR_API_HOST: "0.0.0.0",
        PLEX_BASE_URL: "http://plex.example",
        PLEX_TOKEN: "test-plex-token-secret",
        SEERR_BASE_URL: "http://seerr.example",
        SEERR_API_KEY: "test-seerr-key-secret"
      })
    ).toThrow("fixture mode is off");
  });

  it("requires an explicit browser origin for production Plex sign-in", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        MOODARR_FIXTURE_MODE: "true",
        MOODARR_REQUIRE_ADMIN_TOKEN: "true",
        MOODARR_ADMIN_TOKEN: "test-admin-token-secret",
        MOODARR_PLEX_AUTH_ENABLED: "true"
      })
    ).toThrow(/MOODARR_WEB_ORIGIN/);
  });

  it("authenticates the bundled UI with a container-issued admin session cookie", async () => {
    const app = makeApp(testConfig({ requireAdminToken: true, adminAutoSession: true }));

    const denied = await app.inject({ method: "GET", url: "/api/admin/settings" });
    expect(denied.statusCode).toBe(401);

    const session = await app.inject({ method: "GET", url: "/api/admin/session" });
    expect(session.statusCode).toBe(200);
    expect(session.body).not.toContain("test-admin-token-secret");
    const cookies = Array.isArray(session.headers["set-cookie"]) ? session.headers["set-cookie"] : [String(session.headers["set-cookie"])];
    expect(cookies.join("\n")).toContain("moodarr_admin_session=");
    expect(cookies.join("\n")).toContain("HttpOnly");
    const cookie = cookies.find((value) => value.startsWith("moodarr_admin_session="))!.split(";")[0];

    const authenticated = await app.inject({
      method: "GET",
      url: "/api/admin/settings",
      headers: { cookie }
    });

    expect(authenticated.statusCode).toBe(200);
  });

  it("keeps an explicit admin lock closed when automatic sessions are enabled", async () => {
    const app = makeApp(testConfig({ requireAdminToken: true, adminAutoSession: true }));
    const initial = await app.inject({ method: "GET", url: "/api/admin/session" });
    const initialCookies = Array.isArray(initial.headers["set-cookie"]) ? initial.headers["set-cookie"] : [String(initial.headers["set-cookie"])];
    const sessionCookie = initialCookies.find((value) => value.startsWith("moodarr_admin_session="))!.split(";")[0];

    const locked = await app.inject({ method: "DELETE", url: "/api/admin/session", headers: { cookie: sessionCookie } });
    expect(locked.statusCode).toBe(200);
    const lockCookies = Array.isArray(locked.headers["set-cookie"]) ? locked.headers["set-cookie"] : [String(locked.headers["set-cookie"])];
    const lockCookie = lockCookies.find((value) => value.startsWith("moodarr_admin_locked=1"))!.split(";")[0];

    const status = await app.inject({ method: "GET", url: "/api/admin/session", headers: { cookie: lockCookie } });
    expect(status.json()).toEqual({ ok: false, autoSession: true });
    expect(status.headers["set-cookie"]).toBeUndefined();

    const unlocked = await app.inject({
      method: "POST",
      url: "/api/admin/session",
      headers: { cookie: lockCookie },
      payload: { token: "test-admin-token-secret" }
    });
    expect(unlocked.statusCode).toBe(200);
    const unlockCookies = Array.isArray(unlocked.headers["set-cookie"]) ? unlocked.headers["set-cookie"] : [String(unlocked.headers["set-cookie"])];
    expect(unlockCookies.some((value) => value.startsWith("moodarr_admin_session="))).toBe(true);
    expect(unlockCookies.some((value) => value.startsWith("moodarr_admin_locked="))).toBe(true);
  });

  it("rejects cross-site cookie-authenticated writes while accepting the configured origin", async () => {
    const app = makeApp(testConfig({ requireAdminToken: true, adminAutoSession: true }));
    const initial = await app.inject({ method: "GET", url: "/api/admin/session" });
    const cookie = String(Array.isArray(initial.headers["set-cookie"]) ? initial.headers["set-cookie"][0] : initial.headers["set-cookie"]).split(";")[0];

    const rejected = await app.inject({
      method: "DELETE",
      url: "/api/admin/session",
      headers: { cookie, origin: "https://attacker.example", "sec-fetch-site": "cross-site" }
    });
    expect(rejected.statusCode).toBe(403);

    const accepted = await app.inject({
      method: "DELETE",
      url: "/api/admin/session",
      headers: { cookie, origin: "http://127.0.0.1:5173", "sec-fetch-site": "same-origin" }
    });
    expect(accepted.statusCode).toBe(200);
  });

  it("requires an explicit admin token exchange when automatic admin sessions are disabled", async () => {
    const app = makeApp(testConfig({ requireAdminToken: true, adminAutoSession: false }));

    const status = await app.inject({ method: "GET", url: "/api/admin/session" });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ ok: false, autoSession: false });
    expect(status.headers["set-cookie"]).toBeUndefined();

    const rejected = await app.inject({ method: "POST", url: "/api/admin/session", payload: { token: "wrong-token" } });
    expect(rejected.statusCode).toBe(401);
    expect(rejected.body).not.toContain("test-admin-token-secret");

    const exchanged = await app.inject({
      method: "POST",
      url: "/api/admin/session",
      payload: { token: "test-admin-token-secret" }
    });
    expect(exchanged.statusCode).toBe(200);
    expect(exchanged.json()).toEqual({ ok: true, autoSession: false });
    const cookie = String(exchanged.headers["set-cookie"]).split(";")[0];
    expect(cookie).toContain("moodarr_admin_session=");

    const authenticated = await app.inject({ method: "GET", url: "/api/admin/settings", headers: { cookie } });
    expect(authenticated.statusCode).toBe(200);
  });

  it("rate-limits repeated admin token exchanges per client", async () => {
    const app = makeApp(testConfig({ requireAdminToken: true, adminAutoSession: false }));
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const response = await app.inject({ method: "POST", url: "/api/admin/session", payload: { token: "wrong-token" } });
      expect(response.statusCode).toBe(401);
    }

    const limited = await app.inject({ method: "POST", url: "/api/admin/session", payload: { token: "test-admin-token-secret" } });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBe("60");
    expect(limited.json()).toEqual({ error: "Too many requests. Please wait and retry." });
  });

  it("rate-limits authorization checks and user-controlled workloads per client", async () => {
    const cases = [
      {
        limit: 12,
        expectedStatus: 400,
        request: { method: "POST" as const, url: "/api/auth/plex/start", payload: { returnUrl: "not-a-url" } }
      },
      {
        limit: 12,
        expectedStatus: 404,
        request: { method: "POST" as const, url: "/api/auth/plex/complete", payload: { pinId: "missing", code: "missing" } }
      },
      {
        limit: 60,
        expectedStatus: 200,
        request: { method: "GET" as const, url: "/api/admin/session" }
      },
      {
        limit: 40,
        expectedStatus: 400,
        request: { method: "POST" as const, url: "/api/search", payload: { query: "" } }
      },
      {
        limit: 120,
        expectedStatus: 400,
        request: { method: "POST" as const, url: "/api/feel-feedback", payload: {} }
      }
    ];

    for (const { limit, expectedStatus, request } of cases) {
      const app = makeApp();
      try {
        for (let attempt = 0; attempt < limit; attempt += 1) {
          const response = await app.inject(request);
          expect(response.statusCode, `${request.method} ${request.url} attempt ${attempt + 1}`).toBe(expectedStatus);
        }

        const limited = await app.inject(request);
        expect(limited.statusCode, `${request.method} ${request.url} after ${limit} requests`).toBe(429);
        expect(limited.headers["retry-after"]).toBe("60");
      } finally {
        await app.close();
      }
    }
  });

  it("shares the Plex authorization budget across start and completion routes", async () => {
    const app = makeApp();
    try {
      for (let attempt = 0; attempt < 6; attempt += 1) {
        const start = await app.inject({ method: "POST", url: "/api/auth/plex/start", payload: { returnUrl: "not-a-url" } });
        const complete = await app.inject({ method: "POST", url: "/api/auth/plex/complete", payload: { pinId: "missing", code: "missing" } });
        expect(start.statusCode).toBe(400);
        expect(complete.statusCode).toBe(404);
      }

      const limited = await app.inject({ method: "POST", url: "/api/auth/plex/start", payload: { returnUrl: "not-a-url" } });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("60");
      expect(limited.json()).toEqual({ error: "Too many requests. Please wait and retry." });
    } finally {
      await app.close();
    }
  });

  it("shares the media request budget across preview and creation routes", async () => {
    const app = makeApp();
    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const preview = await app.inject({ method: "POST", url: "/api/requests/preview", payload: { itemId: "" } });
        const create = await app.inject({ method: "POST", url: "/api/requests/create", payload: { itemId: "" } });
        expect(preview.statusCode).toBe(400);
        expect(create.statusCode).toBe(400);
      }

      const limited = await app.inject({ method: "POST", url: "/api/requests/preview", payload: { itemId: "" } });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers["retry-after"]).toBe("60");
      expect(limited.json()).toEqual({ error: "Too many requests. Please wait and retry." });
    } finally {
      await app.close();
    }
  });

  it("authenticates Plex users for finder routes without granting admin access", async () => {
    vi.stubGlobal("fetch", plexAuthFetchMock({ resourceServerId: "server-abc" }));
    const db = createDatabase(":memory:");
    const config = testConfig({
        requireAdminToken: true,
        plexAuth: {
          enabled: true,
          allowNewUsers: true,
          clientIdentifier: "moodarr-test-client",
          productName: "Moodarr Test"
        }
      });
    let app = createApp({ config, db });

    const deniedStats = await app.inject({ method: "GET", url: "/api/library/stats" });
    expect(deniedStats.statusCode).toBe(401);

    const start = await app.inject({
      method: "POST",
      url: "/api/auth/plex/start",
      payload: { returnUrl: "http://127.0.0.1:5173/" }
    });
    expect(start.statusCode).toBe(200);
    expect(start.body).not.toContain("user-plex-token-secret");
    expect(start.json()).toMatchObject({ ok: true, pinId: "123", code: "ABCD" });
    expect(start.json<{ authUrl: string }>().authUrl).toContain("https://app.plex.tv/auth#?");

    app = createApp({ config, db });

    const unboundComplete = await app.inject({
      method: "POST",
      url: "/api/auth/plex/complete",
      payload: { pinId: "123", code: "ABCD" }
    });
    expect(unboundComplete.statusCode).toBe(400);

    const complete = await app.inject({
      method: "POST",
      url: "/api/auth/plex/complete",
      headers: { cookie: String(start.headers["set-cookie"]).split(";")[0] },
      payload: { pinId: "123", code: "ABCD" }
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.body).not.toContain("user-plex-token-secret");
    expect(complete.body).not.toContain("sessionToken");
    expect(complete.json()).toMatchObject({ authenticated: true, user: { provider: "plex", username: "jarel" } });
    const cookie = String(complete.headers["set-cookie"]).split(";")[0];
    expect(cookie).toContain("moodarr_user_session=");

    const stats = await app.inject({ method: "GET", url: "/api/library/stats", headers: { cookie } });
    expect(stats.statusCode).toBe(200);

    const admin = await app.inject({ method: "GET", url: "/api/admin/settings", headers: { cookie } });
    expect(admin.statusCode).toBe(401);

    const replayedComplete = await app.inject({
      method: "POST",
      url: "/api/auth/plex/complete",
      headers: { cookie: String(start.headers["set-cookie"]).split(";")[0] },
      payload: { pinId: "123", code: "ABCD" }
    });
    expect(replayedComplete.statusCode).toBe(400);

    const users = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" }
    });
    expect(users.body).not.toContain("user-plex-token-secret");
    expect(users.body).not.toContain("token_hash");
    const user = users.json<{ users: Array<{ id: string; username: string; requestCount: number }> }>().users[0]!;
    expect(user.username).toBe("jarel");
    expect(user.requestCount).toBe(0);

    const disabled = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${encodeURIComponent(user.id)}`,
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: { enabled: false }
    });
    expect(disabled.statusCode).toBe(200);

    const deniedAfterDisable = await app.inject({ method: "GET", url: "/api/library/stats", headers: { cookie } });
    expect(deniedAfterDisable.statusCode).toBe(401);
  });

  it("can return a native user session token without granting admin access", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubGlobal("fetch", plexAuthFetchMock({ resourceServerId: "server-abc" }));
    const app = makeApp(
      testConfig({
        webOrigin: "https://moodarr.example",
        requireAdminToken: true,
        plexAuth: {
          enabled: true,
          allowNewUsers: true,
          clientIdentifier: "moodarr-test-client",
          productName: "Moodarr Test"
        }
      })
    );

    const challenge = await startPlexAuth(app);
    const complete = await app.inject({
      method: "POST",
      url: "/api/auth/plex/complete",
      headers: { cookie: challenge.cookie },
      payload: { pinId: "123", code: "ABCD", nativeSession: true }
    });
    expect(complete.statusCode).toBe(200);
    expect(complete.body).not.toContain("user-plex-token-secret");
    const body = complete.json<{ sessionToken: string; sessionExpiresAt: string; user: { id: string; username: string; canRequest: boolean; canUseAi: boolean } }>();
    expect(body).toMatchObject({ user: { username: "jarel", canRequest: false, canUseAi: false }, sessionExpiresAt: expect.any(String) });
    expect(body.sessionToken).toEqual(expect.any(String));
    expect(complete.headers["set-cookie"]).toBeUndefined();

    const authHeaders = { authorization: `Bearer ${body.sessionToken}` };
    const session = await app.inject({ method: "GET", url: "/api/auth/session", headers: authHeaders });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ authenticated: true, user: { username: "jarel" } });

    const stats = await app.inject({ method: "GET", url: "/api/library/stats", headers: authHeaders });
    expect(stats.statusCode).toBe(200);

    const admin = await app.inject({ method: "GET", url: "/api/admin/settings", headers: authHeaders });
    expect(admin.statusCode).toBe(401);

    const search = await app.inject({
      method: "POST",
      url: "/api/search",
      headers: authHeaders,
      payload: { query: "funny fantasy", resultLimit: 5, watchContext: "group" }
    });
    expect(search.statusCode).toBe(200);
    const searchBody = search.json<SearchResponse>();
    expect(searchBody.sessionId).toEqual(expect.any(String));
    const firstResult = searchBody.results[0]!;
    expect(firstResult).toBeTruthy();

    const poster = await app.inject({ method: "GET", url: firstResult.posterUrl, headers: authHeaders });
    expect(poster.statusCode).toBe(200);
    expect(String(poster.headers["content-type"])).toMatch(/image\//);

    const feedback = await app.inject({
      method: "POST",
      url: "/api/feel-feedback",
      headers: authHeaders,
      payload: {
        action: "swipe_right",
        source: "ios",
        clientEventId: "ios-test-event-1",
        watchContext: "group",
        sessionId: searchBody.sessionId,
        itemId: firstResult.id,
        moodTerm: "funny",
        metadata: { rawPrompt: "this should not be stored" }
      }
    });
    expect(feedback.statusCode).toBe(200);
    expect(feedback.body).not.toContain("rawPrompt");
    const duplicateFeedback = await app.inject({
      method: "POST",
      url: "/api/feel-feedback",
      headers: authHeaders,
      payload: {
        action: "swipe_right",
        source: "ios",
        clientEventId: "ios-test-event-1",
        watchContext: "group",
        sessionId: searchBody.sessionId,
        itemId: firstResult.id,
        moodTerm: "funny"
      }
    });
    expect(duplicateFeedback.statusCode).toBe(200);
    expect(duplicateFeedback.json<FeelFeedbackResponse>()).toMatchObject({
      eventId: feedback.json<FeelFeedbackResponse>().eventId,
      deduped: true
    });

    const requestable = searchBody.results.find((item) => item.title === "The Princess Bride") ?? searchBody.results.find((item) => item.seerr?.requestable);
    expect(requestable).toBeTruthy();
    const preview = await app.inject({ method: "POST", url: "/api/requests/preview", headers: authHeaders, payload: { itemId: requestable!.id } });
    expect(preview.statusCode).toBe(200);
    const previewBody = preview.json<RequestPreview>();
    const deniedPendingCreate = await app.inject({
      method: "POST",
      url: "/api/requests/create",
      headers: authHeaders,
      payload: { itemId: requestable!.id, confirmed: true, confirmationPhrase: previewBody.confirmationPhrase }
    });
    expect(deniedPendingCreate.statusCode).toBe(403);
    const approved = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${encodeURIComponent(body.user.id)}`,
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: { canRequest: true }
    });
    expect(approved.statusCode).toBe(200);
    const blockedCreate = await app.inject({ method: "POST", url: "/api/requests/create", headers: authHeaders, payload: { itemId: requestable!.id } });
    expect(blockedCreate.statusCode).toBe(409);
    const created = await app.inject({
      method: "POST",
      url: "/api/requests/create",
      headers: authHeaders,
      payload: { itemId: requestable!.id, confirmed: true, confirmationPhrase: previewBody.confirmationPhrase }
    });
    expect(created.statusCode).toBe(200);

    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers: authHeaders });
    expect(logout.statusCode).toBe(200);
    const deniedAfterLogout = await app.inject({ method: "GET", url: "/api/library/stats", headers: authHeaders });
    expect(deniedAfterLogout.statusCode).toBe(401);
  });

  it("allows only configured web and native Plex auth callbacks", async () => {
    vi.stubGlobal("fetch", plexAuthFetchMock({ resourceServerId: "server-abc" }));
    const app = makeApp(testConfig({ plexAuth: { ...testConfig().plexAuth, enabled: true } }));

    const native = await app.inject({
      method: "POST",
      url: "/api/auth/plex/start",
      payload: { returnUrl: "moodarr://auth/plex" }
    });
    expect(native.statusCode).toBe(200);
    expect(native.json<{ authUrl: string }>().authUrl).toContain(encodeURIComponent("moodarr://auth/plex"));

    const hostile = await app.inject({
      method: "POST",
      url: "/api/auth/plex/start",
      headers: { origin: "https://attacker.example" },
      payload: { returnUrl: "https://attacker.example/steal" }
    });
    const hostileAuthUrl = hostile.json<{ authUrl: string }>().authUrl;
    expect(hostile.statusCode).toBe(200);
    expect(hostileAuthUrl).toContain(encodeURIComponent("http://127.0.0.1:5173/"));
    expect(hostileAuthUrl).not.toContain(encodeURIComponent("https://attacker.example/steal"));

    const bundled = await app.inject({
      method: "POST",
      url: "/api/auth/plex/start",
      headers: { host: "moodarr.local:4401", origin: "http://moodarr.local:4401" },
      payload: { returnUrl: "http://moodarr.local:4401/" }
    });
    expect(bundled.statusCode).toBe(200);
    expect(bundled.json<{ authUrl: string }>().authUrl).toContain(encodeURIComponent("http://127.0.0.1:5173/"));
    expect(bundled.json<{ authUrl: string }>().authUrl).not.toContain(encodeURIComponent("http://moodarr.local:4401/"));
  });

  it("adds available Plex items to the signed-in user's Plex Watchlist", async () => {
    const fetchMock = plexAuthFetchMock({ resourceServerId: "server-abc" });
    vi.stubGlobal("fetch", fetchMock);
    const app = makeApp(
      testConfig({
        requireAdminToken: true,
        plexAuth: {
          enabled: true,
          allowNewUsers: true,
          clientIdentifier: "moodarr-test-client",
          productName: "Moodarr Test"
        }
      })
    );

    const challenge = await startPlexAuth(app);
    const complete = await app.inject({
      method: "POST",
      url: "/api/auth/plex/complete",
      headers: { cookie: challenge.cookie },
      payload: { pinId: "123", code: "ABCD", nativeSession: true }
    });
    const completeBody = complete.json<{ sessionToken: string; user: { id: string } }>();
    const sessionToken = completeBody.sessionToken;
    const approved = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${encodeURIComponent(completeBody.user.id)}`,
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: { canRequest: true }
    });
    expect(approved.statusCode).toBe(200);
    const search = await app.inject({
      method: "POST",
      url: "/api/search",
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { query: "cozy movie", resultLimit: 5 }
    });
    const available = search.json<SearchResponse>().results.find((item) => item.availabilityGroup === "available_in_plex");
    expect(available).toBeTruthy();

    const watchlist = await app.inject({
      method: "POST",
      url: "/api/plex/watchlist",
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { itemId: available!.id }
    });

    expect(watchlist.statusCode).toBe(200);
    expect(watchlist.body).not.toContain("user-plex-token-secret");
    expect(watchlist.json()).toMatchObject({ ok: true, itemId: available!.id, alreadyWatchlisted: false });
    const watchlistCall = fetchMock.mock.calls.find(([url]) => String(url).startsWith("https://discover.provider.plex.tv/actions/addToWatchlist"));
    expect(watchlistCall).toBeTruthy();
    expect(watchlistCall?.[1]).toEqual(
      expect.objectContaining({
        method: "PUT",
        headers: expect.objectContaining({ "X-Plex-Token": "user-plex-token-secret" })
      })
    );
  });

  it("keeps Plex auth endpoints closed when Plex sign-in is disabled", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = makeApp(
      testConfig({
        requireAdminToken: true,
        plexAuth: {
          enabled: false,
          allowNewUsers: true,
          clientIdentifier: "moodarr-test-client",
          productName: "Moodarr Test"
        }
      })
    );

    const start = await app.inject({
      method: "POST",
      url: "/api/auth/plex/start",
      payload: { returnUrl: "http://127.0.0.1:5173/" }
    });
    const complete = await app.inject({
      method: "POST",
      url: "/api/auth/plex/complete",
      payload: { pinId: "123", code: "ABCD" }
    });

    expect(start.statusCode).toBe(404);
    expect(complete.statusCode).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects Plex sign-in for accounts without access to the configured server", async () => {
    vi.stubGlobal("fetch", plexAuthFetchMock({ resourceServerId: "other-server" }));
    const app = makeApp(
      testConfig({
        requireAdminToken: true,
        plexAuth: {
          enabled: true,
          allowNewUsers: true,
          clientIdentifier: "moodarr-test-client",
          productName: "Moodarr Test"
        }
      })
    );

    const challenge = await startPlexAuth(app);
    const complete = await app.inject({
      method: "POST",
      url: "/api/auth/plex/complete",
      headers: { cookie: challenge.cookie },
      payload: { pinId: "123", code: "ABCD" }
    });

    expect(complete.statusCode).toBe(403);
    expect(complete.body).toContain("does not have access");
  });

  it("attributes Moodarr request creation to the signed-in Plex user locally", async () => {
    vi.stubGlobal("fetch", plexAuthFetchMock({ resourceServerId: "server-abc" }));
    const db = createDatabase(":memory:");
    const app = createApp({
      config: testConfig({
        requireAdminToken: true,
        plexAuth: {
          enabled: true,
          allowNewUsers: true,
          clientIdentifier: "moodarr-test-client",
          productName: "Moodarr Test"
        }
      }),
      db
    });

    const challenge = await startPlexAuth(app);
    const complete = await app.inject({
      method: "POST",
      url: "/api/auth/plex/complete",
      headers: { cookie: challenge.cookie },
      payload: { pinId: "123", code: "ABCD" }
    });
    expect(complete.statusCode).toBe(200);
    const cookie = String(complete.headers["set-cookie"]).split(";")[0];
    db.prepare("UPDATE app_users SET can_request = 1 WHERE username = 'jarel'").run();

    const search = await app.inject({
      method: "POST",
      url: "/api/search",
      headers: { cookie },
      payload: { query: "Princess Bride" }
    });
    const princessBride = search.json<SearchResponse>().results.find((item) => item.title === "The Princess Bride");
    expect(princessBride).toBeTruthy();

    const preview = await app.inject({
      method: "POST",
      url: "/api/requests/preview",
      headers: { cookie },
      payload: { itemId: princessBride!.id }
    });
    expect(preview.statusCode).toBe(200);

    const created = await app.inject({
      method: "POST",
      url: "/api/requests/create",
      headers: { cookie },
      payload: { itemId: princessBride!.id, confirmed: true, confirmationPhrase: preview.json<RequestPreview>().confirmationPhrase }
    });
    expect(created.statusCode).toBe(200);

    const audit = db
      .prepare("SELECT auth_user_id FROM request_audit WHERE action = 'create' AND status = 'created' LIMIT 1")
      .get() as { auth_user_id: string | null };
    const user = db.prepare("SELECT id FROM app_users WHERE username = 'jarel' LIMIT 1").get() as { id: string };
    expect(audit.auth_user_id).toBe(user.id);

    const users = await app.inject({
      method: "GET",
      url: "/api/admin/users",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" }
    });
    expect(users.statusCode).toBe(200);
    expect(users.body).not.toContain("user-plex-token-secret");
    expect(users.body).not.toContain("token_hash");
    expect(users.json<{ users: Array<{ username: string; requestCount: number }> }>().users[0]).toMatchObject({ username: "jarel", requestCount: 1 });

    const support = await app.inject({
      method: "GET",
      url: "/api/admin/support-bundle",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" }
    });
    expect(support.statusCode).toBe(200);
    expect(support.body).not.toContain("user-plex-token-secret");
    expect(support.body).not.toContain("token_hash");
    expect(
      support
        .json<{ requests: { recent: Array<{ status: string; authUser?: { displayName: string } }> } }>()
        .requests.recent.some((row) => row.status === "created" && row.authUser?.displayName === "Jarel")
    ).toBe(true);
  });

  it("isolates For Me learning by user while keeping Together learning explicitly shared", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const userA = users.upsertPlexUser({ providerUserId: "user-a", username: "alice", displayName: "Alice" }, true);
    const userB = users.upsertPlexUser({ providerUserId: "user-b", username: "bob", displayName: "Bob" }, true);
    const sessionA = users.createSession(userA.id);
    const sessionB = users.createSession(userB.id);
    const headersA = { authorization: `Bearer ${sessionA.token}` };
    const headersB = { authorization: `Bearer ${sessionB.token}` };
    const app = createApp({
      config: testConfig({ requireAdminToken: true, plexAuth: { ...testConfig().plexAuth, enabled: true } }),
      db
    });

    const searchA = await app.inject({
      method: "POST",
      url: "/api/search",
      headers: headersA,
      payload: { query: "cozy movie", watchContext: "solo", resultLimit: 1 }
    });
    const resultA = searchA.json<SearchResponse>();
    expect(resultA.sessionId).toEqual(expect.any(String));
    expect(resultA.results[0]).toBeTruthy();

    const stolenSession = await app.inject({
      method: "POST",
      url: "/api/feel-feedback",
      headers: headersB,
      payload: {
        action: "right_mood",
        sessionId: resultA.sessionId,
        itemId: resultA.results[0]!.id,
        watchContext: "solo",
        moodTerm: "cozy"
      }
    });
    expect(stolenSession.statusCode).toBe(403);

    const unexposedItem = db
      .prepare(
        `SELECT id FROM media_items
         WHERE id NOT IN (SELECT media_item_id FROM recommendation_results WHERE session_id = ?)
         LIMIT 1`
      )
      .get(resultA.sessionId!) as { id: string };
    const unexposedFeedback = await app.inject({
      method: "POST",
      url: "/api/feel-feedback",
      headers: headersA,
      payload: {
        action: "right_mood",
        sessionId: resultA.sessionId,
        itemId: unexposedItem.id,
        watchContext: "solo",
        moodTerm: "cozy"
      }
    });
    expect(unexposedFeedback.statusCode).toBe(400);

    const learnedSolo = await app.inject({
      method: "POST",
      url: "/api/feel-feedback",
      headers: headersA,
      payload: {
        action: "right_mood",
        sessionId: resultA.sessionId,
        itemId: resultA.results[0]!.id,
        watchContext: "solo",
        moodTerm: "cozy"
      }
    });
    expect(learnedSolo.statusCode).toBe(200);

    const repository = new MediaRepository(db);
    expect(repository.feelProfile("solo", userA.id)).toMatchObject({ id: `solo:user:${userA.id}`, terms: [{ term: "cozy" }] });
    expect(repository.feelProfile("solo", userB.id)).toMatchObject({ id: `solo:user:${userB.id}`, terms: [] });

    const groupSearch = await app.inject({
      method: "POST",
      url: "/api/search",
      headers: headersB,
      payload: { query: "weird group comedy", watchContext: "group", resultLimit: 1 }
    });
    const groupResult = groupSearch.json<SearchResponse>();
    const learnedGroup = await app.inject({
      method: "POST",
      url: "/api/feel-feedback",
      headers: headersB,
      payload: {
        action: "right_mood",
        sessionId: groupResult.sessionId,
        itemId: groupResult.results[0]!.id,
        watchContext: "group",
        moodTerm: "weird"
      }
    });
    expect(learnedGroup.statusCode).toBe(200);
    expect(repository.feelProfile("group", userA.id)).toEqual(repository.feelProfile("group", userB.id));
    expect(repository.feelProfile("group", userA.id)).toMatchObject({ id: "group:shared", terms: [{ term: "weird" }] });
  });

  it("enforces per-user request and AI capability controls", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const user = users.upsertPlexUser({ providerUserId: "restricted-user", username: "restricted" }, true);
    const session = users.createSession(user.id);
    const userHeaders = { authorization: `Bearer ${session.token}` };
    const app = createApp({
      config: testConfig({
        requireAdminToken: true,
        plexAuth: { ...testConfig().plexAuth, enabled: true },
        ai: { ...testConfig().ai, provider: "openai" }
      }),
      db
    });

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/admin/users/${encodeURIComponent(user.id)}`,
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: { canRequest: false, canUseAi: false }
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ canRequest: false, canUseAi: false });

    const authSession = await app.inject({ method: "GET", url: "/api/auth/session", headers: userHeaders });
    expect(authSession.json()).toMatchObject({ authenticated: true, user: { canRequest: false, canUseAi: false } });

    const deterministicSearch = await app.inject({
      method: "POST",
      url: "/api/search",
      headers: userHeaders,
      payload: { query: "funny fantasy", useAi: true, resultLimit: 3 }
    });
    expect(deterministicSearch.statusCode).toBe(200);
    expect(deterministicSearch.json<SearchResponse>().usedAi).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();

    const denied = await app.inject({
      method: "POST",
      url: "/api/requests/create",
      headers: userHeaders,
      payload: { itemId: "any-item", confirmed: true, confirmationPhrase: "REQUEST ANYTHING" }
    });
    expect(denied.statusCode).toBe(403);
  });

  it("repairs persisted config permissions when loading settings", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "moodarr-permissions-"));
    const configPath = join(dataDir, "config.json");
    writeFileSync(configPath, JSON.stringify({ fixtureMode: true }), { mode: 0o644 });
    chmodSync(configPath, 0o644);

    loadConfig({
      MOODARR_DATA_DIR: dataDir,
      MOODARR_CONFIG_PATH: configPath
    });

    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it("returns public config status without secrets", async () => {
    const app = makeApp();
    const response = await app.inject({ method: "GET", url: "/api/config/status" });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("test-plex-token-secret");
    expect(response.body).not.toContain("test-seerr-key-secret");
    expect(response.body).not.toContain(".data-test");
    expect(response.body).not.toContain(":memory:");
    expect(response.json()).toMatchObject({
      fixtureMode: true,
      plex: { configured: true },
      seerr: { configured: true }
    });
  });

  it("syncs fixtures and returns available Plex and requestable Seerr search results", async () => {
    const app = makeApp();
    const librarySync = await app.inject({ method: "POST", url: "/api/library/sync" });
    expect(librarySync.statusCode).toBe(202);
    expect(librarySync.json()).toMatchObject({ accepted: true });
    await vi.waitFor(async () => {
      const status = await app.inject({ method: "GET", url: "/api/admin/sync/status" });
      expect(status.json<SyncStatus>().running).toBe(false);
    });

    const seerrSync = await app.inject({ method: "POST", url: "/api/seerr/sync" });
    expect(seerrSync.statusCode).toBe(202);
    expect(seerrSync.json()).toMatchObject({ accepted: true });
    await vi.waitFor(async () => {
      const status = await app.inject({ method: "GET", url: "/api/admin/sync/status" });
      expect(status.json<SyncStatus>().running).toBe(false);
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "funny fantasy" }
    });
    const body = response.json<SearchResponse>();

    expect(response.statusCode).toBe(200);
    expect(body.sessionId).toEqual(expect.any(String));
    expect(body.results.some((item) => item.title === "The Princess Bride" && item.availabilityGroup === "not_in_plex_requestable")).toBe(true);
    expect(body.results.some((item) => item.title === "Stardust" && item.availabilityGroup === "available_in_plex")).toBe(true);
  });

  it("returns a readable validation error for overlong search queries", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "x".repeat(2001) }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<{ error: string }>().error).toBe("Invalid request: query must be 2000 characters or fewer.");
  });

  it("accepts result limits up to 200 and rejects larger requests", async () => {
    const app = makeApp();
    const accepted = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "funny fantasy", resultLimit: 200, useAi: false }
    });
    const rejected = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "funny fantasy", resultLimit: 201, useAi: false }
    });

    expect(accepted.statusCode).toBe(200);
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json<{ error: string }>().error).toBe("Invalid request: resultLimit must be 200 or less.");
  });

  it("uses the configured default result limit when search omits a result count", async () => {
    const app = makeApp(testConfig({ search: { defaultResultLimit: 1 } }));
    await app.inject({ method: "POST", url: "/api/library/sync" });
    await app.inject({ method: "POST", url: "/api/seerr/sync" });

    const response = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "funny fantasy", useAi: false }
    });
    const body = response.json<SearchResponse>();

    expect(response.statusCode).toBe(200);
    expect(body.resultLimit).toBe(1);
    expect(body.results).toHaveLength(1);
  });

  it("purges fixture rows when switching to live mode", async () => {
    const app = makeApp(testConfig({ requireAdminToken: true }));
    await app.inject({ method: "POST", url: "/api/library/sync", headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" } });
    await app.inject({ method: "POST", url: "/api/seerr/sync", headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" } });

    const before = await app.inject({
      method: "GET",
      url: "/api/library/stats",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" }
    });
    expect(before.json<LibraryStats>().totalItems).toBeGreaterThan(0);

    const saved = await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: {
        fixtureMode: false,
        plex: { baseUrl: "http://plex.example", token: "test-plex-token-secret" },
        seerr: { baseUrl: "http://seerr.example", apiKey: "test-seerr-key-secret" }
      }
    });
    expect(saved.statusCode).toBe(200);

    const after = await app.inject({
      method: "GET",
      url: "/api/library/stats",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" }
    });
    expect(after.json<LibraryStats>().totalItems).toBe(0);
  });

  it("purges existing fixture rows on live-mode startup", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    repository.upsertMany([
      {
        source: "fixture",
        mediaType: "movie",
        title: "Fixture Requestable Movie",
        year: 2024,
        summary: "Demo row that should not survive live startup.",
        genres: ["Comedy"],
        externalIds: { tmdb: 424242 },
        seerr: { tmdbId: 424242, status: "unknown", requestable: true }
      }
    ]);

    const app = createApp({ config: testConfig({ fixtureMode: false, requireAdminToken: true }), db });
    const stats = await app.inject({
      method: "GET",
      url: "/api/library/stats",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" }
    });

    expect(stats.statusCode).toBe(200);
    expect(stats.json<LibraryStats>().totalItems).toBe(0);
  });

  it("serves posters through the authenticated proxy when admin auth is enabled", async () => {
    const app = makeApp(testConfig({ requireAdminToken: true }));
    const search = await app.inject({
      method: "POST",
      url: "/api/search",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: { query: "funny fantasy", resultLimit: 1, useAi: false }
    });
    const posterUrl = search.json<SearchResponse>().results[0]?.posterUrl;
    expect(posterUrl).toBeTruthy();

    const denied = await app.inject({ method: "GET", url: posterUrl! });
    const allowed = await app.inject({
      method: "GET",
      url: posterUrl!,
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" }
    });

    expect(denied.statusCode).toBe(401);
    expect(allowed.statusCode).toBe(200);
    expect(allowed.headers["content-type"]).toContain("image/");
  });

  it("honors the requested search result limit", async () => {
    const app = makeApp();
    const response = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "funny fantasy", resultLimit: 2 }
    });
    const body = response.json<SearchResponse>();

    expect(response.statusCode).toBe(200);
    expect(body.results).toHaveLength(2);
  });

	  it("saves recommendation queries to the review queue and accepts mood-fit feedback", async () => {
	    const app = makeApp(testConfig({ reviewQueue: { retentionDays: 90, maxQueries: 500, captureRawQueries: true } }));
    const search = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "quiet hopeful science fiction", resultLimit: 3, useAi: false }
    });
    expect(search.statusCode).toBe(200);

    const pending = await app.inject({ method: "GET", url: "/api/review-queue?status=pending" });
    const pendingBody = pending.json<QueryReviewQueueResponse>();
    expect(pending.statusCode).toBe(200);
    expect(pendingBody.count).toBe(1);
    expect(pendingBody.items[0]).toMatchObject({
      query: "quiet hopeful science fiction",
      watchContext: "solo",
      resultCount: 3
    });
    expect(pendingBody.items[0]!.results.length).toBeGreaterThan(0);

    const saved = await app.inject({
      method: "PUT",
      url: `/api/review-queue/${encodeURIComponent(pendingBody.items[0]!.id)}`,
      payload: {
        moodFitRating: 2,
        moodFeedbackText: "Too action-heavy for the mood."
      }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({
      moodFitRating: 2,
      moodFeedbackText: "Too action-heavy for the mood."
    });

    const afterPending = await app.inject({ method: "GET", url: "/api/review-queue?status=pending" });
    const reviewed = await app.inject({ method: "GET", url: "/api/review-queue?status=reviewed" });
    expect(afterPending.json<QueryReviewQueueResponse>().count).toBe(0);
    expect(reviewed.json<QueryReviewQueueResponse>().count).toBe(1);
  });

	  it("prunes saved query reviews by configured max query count", async () => {
	    const app = makeApp(testConfig({ reviewQueue: { retentionDays: 90, maxQueries: 2, captureRawQueries: false } }));

    for (const query of ["warm comedy", "somber mystery", "gentle fantasy"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/search",
        payload: { query, resultLimit: 2, useAi: false }
      });
      expect(response.statusCode).toBe(200);
    }

    const queue = await app.inject({ method: "GET", url: "/api/review-queue?status=all" });
    expect(queue.statusCode).toBe(200);
	    expect(queue.json<QueryReviewQueueResponse>().count).toBe(2);
	  });

	  it("redacts saved query review text unless raw query capture is enabled", async () => {
	    const app = makeApp();

	    const response = await app.inject({
	      method: "POST",
	      url: "/api/search",
	      payload: { query: "private family movie with http://secret.local/token", resultLimit: 2, useAi: false }
	    });
	    expect(response.statusCode).toBe(200);

	    const queue = await app.inject({ method: "GET", url: "/api/review-queue?status=all" });
	    const body = queue.json<QueryReviewQueueResponse>();
	    expect(body.count).toBe(1);
	    expect(body.items[0]!.query).toMatch(/^\[redacted-query:[a-f0-9]{12}\]$/);
	    expect(JSON.stringify(body)).not.toContain("private family movie");
	    expect(JSON.stringify(body)).not.toContain("secret.local");
	  });

	  it("prunes saved query reviews by configured retention period", async () => {
	    const db = createDatabase(":memory:");
	    const app = createApp({ config: testConfig({ reviewQueue: { retentionDays: 1, maxQueries: 500, captureRawQueries: true } }), db });

    const oldSearch = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "old quiet drama", resultLimit: 2, useAi: false }
    });
    expect(oldSearch.statusCode).toBe(200);
    db.prepare("UPDATE query_review_queue SET created_at = ?, updated_at = ?").run("2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z");

    const freshSearch = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "fresh quiet drama", resultLimit: 2, useAi: false }
    });
    expect(freshSearch.statusCode).toBe(200);

    const queue = await app.inject({ method: "GET", url: "/api/review-queue?status=all" });
    const body = queue.json<QueryReviewQueueResponse>();
    expect(body.count).toBe(1);
    expect(body.items[0]!.query).toBe("fresh quiet drama");
  });

  it("accepts optional feedback context on search without echoing secrets", async () => {
    const app = makeApp();
    const initial = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "feel-good comedy", resultLimit: 5 }
    });
    const firstBody = initial.json<SearchResponse>();
    const liked = firstBody.results[0];
    const disliked = firstBody.results.find((item) => item.title === "The Do-Over") ?? firstBody.results[1];
    const maybe = firstBody.results.find((item) => item.id !== liked?.id && item.id !== disliked?.id) ?? liked;
    expect(liked).toBeTruthy();
    expect(disliked).toBeTruthy();
    expect(maybe).toBeTruthy();

    const refined = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: {
        query: "more like this",
        resultLimit: 5,
        feedbackContext: {
          moreLikeItemIds: [liked!.id],
          maybeItemIds: [maybe!.id],
          lessLikeItemIds: [disliked!.id],
          hiddenItemIds: [disliked!.id]
        }
      }
    });

    expect(refined.statusCode).toBe(200);
    expect(refined.body).not.toContain("test-plex-token-secret");
    expect(refined.body).not.toContain("test-seerr-key-secret");
    expect(refined.json<SearchResponse>().results.some((item) => item.id === disliked!.id)).toBe(false);
  });

  it("records structured feel feedback for web and iOS calibration signals", async () => {
    const db = createDatabase(":memory:");
    const app = createApp({ config: testConfig(), db });
    const search = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "cozy feel-good movie", resultLimit: 5, watchContext: "group" }
    });
    expect(search.statusCode).toBe(200);
    const body = search.json<SearchResponse>();
    expect(body.sessionId).toEqual(expect.any(String));
    const sessionId = body.sessionId!;
    const results = body.results;
    expect(results.length).toBeGreaterThanOrEqual(2);
    const session = db.prepare("SELECT id, profile_id, profile_version FROM recommendation_sessions WHERE id = ? LIMIT 1").get(sessionId) as {
      id: string;
      profile_id: string;
      profile_version: number;
    };
    expect(session).toMatchObject({ profile_id: "group:shared", profile_version: 0 });

    const saved = await app.inject({
      method: "POST",
      url: "/api/feel-feedback",
      payload: {
        action: "pairwise_pick",
        source: "ios",
        watchContext: "group",
        sessionId,
        itemId: results[0]!.id,
        comparedItemId: results[1]!.id,
        moodTerm: "Cozy",
        metadata: {
          gesture: "swipe-right",
          resultRank: 1,
          rawPrompt: "this should not be stored"
        }
      }
    });

    expect(saved.statusCode).toBe(200);
    expect(saved.json<FeelFeedbackResponse>()).toMatchObject({
      ok: true,
      reliability: "high",
      profileVersion: 1,
      profileHoldout: false,
      appliedPreferenceSignal: true,
      appliedProfileSignal: true
    });
    const row = db.prepare("SELECT action, reliability, source, mood_term, metadata_json, profile_version, profile_update_applied, profile_holdout FROM feel_feedback_events LIMIT 1").get() as {
      action: string;
      reliability: string;
      source: string;
      mood_term: string;
      metadata_json: string;
      profile_version: number;
      profile_update_applied: number;
      profile_holdout: number;
    };
    expect(row).toMatchObject({ action: "pairwise_pick", reliability: "high", source: "ios", mood_term: "cozy", profile_version: 1, profile_update_applied: 1, profile_holdout: 0 });
    expect(row.metadata_json).toContain("swipe-right");
    expect(row.metadata_json).not.toContain("rawPrompt");
    const weightCount = (db.prepare("SELECT COUNT(*) AS value FROM preference_feature_weights WHERE profile_id = 'group:shared'").get() as { value: number }).value;
    expect(weightCount).toBeGreaterThan(0);
    const profileTermRow = db.prepare(
      `SELECT evidence_count, positive_count, negative_count, positive_weight, negative_weight,
        effective_evidence, conflict_score, confidence, version
       FROM feel_profile_terms
       WHERE profile_id = 'group:shared' AND term = 'cozy'`
    ).get() as {
      evidence_count: number;
      positive_count: number;
      negative_count: number;
      positive_weight: number;
      negative_weight: number;
      effective_evidence: number;
      conflict_score: number;
      confidence: number;
      version: number;
    };
    expect(profileTermRow).toMatchObject({
      evidence_count: 1,
      positive_count: 1,
      negative_count: 1,
      positive_weight: 1,
      negative_weight: 0,
      effective_evidence: 1,
      conflict_score: 0,
      confidence: 0.111,
      version: 1
    });

    const diagnostics = await app.inject({ method: "GET", url: "/api/admin/recommendations/diagnostics" });
    expect(diagnostics.statusCode).toBe(200);
    const diagnosticsBody = diagnostics.json<RecommendationDiagnostics>();
    expect(diagnosticsBody.recentRuns[0]).toMatchObject({ profileId: "group:shared", profileVersion: 0 });
    expect(diagnosticsBody.feelSignals).toMatchObject({
      total: 1,
      pairwise: 1,
      byReliability: [{ reliability: "high", count: 1 }],
      byAction: [{ action: "pairwise_pick", count: 1 }],
      recent: [{ action: "pairwise_pick", profileVersion: 1, profileUpdateApplied: true, profileHoldout: false }]
    });
    expect(diagnosticsBody.feelProfiles?.group.terms[0]).toMatchObject({
      term: "cozy",
      evidenceCount: 1,
      effectiveEvidence: 1,
      conflictScore: 0,
      version: 1,
      confidence: expect.any(Number)
    });

    const profile = await app.inject({ method: "GET", url: "/api/admin/feel-profiles?watchContext=group" });
    expect(profile.statusCode).toBe(200);
    expect(profile.json<FeelProfileResponse>().terms[0]).toMatchObject({
      term: "cozy",
      featureWeights: expect.any(Object),
      positiveCount: 1,
      negativeCount: 1,
      positiveWeight: 1,
      negativeWeight: 0,
      effectiveEvidence: 1,
      conflictScore: 0,
      version: 1
    });

    const profiledSearch = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "cozy movie", resultLimit: 5, watchContext: "group" }
    });
    expect(profiledSearch.statusCode).toBe(200);
    expect(profiledSearch.json<SearchResponse>().results.some((item) => typeof item.scoreBreakdown?.profile === "number")).toBe(true);
    const profiledSession = db.prepare("SELECT id, profile_version FROM recommendation_sessions ORDER BY created_at DESC LIMIT 1").get() as { id: string; profile_version: number };
    expect(profiledSession.profile_version).toBe(1);
    const replayRows = db.prepare("SELECT feature_version FROM recommendation_results WHERE session_id = ? ORDER BY rank").all(profiledSession.id) as Array<{ feature_version?: string }>;
    expect(replayRows.length).toBeGreaterThan(0);
    expect(replayRows.every((entry) => typeof entry.feature_version === "string" && entry.feature_version.length > 0)).toBe(true);

    const exported = await app.inject({ method: "GET", url: "/api/admin/feel-profiles/export" });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).not.toContain("test-plex-token-secret");
    expect(exported.body).not.toContain("test-seerr-key-secret");
    expect(exported.body).not.toContain("cozy feel-good movie");
    const exportedBody = exported.json<FeelProfileExportResponse>();
    expect(exportedBody).toMatchObject({
      schemaVersion: "feel-profile-export-v1",
      engineVersion: "moodrank-v0.4",
      profiles: { group: { terms: [{ term: "cozy", version: 1 }] } },
      feedbackSummary: { total: 1, holdouts: 0, appliedProfileUpdates: 1 }
    });
    expect(exportedBody.recentSlates[0]).toMatchObject({
      profileId: "group:shared",
      profileVersion: 1
    });
    expect(exportedBody.recentSlates[0]?.results[0]).toMatchObject({
      itemId: expect.any(String),
      featureVersion: expect.any(String),
      scoreBreakdown: expect.any(Object)
    });

    const reset = await app.inject({
      method: "DELETE",
      url: "/api/admin/feel-profiles",
      payload: { watchContext: "group", term: "cozy" }
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json<FeelProfileResetResponse>()).toMatchObject({ ok: true, watchContext: "group", term: "cozy", deletedTerms: 1, deletedCheckpoints: 1 });
  });

  it("keeps weak and diagnostic feel feedback out of term-profile learning", async () => {
    const db = createDatabase(":memory:");
    const app = createApp({ config: testConfig(), db });
    const search = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "cozy movie", resultLimit: 5, watchContext: "solo" }
    });
    const item = search.json<SearchResponse>().results[0]!;

    const opened = await app.inject({
      method: "POST",
      url: "/api/feel-feedback",
      payload: {
        action: "open",
        itemId: item.id,
        watchContext: "solo",
        moodTerm: "cozy",
        reason: "too_scary"
      }
    });
    const requestPreview = await app.inject({
      method: "POST",
      url: "/api/feel-feedback",
      payload: {
        action: "request_preview",
        itemId: item.id,
        watchContext: "solo",
        moodTerm: "cozy"
      }
    });
    const requestCreate = await app.inject({
      method: "POST",
      url: "/api/feel-feedback",
      payload: {
        action: "request_create",
        itemId: item.id,
        watchContext: "solo",
        moodTerm: "cozy"
      }
    });

    expect(opened.json<FeelFeedbackResponse>()).toMatchObject({ reliability: "diagnostic", appliedPreferenceSignal: false, appliedProfileSignal: false });
    expect(requestPreview.json<FeelFeedbackResponse>()).toMatchObject({ reliability: "diagnostic", appliedPreferenceSignal: false, appliedProfileSignal: false });
    expect(requestCreate.json<FeelFeedbackResponse>()).toMatchObject({ reliability: "weak", appliedPreferenceSignal: true, appliedProfileSignal: false });
    const profileTermCount = (db.prepare("SELECT COUNT(*) AS value FROM feel_profile_terms WHERE profile_id = 'solo:default'").get() as { value: number }).value;
    expect(profileTermCount).toBe(0);
    const rows = db.prepare("SELECT action, reliability, reason FROM feel_feedback_events ORDER BY id").all() as Array<{ action: string; reliability: string; reason?: string }>;
    expect(rows).toEqual([
      { action: "open", reliability: "diagnostic", reason: "too_scary" },
      { action: "request_preview", reliability: "diagnostic", reason: null },
      { action: "request_create", reliability: "weak", reason: null }
    ]);
  });

  it("applies high-reliability reason chips to term-profile learning", async () => {
    const db = createDatabase(":memory:");
    const app = createApp({ config: testConfig(), db });
    const search = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "dark movie", resultLimit: 5, watchContext: "solo" }
    });
    const item = search.json<SearchResponse>().results[0]!;

    const feedback = await app.inject({
      method: "POST",
      url: "/api/feel-feedback",
      payload: {
        action: "wrong_mood",
        itemId: item.id,
        watchContext: "solo",
        moodTerm: "dark",
        reason: "Too scary",
        strength: 5
      }
    });

    expect(feedback.statusCode).toBe(200);
    expect(feedback.json<FeelFeedbackResponse>()).toMatchObject({ reliability: "high", appliedPreferenceSignal: true, appliedProfileSignal: true });
    const row = db.prepare("SELECT reliability, reason FROM feel_feedback_events LIMIT 1").get() as { reliability: string; reason: string };
    expect(row).toEqual({ reliability: "high", reason: "too_scary" });
    const profile = await app.inject({ method: "GET", url: "/api/admin/feel-profiles?watchContext=solo" });
    const term = profile.json<FeelProfileResponse>().terms.find((entry) => entry.term === "dark");

    expect(term?.negativeCount).toBe(1);
    expect(term?.featureWeights["genre:horror"]).toBeLessThan(0);
    expect(term?.featureWeights["watch:high friction"]).toBeLessThan(0);
  });

  it("can reset all learned feel profile terms without deleting feedback evidence", async () => {
    const db = createDatabase(":memory:");
    const app = createApp({ config: testConfig(), db });
    const search = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "cozy movie", resultLimit: 5, watchContext: "solo" }
    });
    const item = search.json<SearchResponse>().results[0]!;
    for (const moodTerm of ["cozy", "light"]) {
      const response = await app.inject({
        method: "POST",
        url: "/api/feel-feedback",
        payload: {
          action: "right_mood",
          itemId: item.id,
          watchContext: "solo",
          moodTerm
        }
      });
      expect(response.statusCode).toBe(200);
    }

    const reset = await app.inject({
      method: "DELETE",
      url: "/api/admin/feel-profiles",
      payload: {}
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json<FeelProfileResetResponse>()).toMatchObject({ ok: true, deletedTerms: 2, deletedCheckpoints: 2 });
    const profileTermCount = (db.prepare("SELECT COUNT(*) AS value FROM feel_profile_terms").get() as { value: number }).value;
    const checkpointCount = (db.prepare("SELECT COUNT(*) AS value FROM feel_profile_checkpoints").get() as { value: number }).value;
    const feedbackCount = (db.prepare("SELECT COUNT(*) AS value FROM feel_feedback_events").get() as { value: number }).value;
    expect(profileTermCount).toBe(0);
    expect(checkpointCount).toBe(0);
    expect(feedbackCount).toBe(2);
  });

  it("inspects, exports, rolls back, and resets one user's solo Feel Profile without touching another user", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const userA = users.upsertPlexUser({ providerUserId: "profile-a", username: "alice", displayName: "Alice" }, true);
    const userB = users.upsertPlexUser({ providerUserId: "profile-b", username: "bob", displayName: "Bob" }, true);
    const sessionA = users.createSession(userA.id);
    const sessionB = users.createSession(userB.id);
    const config = testConfig({
      requireAdminToken: true,
      plexAuth: { ...testConfig().plexAuth, enabled: true }
    });
    const app = createApp({ config, db });
    const adminHeaders = { "X-Moodarr-Admin-Token": "test-admin-token-secret" };

    const learn = async (token: string, query: string, moodTerm: string, count: number) => {
      const search = await app.inject({
        method: "POST",
        url: "/api/search",
        headers: { authorization: `Bearer ${token}` },
        payload: { query, resultLimit: 5, watchContext: "solo" }
      });
      const body = search.json<SearchResponse>();
      for (let index = 0; index < count; index += 1) {
        const feedback = await app.inject({
          method: "POST",
          url: "/api/feel-feedback",
          headers: { authorization: `Bearer ${token}` },
          payload: {
            action: "right_mood",
            watchContext: "solo",
            sessionId: body.sessionId,
            itemId: body.results[index % body.results.length]!.id,
            moodTerm
          }
        });
        expect(feedback.statusCode).toBe(200);
      }
    };

    await learn(sessionA.token, "cozy movie", "cozy", 2);
    await learn(sessionB.token, "dark movie", "dark", 1);

    const listed = await app.inject({ method: "GET", url: "/api/admin/users", headers: adminHeaders });
    expect(listed.json<{ users: Array<{ id: string; displayName?: string; username?: string }> }>().users).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: userA.id, displayName: "Alice", username: "alice" }),
        expect.objectContaining({ id: userB.id, displayName: "Bob", username: "bob" })
      ])
    );

    const profileA = await app.inject({
      method: "GET",
      url: `/api/admin/feel-profiles?watchContext=solo&authUserId=${encodeURIComponent(userA.id)}`,
      headers: adminHeaders
    });
    expect(profileA.statusCode).toBe(200);
    expect(profileA.json<FeelProfileResponse>()).toMatchObject({ id: `solo:user:${userA.id}`, terms: [{ term: "cozy", version: 2 }] });

    const exported = await app.inject({
      method: "GET",
      url: `/api/admin/feel-profiles/export?authUserId=${encodeURIComponent(userA.id)}`,
      headers: adminHeaders
    });
    expect(exported.statusCode).toBe(200);
    expect(exported.json<FeelProfileExportResponse>()).toMatchObject({
      profiles: { solo: { id: `solo:user:${userA.id}`, terms: [{ term: "cozy" }] } },
      feedbackSummary: { total: 2 },
      recentSlates: [expect.objectContaining({ profileId: `solo:user:${userA.id}` })]
    });

    const rejectedGroupScope = await app.inject({
      method: "GET",
      url: `/api/admin/feel-profiles?watchContext=group&authUserId=${encodeURIComponent(userA.id)}`,
      headers: adminHeaders
    });
    expect(rejectedGroupScope.statusCode).toBe(400);
    const unknownUser = await app.inject({
      method: "GET",
      url: "/api/admin/feel-profiles?watchContext=solo&authUserId=missing-user",
      headers: adminHeaders
    });
    expect(unknownUser.statusCode).toBe(404);

    const rollback = await app.inject({
      method: "POST",
      url: "/api/admin/feel-profiles/rollback",
      headers: adminHeaders,
      payload: { watchContext: "solo", authUserId: userA.id, term: "cozy", version: 1 }
    });
    expect(rollback.statusCode).toBe(200);
    expect(rollback.json<FeelProfileRollbackResponse>()).toMatchObject({ restoredVersion: 1, profileVersion: 3 });

    const reset = await app.inject({
      method: "DELETE",
      url: "/api/admin/feel-profiles",
      headers: adminHeaders,
      payload: { watchContext: "solo", authUserId: userA.id, term: "cozy" }
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json<FeelProfileResetResponse>()).toMatchObject({ deletedTerms: 1 });
    expect(new MediaRepository(db).feelProfile("solo", userB.id).terms).toEqual([expect.objectContaining({ term: "dark" })]);
  });

  it("shrinks term-profile confidence when high-reliability mood evidence conflicts", async () => {
    const db = createDatabase(":memory:");
    const app = createApp({ config: testConfig(), db });
    const search = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "cozy movie", resultLimit: 5, watchContext: "solo" }
    });
    const item = search.json<SearchResponse>().results[0]!;

    for (const action of ["right_mood", "wrong_mood"] as const) {
      const response = await app.inject({
        method: "POST",
        url: "/api/feel-feedback",
        payload: {
          action,
          itemId: item.id,
          watchContext: "solo",
          moodTerm: "cozy"
        }
      });
      expect(response.statusCode).toBe(200);
    }
    for (let index = 0; index < 2; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/feel-feedback",
        payload: {
          action: "right_mood",
          itemId: item.id,
          watchContext: "solo",
          moodTerm: "light"
        }
      });
      expect(response.statusCode).toBe(200);
    }

    const terms = db
      .prepare(
        `SELECT term, positive_weight, negative_weight, effective_evidence, conflict_score, confidence
         FROM feel_profile_terms
         WHERE profile_id = 'solo:default'
         ORDER BY term`
      )
      .all() as Array<{
      term: string;
      positive_weight: number;
      negative_weight: number;
      effective_evidence: number;
      conflict_score: number;
      confidence: number;
    }>;
    const cozy = terms.find((term) => term.term === "cozy");
    const light = terms.find((term) => term.term === "light");

    expect(cozy).toMatchObject({ positive_weight: 1, negative_weight: 1, effective_evidence: 0.7, conflict_score: 1, confidence: 0.08 });
    expect(light).toMatchObject({ positive_weight: 2, negative_weight: 0, effective_evidence: 2, conflict_score: 0, confidence: 0.2 });
    expect(light!.confidence).toBeGreaterThan(cozy!.confidence);
  });

  it("caps profile learning updates by recommendation session and mood term", async () => {
    const db = createDatabase(":memory:");
    const app = createApp({ config: testConfig(), db });
    const search = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "cozy movie", resultLimit: 5, watchContext: "solo" }
    });
    const item = search.json<SearchResponse>().results[0]!;
    const session = db.prepare("SELECT id FROM recommendation_sessions ORDER BY created_at DESC LIMIT 1").get() as { id: string };

    const responses: FeelFeedbackResponse[] = [];
    for (let index = 0; index < 4; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/feel-feedback",
        payload: {
          action: "right_mood",
          itemId: item.id,
          sessionId: session.id,
          watchContext: "solo",
          moodTerm: "cozy"
        }
      });
      expect(response.statusCode).toBe(200);
      responses.push(response.json<FeelFeedbackResponse>());
    }

    expect(responses.map((response) => response.appliedProfileSignal)).toEqual([true, true, true, false]);
    expect(responses.map((response) => response.profileVersion)).toEqual([1, 2, 3, 3]);
    const term = db.prepare(
      `SELECT evidence_count, positive_count, negative_count, positive_weight, negative_weight,
        effective_evidence, conflict_score, confidence, version
       FROM feel_profile_terms
       WHERE profile_id = 'solo:default' AND term = 'cozy'`
    ).get() as {
      evidence_count: number;
      positive_count: number;
      negative_count: number;
      positive_weight: number;
      negative_weight: number;
      effective_evidence: number;
      conflict_score: number;
      confidence: number;
      version: number;
    };
    expect(term).toMatchObject({
      evidence_count: 3,
      positive_count: 3,
      negative_count: 0,
      positive_weight: 3,
      negative_weight: 0,
      effective_evidence: 3,
      conflict_score: 0,
      confidence: 0.273,
      version: 3
    });
    const eventStats = db.prepare("SELECT COUNT(*) AS total, SUM(profile_update_applied) AS applied, MAX(profile_version) AS version FROM feel_feedback_events").get() as {
      total: number;
      applied: number;
      version: number;
    };
    expect(eventStats).toEqual({ total: 4, applied: 3, version: 3 });
  });

  it("holds out deterministic eligible profile signals for future replay checks", async () => {
    const db = createDatabase(":memory:");
    const app = createApp({ config: testConfig(), db });
    const search = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "cozy movie", resultLimit: 5, watchContext: "solo" }
    });
    const item = search.json<SearchResponse>().results[0]!;
    const responses: FeelFeedbackResponse[] = [];
    for (let index = 0; index < 10; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/feel-feedback",
        payload: {
          action: "right_mood",
          itemId: item.id,
          watchContext: "solo",
          moodTerm: "cozy"
        }
      });
      expect(response.statusCode).toBe(200);
      responses.push(response.json<FeelFeedbackResponse>());
    }

    expect(responses.slice(0, 9).every((response) => response.appliedProfileSignal === true && response.profileHoldout === false)).toBe(true);
    expect(responses[9]).toMatchObject({ profileHoldout: true, appliedProfileSignal: false, profileVersion: 9 });
    const stats = db.prepare("SELECT SUM(profile_holdout) AS holdouts, SUM(profile_update_applied) AS applied FROM feel_feedback_events").get() as {
      holdouts: number;
      applied: number;
    };
    const term = db.prepare("SELECT evidence_count, version FROM feel_profile_terms WHERE profile_id = 'solo:default' AND term = 'cozy'").get() as {
      evidence_count: number;
      version: number;
    };
    expect(stats).toEqual({ holdouts: 1, applied: 9 });
    expect(term).toMatchObject({ evidence_count: 9, version: 9 });

    const diagnostics = new MediaRepository(db).recommendationDiagnostics();
    expect(diagnostics.usageReadiness).toMatchObject({
      status: "collecting",
      ready: false,
      signalProgress: {
        total: 10,
        appliedProfileUpdates: 9,
        targetAppliedProfileUpdates: 10,
        holdouts: 1,
        targetHoldouts: 1,
        replayComparisons: 0,
        targetReplayComparisons: 1
      },
      profileVersions: { solo: 9, max: 9, learnedTerms: 1 },
      review: { driftAlerts: 0, rollbackRecommended: false }
    });
  });

  it("replays held-out profile signals against the next profile checkpoint", async () => {
    const db = createDatabase(":memory:");
    const app = createApp({ config: testConfig(), db });
    let heldoutItemId: string | undefined;

    for (let index = 0; index < 11; index += 1) {
      const search = await app.inject({
        method: "POST",
        url: "/api/search",
        payload: { query: "cozy movie", resultLimit: 5, watchContext: "solo" }
      });
      const item = search.json<SearchResponse>().results[0]!;
      const session = db.prepare("SELECT id FROM recommendation_sessions ORDER BY created_at DESC LIMIT 1").get() as { id: string };
      if (index === 9) heldoutItemId = item.id;
      const response = await app.inject({
        method: "POST",
        url: "/api/feel-feedback",
        payload: {
          action: "right_mood",
          itemId: heldoutItemId ?? item.id,
          sessionId: session.id,
          watchContext: "solo",
          moodTerm: "cozy"
        }
      });
      expect(response.statusCode).toBe(200);
    }

    const repository = new MediaRepository(db);
    const replay = repository.profileReplayEvaluation();
    expect(replay).toMatchObject({
      engineVersion: "moodrank-v0.4",
      holdoutEvents: 1,
      compared: 1,
      losses: 0
    });
    expect(replay.cases[0]).toMatchObject({
      itemId: heldoutItemId,
      moodTerm: "cozy",
      eventProfileVersion: 9,
      nextProfileVersion: 10,
      outcome: expect.stringMatching(/win|tie/)
    });
    expect(replay.cases[0]!.afterProfileScore).toBeGreaterThanOrEqual(replay.cases[0]!.beforeProfileScore);

    const diagnostics = repository.recommendationDiagnostics();
    expect(diagnostics.feelProfileTimeline?.totalCheckpoints).toBe(10);
    expect(diagnostics.feelProfileTimeline?.recent[0]).toMatchObject({ term: "cozy", version: 10, effectiveEvidence: 10 });
    expect(diagnostics.replayStorage).toMatchObject({
      sessions: 11,
      feedbackEvents: 11,
      holdoutEvents: 1,
      checkpoints: 10,
      retentionPolicy: { retentionDays: 180, maxSessions: 1000, maxFeedbackEvents: 5000, maxCheckpointsPerTerm: 120 }
    });
    expect(diagnostics.usageReadiness).toMatchObject({
      status: "replay_ready",
      ready: true,
      signalProgress: {
        total: 11,
        appliedProfileUpdates: 10,
        holdouts: 1,
        replayComparisons: 1
      },
      profileVersions: { solo: 10, max: 10, learnedTerms: 1 },
      review: { driftAlerts: 0, rollbackRecommended: false }
    });

    const compaction = repository.compactReplayData({ retentionDays: 365, maxSessions: 3, maxFeedbackEvents: 4, maxCheckpointsPerTerm: 2 });
    expect(compaction).toMatchObject({
      policy: { retentionDays: 365, maxSessions: 3, maxFeedbackEvents: 4, maxCheckpointsPerTerm: 2 },
      deletedSessions: 8,
      deletedFeedbackEvents: 7,
      deletedCheckpoints: 8
    });
    const storageAfterCompaction = repository.recommendationDiagnostics().replayStorage;
    expect(storageAfterCompaction).toMatchObject({
      sessions: 3,
      resultRows: 15,
      feedbackEvents: 4,
      checkpoints: 2
    });
  });

  it("exposes drift diagnostics and can roll back a feel profile term to an earlier checkpoint", async () => {
    const db = createDatabase(":memory:");
    const app = createApp({ config: testConfig({ requireAdminToken: true }), db });
    const adminHeaders = { "X-Moodarr-Admin-Token": "test-admin-token-secret" };

    for (let index = 0; index < 4; index += 1) {
      const search = await app.inject({
        method: "POST",
        url: "/api/search",
        headers: adminHeaders,
        payload: { query: "dark intense movie", resultLimit: 10, watchContext: "solo" }
      });
      const item = search.json<SearchResponse>().results.find((candidate) => candidate.title === "Get Out") ?? search.json<SearchResponse>().results[0]!;
      const session = db.prepare("SELECT id FROM recommendation_sessions ORDER BY rowid DESC LIMIT 1").get() as { id: string };
      const response = await app.inject({
        method: "POST",
        url: "/api/feel-feedback",
        headers: adminHeaders,
        payload: {
          action: index < 2 ? "right_mood" : "wrong_mood",
          itemId: item.id,
          sessionId: session.id,
          watchContext: "solo",
          moodTerm: "dark",
          reason: index < 2 ? undefined : "too_scary"
        }
      });
      expect(response.statusCode).toBe(200);
    }

    const repository = new MediaRepository(db);
    const beforeRollback = repository.recommendationDiagnostics();
    expect(beforeRollback.feelProfileDrift?.alerts[0]).toMatchObject({
      watchContext: "solo",
      term: "dark",
      severity: "review",
      recommendation: "review_or_rollback"
    });
    expect(beforeRollback.feelProfiles?.solo.terms.find((term) => term.term === "dark")).toMatchObject({
      version: 4,
      conflictScore: 1
    });

    const rollback = await app.inject({
      method: "POST",
      url: "/api/admin/feel-profiles/rollback",
      headers: adminHeaders,
      payload: { watchContext: "solo", term: "dark", version: 2 }
    });

    expect(rollback.statusCode).toBe(200);
    expect(rollback.json<FeelProfileRollbackResponse>()).toMatchObject({
      ok: true,
      watchContext: "solo",
      term: "dark",
      restoredVersion: 2,
      profileVersion: 5
    });

    const afterRollback = repository.recommendationDiagnostics();
    expect(afterRollback.feelProfiles?.solo.terms.find((term) => term.term === "dark")).toMatchObject({
      version: 5,
      conflictScore: 0
    });
    expect(afterRollback.feelProfileTimeline?.totalCheckpoints).toBe(5);
    expect(afterRollback.feelProfileDrift?.alerts.some((alert) => alert.term === "dark" && alert.watchContext === "solo")).toBe(false);
  });

  it("exposes admin recommendation diagnostics without secrets", async () => {
    const app = makeApp(testConfig({ requireAdminToken: true }));
    await app.inject({
      method: "POST",
      url: "/api/search",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: { query: "feel-good comedy", resultLimit: 5 }
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/admin/recommendations/diagnostics",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("test-plex-token-secret");
    expect(response.body).not.toContain("test-seerr-key-secret");
    expect(response.body).not.toContain("test-openai-key-secret");
    expect(response.json()).toMatchObject({
      engineVersion: "moodrank-v0.4",
      sessions: { total: expect.any(Number) },
      features: {
        mediaFeatureCount: expect.any(Number),
        catalog: {
          trustedRefreshRequiredItems: expect.any(Number),
          requestableTrustedRefreshRequiredItems: expect.any(Number),
          catalogRefreshRequiredItems: expect.any(Number),
          plexRefreshRequiredItems: expect.any(Number),
          operationalOnlyItems: expect.any(Number),
          requestableOperationalOnlyItems: expect.any(Number)
        },
        contentFingerprints: {
          total: expect.any(Number),
          current: expect.any(Number),
          missing: expect.any(Number),
          projectedItemCount: expect.any(Number),
          projectedScoreCount: expect.any(Number),
          summaryThin: expect.any(Number),
          summaryMissing: expect.any(Number)
        }
      },
      usageReadiness: {
        status: "cold_start",
        ready: false,
        signalProgress: {
          total: 0,
          appliedProfileUpdates: 0,
          holdouts: 0,
          replayComparisons: 0
        },
        review: { driftAlerts: 0, rollbackRecommended: false }
      }
    });
  });

  it("uses newly saved OpenAI settings without restarting the server", async () => {
    const app = makeApp(
      testConfig({
        requireAdminToken: true,
        ai: {
          provider: "none",
          openaiModel: "gpt-5.5",
          openaiEmbeddingModel: "text-embedding-3-large",
          openaiReasoningEffort: "low"
        },
        knownSecrets: ["test-plex-token-secret", "test-seerr-key-secret", "saved-openai-key-secret", "test-admin-token-secret"]
      })
    );
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const href = String(url);
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        input?: unknown;
        text?: { format?: { name?: string } };
      };
      if (href.includes("/v1/embeddings")) {
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return jsonResponse({
          data: inputs.map((_, index) => ({
            index,
            embedding: Array.from({ length: 512 }, (_, dimension) => (dimension === 0 ? 1 : 0))
          }))
        });
      }

      if (href.includes("/v1/responses") && body.text?.format?.name === "moodarr_recommendation_brief") {
        return jsonResponse({
          output_text: JSON.stringify({
            terms: ["funny", "fantasy"],
            softGenres: ["Comedy", "Fantasy"],
            moods: ["funny", "feel-good"],
            referenceTitle: null,
            hardFilters: {
              mediaTypes: [],
              minRuntimeMinutes: null,
              maxRuntimeMinutes: null,
              minYear: null,
              maxYear: null,
              genres: [],
              excludedGenres: [],
              contentRating: null,
              availability: [],
              requestStatus: []
            },
            wantsBetter: false,
            wantsRequestOptions: false
          })
        });
      }

      if (href.includes("/v1/responses") && body.text?.format?.name === "moodarr_ranking") {
        const payload = responseUserPayload(body);
        return jsonResponse({
          output_text: JSON.stringify({
            summary: "I’d steer this toward warm fantasy comedy with easy, playful energy.",
            refinementOptions: [{ label: "More magical", prompt: "Lean more magical and whimsical." }],
            rankings: payload.candidates.slice(0, 5).map((candidate, index) => ({
              id: candidate.id,
              score: 96 - index,
              explanation: "Warm, playful fantasy-comedy energy makes this a good fit."
            }))
          })
        });
      }

      if (href.includes("/v1/responses") && body.text?.format?.name === "moodarr_taste_scout") {
        const payload = responseUserPayload(body);
        return jsonResponse({
          output_text: JSON.stringify({
            summary: "I’d keep this playful, warm, and easy to choose.",
            recommendations: payload.candidates.slice(0, 3).map((candidate, index) => ({
              id: candidate.id,
              score: 90 - index,
              reason: "Playful and easygoing."
            }))
          })
        });
      }

      if (href.includes("/v1/responses") && body.text?.format?.name === "moodarr_optimized_query") {
        return jsonResponse({
          output_text: JSON.stringify({
            query: "warm, playful fantasy comedy with easygoing group energy"
          })
        });
      }

      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const saved = await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: {
        fixtureMode: true,
        ai: {
          provider: "openai",
          openaiApiKey: "saved-openai-key-secret",
          openaiModel: "gpt-5.5",
          openaiEmbeddingModel: "text-embedding-3-large",
          openaiReasoningEffort: "low"
        }
      }
    });
    expect(saved.statusCode).toBe(200);

    const search = await app.inject({
      method: "POST",
      url: "/api/search",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: { query: "funny fantasy", resultLimit: 3 }
    });

    expect(search.statusCode).toBe(200);
    expect(search.json<SearchResponse>()).toMatchObject({
      usedAi: true,
      optimizedQuery: "funny fantasy",
      diagnostics: { aiBriefParsed: true, model: "gpt-5.5" }
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/responses",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer saved-openai-key-secret" })
      })
    );
  });

  it("blocks request creation without explicit confirmation", async () => {
    const app = makeApp();
    const search = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "Princess Bride" }
    });
    const princessBride = search.json<SearchResponse>().results.find((item) => item.title === "The Princess Bride");
    expect(princessBride).toBeTruthy();

    const create = await app.inject({
      method: "POST",
      url: "/api/requests/create",
      payload: { itemId: princessBride!.id }
    });

    expect(create.statusCode).toBe(409);
    expect(create.body).toContain("explicit confirmation");
  });

  it("creates an external request once for concurrent and repeated idempotent submissions", async () => {
    const db = createDatabase(":memory:");
    const app = createApp({ config: testConfig(), db });
    const search = await app.inject({ method: "POST", url: "/api/search", payload: { query: "Princess Bride" } });
    const item = search.json<SearchResponse>().results.find((result) => result.title === "The Princess Bride");
    expect(item).toBeTruthy();
    const preview = await app.inject({ method: "POST", url: "/api/requests/preview", payload: { itemId: item!.id } });
    const payload = {
      itemId: item!.id,
      confirmed: true,
      confirmationPhrase: preview.json<RequestPreview>().confirmationPhrase
    };
    const headers = { "Idempotency-Key": "request-princess-bride-once" };

    const [first, concurrent] = await Promise.all([
      app.inject({ method: "POST", url: "/api/requests/create", headers, payload }),
      app.inject({ method: "POST", url: "/api/requests/create", headers, payload })
    ]);
    expect(first.statusCode).toBe(200);
    expect(concurrent.statusCode).toBe(200);
    expect(concurrent.json()).toEqual(first.json());

    const repeated = await app.inject({ method: "POST", url: "/api/requests/create", headers, payload });
    expect(repeated.statusCode).toBe(200);
    expect(repeated.json()).toEqual(first.json());
    expect((db.prepare("SELECT COUNT(*) AS value FROM requests").get() as { value: number }).value).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS value FROM request_creation_operations WHERE status = 'created'").get() as { value: number }).value).toBe(1);

    const mismatched = await app.inject({
      method: "POST",
      url: "/api/requests/create",
      headers,
      payload: { ...payload, seasons: [1] }
    });
    expect(mismatched.statusCode).toBe(409);
    expect(mismatched.body).toContain("different request");
  });

  it("rejects a different payload that reuses an in-flight idempotency key", async () => {
    const db = createDatabase(":memory:");
    const app = createApp({ config: testConfig(), db });
    const search = await app.inject({ method: "POST", url: "/api/search", payload: { query: "Princess Bride" } });
    const item = search.json<SearchResponse>().results.find((result) => result.title === "The Princess Bride")!;
    const preview = await app.inject({ method: "POST", url: "/api/requests/preview", payload: { itemId: item.id } });
    const payload = { itemId: item.id, confirmed: true, confirmationPhrase: preview.json<RequestPreview>().confirmationPhrase };
    const headers = { "Idempotency-Key": "concurrent-mismatched-payload" };

    const responses = await Promise.all([
      app.inject({ method: "POST", url: "/api/requests/create", headers, payload }),
      app.inject({ method: "POST", url: "/api/requests/create", headers, payload: { ...payload, seasons: [1] } })
    ]);

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 409]);
    expect(responses.find((response) => response.statusCode === 409)?.body).toContain("different request");
    expect((db.prepare("SELECT COUNT(*) AS value FROM requests").get() as { value: number }).value).toBe(1);
  });

  it("treats a lost Seerr create response as uncertain and reconciles before any resend", async () => {
    const db = createDatabase(":memory:");
    const app = createApp({ config: testConfig(), db });
    const search = await app.inject({ method: "POST", url: "/api/search", payload: { query: "Princess Bride" } });
    const item = search.json<SearchResponse>().results.find((result) => result.title === "The Princess Bride")!;
    const preview = await app.inject({ method: "POST", url: "/api/requests/preview", payload: { itemId: item.id } });
    const payload = { itemId: item.id, confirmed: true, confirmationPhrase: preview.json<RequestPreview>().confirmationPhrase };
    const createRequest = vi.spyOn(SeerrClient.prototype, "createRequest").mockRejectedValueOnce(new Error("connection closed"));

    const first = await app.inject({ method: "POST", url: "/api/requests/create", payload });
    expect(first.statusCode).toBe(409);
    expect(first.body).toContain("will reconcile before any retry");
    expect((db.prepare("SELECT status FROM request_creation_operations").get() as { status: string }).status).toBe("uncertain");

    const retry = await app.inject({ method: "POST", url: "/api/requests/create", payload });
    expect(retry.statusCode).toBe(409);
    expect(retry.body).toContain("did not resend");
    expect(createRequest).toHaveBeenCalledTimes(1);
  });

  it("treats an unconfirmed Seerr 2xx body as uncertain without saving or auditing a created request", async () => {
    const db = createDatabase(":memory:");
    const app = createApp({ config: testConfig(), db });
    const search = await app.inject({ method: "POST", url: "/api/search", payload: { query: "Princess Bride" } });
    const item = search.json<SearchResponse>().results.find((result) => result.title === "The Princess Bride")!;
    const preview = await app.inject({ method: "POST", url: "/api/requests/preview", payload: { itemId: item.id } });
    const payload = { itemId: item.id, confirmed: true, confirmationPhrase: preview.json<RequestPreview>().confirmationPhrase };
    const createRequest = vi.spyOn(SeerrClient.prototype, "createRequest").mockResolvedValueOnce(
      { status: "requested" } as Awaited<ReturnType<SeerrClient["createRequest"]>>
    );

    const response = await app.inject({ method: "POST", url: "/api/requests/create", payload });

    expect(response.statusCode).toBe(409);
    expect(response.body).toContain("did not return a confirmed request outcome");
    expect((db.prepare("SELECT status FROM request_creation_operations").get() as { status: string }).status).toBe("uncertain");
    expect((db.prepare("SELECT COUNT(*) AS value FROM requests").get() as { value: number }).value).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS value FROM request_audit WHERE action = 'create' AND status = 'created'").get() as { value: number }).value).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS value FROM request_audit WHERE action = 'create' AND status = 'failed'").get() as { value: number }).value).toBe(1);
    expect(createRequest).toHaveBeenCalledTimes(1);
  });

  it("marks an unconfirmed stale request operation uncertain without resending it", async () => {
    const db = createDatabase(":memory:");
    const app = createApp({ config: testConfig(), db });
    const search = await app.inject({ method: "POST", url: "/api/search", payload: { query: "Princess Bride" } });
    const item = search.json<SearchResponse>().results.find((result) => result.title === "The Princess Bride")!;
    const preview = await app.inject({ method: "POST", url: "/api/requests/preview", payload: { itemId: item.id } });
    const payload = { itemId: item.id, confirmed: true, confirmationPhrase: preview.json<RequestPreview>().confirmationPhrase };
    const clientKey = "recover-stale-princess-bride";
    const fingerprint = crypto
      .createHash("sha256")
      .update(JSON.stringify({ itemId: item.id, mediaType: null, tmdbId: null, seasons: [] }))
      .digest("hex");
    const operationKey = crypto.createHash("sha256").update(`admin:${clientKey}`).digest("hex");
    const repository = new MediaRepository(db);
    expect(repository.beginRequestCreationOperation(operationKey, fingerprint, "admin", item.id)).toBe(true);
    db.prepare("UPDATE request_creation_operations SET updated_at = ? WHERE idempotency_key = ?").run(
      new Date(Date.now() - 10 * 60_000).toISOString(),
      operationKey
    );
    const createRequest = vi.spyOn(SeerrClient.prototype, "createRequest");

    const recovered = await app.inject({
      method: "POST",
      url: "/api/requests/create",
      headers: { "Idempotency-Key": clientKey },
      payload
    });
    expect(recovered.statusCode).toBe(409);
    expect(recovered.body).toContain("uncertain");
    expect(recovered.body).toContain("did not resend");
    expect(repository.requestCreationOperation(operationKey)).toMatchObject({ status: "uncertain" });
    expect((db.prepare("SELECT COUNT(*) AS value FROM requests").get() as { value: number }).value).toBe(0);
    expect(createRequest).not.toHaveBeenCalled();
  });

  it("reconciles a stale request against Seerr without resending it", async () => {
    const db = createDatabase(":memory:");
    const app = createApp({ config: testConfig(), db });
    const search = await app.inject({ method: "POST", url: "/api/search", payload: { query: "Princess Bride" } });
    const item = search.json<SearchResponse>().results.find((result) => result.title === "The Princess Bride")!;
    const preview = await app.inject({ method: "POST", url: "/api/requests/preview", payload: { itemId: item.id } });
    const payload = { itemId: item.id, confirmed: true, confirmationPhrase: preview.json<RequestPreview>().confirmationPhrase };
    const clientKey = "reconcile-stale-princess-bride";
    const fingerprint = crypto
      .createHash("sha256")
      .update(JSON.stringify({ itemId: item.id, mediaType: null, tmdbId: null, seasons: [] }))
      .digest("hex");
    const operationKey = crypto.createHash("sha256").update(`admin:${clientKey}`).digest("hex");
    const repository = new MediaRepository(db);
    expect(repository.beginRequestCreationOperation(operationKey, fingerprint, "admin", item.id)).toBe(true);
    db.prepare("UPDATE request_creation_operations SET updated_at = ? WHERE idempotency_key = ?").run(
      new Date(Date.now() - 10 * 60_000).toISOString(),
      operationKey
    );
    const syncRequests = vi.spyOn(SeerrClient.prototype, "syncRequests").mockResolvedValueOnce([
      {
        mediaType: item.mediaType,
        title: item.title,
        year: item.year,
        externalIds: { tmdb: item.seerr!.mediaId },
        seerr: {
          tmdbId: item.seerr!.mediaId,
          status: "requested",
          requestStatus: "pending",
          requestable: false
        }
      }
    ]);
    const createRequest = vi.spyOn(SeerrClient.prototype, "createRequest");

    const reconciled = await app.inject({
      method: "POST",
      url: "/api/requests/create",
      headers: { "Idempotency-Key": clientKey },
      payload
    });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json()).toMatchObject({ ok: true, reconciled: true, seerr: { status: "pending", reconciled: true } });
    expect(repository.requestCreationOperation(operationKey)).toMatchObject({ status: "created" });
    expect((db.prepare("SELECT COUNT(*) AS value FROM requests").get() as { value: number }).value).toBe(1);
    expect(syncRequests).toHaveBeenCalledTimes(1);
    expect(createRequest).not.toHaveBeenCalled();
  });

  it("resolves cross-instance request creation races without duplicate writes", async () => {
    const db = createDatabase(":memory:");
    const appA = createApp({ config: testConfig(), db });
    const appB = createApp({ config: testConfig(), db });
    const search = await appA.inject({ method: "POST", url: "/api/search", payload: { query: "Princess Bride" } });
    const item = search.json<SearchResponse>().results.find((result) => result.title === "The Princess Bride")!;
    const preview = await appA.inject({ method: "POST", url: "/api/requests/preview", payload: { itemId: item.id } });
    const payload = { itemId: item.id, confirmed: true, confirmationPhrase: preview.json<RequestPreview>().confirmationPhrase };
    const headers = { "Idempotency-Key": "cross-instance-princess-bride" };

    const responses = await Promise.all([
      appA.inject({ method: "POST", url: "/api/requests/create", headers, payload }),
      appB.inject({ method: "POST", url: "/api/requests/create", headers, payload })
    ]);
    expect(responses.some((response) => response.statusCode === 200)).toBe(true);
    expect(responses.every((response) => response.statusCode === 200 || response.statusCode === 409)).toBe(true);
    const conflict = responses.find((response) => response.statusCode === 409);
    if (conflict) expect(conflict.body).toContain("already being created");
    expect((db.prepare("SELECT COUNT(*) AS value FROM requests").get() as { value: number }).value).toBe(1);
  });

  it("requires TV season selection before request creation", async () => {
    const app = makeApp();
    const search = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "Fawlty Towers" }
    });
    const item = search.json<SearchResponse>().results.find((result) => result.title === "Fawlty Towers");
    expect(item).toBeTruthy();

    const preview = await app.inject({
      method: "POST",
      url: "/api/requests/preview",
      payload: { itemId: item!.id }
    });

    expect(preview.statusCode).toBe(409);
    expect(preview.json<RequestPreview>().blockedReason).toContain("season");
  });

  it("rejects request target tampering when itemId is present", async () => {
    const app = makeApp();
    const search = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "Princess Bride" }
    });
    const princessBride = search.json<SearchResponse>().results.find((item) => item.title === "The Princess Bride");
    expect(princessBride).toBeTruthy();

    const mediaIdTamper = await app.inject({
      method: "POST",
      url: "/api/requests/preview",
      payload: { itemId: princessBride!.id, mediaType: "movie", tmdbId: 999999 }
    });
    const mediaTypeTamper = await app.inject({
      method: "POST",
      url: "/api/requests/preview",
      payload: { itemId: princessBride!.id, mediaType: "tv" }
    });

    expect(mediaIdTamper.statusCode).toBe(400);
    expect(mediaTypeTamper.statusCode).toBe(400);
  });

  it("rejects request creation when an item-bound Seerr row has no media id", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const itemId = repository.upsert({
      mediaType: "movie",
      title: "Malformed Requestable",
      seerr: { status: "unknown", requestable: true }
    });
    const app = createApp({ config: testConfig({ fixtureMode: false, requireAdminToken: true }), db });

    const preview = await app.inject({
      method: "POST",
      url: "/api/requests/preview",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: { itemId, mediaType: "movie", tmdbId: 999999 }
    });

    expect(preview.statusCode).toBe(400);
    expect(preview.body).toContain("missing a trusted TMDB media ID");
  });

  it("previews and creates an honest Seerr request attempt for a trusted local catalog TMDB ID", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const itemId = repository.upsertCatalogRecord({
      source: "wikidata",
      sourceVersion: "request-attempt-test-v1",
      sourceItemId: "Q424242",
      licensePolicy: "CC0-1.0",
      media: {
        mediaType: "movie",
        title: "Trusted Catalog Candidate",
        summary: "Local open catalog metadata.",
        externalIds: { wikidata: "Q424242", tmdb: 424242 }
      }
    });
    const config = testConfig({
      fixtureMode: false,
      requireAdminToken: true,
      seerr: { ...testConfig().seerr, tmdbContentPolicy: "none" }
    });
    const app = createApp({ config, db });
    const createRequest = vi.spyOn(SeerrClient.prototype, "createRequest").mockResolvedValueOnce({
      id: 81,
      status: "approved",
      media: { title: "Untrusted Seerr title", overview: "Untrusted Seerr summary" },
      requestedBy: { email: "private@example.com", plexToken: "upstream-user-token-secret" },
      apiKey: "upstream-api-key-secret"
    } as unknown as Awaited<ReturnType<SeerrClient["createRequest"]>>);
    const headers = { "X-Moodarr-Admin-Token": "test-admin-token-secret" };

    const preview = await app.inject({ method: "POST", url: "/api/requests/preview", headers, payload: { itemId } });

    expect(preview.statusCode).toBe(200);
    expect(preview.json<RequestPreview>()).toMatchObject({
      canRequest: true,
      requestMode: "attempt",
      seerrAvailabilityChecked: false,
      request: { mediaType: "movie", mediaId: 424242, title: "Trusted Catalog Candidate" }
    });
    expect((db.prepare("SELECT COUNT(*) AS value FROM seerr_items WHERE media_item_id = ?").get(itemId) as { value: number }).value).toBe(0);

    const created = await app.inject({
      method: "POST",
      url: "/api/requests/create",
      headers,
      payload: { itemId, confirmed: true, confirmationPhrase: preview.json<RequestPreview>().confirmationPhrase }
    });

    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ seerr: { id: 81, status: "approved" } });
    expect(created.body).not.toContain("Untrusted Seerr");
    expect(created.body).not.toContain("private@example.com");
    expect(created.body).not.toContain("secret");
    const storedResponse = db.prepare("SELECT response_json FROM request_creation_operations WHERE status = 'created'").get() as { response_json: string };
    expect(JSON.parse(storedResponse.response_json)).toEqual(created.json());
    expect(storedResponse.response_json).not.toContain("Untrusted Seerr");
    expect(storedResponse.response_json).not.toContain("private@example.com");
    expect(storedResponse.response_json).not.toContain("secret");
    expect(createRequest).toHaveBeenCalledWith({ mediaType: "movie", mediaId: 424242, seasons: undefined });
    expect(db.prepare("SELECT tmdb_id, status, request_status, requestable FROM seerr_items WHERE media_item_id = ?").get(itemId)).toEqual({
      tmdb_id: 424242,
      status: "requested",
      request_status: "approved",
      requestable: 0
    });

    repository.upsert({
      source: "operational",
      mediaType: "movie",
      title: "Movie 424242",
      externalIds: { tmdb: 424242 },
      seerr: { tmdbId: 424242, seerrMediaId: 9001, status: "unknown", requestable: true }
    });
    expect(db.prepare("SELECT id, request_status, requestable FROM seerr_items WHERE media_item_id = ?").all(itemId)).toEqual([
      { id: "seerr:9001", request_status: "approved", requestable: 0 }
    ]);
  });

  it("rejects a local catalog request attempt without a trusted TMDB ID", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const itemId = repository.upsertCatalogRecord({
      source: "wikidata",
      sourceVersion: "request-attempt-test-v1",
      sourceItemId: "Q515151",
      licensePolicy: "CC0-1.0",
      media: {
        mediaType: "movie",
        title: "No TMDB Identity",
        externalIds: { wikidata: "Q515151" }
      }
    });
    const app = createApp({ config: testConfig({ fixtureMode: false, requireAdminToken: true }), db });

    const preview = await app.inject({
      method: "POST",
      url: "/api/requests/preview",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: { itemId }
    });

    expect(preview.statusCode).toBe(400);
    expect(preview.body).toContain("trusted TMDB media ID");
  });

  it("uses existing operational Seerr state to block a duplicate local request attempt", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const itemId = repository.upsertCatalogRecord({
      source: "wikidata",
      sourceVersion: "request-attempt-test-v1",
      sourceItemId: "Q616161",
      licensePolicy: "CC0-1.0",
      media: {
        mediaType: "movie",
        title: "Already Requested Candidate",
        externalIds: { wikidata: "Q616161", tmdb: 616161 }
      }
    });
    repository.upsert({
      source: "operational",
      mediaType: "movie",
      title: "Movie 616161",
      externalIds: { tmdb: 616161 },
      seerr: { tmdbId: 616161, status: "requested", requestStatus: "approved", requestable: false }
    });
    const app = createApp({ config: testConfig({ fixtureMode: false, requireAdminToken: true }), db });

    const preview = await app.inject({
      method: "POST",
      url: "/api/requests/preview",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: { itemId }
    });

    expect(preview.statusCode).toBe(409);
    expect(preview.json<RequestPreview>().blockedReason).toContain("already has request status approved");
  });

  it("proxies posters without leaking configured tokens", async () => {
    const app = makeApp();
    const search = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "Stardust" }
    });
    const stardust = search.json<SearchResponse>().results.find((item) => item.title === "Stardust");
    expect(stardust).toBeTruthy();
    expect(search.headers["cache-control"]).toBe("no-store");

    const poster = await app.inject({ method: "GET", url: `/api/items/${encodeURIComponent(stardust!.id)}/poster` });

    expect(poster.statusCode).toBe(200);
    expect(poster.headers["content-type"]).toContain("image/svg+xml");
    expect(poster.headers["cache-control"]).toBe("private, max-age=86400");
    expect(poster.body).not.toContain("test-plex-token-secret");
    expect(poster.body).not.toContain("test-seerr-key-secret");
  });

  it("escapes quotes in generated fallback SVG posters", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const itemId = repository.upsert({
      mediaType: "movie",
      title: "\" onload=\"globalThis.__xss=1",
      year: 2026,
      summary: "A title that should remain text.",
      genres: ["Drama"],
      seerr: { tmdbId: 101, status: "unknown", requestable: true }
    });
    const app = createApp({ config: testConfig({ fixtureMode: false, requireAdminToken: true }), db });

    const poster = await app.inject({
      method: "GET",
      url: `/api/items/${encodeURIComponent(itemId)}/poster`,
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" }
    });

    expect(poster.statusCode).toBe(200);
    expect(poster.headers["content-type"]).toContain("image/svg+xml");
    expect(poster.body).not.toContain("\" onload=");
    expect(poster.body).toContain("&quot; onload=&quot;globalThis.__xss=1");
  });

  it("rejects upstream SVG posters and serves the safe fallback instead", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const itemId = repository.upsert({
      mediaType: "movie",
      title: "Poster Safety Test",
      year: 2026,
      posterPath: "/library/metadata/1/thumb/1",
      plex: {
        ratingKey: "poster-safety-test",
        guid: "tmdb://101010",
        libraryTitle: "Movies",
        libraryType: "movie",
        available: true
      }
    });
    const fetchMock = vi.fn(async () => new Response("<svg onload=\"globalThis.__xss=1\"></svg>", { headers: { "content-type": "image/svg+xml" } }));
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp({ config: testConfig({ fixtureMode: false, requireAdminToken: true }), db });

    const poster = await app.inject({
      method: "GET",
      url: `/api/items/${encodeURIComponent(itemId)}/poster`,
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" }
    });

    expect(poster.statusCode).toBe(200);
    expect(poster.headers["content-type"]).toContain("image/svg+xml");
    expect(poster.body).toContain("Poster Safety Test");
    expect(poster.body).not.toContain("globalThis.__xss");
  });

  it("caches proxied posters after the first backend fetch", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const itemId = repository.upsert({
      mediaType: "movie",
      title: "Poster Cache Test",
      year: 2026,
      posterPath: "/library/metadata/1/thumb/1",
      plex: {
        ratingKey: "poster-cache-test",
        guid: "tmdb://101010",
        libraryTitle: "Movies",
        libraryType: "movie",
        available: true
      }
    });
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const app = createApp({ config: testConfig({ fixtureMode: false }), db });
      const first = await app.inject({ method: "GET", url: `/api/items/${encodeURIComponent(itemId)}/poster` });
      const second = await app.inject({ method: "GET", url: `/api/items/${encodeURIComponent(itemId)}/poster` });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(first.headers["cache-control"]).toBe("private, max-age=86400");
      expect(second.headers["cache-control"]).toBe("private, max-age=86400");
      expect(first.headers["content-type"]).toContain("image/jpeg");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).not.toContain("test-plex-token-secret");
      expect(second.body).toBe(first.body);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refetches a poster instead of serving a cache entry older than 180 days", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const itemId = repository.upsert({
      mediaType: "movie",
      title: "Poster Cache Expiry Test",
      year: 2026,
      posterPath: "/library/metadata/1/thumb/1",
      plex: {
        ratingKey: "poster-cache-expiry-test",
        guid: "tmdb://202020",
        libraryTitle: "Movies",
        libraryType: "movie",
        available: true
      }
    });
    const app = createApp({ config: testConfig({ fixtureMode: false }), db });
    const sourceKey = posterCacheSourceKey("/library/metadata/1/thumb/1", "http://plex.example");
    expect(sourceKey).toBeTruthy();
    repository.savePosterCache(itemId, sourceKey!, "image/jpeg", Buffer.from([9, 9, 9]));
    db.prepare("UPDATE poster_cache SET fetched_at = datetime('now', '-181 days') WHERE media_item_id = ?").run(itemId);
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const poster = await app.inject({ method: "GET", url: `/api/items/${encodeURIComponent(itemId)}/poster` });
      const cached = db.prepare("SELECT body FROM poster_cache WHERE media_item_id = ?").get(itemId) as { body: Uint8Array };

      expect(poster.statusCode).toBe(200);
      expect(poster.headers["content-type"]).toContain("image/jpeg");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(Buffer.from(cached.body)).toEqual(Buffer.from([1, 2, 3]));
    } finally {
      await app.close();
      db.close();
      vi.unstubAllGlobals();
    }
  });

  it("runs poster-cache retention at startup and periodically, then stops it on close", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const startupStaleId = repository.upsert({ mediaType: "movie", title: "Startup Expiry", year: 2026 });
    const startupFreshId = repository.upsert({ mediaType: "movie", title: "Startup Fresh", year: 2026 });
    repository.savePosterCache(startupStaleId, "startup-stale", "image/jpeg", Buffer.from("stale"));
    repository.savePosterCache(startupFreshId, "startup-fresh", "image/jpeg", Buffer.from("fresh"));
    db.prepare("UPDATE poster_cache SET fetched_at = datetime('now', '-181 days') WHERE media_item_id = ?").run(startupStaleId);
    db.prepare("UPDATE poster_cache SET fetched_at = datetime('now', '-179 days') WHERE media_item_id = ?").run(startupFreshId);
    let app: ReturnType<typeof createApp> | undefined;

    try {
      app = createApp({ config: testConfig({ fixtureMode: false }), db });
      expect(db.prepare("SELECT 1 FROM poster_cache WHERE media_item_id = ?").get(startupStaleId)).toBeUndefined();
      expect(repository.getPosterCache(startupFreshId, "startup-fresh")?.body.toString()).toBe("fresh");

      const periodicId = repository.upsert({ mediaType: "movie", title: "Periodic Expiry", year: 2026 });
      repository.savePosterCache(periodicId, "periodic", "image/jpeg", Buffer.from("stale"));
      db.prepare("UPDATE poster_cache SET fetched_at = datetime('now', '-181 days') WHERE media_item_id = ?").run(periodicId);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(db.prepare("SELECT 1 FROM poster_cache WHERE media_item_id = ?").get(periodicId)).toBeUndefined();

      await app.close();
      app = undefined;
      const afterCloseId = repository.upsert({ mediaType: "movie", title: "After Close", year: 2026 });
      repository.savePosterCache(afterCloseId, "after-close", "image/jpeg", Buffer.from("stale"));
      db.prepare("UPDATE poster_cache SET fetched_at = datetime('now', '-181 days') WHERE media_item_id = ?").run(afterCloseId);
      await vi.advanceTimersByTimeAsync(60 * 60_000);
      expect(db.prepare("SELECT 1 FROM poster_cache WHERE media_item_id = ?").get(afterCloseId)).toEqual({ 1: 1 });
    } finally {
      await app?.close();
      db.close();
      vi.useRealTimers();
    }
  });

  it("records request preview and create audit diagnostics", async () => {
    const app = makeApp();
    const search = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "Princess Bride" }
    });
    const princessBride = search.json<SearchResponse>().results.find((item) => item.title === "The Princess Bride");
    expect(princessBride).toBeTruthy();

    const preview = await app.inject({
      method: "POST",
      url: "/api/requests/preview",
      payload: { itemId: princessBride!.id }
    });
    expect(preview.statusCode).toBe(200);

    const blocked = await app.inject({
      method: "POST",
      url: "/api/requests/create",
      payload: { itemId: princessBride!.id }
    });
    expect(blocked.statusCode).toBe(409);

    const confirmation = preview.json<RequestPreview>().confirmationPhrase;
    const created = await app.inject({
      method: "POST",
      url: "/api/requests/create",
      payload: { itemId: princessBride!.id, confirmed: true, confirmationPhrase: confirmation }
    });
    expect(created.statusCode).toBe(200);

    const item = await app.inject({ method: "GET", url: `/api/items/${encodeURIComponent(princessBride!.id)}` });
    expect(item.json<ItemDetail>().availabilityGroup).toBe("already_requested");
    expect(item.json<ItemDetail>().seerr?.requestStatus).toBe("pending");

    const support = await app.inject({ method: "GET", url: "/api/admin/support-bundle" });
    expect(support.statusCode).toBe(200);
    expect(support.body).not.toContain("test-seerr-key-secret");
    expect(support.json().requests).toMatchObject({
      total: 3,
      previews: 1,
      creates: 2,
      blocked: 1,
      failed: 0
    });
  });

  it("returns sync history after a scheduled sync run", async () => {
    const app = makeApp();
    const run = await app.inject({ method: "POST", url: "/api/admin/sync/run" });
    expect(run.statusCode).toBe(202);
    expect(run.json()).toMatchObject({ accepted: true, running: true });

    await vi.waitFor(async () => {
      const current = await app.inject({ method: "GET", url: "/api/admin/sync/status" });
      expect(current.json<SyncStatus>().running).toBe(false);
    });

    const status = await app.inject({ method: "GET", url: "/api/admin/sync/status" });
    const body = status.json<SyncStatus>();

    expect(status.statusCode).toBe(200);
    expect(body.history?.library[0]).toMatchObject({ source: "fixture", status: "ok", itemCount: expect.any(Number) });
    expect(body.history?.seerr[0]).toMatchObject({ source: "fixture", status: "ok", itemCount: expect.any(Number) });
  });

  it("redacts and bounds sync errors again before persistence", () => {
    const db = createDatabase(":memory:");
    try {
      const repository = new MediaRepository(db);
      const secret = "persisted-sync-token-secret";
      const upstreamError = `GET /library?X-Plex-Token=${secret} failed ${"x".repeat(4_000)}`;

      repository.recordSync("library", "plex", "error", 0, upstreamError);
      repository.recordCatalogSync(
        "wikidata",
        "test-catalog-version",
        "error",
        { itemCount: 0, mediaItemsUpserted: 0, sourceRecordsUpserted: 0 },
        upstreamError
      );

      const library = db.prepare("SELECT error FROM library_sync_runs ORDER BY id DESC LIMIT 1").get() as { error: string };
      const catalog = db.prepare("SELECT error FROM catalog_sync_runs ORDER BY id DESC LIMIT 1").get() as { error: string };
      for (const persisted of [library.error, catalog.error]) {
        expect(persisted).toHaveLength(maxOperationalErrorLength);
        expect(persisted).not.toContain(secret);
        expect(persisted).toContain("X-Plex-Token=[REDACTED]");
        expect(persisted.endsWith("… [truncated]")).toBe(true);
      }
    } finally {
      db.close();
    }
  });

  it("recursively redacts and allowlists the final support bundle", async () => {
    const originalDiagnostics = MediaRepository.prototype.recommendationDiagnostics;
    vi.spyOn(MediaRepository.prototype, "recommendationDiagnostics").mockImplementation(function (this: MediaRepository) {
      const diagnostics = originalDiagnostics.call(this);
      Object.assign(diagnostics.sessions, {
        title: "smuggled private title",
        error: "smuggled private error test-seerr-key-secret",
        baseUrl: "http://private-upstream.internal",
        rawUpstream: { apiKey: "test-seerr-key-secret", body: "private upstream response" }
      });
      const latestRun = {
        source: "wikidata",
        sourceVersion: "test-catalog-version",
        status: "error",
        itemCount: 0,
        error: `Bearer upstream-bearer-secret test-seerr-key-secret ${"y".repeat(2_000)}`
      };
      Object.assign(latestRun, {
        displayName: "smuggled private identity",
        upstreamResponse: { authorization: "Bearer upstream-bearer-secret", body: "private upstream response" }
      });
      diagnostics.features.catalog!.latestRun = latestRun;
      return diagnostics;
    });
    const db = createDatabase(":memory:");
    const app = createApp({ config: testConfig(), db });

    try {
      const response = await app.inject({ method: "GET", url: "/api/admin/support-bundle" });
      const support = response.json<{
        settings: {
          plex: { tokenConfigured: boolean };
          seerr: { apiKeyConfigured: boolean };
          ai: { openaiApiKeyConfigured: boolean };
          plexAuth: { enabled: boolean; allowNewUsers: boolean };
        };
        stats: { totalItems: number };
        recommendations: RecommendationDiagnostics;
      }>();

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain("test-seerr-key-secret");
      expect(response.body).not.toContain("upstream-bearer-secret");
      expect(response.body).not.toContain("rawUpstream");
      expect(response.body).not.toContain("upstreamResponse");
      expect(response.body).not.toContain("private upstream response");
      expect(response.body).not.toContain("smuggled private");
      expect(support.settings).toMatchObject({
        plex: { tokenConfigured: true },
        seerr: { apiKeyConfigured: true },
        ai: { openaiApiKeyConfigured: true },
        plexAuth: { enabled: false, allowNewUsers: true }
      });
      expect(support.stats.totalItems).toEqual(expect.any(Number));
      expect(support.recommendations.sessions.total).toBeGreaterThanOrEqual(0);
      expect(support.recommendations.features.catalog?.latestRun?.error).toHaveLength(maxOperationalErrorLength);
      expect(support.recommendations.features.catalog?.latestRun?.error).toContain("Bearer [REDACTED]");
      expect(support.recommendations.sessions).not.toHaveProperty("title");
      expect(support.recommendations.sessions).not.toHaveProperty("error");
      expect(support.recommendations.sessions).not.toHaveProperty("baseUrl");
      expect(support.recommendations.features.catalog?.latestRun).not.toHaveProperty("displayName");
    } finally {
      await app.close();
      db.close();
    }
  });

  it("warms provider embeddings through the protected admin endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      return jsonResponse({
        data: (body.input ?? []).map((_, index) => ({
          index,
          embedding: Array.from({ length: 512 }, (_, dimension) => (dimension === 0 ? 1 : 0))
        }))
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const app = makeApp(
      testConfig({
        requireAdminToken: true,
        ai: {
          provider: "openai",
          openaiApiKey: "test-openai-key-secret",
          openaiModel: "gpt-5.5",
          openaiEmbeddingModel: "text-embedding-3-small",
          openaiReasoningEffort: "low"
        }
      })
    );

    const denied = await app.inject({
      method: "POST",
      url: "/api/admin/embeddings/warmup",
      payload: { limit: 2, batchSize: 1 }
    });
    expect(denied.statusCode).toBe(401);

    await app.inject({ method: "POST", url: "/api/library/sync", headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" } });
    const warmed = await app.inject({
      method: "POST",
      url: "/api/admin/embeddings/warmup",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: { limit: 2, batchSize: 1 }
    });

    expect(warmed.statusCode).toBe(200);
    expect(warmed.json()).toMatchObject({
      provider: "openai",
      model: "text-embedding-3-small",
      dimensions: 512,
      configured: true,
      attempted: 2,
      embedded: 2,
      compatibleCount: 2,
      staleCount: 0,
      hasMore: true
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      expect.objectContaining({
        body: expect.stringContaining('"dimensions":512'),
        headers: expect.objectContaining({ Authorization: "Bearer test-openai-key-secret" })
      })
    );
  });

  it("marks Plex items unavailable when a successful sync no longer sees them", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const staleId = repository.upsert({
      mediaType: "movie",
      title: "Removed From Plex",
      year: 2024,
      plex: {
        ratingKey: "removed-from-plex",
        guid: "tmdb://2024001",
        libraryTitle: "Movies",
        libraryType: "movie",
        available: true
      }
    });
    const app = createApp({ config: testConfig(), db });

    const run = await app.inject({ method: "POST", url: "/api/admin/sync/run" });
    expect(run.statusCode).toBe(202);
    expect(run.json()).toMatchObject({ accepted: true });

    await vi.waitFor(async () => {
      const status = await app.inject({ method: "GET", url: "/api/admin/sync/status" });
      expect(status.json<SyncStatus>().running).toBe(false);
      expect(status.json<SyncStatus>().lastResult).toMatchObject({ ok: true, plexUnavailable: 1 });
    });

    const item = await app.inject({ method: "GET", url: `/api/items/${encodeURIComponent(staleId)}` });
    expect(item.statusCode).toBe(200);
    expect(item.json<ItemDetail>().plex?.available).toBe(false);
    expect(item.json<ItemDetail>().availabilityGroup).toBe("unavailable");
  });

  it("tracks applied schema migrations", () => {
    const db = createDatabase(":memory:");
    const migrations = db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: string }[];
    const userVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };

    expect(migrations.map((migration) => migration.id)).toEqual([
      "001_initial_schema",
      "002_request_audit",
      "003_media_source",
      "004_mood_feature_scores",
      "005_query_review_queue",
      "006_feel_feedback_events",
      "007_feel_profile_terms",
      "008_feel_feedback_reliability",
      "009_profile_replay_metadata",
      "010_profile_confidence_evidence",
      "011_replay_logging_holdout",
      "012_feel_profile_checkpoints",
      "013_plex_user_auth",
      "014_request_auth_attribution",
      "015_feel_feedback_client_event_id",
      "016_store_plex_user_token",
      "017_open_catalog_backbone",
      "018_catalog_update_metadata",
      "019_catalog_search_index",
      "020_content_fingerprints",
      "021_moodrank_trace_foundation",
      "022_media_type_aware_external_ids",
      "023_user_scoped_feel_profiles",
      "024_request_creation_idempotency",
      "025_user_capabilities",
      "026_durable_auth_and_request_reconciliation",
      "027_bounded_poster_cache",
      "028_catalog_diagnostics_indexes",
      "029_strict_tmdb_content_boundary"
    ]);
    expect(userVersion.user_version).toBe(29);
  });

  it("prefers an explicit user bearer token over a stale user-session cookie", async () => {
    const db = createDatabase(":memory:");
    const users = new UserRepository(db);
    const userA = users.upsertPlexUser({ providerUserId: "bearer-user", username: "bearer" }, true);
    const userB = users.upsertPlexUser({ providerUserId: "cookie-user", username: "cookie" }, true);
    const sessionA = users.createSession(userA.id);
    const sessionB = users.createSession(userB.id);
    const app = createApp({ config: testConfig({ requireAdminToken: true, plexAuth: { ...testConfig().plexAuth, enabled: true } }), db });
    const headers = {
      authorization: `Bearer ${sessionA.token}`,
      cookie: `moodarr_user_session=${encodeURIComponent(sessionB.token)}`
    };

    const session = await app.inject({ method: "GET", url: "/api/auth/session", headers });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ authenticated: true, user: { id: userA.id } });

    const logout = await app.inject({ method: "POST", url: "/api/auth/logout", headers });
    expect(logout.statusCode).toBe(200);
    expect(users.findSessionUser(sessionA.token)).toBeUndefined();
    expect(users.findSessionUser(sessionB.token)).toMatchObject({ id: userB.id });
  });

  it("ignores malformed cookie fragments instead of failing the request", async () => {
    const app = makeApp(testConfig({ requireAdminToken: true }));
    const response = await app.inject({ method: "GET", url: "/api/admin/settings", headers: { cookie: "moodarr_admin_session=%" } });
    expect(response.statusCode).toBe(401);
  });

  it("requires admin auth for protected admin routes", async () => {
    const app = makeApp(testConfig({ requireAdminToken: true }));

    const denied = await app.inject({ method: "GET", url: "/api/admin/settings" });
    expect(denied.statusCode).toBe(401);
    expect(denied.body).not.toContain("test-admin-token-secret");

    const allowed = await app.inject({
      method: "GET",
      url: "/api/admin/settings",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" }
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.body).not.toContain("test-admin-token-secret");
    expect(allowed.body).not.toContain("test-plex-token-secret");
  });

  it("requires admin auth for private catalog reads when admin auth is enabled", async () => {
    const app = makeApp(testConfig({ requireAdminToken: true }));

    const denied = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "funny fantasy" }
    });
    expect(denied.statusCode).toBe(401);

    const allowed = await app.inject({
      method: "POST",
      url: "/api/search",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: { query: "funny fantasy", resultLimit: 2 }
    });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json<SearchResponse>().results).toHaveLength(2);
  });

  it("rate limits repeated costly route calls", async () => {
    const app = makeApp();

    for (let index = 0; index < 20; index += 1) {
      const response = await app.inject({ method: "POST", url: "/api/plex/test", payload: {} });
      expect(response.statusCode).toBe(200);
    }

    const limited = await app.inject({ method: "POST", url: "/api/plex/test", payload: {} });
    expect(limited.statusCode).toBe(429);
    expect(limited.headers["retry-after"]).toBeTruthy();
  });

  it("persists admin settings server-side without returning secrets", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "moodarr-admin-"));
    const configPath = join(dataDir, "config.json");
    const app = makeApp(testConfig({ dataDir, configPath, requireAdminToken: true }));

    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: {
        fixtureMode: false,
        plex: { baseUrl: "http://plex.internal:32400", token: "new-plex-token-secret" },
        seerr: { baseUrl: "http://seerr.internal:5055", apiKey: "new-seerr-key-secret" },
        ai: {
          provider: "openai",
          openaiApiKey: "new-openai-key-secret",
          openaiModel: "gpt-5.5",
          openaiEmbeddingModel: "text-embedding-3-large",
          openaiReasoningEffort: "high"
        },
        sync: { intervalMinutes: 15, syncSeerr: true },
        search: { defaultResultLimit: 75 },
	        reviewQueue: { retentionDays: 45, maxQueries: 250, captureRawQueries: true }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ai: { openaiReasoningEffort: "high" },
      search: { defaultResultLimit: 75 },
	      reviewQueue: { retentionDays: 45, maxQueries: 250, captureRawQueries: true }
    });
    expect(response.body).not.toContain("new-plex-token-secret");
    expect(response.body).not.toContain("new-seerr-key-secret");
    expect(response.body).not.toContain("new-openai-key-secret");
    expect(readFileSync(configPath, "utf8")).toContain("new-plex-token-secret");
    expect(statSync(configPath).mode & 0o777).toBe(0o600);

    const support = await app.inject({
      method: "GET",
      url: "/api/admin/support-bundle",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" }
    });

    expect(support.statusCode).toBe(200);
    expect(support.body).not.toContain("new-plex-token-secret");
    expect(support.body).not.toContain("new-seerr-key-secret");
    expect(support.body).not.toContain("new-openai-key-secret");
  });

  it("preserves runtime credentials when saving non-secret admin settings", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "moodarr-env-backed-admin-"));
    const config = testConfig({
      fixtureMode: false,
      dataDir,
      configPath: join(dataDir, "config.json"),
      requireAdminToken: true,
      plex: {
        baseUrl: "http://plex.env:32400",
        token: "env-plex-token-secret",
        webBaseUrl: "https://app.plex.tv/desktop"
      },
      seerr: {
        baseUrl: "http://seerr.env:5055",
        apiKey: "env-seerr-key-secret"
      },
      ai: {
        provider: "openai",
        openaiApiKey: "env-openai-key-secret",
        openaiModel: "gpt-5.5-env",
        openaiEmbeddingModel: "text-embedding-3-large",
        openaiReasoningEffort: "low"
      },
      knownSecrets: ["env-plex-token-secret", "env-seerr-key-secret", "env-openai-key-secret", "test-admin-token-secret"]
    });
    const app = makeApp(config);

    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: {
        fixtureMode: false,
        plex: { baseUrl: "http://plex.env:32400", webBaseUrl: "https://app.plex.tv/desktop" },
        seerr: { baseUrl: "http://seerr.env:5055" },
        ai: { provider: "openai", openaiModel: "gpt-5.5-env", openaiEmbeddingModel: "text-embedding-3-large", openaiReasoningEffort: "low" },
        sync: { intervalMinutes: 60, syncSeerr: true }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      plex: { tokenConfigured: true },
      seerr: { apiKeyConfigured: true },
      ai: { provider: "openai", openaiApiKeyConfigured: true, openaiModel: "gpt-5.5-env", openaiReasoningEffort: "low" }
    });
    expect(config.plex.token).toBe("env-plex-token-secret");
    expect(config.seerr.apiKey).toBe("env-seerr-key-secret");
    expect(config.ai.openaiApiKey).toBe("env-openai-key-secret");
    expect(response.body).not.toContain("env-plex-token-secret");
    expect(response.body).not.toContain("env-seerr-key-secret");
    expect(response.body).not.toContain("env-openai-key-secret");
  });

  it("requires Plex token when fixture mode is disabled", async () => {
    const app = makeApp(
      testConfig({
        requireAdminToken: true,
        plex: {
          webBaseUrl: "https://app.plex.tv/desktop"
        }
      })
    );

    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: {
        fixtureMode: false,
        plex: { baseUrl: "http://plex.internal:32400" }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("Plex token");
  });

  it("does not reuse stored Plex or Seerr credentials for request-selected test origins", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const app = makeApp(testConfig({ fixtureMode: false, requireAdminToken: true }));

    const plex = await app.inject({
      method: "POST",
      url: "/api/plex/test",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: { baseUrl: "http://attacker.example" }
    });
    const seerr = await app.inject({
      method: "POST",
      url: "/api/seerr/test",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: { baseUrl: "http://attacker.example" }
    });

    expect(plex.statusCode).toBe(200);
    expect(seerr.statusCode).toBe(200);
    expect(plex.json()).toMatchObject({ ok: false });
    expect(seerr.json()).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears stored integration credentials instead of rebinding them to a changed origin", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "moodarr-origin-rebind-"));
    const app = makeApp(
      testConfig({
        fixtureMode: false,
        dataDir,
        configPath: join(dataDir, "config.json"),
        requireAdminToken: true
      })
    );

    const plex = await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: { fixtureMode: false, plex: { baseUrl: "http://new-plex.example" } }
    });
    const seerr = await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: { fixtureMode: false, seerr: { baseUrl: "http://new-seerr.example" } }
    });

    expect(plex.statusCode).toBe(400);
    expect(plex.body).toContain("Plex token");
    expect(seerr.statusCode).toBe(400);
    expect(seerr.body).toContain("Seerr API key");
  });

  it("rejects unsafe integration and link URL schemes in admin settings", async () => {
    const app = makeApp(testConfig({ requireAdminToken: true }));
    const plex = await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: { plex: { webBaseUrl: "javascript:alert(1)" } }
    });
    const seerr = await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      headers: { "X-Moodarr-Admin-Token": "test-admin-token-secret" },
      payload: { seerr: { baseUrl: "javascript:alert(1)" } }
    });

    expect(plex.statusCode).toBe(400);
    expect(seerr.statusCode).toBe(400);
  });

  it("blocks request creation before auth when admin auth is required", async () => {
    const app = makeApp(testConfig({ requireAdminToken: true }));

    const denied = await app.inject({
      method: "POST",
      url: "/api/requests/create",
      payload: { itemId: "movie:tmdb:1", confirmed: true, confirmationPhrase: "REQUEST TEST" }
    });

    expect(denied.statusCode).toBe(401);
  });
});

function plexAuthFetchMock({ resourceServerId }: { resourceServerId: string }) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://plex.tv/api/v2/pins" && init?.method === "POST") {
      return jsonResponse({ id: 123, code: "ABCD", expiresAt: "2026-06-18T12:00:00.000Z" });
    }
    if (url.startsWith("https://plex.tv/api/v2/pins/123")) {
      return jsonResponse({ id: 123, code: "ABCD", authToken: "user-plex-token-secret" });
    }
    if (url === "https://plex.tv/api/v2/user") {
      return jsonResponse({ id: 42, username: "jarel", title: "Jarel", email: "jarel@example.com" });
    }
    if (url === "http://plex.example/identity") {
      return jsonResponse({ MediaContainer: { machineIdentifier: "server-abc" } });
    }
    if (url.startsWith("https://plex.tv/api/v2/resources")) {
      return jsonResponse([{ clientIdentifier: resourceServerId, provides: "server" }]);
    }
    if (url.startsWith("https://discover.provider.plex.tv/actions/addToWatchlist")) {
      return jsonResponse({ ok: true });
    }
    return jsonResponse({}, 404);
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function responseUserPayload(body: { input?: unknown }) {
  const input = Array.isArray(body.input) ? body.input : [];
  const user = input.find((entry): entry is { role?: string; content?: Array<{ text?: string }> } => {
    return Boolean(entry && typeof entry === "object" && "role" in entry && (entry as { role?: string }).role === "user");
  });
  const text = user?.content?.find((entry) => typeof entry.text === "string")?.text ?? "{}";
  return JSON.parse(text) as { candidates: Array<{ id: string }> };
}
