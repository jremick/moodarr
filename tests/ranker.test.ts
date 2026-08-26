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
    adminAutoSession: false,
    plexAuth: {
      enabled: false,
      allowNewUsers: true,
      clientIdentifier: "moodarr-test",
      productName: "Moodarr Test"
    },
    plex: { webBaseUrl: "https://app.plex.tv/desktop" },
    seerr: {},
    ai: {
      provider: "openai",
      openaiApiKey: "test-openai-key-secret",
      openaiModel: "gpt-5.5",
      openaiEmbeddingModel: "text-embedding-3-large",
      openaiReasoningEffort: "low"
    },
    sync: { intervalMinutes: 0, syncSeerr: true },
    search: { defaultResultLimit: 50 },
	    reviewQueue: { retentionDays: 90, maxQueries: 500, captureRawQueries: false },
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

  it("uses configured reasoning effort and parses structured rankings", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));

      expect(body.reasoning).toEqual({ effort: "low" });
      expect(body.max_output_tokens).toBe(2400);
      expect(JSON.stringify(body)).not.toContain("/api/items/movie%3A1/poster");
      expect(JSON.stringify(body)).not.toContain("test-openai-key-secret");
      const developerPrompt = body.input[0].content[0].text;
      expect(developerPrompt).toContain("helpful friend with good taste");
      expect(developerPrompt).toContain("conversational, casual, warm");
      expect(developerPrompt).toContain("common themes in preferred or liked examples");
      expect(developerPrompt).toContain("follow-up refinement options");
      const userInput = JSON.parse(body.input[1].content[0].text);
      expect(userInput.watchContext).toBe("group");
      expect(userInput.preferredExamples).toEqual([
        {
          id: "movie:2",
          title: "Practical Magic",
          mediaType: "movie",
          year: 1998,
          genres: ["Comedy", "Fantasy"]
        }
      ]);

      return new Response(
        JSON.stringify({
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    summary: "I’d steer this toward breezy fantasy comedy, with Bewitched as the easy first stop.",
                    refinementOptions: [{ label: "More magical", prompt: "Lean more magical and whimsical." }],
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
      candidates: [candidate()],
      feedbackItems: {
        preferredExamples: [
          {
            id: "movie:2",
            title: "Practical Magic",
            mediaType: "movie",
            year: 1998,
            genres: ["Comedy", "Fantasy"]
          }
        ],
        moreLike: [],
        lessLike: []
      }
    });

    expect(result.usedAi).toBe(true);
    expect(result.summary).toBe("I’d steer this toward breezy fantasy comedy, with Bewitched as the easy first stop.");
    expect(result.refinementOptions).toEqual([{ label: "More magical", prompt: "Lean more magical and whimsical." }]);
    expect(result.results[0]).toMatchObject({
      id: "movie:1",
      score: 10,
      matchExplanation: "A concise AI explanation."
    });
    expect(result.trace).toEqual({
      serializedCandidateCount: 1,
      rankedItems: [{ itemId: "movie:1", aiRank: 1, aiScore: 98 }]
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
                      summary: "Known candidate is the best match.",
                      refinementOptions: [],
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
    expect(result.summary).toBe("Known candidate is the best match.");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ id: "movie:1", score: 10 });
    expect(result.trace?.rankedItems).toEqual([{ itemId: "movie:1", aiRank: 1, aiScore: 92 }]);
  });

  it("preserves provider order, appends deterministic leftovers, and never mixes score domains", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              summary: "Provider order is authoritative.",
              refinementOptions: [],
              rankings: [
                { id: "movie:2", score: 25, explanation: "Second candidate first." },
                { id: "movie:1", score: 99, explanation: "First candidate second." }
              ]
            })
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );
    const candidates = [
      candidate({ id: "movie:1", title: "One", score: 95 }),
      candidate({ id: "movie:2", title: "Two", score: 5 }),
      candidate({ id: "movie:3", title: "Three", score: 100 })
    ];

    const result = await new OpenAiRanker(testConfig()).rank({ request: { query: "provider order" }, candidates });

    expect(result.results.map((item) => item.id)).toEqual(["movie:2", "movie:1", "movie:3"]);
    expect(result.results.map((item) => item.score)).toEqual([5, 95, 100]);
    expect(result.results.map((item) => item.matchExplanation)).toEqual([
      "Second candidate first.",
      "First candidate second.",
      "Deterministic match."
    ]);
    expect(result.trace).toEqual({
      serializedCandidateCount: 3,
      rankedItems: [
        { itemId: "movie:2", aiRank: 1, aiScore: 25 },
        { itemId: "movie:1", aiRank: 2, aiScore: 99 }
      ]
    });
  });

  it("rejects ids outside the serialized provider window", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              refinementOptions: [],
              rankings: [{ id: "movie:61", score: 100, explanation: "Was not sent." }]
            })
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
      )
    );
    const candidates = Array.from({ length: 61 }, (_, index) =>
      candidate({ id: `movie:${index + 1}`, title: `Candidate ${index + 1}`, score: 100 - index })
    );

    const result = await new OpenAiRanker(testConfig()).rank({ request: { query: "bounded" }, candidates });

    expect(result.usedAi).toBe(false);
    expect(result.results).toEqual(candidates);
    expect(result.trace).toEqual({ serializedCandidateCount: 60, rankedItems: [] });
  });

  it("drops templated model summaries so the engine can use a natural fallback", async () => {
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
                      summary: "You're looking for a short fantasy comedy under two hours.",
                      refinementOptions: [],
                      rankings: [{ id: "movie:1", score: 90, explanation: "A breezy, low-friction magical comedy." }]
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
      request: { query: "funny fantasy movie under two hours" },
      candidates: [candidate()]
    });

    expect(result.usedAi).toBe(true);
    expect(result.summary).toBeUndefined();
    expect(result.results[0]?.matchExplanation).toBe("A breezy, low-friction magical comedy.");
  });

  it("falls back to deterministic candidates on provider failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const candidates = [candidate()];

    const result = await new OpenAiRanker(testConfig()).rank({
      request: { query: "funny fantasy" },
      candidates
    });

    expect(result).toEqual({
      usedAi: false,
      results: candidates,
      trace: { serializedCandidateCount: 1, rankedItems: [] }
    });
  });
});
