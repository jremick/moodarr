import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("TMDB poster boundary", () => {
  it.each(["none", "configurable"] as const)("never fetches a TMDB CDN poster when source policy is %s", async (tmdbContentPolicy) => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const itemId = repository.upsert({
      mediaType: "movie",
      title: "No Remote Poster",
      year: 2026,
      posterPath: "tmdb://w500/remote-poster.jpg",
      seerr: { tmdbId: 202603, status: "unknown", requestable: true }
    });
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } }));
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp({ config: liveTestConfig(tmdbContentPolicy), db });

    try {
      const result = await app.inject({ method: "GET", url: `/api/items/${encodeURIComponent(itemId)}/poster` });

      expect(result.statusCode).toBe(200);
      expect(result.headers["cache-control"]).toBe("private, no-store");
      expect(result.headers["content-type"]).toContain("image/svg+xml");
      expect(result.body).toContain("No Remote Poster");
      expect(fetchMock).not.toHaveBeenCalled();
      expect(repository.posterCacheDiagnostics().rows).toBe(0);
    } finally {
      await app.close();
      db.close();
    }
  });

  it("does not serve a legacy cached TMDB poster", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const itemId = repository.upsert({
      mediaType: "movie",
      title: "Legacy Cached Poster",
      posterPath: "tmdb://w500/legacy.jpg",
      seerr: { tmdbId: 202604, status: "unknown", requestable: true }
    });
    repository.savePosterCache(itemId, "legacy-source-key", "image/jpeg", Buffer.from([1, 2, 3]));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const app = createApp({ config: liveTestConfig("none"), db });

    try {
      const result = await app.inject({ method: "GET", url: `/api/items/${encodeURIComponent(itemId)}/poster` });

      expect(result.headers["content-type"]).toContain("image/svg+xml");
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await app.close();
      db.close();
    }
  });
});

function liveTestConfig(tmdbContentPolicy: "none" | "configurable"): AppConfig {
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
      apiKey: "test-seerr-key",
      tmdbContentPolicy
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
