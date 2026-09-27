/** Source-only review contracts. Scores are ranking utilities, never probabilities. */
export interface ReviewItem {
  id: string;
  title: string;
  summary?: string;
  genres: string[];
  mediaType: string;
  runtimeMinutes?: number;
  contentRating?: string;
  ratings: { critic?: number; audience?: number; user?: number };
  availabilityGroup: string;
  requestAttempt?: { available: boolean };
}
export interface ReviewFacet {
  term: string;
  polarity: "prefer" | "avoid" | "reduce" | "mixed";
  source: "explicit" | "enrichment" | "requested-effect";
}
export type EvidenceSource = "description" | "genre-prior";
export interface FacetEvidence {
  term: string;
  polarity: "positive" | "negative" | "unknown";
  confidence: number;
  source?: EvidenceSource;
  /** Internal evidence span; do not persist or expose without the normal privacy policy. */
  span?: string;
}
export const featureKeys = ["query", "semantic", "mood", "reference", "preference", "feedback", "availability", "quality", "friction"] as const;
export type FeatureKey = typeof featureKeys[number];
export type RankingFeatures = Record<FeatureKey, number>;
export interface RankContribution { feature: FeatureKey; value: number; weight: number; contribution: number }
export interface RankingModel {
  schemaVersion: "moodarr-review-linear-v1";
  featureVersion: "moodarr-review-features-v1";
  weights: RankingFeatures;
  trainingGroupIds: string[];
  trainingDigest: string;
}
export interface ReviewScore {
  score: number;
  features: RankingFeatures;
  contributions: RankContribution[];
  evidence: FacetEvidence[];
  rejected: boolean;
  explanation: string;
}
export const defaultWeights: Readonly<RankingFeatures> = Object.freeze({
  query: 0.20, semantic: 0.15, mood: 0.23, reference: 0.10,
  preference: 0.08, feedback: 0.09, availability: 0.06, quality: 0.05, friction: 0.04
});
export function unit(value: number) { return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }
export function finiteScore(value: number | undefined, fallback = 50) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : fallback;
}
