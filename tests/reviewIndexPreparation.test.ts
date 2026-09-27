import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPackedIndexFromInputs, prepareSemanticShards } from "../src/server/recommendation/review/prepareIndex";
import { writeSemanticShardStore, loadSemanticShardStore } from "../src/server/recommendation/review/semanticShardStore";
const identity = { model: "explicit-test", modelRevision: "pinned", preprocessingVersion: "v1", featureVersion: "features-v1", dimensions: 3 };
const budget = { maximumDocuments: 1000, maximumVectorBytes: 1_000_000 };
const inputs = Array.from({ length: 65 }, (_, index) => ({ itemId: String(index), featureText: `test description ${index}`, featureVersion: identity.featureVersion }));
const encoder = (calls: number[] = []) => ({ identity, encode: async () => [1, 0, 0], encodeDocuments: async (texts: string[]) => { calls.push(texts.length); return texts.map(() => [1, 0, 0]); } });
const collect = async <T>(values: AsyncIterable<T>) => { const result: T[] = []; for await (const value of values) result.push(value); return result; };
const documents = [{ itemId: "one", inputHash: "a".repeat(64), vector: [1, 0, 0] }];
async function temporary(run: (directory: string) => Promise<void>) { const root = await mkdtemp(join(tmpdir(), "moodarr-review-")); try { await run(root); } finally { await rm(root, { recursive: true, force: true }); } }
describe("explicit index preparation", () => {
  it("batches according to the existing encoder contract", async () => { const calls: number[] = []; assert.equal((await buildPackedIndexFromInputs(inputs, encoder(calls), budget)).size, 65); assert.deepEqual(calls, [32, 32, 1]); });
  it("uses the production feature-text SHA-256 convention", async () => { const index = await buildPackedIndexFromInputs(inputs.slice(0, 1), encoder(), budget); assert.equal(index.documentInputHash("0"), createHash("sha256").update(inputs[0].featureText).digest("hex")); });
  it("rejects stale feature versions before inference", async () => { const calls: number[] = []; await assert.rejects(buildPackedIndexFromInputs([{ ...inputs[0], featureVersion: "old" }], encoder(calls), budget)); assert.equal(calls.length, 0); });
  it("enforces count budgets before extra inference", async () => { const calls: number[] = []; await assert.rejects(buildPackedIndexFromInputs(inputs, encoder(calls), { ...budget, maximumDocuments: 1 })); assert.equal(calls.length, 0); });
  it("rejects duplicates before producing ambiguous snapshots", async () => await assert.rejects(buildPackedIndexFromInputs([inputs[0], inputs[0]], encoder(), budget)));
  it("rejects encoder count mismatches", async () => await assert.rejects(buildPackedIndexFromInputs(inputs.slice(0, 2), { ...encoder(), encodeDocuments: async () => [[1, 0, 0]] }, budget)));
  it("rejects invalid encoder vectors", async () => await assert.rejects(buildPackedIndexFromInputs(inputs.slice(0, 1), { ...encoder(), encodeDocuments: async () => [[0, 0, 0]] }, budget)));
  it("rejects model identity changes during inference", async () => { const mutable = { ...identity }; const bad = { ...encoder(), identity: mutable, encodeDocuments: async () => { mutable.modelRevision = "changed"; return [[1, 0, 0]]; } }; await assert.rejects(buildPackedIndexFromInputs(inputs.slice(0, 1), bad, budget)); });
  it("respects individual text byte bounds", async () => await assert.rejects(buildPackedIndexFromInputs([{ ...inputs[0], featureText: "x".repeat(65_537) }], encoder(), budget)));
  it("uses bounded aggregate input batches", async () => { const calls: number[] = []; await buildPackedIndexFromInputs(inputs.slice(0, 9).map(input => ({ ...input, featureText: "x".repeat(65_536) })), encoder(calls), budget); assert.deepEqual(calls, [8, 1]); });
  it("supports explicit preparation without activating an index", async () => assert.equal((await collect(prepareSemanticShards(inputs.slice(0, 1), encoder(), budget))).length, 1));
  it("handles an empty input without invoking a model", async () => { const calls: number[] = []; assert.equal((await buildPackedIndexFromInputs([], encoder(calls), budget)).size, 0); assert.equal(calls.length, 0); });
});
describe("private, integrity-checked shard storage", () => {
  it("round-trips a prepared index", async () => temporary(async root => { const manifest = await writeSemanticShardStore(join(root, "index"), identity, [documents], budget); const index = await loadSemanticShardStore(manifest, identity, budget); assert.equal(index.size, 1); assert.equal((await index.search([1, 0, 0], [])).queryHits[0].itemId, "one"); }));
  it("does not overwrite existing stores", async () => temporary(async root => { await assert.rejects(writeSemanticShardStore(root, identity, [], budget)); }));
  it("uses private file and directory permissions", async () => temporary(async root => { const path = join(root, "index"), manifest = await writeSemanticShardStore(path, identity, [documents], budget); assert.equal((await stat(path)).mode & 0o777, 0o700); assert.equal((await stat(manifest)).mode & 0o777, 0o600); }));
  it("rejects tampered vector files", async () => temporary(async root => { const manifest = await writeSemanticShardStore(join(root, "index"), identity, [documents], budget); await writeFile(join(root, "index", "part-000000.json"), "[]"); await assert.rejects(loadSemanticShardStore(manifest, identity, budget)); }));
  it("rejects a different model identity", async () => temporary(async root => { const manifest = await writeSemanticShardStore(join(root, "index"), identity, [documents], budget); await assert.rejects(loadSemanticShardStore(manifest, { ...identity, modelRevision: "other" }, budget)); }));
  it("rejects traversal paths in a manifest", async () => temporary(async root => { const manifest = await writeSemanticShardStore(join(root, "index"), identity, [documents], budget); const value = JSON.parse(await readFile(manifest, "utf8")); value.shards[0].file = "../escape.json"; await writeFile(manifest, JSON.stringify(value)); await assert.rejects(loadSemanticShardStore(manifest, identity, budget)); }));
  it("does not follow a shard symlink", async () => temporary(async root => { const manifest = await writeSemanticShardStore(join(root, "index"), identity, [documents], budget); const part = join(root, "index", "part-000000.json"), contents = await readFile(part); await rm(part); await writeFile(join(root, "external.json"), contents); await symlink(join(root, "external.json"), part); await assert.rejects(loadSemanticShardStore(manifest, identity, budget)); }));
  it("rejects count metadata mismatches", async () => temporary(async root => { const manifest = await writeSemanticShardStore(join(root, "index"), identity, [documents], budget); const value = JSON.parse(await readFile(manifest, "utf8")); value.documents = 2; await writeFile(manifest, JSON.stringify(value)); await assert.rejects(loadSemanticShardStore(manifest, identity, budget)); }));
  it("fails closed on duplicate documents across files", async () => temporary(async root => { const directory = join(root, "index"); await assert.rejects(writeSemanticShardStore(directory, identity, [documents, documents], budget)); await assert.rejects(readFile(join(directory, "manifest.json"))); }));
  it("pins caller-owned model identity across asynchronous preparation", async () => temporary(async root => {
    const mutable = { ...identity };
    async function* input() { mutable.modelRevision = "changed"; yield documents; }
    const manifest = await writeSemanticShardStore(join(root, "index"), mutable, input(), budget);
    assert.equal((await loadSemanticShardStore(manifest, identity, budget)).identity.modelRevision, identity.modelRevision);
  }));
  it("rejects oversized batches before large JSON allocation", async () => temporary(async root => {
    const largeIdentity = { ...identity, dimensions: 4096 };
    const input = Array.from({ length: 129 }, (_, index) => ({ ...documents[0], itemId: String(index), vector: new Array(4096).fill(1) }));
    await assert.rejects(writeSemanticShardStore(join(root, "index"), largeIdentity, [input], { maximumDocuments: 1000, maximumVectorBytes: 16_384_000 }), /scalar_limit/);
  }));
  it("rejects a non-array shard instead of silently dropping it", async () => temporary(async root => {
    await assert.rejects(writeSemanticShardStore(join(root, "index"), identity, [null as unknown as typeof documents], budget), /invalid_semantic_shard/);
  }));

});

