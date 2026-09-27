/**
 * Source/evaluation-only fingerprint comparison. These weights are heuristic
 * contribution caps, not calibrated probabilities or a production policy.
 * The input is structurally compatible with ContentFingerprintV1; no database,
 * provider, feature regeneration or production activation is performed here.
 */
export const experienceDimensions = [
  "mood", "tone", "pacing", "intensity", "humor", "romance", "watchability"
] as const;
export const referenceDimensions = [
  ...experienceDimensions, "themes", "setting", "era", "style", "microgenres"
] as const;
export type ExperienceDimension = typeof referenceDimensions[number];

export interface ExperienceEvidenceInput {
  id: string;
  sourceField: string;
  value: string;
  confidence: number;
}
export interface ExperienceTermInput {
  key: string;
  score: number;
  confidence: number;
  polarity?: "positive" | "negative";
  evidenceIds: readonly string[];
}
export interface FingerprintExperienceInput {
  evidence: readonly ExperienceEvidenceInput[];
  dimensions: Partial<Record<ExperienceDimension, readonly ExperienceTermInput[]>>;
}
export interface GroundedExperienceTerm {
  readonly key: string;
  readonly weight: number;
  readonly strength: number;
  readonly confidence: number;
}
export type GroundedExperience = Readonly<Partial<Record<ExperienceDimension, readonly GroundedExperienceTerm[]>>>;
export interface ExperienceComparison {
  /** Weighted tag overlap, not the probability of an emotional match. */
  readonly similarity: number | null;
  /** Fraction of requested dimensions with usable evidence on both sides. */
  readonly coverage: number;
  readonly confidence: number;
  readonly comparedDimensions: readonly ExperienceDimension[];
}

const genreConfidenceCap = 0.25;
const operationalKeys = new Set([
  "watch:in-plex", "watch:requestable", "watch:shared-screen", "watch:group-friendly",
  "watch:available", "watch:unavailable", "watch:already-requested", "watch:partially-available"
]);
const canonicalKey = (key: string) => key.trim().toLowerCase().replace(/[_\s]+/g, "-");
const validUnit = (value: number) => Number.isFinite(value) && value >= 0 && value <= 1;

function evidenceConfidence(evidence: ExperienceEvidenceInput, dimension: ExperienceDimension) {
  if (!validUnit(evidence.confidence) || !evidence.value.trim()) return 0;
  if (evidence.sourceField === "summary") return evidence.confidence;
  if (evidence.sourceField !== "genre") return 0;
  // Animation says something about format, not gentleness or suitability.
  if (/^(?:animation|animated|anime)$/i.test(evidence.value.trim()) && dimension !== "style") return 0;
  return Math.min(evidence.confidence, genreConfidenceCap);
}

function evidenceIndex(entries: readonly ExperienceEvidenceInput[]) {
  const index = new Map<string, ExperienceEvidenceInput>();
  const ambiguous = new Set<string>();
  for (const entry of entries) {
    if (!entry.id.trim() || ambiguous.has(entry.id)) continue;
    const previous = index.get(entry.id);
    if (previous && (previous.sourceField !== entry.sourceField || previous.value !== entry.value || previous.confidence !== entry.confidence)) {
      // Conflicting identities cannot be silently upgraded by input order.
      index.delete(entry.id);
      ambiguous.add(entry.id);
    } else {
      index.set(entry.id, entry);
    }
  }
  return index;
}

/**
 * Uses the strongest justified provenance, never the sum of repeated evidence.
 * Title, rating, runtime, availability, people and recycled feature/catalogFact
 * evidence are deliberately not accepted as emotional/experiential evidence.
 * Negative cues remain owned by existing safety/eligibility code; dropping them
 * here must never be used as evidence that an item lacks objectionable content.
 */
