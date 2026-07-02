import crypto from "node:crypto";
import type { ItemDetail, MediaType } from "../../shared/types";
import { FEATURE_VERSION, buildMediaFeatureDocument, type MediaFeatureDocument } from "./features";
import type { MoodFeatureScoreInput } from "./moodFeatureIndex";

export const CONTENT_FINGERPRINT_SCHEMA_VERSION = "content-fingerprint-v1";
export const CONTENT_FINGERPRINT_VERSION = `${FEATURE_VERSION}-fingerprint-v1`;
export const CONTENT_FINGERPRINT_MOOD_SCORE_SOURCE = "content-fingerprint";
export const CONTENT_FINGERPRINT_MOOD_SCORE_VERSION = `${CONTENT_FINGERPRINT_VERSION}-mood-scores-v1`;

export type ContentFingerprintSource = "deterministic" | "moodarr-wikidata-rules" | "ai-enrichment";
export type FingerprintSpecificity = "broad" | "medium" | "specific";
export type FingerprintPolarity = "positive" | "negative";
export type FingerprintSourceQuality = "missing" | "thin" | "usable" | "rich";
export type FingerprintRatingQuality = "missing" | "usable";

export interface ContentFingerprintV1 {
  schemaVersion: typeof CONTENT_FINGERPRINT_SCHEMA_VERSION;
  fingerprintVersion: string;
  source: ContentFingerprintSource;
  sourceVersion: string;
  inputHash: string;
  generatedAt: string;
  mediaItemId: string;
  title: string;
  mediaType: MediaType;
  year?: number;
  summary: {
    premise?: string;
    contentShape?: string;
    experience?: string;
    confidence: number;
  };
  dimensions: {
    mood: FingerprintTerm[];
    tone: FingerprintTerm[];
    themes: FingerprintTerm[];
    setting: FingerprintTerm[];
    era: FingerprintTerm[];
    style: FingerprintTerm[];
    pacing: FingerprintTerm[];
    intensity: FingerprintTerm[];
    humor: FingerprintTerm[];
    romance: FingerprintTerm[];
    watchability: FingerprintTerm[];
    microgenres: FingerprintTerm[];
    negativeCues: FingerprintTerm[];
  };
  safetyAndFriction: {
    runtimeCommitment?: FingerprintTerm;
    contentRatingFriction?: FingerprintTerm;
    groupFit?: FingerprintTerm;
    attentionDemand?: FingerprintTerm;
    scariness?: FingerprintTerm;
    emotionalWeight?: FingerprintTerm;
  };
  evidence: FingerprintEvidence[];
  sourceQuality: {
    summary: FingerprintSourceQuality;
    genres: FingerprintSourceQuality;
    people: FingerprintSourceQuality;
    ratings: FingerprintRatingQuality;
    warnings: string[];
  };
}

export interface FingerprintTerm {
  key: string;
  label: string;
  score: number;
  confidence: number;
  specificity: FingerprintSpecificity;
  polarity?: FingerprintPolarity;
  evidenceIds: string[];
}

export interface FingerprintEvidence {
  id: string;
  sourceField: "title" | "summary" | "genre" | "runtime" | "contentRating" | "rating" | "person" | "catalogFact" | "availability";
  value: string;
  confidence: number;
}

type DimensionName = keyof ContentFingerprintV1["dimensions"];

interface FingerprintBuildState {
  evidence: FingerprintEvidence[];
  evidenceIds: Record<string, string | undefined>;
  dimensions: ContentFingerprintV1["dimensions"];
  safetyAndFriction: ContentFingerprintV1["safetyAndFriction"];
}

const emptyDimensions = (): ContentFingerprintV1["dimensions"] => ({
  mood: [],
  tone: [],
  themes: [],
  setting: [],
  era: [],
  style: [],
  pacing: [],
  intensity: [],
  humor: [],
  romance: [],
  watchability: [],
  microgenres: [],
  negativeCues: []
});

