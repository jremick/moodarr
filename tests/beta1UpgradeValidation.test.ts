import { describe, expect, it } from "vitest";
import { beta1StatePreserved, parseInstallArgs } from "../scripts/validate-beta-install";

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
