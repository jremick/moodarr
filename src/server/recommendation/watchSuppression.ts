import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { workerData } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { COMMON_ENGLISH_LIST_FILE, COMMON_ENGLISH_SUPPLEMENT_FILE } from "./commonEnglishFiles";
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

const MIN_COMMON_WORD_COUNT = 10_000;
const REQUIRED_COMMON_WORDS = ["the", "you", "to", "a", "and"];
const commonEnglish = loadBundledCommonWords();
const articles = new Set(["a", "an", "the"]);
const lookupEdges = [
  ["put", "on"],
  ["the", "movie"],
  ["the", "film"],
  ["watch"],
  ["play"],
  ["please"],
  ["tonight"],
  ["now"]
];
const negators = [
  ["anything", "but"],
  ["sick", "of"],
  ["tired", "of"],
  ["do", "not"],
  ["have", "not"],
  ["don't"],
  ["dont"],
  ["haven't"],
  ["havent"],
  ["without"],
  ["never"],
  ["avoid"],
  ["nothing"],
  ["skip"],
  ["exclude"],
  ["not"],
  ["no"],
  ["nope"]
];
const rewatchPhrases = [
  ["a", "classic", "i", "love"],
  ["old", "favourites"],
  ["old", "favorites"],
  ["old", "favourite"],
  ["old", "favorite"],
  ["old", "faves"],
  ["old", "fave"],
  ["watch", "again"],
  ["seen", "before"],
  ["already", "watched"],
  ["already", "seen"],
  ["watched", "before"],
  ["i've", "already", "seen"],
  ["i've", "already", "watched"],
  ["i", "have", "already", "seen"],
  ["i", "have", "already", "watched"],
  ["we've", "already", "seen"],
  ["we've", "already", "watched"],
  ["we", "have", "already", "seen"],
  ["we", "have", "already", "watched"],
  ["i've", "seen"],
  ["i've", "watched"],
  ["i", "have", "seen"],
  ["i", "have", "watched"],
  ["we've", "seen"],
  ["we've", "watched"],
  ["we", "have", "seen"],
  ["we", "have", "watched"],
  ["re-watches"],
  ["re-watching"],
  ["rewatches"],
  ["rewatching"],
  ["re-watch"],
  ["rewatch"]
];
rewatchPhrases.sort((left, right) => right.length - left.length);
negators.sort((left, right) => right.length - left.length);

