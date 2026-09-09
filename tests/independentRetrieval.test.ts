import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import { NoopRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { FEATURE_VERSION } from "../src/server/recommendation/features";
import { buildRecommendationBrief } from "../src/server/recommendation/brief";
import { parseRecommendationIntent } from "../src/server/recommendation/intent";
import { retrieveRecommendationCandidates } from "../src/server/recommendation/retrieval";
import { retrieveIndependentCandidates, type IndependentRetrievalExperiment } from "../src/server/recommendation/independentRetrieval";
import { ExactLocalSemanticIndex, type LocalSemanticSnapshot } from "../src/server/recommendation/localSemanticIndex";
import { hashEmbeddingInput } from "../src/server/ai/embeddings";

const databases: DatabaseSync[] = [];
const identity = { model: "synthetic-test-only", modelRevision: "fixture-v1", preprocessingVersion: "fixture-text-v1", featureVersion: FEATURE_VERSION, dimensions: 2 };
beforeEach(() => vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Must remain offline"); })));
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function setup(count = 5) {
  const db = createDatabase(":memory:"); databases.push(db);
  const repository = new MediaRepository(db);
  repository.upsertMany(Array.from({ length: count }, (_, index) => ({
    title: `Observer ${String(index).padStart(5, "0")}`, mediaType: "movie" as const, year: 2024,
    summary: "A study of changing patterns in the landscape.", runtimeMinutes: 100,
    plex: { available: true, ratingKey: `observer-${index}`, libraryTitle: "Regression", libraryType: "movie" }
  })));
  const ids = repository.list().map((item) => item.id);
  const target = ids[ids.length - 1];
  const snapshot: LocalSemanticSnapshot = { schemaVersion: "moodrank-local-semantic-v1", identity, documents: [...repository.featureMap()].map(([id, feature]) => ({
    itemId: id, inputHash: hashEmbeddingInput(feature.featureText), vector: id === target ? [1, 0] : [0, 1]
  })) };
  const encoder = { identity, encode: vi.fn(async () => [1, 0]) };
  const experiment: IndependentRetrievalExperiment = { index: new ExactLocalSemanticIndex(snapshot), encoder, timeoutMs: 5000 };
  return { db, repository, ids, target, snapshot, experiment, encoder };
}
function brief(query = "kinetic escapism") {
  const intent = parseRecommendationIntent(query);
  return buildRecommendationBrief({ query }, intent, intent.hardFilters, "solo", 5);
}
const seerr = { allowsDescriptiveContent: () => false } as unknown as SeerrClient;

describe("independent retrieval integration, synthetic vectors only", () => {
  it("introduces a title outside the real catalogue's legacy 3,000-ID candidate window", async () => {
    const { repository, target, experiment } = setup(3005);
    const legacy = await retrieveRecommendationCandidates(repository, brief());
    expect(legacy.candidates).toHaveLength(3000);
    expect(legacy.candidates.map((item) => item.id)).not.toContain(target);
    const candidate = await retrieveRecommendationCandidates(repository, brief(), undefined, { independentRetrieval: experiment });
    expect(candidate.candidates).toHaveLength(3000);
    expect(candidate.candidates.map((item) => item.id)).toContain(target);
    expect(candidate.context.independentRetrieval).toMatchObject({ status: "applied", accepted: 1 });
    expect(candidate.context.independentSemanticScores?.get(target)).toBe(100);
    expect(fetch).not.toHaveBeenCalled();
  }, 60_000);
  it("runs through the real final engine response only when explicitly injected", async () => {
    const { repository, target, experiment } = setup();
    const legacy = new RecommendationEngine(repository, seerr, new NoopRanker());
    const baseline = await legacy.recommend({ query: "kinetic escapism", useAi: false });
    expect(baseline.diagnostics?.independentRetrieval).toBeUndefined();
    const candidate = new RecommendationEngine(repository, seerr, new NoopRanker(), undefined, undefined, undefined, undefined, undefined, experiment);
    const response = await candidate.recommend({ query: "kinetic escapism", useAi: false });
    expect(response.results[0]?.id).toBe(target);
    expect(response.diagnostics?.independentRetrieval).toMatchObject({ status: "applied" });
    const hidden = await candidate.recommend({ query: "kinetic escapism", useAi: false, feedbackContext: { hiddenItemIds: [target] } });
    expect(hidden.results.map((item) => item.id)).not.toContain(target);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not admit stale hashes, old feature versions or missing items", async () => {
    const { repository, experiment, snapshot } = setup();
    snapshot.documents.forEach((document) => { document.vector = [1, 0]; document.inputHash = "a".repeat(64); });
    snapshot.documents.push({ itemId: "nonexistent", inputHash: "a".repeat(64), vector: [1, 0] });
    experiment.index.replace(snapshot);
    expect((await retrieveIndependentCandidates(repository, brief(), experiment)).ids).toEqual([]);
    experiment.index.replace({ ...snapshot, identity: { ...identity, featureVersion: "old" } });
    expect((await retrieveIndependentCandidates(repository, brief(), experiment)).diagnostics.status).toBe("incompatible");
  });
  it("rejects an encoder/index identity mismatch before calling the encoder", async () => {
    const { repository, experiment, encoder } = setup();
    experiment.encoder = { ...encoder, identity: { ...identity, modelRevision: "other" } };
    expect((await retrieveIndependentCandidates(repository, brief(), experiment)).diagnostics.status).toBe("incompatible");
    expect(encoder.encode).not.toHaveBeenCalled();
  });
  it("retains hard runtime/year/availability filters", async () => {
    const { repository, experiment, target } = setup();
    const candidate = brief();
    for (const filters of [{ maxRuntimeMinutes: 90 }, { minYear: 2025 }, { availability: ["unavailable" as const] }]) {
      candidate.hardFilters = filters;
      expect((await retrieveIndependentCandidates(repository, candidate, experiment)).ids).not.toContain(target);
    }
  });
  it("can find neighbours of an ineligible reference without returning that reference", async () => {
    const { repository, experiment, target } = setup();
    const referenceId = repository.upsert({
      title: "Unavailable Exemplar", mediaType: "movie", runtimeMinutes: 100,
      summary: "A study of another landscape.",
      plex: { available: false, ratingKey: "unavailable-exemplar", libraryTitle: "Regression", libraryType: "movie" }
    });
    const feature = repository.featureMapByIds([referenceId]).get(referenceId)!;
    const snapshot = experiment.index.exportSnapshot();
    snapshot.documents.push({ itemId: referenceId, inputHash: hashEmbeddingInput(feature.featureText), vector: [1, 0] });
    experiment.index.replace(snapshot);
    const candidate = brief();
    candidate.softSignals.terms = [];
    candidate.softSignals.moods = [];
    candidate.softSignals.genres = [];
    candidate.softSignals.referenceTitle = "Unavailable Exemplar";
    experiment.encoder = undefined;
    candidate.hardFilters = { availability: ["available_in_plex"] };
    const result = await retrieveIndependentCandidates(repository, candidate, experiment);
    expect(result.diagnostics.exampleHits).toBe(2);
    expect(result.ids).toContain(target);
    expect(result.ids).not.toContain(referenceId);
  });
  it("does not use negative example identities as positive discovery", async () => {
    const { repository, experiment, target } = setup();
    const candidate = brief();
    candidate.softSignals.terms = [];
    candidate.softSignals.moods = [];
    candidate.softSignals.referenceTitle = repository.findById(target)!.title;
    candidate.feedback.lessLikeTitles = [candidate.softSignals.referenceTitle];
    experiment.encoder = undefined;
    const result = await retrieveIndependentCandidates(repository, candidate, experiment);
    expect(result.ids).toEqual([]);
  });
  it("does not encode directly negated facets or fabricate an empty positive query", async () => {
    const { repository, experiment, encoder } = setup();
    const candidate = brief("no music, not romantic, not slow burn, not bleak");
    candidate.softSignals.terms = ["music", "romantic", "slow burn", "bleak"];
    candidate.softSignals.genres = [];
    candidate.softSignals.moods = [];
    expect((await retrieveIndependentCandidates(repository, candidate, experiment)).diagnostics.status).toBe("empty");
    expect(encoder.encode).not.toHaveBeenCalled();
  });
  it("reports unavailable real model resources without inventing embeddings", async () => {
    const { repository, experiment } = setup();
    experiment.encoder = undefined;
    expect((await retrieveIndependentCandidates(repository, brief(), experiment)).diagnostics.status).toBe("unconfigured");
  });
  it("times out an uncooperative encoder and preserves deterministic fallback", async () => {
    const { repository, experiment } = setup();
    experiment.timeoutMs = 5;
    experiment.encoder = { identity, encode: () => new Promise(() => {}) };
    const result = await retrieveRecommendationCandidates(repository, brief(), undefined, { independentRetrieval: experiment });
    expect(result.context.independentRetrieval?.status).toBe("timeout");
    expect(result.candidates).toHaveLength(5);
  });
  it("propagates explicit caller cancellation instead of treating it as a model failure", async () => {
    const { repository, experiment } = setup();
    const controller = new AbortController();
    experiment.encoder = { identity, encode: async () => { controller.abort(new Error("stop")); return [1, 0]; } };
    await expect(retrieveIndependentCandidates(repository, brief(), experiment, undefined, controller.signal)).rejects.toThrow("stop");
  });
  it("keeps bounded capacity and reuses unused channel slots", async () => {
    const { repository, experiment, snapshot } = setup(20);
    snapshot.documents.forEach((document) => { document.vector = [1, 0]; });
    experiment.index.replace(snapshot);
    experiment.maximumCandidates = 7;
    const result = await retrieveIndependentCandidates(repository, brief(), experiment);
    expect(result.ids).toHaveLength(7);
    expect(new Set(result.ids).size).toBe(7);
  });
  it("does not admit an individually stale feature row", async () => {
    const { db, repository, experiment, target } = setup();
    db.prepare("UPDATE media_features SET feature_version = 'old' WHERE media_item_id = ?").run(target);
    const result = await retrieveIndependentCandidates(repository, brief(), experiment);
    expect(result.ids).not.toContain(target);
    expect(result.diagnostics.rejected).toBe(1);
  });
  it.each(["failure", "zero", "wrong-dimensions"])("keeps model failure %s explicit and fail-soft", async (failure) => {
    const { repository, experiment } = setup();
    experiment.encoder = { identity, encode: async () => {
      if (failure === "failure") throw new Error("private unsafe error not to expose");
      return failure === "zero" ? [0, 0] : [1];
    } };
    const candidate = await retrieveRecommendationCandidates(repository, brief(), undefined, { independentRetrieval: experiment });
    expect(candidate.candidates).toHaveLength(5);
    expect(candidate.context.independentRetrieval?.status).toBe("error");
    expect(JSON.stringify(candidate.context.independentRetrieval)).not.toContain("private");
  });
  it("rejects budget overrides rather than silently allowing unbounded scans", async () => {
    const { repository, experiment } = setup();
    await expect(retrieveIndependentCandidates(repository, brief(), { ...experiment, maximumCandidates: 129 })).rejects.toThrow();
    await expect(retrieveIndependentCandidates(repository, brief(), { ...experiment, timeoutMs: 0 })).rejects.toThrow();
  });

  it("labels the experimental arm in persisted traces without raw query or model identity", async () => {
    const { db, repository, experiment, target } = setup();
    vi.stubEnv("MOODRANK_TRACE_WRITE", "strict");
    const engine = new RecommendationEngine(repository, seerr, new NoopRanker(), undefined, undefined, undefined, undefined, undefined, experiment);
    const query = "kinetic escapism";
    const response = await engine.recommend({ query, useAi: false, resultLimit: 1 });
    expect(response.diagnostics?.engineVersion).toContain("+local-semantic-discovery-v1");
    const stored = db.prepare("SELECT engine_version, retrieval_trace_json, brief_trace_json FROM recommendation_sessions WHERE id = ?").get(response.sessionId!) as {
      engine_version: string; retrieval_trace_json: string; brief_trace_json: string;
    };
    expect(stored.engine_version).toBe(response.diagnostics?.engineVersion);
    expect(JSON.parse(stored.retrieval_trace_json).independentRetrieval.status).toBe("applied");
    expect(stored.retrieval_trace_json + stored.brief_trace_json).not.toContain(query);
    expect(stored.retrieval_trace_json).not.toContain(identity.model);
    const result = db.prepare("SELECT provenance_json FROM recommendation_results WHERE session_id = ? AND media_item_id = ?").get(response.sessionId!, target) as { provenance_json: string };
    expect(JSON.parse(result.provenance_json).sources).toEqual(expect.arrayContaining([expect.objectContaining({ source: "semantic_independent_local" })]));
  });
  it("protects both query and example discovery capacity with deterministic fusion", async () => {
    const { repository, experiment, target, ids } = setup();
    const candidate = brief();
    candidate.feedback.moreLikeTitles = [repository.findById(ids[0])!.title];
    experiment.maximumCandidates = 2;
    const result = await retrieveIndependentCandidates(repository, candidate, experiment);
    expect(result.ids).toHaveLength(2);
    expect(result.ids[0]).toBe(target);
    expect(result.ids[1]).not.toBe(target);
    expect(result.diagnostics.queryHits).toBe(1);
    expect(result.diagnostics.exampleHits).toBe(4);
  });

  it("rejects a same-model snapshot replacement during query encoding", async () => {
    const { repository, experiment } = setup();
    experiment.encoder = { identity, encode: async () => {
      const snapshot = experiment.index.exportSnapshot();
      snapshot.documents.forEach((document) => { document.vector = [1, 0]; });
      experiment.index.replace(snapshot);
      return [1, 0];
    } };
    const result = await retrieveIndependentCandidates(repository, brief(), experiment);
    expect(result.ids).toEqual([]);
    expect(result.diagnostics.status).toBe("error");
  });

  it("rejects a model identity change during asynchronous query encoding", async () => {
    const { repository, experiment } = setup();
    const mutableIdentity = { ...identity };
    experiment.encoder = { identity: mutableIdentity, encode: async () => {
      mutableIdentity.modelRevision = "changed-during-query";
      return [1, 0];
    } };
    const result = await retrieveIndependentCandidates(repository, brief(), experiment);
    expect(result.ids).toEqual([]);
    expect(result.diagnostics.status).toBe("error");
  });

});
