import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { DatabaseSync } from "node:sqlite";
import { openAiFetch, sharedOpenAiDispatcher } from "../src/server/ai/openAiHttp";
import type { BriefParser } from "../src/server/ai/briefParser";
import type { EmbeddingProvider } from "../src/server/ai/embeddings";
import { NoopRanker } from "../src/server/ai/ranker";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository, type IngestMediaRecord } from "../src/server/db/mediaRepository";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import { isSimpleRecommendationQuery } from "../src/server/recommendation/intent";
import { retrievalBriefSignature } from "../src/server/recommendation/retrieval";
import {
  BriefCache,
  briefCacheKey,
  briefQueryHasSensitiveText,
  coordinateSearchLatency,
  normalizeBriefQuery
} from "../src/server/recommendation/searchLatency";
import type { RecommendationBrief } from "../src/server/recommendation/brief";
import { buildRecommendationBrief } from "../src/server/recommendation/brief";
import { parseRecommendationIntent } from "../src/server/recommendation/intent";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  vi.unstubAllGlobals();
});

describe("search brief cache keys", () => {
  it("hashes a normalised query and leaves the raw text out of the key", () => {
    const query = "  Cozy   Comedy for Ada Lovelace <person@example.com> ";
    const left = briefCacheKey({ query, watchContext: "solo", explicitFilters: {}, parserModel: "gpt-test" });
    const right = briefCacheKey({
      query: "cozy comedy for ada lovelace <person@example.com>",
      watchContext: "solo",
      explicitFilters: {},
      parserModel: "gpt-test"
    });

    expect(left).toBe(right);
    expect(left).toMatch(/^[0-9a-f]{64}$/);
    expect(left).not.toContain("lovelace");
    expect(left).not.toContain("@");
    expect(left).not.toContain(normalizeBriefQuery(query));
    expect(briefCacheKey({ query, watchContext: "group", explicitFilters: {}, parserModel: "gpt-test" })).not.toBe(left);
    expect(briefCacheKey({
      query,
      watchContext: "solo",
      explicitFilters: { mediaTypes: ["movie"] },
      parserModel: "gpt-test"
    })).not.toBe(left);
    expect(briefQueryHasSensitiveText(query)).toBe(true);
    expect(briefQueryHasSensitiveText("cozy comedy")).toBe(false);
  });

  it("drops expired briefs and caps the cache", () => {
    const cache = new BriefCache(1_000, 2);
    cache.set("a", { usedAi: true, signals: { moods: ["a"] } }, 0);
    cache.set("b", { usedAi: true, signals: { moods: ["b"] } }, 0);
    cache.set("c", { usedAi: true, signals: { moods: ["c"] } }, 0);
    expect(cache.get("a", 10)).toBeUndefined();
    expect(cache.get("b", 10)?.signals?.moods).toEqual(["b"]);
    expect(cache.get("b", 2_000)).toBeUndefined();
  });
});

describe("simple recommendation queries", () => {
  it("keeps explicit mood and genre wording on the fast path", () => {
    expect(isSimpleRecommendationQuery("cozy comedy")).toBe(true);
    expect(isSimpleRecommendationQuery("  Feel-good   comedy ")).toBe(true);
    expect(isSimpleRecommendationQuery("warm movies for tonight")).toBe(true);
  });

  it("keeps implicit, negated, and reference queries on the model path", () => {
    expect(isSimpleRecommendationQuery("quick cozy options")).toBe(false);
    expect(isSimpleRecommendationQuery("not horror")).toBe(false);
    expect(isSimpleRecommendationQuery("something like Paddington")).toBe(false);
    expect(isSimpleRecommendationQuery("comedy under two hours")).toBe(false);
  });
});