describe("index preparation async boundary invariants", () => {
  it("pins the document budget before asynchronous input changes it", async () => {
    const mutableBudget = { ...budget, maximumDocuments: 1 };
    const calls: number[] = [];
    async function* source() {
      yield inputs[0];
      mutableBudget.maximumDocuments = 1000;
      yield inputs[1];
    }
    await assert.rejects(collect(prepareSemanticShards(source(), encoder(calls), mutableBudget)), /packed_semantic_resource_limit/);
    assert.deepEqual(calls, []);
  });

  it("pins the vector-byte budget before asynchronous input changes it", async () => {
    const mutableBudget = { ...budget, maximumVectorBytes: identity.dimensions * 4 };
    const calls: number[] = [];
    async function* source() {
      yield inputs[0];
      mutableBudget.maximumVectorBytes = budget.maximumVectorBytes;
      yield inputs[1];
    }
    await assert.rejects(collect(prepareSemanticShards(source(), encoder(calls), mutableBudget)), /packed_semantic_resource_limit/);
    assert.deepEqual(calls, []);
  });

  it("pins the build budget before a lazy generator starts inference", async () => {
    const mutableBudget = { ...budget, maximumDocuments: 1 };
    const calls: number[] = [];
    const building = buildPackedIndexFromInputs(inputs.slice(0, 2), encoder(calls), mutableBudget);
    mutableBudget.maximumDocuments = 1000;
    await assert.rejects(building, /packed_semantic_resource_limit/);
    assert.deepEqual(calls, []);
  });

  it("rejects encoder replacement between build start and lazy generator execution", async () => {
    const calls: number[] = [];
    const mutableEncoder = { ...encoder(calls), identity: { ...identity } };
    const building = buildPackedIndexFromInputs(inputs.slice(0, 1), mutableEncoder, budget);
    mutableEncoder.identity = { ...identity, modelRevision: "replacement" };
    await assert.rejects(building, /encoder_identity_changed/);
    assert.deepEqual(calls, []);
  });

  it("checks encoder identity when an empty asynchronous input completes", async () => {
    const mutableEncoder = { ...encoder(), identity: { ...identity } };
    const empty: AsyncIterable<typeof inputs[number]> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            mutableEncoder.identity.modelRevision = "changed";
            return { done: true as const, value: undefined };
          }
        };
      }
    };
    await assert.rejects(collect(prepareSemanticShards(empty, mutableEncoder, budget)), /encoder_identity_changed/);
  });

  it("checks encoder identity again after the consumer resumes the final shard", async () => {
    const mutableEncoder = { ...encoder(), identity: { ...identity } };
    const shards = prepareSemanticShards(inputs.slice(0, 1), mutableEncoder, budget);
    const first = await shards.next();
    assert.equal(first.done, false);
    mutableEncoder.identity.modelRevision = "changed";
    await assert.rejects(shards.next(), /encoder_identity_changed/);
  });

  it("honours cancellation after the last shard before reporting completion", async () => {
    const controller = new AbortController();
    const shards = prepareSemanticShards(inputs.slice(0, 1), encoder(), budget, controller.signal);
    const first = await shards.next();
    assert.equal(first.done, false);
    controller.abort();
    await assert.rejects(shards.next(), { name: "AbortError" });
  });
});
