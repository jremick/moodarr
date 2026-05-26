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
  plex: {
    webBaseUrl: "https://app.plex.tv/desktop"
  },
  seerr: {
    baseUrl: "http://seerr.example",
    apiKey: "test-seerr-key"
  },
  ai: {
    provider: "none",
    openaiModel: "gpt-5-mini"
  },
  sync: {
    intervalMinutes: 0,
    syncSeerr: true
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
});

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
