import {
  defaultSearchResultLimit,
  maxSearchResultLimit,
  type ItemDetail,
  type ItemSummary,
  type RefinementOption,
  type SearchFilters,
  type SearchRequest,
  type SearchResponse,
  type WatchContext
} from "../../shared/types";
import type { BriefParser, ParsedBriefSignals } from "../ai/briefParser";
import { DeterministicBriefParser } from "../ai/briefParser";
import type { EmbeddingProvider } from "../ai/embeddings";
import type { AiRanker } from "../ai/ranker";
import type { QueryOptimizer } from "../ai/queryOptimizer";
import { DeterministicQueryOptimizer } from "../ai/queryOptimizer";
import type { FeedbackItem, TasteScout } from "../ai/tasteScout";
import { NoopTasteScout } from "../ai/tasteScout";
import type { IngestMediaRecord, MediaRepository, QueryReviewRetention, StoredMediaFeature } from "../db/mediaRepository";
import type { SeerrClient } from "../integrations/seerrClient";
import { buildRecommendationBrief, type RecommendationBrief } from "./brief";
import { mergeHardFilters, parseRecommendationIntent, type RecommendationIntent } from "./intent";
import { scoreRankIndexedLibrary, type RankIndexedScoringResult } from "./rankIndex";
import { retrieveRecommendationCandidates, type RetrievalResult } from "./retrieval";
import { seerrSearchQueries, selectRerankCandidates, shouldAugmentWithSeerr } from "./scoring";
import { recommendationEngineVersion } from "./version";

export class RecommendationEngine {
  constructor(
    private readonly repository: MediaRepository,
    private readonly seerrClient: SeerrClient,
    private readonly ranker: AiRanker,
    private readonly embeddingProvider?: EmbeddingProvider,
    private readonly briefParser: BriefParser = new DeterministicBriefParser(),
    private readonly tasteScout: TasteScout = new NoopTasteScout(),
    private readonly queryOptimizer: QueryOptimizer = new DeterministicQueryOptimizer(),
    private readonly reviewQueue?: QueryReviewRetention
  ) {}

