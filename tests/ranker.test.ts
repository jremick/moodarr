import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiRanker } from "../src/server/ai/ranker";
import type { AppConfig } from "../src/server/config";
import type { ItemSummary } from "../src/shared/types";

function testConfig(): AppConfig {
  return {
    fixtureMode: false,
    dataDir: ".data-test",
    configPath: ".data-test/config.json",
    dbPath: ":memory:",
    apiPort: 0,
    apiHost: "127.0.0.1",
    webOrigin: "http://127.0.0.1:5173",
    serveClient: false,
    requireAdminToken: false,
    plex: { webBaseUrl: "https://app.plex.tv/desktop" },
    seerr: {},
    ai: { provider: "openai", openaiApiKey: "test-openai-key-secret", openaiModel: "gpt-5-mini" },
    sync: { intervalMinutes: 0, syncSeerr: true },
    knownSecrets: ["test-openai-key-secret"]
  };
}

function candidate(overrides: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: "movie:1",
    mediaType: "movie",
    title: "Bewitched",
    year: 2005,
    runtimeMinutes: 102,
    summary: "A light witch comedy.",
    genres: ["Comedy", "Fantasy"],
    ratings: {},
    posterUrl: "/api/items/movie%3A1/poster",
    availabilityGroup: "available_in_plex",
    availabilityExplanation: "Available in Plex.",
    matchExplanation: "Deterministic match.",
    score: 10,
    plex: { available: true },
    ...overrides
  };
}

describe("OpenAiRanker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("requests minimal reasoning and parses structured rankings", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));

      expect(body.reasoning).toEqual({ effort: "minimal" });
      expect(body.max_output_tokens).toBe(2400);
      expect(JSON.stringify(body)).not.toContain("/api/items/movie%3A1/poster");
      expect(JSON.stringify(body)).not.toContain("test-openai-key-secret");
      expect(body.input[1].content[0].text).toContain("\"watchContext\":\"group\"");

      return new Response(
        JSON.stringify({
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    rankings: [{ id: "movie:1", score: 98, explanation: "A concise AI explanation." }]
                  })
                }
              ]
            }
          ]
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await new OpenAiRanker(testConfig()).rank({
      request: { query: "funny fantasy movie under two hours", watchContext: "group" },
      candidates: [candidate()]
    });

    expect(result.usedAi).toBe(true);
    expect(result.results[0]).toMatchObject({
      id: "movie:1",
      score: 98,
      matchExplanation: "A concise AI explanation."
    });
  });

  it("ignores unknown candidate ids and clamps model scores", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            output: [
              {
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      rankings: [
                        { id: "unknown", score: 999, explanation: "Ignore me." },
                        { id: "movie:1", score: 0.92, explanation: "Known candidate." },
                        { id: "movie:1", score: 10, explanation: "Duplicate candidate." }
                      ]
                    })
                  }
                ]
              }
            ]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    const result = await new OpenAiRanker(testConfig()).rank({
      request: { query: "funny fantasy" },
      candidates: [candidate()]
    });

    expect(result.usedAi).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ id: "movie:1", score: 92 });
  });

  it("falls back to deterministic candidates on provider failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const candidates = [candidate()];

    const result = await new OpenAiRanker(testConfig()).rank({
      request: { query: "funny fantasy" },
      candidates
    });

    expect(result).toEqual({ usedAi: false, results: candidates });
  });
});
