import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("server configuration integer bounds", () => {
  it.each([
    ["0", 0],
    ["10080", 10_080]
  ])("accepts MOODARR_SYNC_INTERVAL_MINUTES=%s", (value, expected) => {
    expect(loadTestConfig({ MOODARR_SYNC_INTERVAL_MINUTES: value }).sync.intervalMinutes).toBe(expected);
  });

  it.each(["-1", "10081"])("rejects out-of-range MOODARR_SYNC_INTERVAL_MINUTES=%s", (value) => {
    expect(() => loadTestConfig({ MOODARR_SYNC_INTERVAL_MINUTES: value })).toThrow(
      "MOODARR_SYNC_INTERVAL_MINUTES must be an integer between 0 and 10080."
    );
  });

  it("rejects an out-of-range persisted sync interval when there is no environment override", () => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-server-config-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "config.json");
    writeFileSync(configPath, JSON.stringify({ sync: { intervalMinutes: 10_081 } }));

    expect(() => loadTestConfig({}, directory)).toThrow("sync.intervalMinutes must be an integer between 0 and 10080.");
  });

  it.each([
    ["1", 1],
    ["65535", 65_535]
  ])("accepts MOODARR_API_PORT=%s", (value, expected) => {
    expect(loadTestConfig({ MOODARR_API_PORT: value }).apiPort).toBe(expected);
  });

  it.each(["0", "65536"])("rejects out-of-range MOODARR_API_PORT=%s", (value) => {
    expect(() => loadTestConfig({ MOODARR_API_PORT: value })).toThrow(
      "MOODARR_API_PORT must be an integer between 1 and 65535."
    );
  });
});

function loadTestConfig(overrides: NodeJS.ProcessEnv, existingDirectory?: string) {
  const directory = existingDirectory ?? mkdtempSync(join(tmpdir(), "moodarr-server-config-"));
  if (!existingDirectory) temporaryDirectories.push(directory);
  return loadConfig({
    MOODARR_DATA_DIR: directory,
    MOODARR_CONFIG_PATH: join(directory, "config.json"),
    MOODARR_FIXTURE_MODE: "true",
    MOODARR_REQUIRE_ADMIN_TOKEN: "false",
    MOODARR_API_HOST: "127.0.0.1",
    ...overrides
  });
}
