import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { LocalSemanticDocument, LocalSemanticIdentity, LocalSemanticHit } from "../localSemanticIndex";
import type { LocalSemanticSearchIndex } from "./semanticIndexContract";
export interface PackedIndexBudget { maximumDocuments: number; maximumVectorBytes: number }
interface Location { block: number; offset: number; inputHash: string }
interface Block { ids: string[]; values: Float32Array }
/**
 * Explicitly built, immutable float32 exact index. Shard streaming bounds input
 * memory. Resource authorization is mandatory; this is not an ANN latency claim.
 */
export class PackedLocalSemanticIndex implements LocalSemanticSearchIndex {
  private constructor(private readonly modelIdentity: LocalSemanticIdentity, private readonly blocks: Block[],
    private readonly byId: Map<string, Location>, readonly vectorBytes: number) {}
  readonly generation = 0;
  get identity(): LocalSemanticIdentity { return { ...this.modelIdentity }; }
  get size() { return this.byId.size; }
  documentInputHash(id: string) { return this.byId.get(id)?.inputHash; }
  documentIds(): Iterable<string> { return this.byId.keys(); }
  static async fromShards(identity: LocalSemanticIdentity,
    shards: AsyncIterable<readonly LocalSemanticDocument[]> | Iterable<readonly LocalSemanticDocument[]>,
    budget: PackedIndexBudget, signal?: AbortSignal): Promise<PackedLocalSemanticIndex> {
    signal?.throwIfAborted();
    validateIdentity(identity);
    if (!Number.isSafeInteger(budget.maximumDocuments) || budget.maximumDocuments < 1 || budget.maximumDocuments > 200_000
      || !Number.isSafeInteger(budget.maximumVectorBytes) || budget.maximumVectorBytes < identity.dimensions * 4
      || budget.maximumVectorBytes > 1024 ** 3) throw new Error("invalid_packed_index_budget");
    const pinned = { ...identity }, limits = { ...budget }, blocks: Block[] = [], byId = new Map<string, Location>();
    let vectorBytes = 0;
    for await (const shard of shards) {
      signal?.throwIfAborted();
      if (!Array.isArray(shard) || shard.length > 4096) throw new Error("invalid_semantic_shard");
      if (byId.size + shard.length > limits.maximumDocuments || vectorBytes + shard.length * pinned.dimensions * 4 > limits.maximumVectorBytes) throw new Error("packed_semantic_resource_limit");
      if (!shard.length) continue;
      const block: Block = { ids: [], values: new Float32Array(shard.length * pinned.dimensions) };
      for (let index = 0; index < shard.length; index += 1) {
        const document = shard[index];
        if (!document || typeof document.itemId !== "string" || !document.itemId.trim() || document.itemId.length > 256
          || byId.has(document.itemId) || typeof document.inputHash !== "string" || !/^[a-f0-9]{64}$/.test(document.inputHash)) throw new Error("invalid_packed_semantic_document");
        const vector = normalize(document.vector, pinned.dimensions);
        const offset = index * pinned.dimensions;
        block.values.set(vector, offset); block.ids.push(document.itemId);
        byId.set(document.itemId, { block: blocks.length, offset, inputHash: document.inputHash });
        if (index % 64 === 0) await yieldToEventLoop(undefined, { signal });
      }
      blocks.push(block); vectorBytes += block.values.byteLength;
    }
    signal?.throwIfAborted();
    return new PackedLocalSemanticIndex(Object.freeze(pinned), blocks, byId, vectorBytes);
  }
  async search(query: number[] | undefined, positiveReferenceIds: string[], limit = 128, signal?: AbortSignal,
    options: { eligibleIds?: ReadonlySet<string>; excludedIds?: ReadonlySet<string> } = {}) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 512) throw new Error("invalid_local_semantic_limit");
    signal?.throwIfAborted();
    const dimensions = this.modelIdentity.dimensions;
    const eligibleIds = options.eligibleIds ? new Set(options.eligibleIds) : undefined;
    const excludedIds = new Set(options.excludedIds);
    const vector = query === undefined ? undefined : normalize(query, dimensions);
    const references = [...new Set(positiveReferenceIds)].slice(0, 8).flatMap((id) => {
      const location = this.byId.get(id);
      return location ? [this.blocks[location.block].values.subarray(location.offset, location.offset + dimensions)] : [];
    });
    const queryHeap = new TopK(limit), exampleHeap = new TopK(limit);
    if (vector || references.length) for (const block of this.blocks) {
      for (let index = 0; index < block.ids.length; index += 1) {
        if (index % 64 === 0) await yieldToEventLoop(undefined, { signal });
        const itemId = block.ids[index];
        if (excludedIds.has(itemId) || (eligibleIds && !eligibleIds.has(itemId))) continue;
        const offset = index * dimensions;
        const score = (input: Float32Array) => {
          let sum = 0;
          for (let dim = 0; dim < dimensions; dim += 1) sum += input[dim] * block.values[offset + dim];
          return Math.max(0, Math.min(1, sum));
        };
        const inputHash = this.byId.get(itemId)!.inputHash;
        if (vector) queryHeap.add({ itemId, inputHash, similarity: score(vector) });
        if (references.length) {
          let best = 0;
          for (const reference of references) best = Math.max(best, score(reference));
          exampleHeap.add({ itemId, inputHash, similarity: best });
        }
      }
    }
    signal?.throwIfAborted();
    return { queryHits: queryHeap.sorted(), exampleHits: exampleHeap.sorted(), identity: this.identity };
  }
}
function validateIdentity(identity: LocalSemanticIdentity) {
  if (!identity || [identity.model, identity.modelRevision, identity.preprocessingVersion, identity.featureVersion]
    .some((value) => typeof value !== "string" || !value.trim() || value.length > 160)
    || !Number.isInteger(identity.dimensions) || identity.dimensions < 1 || identity.dimensions > 4096) throw new Error("invalid_local_semantic_identity");
}
function normalize(values: number[], dimensions: number): Float32Array {
  if (!Array.isArray(values) || values.length !== dimensions || [...values].some((value) => typeof value !== "number" || !Number.isFinite(value))) throw new Error("invalid_local_semantic_vector");
  let scale = 0;
  for (const value of values) scale = Math.max(scale, Math.abs(value));
  if (!scale) throw new Error("invalid_local_semantic_zero_vector");
  let magnitude = 0;
  for (const value of values) magnitude += (value / scale) ** 2;
  magnitude = Math.sqrt(magnitude);
  return Float32Array.from(values, (value) => value / scale / magnitude);
}
function better(a: LocalSemanticHit, b: LocalSemanticHit) { return a.similarity > b.similarity || (a.similarity === b.similarity && a.itemId < b.itemId); }
/** Worst-first heap: O(log k) insertion and O(k) retained hits per channel. */
class TopK {
  private readonly heap: LocalSemanticHit[] = [];
  constructor(private readonly capacity: number) {}
  add(hit: LocalSemanticHit) {
    if (hit.similarity <= 0) return;
    if (this.heap.length < this.capacity) {
      this.heap.push(hit); let index = this.heap.length - 1;
      while (index > 0) {
        const parent = (index - 1) >>> 1;
        if (!better(this.heap[parent], this.heap[index])) break;
        [this.heap[parent], this.heap[index]] = [this.heap[index], this.heap[parent]]; index = parent;
      }
    } else if (better(hit, this.heap[0])) {
      this.heap[0] = hit; let index = 0;
      while (true) {
        const left = index * 2 + 1, right = left + 1;
        if (left >= this.heap.length) break;
        const worst = right < this.heap.length && better(this.heap[left], this.heap[right]) ? right : left;
        if (!better(this.heap[index], this.heap[worst])) break;
        [this.heap[index], this.heap[worst]] = [this.heap[worst], this.heap[index]]; index = worst;
      }
    }
  }
  sorted() { return [...this.heap].sort((a, b) => b.similarity - a.similarity || (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0)); }
}
