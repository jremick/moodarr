import type {
  AvailabilityGroup,
  ItemSummary,
  RefinementOption,
  SearchFilters,
  WatchContext
} from "../../../shared/types";

export type AvailabilityScope = "plex" | "plex-seerr";

const savedQueryStorageKey = "moodarr.savedQueries";
const maxSavedQueries = 12;

export type VoiceState = "idle" | "listening" | "unsupported";
export type RecommendationFeedback = "up" | "maybe" | "down";
export type DisplayMode = "compact" | "comfortable" | "list";
export type SearchProgressKind = "search" | "refinement";

export interface SearchProgressState {
  id: string;
  kind: SearchProgressKind;
  catalogTotal: number;
  resultLimit: number;
  requestedLimit: number;
  startedAt: number;
}

const feedbackMoodTerms = [
  "low commitment",
  "feel good",
  "cozy",
  "dark",
  "weird",
  "light",
  "funny",
  "comfort",
  "gentle",
  "warm",
  "tense",
  "intense",
  "clever",
  "romantic",
  "magical",
  "bleak",
  "whimsical"
];

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  kind?: "criteria" | "search";
  refinementOptions?: RefinementOption[];
}

export interface SavedQuery {
  id: string;
  query: string;
  createdAt: string;
}

export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<{ 0?: { transcript: string } }> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

export function describeChangedCriteria(
  change: {
    filters?: SearchFilters;
    resultLimit?: number;
    watchContext?: WatchContext;
    showRatedItems?: boolean;
  },
  watchContext: WatchContext
) {
  const parts: string[] = [];
  if (change.watchContext) parts.push(watchContext === "group" ? "a better together mode" : "a more personal mode");
  if (change.resultLimit !== undefined) parts.push("the new result count");
  if (change.filters) {
    parts.push("the updated filters");
  }
  return parts;
}

export function posterMeta(item: ItemSummary) {
  const parts = [];
  if (item.year) parts.push(String(item.year));
  parts.push(item.runtimeMinutes ? `${item.runtimeMinutes} min` : "Runtime unknown");
  return parts.join(", ");
}

export function cleanFitExplanation(item: ItemSummary) {
  const titlePrefix = new RegExp(`^${escapeRegExp(item.title)}\\s*(?:-|:|is\\s+|fits\\s+because\\s+|fits\\s+|works\\s+because\\s+|works\\s+)`, "i");
  const explanation = item.matchExplanation
    .trim()
    .replace(titlePrefix, "")
    .replace(/\bgood fit because(?: of)?\b/gi, "strong match for")
    .replace(/\ba good fit\b/gi, "a strong match")
    .replace(/\bThis looks like a good fit\b/gi, "This looks well matched")
    .replace(/\s*It is already available in Plex\.\s*/gi, " ")
    .trim();
  return threeSentenceText(explanation, [
    item.genres.length ? "The genre tags give a quick read on the tone." : "The cached library details give a little more context.",
    item.runtimeMinutes ? "The card gives enough context to size up the commitment before opening." : "The result card gives enough context to decide whether it is worth opening."
  ]);
}

export function formatItemDescription(item: ItemSummary) {
  return threeSentenceText(item.summary ?? "", [
    item.summary ? "" : "No cached synopsis is available for this item yet.",
    item.genres.length ? `Moodarr has it filed under ${item.genres.slice(0, 3).join(", ").toLowerCase()}.` : "Moodarr does not have detailed genre metadata cached yet.",
    item.runtimeMinutes ? `The cached runtime is ${item.runtimeMinutes} minutes, so the card still gives a basic commitment signal.` : "The runtime is not cached yet, so use the linked service for more detail."
  ]);
}

export function threeSentenceText(text: string, fallbacks: string[]) {
  const sentences = splitSentences(text).filter((sentence) => !/^\s*it is already available in plex\.?\s*$/i.test(sentence));
  for (const fallback of fallbacks) {
    if (sentences.length >= 3) break;
    if (fallback.trim()) sentences.push(fallback.trim());
  }
  while (sentences.length < 3) {
    sentences.push("Use this as a directional signal alongside the poster, genres, and service links.");
  }
  return sentences.slice(0, 3).map(ensureSentencePunctuation).join(" ");
}

