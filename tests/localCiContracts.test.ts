import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  beta1UpgradeCheckCodes,
  beta1UpgradeIdentity,
  beta2UpgradeCheckCodes,
  beta2UpgradeIdentity,
  beta3UpgradeCheckCodes,
  beta3UpgradeIdentity,
  beta4UpgradeCheckCodes,
  beta4UpgradeIdentity,
  beta5UpgradeCheckCodes,
  beta5UpgradeIdentity,
  buildSafeReport,
  requiredInstallModeCheckCodes
} from "../scripts/validate-beta-install";
import { alphaIndexImage, alphaPlatformDigest, alphaRevision, requiredUpgradeCheckCodes } from "../scripts/validate-beta-upgrade";

// The local entrypoint must reach the same accept/reject decision as the GitHub Actions steps it
// replaces. While those workflows still exist, every case below runs through both implementations.
// At cutover, drop only the workflow half of each case; the expected decisions stay.

type Json = Record<string, any>;
type Case = { name: string; report: Json | string; exit: number; accept: boolean };

const root = process.cwd();
const require = createRequire(import.meta.url);
const { load: parseYaml } = require("js-yaml") as { load: (source: string) => unknown };
const jobsScript = join(root, "scripts/local-ci/jobs.sh");
const version = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;
const revision = "a".repeat(40);
const candidateDigest = `sha256:${"c".repeat(64)}`;
const officialImage = `ghcr.io/jremick/moodarr@${candidateDigest}`;
const localImage = "moodarr-local-ci:contract-fixture-native";
const hex = (character: string) => character.repeat(64);
const sortedJson = (codes: readonly string[]) => JSON.stringify([...codes].sort());
const clone = <T>(value: T): T => structuredClone(value);
const mutate = (base: Json, change: (report: Json) => void) => {
  const copy = clone(base);
  change(copy);
  return copy;
};

const scratch = mkdtempSync(join(tmpdir(), "moodarr-local-ci-contracts-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const writeExecutable = (path: string, contents: string) => {
  writeFileSync(path, contents);
  chmodSync(path, 0o755);
};

const fakeBin = join(scratch, "bin");
mkdirSync(fakeBin);
writeExecutable(join(fakeBin, "npm"), '#!/usr/bin/env bash\ncat "$FIXTURE_REPORT"\nexit "$FIXTURE_EXIT"\n');
if (spawnSync("sh", ["-c", "command -v sha256sum"]).status !== 0) {
  writeExecutable(join(fakeBin, "sha256sum"), '#!/bin/sh\nexec shasum -a 256 "$@"\n');
}
const fakePath = `${fakeBin}:${process.env.PATH ?? ""}`;

// Workflow steps call ./node_modules/.bin/tsx to read the validator check-code exports. The stub
// returns those same exports, precomputed once, so each decision costs one bash and one jq run.
const workflowCwd = join(scratch, "workflow-cwd");
mkdirSync(join(workflowCwd, "node_modules", ".bin"), { recursive: true });
mkdirSync(join(workflowCwd, "expected"));
writeFileSync(join(workflowCwd, "package.json"), JSON.stringify({ version }));
writeExecutable(join(workflowCwd, "node_modules", ".bin", "tsx"), `#!/usr/bin/env bash
set -euo pipefail
test "$1" = "--eval"
name="$(printf '%s' "$2" | sed -E 's/^import \\{ ([A-Za-z0-9]+) \\}.*/\\1/')"
cat "$(dirname "$0")/../../expected/$name.json"
`);
const exportedChecks: Record<string, readonly string[]> = {
  requiredInstallModeCheckCodes,
  requiredUpgradeCheckCodes,
  beta1UpgradeCheckCodes,
  beta2UpgradeCheckCodes,
  beta3UpgradeCheckCodes,
  beta4UpgradeCheckCodes,
  beta5UpgradeCheckCodes
};
for (const [name, codes] of Object.entries(exportedChecks)) writeFileSync(join(workflowCwd, "expected", `${name}.json`), sortedJson(codes));
const runnerTemp = join(scratch, "runner");
mkdirSync(join(runnerTemp, "moodarr-native-source-validation"), { recursive: true });

type WorkflowStep = { name?: string; run?: string };
const workflowRun = (path: string, jobId: string, stepName: string) => {
  const document = parseYaml(readFileSync(join(root, path), "utf8")) as { jobs: Record<string, { steps?: WorkflowStep[] }> };
  const matches = (document.jobs[jobId]?.steps ?? []).filter((step) => step.name === stepName);
  if (matches.length !== 1 || typeof matches[0]!.run !== "string") throw new Error(`${path} ${jobId} must contain one ${stepName} step`);
  return matches[0]!.run;
};

const rehearsalStep = workflowRun(".github/workflows/ci.yml", "native-source-validation", "Run and validate release-ineligible native rehearsal");
const officialSteps: Record<string, string> = {
  "beta4-upgrade-rollback": workflowRun(".github/workflows/validate-beta-candidate.yml", "upgrade-rollback", "Validate direct beta.4 upgrade and cold rollback"),
  "beta5-upgrade-rollback": workflowRun(".github/workflows/validate-beta-candidate.yml", "upgrade-rollback", "Validate direct beta.5 upgrade and cold rollback")
};

let reportSequence = 0;
const writeReport = (report: Json | string) => {
  const path = join(scratch, `report-${reportSequence++}.json`);
  writeFileSync(path, typeof report === "string" ? report : `${JSON.stringify(report, null, 2)}\n`);
  return path;
};

const accepted = (result: SpawnSyncReturns<string>) => result.status === 0;

const runWorkflowRehearsal = (validation: string, testCase: Case) => spawnSync("bash", ["-c", rehearsalStep], {
  cwd: workflowCwd,
  encoding: "utf8",
  timeout: 20_000,
  env: {
    ...process.env,
    PATH: fakePath,
    VALIDATION: validation,
    LOCAL_IMAGE: localImage,
    PACKAGE_VERSION: version,
    SOURCE_SHA: revision,
    RUNNER_TEMP: runnerTemp,
    FIXTURE_REPORT: writeReport(testCase.report),
    FIXTURE_EXIT: String(testCase.exit)
  }
});

const runWorkflowOfficial = (validation: string, testCase: Case) => spawnSync("bash", ["-c", officialSteps[validation]!], {
  cwd: workflowCwd,
  encoding: "utf8",
  timeout: 20_000,
  env: {
    ...process.env,
    PATH: fakePath,
    CANDIDATE_IMAGE: officialImage,
    EXPECTED_REVISION: revision,
    REPORT_PATH: join(scratch, "official-report.json"),
    FIXTURE_REPORT: writeReport(testCase.report),
    FIXTURE_EXIT: String(testCase.exit)
  }
});

const runLocalCheck = (validation: string, mode: "rehearsal" | "official", checks: readonly string[], testCase: Case) =>
  spawnSync("bash", [jobsScript, "check-report", validation, mode, writeReport(testCase.report), String(testCase.exit)], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      LCI_EXPECTED_VERSION: version,
      LCI_EXPECTED_REVISION: revision,
      LCI_EXPECTED_IMAGE: mode === "official" ? officialImage : localImage,
      LCI_EXPECTED_DIGEST: mode === "official" ? candidateDigest : "",
      LCI_EXPECTED_CHECKS: sortedJson(checks),
      LCI_EXPECTED_LIFECYCLE_CHECKS: sortedJson(requiredInstallModeCheckCodes)
    }
  });

