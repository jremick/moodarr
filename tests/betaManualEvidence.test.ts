import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { aiOffResponsivenessCheckCodes } from "../scripts/beta-responsiveness-contract";
import {
  BetaManualEvidenceError,
  buildBetaManualEvidenceSummary,
  parseBetaManualEvidenceArgs,
  readCanonicalResponsivenessHarnessSha256,
  readResponsivenessReport,
  validateBetaManualEvidence
} from "../scripts/validate-beta-manual-evidence";

describe("beta manual evidence", () => {
  it("accepts only a complete privacy-safe release matrix", () => {
    const { evidence, bindings } = validFixture();
    const result = validateBetaManualEvidence(evidence, bindings);
    const summary = buildBetaManualEvidenceSummary(JSON.stringify(evidence), bindings);

    expect(result).toMatchObject({ passed: true, failures: [] });
    expect(summary).toMatchObject({
      status: "passed",
      candidate: evidence.candidate,
      recordedAt: evidence.recordedAt,
      operatorRole: evidence.operatorRole,
      failures: []
    });
    expect(summary.responsiveness).toEqual(evidence.responsiveness);
    expect(summary.catalog).toEqual(evidence.catalog);
    expect(summary.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(summary)).not.toContain("hostname");
  });

  it("keeps the tracked placeholder template failing even if every boolean is flipped true", () => {
    const template = JSON.parse(readFileSync("docs/beta-manual-evidence-all-false.example.json", "utf8")) as Record<string, unknown>;
    const bypassAttempt = enableAllBooleans(template) as {
      responsiveness: { status: string };
    };
    bypassAttempt.responsiveness.status = "passed";

    expect(validateBetaManualEvidence(bypassAttempt)).toMatchObject({
      passed: false,
      failures: expect.arrayContaining([
        "candidate_digest_placeholder",
        "candidate_revision_placeholder",
        "catalog_asset_hash_mismatch",
        "catalog_record_count_mismatch",
        "catalog_request_attempt_eligible_count_mismatch",
        "catalog_version_mismatch",
        "chrome_platform_version_placeholder",
        "chrome_version_placeholder",
        "docker_version_placeholder",
        "plex_version_placeholder",
        "recorded_at_placeholder",
        "responsiveness_report_hash_placeholder",
        "seerr_version_placeholder",
        "unraid_version_placeholder"
      ])
    });
  });

  it("accepts only the beta.1 release identity", () => {
    const { evidence, bindings } = validFixture();
    evidence.candidate.version = "0.1.0-beta.2";
    evidence.unraid.imageVersion = "0.1.0-beta.2";
    expect(validateBetaManualEvidence(evidence, bindings)).toMatchObject({
      passed: false,
      failures: ["candidate_version_unsupported"]
    });
  });

  it("fails closed on identity drift, duplicate browsers, console errors, and incomplete checks", () => {
    const { evidence, bindings } = validFixture();
    evidence.unraid.imageDigest = `sha256:${"f".repeat(64)}`;
    evidence.browsers[1]!.family = "chrome";
    evidence.browsers[0]!.consoleErrorCount = 1;
    evidence.integrations.checks.uncertainOutcomeReconciledWithoutResend = false;
    evidence.responsiveness.native = false;

    expect(validateBetaManualEvidence(evidence, bindings)).toMatchObject({
      passed: false,
      failures: expect.arrayContaining([
        "browser_matrix_incomplete",
        "chrome_console_errors",
        "integration_uncertain_outcome_reconciled_without_resend",
        "responsiveness_not_native",
        "unraid_digest_mismatch"
      ])
    });
  });

  it("rejects extra fields and version strings that could carry raw environment data", () => {
    const extra = { ...validEvidence(), hostname: "private-host" };
    expect(() => validateBetaManualEvidence(extra)).toThrowError(expect.objectContaining({ code: "evidence_schema_invalid" }));

    const unsafe = validEvidence();
    unsafe.integrations.plex.version = "https://private-host.example/version";
    expect(() => validateBetaManualEvidence(unsafe)).toThrow(BetaManualEvidenceError);

    const impossibleDate = validEvidence();
    impossibleDate.recordedAt = "2026-02-31T01:00:00.000Z";
    expect(() => validateBetaManualEvidence(impossibleDate)).toThrow(BetaManualEvidenceError);
  });

  it("does not echo malformed JSON", () => {
    expect(() => buildBetaManualEvidenceSummary('{"token":"private-secret"')).toThrowError(
      expect.objectContaining({ code: "evidence_json_invalid" })
    );
  });

  it("requires all four explicit CLI bindings with lowercase immutable identities", () => {
    const revision = "a".repeat(40);
    const digest = `sha256:${"b".repeat(64)}`;
    expect(parseBetaManualEvidenceArgs([
      "--responsiveness-report", "report.json",
      "--expected-digest", digest,
      "--input", "evidence.json",
      "--expected-revision", revision
    ])).toEqual({
      inputPath: resolve("evidence.json"),
      expectedRevision: revision,
      expectedDigest: digest,
      responsivenessReportPath: resolve("report.json")
    });
    expect(() => parseBetaManualEvidenceArgs(["--input", "evidence.json"])).toThrowError(
      expect.objectContaining({ code: "arguments_invalid" })
    );
    expect(() => parseBetaManualEvidenceArgs([
      "--input", "evidence.json",
      "--expected-revision", "A".repeat(40),
      "--expected-digest", digest,
      "--responsiveness-report", "report.json"
    ])).toThrowError(expect.objectContaining({ code: "expected_revision_argument_invalid" }));
    expect(() => parseBetaManualEvidenceArgs([
      "--input", "evidence.json",
      "--expected-revision", revision,
      "--expected-digest", `sha256:${"B".repeat(64)}`,
      "--responsiveness-report", "report.json"
    ])).toThrowError(expect.objectContaining({ code: "expected_digest_argument_invalid" }));
  });

  it("binds evidence and the responsiveness report to both expected candidate identities", () => {
    const revisionFixture = validFixture();
    revisionFixture.bindings.expectedRevision = "d".repeat(40);
    expect(validateBetaManualEvidence(revisionFixture.evidence, revisionFixture.bindings)).toMatchObject({
      passed: false,
      failures: expect.arrayContaining([
        "candidate_revision_expected_mismatch",
        "responsiveness_report_revision_mismatch",
        "responsiveness_report_health_revision_mismatch",
        "responsiveness_report_harness_revision_mismatch"
      ])
    });

    const digestFixture = validFixture();
    digestFixture.bindings.expectedDigest = `sha256:${"e".repeat(64)}`;
    expect(validateBetaManualEvidence(digestFixture.evidence, digestFixture.bindings)).toMatchObject({
      passed: false,
      failures: expect.arrayContaining([
        "candidate_digest_expected_mismatch",
        "responsiveness_report_digest_mismatch"
      ])
    });
  });

  it("binds the responsiveness report to the canonical harness blob hash", () => {
    const fixture = validFixture((report) => {
      report.candidate.harnessSha256 = "f".repeat(64);
    });

    expect(validateBetaManualEvidence(fixture.evidence, fixture.bindings)).toMatchObject({
      passed: false,
      failures: expect.arrayContaining(["responsiveness_report_harness_hash_mismatch"])
    });
  });

  it("derives the harness hash from the requested Git blob and fails closed when it is unavailable", () => {
    const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const blob = execFileSync("git", ["show", `${revision}:scripts/benchmark-beta-responsiveness.ts`]);
    const expected = crypto.createHash("sha256").update(blob).digest("hex");
    expect(readCanonicalResponsivenessHarnessSha256(revision)).toBe(expected);

    const directory = mkdtempSync(join(tmpdir(), "moodarr-beta-harness-unavailable-"));
    try {
      expect(() => readCanonicalResponsivenessHarnessSha256(revision, directory)).toThrowError(
        expect.objectContaining({ code: "responsiveness_harness_source_unavailable" })
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("hashes the exact responsiveness report bytes and rejects malformed report content", () => {
    const fixture = validFixture();
    fixture.bindings.responsivenessReport = Buffer.concat([
      fixture.bindings.responsivenessReport,
      Buffer.from("\n")
    ]);
    expect(validateBetaManualEvidence(fixture.evidence, fixture.bindings)).toMatchObject({
      passed: false,
      failures: expect.arrayContaining(["responsiveness_report_hash_mismatch"])
    });

    const malformed = validFixture();
    malformed.bindings.responsivenessReport = Buffer.from('{"schemaVersion":"moodarr-beta-responsiveness-v3"}');
    expect(() => validateBetaManualEvidence(malformed.evidence, malformed.bindings)).toThrowError(
      expect.objectContaining({ code: "responsiveness_report_schema_invalid" })
    );
  });

  it("rejects a report with drifted identity, non-passing status, or a non-native environment", () => {
    const identity = validFixture((report) => {
      report.candidate.healthRevision = "f".repeat(40);
      report.candidate.expectedVersion = "0.1.0-beta.2";
    });
    expect(validateBetaManualEvidence(identity.evidence, identity.bindings)).toMatchObject({
      passed: false,
      failures: expect.arrayContaining([
        "responsiveness_report_health_revision_mismatch",
        "responsiveness_report_version_mismatch"
      ])
    });

    const failed = validFixture((report) => {
      report.status = "failed";
      report.failures = ["health_p99"];
      report.checks[0]!.status = "failed";
    });
    expect(validateBetaManualEvidence(failed.evidence, failed.bindings)).toMatchObject({
      passed: false,
      failures: expect.arrayContaining([
        "responsiveness_report_not_passed",
        "responsiveness_report_check_not_passed"
      ])
    });

    const nonNative = validFixture((report) => {
      report.environment.architecture = "arm64";
      report.environment.localDockerDaemon = false;
    });
    expect(validateBetaManualEvidence(nonNative.evidence, nonNative.bindings)).toMatchObject({
      passed: false,
      failures: expect.arrayContaining(["responsiveness_report_not_native"])
    });
  });

  it("requires the complete AI-off v3 check contract exactly once", () => {
    const missing = validFixture((report) => {
      report.checks = report.checks.slice(1);
    });
    expect(validateBetaManualEvidence(missing.evidence, missing.bindings)).toMatchObject({
      passed: false,
      failures: expect.arrayContaining(["responsiveness_report_checks_missing"])
    });

    const duplicate = validFixture((report) => {
      report.checks.push({ ...report.checks[0]! });
    });
    expect(validateBetaManualEvidence(duplicate.evidence, duplicate.bindings)).toMatchObject({
      passed: false,
      failures: expect.arrayContaining(["responsiveness_report_checks_duplicate"])
    });

    const unknown = validFixture((report) => {
      report.checks.push({ code: "unrecognized_gate", status: "passed" });
    });
    expect(validateBetaManualEvidence(unknown.evidence, unknown.bindings)).toMatchObject({
      passed: false,
      failures: expect.arrayContaining(["responsiveness_report_checks_unknown"])
    });
  });

  it("rejects future and older-than-14-days evidence deterministically", () => {
    const future = validFixture();
    future.evidence.recordedAt = "2026-07-14T02:00:00.001Z";
    expect(validateBetaManualEvidence(future.evidence, future.bindings)).toMatchObject({
      passed: false,
      failures: expect.arrayContaining(["recorded_at_future"])
    });

    const stale = validFixture();
    stale.evidence.recordedAt = "2026-06-30T01:59:59.999Z";
    expect(validateBetaManualEvidence(stale.evidence, stale.bindings)).toMatchObject({
      passed: false,
      failures: expect.arrayContaining(["recorded_at_stale"])
    });

    const boundary = validFixture((report) => {
      report.startedAt = "2026-06-30T00:00:00.000Z";
      report.finishedAt = "2026-06-30T00:30:00.000Z";
    });
    boundary.evidence.recordedAt = "2026-06-30T02:00:00.000Z";
    expect(validateBetaManualEvidence(boundary.evidence, boundary.bindings)).toMatchObject({
      passed: true,
      failures: []
    });
  });

  it("reads only bounded regular non-symlink responsiveness reports", () => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-beta-evidence-"));
    try {
      const reportPath = join(directory, "report.json");
      const linkPath = join(directory, "report-link.json");
      const directoryPath = join(directory, "not-a-report");
      const oversizedPath = join(directory, "oversized-report.json");
      writeFileSync(reportPath, validFixture().bindings.responsivenessReport);
      writeFileSync(oversizedPath, Buffer.alloc(8 * 1024 * 1024 + 1));
      symlinkSync(reportPath, linkPath);
      mkdirSync(directoryPath);

      expect(readResponsivenessReport(reportPath).length).toBeGreaterThan(0);
      expect(() => readResponsivenessReport(linkPath)).toThrowError(
        expect.objectContaining({ code: "responsiveness_report_file_invalid" })
      );
      expect(() => readResponsivenessReport(directoryPath)).toThrowError(
        expect.objectContaining({ code: "responsiveness_report_file_invalid" })
      );
      expect(() => readResponsivenessReport(oversizedPath)).toThrowError(
        expect.objectContaining({ code: "responsiveness_report_file_invalid" })
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function enableAllBooleans(value: unknown): unknown {
  if (typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.map(enableAllBooleans);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, enableAllBooleans(child)]));
  }
  return value;
}

function validEvidence() {
  const checks = {
    signIn: true,
    search: true,
    resultActions: true,
    requestConfirmation: true,
    adminAccess: true,
    keyboardNavigation: true,
    visibleFocus: true,
    mobileWidthLayout: true,
    reducedMotion: true
  };
  const revision = "a".repeat(40);
  const digest = `sha256:${"b".repeat(64)}`;
  return {
    schemaVersion: "moodarr-beta-manual-evidence-v1" as const,
    candidate: { version: "0.1.0-beta.1", revision, digest },
    recordedAt: "2026-07-14T01:00:00.000Z",
    operatorRole: "maintainer" as const,
    unraid: {
      version: "7.1.4",
      dockerVersion: "28.3.3",
      architecture: "amd64" as const,
      imageVersion: "0.1.0-beta.1",
      imageRevision: revision,
      imageDigest: digest,
      checks: {
        cleanTemplateImport: true,
        exactDigest: true,
        nonRootUser: true,
        readOnlyRoot: true,
        noNewPrivileges: true,
        capabilitiesDropped: true,
        resourceLimits: true,
        healthy: true,
        exactOriginSession: true,
        restartPersistence: true,
        priorVersionUpdate: true,
        cleanupComplete: true
      }
    },
    integrations: {
      plex: { product: "Plex Media Server" as const, version: "1.41.9.9961-46083195d" },
      seerr: { product: "Seerr" as const, version: "3.3.0" },
      checks: {
        plexLibrarySync: true,
        plexSignIn: true,
        plexCapabilityDefaults: true,
        plexPosterAndLink: true,
        plexWatchlistAction: true,
        seerrStateSync: true,
        requestPreview: true,
        controlledRequestCreatedOnce: true,
        idempotentRetry: true,
        uncertainOutcomeReconciledWithoutResend: true,
        upstreamCleanupComplete: true
      }
    },
    catalog: {
      version: "wikidata-20260622-min5-v1",
      assetSha256: "dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a",
      records: 90_397,
      requestAttemptEligibleRecords: 82_865,
      checks: {
        exactAsset: true,
        networklessFullSnapshotImport: true,
        genericSearchIsolation: true,
        requestAttemptDisclosure: true
      }
    },
    responsiveness: {
      reportSha256: "c".repeat(64),
      status: "passed" as const,
      operatingSystem: "linux" as const,
      architecture: "amd64" as const,
      native: true,
      cpuLimit: 2 as const,
      memoryMiB: 2048 as const
    },
    browsers: [
      { family: "chrome" as const, version: "149.0.0.0", platform: "linux" as const, platformVersion: "24.04", consoleErrorCount: 0, checks: { ...checks } },
      { family: "edge" as const, version: "149.0.0.0", platform: "windows" as const, platformVersion: "11.0", consoleErrorCount: 0, checks: { ...checks } },
      { family: "firefox" as const, version: "141.0", platform: "linux" as const, platformVersion: "24.04", consoleErrorCount: 0, checks: { ...checks } },
      { family: "safari" as const, version: "26.5.2", platform: "macos" as const, platformVersion: "26.5", consoleErrorCount: 0, checks: { ...checks } }
    ]
  };
}

function validResponsivenessReport(evidence: ReturnType<typeof validEvidence>) {
  return {
    schemaVersion: "moodarr-beta-responsiveness-v3",
    aiMode: "none",
    status: "passed",
    startedAt: "2026-07-14T00:00:00.000Z",
    finishedAt: "2026-07-14T00:30:00.000Z",
    candidate: {
      digest: evidence.candidate.digest,
      expectedRevision: evidence.candidate.revision,
      expectedVersion: evidence.candidate.version,
      healthRevision: evidence.candidate.revision,
      healthVersion: evidence.candidate.version,
      aiProviderPolicy: "none",
      tmdbContentPolicy: "none",
      harnessRevision: evidence.candidate.revision,
      harnessSha256: "d".repeat(64)
    },
    environment: {
      catalogLabelSha256: "e".repeat(64),
      originClass: "loopback",
      architecture: "amd64",
      operatingSystem: "linux",
      localDockerDaemon: true,
      cpuLimit: 2,
      memoryMiB: 2048,
      pidLimit: 128,
      readOnlyRoot: true,
      imageDigestMatched: true,
      disposableVolumeVerified: true,
      disposableDataConfirmed: true,
      externalProcessingConfirmed: false
    },
    checks: aiOffResponsivenessCheckCodes.map((code) => ({ code, status: "passed" })) as Array<{
      code: string;
      status: "passed" | "failed" | "incomplete";
    }>,
    failures: [] as string[],
    incompleteReasons: [] as string[]
  };
}

function validFixture(mutateReport?: (report: ReturnType<typeof validResponsivenessReport>) => void) {
  const evidence = validEvidence();
  const report = validResponsivenessReport(evidence);
  mutateReport?.(report);
  const responsivenessReport = Buffer.from(JSON.stringify(report));
  evidence.responsiveness.reportSha256 = crypto.createHash("sha256").update(responsivenessReport).digest("hex");
  return {
    evidence,
    bindings: {
      expectedRevision: evidence.candidate.revision,
      expectedDigest: evidence.candidate.digest,
      expectedHarnessSha256: "d".repeat(64),
      responsivenessReport,
      now: new Date("2026-07-14T02:00:00.000Z")
    }
  };
}
