import { parseBlindCaseSet, sha256Text } from "./moodrank-independent-eval-contract";
import { prepareSemanticQueries, type PreparedSemanticDocument, type IndependentRankingArm } from "./moodrank-precomputed-semantic";
import { independentPositiveQuery } from "../src/server/recommendation/independentRetrieval";
import { reviewCandidateRankingExperiments } from "../src/server/recommendation/rankingExperiments";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { assertColdCatalogSnapshot, assertPrivateOutputOutsideRepository, sha256File, buildIndependentCasePlan } from "./evaluate-moodrank-independent";
import { OllamaLocalEncoder, type OllamaLocalEncoderOptions } from "../src/server/recommendation/ollamaLocalEncoder";
import { prepareLocalSemanticSnapshot, type LocalSemanticInput } from "../src/server/recommendation/localSemanticPreparation";
import { FEATURE_VERSION } from "../src/server/recommendation/features";
import type { LocalSemanticSnapshot } from "../src/server/recommendation/localSemanticIndex";

export interface PreparationArgs { catalog: string; config: string; output: string; previous?: string; cases?: string; rankingArm?: IndependentRankingArm }
export function parsePreparationArgs(values: string[]): PreparationArgs {
  const result: Record<string, string> = {};
  for (let i = 0; i < values.length; i += 2) {
    const name = values[i].replace(/^--/, "");
    if (!values[i].startsWith("--") || !["catalog", "config", "output", "previous", "cases", "ranking-arm"].includes(name)
      || result[name] || !values[i + 1] || values[i + 1].startsWith("--")) throw new Error("invalid_preparation_arguments");
    if (name === "ranking-arm") {
      if (!["repaired-default", "review-candidate"].includes(values[i + 1])) throw new Error("invalid_preparation_ranking_arm");
      result[name] = values[i + 1];
    } else result[name] = resolve(values[i + 1]);
  }
  if (!result.catalog || !result.config || !result.output) throw new Error("missing_preparation_arguments");
  if (Boolean(result.cases) !== Boolean(result["ranking-arm"])) throw new Error("preparation_cases_require_explicit_arm");
  return { catalog: result.catalog, config: result.config, output: result.output, previous: result.previous, cases: result.cases, rankingArm: result["ranking-arm"] as IndependentRankingArm | undefined };
}
export async function runLocalSemanticPreparation(args: PreparationArgs, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (Boolean(args.cases) !== Boolean(args.rankingArm) || (args.rankingArm && !["repaired-default", "review-candidate"].includes(args.rankingArm))) throw new Error("invalid_preparation_ranking_arm");
  assertColdCatalogSnapshot(args.catalog);
  assertPrivateOutputOutsideRepository(args.output);
  if (existsSync(args.output)) throw new Error("preparation_output_already_exists");
  const config = readJson(args.config, 16_384) as Record<string, unknown>;
  if (!config || typeof config !== "object" || Array.isArray(config)
    || Object.keys(config).some((key) => !["baseUrl", "model", "digest", "dimensions", "offlineRuntimeConfirmed", "timeoutMs"].includes(key))) throw new Error("invalid_preparation_config");
  const encoder = new OllamaLocalEncoder(config as unknown as OllamaLocalEncoderOptions);
  const previous = args.previous ? readJson(args.previous, 134_217_728) as { schemaVersion: string; snapshot: LocalSemanticSnapshot } : undefined;
  if (previous && previous.schemaVersion !== "moodrank-prepared-local-semantic-v1") throw new Error("invalid_previous_preparation");
  const catalogSha256 = await sha256File(args.catalog);
  const casesRaw = args.cases ? readText(args.cases, 8_388_608) : undefined;
  const caseSet = casesRaw ? parseBlindCaseSet(casesRaw) : undefined;
  if (caseSet && caseSet.catalogSnapshotId !== `sha256:${catalogSha256}`) throw new Error("preparation_cases_catalog_mismatch");
  const db = new DatabaseSync(`${pathToFileURL(args.catalog).href}?immutable=1`, { readOnly: true, allowExtension: false });
  const temporaryOutput = `${args.output}.${randomUUID()}.tmp`;
  try {
    db.exec("PRAGMA query_only = ON");
    const count = Number((db.prepare("SELECT count(*) AS n FROM media_items").get() as { n: number }).n);
    if (count > 50_000 || count * encoder.identity.dimensions > 4_000_000) throw new Error("local_semantic_resource_limit");
    const valid = Number((db.prepare("SELECT count(*) AS n FROM media_features f JOIN media_items m ON m.id = f.media_item_id WHERE f.feature_version = ? AND length(trim(f.feature_text)) > 0").get(FEATURE_VERSION) as { n: number }).n);
    if (valid !== count) throw new Error("local_preparation_requires_current_complete_features");
    const rows = db.prepare("SELECT f.media_item_id AS itemId, f.feature_text AS featureText, f.feature_version AS featureVersion FROM media_features f JOIN media_items m ON m.id = f.media_item_id ORDER BY f.media_item_id");
    const result = await prepareLocalSemanticSnapshot(rows.iterate() as Iterable<LocalSemanticInput>, encoder, { previous: previous?.snapshot, signal });
    const evaluation = caseSet ? await prepareSemanticQueries(caseSet.cases.map((testCase) => independentPositiveQuery(buildIndependentCasePlan(testCase, args.rankingArm === "review-candidate" ? reviewCandidateRankingExperiments : {}).brief)), encoder, { casesSha256: sha256Text(casesRaw!), rankingArm: args.rankingArm! }, signal) : undefined;
    signal?.throwIfAborted();
    if (casesRaw && await sha256File(args.cases!) !== sha256Text(casesRaw).slice(7)) throw new Error("preparation_cases_changed");
    assertColdCatalogSnapshot(args.catalog);
    if (await sha256File(args.catalog) !== catalogSha256) throw new Error("preparation_catalog_changed");
    const output: PreparedSemanticDocument = { schemaVersion: "moodrank-prepared-local-semantic-v1", catalogSha256: `sha256:${catalogSha256}`, snapshot: result.snapshot, ...(evaluation ? { evaluation } : {}) };
    writeFileSync(temporaryOutput, JSON.stringify(output), { flag: "wx", mode: 0o600 });
    // Hard-link publication is atomic and fails if an output appeared meanwhile.
    linkSync(temporaryOutput, args.output);
    return { status: "prepared", counts: result.counts, catalogSha256: `sha256:${catalogSha256}`, outputSha256: `sha256:${await sha256File(args.output)}` };
  } finally { db.close(); if (existsSync(temporaryOutput)) unlinkSync(temporaryOutput); }
}
function readText(path: string, maximumBytes: number): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximumBytes) throw new Error("invalid_preparation_input_file");
  return readFileSync(path, "utf8");
}
function readJson(path: string, maximumBytes: number): unknown { return JSON.parse(readText(path, maximumBytes)); }
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  try { console.log(JSON.stringify(await runLocalSemanticPreparation(parsePreparationArgs(process.argv.slice(2)), controller.signal))); }
  catch (error) {
    const message = error instanceof Error ? error.message : "";
    const code = /^(?:local_|invalid_|missing_|preparation_|precomputed_)[a-z0-9_]+$/.test(message) ? message : "local_semantic_preparation_failed";
    console.error(JSON.stringify({ status: "failed", code })); process.exitCode = 1;
  }
}