export function buildContentFingerprint(
  item: ItemDetail,
  feature: MediaFeatureDocument = buildMediaFeatureDocument(item),
  generatedAt = new Date().toISOString()
): ContentFingerprintV1 {
  const evidence = buildEvidence(item, feature);
  const evidenceIds = Object.fromEntries(evidence.map((entry) => [entry.id, entry.id]));
  const state: FingerprintBuildState = {
    evidence,
    evidenceIds,
    dimensions: emptyDimensions(),
    safetyAndFriction: {}
  };
  const text = normalizedText(item);
  const genres = new Set(item.genres.map((genre) => genre.toLowerCase()));

  addFeatureTerms(state, feature);
  addGenreTerms(state, genres);
  addSummaryTerms(state, text, item);
  addRuntimeTerms(state, item);
  addContentRatingTerms(state, item);
  addAvailabilityTerms(state, item);
  addMicrogenres(state, text, genres);

  const sourceQuality = buildSourceQuality(item);
  const summaryConfidence = sourceQuality.summary === "rich" ? 0.82 : sourceQuality.summary === "usable" ? 0.68 : sourceQuality.summary === "thin" ? 0.38 : 0.12;
  return {
    schemaVersion: CONTENT_FINGERPRINT_SCHEMA_VERSION,
    fingerprintVersion: CONTENT_FINGERPRINT_VERSION,
    source: "deterministic",
    sourceVersion: FEATURE_VERSION,
    inputHash: fingerprintInputHash(item, feature),
    generatedAt,
    mediaItemId: item.id,
    title: item.title,
    mediaType: item.mediaType,
    year: item.year,
    summary: {
      premise: item.summary?.trim() || undefined,
      contentShape: contentShape(item, genres),
      experience: experienceSummary(state),
      confidence: summaryConfidence
    },
    dimensions: sortDimensions(state.dimensions),
    safetyAndFriction: state.safetyAndFriction,
    evidence,
    sourceQuality
  };
}

export function fingerprintToJson(fingerprint: ContentFingerprintV1) {
  return JSON.stringify(fingerprint);
}

export function parseContentFingerprint(value: string | undefined): ContentFingerprintV1 | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as ContentFingerprintV1;
    return parsed?.schemaVersion === CONTENT_FINGERPRINT_SCHEMA_VERSION ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function contentFingerprintMoodFeatureScores(fingerprint: ContentFingerprintV1): MoodFeatureScoreInput[] {
  const dimensions: DimensionName[] = [
    "mood",
    "tone",
    "themes",
    "setting",
    "era",
    "style",
    "pacing",
    "intensity",
    "humor",
    "romance",
    "watchability",
    "microgenres"
  ];
  const scores = dimensions.flatMap((dimension) =>
    fingerprint.dimensions[dimension]
      .filter((term) => term.polarity !== "negative" && term.confidence >= 0.4)
      .map((term) => ({
        feature: term.key,
        score: term.score,
        confidence: term.confidence
      }))
  );
  return dedupeMoodScores(scores);
}

function buildEvidence(item: ItemDetail, feature: MediaFeatureDocument): FingerprintEvidence[] {
  const evidence: FingerprintEvidence[] = [{ id: "title", sourceField: "title", value: item.title, confidence: 1 }];
  if (item.summary?.trim()) evidence.push({ id: "summary", sourceField: "summary", value: item.summary.trim(), confidence: 0.86 });
  for (const genre of item.genres) evidence.push({ id: `genre:${slug(genre)}`, sourceField: "genre", value: genre, confidence: 0.78 });
  if (item.runtimeMinutes) evidence.push({ id: "runtime", sourceField: "runtime", value: `${item.runtimeMinutes} minutes`, confidence: 0.92 });
  if (item.contentRating) evidence.push({ id: "content-rating", sourceField: "contentRating", value: item.contentRating, confidence: 0.86 });
  for (const [key, value] of Object.entries(item.ratings)) {
    if (typeof value === "number") evidence.push({ id: `rating:${key}`, sourceField: "rating", value: `${key}:${value}`, confidence: 0.72 });
  }
  for (const [index, name] of [...item.cast.slice(0, 6), ...item.directors].entries()) {
    evidence.push({ id: `person:${index}:${slug(name)}`, sourceField: "person", value: name, confidence: 0.52 });
  }
  evidence.push({ id: "availability", sourceField: "availability", value: item.availabilityGroup, confidence: 1 });
  const terms = [...feature.moodTerms, ...feature.toneTerms, ...feature.watchabilityTerms];
  if (terms.length) evidence.push({ id: "deterministic-feature-terms", sourceField: "catalogFact", value: terms.join(", "), confidence: 0.66 });
  return evidence;
}

