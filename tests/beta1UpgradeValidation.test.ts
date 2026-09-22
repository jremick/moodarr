import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { beta1CandidateSettingsSnapshot, beta1StatePreserved, beta2CandidateSettingsSnapshot, beta2StatePreserved, beta2UpgradeIdentity, beta3StatePreserved, beta3UpgradeIdentity, beta3UpgradeCheckCodes, installAiSettings, parseInstallArgs, runBeta2UpgradeValidation, runBeta3UpgradeValidation, validatePersistenceEvidence } from "../scripts/validate-beta-install";
import { getAdminSettings, updateAdminSettings } from "../src/server/admin/configStore";
import { loadConfig } from "../src/server/config";

function baseline(schema = 31) {
  return {
    schema,
    configHash: "a".repeat(64),
    tables: Object.fromEntries([
      "app_users", "user_sessions", "preference_profiles", "feel_profile_terms",
      "feel_feedback_events", "requests", "request_creation_operations"
    ].map((name) => [name, { columns: ["id"], count: 1, hash: "b".repeat(64) }]))
  };
}

describe("published beta.1 upgrade continuity", () => {
  it("preserves selected settings across restart and the beta.1 service-tier addition", () => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-beta1-settings-"));
    const configPath = join(directory, "config.json");
    const reload = () => {
      const config = loadConfig({ MOODARR_DATA_DIR: directory, MOODARR_CONFIG_PATH: configPath, MOODARR_REQUIRE_ADMIN_TOKEN: "true", MOODARR_ADMIN_TOKEN: "fixture-admin-token" });
      config.ai.providerPolicy = "none";
      config.seerr.tmdbContentPolicy = "none";
      return config;
    };
    try {
      const configured = updateAdminSettings(reload(), {
        fixtureMode: false,
        plex: { baseUrl: "http://integrations:4700", token: "synthetic-plex-token" },
        seerr: { baseUrl: "http://integrations:4700", apiKey: "synthetic-seerr-key" },
        ai: installAiSettings,
        sync: { intervalMinutes: 360, syncSeerr: true },
        search: { defaultResultLimit: 50 },
        reviewQueue: { retentionDays: 91, maxQueries: 123, captureRawQueries: false },
        plexAuth: { enabled: false, allowNewUsers: false }
      });
      expect(getAdminSettings(reload())).toEqual(configured);
      expect(configured.ai).toMatchObject({ ...installAiSettings, providerPolicy: "none", openaiApiKeyConfigured: false });

      // The published beta.1 schema strips this new field before persisting.
      const legacyConfig = JSON.parse(readFileSync(configPath, "utf8"));
      delete legacyConfig.ai.openaiServiceTier;
      const legacyBytes = JSON.stringify(legacyConfig);
      writeFileSync(configPath, legacyBytes);
      const baselineSettings = JSON.parse(JSON.stringify(configured));
      delete baselineSettings.ai.openaiServiceTier;
      const expected = beta1CandidateSettingsSnapshot(baselineSettings);
      const candidate = getAdminSettings(reload());
      const evidence = { configMode: 0o600, integrity: "ok", foreignKeysOk: true };

      expect(candidate).toEqual(expected);
      expect(candidate.ai.openaiServiceTier).toBe("default");
      expect(baselineSettings.ai).not.toHaveProperty("openaiServiceTier");
      expect(readFileSync(configPath, "utf8")).toBe(legacyBytes);
      expect(validatePersistenceEvidence({ before: expected, after: candidate, ...evidence }).valid).toBe(true);
      for (const changed of [
        { ...candidate, ai: { ...candidate.ai, openaiModel: "gpt-5.6-luna" } },
        { ...candidate, ai: { ...candidate.ai, openaiReasoningEffort: "none" } },
        { ...candidate, ai: { ...candidate.ai, openaiServiceTier: "fast" } },
        { ...candidate, ai: { ...candidate.ai, openaiEmbeddingModel: "changed-model" } },
        { ...candidate, search: { defaultResultLimit: 20 } }
      ]) {
        expect(validatePersistenceEvidence({ before: expected, after: changed, ...evidence }))
          .toEqual({ valid: false, failures: ["settings_persistence_drift"] });
      }
      expect(() => beta1CandidateSettingsSnapshot(candidate)).toThrow(/beta1_settings_contract_mismatch/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts preserved populated state only at the expected schema", () => {
    const before = baseline();
    expect(beta1StatePreserved(before, { ...before, schema: 34 }, 34)).toBe(true);
    expect(beta1StatePreserved(before, structuredClone(before), 31)).toBe(true);
    expect(beta1StatePreserved(before, { ...before, schema: 33 }, 34)).toBe(false);
  });

  it.each(["app_users", "user_sessions", "preference_profiles", "feel_profile_terms", "feel_feedback_events", "requests", "request_creation_operations"])("rejects loss or changes in %s", (name) => {
    const before = baseline();
    const after = { ...structuredClone(before), schema: 34 };
    after.tables[name]!.hash = "c".repeat(64);
    expect(beta1StatePreserved(before, after, 34)).toBe(false);
    delete after.tables[name];
    expect(beta1StatePreserved(before, after, 34)).toBe(false);
    before.tables[name]!.count = 0;
    expect(beta1StatePreserved(before, { ...before, schema: 34 }, 34)).toBe(false);
  });

  it("rejects changed settings and an incorrect baseline", () => {
    const before = baseline();
    expect(beta1StatePreserved(before, { ...before, configHash: "c".repeat(64), schema: 34 }, 34)).toBe(false);
    expect(beta1StatePreserved({ ...before, schema: 30 }, { ...before, schema: 34 }, 34)).toBe(false);
  });

  it("accepts beta.2 with an immutable candidate identity and rejects malformed versions", () => {
    const options = ["--candidate-image", `ghcr.io/jremick/moodarr@sha256:${"b".repeat(64)}`, "--expected-revision", "a".repeat(40), "--expected-version"];
    expect(parseInstallArgs([...options, "0.1.0-beta.2"]).expectedVersion).toBe("0.1.0-beta.2");
    for (const version of ["0.1.0-beta.0", "0.1.0-beta.02", "0.1.0", "0.1.0-beta.2\n"]) {
      expect(() => parseInstallArgs([...options, version])).toThrow();
    }
  });
});

describe("published beta.2 upgrade continuity", () => {
  it("preserves populated schema-34 state through upgrade and cold restore", () => {
    const before = baseline(34);
    expect(beta2StatePreserved(before, structuredClone(before))).toBe(true);
    for (const schema of [31, 33, 35]) {
      expect(beta2StatePreserved({ ...before, schema }, before)).toBe(false);
      expect(beta2StatePreserved(before, { ...before, schema })).toBe(false);
    }
    expect(beta2StatePreserved(before, { ...before, configHash: "c".repeat(64) })).toBe(false);
  });

  it.each(["app_users", "user_sessions", "preference_profiles", "feel_profile_terms", "feel_feedback_events", "requests", "request_creation_operations"])("rejects loss or changes in %s", (name) => {
    const before = baseline(34);
    const after = structuredClone(before);
    after.tables[name]!.hash = "c".repeat(64);
    expect(beta2StatePreserved(before, after)).toBe(false);
    delete after.tables[name];
    expect(beta2StatePreserved(before, after)).toBe(false);
    before.tables[name]!.count = 0;
    expect(beta2StatePreserved(before, structuredClone(before))).toBe(false);
  });

  it("preserves the complete beta.2 settings without the beta.1 service-tier conversion", () => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-beta2-settings-"));
    const configPath = join(directory, "config.json");
    const reload = () => {
      const config = loadConfig({ MOODARR_DATA_DIR: directory, MOODARR_CONFIG_PATH: configPath, MOODARR_REQUIRE_ADMIN_TOKEN: "true", MOODARR_ADMIN_TOKEN: "fixture-admin-token" });
      config.ai.providerPolicy = "none";
      config.seerr.tmdbContentPolicy = "none";
      return config;
    };
    try {
      const configured = updateAdminSettings(reload(), {
        fixtureMode: false,
        plex: { baseUrl: "http://integrations:4700", token: "synthetic-plex-token" },
        seerr: { baseUrl: "http://integrations:4700", apiKey: "synthetic-seerr-key" },
        ai: installAiSettings,
        sync: { intervalMinutes: 360, syncSeerr: true },
        search: { defaultResultLimit: 50 },
        reviewQueue: { retentionDays: 91, maxQueries: 123, captureRawQueries: false },
        plexAuth: { enabled: false, allowNewUsers: false }
      });
      const bytes = readFileSync(configPath, "utf8");
      const expected = beta2CandidateSettingsSnapshot(configured);
      expect(expected).toEqual(configured);
      expect(getAdminSettings(reload())).toEqual(expected);
      expect(readFileSync(configPath, "utf8")).toBe(bytes);
      const evidence = { configMode: 0o600, integrity: "ok", foreignKeysOk: true };
      for (const changed of [
        { ...configured, ai: { ...configured.ai, openaiServiceTier: "fast" } },
        { ...configured, ai: { ...configured.ai, openaiModel: "changed-model" } },
        { ...configured, search: { defaultResultLimit: 20 } }
      ]) {
        expect(validatePersistenceEvidence({ before: expected, after: changed, ...evidence }).valid).toBe(false);
      }
      const missingTier = structuredClone(configured) as unknown as { ai: Record<string, unknown> };
      delete missingTier.ai.openaiServiceTier;
      expect(() => beta2CandidateSettingsSnapshot(missingTier)).toThrow(/beta2_settings_contract_mismatch/);
      expect(() => beta2CandidateSettingsSnapshot({ ...configured, ai: { ...configured.ai, openaiServiceTier: "fast" } })).toThrow(/settings_contract_mismatch/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["0.1.0-beta.1", "0.1.0-beta.2"])("rejects target %s before starting Docker", async (version) => {
    const options = parseInstallArgs([
      "--candidate-image", `ghcr.io/jremick/moodarr@sha256:${"b".repeat(64)}`,
      "--expected-revision", "a".repeat(40), "--expected-version", version
    ]);
    const report = await runBeta2UpgradeValidation(options);
    expect(report).toMatchObject({
      schema: "moodarr-beta2-upgrade-v1", passed: false, releaseEligible: false,
      baseline: beta2UpgradeIdentity,
      lifecycle: { failures: ["preflight_upgrade_target_must_follow_beta2"] }
    });
    expect(report.platform).toBeUndefined();
    expect(report.archiveSha256).toBeUndefined();
  });

  it("accepts a version-bound beta.3 candidate", () => {
    expect(parseInstallArgs([
      "--candidate-image", `ghcr.io/jremick/moodarr@sha256:${"b".repeat(64)}`,
      "--expected-revision", "a".repeat(40), "--expected-version", "0.1.0-beta.3"
    ]).expectedVersion).toBe("0.1.0-beta.3");
  });
});


describe("published beta.3 upgrade continuity", () => {
  it("pins the original published image and source independently of retired Git tags", () => {
    expect(beta3UpgradeIdentity).toEqual({
      image: "ghcr.io/jremick/moodarr@sha256:515a08bd074ba54eaca53c0a70d8bf23af051fa600d32fee6ddec2aacc6e7e38",
      version: "0.1.0-beta.3",
      revision: "85170c8b6359c006754516de347777ea44932c64"
    });
    expect(beta3UpgradeCheckCodes).toEqual(["beta3_identity", "beta3_populated_state", "cold_backup", "migration_preserves_state", "candidate_restart", "rollback_exact_state", "rollback_runtime"]);
  });

  it("requires unchanged populated schema-34 state and complete settings", () => {
    const before = baseline(34);
    expect(beta3StatePreserved(before, structuredClone(before))).toBe(true);
    for (const schema of [31, 33, 35]) {
      expect(beta3StatePreserved({ ...before, schema }, before)).toBe(false);
      expect(beta3StatePreserved(before, { ...before, schema })).toBe(false);
    }
    expect(beta3StatePreserved(before, { ...before, configHash: "c".repeat(64) })).toBe(false);
    for (const name of Object.keys(before.tables)) {
      const changed = structuredClone(before);
      changed.tables[name]!.hash = "c".repeat(64);
      expect(beta3StatePreserved(before, changed)).toBe(false);
      delete changed.tables[name];
      expect(beta3StatePreserved(before, changed)).toBe(false);
      const empty = structuredClone(before);
      empty.tables[name]!.count = 0;
      expect(beta3StatePreserved(empty, structuredClone(empty))).toBe(false);
    }
  });

  it.each(["0.1.0-beta.1", "0.1.0-beta.2", "0.1.0-beta.3"])("rejects target %s before starting Docker", async (version) => {
    const report = await runBeta3UpgradeValidation(parseInstallArgs([
      "--candidate-image", `ghcr.io/jremick/moodarr@sha256:${"b".repeat(64)}`,
      "--expected-revision", "a".repeat(40), "--expected-version", version
    ]));
    expect(report).toMatchObject({
      schema: "moodarr-beta3-upgrade-v1", passed: false, releaseEligible: false,
      baseline: beta3UpgradeIdentity,
      lifecycle: { failures: ["preflight_upgrade_target_must_follow_beta3"] }
    });
    expect(report.platform).toBeUndefined();
    expect(report.archiveSha256).toBeUndefined();
  });

  it("accepts a version-bound beta.4 candidate", () => {
    expect(parseInstallArgs([
      "--candidate-image", `ghcr.io/jremick/moodarr@sha256:${"b".repeat(64)}`,
      "--expected-revision", "a".repeat(40), "--expected-version", "0.1.0-beta.4"
    ]).expectedVersion).toBe("0.1.0-beta.4");
  });
});
