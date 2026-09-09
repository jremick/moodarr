import { setImmediate as yieldToEventLoop } from "node:timers/promises";

/** Explicit offline model/index identity. No model download or network transport. */
export interface LocalSemanticIdentity {
  model: string;
  modelRevision: string;
  preprocessingVersion: string;
  featureVersion: string;
  dimensions: number;
}

export interface LocalSemanticDocument {
  itemId: string;
  inputHash: string;
  vector: number[];
}

export interface LocalSemanticSnapshot {
  schemaVersion: "moodrank-local-semantic-v1";
  identity: LocalSemanticIdentity;
  documents: LocalSemanticDocument[];
}

export interface LocalSemanticHit {
  itemId: string;
  inputHash: string;
  similarity: number;
}

export interface LocalQueryEncoder {
  readonly identity: LocalSemanticIdentity;
  /** Only an explicitly approved, offline encoder may be injected here. */
  encode(query: string, signal?: AbortSignal): Promise<number[]>;
}

const maximumDocuments = 50_000;
const maximumScalars = 4_000_000;
const maximumHits = 512;

/**
 * Correctness-reference exact search for bounded offline evaluation, not an ANN
 * or production-scale performance claim. Build/replace explicitly off the request
 * path. A failed replacement leaves the previous immutable snapshot intact.
 */
export class ExactLocalSemanticIndex {
  private snapshot: LocalSemanticSnapshot;
  private byId: Map<string, LocalSemanticDocument>;

  constructor(snapshot: LocalSemanticSnapshot) {
    this.snapshot = validatedSnapshot(snapshot);
    this.byId = new Map(this.snapshot.documents.map((document) => [document.itemId, document]));
  }

  get identity(): LocalSemanticIdentity { return { ...this.snapshot.identity }; }
  get size() { return this.byId.size; }

  replace(snapshot: LocalSemanticSnapshot) {
    const next = validatedSnapshot(snapshot);
    const byId = new Map(next.documents.map((document) => [document.itemId, document]));
    this.snapshot = next;
    this.byId = byId;
  }

  exportSnapshot(): LocalSemanticSnapshot {
    return {
      schemaVersion: this.snapshot.schemaVersion,
      identity: this.identity,
      documents: this.snapshot.documents.map((document) => ({ ...document, vector: [...document.vector] }))
    };
  }

  documentInputHash(itemId: string) { return this.byId.get(itemId)?.inputHash; }

  async search(query: number[] | undefined, positiveReferenceIds: string[], limit = 128, signal?: AbortSignal) {
    if (!Number.isInteger(limit) || limit < 1 || limit > maximumHits) throw new Error("invalid_local_semantic_limit");
    signal?.throwIfAborted();
    // Pin one snapshot across yields so replacement cannot mix model identities.
    const snapshot = this.snapshot;
    const byId = this.byId;
    const queryVector = query === undefined ? undefined : normalizedVector(query, snapshot.identity.dimensions);
    const references = [...new Set(positiveReferenceIds)].slice(0, 8)
      .flatMap((id) => byId.get(id)?.vector ? [byId.get(id)!.vector] : []);
    const queryHits: LocalSemanticHit[] = [];
    const exampleHits: LocalSemanticHit[] = [];
    for (let index = 0; index < snapshot.documents.length; index += 1) {
      if (index % 256 === 0) {
        signal?.throwIfAborted();
        await yieldToEventLoop(undefined, { signal });
      }
      const document = snapshot.documents[index];
      if (queryVector) retain(queryHits, document, dot(queryVector, document.vector), limit);
      if (references.length) {
        // Discovery uses the nearest positive example; no accumulation or
        // negative-example attraction. Calibration belongs to a separate arm.
        const similarity = Math.max(...references.map((vector) => dot(vector, document.vector)));
        retain(exampleHits, document, similarity, limit);
      }
    }
    signal?.throwIfAborted();
    return { queryHits, exampleHits, identity: { ...snapshot.identity } };
  }
}

export function sameLocalSemanticIdentity(left: LocalSemanticIdentity, right: LocalSemanticIdentity) {
  return left.model === right.model && left.modelRevision === right.modelRevision
    && left.preprocessingVersion === right.preprocessingVersion && left.featureVersion === right.featureVersion
    && left.dimensions === right.dimensions;
}

function validatedSnapshot(value: LocalSemanticSnapshot): LocalSemanticSnapshot {
  if (!value || value.schemaVersion !== "moodrank-local-semantic-v1" || !value.identity) throw new Error("invalid_local_semantic_snapshot");
  const identity = value.identity;
  for (const text of [identity.model, identity.modelRevision, identity.preprocessingVersion, identity.featureVersion]) {
    if (typeof text !== "string" || !text.trim() || text.length > 160) throw new Error("invalid_local_semantic_identity");
  }
  if (!Number.isInteger(identity.dimensions) || identity.dimensions < 1 || identity.dimensions > 4096) throw new Error("invalid_local_semantic_dimensions");
  if (!Array.isArray(value.documents) || value.documents.length > maximumDocuments
    || value.documents.length * identity.dimensions > maximumScalars) throw new Error("local_semantic_resource_limit");
  const seen = new Set<string>();
  const documents = value.documents.map((document) => {
    if (!document || typeof document.itemId !== "string" || !document.itemId.trim() || document.itemId.length > 256
      || seen.has(document.itemId) || typeof document.inputHash !== "string" || !/^[a-f0-9]{64}$/.test(document.inputHash)) {
      throw new Error("invalid_local_semantic_document");
    }
    seen.add(document.itemId);
    return { itemId: document.itemId, inputHash: document.inputHash, vector: normalizedVector(document.vector, identity.dimensions) };
  });
  return { schemaVersion: value.schemaVersion, identity: { ...identity }, documents };
}

function normalizedVector(vector: number[], dimensions: number) {
  if (!Array.isArray(vector) || vector.length !== dimensions || !vector.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("invalid_local_semantic_vector");
  }
  // Scaling avoids overflow for otherwise finite input components.
  const scale = Math.max(...vector.map(Math.abs));
  if (!scale) throw new Error("invalid_local_semantic_zero_vector");
  const scaled = vector.map((value) => value / scale);
  const magnitude = Math.sqrt(scaled.reduce((sum, value) => sum + value * value, 0));
  return scaled.map((value) => value / magnitude);
}

function dot(left: number[], right: number[]) {
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result += left[index] * right[index];
  return Math.max(0, Math.min(1, result));
}

function retain(hits: LocalSemanticHit[], document: LocalSemanticDocument, similarity: number, limit: number) {
  if (similarity <= 0) return;
  const hit = { itemId: document.itemId, inputHash: document.inputHash, similarity };
  const compare = (other: LocalSemanticHit) => other.similarity > similarity
    || (other.similarity === similarity && other.itemId < document.itemId);
  if (hits.length === limit && compare(hits[hits.length - 1])) return;
  // Bounded top-k insertion; avoid sorting or retaining the whole catalogue.
  let low = 0;
  let high = hits.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compare(hits[middle])) low = middle + 1;
    else high = middle;
  }
  hits.splice(low, 0, hit);
  if (hits.length > limit) hits.pop();
}
