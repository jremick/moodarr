import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { updateAdminSettings } from "../src/server/admin/configStore";
import { loadConfig } from "../src/server/config";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("persisted settings", () => {
  it("fails safely and preserves malformed settings", () => {
    const { directory, configPath } = temporaryConfigPath();
    const malformed = '{"plex":';
    writeFileSync(configPath, malformed);

    expect(() => loadTestConfig(directory, configPath)).toThrow(/could not be read or parsed/i);
    expect(readFileSync(configPath, "utf8")).toBe(malformed);
  });

  it("atomically replaces valid settings without leaving temporary files", () => {
    const { directory, configPath } = temporaryConfigPath();
    writeFileSync(configPath, JSON.stringify({ sync: { intervalMinutes: 15 } }));
    const config = loadTestConfig(directory, configPath);

    updateAdminSettings(config, { sync: { intervalMinutes: 45 } });

    expect(JSON.parse(readFileSync(configPath, "utf8"))).toMatchObject({ sync: { intervalMinutes: 45 } });
    expect(readdirSync(directory).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("does not mutate live settings when persistence fails", () => {
    const { directory, configPath } = temporaryConfigPath();
    writeFileSync(configPath, JSON.stringify({ sync: { intervalMinutes: 15 } }));
    const config = loadTestConfig(directory, configPath);
    config.configPath = "/moodarr-read-only/config.json";

    expect(() => updateAdminSettings(config, { sync: { intervalMinutes: 45 } })).toThrow();
    expect(config.sync.intervalMinutes).toBe(15);
  });
});

function temporaryConfigPath() {
  const directory = mkdtempSync(join(tmpdir(), "moodarr-config-test-"));
  temporaryDirectories.push(directory);
  return { directory, configPath: join(directory, "config.json") };
}

function loadTestConfig(directory: string, configPath: string) {
  return loadConfig({
    MOODARR_DATA_DIR: directory,
    MOODARR_CONFIG_PATH: configPath,
    MOODARR_FIXTURE_MODE: "true",
    MOODARR_REQUIRE_ADMIN_TOKEN: "false",
    MOODARR_API_HOST: "127.0.0.1"
  });
}
