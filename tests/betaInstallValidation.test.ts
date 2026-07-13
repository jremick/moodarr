import { describe, expect, it } from "vitest";
import {
  buildSafeReport,
  catalogSnapshotsMatch,
  expectedPosterSha256,
  parseInstallArgs,
  readBoundedResponseBody,
  resolveTrustedExecutable,
  validateConnectionEvidence,
  validatePersistenceEvidence,
  validatePlatformEvidence,
  validatePosterEvidence,
  validateResourceOwnership,
  validateRuntimeEvidence,
  validateSourceBinding,
  validateSyncEvidence,
  type ModeResult,
  type RuntimeEvidence
} from "../scripts/validate-beta-install";

const revision = "a".repeat(40);
const digestImage = `ghcr.io/jremick/moodarr@sha256:${"b".repeat(64)}`;

function mode(passed: boolean, marker: string): ModeResult {
  return {
    passed,
    checkCodes: passed ? [marker] : [],
    counts: { lifecycles: passed ? 3 : 0, plexItems: 2, seerrItems: 2, searchResults: 1, posterBytes: 68, stubCalls: 31 },
    failures: passed ? [] : [marker],
    incomplete: []
  };
}

function runtime(overrides: Partial<RuntimeEvidence> = {}): RuntimeEvidence {
  return {
    running: true,
    healthStatus: "healthy",
    oomKilled: false,
    restartCount: 0,
    imageRef: digestImage,
    imageIdMatches: true,
    versionLabel: "0.1.0-beta.1",
    revisionLabel: revision,
    aiProviderPolicyLabel: "none",
    tmdbContentPolicyLabel: "none",
    user: "999:999",
    readonly: true,
    init: true,
    privileged: false,
    capAdd: [],
    capDrop: ["ALL"],
    securityOpt: ["no-new-privileges:true"],
    pidsLimit: 128,
    memory: 2 * 1024 * 1024 * 1024,
    memorySwap: 2 * 1024 * 1024 * 1024,
    nanoCpus: 2_000_000_000,
    restartPolicy: "no",
    stopTimeout: 30,
    tmpfs: { "/tmp": "rw,nosuid,nodev,noexec,size=536870912,mode=1777" },
    portBindings: { "4401/tcp": [{ HostIp: "127.0.0.1", HostPort: "4499" }] },
    mounts: [{ Type: "volume", Name: "owned", Destination: "/data", RW: true }],
    expectedImageRef: digestImage,
    expectedVersion: "0.1.0-beta.1",
    expectedRevision: revision,
    expectedVolume: "owned",
    expectedPort: 4499,
    expectedRestartPolicy: "no",
    ...overrides
  };
}

