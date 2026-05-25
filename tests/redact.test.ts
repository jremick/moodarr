import { describe, expect, it } from "vitest";
import { redactSecrets, redactString } from "../src/server/security/redact";

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
      nested: {
        apiKey: "test-seerr-key-secret",
        title: "Stardust"
      }
    });

    expect(output).toEqual({
      token: "[REDACTED]",
      nested: {
        apiKey: "[REDACTED]",
        title: "Stardust"
      }
    });
  });
});
