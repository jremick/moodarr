import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getOpenAiRankerContractIdentity,
  OpenAiRanker,
  openAiRankerDefaultMaxOutputTokens,
  openAiRankerEvaluationPromptIdentity,
  openAiRankerEvaluationResponseContractIdentity,
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
    expect(openAiRankerPromptIdentity).toMatchObject({ id: "moodarr-production-ranker-prompt-v4" });
    expect(openAiRankerResponseContractIdentity).toMatchObject({ id: "moodarr-production-ranker-response-v4" });
    expect(openAiRankerPromptIdentity.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(openAiRankerResponseContractIdentity.sha256).toMatch(/^[a-f0-9]{64}$/);

    const sixtyByFive = getOpenAiRankerContractIdentity(60, 50);
    expect(sixtyByFive.explanationCount).toBe(5);
    expect(sixtyByFive.prompt.id).toContain("explanations=5");
    expect(sixtyByFive.responseContract.id).toContain("candidates=60;explanations=5");
    expect(sixtyByFive.prompt.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(sixtyByFive.responseContract.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(getOpenAiRankerContractIdentity(60, 50).responseContract.sha256)
      .toBe(sixtyByFive.responseContract.sha256);
    expect(getOpenAiRankerContractIdentity(59, 50).responseContract.sha256)
      .not.toBe(sixtyByFive.responseContract.sha256);
    expect(getOpenAiRankerContractIdentity(60, 4).prompt.sha256).not.toBe(sixtyByFive.prompt.sha256);

    const evaluation = getOpenAiRankerContractIdentity(60, 50, "evaluation_score_only");
    expect(openAiRankerEvaluationPromptIdentity.id).toBe("moodarr-evaluation-ranker-prompt-v1");
    expect(openAiRankerEvaluationResponseContractIdentity.id).toBe("moodarr-evaluation-ranker-response-v1");
    expect(evaluation).toMatchObject({ explanationCount: 0, responseMode: "evaluation_score_only" });
    expect(evaluation.prompt.id).toBe(openAiRankerEvaluationPromptIdentity.id);
    expect(evaluation.responseContract.id).toContain("candidates=60");
    expect(evaluation.prompt.sha256).not.toBe(sixtyByFive.prompt.sha256);
    expect(evaluation.responseContract.sha256).not.toBe(sixtyByFive.responseContract.sha256);
    expect(getOpenAiRankerContractIdentity(60, 1, "evaluation_score_only").responseContract.sha256)
      .toBe(evaluation.responseContract.sha256);
    expect(getOpenAiRankerContractIdentity(59, 50, "evaluation_score_only").responseContract.sha256)
      .not.toBe(evaluation.responseContract.sha256);
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
      expect(developerPrompt).toContain("Score every provided candidate exactly once");
      expect(developerPrompt).toContain("first 1 candidates after sorting");
      expect(developerPrompt).toContain("one friendly, specific sentence");
      expect(developerPrompt).toContain("exactly 3 refinement options");
      expect(body.text.format.schema.properties.explanations).toMatchObject({ minItems: 1, maxItems: 1 });
      expect(body.text.format.schema.properties.rankings).toBeUndefined();
      expect(body.text.format.schema.properties.scores).toMatchObject({
        additionalProperties: false,
        required: ["c0"],
        properties: { c0: { type: "integer", minimum: 0, maximum: 100 } }
      });
      expect(body.text.format.schema.properties.explanations.items.properties.rankKey.enum).toEqual(["c0"]);
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
      expect(userInput.candidates[0]).toMatchObject({ rankKey: "c0", title: "Bewitched" });
      expect(userInput.candidates[0].id).toBeUndefined();
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
                    scores: { c0: 98 },
                    explanations: [{ rankKey: "c0", explanation: "A concise AI explanation." }]
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
    expect(new OpenAiRanker(testConfig()).responseMode).toBe("production");
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
          scores: { c0: 88 },
          explanations: [{ rankKey: "c0", explanation: "A concise AI explanation." }]
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
        scores: { c0: 90 },
        explanations: [{ rankKey: "c0", explanation: `  ${explanation}  ` }]
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

  it("uses a distinct score-only evaluation contract and maps all 60 ordinal scores locally", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.max_output_tokens).toBe(2_400);
      expect(body.input[0].content[0].text).toContain("Return only the scores object");
      expect(body.input[0].content[0].text).not.toContain("Return explanations");
      expect(body.text.format.name).toBe("moodarr_ranking_evaluation");
      expect(Object.keys(body.text.format.schema.properties)).toEqual(["scores"]);
      expect(body.text.format.schema.required).toEqual(["scores"]);
      expect(body.text.format.schema.properties.scores.additionalProperties).toBe(false);
      expect(body.text.format.schema.properties.scores.required).toEqual(
        Array.from({ length: 60 }, (_, index) => `c${index}`)
      );
      const userInput = JSON.parse(body.input[1].content[0].text);
      expect(userInput.candidates).toHaveLength(60);
      expect(userInput.candidates.every((item: { id?: string }) => item.id === undefined)).toBe(true);
      const scores = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`c${index}`, index]));
      return new Response(JSON.stringify({
        status: "completed",
        service_tier: "priority",
        output_text: JSON.stringify({ scores })
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const candidates = Array.from({ length: 60 }, (_, index) =>
      candidate({ id: `movie:${index}`, title: `Candidate ${index}` })
    );
    const ranker = new OpenAiRanker(
      testConfig(),
      120_000,
      "fast",
      openAiRankerDefaultMaxOutputTokens,
      "evaluation_score_only"
    );

    const result = await ranker.rank({ request: { query: "evaluation" }, candidates });

    expect(result.usedAi).toBe(true);
    expect(result.results.map((item) => item.id)).toEqual(
      Array.from({ length: 60 }, (_, index) => `movie:${59 - index}`)
    );
    expect(result.trace?.rankedItems).toHaveLength(60);
    expect(result.trace?.rankedItems[0]).toEqual({ itemId: "movie:59", aiRank: 1, aiScore: 59 });
    expect(result.providerDiagnostics).toMatchObject({
      requestedServiceTier: "fast",
      receivedServiceTier: "priority"
    });
    expect(Object.prototype.hasOwnProperty.call(result, "summary")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(result, "refinementOptions")).toBe(false);
  });

  it.each([
    { label: "a missing score key", response: { scores: { c0: 90 } } },
    { label: "an extra score key", response: { scores: { c0: 90, c1: 80, c2: 70 } } },
    { label: "production prose", response: { scores: { c0: 90, c1: 80 }, summary: "Forbidden." } }
  ])("rejects evaluation score-only output with $label", async ({ response }) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output_text: JSON.stringify(response)
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const candidates = [
      candidate({ id: "movie:1", title: "One" }),
      candidate({ id: "movie:2", title: "Two" })
    ];
    const ranker = new OpenAiRanker(
      testConfig(),
      120_000,
      "default",
      openAiRankerDefaultMaxOutputTokens,
      "evaluation_score_only"
    );

    const result = await ranker.rank({ request: { query: "evaluation" }, candidates });

    expect(result).toMatchObject({
      usedAi: false,
      results: candidates,
      failureCategory: "malformed_or_truncated_output",
      trace: { serializedCandidateCount: 2, rankedItems: [] }
    });
  });

  it.each([
    {
      label: "a missing rank key",
      scores: { c0: 90 }
    },
    {
      label: "an extra rank key",
      scores: { c0: 90, c1: 80, c2: 70 }
    },
    {
      label: "a non-integer score",
      scores: { c0: 90.5, c1: 80 }
    },
    {
      label: "an out-of-range score",
      scores: { c0: 101, c1: 80 }
    }
  ])("rejects a score-map contract with $label", async ({ scores }) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output_text: JSON.stringify({
        summary: "Invalid provider ordering.",
        refinementOptions: validRefinementOptions,
        scores,
        explanations: [{ rankKey: "c0", explanation: "Only the known top candidate is explained." }]
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
      label: "an unknown explanation rank key",
      explanations: [
        { rankKey: "c0", explanation: "Known top candidate." },
        { rankKey: "unknown", explanation: "Unknown candidate." }
      ]
    },
    {
      label: "a duplicate explanation rank key",
      explanations: [
        { rankKey: "c0", explanation: "Known top candidate." },
        { rankKey: "c0", explanation: "Duplicate candidate." }
      ]
    },
    {
      label: "a missing explanation",
      explanations: [{ rankKey: "c0", explanation: "Known top candidate." }]
    },
    {
      label: "a whitespace-only explanation",
      explanations: [
        { rankKey: "c0", explanation: "   " },
        { rankKey: "c1", explanation: "Known second candidate." }
      ]
    },
    {
      label: "an overlong explanation",
      explanations: [
        { rankKey: "c0", explanation: `  ${"🙂".repeat(180)}.  ` },
        { rankKey: "c1", explanation: "Known second candidate." }
      ]
    }
  ])("rejects top-result prose with $label", async ({ explanations }) => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output_text: JSON.stringify({
        summary: "Invalid explanation coverage.",
        refinementOptions: validRefinementOptions,
        scores: { c0: 90, c1: 80 },
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

  it("sorts scores descending, breaks ties by numeric ordinal order, and never mixes score domains", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            output_text: JSON.stringify({
              summary: "Local score order is authoritative.",
              refinementOptions: validRefinementOptions,
              scores: { c0: 99, c1: 99, c2: 10 },
              explanations: [
                { rankKey: "c0", explanation: "First tied candidate stays first." },
                { rankKey: "c1", explanation: "Second tied candidate stays second." }
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

    expect(result.results.map((item) => item.id)).toEqual(["movie:1", "movie:2", "movie:3"]);
    expect(result.results.map((item) => item.score)).toEqual([95, 5, 100]);
    expect(result.results.map((item) => item.matchExplanation)).toEqual([
      "First tied candidate stays first.",
      "Second tied candidate stays second.",
      "Deterministic match."
    ]);
    expect(result.trace).toEqual({
      serializedCandidateCount: 3,
      rankedItems: [
        { itemId: "movie:1", aiRank: 1, aiScore: 99 },
        { itemId: "movie:2", aiRank: 2, aiScore: 99 },
        { itemId: "movie:3", aiRank: 3, aiScore: 10 }
      ]
    });
  });

  it("breaks c2 versus c10 score ties by numeric input position instead of lexical key order", async () => {
    const scores = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`c${index}`, 10]));
    scores.c2 = 90;
    scores.c10 = 90;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output_text: JSON.stringify({
        summary: "Numeric ordinal ties stay deterministic.",
        refinementOptions: validRefinementOptions,
        scores,
        explanations: [
          { rankKey: "c2", explanation: "The earlier tied candidate stays first." },
          { rankKey: "c10", explanation: "The later tied candidate stays second." }
        ]
      })
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const candidates = Array.from({ length: 12 }, (_, index) =>
      candidate({ id: `movie:${index}`, title: `Candidate ${index}` })
    );

    const result = await new OpenAiRanker(testConfig()).rank({
      request: { query: "tie", resultLimit: 2 },
      candidates
    });

    expect(result.results.slice(0, 2).map((item) => item.id)).toEqual(["movie:2", "movie:10"]);
    expect(result.trace?.rankedItems.slice(0, 2)).toEqual([
      { itemId: "movie:2", aiRank: 1, aiScore: 90 },
      { itemId: "movie:10", aiRank: 2, aiScore: 90 }
    ]);
  });

  it("uses input order to resolve a tie at the explanation cutoff", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      output_text: JSON.stringify({
        summary: "The explanation cutoff follows the deterministic tie rule.",
        refinementOptions: validRefinementOptions,
        scores: { c0: 100, c1: 99, c2: 98, c3: 97, c4: 90, c5: 90 },
        explanations: Array.from({ length: 5 }, (_, index) => ({
          rankKey: `c${index}`,
          explanation: `Explanation ${index}.`
        }))
      })
    }), { status: 200, headers: { "Content-Type": "application/json" } })));
    const candidates = Array.from({ length: 6 }, (_, index) =>
      candidate({ id: `movie:${index}`, title: `Candidate ${index}` })
    );

    const result = await new OpenAiRanker(testConfig()).rank({
      request: { query: "cutoff tie", resultLimit: 5 },
      candidates
    });

    expect(result.usedAi).toBe(true);
    expect(result.results[4]?.id).toBe("movie:4");
    expect(result.results[4]?.matchExplanation).toBe("Explanation 4.");
    expect(result.results[5]?.id).toBe("movie:5");
    expect(result.results[5]?.matchExplanation).toBe("Deterministic match.");
  });

  it("keeps hostile candidate ids out of the provider contract and maps ordinal keys locally", async () => {
    const hostileIds = ["__proto__", "constructor", "movie:\"quoted\"\\path"];
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const bodyText = String(init?.body);
      for (const hostileId of hostileIds) expect(bodyText).not.toContain(hostileId);
      const body = JSON.parse(bodyText);
      const userInput = JSON.parse(body.input[1].content[0].text);
      expect(userInput.candidates.map((item: { rankKey: string }) => item.rankKey)).toEqual(["c0", "c1", "c2"]);
      expect(userInput.candidates.every((item: { id?: string }) => item.id === undefined)).toBe(true);
      expect(body.text.format.schema.properties.scores.required).toEqual(["c0", "c1", "c2"]);
      expect(Object.keys(body.text.format.schema.properties.scores.properties)).toEqual(["c0", "c1", "c2"]);
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          summary: "Ordinal keys keep identifiers private.",
          refinementOptions: validRefinementOptions,
          scores: { c0: 70, c1: 90, c2: 80 },
          explanations: [{ rankKey: "c1", explanation: "The strongest ordinal ranks first." }]
        })
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
    const candidates = hostileIds.map((id, index) => candidate({ id, title: `Candidate ${index}` }));

    const result = await new OpenAiRanker(testConfig()).rank({
      request: { query: "hostile ids", resultLimit: 1 },
      candidates
    });

    expect(result.usedAi).toBe(true);
    expect(result.results.map((item) => item.id)).toEqual(["constructor", "movie:\"quoted\"\\path", "__proto__"]);
  });

  it("accepts an exact 60-candidate score map, caps prose at five, and appends candidates outside the provider window", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const userInput = JSON.parse(body.input[1].content[0].text);
      expect(userInput.candidates).toHaveLength(60);
      expect(userInput.candidates.map((item: { rankKey: string }) => item.rankKey)).toEqual(
        Array.from({ length: 60 }, (_, index) => `c${index}`)
      );
      expect(userInput.candidates.every((item: { id?: string }) => item.id === undefined)).toBe(true);
      expect(body.text.format.schema.properties.rankings).toBeUndefined();
      expect(body.text.format.schema.properties.scores.additionalProperties).toBe(false);
      expect(body.text.format.schema.properties.scores.required).toEqual(
        Array.from({ length: 60 }, (_, index) => `c${index}`)
      );
      expect(Object.keys(body.text.format.schema.properties.scores.properties)).toHaveLength(60);
      expect(body.text.format.schema.properties.explanations).toMatchObject({ minItems: 5, maxItems: 5 });
      expect(JSON.stringify(body)).not.toContain("/api/items/");
      expect(JSON.stringify(body)).not.toContain("test-openai-key-secret");
      const scores = Object.fromEntries(Array.from({ length: 60 }, (_, index) => [`c${index}`, index]));
      const topRankKeys = Array.from({ length: 5 }, (_, index) => `c${59 - index}`);
      return new Response(JSON.stringify({
        output_text: JSON.stringify({
          summary: "A complete provider ordering.",
          refinementOptions: validRefinementOptions,
          scores,
          explanations: topRankKeys.map((rankKey) => ({
            rankKey,
            explanation: `AI explanation for ${rankKey}.`
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
    expect(result.results[0]?.matchExplanation).toBe("AI explanation for c59.");
    expect(result.results[4]?.matchExplanation).toBe("AI explanation for c55.");
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
                      scores: { c0: 90 },
                      explanations: [{ rankKey: "c0", explanation: "A breezy, low-friction magical comedy." }]
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
        scores: { c0: 90 },
        explanations: [{ rankKey: "c0", explanation: "A concise explanation." }]
      }
    },
    {
      label: "a whitespace-only summary",
      response: {
        summary: "   ",
        refinementOptions: validRefinementOptions,
        scores: { c0: 90 },
        explanations: [{ rankKey: "c0", explanation: "A concise explanation." }]
      }
    },
    {
      label: "too few refinement options",
      response: {
        summary: "A complete summary.",
        refinementOptions: validRefinementOptions.slice(0, 2),
        scores: { c0: 90 },
        explanations: [{ rankKey: "c0", explanation: "A concise explanation." }]
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
        scores: { c0: 90 },
        explanations: [{ rankKey: "c0", explanation: "A concise explanation." }]
      }
    },
    {
      label: "an empty refinement option",
      response: {
        summary: "A complete summary.",
        refinementOptions: [{ label: "   ", prompt: "   " }, ...validRefinementOptions.slice(1)],
        scores: { c0: 90 },
        explanations: [{ rankKey: "c0", explanation: "A concise explanation." }]
      }
    },
    {
      label: "an overlong summary",
      response: {
        summary: `  ${"🙂".repeat(240)}.  `,
        refinementOptions: validRefinementOptions,
        scores: { c0: 90 },
        explanations: [{ rankKey: "c0", explanation: "A concise explanation." }]
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
        scores: { c0: 90 },
        explanations: [{ rankKey: "c0", explanation: "A concise explanation." }]
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
        scores: { c0: 90 },
        explanations: [{ rankKey: "c0", explanation: "A concise explanation." }]
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
        scores: null,
        explanations: [{ rankKey: "c0", explanation: "Malformed ranking." }]
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
        scores: { c0: "high" },
        explanations: [{ rankKey: "c0", explanation: "Malformed score." }]
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
        scores: {},
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
        scores: { c0: 80 },
        explanations: [{ rankKey: "c0", explanation: "Partial." }]
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
