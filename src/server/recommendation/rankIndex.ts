import type { ItemDetail, SearchRequest, WatchContext } from "../../shared/types";
import type { RecommendationScoringResult, ScoringContext } from "./scoring";
import { scoreLibraryCandidates } from "./scoring";
import type { RetrievalContext, RetrievalResult } from "./retrieval";

export interface LibraryRankIndex {
  libraryItemCount: number;
  indexedItemCount: number;
  sourceCandidateCount: number;
  scoredItemCount: number;
  rankIndexScores: Map<string, number>;
  rankIndexRanks: Map<string, number>;
  topItemIds: string[];
}

export interface RankIndexedScoringResult extends RecommendationScoringResult {
  rankIndex: LibraryRankIndex;
}

export function scoreRankIndexedLibrary(
  retrieved: RetrievalResult,
  request: SearchRequest,
  watchContext: WatchContext,
  context: Omit<ScoringContext, "rankIndexRanks" | "rankIndexScores" | "allItems"> = {}
): RankIndexedScoringResult {
  const rankIndex = buildLibraryRankIndex(retrieved.candidates, retrieved.context);
  const scored = scoreLibraryCandidates(retrieved.candidates, request.query, request.filters ?? {}, watchContext, {
    ...retrieved.context,
    ...context,
    allItems: retrieved.candidates,
    rankIndexScores: rankIndex.rankIndexScores,
    rankIndexRanks: rankIndex.rankIndexRanks
  });

  return {
    ...scored,
    rankIndex: {
      ...rankIndex,
      scoredItemCount: scored.results.length
    }
  };
}

export function scoreMoodRankV3RetrievedCandidates(
  retrieved: RetrievalResult,
  request: SearchRequest,
  watchContext: WatchContext,
  context: ScoringContext = {}
): RecommendationScoringResult {
  return scoreLibraryCandidates(retrieved.candidates, request.query, request.filters ?? {}, watchContext, {
    ...retrieved.context,
    ...context,
    allItems: retrieved.allItems
  });
}

export function buildLibraryRankIndex(items: ItemDetail[], context: RetrievalContext): LibraryRankIndex {
  const rankMaps = {
    lexical: rankMapFromScores(context.lexicalRanks),
    semantic: rankMapFromScores(context.semanticScores),
    providerEmbedding: rankMapFromScores(context.providerEmbeddingScores),
    catalogRank: rankMapFromScores(context.catalogRankScores),
    mood: rankMapFromScores(context.moodScores),
    feedback: rankMapFromScores(nonNeutralScores(context.feedbackScores, 50)),
    quality: rankMapFromScores(context.qualityScores)
  };
  const rankIndexScores = new Map<string, number>();
  const rankIndexRanks = new Map<string, number>();

  for (const item of items) {
    const semanticScore = Math.max(context.semanticScores.get(item.id) ?? 0, context.providerEmbeddingScores.get(item.id) ?? 0);
    const catalogRankScore = context.catalogRankScores.get(item.id) ?? 0;
    const score =
      (context.lexicalRanks.get(item.id) ?? 44) * 0.12 +
      semanticScore * 0.22 +
      (context.moodScores.get(item.id) ?? 50) * 0.2 +
      (context.feedbackScores.get(item.id) ?? 50) * 0.12 +
      (context.qualityScores.get(item.id) ?? 50) * 0.1 +
      availabilityIndexScore(item) * 0.08 +
      catalogRankScore * 0.04 +
      rankPercentile(item.id, rankMaps.lexical, items.length) * 0.07 +
      rankPercentile(item.id, rankMaps.semantic, items.length) * 0.04 +
      rankPercentile(item.id, rankMaps.providerEmbedding, items.length) * 0.02 +
      rankPercentile(item.id, rankMaps.catalogRank, items.length) * (catalogRankScore > 0 ? 0.02 : 0) +
      rankPercentile(item.id, rankMaps.mood, items.length) * 0.03;
    rankIndexScores.set(item.id, clamp(score));
  }

  const rankedIds = [...rankIndexScores.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([id]) => id);
  rankedIds.forEach((id, index) => rankIndexRanks.set(id, index + 1));

  return {
    libraryItemCount: context.sourceCounts.all,
    indexedItemCount: rankIndexScores.size,
    sourceCandidateCount: context.sourceCounts.selected,
    scoredItemCount: 0,
    rankIndexScores,
    rankIndexRanks,
    topItemIds: rankedIds.slice(0, 120)
  };
}

function rankMapFromScores(scores: Map<string, number>) {
  const rankMap = new Map<string, number>();
  [...scores.entries()]
    .filter(([, score]) => Number.isFinite(score))
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .forEach(([id], index) => rankMap.set(id, index + 1));
  return rankMap;
}

function nonNeutralScores(scores: Map<string, number>, neutral: number) {
  return new Map([...scores.entries()].filter(([, score]) => score !== neutral));
}

function rankPercentile(id: string, ranks: Map<string, number>, corpusSize: number) {
  const rank = ranks.get(id);
  if (!rank) return 0;
  const denominator = Math.max(1, Math.min(corpusSize, ranks.size));
  return clamp(100 - ((rank - 1) / denominator) * 100);
}

function availabilityIndexScore(item: ItemDetail) {
  if (item.availabilityGroup === "available_in_plex") return 96;
  if (item.availabilityGroup === "not_in_plex_requestable") return 74;
  if (item.availabilityGroup === "partially_available") return 58;
  if (item.availabilityGroup === "already_requested") return 46;
  return 28;
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}
