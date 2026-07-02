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
  "dark-comedy": ["microgenre:dark comedy", "microgenre:dark-comedy", "tone:dry"],
  dry: ["tone:dry"],
  easy: ["watch:low-commitment", "watch:background-friendly", "watch:easy-watch"],
  "easy-watch": ["watch:easy-watch", "watch:low-commitment"],
  emotional: ["mood:emotional", "tone:sincere"],
  family: ["theme:family", "watch:group-friendly", "watch:shared-screen"],
  fantasy: ["mood:magical", "tone:whimsical"],
  feelgood: ["mood:feel-good", "mood:warm"],
  "feel-good": ["mood:feel-good", "mood:warm"],
  "found-family": ["theme:found-family", "mood:warm"],
  french: ["style:language-french", "setting:country-france"],
  funny: ["mood:funny", "tone:light"],
  gentle: ["mood:gentle", "mood:warm", "intensity:gentle", "tone:quiet"],
  grounded: ["tone:grounded"],
  "high-friction": ["watch:high-friction"],
  investigation: ["theme:investigation", "tone:clever", "tone:suspenseful"],
  "late-night": ["watch:late-night"],
  light: ["tone:light", "watch:low-commitment", "watch:easy-watch"],
  magical: ["mood:magical", "tone:whimsical"],
  mainstream: ["watch:mainstream-friendly", "watch:recognizable"],
  mystery: ["tone:suspenseful", "tone:clever"],
  nostalgia: ["mood:nostalgic", "theme:nostalgia"],
  nostalgic: ["mood:nostalgic", "theme:nostalgia"],
  offbeat: ["mood:weird", "tone:offbeat"],
  paris: ["setting:paris"],
  romance: ["mood:romantic"],
  romantic: ["mood:romantic"],
  "road-trip": ["theme:road-trip", "mood:adventurous"],
  screenwriter: ["style:writerly", "style:dialogue-driven"],
  short: ["watch:low-commitment"],
  sincere: ["tone:sincere", "mood:emotional"],
  "slow-burn": ["pacing:slow-burn", "watch:attention-heavy"],
  "small-town": ["setting:small-town", "setting:rural"],
  suspenseful: ["tone:suspenseful"],
  survival: ["theme:survival", "intensity:tense"],
  intense: ["mood:intense", "watch:high-friction"],
  tense: ["tone:suspenseful", "mood:intense"],
  thriller: ["tone:suspenseful", "mood:intense"],
  twenties: ["era:1920s", "theme:nostalgia"],
  warm: ["mood:warm", "mood:feel-good"],
  "well-liked": ["watch:well-liked"],
  weird: ["mood:weird", "tone:offbeat"],
  witty: ["tone:clever", "tone:witty", "mood:funny"],
  writer: ["style:writerly", "style:dialogue-driven"],
  "1920s": ["era:1920s", "theme:nostalgia"]
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
    /\b(?:easy[-\s]?watch|easygoing|breezy|lighthearted)\b/i.test(brief.query) ? "watch:easy-watch" : "",
    /\b(?:background|while doing chores|half[-\s]?watch)\b/i.test(brief.query) ? "watch:background-friendly" : "",
    /\b(?:cozy|comfort|gentle|warm)\b/i.test(brief.query) ? "mood:cozy" : "",
    /\bsmall[-\s]?town\b/i.test(brief.query) ? "setting:small-town" : "",
    /\b(?:found|chosen)\s+family\b/i.test(brief.query) ? "theme:found-family" : "",
    /\bfamily\b/i.test(brief.query) ? "theme:family" : "",
    /\broad[-\s]?trip\b/i.test(brief.query) ? "theme:road-trip" : "",
    /\bsurviv(?:al|e|es|ing)\b/i.test(brief.query) ? "theme:survival" : "",
    /\binvestigat(?:ion|e|es|ing)\b|\bdetective\b/i.test(brief.query) ? "theme:investigation" : "",
    /\b(?:well[-\s]?liked|highly[-\s]?rated|good ratings)\b/i.test(brief.query) ? "watch:well-liked" : "",
    /\b(?:mainstream|popular|recognizable|well[-\s]?known)\b/i.test(brief.query) ? "watch:mainstream-friendly" : "",
    /\bfrench(?:[-\s]?language)?\b/i.test(brief.query) ? "style:language-french" : "",
    /\bfrance\b/i.test(brief.query) ? "setting:country-france" : "",
    /\b(?:franchise|familiar world|series entry)\b/i.test(brief.query) ? "watch:familiar-world" : "",
    /\b(?:weird|offbeat|strange|quirky)\b/i.test(brief.query) ? "mood:weird" : "",
    /\b(?:grounded|realistic|real life|true story)\b/i.test(brief.query) ? "tone:grounded" : "",
    /\b(?:sincere|tender|emotional|moving)\b/i.test(brief.query) ? "tone:sincere" : "",
    /\b(?:bleak|grim)\b/i.test(brief.query) ? "tone:bleak" : "",
    /\b(?:dry|deadpan)\b/i.test(brief.query) ? "tone:dry" : "",
    /\b(?:whimsical|playful)\b/i.test(brief.query) ? "tone:whimsical" : "",
    /\b(?:attention[-\s]?heavy|dense|slow[-\s]?burn|complex)\b/i.test(brief.query) ? "watch:attention-heavy" : "",
    /\bslow[-\s]?burn\b/i.test(brief.query) ? "pacing:slow-burn" : "",
    /\b(?:dark|intense|tense|thriller|suspense)\b/i.test(brief.query) ? "tone:suspenseful" : "",
    /\b(?:dark|intense)\b/i.test(brief.query) ? "mood:intense" : "",
    /\b(?:romance|romantic|date)\b/i.test(brief.query) ? "mood:romantic" : "",
    /\bnostalg(?:ia|ic)\b/i.test(brief.query) ? "mood:nostalgic" : "",
    /\bnostalg(?:ia|ic)\b/i.test(brief.query) ? "theme:nostalgia" : "",
    /\btime[-\s]?travel\b|\bgo(?:es|ing)? back\b|\bback to the \d{4}s\b/i.test(brief.query) ? "theme:time-travel" : "",
    /\btime[-\s]?travel\b.*\bromance\b|\bromance\b.*\btime[-\s]?travel\b/i.test(brief.query) ? "microgenre:time-travel-romance" : "",
    /\bparis\b/i.test(brief.query) ? "setting:paris" : "",
    /\b1920s\b|\bnineteen twenties\b/i.test(brief.query) ? "era:1920s" : "",
    /\b(?:screenwriter|writer|dialogue[-\s]?driven)\b/i.test(brief.query) ? "style:dialogue-driven" : "",
    /\bdark\s+comedy\b/i.test(brief.query) ? "microgenre:dark comedy" : "",
    /\bdark\s+comedy\b/i.test(brief.query) ? "microgenre:dark-comedy" : "",
    /\bcozy\s+mystery\b/i.test(brief.query) ? "microgenre:cozy mystery" : "",
    /\bcozy\s+mystery\b/i.test(brief.query) ? "microgenre:cozy-mystery" : "",
    /\bgentle\s+sci[-\s]?fi\b/i.test(brief.query) ? "microgenre:gentle sci-fi" : ""
  ];
  return unique(keys.map(normalizeMoodFeatureKey));
}

export function normalizeMoodFeatureKey(value: string) {
  const [maybeNamespace, ...rest] = value.split(":");
  const namespace = rest.length ? normalizeFeatureNamespace(maybeNamespace) : "tag";
  const term = normalizeFeatureTerm(rest.length ? rest.join(":") : maybeNamespace);
  return namespace && term ? `${namespace}:${term}` : "";
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

function normalizeFeatureNamespace(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/_/g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
