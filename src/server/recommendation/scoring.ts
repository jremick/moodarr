import type { AvailabilityGroup, ItemDetail, ItemSummary, SearchFilters, WatchContext } from "../../shared/types";
import { mergeHardFilters, parseRecommendationIntent, tokenize, type RecommendationIntent } from "./intent";
import { getPreferenceProfile } from "./preferences";
import type { RetrievalContext } from "./retrieval";

const moodLexicon: Record<string, string[]> = {
  funny: ["comedy", "sitcom", "farce", "jokes", "light", "witty"],
  comedy: ["comedy", "sitcom", "funny", "farce"],
  fantasy: ["fantasy", "magic", "witch", "powers", "adventure", "myth"],
  "feel-good": ["feel good", "warm", "kind", "gentle", "friendship", "family", "heart"],
  feelgood: ["feel good", "warm", "kind", "gentle", "friendship", "family", "heart"],
  cozy: ["warm", "gentle", "small town", "friendship", "comfort"],
  short: ["short", "miniseries", "limited"],
  clever: ["witty", "smart", "satire", "mystery"],
  weird: ["surreal", "offbeat", "strange", "quirky"],
  romantic: ["romance", "heart", "warm", "date night"],
  tense: ["thriller", "suspense", "dark", "danger"],
  gentle: ["warm", "family", "kind", "comfort"],
  warm: ["feel good", "gentle", "friendship", "comfort"],
  light: ["comedy", "easy", "breezy", "low commitment"],
  intense: ["thriller", "horror", "dark", "violent"]
};

export interface RecommendationScoringResult {
  intent: RecommendationIntent;
  filters: SearchFilters;
  results: ItemSummary[];
}

export interface ScoringContext extends Partial<RetrievalContext> {
  allItems?: ItemDetail[];
  hiddenItemIds?: Set<string>;
  preferenceWeights?: Map<string, number>;
}

export function scoreLibraryCandidates(
  items: ItemDetail[],
  query: string,
  explicitFilters: SearchFilters,
  watchContext: WatchContext,
  context: ScoringContext = {}
): RecommendationScoringResult {
  const intent = parseRecommendationIntent(query);
  const filters = mergeHardFilters(intent.hardFilters, explicitFilters);
  const allItems = context.allItems ?? items;
  const reference = resolveReference(intent.referenceTitle, allItems);
  const profile = getPreferenceProfile(watchContext);

  const scoredResults = items
    .filter((item) => !context.hiddenItemIds?.has(item.id))
    .filter((item) => matchesFilters(item, filters))
    .map((item) => scoreItem(item, allItems, intent, filters, reference, profile, context))
    .filter((item) => item.score > 0 || intent.terms.length === 0)
    .sort((a, b) => b.score - a.score || availabilityRank(a.availabilityGroup) - availabilityRank(b.availabilityGroup) || a.title.localeCompare(b.title));
  const results = diversifyRankedCandidates(scoredResults, intent, filters, watchContext);

  return { intent, filters, results };
}

export function selectRerankCandidates(candidates: ItemSummary[], resultLimit: number) {
  const target = Math.min(60, Math.max(resultLimit + 5, resultLimit * 2));
  const selected = new Map<string, ItemSummary>();

  for (const candidate of candidates.slice(0, Math.min(candidates.length, Math.ceil(target * 0.62)))) {
    selected.set(candidate.id, candidate);
  }

  for (const group of ["available_in_plex", "not_in_plex_requestable", "already_requested", "partially_available", "unavailable"] satisfies AvailabilityGroup[]) {
    for (const candidate of candidates.filter((item) => item.availabilityGroup === group).slice(0, 8)) {
      selected.set(candidate.id, candidate);
    }
  }

  for (const mediaType of ["movie", "tv"] as const) {
    for (const candidate of candidates.filter((item) => item.mediaType === mediaType).slice(0, 8)) {
      selected.set(candidate.id, candidate);
    }
  }

  return [...selected.values()].slice(0, target);
}

export function shouldAugmentWithSeerr(results: ItemSummary[], resultLimit: number, intent: RecommendationIntent, filters: SearchFilters) {
  if (filters.availability?.some((group) => group !== "available_in_plex")) return true;
  if (intent.wantsRequestOptions) return true;
  if (results.length < Math.min(10, resultLimit)) return true;
  const top = results.slice(0, Math.min(results.length, Math.max(8, resultLimit)));
  if (top.length === 0) return true;
  if (top.every((candidate) => candidate.availabilityGroup === "available_in_plex")) return true;
  return top[0].score < 52;
}