describe("parallel brief and retrieval", () => {
  it("overlaps a matching brief with retrieval", async () => {
    const cache = new BriefCache();
    const started = performance.now();
    const result = await coordinateSearchLatency({
      useAi: true,
      query: "a complicated mood that needs the model",
      watchContext: "solo",
      explicitFilters: {},
      cache,
      briefBudgetMs: 2_000,
      compose: (parsed) => briefFrom(parsed.signals?.moods ?? ["cozy"]),
      signature: (resolved) => retrievalBriefSignature(resolved),
      parse: async () => {
        await delay(120);
        return { usedAi: false };
      },
      retrieve: async (resolved) => {
        await delay(160);
        return resolved.softSignals.moods.join(" ");
      }
    });
    const elapsed = performance.now() - started;

    expect(result.retrievalPlan).toBe("speculative");
    expect(result.partialResult).toBe(false);
    expect(result.retrieved).toBe("cozy");
    expect(result.timings.overlapMs).toBeGreaterThan(60);
    expect(elapsed).toBeLessThan(result.timings.briefMs + result.timings.retrievalMs - 40);
  });

  it("retrieves again when the parsed brief changes the candidate query", async () => {
    const seen: string[] = [];
    const result = await coordinateSearchLatency({
      useAi: true,
      query: "a complicated mood that needs the model",
      watchContext: "solo",
      explicitFilters: {},
      cache: new BriefCache(),
      briefBudgetMs: 2_000,
      compose: (parsed) => briefFrom(parsed.signals?.moods ?? ["cozy"]),
      signature: (resolved) => retrievalBriefSignature(resolved),
      parse: async () => {
        await delay(30);
        return { usedAi: true, signals: { moods: ["wistful"] } };
      },
      retrieve: async (resolved, signal) => {
        seen.push(resolved.softSignals.moods.join(" "));
        await delay(40, signal);
        return resolved.softSignals.moods.join(" ");
      }
    });

    expect(result.retrievalPlan).toBe("refreshed");
    expect(result.briefPath).toBe("parsed");
    expect(result.retrieved).toBe("wistful");
    expect(seen).toContain("wistful");
    expect(result.timings.speculativeRetrievalMs).toBeGreaterThan(0);
  });

  it("returns the speculative retrieval when the brief budget expires", async () => {
    const started = performance.now();
    const result = await coordinateSearchLatency({
      useAi: true,
      query: "a complicated mood that needs the model",
      watchContext: "solo",
      explicitFilters: {},
      cache: new BriefCache(),
      briefBudgetMs: 40,
      compose: (parsed) => briefFrom(parsed.usedAi ? ["wistful"] : ["cozy"]),
      signature: (resolved) => retrievalBriefSignature(resolved),
      parse: (signal) => new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ usedAi: true, signals: { moods: ["wistful"] } }), 400);
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve({ usedAi: false });
        }, { once: true });
      }),
      retrieve: async (resolved) => {
        await delay(30);
        return resolved.softSignals.moods.join(" ");
      }
    });

    expect(result.briefPath).toBe("timeout");
    expect(result.partialResult).toBe(true);
    expect(result.retrievalPlan).toBe("speculative");
    expect(result.retrieved).toBe("cozy");
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("skips the parser for a simple query and reuses a cached brief", async () => {
    const cache = new BriefCache();
    const parse = vi.fn(async () => ({ usedAi: true as const, signals: { moods: ["wistful"] } }));
    const fast = await coordinateSearchLatency({
      useAi: undefined,
      query: "cozy comedy",
      watchContext: "solo",
      explicitFilters: {},
      cache,
      compose: (parsed) => briefFrom(parsed.signals?.moods ?? ["cozy"]),
      signature: (resolved) => retrievalBriefSignature(resolved),
      parse,
      retrieve: async (resolved) => resolved.softSignals.moods.join(" ")
    });
    expect(fast.briefPath).toBe("fast_path");
    expect(parse).not.toHaveBeenCalled();

    const first = await coordinateSearchLatency({
      useAi: true,
      query: "quick cozy options",
      watchContext: "solo",
      explicitFilters: {},
      cache,
      compose: (parsed) => briefFrom(parsed.signals?.moods ?? ["cozy"]),
      signature: (resolved) => retrievalBriefSignature(resolved),
      parse,
      retrieve: async (resolved) => resolved.softSignals.moods.join(" ")
    });
    const second = await coordinateSearchLatency({
      useAi: true,
      query: "Quick   cozy options",
      watchContext: "solo",
      explicitFilters: {},
      cache,
      compose: (parsed) => briefFrom(parsed.signals?.moods ?? ["cozy"]),
      signature: (resolved) => retrievalBriefSignature(resolved),
      parse,
      retrieve: async (resolved) => resolved.softSignals.moods.join(" ")
    });

    expect(first.briefCache).toBe("miss");
    expect(first.retrieved).toBe("wistful");
    expect(second.briefPath).toBe("cache");
    expect(second.briefCache).toBe("hit");
    expect(second.retrieved).toBe("wistful");
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("does not cache a query that contains an email address", async () => {
    const cache = new BriefCache();
    const parse = vi.fn(async () => ({ usedAi: true as const, signals: { moods: ["wistful"] } }));
    const input = {
      useAi: true as const,
      query: "cozy comedy for person@example.com",
      watchContext: "solo" as const,
      explicitFilters: {},
      cache,
      compose: (parsed: { usedAi: boolean; signals?: { moods?: string[] } }) => briefFrom(parsed.signals?.moods ?? ["cozy"]),
      signature: (resolved: RecommendationBrief) => retrievalBriefSignature(resolved),
      parse,
      retrieve: async (resolved: RecommendationBrief) => resolved.softSignals.moods.join(" ")
    };
    await coordinateSearchLatency(input);
    await coordinateSearchLatency(input);
    expect(parse).toHaveBeenCalledTimes(2);
  });
});

