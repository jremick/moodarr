import { applyRuntimeRange, describeRuntimeRange, extractRuntimeRange } from "../shared/runtime";
import { maxSearchResultLimit as sharedMaxSearchResultLimit } from "../shared/types";
import type { MediaType, SearchFilters, WatchContext } from "../shared/types";

export const maxSearchQueryLength = 2000;
export const maxSearchResultLimit = sharedMaxSearchResultLimit;

const numberWords: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  "twenty-five": 25,
  thirty: 30,
  forty: 40,
  fifty: 50
};

type AvailabilityScope = "plex" | "plex-seerr";

export interface ChatCriteria {
  query: string;
  filters: SearchFilters;
  resultLimit: number;
  watchContext: WatchContext;
  applied: string[];
}

export function deriveChatCriteria(prompt: string, currentFilters: SearchFilters, currentLimit: number, currentContext: WatchContext): ChatCriteria {
  const normalized = normalizeText(prompt);
  const filters: SearchFilters = {
    ...currentFilters,
    mediaTypes: currentFilters.mediaTypes ? [...currentFilters.mediaTypes] : undefined,
    genres: currentFilters.genres ? [...currentFilters.genres] : undefined,
    excludedGenres: currentFilters.excludedGenres ? [...currentFilters.excludedGenres] : undefined,
    availability: currentFilters.availability ? [...currentFilters.availability] : undefined,
    requestStatus: currentFilters.requestStatus ? [...currentFilters.requestStatus] : undefined
  };
  const applied: string[] = [];
  let resultLimit = currentLimit;
  let watchContext = currentContext;

  const mediaTypes = extractMediaTypes(normalized);
  if (mediaTypes) {
    filters.mediaTypes = mediaTypes;
    applied.push(mediaTypes.length === 2 ? "movies and TV" : mediaTypes[0] === "movie" ? "movies" : "TV series");
  }

  const runtime = extractRuntimeRange(normalized, mediaTypes ?? filters.mediaTypes);
  if (runtime) {
    const runtimeFilters = applyRuntimeRange(filters, runtime);
    filters.minRuntimeMinutes = runtimeFilters.minRuntimeMinutes;
    filters.maxRuntimeMinutes = runtimeFilters.maxRuntimeMinutes;
    applied.push(describeRuntimeRange(runtime));
  } else if (/\b(any runtime|no runtime|clear runtime)\b/.test(normalized)) {
    delete filters.minRuntimeMinutes;
    delete filters.maxRuntimeMinutes;
    applied.push("any runtime");
  }

  const availability = extractAvailability(normalized);
  if (availability === "plex") {
    filters.availability = ["available_in_plex"];
    applied.push("in Plex");
  } else if (availability === "plex-seerr") {
    delete filters.availability;
    applied.push("Plex and Seerr");
  } else if (/\b(any availability|all availability|include everything|clear availability)\b/.test(normalized)) {
    delete filters.availability;
    applied.push("Plex and Seerr");
  }

  if (/\b(any genre|no genre|clear genre|any style|no style|clear style)\b/.test(normalized)) {
    delete filters.genres;
    delete filters.excludedGenres;
    applied.push("any style");
  }

  const excludedGenres = extractExcludedGenres(normalized);
  if (excludedGenres.length) {
    filters.excludedGenres = [...new Set([...(filters.excludedGenres ?? []), ...excludedGenres])];
    filters.genres = filters.genres?.filter((genre) => !filters.excludedGenres?.some((excluded) => excluded.toLowerCase() === genre.toLowerCase()));
    applied.push(`not ${excludedGenres.map((genre) => genre.toLowerCase()).join(", ")}`);
  }

  const limit = extractResultLimit(normalized);
  if (limit) {
    resultLimit = limit;
    applied.push(`${limit} results`);
  }

  const context = extractWatchContext(normalized);
  if (context) {
    watchContext = context;
    applied.push(context === "group" ? "watching together" : "for me");
  }

  return { query: prompt, filters, resultLimit, watchContext, applied };
}

export function buildConversationQuery(prompt: string, previousQuery: string) {
  const trimmedPrompt = prompt.trim();
  const trimmedPrevious = previousQuery.trim();
  if (trimmedPrompt.length >= maxSearchQueryLength) return trimmedPrompt.slice(0, maxSearchQueryLength);
  if (!trimmedPrevious) return trimmedPrompt;
  const suffix = `\nFollow-up refinement: ${trimmedPrompt}`;
  const previousBudget = maxSearchQueryLength - suffix.length;
  if (previousBudget <= 0) return trimmedPrompt.slice(0, maxSearchQueryLength);
  return `${trimmedPrevious.slice(0, previousBudget)}${suffix}`;
}

function extractMediaTypes(normalized: string): MediaType[] | undefined {
  const wantsMovie = /\b(movies?|films?)\b/.test(normalized);
  const wantsTv = /\b(tv|shows?|series)\b/.test(normalized);
  if (wantsMovie && wantsTv) return ["movie", "tv"];
  if (wantsMovie) return ["movie"];
  if (wantsTv) return ["tv"];
  return undefined;
}

function extractAvailability(normalized: string): AvailabilityScope | undefined {
  if (/\b(plex \+ seerr|plex and seerr|include seerr|requestable|can request|request options|don't have|dont have|not in plex|unavailable)\b/.test(normalized)) return "plex-seerr";
  if (/\b(in plex|on plex|available in plex|plex only|we have|already have|local library)\b/.test(normalized)) return "plex";
  return undefined;
}

function extractResultLimit(normalized: string) {
  const digitMatch =
    normalized.match(/\b(?:find|show|give me|return|get|top|list)\s+(\d{1,3})\b/) ??
    normalized.match(/\b(\d{1,3})\s+(?:movies?|films?|shows?|series|options|results|recommendations|picks)\b/);
  if (digitMatch) return clampResultLimit(Number(digitMatch[1]));

  const wordMatch =
    normalized.match(/\b(?:find|show|give me|return|get|top|list)\s+([a-z]+(?:-[a-z]+)?)\b/) ??
    normalized.match(/\b([a-z]+(?:-[a-z]+)?)\s+(?:movies?|films?|shows?|series|options|results|recommendations|picks)\b/);
  if (wordMatch) return clampResultLimit(parseNumber(wordMatch[1]));
  return undefined;
}

function extractWatchContext(normalized: string): WatchContext | undefined {
  if (/\b(with someone|together|for us|we|us|our|group|date night|family night)\b/.test(normalized)) return "group";
  if (/\b(for me|solo|by myself|just me)\b/.test(normalized)) return "solo";
  return undefined;
}

function extractExcludedGenres(normalized: string) {
  const genres: string[] = [];
  if (/\b(?:not|no|without)\s+(?:animated|animation|cartoons?|anime)\b/.test(normalized) || /\bnon[-\s]?animated\b/.test(normalized) || /\blive[-\s]?action\b/.test(normalized)) {
    genres.push("Animation");
  }
  return genres;
}

function parseNumber(value: string | undefined) {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  return numberWords[value];
}

function clampResultLimit(value: number | undefined) {
  if (!value || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(maxSearchResultLimit, Math.round(value)));
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/\bfeel good\b/g, "feel-good")
    .replace(/\bscience fiction\b/g, "science-fiction")
    .replace(/\brom com\b/g, "rom-com")
    .replace(/\btwo hours?\b/g, "2 hours")
    .replace(/\btwenty five\b/g, "twenty-five");
}
