import type { MediaType, SearchFilters } from "../../shared/types";

export interface RecommendationIntent {
  query: string;
  terms: string[];
  softGenres: string[];
  moods: string[];
  referenceTitle?: string;
  hardFilters: SearchFilters;
  wantsBetter: boolean;
  wantsRequestOptions: boolean;
}

const genreTerms: Record<string, string> = {
  action: "Action",
  adventure: "Adventure",
  animated: "Animation",
  animation: "Animation",
  comedy: "Comedy",
  funny: "Comedy",
  "feel-good": "Comedy",
  feelgood: "Comedy",
  documentary: "Documentary",
  drama: "Drama",
  family: "Family",
  fantasy: "Fantasy",
  horror: "Horror",
  mystery: "Mystery",
  romance: "Romance",
  "sci-fi": "Science Fiction",
  scifi: "Science Fiction",
  thriller: "Thriller"
};

const moodTerms = new Set([
  "cozy",
  "feel-good",
  "feelgood",
  "funny",
  "gentle",
  "light",
  "warm",
  "weird",
  "witty",
  "short",
  "clever",
  "comfort",
  "tonight"
]);

const stopWords = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "like",
  "but",
  "under",
  "hours",
  "hour",
  "movie",
  "film",
  "show",
  "series",
  "tonight",
  "something",
  "start",
  "watch",
  "available",
  "request",
  "recommendations"
]);

export function parseRecommendationIntent(query: string): RecommendationIntent {
  const normalized = query.toLowerCase();
  const terms = tokenize(query);
  const hardFilters: SearchFilters = {};
  const mediaTypes: MediaType[] = [];

  if (/\b(movie|film)\b/.test(normalized)) mediaTypes.push("movie");
  if (/\b(tv|series|show)\b/.test(normalized)) mediaTypes.push("tv");
  if (mediaTypes.length) hardFilters.mediaTypes = [...new Set(mediaTypes)];
  if (/under\s+(two|2)\s+hours?/.test(normalized)) hardFilters.maxRuntimeMinutes = 120;
  if (/\bshort\b/.test(normalized) && hardFilters.mediaTypes?.includes("tv")) hardFilters.maxRuntimeMinutes = 600;

  return {
    query,
    terms,
    softGenres: [...new Set(terms.flatMap((term) => genreTerms[term] ?? []))],
    moods: terms.filter((term) => moodTerms.has(term)),
    referenceTitle: extractReferenceTitle(query),
    hardFilters,
    wantsBetter: /\bbetter\b/.test(normalized),
    wantsRequestOptions: /\b(request|requestable|don't have|dont have|not in plex|unavailable)\b/.test(normalized)
  };
}

export function mergeHardFilters(intentFilters: SearchFilters, explicitFilters: SearchFilters): SearchFilters {
  return {
    ...intentFilters,
    ...explicitFilters,
    mediaTypes: explicitFilters.mediaTypes?.length ? explicitFilters.mediaTypes : intentFilters.mediaTypes,
    genres: explicitFilters.genres?.length ? explicitFilters.genres : undefined,
    availability: explicitFilters.availability?.length ? explicitFilters.availability : intentFilters.availability,
    requestStatus: explicitFilters.requestStatus?.length ? explicitFilters.requestStatus : intentFilters.requestStatus
  };
}

export function tokenize(value: string) {
  return [
    ...new Set(
      value
        .toLowerCase()
        .split(/[^a-z0-9-]+/)
        .filter((term) => term.length > 2 && !stopWords.has(term))
    )
  ];
}

function extractReferenceTitle(query: string) {
  const match = query.match(/\blike\s+(.+?)(?:\.|\s+less\s+like|\s+more\s+like|\s+but|\s+under|\s+for|\s+with|$)/i);
  const title = match?.[1]?.replace(/\s+and\s+.+$/i, "").trim();
  return title || undefined;
}
