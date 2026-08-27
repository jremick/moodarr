import { createHash } from "node:crypto";
import type { ItemSummary, SearchRequest, WatchContext } from "../../shared/types";
import type { AiRankerResult, AiRankerTrace } from "../ai/ranker";
import type { RecommendationBrief } from "./brief";
import type { RankIndexedScoringResult } from "./rankIndex";
import type { RetrievalContext, RetrievalResult } from "./retrieval";
import { recommendationEngineVersion } from "./version";

export const moodRankTraceSchemaVersion = "moodrank-trace-v1";
const maxTraceRejectionRows = 50;

export type TraceWriteMode = "off" | "on" | "strict";
export type ShadowMode = "off" | "shadow" | "on";
export type AdaptiveRetrievalMode = "legacy" | "shadow" | "on";
export type ExposureLoggingMode = "off" | "server_returned" | "client_visible";
export type AffectEnrichmentMode = "off" | "offline";

export interface MoodRankRunTraceFlags {
  traceWrite: TraceWriteMode;
  guardrailsV2: ShadowMode;
  adaptiveRetrieval: AdaptiveRetrievalMode;
  rerankV2: ShadowMode;
  exposureLogging: ExposureLoggingMode;
  affectEnrichment: AffectEnrichmentMode;
}

export interface SearchBriefTraceV1 {
  schemaVersion: typeof moodRankTraceSchemaVersion;
  briefVersion: "search-brief-trace-v1";
  rawQueryHash: string;
  optimizedQueryHash: string;
  queryChanged: boolean;
  watchContext: WatchContext;
  resultLimit: number;
  hardFilterSummary: {
    mediaTypes?: RecommendationBrief["hardFilters"]["mediaTypes"];
    minRuntimeMinutes?: number;
    maxRuntimeMinutes?: number;
    minYear?: number;
    maxYear?: number;
    genreCount: number;
    excludedGenreCount: number;
    hasContentRating: boolean;
    availability?: RecommendationBrief["hardFilters"]["availability"];
    requestStatusCount: number;
  };
  softSignalSummary: {
    termCount: number;
    genreCount: number;
    moodCount: number;
    referenceTitleHash?: string;
    wantsBetter: boolean;
    wantsRequestOptions: boolean;
  };
  feedbackCounts: {
    preferredExamples: number;
    moreLike: number;
    lessLike: number;
  };
}

export type CandidateProvenanceSource =
  | "lexical_fts"
  | "semantic_local_vector"
  | "provider_embedding"
  | "mood_feature_index"
  | "session_feedback"
  | "quality_bucket"
  | "catalog_rank"
  | "availability_bucket"
  | "rank_index";

export interface CandidateProvenanceTrace {
  schemaVersion: typeof moodRankTraceSchemaVersion;
  itemId: string;
  sources: Array<{
    source: CandidateProvenanceSource;
    score: number;
    rank?: number;
  }>;
}

export interface ScoreTraceV1 {
  schemaVersion: typeof moodRankTraceSchemaVersion;
  scoreTraceVersion: "score-trace-v1";
  itemId: string;
  finalScore: number;
  buckets: Array<{
    bucket: string;
    value: number;
    contribution: number;
  }>;
}

