import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/config";
import { PlexClient } from "../src/server/integrations/plexClient";
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
  plex: {
    baseUrl: "http://plex.example:32400",
    token: "test-plex-token-secret",
    webBaseUrl: "https://app.plex.tv/desktop"
  },
  seerr: {
    baseUrl: "http://seerr.example",
    apiKey: "test-seerr-key"
  },
  ai: {
    provider: "none",
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
  knownSecrets: ["test-plex-token-secret", "test-seerr-key"]
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("external item links", () => {
  it("builds Plex links with the server identifier and library metadata key", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/identity")) {
          return jsonResponse({ MediaContainer: { machineIdentifier: "server-abc" } });
        }
        if (url.endsWith("/library/sections")) {
          return jsonResponse({ MediaContainer: { Directory: [{ key: "1", title: "Movies", type: "movie" }] } });
        }
        if (url.endsWith("/library/sections/1/all")) {
          return jsonResponse({
            MediaContainer: {
              Metadata: [{ ratingKey: "123", key: "/library/metadata/123", title: "Stardust", year: 2007, Guid: [{ id: "tmdb://2270" }] }]
            }
          });
        }
        return jsonResponse({}, 404);
      })
    );

    const records = await new PlexClient(config).syncLibrary();

    expect(records[0]?.plex?.url).toBe("https://app.plex.tv/desktop/#!/server/server-abc/details?key=%2Flibrary%2Fmetadata%2F123");
  });

  it("builds Seerr links from the TMDB id, including search records that expose it as mediaId", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/v1/search")) {
          return jsonResponse({
            results: [{ mediaId: 2493, mediaType: "movie", title: "The Princess Bride", releaseDate: "1987-09-25" }]
          });
        }
        if (url.endsWith("/api/v1/movie/2493")) {
          return jsonResponse({ runtime: 98, genres: [{ name: "Adventure" }] });
        }
        return jsonResponse({}, 404);
      })
    );

    const records = await new SeerrClient(config).search("Princess Bride");

    expect(records[0]?.seerr?.url).toBe("http://seerr.example/movie/2493");
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
