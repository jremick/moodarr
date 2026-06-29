import type { AvailabilityGroup, ItemDetail } from "../../shared/types";
import { tokenize } from "./intent";

export const FEATURE_VERSION = "moodrank-v0.4-features-v1";

export interface MediaFeatureDocument {
  mediaItemId: string;
  featureText: string;
  moodTerms: string[];
  toneTerms: string[];
  watchabilityTerms: string[];
  vector: Record<string, number>;
  version: string;
}

const genreExpansions: Record<string, string[]> = {
  action: ["energetic", "big", "high-stakes", "propulsive", "spectacle"],
  adventure: ["journey", "quest", "breezy", "exciting", "escapist", "swashbuckling"],
  animation: ["animated", "stylized", "imaginative", "cartoon", "family-friendly"],
  comedy: ["funny", "light", "witty", "jokes", "low-friction", "easy"],
  crime: ["gritty", "procedural", "danger", "investigation"],
  documentary: ["real", "informative", "grounded", "thoughtful"],
  drama: ["emotional", "character", "serious", "intimate", "weighty"],
  family: ["warm", "gentle", "shared-screen", "comfort", "family-friendly"],
  fantasy: ["magic", "magical", "whimsical", "mythic", "escapist", "wonder"],
  horror: ["scary", "dark", "tense", "dread", "intense"],
  mystery: ["puzzle", "clever", "intrigue", "investigation", "twisty"],
  romance: ["romantic", "heart", "warm", "tender", "date-night"],
  "science fiction": ["sci-fi", "speculative", "future", "high-concept", "wonder"],
  thriller: ["tense", "suspense", "propulsive", "danger", "gripping"],
  war: ["heavy", "intense", "serious", "violent"]
};

const cueTerms: Record<string, string[]> = {
  "feel-good": ["feel-good", "warm", "kind", "gentle", "heart", "friendship", "comfort", "cozy"],
  funny: ["funny", "comedy", "jokes", "witty", "farce", "sitcom", "absurdity"],
  magical: ["fantasy", "magic", "magical", "witch", "powers", "myth", "whimsical"],
  cozy: ["cozy", "comfort", "gentle", "small town", "countryside", "autumn"],
  clever: ["clever", "smart", "witty", "satire", "mystery", "puzzle"],
  weird: ["weird", "surreal", "offbeat", "quirky", "strange"],
  intense: ["tense", "dark", "violent", "horror", "thriller", "gritty"],
  "low-commitment": ["short", "miniseries", "limited", "quick", "breezy", "easy"],
  romantic: ["romantic", "romance", "date night", "tender", "heart"],
  suspenseful: ["suspense", "suspenseful", "tense", "thriller", "mystery"],
  grounded: ["grounded", "real", "documentary", "naturalistic", "slice of life"],
  "attention-heavy": ["dense", "complex", "slow burn", "subtitles", "meditative", "deliberate"],
  "background-friendly": ["easy", "light", "episodic", "sitcom", "comfort"],
  "group-friendly": ["shared-screen", "family", "adventure", "comedy", "pg", "pg-13", "tv-pg", "tv-14"],
  "late-night": ["dark", "moody", "quiet", "slow burn", "noir"],
  cathartic: ["cathartic", "emotional", "uplifting", "triumph", "healing"]
};

const stopTerms = new Set(["movie", "show", "series", "episode", "season", "watch", "available", "requestable", "plex", "seerr"]);

export function buildMediaFeatureDocument(item: ItemDetail): MediaFeatureDocument {
  const genreTerms = item.genres.flatMap((genre) => [genre, ...(genreExpansions[genre.toLowerCase()] ?? [])]);
  const inferredRuntimeTerms = runtimeTerms(item.runtimeMinutes, item.mediaType);
  const inferredRatingTerms = contentRatingTerms(item.contentRating);
  const titleSummary = `${item.title} ${item.summary ?? ""}`;
  const baseText = [
    item.title,
    item.year ? String(item.year) : "",
    item.mediaType,
    item.summary ?? "",
    ...genreTerms,
    ...item.cast.slice(0, 8),
    ...item.directors,
    item.contentRating ?? "",
    availabilityTerms(item.availabilityGroup),
    inferredRuntimeTerms,
    inferredRatingTerms
  ].join(" ");

  const moodTerms = [
    ...inferCueTerms(baseText, ["feel-good", "funny", "magical", "cozy", "weird", "romantic", "cathartic", "late-night"]),
    ...inferPhraseMoodTerms(titleSummary)
  ];
  const toneTerms = inferCueTerms(baseText, ["clever", "intense", "suspenseful", "grounded"]);
  const watchabilityTerms = [
    ...inferCueTerms(baseText, ["low-commitment", "background-friendly", "attention-heavy", "group-friendly"]),
    ...(isSharedScreenFriendly(item) ? ["shared-screen"] : []),
    ...(isHighFriction(item) ? ["high-friction"] : []),
    ...(item.plex?.available ? ["in-plex"] : []),
    ...(item.seerr?.requestable ? ["requestable"] : [])
  ];
  const featureText = [baseText, ...moodTerms, ...toneTerms, ...watchabilityTerms].join(" ");

  return {
    mediaItemId: item.id,
    featureText,
    moodTerms: unique(moodTerms),
    toneTerms: unique(toneTerms),
    watchabilityTerms: unique(watchabilityTerms),
    vector: buildSemanticVector(featureText),
    version: FEATURE_VERSION
  };
}

