import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { FEATURE_VERSION } from "./features";
import { hashEmbeddingInput } from "../ai/embeddings";
import type { MediaRepository } from "../db/mediaRepository";
import type { RecommendationBrief } from "./brief";
import { parseRecommendationIntent, tokenize } from "./intent";
import { matchesRecommendationFilters } from "./scoring";
import { createQueryCueMatcher } from "./queryCuePolarity";
import { sameLocalSemanticIdentity, type LocalQueryEncoder, type LocalSemanticHit } from "./localSemanticIndex";
import type { LocalSemanticSearchIndex } from "./review/semanticIndexContract";
import { assertSemanticProjectionCurrent, prepareSemanticEligibilityProjection, semanticProjectionCandidates, SEMANTIC_ELIGIBILITY_VERSION } from "./semanticEligibilityProjection";

/** Evaluation-only injection: not exposed as an HTTP flag or enabled by default. */
export interface IndependentRetrievalExperiment {
  index: LocalSemanticSearchIndex;
  /** Optional snapshot-local prefilter. Final repository eligibility is still checked. */
  eligibleItemIds?: ReadonlySet<string>;
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
  validated: number;
  refills: number;
  projection?: { version: typeof SEMANTIC_ELIGIBILITY_VERSION; mode: "cold" | "warm" | "refresh"; refreshed: number };
}

