import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { requiredInstallModeCheckCodes } from "../scripts/validate-beta-install";

// Independently read from the immutable release notes, peeled Git tag and anonymous
// GHCR tag/digest/config readback. These are historical identities, not beta.7 inputs.
const baseline = {
  image: "ghcr.io/jremick/moodarr@sha256:04ebff94f39ce82f2ac9159d1d0349a61eb2c07b70eebf92dde6c8d60afb1455",
  version: "0.1.0-beta.6",
  revision: "b3bd90ddd47eac1f56700063cf98829696d35e75"
};
const checks = ["beta6_identity", "beta6_populated_state", "cold_backup", "migration_preserves_state", "candidate_restart", "rollback_exact_state", "rollback_runtime"];
const candidate = {
  image: `ghcr.io/jremick/moodarr@sha256:${"c".repeat(64)}`,
  version: "0.1.0-beta.7",
  revision: "a".repeat(40)
};
const root = process.cwd();
const scratch = mkdtempSync(join(tmpdir(), "moodarr-beta6-gate-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
let sequence = 0;
const receipt = (official: boolean) => ({
  schema: "moodarr-beta6-upgrade-v1", passed: true, releaseEligible: official,
  candidate: { ...candidate, image: official ? candidate.image : "moodarr:beta6-rehearsal" },
  baseline: { ...baseline }, platform: { native: true },
  sourceHashes: { harness: "1".repeat(64), bundlePolicy: "2".repeat(64), stub: "3".repeat(64), compose: "4".repeat(64) },
  archiveSha256: "5".repeat(64), checks: [...checks],
  lifecycle: { passed: true, failures: [] as string[], incomplete: [] as string[], checkCodes: [...requiredInstallModeCheckCodes], counts: { lifecycles: 3, plexItems: 2, seerrItems: 3, searchResults: 1, posterBytes: 68, stubCalls: 35 } },
  incomplete: official ? [] as string[] : ["local_image_rehearsal"]
});
type Receipt = ReturnType<typeof receipt>;

function admit(report: Receipt, official: boolean, exit = official ? 0 : 1) {
  const path = join(scratch, `report-${sequence++}.json`);
  writeFileSync(path, JSON.stringify(report));
  const result = spawnSync("bash", [join(root, "scripts/local-ci/jobs.sh"), "check-report", "beta6-upgrade-rollback", official ? "official" : "rehearsal", path, String(exit)], {
    cwd: root, encoding: "utf8", timeout: 20_000,
    env: { ...process.env, LCI_EXPECTED_VERSION: candidate.version, LCI_EXPECTED_REVISION: candidate.revision,
      LCI_EXPECTED_IMAGE: official ? candidate.image : "moodarr:beta6-rehearsal",
      LCI_EXPECTED_CHECKS: JSON.stringify([...checks].sort()), LCI_EXPECTED_LIFECYCLE_CHECKS: JSON.stringify([...requiredInstallModeCheckCodes].sort()) }
  });
  return { accepted: result.status === 0, diagnostic: `${result.stdout}${result.stderr}`.slice(-700) };
}

describe.each([true, false])("beta.6 real report admission, official=%s", (official) => {
  it("admits a complete three-lifecycle receipt at the exact published baseline", () => {
    const result = admit(receipt(official), official);
    expect(result.accepted, result.diagnostic).toBe(true);
  });
  const failures: Array<[string, (report: Receipt) => void]> = [
    ["wrong historical version", (r) => { r.baseline.version = "0.1.0-beta.5"; }],
    ["wrong historical image", (r) => { r.baseline.image = `ghcr.io/jremick/moodarr@sha256:${"e".repeat(64)}`; }],
    ["wrong historical source", (r) => { r.baseline.revision = "b".repeat(40); }],
    ["different candidate version", (r) => { r.candidate.version = "0.1.0-beta.6"; }],
    ["different candidate source", (r) => { r.candidate.revision = "b".repeat(40); }],
    ["different candidate image", (r) => { r.candidate.image = "moodarr:another-candidate"; }],
    ["malformed backup hash", (r) => { r.archiveSha256 = "not-a-sha256"; }],
    ["missing source binding", (r) => { r.sourceHashes.harness = ""; }],
    ["missing upgrade check", (r) => { r.checks.pop(); }],
    ["duplicated upgrade check", (r) => { r.checks[6] = r.checks[0]!; }],
    ["missing lifecycle check", (r) => { r.lifecycle.checkCodes.pop(); }],
    ["duplicated lifecycle check", (r) => { r.lifecycle.checkCodes[24] = r.lifecycle.checkCodes[0]!; }],
    ["emulated platform", (r) => { r.platform.native = false; }],
    ["migration changed durable state", (r) => { r.lifecycle.passed = false; r.lifecycle.failures = ["candidate_continuity_beta6_migration_changed_durable_state"]; }],
    ["cold restore changed durable state", (r) => { r.lifecycle.failures = ["rollback_restore_beta6_rollback_changed_durable_state"]; }],
    ["incomplete cleanup", (r) => { r.lifecycle.incomplete = ["cleanup_failed"]; }],
    ["missing rollback lifecycle", (r) => { r.lifecycle.counts.lifecycles = 2; }],
    ["lost native user/provider state", (r) => { r.lifecycle.counts.plexItems = 1; }],
    ["incorrect eligibility", (r) => { r.releaseEligible = !official; }],
    ["incorrect rehearsal disposition", (r) => { r.incomplete = official ? ["local_image_rehearsal"] : []; }]
  ];
  it.each(failures)("rejects %s", (_name, mutate) => {
    const report = receipt(official); mutate(report);
    const result = admit(report, official);
    expect(result.accepted, result.diagnostic).toBe(false);
  });
  it("requires the validator exit status to agree with the receipt", () => {
    expect(admit(receipt(official), official, official ? 1 : 0).accepted).toBe(false);
  });
});

it("includes beta.6 in both executable release validation matrices", () => {
  const result = spawnSync("bash", ["scripts/local-ci.sh", "list"], { cwd: root, encoding: "utf8", timeout: 20_000 });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("native-beta6-upgrade-rollback");
  expect(result.stdout).toContain("official-beta6-upgrade-rollback");
});

it.each([1, 2, 3, 4, 5, 6])("rejects beta.%s as a forward target before any Docker command", (beta) => {
  const bin = join(scratch, `bin-${beta}`); mkdirSync(bin);
  const called = join(bin, "docker-called");
  const fakeDocker = join(bin, "docker");
  writeFileSync(fakeDocker, `#!/bin/sh\nprintf called > '${called}'\nexit 99\n`, { mode: 0o755 });
  const result = spawnSync(join(root, "node_modules/.bin/tsx"), ["scripts/validate-beta6-upgrade.ts", "--candidate-image", candidate.image,
    "--expected-revision", candidate.revision, "--expected-version", `0.1.0-beta.${beta}`], {
    cwd: root, encoding: "utf8", timeout: 20_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }
  });
  expect(result.status, result.stderr).toBe(1);
  const report = JSON.parse(result.stdout);
  expect(report).toMatchObject({ schema: "moodarr-beta6-upgrade-v1", passed: false, releaseEligible: false, baseline,
    lifecycle: { failures: ["preflight_upgrade_target_must_follow_beta6"] } });
  expect(report.platform).toBeUndefined();
  expect(() => readFileSync(called)).toThrow();
});
