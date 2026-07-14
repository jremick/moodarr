import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBriefParser,
  DeterministicBriefParser,
  OpenAiBriefParser
} from "../src/server/ai/briefParser";
import { createEmbeddingProvider, NoopEmbeddingProvider, OpenAiEmbeddingProvider } from "../src/server/ai/embeddings";
import { createQueryOptimizer, DeterministicQueryOptimizer, OpenAiQueryOptimizer } from "../src/server/ai/queryOptimizer";
import { createRanker, NoopRanker, OpenAiRanker } from "../src/server/ai/ranker";
import { createTasteScout, NoopTasteScout, OpenAiTasteScout } from "../src/server/ai/tasteScout";
import type { AppConfig } from "../src/server/config";

afterEach(() => vi.unstubAllGlobals());

describe("release AI provider policy", () => {
  it("keeps every provider factory local for a hostile config narrowed to none", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const config = {
      ai: {
        providerPolicy: "none",
        provider: "openai",
        openaiApiKey: "test-openai-key-secret",
        openaiModel: "gpt-5.5",
        openaiEmbeddingModel: "text-embedding-3-large",
        openaiReasoningEffort: "low"
      }
    } as AppConfig;

    const parser = createBriefParser(config);
    const optimizer = createQueryOptimizer(config);
    const scout = createTasteScout(config);
    const ranker = createRanker(config);
    const embeddings = createEmbeddingProvider(config);

    expect(parser).toBeInstanceOf(DeterministicBriefParser);
    expect(parser).not.toBeInstanceOf(OpenAiBriefParser);
    expect(optimizer).toBeInstanceOf(DeterministicQueryOptimizer);
    expect(optimizer).not.toBeInstanceOf(OpenAiQueryOptimizer);
    expect(scout).toBeInstanceOf(NoopTasteScout);
    expect(scout).not.toBeInstanceOf(OpenAiTasteScout);
    expect(ranker).toBeInstanceOf(NoopRanker);
    expect(ranker).not.toBeInstanceOf(OpenAiRanker);
    expect(embeddings).toBeInstanceOf(NoopEmbeddingProvider);
    expect(embeddings).not.toBeInstanceOf(OpenAiEmbeddingProvider);

    await parser.parse({} as never);
    await optimizer.optimize({ query: "warm comedy", filters: {}, watchContext: "solo" });
    await scout.scout({} as never);
    await ranker.rank({ candidates: [] } as never);
    await embeddings.embed(["local feature text"]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
