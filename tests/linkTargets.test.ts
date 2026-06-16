import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { PlexClient } from "../src/server/integrations/plexClient";
import { SeerrClient } from "../src/server/integrations/seerrClient";

const config = {
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
    openaiEmbeddingModel: "text-embedding-3-large",
    openaiReasoningEffort: "low"
  },
  sync: {
    intervalMinutes: 0,
    syncSeerr: true
  },
  knownSecrets: ["test-plex-token-secret", "test-seerr-key"]
} as AppConfig;

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

  it("adds outbound timeouts to Plex JSON requests", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeTruthy();
      const url = String(_input);
      if (url.endsWith("/identity")) return jsonResponse({ MediaContainer: { machineIdentifier: "server-abc" } });
      if (url.endsWith("/library/sections")) return jsonResponse({ MediaContainer: { Directory: [] } });
      return jsonResponse({}, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    await new PlexClient(config).syncLibrary();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("syncs every Plex record returned by upstream sections", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/identity")) return jsonResponse({ MediaContainer: { machineIdentifier: "server-abc" } });
        if (url.endsWith("/library/sections")) return jsonResponse({ MediaContainer: { Directory: [{ key: "1", title: "Movies", type: "movie" }] } });
        if (url.endsWith("/library/sections/1/all")) {
          return jsonResponse({
            MediaContainer: {
              Metadata: Array.from({ length: 5_010 }, (_, index) => ({
                ratingKey: String(index),
                key: `/library/metadata/${index}`,
                title: `Movie ${index}`
              }))
            }
          });
        }
        return jsonResponse({}, 404);
      })
    );

    const records = await new PlexClient(config).syncLibrary();

    expect(records).toHaveLength(5_010);
  });

  it("normalizes legacy stored Plex links when returning media items", () => {
    const repository = new MediaRepository(createDatabase(":memory:"));
    const id = repository.upsert({
      mediaType: "movie",
      title: "Legacy Plex Link",
      year: 2026,
      plex: {
        ratingKey: "75918",
        libraryTitle: "Movies",
        libraryType: "movie",
        url: "https://app.plex.tv/desktop#!/server/b8cd121ddbdb6264e65f00ce0377b27cea906ec6/details?key=library%2Fmetadata%2F75918",
        available: true
      }
    });

    expect(repository.findById(id)?.plex?.url).toBe(
      "https://app.plex.tv/desktop/#!/server/b8cd121ddbdb6264e65f00ce0377b27cea906ec6/details?key=%2Flibrary%2Fmetadata%2F75918"
    );
  });

  it("drops unsafe stored Plex links when returning media items", () => {
    const repository = new MediaRepository(createDatabase(":memory:"));
    const id = repository.upsert({
      mediaType: "movie",
      title: "Unsafe Plex Link",
      year: 2026,
      plex: {
        ratingKey: "unsafe-link",
        libraryTitle: "Movies",
        libraryType: "movie",
        url: "javascript:alert(1)",
        available: true
      }
    });

    expect(repository.findById(id)?.plex?.url).toBeUndefined();
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