export function seerrSearchQueries(intent: RecommendationIntent) {
  const queries = [stripExcludedGenrePhrases(intent.query, intent.hardFilters.excludedGenres)];
  if (intent.referenceTitle) queries.push(intent.referenceTitle);
  const compact = [...intent.softGenres, ...intent.moods].slice(0, 4).join(" ");
  if (compact && compact.toLowerCase() !== intent.query.toLowerCase()) queries.push(compact);
  return [...new Set(queries.filter((query) => query.trim().length > 0))].slice(0, 3);
}

function scoreItem(
  item: ItemDetail,
  allItems: ItemDetail[],
  intent: RecommendationIntent,
  filters: SearchFilters,
  reference: ItemDetail | undefined,
  profile: ReturnType<typeof getPreferenceProfile>,
  context: ScoringContext
): ItemSummary {
  const haystack = searchableText(item);
  const genreText = item.genres.join(" ").toLowerCase();
  const peopleText = [...item.cast, ...item.directors].join(" ").toLowerCase();
  let queryScore = 0;
  let moodScore = context.moodScores?.get(item.id) ?? 50;
  let referenceScore = 0;
  let tasteScore = 0;
  let preferenceScore = 50;
  let availabilityScore = 0;
  let qualityScore = qualitySignal(item);
  let semanticScore = Math.max(context.semanticScores?.get(item.id) ?? 0, context.providerEmbeddingScores?.get(item.id) ?? 0);
  const feedbackScore = context.feedbackScores?.get(item.id) ?? 50;
  let frictionScore = frictionSignal(item, intent, profile.context);
  let noveltyScore = 80;
  let strongQueryEvidence = false;
  const reasons: string[] = [];
  const feature = context.features?.get(item.id);

  for (const term of intent.terms) {
    if (item.title.toLowerCase().includes(term)) {
      queryScore += 24;
      strongQueryEvidence = true;
      reasons.push(`title fit for "${term}"`);
    } else if (genreText.includes(term)) {
      queryScore += 16;
      reasons.push(`${term} genre fit`);
    } else if (peopleText.includes(term)) {
      queryScore += 10;
      strongQueryEvidence = true;
      reasons.push(`${term} person metadata`);
    } else if (haystack.includes(term)) {
      queryScore += 6;
    }

    for (const expansion of moodLexicon[term] ?? []) {
      if (haystack.includes(expansion)) {
        queryScore += 7;
        moodScore += 5;
      }
    }
  }

  for (const mood of intent.moods) {
    if (featureTermMatch(feature, mood) || haystack.includes(mood)) {
      moodScore += 18;
      reasons.push(`${mood} mood`);
    }
    for (const expansion of moodLexicon[mood] ?? []) {
      if (featureTermMatch(feature, expansion) || haystack.includes(expansion)) moodScore += 6;
    }
  }

  for (const genre of intent.softGenres) {
    if (item.genres.some((itemGenre) => itemGenre.toLowerCase() === genre.toLowerCase())) {
      queryScore += 18;
      moodScore += 8;
      reasons.push(`${genre.toLowerCase()} genre`);
    } else {
      queryScore -= 7;
      moodScore -= 5;
    }
  }

  const lexicalScore = context.lexicalRanks?.get(item.id);
  if (lexicalScore) queryScore += Math.round(lexicalScore * 0.18);

  if (reference && reference.id !== item.id) {
    if (item.mediaType === reference.mediaType) {
      queryScore += 8;
      referenceScore += 14;
    } else {
      queryScore -= 6;
      referenceScore -= 16;
    }
    const overlap = overlapCount(reference.genres, item.genres);
    if (overlap > 0) {
      queryScore += Math.min(34, overlap * 12);
      referenceScore += Math.min(38, overlap * 16);
      reasons.push(`shares ${overlap} genre${overlap === 1 ? "" : "s"} with ${reference.title}`);
    }
    const sharedPeople = overlapCount([...reference.cast, ...reference.directors], [...item.cast, ...item.directors]);
    if (sharedPeople > 0) {
      queryScore += Math.min(20, sharedPeople * 8);
      referenceScore += Math.min(24, sharedPeople * 10);
      reasons.push(`shares people with ${reference.title}`);
    }
    const summaryOverlap = overlapCount(tokenize(reference.summary ?? ""), tokenize(item.summary ?? ""));
    queryScore += Math.min(18, summaryOverlap * 3);
    referenceScore += Math.min(24, summaryOverlap * 4);
    if (context.features?.get(reference.id) && context.features?.get(item.id)) {
      semanticScore = Math.max(semanticScore, Math.round((context.semanticScores?.get(item.id) ?? 0) * 0.7 + overlap * 7));
      referenceScore = Math.max(referenceScore, Math.round((context.semanticScores?.get(item.id) ?? 0) * 0.7 + overlap * 9));
    }
  } else if (reference?.id === item.id) {
    if (intent.wantsBetter) {
      queryScore -= 28;
      qualityScore -= 34;
      noveltyScore = 20;
      referenceScore = 0;
      reasons.push(`reference target to improve on`);
    } else {
      referenceScore = 58;
    }
  }

  if (matchesRuntimeRange(item.runtimeMinutes, intent.hardFilters)) {
    queryScore += 14;
  }
  if (intent.wantsBetter && qualityScore >= 76) {
    qualityScore += 12;
    if (item.availabilityGroup === "available_in_plex") qualityScore += 8;
    if (item.availabilityGroup === "already_requested") qualityScore -= 8;
    reasons.push("stronger quality signal than the reference target");
  }

  availabilityScore = availabilitySignal(item.availabilityGroup);
  if (intent.wantsRequestOptions && item.availabilityGroup === "not_in_plex_requestable") availabilityScore += 12;
  if (filters.availability?.includes(item.availabilityGroup)) availabilityScore += 8;

  tasteScore = average([
    runtimeTaste(item.runtimeMinutes, profile.runtimeSweetSpot),
    groupGenreTaste(item, profile.context),
    maturityTaste(item.contentRating, profile.maturityTolerance)
  ]);
  if (item.mediaType === "tv" && /\b(start|short|series)\b/i.test(intent.query)) tasteScore += 12;
  if (item.mediaType === "tv" && !intent.hardFilters.mediaTypes?.includes("tv") && /\btonight|movie|film\b/i.test(intent.query)) {
    tasteScore -= 28;
    frictionScore -= 12;
  }
  if (context.hiddenItemIds?.has(item.id)) noveltyScore = 0;
  preferenceScore = learnedPreferenceScore(item, context.features?.get(item.id), context.preferenceWeights);

  const normalized = {
    query: normalizeQueryBucket(queryScore, strongQueryEvidence),
    semantic: clamp(semanticScore),
    mood: normalizeMoodBucket(moodScore, intent),
    reference: clamp(referenceScore),
    taste: clamp(tasteScore),
    preference: clamp(preferenceScore),
    feedback: clamp(feedbackScore),
    availability: clamp(availabilityScore),
    quality: clamp(qualityScore),
    friction: clamp(frictionScore),
    novelty: clamp(noveltyScore),
    diversity: 50
  };
  const score = Math.round(
    normalized.query * profile.weights.query +
      normalized.semantic * profile.weights.semantic +
      normalized.mood * profile.weights.mood +
      normalized.reference * profile.weights.reference +
      normalized.taste * profile.weights.taste +
      normalized.preference * profile.weights.preference +
      normalized.feedback * profile.weights.feedback +
      normalized.availability * profile.weights.availability +
      normalized.quality * profile.weights.quality +
      normalized.friction * profile.weights.friction +
      normalized.novelty * profile.weights.novelty +
      normalized.diversity * profile.weights.diversity
  );

  return {
    ...item,
    score,
    scoreBreakdown: normalized,
    matchExplanation: buildExplanation(item, reasons, normalized)
  };
}