export async function retrieveIndependentCandidates(
  repository: MediaRepository,
  brief: RecommendationBrief,
  experiment: IndependentRetrievalExperiment,
  hiddenItemIds: ReadonlySet<string> = new Set(),
  callerSignal?: AbortSignal
) {
  const index = experiment.index;
  const diagnostics: IndependentRetrievalDiagnostics = {
    experiment: "local-semantic-discovery-v1", status: "empty", indexed: index.size,
    queryHits: 0, exampleHits: 0, accepted: 0, rejected: 0, truncated: false, validated: 0, refills: 0
  };
  const result = { ids: [] as string[], scores: new Map<string, number>(), diagnostics };
  callerSignal?.throwIfAborted();
  if (index.identity.featureVersion !== FEATURE_VERSION
    || (experiment.encoder && !sameLocalSemanticIdentity(experiment.encoder.identity, index.identity))) {
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
    const generation = index.generation;
    const identity = { ...index.identity };
    // Only source-independent fields are cached. User/filter policy is copied
    // per call and checked across every asynchronous boundary.
    const policyIdentity = () => JSON.stringify({ filters: brief.hardFilters, less: brief.feedback.lessLikeTitles,
      hidden: [...hiddenItemIds].sort(), eligible: experiment.eligibleItemIds ? [...experiment.eligibleItemIds].sort() : null,
      requestAttempt: brief.softSignals.wantsRequestAttempt, requestOptions: brief.softSignals.wantsRequestOptions });
    const policy = policyIdentity();
    const requestedEligibleIds = experiment.eligibleItemIds ? new Set(experiment.eligibleItemIds) : undefined;
    const excludedReferences = new Set(repository.findReferenceIdsByTitle(brief.feedback.lessLikeTitles));
    const excludedIds = new Set([...hiddenItemIds, ...excludedReferences]);
    const intent = { ...parseRecommendationIntent(brief.query), hardFilters: brief.hardFilters,
      wantsRequestOptions: brief.softSignals.wantsRequestOptions, wantsRequestAttempt: brief.softSignals.wantsRequestAttempt };
    const referenceIds = repository.findReferenceIdsByTitle([
      brief.softSignals.referenceTitle ?? "", ...brief.feedback.preferredExampleTitles, ...brief.feedback.moreLikeTitles
    ].filter(Boolean)).filter((id) => !excludedReferences.has(id) && !hiddenItemIds.has(id)).slice(0, 8);
    const referenceFeatures = repository.featureMapByIds(referenceIds);
    const positiveReferenceIds = referenceIds.filter((id) => {
      const feature = referenceFeatures.get(id);
      return feature?.featureVersion === FEATURE_VERSION
        && hashEmbeddingInput(feature.featureText) === index.documentInputHash(id);
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
      const prepared = await prepareSemanticEligibilityProjection(repository, index, signal);
      const { projection } = prepared;
      diagnostics.projection = { version: SEMANTIC_ELIGIBILITY_VERSION, mode: prepared.mode, refreshed: prepared.refreshed };
      const freshReferenceIds = positiveReferenceIds.filter(id => projection.documents.get(id)?.fresh);
      const assertCurrent = () => {
        signal.throwIfAborted();
        if (experiment.index !== index || index.generation !== generation || policyIdentity() !== policy
          || !sameLocalSemanticIdentity(identity, index.identity)
          || (experiment.encoder && !sameLocalSemanticIdentity(identity, experiment.encoder.identity))) {
          throw new Error("local_semantic_snapshot_changed");
        }
        assertSemanticProjectionCurrent(repository, index, projection);
      };
      assertCurrent();
      const eligibleIds = new Set<string>();
      let checked = 0;
      const projectedCandidates = semanticProjectionCandidates(projection, brief.hardFilters);
      diagnostics.rejected += projection.documents.size - projectedCandidates.size;
      for (const id of projectedCandidates) {
        const document = projection.documents.get(id)!;
        if (checked++ % 256 === 0) await yieldToEventLoop(undefined, { signal });
        if (excludedIds.has(id) || (requestedEligibleIds && !requestedEligibleIds.has(id))) continue;
        if (document.fresh && matchesRecommendationFilters(document.item, brief.hardFilters, intent)) eligibleIds.add(id);
        else diagnostics.rejected++;
      }
      assertCurrent();
      const vector = query && experiment.encoder ? await experiment.encoder.encode(query, signal) : undefined;
      assertCurrent();
      const validated = new Set<string>();
      const accepted = new Set<string>();
      const channels: LocalSemanticHit[][] = [[], []];
      const bestSimilarity = new Map<string, number>();
      const maximumValidation = 2048 - referenceIds.length;
      for (let round = 0; round <= 2 && accepted.size < maximum && validated.size < maximumValidation; round++) {
        // Two channels together cannot spend more than the remaining budget.
        const limit = Math.min(512, Math.floor((maximumValidation - validated.size) / 2));
        if (limit < 1) break;
        const hits = await index.search(vector, freshReferenceIds, limit, signal, { eligibleIds, excludedIds });
        assertCurrent();
        if (!sameLocalSemanticIdentity(identity, hits.identity)) throw new Error("local_semantic_identity_changed");
        diagnostics.refills = round;
        diagnostics.queryHits += hits.queryHits.length;
        diagnostics.exampleHits += hits.exampleHits.length;
        diagnostics.truncated ||= hits.queryHits.length === limit || hits.exampleHits.length === limit;
        const returnedChannels = [hits.queryHits, hits.exampleHits];
        const hitIds = [...new Set(returnedChannels.flat().map(hit => hit.itemId))].filter(id => !validated.has(id));
        if (!hitIds.length) break;
        if (hits.queryHits.length > limit || hits.exampleHits.length > limit || hitIds.length > maximumValidation - validated.size) {
          throw new Error("local_semantic_validation_budget");
        }
        const items = new Map(repository.inflateByIds(hitIds).map(item => [item.id, item]));
        const features = repository.featureMapByIds(hitIds);
        const eligible = new Set<string>();
        for (const id of hitIds) {
          validated.add(id);
          excludedIds.add(id);
          const item = items.get(id), feature = features.get(id);
          if (eligibleIds.has(id) && item && feature && feature.featureVersion === identity.featureVersion
            && hashEmbeddingInput(feature.featureText) === projection.documents.get(id)?.inputHash
            && matchesRecommendationFilters(item, brief.hardFilters, intent)) eligible.add(id);
        }
        diagnostics.validated = validated.size;
        const admittedThisRound = new Set<string>();
        for (let channel = 0; channel < returnedChannels.length; channel++) for (const hit of returnedChannels[channel]) {
          if (!eligible.has(hit.itemId) || hit.inputHash !== projection.documents.get(hit.itemId)?.inputHash
            || !Number.isFinite(hit.similarity) || hit.similarity < 0 || hit.similarity > 1) continue;
          channels[channel].push(hit);
          accepted.add(hit.itemId);
          admittedThisRound.add(hit.itemId);
          bestSimilarity.set(hit.itemId, Math.max(bestSimilarity.get(hit.itemId) ?? 0, hit.similarity));
        }
        diagnostics.rejected += hitIds.length - admittedThisRound.size;
        assertCurrent();
        if (hits.queryHits.length < limit && hits.exampleHits.length < limit) break;
      }
      const ids: string[] = [], scores = new Map<string, number>(), seen = new Set<string>();
      // Preserve deterministic channel fusion; similarities are never summed.
      for (let rank = 0; rank < maximumValidation && ids.length < maximum; rank++) for (const channel of channels) {
        const hit = channel[rank];
        if (!hit || seen.has(hit.itemId)) continue;
        seen.add(hit.itemId); ids.push(hit.itemId);
        scores.set(hit.itemId, Math.round(bestSimilarity.get(hit.itemId)! * 100));
        if (ids.length === maximum) break;
      }
      assertCurrent();
      return { ids, scores, assertCurrent };
    };
    const completed = await Promise.race([work(), cancelled]);
    completed.assertCurrent();
    result.ids = completed.ids;
    result.scores = completed.scores;
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
