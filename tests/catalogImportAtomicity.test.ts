import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogFileBinding, validateExpectedCatalogFileSha256 } from "../scripts/catalog-file-binding";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository, type CatalogIngestRecord } from "../src/server/db/mediaRepository";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("full-snapshot catalog atomicity", () => {
  it("requires an exact lowercase SHA-256 only for full-snapshot imports", () => {
    expect(() => validateExpectedCatalogFileSha256("full_snapshot", undefined)).toThrow("requires --expected-file-sha256");
    expect(() => validateExpectedCatalogFileSha256("full_snapshot", "A".repeat(64))).toThrow("lowercase 64-character SHA-256");
    expect(() => validateExpectedCatalogFileSha256("full_snapshot", "a".repeat(64))).not.toThrow();
    expect(() => validateExpectedCatalogFileSha256("incremental", "a".repeat(64))).toThrow("can only be used with --mode full-snapshot");
    expect(() => validateExpectedCatalogFileSha256("incremental", undefined)).not.toThrow();
  });

  it("rejects a missing or mismatched CLI hash before opening the database", () => {
    const directory = temporaryDirectory("moodarr-catalog-hash-cli-");
    const inputPath = join(directory, "snapshot.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    writeFileSync(inputPath, `${JSON.stringify({ id: "Q1", mediaType: "film", label: "Hash Sentinel" })}\n`, "utf8");

    const missing = runImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "hash-missing",
      "--mode", "full-snapshot",
      "--expected-source-records", "1"
    ]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("requires --expected-file-sha256");
    expect(existsSync(databasePath)).toBe(false);

    const mismatch = runImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "hash-mismatch",
      "--mode", "full-snapshot",
      "--expected-source-records", "1",
      "--expected-file-sha256", "0".repeat(64)
    ]);
    expect(mismatch.status).toBe(1);
    expect(mismatch.stderr).toContain("did not match --expected-file-sha256");
    expect(existsSync(databasePath)).toBe(false);
  });

  it("commits an exact full snapshot only after the post-write hash succeeds", () => {
    const directory = temporaryDirectory("moodarr-catalog-hash-success-");
    const inputPath = join(directory, "snapshot.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    const body = `${JSON.stringify({ id: "Q1", mediaType: "film", label: "Exact Snapshot", description: "Exact summary", genreLabels: ["Drama"] })}\n`;
    const expectedFileSha256 = sha256(body);
    writeFileSync(inputPath, body, "utf8");

    const result = runImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "exact-snapshot",
      "--mode", "full-snapshot",
      "--expected-source-records", "1",
      "--expected-file-sha256", expectedFileSha256,
      "--batch-size", "1"
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      expectedFileSha256,
      fileSha256: expectedFileSha256,
      mode: "full_snapshot",
      records: 1,
      imported: 1
    });

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(inspection.prepare("SELECT source_item_id, active FROM catalog_source_records").get()).toEqual({ source_item_id: "Q1", active: 1 });
      expect(inspection.prepare("SELECT source_version, status, update_mode FROM catalog_sync_runs").get()).toEqual({
        source_version: "exact-snapshot",
        status: "ok",
        update_mode: "full_snapshot"
      });
    } finally {
      inspection.close();
    }
  });

  it("binds both hashes and parse passes to one regular no-follow file handle", async () => {
    const directory = temporaryDirectory("moodarr-catalog-binding-");
    const inputPath = join(directory, "snapshot.jsonl");
    const symlinkPath = join(directory, "snapshot-link.jsonl");
    const body = `${JSON.stringify({ id: "Q1", mediaType: "film", label: "Stable Sentinel" })}\n`;
    const expectedSha256 = sha256(body);
    writeFileSync(inputPath, body, "utf8");
    symlinkSync(inputPath, symlinkPath);

    await expect(CatalogFileBinding.open(symlinkPath, expectedSha256)).rejects.toThrow("cannot be a symbolic link");
    const binding = await CatalogFileBinding.open(inputPath, expectedSha256);
    try {
      await expect(binding.verifyBeforePreflight()).resolves.toBe(expectedSha256);
      writeFileSync(inputPath, `${JSON.stringify({ id: "Q2", mediaType: "film", label: "Changed Sentinel" })}\n`, "utf8");
      await expect(binding.verifyAfterWritePass()).rejects.toThrow("changed during import");
    } finally {
      await binding.close();
    }
  });

  it("rolls back inserted rows, inactive marking, and the sync record after a post-pass failure", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db, { runStartupRepairs: false });
    repository.upsertCatalogRecordsWithStats([catalogRecord("Q1", "First"), catalogRecord("Q2", "Second")]);

    await expect(repository.withCatalogSnapshotTransaction(async () => {
      repository.upsertCatalogRecordsWithStats([catalogRecord("Q3", "Third", "snapshot-b")]);
      const inactive = repository.markCatalogRecordsInactiveExcept("wikidata", "snapshot-b", ["Q3"]);
      repository.recordCatalogSync("wikidata", "snapshot-b", "ok", {
        itemCount: 1,
        mediaItemsUpserted: 1,
        sourceRecordsUpserted: 1,
        updateMode: "full_snapshot",
        changedSourceRecords: 1,
        unchangedSourceRecords: 0,
        inactiveSourceRecords: inactive
      });
      throw new Error("simulated post-pass hash failure");
    })).rejects.toThrow("simulated post-pass hash failure");

    expect(db.prepare("SELECT source_item_id, active FROM catalog_source_records ORDER BY source_item_id").all()).toEqual([
      { source_item_id: "Q1", active: 1 },
      { source_item_id: "Q2", active: 1 }
    ]);
    expect(db.prepare("SELECT title FROM media_items ORDER BY title").all()).toEqual([{ title: "First" }, { title: "Second" }]);
    expect(db.prepare("SELECT COUNT(*) AS value FROM catalog_sync_runs").get()).toEqual({ value: 0 });
    db.close();
  });

  it("does not run startup repairs before the production full-snapshot transaction", () => {
    const directory = temporaryDirectory("moodarr-catalog-cli-atomicity-");
    const inputPath = join(directory, "snapshot.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    const db = createDatabase(databasePath);
    const repository = new MediaRepository(db);
    repository.upsertCatalogRecordsWithStats([catalogRecord("Q1", "Existing")]);
    db.prepare("DELETE FROM catalog_search_index_fts").run();
    db.prepare("DELETE FROM catalog_search_index").run();
    db.exec(`
      CREATE TRIGGER fail_full_snapshot_import
      BEFORE INSERT ON catalog_source_records
      WHEN NEW.source_item_id = 'Q2'
      BEGIN
        SELECT RAISE(ABORT, 'forced full-snapshot failure');
      END;
    `);
    db.close();

    const body = `${JSON.stringify({
      id: "Q2",
      mediaType: "film",
      label: "Replacement",
      description: "Replacement summary",
      genreLabels: ["Drama"]
    })}\n`;
    writeFileSync(inputPath, body, "utf8");
    const expectedFileSha256 = sha256(body);

    const result = runImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "failed-snapshot",
      "--mode", "full-snapshot",
      "--expected-source-records", "1",
      "--expected-file-sha256", expectedFileSha256,
      "--batch-size", "1"
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("forced full-snapshot failure");

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(inspection.prepare("SELECT source_item_id, active FROM catalog_source_records ORDER BY source_item_id").all()).toEqual([
        { source_item_id: "Q1", active: 1 }
      ]);
      expect(inspection.prepare("SELECT COUNT(*) AS value FROM catalog_search_index").get()).toEqual({ value: 0 });
      expect(inspection.prepare("SELECT COUNT(*) AS value FROM catalog_search_index_fts").get()).toEqual({ value: 0 });
      expect(inspection.prepare("SELECT COUNT(*) AS value FROM catalog_sync_runs").get()).toEqual({ value: 0 });
    } finally {
      inspection.close();
    }
  });

  it("keeps a standalone catalog batch atomic when an internal write fails", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db, { runStartupRepairs: false });
    db.exec(`
      CREATE TRIGGER fail_second_catalog_record
      BEFORE INSERT ON catalog_source_records
      WHEN NEW.source_item_id = 'Q2'
      BEGIN
        SELECT RAISE(ABORT, 'forced catalog write failure');
      END;
    `);

    expect(() => repository.upsertCatalogRecordsWithStats([catalogRecord("Q1", "First"), catalogRecord("Q2", "Second")]))
      .toThrow("forced catalog write failure");
    expect(db.prepare("SELECT COUNT(*) AS value FROM catalog_source_records").get()).toEqual({ value: 0 });
    expect(db.prepare("SELECT COUNT(*) AS value FROM media_items").get()).toEqual({ value: 0 });
    db.close();
  });
});

function catalogRecord(sourceItemId: string, title: string, sourceVersion = "snapshot-a"): CatalogIngestRecord {
  return {
    source: "wikidata",
    sourceVersion,
    sourceItemId,
    licensePolicy: "wikidata-cc0",
    payloadHash: sha256(`${sourceItemId}:${title}`),
    media: { mediaType: "movie", title, year: 2025, summary: `${title} summary`, genres: ["Drama"] }
  };
}

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
      MOODARR_ADMIN_TOKEN: "catalog-import-test-admin-token-secret"
    }
  });
}

function temporaryDirectory(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
