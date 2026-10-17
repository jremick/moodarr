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

const rewatchPhrase = String.raw`re-?watch(?:es|ing)?|watch again|seen before|already watched|already seen|watched before|i(?:'ve| have) (?:already )?(?:seen|watched)|old favou?rites?`;

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
  const negated = new RegExp(
    String.raw`\b(?:not|no|without|don't|dont|do not|never|avoid|nothing|haven't|havent|have not)\b(?:\s+[a-z0-9']+){0,6}\s+(?:a\s+|an\s+|another\s+|anything\s+|something\s+)?(?:${rewatchPhrase})\b`,
    "g"
  );
  const seenEverything = /\b(?:i(?:'ve| have)\s+)?(?:already\s+)?seen\s+(?:everything|it all|all of (?:it|them|these|those))\b/g;
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
  if (referenceTitle === normalizedTitle) return true;
  return phraseNamesTitle(referenceTitle, normalizedTitle);
}

function phraseNamesTitle(normalizedQuery: string, normalizedTitle: string) {
  const queryWords = normalizedQuery.split(" ").filter(Boolean);
  const titleWords = normalizedTitle.split(" ").filter(Boolean);
  if (!queryWords.length || !titleWords.length) return false;
  if (titleWords.length >= 2 && ` ${normalizedQuery} `.includes(` ${normalizedTitle} `)) return true;
  if (titleWords.length >= 2) {
    return titleWords.some((titleWord) => !titleTokenIsNegated(normalizedQuery, titleWord) && queryWordNamesTitleWord(queryWords, titleWord));
  }
  const [titleWord] = titleWords;
  return queryWords.some((word) => wordNamesTitleToken(word, titleWord))
    && queryWords.every((word) => wordNamesTitleToken(word, titleWord) || titleWrappers.has(word));
}

function queryWordNamesTitleWord(queryWords: string[], titleWord: string) {
  if (titleStopWords.has(titleWord) || titleWord.length < 4) return false;
  return queryWords.some((word) => wordNamesTitleToken(word, titleWord));
}

function wordNamesTitleToken(word: string, titleWord: string) {
  if (titleStopWords.has(titleWord)) return false;
  if (word === titleWord) return true;
  if (word.length < 4 || titleWord.length < 4) return false;
  return titleWord.startsWith(word) || word.startsWith(titleWord);
}

function titleTokenIsNegated(query: string, titleWord: string) {
  return new RegExp(`\\b(?:not|no|without|except|excluding)\\s+(?:a\\s+|an\\s+|the\\s+)?${escapeRegex(titleWord)}\\b`, "i").test(query);
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
