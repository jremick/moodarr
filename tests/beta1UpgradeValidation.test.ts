import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { beta1CandidateSettingsSnapshot, beta1StatePreserved, installAiSettings, parseInstallArgs, validatePersistenceEvidence } from "../scripts/validate-beta-install";
import { getAdminSettings, updateAdminSettings } from "../src/server/admin/configStore";
import { loadConfig } from "../src/server/config";

function baseline() {
  return {
    schema: 31,
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
