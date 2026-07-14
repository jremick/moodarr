import crypto from "node:crypto";
import type { SearchFilters, SearchRequest } from "../../shared/types";
import type { BriefParser } from "../ai/briefParser";
import type { EmbeddingProvider } from "../ai/embeddings";
import type { AiRanker } from "../ai/ranker";
import type { QueryOptimizer } from "../ai/queryOptimizer";
import type { TasteScout } from "../ai/tasteScout";
import type { MediaRepository, QueryReviewRetention } from "../db/mediaRepository";
import type { SeerrClient } from "../integrations/seerrClient";
import { RecommendationEngine } from "../recommendation/engine";
import { scoreLibraryCandidates } from "../recommendation/scoring";
import type { AppConfig } from "../config";
import { createBriefParser } from "../ai/briefParser";
import { createEmbeddingProvider } from "../ai/embeddings";
import { createQueryOptimizer } from "../ai/queryOptimizer";
import { createRanker } from "../ai/ranker";
import { createTasteScout } from "../ai/tasteScout";

export class SearchService extends RecommendationEngine {
  constructor(
    repository: MediaRepository,
    seerrClient: SeerrClient,
    ranker: AiRanker,
    embeddingProvider?: EmbeddingProvider,
    briefParser?: BriefParser,
    tasteScout?: TasteScout,
    queryOptimizer?: QueryOptimizer,
    reviewQueue?: QueryReviewRetention
  ) {
    super(repository, seerrClient, ranker, embeddingProvider, briefParser, tasteScout, queryOptimizer, reviewQueue);
  }

  async search(request: SearchRequest, context: { authUserId?: string; signal?: AbortSignal } = {}) {
    return this.recommend(request, context);
  }
}

export function rankDeterministically(items: Parameters<typeof scoreLibraryCandidates>[0], query: string, filters: SearchFilters) {
  return scoreLibraryCandidates(items, query, filters, "solo").results;
}

export function hashQuery(query: string) {
  return crypto.createHash("sha256").update(query.toLowerCase().trim()).digest("hex");
}

export function createConfiguredSearchService(config: AppConfig, repository: MediaRepository, seerrClient: SeerrClient) {
  return new SearchService(
    repository,
    seerrClient,
    createRanker(config),
    createEmbeddingProvider(config),
    createBriefParser(config),
    createTasteScout(config),
    createQueryOptimizer(config),
    config.reviewQueue
  );
}
