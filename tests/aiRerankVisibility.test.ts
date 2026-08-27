import { describe, expect, it, vi } from "vitest";
import type { BriefParser } from "../src/server/ai/briefParser";
import type { AiRanker } from "../src/server/ai/ranker";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { fixturePlexItems } from "../src/server/fixtures/media";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { RecommendationEngine } from "../src/server/recommendation/engine";

const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;

describe("AI rerank fallback visibility", () => {
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
    db.close();
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
      fallbacks: 1
    });
    expect(diagnostics.recentRuns[0]?.aiRerank).toEqual({
      requested: true,
      status: "fallback",
      failureCategory: "http_failure"
    });
    expect(diagnostics.recentRuns.at(-1)?.aiRerank).toBeUndefined();
    db.close();
  });
});
