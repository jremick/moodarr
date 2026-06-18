import type { ItemDetail, WatchContext } from "../../shared/types";
import { tokenize } from "./intent";

export interface FeelProfileTermCalibration {
  term: string;
  featureWeights: Record<string, number>;
  confidence: number;
  evidenceCount: number;
  positiveWeight?: number;
  negativeWeight?: number;
  effectiveEvidence?: number;
  conflictScore?: number;
}

export interface FeelProfile {
  id: string;
  label: string;
  watchContext: WatchContext;
  terms: FeelProfileTermCalibration[];
}

export interface FeelProfileAdjustment {
  matchedTerms: string[];
  weights: Map<string, number>;
  confidence: number;
  evidenceCount: number;
  effectiveEvidence: number;
  conflictScore: number;
}

export interface FeelProfileFeatureSignal {
  moodTerms: string[];
  toneTerms: string[];
  watchabilityTerms: string[];
}

export const syntheticFeelProfiles = {
  cozyWittyLowStakes: {
    id: "synthetic:cozy-witty-low-stakes",
    label: "Cozy means witty, warm, low-stakes comedy",
    watchContext: "solo",
    terms: [
      {
        term: "cozy",
        confidence: 0.9,
        evidenceCount: 24,
        featureWeights: {
          "genre:comedy": 2.4,
          "genre:family": 1.5,
          "mood:feel good": 2.2,
          "mood:cozy": 2,
          "mood:funny": 1.7,
          "tone:clever": 1.2,
          "watch:low commitment": 1.4,
          "genre:fantasy": -1.6,
          "genre:romance": -0.6,
          "watch:high friction": -2.2,
          "rating:tv ma": -1.8,
          "genre:horror": -3
        }
      }
    ]
  } satisfies FeelProfile,
  cozyFantasyAdventure: {
    id: "synthetic:cozy-fantasy-adventure",
    label: "Cozy means magical adventure comfort",
    watchContext: "solo",
    terms: [
      {
        term: "cozy",
        confidence: 0.9,
        evidenceCount: 24,
        featureWeights: {
          "genre:fantasy": 2.8,
          "genre:adventure": 2.4,
          "genre:romance": 1.3,
          "mood:magical": 2.2,
          "mood:cozy": 1.8,
          "tone:clever": 0.8,
          "watch:group friendly": 1,
          "runtime:long movie": -1.1,
          "genre:horror": -3,
          "watch:high friction": -2
        }
      }
    ]
  } satisfies FeelProfile,
  darkPsychologicalTension: {
    id: "synthetic:dark-psychological-tension",
    label: "Dark means grounded psychological tension",
    watchContext: "solo",
    terms: [
      {
        term: "dark",
        confidence: 0.9,
        evidenceCount: 26,
        featureWeights: {
          "genre:thriller": 2.6,
          "genre:mystery": 2.2,
          "genre:drama": 1.4,
          "tone:suspenseful": 2.5,
          "tone:grounded": 1.8,
          "mood:intense": 1.1,
          "watch:late night": 0.9,
          "genre:horror": -2.4,
          "watch:high friction": -1.7,
          "rating:r": -0.8,
          "rating:tv ma": -1.5,
          "genre:comedy": -1.4,
          "genre:family": -2.4
        }
      }
    ]
  } satisfies FeelProfile,
  darkHorrorIntensity: {
    id: "synthetic:dark-horror-intensity",
    label: "Dark means scary, intense horror",
    watchContext: "solo",
    terms: [
      {
        term: "dark",
        confidence: 0.9,
        evidenceCount: 26,
        featureWeights: {
          "genre:horror": 3,
          "genre:thriller": 1.8,
          "mood:intense": 2.5,
          "tone:suspenseful": 1.7,
          "watch:high friction": 2.1,
          "rating:r": 1,
          "rating:tv ma": 1.2,
          "genre:drama": -1.1,
          "tone:grounded": -0.7,
          "genre:family": -3,
          "watch:low commitment": -1.4
        }
      }
    ]
  } satisfies FeelProfile,
  weirdPlayfulOffbeat: {
    id: "synthetic:weird-playful-offbeat",
    label: "Weird means playful, offbeat comedy",
    watchContext: "solo",
    terms: [
      {
        term: "weird",
        confidence: 0.9,
        evidenceCount: 22,
        featureWeights: {
          "genre:comedy": 2.8,
          "genre:fantasy": 1.5,
          "mood:weird": 2,
          "mood:funny": 2.1,
          "tone:clever": 1.2,
          "watch:low commitment": 1.1,
          "watch:background friendly": 0.8,
          "genre:drama": -1.8,
          "genre:horror": -2.8,
          "watch:attention heavy": -1.6,
          "watch:high friction": -2.1
        }
      }
    ]
  } satisfies FeelProfile,
  weirdArthouseAlienating: {
    id: "synthetic:weird-arthouse-alienating",
    label: "Weird means surreal, demanding, alienating",
    watchContext: "solo",
    terms: [
      {
        term: "weird",
        confidence: 0.9,
        evidenceCount: 22,
        featureWeights: {
          "genre:drama": 2.3,
          "genre:science fiction": 1.9,
          "genre:horror": 1.2,
          "mood:weird": 2.4,
          "mood:late night": 1.3,
          "tone:intense": 1.1,
          "watch:attention heavy": 2.4,
          "watch:high friction": 1.4,
          "genre:comedy": -2.6,
          "genre:family": -3,
          "watch:background friendly": -2,
          "watch:low commitment": -2.1
        }
      }
    ]
  } satisfies FeelProfile,
  lightLowAttention: {
    id: "synthetic:light-low-attention",
    label: "Light means easy, short, background-friendly",
    watchContext: "solo",
    terms: [
      {
        term: "light",
        confidence: 0.9,
        evidenceCount: 20,
        featureWeights: {
          "genre:comedy": 2.4,
          "genre:family": 1.6,
          "mood:funny": 1.8,
          "mood:feel good": 1.5,
          "watch:low commitment": 2.5,
          "watch:background friendly": 2.1,
          "runtime:short movie": 1.8,
          "runtime:short series": 1.6,
          "genre:drama": -1.5,
          "genre:horror": -3,
          "watch:attention heavy": -2.4,
          "watch:high friction": -2.2,
          "runtime:long movie": -1.9
        }
      }
    ]
  } satisfies FeelProfile,
  lightEmotionallyGentle: {
    id: "synthetic:light-emotionally-gentle",
    label: "Light means emotionally gentle and warm",
    watchContext: "solo",
    terms: [
      {
        term: "light",
        confidence: 0.9,
        evidenceCount: 20,
        featureWeights: {
          "genre:romance": 2.2,
          "genre:drama": 1.4,
          "genre:family": 1.5,
          "mood:feel good": 2.4,
          "mood:romantic": 1.6,
          "tone:grounded": 0.8,
          "watch:group friendly": 1,
          "watch:shared screen": 1,
          "genre:horror": -3,
          "mood:intense": -2.1,
          "tone:suspenseful": -2.4,
          "watch:high friction": -2.5,
          "rating:r": -1.5,
          "rating:tv ma": -1.8
        }
      }
    ]
  } satisfies FeelProfile
};

