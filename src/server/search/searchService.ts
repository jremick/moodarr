import crypto from "node:crypto";
import type { SearchFilters, SearchRequest } from "../../shared/types";
import type { BriefParser } from "../ai/briefParser";
import type { EmbeddingProvider } from "../ai/embeddings";
import type { AiRanker } from "../ai/ranker";
import type { TasteScout } from "../ai/tasteScout";
import type { MediaRepository } from "../db/mediaRepository";
import type { SeerrClient } from "../integrations/seerrClient";
import { RecommendationEngine } from "../recommendation/engine";
import { scoreLibraryCandidates } from "../recommendation/scoring";

export class SearchService extends RecommendationEngine {
  constructor(
    repository: MediaRepository,
    seerrClient: SeerrClient,
    ranker: AiRanker,
    embeddingProvider?: EmbeddingProvider,
    briefParser?: BriefParser,
    tasteScout?: TasteScout
  ) {
    super(repository, seerrClient, ranker, embeddingProvider, briefParser, tasteScout);
  }

  async search(request: SearchRequest) {
    return this.recommend(request);
  }
}

export function rankDeterministically(items: Parameters<typeof scoreLibraryCandidates>[0], query: string, filters: SearchFilters) {
  return scoreLibraryCandidates(items, query, filters, "solo").results;
}

export function hashQuery(query: string) {
  return crypto.createHash("sha256").update(query.toLowerCase().trim()).digest("hex");
}
