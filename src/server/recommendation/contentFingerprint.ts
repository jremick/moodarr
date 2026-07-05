import crypto from "node:crypto";
import type { ItemDetail, MediaType } from "../../shared/types";
import { FEATURE_VERSION, buildMediaFeatureDocument, type MediaFeatureDocument } from "./features";
import type { MoodFeatureScoreInput } from "./moodFeatureIndex";

export const CONTENT_FINGERPRINT_SCHEMA_VERSION = "content-fingerprint-v1";
export const CONTENT_FINGERPRINT_RULESET_VERSION = "fingerprint-rules-v2";
export const CONTENT_FINGERPRINT_VERSION = `${FEATURE_VERSION}-${CONTENT_FINGERPRINT_RULESET_VERSION}`;
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

type FingerprintTermSpec = {
  dimension: DimensionName;
  key: string;
  label: string;
  score: number;
  confidence: number;
  specificity: FingerprintSpecificity;
  polarity?: FingerprintPolarity;
};

interface TextRule {
  pattern: RegExp;
  terms: FingerprintTermSpec[];
}

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
  addReleaseEraTerms(state, item);
  addRatingsTerms(state, item);
  addCatalogFactTerms(state, item);
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
    sourceVersion: `${FEATURE_VERSION}+${CONTENT_FINGERPRINT_RULESET_VERSION}`,
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
  if (item.year) evidence.push({ id: "release-year", sourceField: "catalogFact", value: String(item.year), confidence: 0.9 });
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
  const catalog = item.metadata?.catalog;
  if (catalog) {
    const rankFacts = [
      typeof catalog.mainstreamScore === "number" ? `mainstream:${catalog.mainstreamScore}` : "",
      typeof catalog.metadataConfidence === "number" ? `metadata-confidence:${catalog.metadataConfidence}` : "",
      typeof catalog.sitelinkCount === "number" ? `sitelinks:${catalog.sitelinkCount}` : "",
      typeof catalog.awardCount === "number" ? `awards:${catalog.awardCount}` : ""
    ].filter(Boolean);
    if (rankFacts.length) evidence.push({ id: "catalog:rank", sourceField: "catalogFact", value: rankFacts.join(", "), confidence: 0.58 });
    if (catalog.countries?.length) evidence.push({ id: "catalog:countries", sourceField: "catalogFact", value: catalog.countries.join(", "), confidence: 0.5 });
    if (catalog.languages?.length) evidence.push({ id: "catalog:languages", sourceField: "catalogFact", value: catalog.languages.join(", "), confidence: 0.48 });
    if (catalog.franchises?.length) evidence.push({ id: "catalog:franchises", sourceField: "catalogFact", value: catalog.franchises.join(", "), confidence: 0.54 });
  }
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
  const has = (value: string) => genres.has(value);
  if (has("comedy")) {
    addTerm(state, "humor", "humor:comedy", "comedy", 76, 0.74, "broad", ["genre:comedy"]);
    addTerm(state, "tone", "tone:light", "light", 66, 0.58, "broad", ["genre:comedy"]);
  }
  if (has("fantasy")) {
    addTerm(state, "mood", "mood:escapist", "escapist", 72, 0.66, "broad", ["genre:fantasy"]);
    addTerm(state, "tone", "tone:whimsical", "whimsical", 68, 0.58, "broad", ["genre:fantasy"]);
  }
  if (has("romance")) {
    addTerm(state, "mood", "mood:romantic", "romantic", 78, 0.78, "broad", ["genre:romance"]);
    addTerm(state, "romance", "romance:central", "romance", 78, 0.74, "broad", ["genre:romance"]);
  }
  if (has("action")) {
    addTerm(state, "mood", "mood:adventurous", "adventurous", 72, 0.54, "broad", ["genre:action"]);
    addTerm(state, "pacing", "pacing:propulsive", "propulsive", 76, 0.58, "broad", ["genre:action"]);
    addTerm(state, "intensity", "intensity:action-driven", "action-driven", 74, 0.56, "broad", ["genre:action"]);
  }
  if (has("adventure")) {
    addTerm(state, "mood", "mood:adventurous", "adventurous", 78, 0.62, "broad", ["genre:adventure"]);
    addTerm(state, "pacing", "pacing:quest-driven", "quest-driven", 68, 0.48, "broad", ["genre:adventure"]);
  }
  if (has("drama")) {
    addTerm(state, "mood", "mood:emotional", "emotional", 64, 0.46, "broad", ["genre:drama"]);
    addTerm(state, "tone", "tone:sincere", "sincere", 60, 0.42, "broad", ["genre:drama"]);
  }
  if (has("thriller")) {
    addTerm(state, "tone", "tone:suspenseful", "suspenseful", 82, 0.68, "broad", ["genre:thriller"]);
    addTerm(state, "mood", "mood:intense", "intense", 76, 0.58, "broad", ["genre:thriller"]);
    addTerm(state, "intensity", "intensity:tense", "tense", 78, 0.62, "broad", ["genre:thriller"]);
  }
  if (has("mystery")) {
    addTerm(state, "tone", "tone:clever", "clever", 76, 0.58, "broad", ["genre:mystery"]);
    addTerm(state, "tone", "tone:suspenseful", "suspenseful", 70, 0.5, "broad", ["genre:mystery"]);
    addTerm(state, "themes", "theme:investigation", "investigation", 70, 0.5, "broad", ["genre:mystery"]);
  }
  if (has("crime")) {
    addTerm(state, "themes", "theme:crime", "crime", 72, 0.52, "broad", ["genre:crime"]);
    addTerm(state, "tone", "tone:suspenseful", "suspenseful", 68, 0.48, "broad", ["genre:crime"]);
  }
  if (has("documentary")) {
    addTerm(state, "tone", "tone:grounded", "grounded", 84, 0.72, "broad", ["genre:documentary"]);
    const term = termValue("watch:attention-heavy", "attention-heavy", 66, 0.5, "broad", ["genre:documentary"]);
    addTermObject(state, "watchability", term);
    state.safetyAndFriction.attentionDemand = term;
  }
  if (has("science fiction") || has("sci-fi") || has("sci fi")) {
    addTerm(state, "tone", "tone:speculative", "speculative", 76, 0.56, "broad", ["genre:science-fiction"]);
    addTerm(state, "mood", "mood:escapist", "escapist", 62, 0.44, "broad", ["genre:science-fiction"]);
  }
  if (has("family") || has("animation")) {
    addTerm(state, "watchability", "watch:group-friendly", "group-friendly", 78, 0.62, "broad", ["genre:family", "genre:animation"]);
    addTerm(state, "watchability", "watch:shared-screen", "shared-screen", 76, 0.58, "broad", ["genre:family", "genre:animation"]);
  }
  if (has("music") || has("musical")) {
    addTerm(state, "themes", "theme:music", "music", 74, 0.56, "broad", ["genre:music", "genre:musical"]);
    addTerm(state, "mood", "mood:expressive", "expressive", 64, 0.44, "broad", ["genre:music", "genre:musical"]);
  }
  if (has("war")) {
    addTerm(state, "themes", "theme:war", "war", 78, 0.62, "broad", ["genre:war"]);
    addTerm(state, "tone", "tone:heavy", "heavy", 76, 0.58, "broad", ["genre:war"]);
    addTerm(state, "watchability", "watch:attention-heavy", "attention-heavy", 66, 0.48, "broad", ["genre:war"]);
  }
  if (has("sports")) {
    addTerm(state, "themes", "theme:sports", "sports", 76, 0.58, "broad", ["genre:sports"]);
    addTerm(state, "mood", "mood:feel-good", "feel-good", 60, 0.42, "broad", ["genre:sports"]);
  }
  if (has("horror")) {
    const scary = termValue("intensity:scary", "scary", 84, 0.78, "broad", ["genre:horror"]);
    addTermObject(state, "intensity", scary);
    addTerm(state, "negativeCues", "negative:scary", "scary", 84, 0.78, "broad", ["genre:horror"], "negative");
    state.safetyAndFriction.scariness = scary;
  } else if (has("comedy") || has("family") || has("fantasy") || has("animation")) {
    const evidenceIds = ["comedy", "family", "fantasy", "animation"].filter((genre) => has(genre)).map((genre) => `genre:${genre}`);
    addTerm(state, "intensity", "intensity:gentle", "gentle", 64, 0.52, "broad", evidenceIds);
    addTerm(state, "intensity", "intensity:low-stakes", "low-stakes", 62, 0.48, "broad", evidenceIds);
  }
}

