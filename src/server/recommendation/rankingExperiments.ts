/** Source/evaluation-only ablation switches. No HTTP or environment activation. */
export interface RankingExperiments {
  sharedIntent?: boolean;
  normalizedFeedback?: boolean;
  boundedPersonalization?: boolean;
  experientialDiversity?: boolean;
  groundedExplanations?: boolean;
  personalizationAudit?: boolean;
}
const switches = ["sharedIntent", "normalizedFeedback", "boundedPersonalization", "experientialDiversity", "groundedExplanations", "personalizationAudit"] as const;
export function resolveRankingExperiments(input?: RankingExperiments): Readonly<RankingExperiments> {
  if (input !== undefined && (!input || typeof input !== "object" || Array.isArray(input))) throw new Error("invalid_ranking_experiments");
  const result: RankingExperiments = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (!switches.includes(key as typeof switches[number]) || typeof value !== "boolean") throw new Error("invalid_ranking_experiments");
    if (value) result[key as typeof switches[number]] = true;
  }
  return Object.freeze(result);
}
export function rankingExperimentSuffix(input: RankingExperiments) {
  const mask = switches.reduce((mask, key, index) => mask | (input[key] ? 1 << index : 0), 0);
  return mask ? `+intent-ranking-v2-${mask}` : "";
}

/** Candidate for independent review, not automatic production activation.
 * The fixed-eight cap is deliberately excluded after its observed regressions.
 */
export const reviewCandidateRankingExperiments: Readonly<RankingExperiments> = Object.freeze({
  sharedIntent: true, normalizedFeedback: true, personalizationAudit: true,
  experientialDiversity: true, groundedExplanations: true
});
