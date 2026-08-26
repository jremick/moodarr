import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  loadMoodrankLeakagePolicy,
  scanMoodrankEvaluationLeakage,
  type LeakageFinding,
  type LeakageScanReport
} from "./moodrank-eval-leakage-contract";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(scriptDirectory, "..");
const defaultPolicyPath = resolve(scriptDirectory, "moodrank-eval-known-debt.json");

export function runMoodrankLeakageGuard(repoRoot = defaultRepoRoot, policyPath = defaultPolicyPath): LeakageScanReport {
  const policy = loadMoodrankLeakagePolicy(policyPath);
  return scanMoodrankEvaluationLeakage({
    repoRoot,
    fixtureFiles: ["src/server/recommendation/profileEvalFixtures.ts"],
    productionDirectories: ["src/server"],
    excludedProductionFiles: [
      "src/server/recommendation/evaluation.ts",
      "src/server/recommendation/profileEvalFixtures.ts",
      "src/server/recommendation/profileJourneyEvaluation.ts",
      "src/server/recommendation/rankIndexEvaluation.ts"
    ],
    policy
  });
}

export function formatMoodrankLeakageReport(report: LeakageScanReport): string {
  const lines = [
    "MoodRank evaluation-leakage guard",
    `Status: ${report.status}`,
    `Scanned ${report.fixtureRecordCount} synthetic fixture records across ${report.productionFileCount} production files.`,
    `Active known debt: ${report.activeKnownDebt.length}; resolved debt: ${report.resolvedKnownDebt.length}; allowlisted: ${report.allowlistedFindings.length}; new findings: ${report.unbaselinedFindings.length}.`
  ];

  if (report.activeKnownDebt.length > 0) {
    lines.push("", "Existing known debt:", ...report.activeKnownDebt.map((finding) => `  - ${formatFinding(finding)}`));
  }
  if (report.resolvedKnownDebt.length > 0) {
    lines.push(
      "",
      "Resolved known debt (safe to remove from the baseline):",
      ...report.resolvedKnownDebt.map(
        (entry) => `  - ${entry.sourceFile}: ${entry.markerKind} ${JSON.stringify(entry.marker)} (${entry.findingId})`
      )
    );
  }
  if (report.unbaselinedFindings.length > 0) {
    lines.push("", "New unbaselined findings:", ...report.unbaselinedFindings.map((finding) => `  - ${formatFinding(finding)}`));
  }

  return lines.join("\n");
}

function formatFinding(finding: LeakageFinding): string {
  return `${finding.sourceFile}:${finding.line}:${finding.column} ${finding.markerKind} ${JSON.stringify(finding.marker)} from ${finding.fixtureTitles.join(", ")} [${finding.findingId}]`;
}

function runCli() {
  try {
    const report = runMoodrankLeakageGuard();
    console.log(formatMoodrankLeakageReport(report));
    if (report.status === "failed") process.exitCode = 1;
  } catch (error) {
    console.error(`MoodRank evaluation-leakage guard error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPath === import.meta.url) runCli();
