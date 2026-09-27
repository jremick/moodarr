import { RecommendationEngine } from "../engine";
import type { RankingExperiments } from "../rankingExperiments";
import type { IndependentRetrievalExperiment } from "../independentRetrieval";
import { validateModel } from "./linearModel";
import type { RankingModel } from "./types";
type Dependencies = ConstructorParameters<typeof RecommendationEngine>;
export interface ReviewEngineDependencies {
  repository: Dependencies[0]; seerrClient: Dependencies[1]; ranker: Dependencies[2];
  embeddingProvider?: Dependencies[3]; briefParser?: Dependencies[4]; tasteScout?: Dependencies[5];
  queryOptimizer?: Dependencies[6]; reviewQueue?: Dependencies[7];
}
export const reviewArms = {
  baseline: {},
  intent: { sharedIntent: true },
  evidence: { sharedIntent: true, evidenceAwareScoring: true },
  reference: { sharedIntent: true, referenceAspects: true },
  retrieval: { sharedIntent: true, reciprocalFusion: true },
  semantic: { sharedIntent: true, semanticRankFusion: true },
  presentation: { sharedIntent: true, experientialDiversity: true, groundedExplanations: true, finalSlateDiversity: true },
  combined: { sharedIntent: true, normalizedFeedback: true, personalizationAudit: true,
    evidenceAwareScoring: true, referenceAspects: true, reciprocalFusion: true,
    semanticRankFusion: true, experientialDiversity: true, groundedExplanations: true, finalSlateDiversity: true }
} satisfies Record<string, RankingExperiments>;
/** Explicit source/evaluation construction, not an HTTP flag or production default. */
export function createReviewCandidateEngine(dependencies: ReviewEngineDependencies, arm: keyof typeof reviewArms,
  options: { independentRetrieval?: IndependentRetrievalExperiment; model?: RankingModel } = {}) {
  if (!Object.prototype.hasOwnProperty.call(reviewArms, arm)) throw new Error("invalid_review_arm");
  if (options.model && arm !== "combined" && arm !== "evidence") throw new Error("ranking_model_requires_evidence_arm");
  const model = options.model ? validateModel(options.model) : undefined;
  return new RecommendationEngine(dependencies.repository, dependencies.seerrClient, dependencies.ranker,
    dependencies.embeddingProvider, dependencies.briefParser, dependencies.tasteScout,
    dependencies.queryOptimizer, dependencies.reviewQueue, options.independentRetrieval, reviewArms[arm], model);
}