export function splitSentences(text: string) {
  return text
    .replace(/\s+/g, " ")
    .match(/[^.!?]+[.!?]+|[^.!?]+$/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) ?? [];
}

export function ensureSentencePunctuation(sentence: string) {
  const trimmed = sentence.trim();
  if (!trimmed) return "";
  const capitalized = trimmed[0]?.toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function trailerUrl(item: ItemSummary) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${item.title} ${item.year ?? ""} trailer`)}`;
}

export function applyFeedbackRanking(
  items: ItemSummary[],
  feedbackByItem: Record<string, RecommendationFeedback>,
  preferredExampleByItem: Record<string, boolean>,
  baseScores: Record<string, number>
) {
  const feedbackEntries = Object.entries(feedbackByItem);
  const preferredEntries = Object.entries(preferredExampleByItem).filter(([, selected]) => selected);
  if (feedbackEntries.length === 0 && preferredEntries.length === 0) return items;
  const itemById = new Map(items.map((item) => [item.id, item]));
  return items
    .map((item) => {
      let score = baseScores[item.id] ?? item.score;
      for (const [preferredItemId] of preferredEntries) {
        const reference = itemById.get(preferredItemId);
        if (!reference) continue;
        if (item.id === preferredItemId) score += 18;
        score += sharedGenreCount(item, reference) * 12;
        if (item.mediaType === reference.mediaType) score += 5;
      }
      for (const [feedbackItemId, feedback] of feedbackEntries) {
        const reference = itemById.get(feedbackItemId);
        if (!reference) continue;
        const direction = feedback === "up" ? 1 : feedback === "down" ? -1 : 0.35;
        if (item.id === feedbackItemId) score += direction * 14;
        score += direction * sharedGenreCount(item, reference) * 8;
        if (item.mediaType === reference.mediaType) score += direction * 3;
      }
      return { ...item, score: Math.max(0, Math.round(score)) };
    })
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

export function displayMatchScore(item: { score: number }, index: number, visibleItems: Array<{ score: number }>) {
  const rawScore = safeScore(item.score);
  const scores = visibleItems.map((entry) => safeScore(entry.score));
  const topScore = Math.max(rawScore, ...scores);
  const bottomScore = Math.min(rawScore, ...scores);
  const spread = topScore - bottomScore;
  const topTieCount = scores.filter((score) => score === topScore).length;
  const secondScore = scores
    .filter((score) => score < topScore)
    .sort((left, right) => right - left)[0];
  const distinctTopGap = topTieCount === 1 ? (secondScore === undefined ? 8 : topScore - secondScore) : 0;
  const highConfidenceBonus = Math.max(0, Math.min(3, (rawScore - 92) / 8));
  const absoluteAnchor = 48 + Math.min(42, Math.max(0, rawScore) * 0.42);
  const relativeScore = spread >= 8 ? 64 + ((rawScore - bottomScore) / spread) * 32 : absoluteAnchor + (rawScore - topScore) * 0.35;
  const rankPenalty = Math.min(20, Math.max(0, index) * 0.65);
  const rankCeiling = index === 0 ? 100 : Math.max(76, 99 - Math.ceil(index / 2));
  const topCeiling = index === 0 && rawScore >= 98 && distinctTopGap >= 4 ? 100 : Math.min(rankCeiling, 99);
  return Math.max(1, Math.min(topCeiling, Math.round(relativeScore + highConfidenceBonus - rankPenalty)));
}

export function safeScore(score: number) {
  return Number.isFinite(score) ? score : 0;
}

export function filterFeedbackItems(items: ItemSummary[], feedbackByItem: Record<string, RecommendationFeedback>, showRatedItems: boolean) {
  const hiddenItemIds = new Set(
    Object.entries(feedbackByItem)
      .filter(([, feedback]) => feedback === "down" || (!showRatedItems && feedback === "up"))
      .map(([itemId]) => itemId)
  );
  if (hiddenItemIds.size === 0) return items;
  return items.filter((item) => !hiddenItemIds.has(item.id));
}

export function visibleResultsFromPool(items: ItemSummary[], feedbackByItem: Record<string, RecommendationFeedback>, showRatedItems: boolean, limit: number) {
  return filterFeedbackItems(items, feedbackByItem, showRatedItems).slice(0, limit);
}

export function hiddenFeedbackCount(feedbackByItem: Record<string, RecommendationFeedback>, showRatedItems: boolean) {
  return Object.values(feedbackByItem).filter((feedback) => feedback === "down" || (!showRatedItems && feedback === "up")).length;
}

export function extractFeedbackMoodTerm(query: string) {
  const normalized = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!normalized) return undefined;
  return feedbackMoodTerms.find((term) => normalized.includes(term));
}