export interface ScoreTraceV2 {
  schemaVersion: typeof moodRankTraceSchemaVersion;
  scoreTraceVersion: "score-trace-v2";
  itemId: string;
  finalScore: number;
  buckets: Array<{
    bucket: string;
    value: number;
    weight: number;
    contribution: number;
  }>;
  deterministic: {
    score: number;
    unroundedScore: number;
    disqualified: boolean;
    adjustments: Array<{
      adjustment: "profile_delta" | "rank_index_delta";
      value?: number;
      contribution: number;
    }>;
  };
  scores: {
    deterministic: number;
    ai?: number;
    scout?: number;
    scoutOrderingDelta?: number;
    postScoutOrderingScore?: number;
    preResponse: number;
    response: number;
    responseClampDelta: number;
  };
  ranks: {
    preDiversity?: number;
    postDiversity?: number;
    postScoringFallback?: number;
    ai?: number;
    postRerank?: number;
    postScout?: number;
    postMerge?: number;
    response: number;
  };
  orderingReason: "pre_diversity" | "diversity" | "rerank_stage" | "taste_scout" | "merge_dedupe" | "request_attempt_fallback";
  explanationSource: "deterministic" | "ai" | "reranker_unknown";
  scoutAppliedToOrdering?: boolean;
  diversity?: {
    strategy: "small_pool" | "precision_protected" | "mmr" | "outside_diversity_pool";
    score: number;
    lambda?: number;
    maxSimilarity?: number;
    mmr?: number;
    rankMovement?: number;
  };
}

export interface RejectionTrace {
  schemaVersion: typeof moodRankTraceSchemaVersion;
  itemId: string;
  stage: "result_window_cut" | "rerank_window_cut";
  reasonCode: "outside_result_limit" | "outside_rerank_serialized_limit";
  score?: number;
  sampled: boolean;
}

export interface RetrievalTraceV1 {
  schemaVersion: typeof moodRankTraceSchemaVersion;
  retrievalTraceVersion: "retrieval-trace-v1";
  sourceCounts: RetrievalContext["sourceCounts"];
  providerEmbeddingBackfillCount: number;
  embeddingModel?: string;
}

export interface RerankTraceV1 {
  schemaVersion: typeof moodRankTraceSchemaVersion;
  rerankTraceVersion: "rerank-trace-v1";
  model?: string;
  offeredCandidateCount: number;
  serializedCandidateLimit: number;
  usedAi: boolean;
  resultCount: number;
}

export interface RerankTraceV2 {
  schemaVersion: typeof moodRankTraceSchemaVersion;
  rerankTraceVersion: "rerank-trace-v2";
  model?: string;
  offeredCandidateCount: number;
  serializedCandidateLimit: number;
  rerankWindowCandidateCount: number;
  rerankRequested: boolean;
  serializedCandidateCount?: number;
  aiRankedCandidateCount?: number;
  postRerankCandidateCount: number;
  usedAi: boolean;
  resultCount: number;
}

export interface RecommendationRunTraceRecord {
  schemaVersion: typeof moodRankTraceSchemaVersion;
  engineVersion: string;
  flags: MoodRankRunTraceFlags;
  brief: SearchBriefTraceV1;
  retrieval: RetrievalTraceV1;
  rerank?: RerankTraceV1 | RerankTraceV2;
  provenanceByItemId: Record<string, CandidateProvenanceTrace>;
  scoreTraceByItemId: Record<string, ScoreTraceV1 | ScoreTraceV2>;
  rejections: RejectionTrace[];
}

export function currentMoodRankTraceFlags(env: NodeJS.ProcessEnv = process.env): MoodRankRunTraceFlags {
  return {
    traceWrite: traceWriteMode(env.MOODRANK_TRACE_WRITE),
    guardrailsV2: shadowMode(env.MOODRANK_GUARDRAILS_V2),
    adaptiveRetrieval: adaptiveRetrievalMode(env.MOODRANK_ADAPTIVE_RETRIEVAL),
    rerankV2: shadowMode(env.MOODRANK_RERANK_V2),
    exposureLogging: exposureLoggingMode(env.MOODRANK_EXPOSURE_LOGGING),
    affectEnrichment: affectEnrichmentMode(env.MOODRANK_AFFECT_ENRICHMENT)
  };
}

export function shouldWriteMoodRankTrace(flags: MoodRankRunTraceFlags) {
  return flags.traceWrite !== "off";
}

