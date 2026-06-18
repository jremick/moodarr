import { defaultSearchResultLimit, maxSearchResultLimit, type ItemSummary, type RefinementOption, type SearchRequest, type SearchResponse, type WatchContext } from "../../shared/types";
import type { BriefParser, ParsedBriefSignals } from "../ai/briefParser";
import { DeterministicBriefParser } from "../ai/briefParser";
import type { EmbeddingProvider } from "../ai/embeddings";
import type { AiRanker } from "../ai/ranker";
import type { QueryOptimizer } from "../ai/queryOptimizer";
import { DeterministicQueryOptimizer } from "../ai/queryOptimizer";
import type { FeedbackItem, TasteScout } from "../ai/tasteScout";
import { NoopTasteScout } from "../ai/tasteScout";
import type { IngestMediaRecord, MediaRepository, QueryReviewRetention } from "../db/mediaRepository";
import type { SeerrClient } from "../integrations/seerrClient";
import { buildRecommendationBrief } from "./brief";
import { mergeHardFilters, parseRecommendationIntent, type RecommendationIntent } from "./intent";
import { retrieveRecommendationCandidates, type RetrievalResult } from "./retrieval";
import { scoreLibraryCandidates, seerrSearchQueries, selectRerankCandidates, shouldAugmentWithSeerr } from "./scoring";
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
    const { brief, filters } = resolvedBrief;
    const scoredRequest = { ...effectiveRequest, filters };
    const searchEmbeddingProvider = request.useAi === false ? undefined : this.embeddingProvider;
    let retrieved = await timeStage(stageLatencyMs, "retrieval", () =>
      retrieveRecommendationCandidates(this.repository, brief, searchEmbeddingProvider, { backfillProviderEmbeddings: false })
    );
    let scoringStartedAt = Date.now();
    let scored = scoreRetrievedCandidates(this.repository, retrieved, scoredRequest, watchContext);
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
      scored = scoreRetrievedCandidates(this.repository, retrieved, scoredRequest, watchContext);
      recordStageLatency(stageLatencyMs, "scoring", scoringStartedAt);
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
        scored = scoreRetrievedCandidates(this.repository, retrieved, scoredRequest, watchContext);
        recordStageLatency(stageLatencyMs, "scoring", scoringStartedAt);
      }
    }

    const rerankCandidates = selectRerankCandidates(scored.results, resultLimit);
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
        candidateCount: retrieved.context.sourceCounts.selected,
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
    const refinementOptions = ranked.refinementOptions?.length ? ranked.refinementOptions : buildRefinementOptions(request, results);

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
        candidateCount: retrieved.context.sourceCounts.selected,
        rerankCandidateCount: rerankCandidates.length,
        providerEmbeddingCount: retrieved.context.sourceCounts.providerEmbedding,
        providerEmbeddingBackfillCount: retrieved.context.providerEmbeddingBackfillCount,
        moodCandidateCount: retrieved.context.sourceCounts.mood,
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
}

function exactCatalogMatch(candidate: ItemSummary, records: IngestMediaRecord[]) {
  return records.find((record) => {
    if (record.mediaType !== candidate.mediaType) return false;
    if (normalizeMatchTitle(record.title) !== normalizeMatchTitle(candidate.title)) return false;
    return !record.year || !candidate.year || Math.abs(record.year - candidate.year) <= 1;
  });
}

function normalizeMatchTitle(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function scoreRetrievedCandidates(repository: MediaRepository, retrieved: RetrievalResult, request: SearchRequest, watchContext: WatchContext) {
  return scoreLibraryCandidates(retrieved.candidates, request.query, request.filters ?? {}, watchContext, {
    ...retrieved.context,
    allItems: retrieved.allItems,
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

function buildRefinementOptions(request: SearchRequest, results: ItemSummary[]): RefinementOption[] {
  if (results.length === 0) {
    return [
      { label: "Loosen the brief", prompt: "Loosen the filters and show me broader nearby options." },
      { label: "Try requestable", prompt: "Include requestable Plex plus Seerr options that match the same feel." },
      { label: "Short and easy", prompt: "Keep it short, easy to watch, and low commitment." }
    ];
  }

  const query = request.query.toLowerCase();
  const topGenres = new Set(results.slice(0, 6).flatMap((item) => item.genres.map((genre) => genre.toLowerCase())));
  const options: RefinementOption[] = [];

  if (query.includes("fun") || topGenres.has("comedy")) {
    options.push({ label: "Lighter and warmer", prompt: "Make it lighter, warmer, and more feel-good." });
    options.push({ label: "Sharper comedy", prompt: "Make it funnier, sharper, and a little more clever." });
  }

  if (query.includes("fantasy") || topGenres.has("fantasy") || topGenres.has("adventure")) {
    options.push({ label: "More magical", prompt: "Lean more magical, whimsical, and adventurous." });
  }

  if (request.watchContext === "group") {
    options.push({ label: "Crowd pleasers", prompt: "Make it more broadly watchable for a group." });
  } else {
    options.push({ label: "More specific", prompt: "Make it a more distinctive personal pick, even if it is less obvious." });
  }

  if (results.some((item) => item.availabilityGroup !== "available_in_plex")) {
    options.push({ label: "Only in Plex", prompt: "Only show things already available in Plex." });
  } else {
    options.push({ label: "Include requests", prompt: "Also include requestable Plex plus Seerr options with the same vibe." });
  }

  return uniqueRefinementOptions(options).slice(0, 3);
}

function uniqueRefinementOptions(options: RefinementOption[]) {
  const seen = new Set<string>();
  return options.filter((option) => {
    const key = option.label.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatList(values: string[]) {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}