const describeResult = (result: SpawnSyncReturns<string>) => `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().slice(-600);

const lifecycleCounts = { lifecycles: 3, plexItems: 2, seerrItems: 3, searchResults: 1, posterBytes: 68, stubCalls: 35 };
const passingMode = () => ({ passed: true, checkCodes: [...requiredInstallModeCheckCodes], counts: { ...lifecycleCounts }, failures: [], incomplete: [] });
const nativePlatform = () => ({
  endpointLocalUnix: true,
  dockerClientVersion: "28.3.0",
  dockerServerVersion: "28.3.0",
  composeVersion: "2.38.2",
  daemonOs: "linux",
  daemonArch: "x86_64",
  imageOs: "linux",
  imageArch: "amd64",
  native: true
});
const profileSourceHashes = () => ({ harness: hex("1"), bundlePolicy: hex("2"), stub: hex("3"), compose: hex("4") });

// The clean-install shape comes from the validator's own public report builder.
const cleanInstallReport = (official: boolean): Json => buildSafeReport({
  official,
  candidateDigest: official ? candidateDigest : undefined,
  expectedVersion: version,
  expectedRevision: revision,
  sourceHashes: { harness: hex("1"), bundle_policy: hex("2"), stub: hex("3"), compose: hex("4") },
  platform: nativePlatform(),
  docker: passingMode(),
  compose: passingMode(),
  releaseEligible: official,
  incomplete: []
}) as Json;

const alphaUpgradeReport = (official: boolean): Json => JSON.parse(JSON.stringify({
  schema: "moodarr-beta-upgrade-validation-v1",
  status: official ? "passed" : "incomplete",
  mode: official ? "official-candidate" : "local-rehearsal",
  releaseEligible: official,
  images: {
    alpha: { indexDigest: alphaIndexImage.split("@")[1], platformDigest: alphaPlatformDigest, revision: alphaRevision },
    candidate: { indexDigest: official ? candidateDigest : undefined, platformDigest: `sha256:${hex("d")}`, version, revision }
  },
  archive: { sha256: hex("5") },
  state: { before: { total: 3 }, candidate: { total: 3 }, restarted: { total: 3 }, rollback: { total: 3 } },
  database: { before: { schema: 21 }, candidate: { schema: 34 }, plexRefreshed: { schema: 34 }, restarted: { schema: 34 }, rollback: { schema: 21 } },
  checks: [...requiredUpgradeCheckCodes].sort(),
  failures: [],
  incomplete: official ? [] : ["local_rehearsal"]
})) as Json;

const profileReport = (beta: number, identity: Json, checks: readonly string[], official: boolean): Json => ({
  schema: `moodarr-beta${beta}-upgrade-v1`,
  passed: true,
  releaseEligible: official,
  sourceHashes: profileSourceHashes(),
  platform: nativePlatform(),
  baseline: { ...identity },
  candidate: { image: official ? officialImage : localImage, version, revision },
  archiveSha256: hex("6"),
  checks: [...checks],
  lifecycle: passingMode(),
  incomplete: official ? [] : ["local_image_rehearsal"]
});

const profiles = [
  { beta: 1, identity: beta1UpgradeIdentity, checks: beta1UpgradeCheckCodes },
  { beta: 2, identity: beta2UpgradeIdentity, checks: beta2UpgradeCheckCodes },
  { beta: 3, identity: beta3UpgradeIdentity, checks: beta3UpgradeCheckCodes },
  { beta: 4, identity: beta4UpgradeIdentity, checks: beta4UpgradeCheckCodes },
  { beta: 5, identity: beta5UpgradeIdentity, checks: beta5UpgradeCheckCodes }
] as const;

const exitCodeCases = (valid: Json, releaseExit: number): Case[] => [
  { name: "complete report with the contract exit code", report: valid, exit: releaseExit, accept: true },
  { name: `exit ${releaseExit === 1 ? 0 : 1} with an otherwise complete report`, report: valid, exit: releaseExit === 1 ? 0 : 1, accept: false },
  { name: "exit 2 with an otherwise complete report", report: valid, exit: 2, accept: false },
  { name: "empty report", report: "", exit: releaseExit, accept: false },
  { name: "malformed report", report: "{", exit: releaseExit, accept: false }
];

const rehearsalCases: Array<{ validation: string; checks: readonly string[]; cases: Case[] }> = [
  (() => {
    const valid = cleanInstallReport(false);
    return {
      validation: "clean-install",
      checks: requiredInstallModeCheckCodes,
      cases: [
        ...exitCodeCases(valid, 1),
        { name: "daemon reports amd64 instead of x86_64", report: mutate(valid, (r) => { r.platform.daemonArch = "amd64"; }), exit: 1, accept: true },
        { name: "release-eligible local image", report: mutate(valid, (r) => { r.releaseEligible = true; }), exit: 1, accept: false },
        { name: "candidate revision mismatch", report: mutate(valid, (r) => { r.candidate.revision = "b".repeat(40); }), exit: 1, accept: false },
        { name: "non-local Docker endpoint", report: mutate(valid, (r) => { r.platform.endpointLocalUnix = false; }), exit: 1, accept: false },
        { name: "arm64 daemon", report: mutate(valid, (r) => { r.platform.daemonArch = "arm64"; }), exit: 1, accept: false },
        { name: "emulated platform", report: mutate(valid, (r) => { r.platform.native = false; }), exit: 1, accept: false },
        { name: "unresolved top-level incomplete", report: mutate(valid, (r) => { r.incomplete = ["source_dirty"]; }), exit: 1, accept: false },
        { name: "missing Compose mode", report: mutate(valid, (r) => { delete r.modes.compose; }), exit: 1, accept: false },
        { name: "missing required check code", report: mutate(valid, (r) => { r.modes.docker.checkCodes.pop(); }), exit: 1, accept: false },
        { name: "duplicated check code", report: mutate(valid, (r) => { r.modes.compose.checkCodes[24] = r.modes.compose.checkCodes[0]; }), exit: 1, accept: false },
        { name: "stub call count drift", report: mutate(valid, (r) => { r.modes.compose.counts.stubCalls = 34; }), exit: 1, accept: false },
        { name: "mode failure recorded", report: mutate(valid, (r) => { r.modes.docker.failures = ["container_unhealthy"]; }), exit: 1, accept: false },
        { name: "published digest on a local rehearsal", report: mutate(valid, (r) => { r.candidate.digest = candidateDigest; }), exit: 1, accept: false }
      ]
    };
  })(),
  (() => {
    const valid = alphaUpgradeReport(false);
    return {
      validation: "alpha21-upgrade-rollback",
      checks: requiredUpgradeCheckCodes,
      cases: [
        ...exitCodeCases(valid, 1),
        { name: "release-eligible local image", report: mutate(valid, (r) => { r.releaseEligible = true; }), exit: 1, accept: false },
        { name: "status passed without official proof", report: mutate(valid, (r) => { r.status = "passed"; }), exit: 1, accept: false },
        { name: "official mode label", report: mutate(valid, (r) => { r.mode = "official-candidate"; }), exit: 1, accept: false },
        { name: "rehearsal marker missing", report: mutate(valid, (r) => { r.incomplete = []; }), exit: 1, accept: false },
        { name: "extra incomplete code", report: mutate(valid, (r) => { r.incomplete = ["amd64_emulation", "local_rehearsal"]; }), exit: 1, accept: false },
        { name: "recorded failure", report: mutate(valid, (r) => { r.failures = ["candidate_restart"]; }), exit: 1, accept: false },
        { name: "candidate version mismatch", report: mutate(valid, (r) => { r.images.candidate.version = "0.1.0-beta.1"; }), exit: 1, accept: false },
        { name: "missing rollback state", report: mutate(valid, (r) => { r.state.rollback = null; }), exit: 1, accept: false },
        { name: "missing Plex-refresh database", report: mutate(valid, (r) => { r.database.plexRefreshed = null; }), exit: 1, accept: false },
        { name: "invalid archive digest", report: mutate(valid, (r) => { r.archive.sha256 = "not-a-digest"; }), exit: 1, accept: false },
        { name: "missing check code", report: mutate(valid, (r) => { r.checks.pop(); }), exit: 1, accept: false }
      ]
    };
  })(),
  ...profiles.map(({ beta, identity, checks }) => {
    const valid = profileReport(beta, identity, checks, false);
    const baselineCases: Case[] = beta === 1
      ? [{ name: "wrong baseline version", report: mutate(valid, (r) => { r.baseline.version = "0.1.0-beta.2"; }), exit: 1, accept: false }]
      : [
          { name: "baseline digest drift", report: mutate(valid, (r) => { r.baseline.image = `ghcr.io/jremick/moodarr@sha256:${hex("e")}`; }), exit: 1, accept: false },
          { name: "baseline revision drift", report: mutate(valid, (r) => { r.baseline.revision = "f".repeat(40); }), exit: 1, accept: false }
        ];
    const imageCases: Case[] = beta >= 4
      ? [
          { name: "report bound to another image", report: mutate(valid, (r) => { r.candidate.image = "moodarr-local-ci:other-run-native"; }), exit: 1, accept: false },
          { name: "lifecycle check code duplicated", report: mutate(valid, (r) => { r.lifecycle.checkCodes[24] = r.lifecycle.checkCodes[0]; }), exit: 1, accept: false }
        ]
      : [];
    return {
      validation: `beta${beta}-upgrade-rollback`,
      checks,
      cases: [
        ...exitCodeCases(valid, 1),
        ...baselineCases,
        ...imageCases,
        { name: "release-eligible local image", report: mutate(valid, (r) => { r.releaseEligible = true; }), exit: 1, accept: false },
        { name: "rehearsal marker missing", report: mutate(valid, (r) => { r.incomplete = []; }), exit: 1, accept: false },
        { name: "candidate revision mismatch", report: mutate(valid, (r) => { r.candidate.revision = "b".repeat(40); }), exit: 1, accept: false },
        { name: "emulated platform", report: mutate(valid, (r) => { r.platform.native = false; }), exit: 1, accept: false },
        { name: "missing profile check", report: mutate(valid, (r) => { r.checks.pop(); }), exit: 1, accept: false },
        { name: "lifecycle not passed", report: mutate(valid, (r) => { r.lifecycle.passed = false; }), exit: 1, accept: false },
        { name: "lifecycle count drift", report: mutate(valid, (r) => { r.lifecycle.counts.lifecycles = 2; }), exit: 1, accept: false },
        { name: "lifecycle incomplete", report: mutate(valid, (r) => { r.lifecycle.incomplete = ["not_run"]; }), exit: 1, accept: false }
      ]
    };
  })
];

describe("local rehearsal report contracts match the CI native-source matrix", () => {
  for (const { validation, checks, cases } of rehearsalCases) {
    it(`${validation} reaches the workflow's decision for every case`, () => {
      for (const testCase of cases) {
        const workflow = runWorkflowRehearsal(validation, testCase);
        const local = runLocalCheck(validation, "rehearsal", checks, testCase);
        expect(accepted(workflow), `workflow ${validation}: ${testCase.name}: ${describeResult(workflow)}`).toBe(testCase.accept);
        expect(accepted(local), `local ${validation}: ${testCase.name}: ${describeResult(local)}`).toBe(testCase.accept);
      }
    }, 120_000);
  }
});