describe("beta clean-install validation helpers", () => {
  it("accepts only the lowercase immutable official candidate form", () => {
    const parsed = parseInstallArgs([
      "--candidate-image", digestImage,
      "--expected-revision", revision,
      "--expected-version", "0.1.0-beta.1"
    ]);
    expect(parsed.official).toBe(true);
    expect(() => parseInstallArgs([
      "--candidate-image", digestImage.toUpperCase(),
      "--expected-revision", revision,
      "--expected-version", "0.1.0-beta.1"
    ])).toThrowError(/invalid_candidate_image/);
  });

  it("requires explicit local and dirty flags for rehearsal and keeps emulation rehearsal-only", () => {
    expect(() => parseInstallArgs([
      "--candidate-image", "moodarr:beta-validation-local",
      "--expected-revision", revision,
      "--expected-version", "0.1.0-beta.1",
      "--allow-local-image"
    ])).toThrowError(/local_rehearsal_requires_explicit_flags/);
    const parsed = parseInstallArgs([
      "--candidate-image", "moodarr:beta-validation-local",
      "--expected-revision", revision,
      "--expected-version", "0.1.0-beta.1",
      "--allow-local-image", "--allow-dirty", "--allow-emulation"
    ]);
    expect(parsed).toMatchObject({ official: false, allowEmulation: true });
    expect(() => parseInstallArgs([
      "--candidate-image", digestImage,
      "--expected-revision", revision,
      "--expected-version", "0.1.0-beta.1",
      "--allow-emulation"
    ])).toThrowError(/rehearsal_flags_rejected/);
  });

  it("fails official source mismatch and dirty state", () => {
    const checked = validateSourceBinding({
      expectedRevision: revision,
      headRevision: "c".repeat(40),
      clean: false,
      committedMatches: { harness: false, bundle_policy: false, stub: true, compose: true },
      allowDirty: false
    });
    expect(checked.eligible).toBe(false);
    expect(checked.failures).toEqual(expect.arrayContaining([
      "source_revision_mismatch",
      "source_dirty",
      "source_harness_mismatch",
      "source_bundle_policy_mismatch"
    ]));
  });

  it("does not accept a stale sync result", () => {
    const checked = validateSyncEvidence({
      accepted: true,
      acceptedStartedAt: "2026-07-13T00:00:00.000Z",
      baselineFingerprint: "same",
      observedRunning: true,
      result: { ok: true, startedAt: "2026-07-13T00:00:01.000Z", finishedAt: "2026-07-13T00:00:02.000Z", plexItems: 2, seerrItems: 2 },
      resultFingerprint: "same"
    });
    expect(checked.valid).toBe(false);
    expect(checked.failures).toContain("sync_result_stale");
  });

  it("fails Docker health even when an HTTP probe could be healthy", () => {
    const checked = validateRuntimeEvidence(runtime({ healthStatus: "unhealthy" }));
    expect(checked.valid).toBe(false);
    expect(checked.failures).toContain("container_unhealthy");
  });

  it("requires explicit ok true from both connection adapters", () => {
    expect(validateConnectionEvidence({ ok: true, mode: "live" })).toBe(true);
    expect(validateConnectionEvidence({ ok: false, mode: "live" })).toBe(false);
  });

  it("rejects an SVG fallback even when bytes are otherwise nonempty", () => {
    expect(validatePosterEvidence("image/svg+xml", Buffer.from("<svg/>"), expectedPosterSha256)).toBe(false);
  });

  it("rejects foreign resource ownership", () => {
    expect(validateResourceOwnership("foreign", "owned")).toBe(false);
    expect(validateResourceOwnership("owned", "owned")).toBe(true);
  });

  it("rejects wrong candidate identity and non-native official platform", () => {
    expect(validateRuntimeEvidence(runtime({ revisionLabel: "d".repeat(40) })).failures).toContain("container_identity_mismatch");
    expect(validateRuntimeEvidence(runtime({ aiProviderPolicyLabel: "configurable" })).failures).toContain("container_identity_mismatch");
    expect(validateRuntimeEvidence(runtime({ tmdbContentPolicyLabel: "configurable" })).failures).toContain("container_identity_mismatch");
    const platform = validatePlatformEvidence({
      endpointLocalUnix: true,
      dockerClientVersion: "28.0.0",
      dockerServerVersion: "28.0.0",
      composeVersion: "2.39.0",
      daemonOs: "linux",
      daemonArch: "arm64",
      imageOs: "linux",
      imageArch: "amd64",
      native: false
    }, false);
    expect(platform.valid).toBe(false);
    expect(platform.failures).toContain("daemon_not_native_amd64");
  });

  it("marks emulation incomplete without treating it as native evidence", () => {
    const platform = validatePlatformEvidence({
      endpointLocalUnix: true,
      dockerClientVersion: "28.0.0",
      dockerServerVersion: "28.0.0",
      composeVersion: "2.39.0",
      daemonOs: "linux",
      daemonArch: "arm64",
      imageOs: "linux",
      imageArch: "amd64",
      native: false
    }, true);
    expect(platform.valid).toBe(true);
    expect(platform.incomplete).toContain("platform_emulated_not_release_evidence");
  });

  it("detects persistence drift, weak config mode, and failed integrity", () => {
    const checked = validatePersistenceEvidence({ before: { fixtureMode: false }, after: { fixtureMode: true }, configMode: 0o644, integrity: "corrupt", foreignKeysOk: false });
    expect(checked.failures).toEqual(expect.arrayContaining(["settings_persistence_drift", "config_mode_mismatch", "sqlite_integrity_failed", "sqlite_foreign_keys_failed"]));
  });

  it("detects catalog loss before a later lifecycle can repopulate it", () => {
    const expected = { totalItems: 2, plexItems: 2, seerrItems: 2, identitySha256: "a".repeat(64) };
    expect(catalogSnapshotsMatch(expected, expected)).toBe(true);
    expect(catalogSnapshotsMatch(expected, { ...expected, totalItems: 0, identitySha256: "b".repeat(64) })).toBe(false);
  });

  it("resolves trusted binaries only from fixed system directories", () => {
    expect(resolveTrustedExecutable("git", ["/usr/bin"])).toMatch(/\/git$/);
    expect(() => resolveTrustedExecutable("git", ["node_modules/.bin"])).toThrowError(/trusted_git_not_found/);
  });

  it("aborts streamed responses once the cumulative limit is exceeded", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.enqueue(new Uint8Array([3, 4]));
        controller.close();
      }
    });
    await expect(readBoundedResponseBody(new Response(stream), 3)).rejects.toThrowError(/response_too_large/);
  });

  it("requires the expected restart policy and stop timeout", () => {
    expect(validateRuntimeEvidence(runtime({ restartPolicy: "always", stopTimeout: 10 })).failures).toContain("container_lifecycle_policy_mismatch");
  });

  it("emits only the safe allowlisted report shape", () => {
    const report = buildSafeReport({
      official: true,
      candidateDigest: `sha256:${"b".repeat(64)}`,
      expectedVersion: "0.1.0-beta.1",
      expectedRevision: revision,
      sourceHashes: {
        harness: "1".repeat(64),
        bundle_policy: "2".repeat(64),
        stub: "3".repeat(64),
        compose: "4".repeat(64)
      },
      platform: { endpointLocalUnix: true, dockerClientVersion: "28.0.0", dockerServerVersion: "28.0.0", composeVersion: "2.39.0", daemonOs: "linux", daemonArch: "amd64", imageOs: "linux", imageArch: "amd64", native: true },
      docker: { ...mode(true, "docker_ok"), token: "secret", path: "/private/path" } as ModeResult,
      compose: mode(true, "compose_ok"),
      releaseEligible: true
    });
    const serialized = JSON.stringify(report);
    expect(report.schema).toBe("moodarr-beta-clean-install-v1");
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("/private/path");
    expect(Object.keys(report)).toEqual(["schema", "candidate", "sourceHashes", "platform", "modes", "passed", "releaseEligible", "incomplete"]);
    expect(report.sourceHashes.bundlePolicy).toBe("2".repeat(64));
  });

  it("keeps Docker and Compose evidence independent", () => {
    const report = buildSafeReport({
      official: true,
      expectedVersion: "0.1.0-beta.1",
      expectedRevision: revision,
      docker: mode(true, "docker_ok"),
      compose: mode(false, "compose_failed"),
      releaseEligible: false
    });
    expect(report.modes.docker.passed).toBe(true);
    expect(report.modes.compose.passed).toBe(false);
    expect(report.passed).toBe(false);
  });

  it("keeps a passing rehearsal release-ineligible", () => {
    const report = buildSafeReport({
      official: false,
      expectedVersion: "0.1.0-beta.1",
      expectedRevision: revision,
      docker: mode(true, "docker_ok"),
      compose: mode(true, "compose_ok"),
      releaseEligible: false,
      incomplete: ["platform_emulated_not_release_evidence"]
    });
    expect(report.passed).toBe(true);
    expect(report.releaseEligible).toBe(false);
  });
});
