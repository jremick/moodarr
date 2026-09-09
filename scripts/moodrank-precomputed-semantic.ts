import { createHash } from "node:crypto";
import { ExactLocalSemanticIndex, sameLocalSemanticIdentity, type LocalSemanticIdentity, type LocalSemanticSnapshot, type LocalQueryEncoder } from "../src/server/recommendation/localSemanticIndex";
import { FEATURE_VERSION } from "../src/server/recommendation/features";
import { recommendationEngineVersion } from "../src/server/recommendation/version";
import { rankingExperimentSuffix, reviewCandidateRankingExperiments } from "../src/server/recommendation/rankingExperiments";
import type { LocalDocumentEncoder } from "../src/server/recommendation/ollamaLocalEncoder";

export type IndependentRankingArm = "repaired-default" | "review-candidate";
export interface PreparedSemanticEvaluation {
  casesSha256: string;
  rankingArm: IndependentRankingArm;
  projectionVersion: string;
  queries: Array<{ inputHash: string; vector: number[] }>;
}
export interface PreparedSemanticDocument {
  schemaVersion: "moodrank-prepared-local-semantic-v1";
  catalogSha256: string;
  snapshot: LocalSemanticSnapshot;
  evaluation?: PreparedSemanticEvaluation;
}
export function semanticProjectionVersion(arm: IndependentRankingArm) {
  return `${recommendationEngineVersion}${rankingExperimentSuffix(arm === "review-candidate" ? reviewCandidateRankingExperiments : {})}:independent-positive-query-v2`;
}
export const semanticQueryHash = (query: string) => createHash("sha256").update(query).digest("hex");

/** Explicit preparation only. It receives query TEXT, never judgments, and is
 * separate from the no-network/no-model independent evaluation process. */
export async function prepareSemanticQueries(queries: string[], encoder: LocalDocumentEncoder, binding: { casesSha256: string; rankingArm: IndependentRankingArm }, signal?: AbortSignal): Promise<PreparedSemanticEvaluation> {
  const identity = { ...encoder.identity };
  const unique = [...new Set(queries.filter(Boolean))];
  if (unique.length > 5000 || unique.length * encoder.identity.dimensions > 4_000_000) throw new Error("precomputed_query_resource_limit");
  const rows: PreparedSemanticEvaluation["queries"] = [];
  for (let start = 0; start < unique.length; start += 8) {
    signal?.throwIfAborted();
    const batch = unique.slice(start, start + 8);
    const vectors = await encoder.encodeDocuments(batch, signal);
    signal?.throwIfAborted();
    if (vectors.length !== batch.length || !sameLocalSemanticIdentity(identity, encoder.identity)) throw new Error("precomputed_query_count_mismatch");
    rows.push(...batch.map((query, offset) => ({ inputHash: semanticQueryHash(query), vector: vectors[offset] })));
  }
  const evaluation = { ...binding, projectionVersion: semanticProjectionVersion(binding.rankingArm), queries: rows };
  // Validation rejects malformed vectors/duplicates before any file is published.
  new PrecomputedSemanticEncoder(identity, evaluation.queries);
  return evaluation;
}

/** Pure lookup encoder: no model, socket, fetch, file discovery or hidden writes. */
export class PrecomputedSemanticEncoder implements LocalQueryEncoder {
  readonly identity: LocalSemanticIdentity;
  private readonly vectors: Map<string, number[]>;
  constructor(identity: LocalSemanticIdentity, queries: PreparedSemanticEvaluation["queries"]) {
    if (!Array.isArray(queries) || queries.length > 5000) throw new Error("invalid_precomputed_queries");
    const validated = new ExactLocalSemanticIndex({ schemaVersion: "moodrank-local-semantic-v1", identity, documents: queries.map((query) => ({ itemId: query.inputHash, inputHash: query.inputHash, vector: query.vector })) }).exportSnapshot();
    this.identity = Object.freeze({ ...validated.identity });
    this.vectors = new Map(validated.documents.map((query) => [query.inputHash, [...query.vector]]));
  }
  has(query: string) { return !query || this.vectors.has(semanticQueryHash(query)); }
  async encode(query: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const vector = this.vectors.get(semanticQueryHash(query));
    if (!vector) throw new Error("missing_precomputed_semantic_query");
    return [...vector];
  }
}
export function validatePreparedSemanticDocument(value: PreparedSemanticDocument, binding: { casesSha256: string; catalogSha256: string; rankingArm: IndependentRankingArm }) {
  if (!hasOnlyKeys(value, ["schemaVersion", "catalogSha256", "snapshot", "evaluation"])
    || !hasOnlyKeys(value.snapshot, ["schemaVersion", "identity", "documents"])
    || !hasOnlyKeys(value.snapshot.identity, ["model", "modelRevision", "preprocessingVersion", "featureVersion", "dimensions"])
    || !Array.isArray(value.snapshot.documents) || value.snapshot.documents.some((document) => !hasOnlyKeys(document, ["itemId", "inputHash", "vector"]))
    || !hasOnlyKeys(value.evaluation, ["casesSha256", "rankingArm", "projectionVersion", "queries"])
    || !Array.isArray(value.evaluation?.queries) || value.evaluation.queries.some((query) => !hasOnlyKeys(query, ["inputHash", "vector"]))) throw new Error("invalid_precomputed_semantic_document");
  if (!value || value.schemaVersion !== "moodrank-prepared-local-semantic-v1" || value.catalogSha256 !== binding.catalogSha256
    || !value.evaluation || value.evaluation.casesSha256 !== binding.casesSha256 || value.evaluation.rankingArm !== binding.rankingArm
    || value.evaluation.projectionVersion !== semanticProjectionVersion(binding.rankingArm)) throw new Error("precomputed_semantic_binding_mismatch");
  const index = new ExactLocalSemanticIndex(value.snapshot);
  if (index.identity.featureVersion !== FEATURE_VERSION) throw new Error("precomputed_semantic_feature_mismatch");
  const encoder = new PrecomputedSemanticEncoder(index.identity, value.evaluation.queries);
  return { index, encoder };
}

function hasOnlyKeys(value: unknown, allowed: string[]) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every((key) => allowed.includes(key)));
}
