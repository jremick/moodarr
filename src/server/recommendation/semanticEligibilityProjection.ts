import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { ItemDetail, SearchFilters } from "../../shared/types";
import type { MediaRepository } from "../db/mediaRepository";
import { hashEmbeddingInput } from "../ai/embeddings";
import { buildMediaFeatureDocument } from "./features";
import { sameLocalSemanticIdentity, type LocalSemanticIdentity } from "./localSemanticIndex";
import type { LocalSemanticSearchIndex } from "./review/semanticIndexContract";

export const SEMANTIC_ELIGIBILITY_VERSION = "semantic-eligibility-v1";
interface ProjectedDocument {
  ordinal: number;
  inputHash: string;
  fresh: boolean;
  item: ItemDetail;
  expiresAt?: number;
}
interface EligibilityProjection {
  version: typeof SEMANTIC_ELIGIBILITY_VERSION;
  generation: number;
  identity: LocalSemanticIdentity;
  source: ReturnType<MediaRepository["semanticEligibilityRevision"]>;
  documents: ReadonlyMap<string, ProjectedDocument>;
  ordinals: ReadonlyMap<string, number>;
  freshIds: ReadonlySet<string>;
  byMediaType: ReadonlyMap<string, ReadonlySet<string>>;
  byAvailability: ReadonlyMap<string, ReadonlySet<string>>;
  expiresAt: number;
}
const projections = new WeakMap<MediaRepository, WeakMap<LocalSemanticSearchIndex, EligibilityProjection>>();

/** Can be warmed explicitly alongside an index. Cold and dirty refreshes are
 * cancellable, incremental batches; ordinary requests reuse operational fields
 * and hashes. No query, user eligibility, or result is cached here.
 */
export async function prepareSemanticEligibilityProjection(repository: MediaRepository, index: LocalSemanticSearchIndex, signal: AbortSignal) {
  signal.throwIfAborted();
  const source = repository.semanticEligibilityRevision();
  const generation = index.generation, identity = { ...index.identity };
  let cache = projections.get(repository);
  if (!cache) { cache = new WeakMap(); projections.set(repository, cache); }
  const previous = cache.get(index);
  const rebuild = !previous || previous.generation !== generation || previous.source.dataVersion !== source.dataVersion
    || previous.source.mode !== source.mode || (source.mode === "query-only" && previous.source.revision !== source.revision)
    || !sameLocalSemanticIdentity(previous.identity, identity);
  const now = Date.now();
  const dirty = rebuild ? undefined : new Set([
    ...(source.mode === "journal" ? repository.semanticEligibilityChangedIds(previous.source.revision) : []),
    ...(previous.expiresAt <= now ? [...previous.documents].filter(([, entry]) => entry.expiresAt !== undefined && entry.expiresAt <= now).map(([id]) => id) : [])
  ]);
  if (!rebuild && dirty!.size === 0) {
    const projection = { ...previous, source };
    cache.set(index, projection);
    return { projection, mode: "warm" as const, refreshed: 0 };
  }
  const documents = rebuild ? new Map<string, ProjectedDocument>() : new Map(previous.documents);
  const ordinals = rebuild ? new Map<string, number>() : new Map(previous.ordinals);
  let refreshed = 0, ordinal = 0, batch: string[] = [];
  const refresh = async () => {
    await yieldToEventLoop(undefined, { signal });
    const items = repository.inflateByIds(batch);
    const features = repository.featureMapByIds(batch);
    const expiries = repository.semanticEligibilityExpiries(batch);
    for (const id of batch) documents.delete(id);
    for (const item of items) {
      const feature = features.get(item.id);
      const inputHash = hashEmbeddingInput(buildMediaFeatureDocument(item).featureText);
      const fresh = Boolean(feature && feature.featureVersion === identity.featureVersion
        && hashEmbeddingInput(feature.featureText) === inputHash && index.documentInputHash(item.id) === inputHash);
      documents.set(item.id, { ordinal: ordinals.get(item.id)!, inputHash, fresh,
        item: filterFields(item), expiresAt: expiries.get(item.id) });
    }
    refreshed += batch.length;
    batch = [];
  };
  for (const id of rebuild ? index.documentIds() : dirty!) {
    if (rebuild) ordinals.set(id, ordinal++);
    if (!rebuild && index.documentInputHash(id) === undefined) { documents.delete(id); continue; }
    batch.push(id);
    if (batch.length === 256) await refresh();
  }
  if (batch.length) await refresh();
  const freshIds = new Set<string>(), byMediaType = new Map<string, Set<string>>(), byAvailability = new Map<string, Set<string>>();
  for (const [id, entry] of documents) {
    if (!entry.fresh) continue;
    freshIds.add(id);
    for (const [map, key] of [[byMediaType, entry.item.mediaType], [byAvailability, entry.item.availabilityGroup]] as const) {
      const ids = map.get(key) ?? new Set<string>(); ids.add(id); map.set(key, ids);
    }
  }
  const projection: EligibilityProjection = { version: SEMANTIC_ELIGIBILITY_VERSION, generation, identity, source, documents, ordinals,
    freshIds, byMediaType, byAvailability,
    expiresAt: [...documents.values()].reduce((earliest, entry) => Math.min(earliest, entry.expiresAt ?? Infinity), Infinity) };
  assertSemanticProjectionCurrent(repository, index, projection);
  signal.throwIfAborted();
  cache.set(index, projection);
  return { projection, mode: rebuild ? "cold" as const : "refresh" as const, refreshed };
}

/** Choose the smallest cached fresh/type/availability set. Remaining hard
 * filters are checked on its operational fields before the vector top-k scan.
 */
export function semanticProjectionCandidates(projection: EligibilityProjection, filters: SearchFilters) {
  let candidates = projection.freshIds;
  for (const [keys, index] of [[filters.mediaTypes, projection.byMediaType], [filters.availability, projection.byAvailability]] as const) {
    if (!keys?.length) continue;
    const matching = new Set(keys.flatMap(key => [...(index.get(key) ?? [])]));
    if (matching.size < candidates.size) candidates = matching;
  }
  return candidates;
}

export function assertSemanticProjectionCurrent(repository: MediaRepository, index: LocalSemanticSearchIndex, projection: EligibilityProjection) {
  const source = repository.semanticEligibilityRevision();
  if (projection.generation !== index.generation || !sameLocalSemanticIdentity(projection.identity, index.identity)
    || projection.source.revision !== source.revision || projection.source.dataVersion !== source.dataVersion
    || projection.source.mode !== source.mode
    || Date.now() >= projection.expiresAt) throw new Error("semantic_projection_changed");
}

function filterFields(item: ItemDetail): ItemDetail {
  return {
    id: item.id, title: item.title, summary: item.summary, mediaType: item.mediaType, year: item.year,
    runtimeMinutes: item.runtimeMinutes, genres: item.genres, contentRating: item.contentRating,
    availabilityGroup: item.availabilityGroup, catalogIdentityAmbiguous: item.catalogIdentityAmbiguous,
    requestAttempt: item.requestAttempt, metadata: item.metadata ? { hasPoster: item.metadata.hasPoster,
      sparse: item.metadata.sparse, source: item.metadata.source, catalogSourceCount: item.metadata.catalogSourceCount } : undefined,
    plex: item.plex ? { available: item.plex.available } : undefined,
    seerr: item.seerr ? { status: item.seerr.status, requestStatus: item.seerr.requestStatus, requestable: item.seerr.requestable } : undefined,
    cast: [], directors: [], externalIds: {}, ratings: {}, posterUrl: "", availabilityExplanation: "", matchExplanation: "", score: 0
  };
}