export function buildFeelProfileAdjustment(profile: FeelProfile | undefined, query: string): FeelProfileAdjustment | undefined {
  if (!profile) return undefined;
  const matched = profile.terms.filter((term) => queryMatchesTerm(query, term.term));
  if (matched.length === 0) return undefined;

  const weights = new Map<string, number>();
  let confidenceTotal = 0;
  let evidenceCount = 0;
  let effectiveEvidence = 0;
  let conflictTotal = 0;
  for (const term of matched) {
    const influence = termInfluenceScale(term);
    confidenceTotal += influence;
    evidenceCount += Math.max(0, Math.floor(term.evidenceCount));
    effectiveEvidence += termEffectiveEvidence(term);
    conflictTotal += termConflictScore(term);
    for (const [feature, weight] of Object.entries(term.featureWeights)) {
      const key = normalizeFeatureKey(feature);
      if (!key) continue;
      weights.set(key, clampWeight((weights.get(key) ?? 0) + weight * influence));
    }
  }

  return {
    matchedTerms: matched.map((term) => normalizeTerm(term.term)),
    weights,
    confidence: confidenceTotal / matched.length,
    evidenceCount,
    effectiveEvidence: Number(effectiveEvidence.toFixed(3)),
    conflictScore: Number((conflictTotal / matched.length).toFixed(3))
  };
}

