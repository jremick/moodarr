import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { PackedLocalSemanticIndex } from "../src/server/recommendation/review/packedSemanticIndex";
const identity = { model: "test-local", modelRevision: "pinned-test", preprocessingVersion: "v1", featureVersion: "test-features", dimensions: 3 };
const hash = "a".repeat(64);
const doc = (itemId: string, vector: number[]) => ({ itemId, vector, inputHash: hash });
const budget = { maximumDocuments: 1000, maximumVectorBytes: 1_000_000 };
const build = (documents = [doc("x", [1, 0, 0]), doc("y", [0, 1, 0]), doc("z", [1, 1, 0])]) => PackedLocalSemanticIndex.fromShards(identity, [documents], budget);
describe("packed local semantic index", () => {
  it("returns nearest query matches", async () => assert.equal((await (await build()).search([1, 0, 0], [])).queryHits[0].itemId, "x"));
  it("finds neighbours of a positive example independently of the query", async () => assert.equal((await (await build()).search(undefined, ["y"])).exampleHits[0].itemId, "y"));
  it("returns an empty result without a query or reference", async () => assert.equal((await (await build()).search(undefined, [])).queryHits.length, 0));
  it("normalizes non-unit vectors", async () => { const result = await (await build([doc("x", [10, 0, 0])])).search([10, 0, 0], []); assert.ok(Math.abs(result.queryHits[0].similarity - 1) < 1e-6); });
  it("avoids overflow for huge finite values", async () => { const result = await (await build([doc("x", [1e308, 1e308, 0])])).search([1e308, 1e308, 0], []); assert.ok(result.queryHits[0].similarity > 0.999); });
  it("checks eligibility before top-k", async () => assert.deepEqual((await (await build()).search([1, 0, 0], [], 1, undefined, { eligibleIds: new Set(["z"]) })).queryHits.map((entry) => entry.itemId), ["z"]));
  it("deterministically breaks equal-similarity ties", async () => assert.equal((await (await build([doc("b", [1, 0, 0]), doc("a", [1, 0, 0])])).search([1, 0, 0], [], 1)).queryHits[0].itemId, "a"));
  it("does not retain caller-owned vector arrays", async () => { const vector = [1, 0, 0], index = await build([doc("x", vector)]); vector[0] = 0; assert.equal((await index.search([1, 0, 0], [])).queryHits[0].itemId, "x"); });
  it("identity getters cannot mutate the index", async () => { const index = await build(); index.identity.model = "changed"; assert.equal(index.identity.model, identity.model); });
  it("reports exact vector storage bytes", async () => assert.equal((await build()).vectorBytes, 3 * 3 * 4));
  it("retains input hashes for freshness validation", async () => assert.equal((await build()).documentInputHash("x"), hash));
  it("does not manufacture unknown reference IDs", async () => assert.equal((await (await build()).search(undefined, ["missing"])).exampleHits.length, 0));
  it("supports streamed shards", async () => { async function* shards() { yield [doc("x", [1, 0, 0])]; yield [doc("y", [0, 1, 0])]; } assert.equal((await PackedLocalSemanticIndex.fromShards(identity, shards(), budget)).size, 2); });
  it("rejects duplicate documents across shards", async () => await assert.rejects(PackedLocalSemanticIndex.fromShards(identity, [[doc("x", [1, 0, 0])], [doc("x", [0, 1, 0])]], budget)));
  it("rejects invalid dimensions", async () => await assert.rejects(PackedLocalSemanticIndex.fromShards({ ...identity, dimensions: 0 }, [], budget)));
  it("rejects vector-dimension mismatch", async () => await assert.rejects(build([doc("x", [1, 0])])));
  it("rejects zero vectors", async () => await assert.rejects(build([doc("x", [0, 0, 0])])));
  it("rejects non-finite vectors", async () => await assert.rejects(build([doc("x", [NaN, 0, 0])])));
  it("rejects sparse vectors", async () => {
    const sparse = new Array<number>(3);
    sparse[0] = 1;
    sparse[2] = 0;
    await assert.rejects(build([doc("x", sparse)]));
  });
  it("rejects stale malformed hash input", async () => await assert.rejects(build([{ ...doc("x", [1, 0, 0]), inputHash: "bad" }])));
  it("enforces vector byte budgets before allocation", async () => await assert.rejects(PackedLocalSemanticIndex.fromShards(identity, [[doc("x", [1, 0, 0]), doc("y", [1, 0, 0])]], { maximumDocuments: 2, maximumVectorBytes: 12 })));
  it("enforces document budgets", async () => await assert.rejects(PackedLocalSemanticIndex.fromShards(identity, [[doc("x", [1, 0, 0]), doc("y", [1, 0, 0])]], { ...budget, maximumDocuments: 1 })));
  it("requires finite bounded resource authorization", async () => await assert.rejects(PackedLocalSemanticIndex.fromShards(identity, [], { ...budget, maximumVectorBytes: Infinity })));
  it("respects a pre-aborted build", async () => { const controller = new AbortController(); controller.abort(); await assert.rejects(PackedLocalSemanticIndex.fromShards(identity, [], budget, controller.signal)); });
  it("respects search cancellation", async () => { const index = await build(), controller = new AbortController(); controller.abort(); await assert.rejects(index.search([1, 0, 0], [], 3, controller.signal)); });
  it("yields so cancellation during a search is observable", async () => { const index = await build(), controller = new AbortController(); const result = index.search([1, 0, 0], [], 3, controller.signal); controller.abort(); await assert.rejects(result); });
  it("rejects invalid top-k", async () => await assert.rejects((await build()).search([1, 0, 0], [], 0)));
  it("excludes non-positive dot products", async () => assert.equal((await (await build([doc("x", [-1, 0, 0])])).search([1, 0, 0], [])).queryHits.length, 0));
  it("matches exhaustive float32 scoring and sorting", async () => {
    const documents = Array.from({ length: 301 }, (_, i) => doc(String(i).padStart(4, "0"), [Math.sin(i + 1), Math.cos(i + 7), 0.7]));
    const index = await build(documents), query = [0.5, 0.8, 0.2];
    const normalize = (v: number[]) => { const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0)); return Float32Array.from(v, x => x / n); };
    const q = normalize(query);
    const expected = documents.map(d => ({ id: d.itemId, score: [...normalize(d.vector)].reduce((s, x, i) => s + x * q[i], 0) }))
      .filter(d => d.score > 0).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 17).map(d => d.id);
    assert.deepEqual((await index.search(query, [], 17)).queryHits.map(d => d.itemId), expected);
  });
  it("pins approved resource budgets before consuming asynchronous inputs", async () => {
    const mutable = { maximumDocuments: 1, maximumVectorBytes: 12 };
    async function* inputs() { mutable.maximumDocuments = 100; mutable.maximumVectorBytes = 1200; yield [doc("a", [1, 0, 0]), doc("b", [0, 1, 0])]; }
    await assert.rejects(PackedLocalSemanticIndex.fromShards(identity, inputs(), mutable), /resource_limit/);
  });
  it("pins the eligibility set for a complete search", async () => {
    const index = await build(), eligible = new Set(["x"]);
    const pending = index.search([1, 1, 0], [], 128, undefined, { eligibleIds: eligible });
    eligible.clear(); eligible.add("y");
    assert.deepEqual((await pending).queryHits.map(hit => hit.itemId), ["x"]);
  });

});
