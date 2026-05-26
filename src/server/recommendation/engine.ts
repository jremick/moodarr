import type { ItemSummary, RefinementOption, SearchRequest, SearchResponse, WatchContext } from "../../shared/types";
import { describeRuntimeRange } from "../../shared/runtime";
import type { BriefParser, ParsedBriefSignals } from "../ai/briefParser";
import { DeterministicBriefParser } from "../ai/briefParser";
import type { EmbeddingProvider } from "../ai/embeddings";
import type { AiRanker } from "../ai/ranker";
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
    private readonly briefParser: BriefParser = new DeterministicBriefParser()
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
    const summary = ranked.summary || buildSearchSummary(scored.filters, watchContext, resultLimit, results);
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
  return {
    ...deterministic,
    terms: unique([...deterministic.terms, ...(parsed.terms ?? [])].map((term) => term.toLowerCase())),
    softGenres: unique([...deterministic.softGenres, ...(parsed.softGenres ?? [])]),
    moods: unique([...deterministic.moods, ...(parsed.moods ?? [])].map((mood) => mood.toLowerCase())),
    referenceTitle: deterministic.referenceTitle ?? parsed.referenceTitle,
    hardFilters,
    wantsBetter: deterministic.wantsBetter || Boolean(parsed.wantsBetter),
    wantsRequestOptions: deterministic.wantsRequestOptions || Boolean(parsed.wantsRequestOptions)
  };
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
    return `I’m looking for ${filterSummary}, but I don’t have a strong match in the cached Plex and Seerr data yet. Try loosening the runtime, availability, or style constraints.`;
  }

  const topTitles = formatList(results.slice(0, 3).map((item) => item.title));
  const availability = results.some((item) => item.availabilityGroup !== "available_in_plex")
    ? "I’m also keeping request status visible where Plex does not already have the item."
    : "Everything shown first is already available in Plex.";
  return `I’m looking for ${filterSummary}. I’d start with ${topTitles}; they line up best on availability, runtime, ratings, and metadata. ${availability}`;
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