export function buildRecommendationRunTrace(input: {
  request: SearchRequest;
  optimizedQuery: string;
  brief: RecommendationBrief;
  retrieved: RetrievalResult;
  scored: RankIndexedScoringResult;
  rerankCandidates: ItemSummary[];
  ranked: AiRankerResult;
  rerankRequested: boolean;
  deterministicWithScout: ItemSummary[];
  rankedWithScout: ItemSummary[];
  mergedResults: ItemSummary[];
  orderedResults: ItemSummary[];
  deterministicScoutOrderingByItemId: Map<string, TasteScoutOrderingEvidence>;
  rankedScoutOrderingByItemId: Map<string, TasteScoutOrderingEvidence>;
  results: ItemSummary[];
  model?: string;
  flags: MoodRankRunTraceFlags;
}): RecommendationRunTraceRecord {
  const finalIds = new Set(input.results.map((item) => item.id));
  const serializedCandidateCount = serializedRerankCandidateCount(input.rerankCandidates, input.ranked, input.rerankRequested);
  const aiById = new Map(input.ranked.trace?.rankedItems.map((item) => [item.itemId, item]) ?? []);
  const preResponseById = new Map(input.orderedResults.map((item) => [item.id, item]));
  const rankedRanks = rankMap(input.ranked.results);
  const rankedPostScoutRanks = rankMap(input.rankedWithScout);
  const deterministicPostScoutRanks = rankMap(input.deterministicWithScout);
  const mergedRanks = rankMap(input.mergedResults);
  const responseRanks = rankMap(input.results);
  return {
    schemaVersion: moodRankTraceSchemaVersion,
    engineVersion: recommendationEngineVersion,
    flags: input.flags,
    brief: buildSearchBriefTrace(input.request.query, input.optimizedQuery, input.brief),
    retrieval: buildRetrievalTrace(input.retrieved),
    rerank: buildRerankTrace(input.rerankCandidates, input.ranked, input.rerankRequested, input.model),
    provenanceByItemId: Object.fromEntries(input.results.map((item) => [item.id, buildCandidateProvenanceTrace(item.id, input.retrieved.context, input.scored.rankIndex.rankIndexRanks)])),
    scoreTraceByItemId: Object.fromEntries(
      input.results.map((item) => [
        item.id,
        buildScoreTrace(item, input.scored, {
          aiById,
          hasExplicitAiTrace: Boolean(input.ranked.trace),
          preResponseById,
          deterministicScoutOrderingByItemId: input.deterministicScoutOrderingByItemId,
          rankedScoutOrderingByItemId: input.rankedScoutOrderingByItemId,
          rankedRanks,
          rankedPostScoutRanks,
          deterministicPostScoutRanks,
          mergedRanks,
          responseRanks,
          usedAiRerank: input.ranked.usedAi
        })
      ])
    ),
    rejections: buildWindowCutRejections(input.scored.results, finalIds, input.rerankCandidates, serializedCandidateCount)
  };
}

