import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/server/db/database";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("trusted catalog refresh readiness", () => {
  it("requires exact schema 31 and the identity-quarantine migration", () => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-catalog-readiness-"));
    tempDirectories.push(directory);
    const inputPath = join(directory, "refresh.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    writeFileSync(inputPath, `${JSON.stringify({ id: "Q1", mediaType: "film", label: "Readiness Sentinel" })}\n`, "utf8");
    createDatabase(databasePath).close();

    const args = [
      "--file", inputPath,
      "--version", "readiness-sentinel",
      "--rehydrate-required",
      "--expected-refresh-required", "1",
      "--dry-run"
    ];

    const current = runImporter(directory, databasePath, args);
    expect(current.status).toBe(1);
    expect(current.stderr).toContain("preflight expected 1 catalog items but found 0");

    const missingMigrationDatabase = new DatabaseSync(databasePath);
    missingMigrationDatabase.prepare("DELETE FROM schema_migrations WHERE id = ?").run("031_integration_identity_quarantine");
    missingMigrationDatabase.close();

    const missingMigration = runImporter(directory, databasePath, args);
    expect(missingMigration.status).toBe(1);
    expect(missingMigration.stderr).toContain("schema-31 migrations");

    const staleVersionDatabase = new DatabaseSync(databasePath);
    staleVersionDatabase.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)")
      .run("031_integration_identity_quarantine", new Date().toISOString());
    staleVersionDatabase.exec("PRAGMA user_version = 30");
    staleVersionDatabase.close();

    const staleVersion = runImporter(directory, databasePath, args);
    expect(staleVersion.status).toBe(1);
    expect(staleVersion.stderr).toContain("schema-31 migrations");
  });
});

function runImporter(directory: string, databasePath: string, args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "scripts/import-wikidata-catalog.ts", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      MOODARR_DATA_DIR: directory,
      MOODARR_DB_PATH: databasePath,
      MOODARR_FIXTURE_MODE: "false",
      MOODARR_REQUIRE_ADMIN_TOKEN: "true",
      MOODARR_ADMIN_TOKEN: "catalog-import-readiness-test-admin-token-secret"
    }
  });
}
