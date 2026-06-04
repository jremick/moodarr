import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { loadConfig, type AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import type { ItemDetail, RequestPreview, SearchResponse, SyncStatus } from "../src/shared/types";

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
      openaiEmbeddingModel: "text-embedding-3-large"
    },
    sync: {
      intervalMinutes: 0,
      syncSeerr: true
    },
    knownSecrets: ["test-plex-token-secret", "test-seerr-key-secret", "test-openai-key-secret", "test-admin-token-secret"]
  };
  return { ...base, ...overrides };
}

function makeApp(config = testConfig()) {
  return createApp({ config, db: createDatabase(":memory:") });
}

describe("Moodarr API", () => {
  it("accepts legacy Feelerr environment names during the rename", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "moodarr-legacy-env-"));
    const config = loadConfig({
      FEELERR_DATA_DIR: dataDir,
      FEELERR_CONFIG_PATH: join(dataDir, "config.json"),
      FEELERR_DB_PATH: join(dataDir, "feelerr.sqlite"),
      FEELERR_API_PORT: "4410",
      FEELERR_ADMIN_TOKEN: "legacy-admin-token-secret",
      FEELERR_REQUIRE_ADMIN_TOKEN: "true",
      FEELERR_SYNC_INTERVAL_MINUTES: "120"
    });

    expect(config.dataDir).toBe(dataDir);
    expect(config.dbPath).toBe(join(dataDir, "feelerr.sqlite"));
    expect(config.apiPort).toBe(4410);
    expect(config.adminToken).toBe("legacy-admin-token-secret");
    expect(config.requireAdminToken).toBe(true);
    expect(config.sync.intervalMinutes).toBe(120);
  });

  it("returns public config status without secrets", async () => {
    const app = makeApp();
    const response = await app.inject({ method: "GET", url: "/api/config/status" });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("test-plex-token-secret");
    expect(response.body).not.toContain("test-seerr-key-secret");
    expect(response.json()).toMatchObject({
      fixtureMode: true,
      plex: { configured: true },
      seerr: { configured: true }
    });
  });

  it("syncs fixtures and returns available Plex and requestable Seerr search results", async () => {
    const app = makeApp();
    await app.inject({ method: "POST", url: "/api/library/sync" });
    await app.inject({ method: "POST", url: "/api/seerr/sync" });

    const response = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "funny fantasy" }
    });
    const body = response.json<SearchResponse>();

    expect(response.statusCode).toBe(200);
    expect(body.results.some((item) => item.title === "The Princess Bride" && item.availabilityGroup === "not_in_plex_requestable")).toBe(true);
    expect(body.results.some((item) => item.title === "Stardust" && item.availabilityGroup === "available_in_plex")).toBe(true);
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
    expect(liked).toBeTruthy();
    expect(disliked).toBeTruthy();

    const refined = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: {
        query: "more like this",
        resultLimit: 5,
        feedbackContext: {
          moreLikeItemIds: [liked!.id],
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
      engineVersion: "hybrid-v2",
      sessions: { total: expect.any(Number) },
      features: { mediaFeatureCount: expect.any(Number) }
    });
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

  it("proxies posters without leaking configured tokens", async () => {
    const app = makeApp();
    const search = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query: "Stardust" }
    });
    const stardust = search.json<SearchResponse>().results.find((item) => item.title === "Stardust");
    expect(stardust).toBeTruthy();

    const poster = await app.inject({ method: "GET", url: `/api/items/${encodeURIComponent(stardust!.id)}/poster` });

    expect(poster.statusCode).toBe(200);
    expect(poster.headers["content-type"]).toContain("image/svg+xml");
    expect(poster.body).not.toContain("test-plex-token-secret");
    expect(poster.body).not.toContain("test-seerr-key-secret");
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
      expect(first.headers["content-type"]).toContain("image/jpeg");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0] ?? "")).not.toContain("test-plex-token-secret");
      expect(second.body).toBe(first.body);
    } finally {
      vi.unstubAllGlobals();
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
    expect(run.statusCode).toBe(200);

    const status = await app.inject({ method: "GET", url: "/api/admin/sync/status" });
    const body = status.json<SyncStatus>();

    expect(status.statusCode).toBe(200);
    expect(body.history?.library[0]).toMatchObject({ source: "fixture", status: "ok", itemCount: expect.any(Number) });
    expect(body.history?.seerr[0]).toMatchObject({ source: "fixture", status: "ok", itemCount: expect.any(Number) });
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
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({ ok: true, plexUnavailable: 1 });

    const item = await app.inject({ method: "GET", url: `/api/items/${encodeURIComponent(staleId)}` });
    expect(item.statusCode).toBe(200);
    expect(item.json<ItemDetail>().plex?.available).toBe(false);
    expect(item.json<ItemDetail>().availabilityGroup).toBe("unavailable");
  });

  it("tracks applied schema migrations", () => {
    const db = createDatabase(":memory:");
    const migrations = db.prepare("SELECT id FROM schema_migrations ORDER BY id").all() as { id: string }[];
    const userVersion = db.prepare("PRAGMA user_version").get() as { user_version: number };

    expect(migrations.map((migration) => migration.id)).toEqual(["001_initial_schema", "002_request_audit"]);
    expect(userVersion.user_version).toBe(2);
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

    const legacyAllowed = await app.inject({
      method: "GET",
      url: "/api/admin/settings",
      headers: { "X-Feelerr-Admin-Token": "test-admin-token-secret" }
    });
    expect(legacyAllowed.statusCode).toBe(200);
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
        ai: { provider: "openai", openaiApiKey: "new-openai-key-secret", openaiModel: "gpt-5.5", openaiEmbeddingModel: "text-embedding-3-large" },
        sync: { intervalMinutes: 15, syncSeerr: true }
      }
    });

    expect(response.statusCode).toBe(200);
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

  it("requires Plex token when fixture mode is disabled", async () => {
    const app = makeApp(
      testConfig({
        plex: {
          webBaseUrl: "https://app.plex.tv/desktop"
        }
      })
    );

    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      payload: {
        fixtureMode: false,
        plex: { baseUrl: "http://plex.internal:32400" }
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("Plex token");
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
