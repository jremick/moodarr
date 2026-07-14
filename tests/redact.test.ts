import { describe, expect, it } from "vitest";
import {
  allowBoundedText,
  allowNumericRecord,
  allowObject,
  allowValue,
  maxOperationalErrorLength,
  redactAllowedFields,
  redactSecrets,
  redactString,
  safeErrorMessage
} from "../src/server/security/redact";

describe("secret redaction", () => {
  it("redacts known secret values in strings and URLs", () => {
    const output = redactString("GET /poster?X-Plex-Token=test-plex-token-secret Bearer test-seerr-key-secret", [
      "test-plex-token-secret",
      "test-seerr-key-secret"
    ]);

    expect(output).not.toContain("test-plex-token-secret");
    expect(output).not.toContain("test-seerr-key-secret");
    expect(output).toContain("[REDACTED]");
  });

  it("redacts sensitive object keys recursively", () => {
    const output = redactSecrets({
      token: "test-plex-token-secret",
      tokenConfigured: true,
      nested: {
        apiKey: "test-seerr-key-secret",
        title: "Stardust"
      }
    });

    expect(output).toEqual({
      token: "[REDACTED]",
      tokenConfigured: true,
      nested: {
        apiKey: "[REDACTED]",
        title: "Stardust"
      }
    });
  });

  it("redacts before bounding very long operational errors", () => {
    const secret = "very-long-upstream-secret";
    const output = safeErrorMessage(new Error(`${"x".repeat(900)} ${secret} ${"y".repeat(2_000)}`), [secret]);

    expect(output).toHaveLength(maxOperationalErrorLength);
    expect(output).not.toContain(secret);
    expect(output).toContain("[REDACTED]");
    expect(output.endsWith("… [truncated]")).toBe(true);
  });

  it("recursively enforces schema-shaped support fields and numeric record values", () => {
    const output = redactAllowedFields(
      {
        settings: {
          tokenConfigured: true,
          error: "test-seerr-key-secret",
          rawUpstream: { body: "test-seerr-key-secret" }
        },
        sync: {
          error: `Bearer test-seerr-key-secret ${"z".repeat(2_000)}`,
          title: "private upstream title",
          stageDurationsMs: { fetching_plex: 12, "test-seerr-key-secret": 99, token: 1, debug: "test-seerr-key-secret" }
        }
      },
      {
        settings: allowObject({ tokenConfigured: allowValue }),
        sync: allowObject({ error: allowBoundedText, stageDurationsMs: allowNumericRecord })
      },
      ["test-seerr-key-secret"]
    );

    expect(output).toEqual({
      settings: { tokenConfigured: true },
      sync: {
        error: expect.not.stringContaining("test-seerr-key-secret"),
        stageDurationsMs: { fetching_plex: 12 }
      }
    });
    expect(output.sync.error).toHaveLength(maxOperationalErrorLength);
  });
});
