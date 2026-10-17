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

const commonDescriptiveWords = new Set([
  "child", "children", "crazy", "fun", "holiday", "hot", "hunt", "kid", "kids", "laugh", "laughs", "mom", "moms",
  "monster", "monsters", "mother", "rich", "silly", "space", "spy", "superhero", "war"
]);

const rewatchPhrase = String.raw`re-?watch(?:es|ing)?|watch again|seen before|already watched|already seen|watched before|i(?:'ve| have) (?:already )?(?:seen|watched)|old favou?rites?|old faves?`;
const negationFillers = String.raw`any|bit|it|just|lot|lots|more|of|one|please|really|some|that|this|to|too|want`;

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
  const normalized = normalizeSearchText(query);
  const lead = String.raw`anything\s+but|sick\s+of|tired\s+of|do not|have not|don't|dont|haven't|havent|without|never|avoid|nothing|skip|exclude|not|no`;
  const negated = new RegExp(
    String.raw`\b(?:${lead})(?:\s+(?:${negationFillers})){0,6}\s+(?:(?:a|an|the|another|anything|something|what)\s+)?(?:${rewatchPhrase})\b`,
    "gi"
  );
  const seenEverything = /\b(?:i(?:'ve| have)\s+)?(?:already\s+)?seen\s+(?:everything|it all|all of (?:it|them|these|those)|too many re-?watches?)\b/g;
  const remaining = normalized.replace(negated, " ").replace(seenEverything, " ");
  return new RegExp(String.raw`\b(?:${rewatchPhrase})\b`).test(remaining);
}

export function queryNamesTitle(query: string, title: string) {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedTitle = normalizeTitle(title);
  if (!normalizedTitle || titleIsNegated(normalizedQuery, normalizedTitle)) return false;
  if (quotedTitles(normalizedQuery).some((quoted) => normalizeTitle(quoted) === normalizedTitle)) return true;
  const reference = extractReferenceTitle(normalizedQuery);
  if (reference && referenceNamesTitle(reference, normalizedTitle)) return true;
  return phraseNamesTitle(normalizeTitle(normalizedQuery), normalizedTitle);
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
  return phraseNamesTitle(referenceTitle, normalizedTitle);
}

function phraseNamesTitle(normalizedQuery: string, normalizedTitle: string) {
  const rawQueryWords = normalizedQuery.split(" ").filter(Boolean);
  const titleWords = normalizedTitle.split(" ").filter(Boolean);
  if (!titleWords.length) return false;
  if (sameWords(rawQueryWords, titleWords) && !rawQueryWords.some((word) => titleTokenIsNegated(normalizedQuery, word))) return true;
  const candidates = [trimEdges(rawQueryWords, true), trimEdges(rawQueryWords, false)];
  return candidates.some((words) => phraseMatchesTitle(words, titleWords, normalizedQuery));
}

function phraseMatchesTitle(queryWords: string[], titleWords: string[], normalizedQuery: string) {
  if (!queryWords.length || queryWords.some((word) => titleTokenIsNegated(normalizedQuery, word))) return false;
  if (!sameWords(queryWords, titleWords) && !containsContiguous(titleWords, queryWords)) return false;
  if (queryWords.length === 1) return isDistinctiveTitleToken(queryWords[0]);
  return queryWords.some((word) => !isDescriptiveWord(word));
}

function sameWords(left: string[], right: string[]) {
  return left.length === right.length && left.every((word, index) => word === right[index]);
}

function isDistinctiveTitleToken(word: string) {
  return word.length >= 8 && !isDescriptiveWord(word);
}

function isDescriptiveWord(word: string) {
  return titleWrappers.has(word) || titleStopWords.has(word) || neverSpecificWords.has(word) || moodGenreWords.has(word) || commonDescriptiveWords.has(word);
}

const genericTitleWords = new Set(["film", "films", "movie", "movies", "series", "show", "shows", "tv"]);

function trimEdges(words: string[], includeGenerics: boolean) {
  let start = 0;
  let end = words.length;
  while (start < end && isEdgeFiller(words[start], includeGenerics)) start += 1;
  while (end > start && isEdgeFiller(words[end - 1], includeGenerics)) end -= 1;
  return words.slice(start, end);
}

function isEdgeFiller(word: string, includeGenerics: boolean) {
  if (!includeGenerics && genericTitleWords.has(word)) return false;
  return titleWrappers.has(word) || titleStopWords.has(word);
}

function containsContiguous(titleWords: string[], queryWords: string[]) {
  if (queryWords.length > titleWords.length) return false;
  return titleWords.some((_, index) => queryWords.every((word, offset) => titleWords[index + offset] === word));
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