  async recommend(request: SearchRequest): Promise<SearchResponse> {
    const startedAt = Date.now();
    const stageLatencyMs: Record<string, number> = {};
    const resultLimit = clampResultLimit(request.resultLimit);
    const watchContext = normalizeWatchContext(request.watchContext);
    const optimizationInput = {
      query: request.query,
      filters: request.filters ?? {},
      watchContext
    };
    const deterministicOptimizer = new DeterministicQueryOptimizer();
    const deterministicOptimizationStartedAt = Date.now();
    const deterministicOptimizedQuery = await deterministicOptimizer.optimize(optimizationInput);
    recordStageLatency(stageLatencyMs, "queryOptimization", deterministicOptimizationStartedAt);
    const briefRequest = {
      ...request,
      query: deterministicOptimizedQuery.query || request.query
    };
    const optimizedQueryPromise = request.useAi !== false && shouldUseAiQueryOptimizer(request.query)
      ? timeStage(stageLatencyMs, "queryOptimization", () => this.queryOptimizer.optimize(optimizationInput))
      : Promise.resolve(deterministicOptimizedQuery);
    const resolvedBriefPromise = timeStage(stageLatencyMs, "brief", () => this.resolveBrief(briefRequest, watchContext, resultLimit));
    const [optimizedQuery, resolvedBrief] = await Promise.all([optimizedQueryPromise, resolvedBriefPromise]);
    const effectiveRequest = {
      ...request,
      query: optimizedQuery.query || briefRequest.query
    };
    const queryOptimized = effectiveRequest.query.trim() !== request.query.trim();
    let seerrAugmented = false;
    let catalogVerificationCount = 0;
    const { brief, filters } = resolvedBrief;
    const scoredRequest = { ...effectiveRequest, filters };
    const searchEmbeddingProvider = request.useAi === false ? undefined : this.embeddingProvider;
    let retrieved = await timeStage(stageLatencyMs, "retrieval", () =>
      retrieveRecommendationCandidates(this.repository, brief, searchEmbeddingProvider, { backfillProviderEmbeddings: false })
    );
    let scoringStartedAt = Date.now();
    let scored = scoreRankIndexedCandidates(this.repository, retrieved, scoredRequest, watchContext);
    recordStageLatency(stageLatencyMs, "scoring", scoringStartedAt);

    for (let pass = 0; pass < 2; pass += 1) {
      const seerrStartedAt = Date.now();
      const excludedGenreBackfillCount = await this.backfillExcludedGenreMetadata(scored.results, scored.filters, resultLimit);
      recordStageLatency(stageLatencyMs, "seerr", seerrStartedAt);
      if (excludedGenreBackfillCount === 0) break;
      seerrAugmented = true;
      retrieved = await timeStage(stageLatencyMs, "retrieval", () =>
        retrieveRecommendationCandidates(this.repository, brief, searchEmbeddingProvider, { backfillProviderEmbeddings: false })
      );
      scoringStartedAt = Date.now();
      scored = scoreRankIndexedCandidates(this.repository, retrieved, scoredRequest, watchContext);
      recordStageLatency(stageLatencyMs, "scoring", scoringStartedAt);
    }

    if (shouldAugmentWithSeerr(scored.results, resultLimit, scored.intent, scored.filters)) {
      const catalogVerificationStartedAt = Date.now();
      const catalogRecords = await this.verifyCatalogRequestability(retrieved, resultLimit, scored.filters, brief);
      recordStageLatency(stageLatencyMs, "catalogVerification", catalogVerificationStartedAt);
      if (catalogRecords.length > 0) {
        catalogVerificationCount += catalogRecords.length;
        seerrAugmented = true;
        this.repository.upsertMany(catalogRecords);
        retrieved = await timeStage(stageLatencyMs, "retrieval", () =>
          retrieveRecommendationCandidates(this.repository, brief, searchEmbeddingProvider, { backfillProviderEmbeddings: false })
        );
        scoringStartedAt = Date.now();
        scored = scoreRankIndexedCandidates(this.repository, retrieved, scoredRequest, watchContext);
        recordStageLatency(stageLatencyMs, "scoring", scoringStartedAt);
      }
    }

    if (shouldAugmentWithSeerr(scored.results, resultLimit, scored.intent, scored.filters)) {
      const seerrStartedAt = Date.now();
      const seerrRecords: IngestMediaRecord[] = [];
      for (const query of seerrSearchQueries(scored.intent)) {
        seerrRecords.push(...(await this.seerrClient.search(query).catch(() => [])));
      }
      recordStageLatency(stageLatencyMs, "seerr", seerrStartedAt);
      if (seerrRecords.length > 0) {
        seerrAugmented = true;
        this.repository.upsertMany(seerrRecords);
        retrieved = await timeStage(stageLatencyMs, "retrieval", () =>
          retrieveRecommendationCandidates(this.repository, brief, searchEmbeddingProvider, { backfillProviderEmbeddings: false })
        );
        scoringStartedAt = Date.now();
        scored = scoreRankIndexedCandidates(this.repository, retrieved, scoredRequest, watchContext);
        recordStageLatency(stageLatencyMs, "scoring", scoringStartedAt);
      }
    }

    const rerankCandidates = selectRerankCandidates(scored.results);
    const rankedRequest = {
      ...effectiveRequest,
      filters: scored.filters,
      watchContext
    };
    const feedbackItems = resolveFeedbackItems(this.repository, request.feedbackContext);
    const emptyScout: Awaited<ReturnType<TasteScout["scout"]>> = { usedAi: false, recommendations: [] };
    const useAiRanking = request.useAi === true || (request.useAi !== false && shouldUseAiReranking(rankedRequest, feedbackItems));
    const [ranked, scout] = !useAiRanking
      ? [
          { usedAi: false, results: rerankCandidates },
          emptyScout
        ]
      : await Promise.all([
          timeStage(stageLatencyMs, "rerank", () => this.ranker.rank({
            request: rankedRequest,
            candidates: rerankCandidates,
            feedbackItems
          })),
          shouldUseTasteScout(rankedRequest, feedbackItems)
            ? timeStage(stageLatencyMs, "tasteScout", () =>
                this.tasteScout.scout({
                  request: rankedRequest,
                  watchContext,
                  candidates: selectTasteScoutCandidates(scored.results, resultLimit),
                  feedbackItems
                })
              )
            : Promise.resolve(emptyScout)
        ]);
    const deterministicWithScout = applyTasteScoutSignals(scored.results, scout.recommendations);
    const rankedWithScout = applyTasteScoutSignals(ranked.results, scout.recommendations);
    const results = mergeRankedResults(rankedWithScout, deterministicWithScout).slice(0, resultLimit);
    const usedAi = ranked.usedAi || scout.usedAi || resolvedBrief.usedAiBrief || optimizedQuery.usedAi;
    this.repository.recordSearch(request.query, results.length, usedAi);
    const latencyMs = Date.now() - startedAt;
    let sessionId: string | undefined;
    try {
      sessionId = this.repository.recordRecommendationRun({
        query: request.query,
        optimizedQuery: effectiveRequest.query,
        engineVersion: recommendationEngineVersion,
        model: this.ranker.modelName,
        watchContext,
        resultCount: results.length,
        candidateCount: scored.rankIndex.scoredItemCount,
        rerankCandidateCount: rerankCandidates.length,
        usedAi,
        seerrAugmented,
        latencyMs,
        results,
        feedback: request.feedbackContext,
        reviewQueue: this.reviewQueue
      });
    } catch {
      // Telemetry should never break a recommendation response.
    }
    const summary = ranked.summary || scout.summary || buildSearchSummary(effectiveRequest, results, feedbackItems);
    const refinementOptions = buildRefinementOptions(request, results, ranked.refinementOptions);

    return {
      sessionId,
      query: request.query,
      optimizedQuery: effectiveRequest.query,
      usedAi,
      summary,
      refinementOptions,
      resolvedFilters: scored.filters,
      watchContext,
      resultLimit,
      diagnostics: {
        engineVersion: recommendationEngineVersion,
        model: this.ranker.modelName,
        embeddingModel: retrieved.context.embeddingModel,
        candidateCount: scored.rankIndex.scoredItemCount,
        libraryItemCount: scored.rankIndex.libraryItemCount,
        scoredItemCount: scored.rankIndex.scoredItemCount,
        rankIndexCandidateCount: scored.rankIndex.indexedItemCount,
        retrievalCandidateCount: scored.rankIndex.sourceCandidateCount,
        rerankCandidateCount: rerankCandidates.length,
        providerEmbeddingCount: retrieved.context.sourceCounts.providerEmbedding,
        providerEmbeddingBackfillCount: retrieved.context.providerEmbeddingBackfillCount,
        moodCandidateCount: retrieved.context.sourceCounts.mood,
        catalogVerificationCount,
        catalogRankCandidateCount: retrieved.context.sourceCounts.catalogRank,
        diversityApplied: true,
        aiBriefParsed: resolvedBrief.usedAiBrief,
        tasteScoutUsed: scout.usedAi,
        queryOptimized,
        seerrAugmented,
        latencyMs,
        stageLatencyMs
      },
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

  private async resolveBrief(request: SearchRequest, watchContext: WatchContext, resultLimit: number) {
    const deterministicIntent = parseRecommendationIntent(request.query);
    const parsed = request.useAi === false
      ? { usedAi: false as const }
      : await this.briefParser.parse({
          query: request.query,
          deterministicIntent,
          explicitFilters: request.filters ?? {},
          watchContext
        });
    const intent = mergeParsedSignals(deterministicIntent, parsed.signals);
    const filters = mergeHardFilters(intent.hardFilters, request.filters ?? {});
    return {
      intent,
      filters,
      usedAiBrief: parsed.usedAi,
      brief: buildRecommendationBrief(request, intent, filters, watchContext, resultLimit)
    };
  }

  private async backfillExcludedGenreMetadata(candidates: ItemSummary[], filters: SearchRequest["filters"], resultLimit: number) {
    if (!filters?.excludedGenres?.some((genre) => genre.toLowerCase() === "animation")) return 0;

    const candidatesToValidate = candidates
      .filter((candidate) => candidate.plex?.available)
      .filter((candidate) => !candidate.genres.some((genre) => genre.toLowerCase() === "animation"))
      .slice(0, Math.min(60, Math.max(24, resultLimit * 3)));

    if (candidatesToValidate.length === 0) return 0;

    const records = (
      await Promise.all(
        candidatesToValidate.map(async (candidate) => {
          const matches = await this.seerrClient.search(candidate.title).catch(() => []);
          return exactCatalogMatch(candidate, matches);
        })
      )
    ).filter((record): record is IngestMediaRecord => Boolean(record));

    if (records.length === 0) return 0;
    this.repository.upsertMany(records);
    return records.length;
  }

  private async verifyCatalogRequestability(retrieved: RetrievalResult, resultLimit: number, filters: SearchFilters, brief: RecommendationBrief) {
    const candidates = selectCatalogVerificationCandidates(retrieved, filters, brief, Math.min(8, Math.max(3, resultLimit)));
    const records: IngestMediaRecord[] = [];
    for (const candidate of candidates) {
      const matches = await this.seerrClient.search(candidate.title).catch(() => []);
      const exact = exactCatalogMatch(candidate, matches);
      if (exact) records.push(exact);
    }
    return dedupeIngestRecords(records);
  }
}

function exactCatalogMatch(candidate: ItemSummary, records: IngestMediaRecord[]) {
  return records.find((record) => {
    if (record.mediaType !== candidate.mediaType) return false;
    if (normalizeMatchTitle(record.title) !== normalizeMatchTitle(candidate.title)) return false;
    return !record.year || !candidate.year || Math.abs(record.year - candidate.year) <= 1;
  });
}

export function selectCatalogVerificationCandidates(retrieved: RetrievalResult, filters: SearchFilters, brief: RecommendationBrief, limit: number) {
  return retrieved.candidates
    .filter((item) => item.metadata?.source === "catalog" && !item.plex?.available && !item.seerr)
    .filter((item) => matchesCatalogVerificationFilters(item, filters, retrieved.context.features.get(item.id)))
    .sort((left, right) => catalogCandidateScore(retrieved, right, brief) - catalogCandidateScore(retrieved, left, brief) || left.title.localeCompare(right.title))
    .slice(0, limit);
}

function catalogCandidateScore(retrieved: RetrievalResult, item: ItemDetail, brief: RecommendationBrief) {
  const context = retrieved.context;
  const itemId = item.id;
  return (
    (context.lexicalRanks.get(itemId) ?? 0) * 0.18 +
    Math.max(context.semanticScores.get(itemId) ?? 0, context.providerEmbeddingScores.get(itemId) ?? 0) * 0.24 +
    (context.moodScores.get(itemId) ?? 0) * 0.22 +
    (context.catalogRankScores.get(itemId) ?? 0) * 0.22 +
    (context.qualityScores.get(itemId) ?? 0) * 0.08 +
    (context.feedbackScores.get(itemId) ?? 50) * 0.06 +
    catalogVerificationQueryAdjustment(item, context.features.get(itemId), brief)
  );
}

function matchesCatalogVerificationFilters(item: ItemDetail, filters: SearchFilters, feature: StoredMediaFeature | undefined) {
  if (filters.mediaTypes?.length && !filters.mediaTypes.includes(item.mediaType)) return false;
  if (filters.minRuntimeMinutes && item.runtimeMinutes && item.runtimeMinutes < filters.minRuntimeMinutes) return false;
  if (filters.maxRuntimeMinutes && item.runtimeMinutes && item.runtimeMinutes > filters.maxRuntimeMinutes) return false;
  if (filters.minYear && item.year && item.year < filters.minYear) return false;
  if (filters.maxYear && item.year && item.year > filters.maxYear) return false;
  if (filters.genres?.length && !filters.genres.some((genre) => hasCatalogGenreEvidence(item, genre))) return false;
  if (filters.excludedGenres?.length && filters.excludedGenres.some((genre) => hasExcludedCatalogGenreEvidence(item, feature, genre))) return false;
  if (filters.contentRating && item.contentRating && item.contentRating !== filters.contentRating) return false;
  return true;
}

function catalogVerificationQueryAdjustment(item: ItemDetail, feature: StoredMediaFeature | undefined, brief: RecommendationBrief) {
  const query = normalizeCatalogText(brief.query);
  const text = catalogEvidenceText(item, feature);
  const bodyText = catalogEvidenceText(item, undefined);
  let score = 0;

  if (/\b(?:comfort|cozy|warm|gentle|feel good|feelgood|low commitment|easy|background)\b/.test(query)) {
    const comfortSupportPattern =
      /\b(?:warm|gentle|cozy|comforting|heartwarming|friendship|family|christmas|holiday|comedy|romantic comedy|romance|romantic|feel good|sitcom|short film|episodic|background friendly|low commitment)\b/;
    const hasGroundedComfortSupport = comfortSupportPattern.test(bodyText);
    const hasComfortSupport = /\b(?:warm|gentle|cozy|comforting|heartwarming|friendship|family|christmas|holiday|comedy|romantic comedy|romance|romantic|feel good|sitcom|short film|episodic|background friendly|low commitment)\b/.test(
      text
    );
    if (hasComfortSupport) score += 10;
    else score -= 12;
    if (!hasGroundedComfortSupport) score -= 18;
    if (/\b(?:thriller|war|horror|violent|violence|gore|bleak|intense|high friction|erotic|crime|spy)\b/.test(text)) score -= 18;
    if (/\blow commitment\b/.test(text) || /\b(?:sitcom|short film|episodic|comedy television)\b/.test(text)) score += 8;
    if (/\bcomfort\b/.test(normalizeCatalogText(item.title)) && !hasComfortSupport) score -= 10;
    if (hasCreditNameMatch(item, "comfort")) score -= 40;
  }

  if (/\b(?:not scary|not horror|less horror|not too dark)\b/.test(query) || brief.hardFilters.excludedGenres?.includes("Horror")) {
    if (/\b(?:horror|scary|gore|slasher|body horror|ghost film|nightmare|terror|haunted|zombie|vampire|monster|splatter|erotic thriller|high friction)\b/.test(text)) {
      score -= 24;
    }
    if (/\b(?:mystery|detective|noir|crime|psychological|gothic|dark fantasy|drama)\b/.test(text)) score += 8;
  }

  if (brief.watchContext === "group" || /\b(?:group|family|shared|crowd)\b/.test(query)) {
    if (/\b(?:family|comedy|adventure|animation|animated|shared screen|group friendly|children)\b/.test(text)) score += 10;
    if (/\b(?:horror|gore|violent|bleak|erotic|high friction|adult animated)\b/.test(text)) score -= 14;
  }

  if (/\b(?:weird|offbeat|strange|quirky|bizarre|surreal)\b/.test(query)) {
    if (/\b(?:weird|offbeat|strange|quirky|bizarre|surreal|absurd|cult film)\b/.test(text)) score += 10;
    if (brief.watchContext === "group" && /\b(?:comedy|adventure|animation|family)\b/.test(text)) score += 6;
  }

  return score;
}

function hasCatalogGenreEvidence(item: ItemDetail, genre: string) {
  const normalized = normalizeCatalogText(genre);
  return item.genres.some((entry) => normalizeCatalogText(entry).includes(normalized));
}

function hasExcludedCatalogGenreEvidence(item: ItemDetail, feature: StoredMediaFeature | undefined, genre: string) {
  const normalized = normalizeCatalogText(genre);
  const text = catalogEvidenceText(item, feature, { includeTitle: false });
  if (item.genres.some((entry) => normalizeCatalogText(entry).includes(normalized))) return true;
  if (normalized === "horror") {
    return /\b(?:horror|scary|gore|slasher|body horror|ghost film|nightmare|terror|haunted|zombie|vampire|monster film|splatter film|erotic thriller)\b/.test(text);
  }
  if (normalized === "animation") return /\b(?:animation|animated|anime|cartoon)\b/.test(text);
  if (normalized === "comedy") return /\b(?:comedy|funny|sitcom|farce|jokes)\b/.test(text);
  return false;
}

function catalogEvidenceText(item: ItemDetail, feature: StoredMediaFeature | undefined, options: { includeTitle?: boolean } = {}) {
  return normalizeCatalogText([
    options.includeTitle === false ? "" : item.title,
    item.summary ?? "",
    item.genres.join(" "),
    ...(feature?.moodTerms ?? []),
    ...(feature?.toneTerms ?? []),
    ...(feature?.watchabilityTerms ?? [])
  ].join(" "));
}

function hasCreditNameMatch(item: ItemDetail, term: string) {
  const summary = item.summary ?? "";
  const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b(?:by|directed by)\\s+[A-Z][\\p{L}\\p{M}'’.-]*(?:\\s+[A-Z][\\p{L}\\p{M}'’.-]*){0,4}\\s+${escapedTerm}\\b`, "iu").test(summary);
}

function normalizeCatalogText(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function dedupeIngestRecords(records: IngestMediaRecord[]) {
  const seen = new Set<string>();
  const deduped: IngestMediaRecord[] = [];
  for (const record of records) {
    const key = `${record.mediaType}:${record.externalIds?.tmdb ?? record.externalIds?.imdb ?? record.externalIds?.tvdb ?? record.title}:${record.year ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(record);
  }
  return deduped;
}

function normalizeMatchTitle(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function scoreRankIndexedCandidates(repository: MediaRepository, retrieved: RetrievalResult, request: SearchRequest, watchContext: WatchContext): RankIndexedScoringResult {
  return scoreRankIndexedLibrary(retrieved, request, watchContext, {
    preferenceWeights: repository.preferenceWeights(watchContext),
    feelProfile: repository.feelProfile(watchContext),
    hiddenItemIds: new Set(request.feedbackContext?.hiddenItemIds ?? [])
  });
}

function mergeParsedSignals(deterministic: RecommendationIntent, parsed: ParsedBriefSignals | undefined): RecommendationIntent {
  if (!parsed) return deterministic;
  const hardFilters = pruneEmptyFilters({
    ...(parsed.hardFilters ?? {}),
    ...deterministic.hardFilters
  });
  if (
    hardFilters.availability?.includes("not_in_plex_requestable") &&
    !deterministic.hardFilters.availability?.length &&
    deterministic.wantsRequestOptions &&
    !requestableOnlyRequested(deterministic.query)
  ) {
    delete hardFilters.availability;
  }
  const excludedGenres = new Set((hardFilters.excludedGenres ?? []).map((genre) => genre.toLowerCase()));
  const excludedTerms = excludedGenres.has("animation") ? new Set(["animated", "animation", "cartoon", "cartoons", "anime"]) : new Set<string>();
  return {
    ...deterministic,
    terms: unique([...deterministic.terms, ...(parsed.terms ?? [])].map((term) => term.toLowerCase())).filter((term) => !excludedTerms.has(term)),
    softGenres: unique([...deterministic.softGenres, ...(parsed.softGenres ?? [])]).filter((genre) => !excludedGenres.has(genre.toLowerCase())),
    moods: unique([...deterministic.moods, ...(parsed.moods ?? [])].map((mood) => mood.toLowerCase())),
    referenceTitle: deterministic.referenceTitle ?? parsed.referenceTitle,
    hardFilters,
    wantsBetter: deterministic.wantsBetter || Boolean(parsed.wantsBetter),
    wantsRequestOptions: deterministic.wantsRequestOptions || Boolean(parsed.wantsRequestOptions)
  };
}

function requestableOnlyRequested(query: string) {
  return /\b(?:only|just|exclusively)\s+(?:requestable|unavailable|not in plex)\b/i.test(query) || /\b(?:requestable|unavailable|not in plex)\s+(?:only|just|exclusively)\b/i.test(query);
}

function pruneEmptyFilters(filters: SearchRequest["filters"] = {}) {
  return Object.fromEntries(
    Object.entries(filters).filter(([, value]) => {
      if (Array.isArray(value)) return value.length > 0;
      return value !== undefined && value !== null && value !== "";
    })
  ) as NonNullable<SearchRequest["filters"]>;
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function mergeRankedResults(ranked: ItemSummary[], deterministic: ItemSummary[]) {
  const rankedIds = new Set(ranked.map((item) => item.id));
  return [...ranked, ...deterministic.filter((item) => !rankedIds.has(item.id))];
}

function selectTasteScoutCandidates(candidates: ItemSummary[], resultLimit: number) {
  const target = Math.min(90, Math.max(30, resultLimit * 6));
  const selected = new Map<string, ItemSummary>();
  for (const candidate of candidates.slice(0, target)) selected.set(candidate.id, candidate);
  for (const group of ["available_in_plex", "not_in_plex_requestable", "already_requested", "partially_available"] as const) {
    for (const candidate of candidates.filter((item) => item.availabilityGroup === group).slice(0, 8)) selected.set(candidate.id, candidate);
  }
  return [...selected.values()].slice(0, target);
}

function applyTasteScoutSignals(items: ItemSummary[], recommendations: { id: string; score: number; reason?: string }[]) {
  if (recommendations.length === 0) return items;
  const signalById = new Map(recommendations.map((recommendation) => [recommendation.id, recommendation]));
  return items
    .map((item) => {
      const signal = signalById.get(item.id);
      if (!signal) return item;
      const scoutScore = Math.max(0, Math.min(100, signal.score));
      const boost = Math.round((scoutScore - 50) * 0.24);
      return {
        ...item,
        score: Math.max(0, Math.min(100, item.score + boost)),
        scoreBreakdown: item.scoreBreakdown ? { ...item.scoreBreakdown, scout: scoutScore } : undefined,
        matchExplanation: signal.reason || item.matchExplanation
      };
    })
    .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title));
}

function resolveFeedbackItems(repository: MediaRepository, feedback: SearchRequest["feedbackContext"]): { moreLike: FeedbackItem[]; lessLike: FeedbackItem[] } {
  return {
    moreLike: (feedback?.moreLikeItemIds ?? []).flatMap((id) => toFeedbackItem(repository.findById(id))),
    lessLike: (feedback?.lessLikeItemIds ?? []).flatMap((id) => toFeedbackItem(repository.findById(id)))
  };
}

function toFeedbackItem(item: ReturnType<MediaRepository["findById"]>): FeedbackItem[] {
  if (!item) return [];
  return [
    {
      id: item.id,
      title: item.title,
      mediaType: item.mediaType,
      year: item.year,
      runtimeMinutes: item.runtimeMinutes,
      genres: item.genres,
      summary: item.summary
    }
  ];
}

function clampResultLimit(value: number | undefined) {
  if (!value) return defaultSearchResultLimit;
  return Math.max(1, Math.min(maxSearchResultLimit, value));
}

function normalizeWatchContext(value: WatchContext | undefined): WatchContext {
  return value === "group" ? "group" : "solo";
}

async function timeStage<T>(stageLatencyMs: Record<string, number>, stage: string, action: () => Promise<T>) {
  const startedAt = Date.now();
  try {
    return await action();
  } finally {
    recordStageLatency(stageLatencyMs, stage, startedAt);
  }
}

function recordStageLatency(stageLatencyMs: Record<string, number>, stage: string, startedAt: number) {
  stageLatencyMs[stage] = (stageLatencyMs[stage] ?? 0) + Date.now() - startedAt;
}

function shouldUseAiQueryOptimizer(query: string) {
  return query.trim().length > 600;
}

function shouldUseTasteScout(request: SearchRequest, feedbackItems: { moreLike: FeedbackItem[]; lessLike: FeedbackItem[] }) {
  if (feedbackItems.moreLike.length > 0 || feedbackItems.lessLike.length > 0) return true;
  return /\b(?:more like|less like|similar to|vibe of|vibes like|taste|surprise me)\b/i.test(request.query);
}

function shouldUseAiReranking(request: SearchRequest, feedbackItems: { moreLike: FeedbackItem[]; lessLike: FeedbackItem[] }) {
  if (feedbackItems.moreLike.length > 0 || feedbackItems.lessLike.length > 0) return true;
  const query = request.query.trim();
  if (query.length > 180) return true;
  return /\b(?:more like|less like|something like|similar to|vibe of|vibes like|reminds me of|taste|surprise me|date night|for a group|requestable|unavailable|not in plex)\b/i.test(query);
}

function buildSearchSummary(
  request: SearchRequest,
  results: ItemSummary[],
  feedbackItems: { moreLike: FeedbackItem[]; lessLike: FeedbackItem[] }
) {
  if (results.length === 0) {
    return "I’m not finding a confident match yet. I’d loosen one constraint or give me one example that has the feeling you want, and I’ll steer from there.";
  }

  const topTitles = formatList(results.slice(0, 3).map((item) => item.title));
  const mood = describeMoodDirection(request.query, results, feedbackItems);
  const availability = results.some((item) => item.availabilityGroup !== "available_in_plex")
    ? "I’ll keep requestable options nearby when they carry the same feel."
    : "The strongest starting points are already in Plex.";
  return `I’d steer this toward ${mood}. ${topTitles} feel like the best first stops from this pass. ${availability}`;
}

function describeMoodDirection(query: string, results: ItemSummary[], feedbackItems: { moreLike: FeedbackItem[]; lessLike: FeedbackItem[] }) {
  if (feedbackItems.moreLike.length > 0) {
    const likedGenres = topValues(feedbackItems.moreLike.flatMap((item) => item.genres), 3);
    const likedTitles = formatList(feedbackItems.moreLike.map((item) => item.title).slice(0, 3));
    if (likedGenres.length) return `${formatList(likedGenres).toLowerCase()} picks with the same kind of energy as ${likedTitles}`;
    return `the same kind of energy as ${likedTitles}`;
  }
  const normalized = query.toLowerCase();
  const moodWords = [
    ["feel-good", "warm, feel-good comfort"],
    ["funny", "light, funny energy"],
    ["comedy", "easy comedy"],
    ["fantasy", "playful fantasy and adventure"],
    ["cozy", "cozy, low-friction comfort"],
    ["weird", "a more offbeat mood"],
    ["clever", "clever, sharper writing"],
    ["short", "low-commitment viewing"]
  ];
  const matched = moodWords.find(([term]) => normalized.includes(term));
  if (matched) return matched[1];
  const genres = topValues(results.slice(0, 5).flatMap((item) => item.genres), 3);
  return genres.length ? `${formatList(genres).toLowerCase()} that feels easy to choose` : "the mood you described";
}

function topValues(values: string[], limit: number) {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([value]) => value);
}

