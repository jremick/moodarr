import type { AvailabilityGroup, ItemDetail } from "../../shared/types";
import { tokenize } from "./intent";

export const FEATURE_VERSION = "features-v1";

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
  action: ["energetic", "big", "high-stakes"],
  adventure: ["journey", "quest", "breezy", "exciting"],
  animation: ["animated", "stylized", "imaginative"],
  comedy: ["funny", "light", "witty", "jokes"],
  documentary: ["real", "informative", "grounded"],
  drama: ["emotional", "character", "serious"],
  family: ["warm", "gentle", "shared-screen", "comfort"],
  fantasy: ["magic", "magical", "whimsical", "mythic"],
  horror: ["scary", "dark", "tense"],
  mystery: ["puzzle", "clever", "intrigue"],
  romance: ["romantic", "heart", "warm"],
  "science fiction": ["sci-fi", "speculative", "future"],
  thriller: ["tense", "suspense", "propulsive"]
};

const cueTerms: Record<string, string[]> = {
  "feel-good": ["feel-good", "warm", "kind", "gentle", "heart", "friendship", "comfort", "cozy"],
  funny: ["funny", "comedy", "jokes", "witty", "farce", "sitcom", "absurdity"],
  magical: ["fantasy", "magic", "magical", "witch", "powers", "myth", "whimsical"],
  cozy: ["cozy", "comfort", "gentle", "small town", "countryside", "autumn"],
  clever: ["clever", "smart", "witty", "satire", "mystery", "puzzle"],
  weird: ["weird", "surreal", "offbeat", "quirky", "strange"],
  intense: ["tense", "dark", "violent", "horror", "thriller", "gritty"],
  "low-commitment": ["short", "miniseries", "limited", "quick", "breezy", "easy"]
};

const stopTerms = new Set(["movie", "show", "series", "episode", "season", "watch", "available", "requestable"]);

export function buildMediaFeatureDocument(item: ItemDetail): MediaFeatureDocument {
  const genreTerms = item.genres.flatMap((genre) => [genre, ...(genreExpansions[genre.toLowerCase()] ?? [])]);
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
    runtimeTerms(item.runtimeMinutes, item.mediaType)
  ].join(" ");

  const moodTerms = inferCueTerms(baseText, ["feel-good", "funny", "magical", "cozy", "weird"]);
  const toneTerms = inferCueTerms(baseText, ["clever", "intense"]);
  const watchabilityTerms = [
    ...inferCueTerms(baseText, ["low-commitment"]),
    ...(isSharedScreenFriendly(item) ? ["shared-screen"] : []),
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
