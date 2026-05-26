import type { ItemSummary, SearchRequest, SearchResponse, WatchContext } from "../../shared/types";
import { describeRuntimeRange } from "../../shared/runtime";
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
    const summary = ranked.summary || buildSearchSummary(scored.filters, watchContext, resultLimit, results);

    return {
      query: request.query,
      usedAi: ranked.usedAi,
      summary,
      resolvedFilters: scored.filters,
      watchContext,
      resultLimit,
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

function buildSearchSummary(filters: SearchRequest["filters"] = {}, watchContext: WatchContext, resultLimit: number, results: ItemSummary[]) {
  const filterSummary = describeFilters(filters, watchContext, resultLimit);
  if (results.length === 0) {
    return `I’m filtering for ${filterSummary}, but I don’t have a strong match in the cached Plex and Seerr data yet. Try loosening the runtime, availability, or style constraints.`;
  }

  const topTitles = formatList(results.slice(0, 3).map((item) => item.title));
  const availability = results.some((item) => item.availabilityGroup !== "available_in_plex")
    ? "I’m also keeping request status visible where Plex does not already have the item."
    : "Everything shown first is already available in Plex.";
  return `I’m filtering for ${filterSummary}. I’m recommending ${topTitles} first because they best match the request across availability, runtime, ratings, and metadata. ${availability}`;
}

function describeFilters(filters: SearchRequest["filters"] = {}, watchContext: WatchContext, resultLimit: number) {
  return formatList([
    filters.mediaTypes?.length === 1 ? (filters.mediaTypes[0] === "movie" ? "movies" : "TV") : "movies and TV",
    filters.availability?.length === 1 && filters.availability[0] === "available_in_plex" ? "available in Plex" : "Plex plus Seerr request options",
    describeRuntimeRange(filters),
    filters.genres?.length ? `${formatList(filters.genres)} style` : "any style",
    watchContext === "group" ? "watching together" : "for me",
    `${resultLimit} results`
  ]);
}

function formatList(values: string[]) {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}