export function scoreFeelProfileFit(
  item: ItemDetail,
  feature: FeelProfileFeatureSignal | undefined,
  adjustment: FeelProfileAdjustment | undefined
) {
  if (!adjustment || adjustment.weights.size === 0) return undefined;
  const keys = itemProfileFeatureKeys(item, feature);
  const weightedFit = keys.reduce((sum, key) => sum + (adjustment.weights.get(key) ?? 0), 0);
  return clampScore(50 + weightedFit * 5);
}

export function itemProfileFeatureKeys(item: ItemDetail, feature: FeelProfileFeatureSignal | undefined) {
  return unique([
    `media:${item.mediaType}`,
    ...item.genres.map((genre) => `genre:${normalizeLooseKey(genre)}`),
    ...(feature?.moodTerms ?? []).map((term) => `mood:${normalizeLooseKey(term)}`),
    ...(feature?.toneTerms ?? []).map((term) => `tone:${normalizeLooseKey(term)}`),
    ...(feature?.watchabilityTerms ?? []).map((term) => `watch:${normalizeLooseKey(term)}`),
    runtimeProfileFeature(item.runtimeMinutes, item.mediaType),
    ratingProfileFeature(item.contentRating)
  ].filter((key): key is string => Boolean(key)));
}

function queryMatchesTerm(query: string, term: string) {
  const normalizedTerm = normalizeTerm(term);
  const normalizedQuery = normalizeTerm(query);
  if (!normalizedTerm || !normalizedQuery) return false;
  if (normalizedQuery.includes(normalizedTerm)) return true;
  return tokenize(query).some((token) => normalizeTerm(token) === normalizedTerm);
}

function runtimeProfileFeature(runtime: number | undefined, mediaType: ItemDetail["mediaType"]) {
  if (!runtime) return undefined;
  if (mediaType === "tv") return runtime <= 600 ? "runtime:short series" : "runtime:long series";
  if (runtime <= 95) return "runtime:short movie";
  if (runtime <= 125) return "runtime:normal movie";
  return "runtime:long movie";
}

function ratingProfileFeature(contentRating: string | undefined) {
  return contentRating ? `rating:${normalizeLooseKey(contentRating)}` : undefined;
}

function normalizeFeatureKey(feature: string) {
  const [namespace, ...rest] = feature.split(":");
  const value = rest.join(":");
  if (!namespace || !value) return "";
  return `${normalizeLooseKey(namespace)}:${normalizeLooseKey(value)}`;
}

function normalizeLooseKey(value: string) {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizeTerm(value: string) {
  return normalizeLooseKey(value);
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function termInfluenceScale(term: FeelProfileTermCalibration) {
  const confidence = clamp01(term.confidence);
  const evidenceScale = 1 - Math.exp(-termEffectiveEvidence(term) / 4);
  const conflictScale = 1 - termConflictScore(term) * 0.65;
  return clamp01(confidence * evidenceScale * conflictScale);
}

function termEffectiveEvidence(term: FeelProfileTermCalibration) {
  if (typeof term.effectiveEvidence === "number" && Number.isFinite(term.effectiveEvidence)) return Math.max(0, term.effectiveEvidence);
  return Math.max(0, term.evidenceCount);
}

function termConflictScore(term: FeelProfileTermCalibration) {
  if (typeof term.conflictScore === "number" && Number.isFinite(term.conflictScore)) return clamp01(term.conflictScore);
  const positive = Math.max(0, term.positiveWeight ?? 0);
  const negative = Math.max(0, term.negativeWeight ?? 0);
  const total = positive + negative;
  return total > 0 ? clamp01((2 * Math.min(positive, negative)) / total) : 0;
}

function clampWeight(value: number) {
  return Number(Math.max(-6, Math.min(6, value)).toFixed(3));
}

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}
