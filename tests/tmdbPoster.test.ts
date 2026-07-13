import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { maxPosterBytes } from "../src/server/security/http";
import { fetchTmdbPoster, tmdbPosterUrl } from "../src/server/posters/tmdbPoster";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TMDB poster fetching", () => {
  it("accepts only the supported size and a single safe raster filename", () => {
    expect(tmdbPosterUrl("tmdb://w500/AbC_123-safe.jpg")).toBe("https://image.tmdb.org/t/p/w500/AbC_123-safe.jpg");

    for (const path of [
      "https://image.tmdb.org/t/p/w500/poster.jpg",
      "tmdb://evil.example/poster.jpg",
      "tmdb://w780/poster.jpg",
      "tmdb://original/poster.jpg",
      "tmdb://w500//poster.jpg",
      "tmdb://w500/subdir/poster.jpg",
      "tmdb://w500/../poster.jpg",
      "tmdb://w500/%2e%2e%2fposter.jpg",
      "tmdb://w500/poster.jpg?destination=http://169.254.169.254",
      "tmdb://w500/poster.jpg#fragment",
      "tmdb://w500/poster.svg",
      " tmdb://w500/poster.jpg"
    ]) {
      expect(() => tmdbPosterUrl(path), path).toThrow(/supported format/i);
    }
  });

  it("constructs the fixed CDN URL and disables redirects", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
    });

    const image = await fetchTmdbPoster("tmdb://w500/poster.jpg", fetchMock);

    expect(image).toEqual({ contentType: "image/jpeg", body: Buffer.from([1, 2, 3]) });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://image.tmdb.org/t/p/w500/poster.jpg");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      headers: { "User-Agent": "Moodarr (+https://github.com/jremick/moodarr)" },
      redirect: "error"
    });
  });

  it("rejects an upstream redirect without following it", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      void _input;
      void _init;
      return new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data" } });
    });

    await expect(fetchTmdbPoster("tmdb://w500/poster.jpg", fetchMock)).rejects.toThrow(/HTTP 302/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });

  it("keeps an approved TMDB poster in the server cache without permitting browser storage", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const itemId = repository.upsert({
      mediaType: "movie",
      title: "Approved TMDB Poster",
      year: 2026,
      posterPath: "tmdb://w500/approved-poster.jpg",
      seerr: { tmdbId: 202603, status: "unknown", requestable: true }
    });
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp({ config: liveTestConfig(), db });

    try {
      const first = await app.inject({ method: "GET", url: `/api/items/${encodeURIComponent(itemId)}/poster` });
      const second = await app.inject({ method: "GET", url: `/api/items/${encodeURIComponent(itemId)}/poster` });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(first.headers["cache-control"]).toBe("private, no-store");
      expect(second.headers["cache-control"]).toBe("private, no-store");
      expect(first.headers["content-type"]).toContain("image/jpeg");
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(repository.posterCacheDiagnostics().rows).toBe(1);
    } finally {
      await app.close();
      db.close();
    }
  });

  it.each([
    {
      name: "an invalid path",
      posterPath: "tmdb://w500/../internal.jpg",
      response: () => new Response(new Uint8Array([1]), { headers: { "content-type": "image/jpeg" } }),
      expectedFetches: 0
    },
    {
      name: "a cross-origin redirect",
      posterPath: "tmdb://w500/poster.jpg",
      response: () => new Response(null, { status: 302, headers: { Location: "http://169.254.169.254/latest/meta-data" } }),
      expectedFetches: 1
    },
    {
      name: "an unsafe content type",
      posterPath: "tmdb://w500/poster.jpg",
      response: () => new Response("<svg/>", { headers: { "content-type": "image/svg+xml" } }),
      expectedFetches: 1
    },
    {
      name: "an oversized response",
      posterPath: "tmdb://w500/poster.jpg",
      response: () =>
        new Response(new Uint8Array([1]), {
          headers: { "content-type": "image/jpeg", "content-length": String(maxPosterBytes + 1) }
        }),
      expectedFetches: 1
    }
  ])("serves a safe fallback and does not cache $name", async ({ posterPath, response, expectedFetches }) => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const itemId = repository.upsert({
      mediaType: "movie",
      title: "Rejected TMDB Poster",
      year: 2026,
      posterPath,
      seerr: { tmdbId: 202602, status: "unknown", requestable: true }
    });
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp({ config: liveTestConfig(), db });

    try {
      const result = await app.inject({ method: "GET", url: `/api/items/${encodeURIComponent(itemId)}/poster` });

      expect(result.statusCode).toBe(200);
      expect(result.headers["cache-control"]).toBe("private, no-store");
      expect(result.headers["content-type"]).toContain("image/svg+xml");
      expect(result.body).toContain("Rejected TMDB Poster");
      expect(fetchMock).toHaveBeenCalledTimes(expectedFetches);
      expect(repository.posterCacheDiagnostics().rows).toBe(0);
    } finally {
      await app.close();
      db.close();
    }
  });
});

function liveTestConfig(): AppConfig {
  return {
    fixtureMode: false,
    dataDir: ".data-test",
    configPath: ".data-test/config.json",
    dbPath: ":memory:",
    apiPort: 0,
    apiHost: "127.0.0.1",
    webOrigin: "http://127.0.0.1:5173",
    serveClient: false,
    adminToken: "test-admin-token",
    requireAdminToken: false,
    adminAutoSession: false,
    plexAuth: {
      enabled: false,
      allowNewUsers: false,
      clientIdentifier: "moodarr-tmdb-poster-test",
      productName: "Moodarr Test"
    },
    plex: {
      baseUrl: "http://plex.example",
      token: "test-plex-token",
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
    knownSecrets: ["test-admin-token", "test-plex-token", "test-seerr-key"]
  };
}