function addFeatureTerms(state: FingerprintBuildState, feature: MediaFeatureDocument) {
  for (const term of feature.moodTerms) addTerm(state, "mood", `mood:${slug(term)}`, term, 74, 0.66, "broad", ["deterministic-feature-terms"]);
  for (const term of feature.toneTerms) addTerm(state, "tone", `tone:${slug(term)}`, term, 70, 0.64, "broad", ["deterministic-feature-terms"]);
  for (const term of feature.watchabilityTerms) {
    addTerm(state, "watchability", `watch:${slug(term)}`, term, 70, 0.7, term === "in-plex" || term === "requestable" ? "specific" : "medium", [
      "deterministic-feature-terms"
    ]);
  }
}

function addGenreTerms(state: FingerprintBuildState, genres: Set<string>) {
  if (genres.has("comedy")) {
    addTerm(state, "humor", "humor:comedy", "comedy", 76, 0.74, "broad", ["genre:comedy"]);
    addTerm(state, "tone", "tone:light", "light", 66, 0.58, "broad", ["genre:comedy"]);
  }
  if (genres.has("fantasy")) {
    addTerm(state, "mood", "mood:escapist", "escapist", 72, 0.66, "broad", ["genre:fantasy"]);
    addTerm(state, "tone", "tone:whimsical", "whimsical", 68, 0.58, "broad", ["genre:fantasy"]);
  }
  if (genres.has("romance")) {
    addTerm(state, "mood", "mood:romantic", "romantic", 78, 0.78, "broad", ["genre:romance"]);
    addTerm(state, "romance", "romance:central", "romance", 78, 0.74, "broad", ["genre:romance"]);
  }
  if (genres.has("horror")) {
    const scary = termValue("intensity:scary", "scary", 84, 0.78, "broad", ["genre:horror"]);
    addTermObject(state, "intensity", scary);
    addTerm(state, "negativeCues", "negative:scary", "scary", 84, 0.78, "broad", ["genre:horror"], "negative");
    state.safetyAndFriction.scariness = scary;
  } else if (genres.has("comedy") || genres.has("family") || genres.has("fantasy")) {
    const evidenceIds = ["comedy", "family", "fantasy"].filter((genre) => genres.has(genre)).map((genre) => `genre:${genre}`);
    addTerm(state, "intensity", "intensity:gentle", "gentle", 64, 0.52, "broad", evidenceIds);
    addTerm(state, "intensity", "intensity:low-stakes", "low-stakes", 62, 0.48, "broad", evidenceIds);
  }
}

