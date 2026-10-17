import { extractReferenceTitle } from "./intent";
import { normalizeTitle } from "../db/textNormalization";
import type { MediaType } from "../../shared/types";

export interface PlexWatchSuppression {
  recentRatingKeys: ReadonlySet<string>;
  recentTitles: ReadonlySet<string>;
  completedShowRatingKeys: ReadonlySet<string>;
  completedShowTitles: ReadonlySet<string>;
}

export interface WatchSuppressionItem {
  id: string;
  mediaType: MediaType;
  title: string;
  year?: number;
}

const titleWrappers = new Set([
  "a",
  "an",
  "film",
  "films",
  "movie",
  "movies",
  "now",
  "please",
  "series",
  "show",
  "shows",
  "the",
  "today",
  "tonight",
  "tv",
  "watch"
]);

export function emptyPlexWatchSuppression(): PlexWatchSuppression {
  return {
    recentRatingKeys: new Set(),
    recentTitles: new Set(),
    completedShowRatingKeys: new Set(),
    completedShowTitles: new Set()
  };
}

export function summaryNamesDemotedTitle(summary: string, titles: readonly string[]) {
  return titles.some((title) => {
    const trimmed = title.trim();
    if (trimmed.length < 3) return false;
    return new RegExp(`\\b${escapeRegex(trimmed)}\\b`, "i").test(summary);
  });
}

export function suppressWatchedResults<T extends WatchSuppressionItem>(
  results: T[],
  state: PlexWatchSuppression | undefined,
  query: string,
  ratingKeysById: ReadonlyMap<string, readonly string[]>
): T[] {
  if (!state || queryRequestsRewatch(query)) return results;
  const kept: T[] = [];
  const sunk: T[] = [];
  for (const item of results) {
    if (queryNamesTitle(query, item.title) || !isSuppressed(item, state, ratingKeysById.get(item.id) ?? [])) kept.push(item);
    else sunk.push(item);
  }
  return sunk.length === 0 ? results : [...kept, ...sunk];
}

export function queryRequestsRewatch(query: string) {
  const withoutNegatedRewatch = query
    .toLowerCase()
    .replace(
      /\b(?:not|no|without|don't|dont|do not|never|avoid)\b(?:\s+\w+){0,3}\s+(?:a\s+|an\s+|another\s+)?(?:re-?watch(?:es|ing)?|watch again|already watched|already seen|watched before|seen before)\b/g,
      " "
    );
  return /\b(?:re-?watch(?:es|ing)?|watch again|seen before|already watched|already seen|watched before|i(?:'ve| have) (?:already )?(?:seen|watched))\b/.test(
    withoutNegatedRewatch
  );
}

export function queryNamesTitle(query: string, title: string) {
  const normalizedTitle = normalizeTitle(title);
  if (!normalizedTitle || titleIsNegated(query, normalizedTitle)) return false;
  if (quotedTitles(query).some((quoted) => normalizeTitle(quoted) === normalizedTitle)) return true;
  const reference = extractReferenceTitle(query);
  if (reference && referenceNamesTitle(reference, normalizedTitle)) return true;
  return phraseNamesTitle(normalizeTitle(query), normalizedTitle);
}

function isSuppressed(item: WatchSuppressionItem, state: PlexWatchSuppression, ratingKeys: readonly string[]) {
  if (ratingKeys.some((key) => state.recentRatingKeys.has(key))) return true;
  if (item.mediaType === "tv" && ratingKeys.some((key) => state.completedShowRatingKeys.has(key))) return true;
  if (titleKeyMatches(state.recentTitles, item.mediaType, item.title, item.year)) return true;
  return item.mediaType === "tv" && titleKeyMatches(state.completedShowTitles, item.mediaType, item.title, item.year);
}

function titleKeyMatches(keys: ReadonlySet<string>, mediaType: MediaType, title: string, year?: number) {
  const normalized = normalizeTitle(title);
  if (!normalized) return false;
  if (year && keys.has(`${mediaType}|${normalized}|${year}`)) return true;
  return keys.has(`${mediaType}|${normalized}|`);
}

function titleIsNegated(query: string, normalizedTitle: string) {
  const titlePattern = normalizedTitle.split(" ").map(escapeRegex).join("\\s+");
  return new RegExp(`\\b(?:not|no|without|except|excluding)\\s+(?:a\\s+|an\\s+|the\\s+)?${titlePattern}\\b`, "i").test(normalizeTitle(query));
}

function quotedTitles(query: string) {
  return [...query.matchAll(/"([^"]+)"|“([^”]+)”|'([^']+)'/g)]
    .map((match) => match[1] ?? match[2] ?? match[3] ?? "")
    .filter(Boolean);
}

function referenceNamesTitle(reference: string, normalizedTitle: string) {
  const referenceTitle = normalizeTitle(reference);
  if (!referenceTitle) return false;
  if (referenceTitle === normalizedTitle) return true;
  return phraseNamesTitle(referenceTitle, normalizedTitle);
}

function phraseNamesTitle(normalizedQuery: string, normalizedTitle: string) {
  const queryWords = normalizedQuery.split(" ").filter(Boolean);
  const titleWords = normalizedTitle.split(" ").filter(Boolean);
  if (!queryWords.length || !titleWords.length) return false;
  if (titleWords.length >= 2) {
    return ` ${normalizedQuery} `.includes(` ${normalizedTitle} `);
  }
  const [titleWord] = titleWords;
  return queryWords.includes(titleWord) && queryWords.every((word) => word === titleWord || titleWrappers.has(word));
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
