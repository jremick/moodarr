import type { ItemSummary, SearchRequest, SearchResponse, WatchContext } from "../../shared/types";
import type { AiRanker } from "../ai/ranker";
import type { MediaRepository } from "../db/mediaRepository";
import type { SeerrClient } from "../integrations/seerrClient";
import { scoreLibraryCandidates, seerrSearchQueries, selectRerankCandidates, shouldAugmentWithSeerr } from "./scoring";

export class RecommendationEngine {
  constructor(
    private readonly repository: MediaRepository,
    private readonly seerrClient: SeerrClient,
    private readonly ranker: AiRanker
  ) {}

  async recommend(request: SearchRequest): Promise<SearchResponse> {
    const resultLimit = clampResultLimit(request.resultLimit);
    const watchContext = normalizeWatchContext(request.watchContext);
    let scored = scoreLibraryCandidates(this.repository.list(), request.query, request.filters ?? {}, watchContext);

    if (shouldAugmentWithSeerr(scored.results, resultLimit, scored.intent, scored.filters)) {
      const seerrRecords = (
        await Promise.all(
          seerrSearchQueries(scored.intent).map((query) =>
            this.seerrClient.search(query).catch(() => [])
          )
        )
      ).flat();
      if (seerrRecords.length > 0) {
        this.repository.upsertMany(seerrRecords);
        scored = scoreLibraryCandidates(this.repository.list(), request.query, request.filters ?? {}, watchContext);
      }
    }

    const rerankCandidates = selectRerankCandidates(scored.results, resultLimit);
    const ranked = request.useAi === false
      ? { usedAi: false, results: rerankCandidates }
      : await this.ranker.rank({
          request: {
            ...request,
            filters: scored.filters,
            watchContext
          },
          candidates: rerankCandidates
        });
    const results = mergeRankedResults(ranked.results, scored.results).slice(0, resultLimit);
    this.repository.recordSearch(request.query, results.length, ranked.usedAi);

    return {
      query: request.query,
      usedAi: ranked.usedAi,
      results,
      groups: {
        available_in_plex: results.filter((item) => item.availabilityGroup === "available_in_plex"),
        not_in_plex_requestable: results.filter((item) => item.availabilityGroup === "not_in_plex_requestable"),
        already_requested: results.filter((item) => item.availabilityGroup === "already_requested"),
        partially_available: results.filter((item) => item.availabilityGroup === "partially_available"),
        unavailable: results.filter((item) => item.availabilityGroup === "unavailable")
      }
    };
  }
}

function mergeRankedResults(ranked: ItemSummary[], deterministic: ItemSummary[]) {
  const rankedIds = new Set(ranked.map((item) => item.id));
  return [...ranked, ...deterministic.filter((item) => !rankedIds.has(item.id))];
}

function clampResultLimit(value: number | undefined) {
  if (!value) return 20;
  return Math.max(1, Math.min(50, value));
}

function normalizeWatchContext(value: WatchContext | undefined): WatchContext {
  return value === "group" ? "group" : "solo";
}
