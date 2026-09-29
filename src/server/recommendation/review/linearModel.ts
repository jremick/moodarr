import { createHash } from "node:crypto";
import { defaultWeights, featureKeys, type RankingFeatures, type RankingModel, type RankContribution } from "./types";
export const featureVersion = "moodarr-review-features-v1" as const;
export function rankingModelSuffix(model?: RankingModel) {
  if (!model) return "";
  const valid = validateModel(model);
  const digest = createHash("sha256").update(JSON.stringify([valid.featureVersion, featureKeys.map(key => valid.weights[key]), valid.trainingDigest])).digest("hex");
  return `+review-model-${digest.slice(0, 16)}`;
}
export function validateFeatures(values: RankingFeatures) {
  if (!values || Object.keys(values).length !== featureKeys.length || featureKeys.some((key) => !Number.isFinite(values[key]) || values[key] < 0 || values[key] > 100)) throw new Error("invalid_ranking_features");
}
export function validateModel(model: RankingModel): RankingModel {
  if (!model || model.schemaVersion !== "moodarr-review-linear-v1" || model.featureVersion !== featureVersion || !model.weights
    || Object.keys(model.weights).length !== featureKeys.length || featureKeys.some((key) => !Number.isFinite(model.weights[key]) || model.weights[key] < 0)
    || Math.abs(featureKeys.reduce((sum, key) => sum + model.weights[key], 0) - 1) > 1e-8
    || !/^[a-f0-9]{64}$/.test(model.trainingDigest) || !Array.isArray(model.trainingGroupIds)
    || model.trainingGroupIds.some((id) => typeof id !== "string" || !id || id.length > 256)
    || new Set(model.trainingGroupIds).size !== model.trainingGroupIds.length) throw new Error("invalid_ranking_model");
  return { ...model, weights: { ...model.weights }, trainingGroupIds: [...model.trainingGroupIds] };
}
export function scoreLinear(features: RankingFeatures, model?: RankingModel): { score: number; contributions: RankContribution[] } {
  validateFeatures(features);
  const weights = model ? validateModel(model).weights : defaultWeights;
  const contributions = featureKeys.map((feature) => ({ feature, value: features[feature], weight: weights[feature], contribution: weights[feature] * features[feature] }));
  return { score: contributions.reduce((sum, entry) => sum + entry.contribution, 0), contributions };
}
export interface PairwiseJudgment { groupId: string; better: RankingFeatures; worse: RankingFeatures }
export function fitPairwiseModel(rows: readonly PairwiseJudgment[], options: { epochs?: number; learningRate?: number; regularization?: number } = {}): RankingModel {
  const epochs = options.epochs ?? 200, rate = options.learningRate ?? 0.1, regularization = options.regularization ?? 0.1;
  if (!rows.length || rows.length > 100_000 || !Number.isInteger(epochs) || epochs < 1 || epochs > 1000
    || !Number.isFinite(rate) || rate <= 0 || rate > 1 || !Number.isFinite(regularization) || regularization < 0 || regularization > 10) throw new Error("invalid_training_budget");
  for (const row of rows) {
    if (!row.groupId || typeof row.groupId !== "string" || row.groupId.length > 256) throw new Error("invalid_training_group");
    validateFeatures(row.better); validateFeatures(row.worse);
  }
  // Full-batch, group-balanced gradients are order-independent and stop long
  // feedback sessions from outweighing all other requests solely by row count.
  const groupCounts = new Map<string, number>();
  rows.forEach((row) => groupCounts.set(row.groupId, (groupCounts.get(row.groupId) ?? 0) + 1));
  const weights = { ...defaultWeights };
  const ordered = [...rows].sort((a, b) => canonical(a).localeCompare(canonical(b)));
  for (let epoch = 0; epoch < epochs; epoch += 1) {
    const gradient = Object.fromEntries(featureKeys.map((key) => [key, 0])) as RankingFeatures;
    for (const row of ordered) {
      const margin = featureKeys.reduce((sum, key) => sum + weights[key] * (row.better[key] - row.worse[key]) / 100, 0);
      const multiplier = -1 / (1 + Math.exp(margin)) / groupCounts.get(row.groupId)! / groupCounts.size;
      for (const key of featureKeys) gradient[key] += multiplier * (row.better[key] - row.worse[key]) / 100;
    }
    const proposed = featureKeys.map((key) => weights[key] - rate * (gradient[key] + regularization * (weights[key] - defaultWeights[key])));
    const projected = simplex(proposed);
    featureKeys.forEach((key, index) => weights[key] = projected[index]);
  }
  const trainingGroupIds = [...groupCounts.keys()].sort();
  return validateModel({ schemaVersion: "moodarr-review-linear-v1", featureVersion, weights, trainingGroupIds,
    trainingDigest: createHash("sha256").update(ordered.map(canonical).join("\n")).digest("hex") });
}
function canonical(row: PairwiseJudgment) { return JSON.stringify([row.groupId, featureKeys.map((key) => row.better[key]), featureKeys.map((key) => row.worse[key])]); }
function simplex(values: number[]): number[] {
  const sorted = [...values].sort((a, b) => b - a);
  let sum = 0, threshold = 0;
  for (let index = 0; index < sorted.length; index += 1) {
    sum += sorted[index]; const next = (sum - 1) / (index + 1);
    if (sorted[index] > next) threshold = next;
  }
  return values.map((value) => Math.max(0, value - threshold));
}
