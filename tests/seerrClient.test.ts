import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/config";
import { SeerrClient } from "../src/server/integrations/seerrClient";

const config: AppConfig = {
  fixtureMode: false,
  dataDir: ".data-test",
  configPath: ".data-test/config.json",
  dbPath: ":memory:",
  apiPort: 0,
  apiHost: "127.0.0.1",
  webOrigin: "http://127.0.0.1:5173",
  serveClient: false,
  requireAdminToken: false,
  adminAutoSession: false,
  plexAuth: {
    enabled: false,
    allowNewUsers: true,
    clientIdentifier: "moodarr-test",
    productName: "Moodarr Test"
  },
  plex: {
    webBaseUrl: "https://app.plex.tv/desktop"
  },
  seerr: {
    baseUrl: "http://seerr.example",
    apiKey: "test-seerr-key"
  },
  ai: {
    provider: "none",
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
  knownSecrets: ["test-seerr-key"]
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SeerrClient", () => {
  it("enriches search results with movie detail runtime and genres", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/v1/search")) {
          return jsonResponse({
            results: [
              {
                id: 2493,
                mediaType: "movie",
                title: "The Princess Bride",
                releaseDate: "1987-09-25",
                overview: "A witty fantasy romance adventure.",
                genreIds: [12, 35]
              }
            ]
          });
        }
        if (url.endsWith("/api/v1/movie/2493")) {
          return jsonResponse({
            runtime: 98,
            genres: [{ name: "Adventure" }, { name: "Comedy" }]
          });
        }
        return jsonResponse({}, 404);
      })
    );

    const results = await new SeerrClient(config).search("Princess Bride");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: "The Princess Bride",
      runtimeMinutes: 98,
      genres: ["Adventure", "Comedy"]
    });
  });

  it("keeps the base search result when detail enrichment fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/v1/search")) {
          return jsonResponse({
            results: [
              {
                id: 2493,
                mediaType: "movie",
                title: "The Princess Bride",
                releaseDate: "1987-09-25",
                overview: "A witty fantasy romance adventure."
              }
            ]
          });
        }
        return jsonResponse({ message: "detail unavailable" }, 500);
      })
    );

    const results = await new SeerrClient(config).search("Princess Bride");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: "The Princess Bride",
      summary: "A witty fantasy romance adventure."
    });
    expect(results[0].runtimeMinutes).toBeUndefined();
    expect(results[0].genres).toBeUndefined();
  });

  it("propagates cancellation during detail enrichment", async () => {
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/v1/search")) {
          return jsonResponse({ results: [{ id: 2493, mediaType: "movie", title: "The Princess Bride" }] });
        }
        controller.abort(new Error("sync cancelled"));
        throw new DOMException("The operation was aborted.", "AbortError");
      })
    );

    await expect(new SeerrClient(config).search("Princess Bride", controller.signal)).rejects.toThrow("sync cancelled");
  });

  it("keeps search genre ids when detail enrichment fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/v1/search")) {
          return jsonResponse({
            results: [
              {
                id: 16,
                mediaType: "movie",
                title: "Animated Fantasy",
                releaseDate: "2024-01-01",
                overview: "An animated fantasy comedy.",
                genreIds: [16, 35, 14]
              }
            ]
          });
        }
        return jsonResponse({ message: "detail unavailable" }, 500);
      })
    );

    const results = await new SeerrClient(config).search("Animated Fantasy");

    expect(results).toHaveLength(1);
    expect(results[0].genres).toEqual(["Animation", "Comedy", "Fantasy"]);
  });

  it("adds outbound timeouts to Seerr connection tests", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeTruthy();
      return jsonResponse({ ok: true });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new SeerrClient(config).testConnection({ baseUrl: config.seerr.baseUrl, apiKey: config.seerr.apiKey });

    expect(result.ok).toBe(true);
  });

  it("caps Seerr search fanout before detail enrichment", async () => {
    let detailCalls = 0;
    let activeDetailCalls = 0;
    let maxConcurrentDetailCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/v1/search")) {
          return jsonResponse({
            results: Array.from({ length: 75 }, (_, index) => ({ id: index + 1, mediaType: "movie", title: `Movie ${index + 1}` }))
          });
        }
        if (url.includes("/api/v1/movie/")) {
          detailCalls += 1;
          activeDetailCalls += 1;
          maxConcurrentDetailCalls = Math.max(maxConcurrentDetailCalls, activeDetailCalls);
          await new Promise((resolve) => setTimeout(resolve, 1));
          activeDetailCalls -= 1;
          return jsonResponse({ runtime: 90 });
        }
        return jsonResponse({}, 404);
      })
    );

    const results = await new SeerrClient(config).search("movie");

    expect(results).toHaveLength(24);
    expect(detailCalls).toBe(12);
    expect(maxConcurrentDetailCalls).toBeLessThanOrEqual(6);
  });

  it("enriches synced request records so placeholder titles are not used as catalog recommendations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/v1/request?take=100&skip=0")) {
          return jsonResponse({
            pageInfo: { page: 1, pageSize: 100, results: 1, pages: 1 },
            results: [
              {
                id: 100,
                status: 2,
                media: {
                  id: 500,
                  tmdbId: 2493,
                  mediaType: "movie",
                  status: 1
                }
              }
            ]
          });
        }
        if (url.endsWith("/api/v1/movie/2493")) {
          return jsonResponse({
            title: "The Princess Bride",
            releaseDate: "1987-09-25",
            overview: "A witty fantasy romance adventure.",
            runtime: 98,
            posterPath: "/princess.jpg",
            genres: [{ name: "Adventure" }, { name: "Comedy" }],
            mediaInfo: {
              id: 500,
              status: 1,
              requests: [{ status: 2 }]
            }
          });
        }
        return jsonResponse({}, 404);
      })
    );

    const results = await new SeerrClient(config).syncRequests();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: "The Princess Bride",
      year: 1987,
      summary: "A witty fantasy romance adventure.",
      runtimeMinutes: 98,
      posterPath: "tmdb://w500/princess.jpg",
      genres: ["Adventure", "Comedy"]
    });
    expect(results[0].title).not.toBe("Movie 2493");
  });

  it("syncs every Seerr request page instead of only the default first page", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/api/v1/request?take=100&skip=0")) {
          return jsonResponse({
            pageInfo: { page: 1, pageSize: 2, results: 3, pages: 2 },
            results: [
              { id: 100, status: 2, media: { id: 500, tmdbId: 2493, mediaType: "movie", status: 1 } },
              { id: 101, status: 2, media: { id: 501, tmdbId: 2270, mediaType: "movie", status: 1 } }
            ]
          });
        }
        if (url.endsWith("/api/v1/request?take=100&skip=2")) {
          return jsonResponse({
            pageInfo: { page: 2, pageSize: 2, results: 3, pages: 2 },
            results: [{ id: 102, status: 2, media: { id: 502, tmdbId: 57243, mediaType: "tv", status: 1 } }]
          });
        }
        if (url.endsWith("/api/v1/movie/2493")) {
          return jsonResponse({ title: "The Princess Bride" });
        }
        if (url.endsWith("/api/v1/movie/2270")) {
          return jsonResponse({ title: "Stardust" });
        }
        if (url.endsWith("/api/v1/tv/57243")) {
          return jsonResponse({ name: "Doctor Who" });
        }
        return jsonResponse({}, 404);
      })
    );

    const results = await new SeerrClient(config).syncRequests();

    expect(results.map((result) => result.title)).toEqual(["The Princess Bride", "Stardust", "Doctor Who"]);
  });

  it("syncs every Seerr request page reported by upstream pagination", async () => {
    let requestPages = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/v1/request?")) {
          requestPages += 1;
          const skip = Number(new URL(url).searchParams.get("skip") ?? 0);
          return jsonResponse({
            results: Array.from({ length: 100 }, (_, index) => ({
              id: skip + index,
              status: 2,
              media: { id: skip + index, tmdbId: skip + index + 1, mediaType: "movie", status: 1 }
            })),
            pageInfo: { results: 2_100 }
          });
        }
        if (url.includes("/api/v1/movie/")) {
          return jsonResponse({ title: "Large Sync Movie" });
        }
        return jsonResponse({}, 404);
      })
    );

    const results = await new SeerrClient(config).syncRequests();

    expect(results).toHaveLength(2_100);
    expect(requestPages).toBe(21);
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