function matchesFilters(item: ItemDetail, filters: SearchFilters) {
  if (!isRecommendationEligible(item)) return false;
  if (filters.mediaTypes?.length && !filters.mediaTypes.includes(item.mediaType)) return false;
  if (filters.minRuntimeMinutes && item.runtimeMinutes && item.runtimeMinutes < filters.minRuntimeMinutes) return false;
  if (filters.maxRuntimeMinutes && item.runtimeMinutes && item.runtimeMinutes > filters.maxRuntimeMinutes) return false;
  if (filters.minYear && item.year && item.year < filters.minYear) return false;
  if (filters.maxYear && item.year && item.year > filters.maxYear) return false;
  if (filters.genres?.length && !filters.genres.some((genre) => item.genres.map((entry) => entry.toLowerCase()).includes(genre.toLowerCase()))) return false;
  if (filters.excludedGenres?.length && filters.excludedGenres.some((genre) => hasExcludedGenreEvidence(item, genre))) return false;
  if (filters.contentRating && item.contentRating !== filters.contentRating) return false;
  if (filters.availability?.length && !filters.availability.includes(item.availabilityGroup)) return false;
  if (filters.requestStatus?.length && !filters.requestStatus.includes(item.seerr?.requestStatus ?? "")) return false;
  return true;
}