function addSummaryTerms(state: FingerprintBuildState, text: string, item: ItemDetail) {
  if (/\bnostalg(?:ia|ic)\b|\bpast\b|\b1920s\b|\bgo(?:es|ing)? back\b/.test(text)) {
    addTerm(state, "mood", "mood:nostalgic", "nostalgic", 88, 0.82, "specific", ["summary"]);
    addTerm(state, "themes", "theme:nostalgia", "nostalgia", 88, 0.82, "specific", ["summary"]);
    addTerm(state, "themes", "theme:past-vs-present", "past versus present", 78, 0.68, "specific", ["summary"]);
  }
  if (/\bparis\b/.test(text)) addTerm(state, "setting", "setting:paris", "Paris", 94, 0.9, "specific", ["summary", "title"]);
  if (/\b1920s\b|\bnineteen twenties\b/.test(text)) addTerm(state, "era", "era:1920s", "1920s", 94, 0.9, "specific", ["summary"]);
  if (/\btime[-\s]?travel\b|\bgo(?:es|ing)? back\b|\bback to the \d{4}s\b/.test(text)) {
    addTerm(state, "themes", "theme:time-travel", "time travel", 86, 0.78, "specific", ["summary"]);
  }
  if (/\bscreenwriter\b|\bwriter\b|\bauthor\b|\bnovelist\b/.test(text)) {
    addTerm(state, "style", "style:writerly", "writerly", 70, 0.56, "specific", ["summary"]);
    addTerm(state, "style", "style:dialogue-driven", "dialogue-driven", 62, 0.42, "medium", ["summary"]);
  }
  if (/\bfiancee?\b|\bromance\b|\bromantic\b|\blove\b|\bwedding\b|\bdate\b/.test(text)) {
    addTerm(state, "mood", "mood:romantic", "romantic", 82, 0.74, "broad", ["summary"]);
    addTerm(state, "romance", "romance:relationship-tension", "relationship tension", 74, 0.62, "medium", ["summary"]);
  }
  if (/\bwitty\b|\bclever\b|\bsatire\b|\bscreenwriter\b/.test(text) || item.genres.some((genre) => genre.toLowerCase() === "comedy")) {
    addTerm(state, "tone", "tone:witty", "witty", 78, 0.66, "medium", ["summary", "genre:comedy"]);
    addTerm(state, "humor", "humor:situational", "situational humor", 68, 0.54, "medium", ["summary", "genre:comedy"]);
  }
  if (/\bfriendship\b|\bfriends?\b/.test(text)) addTerm(state, "themes", "theme:friendship", "friendship", 72, 0.7, "broad", ["summary"]);
  if (/\b(?:no|not|without)\s+(?:jokes?|comedy|humou?r)\b/.test(text)) {
    addTerm(state, "negativeCues", "negative:no-jokes", "no jokes", 84, 0.76, "specific", ["summary", "title"], "negative");
  }
  if (/\b(?:no|not|without)\s+(?:gore|scary|horror)\b|\bnot\s+too\s+scary\b/.test(text)) {
    addTerm(state, "negativeCues", "negative:not-scary", "not scary", 86, 0.78, "specific", ["summary"], "negative");
  }
}

function addRuntimeTerms(state: FingerprintBuildState, item: ItemDetail) {
  const runtime = item.runtimeMinutes;
  if (!runtime) return;
  if (item.mediaType === "movie" && runtime <= 100) {
    const term = termValue("watch:low-commitment", "low-commitment", 86, 0.9, "medium", ["runtime"]);
    addTermObject(state, "watchability", term);
    state.safetyAndFriction.runtimeCommitment = term;
    addTerm(state, "pacing", "pacing:breezy", "breezy", 76, 0.68, "medium", ["runtime"]);
  } else if (runtime > 150 || (item.mediaType === "tv" && runtime > 900)) {
    const term = termValue("watch:high-commitment", "high commitment", 78, 0.82, "medium", ["runtime"], "negative");
    addTermObject(state, "watchability", term);
    state.safetyAndFriction.runtimeCommitment = term;
  }
}