const functionWords = new Set(["a", "an", "the", "to", "in", "of"]);
const clauseBreaks = new Set([",", ";", ".", ":", "-", "–", "—", "?", "!", "…", "(", ")", "\n", "\r", "&", "/"]);
const rewatchDeclines = [
  ["no", "thanks"],
  ["not", "today"],
  ["not", "now"],
  ["no"],
  ["nope"],
  ["nah"]
];
const seenEverything = /\b(?:(?:i|we)(?:'ve| have)\s+)?(?:already\s+)?seen\s+(?:everything|it all|all of (?:it|them|these|those)|too many re-?watch(?:es)?)\b/gi;

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
  ratingKeysById: ReadonlyMap<string, readonly string[]>,
  commonWords: ReadonlySet<string> | null = commonEnglish
): T[] {
  if (!state || queryRequestsRewatch(query)) return results;
  const kept: T[] = [];
  const sunk: T[] = [];
  for (const item of results) {
    if (queryNamesTitle(query, item.title, commonWords) || !isSuppressed(item, state, ratingKeysById.get(item.id) ?? [])) kept.push(item);
    else sunk.push(item);
  }
  return sunk.length === 0 ? results : [...kept, ...sunk];
}

export function queryRequestsRewatch(query: string) {
  const tokens = tokenize(normalizeSearchText(query).replace(seenEverything, " "));
  const { clauses, separators } = splitClauses(tokens);
  const requests = clauses.map((clause) => clauseRequestsRewatch(clause));
  for (let index = 0; index < clauses.length; index += 1) {
    const following = clauses[index + 1];
    if (!requests[index] || !following) continue;
    const answeredNo = separators[index + 1] === "?" && isRewatchDecline(following);
    if (isLoneNegator(following) || answeredNo) requests[index] = false;
  }
  return requests.some(Boolean);
}

export function queryNamesTitle(query: string, title: string, commonWords: ReadonlySet<string> | null = commonEnglish) {
  const normalizedQuery = normalizeSearchText(query);
  const normalizedTitle = normalizeTitle(title);
  if (!normalizedTitle || titleIsNegated(normalizedQuery, normalizedTitle)) return false;
  if (quotedTitles(normalizedQuery).some((quoted) => equalsWholeTitle(words(normalizeTitle(quoted)), words(normalizedTitle)))) return true;
  const reference = extractReferenceTitle(normalizedQuery);
  if (reference && phraseNamesTitle(normalizeTitle(reference), normalizedTitle, commonWords)) return true;
  return phraseNamesTitle(normalizeTitle(normalizedQuery), normalizedTitle, commonWords);
}

export function loadCommonWordList(readMain: () => string, readSupplement?: () => string) {
  let text: string;
  try {
    text = readMain();
  } catch {
    warnUnusableWordList();
    return undefined;
  }
  const words = parseWordList(text);
  if (!wordListUsable(words)) {
    warnUnusableWordList();
    return undefined;
  }
  if (!readSupplement) return words;
  try {
    for (const word of parseWordList(readSupplement())) words.add(word);
  } catch {
    warnMissingSupplement();
  }
  return words;
}

function loadBundledCommonWords() {
  return loadCommonWordList(
    () => readBundledList(COMMON_ENGLISH_LIST_FILE),
    () => readBundledList(COMMON_ENGLISH_SUPPLEMENT_FILE)
  ) ?? null;
}

function readBundledList(fileName: string) {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 4; depth += 1) {
    try {
      return readFileSync(join(directory, fileName), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const missing = new Error(`Missing ${fileName}`) as NodeJS.ErrnoException;
  missing.code = "ENOENT";
  throw missing;
}

function parseWordList(text: string) {
  const words = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim().toLowerCase();
    if (!trimmed || trimmed.startsWith("#")) continue;
    words.add(trimmed);
    const normalized = trimmed.replace(/[^a-z0-9]+/g, "");
    if (normalized) words.add(normalized);
  }
  return words;
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

function phraseNamesTitle(normalizedQuery: string, normalizedTitle: string, commonWords: ReadonlySet<string> | null) {
  const queryWords = words(normalizedQuery);
  const titleWords = words(normalizedTitle);
  if (!queryWords.length || !titleWords.length) return false;
  if (equalsWholeTitle(trimLookup(queryWords), titleWords)) return true;
  if (!wordListUsable(commonWords)) return false;
  return queryWords.some((word) => titleWords.includes(word) && !isCommonWord(word, commonWords) && !titleTokenIsNegated(normalizedQuery, word));
}

function wordListUsable(words: ReadonlySet<string> | null | undefined): words is ReadonlySet<string> {
  return words != null && words.size >= MIN_COMMON_WORD_COUNT && REQUIRED_COMMON_WORDS.every((word) => words.has(word));
}

function processLabel() {
  const role = workerData && typeof workerData === "object" && "role" in workerData ? (workerData as { role?: unknown }).role : undefined;
  if (role === "search") return "search worker";
  if (role === "diagnostics") return "diagnostics worker";
  return "server";
}

function warnUnusableWordList() {
  console.warn(`Common English word list is missing or unusable in the ${processLabel()}; naming a watched title from a rare word is off.`);
}

function warnMissingSupplement() {
  console.warn(`Common English genre supplement is missing or unreadable in the ${processLabel()}; rare-word naming stays on without it.`);
}

function isCommonWord(word: string, commonWords: ReadonlySet<string>) {
  return /^\d+$/.test(word) || commonWords.has(word);
}

function equalsWholeTitle(queryWords: string[], titleWords: string[]) {
  if (!queryWords.length || !titleWords.length) return false;
  if (sameWords(queryWords, titleWords)) return true;
  const queryRest = withoutLeadingArticle(queryWords);
  const titleRest = withoutLeadingArticle(titleWords);
  if (queryRest && sameWords(queryRest.words, titleWords) && (queryRest.article === "the" || queryRest.words.length === 1)) return true;
  if (titleRest && queryWords.length >= 2 && sameWords(queryWords, titleRest.words)) return true;
  return Boolean(queryRest && titleRest && queryRest.words.length >= 2 && queryRest.article === "the" && sameWords(queryRest.words, titleRest.words));
}

function withoutLeadingArticle(tokens: string[]) {
  const article = tokens[0];
  if (!article || tokens.length < 2 || !articles.has(article)) return undefined;
  return { article, words: tokens.slice(1) };
}

function trimLookup(tokens: string[]) {
  let current = tokens;
  while (current.length) {
    const last = current[current.length - 1] ?? "";
    if (current.length > 1 && /^(?:19|20)\d{2}$/.test(last)) {
      current = current.slice(0, -1);
      continue;
    }
    const start = lookupEdges.find((phrase) => startsWith(current, phrase));
    if (start) {
      current = current.slice(start.length);
      continue;
    }
    const end = lookupEdges.find((phrase) => endsWith(current, phrase));
    if (end) {
      current = current.slice(0, current.length - end.length);
      continue;
    }
    break;
  }
  return current;
}

function clauseRequestsRewatch(tokens: string[]) {
  const dropped = new Array<boolean>(tokens.length).fill(false);
  for (let index = 0; index < tokens.length; index += 1) {
    if (dropped[index]) continue;
    const negatorLength = phraseAt(tokens, index, negators);
    if (!negatorLength) continue;
    const end = negatedRewatchEnd(tokens, index, negatorLength);
    if (end === undefined) continue;
    for (let cursor = index; cursor < end; cursor += 1) dropped[cursor] = true;
    index = end - 1;
  }
  const remaining = tokens.filter((_, index) => !dropped[index]);
  return remaining.some((_, index) => rewatchPhraseAt(remaining, index) > 0);
}

function splitClauses(tokens: string[]) {
  const clauses: string[][] = [];
  const separators: string[] = [];
  let current: string[] = [];
  let separator = "";
  for (const token of tokens) {
    if (clauseBreaks.has(token)) {
      if (current.length) {
        clauses.push(current);
        separators.push(separator);
        current = [];
      }
      separator = token;
      continue;
    }
    current.push(token);
  }
  if (current.length) {
    clauses.push(current);
    separators.push(separator);
  }
  return { clauses, separators };
}

function isRewatchDecline(tokens: string[]) {
  return rewatchDeclines.some((phrase) => phrase.length === tokens.length && phrase.every((word, index) => tokens[index] === word));
}

function isLoneNegator(tokens: string[]) {
  return negators.some((phrase) => phrase.length === tokens.length && phrase.every((word, index) => tokens[index] === word));
}

function negatedRewatchEnd(tokens: string[], index: number, negatorLength: number) {
  let cursor = index + negatorLength;
  let wordsAfter = 0;
  while (cursor < tokens.length) {
    const token = tokens[cursor] ?? "";
    if (wordsAfter >= 1 && /^re-?watch$/.test(token) && !functionWords.has(tokens[cursor - 1] ?? "")) return undefined;
    const phraseLength = rewatchPhraseAt(tokens, cursor);
    if (phraseLength) return cursor + phraseLength;
    wordsAfter += 1;
    cursor += 1;
  }
  return undefined;
}

function rewatchPhraseAt(tokens: string[], index: number) {
  return phraseAt(tokens, index, rewatchPhrases);
}

function phraseAt(tokens: string[], index: number, phrases: readonly (readonly string[])[]) {
  for (const phrase of phrases) {
    if (phrase.every((word, offset) => tokens[index + offset] === word)) return phrase.length;
  }
  return 0;
}

function startsWith(tokens: string[], phrase: readonly string[]) {
  return phrase.every((word, index) => tokens[index] === word);
}

function endsWith(tokens: string[], phrase: readonly string[]) {
  return phrase.every((word, index) => tokens[tokens.length - phrase.length + index] === word);
}

function sameWords(left: string[], right: string[]) {
  return left.length === right.length && left.every((word, index) => word === right[index]);
}

function words(value: string) {
  return value.split(" ").filter(Boolean);
}

function titleTokenIsNegated(query: string, titleWord: string) {
  return new RegExp(`\\b(?:not|no|without|except|excluding|skip)\\s+(?:a\\s+|an\\s+|the\\s+)?${escapeRegex(titleWord)}\\b`, "i").test(query);
}

function tokenize(value: string) {
  return value.match(/[a-z0-9]+(?:['-][a-z0-9]+)*|[,;.:&\u2013\u2014?!()/\u2026\n\r-]/g) ?? [];
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