export function projectGroundedExperience(input: FingerprintExperienceInput | undefined): GroundedExperience {
  if (!input) return Object.freeze({});
  const evidence = evidenceIndex(input.evidence);
  const result: Partial<Record<ExperienceDimension, readonly GroundedExperienceTerm[]>> = {};
  for (const dimension of referenceDimensions) {
    const terms = new Map<string, GroundedExperienceTerm>();
    for (const term of input.dimensions[dimension] ?? []) {
      if (term.polarity === "negative" || !validUnit(term.confidence) || !Number.isFinite(term.score) || term.score <= 0 || term.score > 100) continue;
      const key = canonicalKey(term.key);
      if (!key || operationalKeys.has(key)) continue;
      let provenanceConfidence = 0;
      for (const id of new Set(term.evidenceIds)) {
        const source = evidence.get(id);
        if (source) provenanceConfidence = Math.max(provenanceConfidence, evidenceConfidence(source, dimension));
      }
      const confidence = Math.min(term.confidence, provenanceConfidence);
      if (!confidence) continue;
      const weight = (term.score / 100) * confidence;
      const previous = terms.get(key);
      if (!previous || weight > previous.weight || (weight === previous.weight && confidence > previous.confidence)) {
        terms.set(key, Object.freeze({ key, weight, strength: term.score / 100, confidence }));
      }
    }
    if (terms.size) result[dimension] = Object.freeze([...terms.values()].sort((a, b) => a.key.localeCompare(b.key)));
  }
  return Object.freeze(result);
}

function selectedDimensions(requested: readonly ExperienceDimension[]) {
  if (!requested.length || requested.some((dimension) => !referenceDimensions.includes(dimension))) {
    throw new Error("invalid_experience_dimensions");
  }
  return [...new Set(requested)];
}

/** Compare only dimensions observed on both sides; missing is unknown. */
export function compareGroundedExperience(
  left: GroundedExperience,
  right: GroundedExperience,
  requested: readonly ExperienceDimension[] = experienceDimensions
): ExperienceComparison {
  const dimensions = selectedDimensions(requested);
  const compared: ExperienceDimension[] = [];
  let similaritySum = 0;
  let confidenceSum = 0;
  for (const dimension of dimensions) {
    const a = left[dimension];
    const b = right[dimension];
    if (!a?.length || !b?.length) continue;
    // Confidence controls influence below, not whether identical tags match.
    const aWeights = new Map(a.map((term) => [term.key, term.strength]));
    const bWeights = new Map(b.map((term) => [term.key, term.strength]));
    let intersection = 0;
    let union = 0;
    for (const key of new Set([...aWeights.keys(), ...bWeights.keys()])) {
      intersection += Math.min(aWeights.get(key) ?? 0, bWeights.get(key) ?? 0);
      union += Math.max(aWeights.get(key) ?? 0, bWeights.get(key) ?? 0);
    }
    if (!union) continue;
    // Equal dimension budgets prevent a large tag list dominating the result.
    similaritySum += intersection / union;
    confidenceSum += Math.min(Math.max(...a.map((term) => term.confidence)), Math.max(...b.map((term) => term.confidence)));
    compared.push(dimension);
  }
  return Object.freeze({
    similarity: compared.length ? similaritySum / compared.length : null,
    coverage: compared.length / dimensions.length,
    confidence: compared.length ? confidenceSum / compared.length : 0,
    comparedDimensions: Object.freeze(compared)
  });
}

/** Bounded diversity candidate; preserve the caller's relevance gates and head. */
export function groundedDiversitySimilarity(left: GroundedExperience, right: GroundedExperience, structural: number) {
  if (!validUnit(structural)) throw new Error("invalid_structural_similarity");
  const comparison = compareGroundedExperience(left, right);
  if (comparison.similarity === null) return structural;
  const weight = 0.7 * comparison.confidence * comparison.coverage;
  return structural + weight * (comparison.similarity - structural);
}

/** Explicit aspect selection; unrelated matching genres/moods cannot compensate. */
export function referenceAspectSimilarity(
  candidate: FingerprintExperienceInput | undefined,
  reference: FingerprintExperienceInput | undefined,
  requested: readonly ExperienceDimension[]
) {
  return compareGroundedExperience(projectGroundedExperience(candidate), projectGroundedExperience(reference), requested);
}
