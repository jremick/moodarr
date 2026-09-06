import { chmodSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evaluateModelSelection,
  parseModelSelectionManifest,
  type ModelSelectionManifest
} from "./moodrank-model-selection-contract";

export interface ModelSelectionCliArgs {
  manifestPath: string;
  outputPath: string;
}

export function parseModelSelectionCliArgs(argv: string[]): ModelSelectionCliArgs {
  const values = new Map<string, string>();
  const allowed = new Set(["--manifest", "--output"]);
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!option || !allowed.has(option)) throw new Error(`unknown_option:${option ?? "missing"}`);
    if (!value || value.startsWith("--")) throw new Error(`missing_value:${option}`);
    if (values.has(option)) throw new Error(`duplicate_option:${option}`);
    values.set(option, value);
  }
  const manifestPath = values.get("--manifest");
  const outputPath = values.get("--output");
  if (!manifestPath) throw new Error("manifest_path_required");
  if (!outputPath) throw new Error("output_path_required");
  return { manifestPath: resolve(manifestPath), outputPath: resolve(outputPath) };
}

export function runModelSelectionCli(args: ModelSelectionCliArgs) {
  assertPrivateRegularFile(args.manifestPath, "manifest");
  const manifest = parseModelSelectionManifest(JSON.parse(readFileSync(args.manifestPath, "utf8")));
  const baseDirectory = dirname(args.manifestPath);
  const reports = Object.fromEntries(manifest.configurations.map((configuration) => {
    const reportPath = isAbsolute(configuration.reportPath)
      ? configuration.reportPath
      : resolve(baseDirectory, configuration.reportPath);
    assertPrivateRegularFile(reportPath, `report:${configuration.id}`);
    return [configuration.id, JSON.parse(readFileSync(reportPath, "utf8"))];
  }));
  const productionAcceptanceReport = manifest.productionAcceptance
    ? readPrivateReport(
        manifest.productionAcceptance.reportPath,
        baseDirectory,
        `production-acceptance:${manifest.productionAcceptance.configurationId}`
      )
    : undefined;
  const result = evaluateModelSelection(manifest, reports, productionAcceptanceReport);
  writePrivateJson(args.outputPath, result);
  return result;
}

function readPrivateReport(path: string, baseDirectory: string, label: string) {
  const reportPath = isAbsolute(path) ? path : resolve(baseDirectory, path);
  assertPrivateRegularFile(reportPath, label);
  return JSON.parse(readFileSync(reportPath, "utf8"));
}

function assertPrivateRegularFile(path: string, label: string) {
  const stats = lstatSync(path);
  if (!stats.isFile() || stats.isSymbolicLink()) throw new Error(`${label}_must_be_regular_file`);
  if ((stats.mode & 0o077) !== 0) throw new Error(`${label}_permissions_must_be_0600_or_stricter`);
}

function writePrivateJson(path: string, value: unknown) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(path, 0o600);
}

function isMainModule() {
  return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  try {
    const args = parseModelSelectionCliArgs(process.argv.slice(2));
    const result = runModelSelectionCli(args);
    console.log(JSON.stringify({
      status: "completed",
      decisionId: result.decisionId,
      evidenceStage: result.evidenceStage,
      configurationsEvaluated: result.configurations.length,
      modelSelectionWinnerId: result.modelSelectionWinnerId,
      productionPromotionCandidates: result.productionPromotionCandidateIds.length,
      recommendedConfigurationId: result.recommendedConfigurationId,
      outputPath: args.outputPath
    }));
  } catch (error) {
    console.error(JSON.stringify({
      status: "failed",
      error: error instanceof Error ? error.message : "unknown_error"
    }));
    process.exitCode = 1;
  }
}

export type { ModelSelectionManifest };