function addContentRatingTerms(state: FingerprintBuildState, item: ItemDetail) {
  const rating = item.contentRating?.toUpperCase();
  if (!rating) return;
  if (["G", "PG", "TV-G", "TV-PG"].includes(rating)) {
    const term = termValue("watch:shared-screen", "shared-screen", 82, 0.84, "medium", ["content-rating"]);
    addTermObject(state, "watchability", term);
    state.safetyAndFriction.groupFit = term;
    state.safetyAndFriction.contentRatingFriction = termValue("friction:low", "low friction", 82, 0.78, "broad", ["content-rating"]);
  } else if (["PG-13", "TV-14"].includes(rating)) {
    const term = termValue("watch:shared-screen", "shared-screen", 74, 0.76, "medium", ["content-rating"]);
    addTermObject(state, "watchability", term);
    state.safetyAndFriction.groupFit = term;
    state.safetyAndFriction.contentRatingFriction = termValue("friction:moderate", "moderate friction", 62, 0.66, "broad", ["content-rating"]);
  } else if (["R", "NC-17", "TV-MA"].includes(rating)) {
    const term = termValue("watch:high-friction", "high friction", 78, 0.82, "medium", ["content-rating"], "negative");
    addTermObject(state, "watchability", term);
    state.safetyAndFriction.contentRatingFriction = term;
  }
}

function addAvailabilityTerms(state: FingerprintBuildState, item: ItemDetail) {
  if (item.plex?.available) addTerm(state, "watchability", "watch:in-plex", "in Plex", 100, 1, "specific", ["availability"]);
  if (item.seerr?.requestable) addTerm(state, "watchability", "watch:requestable", "requestable", 88, 0.94, "specific", ["availability"]);
}

function addMicrogenres(state: FingerprintBuildState, text: string, genres: Set<string>) {
  const hasComedy = genres.has("comedy");
  const hasFantasy = genres.has("fantasy");
  const hasRomance = genres.has("romance") || /\bfiancee?\b|\bromance\b|\bromantic\b|\blove\b/.test(text);
  const hasTimeTravel = /\btime[-\s]?travel\b|\bgo(?:es|ing)? back\b|\bback to the \d{4}s\b|\b1920s\b/.test(text);
  if (hasTimeTravel && hasRomance) addTerm(state, "microgenres", "microgenre:time-travel-romance", "time-travel romance", 88, 0.78, "specific", ["summary"]);
  if (hasComedy && hasFantasy && /\bscreenwriter\b|\bwriter\b|\b1920s\b|\bparis\b/.test(text)) {
    addTerm(state, "microgenres", "microgenre:literary-fantasy-comedy", "literary fantasy comedy", 76, 0.58, "specific", ["summary", "genre:comedy", "genre:fantasy"]);
  }
  if (hasComedy && hasRomance) addTerm(state, "microgenres", "microgenre:romantic-comedy", "romantic comedy", 76, 0.64, "medium", ["summary", "genre:comedy"]);
  if (hasComedy && hasFantasy) addTerm(state, "microgenres", "microgenre:fantasy-comedy", "fantasy comedy", 76, 0.72, "medium", ["genre:comedy", "genre:fantasy"]);
  if (/\bparis\b/.test(text) && /\bnostalg/.test(text)) addTerm(state, "microgenres", "microgenre:paris-nostalgia-comedy", "Paris nostalgia comedy", 78, 0.7, "specific", ["summary"]);
}

function buildSourceQuality(item: ItemDetail): ContentFingerprintV1["sourceQuality"] {
  const summaryWords = item.summary ? item.summary.trim().split(/\s+/).filter(Boolean).length : 0;
  const summary = summaryWords === 0 ? "missing" : summaryWords < 8 ? "thin" : summaryWords < 45 ? "usable" : "rich";
  const genres = item.genres.length === 0 ? "missing" : item.genres.length === 1 ? "thin" : item.genres.length <= 3 ? "usable" : "rich";
  const peopleCount = item.cast.length + item.directors.length;
  const people = peopleCount === 0 ? "missing" : peopleCount < 3 ? "thin" : peopleCount < 8 ? "usable" : "rich";
  const ratings = Object.values(item.ratings).some((value) => typeof value === "number") ? "usable" : "missing";
  const warnings = [
    summary === "missing" ? "summary_missing" : "",
    summary === "thin" ? "summary_thin" : "",
    genres === "missing" ? "genres_missing" : "",
    ratings === "missing" ? "ratings_missing" : "",
    item.metadata?.source === "catalog" && !item.plex && !item.seerr ? "catalog_only_unverified" : ""
  ].filter(Boolean);
  return { summary, genres, people, ratings, warnings };
}

