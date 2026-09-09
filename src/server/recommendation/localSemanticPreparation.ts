import { hashEmbeddingInput } from "../ai/embeddings";
import { FEATURE_VERSION } from "./features";
import { ExactLocalSemanticIndex, sameLocalSemanticIdentity, type LocalSemanticSnapshot } from "./localSemanticIndex";
import type { LocalDocumentEncoder } from "./ollamaLocalEncoder";

export interface LocalSemanticInput { itemId: string; featureText: string; featureVersion: string }
/** Prepare only explicitly supplied permitted text. A complete next snapshot is
 * returned atomically; failure never mutates a previous index or database. */
export async function prepareLocalSemanticSnapshot(
  source: Iterable<LocalSemanticInput>, encoder: LocalDocumentEncoder,
  options: { previous?: LocalSemanticSnapshot; batchSize?: number; signal?: AbortSignal } = {}
) {
  options.signal?.throwIfAborted();
  const identity = { ...encoder.identity };
  new ExactLocalSemanticIndex({ schemaVersion: "moodrank-local-semantic-v1", identity, documents: [] });
  if (identity.featureVersion !== FEATURE_VERSION) throw new Error("local_preparation_feature_version_mismatch");
  const batchSize = options.batchSize ?? 16;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 32) throw new Error("invalid_local_preparation_batch_size");
  const inputs: Array<LocalSemanticInput & { inputHash: string }> = [];
  const seen = new Set<string>();
  let totalTextBytes = 0;
  for (const input of source) {
    options.signal?.throwIfAborted();
    if (!input || typeof input.itemId !== "string" || !input.itemId.trim() || input.itemId.length > 256 || seen.has(input.itemId)
      || input.featureVersion !== FEATURE_VERSION || typeof input.featureText !== "string" || !input.featureText.trim()
      || Buffer.byteLength(input.featureText) > 65_536) throw new Error("invalid_local_semantic_input");
    totalTextBytes += Buffer.byteLength(input.featureText);
    if (totalTextBytes > 67_108_864) throw new Error("local_preparation_text_limit");
    seen.add(input.itemId);
    if (seen.size > 50_000 || seen.size * identity.dimensions > 4_000_000) throw new Error("local_semantic_resource_limit");
    inputs.push({ ...input, inputHash: hashEmbeddingInput(input.featureText) });
  }
  const previous = options.previous ? new ExactLocalSemanticIndex(options.previous).exportSnapshot() : undefined;
  if (previous && !sameLocalSemanticIdentity(previous.identity, identity)) throw new Error("local_preparation_previous_identity_mismatch");
  const old = new Map(previous?.documents.map((document) => [document.itemId, document]) ?? []);
  const documents: LocalSemanticSnapshot["documents"] = [];
  const pending: typeof inputs = [];
  for (const input of inputs) {
    const reusable = old.get(input.itemId);
    if (reusable?.inputHash === input.inputHash) documents.push({ ...reusable, vector: [...reusable.vector] });
    else pending.push(input);
  }
  for (let start = 0; start < pending.length; start += batchSize) {
    options.signal?.throwIfAborted();
    const batch = pending.slice(start, start + batchSize);
    // Respect the encoder's aggregate input limit even for long descriptions.
    const vectors: number[][] = [];
    for (let offset = 0; offset < batch.length; offset += 8) {
      const group = batch.slice(offset, offset + 8);
      vectors.push(...await encoder.encodeDocuments(group.map((input) => input.featureText), options.signal));
      options.signal?.throwIfAborted();
      if (vectors.length !== Math.min(offset + 8, batch.length) || !sameLocalSemanticIdentity(identity, encoder.identity)) throw new Error("local_preparation_encoder_drift");
    }
    for (let offset = 0; offset < batch.length; offset += 1) documents.push({ itemId: batch[offset].itemId, inputHash: batch[offset].inputHash, vector: vectors[offset] });
  }
  documents.sort((a, b) => a.itemId.localeCompare(b.itemId, "en"));
  const snapshot = new ExactLocalSemanticIndex({ schemaVersion: "moodrank-local-semantic-v1", identity, documents }).exportSnapshot();
  return { snapshot, counts: { total: inputs.length, encoded: pending.length, reused: inputs.length - pending.length, deleted: [...old.keys()].filter((id) => !seen.has(id)).length } };
}