function featureTermMatch(feature: { moodTerms: string[]; toneTerms: string[]; watchabilityTerms: string[]; featureText: string } | undefined, term: string) {
  if (!feature) return false;
  const normalized = term.toLowerCase();
  return [...feature.moodTerms, ...feature.toneTerms, ...feature.watchabilityTerms].some((value) => value.toLowerCase() === normalized) || feature.featureText.toLowerCase().includes(normalized);
}

function isRecommendationEligible(item: ItemDetail) {
  if (item.plex?.available) return true;
  if (!item.seerr) return true;
  if (item.metadata?.sparse) return false;
  if (item.availabilityGroup === "not_in_plex_requestable") {
    return Boolean(item.metadata?.hasPoster && item.summary?.trim() && item.genres.length > 0);
  }
  return true;
}

function stripExcludedGenrePhrases(query: string, excludedGenres: string[] | undefined) {
  if (!excludedGenres?.some((genre) => genre.toLowerCase() === "animation")) return query;
  return query
    .replace(/\b(?:not|no|without)\s+(?:animated|animation|cartoons?|anime)\b/gi, "")
    .replace(/\bnon[-\s]?animated\b/gi, "")
    .replace(/\blive[-\s]?action\b/gi, "")
    .replace(/\b(?:animated|animation|anime|cartoons?)\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function hasExcludedGenreEvidence(item: ItemDetail, genre: string) {
  const normalizedGenre = genre.toLowerCase();
  if (item.genres.some((entry) => entry.toLowerCase() === normalizedGenre)) return true;
  if (normalizedGenre !== "animation") return false;

  const title = item.title.toLowerCase();
  const summary = item.summary?.toLowerCase() ?? "";
  if (/\b(?:animated|animation|anime)\b/.test(`${title} ${summary}`)) return true;
  return /\b(?:cartoon|cartoons)\b/.test(title);
}

function matchesRuntimeRange(runtime: number | undefined, filters: SearchFilters) {
  if (!runtime) return false;
  if (filters.minRuntimeMinutes && runtime < filters.minRuntimeMinutes) return false;
  if (filters.maxRuntimeMinutes && runtime > filters.maxRuntimeMinutes) return false;
  return Boolean(filters.minRuntimeMinutes || filters.maxRuntimeMinutes);
}

function searchableText(item: ItemDetail) {
  return `${item.title} ${item.summary ?? ""} ${item.genres.join(" ")} ${item.cast.join(" ")} ${item.directors.join(" ")} ${item.contentRating ?? ""}`.toLowerCase();
}

function resolveReference(referenceTitle: string | undefined, items: ItemDetail[]) {
  if (!referenceTitle) return undefined;
  const normalized = referenceTitle.toLowerCase();
  return items.find((item) => item.title.toLowerCase() === normalized) ?? items.find((item) => item.title.toLowerCase().includes(normalized));
}

function qualitySignal(item: ItemDetail) {
  const ratings = [item.ratings.critic, item.ratings.audience, item.ratings.user].map(normalizeRating).filter((value): value is number => typeof value === "number");
  if (ratings.length === 0) return 42;
  return ratings.reduce((sum, value) => sum + value, 0) / ratings.length;
}

function normalizeRating(value: number | undefined) {
  if (typeof value !== "number") return undefined;
  return value <= 10 ? value * 10 : value;
}

function availabilitySignal(group: AvailabilityGroup) {
  if (group === "available_in_plex") return 96;
  if (group === "not_in_plex_requestable") return 70;
  if (group === "partially_available") return 56;
  if (group === "already_requested") return 46;
  return 18;
}

function availabilityRank(group: AvailabilityGroup) {
  return ["available_in_plex", "not_in_plex_requestable", "partially_available", "already_requested", "unavailable"].indexOf(group);
}

function runtimeTaste(runtime: number | undefined, sweetSpot: number) {
  if (!runtime) return 42;
  if (runtime <= sweetSpot) return 82;
  if (runtime <= sweetSpot + 30) return 62;
  return 34;
}

function groupGenreTaste(item: ItemDetail, context: WatchContext) {
  const genres = item.genres.map((genre) => genre.toLowerCase());
  if (context === "group") {
    let score = 48;
    if (genres.some((genre) => ["comedy", "adventure", "family", "animation", "fantasy"].includes(genre))) score += 26;
    if (genres.includes("horror")) score -= 18;
    return score;
  }
  let score = 52;
  if (genres.some((genre) => ["comedy", "fantasy", "adventure", "mystery", "thriller", "drama"].includes(genre))) score += 16;
  return score;
}

function maturityTaste(contentRating: string | undefined, tolerance: "normal" | "shared-screen") {
  if (!contentRating) return 50;
  if (tolerance === "normal") return 58;
  if (["G", "PG", "TV-G", "TV-PG"].includes(contentRating)) return 78;
  if (["PG-13", "TV-14"].includes(contentRating)) return 60;
  if (["R", "NC-17", "TV-MA"].includes(contentRating)) return 34;
  return 50;
}

function frictionSignal(item: ItemDetail, intent: RecommendationIntent, context: WatchContext) {
  let score = 68;
  const query = intent.query.toLowerCase();
  const wantsLowCommitment = /\b(?:short|quick|easy|light|low[-\s]?commitment|tired|background)\b/.test(query);
  const wantsIntensity = /\b(?:intense|tense|thriller|horror|dark)\b/.test(query);
  const rating = item.contentRating?.toUpperCase();
  if (item.runtimeMinutes) {
    if (item.mediaType === "movie") {
      if (item.runtimeMinutes <= 95) score += wantsLowCommitment ? 24 : 10;
      else if (item.runtimeMinutes <= 125) score += 8;
      else if (item.runtimeMinutes > 150) score -= wantsLowCommitment ? 34 : 16;
    } else {
      if (item.runtimeMinutes <= 240) score += wantsLowCommitment ? 22 : 8;
      else if (item.runtimeMinutes > 900) score -= wantsLowCommitment ? 36 : 18;
    }
  }
  if (context === "group") {
    if (rating && ["G", "PG", "TV-G", "TV-PG"].includes(rating)) score += 14;
    if (rating && ["R", "NC-17", "TV-MA"].includes(rating)) score -= 22;
  }
  const genres = item.genres.map((genre) => genre.toLowerCase());
  if (genres.includes("horror") && !wantsIntensity) score -= context === "group" ? 24 : 12;
  if (wantsIntensity && genres.some((genre) => ["thriller", "horror", "mystery"].includes(genre))) score += 18;
  return score;
}

function overlapCount(left: string[], right: string[]) {
  const rightSet = new Set(right.map((value) => value.toLowerCase()));
  return left.filter((value) => rightSet.has(value.toLowerCase())).length;
}

function average(values: number[]) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildExplanation(item: ItemDetail, reasons: string[], scores: ItemSummary["scoreBreakdown"]) {
  const uniqueReasons = [...new Set(reasons.map(readableReason))].slice(0, 2);
  if (uniqueReasons.length > 0) {
    return `Good fit because of ${formatReasons(uniqueReasons)}. ${availabilityPhrase(item.availabilityGroup)}`;
  }
  if ((scores?.quality ?? 0) > 75) return `Good fit from the mood, style, and overall quality signals. ${availabilityPhrase(item.availabilityGroup)}`;
  return `Good fit based on the available mood, style, availability, and library metadata. ${availabilityPhrase(item.availabilityGroup)}`;
}

function learnedPreferenceScore(item: ItemDetail, feature: { moodTerms: string[]; toneTerms: string[]; watchabilityTerms: string[] } | undefined, weights: Map<string, number> | undefined) {
  if (!weights?.size) return 50;
  const keys = [
    `media:${item.mediaType}`,
    ...item.genres.map((genre) => `genre:${normalizeFeatureKey(genre)}`),
    ...(feature?.moodTerms ?? []).map((term) => `mood:${normalizeFeatureKey(term)}`),
    ...(feature?.toneTerms ?? []).map((term) => `tone:${normalizeFeatureKey(term)}`),
    ...(feature?.watchabilityTerms ?? []).map((term) => `watch:${normalizeFeatureKey(term)}`),
    runtimePreferenceFeature(item.runtimeMinutes, item.mediaType),
    ratingPreferenceFeature(item.contentRating)
  ].filter((key): key is string => Boolean(key));
  const total = keys.reduce((sum, key) => sum + (weights.get(key) ?? 0), 0);
  return 50 + total * 7;
}

function normalizeFeatureKey(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function runtimePreferenceFeature(runtime: number | undefined, mediaType: ItemDetail["mediaType"]) {
  if (!runtime) return undefined;
  if (mediaType === "tv") return runtime <= 600 ? "runtime:short-series" : "runtime:long-series";
  if (runtime <= 95) return "runtime:short-movie";
  if (runtime <= 125) return "runtime:normal-movie";
  return "runtime:long-movie";
}

function ratingPreferenceFeature(contentRating: string | undefined) {
  return contentRating ? `rating:${normalizeFeatureKey(contentRating)}` : undefined;
}

function readableReason(reason: string) {
  return reason
    .replace(/^title fit for "(.+)"$/i, 'the exact "$1" cue')
    .replace(/^(.+) genre fit$/i, "$1 style")
    .replace(/^(.+) genre$/i, "$1 style")
    .replace(/^(.+) person metadata$/i, 'people metadata matching "$1"');
}

function formatReasons(reasons: string[]) {
  if (reasons.length <= 1) return reasons[0] ?? "the available metadata";
  return `${reasons.slice(0, -1).join(", ")} and ${reasons[reasons.length - 1]}`;
}

function diversifyRankedCandidates(candidates: ItemSummary[], intent: RecommendationIntent, filters: SearchFilters, watchContext: WatchContext) {
  if (candidates.length <= 3) return candidates.map((candidate, index) => applyDiversityScore(candidate, index === 0 ? 100 : 78));
  const poolSize = Math.min(candidates.length, 120);
  const pool = candidates.slice(0, poolSize);
  const remaining = new Set(pool.map((candidate) => candidate.id));
  const protectedCount = precisionProtectedCount(intent, filters, watchContext, pool.length);
  const selected = pool.slice(0, protectedCount).map((candidate, index) => applyDiversityScore(candidate, index === 0 ? 100 : 88));
  for (const candidate of selected) remaining.delete(candidate.id);
  const lambda = diversityLambda(intent, filters, watchContext);

  while (selected.length < pool.length) {
    let best: ItemSummary | undefined;
    let bestMmr = Number.NEGATIVE_INFINITY;
    let bestDiversityScore = 100;
    for (const candidate of pool) {
      if (!remaining.has(candidate.id)) continue;
      const maxSimilarity = selected.length === 0 ? 0 : Math.max(...selected.map((item) => candidateSimilarity(candidate, item)));
      const relevance = candidate.score / 100;
      const mmr = lambda * relevance - (1 - lambda) * maxSimilarity;
      if (mmr > bestMmr || (mmr === bestMmr && candidate.score > (best?.score ?? 0))) {
        best = candidate;
        bestMmr = mmr;
        bestDiversityScore = Math.round((1 - maxSimilarity) * 100);
      }
    }
    if (!best) break;
    remaining.delete(best.id);
    selected.push(applyDiversityScore(best, bestDiversityScore));
  }

  const selectedIds = new Set(selected.map((candidate) => candidate.id));
  return [...selected, ...candidates.slice(poolSize), ...candidates.slice(0, poolSize).filter((candidate) => !selectedIds.has(candidate.id))];
}

function precisionProtectedCount(intent: RecommendationIntent, filters: SearchFilters, watchContext: WatchContext, poolLength: number) {
  if (poolLength <= 3) return 0;
  const query = intent.query.toLowerCase();
  const broadExploration = /\b(?:anything|options|ideas|surprise|surprise me|browse)\b/.test(query);
  if (broadExploration && !intent.referenceTitle && !filters.mediaTypes?.length && intent.softGenres.length === 0 && intent.moods.length === 0) return 1;
  if (intent.referenceTitle || intent.wantsBetter || filters.mediaTypes?.length || filters.availability?.length) return Math.min(3, poolLength);
  if (intent.softGenres.length > 0 || intent.moods.length > 0) return watchContext === "group" ? Math.min(3, poolLength) : Math.min(2, poolLength);
  return 1;
}

function diversityLambda(intent: RecommendationIntent, filters: SearchFilters, watchContext: WatchContext) {
  const query = intent.query.toLowerCase();
  if (filters.genres?.length || /\b(?:only|strictly|exactly|just)\b/.test(query)) return 0.9;
  if (intent.referenceTitle && !/\b(?:or|something|options|ideas|anything)\b/.test(query)) return 0.86;
  if (intent.softGenres.length || intent.moods.length) return 0.88;
  if (watchContext === "group") return 0.82;
  if (/\b(?:something|anything|options|ideas|weird|mood)\b/.test(query)) return 0.76;
  return 0.82;
}

function applyDiversityScore(candidate: ItemSummary, diversityScore: number): ItemSummary {
  const normalized = clamp(diversityScore);
  return {
    ...candidate,
    scoreBreakdown: candidate.scoreBreakdown ? { ...candidate.scoreBreakdown, diversity: normalized } : undefined
  };
}

function candidateSimilarity(left: ItemSummary, right: ItemSummary) {
  const leftTerms = diversityTerms(left);
  const rightTerms = diversityTerms(right);
  if (leftTerms.size === 0 || rightTerms.size === 0) return 0;
  const intersection = [...leftTerms].filter((term) => rightTerms.has(term)).length;
  const union = new Set([...leftTerms, ...rightTerms]).size;
  const genreOverlap = intersection / union;
  const sameType = left.mediaType === right.mediaType ? 0.08 : 0;
  const runtimeSimilarity = runtimeBucket(left) === runtimeBucket(right) ? 0.08 : 0;
  return Math.min(1, genreOverlap + sameType + runtimeSimilarity);
}

function diversityTerms(item: ItemSummary) {
  return new Set([
    ...item.genres.map((genre) => `genre:${normalizeFeatureKey(genre)}`),
    `availability:${item.availabilityGroup}`,
    item.mediaType,
    runtimeBucket(item)
  ]);
}

function runtimeBucket(item: ItemSummary) {
  const runtime = item.runtimeMinutes;
  if (!runtime) return "runtime:unknown";
  if (item.mediaType === "tv") return runtime <= 240 ? "runtime:short-series" : runtime <= 600 ? "runtime:medium-series" : "runtime:long-series";
  return runtime <= 95 ? "runtime:short-movie" : runtime <= 125 ? "runtime:normal-movie" : "runtime:long-movie";
}

function availabilityPhrase(group: AvailabilityGroup) {
  if (group === "available_in_plex") return "It is already available in Plex.";
  if (group === "not_in_plex_requestable") return "It is not in Plex but appears requestable.";
  if (group === "already_requested") return "It already has request activity in Seerr.";
  if (group === "partially_available") return "Availability is partial, so Plex and Seerr should both be checked.";
  return "No usable local or request status is cached yet.";
}

function clamp(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function normalizeQueryBucket(value: number, strongEvidence: boolean) {
  const clamped = clamp(value);
  if (strongEvidence) return clamped;
  return Math.min(clamped, 92);
}

function normalizeMoodBucket(value: number, intent: RecommendationIntent) {
  const clamped = clamp(value);
  if (hasSpecificMoodIntent(intent)) return clamped;
  return Math.min(clamped, 88);
}

function hasSpecificMoodIntent(intent: RecommendationIntent) {
  const query = intent.query.toLowerCase();
  return (
    intent.moods.some((mood) => !["funny", "light", "tonight"].includes(mood)) ||
    /\b(?:feel[-\s]?good|cozy|comfort|gentle|warm|weird|offbeat|romantic|tense|suspenseful|clever|short|low[-\s]?commitment|dark|intense)\b/.test(query)
  );
}