function buildRefinementOptions(request: SearchRequest, results: ItemSummary[], suggestedOptions: RefinementOption[] = []): RefinementOption[] {
  const targetCount = targetRefinementCount(request, results);
  if (results.length === 0) {
    return uniqueRefinementOptions([
      { label: "Loosen the brief", prompt: "Loosen the filters and show me broader nearby options." },
      { label: "Try requestable", prompt: "Include requestable Plex plus Seerr options that match the same feel." },
      { label: "Short and easy", prompt: "Keep it short, easy to watch, and low commitment." },
      { label: "Different mood", prompt: "Try a different mood direction that still fits what I asked for." },
      { label: "Hidden gems", prompt: "Show less obvious picks that are still close to the brief." }
    ]).slice(0, targetCount);
  }

  const query = request.query.toLowerCase();
  const topResults = results.slice(0, 6);
  const topGenres = new Set(topResults.flatMap((item) => item.genres.map((genre) => genre.toLowerCase())));
  const strongestGenres = topValues(topResults.flatMap((item) => item.genres), 3);
  const topTitle = results[0]?.title;
  const averageMinutes = averageRuntimeMinutes(topResults);
  const hasPositiveFeedback = Boolean(request.feedbackContext?.moreLikeItemIds?.length || request.feedbackContext?.maybeItemIds?.length);
  const hasNegativeFeedback = Boolean(request.feedbackContext?.lessLikeItemIds?.length || request.feedbackContext?.hiddenItemIds?.length);
  const options: RefinementOption[] = [];

  for (const option of suggestedOptions) pushRefinementOption(options, option);

  if (topTitle) {
    pushRefinementOption(options, { label: `More like ${shortOptionTitle(topTitle)}`, prompt: `Use ${topTitle} as the stronger reference point and find more options with that same feel.` });
  }

  if (hasPositiveFeedback || hasNegativeFeedback) {
    pushRefinementOption(options, { label: "Use my picks", prompt: "Adjust around what I liked and disliked, and make the next set more decisive." });
  }

  if (request.watchContext === "group") {
    pushRefinementOption(options, { label: "Crowd pleasers", prompt: "Make it more broadly watchable for a group." });
    pushRefinementOption(options, { label: "Bolder group pick", prompt: "Still keep it group-friendly, but make the choices a little less obvious." });
  } else {
    pushRefinementOption(options, { label: "More personal", prompt: "Make it a more distinctive personal pick, even if it is less obvious." });
    pushRefinementOption(options, { label: "Easier tonight", prompt: "Keep the taste direction, but make it easier to choose and watch tonight." });
  }

  if (hasQueryAny(query, ["fun", "funny", "comedy"]) || topGenres.has("comedy")) {
    pushRefinementOption(options, { label: "Warmer laughs", prompt: "Make it lighter, warmer, and more feel-good without losing the same basic brief." });
    pushRefinementOption(options, { label: "Sharper comedy", prompt: "Make it funnier, sharper, and a little more clever." });
  }

  if (hasQueryAny(query, ["fantasy", "magic", "adventure"]) || topGenres.has("fantasy") || topGenres.has("adventure")) {
    pushRefinementOption(options, { label: "More magical", prompt: "Lean more magical, whimsical, and adventurous." });
    pushRefinementOption(options, { label: "More adventure", prompt: "Keep the same mood, but make the picks more propulsive and adventurous." });
  }

  if (hasQueryAny(query, ["dark", "weird", "strange", "surreal"]) || topGenres.has("science fiction")) {
    pushRefinementOption(options, { label: "Stranger picks", prompt: "Make it stranger, more distinctive, and less obvious." });
    pushRefinementOption(options, { label: "More grounded", prompt: "Keep the unusual feel, but make the choices more grounded and easier to settle into." });
  }

  if (hasQueryAny(query, ["tense", "thriller", "horror", "scary"]) || topGenres.has("thriller") || topGenres.has("horror")) {
    pushRefinementOption(options, { label: "More tension", prompt: "Turn up the suspense and momentum without making it feel random." });
    pushRefinementOption(options, { label: "Less intense", prompt: "Keep the hook, but make it less intense and easier to watch tonight." });
  }

  if (hasQueryAny(query, ["romance", "heartfelt", "gentle", "cozy"]) || topGenres.has("romance") || topGenres.has("drama")) {
    pushRefinementOption(options, { label: "More heartfelt", prompt: "Make it more heartfelt, gentle, and emotionally satisfying." });
    pushRefinementOption(options, { label: "Less heavy", prompt: "Keep the emotional thread, but make the next set lighter and easier." });
  }

  if (strongestGenres.length > 0 && !strongestGenres.some((genre) => query.includes(genre.toLowerCase()))) {
    pushRefinementOption(options, { label: `Lean ${strongestGenres[0]}`, prompt: `Lean more into the ${strongestGenres[0].toLowerCase()} side of these results.` });
  }

  if (results.some((item) => item.availabilityGroup !== "available_in_plex")) {
    pushRefinementOption(options, { label: "Only in Plex", prompt: "Only show things already available in Plex." });
  } else {
    pushRefinementOption(options, { label: "Include requests", prompt: "Also include requestable Plex plus Seerr options with the same vibe." });
  }

  if (averageMinutes && averageMinutes > 115) {
    pushRefinementOption(options, { label: "Shorter picks", prompt: "Keep the same feel, but prefer shorter, lower-commitment choices." });
  } else {
    pushRefinementOption(options, { label: "Deeper cut", prompt: "Keep the same direction, but show a deeper cut that still feels worth it." });
  }
  pushRefinementOption(options, { label: "Surprise me", prompt: "Make one smart lateral move from this result set and surprise me." });

  return uniqueRefinementOptions(options).slice(0, targetCount);
}

