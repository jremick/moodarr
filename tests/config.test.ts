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

  it.each([10_081, -1, 1.5, null, true, {}, [], ""])("rejects malformed persisted sync interval %j", (intervalMinutes) => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-server-config-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "config.json");
    writeFileSync(configPath, JSON.stringify({ sync: { intervalMinutes } }));

    expect(() => loadTestConfig({}, directory)).toThrow("sync.intervalMinutes must be an integer between 0 and 10080.");
  });

  it.each([
    [{ fixtureMode: "false" }, "fixtureMode"],
    [{ plexAuth: { enabled: "false" } }, "plexAuth.enabled"],
    [{ plexAuth: { allowNewUsers: "false" } }, "plexAuth.allowNewUsers"],
    [{ sync: { syncSeerr: "false" } }, "sync.syncSeerr"],
    [{ reviewQueue: { captureRawQueries: "false" } }, "reviewQueue.captureRawQueries"]
  ])("rejects wrong-typed persisted boolean at %s", (persisted, field) => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-server-config-"));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, "config.json"), JSON.stringify(persisted));

    expect(() => loadConfig({
      MOODARR_DATA_DIR: directory,
      MOODARR_CONFIG_PATH: join(directory, "config.json"),
      MOODARR_REQUIRE_ADMIN_TOKEN: "true",
      MOODARR_API_HOST: "127.0.0.1"
    })).toThrow(`${field} must be a boolean.`);
  });

  it.each([
    {
      label: "fixtureMode",
      persisted: { fixtureMode: "false" },
      environment: { MOODARR_FIXTURE_MODE: "true" },
      read: (config: ReturnType<typeof loadConfig>) => config.fixtureMode
    },
    {
      label: "plexAuth.enabled",
      persisted: { plexAuth: { enabled: "false" } },
      environment: { MOODARR_PLEX_AUTH_ENABLED: "true" },
      read: (config: ReturnType<typeof loadConfig>) => config.plexAuth.enabled
    },
    {
      label: "plexAuth.allowNewUsers",
      persisted: { plexAuth: { allowNewUsers: "false" } },
      environment: { MOODARR_PLEX_AUTH_ALLOW_NEW_USERS: "true" },
      read: (config: ReturnType<typeof loadConfig>) => config.plexAuth.allowNewUsers
    },
    {
      label: "sync.syncSeerr",
      persisted: { sync: { syncSeerr: "false" } },
      environment: { MOODARR_SYNC_SEERR: "true" },
      read: (config: ReturnType<typeof loadConfig>) => config.sync.syncSeerr
    },
    {
      label: "reviewQueue.captureRawQueries",
      persisted: { reviewQueue: { captureRawQueries: "false" } },
      environment: { MOODARR_REVIEW_CAPTURE_RAW_QUERIES: "true" },
      read: (config: ReturnType<typeof loadConfig>) => config.reviewQueue.captureRawQueries
    }
  ])("lets a valid environment value override malformed persisted $label", ({ persisted, environment, read }) => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-server-config-"));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, "config.json"), JSON.stringify(persisted));

    const config = loadConfig({
      MOODARR_DATA_DIR: directory,
      MOODARR_CONFIG_PATH: join(directory, "config.json"),
      MOODARR_REQUIRE_ADMIN_TOKEN: "true",
      MOODARR_API_HOST: "127.0.0.1",
      ...environment
    });

    expect(read(config)).toBe(true);
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

describe("additional browser origins", () => {
  it.each([undefined, "", "   "])("defaults to no additional origins for %j", (value) => {
    expect(loadTestConfig({ MOODARR_ADDITIONAL_WEB_ORIGINS: value }).additionalWebOrigins).toEqual([]);
  });

  it("normalizes and deduplicates explicit origins without replacing the primary origin", () => {
    const config = loadTestConfig({
      MOODARR_WEB_ORIGIN: "http://moodarr.example:4401",
      MOODARR_ADDITIONAL_WEB_ORIGINS: " http://192.0.2.40:4401/, http://LAN.EXAMPLE:80/, http://192.0.2.40:4401 "
    });
    expect(config.webOrigin).toBe("http://moodarr.example:4401");
    expect(config.additionalWebOrigins).toEqual(["http://192.0.2.40:4401", "http://lan.example"]);
  });

  it.each([
    "*",
    "http://*:4401",
    "http://*.example:4401",
    "http://user:password@moodarr.example:4401",
    "http://moodarr.example:4401/path",
    "http://moodarr.example:4401/?query=1",
    "http://moodarr.example:4401/#fragment",
    "ftp://moodarr.example:4401",
    "file:///tmp/moodarr",
    "not-an-origin"
  ])("rejects malformed or non-exact additional origin %s", (value) => {
    expect(() => loadTestConfig({ MOODARR_ADDITIONAL_WEB_ORIGINS: value })).toThrow("MOODARR_ADDITIONAL_WEB_ORIGINS");
  });

  it.each([
    ["https://moodarr.example", "http://192.0.2.40:4401"],
    ["http://moodarr.example:4401", "https://moodarr.example"]
  ])("rejects mixed cookie security schemes for %s and %s", (primary, additional) => {
    expect(() => loadTestConfig({
      MOODARR_WEB_ORIGIN: primary,
      MOODARR_ADDITIONAL_WEB_ORIGINS: additional
    })).toThrow("MOODARR_ADDITIONAL_WEB_ORIGINS");
  });

  it("accepts additional HTTPS origins with an HTTPS primary", () => {
    expect(loadTestConfig({
      MOODARR_WEB_ORIGIN: "https://moodarr.example",
      MOODARR_ADDITIONAL_WEB_ORIGINS: "https://moodarr-tailnet.example:443/"
    }).additionalWebOrigins).toEqual(["https://moodarr-tailnet.example"]);
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
