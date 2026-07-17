import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  UpgradeValidationError,
  assessIntegrationStubReadiness,
  alphaIndexImage,
  alphaPlatformDigest,
  appContainerSecurityArgs,
  assessStateTransitions,
  buildPublicReport,
  buildUpgradeIntegrationFixture,
  candidateMigrationIds,
  databaseInspectionScriptV2,
  findForbiddenPublicEvidence,
  integrationStubReadyMarker,
  isAcceptedGracefulStopExit,
  normalizeDockerPlatform,
  ownedResourceListArgs,
  parseUpgradeArgs,
  requiredUpgradeCheckCodes,
  resolveTrustedHostExecutable,
  resolveAmd64ManifestDigest,
  upgradeFixtureTimestamp,
  validateCandidateReleaseLabels,
  validateCandidateTmdbPolicySurfaces,
  validateDatabaseObservation,
  validatePlexRecoverySearchResults,
  validateTrustedCatalogRecoverySearchResults,
  validateTrustedRefreshClearedDiagnostics,
  validateRequestCreationResponse,
  validateSearchResponseShape,
  validateSourceSnapshot,
  writeUpgradeIntegrationFixture,
  type AggregateState,
  type DatabaseObservation,
  type UpgradeOptions
} from "../scripts/validate-beta-upgrade";

const revision = "960ab9cded1440eb274b851ef230b1d86bd83f2d";
const digest = `ghcr.io/jremick/moodarr@sha256:${"a".repeat(64)}`;

