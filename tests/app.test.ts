import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";
import type { RequestPreview, SearchResponse } from "../src/shared/types";

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
      openaiModel: "gpt-5-mini"
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

describe("Feelerr API", () => {
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

  it("requires admin auth for protected admin routes", async () => {
    const app = makeApp(testConfig({ requireAdminToken: true }));

    const denied = await app.inject({ method: "GET", url: "/api/admin/settings" });
    expect(denied.statusCode).toBe(401);
    expect(denied.body).not.toContain("test-admin-token-secret");

    const allowed = await app.inject({
      method: "GET",
      url: "/api/admin/settings",
      headers: { "X-Feelerr-Admin-Token": "test-admin-token-secret" }
    });

    expect(allowed.statusCode).toBe(200);
    expect(allowed.body).not.toContain("test-admin-token-secret");
    expect(allowed.body).not.toContain("test-plex-token-secret");
  });

  it("persists admin settings server-side without returning secrets", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "feelerr-admin-"));
    const configPath = join(dataDir, "config.json");
    const app = makeApp(testConfig({ dataDir, configPath, requireAdminToken: true }));

    const response = await app.inject({
      method: "PUT",
      url: "/api/admin/settings",
      headers: { "X-Feelerr-Admin-Token": "test-admin-token-secret" },
      payload: {
        fixtureMode: false,
        plex: { baseUrl: "http://plex.internal:32400", token: "new-plex-token-secret" },
        seerr: { baseUrl: "http://seerr.internal:5055", apiKey: "new-seerr-key-secret" },
        ai: { provider: "openai", openaiApiKey: "new-openai-key-secret", openaiModel: "gpt-5-mini" },
        sync: { intervalMinutes: 15, syncSeerr: true }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("new-plex-token-secret");
    expect(response.body).not.toContain("new-seerr-key-secret");
    expect(response.body).not.toContain("new-openai-key-secret");
    expect(readFileSync(configPath, "utf8")).toContain("new-plex-token-secret");

    const support = await app.inject({
      method: "GET",
      url: "/api/admin/support-bundle",
      headers: { "X-Feelerr-Admin-Token": "test-admin-token-secret" }
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
