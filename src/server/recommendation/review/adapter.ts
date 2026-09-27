import type { ItemDetail, ItemSummary } from "../../../shared/types";
import type { RecommendationIntent } from "../intent";
import type { ScoringContext, DeterministicScoreComputationTrace } from "../scoring";
import { scoreReviewItem } from "./score";
import { fuseSemanticSignals } from "./semanticSignals";
import { scoreLinear } from "./linearModel";
import type { ExperienceAspect } from "./evidence";
import { createContentCueMatcher, createQueryCueMatcher } from "../queryCuePolarity";
import { documentaryPolicy } from "../documentaryPolicy";
import { evidenceDescription } from "./evidence";
export function prepareReviewScoringContext(context: ScoringContext): ScoringContext {
  if (!context.rankingExperiments?.semanticRankFusion) return context;
  return { ...context, reviewSemanticScores: fuseSemanticSignals([
    context.semanticScores ?? new Map(), context.providerEmbeddingScores ?? new Map(), context.independentSemanticScores ?? new Map()
  ]) };
}
export function reviewSemanticScore(context: ScoringContext, itemId: string) {
  return context.reviewSemanticScores?.get(itemId);
}
export function requestedReferenceAspects(query: string): ExperienceAspect[] {
  const aliases: [ExperienceAspect, string][] = [["tone", "tone|mood|atmosphere"], ["humour", "humou?r|comedy"], ["pacing", "pacing|pace"], ["intensity", "intensity"], ["themes", "themes?"], ["setting", "setting"]];
  return aliases.filter(([, words]) => new RegExp(`\\b(?:for (?:its|the)|same|similar|in terms of)\\s+(?:${words})\\b`, "i").test(query)).map(([aspect]) => aspect);
}
export function scoreEvidenceCandidate(item: ItemDetail, intent: RecommendationIntent, reference: ItemDetail | undefined,
  context: ScoringContext, preferenceScore: number,
  traces?: Map<string, DeterministicScoreComputationTrace>, unroundedScores?: Map<string, number>): ItemSummary | undefined {
  if (!intent.viewingIntent) throw new Error("evidence_ranking_requires_shared_intent");
  if (explicitFormatConflict(item, intent.viewingIntent.desiredQuery)) return undefined;
  const scored = scoreReviewItem(item, {
    facets: intent.viewingIntent.facets, softGenres: intent.softGenres,
    reference: context.rankingExperiments?.referenceAspects ? reference : undefined,
    referenceAspects: requestedReferenceAspects(intent.viewingIntent.positiveQuery),
    positiveQuery: intent.viewingIntent.positiveQuery,
    lexicalScore: context.lexicalRanks?.get(item.id),
    semanticScore: context.rankingExperiments?.semanticRankFusion ? reviewSemanticScore(context, item.id)
      : Math.max(context.semanticScores?.get(item.id) ?? 0, context.providerEmbeddingScores?.get(item.id) ?? 0, context.independentSemanticScores?.get(item.id) ?? 0),
    preferenceScore, feedbackScore: context.feedbackScores?.get(item.id), model: context.reviewRankingModel
  });
  const neutral = context.rankingExperiments?.personalizationAudit && !scored.rejected
    ? scoreLinear({ ...scored.features, preference: 50 }, context.reviewRankingModel).score : undefined;
  const raw = scored.contributions.reduce((sum, entry) => sum + entry.contribution, 0);
  unroundedScores?.set(item.id, raw);
  traces?.set(item.id, {
    itemId: item.id, disqualified: scored.rejected, unroundedScore: raw, deterministicScore: scored.score,
    buckets: scored.contributions.map((entry) => ({ bucket: entry.feature, value: entry.value, weight: entry.weight, contribution: entry.contribution })),
    adjustments: [],
    ...(neutral === undefined ? {} : { personalization: {
      neutralScore: Math.round(neutral), proposedScore: scored.score,
      proposedDelta: scored.score - Math.round(neutral), appliedDelta: scored.score - Math.round(neutral), policy: "audit-only" as const
    } })
  });
  if (scored.rejected) return undefined;
  return { ...item, score: scored.score,
    scoreBreakdown: { ...scored.features, taste: 50, novelty: 50, diversity: 50 }, matchExplanation: scored.explanation };
}

/** Explicit formats are eligibility conditions, not missing aesthetic evidence. */
function explicitFormatConflict(item: ItemDetail, query: string) {
  const cues = createQueryCueMatcher(query);
  const genres = new Set(item.genres.map(genre => genre.toLowerCase()));
  const description = `${evidenceDescription(item)} ${item.genres.join(" ")}`;
  const evidence = createContentCueMatcher(description);
  const permitsAnimation = /\b(?:animated|animation|anime)\s+(?:is\s+)?(?:ok|okay|allowed|fine)\b|\b(?:ok|okay|allowed|fine)\b.{0,32}\b(?:animated|animation|anime)\b/i.test(query);
  if (!permitsAnimation && cues.has(/\b(?:animated|animation|anime)\b/i)) {
    if (cues.has(/\badult\s+animation\b/i) && !genres.has("animation")) return true;
    if (!genres.has("animation") && !evidence.has(/\b(?:animated|animation|anime|cartoon)\b/i)) return true;
  }
  if (cues.has(/\b(?:documentary|documentaries|docs?|nonfiction|non-fiction)\b/i) && !genres.has("documentary")) return true;
  if (cues.excludes(/\b(?:musicals?|music|songs?|musical\s+numbers?)\b/i)
    && evidence.has(/\b(?:musicals?|music|songs?|singer|band|concert|stage|recording|album|musician|songwriter|singing)\b/i)) return true;
  return genres.has("documentary") && Boolean(documentaryPolicy(query, description).hardReason);
}
