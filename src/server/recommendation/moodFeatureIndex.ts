import type { RecommendationBrief } from "./brief";
import { tokenize } from "./intent";
import { createQueryCueMatcher } from "./queryCuePolarity";

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
  documentary: ["tone:grounded", "watch:real-world"],
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
  legal: ["theme:law", "theme:investigation", "tone:clever"],
  light: ["tone:light", "watch:low-commitment", "watch:easy-watch"],
  magical: ["mood:magical", "tone:whimsical"],
  mainstream: ["watch:mainstream-friendly", "watch:recognizable"],
  mystery: ["tone:suspenseful", "tone:clever"],
  music: ["theme:music", "mood:expressive"],
  musical: ["theme:music", "mood:expressive"],
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
  sport: ["theme:sports", "watch:group-friendly"],
  sports: ["theme:sports", "watch:group-friendly"],
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
  documentary: ["tone:grounded", "watch:real-world"],
  drama: ["mood:emotional"],
  family: ["mood:warm", "watch:group-friendly", "watch:shared-screen"],
  fantasy: ["mood:magical", "tone:whimsical"],
  horror: ["mood:intense", "watch:high-friction"],
  music: ["theme:music", "mood:expressive"],
  musical: ["theme:music", "mood:expressive"],
  mystery: ["tone:clever", "tone:suspenseful"],
  romance: ["mood:romantic"],
  sports: ["theme:sports", "watch:group-friendly"],
  thriller: ["tone:suspenseful", "mood:intense"]
};

export function moodFeatureKeysForBrief(brief: RecommendationBrief) {
  const cues = createQueryCueMatcher(brief.query);
  const excludedGenres = new Set((brief.hardFilters.excludedGenres ?? []).map(normalizeFeatureTerm));
  const keys = [
    ...brief.softSignals.moods.filter(cues.allows).map((mood) => `mood:${mood}`),
    ...brief.softSignals.genres
      .filter((genre) => !excludedGenres.has(normalizeFeatureTerm(genre)) && cues.allows(genre))
      .flatMap((genre) => genreFeatureExpansions[normalizeFeatureTerm(genre)] ?? []),
    ...brief.softSignals.terms.filter(cues.allows).flatMap((term) => queryFeatureExpansions[normalizeFeatureTerm(term)] ?? []),
    brief.watchContext === "group" ? "watch:group-friendly" : "",
    brief.watchContext === "group" ? "watch:shared-screen" : "",
    cues.has(/\b(?:short|quick|easy|low[-\s]?commitment|tired)\b/i) ? "watch:low-commitment" : "",
    cues.has(/\b(?:easy[-\s]?watch|easygoing|breezy|lighthearted)\b/i) ? "watch:easy-watch" : "",
    cues.has(/\b(?:background|while doing chores|half[-\s]?watch)\b/i) ? "watch:background-friendly" : "",
    cues.has(/\b(?:cozy|comfort|gentle|warm)\b/i) ? "mood:cozy" : "",
    cues.has(/\bsmall[-\s]?town\b/i) ? "setting:small-town" : "",
    cues.has(/\b(?:found|chosen)\s+family\b/i) ? "theme:found-family" : "",
    cues.has(/\bfamily\b/i) ? "theme:family" : "",
    cues.has(/\broad[-\s]?trip\b/i) ? "theme:road-trip" : "",
    cues.has(/\bsurviv(?:al|e|es|ing)\b/i) ? "theme:survival" : "",
    cues.has(/\binvestigat(?:ion|e|es|ing)\b|\bdetective\b/i) ? "theme:investigation" : "",
    cues.has(/\b(?:legal|courtroom|court|trial|lawyer|attorney|judge|jury)\b/i) ? "theme:law" : "",
    cues.has(/\b(?:sports?|football|baseball|basketball|soccer|boxing|athlete|coach|team)\b/i) ? "theme:sports" : "",
    cues.has(/\b(?:music|musical|songs?|band|singer|songwriter|recording|studio)\b/i) ? "theme:music" : "",
    cues.has(/\b(?:documentary|documentaries|docs?|nonfiction|non-fiction)\b/i) ? "watch:real-world" : "",
    cues.has(/\b(?:well[-\s]?liked|highly[-\s]?rated|good ratings)\b/i) ? "watch:well-liked" : "",
    cues.has(/\b(?:mainstream|popular|recognizable|well[-\s]?known)\b/i) ? "watch:mainstream-friendly" : "",
    cues.has(/\bfrench(?:[-\s]?language)?\b/i) ? "style:language-french" : "",
    cues.has(/\bfrance\b/i) ? "setting:country-france" : "",
    cues.has(/\b(?:franchise|familiar world|series entry)\b/i) ? "watch:familiar-world" : "",
    cues.has(/\b(?:weird|offbeat|strange|quirky)\b/i) ? "mood:weird" : "",
    cues.has(/\b(?:grounded|realistic|real life|true story)\b/i) ? "tone:grounded" : "",
    cues.has(/\b(?:sincere|tender|emotional|moving)\b/i) ? "tone:sincere" : "",
    cues.has(/\b(?:bleak|grim)\b/i) ? "tone:bleak" : "",
    cues.has(/\b(?:dry|deadpan)\b/i) ? "tone:dry" : "",
    cues.has(/\b(?:whimsical|playful)\b/i) ? "tone:whimsical" : "",
    cues.has(/\b(?:attention[-\s]?heavy|dense|slow[-\s]?burn|complex)\b/i) ? "watch:attention-heavy" : "",
    cues.has(/\bslow[-\s]?burn\b/i) ? "pacing:slow-burn" : "",
    cues.has(/\b(?:dark|intense|tense|thriller|suspense)\b/i) ? "tone:suspenseful" : "",
    cues.has(/\b(?:dark|intense)\b/i) ? "mood:intense" : "",
    cues.has(/\b(?:romance|romantic|date)\b/i) ? "mood:romantic" : "",
    cues.has(/\bnostalg(?:ia|ic)\b/i) ? "mood:nostalgic" : "",
    cues.has(/\bnostalg(?:ia|ic)\b/i) ? "theme:nostalgia" : "",
    cues.has(/\btime[-\s]?travel\b|\bgo(?:es|ing)? back\b|\bback to the \d{4}s\b/i) ? "theme:time-travel" : "",
    (cues.has(/\btime[-\s]?travel\b/i) && cues.has(/\bromance\b/i)) ? "microgenre:time-travel-romance" : "",
    cues.has(/\bparis\b/i) ? "setting:paris" : "",
    cues.has(/\b1920s\b|\bnineteen twenties\b/i) ? "era:1920s" : "",
    cues.has(/\b(?:screenwriter|writer|dialogue[-\s]?driven)\b/i) ? "style:dialogue-driven" : "",
    cues.has(/\bdark\s+comedy\b/i) ? "microgenre:dark comedy" : "",
    cues.has(/\bdark\s+comedy\b/i) ? "microgenre:dark-comedy" : "",
    cues.has(/\bcozy\s+mystery\b/i) ? "microgenre:cozy mystery" : "",
    cues.has(/\bcozy\s+mystery\b/i) ? "microgenre:cozy-mystery" : "",
    cues.has(/\bgentle\s+sci[-\s]?fi\b/i) ? "microgenre:gentle sci-fi" : ""
  ];
  // A directly avoided quality cannot be reintroduced by another term's
  // expansion (for example, cozy must not override "not feel-good").
  return unique(keys.map(normalizeMoodFeatureKey)).filter((key) => cues.allows(key.slice(key.indexOf(":") + 1)));
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
