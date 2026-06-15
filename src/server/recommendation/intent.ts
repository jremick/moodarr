import type { AvailabilityGroup, MediaType, SearchFilters } from "../../shared/types";
import { applyRuntimeRange, extractRuntimeRange } from "../../shared/runtime";

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

const negatedGenrePatterns: Array<{ genre: string; patterns: RegExp[]; terms: string[] }> = [
  {
    genre: "Animation",
    patterns: [/\b(?:not|no|without)\s+(?:animated|animation|cartoons?|anime)\b/, /\bnon[-\s]?animated\b/, /\blive[-\s]?action\b/],
    terms: ["animated", "animation", "cartoon", "cartoons", "anime"]
  }
];

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
  const excludedGenres = extractExcludedGenres(normalized);
  const excludedTerms = new Set(negatedGenrePatterns.filter((entry) => excludedGenres.includes(entry.genre)).flatMap((entry) => entry.terms));
  const terms = tokenize(query).filter((term) => !excludedTerms.has(term));
  const hardFilters: SearchFilters = {};
  const mediaTypes: MediaType[] = [];

  if (/\b(movie|film)\b/.test(normalized)) mediaTypes.push("movie");
  if (/\b(tv|series|show)\b/.test(normalized)) mediaTypes.push("tv");
  if (mediaTypes.length) hardFilters.mediaTypes = [...new Set(mediaTypes)];
  if (excludedGenres.length) hardFilters.excludedGenres = excludedGenres;
  const availability = extractAvailabilityGroups(normalized);
  if (availability.length) hardFilters.availability = availability;
  const runtimeRange = extractRuntimeRange(normalized, hardFilters.mediaTypes);
  if (runtimeRange) Object.assign(hardFilters, applyRuntimeRange(hardFilters, runtimeRange));

  return {
    query,
    terms,
    softGenres: [...new Set(terms.flatMap((term) => genreTerms[term] ?? []))].filter((genre) => !excludedGenres.includes(genre)),
    moods: terms.filter((term) => moodTerms.has(term)),
    referenceTitle: extractReferenceTitle(query),
    hardFilters,
    wantsBetter: /\bbetter\b/.test(normalized),
    wantsRequestOptions: /\b(request|requestable|don't have|dont have|not in plex|unavailable)\b/.test(normalized)
  };
}

export function mergeHardFilters(intentFilters: SearchFilters, explicitFilters: SearchFilters): SearchFilters {
  const excludedGenres = unique([...(intentFilters.excludedGenres ?? []), ...(explicitFilters.excludedGenres ?? [])]);
  return {
    ...intentFilters,
    ...explicitFilters,
    mediaTypes: explicitFilters.mediaTypes?.length ? explicitFilters.mediaTypes : intentFilters.mediaTypes,
    genres: explicitFilters.genres?.length ? explicitFilters.genres : undefined,
    excludedGenres: excludedGenres.length ? excludedGenres : undefined,
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
  const match = query.match(/\blike\s+(.+?)(?:[.;,]|\s+that\b|\s+less\s+like|\s+more\s+like|\s+but|\s+under|\s+for|\s+with|$)/i);
  const title = match?.[1]?.replace(/\s+and\s+.+$/i, "").replace(/[.;,]+$/g, "").trim();
  return title || undefined;
}

function extractExcludedGenres(normalized: string) {
  return unique(negatedGenrePatterns.filter((entry) => entry.patterns.some((pattern) => pattern.test(normalized))).map((entry) => entry.genre));
}

function extractAvailabilityGroups(normalized: string): AvailabilityGroup[] {
  if (/\b(?:plex\s+only|only\s+in\s+plex|already\s+in\s+plex|available\s+in\s+plex|in\s+plex)\b/.test(normalized) && !/\bnot\s+in\s+plex\b/.test(normalized)) {
    return ["available_in_plex"];
  }
  if (/\b(?:only|just|exclusively)\s+(?:requestable|unavailable|not\s+in\s+plex)\b/.test(normalized)) {
    return ["not_in_plex_requestable"];
  }
  if (/\b(?:request|requestable)\b/.test(normalized) && /\b(?:if|when)\b.*\bnot\s+in\s+plex\b/.test(normalized)) {
    return ["available_in_plex", "not_in_plex_requestable"];
  }
  return [];
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
