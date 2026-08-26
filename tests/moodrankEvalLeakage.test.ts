import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MOODRANK_LEAKAGE_SCHEMA_VERSION,
  parseMoodrankLeakagePolicy,
  scanMoodrankEvaluationLeakage,
  type MoodrankLeakagePolicy
} from "../scripts/moodrank-eval-leakage-contract";
import { runMoodrankLeakageGuard } from "../scripts/verify-moodrank-eval-leakage";

const emptyPolicy: MoodrankLeakagePolicy = {
  schemaVersion: MOODRANK_LEAKAGE_SCHEMA_VERSION,
  reviewedDistinctiveMarkers: [],
  allowlist: [],
  knownDebt: []
};

function withFixtureRepo(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "moodarr-eval-leakage-"));
  try {
    mkdirSync(join(root, "fixtures"), { recursive: true });
    mkdirSync(join(root, "production"), { recursive: true });
    writeFileSync(
      join(root, "fixtures", "catalog.ts"),
      [
        "export const catalog = [",
        "  {",
        '    title: "Quiet County Fair",',
        '    summary: "A gentle comedy about unusual lantern chores at a calm county fair."',
        "  },",
        "  {",
        '    title: "Soft Rain Sunday",',
        '    summary: "A warm story about family kindness on a rainy Sunday."',
        "  },",
        "  {",
        '    title: "Deadpan Lighthouse",',
        '    summary: "A dry, non-exhausting comedy set at a lighthouse."',
        "  }",
        "];"
      ].join("\n")
    );
    run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scan(root: string, policy: MoodrankLeakagePolicy = emptyPolicy) {
  return scanMoodrankEvaluationLeakage({
    repoRoot: root,
    fixtureFiles: ["fixtures/catalog.ts"],
    productionDirectories: ["production"],
    policy
  });
}

describe("MoodRank evaluation-leakage guard", () => {
  it("scans production code outside the recommendation directory", () => {
    const root = mkdtempSync(join(tmpdir(), "moodarr-eval-leakage-wrapper-"));
    try {
      mkdirSync(join(root, "src/server/recommendation"), { recursive: true });
      mkdirSync(join(root, "src/server/ai"), { recursive: true });
      writeFileSync(
        join(root, "src/server/recommendation/profileEvalFixtures.ts"),
        'export const catalog = [{ title: "Quiet County Fair", summary: "A quiet synthetic fixture." }];\n'
      );
      writeFileSync(join(root, "src/server/ai/queryOptimizer.ts"), 'export const leakedRule = "Quiet County Fair";\n');
      const policyPath = join(root, "policy.json");
      writeFileSync(policyPath, JSON.stringify(emptyPolicy));

      const report = runMoodrankLeakageGuard(root, policyPath);

      expect(report.status).toBe("failed");
      expect(report.unbaselinedFindings).toContainEqual(
        expect.objectContaining({ sourceFile: "src/server/ai/queryOptimizer.ts", markerKind: "exact_title" })
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects exact fixture titles and reviewed title or summary markers", () => {
    withFixtureRepo((root) => {
      writeFileSync(
        join(root, "production", "scoring.ts"),
        [
          'const exact = "Quiet County Fair";',
          'const phrase = /county\\s+fair/;',
          'const reviewed = /lantern chores/;'
        ].join("\n")
      );
      const policy: MoodrankLeakagePolicy = {
        ...emptyPolicy,
        reviewedDistinctiveMarkers: [
          {
            marker: "county fair",
            fixtureTitle: "Quiet County Fair",
            fixtureField: "title",
            rationale: "A reviewer marked this unusual title phrase as fixture-specific."
          },
          {
            marker: "lantern chores",
            fixtureTitle: "Quiet County Fair",
            fixtureField: "summary",
            rationale: "A reviewer marked this uncommon phrase as fixture-specific."
          }
        ]
      };

      const report = scan(root, policy);

      expect(report.status).toBe("failed");
      expect(report.unbaselinedFindings.map((finding) => [finding.markerKind, finding.marker])).toEqual(
        expect.arrayContaining([
          ["exact_title", "quiet county fair"],
          ["reviewed_title_phrase", "county fair"],
          ["reviewed_summary_phrase", "lantern chores"]
        ])
      );
    });
  });

  it("detects family kindness and non-exhausting in literal and normalized regex forms", () => {
    withFixtureRepo((root) => {
      writeFileSync(
        join(root, "production", "scoring.ts"),
        [
          'const familyLiteral = "family kindness";',
          "const familyRegex = /family\\s+kindness/;",
          'const exhaustingLiteral = "non-exhausting";',
          "const exhaustingRegex = /non\\s+exhausting/;"
        ].join("\n")
      );
      const policy: MoodrankLeakagePolicy = {
        ...emptyPolicy,
        reviewedDistinctiveMarkers: [
          {
            marker: "family kindness",
            fixtureTitle: "Soft Rain Sunday",
            fixtureField: "summary",
            rationale: "A reviewer marked this uncommon phrase as fixture-specific."
          },
          {
            marker: "non-exhausting",
            fixtureTitle: "Deadpan Lighthouse",
            fixtureField: "summary",
            rationale: "A reviewer marked this uncommon phrase as fixture-specific."
          }
        ]
      };

      const report = scan(root, policy);
      const summaryFindings = report.unbaselinedFindings.filter(
        (finding) => finding.markerKind === "reviewed_summary_phrase"
      );

      expect(report.status).toBe("failed");
      expect(
        summaryFindings
          .filter((finding) => finding.marker === "family kindness")
          .map((finding) => finding.literalKind)
          .sort()
      ).toEqual(["regex", "string"]);
      expect(
        summaryFindings
          .filter((finding) => finding.marker === "non exhausting")
          .map((finding) => finding.literalKind)
          .sort()
      ).toEqual(["regex", "string"]);
    });
  });

  it("does not join separate regular-expression alternatives into a fixture title", () => {
    withFixtureRepo((root) => {
      writeFileSync(join(root, "production", "scoring.ts"), 'const terms = /quiet|county|fair/;\n');

      const report = scan(root);

      expect(report.findings).toEqual([]);
      expect(report.status).toBe("clean");
    });
  });

  it("fails on new findings, reports baselined debt, and lets removed debt pass", () => {
    withFixtureRepo((root) => {
      const scoringPath = join(root, "production", "scoring.ts");
      writeFileSync(scoringPath, 'const terms = "county fair";\n');
      const markerPolicy: MoodrankLeakagePolicy = {
        ...emptyPolicy,
        reviewedDistinctiveMarkers: [
          {
            marker: "county fair",
            fixtureTitle: "Quiet County Fair",
            fixtureField: "title",
            rationale: "A reviewer marked this unusual title phrase as fixture-specific."
          }
        ]
      };
      const firstReport = scan(root, markerPolicy);
      const finding = firstReport.unbaselinedFindings.find((candidate) => candidate.marker === "county fair");
      expect(finding).toBeDefined();

      const policy: MoodrankLeakagePolicy = {
        ...markerPolicy,
        knownDebt: [
          {
            findingId: finding!.findingId,
            marker: finding!.marker,
            markerKind: finding!.markerKind,
            fixtureTitles: finding!.fixtureTitles,
            sourceFile: finding!.sourceFile,
            rationale: "Existing coupling retained temporarily while scoring rules are generalized."
          }
        ]
      };
      const baselinedReport = scan(root, policy);
      expect(baselinedReport.status).toBe("baseline_pass_with_known_debt");
      expect(baselinedReport.activeKnownDebt).toHaveLength(1);
      expect(baselinedReport.unbaselinedFindings).toEqual([]);

      writeFileSync(scoringPath, 'const terms = "general catalog language";\n');
      const resolvedReport = scan(root, policy);
      expect(resolvedReport.status).toBe("clean");
      expect(resolvedReport.resolvedKnownDebt).toHaveLength(1);
    });
  });

  it("fails when a baselined literal changes or a duplicate match is added", () => {
    withFixtureRepo((root) => {
      const scoringPath = join(root, "production", "scoring.ts");
      writeFileSync(scoringPath, 'const terms = "Quiet County Fair";\n');
      const firstReport = scan(root);
      const baseline = firstReport.unbaselinedFindings.map((finding) => ({
        findingId: finding.findingId,
        marker: finding.marker,
        markerKind: finding.markerKind,
        fixtureTitles: finding.fixtureTitles,
        sourceFile: finding.sourceFile,
        rationale: "Existing fixture title retained temporarily."
      }));
      const policy: MoodrankLeakagePolicy = { ...emptyPolicy, knownDebt: baseline };

      writeFileSync(scoringPath, 'const changed = "A Quiet County Fair selection";\n');
      const changedReport = scan(root, policy);
      expect(changedReport.status).toBe("failed");
      expect(changedReport.unbaselinedFindings).toHaveLength(1);
      expect(changedReport.resolvedKnownDebt).toHaveLength(1);

      writeFileSync(
        scoringPath,
        ['const original = "Quiet County Fair";', 'const duplicate = "Quiet County Fair";'].join("\n")
      );
      const duplicateReport = scan(root, policy);
      expect(duplicateReport.status).toBe("failed");
      expect(duplicateReport.activeKnownDebt).toHaveLength(1);
      expect(duplicateReport.unbaselinedFindings).toHaveLength(1);
    });
  });

  it("requires an allowlist rationale and two independent examples", () => {
    expect(() =>
      parseMoodrankLeakagePolicy({
        ...emptyPolicy,
        allowlist: [
          {
            marker: "county fair",
            markerKind: "reviewed_title_phrase",
            rationale: "General catalog language.",
            independentExamples: ["Only one example"]
          }
        ]
      })
    ).toThrow(/at least two distinct examples/);
  });

  it("suppresses only the reviewed marker kind in a valid allowlist entry", () => {
    withFixtureRepo((root) => {
      writeFileSync(join(root, "production", "scoring.ts"), 'const exact = "Quiet County Fair";\n');
      const policy: MoodrankLeakagePolicy = {
        ...emptyPolicy,
        reviewedDistinctiveMarkers: [
          {
            marker: "county fair",
            fixtureTitle: "Quiet County Fair",
            fixtureField: "title",
            rationale: "A reviewer marked this unusual title phrase as fixture-specific."
          }
        ],
        allowlist: [
          {
            marker: "county fair",
            markerKind: "reviewed_title_phrase",
            rationale: "This phrase describes a general setting with independent catalog examples.",
            independentExamples: ["Example Film (1994)", "Another Film (2011)"]
          }
        ]
      };

      const report = scan(root, policy);

      expect(report.allowlistedFindings).toHaveLength(1);
      expect(report.allowlistedFindings[0].markerKind).toBe("reviewed_title_phrase");
      expect(report.unbaselinedFindings).toContainEqual(expect.objectContaining({ markerKind: "exact_title" }));
    });
  });

  it("rejects allowlist entries that do not map to extracted fixture markers", () => {
    withFixtureRepo((root) => {
      const policy: MoodrankLeakagePolicy = {
        ...emptyPolicy,
        allowlist: [
          {
            marker: "made up phrase",
            markerKind: "reviewed_title_phrase",
            rationale: "This should not be accepted as a hidden new detector rule.",
            independentExamples: ["Example A", "Example B"]
          }
        ]
      };

      expect(() => scan(root, policy)).toThrow(/does not reference an extracted fixture marker/);
    });
  });
});
