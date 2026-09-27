import { resolve } from "node:path";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { scanMoodrankEvaluationLeakage, loadMoodrankLeakagePolicy } from "./moodrank-eval-leakage-contract";
import { structuralCatalog } from "../tests/fixtures/moodrankStructuralCatalog";

// Expand review coverage without changing blocking policy, debt or allowlists.
const root = resolve(import.meta.dirname, "..");
const temporary = mkdtempSync(resolve(tmpdir(), "moodrank-structural-markers-"));
try {
  const structural = resolve(temporary, "catalog.ts");
  writeFileSync(structural, `export const catalog = ${JSON.stringify(structuralCatalog)};\n`);
  const report = scanMoodrankEvaluationLeakage({ repoRoot: root,
    fixtureFiles: ["src/server/recommendation/profileEvalFixtures.ts", "src/server/fixtures/media.ts", "src/server/recommendation/rankIndexEvaluation.ts", structural],
    productionDirectories: ["src/server"],
    excludedProductionFiles: ["src/server/fixtures/media.ts", "src/server/recommendation/evaluation.ts", "src/server/recommendation/profileEvalFixtures.ts", "src/server/recommendation/profileJourneyEvaluation.ts", "src/server/recommendation/rankIndexEvaluation.ts"],
    policy: loadMoodrankLeakagePolicy(resolve(root, "scripts/moodrank-eval-known-debt.json")), automaticPhraseMarkers: true });
  console.log(JSON.stringify({ scope: "phrase overlap candidates for human review, not proof of fixture leakage", policyChanged: false, ...report }, null, 2));
} finally { rmSync(temporary, { recursive: true }); }