const officialCommonCases = (valid: Json, candidateField: (report: Json) => void): Case[] => [
  ...exitCodeCases(valid, 0),
  { name: "unresolved rehearsal incomplete", report: mutate(valid, (r) => { r.incomplete = ["local_image_rehearsal"]; }), exit: 0, accept: false },
  { name: "not release eligible", report: mutate(valid, (r) => { r.releaseEligible = false; }), exit: 0, accept: false },
  { name: "report bound to another candidate", report: mutate(valid, candidateField), exit: 0, accept: false }
];

const officialCases: Array<{ validation: string; checks: readonly string[]; workflowParity: boolean; cases: Case[] }> = [
  {
    validation: "clean-install",
    checks: requiredInstallModeCheckCodes,
    workflowParity: false,
    cases: [
      ...officialCommonCases(cleanInstallReport(true), (r) => { r.candidate.digest = `sha256:${hex("e")}`; }),
      { name: "local-rehearsal kind", report: mutate(cleanInstallReport(true), (r) => { r.candidate.kind = "local-rehearsal"; }), exit: 0, accept: false },
      { name: "emulated platform", report: mutate(cleanInstallReport(true), (r) => { r.platform.native = false; }), exit: 0, accept: false }
    ]
  },
  {
    validation: "alpha21-upgrade-rollback",
    checks: requiredUpgradeCheckCodes,
    workflowParity: false,
    cases: [
      ...officialCommonCases(alphaUpgradeReport(true), (r) => { r.images.candidate.indexDigest = `sha256:${hex("e")}`; }),
      { name: "status incomplete", report: mutate(alphaUpgradeReport(true), (r) => { r.status = "incomplete"; }), exit: 0, accept: false },
      { name: "rehearsal mode label", report: mutate(alphaUpgradeReport(true), (r) => { r.mode = "local-rehearsal"; }), exit: 0, accept: false }
    ]
  },
  ...profiles.map(({ beta, identity, checks }) => {
    const valid = profileReport(beta, identity, checks, true);
    return {
      validation: `beta${beta}-upgrade-rollback`,
      checks,
      workflowParity: beta >= 4,
      cases: [
        ...officialCommonCases(valid, (r) => { r.candidate.image = `ghcr.io/jremick/moodarr@sha256:${hex("e")}`; }),
        { name: "baseline digest drift", report: mutate(valid, (r) => { r.baseline.image = `ghcr.io/jremick/moodarr@sha256:${hex("e")}`; }), exit: 0, accept: false },
        { name: "baseline revision drift", report: mutate(valid, (r) => { r.baseline.revision = "f".repeat(40); }), exit: 0, accept: false },
        { name: "lifecycle incomplete", report: mutate(valid, (r) => { r.lifecycle.incomplete = ["not_run"]; }), exit: 0, accept: false }
      ]
    };
  })
];

