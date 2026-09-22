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
  plexAuth: {
    enabled: false,
    allowNewUsers: true,
    clientIdentifier: "moodarr-test",
    productName: "Moodarr Test"
  },
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
              totalSize: 1,
              Metadata: [{ ratingKey: "123", key: "/library/metadata/123", title: "Stardust", year: 2007, Guid: [{ id: "tmdb://2270" }] }]
            }
          });
        }
        return jsonResponse({}, 404);
      })
    );

    const { records } = await new PlexClient(config).syncLibrary();

    expect(records[0]?.plex?.url).toBe("https://app.plex.tv/desktop/#!/server/server-abc/details?key=%2Flibrary%2Fmetadata%2F123");
  });

  it("builds TV show Plex links to the show details page instead of the children endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/identity")) {
          return jsonResponse({ MediaContainer: { machineIdentifier: "server-abc" } });
        }
        if (url.endsWith("/library/sections")) {
          return jsonResponse({ MediaContainer: { Directory: [{ key: "2", title: "TV Shows", type: "show" }] } });
        }
        if (url.endsWith("/library/sections/2/all")) {
          return jsonResponse({
            MediaContainer: {
              totalSize: 1,
              Metadata: [{ ratingKey: "456", key: "/library/metadata/456/children", title: "Detectorists", year: 2014, Guid: [{ id: "tmdb://63162" }] }]
            }
          });
        }
        return jsonResponse({}, 404);
      })
    );

    const { records } = await new PlexClient(config).syncLibrary();

    expect(records[0]?.plex?.url).toBe("https://app.plex.tv/desktop/#!/server/server-abc/details?key=%2Flibrary%2Fmetadata%2F456");
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
    const items = Array.from({ length: 1_010 }, (_, index) => ({
      ratingKey: String(index),
      key: `/library/metadata/${index}`,
      title: `Movie ${index}`
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/identity")) return jsonResponse({ MediaContainer: { machineIdentifier: "server-abc" } });
        if (url.endsWith("/library/sections")) return jsonResponse({ MediaContainer: { Directory: [{ key: "1", title: "Movies", type: "movie" }] } });
        if (url.endsWith("/library/sections/1/all")) {
          const start = Number(new Headers(init?.headers).get("X-Plex-Container-Start") ?? 0);
          const page = items.slice(start, start + 500);
          return jsonResponse({
            MediaContainer: {
              Metadata: page,
              totalSize: items.length,
              offset: start,
              size: page.length
            }
          });
        }
        return jsonResponse({}, 404);
      })
    );

    const { records, complete } = await new PlexClient(config).syncLibrary();

    expect(complete).toBe(true);
    expect(records).toHaveLength(1_010);
  });

  it("continues safely when Plex clamps pages below the requested size", async () => {
    const items = Array.from({ length: 5 }, (_, index) => ({
      ratingKey: String(index),
      key: `/library/metadata/${index}`,
      title: `Clamped movie ${index}`
    }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/identity")) return jsonResponse({ MediaContainer: { machineIdentifier: "server-abc" } });
        if (url.endsWith("/library/sections")) return jsonResponse({ MediaContainer: { Directory: [{ key: "1", title: "Movies", type: "movie" }] } });
        if (url.endsWith("/library/sections/1/all")) {
          const start = Number(new Headers(init?.headers).get("X-Plex-Container-Start") ?? 0);
          const page = items.slice(start, start + 2);
          return jsonResponse({ MediaContainer: { Metadata: page, totalSize: items.length, offset: start, size: page.length } });
        }
        return jsonResponse({}, 404);
      })
    );

    const { records, complete } = await new PlexClient(config).syncLibrary();

    expect(complete).toBe(true);
    expect(records).toHaveLength(5);
  });

  it("rejects incomplete, oversized, and inconsistent Plex snapshots", async () => {
    const pageResponses = [
      { MediaContainer: { Metadata: [{ ratingKey: "only-one", title: "Only one" }], totalSize: 2, offset: 0, size: 1 } },
      { MediaContainer: { Metadata: [], totalSize: 2, offset: 1, size: 0 } },
      { MediaContainer: { Metadata: Array.from({ length: 501 }, (_, index) => ({ title: `Movie ${index}` })), totalSize: 501 } },
      { MediaContainer: { Metadata: Array.from({ length: 500 }, (_, index) => ({ ratingKey: `changed-${index}`, title: `Movie ${index}` })), totalSize: 501, offset: 0, size: 500 } },
      { MediaContainer: { Metadata: [{ ratingKey: "changed-last", title: "Last" }], totalSize: 502, offset: 500, size: 1 } }
    ];
    let pageCall = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/identity")) return jsonResponse({ MediaContainer: { machineIdentifier: "server-abc" } });
        if (url.endsWith("/library/sections")) return jsonResponse({ MediaContainer: { Directory: [{ key: "1", title: "Movies", type: "movie" }] } });
        if (url.endsWith("/library/sections/1/all")) return jsonResponse(pageResponses[pageCall++]!);
        return jsonResponse({}, 404);
      })
    );

    await expect(new PlexClient(config).syncLibrary()).rejects.toThrow(/ended library section/);
    pageCall = 2;
    await expect(new PlexClient(config).syncLibrary()).rejects.toThrow(/invalid page/);
    pageCall = 3;
    await expect(new PlexClient(config).syncLibrary()).rejects.toThrow(/changed the reported total/);
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
    expect(repository.findById(id)?.plex?.appUrl).toBe("plex://play/?metadataKey=%2Flibrary%2Fmetadata%2F75918&server=b8cd121ddbdb6264e65f00ce0377b27cea906ec6");
  });

  it("normalizes stored TV show Plex links that point at the children endpoint", () => {
    const repository = new MediaRepository(createDatabase(":memory:"));
    const id = repository.upsert({
      mediaType: "tv",
      title: "Legacy TV Plex Link",
      year: 2026,
      plex: {
        ratingKey: "8462",
        libraryTitle: "TV Shows",
        libraryType: "show",
        url: "https://app.plex.tv/desktop/#!/server/server-abc/details?key=%2Flibrary%2Fmetadata%2F8462%2Fchildren",
        available: true
      }
    });

    expect(repository.findById(id)?.plex?.url).toBe("https://app.plex.tv/desktop/#!/server/server-abc/details?key=%2Flibrary%2Fmetadata%2F8462");
    expect(repository.findById(id)?.plex?.appUrl).toBe("plex://play/?metadataKey=%2Flibrary%2Fmetadata%2F8462&server=server-abc");
  });

  it.each([
    ["non-HTTP scheme", "javascript:alert(1)"],
    ["missing metadata", "https://app.plex.tv/desktop/#!/server/server-abc/details"],
    ["empty metadata", "https://app.plex.tv/desktop/#!/server/server-abc/details?key="],
    ["unrelated metadata path", "https://app.plex.tv/desktop/#!/server/server-abc/details?key=not-metadata"],
    ["missing metadata identifier", "https://app.plex.tv/desktop/#!/server/server-abc/details?key=%2Flibrary%2Fmetadata%2F"],
    ["metadata traversal", "https://app.plex.tv/desktop/#!/server/server-abc/details?key=%2Flibrary%2Fmetadata%2F.."],
    ["metadata control character", "https://app.plex.tv/desktop/#!/server/server-abc/details?key=%2Flibrary%2Fmetadata%2F123%00"],
    ["malformed metadata encoding", "https://app.plex.tv/desktop/#!/server/server-abc/details?key=%2Flibrary%2Fmetadata%2F%ZZ"],
    ["wrong route", "https://app.plex.tv/desktop/#!/server/server-abc/home?key=%2Flibrary%2Fmetadata%2F123"],
    ["empty server identifier", "https://app.plex.tv/desktop/#!/server//details?key=%2Flibrary%2Fmetadata%2F123"],
    ["server traversal", "https://app.plex.tv/desktop/#!/server/../details?key=%2Flibrary%2Fmetadata%2F123"],
    ["encoded server traversal", "https://app.plex.tv/desktop/#!/server/%2e%2e/details?key=%2Flibrary%2Fmetadata%2F123"],
    ["malformed server encoding", "https://app.plex.tv/desktop/#!/server/%ZZ/details?key=%2Flibrary%2Fmetadata%2F123"],
    ["encoded server path separator", "https://app.plex.tv/desktop/#!/server/server%2Fabc/details?key=%2Flibrary%2Fmetadata%2F123"],
    ["encoded server backslash", "https://app.plex.tv/desktop/#!/server/server%5Cabc/details?key=%2Flibrary%2Fmetadata%2F123"],
    ["double-encoded server identifier", "https://app.plex.tv/desktop/#!/server/%2573erver-abc/details?key=%2Flibrary%2Fmetadata%2F123"],
    ["duplicate metadata", "https://app.plex.tv/desktop/#!/server/server-abc/details?key=%2Flibrary%2Fmetadata%2F123&key=%2Flibrary%2Fmetadata%2F456"],
    ["embedded credentials", "https://synthetic-user:synthetic-password@app.plex.tv/desktop/#!/server/server-abc/details?key=%2Flibrary%2Fmetadata%2F123"],
    ["query token", "https://app.plex.tv/desktop/?X-Plex-Token=synthetic-token#!/server/server-abc/details?key=%2Flibrary%2Fmetadata%2F123"],
    ["fragment token", "https://app.plex.tv/desktop/#!/server/server-abc/details?key=%2Flibrary%2Fmetadata%2F123&X-Plex-Token=synthetic-token"],
    ["encoded fragment token", "https://app.plex.tv/desktop/#!/server/server-abc/details?key=%2Flibrary%2Fmetadata%2F123&%58-Plex-Token=synthetic-token"],
    ["token inside metadata", "https://app.plex.tv/desktop/#!/server/server-abc/details?key=%2Flibrary%2Fmetadata%2F123%2Fchildren%3FX-Plex-Token%3Dsynthetic-token"]
  ])("drops stored Plex links with %s when returning media items", (_reason, url) => {
    const repository = new MediaRepository(createDatabase(":memory:"));
    const id = repository.upsert({
      mediaType: "movie",
      title: "Unsafe Plex Link",
      year: 2026,
      plex: {
        ratingKey: "unsafe-link",
        libraryTitle: "Movies",
        libraryType: "movie",
        url,
        available: true
      }
    });

    expect(repository.findById(id)?.plex).toMatchObject({ available: true, library: "Movies" });
    expect(repository.findById(id)?.plex?.url).toBeUndefined();
    expect(repository.findById(id)?.plex?.appUrl).toBeUndefined();
  });

  it.each([
    {
      url: "http://plex.example.test:32400/custom/web#!/server/server-abc/details?key=library%2Fmetadata%2F123%2Fchildren%2F",
      expectedUrl: "http://plex.example.test:32400/custom/web/#!/server/server-abc/details?key=%2Flibrary%2Fmetadata%2F123",
      expectedAppUrl: "plex://play/?metadataKey=%2Flibrary%2Fmetadata%2F123&server=server-abc"
    },
    {
      url: "https://plex.example.test/custom/web/#!/details?key=/library/metadata/fixture-123",
      expectedUrl: "https://plex.example.test/custom/web/#!/details?key=%2Flibrary%2Fmetadata%2Ffixture-123",
      expectedAppUrl: undefined
    },
    {
      url: "https://plex.example.test/custom/web/#!/server/%73erver-abc/details?key=%2Flibrary%2Fmetadata%2F123",
      expectedUrl: "https://plex.example.test/custom/web/#!/server/server-abc/details?key=%2Flibrary%2Fmetadata%2F123",
      expectedAppUrl: "plex://play/?metadataKey=%2Flibrary%2Fmetadata%2F123&server=server-abc"
    }
  ])("preserves supported title links on custom web bases: $url", ({ url, expectedUrl, expectedAppUrl }) => {
    const repository = new MediaRepository(createDatabase(":memory:"));
    const id = repository.upsert({
      mediaType: "movie",
      title: "Custom Plex Link",
      plex: { ratingKey: "custom-link", libraryTitle: "Movies", libraryType: "movie", url, available: true }
    });

    expect(repository.findById(id)?.plex?.url).toBe(expectedUrl);
    expect(repository.findById(id)?.plex?.appUrl).toBe(expectedAppUrl);
  });

  it("returns exact IMDb title links for valid stored IMDb IDs", () => {
    const repository = new MediaRepository(createDatabase(":memory:"));
    const id = repository.upsert({
      mediaType: "movie",
      title: "Stardust",
      year: 2007,
      externalIds: { imdb: "tt0486655" }
    });

    expect(repository.findById(id)?.imdbUrl).toBe("https://www.imdb.com/title/tt0486655/");
  });

  it("does not return IMDb links for invalid stored IMDb IDs", () => {
    const repository = new MediaRepository(createDatabase(":memory:"));
    const id = repository.upsert({
      mediaType: "movie",
      title: "Unsafe IMDb Link",
      year: 2026,
      externalIds: { imdb: "javascript:alert(1)" }
    });

    expect(repository.findById(id)?.imdbUrl).toBeUndefined();
  });

  it("builds Seerr links from the TMDB id, including search records that expose it as mediaId", async () => {
    const configurableTmdbContentConfig: AppConfig = {
      ...config,
      seerr: { ...config.seerr, tmdbContentPolicy: "configurable" }
    };
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

    const records = await new SeerrClient(configurableTmdbContentConfig).search("Princess Bride");

    expect(records[0]?.seerr?.url).toBe("http://seerr.example/movie/2493");
  });
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