function addSummaryTerms(state: FingerprintBuildState, text: string, item: ItemDetail) {
  if (/\bnostalg(?:ia|ic)\b|\bpast\b|\b1920s\b|\bgo(?:es|ing)? back\b/.test(text)) {
    addTerm(state, "mood", "mood:nostalgic", "nostalgic", 88, 0.82, "specific", ["summary"]);
    addTerm(state, "themes", "theme:nostalgia", "nostalgia", 88, 0.82, "specific", ["summary"]);
    addTerm(state, "themes", "theme:past-vs-present", "past versus present", 78, 0.68, "specific", ["summary"]);
    addTerm(state, "tone", "tone:wistful", "wistful", 74, 0.62, "medium", ["summary"]);
  }
  if (/\bparis\b/.test(text)) addTerm(state, "setting", "setting:paris", "Paris", 94, 0.9, "specific", ["summary", "title"]);
  if (/\b1920s\b|\bnineteen twenties\b/.test(text)) addTerm(state, "era", "era:1920s", "1920s", 94, 0.9, "specific", ["summary"]);
  if (/\btime[-\s]?travel\b|\bgo(?:es|ing)? back\b|\bback to the \d{4}s\b/.test(text)) {
    addTerm(state, "themes", "theme:time-travel", "time travel", 86, 0.78, "specific", ["summary"]);
    addTerm(state, "style", "style:period-fantasy", "period fantasy", 72, 0.58, "specific", ["summary"]);
  }
  if (/\bscreenwriter\b|\bwriter\b|\bauthor\b|\bnovelist\b/.test(text)) {
    addTerm(state, "style", "style:writerly", "writerly", 70, 0.56, "specific", ["summary"]);
    addTerm(state, "style", "style:dialogue-driven", "dialogue-driven", 62, 0.42, "medium", ["summary"]);
    addTerm(state, "themes", "theme:creative-longing", "creative longing", 70, 0.54, "specific", ["summary"]);
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
  applyTextRules(state, text, summaryRules, ["summary"]);
  applyCompoundSummaryRules(state, text, item);
  if (/\b(?:no|not|without)\s+(?:jokes?|comedy|humou?r)\b/.test(text)) {
    addTerm(state, "negativeCues", "negative:no-jokes", "no jokes", 84, 0.76, "specific", ["summary", "title"], "negative");
  }
  if (/\b(?:no|not|without)\s+(?:gore|scary|horror)\b|\bnot\s+too\s+scary\b/.test(text)) {
    addTerm(state, "negativeCues", "negative:not-scary", "not scary", 86, 0.78, "specific", ["summary"], "negative");
  }
}

const summaryRules: TextRule[] = [
  textRule(/\b(?:identity|self-discovery|finds? herself|finds? himself|reinvents?|double life|secret identity)\b/, [
    spec("themes", "theme:identity", "identity", 78, 0.66, "medium"),
    spec("tone", "tone:introspective", "introspective", 68, 0.54, "medium")
  ]),
  textRule(/\b(?:ambition|fame|success|career|rivalry|rivals?|competition|competes?|championship)\b/, [
    spec("themes", "theme:ambition", "ambition", 74, 0.58, "medium"),
    spec("pacing", "pacing:goal-driven", "goal-driven", 66, 0.48, "medium")
  ]),
  textRule(/\b(?:grief|mourning|loss of|bereavement|widow|widower|healing|trauma)\b/, [
    spec("themes", "theme:grief", "grief", 82, 0.72, "medium"),
    spec("tone", "tone:heavy", "heavy", 76, 0.62, "medium"),
    spec("mood", "mood:emotional", "emotional", 78, 0.64, "medium")
  ]),
  textRule(/\b(?:coming[-\s]?of[-\s]?age|teenage|teenagers?|adolescen(?:t|ce)|growing up|high school)\b/, [
    spec("themes", "theme:coming-of-age", "coming-of-age", 82, 0.72, "medium"),
    spec("setting", "setting:school", "school", 70, 0.54, "medium")
  ]),
  textRule(/\b(?:revenge|vengeance|avenges?|payback)\b/, [
    spec("themes", "theme:revenge", "revenge", 84, 0.74, "medium"),
    spec("mood", "mood:intense", "intense", 78, 0.62, "medium"),
    spec("intensity", "intensity:violent", "violent", 72, 0.54, "medium")
  ]),
  textRule(/\b(?:survival|survive|stranded|trapped|wilderness|deserted|shipwreck|post[-\s]?apocalyptic)\b/, [
    spec("themes", "theme:survival", "survival", 84, 0.72, "medium"),
    spec("intensity", "intensity:tense", "tense", 76, 0.6, "medium")
  ]),
  textRule(/\b(?:investigation|detective|mystery|murder|case|whodunit|conspiracy|uncover(?:s|ing)?)\b/, [
    spec("themes", "theme:investigation", "investigation", 82, 0.7, "medium"),
    spec("tone", "tone:clever", "clever", 74, 0.58, "medium"),
    spec("tone", "tone:suspenseful", "suspenseful", 72, 0.56, "medium")
  ]),
  textRule(/\b(?:crime|criminal|heist|robbery|gangster|mafia|police|lawyer|courtroom|trial)\b/, [
    spec("themes", "theme:crime", "crime", 80, 0.66, "medium"),
    spec("themes", "theme:law", "law", 76, 0.58, "medium"),
    spec("tone", "tone:grounded", "grounded", 62, 0.44, "broad")
  ]),
  textRule(/\b(?:political|politics|election|government|president|minister|senator|revolution|activis[mt])\b/, [
    spec("themes", "theme:politics", "politics", 78, 0.64, "medium"),
    spec("watchability", "watch:attention-heavy", "attention-heavy", 68, 0.5, "medium")
  ]),
  textRule(/\b(?:war|soldier|military|battle|army|navy|veteran|frontline)\b/, [
    spec("themes", "theme:war", "war", 84, 0.72, "medium"),
    spec("tone", "tone:heavy", "heavy", 76, 0.6, "medium")
  ]),
  textRule(/\b(?:music|musician|band|singer|songwriter|concert|dance|dancer|musical)\b/, [
    spec("themes", "theme:music", "music", 82, 0.7, "medium"),
    spec("mood", "mood:expressive", "expressive", 70, 0.54, "medium")
  ]),
  textRule(/\b(?:sport|sports|football|soccer|baseball|basketball|boxing|coach|athlete|team)\b/, [
    spec("themes", "theme:sports", "sports", 82, 0.7, "medium"),
    spec("pacing", "pacing:goal-driven", "goal-driven", 70, 0.54, "medium")
  ]),
  textRule(/\b(?:christmas|holiday|thanksgiving|new year|festive)\b/, [
    spec("themes", "theme:holiday", "holiday", 84, 0.74, "specific"),
    spec("mood", "mood:warm", "warm", 78, 0.64, "medium"),
    spec("watchability", "watch:group-friendly", "group-friendly", 76, 0.58, "medium")
  ]),
  textRule(/\b(?:road trip|roadtrip|cross-country|journey across|travels? across|on the road)\b/, [
    spec("themes", "theme:road-trip", "road trip", 84, 0.72, "specific"),
    spec("mood", "mood:adventurous", "adventurous", 76, 0.58, "medium")
  ]),
  textRule(/\b(?:found family|makeshift family|unlikely family|chosen family)\b/, [
    spec("themes", "theme:found-family", "found family", 86, 0.76, "specific"),
    spec("mood", "mood:warm", "warm", 78, 0.64, "medium")
  ]),
  textRule(/\b(?:family|families|parent|parents|mother|father|siblings?|daughter|son)\b/, [
    spec("themes", "theme:family", "family", 70, 0.52, "broad")
  ]),
  textRule(/\b(?:new york|manhattan|brooklyn)\b/, [spec("setting", "setting:new-york", "New York", 88, 0.78, "specific")]),
  textRule(/\b(?:london)\b/, [spec("setting", "setting:london", "London", 88, 0.78, "specific")]),
  textRule(/\b(?:los angeles|hollywood)\b/, [spec("setting", "setting:los-angeles", "Los Angeles", 86, 0.76, "specific")]),
  textRule(/\b(?:space|spaceship|spacecraft|astronaut|planet|galaxy|mars|moon)\b/, [
    spec("setting", "setting:space", "space", 86, 0.74, "medium"),
    spec("tone", "tone:speculative", "speculative", 70, 0.52, "medium")
  ]),
  textRule(/\b(?:small town|village|rural town)\b/, [
    spec("setting", "setting:small-town", "small town", 86, 0.76, "medium"),
    spec("setting", "setting:rural", "rural", 66, 0.5, "broad")
  ]),
  textRule(/\b(?:ocean|sea|seaside|coastal|beach|island|ship|boat)\b/, [spec("setting", "setting:ocean", "ocean", 78, 0.62, "medium")]),
  textRule(/\b(?:forest|wilderness|mountain|desert|jungle|countryside)\b/, [spec("setting", "setting:wilderness", "wilderness", 78, 0.62, "medium")]),
  textRule(/\b(?:office|workplace|company|corporate|co-workers?|coworkers?)\b/, [spec("setting", "setting:workplace", "workplace", 74, 0.58, "medium")]),
  textRule(/\b(?:city|urban|metropolis)\b/, [spec("setting", "setting:urban", "urban", 66, 0.48, "broad")]),
  textRule(/\b(?:future|futuristic|distant future|near future)\b/, [
    spec("era", "era:future", "future", 84, 0.72, "medium"),
    spec("tone", "tone:speculative", "speculative", 70, 0.52, "medium")
  ]),
  textRule(/\b(?:medieval|middle ages|knight|kingdom|castle)\b/, [spec("era", "era:medieval", "medieval", 84, 0.72, "medium")]),
  textRule(/\b(?:victorian|edwardian|19th century|nineteenth century)\b/, [spec("era", "era:victorian", "Victorian", 82, 0.7, "medium")]),
  textRule(/\b(?:1960s|nineteen sixties|sixties)\b/, [spec("era", "era:1960s", "1960s", 84, 0.74, "specific")]),
  textRule(/\b(?:1970s|nineteen seventies|seventies)\b/, [spec("era", "era:1970s", "1970s", 84, 0.74, "specific")]),
  textRule(/\b(?:1980s|nineteen eighties|eighties)\b/, [spec("era", "era:1980s", "1980s", 84, 0.74, "specific")]),
  textRule(/\b(?:1990s|nineteen nineties|nineties)\b/, [spec("era", "era:1990s", "1990s", 84, 0.74, "specific")]),
  textRule(/\b(?:2000s|two thousands|aughts)\b/, [spec("era", "era:2000s", "2000s", 78, 0.66, "specific")]),
  textRule(/\b(?:slow burn|slow-burn|meditative|patiently paced)\b/, [
    spec("pacing", "pacing:slow-burn", "slow-burn", 84, 0.74, "medium"),
    spec("watchability", "watch:attention-heavy", "attention-heavy", 72, 0.56, "medium")
  ]),
  textRule(/\b(?:fast-paced|fast paced|relentless|nonstop|race against time|chase)\b/, [
    spec("pacing", "pacing:propulsive", "propulsive", 84, 0.72, "medium"),
    spec("intensity", "intensity:tense", "tense", 74, 0.58, "medium")
  ]),
  textRule(/\b(?:quiet|gentle|low-key|low key|understated|soft)\b/, [
    spec("tone", "tone:quiet", "quiet", 78, 0.66, "medium"),
    spec("intensity", "intensity:gentle", "gentle", 72, 0.58, "medium")
  ]),
  textRule(/\b(?:bleak|grim|nihilistic|devastating|tragic)\b/, [
    spec("tone", "tone:bleak", "bleak", 84, 0.74, "medium"),
    spec("watchability", "watch:high-friction", "high friction", 74, 0.6, "medium")
  ]),
  textRule(/\b(?:violent|violence|brutal|gore|bloody)\b/, [
    spec("intensity", "intensity:violent", "violent", 86, 0.76, "medium"),
    spec("watchability", "watch:high-friction", "high friction", 82, 0.7, "medium")
  ]),
  textRule(/\b(?:scary|frightening|terrifying|terror|nightmare|haunted)\b/, [
    spec("intensity", "intensity:scary", "scary", 86, 0.76, "medium"),
    spec("watchability", "watch:high-friction", "high friction", 82, 0.68, "medium")
  ]),
  textRule(/\b(?:dense|complex|philosophical|experimental|nonlinear|non-linear|ambiguous)\b/, [
    spec("style", "style:complex", "complex", 80, 0.66, "medium"),
    spec("watchability", "watch:attention-heavy", "attention-heavy", 78, 0.62, "medium")
  ]),
  textRule(/\b(?:easy watch|easygoing|easy-going|breezy|lighthearted|light-hearted)\b/, [
    spec("watchability", "watch:easy-watch", "easy watch", 82, 0.68, "medium"),
    spec("pacing", "pacing:breezy", "breezy", 76, 0.58, "medium")
  ])
];

function applyCompoundSummaryRules(state: FingerprintBuildState, text: string, item: ItemDetail) {
  const hasTimeTravel = /\btime[-\s]?travel\b|\bgo(?:es|ing)? back\b|\bback to the \d{4}s\b|\b1920s\b/.test(text);
  const hasRomance = /\bfiancee?\b|\bromance\b|\bromantic\b|\blove\b|\bwedding\b|\bdate\b/.test(text) || item.genres.some((genre) => genre.toLowerCase() === "romance");
  const hasNostalgia = /\bnostalg(?:ia|ic)\b|\bpast\b|\b1920s\b/.test(text);
  if (hasNostalgia && hasRomance) {
    addTerm(state, "themes", "theme:romantic-idealization", "romantic idealization", 74, 0.58, "specific", ["summary"]);
  }
  if (hasTimeTravel && /\b1920s\b|\bnineteen twenties\b|\bmedieval\b|\bvictorian\b|\b19th century\b/.test(text)) {
    addTerm(state, "style", "style:period-fantasy", "period fantasy", 78, 0.64, "specific", ["summary"]);
  }
  if (/\b(?:subtitle|subtitled|foreign language|non-english)\b/.test(text)) {
    const term = termValue("watch:language-attention", "language attention", 70, 0.54, "medium", ["summary"]);
    addTermObject(state, "watchability", term);
    state.safetyAndFriction.attentionDemand = strongerTerm(state.safetyAndFriction.attentionDemand, term);
  }
}

function applyTextRules(state: FingerprintBuildState, text: string, rules: TextRule[], evidenceIds: string[]) {
  for (const rule of rules) {
    if (!rule.pattern.test(text)) continue;
    for (const term of rule.terms) {
      const value = termValue(term.key, term.label, term.score, term.confidence, term.specificity, evidenceIds, term.polarity);
      addTermObject(state, term.dimension, value);
      updateSafetyFromTerm(state, value);
    }
  }
}

function addReleaseEraTerms(state: FingerprintBuildState, item: ItemDetail) {
  const year = item.year;
  if (!year || year < 1900 || year > 2100) return;
  const decade = Math.floor(year / 10) * 10;
  addTerm(state, "era", `era:release-${decade}s`, `${decade}s release`, 56, 0.42, "broad", ["release-year"]);
}

function addRatingsTerms(state: FingerprintBuildState, item: ItemDetail) {
  const values = Object.values(item.ratings).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (values.length === 0) return;
  const normalized = values.map((value) => (value <= 10 ? value * 10 : value));
  const average = normalized.reduce((total, value) => total + value, 0) / normalized.length;
  if (average >= 82) {
    addTerm(state, "watchability", "watch:well-liked", "well-liked", 72, 0.56, "broad", ratingEvidenceIds(item));
  } else if (average >= 72) {
    addTerm(state, "watchability", "watch:solid-pick", "solid pick", 64, 0.48, "broad", ratingEvidenceIds(item));
  } else if (average <= 45) {
    addTerm(state, "negativeCues", "negative:low-rated", "low-rated", 68, 0.48, "broad", ratingEvidenceIds(item), "negative");
  }
}

function addCatalogFactTerms(state: FingerprintBuildState, item: ItemDetail) {
  const catalog = item.metadata?.catalog;
  if (!catalog) return;
  if ((catalog.mainstreamScore ?? 0) >= 76 || (catalog.sitelinkCount ?? 0) >= 80) {
    addTerm(state, "watchability", "watch:mainstream-friendly", "mainstream-friendly", 68, 0.5, "broad", ["catalog:rank"]);
  } else if ((catalog.mainstreamScore ?? 0) >= 52 || (catalog.sitelinkCount ?? 0) >= 25) {
    addTerm(state, "watchability", "watch:recognizable", "recognizable", 60, 0.42, "broad", ["catalog:rank"]);
  }
  if ((catalog.awardCount ?? 0) >= 2) {
    addTerm(state, "style", "style:award-recognized", "award-recognized", 64, 0.46, "broad", ["catalog:rank"]);
  }
  for (const country of catalog.countries?.slice(0, 4) ?? []) {
    addTerm(state, "setting", `setting:country-${slug(country)}`, country, 56, 0.42, "broad", ["catalog:countries"]);
  }
  for (const language of catalog.languages?.slice(0, 3) ?? []) {
    addTerm(state, "style", `style:language-${slug(language)}`, `${language} language`, 56, 0.42, "broad", ["catalog:languages"]);
  }
  if (catalog.franchises?.length) {
    addTerm(state, "style", "style:franchise-entry", "franchise entry", 62, 0.46, "medium", ["catalog:franchises"]);
    addTerm(state, "watchability", "watch:familiar-world", "familiar world", 60, 0.42, "medium", ["catalog:franchises"]);
  }
}

function updateSafetyFromTerm(state: FingerprintBuildState, term: FingerprintTerm) {
  if (term.key === "watch:attention-heavy" || term.key === "watch:language-attention") {
    state.safetyAndFriction.attentionDemand = strongerTerm(state.safetyAndFriction.attentionDemand, term);
  }
  if (term.key === "watch:high-friction") {
    state.safetyAndFriction.contentRatingFriction = strongerTerm(state.safetyAndFriction.contentRatingFriction, term);
  }
  if (term.key === "intensity:scary") {
    state.safetyAndFriction.scariness = strongerTerm(state.safetyAndFriction.scariness, term);
  }
  if (term.key === "tone:heavy" || term.key === "tone:bleak") {
    state.safetyAndFriction.emotionalWeight = strongerTerm(state.safetyAndFriction.emotionalWeight, term);
  }
}

function textRule(pattern: RegExp, terms: FingerprintTermSpec[]): TextRule {
  return { pattern, terms };
}

function spec(
  dimension: DimensionName,
  key: string,
  label: string,
  score: number,
  confidence: number,
  specificity: FingerprintSpecificity,
  polarity?: FingerprintPolarity
): FingerprintTermSpec {
  return { dimension, key, label, score, confidence, specificity, polarity };
}

function addRuntimeTerms(state: FingerprintBuildState, item: ItemDetail) {
  const runtime = item.runtimeMinutes;
  if (!runtime) return;
  if (item.mediaType === "movie" && runtime <= 100) {
    const term = termValue("watch:low-commitment", "low-commitment", 86, 0.9, "medium", ["runtime"]);
    addTermObject(state, "watchability", term);
    state.safetyAndFriction.runtimeCommitment = term;
    addTerm(state, "pacing", "pacing:breezy", "breezy", 76, 0.68, "medium", ["runtime"]);
    addTerm(state, "watchability", "watch:easy-watch", "easy watch", 62, 0.46, "broad", ["runtime"]);
  } else if (runtime > 150 || (item.mediaType === "tv" && runtime > 900)) {
    const term = termValue("watch:high-commitment", "high commitment", 78, 0.82, "medium", ["runtime"], "negative");
    addTermObject(state, "watchability", term);
    state.safetyAndFriction.runtimeCommitment = term;
    const attention = termValue("watch:attention-heavy", "attention-heavy", 66, 0.5, "broad", ["runtime"]);
    addTermObject(state, "watchability", attention);
    state.safetyAndFriction.attentionDemand = strongerTerm(state.safetyAndFriction.attentionDemand, attention);
  }
}

function addContentRatingTerms(state: FingerprintBuildState, item: ItemDetail) {
  const rating = item.contentRating?.toUpperCase();
  if (!rating) return;
  if (["G", "PG", "TV-G", "TV-PG"].includes(rating)) {
    const term = termValue("watch:shared-screen", "shared-screen", 82, 0.84, "medium", ["content-rating"]);
    addTermObject(state, "watchability", term);
    addTerm(state, "watchability", "watch:group-friendly", "group-friendly", 80, 0.74, "medium", ["content-rating"]);
    state.safetyAndFriction.groupFit = term;
    state.safetyAndFriction.contentRatingFriction = termValue("friction:low", "low friction", 82, 0.78, "broad", ["content-rating"]);
  } else if (["PG-13", "TV-14"].includes(rating)) {
    const term = termValue("watch:shared-screen", "shared-screen", 74, 0.76, "medium", ["content-rating"]);
    addTermObject(state, "watchability", term);
    addTerm(state, "watchability", "watch:group-friendly", "group-friendly", 70, 0.62, "medium", ["content-rating"]);
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
  if (hasComedy && /\b(?:dark|black comedy|deadpan|cynical|murder|crime)\b/.test(text)) {
    addTerm(state, "microgenres", "microgenre:dark-comedy", "dark comedy", 82, 0.68, "specific", ["summary", "genre:comedy"]);
  }
  if (genres.has("mystery") && /\b(?:cozy|cosy|village|small town|bookshop|bakery|gentle)\b/.test(text)) {
    addTerm(state, "microgenres", "microgenre:cozy-mystery", "cozy mystery", 86, 0.76, "specific", ["summary", "genre:mystery"]);
  }
  if (genres.has("thriller") && /\b(?:survival|stranded|trapped|wilderness)\b/.test(text)) {
    addTerm(state, "microgenres", "microgenre:survival-thriller", "survival thriller", 84, 0.72, "specific", ["summary", "genre:thriller"]);
  }
  if (/\bcoming[-\s]?of[-\s]?age\b/.test(text) && (genres.has("comedy") || genres.has("drama"))) {
    addTerm(state, "microgenres", "microgenre:coming-of-age", "coming-of-age", 80, 0.68, "medium", ["summary"]);
  }
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

function ratingEvidenceIds(item: ItemDetail) {
  const ids = Object.entries(item.ratings)
    .filter(([, value]) => typeof value === "number")
    .map(([key]) => `rating:${key}`);
  return ids.length ? ids : ["rating"];
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

function strongerTerm(current: FingerprintTerm | undefined, candidate: FingerprintTerm) {
  if (!current) return candidate;
  return candidate.score * candidate.confidence > current.score * current.confidence ? candidate : current;
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
        fingerprintRulesetVersion: CONTENT_FINGERPRINT_RULESET_VERSION,
        moodTerms: feature.moodTerms,
        toneTerms: feature.toneTerms,
        watchabilityTerms: feature.watchabilityTerms,
        catalog: item.metadata?.catalog
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
