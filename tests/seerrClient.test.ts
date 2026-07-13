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
    apiKey: "test-seerr-key",
    tmdbContentPolicy: "configurable"
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
  it("returns no descriptive search content and makes no request when the TMDB content policy is none", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const strictConfig: AppConfig = { ...config, seerr: { ...config.seerr, tmdbContentPolicy: "none" } };

    await expect(new SeerrClient(strictConfig).search("unique descriptive sentinel")).resolves.toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("syncs only operational request state under the strict policy without detail calls", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/request?take=100&skip=0")) {
        return jsonResponse({
          pageInfo: { results: 1 },
          results: [
            {
              id: 100,
              status: 2,
              media: { id: 500, tmdbId: 2493, tvdbId: 789, imdbId: "tt0093779", mediaType: "movie", status: 1 }
            }
          ]
        });
      }
      return jsonResponse({ title: "forbidden-detail-sentinel" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const strictConfig: AppConfig = { ...config, seerr: { ...config.seerr, tmdbContentPolicy: "none" } };

    const results = await new SeerrClient(strictConfig).syncRequests();

    expect(results).toEqual([
      expect.objectContaining({
        source: "operational",
        mediaType: "movie",
        title: "Movie 2493",
        externalIds: { tmdb: 2493, tvdb: 789, imdb: "tt0093779" },
        seerr: expect.objectContaining({
          tmdbId: 2493,
          tvdbId: 789,
          imdbId: "tt0093779",
          seerrMediaId: 500,
          status: "unknown",
          requestStatus: "approved",
          requestable: false
        })
      })
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/v1/request?");
  });

  it("allowlists and bounds operational Seerr sync fields at runtime", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          pageInfo: { results: 1, apiKey: "upstream-page-secret" },
          results: [
            {
              id: "upstream-request-secret",
              status: "private@example.com upstream-request-secret",
              requestedBy: { email: "private@example.com", plexToken: "upstream-user-token-secret" },
              media: {
                id: "upstream-media-secret",
                tmdbId: 2493,
                tvdbId: "upstream-tvdb-secret",
                imdbId: "upstream-imdb-secret",
                mediaType: "movie",
                status: "upstream-media-status-secret",
                overview: "Untrusted upstream description"
              }
            }
          ]
        })
      )
    );
    const strictConfig: AppConfig = { ...config, seerr: { ...config.seerr, tmdbContentPolicy: "none" } };

    const results = await new SeerrClient(strictConfig).syncRequests();

    expect(results).toEqual([
      expect.objectContaining({
        source: "operational",
        title: "Movie 2493",
        externalIds: { tmdb: 2493, tvdb: undefined, imdb: undefined },
        seerr: expect.objectContaining({
          tmdbId: 2493,
          tvdbId: undefined,
          imdbId: undefined,
          seerrMediaId: undefined,
          status: "unknown",
          requestStatus: "unknown",
          requestable: false
        })
      })
    ]);
    expect(JSON.stringify(results)).not.toContain("Untrusted upstream");
    expect(JSON.stringify(results)).not.toContain("private@example.com");
    expect(JSON.stringify(results)).not.toContain("secret");
  });

  it("rejects malformed Seerr sync envelopes without reflecting upstream values", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ results: { apiKey: "upstream-envelope-secret" } })));

    await expect(new SeerrClient(config).syncRequests()).rejects.toThrow("Seerr request response did not contain a valid results array.");
  });

  it("replaces malformed JSON parser messages before they reach operational errors", async () => {
    const fetchMock = vi.fn(async () => new Response(`{"results":[{"apiKey":"${config.seerr.apiKey}"}`, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await caughtError(new SeerrClient(config).syncRequests());

    expect(error.message).toBe("Seerr returned malformed JSON.");
    expect(error.message).not.toContain(config.seerr.apiKey);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed supported request rows instead of omitting known request state", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        pageInfo: { results: 2 },
        results: [
          { id: 100, status: 2, media: { tmdbId: 2493, mediaType: "movie", status: 1 } },
          { id: 101, status: "upstream-secret", media: { tmdbId: "upstream-secret", mediaType: "tv" } }
        ]
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const strictConfig: AppConfig = { ...config, seerr: { ...config.seerr, tmdbContentPolicy: "none" } };

    const error = await caughtError(new SeerrClient(strictConfig).syncRequests());

    expect(error.message).toBe("Seerr request response contained a malformed supported media row.");
    expect(error.message).not.toContain("upstream-secret");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a non-object row", "upstream-secret"],
    ["missing media", { id: 101, upstreamSecret: "upstream-secret" }],
    ["missing media type", { id: 101, media: { tmdbId: 2493, upstreamSecret: "upstream-secret" } }],
    ["a structurally invalid media type", { id: 101, media: { tmdbId: 2493, mediaType: 42, upstreamSecret: "upstream-secret" } }]
  ])("rejects %s instead of treating it as an explicitly unsupported media row", async (_label, malformedRow) => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse([malformedRow])));

    const error = await caughtError(new SeerrClient(config).syncRequests());

    expect(error.message).toBe("Seerr request response contained a malformed supported media row.");
    expect(error.message).not.toContain("upstream-secret");
  });

  it("skips explicitly unsupported operational rows without retaining their upstream fields", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          pageInfo: { results: 2 },
          results: [
            { status: "upstream-secret", media: { tmdbId: 2494, mediaType: "person" } },
            { status: 2, media: { tmdbId: 2493, mediaType: "movie", status: 1 } }
          ]
        })
      )
    );
    const strictConfig: AppConfig = { ...config, seerr: { ...config.seerr, tmdbContentPolicy: "none" } };

    const results = await new SeerrClient(strictConfig).syncRequests();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ title: "Movie 2493", seerr: { tmdbId: 2493, requestStatus: "approved", requestable: false } });
    expect(JSON.stringify(results)).not.toContain("upstream-secret");
  });

  it.each([
    ["active row first", [2, 3], "approved"],
    ["declined row first", [3, 2], "approved"],
    ["uncertain row first", ["future-upstream-status", 3], "unknown"]
  ])("conservatively consolidates duplicate media requests when the %s", async (_label, requestStatuses, expectedStatus) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          pageInfo: { results: 2 },
          results: requestStatuses.map((status, index) => ({
            id: 100 + index,
            status,
            media: { id: 500, tmdbId: 2493, mediaType: "movie", status: 1 }
          }))
        })
      )
    );
    const strictConfig: AppConfig = { ...config, seerr: { ...config.seerr, tmdbContentPolicy: "none" } };

    const results = await new SeerrClient(strictConfig).syncRequests();

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      title: "Movie 2493",
      seerr: { seerrMediaId: 500, requestStatus: expectedStatus, requestable: false }
    });
  });

  it("rejects oversized request pages and totals before returning sync records", async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({
      id: index + 1,
      status: 2,
      media: { id: index + 1, tmdbId: index + 1, mediaType: "movie", status: 1 }
    }));
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ pageInfo: { results: 101 }, results: rows })));
    await expect(new SeerrClient(config).syncRequests()).rejects.toThrow("Seerr request response exceeded the safe page size.");

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ pageInfo: { results: 20_001 }, results: [] })));
    await expect(new SeerrClient(config).syncRequests()).rejects.toThrow("Seerr request response contained invalid pagination metadata.");
  });

  it("rejects a drifting Seerr pagination total", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const skip = Number(new URL(String(input)).searchParams.get("skip") ?? 0);
      if (skip === 0) {
        return jsonResponse({
          pageInfo: { results: 101 },
          results: Array.from({ length: 100 }, (_, index) => ({
            id: index + 1,
            status: 2,
            media: { id: index + 1, tmdbId: index + 1, mediaType: "movie", status: 1 }
          }))
        });
      }
      return jsonResponse({ pageInfo: { results: 102 }, results: [{ id: 101, status: 2, media: { id: 101, tmdbId: 101, mediaType: "movie", status: 1 } }] });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new SeerrClient(config).syncRequests()).rejects.toThrow("Seerr request response changed its pagination total during sync.");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects repeated pages instead of accepting duplicate rows as the reported total", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      status: 2,
      media: { id: index + 1, tmdbId: index + 1, mediaType: "movie", status: 1 }
    }));
    const fetchMock = vi.fn(async () => jsonResponse({ pageInfo: { results: 200 }, results: firstPage }));
    vi.stubGlobal("fetch", fetchMock);
    const strictConfig: AppConfig = { ...config, seerr: { ...config.seerr, tmdbContentPolicy: "none" } };

    await expect(new SeerrClient(strictConfig).syncRequests()).rejects.toThrow("repeated or overlapped an earlier record");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

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

  it("allowlists operational fields and normalizes status before returning create results", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          id: 42,
          status: 2,
          media: { title: "Untrusted Seerr title", overview: "Untrusted Seerr summary" },
          requestedBy: { email: "private@example.com", plexToken: "upstream-user-token-secret" },
          apiKey: "upstream-api-key-secret"
        })
      )
    );

    const result = await new SeerrClient(config).createRequest({ mediaType: "movie", mediaId: 2493 });

    expect(result).toEqual({ id: 42, status: "approved" });
    expect(JSON.stringify(result)).not.toContain("Untrusted Seerr");
    expect(JSON.stringify(result)).not.toContain("private@example.com");
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("rejects an unconfirmed create result with an unsafe or missing request ID", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ id: "upstream-user-token-secret", status: "unexpected secret status" })));

    const unsafeId = new SeerrClient(config).createRequest({ mediaType: "movie", mediaId: 2493 });
    await expect(unsafeId).rejects.toThrow("Seerr did not return a confirmed request identifier.");

    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ status: "approved" })));
    const missingId = new SeerrClient(config).createRequest({ mediaType: "movie", mediaId: 2493 });
    await expect(missingId).rejects.toThrow("Seerr did not return a confirmed request identifier.");
  });

  it("caps Seerr create and request-page response bodies", async () => {
    const createFetch = vi.fn(async () => jsonResponse({ id: 42, status: 2, padding: "x".repeat(70 * 1024) }));
    vi.stubGlobal("fetch", createFetch);
    await expect(new SeerrClient(config).createRequest({ mediaType: "movie", mediaId: 2493 })).rejects.toThrow("Response is larger than the 65536 byte limit.");
    expect(createFetch).toHaveBeenCalledTimes(1);

    const pageFetch = vi.fn(async () => jsonResponse({ pageInfo: { results: 0 }, results: [], padding: "x".repeat(2 * 1024 * 1024) }));
    vi.stubGlobal("fetch", pageFetch);
    await expect(new SeerrClient(config).syncRequests()).rejects.toThrow("Response is larger than the 2097152 byte limit.");
    expect(pageFetch).toHaveBeenCalledTimes(1);
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

async function caughtError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("Expected operation to reject.");
}
