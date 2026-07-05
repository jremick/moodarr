import { createHash } from "node:crypto";
import type { ItemSummary, SearchRequest, WatchContext } from "../../shared/types";
import type { RecommendationBrief } from "./brief";
import type { RankIndexedScoringResult } from "./rankIndex";
import type { RetrievalContext, RetrievalResult } from "./retrieval";
import { recommendationEngineVersion } from "./version";

export const moodRankTraceSchemaVersion = "moodrank-trace-v1";

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

export interface RecommendationRunTraceRecord {
  schemaVersion: typeof moodRankTraceSchemaVersion;
  engineVersion: string;
  flags: MoodRankRunTraceFlags;
  brief: SearchBriefTraceV1;
  retrieval: RetrievalTraceV1;
  rerank?: RerankTraceV1;
  provenanceByItemId: Record<string, CandidateProvenanceTrace>;
  scoreTraceByItemId: Record<string, ScoreTraceV1>;
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
  ranked: { usedAi: boolean; results: ItemSummary[] };
  results: ItemSummary[];
  model?: string;
  flags: MoodRankRunTraceFlags;
}): RecommendationRunTraceRecord {
  const finalIds = new Set(input.results.map((item) => item.id));
  const rerankIds = new Set(input.rerankCandidates.map((item) => item.id));
  return {
    schemaVersion: moodRankTraceSchemaVersion,
    engineVersion: recommendationEngineVersion,
    flags: input.flags,
    brief: buildSearchBriefTrace(input.request.query, input.optimizedQuery, input.brief),
    retrieval: buildRetrievalTrace(input.retrieved),
    rerank: buildRerankTrace(input.rerankCandidates, input.ranked, input.model),
    provenanceByItemId: Object.fromEntries(input.results.map((item) => [item.id, buildCandidateProvenanceTrace(item.id, input.retrieved.context, input.scored.rankIndex.rankIndexRanks)])),
    scoreTraceByItemId: Object.fromEntries(input.results.map((item) => [item.id, buildScoreTrace(item)])),
    rejections: buildWindowCutRejections(input.scored.results, finalIds, rerankIds)
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

function buildScoreTrace(item: ItemSummary): ScoreTraceV1 {
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

function buildRerankTrace(candidates: ItemSummary[], ranked: { usedAi: boolean; results: ItemSummary[] }, model?: string): RerankTraceV1 {
  return {
    schemaVersion: moodRankTraceSchemaVersion,
    rerankTraceVersion: "rerank-trace-v1",
    model,
    offeredCandidateCount: candidates.length,
    serializedCandidateLimit: Math.min(60, candidates.length),
    usedAi: ranked.usedAi,
    resultCount: ranked.results.length
  };
}

function buildWindowCutRejections(scoredResults: ItemSummary[], finalIds: Set<string>, rerankIds: Set<string>) {
  const rejections: RejectionTrace[] = [];
  for (const item of scoredResults) {
    if (finalIds.has(item.id)) continue;
    if (rejections.length >= 50) break;
    rejections.push({
      schemaVersion: moodRankTraceSchemaVersion,
      itemId: item.id,
      stage: rerankIds.has(item.id) ? "result_window_cut" : "rerank_window_cut",
      reasonCode: rerankIds.has(item.id) ? "outside_result_limit" : "outside_rerank_serialized_limit",
      score: item.score,
      sampled: scoredResults.length > 200
    });
  }
  return rejections;
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
