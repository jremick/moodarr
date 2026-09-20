import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BriefParser } from "../src/server/ai/briefParser";
import { NoopRanker, OpenAiRanker, type AiRanker } from "../src/server/ai/ranker";
import { loadConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { fixturePlexItems } from "../src/server/fixtures/media";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import { SearchService } from "../src/server/search/searchService";

const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;

describe("AI rerank fallback visibility", () => {
  it.each(["deadline", "cancellation"] as const)("does not miscount a caller %s as a provider failure", async (kind) => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-ranker-abort-"));
    const db = createDatabase(":memory:");
    vi.stubEnv("MOODRANK_TRACE_WRITE", "strict");
    try {
      const config = loadConfig({
        NODE_ENV: "test", MOODARR_DATA_DIR: directory, MOODARR_FIXTURE_MODE: "true",
        AI_PROVIDER: "openai", OPENAI_API_KEY: "test-only-openai-key"
      });
      const repository = new MediaRepository(db);
      repository.upsertMany(fixturePlexItems.slice(0, 3));
      const caller = new AbortController();
      vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
        caller.abort(kind === "deadline"
          ? new DOMException("private caller deadline detail", "TimeoutError")
          : new Error("private caller cancellation detail"));
        init.signal!.throwIfAborted();
        throw new Error("Expected an aborted provider request.");
      }));
      const service = new SearchService(repository, seerrClient, new OpenAiRanker(config));
      const result = service.search({ query: "a warm comedy", resultLimit: 3, useAi: true }, { signal: caller.signal });
      if (kind === "deadline") {
        const response = await result;
        expect(response.aiRerank).toEqual({ requested: true, status: "fallback", failureCategory: "timeout" });
        expect(response.results).toHaveLength(3);
        const row = db.prepare("SELECT rerank_trace_json FROM recommendation_sessions WHERE id = ?")
          .get(response.sessionId!) as { rerank_trace_json: string };
        expect(JSON.parse(row.rerank_trace_json).failureDetails).toMatchObject({ reason: "caller_deadline" });
        expect(row.rerank_trace_json).not.toContain("private");
      } else {
        await expect(result).rejects.toMatchObject({ name: "AbortError", message: "Search cancelled." });
        expect(db.prepare("SELECT COUNT(*) AS total FROM recommendation_sessions").get()).toMatchObject({ total: 0 });
      }
      expect(repository.recommendationDiagnostics().aiRerankHealth).toMatchObject({
        attempts: kind === "deadline" ? 1 : 0,
        fallbacks: kind === "deadline" ? 1 : 0,
        failureCategories: { timeout: kind === "deadline" ? 1 : 0, request_failure: 0, malformed_or_truncated_output: 0 }
      });
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it.each(["off", "on", "strict"])("persists bounded failure details only when trace writing is enabled (%s)", async (traceWrite) => {
    const db = createDatabase(":memory:");
    vi.stubEnv("MOODRANK_TRACE_WRITE", traceWrite);
    try {
      const repository = new MediaRepository(db);
      repository.upsertMany(fixturePlexItems.slice(0, 3));
      const ranker: AiRanker = {
        rank: async ({ candidates }) => ({
          usedAi: false,
          results: candidates,
          failureCategory: "malformed_or_truncated_output",
          failureReason: "incomplete_response",
          providerDiagnostics: {
            requestedServiceTier: "default",
            receivedServiceTier: "untrusted-provider-text",
            responseStatus: "incomplete",
            incompleteReason: "max_output_tokens",
            outputTokens: 2400,
            reasoningTokens: 0,
            maxOutputTokens: 2400
          },
          trace: { serializedCandidateCount: candidates.length, rankedItems: [] }
        })
      };
      const response = await new RecommendationEngine(repository, seerrClient, ranker).recommend({
        query: "a warm comedy", resultLimit: 3, useAi: true
      });
      expect(response.aiRerank).toEqual({ requested: true, status: "fallback", failureCategory: "malformed_or_truncated_output" });
      expect(response.results).toHaveLength(3);
      expect(JSON.stringify(response)).not.toContain("failureDetails");
      const session = db.prepare("SELECT rerank_trace_json FROM recommendation_sessions WHERE id = ?")
        .get(response.sessionId!) as { rerank_trace_json: string | null };
      if (traceWrite === "off") {
        expect(session.rerank_trace_json).toBeNull();
      } else {
        expect(JSON.parse(session.rerank_trace_json!).failureDetails).toEqual({
          reason: "incomplete_response", responseStatus: "incomplete", incompleteReason: "max_output_tokens",
          outputTokens: 2400, reasoningTokens: 0, maxOutputTokens: 2400
        });
        expect(session.rerank_trace_json).not.toContain("untrusted-provider-text");
        expect(session.rerank_trace_json).not.toContain("a warm comedy");
      }
    } finally {
      db.close();
      vi.unstubAllEnvs();
    }
  });

  it("reports rerank fallback even when another AI stage succeeded", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    repository.upsertMany(fixturePlexItems.slice(0, 3));
    const ranker: AiRanker = {
      modelName: "test-model",
      rank: vi.fn(async ({ candidates }) => ({
        usedAi: false,
        results: candidates,
        failureCategory: "timeout" as const,
        trace: { serializedCandidateCount: candidates.length, rankedItems: [] }
      }))
    };
    const briefParser: BriefParser = {
      parse: vi.fn(async () => ({ usedAi: true }))
    };

    const response = await new RecommendationEngine(
      repository,
      seerrClient,
      ranker,
      undefined,
      briefParser
    ).recommend({ query: "a warm comedy", resultLimit: 3, useAi: true });

    expect(response.usedAi).toBe(true);
    expect(response.aiRerank).toEqual({
      requested: true,
      status: "fallback",
      failureCategory: "timeout"
    });
    expect(response.results).toHaveLength(3);
    expect(repository.recommendationDiagnostics().aiRerankHealth).toMatchObject({
      attempts: 1,
      applied: 0,
      fallbacks: 1
    });
    db.close();
  });

  it.each([undefined, true])("does not report a provider failure when reranking is unavailable (useAi=%s)", async (useAi) => {
    const db = createDatabase(":memory:");
    vi.stubEnv("MOODRANK_TRACE_WRITE", "strict");
    try {
      const repository = new MediaRepository(db);
      repository.upsertMany(fixturePlexItems.slice(0, 3));
      const ranker = new NoopRanker();
      const rank = vi.spyOn(ranker, "rank");

      const response = await new RecommendationEngine(repository, seerrClient, ranker).recommend({
        query: "something warm for date night",
        resultLimit: 3,
        ...(useAi === undefined ? {} : { useAi })
      });

      expect(rank).toHaveBeenCalledOnce();
      expect(response.usedAi).toBe(false);
      expect(response.results).toHaveLength(3);
      expect(response.aiRerank).toEqual({ requested: false, status: "not_requested" });
      const diagnostics = repository.recommendationDiagnostics();
      expect(diagnostics.sessions).toMatchObject({
        total: 1,
        rerankRequests: 0,
        rerankApplied: 0,
        rerankFallbacks: 0
      });
      expect(diagnostics.aiRerankHealth).toMatchObject({ attempts: 0, applied: 0, fallbacks: 0 });
      expect(diagnostics.recentRuns[0]?.aiRerank).toEqual(response.aiRerank);
      const session = db.prepare(
        "SELECT rerank_trace_json FROM recommendation_sessions WHERE id = ?"
      ).get(response.sessionId!) as { rerank_trace_json: string };
      expect(JSON.parse(session.rerank_trace_json)).toMatchObject({
        rerankRequested: false,
        serializedCandidateCount: 0,
        usedAi: false,
        failureCategory: "not_attempted"
      });
    } finally {
      db.close();
      vi.unstubAllEnvs();
    }
  });

  it("does not call or report a rerank when there are no candidates", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const rank = vi.fn(async ({ candidates }: Parameters<AiRanker["rank"]>[0]) => ({
      usedAi: true,
      results: candidates
    }));

    const response = await new RecommendationEngine(
      repository,
      seerrClient,
      { modelName: "test-model", rank }
    ).recommend({ query: "anything", useAi: true });

    expect(rank).not.toHaveBeenCalled();
    expect(response.aiRerank).toEqual({ requested: false, status: "not_requested" });
    db.close();
  });

  it("persists current rerank outcomes without inventing status for legacy rows", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const base = {
      engineVersion: "test-engine",
      model: "test-model",
      watchContext: "solo" as const,
      resultCount: 0,
      candidateCount: 0,
      rerankCandidateCount: 0,
      usedAi: false,
      seerrAugmented: false,
      latencyMs: 10,
      results: []
    };

    const legacyId = repository.recordRecommendationRun({ query: "legacy", ...base });
    repository.recordRecommendationRun({
      query: "applied",
      ...base,
      usedAi: true,
      aiRerank: { requested: true, status: "applied" }
    });
    repository.recordRecommendationRun({
      query: "fallback",
      ...base,
      aiRerank: { requested: true, status: "fallback", failureCategory: "http_failure" }
    });

    const legacy = db.prepare(
      "SELECT rerank_requested, rerank_used_ai, rerank_failure_category FROM recommendation_sessions WHERE id = ?"
    ).get(legacyId);
    expect(legacy).toEqual({
      rerank_requested: null,
      rerank_used_ai: null,
      rerank_failure_category: null
    });

    const diagnostics = repository.recommendationDiagnostics();
    expect(diagnostics.sessions).toMatchObject({
      total: 3,
      rerankRequests: 2,
      rerankApplied: 1,
      rerankFallbacks: 1
    });
    expect(diagnostics.aiRerankHealth).toEqual({
      windowHours: 24,
      attempts: 2,
      applied: 1,
      fallbacks: 1,
      failureCategories: {
        not_attempted: 0,
        timeout: 0,
        http_failure: 1,
        malformed_or_truncated_output: 0,
        empty_ranking: 0,
        request_failure: 0
      }
    });
    expect(diagnostics.recentRuns[0]?.aiRerank).toEqual({
      requested: true,
      status: "fallback",
      failureCategory: "http_failure"
    });
    expect(diagnostics.recentRuns.at(-1)?.aiRerank).toBeUndefined();
    db.close();
  });

  it("aggregates categorized rerank failures only within the 24-hour diagnostics window", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const base = {
      engineVersion: "test-engine",
      model: "test-model",
      watchContext: "solo" as const,
      resultCount: 0,
      candidateCount: 0,
      rerankCandidateCount: 0,
      usedAi: false,
      seerrAugmented: false,
      latencyMs: 10,
      results: []
    };

    repository.recordRecommendationRun({
      query: "timeout",
      ...base,
      aiRerank: { requested: true, status: "fallback", failureCategory: "timeout" }
    });
    repository.recordRecommendationRun({
      query: "malformed",
      ...base,
      aiRerank: { requested: true, status: "fallback", failureCategory: "malformed_or_truncated_output" }
    });
    const expiredId = repository.recordRecommendationRun({
      query: "expired",
      ...base,
      aiRerank: { requested: true, status: "fallback", failureCategory: "http_failure" }
    });
    db.prepare("UPDATE recommendation_sessions SET created_at = ? WHERE id = ?").run(
      new Date(Date.now() - 25 * 60 * 60 * 1_000).toISOString(),
      expiredId
    );

    expect(repository.recommendationDiagnostics().aiRerankHealth).toEqual({
      windowHours: 24,
      attempts: 2,
      applied: 0,
      fallbacks: 2,
      failureCategories: {
        not_attempted: 0,
        timeout: 1,
        http_failure: 0,
        malformed_or_truncated_output: 1,
        empty_ranking: 0,
        request_failure: 0
      }
    });
    db.close();
  });
});
