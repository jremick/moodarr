import { createHash } from "node:crypto";
import { validateModel } from "./linearModel";
import type { RankingModel } from "./types";
export interface JudgedCase<Request = unknown> {
  id: string;
  /** Split all paraphrases/variants of an intent together, not by individual row. */
  groupId: string;
  request: Request;
  grades: Record<string, number>;
  forbiddenItemIds: string[];
}
export interface CaseResult {
  id: string; groupId: string; ndcg: number | null; judgedPoolRecall: number | null;
  ndcgAt3: number | null; ndcgAt10: number | null;
  constraintViolations: number; returned: number; latencyMs: number;
}
export interface FinalEvaluation {
  stage: "final_product_response";
  k: number;
  cases: CaseResult[];
  meanNdcg: number | null;
  meanNdcgAt3: number | null;
  meanNdcgAt10: number | null;
  /** Binds requests, groups and judgments; catalogue/source identities belong to the run receipt. */
  casesSha256: string;
  violations: number;
  /** Final responses do not expose the pre-scoring candidate IDs. */
  candidateRecall: null;
}
export async function evaluateFinalResponses<Request>(engine: {
  recommend(request: Request, context?: { signal?: AbortSignal }): Promise<{ results: { id: string }[] }>
}, cases: readonly JudgedCase<Request>[], options: { k?: number; model?: RankingModel; signal?: AbortSignal } = {}): Promise<FinalEvaluation> {
  const k = options.k ?? 5;
  if (!Number.isInteger(k) || k < 1 || k > 200 || !cases.length || cases.length > 10_000
    || new Set(cases.map((entry) => entry.id)).size !== cases.length) throw new Error("invalid_evaluation_cases");
  const trainingGroups = new Set(options.model ? validateModel(options.model).trainingGroupIds : []);
  // Validate the complete split before making any engine calls.
  for (const entry of cases) {
    if (!entry.id || !entry.groupId || trainingGroups.has(entry.groupId)) throw new Error("invalid_or_leaked_evaluation_group");
    if (!entry.grades || Array.isArray(entry.grades) || !Object.keys(entry.grades).length
      || Object.values(entry.grades).some((grade) => !Number.isInteger(grade) || grade < 0 || grade > 3)
      || !Array.isArray(entry.forbiddenItemIds) || entry.forbiddenItemIds.some((id) => typeof id !== "string" || !id)) throw new Error("invalid_judgments");
  }
  const results: CaseResult[] = [];
  for (const entry of cases) {
    options.signal?.throwIfAborted();
    const started = performance.now();
    const response = await engine.recommend(entry.request, { signal: options.signal });
    options.signal?.throwIfAborted();
    const returned = response.results.map((item) => item.id);
    if (new Set(returned).size !== returned.length) throw new Error("duplicate_final_result");
    if (returned.some((id) => !Object.prototype.hasOwnProperty.call(entry.grades, id))) throw new Error("unjudged_final_result");
    const ideal = Object.values(entry.grades).sort((a, b) => b - a);
    const dcg = (grades: number[]) => grades.reduce((sum, grade, rank) => sum + (2 ** grade - 1) / Math.log2(rank + 2), 0);
    const ndcgAt = (cutoff: number) => {
      const idcg = dcg(ideal.slice(0, cutoff));
      return idcg ? dcg(returned.slice(0, cutoff).map((id) => entry.grades[id])) / idcg : null;
    };
    const relevant = Object.entries(entry.grades).filter(([, grade]) => grade > 0).length;
    const forbidden = new Set(entry.forbiddenItemIds);
    results.push({ id: entry.id, groupId: entry.groupId,
      ndcg: ndcgAt(k), ndcgAt3: ndcgAt(3), ndcgAt10: ndcgAt(10),
      judgedPoolRecall: relevant ? returned.slice(0, k).filter((id) => entry.grades[id] > 0).length / relevant : null,
      constraintViolations: returned.filter((id) => forbidden.has(id)).length,
      returned: returned.length, latencyMs: performance.now() - started });
  }
  const aggregate = (key: "ndcg" | "ndcgAt3" | "ndcgAt10") => {
    const graded = results.flatMap((entry) => entry[key] === null ? [] : [entry[key]]);
    return graded.length ? mean(graded) : null;
  };
  const casesSha256 = createHash("sha256").update(JSON.stringify(
    [...cases].sort((a, b) => a.id.localeCompare(b.id)).map((entry) => ({ ...entry, forbiddenItemIds: [...entry.forbiddenItemIds].sort() })),
    (_key, value) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))) : value
  )).digest("hex");
  return { stage: "final_product_response", k, cases: results,
    meanNdcg: aggregate("ndcg"), meanNdcgAt3: aggregate("ndcgAt3"), meanNdcgAt10: aggregate("ndcgAt10"), casesSha256,
    violations: results.reduce((sum, entry) => sum + entry.constraintViolations, 0), candidateRecall: null };
}
/** Paired, group-balanced bootstrap; no reuse of individual paraphrases as independent samples. */
export function compareFinalEvaluations(baseline: FinalEvaluation, candidate: FinalEvaluation, repeats = 2000) {
  if (baseline.stage !== "final_product_response" || candidate.stage !== baseline.stage || baseline.k !== candidate.k
    || baseline.casesSha256 !== candidate.casesSha256
    || baseline.cases.length !== candidate.cases.length || !Number.isInteger(repeats) || repeats < 100 || repeats > 10_000) throw new Error("incompatible_evaluations");
  const base = new Map(baseline.cases.map((entry) => [entry.id, entry]));
  if (base.size !== baseline.cases.length || new Set(candidate.cases.map((entry) => entry.id)).size !== candidate.cases.length) throw new Error("duplicate_evaluation_case");
  const differences = new Map<string, number[]>();
  for (const entry of candidate.cases) {
    const previous = base.get(entry.id);
    if (!previous || entry.groupId !== previous.groupId || (entry.ndcg === null) !== (previous.ndcg === null)) throw new Error("unpaired_evaluation_case");
    if (entry.ndcg === null || previous.ndcg === null) continue;
    const values = differences.get(entry.groupId) ?? [];
    values.push(entry.ndcg - previous.ndcg); differences.set(entry.groupId, values);
  }
  const groups = [...differences].sort(([a], [b]) => a.localeCompare(b)).map(([, values]) => mean(values));
  if (!groups.length) throw new Error("no_graded_evaluation_groups");
  let seed = 0x58a72b19;
  const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2 ** 32; };
  const samples = Array.from({ length: repeats }, () => mean(groups.map(() => groups[Math.floor(random() * groups.length)]))).sort((a, b) => a - b);
  return { groupCount: groups.length, groupBalancedMeanDelta: mean(groups),
    lower95: samples[Math.floor(repeats * 0.025)], upper95: samples[Math.min(repeats - 1, Math.floor(repeats * 0.975))],
    constraintDelta: candidate.violations - baseline.violations,
    deploymentApproved: false as const };
}
function mean(values: number[]) { return values.reduce((sum, value) => sum + value, 0) / values.length; }
