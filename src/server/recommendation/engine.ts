import type { ItemSummary, RefinementOption, SearchRequest, SearchResponse, WatchContext } from "../../shared/types";
import type { BriefParser, ParsedBriefSignals } from "../ai/briefParser";
import { DeterministicBriefParser } from "../ai/briefParser";
import type { EmbeddingProvider } from "../ai/embeddings";
import type { AiRanker } from "../ai/ranker";
import type { FeedbackItem, TasteScout } from "../ai/tasteScout";
import { NoopTasteScout } from "../ai/tasteScout";
import type { MediaRepository } from "../db/mediaRepository";
import type { SeerrClient } from "../integrations/seerrClient";
import { buildRecommendationBrief } from "./brief";
import { mergeHardFilters, parseRecommendationIntent, type RecommendationIntent } from "./intent";
import { retrieveRecommendationCandidates, type RetrievalResult } from "./retrieval";
import { scoreLibraryCandidates, seerrSearchQueries, selectRerankCandidates, shouldAugmentWithSeerr } from "./scoring";

export const recommendationEngineVersion = "hybrid-v2";

export class RecommendationEngine {
  constructor(
    private readonly repository: MediaRepository,
    private readonly seerrClient: SeerrClient,
    private readonly ranker: AiRanker,
    private readonly embeddingProvider?: EmbeddingProvider,
    private readonly briefParser: BriefParser = new DeterministicBriefParser(),
    private readonly tasteScout: TasteScout = new NoopTasteScout()
  ) {}

  async recommend(request: SearchRequest): Promise<SearchResponse> {
    const startedAt = Date.now();
    const resultLimit = clampResultLimit(request.resultLimit);
    const watchContext = normalizeWatchContext(request.watchContext);
    let seerrAugmented = false;
    const resolvedBrief = await this.resolveBrief(request, watchContext, resultLimit);
    const { brief, filters } = resolvedBrief;
    const scoredRequest = { ...request, filters };
    let retrieved = await retrieveRecommendationCandidates(this.repository, brief, this.embeddingProvider);
    let scored = scoreRetrievedCandidates(this.repository, retrieved, scoredRequest, watchContext);

    if (shouldAugmentWithSeerr(scored.results, resultLimit, scored.intent, scored.filters)) {
      const seerrRecords = (
        await Promise.all(
          seerrSearchQueries(scored.intent).map((query) =>
            this.seerrClient.search(query).catch(() => [])
          )
        )
      ).flat();
      if (seerrRecords.length > 0) {
        seerrAugmented = true;
        this.repository.upsertMany(seerrRecords);
        retrieved = await retrieveRecommendationCandidates(this.repository, brief, this.embeddingProvider);
        scored = scoreRetrievedCandidates(this.repository, retrieved, scoredRequest, watchContext);
      }
    }

    const rerankCandidates = selectRerankCandidates(scored.results, resultLimit);
    const rankedRequest = {
      ...request,
      filters: scored.filters,
      watchContext
    };
    const feedbackItems = resolveFeedbackItems(this.repository, request.feedbackContext);
    const [ranked, scout] = request.useAi === false
      ? [
          { usedAi: false, results: rerankCandidates },
          { usedAi: false, recommendations: [] as { id: string; score: number; reason?: string }[] }
        ]
      : await Promise.all([
          this.ranker.rank({
            request: rankedRequest,
            candidates: rerankCandidates,
            feedbackItems
          }),
          this.tasteScout.scout({
            request: rankedRequest,
            watchContext,
            candidates: selectTasteScoutCandidates(scored.results, resultLimit),
            feedbackItems
          })
        ]);
    const deterministicWithScout = applyTasteScoutSignals(scored.results, scout.recommendations);
    const rankedWithScout = applyTasteScoutSignals(ranked.results, scout.recommendations);
    const results = mergeRankedResults(rankedWithScout, deterministicWithScout).slice(0, resultLimit);
    this.repository.recordSearch(request.query, results.length, ranked.usedAi);
    const latencyMs = Date.now() - startedAt;
    try {
      this.repository.recordRecommendationRun({
        query: request.query,
        engineVersion: recommendationEngineVersion,
        model: this.ranker.modelName,
        watchContext,
        resultCount: results.length,
        candidateCount: retrieved.context.sourceCounts.selected,
        rerankCandidateCount: rerankCandidates.length,
        usedAi: ranked.usedAi,
        seerrAugmented,
        latencyMs,
        results,
        feedback: request.feedbackContext
      });
    } catch {
      // Telemetry should never break a recommendation response.
    }
    const summary = ranked.summary || scout.summary || buildSearchSummary(request, results, feedbackItems);
    const refinementOptions = ranked.refinementOptions?.length ? ranked.refinementOptions : buildRefinementOptions(request, results);

    return {
      query: request.query,
      usedAi: ranked.usedAi,
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
        aiBriefParsed: resolvedBrief.usedAiBrief,
        tasteScoutUsed: scout.usedAi,
        seerrAugmented,
        latencyMs
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
}

function scoreRetrievedCandidates(repository: MediaRepository, retrieved: RetrievalResult, request: SearchRequest, watchContext: WatchContext) {
  return scoreLibraryCandidates(retrieved.candidates, request.query, request.filters ?? {}, watchContext, {
    ...retrieved.context,
    allItems: retrieved.allItems,
    preferenceWeights: repository.preferenceWeights(watchContext),
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
  if (!value) return 20;
  return Math.max(1, Math.min(50, value));
}

function normalizeWatchContext(value: WatchContext | undefined): WatchContext {
  return value === "group" ? "group" : "solo";
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
    ? "I’m keeping requestable options in the mix where they fit the same mood."
    : "The first picks are already in Plex.";
  return `I’m leaning into ${mood}. I’d start with ${topTitles}; they share the closest feel from your library. ${availability}`;
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