function uniqueRefinementOptions(options: RefinementOption[]) {
  const seen = new Set<string>();
  return options.flatMap((option) => {
    const label = option.label.trim();
    const prompt = option.prompt.trim();
    const key = label.toLowerCase();
    if (!label || !prompt || seen.has(key)) return [];
    seen.add(key);
    return [{ label, prompt }];
  });
}

function pushRefinementOption(options: RefinementOption[], option: RefinementOption) {
  if (!option.label.trim() || !option.prompt.trim()) return;
  options.push({ label: option.label.trim(), prompt: option.prompt.trim() });
}

function targetRefinementCount(request: SearchRequest, results: ItemSummary[]) {
  const seed = `${request.query}|${request.watchContext ?? "solo"}|${results.slice(0, 5).map((item) => item.id).join("|")}`;
  return 3 + (hashString(seed) % 3);
}

function hashString(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function hasQueryAny(query: string, terms: string[]) {
  return terms.some((term) => query.includes(term));
}

function averageRuntimeMinutes(results: ItemSummary[]) {
  const runtimes = results.flatMap((item) => (item.runtimeMinutes ? [item.runtimeMinutes] : []));
  if (runtimes.length === 0) return undefined;
  return runtimes.reduce((sum, runtime) => sum + runtime, 0) / runtimes.length;
}

function shortOptionTitle(title: string) {
  const compact = title.split(":")[0].trim();
  if (compact.length <= 18) return compact;
  const words = compact.split(/\s+/);
  const shortened = words.slice(0, 3).join(" ");
  return shortened.length <= 18 ? shortened : `${shortened.slice(0, 17).trim()}...`;
}

function formatList(values: string[]) {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}