export function buildFeedbackContext(feedbackByItem: Record<string, RecommendationFeedback>, preferredExampleByItem: Record<string, boolean>, showRatedItems: boolean) {
  const preferredExampleItemIds = Object.entries(preferredExampleByItem)
    .filter(([, selected]) => selected)
    .map(([itemId]) => itemId);
  const moreLikeItemIds = Object.entries(feedbackByItem)
    .filter(([, feedback]) => feedback === "up")
    .map(([itemId]) => itemId);
  const maybeItemIds = Object.entries(feedbackByItem)
    .filter(([, feedback]) => feedback === "maybe")
    .map(([itemId]) => itemId);
  const lessLikeItemIds = Object.entries(feedbackByItem)
    .filter(([, feedback]) => feedback === "down")
    .map(([itemId]) => itemId);
  const hiddenItemIds = Object.entries(feedbackByItem)
    .filter(([, feedback]) => feedback === "down" || (!showRatedItems && feedback === "up"))
    .map(([itemId]) => itemId);
  return { preferredExampleItemIds, moreLikeItemIds, maybeItemIds, lessLikeItemIds, hiddenItemIds, showRatedItems };
}

export function nextFeedbackState(current: Record<string, RecommendationFeedback>, itemId: string, feedback: RecommendationFeedback) {
  const next = { ...current };
  if (next[itemId] === feedback) delete next[itemId];
  else next[itemId] = feedback;
  return next;
}

export function clearFeedbackState(current: Record<string, RecommendationFeedback>, itemId: string) {
  if (!current[itemId]) return current;
  const next = { ...current };
  delete next[itemId];
  return next;
}

export function nextPreferredExampleState(current: Record<string, boolean>, itemId: string) {
  const next = { ...current };
  if (next[itemId]) delete next[itemId];
  else next[itemId] = true;
  return next;
}

export function clearPreferredExampleState(current: Record<string, boolean>, itemId: string) {
  if (!current[itemId]) return current;
  const next = { ...current };
  delete next[itemId];
  return next;
}

export function nextFeedbackTitleState(current: Record<string, string>, item: ItemSummary, feedbackByItem: Record<string, RecommendationFeedback>) {
  const next = { ...current };
  if (feedbackByItem[item.id]) next[item.id] = item.title;
  else delete next[item.id];
  return next;
}

export function nextPreferredExampleTitleState(current: Record<string, string>, item: ItemSummary, preferredExampleByItem: Record<string, boolean>) {
  const next = { ...current };
  if (preferredExampleByItem[item.id]) next[item.id] = item.title;
  else delete next[item.id];
  return next;
}

export function clearTitleState(current: Record<string, string>, itemId: string) {
  if (!current[itemId]) return current;
  const next = { ...current };
  delete next[itemId];
  return next;
}

export function summarizeFeedbackSelection(
  feedbackByItem: Record<string, RecommendationFeedback>,
  titleByItem: Record<string, string>,
  preferredExampleByItem: Record<string, boolean>,
  preferredExampleTitleByItem: Record<string, string>,
  submittedFeedbackByItem: Record<string, RecommendationFeedback> = {},
  submittedPreferredExampleByItem: Record<string, boolean> = {}
) {
  const preferredExamples = Object.entries(preferredExampleByItem)
    .filter(([, selected]) => selected)
    .filter(([itemId]) => !submittedPreferredExampleByItem[itemId])
    .map(([itemId]) => preferredExampleTitleByItem[itemId])
    .filter((title): title is string => Boolean(title));
  const moreLike = Object.entries(feedbackByItem)
    .filter(([, feedback]) => feedback === "up")
    .filter(([itemId, feedback]) => submittedFeedbackByItem[itemId] !== feedback)
    .map(([itemId]) => titleByItem[itemId])
    .filter((title): title is string => Boolean(title));
  const lessLike = Object.entries(feedbackByItem)
    .filter(([, feedback]) => feedback === "down")
    .filter(([itemId, feedback]) => submittedFeedbackByItem[itemId] !== feedback)
    .map(([itemId]) => titleByItem[itemId])
    .filter((title): title is string => Boolean(title));
  const maybe = Object.entries(feedbackByItem)
    .filter(([, feedback]) => feedback === "maybe")
    .filter(([itemId, feedback]) => submittedFeedbackByItem[itemId] !== feedback)
    .map(([itemId]) => titleByItem[itemId])
    .filter((title): title is string => Boolean(title));
  const parts = [];
  if (preferredExamples.length) {
    parts.push(`Use ${formatList(preferredExamples)} as ${preferredExamples.length === 1 ? "a preferred example" : "preferred examples"} of the mood.`);
  }
  if (moreLike.length) parts.push(`More like ${formatList(moreLike)}.`);
  if (maybe.length) parts.push(`Maybe keep ${formatList(maybe)} as potentials.`);
  if (lessLike.length) parts.push(`Less like ${formatList(lessLike)}.`);
  return parts.join(" ");
}

