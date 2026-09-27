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

// Coverage belongs to the displayed response, independently of the metric cutoff.
describe("complete displayed-slate evaluation", () => {
  const ids = Array.from({ length: 10 }, (_, index) => `item-${index}`);
  const one: JudgedCase<string> = { id: "slate", groupId: "one-family", request: "ten results",
    grades: Object.fromEntries(ids.map((id, index) => [id, index === 0 || index === 3 ? 3 : 0])), forbiddenItemIds: [ids[9]] };
  const response = (returned = ids) => ({ recommend: async () => ({ results: returned.map(id => ({ id })) }) });
  it.each([3, 9])("rejects an unjudged displayed result at index %s beyond NDCG@3", async index => {
    const grades = { ...one.grades }; delete grades[ids[index]];
    await assert.rejects(evaluateFinalResponses(response(), [{ ...one, grades }], { k: 3 }), /unjudged_final_result/);
  });
  it("rejects a duplicate beyond the metric cutoff", async () => {
    await assert.rejects(evaluateFinalResponses(response([...ids.slice(0, 9), ids[0]]), [one], { k: 3 }), /duplicate_final_result/);
  });
  it("measures both cutoffs once and counts violations across all displayed results", async () => {
    let calls = 0;
    const result = await evaluateFinalResponses({ recommend: async () => { calls++; return response().recommend(); } }, [one], { k: 3 });
    assert.equal(calls, 1);
    assert.equal(result.cases[0].returned, 10);
    assert.equal(result.violations, 1);
    assert.equal(result.meanNdcgAt3, 1 / (1 + 1 / Math.log2(3)));
    assert.ok(Math.abs(result.meanNdcgAt10! - 0.8772153153380493) < 1e-12);
    assert.equal(result.meanNdcg, result.meanNdcgAt3);
  });
  it.each(["request", "judgments"])("rejects paired comparisons after changing %s under the same case IDs", async change => {
    const baseline = await evaluateFinalResponses(response(), [one], { k: 3 });
    const changed = change === "request" ? { ...one, request: "different request" } : { ...one, grades: { ...one.grades, [ids[1]]: 2 } };
    const candidate = await evaluateFinalResponses(response(), [changed], { k: 3 });
    assert.throws(() => compareFinalEvaluations(baseline, candidate), /incompatible_evaluations/);
  });
});