function contentShape(item: ItemDetail, genres: Set<string>) {
  const genreText = [...genres].slice(0, 3).join("/");
  if (item.mediaType === "tv") return genreText ? `tv ${genreText}` : "tv";
  return genreText ? `movie ${genreText}` : "movie";
}

function experienceSummary(state: FingerprintBuildState) {
  const terms = [
    ...state.dimensions.mood.slice(0, 2).map((term) => term.label),
    ...state.dimensions.tone.slice(0, 2).map((term) => term.label),
    ...state.dimensions.watchability.slice(0, 2).map((term) => term.label)
  ];
  return unique(terms).slice(0, 5).join(", ") || undefined;
}

function fingerprintInputHash(item: ItemDetail, feature: MediaFeatureDocument) {
  return crypto
    .createHash("sha256")
    .update(
      stableJson({
        title: item.title,
        mediaType: item.mediaType,
        year: item.year,
        summary: item.summary,
        genres: [...item.genres].sort(),
        cast: item.cast.slice(0, 8),
        directors: item.directors,
        runtimeMinutes: item.runtimeMinutes,
        contentRating: item.contentRating,
        ratings: item.ratings,
        availabilityGroup: item.availabilityGroup,
        featureVersion: feature.version,
        moodTerms: feature.moodTerms,
        toneTerms: feature.toneTerms,
        watchabilityTerms: feature.watchabilityTerms
      })
    )
    .digest("hex");
}

function normalizedText(item: ItemDetail) {
  return `${item.title} ${item.summary ?? ""} ${item.genres.join(" ")}`.toLowerCase();
}

function addTerm(
  state: FingerprintBuildState,
  dimension: DimensionName,
  key: string,
  label: string,
  score: number,
  confidence: number,
  specificity: FingerprintSpecificity,
  evidenceIds: string[],
  polarity?: FingerprintPolarity
) {
  addTermObject(state, dimension, termValue(key, label, score, confidence, specificity, evidenceIds, polarity));
}

function addTermObject(state: FingerprintBuildState, dimension: DimensionName, term: FingerprintTerm) {
  const existing = state.dimensions[dimension].find((entry) => entry.key === term.key);
  if (existing) {
    existing.score = Math.max(existing.score, term.score);
    existing.confidence = Math.max(existing.confidence, term.confidence);
    existing.evidenceIds = unique([...existing.evidenceIds, ...term.evidenceIds]);
    return;
  }
  state.dimensions[dimension].push(term);
}

function termValue(
  key: string,
  label: string,
  score: number,
  confidence: number,
  specificity: FingerprintSpecificity,
  evidenceIds: string[],
  polarity?: FingerprintPolarity
): FingerprintTerm {
  return {
    key,
    label,
    score: clampScore(score),
    confidence: clampConfidence(confidence),
    specificity,
    polarity,
    evidenceIds: unique(evidenceIds)
  };
}

function sortDimensions(dimensions: ContentFingerprintV1["dimensions"]) {
  return Object.fromEntries(
    Object.entries(dimensions).map(([dimension, terms]) => [
      dimension,
      [...terms].sort((left, right) => right.score * right.confidence - left.score * left.confidence || left.key.localeCompare(right.key))
    ])
  ) as ContentFingerprintV1["dimensions"];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function slug(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function dedupeMoodScores(scores: MoodFeatureScoreInput[]) {
  const byFeature = new Map<string, MoodFeatureScoreInput>();
  for (const score of scores) {
    const existing = byFeature.get(score.feature);
    if (!existing || score.score * (score.confidence ?? 1) > existing.score * (existing.confidence ?? 1)) {
      byFeature.set(score.feature, score);
    }
  }
  return [...byFeature.values()];
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function clampConfidence(value: number) {
  return Math.max(0, Math.min(1, Number(value.toFixed(3))));
}
