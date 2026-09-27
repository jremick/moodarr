import { describe, it } from "vitest";
import assert from "node:assert/strict";
import { evaluateFinalResponses, compareFinalEvaluations, type JudgedCase } from "../src/server/recommendation/review/evaluation";
import { fitPairwiseModel } from "../src/server/recommendation/review/linearModel";
import { featureKeys, type RankingFeatures } from "../src/server/recommendation/review/types";
const examples: JudgedCase<string>[] = [
  { id: "one", groupId: "heldout-one", request: "first", grades: { a: 3, b: 1, c: 0 }, forbiddenItemIds: ["c"] },
  { id: "two", groupId: "heldout-two", request: "second", grades: { a: 1, b: 3, c: 0 }, forbiddenItemIds: ["c"] }
];
const engine = { recommend: async (request: string) => ({ results: (request === "first" ? ["a", "b"] : ["b", "a"]).map(id => ({ id })) }) };
describe("final-product evaluation", () => {
  it("evaluates the returned product order", async () => assert.equal((await evaluateFinalResponses(engine, examples, { k: 2 })).meanNdcg, 1));
  it("does not invent candidate recall from final results", async () => assert.equal((await evaluateFinalResponses(engine, examples)).candidateRecall, null));
  it("keeps judged-pool recall distinct from catalogue recall", async () => assert.equal((await evaluateFinalResponses(engine, examples, { k: 1 })).cases[0].judgedPoolRecall, 0.5));
  it("fails closed on unjudged returned titles", async () => await assert.rejects(evaluateFinalResponses({ recommend: async () => ({ results: [{ id: "unknown" }] }) }, examples)));
  it("rejects duplicate returned titles", async () => await assert.rejects(evaluateFinalResponses({ recommend: async () => ({ results: [{ id: "a" }, { id: "a" }] }) }, examples)));
  it("counts hard exclusions separately", async () => assert.equal((await evaluateFinalResponses({ recommend: async () => ({ results: [{ id: "c" }] }) }, examples)).violations, 2));
  it("penalizes empty results when judged matches exist", async () => assert.equal((await evaluateFinalResponses({ recommend: async () => ({ results: [] }) }, examples)).meanNdcg, 0));
  it("does not invent NDCG for a query with no judged positive", async () => assert.equal((await evaluateFinalResponses(engine, [{ ...examples[0], grades: { a: 0, b: 0 } }])).meanNdcg, null));
  it("rejects invalid judgment scales", async () => await assert.rejects(evaluateFinalResponses(engine, [{ ...examples[0], grades: { a: 4 } }])));
  it("rejects repeated case IDs", async () => await assert.rejects(evaluateFinalResponses(engine, [examples[0], examples[0]])));
  it("rejects training/holdout leakage before running the engine", async () => {
    let calls = 0; const f = Object.fromEntries(featureKeys.map(key => [key, 50])) as RankingFeatures;
    const model = fitPairwiseModel([{ groupId: examples[0].groupId, better: f, worse: f }]);
    await assert.rejects(evaluateFinalResponses({ recommend: async () => { calls++; return { results: [] }; } }, examples, { model })); assert.equal(calls, 0);
  });
  it("observes cancellation before engine execution", async () => { const controller = new AbortController(); controller.abort(); await assert.rejects(evaluateFinalResponses(engine, examples, { signal: controller.signal })); });
  it("compares paired identical arms without an invented lift", async () => { const result = await evaluateFinalResponses(engine, examples); const comparison = compareFinalEvaluations(result, result); assert.equal(comparison.groupBalancedMeanDelta, 0); assert.equal(comparison.lower95, 0); assert.equal(comparison.upper95, 0); });
  it("does not automatically approve deployment", async () => { const result = await evaluateFinalResponses(engine, examples); assert.equal(compareFinalEvaluations(result, result).deploymentApproved, false); });
  it("requires matched case identities", async () => { const result = await evaluateFinalResponses(engine, examples); assert.throws(() => compareFinalEvaluations(result, { ...result, cases: result.cases.map(entry => ({ ...entry, id: entry.id + "other" })) })); });
  it("uses intent groups rather than rows as bootstrap units", async () => { const result = await evaluateFinalResponses(engine, [examples[0], { ...examples[0], id: "paraphrase" }]); assert.equal(compareFinalEvaluations(result, result).groupCount, 1); });
});
