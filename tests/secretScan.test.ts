import { describe, expect, it } from "vitest";
import { detectSecretFindings } from "../scripts/verify-tracked-secrets";

describe("tracked-content secret scan", () => {
  it("detects credential patterns without returning their values", () => {
    const body = [
      "OPENAI_API" + "_KEY=" + "sk-" + "proj-" + "abcdefghijklmnopqrstuvwxyz123456",
      "github" + "_pat_" + "abcdefghijklmnopqrstuvwxyz_ABCDEFGHIJKLMNOPQRSTUVWXYZ",
      "admin" + 'Token: "production-secret-value-123"'
    ].join("\n");

    expect(detectSecretFindings("fixture.txt", body)).toEqual([
      { file: "fixture.txt", line: 1, kind: "OpenAI key" },
      { file: "fixture.txt", line: 1, kind: "OPENAI_API_KEY literal" },
      { file: "fixture.txt", line: 2, kind: "GitHub token" },
      { file: "fixture.txt", line: 3, kind: "adminToken literal" }
    ]);
  });

  it("allows documented placeholders and synthetic test credentials", () => {
    const body = [
      "MOODARR_ADMIN_TOKEN=${MOODARR_ADMIN_TOKEN:?Set MOODARR_ADMIN_TOKEN}",
      "PLEX_TOKEN=test-plex-token-secret",
      'OPENAI_API_KEY="replace-with-a-real-key"'
    ].join("\n");

    expect(detectSecretFindings("fixture.txt", body)).toEqual([]);
  });
});