describe("beta upgrade validation", () => {
  it("makes the completed integration fixture readable by the unprivileged helper", () => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-beta-upgrade-fixture-"));
    const fixture = join(directory, "integrations.mjs");
    try {
      writeUpgradeIntegrationFixture(fixture, readFileSync("scripts/fixtures/beta-install-integrations.mjs", "utf8"));
      expect(statSync(fixture).mode & 0o777).toBe(0o644);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
    const cleanOptions = parseUpgradeArgs([...base, "--allow-local-image"]);
    expect(cleanOptions).toMatchObject({ official: false, allowDirty: false, allowLocalImage: true, allowEmulation: false });
    const options = parseUpgradeArgs([...base, "--allow-local-image", "--allow-dirty", "--allow-emulation"]);
    expect(options).toMatchObject({ official: false, allowDirty: true, allowLocalImage: true, allowEmulation: true });
    expect(buildPublicReport(reportInput(options)).releaseEligible).toBe(false);
    expect(buildPublicReport(reportInput(options)).incomplete).toEqual(expect.arrayContaining(["local_rehearsal", "amd64_emulation"]));
  });

  it("requires the candidate OCI and runtime TMDB policy to remain none", () => {
    const labels = {
      "org.opencontainers.image.version": "0.1.0-beta.1",
      "org.opencontainers.image.revision": revision,
      "io.moodarr.ai-provider-policy": "none",
      "io.moodarr.tmdb-content-policy": "none"
    };
    expect(validateCandidateReleaseLabels(labels, "0.1.0-beta.1", revision)).toBe(true);
    expect(validateCandidateReleaseLabels({ ...labels, "io.moodarr.tmdb-content-policy": "configurable" }, "0.1.0-beta.1", revision)).toBe(false);
    expect(validateCandidateReleaseLabels({ ...labels, "io.moodarr.tmdb-content-policy": undefined }, "0.1.0-beta.1", revision)).toBe(false);

    const health = { policies: { aiProvider: "none", tmdbContent: "none" } };
    const publicConfig = { seerr: { tmdbContentPolicy: "none" } };
    const settings = { seerr: { tmdbContentPolicy: "none" } };
    expect(validateCandidateTmdbPolicySurfaces(health, publicConfig, settings)).toBe(true);
    expect(validateCandidateTmdbPolicySurfaces(
      { policies: { ...health.policies, tmdbContent: "configurable" } }, publicConfig, settings
    )).toBe(false);
    expect(validateCandidateTmdbPolicySurfaces(health, { seerr: { tmdbContentPolicy: "configurable" } }, settings)).toBe(false);
    expect(validateCandidateTmdbPolicySurfaces(health, publicConfig, {
      seerr: { tmdbContentPolicy: "configurable" }
    })).toBe(false);
  });

  it("binds official and clean local evidence to exact HEAD, version, and tracked script", () => {
    const options = parseUpgradeArgs(officialArgs());
    const localOptions = parseUpgradeArgs([
      "--candidate-image", "moodarr:beta-validation-local",
      "--expected-version", "0.1.0-beta.1",
      "--expected-revision", revision,
      "--allow-local-image"
    ]);
    const valid = { headRevision: revision, dirty: false, scriptMatchesHead: true, packageVersion: "0.1.0-beta.1" };
    expect(() => validateSourceSnapshot(options, valid)).not.toThrow();
    expect(() => validateSourceSnapshot(localOptions, valid)).not.toThrow();
    expect(() => validateSourceSnapshot(localOptions, { ...valid, dirty: true })).toThrowError(
      expect.objectContaining({ code: "dirty_worktree" })
    );
    expect(() => validateSourceSnapshot(localOptions, { ...valid, scriptMatchesHead: false })).toThrowError(
      expect.objectContaining({ code: "script_not_bound_to_head" })
    );
    expect(() => validateSourceSnapshot(options, { ...valid, dirty: true })).toThrowError(expect.objectContaining({ code: "dirty_worktree" }));
    expect(() => validateSourceSnapshot(options, { ...valid, scriptMatchesHead: false })).toThrowError(
      expect.objectContaining({ code: "script_not_bound_to_head" })
    );
    expect(() => validateSourceSnapshot(options, { ...valid, headRevision: "1".repeat(40) })).toThrowError(
      expect.objectContaining({ code: "revision_not_head" })
    );

    const dirtyOptions = { ...localOptions, allowDirty: true };
    expect(() => validateSourceSnapshot(dirtyOptions, { ...valid, dirty: true, scriptMatchesHead: false })).not.toThrow();
    expect(() => validateSourceSnapshot(dirtyOptions, { ...valid, headRevision: "1".repeat(40) })).toThrowError(
      expect.objectContaining({ code: "revision_not_head" })
    );
    expect(() => validateSourceSnapshot(dirtyOptions, { ...valid, packageVersion: "0.1.0-beta.0" })).toThrowError(
      expect.objectContaining({ code: "package_version_mismatch" })
    );
  });

  it("requires the expected schema and SQLite integrity result", () => {
    expect(validateDatabaseObservation(database(21, "ok"), 21)).toEqual([]);
    expect(validateDatabaseObservation(database(28, "corrupt"), 21)).toEqual(["schema_version", "database_integrity", "schema_migrations"]);
    expect(validateDatabaseObservation({ ...database(21, "ok"), configJsonValid: false }, 21)).toEqual(["config_json"]);
  });

  it("generates schema-21 and schema-31 inspectors while keeping schema 31 on the modern branch", () => {
    const alphaInspector = databaseInspectionScriptV2(["001_initial_schema"], 21, "baseline-session");
    const candidateInspector = databaseInspectionScriptV2(candidateMigrationIds, 31, "baseline-session");

    expect(() => new Function(alphaInspector)).not.toThrow();
    expect(() => new Function(candidateInspector)).not.toThrow();
    expect(candidateMigrationIds).toHaveLength(31);
    expect(candidateMigrationIds.slice(-3)).toEqual([
      "029_strict_tmdb_content_boundary",
      "030_retrieval_performance_indexes",
      "031_integration_identity_quarantine"
    ]);
    expect(candidateInspector).toContain("requestOperationsTable=true");
    expect(candidateInspector).toContain("source_key,byte_size,last_accessed_at");
    expect(candidateInspector).toContain("e.media_type AS external_media_type");
    expect(candidateInspector).toContain("media_type='movie' AND value=?");
    expect(alphaInspector).toContain("requestOperationsTable=false");
    expect(alphaInspector).toContain("NULL AS source_key,length(body) AS byte_size,fetched_at AS last_accessed_at");
    expect(alphaInspector.match(/NOT IN \(\?,\?\)/g)).toHaveLength(3);
    expect(alphaInspector).toContain('["catalog-collision-tv","catalog-collision-movie"]');
    expect(alphaInspector).not.toContain('NOT IN ("catalog-collision-tv","catalog-collision-movie")');
  });

  it("adapts the strict protocol stub only for alpha unpaginated Plex compatibility", () => {
    const source = readFileSync("scripts/fixtures/beta-install-integrations.mjs", "utf8");
    const upgraded = buildUpgradeIntegrationFixture(source);
    expect(upgraded).not.toBe(source);
    expect(upgraded).toContain("const alphaUnpaged = pageSize === undefined && startHeader === undefined;");
    expect(upgraded).toContain('(!alphaUnpaged && pageSize !== "500")');
    expect(source).not.toContain(integrationStubReadyMarker);
    expect(upgraded).toContain(`process.stdout.write("${integrationStubReadyMarker}\\n");`);
    expect(() => buildUpgradeIntegrationFixture(upgraded)).toThrowError(
      expect.objectContaining({ code: "integration_fixture_contract_mismatch" })
    );
  });

  it("requires an exact readiness marker and a still-running integration stub", () => {
    const running = { Running: true, Restarting: false, OOMKilled: false };
    expect(assessIntegrationStubReadiness(`booting\n${integrationStubReadyMarker}\n`, running)).toBe("ready");
    expect(assessIntegrationStubReadiness(`${integrationStubReadyMarker}-not-exact\n`, running)).toBe("waiting");
    expect(assessIntegrationStubReadiness(`${integrationStubReadyMarker}\n`, { ...running, Running: false })).toBe("not_running");
    expect(assessIntegrationStubReadiness(`${integrationStubReadyMarker}\n`, { ...running, Restarting: true })).toBe("not_running");
  });

  it("validates Plex recovery through the supported public projection", () => {
    const result = {
      title: "Beta Candidate Lantern",
      year: 2023,
      summary: "Friends follow a lantern through a quiet fantasy adventure.",
      availabilityGroup: "available_in_plex",
      plex: {
        available: true,
        library: "Candidate Library",
        url: "https://app.plex.tv/desktop/#!/server/candidate-stub-machine/details?key=%2Flibrary%2Fmetadata%2F1002",
        appUrl: "plex://play/?metadataKey=%2Flibrary%2Fmetadata%2F1002&server=candidate-stub-machine"
      }
    };
    expect(validatePlexRecoverySearchResults([result])).toBe(true);
    expect(validatePlexRecoverySearchResults([{ ...result, plex: { ...result.plex, url: result.plex.url.replace("1002", "1001") } }])).toBe(false);
    expect(validatePlexRecoverySearchResults([result, result])).toBe(false);
  });

  it("validates trusted catalog recovery and cleared diagnostics through public fields", () => {
    const result = {
      id: "trusted-refresh-sentinel",
      title: "Synthetic Trusted Catalog Recovery Sentinel",
      year: 1994,
      summary: "Self-authored trusted catalog metadata restored by the packaged importer.",
      availabilityGroup: "not_in_plex_requestable",
      metadata: { source: "catalog", catalogSourceCount: 1 },
      seerr: { requestable: true, mediaId: 987654320 }
    };
    const diagnostics = {
      features: {
        catalog: {
          trustedRefreshRequiredItems: 0,
          requestableTrustedRefreshRequiredItems: 0,
          catalogRefreshRequiredItems: 0,
          plexRefreshRequiredItems: 0
        }
      }
    };
    expect(validateTrustedCatalogRecoverySearchResults([result])).toBe(true);
    expect(validateTrustedCatalogRecoverySearchResults([{ ...result, seerr: undefined }])).toBe(false);
    expect(validateTrustedRefreshClearedDiagnostics(diagnostics)).toBe(true);
    expect(validateTrustedRefreshClearedDiagnostics({
      features: { catalog: { ...diagnostics.features.catalog, catalogRefreshRequiredItems: 1 } }
    })).toBe(false);
  });

  it("discovers owned Docker resources by the same names used for tracking", () => {
    const owner = "fixture-owner";
    expect(ownedResourceListArgs("container", owner)).toEqual([
      "ps", "-a", "--filter", "label=dev.moodarr.beta-upgrade-owner=fixture-owner", "--format", "{{.Names}}"
    ]);
    expect(ownedResourceListArgs("volume", owner)).toEqual([
      "volume", "ls", "--filter", "label=dev.moodarr.beta-upgrade-owner=fixture-owner", "--format", "{{.Name}}"
    ]);
    expect(ownedResourceListArgs("network", owner)).toEqual([
      "network", "ls", "--filter", "label=dev.moodarr.beta-upgrade-owner=fixture-owner", "--format", "{{.Name}}"
    ]);
  });

  it("fails closed when mandatory database evidence or SHA-256 hashes are missing", () => {
    const missing = { ...database(21, "ok") } as Partial<DatabaseObservation>;
    delete missing.foreignKeysOk;
    delete missing.migrationIdsExact;
    delete missing.configMode0600;
    delete missing.externalMediaTypesValid;
    delete missing.trustedRefresh;
    delete missing.plexRefresh;
    expect(validateDatabaseObservation(missing as DatabaseObservation, 21)).toEqual(expect.arrayContaining([
      "foreign_keys", "schema_migrations", "config_mode", "external_media_types", "trusted_refresh", "plex_refresh"
    ]));
    const malformed = database(21, "ok");
    malformed.canonical = { ...malformed.canonical!, profiles: "not-a-sha256" };
    expect(validateDatabaseObservation(malformed, 21)).toContain("canonical_hashes");
  });

  it("preserves aggregate state while migrating group:default to group:shared", () => {
    const before = state("group:default");
    const candidate = state("group:shared");
    const candidateDb = database(31, "ok", { groupDefaultProfiles: 0, groupSharedProfiles: 1, syntheticUserCapabilities: true });
    const restartedDb = database(31, "ok", { groupDefaultProfiles: 0, groupSharedProfiles: 1, syntheticUserCapabilities: true }, "rehydrated");
    const result = assessStateTransitions(before, candidate, candidate, before, {
      before: database(21, "ok", { groupDefaultProfiles: 1, groupSharedProfiles: 0 }),
      candidate: candidateDb,
      plexRefreshed: database(31, "ok", { groupDefaultProfiles: 0, groupSharedProfiles: 1, syntheticUserCapabilities: true }, "plex_rehydrated"),
      restarted: restartedDb,
      rollback: database(21, "ok", { groupDefaultProfiles: 1, groupSharedProfiles: 0 })
    });
    expect(result.failures).toEqual([]);
    expect(result.checks).toEqual(expect.arrayContaining(["candidate_profile_migrated", "candidate_restart_preserved", "rollback_state_preserved", "database_group_profile_migrated"]));
    expect(result.checks).toContain("representative_catalog_80000");
    expect(result.incomplete).toEqual([]);
  });

  it("requires strict TMDB sanitation, factual preservation, restart stability, and pristine rollback", () => {
    const before = state("group:default");
    const candidate = state("group:shared");
    const baseline = database(21, "ok");
    const migrated = database(31, "ok");
    const plexRehydrated = database(31, "ok", {}, "plex_rehydrated");
    const rehydrated = database(31, "ok", {}, "rehydrated");
    const passing = assessStateTransitions(before, candidate, candidate, before, {
      before: baseline, candidate: migrated, plexRefreshed: plexRehydrated, restarted: rehydrated, rollback: baseline
    });
    expect(passing.failures).toEqual([]);
    expect(passing.checks).toEqual(expect.arrayContaining([
      "strict_tmdb_boundary_legacy_seeded",
      "strict_tmdb_boundary_candidate_sanitized",
      "strict_tmdb_boundary_restart_preserved",
      "strict_tmdb_boundary_rollback_restored",
      "trusted_refresh_legacy_seeded",
      "trusted_refresh_candidate_sanitized",
      "trusted_refresh_plex_refresh_preserved",
      "trusted_refresh_catalog_rehydrated",
      "trusted_refresh_rollback_restored",
      "plex_refresh_legacy_seeded",
      "plex_refresh_candidate_sanitized",
      "plex_refresh_full_sync_rehydrated",
      "plex_refresh_restart_preserved",
      "plex_refresh_rollback_restored",
      "canonical_media_descriptions_sanitized",
      "canonical_trusted_descriptions_rehydrated",
      "canonical_request_audits_sanitized",
      "canonical_query_review_sanitized",
      "canonical_legacy_facts_preserved"
    ]));

    const stale = database(31, "ok");
    stale.strictTmdbBoundary = { ...stale.strictTmdbBoundary!, legacyDescriptiveRows: 1 };
    expect(assessStateTransitions(before, candidate, candidate, before, {
      before: baseline, candidate: stale, restarted: rehydrated, rollback: baseline
    }).failures).toContain("strict_tmdb_boundary_candidate_sanitized");

    const staleDerivedReplica = database(31, "ok");
    staleDerivedReplica.strictTmdbBoundary!.legacyDerivedReplicas = {
      ...staleDerivedReplica.strictTmdbBoundary!.legacyDerivedReplicas,
      catalogSearchIndex: 1
    };
    expect(assessStateTransitions(before, candidate, candidate, before, {
      before: baseline, candidate: staleDerivedReplica, restarted: rehydrated, rollback: baseline
    }).failures).toContain("strict_tmdb_boundary_candidate_sanitized");

    const incompleteLegacySeed = database(21, "ok");
    incompleteLegacySeed.strictTmdbBoundary!.legacyDerivedReplicas = {
      ...incompleteLegacySeed.strictTmdbBoundary!.legacyDerivedReplicas,
      mediaEmbeddings: 0
    };
    expect(assessStateTransitions(before, candidate, candidate, before, {
      before: incompleteLegacySeed, candidate: migrated, restarted: rehydrated, rollback: baseline
    }).failures).toContain("strict_tmdb_boundary_legacy_seeded");

    const safelyRegenerated = database(31, "ok");
    safelyRegenerated.strictTmdbBoundary!.derivedSurfaceRows = {
      genres: 2,
      mediaFeatures: 3,
      mediaEmbeddings: 4,
      mediaMoodFeatureScores: 5,
      mediaContentFingerprints: 6,
      mediaFeatureFts: 7,
      catalogSearchIndex: 8,
      catalogSearchIndexFts: 9
    };
    safelyRegenerated.strictTmdbBoundary!.derivedRows = Object.values(
      safelyRegenerated.strictTmdbBoundary!.derivedSurfaceRows
    ).reduce((sum, value) => sum + value, 0);
    const safelyRehydrated = database(31, "ok", {}, "rehydrated");
    safelyRehydrated.strictTmdbBoundary!.derivedSurfaceRows = { ...safelyRegenerated.strictTmdbBoundary!.derivedSurfaceRows };
    safelyRehydrated.strictTmdbBoundary!.derivedRows = safelyRegenerated.strictTmdbBoundary!.derivedRows;
    expect(assessStateTransitions(before, candidate, candidate, before, {
      before: baseline, candidate: safelyRegenerated, restarted: safelyRehydrated, rollback: baseline
    }).failures).toEqual([]);

    const factsLost = database(31, "ok");
    factsLost.canonical = { ...factsLost.canonical!, legacyBoundaryFacts: "f".repeat(64) };
    expect(assessStateTransitions(before, candidate, candidate, before, {
      before: baseline, candidate: factsLost, restarted: rehydrated, rollback: baseline
    }).failures).toContain("canonical_legacy_facts_preserved");

    const rollbackNotPristine = database(21, "ok");
    rollbackNotPristine.canonical = { ...rollbackNotPristine.canonical!, queryReview: "e".repeat(64) };
    expect(assessStateTransitions(before, candidate, candidate, before, {
      before: baseline, candidate: migrated, restarted: rehydrated, rollback: rollbackNotPristine
    }).failures).toContain("canonical_query_review_sanitized");

    const refreshNotRequired = database(31, "ok");
    refreshNotRequired.trustedRefresh = { ...refreshNotRequired.trustedRefresh!, refreshRequiredRows: 0 };
    expect(assessStateTransitions(before, candidate, candidate, before, {
      before: baseline, candidate: refreshNotRequired, restarted: rehydrated, rollback: baseline
    }).failures).toContain("trusted_refresh_candidate_sanitized");

    const refreshNotCleared = database(31, "ok", {}, "rehydrated");
    refreshNotCleared.trustedRefresh = { ...refreshNotCleared.trustedRefresh!, refreshRequiredRows: 1 };
    expect(assessStateTransitions(before, candidate, candidate, before, {
      before: baseline, candidate: migrated, restarted: refreshNotCleared, rollback: baseline
    }).failures).toContain("trusted_refresh_catalog_rehydrated");

    const plexRefreshNotCleared = database(31, "ok", {}, "plex_rehydrated");
    plexRefreshNotCleared.plexRefresh = { ...plexRefreshNotCleared.plexRefresh!, refreshRequiredRows: 1 };
    expect(assessStateTransitions(before, candidate, candidate, before, {
      before: baseline, candidate: migrated, plexRefreshed: plexRefreshNotCleared, restarted: rehydrated, rollback: baseline
    }).failures).toContain("plex_refresh_full_sync_rehydrated");

    const catalogClearedByPlex = database(31, "ok", {}, "plex_rehydrated");
    catalogClearedByPlex.trustedRefresh = { ...database(31, "ok", {}, "rehydrated").trustedRefresh! };
    expect(assessStateTransitions(before, candidate, candidate, before, {
      before: baseline, candidate: migrated, plexRefreshed: catalogClearedByPlex, restarted: rehydrated, rollback: baseline
    }).failures).toContain("trusted_refresh_plex_refresh_preserved");
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
    const candidateDb = database(31, "ok");
    candidateDb.canonical = { ...candidateDb.canonical!, recommendations: "f".repeat(64) };
    const result = assessStateTransitions(before, candidate, candidate, before, {
      before: database(21, "ok"), candidate: candidateDb, restarted: database(31, "ok", {}, "rehydrated"), rollback: database(21, "ok")
    });
    expect(result.failures).toContain("canonical_recommendations_preserved");
  });

  it("emits only allowlisted aggregate public evidence", () => {
    const report = buildPublicReport(reportInput(parseUpgradeArgs(officialArgs())));
    const serialized = JSON.stringify(report);
    expect(report.status).toBe("passed");
    expect(report.releaseEligible).toBe(true);
    expect(requiredUpgradeCheckCodes).toHaveLength(107);
    expect(new Set(requiredUpgradeCheckCodes).size).toBe(107);
    expect(report.checks).toHaveLength(107);
    expect(new Set(report.checks)).toEqual(new Set(requiredUpgradeCheckCodes));
    expect(report.checks).toEqual(expect.arrayContaining([
      "production_plex_full_sync", "plex_refresh_required_cleared", "plex_recovery_search_restored",
      "packaged_trusted_catalog_refresh", "trusted_catalog_requestable_search_restored", "trusted_refresh_required_cleared"
    ]));
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
    expect(serialized).not.toContain("Legacy TMDB Boundary Sentinel");
  });

  it("requires the distinct post-Plex pre-catalog database observation for release evidence", () => {
    const input = reportInput(parseUpgradeArgs(officialArgs()));
    const report = buildPublicReport({ ...input, plexRefreshedDatabase: undefined });
    expect(report.status).toBe("failed");
    expect(report.releaseEligible).toBe(false);
    expect(report.failures).toContain("missing_evidence");
  });

  it("fails closed when any required upgrade check code is absent", () => {
    const input = reportInput(parseUpgradeArgs(officialArgs()));
    input.checks = input.checks.filter((code) => code !== "alpha_api_seed");
    const report = buildPublicReport(input);
    expect(report.status).toBe("failed");
    expect(report.releaseEligible).toBe(false);
    expect(report.failures).toContain("required_upgrade_check_codes_missing");
    expect(report.checks).toHaveLength(106);
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

  it("retains the actionable integration fixture mode failure in the public report", () => {
    const options = parseUpgradeArgs(officialArgs());
    const report = buildPublicReport({ ...reportInput(options), failures: ["integration_fixture_mode_mismatch"] });
    expect(report.status).toBe("failed");
    expect(report.releaseEligible).toBe(false);
    expect(report.failures).toContain("integration_fixture_mode_mismatch");
  });
});

function officialArgs() {
  return ["--candidate-image", digest, "--expected-version", "0.1.0-beta.1", "--expected-revision", revision];
}

function state(id: string): AggregateState {
  return {
    catalog: { total: 80_002, plex: 2, seerr: 4 },
    settings: { fixtureMode: false, syncInterval: 0, resultLimit: 37, retentionDays: 45, maxQueries: 321 },
    profile: { id, terms: 1, maxVersion: 1, feedback: 1 },
    requests: { total: 4, previews: 2, creates: 2, blocked: 0, failed: 0 }
  };
}

function database(
  schemaVersion: number,
  integrity: string,
  overrides: Partial<DatabaseObservation> = {},
  phase: "legacy" | "sanitized" | "plex_rehydrated" | "rehydrated" = schemaVersion >= 30 ? "sanitized" : "legacy"
): DatabaseObservation {
  const migrated = schemaVersion >= 30;
  const rehydrated = phase === "rehydrated";
  const plexRehydrated = phase === "plex_rehydrated" || rehydrated;
  const legacyHash = (before: string, after: string) => (migrated ? after : before).repeat(64);
  const derivedSurfaceRows = migrated
    ? {
        genres: 0, mediaFeatures: 0, mediaEmbeddings: 0, mediaMoodFeatureScores: 0,
        mediaContentFingerprints: 0, mediaFeatureFts: 0, catalogSearchIndex: 0, catalogSearchIndexFts: 0
      }
    : {
        genres: 1, mediaFeatures: 1, mediaEmbeddings: 1, mediaMoodFeatureScores: 4,
        mediaContentFingerprints: 1, mediaFeatureFts: 1, catalogSearchIndex: 1, catalogSearchIndexFts: 1
      };
  const legacyDerivedReplicas = {
    genres: migrated ? 0 : 1,
    mediaFeatures: migrated ? 0 : 1,
    mediaEmbeddings: migrated ? 0 : 1,
    mediaMoodFeatureScores: migrated ? 0 : 4,
    mediaContentFingerprints: migrated ? 0 : 1,
    mediaFeatureFts: migrated ? 0 : 1,
    catalogSearchIndex: migrated ? 0 : 1,
    catalogSearchIndexFts: migrated ? 0 : 1
  };
  const canonical = {
    config: "1".repeat(64), configRaw: "0".repeat(64), profiles: "2".repeat(64), checkpoints: "3".repeat(64), feedback: "4".repeat(64),
    requestAudits: legacyHash("5", "c"), requestAuditFacts: "5".repeat(64), requests: "d".repeat(64),
    mediaExternalIds: (phase === "legacy" ? "6" : rehydrated ? "f" : plexRehydrated ? "d" : "e").repeat(64), mediaIdentityFacts: "6".repeat(64), catalogRelationships: "b".repeat(64),
    recommendations: "a".repeat(64), userSessions: "7".repeat(64), poster: legacyHash("8", "f"), posterSafe: "8".repeat(64), posterBody: "9".repeat(64),
    legacyBoundary: legacyHash("a", "b"), legacyBoundaryFacts: "c".repeat(64), queryReview: legacyHash("d", "e")
  };
  return {
    schemaVersion,
    integrity,
    integrityOk: integrity === "ok",
    foreignKeysOk: true,
    migrationCount: schemaVersion,
    migrationIdsExact: schemaVersion === 21 || migrated,
    totalItems: 80_002,
    plexItems: 2,
    seerrItems: 4,
    externalIds: rehydrated ? 80_009 : 80_008,
    externalMediaTypesValid: true,
    requestAudits: 4,
    attributedRequestAudits: 2,
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
    posterRows: phase === "legacy" ? 4 : rehydrated ? 1 : 3,
    posterSvgRows: 1,
    posterPngJpegRows: phase === "legacy" ? 3 : rehydrated ? 0 : 2,
    posterByteSizeBackfilled: true,
    posterLastAccessBackfilled: true,
    strictTmdbBoundary: {
      mediaRows: 1,
      legacyDescriptiveRows: migrated ? 0 : 1,
      sanitizedRows: migrated ? 1 : 0,
      factualExternalIdRows: 1,
      seerrRelationshipRows: 1,
      plexRelationshipRows: 0,
      requestRows: 1,
      requestAuditRows: 1,
      requestAuditDescriptiveRows: migrated ? 0 : 1,
      derivedRows: Object.values(derivedSurfaceRows).reduce((sum, value) => sum + value, 0),
      derivedSurfaceRows,
      legacyDerivedReplicas,
      posterRows: migrated ? 0 : 1,
      reviewQueueRows: 1,
      reviewQueueDescriptiveRows: migrated ? 0 : 1,
      requestOperationsTable: migrated,
      requestOperationRows: 0,
      requestOperationDescriptiveRows: 0
    },
    trustedRefresh: {
      mediaRows: 1,
      legacyDescriptiveRows: phase === "legacy" ? 1 : 0,
      sanitizedOperationalRows: phase === "sanitized" || phase === "plex_rehydrated" ? 1 : 0,
      rehydratedCatalogRows: rehydrated ? 1 : 0,
      activeCatalogRelationships: 1,
      trustedCatalogProvenanceRows: 1,
      staleCatalogRelationships: phase === "sanitized" || phase === "plex_rehydrated" ? 1 : 0,
      requestableSeerrRelationships: 1,
      refreshRequiredRows: phase === "sanitized" || phase === "plex_rehydrated" ? 1 : 0,
      legacyDerivedReplicaRows: phase === "legacy" ? 3 : 0,
      catalogSearchIndexRows: phase === "sanitized" || phase === "plex_rehydrated" ? 0 : 1,
      catalogSearchIndexFtsRows: phase === "sanitized" || phase === "plex_rehydrated" ? 0 : 1
    },
    plexRefresh: {
      mediaRows: 1,
      descriptiveLiveRows: plexRehydrated || phase === "legacy" ? 1 : 0,
      sanitizedOperationalRows: phase === "sanitized" ? 1 : 0,
      plexRelationshipRows: 1,
      seerrRelationshipRows: 1,
      refreshRequiredRows: phase === "sanitized" ? 1 : 0,
      genreRows: plexRehydrated || phase === "legacy" ? 2 : 0,
      mediaFeatureRows: plexRehydrated || phase === "legacy" ? 1 : 0,
      catalogSearchIndexRows: plexRehydrated || phase === "legacy" ? 1 : 0,
      catalogSearchIndexFtsRows: plexRehydrated || phase === "legacy" ? 1 : 0
    },
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
    checks: [
      "alpha_api_seed",
      "alpha_production_catalog_3_2_2",
      "cold_archive_sha256",
      "candidate_restart",
      "candidate_ai_policy_enforced",
      "candidate_tmdb_policy_enforced",
      "rollback_fresh_volume",
      "synthetic_poster_route_preserved",
      "production_plex_full_sync",
      "plex_refresh_required_cleared",
      "plex_recovery_search_restored",
      "packaged_trusted_catalog_refresh",
      "trusted_catalog_requestable_search_restored",
      "trusted_refresh_required_cleared"
    ],
    candidatePlatformDigest: "sha256:" + "b".repeat(64),
    archiveSha256: "c".repeat(64),
    before,
    candidate,
    restarted: candidate,
    rollback: before,
    beforeDatabase: database(21, "ok"),
    candidateDatabase: database(31, "ok"),
    plexRefreshedDatabase: database(31, "ok", {}, "plex_rehydrated"),
    restartedDatabase: database(31, "ok", {}, "rehydrated"),
    rollbackDatabase: database(21, "ok")
  };
}