describe("local official candidate contracts require zero unresolved incompletes", () => {
  for (const { validation, checks, workflowParity, cases } of officialCases) {
    it(`${validation} official proof accepts only a complete release-eligible report${workflowParity ? " and matches the candidate workflow" : ""}`, () => {
      for (const testCase of cases) {
        const local = runLocalCheck(validation, "official", checks, testCase);
        expect(accepted(local), `local official ${validation}: ${testCase.name}: ${describeResult(local)}`).toBe(testCase.accept);
        if (workflowParity) {
          const workflow = runWorkflowOfficial(validation, testCase);
          expect(accepted(workflow), `workflow official ${validation}: ${testCase.name}: ${describeResult(workflow)}`).toBe(testCase.accept);
        }
      }
    }, 120_000);
  }

  it("rejects an unknown validation or mode instead of treating it as passed", () => {
    const valid: Case = { name: "valid", report: cleanInstallReport(false), exit: 1, accept: false };
    expect(accepted(runLocalCheck("beta9-upgrade-rollback", "rehearsal", requiredInstallModeCheckCodes, valid))).toBe(false);
    const wrongMode = spawnSync("bash", [jobsScript, "check-report", "clean-install", "preview", writeReport(valid.report), "1"], { cwd: root, encoding: "utf8" });
    expect(accepted(wrongMode)).toBe(false);
  });
});

