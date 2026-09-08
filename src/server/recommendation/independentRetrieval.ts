import { FEATURE_VERSION } from "./features";
import { hashEmbeddingInput } from "../ai/embeddings";
import type { MediaRepository } from "../db/mediaRepository";
import type { RecommendationBrief } from "./brief";
import { parseRecommendationIntent, tokenize } from "./intent";
import { matchesRecommendationFilters } from "./scoring";
import { createQueryCueMatcher } from "./queryCuePolarity";
import { ExactLocalSemanticIndex, sameLocalSemanticIdentity, type LocalQueryEncoder, type LocalSemanticHit } from "./localSemanticIndex";

/** Evaluation-only injection: not exposed as an HTTP flag or enabled by default. */
export interface IndependentRetrievalExperiment {
  index: ExactLocalSemanticIndex;
  encoder?: LocalQueryEncoder;
  timeoutMs?: number;
  maximumCandidates?: number;
}

export interface IndependentRetrievalDiagnostics {
  experiment: "local-semantic-discovery-v1";
  status: "applied" | "empty" | "incompatible" | "unconfigured" | "timeout" | "error";
  indexed: number;
  queryHits: number;
  exampleHits: number;
  accepted: number;
  rejected: number;
  truncated: boolean;
}

export async function retrieveIndependentCandidates(
  repository: MediaRepository,
  brief: RecommendationBrief,
  experiment: IndependentRetrievalExperiment,
  hiddenItemIds: ReadonlySet<string> = new Set(),
  callerSignal?: AbortSignal
) {
  const diagnostics: IndependentRetrievalDiagnostics = {
    experiment: "local-semantic-discovery-v1", status: "empty", indexed: experiment.index.size,
    queryHits: 0, exampleHits: 0, accepted: 0, rejected: 0, truncated: false
  };
  const result = { ids: [] as string[], scores: new Map<string, number>(), diagnostics };
  callerSignal?.throwIfAborted();
  if (experiment.index.identity.featureVersion !== FEATURE_VERSION
    || (experiment.encoder && !sameLocalSemanticIdentity(experiment.encoder.identity, experiment.index.identity))) {
    diagnostics.status = "incompatible";
    return result;
  }
  const maximum = experiment.maximumCandidates ?? 128;
  const timeoutMs = experiment.timeoutMs ?? 1000;
  if (!Number.isInteger(maximum) || maximum < 1 || maximum > 128 || !Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) {
    throw new Error("invalid_independent_retrieval_budget");
  }
  const controller = new AbortController();
  const signal = callerSignal ? AbortSignal.any([callerSignal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortError = new Error("independent_retrieval_cancelled");
  let abort: (() => void) | undefined;
  try {
    const generation = experiment.index.generation;
    const excludedReferences = new Set(repository.findReferenceIdsByTitle(brief.feedback.lessLikeTitles));
    const referenceIds = repository.findReferenceIdsByTitle([
      brief.softSignals.referenceTitle ?? "", ...brief.feedback.preferredExampleTitles, ...brief.feedback.moreLikeTitles
    ].filter(Boolean)).filter((id) => !excludedReferences.has(id) && !hiddenItemIds.has(id)).slice(0, 8);
    const referenceFeatures = repository.featureMapByIds(referenceIds);
    const positiveReferenceIds = referenceIds.filter((id) => {
      const feature = referenceFeatures.get(id);
      return feature?.featureVersion === FEATURE_VERSION
        && hashEmbeddingInput(feature.featureText) === experiment.index.documentInputHash(id);
    });
    const query = independentPositiveQuery(brief);
    if ((!query || !experiment.encoder) && positiveReferenceIds.length === 0) {
      diagnostics.status = query && !experiment.encoder ? "unconfigured" : "empty";
      return result;
    }
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => reject(abortError);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    const work = async () => {
      const identity = experiment.index.identity;
      const vector = query && experiment.encoder ? await experiment.encoder.encode(query, signal) : undefined;
      signal.throwIfAborted();
      if (experiment.index.generation !== generation || !sameLocalSemanticIdentity(identity, experiment.index.identity)
        || (experiment.encoder && !sameLocalSemanticIdentity(identity, experiment.encoder.identity))) {
        throw new Error("local_semantic_identity_changed");
      }
      return experiment.index.search(vector, positiveReferenceIds, 512, signal);
    };
    const hits = await Promise.race([work(), cancelled]);
    signal.throwIfAborted();
    if (experiment.index.generation !== generation) throw new Error("local_semantic_snapshot_changed");
    diagnostics.queryHits = hits.queryHits.length;
    diagnostics.exampleHits = hits.exampleHits.length;
    diagnostics.truncated = hits.queryHits.length === 512 || hits.exampleHits.length === 512;
    const hitIds = [...new Set([...hits.queryHits, ...hits.exampleHits].map((hit) => hit.itemId))];
    const items = new Map(repository.inflateByIds(hitIds).map((item) => [item.id, item]));
    const features = repository.featureMapByIds(hitIds);
    const intent = { ...parseRecommendationIntent(brief.query), hardFilters: brief.hardFilters, ...{
      wantsRequestOptions: brief.softSignals.wantsRequestOptions, wantsRequestAttempt: brief.softSignals.wantsRequestAttempt
    } };
    const eligible = new Map<string, boolean>();
    const admit = (hit: LocalSemanticHit) => {
      if (eligible.has(hit.itemId)) return eligible.get(hit.itemId)!;
      const item = items.get(hit.itemId);
      const feature = features.get(hit.itemId);
      const allowed = Boolean(item && feature && !hiddenItemIds.has(hit.itemId) && !excludedReferences.has(hit.itemId)
        && feature.featureVersion === hits.identity.featureVersion && hashEmbeddingInput(feature.featureText) === hit.inputHash
        && matchesRecommendationFilters(item, brief.hardFilters, intent));
      eligible.set(hit.itemId, allowed);
      if (!allowed) diagnostics.rejected += 1;
      return allowed;
    };
    const channels = [hits.queryHits.filter(admit), hits.exampleHits.filter(admit)];
    const bestSimilarity = new Map<string, number>();
    for (const channel of channels) for (const hit of channel) {
      bestSimilarity.set(hit.itemId, Math.max(bestSimilarity.get(hit.itemId) ?? 0, hit.similarity));
    }
    const seen = new Set<string>();
    // Protected, deterministic round-robin capacity; raw similarities from
    // different channels are not added together. Unused capacity is reusable.
    for (let rank = 0; rank < 512 && result.ids.length < maximum; rank += 1) {
      for (const channel of channels) {
        const hit = channel[rank];
        if (!hit || seen.has(hit.itemId)) continue;
        seen.add(hit.itemId);
        result.ids.push(hit.itemId);
        result.scores.set(hit.itemId, Math.round(bestSimilarity.get(hit.itemId)! * 100));
        if (result.ids.length === maximum) break;
      }
    }
    diagnostics.accepted = result.ids.length;
    diagnostics.status = result.ids.length ? "applied" : "empty";
    return result;
  } catch {
    callerSignal?.throwIfAborted();
    diagnostics.status = controller.signal.aborted ? "timeout" : "error";
    return result;
  } finally {
    clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
  }
}

export function independentPositiveQuery(brief: RecommendationBrief) {
  if (brief.viewingIntent) return brief.viewingIntent.positiveQuery;
  const cues = createQueryCueMatcher(brief.query);
  const referenceWords = new Set([
    brief.softSignals.referenceTitle ?? "", ...brief.feedback.preferredExampleTitles,
    ...brief.feedback.moreLikeTitles, ...brief.feedback.lessLikeTitles
  ].flatMap(tokenize));
  const excludedGenres = new Set((brief.hardFilters.excludedGenres ?? []).map((genre) => genre.toLowerCase()));
  return [...new Set([...brief.softSignals.moods, ...brief.softSignals.genres, ...brief.softSignals.terms])]
    .filter((term) => cues.allows(term) && !referenceWords.has(term.toLowerCase()) && !excludedGenres.has(term.toLowerCase()))
    .join(" ").slice(0, 2000);
}
