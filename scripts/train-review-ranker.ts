/** Offline, explicitly invoked training only. Never called by app startup. */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fitPairwiseModel, type PairwiseJudgment } from "../src/server/recommendation/review/linearModel";
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== "--input" || args[2] !== "--output") throw new Error("Usage: npx tsx scripts/train-review-ranker.ts --input PRIVATE_SPLIT.json --output NEW_MODEL.json");
const input = resolve(args[1]), output = resolve(args[3]);
if (input === output || statSync(input).size > 10 * 1024 * 1024) throw new Error("invalid_training_input");
const data = JSON.parse(readFileSync(input, "utf8")) as { training: PairwiseJudgment[]; heldOutGroupIds: string[] };
if (!Array.isArray(data.training) || !Array.isArray(data.heldOutGroupIds) || !data.heldOutGroupIds.length
  || data.heldOutGroupIds.some((id) => typeof id !== "string" || !id)) throw new Error("a_predeclared_holdout_is_required");
const heldOut = new Set(data.heldOutGroupIds);
if (data.training.some((row) => heldOut.has(row.groupId))) throw new Error("training_holdout_leakage");
const model = fitPairwiseModel(data.training);
writeFileSync(output, JSON.stringify(model, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ trainedGroups: model.trainingGroupIds.length, trainingDigest: model.trainingDigest, activated: false }));