export function stableTraceHash(value: string) {
  return createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

function buildSearchBriefTrace(rawQuery: string, optimizedQuery: string, brief: RecommendationBrief): SearchBriefTraceV1 {
  return {
    schemaVersion: moodRankTraceSchemaVersion,
    briefVersion: "search-brief-trace-v1",
    rawQueryHash: stableTraceHash(rawQuery),
    optimizedQueryHash: stableTraceHash(optimizedQuery),
    queryChanged: rawQuery.trim() !== optimizedQuery.trim(),
    watchContext: brief.watchContext,
    resultLimit: brief.resultLimit,
    hardFilterSummary: {
      mediaTypes: brief.hardFilters.mediaTypes,
      minRuntimeMinutes: brief.hardFilters.minRuntimeMinutes,
      maxRuntimeMinutes: brief.hardFilters.maxRuntimeMinutes,
      minYear: brief.hardFilters.minYear,
      maxYear: brief.hardFilters.maxYear,
      genreCount: brief.hardFilters.genres?.length ?? 0,
      excludedGenreCount: brief.hardFilters.excludedGenres?.length ?? 0,
      hasContentRating: Boolean(brief.hardFilters.contentRating),
      availability: brief.hardFilters.availability,
      requestStatusCount: brief.hardFilters.requestStatus?.length ?? 0
    },
    softSignalSummary: {
      termCount: brief.softSignals.terms.length,
      genreCount: brief.softSignals.genres.length,
      moodCount: brief.softSignals.moods.length,
      referenceTitleHash: brief.softSignals.referenceTitle ? stableTraceHash(brief.softSignals.referenceTitle) : undefined,
      wantsBetter: brief.softSignals.wantsBetter,
      wantsRequestOptions: brief.softSignals.wantsRequestOptions
    },
    feedbackCounts: {
      preferredExamples: brief.feedback.preferredExampleTitles.length,
      moreLike: brief.feedback.moreLikeTitles.length,
      lessLike: brief.feedback.lessLikeTitles.length
    }
  };
}

function buildRetrievalTrace(retrieved: RetrievalResult): RetrievalTraceV1 {
  return {
    schemaVersion: moodRankTraceSchemaVersion,
    retrievalTraceVersion: "retrieval-trace-v1",
    sourceCounts: retrieved.context.sourceCounts,
    providerEmbeddingBackfillCount: retrieved.context.providerEmbeddingBackfillCount,
    embeddingModel: retrieved.context.embeddingModel
  };
}

function buildCandidateProvenanceTrace(itemId: string, context: RetrievalContext, rankIndexRanks: Map<string, number>): CandidateProvenanceTrace {
  const sources: CandidateProvenanceTrace["sources"] = [];
  addSource(sources, "lexical_fts", context.lexicalRanks.get(itemId));
  addSource(sources, "semantic_local_vector", positive(context.semanticScores.get(itemId)));
  addSource(sources, "provider_embedding", positive(context.providerEmbeddingScores.get(itemId)));
  addSource(sources, "mood_feature_index", aboveNeutral(context.moodScores.get(itemId), 50));
  addSource(sources, "session_feedback", nonNeutral(context.feedbackScores.get(itemId), 50));
  addSource(sources, "quality_bucket", positive(context.qualityScores.get(itemId)));
  addSource(sources, "catalog_rank", positive(context.catalogRankScores.get(itemId)));
  addSource(sources, "rank_index", rankIndexRanks.has(itemId) ? 100 - Math.min(99, (rankIndexRanks.get(itemId)! - 1) / 2) : undefined, rankIndexRanks.get(itemId));
  return {
    schemaVersion: moodRankTraceSchemaVersion,
    itemId,
    sources: sources.sort((left, right) => right.score - left.score).slice(0, 4)
  };
}

export interface TasteScoutOrderingEvidence {
  scoutScore: number;
  orderingDelta: number;
  orderingScore: number;
  applied: boolean;
}

interface ScoreTraceOrderingContext {
  aiById: Map<string, AiRankerTrace["rankedItems"][number]>;
  hasExplicitAiTrace: boolean;
  preResponseById: Map<string, ItemSummary>;
  deterministicScoutOrderingByItemId: Map<string, TasteScoutOrderingEvidence>;
  rankedScoutOrderingByItemId: Map<string, TasteScoutOrderingEvidence>;
  rankedRanks: Map<string, number>;
  rankedPostScoutRanks: Map<string, number>;
  deterministicPostScoutRanks: Map<string, number>;
  mergedRanks: Map<string, number>;
  responseRanks: Map<string, number>;
  usedAiRerank: boolean;
}

function buildScoreTrace(item: ItemSummary, scored: RankIndexedScoringResult, ordering: ScoreTraceOrderingContext): ScoreTraceV1 | ScoreTraceV2 {
  const computation = scored.scoreTrace?.computationByItemId.get(item.id);
  const rankStages = scored.scoreTrace?.rankByItemId.get(item.id);
  const responseRank = ordering.responseRanks.get(item.id);
  if (!computation || !responseRank) return buildScoreTraceV1(item);

  const ai = ordering.aiById.get(item.id);
  const preResponseScore = ordering.preResponseById.get(item.id)?.score ?? item.score;
  const scout = ordering.rankedScoutOrderingByItemId.get(item.id) ?? ordering.deterministicScoutOrderingByItemId.get(item.id);
  const scores: ScoreTraceV2["scores"] = {
    deterministic: computation.deterministicScore,
    preResponse: preResponseScore,
    response: item.score,
    responseClampDelta: item.score - preResponseScore
  };
  if (ai) scores.ai = ai.aiScore;
  if (scout) {
    scores.scout = scout.scoutScore;
    scores.scoutOrderingDelta = scout.orderingDelta;
    scores.postScoutOrderingScore = scout.orderingScore;
  }

  const ranks: ScoreTraceV2["ranks"] = {
    preDiversity: rankStages?.preDiversityRank,
    postDiversity: rankStages?.postDiversityRank,
    postScoringFallback: rankStages?.postScoringFallbackRank,
    ai: ai?.aiRank,
    postRerank: ordering.rankedRanks.get(item.id),
    postScout: ordering.rankedPostScoutRanks.get(item.id) ?? ordering.deterministicPostScoutRanks.get(item.id),
    postMerge: ordering.mergedRanks.get(item.id),
    response: responseRank
  };
  const diversity = rankStages?.diversity
    ? {
        ...rankStages.diversity,
        rankMovement:
          rankStages.preDiversityRank !== undefined && rankStages.postDiversityRank !== undefined
            ? rankStages.postDiversityRank - rankStages.preDiversityRank
            : undefined
      }
    : undefined;

  return {
    schemaVersion: moodRankTraceSchemaVersion,
    scoreTraceVersion: "score-trace-v2",
    itemId: item.id,
    finalScore: item.score,
    buckets: computation.buckets,
    deterministic: {
      score: computation.deterministicScore,
      unroundedScore: computation.unroundedScore,
      disqualified: computation.disqualified,
      adjustments: computation.adjustments
    },
    scores,
    ranks,
    orderingReason: scoreTraceOrderingReason(ranks, ordering.usedAiRerank),
    explanationSource: ai
      ? "ai"
      : ordering.usedAiRerank && !ordering.hasExplicitAiTrace
        ? "reranker_unknown"
        : "deterministic",
    scoutAppliedToOrdering: scout?.applied,
    diversity
  };
}

function buildScoreTraceV1(item: ItemSummary): ScoreTraceV1 {
  const buckets = Object.entries(item.scoreBreakdown ?? {})
    .filter((entry): entry is [string, number] => typeof entry[1] === "number" && Number.isFinite(entry[1]))
    .map(([bucket, value]) => ({ bucket, value, contribution: value }));
  return {
    schemaVersion: moodRankTraceSchemaVersion,
    scoreTraceVersion: "score-trace-v1",
    itemId: item.id,
    finalScore: item.score,
    buckets
  };
}

export function buildRerankTrace(
  candidates: ItemSummary[],
  ranked: AiRankerResult,
  rerankRequested: boolean,
  model?: string
): RerankTraceV2 {
  const serializedCandidateCount = serializedRerankCandidateCount(candidates, ranked, rerankRequested);
  return {
    schemaVersion: moodRankTraceSchemaVersion,
    rerankTraceVersion: "rerank-trace-v2",
    model,
    offeredCandidateCount: candidates.length,
    serializedCandidateLimit: serializedCandidateCount,
    rerankWindowCandidateCount: candidates.length,
    rerankRequested,
    serializedCandidateCount,
    aiRankedCandidateCount: ranked.trace?.rankedItems.length,
    postRerankCandidateCount: ranked.results.length,
    usedAi: ranked.usedAi,
    resultCount: ranked.results.length
  };
}

function rankMap(items: ItemSummary[]) {
  return new Map(items.map((item, index) => [item.id, index + 1]));
}

export function scoreTraceOrderingReason(
  ranks: ScoreTraceV2["ranks"],
  usedAiRerank: boolean
): ScoreTraceV2["orderingReason"] {
  if (ranks.postMerge !== undefined && ranks.response !== ranks.postMerge) return "request_attempt_fallback";
  if (ranks.postScout !== undefined && ranks.postMerge !== undefined && ranks.postScout !== ranks.postMerge) return "merge_dedupe";
  if (ranks.postRerank !== undefined && ranks.postScout !== undefined && ranks.postRerank !== ranks.postScout) return "taste_scout";
  if (usedAiRerank && ranks.postScoringFallback !== undefined && ranks.postRerank !== undefined && ranks.postScoringFallback !== ranks.postRerank) return "rerank_stage";
  if (ranks.postDiversity !== undefined && ranks.postScoringFallback !== undefined && ranks.postDiversity !== ranks.postScoringFallback) return "request_attempt_fallback";
  if (ranks.preDiversity !== undefined && ranks.postDiversity !== undefined && ranks.preDiversity !== ranks.postDiversity) return "diversity";
  return "pre_diversity";
}

export function buildWindowCutRejections(
  scoredResults: ItemSummary[],
  finalIds: ReadonlySet<string>,
  rerankCandidates: ItemSummary[],
  serializedCandidateCount: number
) {
  const serializedIds = new Set(rerankCandidates.slice(0, serializedCandidateCount).map((item) => item.id));
  const rejections: RejectionTrace[] = [];
  for (const item of scoredResults) {
    if (finalIds.has(item.id)) continue;
    const providerExposed = serializedIds.has(item.id);
    rejections.push({
      schemaVersion: moodRankTraceSchemaVersion,
      itemId: item.id,
      stage: providerExposed ? "result_window_cut" : "rerank_window_cut",
      reasonCode: providerExposed ? "outside_result_limit" : "outside_rerank_serialized_limit",
      score: item.score,
      sampled: false
    });
  }
  if (rejections.length <= maxTraceRejectionRows) return rejections;
  return Array.from({ length: maxTraceRejectionRows }, (_, index) => ({
    ...rejections[Math.floor((index * (rejections.length - 1)) / (maxTraceRejectionRows - 1))]!,
    sampled: true
  }));
}

function serializedRerankCandidateCount(candidates: ItemSummary[], ranked: AiRankerResult, rerankRequested: boolean) {
  if (!rerankRequested) return 0;
  const reportedCount = ranked.trace?.serializedCandidateCount ?? 0;
  if (!Number.isFinite(reportedCount)) return 0;
  return Math.max(0, Math.min(candidates.length, Math.trunc(reportedCount)));
}

function addSource(sources: CandidateProvenanceTrace["sources"], source: CandidateProvenanceSource, score: number | undefined, rank?: number) {
  if (score === undefined || !Number.isFinite(score)) return;
  sources.push({ source, score: Math.round(score), rank });
}

function positive(value: number | undefined) {
  return value && value > 0 ? value : undefined;
}

function aboveNeutral(value: number | undefined, neutral: number) {
  return value !== undefined && value > neutral ? value : undefined;
}

function nonNeutral(value: number | undefined, neutral: number) {
  return value !== undefined && value !== neutral ? value : undefined;
}

function traceWriteMode(value: string | undefined): TraceWriteMode {
  return value === "on" || value === "strict" ? value : "off";
}

function shadowMode(value: string | undefined): ShadowMode {
  return value === "shadow" || value === "on" ? value : "off";
}

function adaptiveRetrievalMode(value: string | undefined): AdaptiveRetrievalMode {
  return value === "shadow" || value === "on" ? value : "legacy";
}

function exposureLoggingMode(value: string | undefined): ExposureLoggingMode {
  return value === "server_returned" || value === "client_visible" ? value : "off";
}

function affectEnrichmentMode(value: string | undefined): AffectEnrichmentMode {
  return value === "offline" ? value : "off";
}
