import crypto from "node:crypto";
import type { SearchFilters, SearchRequest } from "../../shared/types";
import type { AiRanker } from "../ai/ranker";
import type { MediaRepository } from "../db/mediaRepository";
import type { SeerrClient } from "../integrations/seerrClient";
import { RecommendationEngine } from "../recommendation/engine";
import { scoreLibraryCandidates } from "../recommendation/scoring";

export class SearchService extends RecommendationEngine {
  constructor(repository: MediaRepository, seerrClient: SeerrClient, ranker: AiRanker) {
    super(repository, seerrClient, ranker);
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