export function retainedPotentialItems(freshItems: ItemSummary[], previousItems: ItemSummary[], feedbackByItem: Record<string, RecommendationFeedback>) {
  if (previousItems.length === 0) return [];
  const freshIds = new Set(freshItems.map((item) => item.id));
  const maybeIds = new Set(Object.entries(feedbackByItem).filter(([, feedback]) => feedback === "maybe").map(([itemId]) => itemId));
  return previousItems.filter((item) => maybeIds.has(item.id) && !freshIds.has(item.id));
}

export function mergeUniqueItems(primaryItems: ItemSummary[], retainedItems: ItemSummary[]) {
  if (retainedItems.length === 0) return primaryItems;
  const itemById = new Map<string, ItemSummary>();
  for (const item of [...primaryItems, ...retainedItems]) itemById.set(item.id, item);
  return [...itemById.values()];
}

export function sharedGenreCount(first: ItemSummary, second: ItemSummary) {
  const secondGenres = new Set(second.genres.map((genre) => genre.toLowerCase()));
  return first.genres.filter((genre) => secondGenres.has(genre.toLowerCase())).length;
}

export function availabilityScopeFromFilters(filters: SearchFilters): AvailabilityScope {
  return filters.availability?.length === 1 && filters.availability[0] === "available_in_plex" ? "plex" : "plex-seerr";
}

export function availabilityFromScope(scope: AvailabilityScope): AvailabilityGroup[] | undefined {
  return scope === "plex" ? ["available_in_plex"] : undefined;
}

export function loadSavedQueries(): SavedQuery[] {
  try {
    const raw = localStorage.getItem(savedQueryStorageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const query = typeof (entry as SavedQuery).query === "string" ? (entry as SavedQuery).query.trim() : "";
      if (!query) return [];
      return [
        {
          id: typeof (entry as SavedQuery).id === "string" ? (entry as SavedQuery).id : createId(),
          query,
          createdAt: typeof (entry as SavedQuery).createdAt === "string" ? (entry as SavedQuery).createdAt : new Date().toISOString()
        }
      ];
    });
  } catch {
    return [];
  }
}

export function persistSavedQueries(queries: SavedQuery[]) {
  const next = queries.slice(0, maxSavedQueries);
  localStorage.setItem(savedQueryStorageKey, JSON.stringify(next));
  return next;
}

export function upsertSavedQuery(current: SavedQuery[], query: string) {
  const normalized = query.trim();
  const withoutDuplicate = current.filter((entry) => entry.query.trim() !== normalized);
  return [{ id: createId(), query: normalized, createdAt: new Date().toISOString() }, ...withoutDuplicate].slice(0, maxSavedQueries);
}

export async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const element = document.createElement("textarea");
  element.value = value;
  element.setAttribute("readonly", "");
  element.style.position = "fixed";
  element.style.left = "-9999px";
  document.body.appendChild(element);
  element.select();
  try {
    if (!document.execCommand("copy")) throw new Error("Could not copy query.");
  } finally {
    document.body.removeChild(element);
  }
}

export function formatList(values: string[]) {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

export function createId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function getSpeechRecognitionConstructor() {
  if (typeof window === "undefined") return undefined;
  const speechWindow = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}
