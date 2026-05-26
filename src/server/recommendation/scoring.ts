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
  weird: ["surreal", "offbeat", "strange", "quirky"]
};

export interface RecommendationScoringResult {
  intent: RecommendationIntent;
  filters: SearchFilters;
  results: ItemSummary[];
}

export interface ScoringContext extends Partial<RetrievalContext> {
  allItems?: ItemDetail[];
  hiddenItemIds?: Set<string>;
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

  const results = items
    .filter((item) => !context.hiddenItemIds?.has(item.id))
    .filter((item) => matchesFilters(item, filters))
    .map((item) => scoreItem(item, allItems, intent, filters, reference, profile, context))
    .filter((item) => item.score > 0 || intent.terms.length === 0)
    .sort((a, b) => b.score - a.score || availabilityRank(a.availabilityGroup) - availabilityRank(b.availabilityGroup) || a.title.localeCompare(b.title));

  return { intent, filters, results };
}

export function selectRerankCandidates(candidates: ItemSummary[], resultLimit: number) {
  const target = Math.min(80, Math.max(36, resultLimit * 4));
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
  const queries = [intent.query];
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
  let tasteScore = 0;
  let availabilityScore = 0;
  let qualityScore = qualitySignal(item);
  let semanticScore = context.semanticScores?.get(item.id) ?? 0;
  const feedbackScore = context.feedbackScores?.get(item.id) ?? 50;
  let noveltyScore = 80;
  const reasons: string[] = [];

  for (const term of intent.terms) {
    if (item.title.toLowerCase().includes(term)) {
      queryScore += 24;
      reasons.push(`title fit for "${term}"`);
    } else if (genreText.includes(term)) {
      queryScore += 16;
      reasons.push(`${term} genre fit`);
    } else if (peopleText.includes(term)) {
      queryScore += 10;
      reasons.push(`${term} person metadata`);
    } else if (haystack.includes(term)) {
      queryScore += 6;
    }

    for (const expansion of moodLexicon[term] ?? []) {
      if (haystack.includes(expansion)) queryScore += 7;
    }
  }

  for (const genre of intent.softGenres) {
    if (item.genres.some((itemGenre) => itemGenre.toLowerCase() === genre.toLowerCase())) {
      queryScore += 18;
      reasons.push(`${genre.toLowerCase()} genre`);
    }
  }

  const lexicalScore = context.lexicalRanks?.get(item.id);
  if (lexicalScore) queryScore += Math.round(lexicalScore * 0.18);

  if (reference && reference.id !== item.id) {
    const overlap = overlapCount(reference.genres, item.genres);
    if (overlap > 0) {
      queryScore += Math.min(34, overlap * 12);
      reasons.push(`shares ${overlap} genre${overlap === 1 ? "" : "s"} with ${reference.title}`);
    }
    const sharedPeople = overlapCount([...reference.cast, ...reference.directors], [...item.cast, ...item.directors]);
    if (sharedPeople > 0) {
      queryScore += Math.min(20, sharedPeople * 8);
      reasons.push(`shares people with ${reference.title}`);
    }
    const summaryOverlap = overlapCount(tokenize(reference.summary ?? ""), tokenize(item.summary ?? ""));
    queryScore += Math.min(18, summaryOverlap * 3);
    if (context.features?.get(reference.id) && context.features?.get(item.id)) {
      semanticScore = Math.max(semanticScore, Math.round((context.semanticScores?.get(item.id) ?? 0) * 0.7 + overlap * 7));
    }
  }

  if (matchesRuntimeRange(item.runtimeMinutes, intent.hardFilters)) {
    queryScore += 14;
  }
  if (intent.wantsBetter && qualityScore >= 76) {
    qualityScore += 12;
    reasons.push("stronger quality signal than the reference target");
  }

  availabilityScore = availabilitySignal(item.availabilityGroup);
  if (intent.wantsRequestOptions && item.availabilityGroup === "not_in_plex_requestable") availabilityScore += 12;
  if (filters.availability?.includes(item.availabilityGroup)) availabilityScore += 8;

  tasteScore += runtimeTaste(item.runtimeMinutes, profile.runtimeSweetSpot);
  tasteScore += groupGenreTaste(item, profile.context);
  tasteScore += maturityTaste(item.contentRating, profile.maturityTolerance);
  if (item.mediaType === "tv" && /\b(start|short|series)\b/i.test(intent.query)) tasteScore += 12;
  if (context.hiddenItemIds?.has(item.id)) noveltyScore = 0;

  const normalized = {
    query: clamp(queryScore),
    semantic: clamp(semanticScore),
    taste: clamp(tasteScore),
    feedback: clamp(feedbackScore),
    availability: clamp(availabilityScore),
    quality: clamp(qualityScore),
    novelty: clamp(noveltyScore)
  };
  const score = Math.round(
    normalized.query * profile.weights.query +
      normalized.semantic * profile.weights.semantic +
      normalized.taste * profile.weights.taste +
      normalized.feedback * profile.weights.feedback +
      normalized.availability * profile.weights.availability +
      normalized.quality * profile.weights.quality +
      normalized.novelty * profile.weights.novelty
  );

  return {
    ...item,
    score,
    scoreBreakdown: normalized,
    matchExplanation: buildExplanation(item, reasons, normalized)
  };
}

function matchesFilters(item: ItemDetail, filters: SearchFilters) {
  if (filters.mediaTypes?.length && !filters.mediaTypes.includes(item.mediaType)) return false;
  if (filters.minRuntimeMinutes && item.runtimeMinutes && item.runtimeMinutes < filters.minRuntimeMinutes) return false;
  if (filters.maxRuntimeMinutes && item.runtimeMinutes && item.runtimeMinutes > filters.maxRuntimeMinutes) return false;
  if (filters.minYear && item.year && item.year < filters.minYear) return false;
  if (filters.maxYear && item.year && item.year > filters.maxYear) return false;
  if (filters.genres?.length && !filters.genres.some((genre) => item.genres.map((entry) => entry.toLowerCase()).includes(genre.toLowerCase()))) return false;
  if (filters.contentRating && item.contentRating !== filters.contentRating) return false;
  if (filters.availability?.length && !filters.availability.includes(item.availabilityGroup)) return false;
  if (filters.requestStatus?.length && !filters.requestStatus.includes(item.seerr?.requestStatus ?? "")) return false;
  return true;
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

function overlapCount(left: string[], right: string[]) {
  const rightSet = new Set(right.map((value) => value.toLowerCase()));
  return left.filter((value) => rightSet.has(value.toLowerCase())).length;
}

function buildExplanation(item: ItemDetail, reasons: string[], scores: ItemSummary["scoreBreakdown"]) {
  const uniqueReasons = [...new Set(reasons.map(readableReason))].slice(0, 2);
  if (uniqueReasons.length > 0) {
    return `Good fit because of ${formatReasons(uniqueReasons)}. ${availabilityPhrase(item.availabilityGroup)}`;
  }
  if ((scores?.quality ?? 0) > 75) return `Good fit from the mood, style, and overall quality signals. ${availabilityPhrase(item.availabilityGroup)}`;
  return `Good fit based on the available mood, style, availability, and library metadata. ${availabilityPhrase(item.availabilityGroup)}`;
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
