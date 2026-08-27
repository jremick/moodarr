import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiTasteScout } from "../src/server/ai/tasteScout";
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

function candidate(index = 1): ItemSummary {
  return {
    id: `movie:${index}`,
    mediaType: "movie",
    title: `Candidate ${index}`,
    genres: ["Drama"],
    ratings: {},
    posterUrl: `/api/items/movie%3A${index}/poster`,
    availabilityGroup: "available_in_plex",
    availabilityExplanation: "Available in Plex.",
    matchExplanation: "Deterministic match.",
    score: 50,
    plex: { available: true }
  };
}

function providerResponse(recommendations: Array<{ id: string; score: number; reason: string }>) {
  return new Response(
    JSON.stringify({
      output_text: JSON.stringify({ summary: "A provider summary.", recommendations })
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

describe("OpenAiTasteScout", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a declared 0-100 score of one as one", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerResponse([
      { id: "movie:1", score: 1, reason: "A restrained match." }
    ])));

    const result = await new OpenAiTasteScout(testConfig()).scout({
      request: { query: "restrained drama" },
      watchContext: "solo",
      candidates: [candidate()],
      feedbackItems: { moreLike: [], lessLike: [] }
    });

    expect(result).toMatchObject({
      usedAi: true,
      recommendations: [{ id: "movie:1", score: 1, reason: "A restrained match." }]
    });
  });

  it("keeps the first recommendation when the provider repeats an item id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerResponse([
      { id: "movie:1", score: 1, reason: "First recommendation." },
      { id: "movie:1", score: 100, reason: "Conflicting duplicate." }
    ])));

    const result = await new OpenAiTasteScout(testConfig()).scout({
      request: { query: "stable duplicate handling" },
      watchContext: "solo",
      candidates: [candidate()],
      feedbackItems: { moreLike: [], lessLike: [] }
    });

    expect(result.recommendations).toEqual([
      { id: "movie:1", score: 1, reason: "First recommendation." }
    ]);
  });

  it("reports deterministic fallback when no recommendation was in the serialized provider payload", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => providerResponse([
      { id: "movie:91", score: 90, reason: "This item was not serialized." },
      { id: "unknown", score: 80, reason: "This item does not exist." }
    ])));
    const candidates = Array.from({ length: 91 }, (_, index) => candidate(index + 1));

    const result = await new OpenAiTasteScout(testConfig()).scout({
      request: { query: "bounded payload" },
      watchContext: "solo",
      candidates,
      feedbackItems: { moreLike: [], lessLike: [] }
    });

    expect(result).toEqual({ usedAi: false, recommendations: [] });
  });
});
