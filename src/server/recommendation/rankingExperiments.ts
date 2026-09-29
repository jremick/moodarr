/** Source/evaluation-only ablation switches. No HTTP or environment activation. */
export interface RankingExperiments {
  sharedIntent?: boolean;
  normalizedFeedback?: boolean;
  boundedPersonalization?: boolean;
  experientialDiversity?: boolean;
  groundedExplanations?: boolean;
  personalizationAudit?: boolean;
  evidenceAwareScoring?: boolean;
  referenceAspects?: boolean;
  reciprocalFusion?: boolean;
  semanticRankFusion?: boolean;
  finalSlateDiversity?: boolean;
  fractionalUtility?: boolean;
  scopedComparatives?: boolean;
  evidenceContract?: boolean;
  separatedComposition?: boolean;
  /** Restore the original desired-facet amplitude; reduction/reference stay fixed. */
  equalAmplitudeComposition?: boolean;
  /** Average support over distinct requested prefer facets, excluding enrichment. */
  coverageComposition?: boolean;
}
const switches = ["sharedIntent", "normalizedFeedback", "boundedPersonalization", "experientialDiversity", "groundedExplanations", "personalizationAudit", "evidenceAwareScoring", "referenceAspects", "reciprocalFusion", "semanticRankFusion", "finalSlateDiversity", "fractionalUtility", "scopedComparatives", "evidenceContract", "separatedComposition", "equalAmplitudeComposition", "coverageComposition"] as const;
export function resolveRankingExperiments(input?: RankingExperiments): Readonly<RankingExperiments> {
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) throw new Error("invalid_ranking_experiments");
  const result: RankingExperiments = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!switches.includes(key as typeof switches[number]) || typeof value !== "boolean") throw new Error("invalid_ranking_experiments");
    if (value) result[key as typeof switches[number]] = true;
  }
  if (result.evidenceAwareScoring && (!result.sharedIntent || result.boundedPersonalization)) {
    throw new Error("evidence_ranking_requires_shared_intent_without_fixed_cap");
  }
  if (result.scopedComparatives && !result.sharedIntent) throw new Error("scoped_comparatives_require_shared_intent");
  if (result.evidenceContract && !result.evidenceAwareScoring) throw new Error("claim_extraction_requires_evidence_scorer");
  if (result.separatedComposition && !result.evidenceContract) throw new Error("separated_composition_requires_claim_contract");
  if ((result.equalAmplitudeComposition || result.coverageComposition) && !result.separatedComposition) throw new Error("composition_control_requires_separated_composition");
  return Object.freeze(result);
}
export function rankingExperimentSuffix(input: RankingExperiments) {
  const mask = switches.reduce((mask, key, index) => mask | (input[key] ? 1 << index : 0), 0);
  return mask >= 64 ? `+ranking-review-v1-${mask}` : mask ? `+intent-ranking-v2-${mask}` : "";
}

/** Candidate for independent review, not automatic production activation.
 * The fixed-eight cap is deliberately excluded after its observed regressions.
 */
export const reviewCandidateRankingExperiments: Readonly<RankingExperiments> = Object.freeze({
  sharedIntent: true, normalizedFeedback: true, personalizationAudit: true,
  experientialDiversity: true, groundedExplanations: true
});
