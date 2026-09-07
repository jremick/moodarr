import { describe, expect, it } from "vitest";
import { ExactLocalSemanticIndex, type LocalSemanticSnapshot } from "../src/server/recommendation/localSemanticIndex";
import { FEATURE_VERSION } from "../src/server/recommendation/features";

const identity = { model: "synthetic-test-only", modelRevision: "fixture-v1", preprocessingVersion: "fixture-text-v1", featureVersion: FEATURE_VERSION, dimensions: 2 };
const hash = "a".repeat(64);
function snapshot(): LocalSemanticSnapshot {
  return { schemaVersion: "moodrank-local-semantic-v1", identity: { ...identity }, documents: [
    { itemId: "b", inputHash: hash, vector: [1, 0] },
    { itemId: "a", inputHash: hash, vector: [1, 0] },
    { itemId: "c", inputHash: hash, vector: [0, 1] }
  ] };
}

describe("offline exact semantic index mechanics, not semantic quality", () => {
  it("searches a relevant long-tail target beyond 3,000 preceding records", async () => {
    const source = snapshot();
    source.documents = Array.from({ length: 3200 }, (_, index) => ({ itemId: `noise-${index}`, inputHash: hash, vector: [0, 1] }));
    source.documents.push({ itemId: "long-tail", inputHash: hash, vector: [1, 0] });
    expect((await new ExactLocalSemanticIndex(source).search([1, 0], [], 10)).queryHits.map((hit) => hit.itemId)).toEqual(["long-tail"]);
  });
  it("has deterministic ties independent of insertion order", async () => {
    const index = new ExactLocalSemanticIndex(snapshot());
    expect((await index.search([1, 0], [], 1)).queryHits.map((hit) => hit.itemId)).toEqual(["a"]);
  });
  it("normalises finite large vectors without overflow", async () => {
    const source = snapshot();
    source.documents[0].vector = [1e300, 0];
    expect((await new ExactLocalSemanticIndex(source).search([1e300, 0], [], 2)).queryHits).toHaveLength(2);
  });
  it("does not let external mutations alter a prepared index", async () => {
    const source = snapshot();
    const index = new ExactLocalSemanticIndex(source);
    source.documents[0].vector[0] = 0;
    index.exportSnapshot().documents[0].vector[0] = 0;
    expect((await index.search([1, 0], [], 2)).queryHits).toHaveLength(2);
  });
  it("replaces/deletes atomically and rejects a corrupt replacement without losing the current index", async () => {
    const index = new ExactLocalSemanticIndex(snapshot());
    const corrupt = snapshot();
    corrupt.documents[1].vector = [0, 0];
    expect(() => index.replace(corrupt)).toThrow();
    expect(index.size).toBe(3);
    const changed = snapshot();
    changed.documents = [changed.documents[2]];
    index.replace(changed);
    expect(index.size).toBe(1);
    expect((await index.search([1, 0], [], 2)).queryHits).toEqual([]);
  });
  it.each([[0, 0], [1], [NaN, 1], [Infinity, 1], ["1", 0]].map((vector) => ({ vector })))("rejects invalid stored vectors $vector", ({ vector }) => {
    const source = snapshot();
    source.documents[0].vector = vector as number[];
    expect(() => new ExactLocalSemanticIndex(source)).toThrow();
  });
  it("rejects duplicate IDs and invalid input hashes", () => {
    const source = snapshot();
    source.documents[1].itemId = "b";
    expect(() => new ExactLocalSemanticIndex(source)).toThrow();
    source.documents[1].itemId = "a";
    source.documents[1].inputHash = "not-a-hash";
    expect(() => new ExactLocalSemanticIndex(source)).toThrow();
  });
  it.each([0, 1.5, 4097])("rejects invalid dimensions %s", (dimensions) => {
    expect(() => new ExactLocalSemanticIndex({ ...snapshot(), identity: { ...identity, dimensions } })).toThrow();
  });
  it("keeps query and exemplar discovery in separate channels without duplicate-example accumulation", async () => {
    const index = new ExactLocalSemanticIndex(snapshot());
    const once = await index.search([0, 1], ["a"], 10);
    const duplicate = await index.search([0, 1], ["a", "a"], 10);
    expect(once).toEqual(duplicate);
    expect(once.queryHits.map((hit) => hit.itemId)).toEqual(["c"]);
    expect(once.exampleHits.map((hit) => hit.itemId)).toEqual(["a", "b"]);
  });
  it("propagates caller cancellation before and during a cooperative scan", async () => {
    const index = new ExactLocalSemanticIndex(snapshot());
    const pre = AbortSignal.abort(new Error("caller stopped"));
    await expect(index.search([1, 0], [], 10, pre)).rejects.toThrow("caller stopped");
    const controller = new AbortController();
    const search = index.search([1, 0], [], 10, controller.signal);
    controller.abort();
    await expect(search).rejects.toThrow();
  });
  it.each([0, 513, 1.2])("rejects an invalid result cap %s", async (limit) => {
    await expect(new ExactLocalSemanticIndex(snapshot()).search([1, 0], [], limit)).rejects.toThrow();
  });
  it("pins one immutable model snapshot across a concurrent replacement", async () => {
    const index = new ExactLocalSemanticIndex(snapshot());
    const pending = index.search([1, 0], [], 10);
    const replacement = snapshot();
    replacement.identity.modelRevision = "replacement";
    replacement.documents = [];
    index.replace(replacement);
    const result = await pending;
    expect(result.identity.modelRevision).toBe("fixture-v1");
    expect(result.queryHits.map((hit) => hit.itemId)).toEqual(["a", "b"]);
    expect(index.size).toBe(0);
  });
  it("enforces corpus and memory budgets before accepting an index", () => {
    const source = snapshot();
    source.documents = Array.from({ length: 50_001 }, () => source.documents[0]);
    expect(() => new ExactLocalSemanticIndex(source)).toThrow("local_semantic_resource_limit");
    source.documents = Array.from({ length: 1000 }, () => source.documents[0]);
    source.identity.dimensions = 4096;
    expect(() => new ExactLocalSemanticIndex(source)).toThrow("local_semantic_resource_limit");
  });

});
