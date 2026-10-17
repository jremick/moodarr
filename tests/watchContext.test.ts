import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveChatCriteria } from "../src/client/chatCriteria";
import { OpenAiBriefParser } from "../src/server/ai/briefParser";
import { optimizeQueryDeterministically } from "../src/server/ai/queryOptimizer";
import type { AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import { parseRecommendationIntent } from "../src/server/recommendation/intent";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { inferWatchContext, resolveWatchContext, sharedWatchContextBriefGuidance } from "../src/shared/watchContext";

const coupleQueries = [
  "something funny, under 2 hours, for both of us",
  "something funny, under 2 hours, for us",
  "something funny, under 2 hours, date night",
  "something funny, under 2 hours, me and my partner",
  "something funny, under 2 hours, with my wife",
  "something funny, under 2 hours, with my husband",
  "something funny, under 2 hours, the two of us",
  "something funny, under 2 hours, couple",
  "something funny for a couple",
  "couples comedy"
];

afterEach(() => vi.unstubAllGlobals());

describe("watch context phrases", () => {
  it.each(coupleQueries)("reads a shared watch context from %s", (query) => {
    expect(inferWatchContext(query)).toBe("group");
    expect(deriveChatCriteria(query, {}, 20, "solo").watchContext).toBe("group");
    expect(resolveWatchContext(query)).toBe("group");
  });

  it.each(["solo", "just me", "for me", "by myself", "a quiet movie just for me"])("keeps personal viewing on %s", (query) => {
    expect(inferWatchContext(query)).toBe("solo");
    expect(deriveChatCriteria(query, {}, 20, "group").watchContext).toBe("solo");
    expect(resolveWatchContext(query)).toBe("solo");
  });

  it("does not treat a quantity or a plain runtime as shared viewing", () => {
    expect(inferWatchContext("something funny, under 2 hours")).toBeUndefined();
    expect(inferWatchContext("a couple of comedies")).toBeUndefined();
    expect(deriveChatCriteria("something funny, under 2 hours", {}, 20, "solo").watchContext).toBe("solo");
    expect(deriveChatCriteria("a couple of comedies under two hours", {}, 20, "solo").watchContext).toBe("solo");
    expect(deriveChatCriteria("together for family night", {}, 20, "solo").watchContext).toBe("group");
  });

  it("keeps an explicit watch context when the caller already set one", () => {
    expect(resolveWatchContext("funny movie under two hours", "group")).toBe("group");
    expect(resolveWatchContext("funny movie under two hours", "solo")).toBe("solo");
    expect(resolveWatchContext("something funny, under 2 hours, for both of us", "group")).toBe("group");
  });
});

describe("search watch context", () => {
  it("resolves an omitted watch context from the query", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const response = await new RecommendationEngine(repository, seerrClient, {
      rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates }))
    }).recommend({
      query: "something funny, under 2 hours, for both of us",
      useAi: false
    });

    expect(response.watchContext).toBe("group");
    db.close();
  });

  it("does not append a second group marker when the query already names a couple", () => {
    expect(optimizeQueryDeterministically({
      query: "something funny, under 2 hours, with my wife",
      filters: {},
      watchContext: "group"
    })).toBe("something funny, under 2 hours, with my wife");
    expect(optimizeQueryDeterministically({
      query: "funny movie",
      filters: {},
      watchContext: "group"
    })).toContain("for a group");
  });
});

describe("brief parser watch context guidance", () => {
  it("tells the brief model that couple phrases are the shared watch context", async () => {
    const fetchMock = vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>(async () => Response.json({
      output: [{ content: [{ type: "output_text", text: JSON.stringify({
        terms: [],
        softGenres: [],
        moods: [],
        referenceTitle: null,
        hardFilters: {
          mediaTypes: [],
          minRuntimeMinutes: null,
          maxRuntimeMinutes: null,
          minYear: null,
          maxYear: null,
          genres: [],
          excludedGenres: [],
          contentRating: null,
          availability: [],
          requestStatus: []
        },
        wantsBetter: false,
        wantsRequestOptions: false
      }) }] }]
    }));
    vi.stubGlobal("fetch", fetchMock);
    const config = {
      ai: {
        provider: "openai",
        openaiApiKey: "test-only",
        openaiModel: "gpt-test",
        openaiReasoningEffort: "low",
        openaiServiceTier: "default"
      }
    } as AppConfig;

    await new OpenAiBriefParser(config).parse({
      query: "something funny, under 2 hours, for both of us",
      deterministicIntent: parseRecommendationIntent("something funny, under 2 hours, for both of us"),
      explicitFilters: {},
      watchContext: "group"
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const developerPrompt = body.input[0].content[0].text as string;
    const userPayload = JSON.parse(body.input[1].content[0].text as string);
    expect(developerPrompt).toContain(sharedWatchContextBriefGuidance);
    expect(developerPrompt).toContain("for both of us");
    expect(developerPrompt).toContain("with my husband");
    expect(developerPrompt).toContain("just me");
    expect(userPayload.watchContext).toBe("group");
  });
});
