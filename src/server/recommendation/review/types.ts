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
  polarity: "positive" | "negative" | "mixed" | "unknown";
  confidence: number;
  source?: EvidenceSource;
  /** Internal evidence span; do not persist or expose without the normal privacy policy. */
  span?: string;
}
/** Ordinal, explicitly worded degree; never a probability or inferred keyword magnitude. */
export interface ClaimIntensity { value: number; scale: "explicit-linguistic-degree-v1" }
export interface EvidenceClaim {
  id: string;
  aspect: string;
  value: "present" | "absent" | "unknown";
  polarity: FacetEvidence["polarity"];
  scope: "viewing-experience" | "subject" | "unknown";
  intensity?: ClaimIntensity;
  /** The minimum is a conservative heuristic cap, not a calibrated probability. */
  reliability: { source: number; extraction: number; mapping: number; cap: number };
  provenance: {
    itemId: string;
    field: "summary" | "genres";
    sourceHash: string;
    span?: { start: number; end: number; text: string };
    sourceValue?: string;
    extractorVersion: string;
    /** Shared statement identity across adapters, not independent votes. */
    parentIds: string[];
    fingerprint?: { version: string; inputHash: string; termKey: string };
  };
  freshness: "current" | "stale";
}
export interface ClaimFacetEvidence extends FacetEvidence {
  claims: EvidenceClaim[];
  intensity?: ClaimIntensity;
  coverage: { requested: number; supported: number; fraction: number; conflicted: boolean };
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
  composition?: {
    desiredContribution: number;
    reductionPenalty: number;
    referenceTransformation: number;
    unknownTerms: string[];
    unknownReferenceTerms: string[];
  };
}
export const defaultWeights: Readonly<RankingFeatures> = Object.freeze({
  query: 0.20, semantic: 0.15, mood: 0.23, reference: 0.10,
  preference: 0.08, feedback: 0.09, availability: 0.06, quality: 0.05, friction: 0.04
});
export function unit(value: number) { return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }
export function finiteScore(value: number | undefined, fallback = 50) {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : fallback;
}