describe("recommendation engine search latency", () => {
  it("overlaps the model brief with retrieval and reports the diagnostics", async () => {
    const { repository } = engineFor();
    const parser: BriefParser = {
      parse: vi.fn(async () => {
        await delay(150);
        return { usedAi: false };
      })
    };
    const started = performance.now();
    const response = await new RecommendationEngine(
      repository,
      quietSeerr(),
      new NoopRanker(),
      slowEmbeddings(150),
      parser
    ).recommend({ query: "cozy comedy", resultLimit: 5, useAi: true });
    const elapsed = performance.now() - started;

    expect(parser.parse).toHaveBeenCalledOnce();
    expect(response.diagnostics?.briefPath).toBe("deterministic");
    expect(response.diagnostics?.retrievalPlan).toBe("speculative");
    expect(response.diagnostics?.partialResult).toBe(false);
    expect(response.diagnostics?.stageLatencyMs?.briefRetrievalOverlap).toBeGreaterThan(40);
    expect(elapsed).toBeLessThan(260);
    expect(response.results.length).toBeGreaterThan(0);
  });

  it("does not call the brief parser for a simple default search", async () => {
    const { repository } = engineFor();
    const parser: BriefParser = { parse: vi.fn(async () => ({ usedAi: true, signals: { moods: ["wistful"] } })) };
    const response = await new RecommendationEngine(repository, quietSeerr(), new NoopRanker(), undefined, parser).recommend({
      query: "cozy comedy",
      resultLimit: 5
    });

    expect(parser.parse).not.toHaveBeenCalled();
    expect(response.diagnostics).toMatchObject({ briefPath: "fast_path", briefCache: "bypass", aiBriefParsed: false, retrievalPlan: "direct" });
  });

  it("caches a parsed brief without putting the query in the diagnostics", async () => {
    const { repository } = engineFor();
    const parser: BriefParser = {
      parse: vi.fn(async () => ({
        usedAi: true,
        signals: { moods: ["wistful"], hardFilters: { maxRuntimeMinutes: 100, mediaTypes: ["movie" as const] } }
      }))
    };
    const engine = new RecommendationEngine(repository, quietSeerr(), new NoopRanker(), undefined, parser);
    const first = await engine.recommend({ query: "quick cozy options", resultLimit: 5 });
    const second = await engine.recommend({ query: "Quick   cozy options", resultLimit: 5 });

    expect(parser.parse).toHaveBeenCalledTimes(1);
    expect(first.diagnostics?.briefCache).toBe("miss");
    expect(first.diagnostics?.aiBriefParsed).toBe(true);
    expect(first.resolvedFilters.maxRuntimeMinutes).toBe(100);
    expect(second.diagnostics).toMatchObject({ briefPath: "cache", briefCache: "hit", aiBriefParsed: true });
    expect(second.resolvedFilters.maxRuntimeMinutes).toBe(100);
    expect(JSON.stringify(second.diagnostics)).not.toContain("quick cozy");
  });
});

