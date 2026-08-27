import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getOpenAiRankerContractIdentity,
  OpenAiRanker,
  openAiRankerDefaultMaxOutputTokens,
  openAiRankerMaxOutputTokenLimit,
  openAiRankerPromptIdentity,
  openAiRankerResponseContractIdentity
} from "../src/server/ai/ranker";
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

const validRefinementOptions = [
  { label: "More magical", prompt: "Lean more magical and whimsical." },
  { label: "More playful", prompt: "Make the next pass more playful." },
  { label: "Shorter picks", prompt: "Keep this mood but favor shorter options." }
];

describe("OpenAiRanker", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exposes stable template identities and count-specific production contract identities", () => {
    expect(openAiRankerPromptIdentity).toMatchObject({ id: "moodarr-production-ranker-prompt-v3" });
    expect(openAiRankerResponseContractIdentity).toMatchObject({ id: "moodarr-production-ranker-response-v3" });
    expect(openAiRankerPromptIdentity.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(openAiRankerResponseContractIdentity.sha256).toMatch(/^[a-f0-9]{64}$/);

    const sixtyByFive = getOpenAiRankerContractIdentity(60, 50);
    expect(sixtyByFive.explanationCount).toBe(5);
    expect(sixtyByFive.prompt.id).toContain("explanations=5");
    expect(sixtyByFive.responseContract.id).toContain("candidates=60;explanations=5");
    expect(sixtyByFive.prompt.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(sixtyByFive.responseContract.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(getOpenAiRankerContractIdentity(60, 4).prompt.sha256).not.toBe(sixtyByFive.prompt.sha256);
  });

  it("uses configured reasoning effort and parses structured rankings", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));

      expect(body.reasoning).toEqual({ effort: "low" });
      expect(body.max_output_tokens).toBe(2400);
      expect(body.service_tier).toBe("default");
      expect(JSON.stringify(body)).not.toContain("/api/items/movie%3A1/poster");
      expect(JSON.stringify(body)).not.toContain("test-openai-key-secret");
      const developerPrompt = body.input[0].content[0].text;
      expect(developerPrompt).toContain("Rank every provided candidate exactly once");
      expect(developerPrompt).toContain("first 1 ranked candidates");
      expect(developerPrompt).toContain("one friendly, specific sentence");
      expect(developerPrompt).toContain("exactly 3 refinement options");
      expect(body.text.format.schema.properties.rankings).toMatchObject({ minItems: 1, maxItems: 1 });
      expect(body.text.format.schema.properties.explanations).toMatchObject({ minItems: 1, maxItems: 1 });
      expect(body.text.format.schema.properties.rankings.items.properties.score.type).toBe("integer");
      expect(body.text.format.schema.properties.refinementOptions).toMatchObject({ minItems: 3, maxItems: 3 });
      expect(JSON.stringify(body.text.format)).not.toMatch(/minLength|maxLength/);
      expect(body.text.format.schema.properties.summary.description).toContain("at most 240 characters");
      expect(body.text.format.schema.properties.explanations.items.properties.explanation.description)
        .toContain("at most 180 characters");
      expect(body.text.format.schema.properties.refinementOptions.items.properties.label.description)
        .toContain("at most 32 characters");
      expect(body.text.format.schema.properties.refinementOptions.items.properties.prompt.description)
        .toContain("at most 120 characters");
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
          service_tier: "default",
          usage: {
            input_tokens: 120,
            input_tokens_details: { cached_tokens: 20 },
            output_tokens: 45,
            output_tokens_details: { reasoning_tokens: 5 },
            total_tokens: 165
          },
          output: [
            {
              content: [
                {
                  type: "output_text",
                  text: JSON.stringify({
                    summary: "I’d steer this toward breezy fantasy comedy, with Bewitched as the easy first stop.",
                    refinementOptions: validRefinementOptions,
                    rankings: [{ id: "movie:1", score: 98 }],
                    explanations: [{ id: "movie:1", explanation: "A concise AI explanation." }]
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
    expect(result.refinementOptions).toEqual(validRefinementOptions);
    expect(result.results[0]).toMatchObject({
      id: "movie:1",
      score: 10,
      matchExplanation: "A concise AI explanation."
    });
    expect(result.trace).toEqual({
      serializedCandidateCount: 1,
      rankedItems: [{ itemId: "movie:1", aiRank: 1, aiScore: 98 }]
    });
    expect(result.failureCategory).toBeUndefined();
    expect(result.providerDiagnostics).toMatchObject({
      requestedServiceTier: "default",
      receivedServiceTier: "default",
      inputTokens: 120,
      cachedInputTokens: 20,
      outputTokens: 45,
      reasoningTokens: 5,
      totalTokens: 165
    });
    expect(result.providerDiagnostics?.providerLatencyMs).toBeGreaterThanOrEqual(0);
    expect(new OpenAiRanker(testConfig()).requestTimeoutMs).toBe(6_000);
    expect(new OpenAiRanker(testConfig()).rankerMaxOutputTokens).toBe(openAiRankerDefaultMaxOutputTokens);
  });

  it("uses an explicit diagnostic output-token budget without changing the production default", async () => {
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.service_tier).toBe("fast");
      expect(body.max_output_tokens).toBe(4_800);
      return new Response(JSON.stringify({
        status: "completed",
        service_tier: "priority",
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 30,
          output_tokens_details: { reasoning_tokens: 4 },
          total_tokens: 130
        },
        output_text: JSON.stringify({
          summary: "A compact successful ranking.",
          refinementOptions: validRefinementOptions,
          rankings: [{ id: "movie:1", score: 88 }],
          explanations: [{ id: "movie:1", explanation: "A concise AI explanation." }]
        })
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    const ranker = new OpenAiRanker(testConfig(), 6_000, "fast", 4_800);
    const result = await ranker.rank({
      request: { query: "funny fantasy" },
      candidates: [candidate()]
    });

    expect(result.usedAi).toBe(true);
    expect(result.providerDiagnostics).toMatchObject({
      requestedServiceTier: "fast",
      receivedServiceTier: "priority",
      inputTokens: 100,
      cachedInputTokens: 0,
      outputTokens: 30,
      reasoningTokens: 4,
      totalTokens: 130
    });
    expect(result.providerDiagnostics?.providerLatencyMs).toBeGreaterThanOrEqual(0);
    expect(ranker.rankerMaxOutputTokens).toBe(4_800);
    expect(openAiRankerDefaultMaxOutputTokens).toBe(2_400);
    expect(JSON.stringify(result.providerDiagnostics)).not.toContain("funny fantasy");
  });

  it("accepts exact Unicode text limits after trimming surrounding whitespace", async () => {
    const summary = `${"🙂".repeat(239)}.`;
    const explanation = `${"🙂".repeat(179)}.`;
    const label = "🙂".repeat(32);
    const prompt = `${"🙂".repeat(119)}.`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output_text: JSON.stringify({
        summary: `  ${summary}  `,
        refinementOptions: [
          { label: `  ${label}  `, prompt: `  ${prompt}  ` },
          ...validRefinementOptions.slice(1)
        ],
        rankings: [{ id: "movie:1", score: 90 }],
        explanations: [{ id: "movie:1", explanation: `  ${explanation}  ` }]
      })
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const result = await new OpenAiRanker(testConfig()).rank({
      request: { query: "funny fantasy" },
      candidates: [candidate()]
    });

    expect(result.usedAi).toBe(true);
    expect(result.summary).toBe(summary);
    expect(result.results[0]?.matchExplanation).toBe(explanation);
    expect(result.refinementOptions?.[0]).toEqual({ label, prompt });
  });

  it.each([
    {
      label: "an unknown id",
      rankings: [{ id: "movie:1", score: 90 }, { id: "unknown", score: 80 }]
    },
    {
      label: "a duplicate id",
      rankings: [{ id: "movie:1", score: 90 }, { id: "movie:1", score: 80 }]
    },
    {
      label: "a missing id",
      rankings: [{ id: "movie:1", score: 90 }]
    },
    {
      label: "a non-integer score",
      rankings: [{ id: "movie:1", score: 90.5 }, { id: "movie:2", score: 80 }]
    }
  ])("rejects a full-ranking contract with $label", async ({ rankings }) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output_text: JSON.stringify({
        summary: "Invalid provider ordering.",
        refinementOptions: validRefinementOptions,
        rankings,
        explanations: [{ id: "movie:1", explanation: "Only the known top candidate is explained." }]
      })
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const candidates = [
      candidate({ id: "movie:1", title: "One" }),
      candidate({ id: "movie:2", title: "Two" })
    ];

    const result = await new OpenAiRanker(testConfig()).rank({
      request: { query: "funny fantasy", resultLimit: 1 },
      candidates
    });

    expect(result).toMatchObject({
      usedAi: false,
      results: candidates,
      failureCategory: "malformed_or_truncated_output",
      trace: { serializedCandidateCount: 2, rankedItems: [] }
    });
  });

  it.each([
    {
      label: "an unknown explanation id",
      explanations: [
        { id: "movie:1", explanation: "Known top candidate." },
        { id: "unknown", explanation: "Unknown candidate." }
      ]
    },
    {
      label: "a duplicate explanation id",
      explanations: [
        { id: "movie:1", explanation: "Known top candidate." },
        { id: "movie:1", explanation: "Duplicate candidate." }
      ]
    },
    {
      label: "a missing explanation",
      explanations: [{ id: "movie:1", explanation: "Known top candidate." }]
    },
    {
      label: "a whitespace-only explanation",
      explanations: [
        { id: "movie:1", explanation: "   " },
        { id: "movie:2", explanation: "Known second candidate." }
      ]
    },
    {
      label: "an overlong explanation",
      explanations: [
        { id: "movie:1", explanation: `  ${"🙂".repeat(180)}.  ` },
        { id: "movie:2", explanation: "Known second candidate." }
      ]
    }
  ])("rejects top-result prose with $label", async ({ explanations }) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output_text: JSON.stringify({
        summary: "Invalid explanation coverage.",
        refinementOptions: validRefinementOptions,
        rankings: [{ id: "movie:1", score: 90 }, { id: "movie:2", score: 80 }],
        explanations
      })
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const candidates = [
      candidate({ id: "movie:1", title: "One" }),
      candidate({ id: "movie:2", title: "Two" })
    ];

    const result = await new OpenAiRanker(testConfig()).rank({
      request: { query: "funny fantasy", resultLimit: 2 },
      candidates
    });

    expect(result).toMatchObject({
      usedAi: false,
      results: candidates,
      failureCategory: "malformed_or_truncated_output"
    });
  });

  it("preserves provider order, applies prose only to the top result window, and never mixes score domains", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              summary: "Provider order is authoritative.",
              refinementOptions: validRefinementOptions,
              rankings: [
                { id: "movie:2", score: 25 },
                { id: "movie:1", score: 99 },
                { id: "movie:3", score: 10 }
              ],
              explanations: [
                { id: "movie:2", explanation: "Second candidate first." },
                { id: "movie:1", explanation: "First candidate second." }
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

    const result = await new OpenAiRanker(testConfig()).rank({ request: { query: "provider order", resultLimit: 2 }, candidates });

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
        { itemId: "movie:1", aiRank: 2, aiScore: 99 },
        { itemId: "movie:3", aiRank: 3, aiScore: 10 }
      ]
    });
  });

  it("accepts an exact 60-candidate ordering, caps prose at five, and appends candidates outside the provider window", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const userInput = JSON.parse(body.input[1].content[0].text);
      expect(userInput.candidates).toHaveLength(60);
      expect(body.text.format.schema.properties.rankings).toMatchObject({ minItems: 60, maxItems: 60 });
      expect(body.text.format.schema.properties.explanations).toMatchObject({ minItems: 5, maxItems: 5 });
      expect(JSON.stringify(body)).not.toContain("/api/items/");
      expect(JSON.stringify(body)).not.toContain("test-openai-key-secret");
      const rankings = Array.from({ length: 60 }, (_, index) => ({
        id: `movie:${60 - index}`,
        score: Math.max(0, 100 - index)
      }));
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          summary: "A complete provider ordering.",
          refinementOptions: validRefinementOptions,
          rankings,
          explanations: rankings.slice(0, 5).map(({ id }) => ({
            id,
            explanation: `AI explanation for ${id}.`
          }))
        })
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const candidates = Array.from({ length: 61 }, (_, index) =>
      candidate({ id: `movie:${index + 1}`, title: `Candidate ${index + 1}`, score: 100 - index })
    );

    const result = await new OpenAiRanker(testConfig()).rank({
      request: { query: "bounded", resultLimit: 50 },
      candidates
    });

    expect(result.usedAi).toBe(true);
    expect(result.results).toHaveLength(61);
    expect(result.results.slice(0, 60).map((item) => item.id)).toEqual(
      Array.from({ length: 60 }, (_, index) => `movie:${60 - index}`)
    );
    expect(result.results[60]).toBe(candidates[60]);
    expect(result.results[0]?.matchExplanation).toBe("AI explanation for movie:60.");
    expect(result.results[4]?.matchExplanation).toBe("AI explanation for movie:56.");
    expect(result.results[5]?.matchExplanation).toBe("Deterministic match.");
    expect(result.trace?.rankedItems).toHaveLength(60);
    expect(JSON.stringify(result.trace)).not.toContain("AI explanation");
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
                      refinementOptions: validRefinementOptions,
                      rankings: [{ id: "movie:1", score: 90 }],
                      explanations: [{ id: "movie:1", explanation: "A breezy, low-friction magical comedy." }]
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

  it.each([
    {
      label: "a missing summary",
      response: {
        refinementOptions: validRefinementOptions,
        rankings: [{ id: "movie:1", score: 90 }],
        explanations: [{ id: "movie:1", explanation: "A concise explanation." }]
      }
    },
    {
      label: "a whitespace-only summary",
      response: {
        summary: "   ",
        refinementOptions: validRefinementOptions,
        rankings: [{ id: "movie:1", score: 90 }],
        explanations: [{ id: "movie:1", explanation: "A concise explanation." }]
      }
    },
    {
      label: "too few refinement options",
      response: {
        summary: "A complete summary.",
        refinementOptions: validRefinementOptions.slice(0, 2),
        rankings: [{ id: "movie:1", score: 90 }],
        explanations: [{ id: "movie:1", explanation: "A concise explanation." }]
      }
    },
    {
      label: "too many refinement options",
      response: {
        summary: "A complete summary.",
        refinementOptions: [
          ...validRefinementOptions,
          { label: "More action", prompt: "Make the next pass more action-driven." }
        ],
        rankings: [{ id: "movie:1", score: 90 }],
        explanations: [{ id: "movie:1", explanation: "A concise explanation." }]
      }
    },
    {
      label: "an empty refinement option",
      response: {
        summary: "A complete summary.",
        refinementOptions: [{ label: "   ", prompt: "   " }, ...validRefinementOptions.slice(1)],
        rankings: [{ id: "movie:1", score: 90 }],
        explanations: [{ id: "movie:1", explanation: "A concise explanation." }]
      }
    },
    {
      label: "an overlong summary",
      response: {
        summary: `  ${"🙂".repeat(240)}.  `,
        refinementOptions: validRefinementOptions,
        rankings: [{ id: "movie:1", score: 90 }],
        explanations: [{ id: "movie:1", explanation: "A concise explanation." }]
      }
    },
    {
      label: "an overlong refinement label",
      response: {
        summary: "A complete summary.",
        refinementOptions: [
          { label: `  ${"🙂".repeat(33)}  `, prompt: "Lean more magical and whimsical." },
          ...validRefinementOptions.slice(1)
        ],
        rankings: [{ id: "movie:1", score: 90 }],
        explanations: [{ id: "movie:1", explanation: "A concise explanation." }]
      }
    },
    {
      label: "an overlong refinement prompt",
      response: {
        summary: "A complete summary.",
        refinementOptions: [
          { label: "More magical", prompt: `  ${"🙂".repeat(120)}.  ` },
          ...validRefinementOptions.slice(1)
        ],
        rankings: [{ id: "movie:1", score: 90 }],
        explanations: [{ id: "movie:1", explanation: "A concise explanation." }]
      }
    }
  ])("rejects $label from the required response envelope", async ({ response }) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output_text: JSON.stringify(response)
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const result = await new OpenAiRanker(testConfig()).rank({
      request: { query: "funny fantasy" },
      candidates: [candidate()]
    });

    expect(result).toMatchObject({ usedAi: false, failureCategory: "malformed_or_truncated_output" });
  });

  it("falls back to deterministic candidates on provider failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 500 })));
    const candidates = [candidate()];

    const result = await new OpenAiRanker(testConfig()).rank({
      request: { query: "funny fantasy" },
      candidates
    });

    expect(result).toMatchObject({
      usedAi: false,
      results: candidates,
      failureCategory: "http_failure",
      trace: { serializedCandidateCount: 1, rankedItems: [] }
    });
    expect(result.providerDiagnostics).toMatchObject({ requestedServiceTier: "default" });
    expect(result.providerDiagnostics?.providerLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it.each([0, -1, 1.5, openAiRankerMaxOutputTokenLimit + 1])(
    "rejects invalid max-output-token budget %s",
    (rankerMaxOutputTokens) => {
      expect(() => new OpenAiRanker(testConfig(), 6_000, "default", rankerMaxOutputTokens))
        .toThrow(/invalid_openai_ranker_max_output_tokens/);
    }
  );

  it("distinguishes timeout, malformed output, and request failures", async () => {
    const candidates = [candidate()];

    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      await new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true }));
      return new Response();
    }));
    const timeoutResult = await new OpenAiRanker(testConfig(), 1).rank({
      request: { query: "funny fantasy" },
      candidates
    });
    expect(timeoutResult.failureCategory).toBe("timeout");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ output_text: "{" }), { status: 200 })));
    const malformedResult = await new OpenAiRanker(testConfig()).rank({
      request: { query: "funny fantasy" },
      candidates
    });
    expect(malformedResult.failureCategory).toBe("malformed_or_truncated_output");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output_text: JSON.stringify({
        summary: "Malformed ranking.",
        refinementOptions: validRefinementOptions,
        rankings: [null],
        explanations: [{ id: "movie:1", explanation: "Malformed ranking." }]
      })
    }), { status: 200 })));
    const malformedRanking = await new OpenAiRanker(testConfig()).rank({
      request: { query: "funny fantasy" },
      candidates
    });
    expect(malformedRanking.failureCategory).toBe("malformed_or_truncated_output");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output_text: JSON.stringify({
        summary: "Malformed ranking.",
        refinementOptions: validRefinementOptions,
        rankings: [{ id: "movie:1", score: "high" }],
        explanations: [{ id: "movie:1", explanation: "Malformed score." }]
      })
    }), { status: 200 })));
    const malformedRankingFields = await new OpenAiRanker(testConfig()).rank({
      request: { query: "funny fantasy" },
      candidates
    });
    expect(malformedRankingFields.failureCategory).toBe("malformed_or_truncated_output");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output_text: JSON.stringify({
        summary: "Empty ranking.",
        refinementOptions: validRefinementOptions,
        rankings: [],
        explanations: []
      })
    }), { status: 200 })));
    const emptyRanking = await new OpenAiRanker(testConfig()).rank({
      request: { query: "funny fantasy" },
      candidates
    });
    expect(emptyRanking.failureCategory).toBe("empty_ranking");

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      status: "incomplete",
      output_text: JSON.stringify({
        summary: "Partial ranking.",
        refinementOptions: validRefinementOptions,
        rankings: [{ id: "movie:1", score: 80 }],
        explanations: [{ id: "movie:1", explanation: "Partial." }]
      })
    }), { status: 200 })));
    const incompleteResult = await new OpenAiRanker(testConfig()).rank({
      request: { query: "funny fantasy" },
      candidates
    });
    expect(incompleteResult.failureCategory).toBe("malformed_or_truncated_output");

    for (const status of ["failed", "cancelled", "queued", "in_progress"]) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status }), { status: 200 })));
      const providerFailure = await new OpenAiRanker(testConfig()).rank({
        request: { query: "funny fantasy" },
        candidates
      });
      expect(providerFailure.failureCategory).toBe("request_failure");
    }

    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("connection failed"); }));
    const requestFailure = await new OpenAiRanker(testConfig()).rank({
      request: { query: "funny fantasy" },
      candidates
    });
    expect(requestFailure.failureCategory).toBe("request_failure");
  });
});