export function buildQueryVector(query: string) {
  const expanded = expandSemanticText(query);
  return buildSemanticVector(expanded);
}

export function buildSemanticVector(value: string) {
  const vector: Record<string, number> = {};
  for (const term of tokenizeFeatureText(expandSemanticText(value))) {
    vector[term] = (vector[term] ?? 0) + 1;
  }
  return normalizeVector(vector);
}

export function parseFeatureVector(value: string | undefined) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as Record<string, number>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

export function cosineSimilarity(left: Record<string, number>, right: Record<string, number>) {
  let dot = 0;
  for (const [term, weight] of Object.entries(left)) {
    dot += weight * (right[term] ?? 0);
  }
  return Math.max(0, Math.min(1, dot));
}

export function vectorToJson(vector: Record<string, number>) {
  return JSON.stringify(vector);
}

function expandSemanticText(value: string) {
  const terms = tokenize(value);
  const expansions = terms.flatMap((term) => {
    if (term === "feelgood") return cueTerms["feel-good"];
    if (term === "feel-good") return cueTerms["feel-good"];
    if (term === "fantasy") return cueTerms.magical;
    if (term === "funny" || term === "comedy") return cueTerms.funny;
    if (term === "cozy") return cueTerms.cozy;
    if (term === "weird") return cueTerms.weird;
    if (term === "clever") return cueTerms.clever;
    if (term === "romantic" || term === "romance") return cueTerms.romantic;
    if (term === "tense" || term === "suspenseful") return cueTerms.suspenseful;
    if (term === "easy" || term === "breezy") return cueTerms["low-commitment"];
    if (term === "short") return cueTerms["low-commitment"];
    return [];
  });
  return `${value} ${expansions.join(" ")}`;
}

function inferCueTerms(text: string, keys: string[]) {
  const normalized = text.toLowerCase();
  return keys.filter((key) => cueTerms[key]?.some((cue) => normalized.includes(cue)));
}

function runtimeTerms(runtime: number | undefined, mediaType: ItemDetail["mediaType"]) {
  if (!runtime) return "";
  if (mediaType === "tv") {
    if (runtime <= 240) return "short low-commitment miniseries easy";
    if (runtime <= 600) return "short series manageable";
    return "long series commitment";
  }
  if (runtime <= 95) return "short quick low-commitment";
  if (runtime <= 125) return "easy normal length";
  return "long movie";
}

function contentRatingTerms(contentRating: string | undefined) {
  const rating = contentRating?.toUpperCase();
  if (!rating) return "";
  if (["G", "PG", "TV-G", "TV-PG"].includes(rating)) return "family friendly gentle shared-screen low-friction";
  if (["PG-13", "TV-14"].includes(rating)) return "shared-screen group-friendly moderate-friction";
  if (["R", "NC-17", "TV-MA"].includes(rating)) return "mature intense high-friction";
  return "";
}

function availabilityTerms(group: AvailabilityGroup) {
  if (group === "available_in_plex") return "available in plex local ready";
  if (group === "not_in_plex_requestable") return "requestable seerr unavailable plex";
  if (group === "already_requested") return "already requested seerr pending";
  if (group === "partially_available") return "partial availability plex seerr";
  return "unavailable";
}

function isSharedScreenFriendly(item: ItemDetail) {
  const rating = item.contentRating?.toUpperCase();
  if (!rating) return false;
  return ["G", "PG", "PG-13", "TV-G", "TV-PG", "TV-14"].includes(rating);
}

function isHighFriction(item: ItemDetail) {
  const rating = item.contentRating?.toUpperCase();
  if (rating && ["R", "NC-17", "TV-MA"].includes(rating)) return true;
  if (item.mediaType === "movie" && (item.runtimeMinutes ?? 0) > 150) return true;
  if (item.mediaType === "tv" && (item.runtimeMinutes ?? 0) > 900) return true;
  const genres = item.genres.map((genre) => genre.toLowerCase());
  return genres.some((genre) => ["horror", "war"].includes(genre));
}

function inferPhraseMoodTerms(text: string) {
  const normalized = text.toLowerCase();
  const terms: string[] = [];
  if (/\b(?:friendship|kindness|heartwarming|uplifting|comfort)\b/.test(normalized)) terms.push("feel-good");
  if (/\b(?:surreal|strange|bizarre|offbeat|quirky)\b/.test(normalized)) terms.push("weird");
  if (/\b(?:mystery|riddle|puzzle|twist|investigation)\b/.test(normalized)) terms.push("clever");
  if (/\b(?:quest|adventure|journey|kingdom|magic|witch|myth)\b/.test(normalized)) terms.push("magical");
  if (/\b(?:love|romance|wedding|date)\b/.test(normalized)) terms.push("romantic");
  return terms;
}

function tokenizeFeatureText(value: string) {
  return tokenize(value)
    .map((term) => term.replace(/^science-fiction$/, "sci-fi"))
    .filter((term) => !stopTerms.has(term));
}

function normalizeVector(vector: Record<string, number>) {
  const magnitude = Math.sqrt(Object.values(vector).reduce((sum, value) => sum + value * value, 0));
  if (!magnitude) return vector;
  return Object.fromEntries(Object.entries(vector).map(([term, value]) => [term, Number((value / magnitude).toFixed(6))]));
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
