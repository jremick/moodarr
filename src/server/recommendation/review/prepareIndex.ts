import { createHash } from "node:crypto";
import type { LocalSemanticIdentity, LocalSemanticDocument } from "../localSemanticIndex";
import type { LocalDocumentEncoder } from "../ollamaLocalEncoder";
import { PackedLocalSemanticIndex, type PackedIndexBudget } from "./packedSemanticIndex";
export interface SemanticInput { itemId: string; featureText: string; featureVersion: string }
/** No implicit model choice/download. Compatible with the pinned loopback Ollama adapter. */
export async function* prepareSemanticShards(inputs: AsyncIterable<SemanticInput> | Iterable<SemanticInput>,
  encoder: LocalDocumentEncoder, budget: PackedIndexBudget, signal?: AbortSignal): AsyncGenerator<LocalSemanticDocument[]> {
  signal?.throwIfAborted();
  const identity = { ...encoder.identity }, limits = { ...budget }, dimensions = identity.dimensions;
  await PackedLocalSemanticIndex.fromShards(identity, [], limits, signal);
  if (!Number.isSafeInteger(limits.maximumDocuments) || limits.maximumDocuments < 1 || limits.maximumDocuments > 200_000
    || !Number.isSafeInteger(limits.maximumVectorBytes) || limits.maximumVectorBytes < dimensions * 4
    || limits.maximumVectorBytes > 1024 ** 3) throw new Error("invalid_packed_index_budget");
  const assertIdentity = () => { if (!sameIdentity(identity, encoder.identity)) throw new Error("encoder_identity_changed"); };
  const seen = new Set<string>();
  let batch: SemanticInput[] = [], batchBytes = 0;
  const encode = async (rows: SemanticInput[]) => {
    signal?.throwIfAborted(); assertIdentity();
    const vectors = await encoder.encodeDocuments(rows.map(row => row.featureText), signal);
    signal?.throwIfAborted(); assertIdentity();
    if (!Array.isArray(vectors) || vectors.length !== rows.length) throw new Error("encoder_vector_count_mismatch");
    return rows.map((row, index) => {
      const vector = vectors[index];
      if (!Array.isArray(vector) || vector.length !== dimensions || [...vector].some(value => typeof value !== "number" || !Number.isFinite(value))
        || !vector.some(value => value !== 0)) throw new Error("invalid_prepared_vector");
      return { itemId: row.itemId, inputHash: createHash("sha256").update(row.featureText).digest("hex"), vector: [...vector] };
    });
  };
  for await (const input of inputs) {
    signal?.throwIfAborted(); assertIdentity();
    if (!input || typeof input.itemId !== "string" || !input.itemId.trim() || input.itemId.length > 256 || seen.has(input.itemId)
      || typeof input.featureText !== "string" || !input.featureText.trim() || Buffer.byteLength(input.featureText) > 65_536
      || input.featureVersion !== identity.featureVersion) throw new Error("invalid_semantic_preparation_input");
    // Enforce budget before inference, not only after vectors have been produced.
    if (seen.size + 1 > limits.maximumDocuments || (seen.size + 1) * dimensions * 4 > limits.maximumVectorBytes) throw new Error("packed_semantic_resource_limit");
    seen.add(input.itemId);
    const bytes = Buffer.byteLength(input.featureText);
    if (batch.length && (batch.length >= 32 || batchBytes + bytes > 524_288)) {
      yield await encode(batch); batch = []; batchBytes = 0;
    }
    batch.push({ ...input }); batchBytes += bytes;
  }
  if (batch.length) yield await encode(batch);
  signal?.throwIfAborted(); assertIdentity();
}
export function buildPackedIndexFromInputs(inputs: AsyncIterable<SemanticInput> | Iterable<SemanticInput>,
  encoder: LocalDocumentEncoder, budget: PackedIndexBudget, signal?: AbortSignal) {
  const identity = { ...encoder.identity }, limits = { ...budget };
  async function* pinnedShards() {
    if (!sameIdentity(identity, encoder.identity)) throw new Error("encoder_identity_changed");
    for await (const shard of prepareSemanticShards(inputs, encoder, limits, signal)) {
      if (!sameIdentity(identity, encoder.identity)) throw new Error("encoder_identity_changed");
      yield shard;
    }
    if (!sameIdentity(identity, encoder.identity)) throw new Error("encoder_identity_changed");
  }
  return PackedLocalSemanticIndex.fromShards(identity, pinnedShards(), limits, signal);
}
export function sameIdentity(a: LocalSemanticIdentity, b: LocalSemanticIdentity) {
  return a.model === b.model && a.modelRevision === b.modelRevision && a.preprocessingVersion === b.preprocessingVersion
    && a.featureVersion === b.featureVersion && a.dimensions === b.dimensions;
}
