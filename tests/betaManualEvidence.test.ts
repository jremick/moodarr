import { describe, expect, it } from "vitest";
import { BetaManualEvidenceError, buildBetaManualEvidenceSummary, validateBetaManualEvidence } from "../scripts/validate-beta-manual-evidence";

describe("beta manual evidence", () => {
  it("accepts only a complete privacy-safe release matrix", () => {
    const evidence = validEvidence();
    const result = validateBetaManualEvidence(evidence);
    const summary = buildBetaManualEvidenceSummary(JSON.stringify(evidence));

    expect(result).toMatchObject({ passed: true, failures: [] });
    expect(summary).toMatchObject({ status: "passed", candidate: evidence.candidate, failures: [] });
    expect(summary.evidenceSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(summary)).not.toContain("hostname");
  });

  it("fails closed on identity drift, duplicate browsers, console errors, and incomplete checks", () => {
    const evidence = validEvidence();
    evidence.unraid.imageDigest = `sha256:${"f".repeat(64)}`;
    evidence.browsers[1]!.family = "chrome";
    evidence.browsers[0]!.consoleErrorCount = 1;
    evidence.integrations.checks.uncertainOutcomeReconciledWithoutResend = false;
    evidence.responsiveness.native = false;

    expect(validateBetaManualEvidence(evidence)).toMatchObject({
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
});

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
