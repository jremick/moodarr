import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app";
import { loadConfig, type AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import type { ItemDetail, LibraryStats, QueryReviewQueueResponse, RequestPreview, SearchResponse, SyncStatus } from "../src/shared/types";

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
    reviewQueue: {
      retentionDays: 90,
      maxQueries: 500
    },
    knownSecrets: ["test-plex-token-secret", "test-seerr-key-secret", "test-openai-key-secret", "test-admin-token-secret"]
  };
  return { ...base, ...overrides };
}

function makeApp(config = testConfig()) {
  return createApp({ config, db: createDatabase(":memory:") });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Moodarr API", () => {
  it("loads Moodarr environment settings", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "moodarr-env-"));
    const config = loadConfig({
      MOODARR_DATA_DIR: dataDir,
      MOODARR_CONFIG_PATH: join(dataDir, "config.json"),
      MOODARR_DB_PATH: join(dataDir, "moodarr.sqlite"),
      MOODARR_API_PORT: "4410",
      MOODARR_ADMIN_TOKEN: "admin-token-secret",
      MOODARR_REQUIRE_ADMIN_TOKEN: "true",
      MOODARR_SYNC_INTERVAL_MINUTES: "120",
      MOODARR_REVIEW_RETENTION_DAYS: "30",
      MOODARR_REVIEW_MAX_QUERIES: "25"
    });

    expect(config.dataDir).toBe(dataDir);
    expect(config.dbPath).toBe(join(dataDir, "moodarr.sqlite"));
    expect(config.apiPort).toBe(4410);
    expect(config.adminToken).toBe("admin-token-secret");
    expect(config.requireAdminToken).toBe(true);
    expect(config.sync.intervalMinutes).toBe(120);
    expect(config.reviewQueue).toEqual({ retentionDays: 30, maxQueries: 25 });
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
    const app = makeApp();
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
    const app = makeApp(testConfig({ reviewQueue: { retentionDays: 90, maxQueries: 2 } }));

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

  it("prunes saved query reviews by configured retention period", async () => {
    const db = createDatabase(":memory:");
    const app = createApp({ config: testConfig({ reviewQueue: { retentionDays: 1, maxQueries: 500 } }), db });

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
      engineVersion: "moodrank-v3",
      sessions: { total: expect.any(Number) },
      features: { mediaFeatureCount: expect.any(Number) }
    });
  });

  it("uses newly saved OpenAI settings without restarting the server", async () => {
    const app = makeApp(
      testConfig({
        requireAdminToken: true,
        ai: {
          provider: "none",
          openaiModel: "gpt-5.5",
          openaiEmbeddingModel: "text-embedding-3-large"
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
          data: inputs.map((_, index) => ({ index, embedding: [1, 0] }))
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
          openaiEmbeddingModel: "text-embedding-3-large"
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
    expect(preview.body).toContain("missing a Seerr media ID");
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

  it("warms provider embeddings through the protected admin endpoint", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
      return jsonResponse({
        data: (body.input ?? []).map((_, index) => ({ index, embedding: [1, 0] }))
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
          openaiEmbeddingModel: "text-embedding-3-small"
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
      configured: true,
      attempted: 2,
      embedded: 2,
      hasMore: true
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.openai.com/v1/embeddings",
      expect.objectContaining({
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

    expect(migrations.map((migration) => migration.id)).toEqual(["001_initial_schema", "002_request_audit", "003_media_source", "004_mood_feature_scores", "005_query_review_queue"]);
    expect(userVersion.user_version).toBe(5);
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
        ai: { provider: "openai", openaiApiKey: "new-openai-key-secret", openaiModel: "gpt-5.5", openaiEmbeddingModel: "text-embedding-3-large" },
        sync: { intervalMinutes: 15, syncSeerr: true },
        reviewQueue: { retentionDays: 45, maxQueries: 250 }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      reviewQueue: { retentionDays: 45, maxQueries: 250 }
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
        openaiEmbeddingModel: "text-embedding-3-large"
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
        ai: { provider: "openai", openaiModel: "gpt-5.5-env", openaiEmbeddingModel: "text-embedding-3-large" },
        sync: { intervalMinutes: 60, syncSeerr: true }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      plex: { tokenConfigured: true },
      seerr: { apiKeyConfigured: true },
      ai: { provider: "openai", openaiApiKeyConfigured: true, openaiModel: "gpt-5.5-env" }
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