describe("OpenAI connection reuse", () => {
  it("sends OpenAI requests through one shared dispatcher", async () => {
    const seen: Array<RequestInit & { dispatcher?: unknown }> = [];
    const fetchMock = vi.fn(async (...args: [string, (RequestInit & { dispatcher?: unknown })?]) => {
      const init = args[1];
      if (init) seen.push(init);
      return new Response("{}", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await openAiFetch("https://api.openai.com/v1/responses", { method: "POST" });
    await openAiFetch("https://api.openai.com/v1/embeddings", { method: "POST" });
    const first = seen[0];
    const second = seen[1];
    expect(first?.dispatcher).toBe(sharedOpenAiDispatcher());
    expect(second?.dispatcher).toBe(first?.dispatcher);
  });

  it("reuses one socket for two sequential OpenAI fetches", async () => {
    const ports: number[] = [];
    const server = createServer((request, response) => {
      ports.push(request.socket.remotePort ?? 0);
      response.end("ok");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    try {
      const { port } = server.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}/`;
      await (await openAiFetch(url)).text();
      await (await openAiFetch(url)).text();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await (await openAiFetch(url)).text();
      expect(ports).toHaveLength(3);
      expect(new Set(ports.slice(0, 2)).has(ports[2] ?? 0)).toBe(true);
      expect(ports[2]).not.toBe(0);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});

function briefFrom(moods: string[]): RecommendationBrief {
  const query = "cozy comedy";
  const intent = parseRecommendationIntent(query);
  const brief = buildRecommendationBrief({ query, watchContext: "solo" }, intent, intent.hardFilters, "solo", 5);
  return { ...brief, softSignals: { ...brief.softSignals, moods } };
}

function engineFor() {
  const db = createDatabase(":memory:");
  databases.push(db);
  const repository = new MediaRepository(db);
  repository.upsertIntegrationRecords([record("Cozy Harbor")]);
  return { repository };
}

function record(title: string): IngestMediaRecord {
  return {
    title,
    mediaType: "movie",
    year: 2018,
    runtimeMinutes: 90,
    summary: "A warm cozy comedy about neighbors.",
    genres: ["Comedy"],
    cast: [],
    directors: [],
    ratings: { critic: 80, audience: 82 },
    externalIds: { tmdb: 424242 },
    plex: { ratingKey: title, guid: `test:${title}`, libraryTitle: "Test", libraryType: "movie", available: true }
  };
}

function quietSeerr() {
  return { search: vi.fn(async () => []), allowsDescriptiveContent: () => false } as unknown as SeerrClient;
}

function slowEmbeddings(ms: number): EmbeddingProvider {
  return {
    providerName: "openai",
    modelName: "test-embeddings",
    outputDimensions: 4,
    configured: true,
    async embed(input) {
      await delay(ms);
      return input.map(() => [1, 0, 0, 0]);
    }
  };
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => resolve(), ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      const reason = signal.reason;
      reject(reason instanceof Error ? reason : new DOMException("The operation was aborted.", "AbortError"));
    }, { once: true });
  });
}
