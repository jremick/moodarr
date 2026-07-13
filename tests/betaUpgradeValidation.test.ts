import { describe, expect, it } from "vitest";
import {
  UpgradeValidationError,
  alphaIndexImage,
  alphaPlatformDigest,
  appContainerSecurityArgs,
  assessStateTransitions,
  buildPublicReport,
  findForbiddenPublicEvidence,
  isAcceptedGracefulStopExit,
  normalizeDockerPlatform,
  parseUpgradeArgs,
  resolveTrustedHostExecutable,
  resolveAmd64ManifestDigest,
  upgradeFixtureTimestamp,
  validateDatabaseObservation,
  validateRequestCreationResponse,
  validateSearchResponseShape,
  validateSourceSnapshot,
  type AggregateState,
  type DatabaseObservation,
  type UpgradeOptions
} from "../scripts/validate-beta-upgrade";

const revision = "960ab9cded1440eb274b851ef230b1d86bd83f2d";
const digest = `ghcr.io/jremick/moodarr@sha256:${"a".repeat(64)}`;

describe("beta upgrade validation", () => {
  it("accepts only an exact official GHCR digest and rejects official escape flags", () => {
    expect(parseUpgradeArgs(officialArgs())).toMatchObject({ official: true, allowDirty: false, allowEmulation: false });
    expect(() => parseUpgradeArgs([...officialArgs(), "--allow-dirty"])).toThrowError(
      expect.objectContaining({ code: "official_overrides_rejected" })
    );
    const tagged = officialArgs();
    tagged[tagged.indexOf("--candidate-image") + 1] = "ghcr.io/jremick/moodarr:v0.1.0-beta.1";
    expect(() => parseUpgradeArgs(tagged)).toThrow(UpgradeValidationError);
    const uppercase = officialArgs();
    uppercase[uppercase.indexOf("--candidate-image") + 1] = `ghcr.io/jremick/moodarr@sha256:${"A".repeat(64)}`;
    expect(() => parseUpgradeArgs(uppercase)).toThrow(UpgradeValidationError);
  });

  it("makes every local image an explicitly acknowledged, ineligible rehearsal", () => {
    const base = ["--candidate-image", "moodarr:beta-validation-local", "--expected-version", "0.1.0-beta.1", "--expected-revision", revision];
    expect(() => parseUpgradeArgs(base)).toThrowError(expect.objectContaining({ code: "local_rehearsal_acknowledgements_required" }));
    expect(() => parseUpgradeArgs([...base, "--allow-local-image"])).toThrowError(
      expect.objectContaining({ code: "local_rehearsal_acknowledgements_required" })
    );
    const options = parseUpgradeArgs([...base, "--allow-local-image", "--allow-dirty", "--allow-emulation"]);
    expect(options).toMatchObject({ official: false, allowDirty: true, allowLocalImage: true, allowEmulation: true });
    expect(buildPublicReport(reportInput(options)).releaseEligible).toBe(false);
    expect(buildPublicReport(reportInput(options)).incomplete).toEqual(expect.arrayContaining(["local_rehearsal", "amd64_emulation"]));
  });

  it("binds official evidence to a clean exact HEAD and tracked script", () => {
    const options = parseUpgradeArgs(officialArgs());
    const valid = { headRevision: revision, dirty: false, scriptMatchesHead: true, packageVersion: "0.1.0-beta.1" };
    expect(() => validateSourceSnapshot(options, valid)).not.toThrow();
    expect(() => validateSourceSnapshot(options, { ...valid, dirty: true })).toThrowError(expect.objectContaining({ code: "dirty_worktree" }));
    expect(() => validateSourceSnapshot(options, { ...valid, scriptMatchesHead: false })).toThrowError(
      expect.objectContaining({ code: "script_not_bound_to_head" })
    );
    expect(() => validateSourceSnapshot(options, { ...valid, headRevision: "1".repeat(40) })).toThrowError(
      expect.objectContaining({ code: "revision_not_head" })
    );
  });

  it("requires the expected schema and SQLite integrity result", () => {
    expect(validateDatabaseObservation(database(21, "ok"), 21)).toEqual([]);
    expect(validateDatabaseObservation(database(28, "corrupt"), 21)).toEqual(["schema_version", "database_integrity", "schema_migrations"]);
    expect(validateDatabaseObservation({ ...database(21, "ok"), configJsonValid: false }, 21)).toEqual(["config_json"]);
  });

  it("fails closed when mandatory database evidence or SHA-256 hashes are missing", () => {
    const missing = { ...database(21, "ok") } as Partial<DatabaseObservation>;
    delete missing.foreignKeysOk;
    delete missing.migrationIdsExact;
    delete missing.configMode0600;
    delete missing.externalMediaTypesValid;
    expect(validateDatabaseObservation(missing as DatabaseObservation, 21)).toEqual(expect.arrayContaining([
      "foreign_keys", "schema_migrations", "config_mode", "external_media_types"
    ]));
    const malformed = database(21, "ok");
    malformed.canonical = { ...malformed.canonical!, profiles: "not-a-sha256" };
    expect(validateDatabaseObservation(malformed, 21)).toContain("canonical_hashes");
  });

  it("preserves aggregate state while migrating group:default to group:shared", () => {
    const before = state("group:default");
    const candidate = state("group:shared");
    const candidateDb = database(28, "ok", { groupDefaultProfiles: 0, groupSharedProfiles: 1, syntheticUserCapabilities: true });
    const result = assessStateTransitions(before, candidate, candidate, before, {
      before: database(21, "ok", { groupDefaultProfiles: 1, groupSharedProfiles: 0 }),
      candidate: candidateDb,
      restarted: candidateDb,
      rollback: database(21, "ok", { groupDefaultProfiles: 1, groupSharedProfiles: 0 })
    });
    expect(result.failures).toEqual([]);
    expect(result.checks).toEqual(expect.arrayContaining(["candidate_profile_migrated", "candidate_restart_preserved", "rollback_state_preserved", "database_group_profile_migrated"]));
    expect(result.checks).toContain("representative_catalog_80000");
    expect(result.incomplete).toEqual([]);
  });

  it("fails state loss, wrong profile migration, schema, and integrity", () => {
    const before = state("group:default");
    const candidate = state("group:default");
    candidate.catalog.total -= 1;
    const result = assessStateTransitions(before, candidate, candidate, before, {
      before: database(20, "ok"), candidate: database(27, "not ok"), restarted: database(27, "not ok"), rollback: database(28, "ok")
    });
    expect(result.failures).toEqual(expect.arrayContaining([
      "before_schema_version", "candidate_schema_version", "candidate_database_integrity", "rollback_schema_version",
      "candidate_catalog_preserved", "candidate_profile_migrated", "database_group_profile_migrated"
    ]));
  });

  it("selects the exact linux/amd64 manifest and fails closed when it is absent", () => {
    const raw = JSON.stringify({ manifests: [
      { digest: "sha256:arm", platform: { os: "linux", architecture: "arm64" } },
      { digest: alphaPlatformDigest, platform: { os: "linux", architecture: "amd64" } }
    ] });
    expect(resolveAmd64ManifestDigest(raw, digest)).toBe(alphaPlatformDigest);
    expect(() => resolveAmd64ManifestDigest(JSON.stringify({ manifests: [] }), digest)).toThrowError(
      expect.objectContaining({ code: "amd64_manifest_missing" })
    );
  });

  it("normalizes Docker's native architecture aliases", () => {
    expect(normalizeDockerPlatform("linux/x86_64\n")).toBe("linux/amd64");
    expect(normalizeDockerPlatform("linux/amd64")).toBe("linux/amd64");
    expect(normalizeDockerPlatform("linux/aarch64")).toBe("linux/arm64");
  });

  it("resolves host tools only from fixed trusted directories", () => {
    expect(resolveTrustedHostExecutable("git", ["/usr/bin"])).toMatch(/\/git$/);
    expect(() => resolveTrustedHostExecutable("git", ["node_modules/.bin"])).toThrowError(/trusted_git_not_found/);
  });

  it("accepts only expected graceful-stop exit codes", () => {
    expect(isAcceptedGracefulStopExit(alphaIndexImage, 143)).toBe(true);
    expect(isAcceptedGracefulStopExit(alphaIndexImage, 0)).toBe(true);
    expect(isAcceptedGracefulStopExit(digest, 0)).toBe(true);
    expect(isAcceptedGracefulStopExit(alphaIndexImage, 137)).toBe(false);
    expect(isAcceptedGracefulStopExit(digest, 143)).toBe(false);
  });

  it("captures the upgrade fixture timestamp at rehearsal time so poster-cache proof cannot expire", () => {
    const now = Date.parse("2030-02-03T04:05:06.789Z");
    expect(upgradeFixtureTimestamp(now)).toBe("2030-02-03T04:05:06.789Z");
    expect(() => upgradeFixtureTimestamp(Number.NaN)).toThrowError(
      expect.objectContaining({ code: "invalid_fixture_timestamp" })
    );
  });

  it("fails closed on malformed search and request-creation responses", () => {
    expect(validateSearchResponseShape({ results: [], sessionId: "session-1", usedAi: false })).toBe(true);
    expect(validateSearchResponseShape({ results: [], sessionId: "session-1" })).toBe(false);
    expect(validateSearchResponseShape({ results: [], sessionId: "session-1", usedAi: "false" })).toBe(false);
    const created = { ok: true, request: { mediaType: "movie", mediaId: 42, title: "Fixture" }, seerr: { id: "fixture-42", status: "created" } };
    expect(validateRequestCreationResponse(created)).toBe(true);
    expect(validateRequestCreationResponse({ ...created, ok: false })).toBe(false);
    expect(validateRequestCreationResponse({ ...created, seerr: { status: "created" } })).toBe(false);
  });

  it("detects loss of the canonical baseline recommendation graph", () => {
    const before = state("group:default");
    const candidate = state("group:shared");
    const candidateDb = database(28, "ok");
    candidateDb.canonical = { ...candidateDb.canonical!, recommendations: "f".repeat(64) };
    const result = assessStateTransitions(before, candidate, candidate, before, {
      before: database(21, "ok"), candidate: candidateDb, restarted: database(28, "ok"), rollback: database(21, "ok")
    });
    expect(result.failures).toContain("canonical_recommendations_preserved");
  });

  it("emits only allowlisted aggregate public evidence", () => {
    const report = buildPublicReport(reportInput(parseUpgradeArgs(officialArgs())));
    const serialized = JSON.stringify(report);
    expect(report.status).toBe("passed");
    expect(report.releaseEligible).toBe(true);
    expect(findForbiddenPublicEvidence(report)).toEqual([]);
    for (const secret of [
      "admin-token-value", "http://127.0.0.1:4401", "/Users/example/private", "moodarr-upgrade-deadbeef-original",
      "Secret Movie Title", "funny fantasy"
    ]) expect(serialized).not.toContain(secret);
    expect(findForbiddenPublicEvidence({ token: "admin-token-value", endpoint: "http://127.0.0.1:4401" })).not.toEqual([]);
    for (const unsafe of [
      "ftp://example.test/private", "file:///etc/passwd", "/home/example/private", "/var/lib/moodarr", "/opt/moodarr/private.bin", "C:\\Users\\example\\secret",
      "ghp_1234567890abcdef", "sk-1234567890abcdef", "Bearer opaque-value", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature"
    ]) expect(findForbiddenPublicEvidence({ evidence: unsafe }), unsafe).not.toEqual([]);
    expect(serialized).not.toContain("group:default");
  });

  it("pins the exact app-container confinement and graceful stop contract", () => {
    const args = appContainerSecurityArgs("owned-volume", 4455);
    expect(args).toEqual(expect.arrayContaining([
      "--read-only", "--privileged=false", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true",
      "--pids-limit", "128", "--memory", "2g", "--memory-swap", "2g", "--cpus", "2", "--user", "999:999",
      "--stop-timeout", "30", "127.0.0.1:4455:4401", "type=volume,src=owned-volume,dst=/data"
    ]));
    expect(args.filter((value) => value === "--tmpfs")).toHaveLength(1);
  });

  it("fails closed on non-allowlisted evidence codes", () => {
    const options = parseUpgradeArgs(officialArgs());
    const report = buildPublicReport({ ...reportInput(options), checks: ["invented_check"], failures: ["dynamic_failure_with_private_detail"] });
    expect(report.status).toBe("failed");
    expect(report.checks).not.toContain("invented_check");
    expect(report.failures).toContain("unexpected_failure");
    expect(JSON.stringify(report)).not.toContain("private_detail");
  });
});