// Published-candidate supply-chain evidence. Fixtures mirror the published OCI index layout.
const imageManifestDigest = `sha256:${hex("1")}`;
const validManifest = {
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.index.v1+json",
  manifests: [
    { mediaType: "application/vnd.oci.image.manifest.v1+json", digest: imageManifestDigest, size: 1, platform: { os: "linux", architecture: "amd64" } },
    {
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: `sha256:${hex("2")}`,
      size: 1,
      annotations: { "vnd.docker.reference.type": "attestation-manifest", "vnd.docker.reference.digest": imageManifestDigest },
      platform: { os: "unknown", architecture: "unknown" }
    }
  ]
};
const validImageConfig = {
  os: "linux",
  architecture: "amd64",
  config: {
    Labels: {
      "org.opencontainers.image.version": version,
      "org.opencontainers.image.revision": revision,
      "org.opencontainers.image.source": "https://github.com/jremick/moodarr",
      "org.opencontainers.image.licenses": "Apache-2.0",
      "io.moodarr.ai-provider-policy": "none",
      "io.moodarr.tmdb-content-policy": "none"
    }
  }
};
const validProvenance = (): Json => ({
  SLSA: {
    buildDefinition: {
      buildType: "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md",
      resolvedDependencies: [{ uri: "pkg:docker/node@24", digest: { sha256: hex("3") } }]
    },
    runDetails: {
      builder: { id: "https://github.com/jremick/moodarr/actions/runs/1/attempts/1" },
      metadata: { buildkit_metadata: { vcs: { source: "https://github.com/jremick/moodarr", revision } } }
    }
  }
});
const validSbom = { SPDX: { spdxVersion: "SPDX-2.3", SPDXID: "SPDXRef-DOCUMENT", packages: [{ SPDXID: "SPDXRef-Package-node", name: "node" }] } };
const validTrivy = { SchemaVersion: 2, ArtifactName: "fixture", ArtifactType: "container_image", Results: [{ Target: "debian", Class: "os-pkgs", Type: "debian" }] };
const manifestText = JSON.stringify(validManifest);
const manifestDigest = `sha256:${createHash("sha256").update(manifestText).digest("hex")}`;
const publishedImage = (digest: string) => `ghcr.io/jremick/moodarr@${digest}`;
const supplyChainEvidenceStep = workflowRun(".github/workflows/validate-beta-candidate.yml", "supply-chain", "Verify published digest, image identity, SBOM, and provenance");
const supplyChainPolicyStep = workflowRun(".github/workflows/validate-beta-candidate.yml", "supply-chain", "Record compact supply-chain evidence and enforce policy");
const anonymousPullStep = workflowRun(".github/workflows/validate-beta-candidate.yml", "supply-chain", "Verify anonymous public candidate pull");

const freshDirectory = (prefix: string) => mkdtempSync(join(scratch, prefix));

