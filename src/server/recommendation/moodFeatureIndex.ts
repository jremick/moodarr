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
  easy: ["watch:low-commitment", "watch:background-friendly"],
  fantasy: ["mood:magical", "tone:whimsical"],
  feelgood: ["mood:feel-good", "mood:warm"],
  "feel-good": ["mood:feel-good", "mood:warm"],
  funny: ["mood:funny", "tone:light"],
  gentle: ["mood:gentle", "mood:warm"],
  light: ["tone:light", "watch:low-commitment"],
  magical: ["mood:magical", "tone:whimsical"],
  mystery: ["tone:suspenseful", "tone:clever"],
  romance: ["mood:romantic"],
  romantic: ["mood:romantic"],
  short: ["watch:low-commitment"],
  suspenseful: ["tone:suspenseful"],
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
    /\b(?:cozy|comfort|gentle|warm)\b/i.test(brief.query) ? "mood:cozy" : "",
    /\b(?:weird|offbeat|strange|quirky)\b/i.test(brief.query) ? "mood:weird" : "",
    /\b(?:tense|thriller|suspense)\b/i.test(brief.query) ? "tone:suspenseful" : "",
    /\b(?:romance|romantic|date)\b/i.test(brief.query) ? "mood:romantic" : ""
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
