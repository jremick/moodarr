import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiBriefParser } from "../src/server/ai/briefParser";
import { OpenAiQueryOptimizer } from "../src/server/ai/queryOptimizer";
import { OpenAiRanker } from "../src/server/ai/ranker";
import { OpenAiTasteScout } from "../src/server/ai/tasteScout";
import type { AppConfig } from "../src/server/config";
import { parseRecommendationIntent } from "../src/server/recommendation/intent";
import type { ItemSummary } from "../src/shared/types";

const config = { ai: {
  provider: "openai", openaiApiKey: "test-only", openaiModel: "gpt-6-luna",
  openaiReasoningEffort: "none", openaiServiceTier: "fast"
}, knownSecrets: ["test-only", "retained-openai-key", "abc"] } as AppConfig;
const item: ItemSummary = {
  id: "movie:1", title: "Example", mediaType: "movie", genres: ["Comedy"], ratings: {},
  score: 50, matchExplanation: "Local match.", availabilityGroup: "available_in_plex",
  availabilityExplanation: "Available.", posterUrl: "/poster", plex: { available: true }
};
const refinementOptions = [
  { label: "Lighter", prompt: "Something lighter." },
  { label: "Warmer", prompt: "Something warmer." },
  { label: "Shorter", prompt: "Something shorter." }
];
const payloads: Record<string, unknown> = {
  moodarr_ranking: { summary: "Try a warm comedy.", scores: { c0: 95 }, refinementOptions },
  moodarr_recommendation_brief: { moods: ["warm"], terms: ["comedy"], hardFilters: {} },
  moodarr_optimized_query: { query: "A warm comedy" },
  moodarr_taste_scout: { summary: "A warm pick.", recommendations: [{ id: "movie:1", score: 95, reason: "Warm comedy." }] }
};

afterEach(() => vi.unstubAllGlobals());

describe("GPT-6 structured final answers across provider stages", () => {
  it.each(["completed", "incomplete"])("handles %s commentary plus final responses consistently", async (status) => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      expect(request).toMatchObject({ model: "gpt-6-luna", service_tier: "fast", reasoning: { effort: "none" } });
      const payload = payloads[request.text.format.name];
      expect(payload).toBeDefined();
      return Response.json({ status, output: [
        { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "Let me consider those preferences." }] },
        { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: JSON.stringify(payload) }] }
      ] });
    });
    vi.stubGlobal("fetch", fetch);
    const request = { query: "warm comedy" };
    const rank = await new OpenAiRanker(config).rank({ request, candidates: [item] });
    const brief = await new OpenAiBriefParser(config).parse({ query: request.query, deterministicIntent: parseRecommendationIntent(request.query), explicitFilters: {}, watchContext: "solo" });
    const optimized = await new OpenAiQueryOptimizer(config).optimize({ query: request.query, filters: {}, watchContext: "solo" });
    const scout = await new OpenAiTasteScout(config).scout({ request, watchContext: "solo", candidates: [item], feedbackItems: { moreLike: [], lessLike: [] } });
    expect([rank.usedAi, brief.usedAi, optimized.usedAi, scout.usedAi]).toEqual(Array(4).fill(status === "completed"));
    if (status === "completed") {
      expect(rank.results).toEqual([item]);
      expect(brief.signals?.moods).toEqual(["warm"]);
      expect(optimized.query).toBe("A warm comedy");
      expect(scout.recommendations[0]?.id).toBe(item.id);
    }
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("rejects active and retained secrets from every provider text stage", async () => {
    const reflectedPayloads: Record<string, unknown> = {
      moodarr_ranking: {
        summary: "Try retained-openai-key picks.",
        scores: { c0: 95 },
        refinementOptions
      },
      moodarr_recommendation_brief: { moods: ["abc"], terms: ["comedy"], hardFilters: {} },
      moodarr_taste_scout: {
        summary: "A warm pick.",
        recommendations: [{ id: "movie:1", score: 95, reason: "Contains retained-openai-key." }]
      }
    };
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      const text = request.text.format.name === "moodarr_optimized_query"
        ? '{"query":"A warm comedy with test\\u002donly"}'
        : JSON.stringify(reflectedPayloads[request.text.format.name]);
      return Response.json({ status: "completed", service_tier: "retained-openai-key", output: [
        { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text }] }
      ] });
    });
    vi.stubGlobal("fetch", fetch);

    const request = { query: "warm comedy" };
    const rank = await new OpenAiRanker(config).rank({ request, candidates: [item] });
    const brief = await new OpenAiBriefParser(config).parse({ query: request.query, deterministicIntent: parseRecommendationIntent(request.query), explicitFilters: {}, watchContext: "solo" });
    const optimized = await new OpenAiQueryOptimizer(config).optimize({ query: request.query, filters: {}, watchContext: "solo" });
    const scout = await new OpenAiTasteScout(config).scout({ request, watchContext: "solo", candidates: [item], feedbackItems: { moreLike: [], lessLike: [] } });

    expect(rank).toMatchObject({ usedAi: false, results: [item], failureReason: "reflected_known_secret" });
    expect(brief).toEqual({ usedAi: false });
    expect(optimized).toEqual({ usedAi: false, query: "warm comedy" });
    expect(scout).toEqual({ usedAi: false, recommendations: [] });
    expect(JSON.stringify({ rank, brief, optimized, scout })).not.toContain("openai-key");
    expect(JSON.stringify({ rank, brief, optimized, scout })).not.toContain("test-only");
  });
});