const writeImagetoolsFake = (bin: string) => writeExecutable(join(bin, "docker"), `#!/usr/bin/env bash
set -euo pipefail
emit_fixture() { if [[ -f "$1" ]]; then cat "$1"; fi; }
case "$*" in
  *" --raw") emit_fixture "$FIXTURE_MANIFEST" ;;
  *"{{json .Image}}"*) emit_fixture "$FIXTURE_IMAGE_CONFIG" ;;
  *"{{json .Provenance}}"*) emit_fixture "$FIXTURE_PROVENANCE" ;;
  *"{{json .SBOM}}"*) emit_fixture "$FIXTURE_SBOM" ;;
  *) echo "unexpected fake docker invocation: $*" >&2; exit 64 ;;
esac
`);

describe("local supply-chain evidence matches the candidate workflow", () => {
  it("verifies published digest identity, SBOM and provenance with the same decisions", () => {
    const withoutTmdbPolicy = clone(validImageConfig) as Json;
    delete withoutTmdbPolicy.config.Labels["io.moodarr.tmdb-content-policy"];
    const armImage = { ...clone(validImageConfig), architecture: "arm64" };
    const otherAttachment = clone(validManifest) as Json;
    otherAttachment.manifests[1].annotations["vnd.docker.reference.digest"] = `sha256:${hex("4")}`;
    const selfHostedBuilder = validProvenance();
    selfHostedBuilder.SLSA.runDetails.builder.id = "https://example.invalid/build/1";
    const missingMaterialDigest = validProvenance();
    delete missingMaterialDigest.SLSA.buildDefinition.resolvedDependencies[0].digest;
    const invalidMaterialDigest = validProvenance();
    invalidMaterialDigest.SLSA.buildDefinition.resolvedDependencies = [{ uri: "pkg:docker/node@24", digest: { sha256: "not-a-digest" } }];
    const githubPayload = validProvenance();
    githubPayload.SLSA.buildDefinition.internalParameters = { github_actor: "fixture-user", github_event_payload: "{fixture}" };
    const otherRevision = validProvenance();
    otherRevision.SLSA.runDetails.metadata.buildkit_metadata.vcs.revision = "b".repeat(40);
    const cases: Array<{ name: string; manifest?: string; digest?: string; imageConfig?: Json; provenance?: string | null; sbom?: string | null; accept: boolean }> = [
      { name: "valid public evidence", accept: true },
      { name: "digest differs from the published manifest bytes", digest: `sha256:${hex("9")}`, accept: false },
      { name: "missing TMDB content policy label", imageConfig: withoutTmdbPolicy, accept: false },
      { name: "arm64 image", imageConfig: armImage, accept: false },
      { name: "attestation references another manifest", manifest: JSON.stringify(otherAttachment), accept: false },
      { name: "malformed provenance", provenance: "{", accept: false },
      { name: "missing provenance", provenance: null, accept: false },
      { name: "non-GitHub builder identity", provenance: JSON.stringify(selfHostedBuilder), accept: false },
      { name: "provenance for another revision", provenance: JSON.stringify(otherRevision), accept: false },
      { name: "missing material digest", provenance: JSON.stringify(missingMaterialDigest), accept: false },
      { name: "invalid material digest", provenance: JSON.stringify(invalidMaterialDigest), accept: false },
      { name: "privacy-sensitive GitHub payload", provenance: JSON.stringify(githubPayload), accept: false },
      { name: "malformed SBOM", sbom: "{", accept: false },
      { name: "missing SBOM", sbom: null, accept: false }
    ];
    for (const testCase of cases) {
      const directory = freshDirectory("evidence-");
      const bin = join(directory, "bin");
      mkdirSync(bin);
      writeImagetoolsFake(bin);
      const manifest = testCase.manifest ?? manifestText;
      const digest = testCase.digest ?? `sha256:${createHash("sha256").update(manifest).digest("hex")}`;
      const fixture = (name: string, value: string | null | undefined, fallback: string) => {
        const path = join(directory, name);
        if (value !== null) writeFileSync(path, value ?? fallback);
        return path;
      };
      const environment = {
        ...process.env,
        PATH: `${bin}:${fakePath}`,
        FIXTURE_MANIFEST: fixture("fixture-manifest.json", manifest, manifest),
        FIXTURE_IMAGE_CONFIG: fixture("fixture-image.json", testCase.imageConfig ? JSON.stringify(testCase.imageConfig) : undefined, JSON.stringify(validImageConfig)),
        FIXTURE_PROVENANCE: fixture("fixture-provenance.json", testCase.provenance, JSON.stringify(validProvenance())),
        FIXTURE_SBOM: fixture("fixture-sbom.json", testCase.sbom, JSON.stringify(validSbom))
      };
      const workflow = spawnSync("bash", ["-c", supplyChainEvidenceStep], {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
        env: { ...environment, RUNNER_TEMP: join(directory, "runner"), CANDIDATE_IMAGE: publishedImage(digest), CANDIDATE_DIGEST: digest, EXPECTED_REVISION: revision }
      });
      const subjobDir = join(directory, "local");
      mkdirSync(subjobDir);
      const local = spawnSync("bash", [jobsScript, "supply-chain-verify-evidence"], {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
        env: { ...environment, LCI_SUBJOB_DIR: subjobDir, LCI_CANDIDATE_DIGEST: digest, LCI_SOURCE_SHA: revision }
      });
      expect(accepted(workflow), `workflow evidence ${testCase.name}: ${describeResult(workflow)}`).toBe(testCase.accept);
      expect(accepted(local), `local evidence ${testCase.name}: ${describeResult(local)}`).toBe(testCase.accept);
    }
  }, 120_000);

  it("enforces the published-digest vulnerability and public-pull policy with the same decisions", () => {
    const anonymousPull = {
      schemaVersion: "moodarr-anonymous-candidate-pull-v1",
      candidateImage: publishedImage(manifestDigest),
      candidateDigest: manifestDigest,
      registryDigest: manifestDigest,
      manifestMediaType: "application/vnd.oci.image.index.v1+json",
      anonymousPullVerified: true
    };
    const actionable = { ...validTrivy, Results: [{ ...validTrivy.Results[0], Vulnerabilities: [{ VulnerabilityID: "CVE-FIXTURE", PkgName: "fixture", Severity: "HIGH", FixedVersion: "2.0.0" }] }] };
    const nullVulnerabilities = { ...validTrivy, Results: [{ ...validTrivy.Results[0], Vulnerabilities: null }] };
    const invalidVulnerabilities = { ...validTrivy, Results: [{ ...validTrivy.Results[0], Vulnerabilities: "not-an-array" }] };
    const cases: Array<{ name: string; highCritical?: string | null; actionable?: string | null; anonymousPull?: string | null; accept: boolean }> = [
      { name: "omitted vulnerability results", accept: true },
      { name: "null vulnerability results", highCritical: JSON.stringify(nullVulnerabilities), actionable: JSON.stringify(nullVulnerabilities), accept: true },
      { name: "missing anonymous public-pull evidence", anonymousPull: null, accept: false },
      { name: "malformed anonymous public-pull evidence", anonymousPull: "{", accept: false },
      { name: "anonymous pull for another digest", anonymousPull: JSON.stringify({ ...anonymousPull, registryDigest: `sha256:${hex("9")}` }), accept: false },
      { name: "fixable high finding", highCritical: JSON.stringify(actionable), actionable: JSON.stringify(actionable), accept: false },
      { name: "invalid vulnerability field", highCritical: JSON.stringify(invalidVulnerabilities), accept: false },
      { name: "malformed high/critical scan", highCritical: "{", accept: false },
      { name: "missing high/critical scan", highCritical: null, accept: false },
      { name: "structurally empty high/critical scan", highCritical: "{}", accept: false },
      { name: "malformed actionable scan", actionable: "{", accept: false },
      { name: "missing actionable scan", actionable: null, accept: false },
      { name: "structurally empty actionable scan", actionable: "{}", accept: false }
    ];
    for (const testCase of cases) {
      const directory = freshDirectory("policy-");
      const bin = join(directory, "bin");
      const dockerConfig = join(directory, "docker-config");
      mkdirSync(bin);
      mkdirSync(join(dockerConfig, "cli-plugins"), { recursive: true });
      writeExecutable(join(bin, "trivy"), '#!/usr/bin/env bash\nif [[ "$1" == "--version" ]]; then echo "Version: 0.70.0"; exit 0; fi\necho "unexpected fake trivy invocation: $*" >&2\nexit 64\n');
      writeExecutable(join(dockerConfig, "cli-plugins", "docker-buildx"), "fixture Buildx bytes\n");
      const populate = (target: string) => {
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, "manifest.json"), manifestText);
        writeFileSync(join(target, "image-config.json"), JSON.stringify(validImageConfig));
        writeFileSync(join(target, "provenance.json"), JSON.stringify(validProvenance()));
        writeFileSync(join(target, "sbom.spdx.json"), JSON.stringify(validSbom));
        writeFileSync(join(target, "trivy-version.txt"), "Version: 0.70.0\n");
        const optional = (name: string, value: string | null | undefined, fallback: string) => {
          if (value !== null) writeFileSync(join(target, name), value ?? fallback);
        };
        optional("anonymous-pull.json", testCase.anonymousPull, JSON.stringify(anonymousPull));
        optional("trivy-high-critical.json", testCase.highCritical, JSON.stringify(validTrivy));
        optional("trivy-actionable.json", testCase.actionable, JSON.stringify(validTrivy));
      };
      const workflowTemp = join(directory, "runner");
      populate(join(workflowTemp, "moodarr-beta-supply-chain"));
      const subjobDir = join(directory, "local");
      populate(subjobDir);
      const environment = { ...process.env, PATH: `${bin}:${fakePath}`, DOCKER_CONFIG: dockerConfig };
      const workflow = spawnSync("bash", ["-c", supplyChainPolicyStep], {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
        env: {
          ...environment,
          RUNNER_TEMP: workflowTemp,
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_REPOSITORY: "jremick/moodarr",
          GITHUB_RUN_ID: "1",
          GITHUB_STEP_SUMMARY: join(directory, "summary.md"),
          CANDIDATE_IMAGE: publishedImage(manifestDigest),
          CANDIDATE_DIGEST: manifestDigest,
          EXPECTED_REVISION: revision
        }
      });
      const local = spawnSync("bash", [jobsScript, "supply-chain-record-policy"], {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
        env: { ...environment, LCI_SUBJOB_DIR: subjobDir, LCI_CANDIDATE_DIGEST: manifestDigest, LCI_SOURCE_SHA: revision, LCI_RUN_ID: "contract-fixture-run" }
      });
      expect(accepted(workflow), `workflow policy ${testCase.name}: ${describeResult(workflow)}`).toBe(testCase.accept);
      expect(accepted(local), `local policy ${testCase.name}: ${describeResult(local)}`).toBe(testCase.accept);
      if (testCase.accept) {
        const report = JSON.parse(readFileSync(join(subjobDir, "supply-chain-report.json"), "utf8")) as Json;
        expect(report.candidate).toEqual(JSON.parse(readFileSync(join(workflowTemp, "moodarr-beta-supply-chain", "supply-chain-report.json"), "utf8")).candidate);
        expect(report.localRun).toEqual({ runId: "contract-fixture-run" });
        expect(report).not.toHaveProperty("workflowRun");
      }
    }
  }, 120_000);

  it("proves anonymous exact-digest availability without printing the pull token", () => {
    const token = "fixture-anonymous-pull-token";
    const headers = (mediaType: string, digest: string) => `HTTP/2 200\r\ncontent-type: ${mediaType}\r\ndocker-content-digest: ${digest}\r\n\r\n`;
    const indexType = "application/vnd.oci.image.index.v1+json";
    const cases: Array<{ name: string; digest?: string; tokenBody?: string; headers?: string; fail?: boolean; accept: boolean }> = [
      { name: "exact public OCI index", accept: true },
      { name: "single-platform manifest media type", headers: headers("application/vnd.oci.image.manifest.v1+json", manifestDigest), accept: false },
      { name: "registry reports another digest", headers: headers(indexType, `sha256:${hex("8")}`), accept: false },
      { name: "bytes do not match the requested digest", digest: `sha256:${hex("7")}`, headers: headers(indexType, `sha256:${hex("7")}`), accept: false },
      { name: "multiline token response", tokenBody: JSON.stringify({ token: `${token}\nextra` }), accept: false },
      { name: "token response is not one object", tokenBody: `${JSON.stringify({ token })}${JSON.stringify({ token })}`, accept: false },
      { name: "registry request fails", fail: true, accept: false }
    ];
    for (const testCase of cases) {
      const directory = freshDirectory("anonymous-");
      const bin = join(directory, "bin");
      const scenario = join(bin, "scenario");
      mkdirSync(scenario, { recursive: true });
      writeFileSync(join(scenario, "token.json"), testCase.tokenBody ?? JSON.stringify({ token }));
      writeFileSync(join(scenario, "manifest.json"), manifestText);
      writeFileSync(join(scenario, "headers.txt"), testCase.headers ?? headers(indexType, manifestDigest));
      if (testCase.fail) writeFileSync(join(scenario, "fail"), "");
      writeExecutable(join(bin, "curl"), `#!/usr/bin/env bash
set -euo pipefail
scenario="$(cd "$(dirname "$0")" && pwd)/scenario"
output=""; headers=""; url=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --output) output="$2"; shift 2 ;;
    --dump-header) headers="$2"; shift 2 ;;
    --header|--data-urlencode|--connect-timeout|--max-time|--retry|--retry-delay|--retry-max-time|--user|--write-out) shift 2 ;;
    https://*) url="$1"; shift ;;
    *) shift ;;
  esac
done
if [[ -f "$scenario/fail" ]]; then exit 22; fi
case "$url" in
  https://ghcr.io/token) cp "$scenario/token.json" "$output" ;;
  https://ghcr.io/v2/jremick/moodarr/manifests/*) cp "$scenario/manifest.json" "$output"; cp "$scenario/headers.txt" "$headers" ;;
  *) echo "unexpected fake curl URL: $url" >&2; exit 64 ;;
esac
`);
      const digest = testCase.digest ?? manifestDigest;
      const environment = { ...process.env, PATH: `${bin}:${fakePath}` };
      const workflowTemp = join(directory, "runner");
      mkdirSync(workflowTemp);
      const workflow = spawnSync("bash", ["-c", anonymousPullStep], {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
        env: { ...environment, RUNNER_TEMP: workflowTemp, CANDIDATE_DIGEST: digest, CANDIDATE_IMAGE: publishedImage(digest) }
      });
      const subjobDir = join(directory, "local");
      mkdirSync(subjobDir);
      const local = spawnSync("bash", [jobsScript, "anonymous-pull"], {
        cwd: root,
        encoding: "utf8",
        timeout: 20_000,
        env: { ...environment, LCI_SUBJOB_DIR: subjobDir, LCI_CANDIDATE_DIGEST: digest }
      });
      expect(accepted(workflow), `workflow anonymous pull ${testCase.name}: ${describeResult(workflow)}`).toBe(testCase.accept);
      expect(accepted(local), `local anonymous pull ${testCase.name}: ${describeResult(local)}`).toBe(testCase.accept);
      expect(`${local.stdout}${local.stderr}`).not.toContain(token);
      if (testCase.accept) {
        expect(JSON.parse(readFileSync(join(subjobDir, "anonymous-pull.json"), "utf8"))).toEqual(
          JSON.parse(readFileSync(join(workflowTemp, "moodarr-beta-supply-chain", "anonymous-pull.json"), "utf8"))
        );
      }
      expect(readdirSync(subjobDir).filter((name) => name !== "anonymous-pull.json")).toEqual([]);
    }
  }, 60_000);
});
