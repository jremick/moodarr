import type { RecommendationBrief } from "./brief";
import { tokenize } from "./intent";

export interface MoodFeatureScoreInput {
  feature: string;
  score: number;
  confidence?: number;
}

const queryFeatureExpansions: Record<string, string[]> = {
  adventure: ["mood:adventurous", "tone:breezy"],
  comedy: ["mood:funny", "tone:light", "watch:background-friendly"],
  cozy: ["mood:cozy", "mood:feel-good", "watch:low-commitment"],
  dark: ["mood:intense", "tone:suspenseful", "watch:late-night"],
  dry: ["tone:dry"],
  easy: ["watch:low-commitment", "watch:background-friendly"],
  emotional: ["mood:emotional", "tone:sincere"],
  fantasy: ["mood:magical", "tone:whimsical"],
  feelgood: ["mood:feel-good", "mood:warm"],
  "feel-good": ["mood:feel-good", "mood:warm"],
  funny: ["mood:funny", "tone:light"],
  gentle: ["mood:gentle", "mood:warm"],
  grounded: ["tone:grounded"],
  "high-friction": ["watch:high-friction"],
  "late-night": ["watch:late-night"],
  light: ["tone:light", "watch:low-commitment"],
  magical: ["mood:magical", "tone:whimsical"],
  mystery: ["tone:suspenseful", "tone:clever"],
  offbeat: ["mood:weird", "tone:offbeat"],
  romance: ["mood:romantic"],
  romantic: ["mood:romantic"],
  short: ["watch:low-commitment"],
  sincere: ["tone:sincere", "mood:emotional"],
  suspenseful: ["tone:suspenseful"],
  intense: ["mood:intense", "watch:high-friction"],
  tense: ["tone:suspenseful", "mood:intense"],
  thriller: ["tone:suspenseful", "mood:intense"],
  warm: ["mood:warm", "mood:feel-good"],
  weird: ["mood:weird", "tone:offbeat"],
  witty: ["tone:clever", "mood:funny"]
};

const genreFeatureExpansions: Record<string, string[]> = {
  adventure: ["mood:adventurous", "tone:breezy"],
  animation: ["watch:family-friendly"],
  comedy: ["mood:funny", "tone:light"],
  drama: ["mood:emotional"],
  family: ["mood:warm", "watch:group-friendly", "watch:shared-screen"],
  fantasy: ["mood:magical", "tone:whimsical"],
  horror: ["mood:intense", "watch:high-friction"],
  mystery: ["tone:clever", "tone:suspenseful"],
  romance: ["mood:romantic"],
  thriller: ["tone:suspenseful", "mood:intense"]
};

export function moodFeatureKeysForBrief(brief: RecommendationBrief) {
  const keys = [
    ...brief.softSignals.moods.map((mood) => `mood:${mood}`),
    ...brief.softSignals.genres.flatMap((genre) => genreFeatureExpansions[normalizeFeatureTerm(genre)] ?? []),
    ...brief.softSignals.terms.flatMap((term) => queryFeatureExpansions[normalizeFeatureTerm(term)] ?? []),
    brief.watchContext === "group" ? "watch:group-friendly" : "",
    brief.watchContext === "group" ? "watch:shared-screen" : "",
    /\b(?:short|quick|easy|low[-\s]?commitment|tired)\b/i.test(brief.query) ? "watch:low-commitment" : "",
    /\b(?:background|while doing chores|half[-\s]?watch)\b/i.test(brief.query) ? "watch:background-friendly" : "",
    /\b(?:cozy|comfort|gentle|warm)\b/i.test(brief.query) ? "mood:cozy" : "",
    /\b(?:weird|offbeat|strange|quirky)\b/i.test(brief.query) ? "mood:weird" : "",
    /\b(?:grounded|realistic|real life|true story)\b/i.test(brief.query) ? "tone:grounded" : "",
    /\b(?:sincere|tender|emotional|moving)\b/i.test(brief.query) ? "tone:sincere" : "",
    /\b(?:bleak|grim)\b/i.test(brief.query) ? "tone:bleak" : "",
    /\b(?:dry|deadpan)\b/i.test(brief.query) ? "tone:dry" : "",
    /\b(?:whimsical|playful)\b/i.test(brief.query) ? "tone:whimsical" : "",
    /\b(?:attention[-\s]?heavy|dense|slow[-\s]?burn)\b/i.test(brief.query) ? "watch:attention-heavy" : "",
    /\b(?:dark|intense|tense|thriller|suspense)\b/i.test(brief.query) ? "tone:suspenseful" : "",
    /\b(?:dark|intense)\b/i.test(brief.query) ? "mood:intense" : "",
    /\b(?:romance|romantic|date)\b/i.test(brief.query) ? "mood:romantic" : "",
    /\bdark\s+comedy\b/i.test(brief.query) ? "microgenre:dark comedy" : "",
    /\bcozy\s+mystery\b/i.test(brief.query) ? "microgenre:cozy mystery" : "",
    /\bgentle\s+sci[-\s]?fi\b/i.test(brief.query) ? "microgenre:gentle sci-fi" : ""
  ];
  return unique(keys.map(normalizeMoodFeatureKey));
}

export function normalizeMoodFeatureKey(value: string) {
  const [maybeNamespace, ...rest] = value.split(":");
  const namespace = rest.length ? normalizeFeatureTerm(maybeNamespace) : "tag";
  const term = normalizeFeatureTerm(rest.length ? rest.join(":") : maybeNamespace);
  return term ? `${namespace}:${term}` : "";
}

export function deterministicMoodFeatureScores(input: { moodTerms: string[]; toneTerms: string[]; watchabilityTerms: string[] }): MoodFeatureScoreInput[] {
  return [
    ...input.moodTerms.map((term) => ({ feature: `mood:${term}`, score: 86, confidence: 0.74 })),
    ...input.toneTerms.map((term) => ({ feature: `tone:${term}`, score: 78, confidence: 0.7 })),
    ...input.watchabilityTerms.map((term) => ({ feature: `watch:${term}`, score: 74, confidence: 0.68 }))
  ];
}

export function moodFeatureScoreFromAggregate(aggregateScore: number, matchedFeatureCount: number) {
  return clampScore(50 + aggregateScore / Math.max(1.25, matchedFeatureCount * 1.25));
}

export function normalizeMoodSeedScore(value: number) {
  return clampScore(value <= 1 ? value * 100 : value);
}

function normalizeFeatureTerm(value: string) {
  return tokenize(value.replace(/_/g, " ")).join(" ");
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
