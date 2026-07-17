import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSafeReport,
  catalogSnapshotsMatch,
  expectedPosterSha256,
  parseInstallArgs,
  readBoundedResponseBody,
  requestAttemptIdempotencyKeyForLifecycle,
  requestValidationPhaseForCompletedLifecycles,
  requiredInstallModeCheckCodes,
  requiredInstallStubCounts,
  resolveTrustedExecutable,
  syntheticCatalogFileSha256,
  validateConnectionEvidence,
  validateCatalogBootstrapImportSummary,
  validateCatalogRequestAttemptEvidence,
  validatePersistenceEvidence,
  validatePlatformEvidence,
  validatePosterEvidence,
  validateResourceOwnership,
  validateRequestCreationEvidence,
  validateUncertainCreateResponse,
  validateRuntimeEvidence,
  validateSourceBinding,
  validateSyncEvidence,
  validateProtocolStubCounts,
  writeInstallIntegrationFixture,
  writeSyntheticCatalogFixture,
  type ModeResult,
  type RequestCreationEvidence,
  type RuntimeEvidence
} from "../scripts/validate-beta-install";

const revision = "a".repeat(40);
const digestImage = `ghcr.io/jremick/moodarr@sha256:${"b".repeat(64)}`;

function mode(passed: boolean, marker: string): ModeResult {
  return {
    passed,
    checkCodes: passed ? [...requiredInstallModeCheckCodes] : [],
    counts: { lifecycles: passed ? 3 : 0, plexItems: 2, seerrItems: 3, searchResults: 1, posterBytes: 68, stubCalls: 35 },
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
  it("makes the completed catalog fixture readable by the unprivileged importer", () => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-beta-install-fixture-"));
    const fixture = join(directory, "catalog.jsonl");
    try {
      writeSyntheticCatalogFixture(fixture);
      expect(statSync(fixture).mode & 0o777).toBe(0o644);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("makes a private copy of the integration fixture readable by the unprivileged helper", () => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-beta-install-stub-"));
    const fixture = join(directory, "integrations.mjs");
    const source = readFileSync("scripts/fixtures/beta-install-integrations.mjs", "utf8");
    try {
      writeInstallIntegrationFixture(fixture, source);
      expect(statSync(fixture).mode & 0o777).toBe(0o644);
      expect(readFileSync(fixture, "utf8")).toBe(source);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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

  it("requires an explicit local-image acknowledgement while keeping dirty and emulation escapes optional", () => {
    expect(() => parseInstallArgs([
      "--candidate-image", "moodarr:beta-validation-local",
      "--expected-revision", revision,
      "--expected-version", "0.1.0-beta.1"
    ])).toThrowError(/local_rehearsal_requires_explicit_flags/);
    const clean = parseInstallArgs([
      "--candidate-image", "moodarr:beta-validation-local",
      "--expected-revision", revision,
      "--expected-version", "0.1.0-beta.1",
      "--allow-local-image"
    ]);
    expect(clean).toMatchObject({ official: false, allowLocalImage: true, allowDirty: false, allowEmulation: false });
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

  it("binds clean rehearsals to exact HEAD and committed validator inputs unless dirty mode is explicit", () => {
    const exact = validateSourceBinding({
      expectedRevision: revision,
      headRevision: revision,
      clean: true,
      committedMatches: { harness: true, bundle_policy: true, stub: true, compose: true },
      allowDirty: false
    });
    expect(exact).toEqual({ eligible: true, failures: [] });

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

    const dirty = validateSourceBinding({
      expectedRevision: revision,
      headRevision: revision,
      clean: false,
      committedMatches: { harness: false, bundle_policy: false, stub: false, compose: false },
      allowDirty: true
    });
    expect(dirty).toEqual({ eligible: false, failures: [] });
    expect(validateSourceBinding({
      expectedRevision: revision,
      headRevision: "c".repeat(40),
      clean: false,
      committedMatches: { harness: false, bundle_policy: false, stub: false, compose: false },
      allowDirty: true
    }).failures).toContain("source_revision_mismatch");
  });

  it("does not accept a stale sync result", () => {
    const checked = validateSyncEvidence({
      accepted: true,
      acceptedStartedAt: "2026-07-13T00:00:00.000Z",
      baselineFingerprint: "same",
      observedRunning: true,
      result: { ok: true, startedAt: "2026-07-13T00:00:01.000Z", finishedAt: "2026-07-13T00:00:02.000Z", plexItems: 2, seerrItems: 3 },
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

  it("accepts only the exact normal, uncertain, and reconciled durable request evidence", () => {
    const base: RequestCreationEvidence = {
      operationCount: 1,
      operationStatus: "created",
      operationErrorPresent: false,
      operationResponseConfirmed: false,
      operationResponseReconciled: false,
      requestCount: 1,
      requestStatus: "approved",
      requestHasExternalId: false,
      createdAudits: 1,
      failedAudits: 0,
      reconciliationAudits: 0
    };
    const normal = {
      ...base,
      operationResponseConfirmed: true,
      requestHasExternalId: true
    };
    const uncertain = {
      ...base,
      operationStatus: "uncertain",
      operationErrorPresent: true,
      requestCount: 0,
      requestStatus: undefined,
      createdAudits: 0,
      failedAudits: 1
    };
    const reconciled = {
      ...base,
      operationResponseReconciled: true,
      failedAudits: 1,
      reconciliationAudits: 1
    };
    expect(validateRequestCreationEvidence(normal, "normal")).toBe(true);
    expect(validateRequestCreationEvidence({ ...normal, operationCount: 2, createdAudits: 2 }, "normal", 2)).toBe(true);
    expect(validateRequestCreationEvidence({ ...normal, operationCount: 3, createdAudits: 3 }, "normal", 3)).toBe(true);
    expect(validateRequestCreationEvidence({ ...normal, operationCount: 2, createdAudits: 2 }, "normal", 3)).toBe(false);
    expect(validateRequestCreationEvidence(uncertain, "uncertain")).toBe(true);
    expect(validateRequestCreationEvidence(reconciled, "reconciled")).toBe(true);
    expect(validateRequestCreationEvidence({ ...reconciled, requestCount: 2 }, "reconciled")).toBe(false);
    expect(validateRequestCreationEvidence({ ...reconciled, reconciliationAudits: 0 }, "reconciled")).toBe(false);
  });

  it("creates and reconciles in lifecycle two, then verifies durability only after the lifecycle-three recreate", () => {
    expect(requestValidationPhaseForCompletedLifecycles(0)).toBe("none");
    expect(requestValidationPhaseForCompletedLifecycles(1)).toBe("create-and-reconcile");
    expect(requestValidationPhaseForCompletedLifecycles(2)).toBe("verify-durable-after-recreate");
    expect(requestValidationPhaseForCompletedLifecycles(3)).toBe("none");
  });

  it("uses one deterministic idempotency key per lifecycle while keeping each lifecycle replay stable", () => {
    const owner = "a".repeat(36);
    const keys = [0, 1, 2].map((completed) => requestAttemptIdempotencyKeyForLifecycle(owner, completed));

    expect(new Set(keys).size).toBe(3);
    expect(keys).toEqual([
      `beta-install-${owner}-lifecycle-1`,
      `beta-install-${owner}-lifecycle-2`,
      `beta-install-${owner}-lifecycle-3`
    ]);
    expect(requestAttemptIdempotencyKeyForLifecycle(owner, 1)).toBe(keys[1]);
    expect(() => requestAttemptIdempotencyKeyForLifecycle(owner, 3)).toThrowError(/request_attempt_lifecycle_identity_invalid/);
    expect(() => requestAttemptIdempotencyKeyForLifecycle("unsafe-owner", 0)).toThrowError(/request_attempt_lifecycle_identity_invalid/);
  });

  it("accepts the app error envelope for an uncertain create and rejects the wrong response shape", () => {
    const error = "Seerr did not return a confirmed request outcome. Moodarr will reconcile before any retry and will not resend automatically.";
    expect(validateUncertainCreateResponse({ error })).toBe(true);
    expect(validateUncertainCreateResponse({ message: error })).toBe(false);
    expect(validateUncertainCreateResponse({ error: "will reconcile before any retry" })).toBe(false);
    expect(validateUncertainCreateResponse(null)).toBe(false);
  });

  it("requires the exact stub call contract, including one dropped response and no resend", () => {
    expect(validateProtocolStubCounts({ ...requiredInstallStubCounts })).toBe(true);
    expect(requiredInstallStubCounts.seerrCreates).toBe(4);
    expect(validateProtocolStubCounts({ ...requiredInstallStubCounts, seerrCreates: 5 })).toBe(false);
    expect(validateProtocolStubCounts({ ...requiredInstallStubCounts, seerrDroppedResponses: 0 })).toBe(false);
  });

  it("accepts only the exact networkless full-snapshot bootstrap summary", () => {
    const summary = {
      source: "wikidata",
      sourceVersion: "beta-install-wikidata-full-snapshot-v1",
      records: 1,
      imported: 1,
      skipped: 0,
      mediaItemsUpserted: 1,
      sourceRecordsUpserted: 1,
      changedSourceRecords: 1,
      unchangedSourceRecords: 0,
      inactiveSourceRecords: 0,
      skippedReasons: {},
      ignoredNotRequired: 0,
      dryRun: false,
      rehydrateRequired: false,
      expectedSourceRecords: 1,
      expectedFileSha256: syntheticCatalogFileSha256,
      fileSha256: syntheticCatalogFileSha256,
      uniqueImportableSourceRecords: 1,
      refreshRequiredBefore: 0,
      refreshRequiredSourceRecordsBefore: 0,
      refreshRequiredRemaining: 0,
      refreshRequiredSourceRecordsRemaining: 0,
      mode: "full_snapshot",
      batchSize: 1
    };
    expect(validateCatalogBootstrapImportSummary(summary)).toBe(true);
    expect(validateCatalogBootstrapImportSummary({ ...summary, mode: "incremental" })).toBe(false);
    expect(validateCatalogBootstrapImportSummary({ ...summary, uniqueImportableSourceRecords: 0 })).toBe(false);
    expect(validateCatalogBootstrapImportSummary({ ...summary, changedSourceRecords: 0, unchangedSourceRecords: 1 })).toBe(false);
    expect(validateCatalogBootstrapImportSummary({ ...summary, fileSha256: "0".repeat(64) })).toBe(false);
  });

  it("proves catalog request-attempt discovery, disclosure, and both isolation boundaries", () => {
    const row = {
      id: "catalog-sentinel",
      title: "Beta Catalog Moonlit Orchard",
      availabilityGroup: "unavailable",
      availabilityExplanation: "Not found in Plex. Moodarr has not checked Seerr availability; a confirmed request will make one request attempt.",
      requestAttempt: { available: true, seerrAvailabilityChecked: false },
      metadata: { source: "catalog", catalogSourceCount: 1 }
    };
    const evidence = {
      genericSearch: { usedAi: false, results: [] },
      attemptSearch: { usedAi: false, results: [row] },
      verifiedRequestableSearch: { usedAi: false, results: [] },
      preview: {
        canRequest: true,
        requestMode: "attempt",
        seerrAvailabilityChecked: false,
        requiresConfirmation: true,
        confirmationPhrase: "REQUEST BETA CATALOG MOONLIT ORCHARD",
        confirmationToken: "a".repeat(64),
        request: { mediaType: "movie", mediaId: 8_888_101, title: "Beta Catalog Moonlit Orchard" },
        item: row
      }
    };
    expect(validateCatalogRequestAttemptEvidence(evidence)).toEqual({ valid: true, failures: [] });

    expect(validateCatalogRequestAttemptEvidence({ ...evidence, genericSearch: { usedAi: false, results: [row] } }).failures)
      .toContain("catalog_request_attempt_generic_isolation_mismatch");
    expect(validateCatalogRequestAttemptEvidence({ ...evidence, verifiedRequestableSearch: { usedAi: false, results: [row] } }).failures)
      .toContain("catalog_request_attempt_verified_filter_isolation_mismatch");
    expect(validateCatalogRequestAttemptEvidence({
      ...evidence,
      attemptSearch: { usedAi: false, results: [{ ...row, availabilityGroup: "not_in_plex_requestable" }] }
    }).failures).toContain("catalog_request_attempt_discovery_mismatch");
    expect(validateCatalogRequestAttemptEvidence({
      ...evidence,
      attemptSearch: { usedAi: false, results: [{ ...row, requestAttempt: { available: true, seerrAvailabilityChecked: true } }] }
    }).failures).toContain("catalog_request_attempt_disclosure_mismatch");
  });

  it("makes the packaged stub accept then drop one controlled create while preserving the normal path", async () => {
    const port = await availablePort();
    const plexToken = "p".repeat(32);
    const seerrKey = "s".repeat(32);
    const child = spawn(process.execPath, ["scripts/fixtures/beta-install-integrations.mjs"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MOODARR_BETA_STUB_PLEX_TOKEN: plexToken,
        MOODARR_BETA_STUB_SEERR_KEY: seerrKey,
        MOODARR_BETA_STUB_UNCERTAIN_CREATE: "drop-first-response",
        MOODARR_BETA_STUB_PORT: String(port)
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    const baseUrl = `http://127.0.0.1:${port}`;
    const headers = { Accept: "application/json", "X-Api-Key": seerrKey };
    try {
      await waitForStub(baseUrl, headers, child);
      const initial = await fetch(`${baseUrl}/api/v1/request?take=100&skip=2`, { headers });
      expect(initial.status).toBe(200);
      expect(await initial.json()).toMatchObject({
        pageInfo: { results: 3 },
        results: [{ status: 3, media: { tmdbId: 7004, status: 1 } }]
      });

      const normal = await fetch(`${baseUrl}/api/v1/request`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ mediaType: "movie", mediaId: 7003 })
      });
      expect(normal.status).toBe(201);
      expect(await normal.json()).toMatchObject({ id: 9003, status: 2 });

      await expect(fetch(`${baseUrl}/api/v1/request`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ mediaType: "movie", mediaId: 7004 })
      })).rejects.toThrow();

      const reconciled = await fetch(`${baseUrl}/api/v1/request?take=100&skip=2`, { headers });
      expect(reconciled.status).toBe(200);
      expect(await reconciled.json()).toMatchObject({
        pageInfo: { results: 3 },
        results: [{ status: 2, media: { tmdbId: 7004, status: 2 } }]
      });

      const exited = once(child, "exit");
      expect(child.kill("SIGTERM")).toBe(true);
      const [exitCode] = await exited;
      expect(exitCode, stderr).toBe(0);
      const countsMatch = stdout.match(/^MOODARR_BETA_STUB_COUNTS (\{[^\n]+\})$/m);
      expect(countsMatch, stderr).not.toBeNull();
      const counts = JSON.parse(countsMatch![1]!) as Record<string, number>;
      expect(counts).toMatchObject({ seerrCreates: 2, seerrDroppedResponses: 1, rejected: 0, unknown: 0 });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
      }
    }
  }, 10_000);

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

  it.each(["docker", "compose"] as const)("fails closed when the %s mode omits any required check code", (modeName) => {
    const incompleteMode = mode(true, `${modeName}_ok`);
    incompleteMode.checkCodes = incompleteMode.checkCodes.slice(1);
    const report = buildSafeReport({
      official: true,
      expectedVersion: "0.1.0-beta.1",
      expectedRevision: revision,
      docker: modeName === "docker" ? incompleteMode : mode(true, "docker_ok"),
      compose: modeName === "compose" ? incompleteMode : mode(true, "compose_ok"),
      releaseEligible: true
    });
    expect(requiredInstallModeCheckCodes).toHaveLength(25);
    expect(new Set(requiredInstallModeCheckCodes).size).toBe(25);
    expect(report.modes[modeName].passed).toBe(false);
    expect(report.modes[modeName].failures).toContain("required_install_check_codes_missing");
    expect(report.passed).toBe(false);
    expect(report.releaseEligible).toBe(false);
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

async function availablePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a loopback test port.");
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForStub(
  baseUrl: string,
  headers: Record<string, string>,
  child: ReturnType<typeof spawn>
) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("Protocol stub exited before becoming ready.");
    try {
      const response = await fetch(`${baseUrl}/api/v1/status`, { headers, signal: AbortSignal.timeout(250) });
      if (response.ok) return;
    } catch {
      // Retry until the bounded readiness deadline.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Protocol stub readiness timed out.");
}