function officialArgs() {
  return ["--candidate-image", digest, "--expected-version", "0.1.0-beta.1", "--expected-revision", revision];
}

function state(id: string): AggregateState {
  return {
    catalog: { total: 10, plex: 6, seerr: 4 },
    settings: { fixtureMode: true, syncInterval: 0, resultLimit: 37, retentionDays: 45, maxQueries: 321 },
    profile: { id, terms: 1, maxVersion: 1, feedback: 1 },
    requests: { total: 2, previews: 1, creates: 1, blocked: 0, failed: 0 }
  };
}

function database(schemaVersion: number, integrity: string, overrides: Partial<DatabaseObservation> = {}): DatabaseObservation {
  const migrated = schemaVersion === 28;
  const canonical = {
    config: "1".repeat(64), configRaw: "0".repeat(64), profiles: "2".repeat(64), checkpoints: "3".repeat(64), feedback: "4".repeat(64),
    requestAudits: "5".repeat(64), mediaExternalIds: "6".repeat(64), catalogRelationships: "b".repeat(64), recommendations: "a".repeat(64), userSessions: "7".repeat(64), poster: "8".repeat(64), posterBody: "9".repeat(64)
  };
  return {
    schemaVersion,
    integrity,
    integrityOk: integrity === "ok",
    foreignKeysOk: true,
    migrationCount: schemaVersion,
    migrationIdsExact: schemaVersion === 21 || migrated,
    totalItems: 80_000,
    plexItems: 6,
    seerrItems: 4,
    externalIds: 80_020,
    externalMediaTypesValid: true,
    requestAudits: 3,
    attributedRequestAudits: 1,
    feedbackEvents: 1,
    profileTerms: 1,
    profileCheckpoints: 1,
    groupDefaultProfiles: schemaVersion === 21 ? 1 : 0,
    groupSharedProfiles: migrated ? 1 : 0,
    groupDefaultRecommendationSessions: schemaVersion === 21 ? 1 : 0,
    groupSharedRecommendationSessions: migrated ? 1 : 0,
    appUsers: 1,
    userSessions: 1,
    syntheticUserCapabilities: migrated,
    posterRows: 1,
    posterSvgRows: 1,
    posterPngJpegRows: 0,
    posterByteSizeBackfilled: true,
    posterLastAccessBackfilled: true,
    configJsonValid: true,
    configMode0600: true,
    configOwner999: true,
    canonical,
    ...overrides
  };
}

function reportInput(options: UpgradeOptions) {
  const before = state("group:default");
  const candidate = state("group:shared");
  return {
    options,
    candidatePlatformDigest: "sha256:" + "b".repeat(64),
    archiveSha256: "c".repeat(64),
    before,
    candidate,
    restarted: candidate,
    rollback: before,
    beforeDatabase: database(21, "ok"),
    candidateDatabase: database(28, "ok"),
    restartedDatabase: database(28, "ok"),
    rollbackDatabase: database(21, "ok")
  };
}
