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

const titleStopWords = new Set(["a", "an", "and", "at", "by", "for", "from", "in", "of", "on", "the", "to", "with"]);

const neverSpecificWords = new Set(["film", "films", "movie", "movies", "show", "shows", "something", "tv", "watch"]);

const moodGenreWords = new Set([
  "action", "adventure", "animated", "animation", "anime", "christmas", "clever", "comedy", "cozy", "crime", "dark",
  "documentary", "drama", "family", "fantasy", "feel", "feelgood", "funny", "good", "horror", "light", "love",
  "music", "musical", "mystery", "night", "romance", "romantic", "scary", "scifi", "short", "sport", "sports",
  "thriller", "warm", "weird"
]);

const rewatchPhrase = String.raw`re-?watch(?:es|ing)?|watch again|seen before|already watched|already seen|watched before|i(?:'ve| have) (?:already )?(?:seen|watched)|old favou?rites?|old fave`;

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
  const catalogueCounts = titleWordCounts(results);
  const kept: T[] = [];
  const sunk: T[] = [];
  for (const item of results) {
    if (queryNamesTitle(query, item.title, catalogueCounts) || !isSuppressed(item, state, ratingKeysById.get(item.id) ?? [])) kept.push(item);
    else sunk.push(item);
  }
  return sunk.length === 0 ? results : [...kept, ...sunk];
}

export function queryRequestsRewatch(query: string) {
  const normalized = normalizeSearchText(query);
  const lead = String.raw`not|no|without|don't|dont|do not|never|avoid|nothing|haven't|havent|have not|skip|exclude`;
  const negated = new RegExp(
    String.raw`\b(?:${lead}|anything\s+but|sick\s+of|tired\s+of)\b(?:\s+[a-z0-9']+){0,6}\s+(?:a\s+|an\s+|another\s+|anything\s+|something\s+|what\s+)?(?:${rewatchPhrase})\b`,
    "g"
  );
  const seenEverything = /\b(?:i(?:'ve| have)\s+)?(?:already\s+)?seen\s+(?:everything|it all|all of (?:it|them|these|those)|too many re-?watches?)\b/g;
  const remaining = normalized.replace(negated, " ").replace(seenEverything, " ");
  return new RegExp(String.raw`\b(?:${rewatchPhrase})\b`).test(remaining);
}

export function queryNamesTitle(query: string, title: string, catalogueCounts?: ReadonlyMap<string, number>) {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedTitle = normalizeTitle(title);
  if (!normalizedTitle || titleIsNegated(normalizedQuery, normalizedTitle)) return false;
  if (quotedTitles(normalizedQuery).some((quoted) => normalizeTitle(quoted) === normalizedTitle)) return true;
  const reference = extractReferenceTitle(normalizedQuery);
  if (reference && referenceNamesTitle(reference, normalizedTitle, catalogueCounts)) return true;
  return phraseNamesTitle(normalizeTitle(normalizedQuery), normalizedTitle, catalogueCounts);
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

function referenceNamesTitle(reference: string, normalizedTitle: string, catalogueCounts?: ReadonlyMap<string, number>) {
  const referenceTitle = normalizeTitle(reference);
  if (!referenceTitle) return false;
  return phraseNamesTitle(referenceTitle, normalizedTitle, catalogueCounts);
}

function phraseNamesTitle(normalizedQuery: string, normalizedTitle: string, catalogueCounts?: ReadonlyMap<string, number>) {
  const queryWords = trimEdgeWrappers(normalizedQuery.split(" ").filter(Boolean));
  const titleWords = normalizedTitle.split(" ").filter(Boolean);
  if (!queryWords.length || !containsContiguous(titleWords, queryWords) || queryWords.some((word) => titleTokenIsNegated(normalizedQuery, word))) return false;
  const namesWholeTitle = queryWords.length === titleWords.length;
  if (!namesWholeTitle && isMoodOrGenreQuery(normalizedQuery)) return false;
  if (namesWholeTitle) return true;
  return queryWords.some((word) => wordIsSpecific(word, catalogueCounts));
}

function isMoodOrGenreQuery(normalizedQuery: string) {
  const words = normalizedQuery.split(" ").filter((word) => word && !titleWrappers.has(word) && !titleStopWords.has(word));
  return words.length === 0 || words.every((word) => moodGenreWords.has(word) || neverSpecificWords.has(word));
}

function trimEdgeWrappers(words: string[]) {
  let start = 0;
  let end = words.length;
  while (start < end && (titleWrappers.has(words[start]) || titleStopWords.has(words[start]))) start += 1;
  while (end > start && (titleWrappers.has(words[end - 1]) || titleStopWords.has(words[end - 1]))) end -= 1;
  return words.slice(start, end);
}

function containsContiguous(titleWords: string[], queryWords: string[]) {
  if (queryWords.length > titleWords.length) return false;
  return titleWords.some((_, index) => queryWords.every((word, offset) => titleWords[index + offset] === word));
}

function wordIsSpecific(word: string, catalogueCounts?: ReadonlyMap<string, number>) {
  if (neverSpecificWords.has(word) || titleWrappers.has(word) || titleStopWords.has(word)) return false;
  if (!moodGenreWords.has(word)) return true;
  return catalogueCounts?.get(word) === 1;
}

function titleWordCounts(results: readonly WatchSuppressionItem[]) {
  const counts = new Map<string, number>();
  for (const item of results) {
    for (const word of new Set(normalizeTitle(item.title).split(" ").filter(Boolean))) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return counts;
}

function titleTokenIsNegated(query: string, titleWord: string) {
  return new RegExp(`\\b(?:not|no|without|except|excluding|skip)\\s+(?:a\\s+|an\\s+|the\\s+)?${escapeRegex(titleWord)}\\b`, "i").test(query);
}

function normalizeSearchText(query: string) {
  return query
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u2035\u0060\u00b4]/g, "'")
    .replace(/[\u201c\u201d\u201e\u00ab\u00bb]/g, "\"")
    .toLowerCase();
}

function escapeRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
