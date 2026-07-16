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
    expect(() => validateExpectedCatalogFileSha256("full_snapshot", undefined)).toThrow("require --expected-file-sha256");
    expect(() => validateExpectedCatalogFileSha256("full_snapshot", "A".repeat(64))).toThrow("lowercase 64-character SHA-256");
    expect(() => validateExpectedCatalogFileSha256("full_snapshot", "a".repeat(64))).not.toThrow();
    expect(() => validateExpectedCatalogFileSha256("incremental", "a".repeat(64))).toThrow("can only be used with --mode full-snapshot or --rehydrate-required");
    expect(() => validateExpectedCatalogFileSha256("incremental", undefined, true)).toThrow("trusted-rehydrate imports require");
    expect(() => validateExpectedCatalogFileSha256("incremental", "a".repeat(64), true)).not.toThrow();
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
    expect(missing.stderr).toContain("require --expected-file-sha256");
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

  it("preserves a catalog write error when SQLite discards the outer transaction", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db, { runStartupRepairs: false });
    repository.upsertCatalogRecordsWithStats([catalogRecord("Q1", "Existing")]);
    const before = {
      sources: db.prepare("SELECT source_item_id, active FROM catalog_source_records ORDER BY source_item_id").all(),
      media: db.prepare("SELECT title FROM media_items ORDER BY title").all(),
      features: db.prepare("SELECT media_item_id, feature_version FROM media_features ORDER BY media_item_id").all(),
      moodScores: db.prepare("SELECT media_item_id, source, feature FROM media_mood_feature_scores ORDER BY media_item_id, source, feature").all(),
      searchIndex: db.prepare("SELECT media_item_id, title FROM catalog_search_index ORDER BY media_item_id").all()
    };
    db.exec(`
      CREATE TEMP TRIGGER force_catalog_transaction_rollback
      BEFORE INSERT ON media_mood_feature_scores
      BEGIN
        SELECT RAISE(ROLLBACK, 'forced catalog transaction rollback');
      END
    `);

    await expect(
      repository.withCatalogSnapshotTransaction(async () => {
        repository.upsertCatalogRecordsWithStats([catalogRecord("Q2", "Rolled Back", "snapshot-b")]);
      })
    ).rejects.toThrow("forced catalog transaction rollback");
    expect({
      sources: db.prepare("SELECT source_item_id, active FROM catalog_source_records ORDER BY source_item_id").all(),
      media: db.prepare("SELECT title FROM media_items ORDER BY title").all(),
      features: db.prepare("SELECT media_item_id, feature_version FROM media_features ORDER BY media_item_id").all(),
      moodScores: db.prepare("SELECT media_item_id, source, feature FROM media_mood_feature_scores ORDER BY media_item_id, source, feature").all(),
      searchIndex: db.prepare("SELECT media_item_id, title FROM catalog_search_index ORDER BY media_item_id").all()
    }).toEqual(before);

    db.exec("DROP TRIGGER force_catalog_transaction_rollback");
    expect(repository.upsertCatalogRecordsWithStats([catalogRecord("Q2", "Recovered", "snapshot-b")]).mediaItemIds).toHaveLength(1);
    expect(db.prepare("SELECT title FROM media_items ORDER BY title").all()).toEqual([{ title: "Existing" }, { title: "Recovered" }]);
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

  it("rebinds a proven stale cross-type Wikidata identity only during trusted rehydrate", () => {
    const directory = temporaryDirectory("moodarr-catalog-type-rebind-");
    const inputPath = join(directory, "refresh.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    const fixture = seedLegacyCrossTypeCollision(databasePath, true);
    writeFileSync(inputPath, fixture.body, "utf8");

    const ordinaryIncremental = runImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "trusted-refresh-v2",
      "--batch-size", "1"
    ]);
    expect(ordinaryIncremental.status).toBe(1);
    expect(ordinaryIncremental.stderr).toContain("Catalog source identity no longer matches its bound media item.");
    const protectedStateBefore = protectedOperationalState(databasePath);

    const recovered = runImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "trusted-refresh-v2",
      "--rehydrate-required",
      "--expected-refresh-required", "1",
      "--expected-refresh-source-records", "1",
      "--expected-source-records", "2",
      "--expected-type-repairs", "1",
      "--expected-recovery-source-records", "2",
      "--expected-file-sha256", sha256(fixture.body),
      "--batch-size", "1"
    ]);
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      rehydrateRequired: true,
      refreshRequiredBefore: 1,
      refreshRequiredSourceRecordsBefore: 1,
      refreshRequiredRemaining: 0,
      refreshRequiredSourceRecordsRemaining: 0,
      changedSourceRecords: 2,
      unchangedSourceRecords: 0
    });

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const bindings = inspection
        .prepare(
          `SELECT r.source_item_id, r.media_item_id, r.content_version, r.materialization_stale, m.media_type, m.title
           FROM catalog_source_records r
           JOIN media_items m ON m.id = r.media_item_id
           ORDER BY r.source_item_id`
        )
        .all();
      expect(bindings).toEqual([
        {
          source_item_id: "Q211372",
          media_item_id: "movie:654",
          content_version: 7,
          materialization_stale: 0,
          media_type: "movie",
          title: "On the Waterfront"
        },
        {
          source_item_id: "Q762739",
          media_item_id: fixture.boundMediaItemId,
          content_version: 1,
          materialization_stale: 0,
          media_type: "tv",
          title: "Reba"
        }
      ]);
      expect(
        inspection.prepare("SELECT media_item_id, media_type FROM external_ids WHERE source = 'wikidata' AND value = 'Q211372'").all()
      ).toEqual([{ media_item_id: "movie:654", media_type: "movie" }]);
      expect(
        inspection.prepare("SELECT media_item_id FROM external_ids WHERE source = 'tmdb' AND media_type = 'tv' AND value = '654'").get()
      ).toEqual({ media_item_id: fixture.boundMediaItemId });
      expect(
        inspection.prepare("SELECT media_item_id FROM external_ids WHERE source = 'plex' AND media_type = 'tv' AND value = 'plex://show/legacy-reba'").get()
      ).toEqual({ media_item_id: fixture.boundMediaItemId });
      expect(
        inspection.prepare("SELECT media_item_id FROM external_ids WHERE source = 'tvdb' AND media_type = 'tv' AND value = '999'").get()
      ).toBeUndefined();
      expect(
        inspection.prepare("SELECT media_item_id FROM external_ids WHERE source = 'tvdb' AND media_type = 'movie' AND value = '999'").get()
      ).toEqual({ media_item_id: "movie:654" });
      expect(
        inspection.prepare("SELECT media_item_id FROM catalog_rank_signals WHERE source = 'wikidata' ORDER BY media_item_id").all()
      ).toEqual([{ media_item_id: "movie:654" }, { media_item_id: fixture.boundMediaItemId }].sort((left, right) =>
        left.media_item_id.localeCompare(right.media_item_id)
      ));
      expect(inspection.prepare("SELECT status FROM catalog_sync_runs ORDER BY id DESC LIMIT 1").get()).toEqual({ status: "ok" });
    } finally {
      inspection.close();
    }
    expect(protectedOperationalState(databasePath)).toEqual(protectedStateBefore);
  });

  it("keeps ordinary custom-source imports but rejects custom-source trusted recovery before writes", () => {
    const directory = temporaryDirectory("moodarr-catalog-custom-source-");
    const inputPath = join(directory, "custom.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    const body = `${JSON.stringify({ id: "Q900001", mediaType: "film", label: "Custom Source Sentinel" })}\n`;
    writeFileSync(inputPath, body, "utf8");

    const ordinary = runImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "custom-v1",
      "--source", "custom-catalog"
    ]);
    expect(ordinary.status, ordinary.stderr).toBe(0);
    const before = catalogRepairState(databasePath);
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(inspection.prepare("SELECT source, source_version, source_item_id FROM catalog_source_records").get()).toEqual({
        source: "custom catalog",
        source_version: "custom-v1",
        source_item_id: "Q900001"
      });
    } finally {
      inspection.close();
    }

    const rejected = spawnImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "custom-v2",
      "--source", "custom-catalog",
      "--rehydrate-required",
      "--expected-refresh-required", "0",
      "--expected-source-records", "1",
      "--expected-file-sha256", sha256(body),
      "--dry-run"
    ]);
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("only supports the Wikidata source");
    expect(catalogRepairState(databasePath)).toEqual(before);
  });

  it("discovers exact repair and recovery counts in a read-only trusted dry run", () => {
    const directory = temporaryDirectory("moodarr-catalog-rehydrate-discovery-");
    const inputPath = join(directory, "refresh.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    const fixture = seedLegacyCrossTypeCollision(databasePath, true);
    writeFileSync(inputPath, fixture.body, "utf8");
    const before = catalogRepairState(databasePath);

    const discovered = runImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "trusted-refresh-v2",
      "--rehydrate-required",
      "--expected-refresh-required", "1",
      "--expected-source-records", "2",
      "--expected-file-sha256", sha256(fixture.body),
      "--dry-run"
    ]);

    expect(discovered.status, discovered.stderr).toBe(0);
    expect(JSON.parse(discovered.stdout)).toMatchObject({
      dryRun: true,
      uniqueImportableSourceRecords: 2,
      refreshRequiredSourceRecordsBefore: 1,
      typeRepairSourceRecordsBefore: 1,
      typeRepairExternalIdsPlanned: 3,
      typeRepairExternalIdsRemoved: 0,
      recoverySourceRecordsPlanned: 2,
      recoverySourceRecordsSelected: 2,
      recoverySourceRecordsImported: 0,
      recoveryPlanSha256: expect.stringMatching(/^[0-9a-f]{64}$/)
    });
    expect(catalogRepairState(databasePath)).toEqual(before);
  });

  it("requires a write to bind the exact canonical plan emitted by dry-run", () => {
    const directory = temporaryDirectory("moodarr-catalog-rehydrate-plan-required-");
    const inputPath = join(directory, "refresh.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    const fixture = seedLegacyCrossTypeCollision(databasePath, true);
    writeFileSync(inputPath, fixture.body, "utf8");
    const before = catalogRepairState(databasePath);

    const rejected = spawnImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "trusted-refresh-v2",
      "--rehydrate-required",
      "--expected-refresh-required", "1",
      "--expected-refresh-source-records", "1",
      "--expected-source-records", "2",
      "--expected-type-repairs", "1",
      "--expected-recovery-source-records", "2",
      "--expected-file-sha256", sha256(fixture.body)
    ]);

    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("require --expected-recovery-plan-sha256");
    expect(catalogRepairState(databasePath)).toEqual(before);
  });

  it("rejects a write when any recovery source binding drifts after plan discovery", () => {
    const directory = temporaryDirectory("moodarr-catalog-rehydrate-plan-drift-");
    const inputPath = join(directory, "refresh.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    const fixture = seedLegacyCrossTypeCollision(databasePath, true);
    writeFileSync(inputPath, fixture.body, "utf8");
    const discovery = spawnImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "trusted-refresh-v2",
      "--rehydrate-required",
      "--expected-refresh-required", "1",
      "--expected-source-records", "2",
      "--expected-file-sha256", sha256(fixture.body),
      "--dry-run"
    ]);
    expect(discovery.status, discovery.stderr).toBe(0);
    const planSha256 = JSON.parse(discovery.stdout).recoveryPlanSha256 as string;

    const mutable = new DatabaseSync(databasePath);
    mutable.prepare("UPDATE catalog_source_records SET content_hash = ? WHERE source_item_id = 'Q762739'").run("f".repeat(64));
    mutable.close();
    const beforeWrite = catalogRepairState(databasePath);
    const rejected = spawnImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "trusted-refresh-v2",
      "--rehydrate-required",
      "--expected-refresh-required", "1",
      "--expected-refresh-source-records", "1",
      "--expected-source-records", "2",
      "--expected-type-repairs", "1",
      "--expected-recovery-source-records", "2",
      "--expected-recovery-plan-sha256", planSha256,
      "--expected-file-sha256", sha256(fixture.body)
    ]);

    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("did not match --expected-recovery-plan-sha256");
    expect(catalogRepairState(databasePath)).toEqual(beforeWrite);
  });

  it("rejects a write when a recovery source version drifts after plan discovery", () => {
    const directory = temporaryDirectory("moodarr-catalog-rehydrate-source-version-drift-");
    const inputPath = join(directory, "refresh.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    const fixture = seedLegacyCrossTypeCollision(databasePath, true);
    writeFileSync(inputPath, fixture.body, "utf8");
    const discovery = spawnImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "trusted-refresh-v2",
      "--rehydrate-required",
      "--expected-refresh-required", "1",
      "--expected-source-records", "2",
      "--expected-file-sha256", sha256(fixture.body),
      "--dry-run"
    ]);
    expect(discovery.status, discovery.stderr).toBe(0);
    const planSha256 = JSON.parse(discovery.stdout).recoveryPlanSha256 as string;

    const mutable = new DatabaseSync(databasePath);
    mutable.prepare("UPDATE catalog_source_records SET source_version = ? WHERE source_item_id = 'Q211372'").run("drifted-source-version");
    mutable.close();
    const beforeWrite = catalogRepairState(databasePath);
    const rejected = spawnImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "trusted-refresh-v2",
      "--rehydrate-required",
      "--expected-refresh-required", "1",
      "--expected-refresh-source-records", "1",
      "--expected-source-records", "2",
      "--expected-type-repairs", "1",
      "--expected-recovery-source-records", "2",
      "--expected-recovery-plan-sha256", planSha256,
      "--expected-file-sha256", sha256(fixture.body)
    ]);

    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("did not match --expected-recovery-plan-sha256");
    expect(catalogRepairState(databasePath)).toEqual(beforeWrite);
  });

  it("repairs a latent collision even when the source-specific refresh count is zero", () => {
    const directory = temporaryDirectory("moodarr-catalog-rehydrate-zero-refresh-");
    const inputPath = join(directory, "refresh.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    const fixture = seedLegacyCrossTypeCollision(databasePath, true);
    const mutable = new DatabaseSync(databasePath);
    mutable.prepare("UPDATE catalog_source_records SET materialization_stale = 0").run();
    mutable.close();
    writeFileSync(inputPath, fixture.body, "utf8");

    const recovered = runImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "trusted-refresh-v2",
      "--rehydrate-required",
      "--expected-refresh-required", "0",
      "--expected-refresh-source-records", "0",
      "--expected-source-records", "2",
      "--expected-type-repairs", "1",
      "--expected-recovery-source-records", "2",
      "--expected-file-sha256", sha256(fixture.body)
    ]);

    expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      refreshRequiredBefore: 0,
      typeRepairSourceRecordsBefore: 1,
      typeRepairSourceRecordsRemaining: 0,
      typeRepairExternalIdsPlanned: 3,
      typeRepairExternalIdsRemoved: 3,
      recoverySourceRecordsPlanned: 2,
      recoverySourceRecordsImported: 2
    });
  });

  it("rejects a limited trusted recovery before opening a write path", () => {
    const directory = temporaryDirectory("moodarr-catalog-rehydrate-limit-");
    const inputPath = join(directory, "refresh.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    const fixture = seedLegacyCrossTypeCollision(databasePath, true);
    writeFileSync(inputPath, fixture.body, "utf8");
    const before = catalogRepairState(databasePath);

    const rejected = runImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "trusted-refresh-v2",
      "--rehydrate-required",
      "--expected-refresh-required", "1",
      "--expected-refresh-source-records", "1",
      "--expected-source-records", "2",
      "--expected-type-repairs", "1",
      "--expected-recovery-source-records", "2",
      "--expected-file-sha256", sha256(fixture.body),
      "--limit", "1"
    ]);

    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("trusted recovery must preflight the complete operator-approved asset");
    expect(catalogRepairState(databasePath)).toEqual(before);
  });

  it("reuses one exact existing target and preserves durable operational request identities", () => {
    const directory = temporaryDirectory("moodarr-catalog-rehydrate-existing-target-");
    const inputPath = join(directory, "refresh.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    const fixture = seedLegacyCrossTypeCollision(databasePath, false);
    const mutable = createDatabase(databasePath);
    const repository = new MediaRepository(mutable, { runStartupRepairs: false });
    const targetMediaItemId = repository.upsert({
      source: "live",
      mediaType: "movie",
      title: "Existing On the Waterfront",
      year: 1954,
      externalIds: {
        tmdb: 654,
        imdb: "tt0047296",
        tvdb: 999,
        plex: "plex://show/legacy-reba"
      }
    });
    mutable.prepare("DELETE FROM seerr_items WHERE media_item_id = ?").run(fixture.boundMediaItemId);
    mutable.close();
    writeFileSync(inputPath, fixture.body, "utf8");

    const recovered = runImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "trusted-refresh-v2",
      "--rehydrate-required",
      "--expected-refresh-required", "1",
      "--expected-refresh-source-records", "1",
      "--expected-source-records", "1",
      "--expected-type-repairs", "1",
      "--expected-recovery-source-records", "1",
      "--expected-file-sha256", sha256(fixture.body)
    ]);

    expect(recovered.status, recovered.stderr).toBe(0);
    expect(targetMediaItemId).toBe("movie:654");
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(inspection.prepare("SELECT media_item_id FROM catalog_source_records WHERE source_item_id = 'Q211372'").get())
        .toEqual({ media_item_id: targetMediaItemId });
      expect(inspection.prepare("SELECT media_item_id FROM external_ids WHERE source = 'tmdb' AND media_type = 'tv' AND value = '654'").get())
        .toEqual({ media_item_id: fixture.boundMediaItemId });
      expect(inspection.prepare("SELECT media_item_id FROM requests WHERE media_item_id = ? AND media_id = 654").get(fixture.boundMediaItemId))
        .toEqual({ media_item_id: fixture.boundMediaItemId });
      expect(inspection.prepare(
        "SELECT media_type, title, normalized_title, year, source FROM media_items WHERE id = ?"
      ).get(targetMediaItemId)).toEqual({
        media_type: "movie",
        title: "Existing On the Waterfront",
        normalized_title: "existing on the waterfront",
        year: 1954,
        source: "live"
      });
    } finally {
      inspection.close();
    }
  });

  it("rejects an old plan when an existing repair target's source or external-ID owners drift", () => {
    for (const mutation of ["source", "external-id"] as const) {
      const directory = temporaryDirectory(`moodarr-catalog-rehydrate-target-${mutation}-drift-`);
      const inputPath = join(directory, "refresh.jsonl");
      const databasePath = join(directory, "moodarr.sqlite");
      const fixture = seedLegacyCrossTypeCollision(databasePath, false);
      const mutable = createDatabase(databasePath);
      const repository = new MediaRepository(mutable, { runStartupRepairs: false });
      const targetMediaItemId = repository.upsert({
        source: "live",
        mediaType: "movie",
        title: "Existing On the Waterfront",
        year: 1954,
        externalIds: { tmdb: 654, imdb: "tt0047296", tvdb: 999 }
      });
      mutable.close();
      writeFileSync(inputPath, fixture.body, "utf8");
      const discovery = spawnImporter(directory, databasePath, [
        "--file", inputPath,
        "--version", "trusted-refresh-v2",
        "--rehydrate-required",
        "--expected-refresh-required", "1",
        "--expected-source-records", "1",
        "--expected-file-sha256", sha256(fixture.body),
        "--dry-run"
      ]);
      expect(discovery.status, discovery.stderr).toBe(0);
      const planSha256 = JSON.parse(discovery.stdout).recoveryPlanSha256 as string;

      const drift = new DatabaseSync(databasePath);
      if (mutation === "source") {
        drift.prepare("UPDATE media_items SET source = 'catalog' WHERE id = ?").run(targetMediaItemId);
      } else {
        drift.prepare(
          "INSERT INTO external_ids (media_item_id, source, media_type, value) VALUES (?, 'custom', 'movie', 'target-owner-drift')"
        ).run(targetMediaItemId);
      }
      drift.close();
      const beforeWrite = catalogRepairState(databasePath);
      const rejected = spawnImporter(directory, databasePath, [
        "--file", inputPath,
        "--version", "trusted-refresh-v2",
        "--rehydrate-required",
        "--expected-refresh-required", "1",
        "--expected-refresh-source-records", "1",
        "--expected-source-records", "1",
        "--expected-type-repairs", "1",
        "--expected-recovery-source-records", "1",
        "--expected-recovery-plan-sha256", planSha256,
        "--expected-file-sha256", sha256(fixture.body)
      ]);

      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain("did not match --expected-recovery-plan-sha256");
      expect(catalogRepairState(databasePath)).toEqual(beforeWrite);
    }
  });

  it("does not let a created operation circularly corroborate a different TMDB identity", () => {
    const directory = temporaryDirectory("moodarr-catalog-rehydrate-created-operation-");
    const inputPath = join(directory, "refresh.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    const fixture = seedLegacyCrossTypeCollision(databasePath, false);
    const mutable = new DatabaseSync(databasePath);
    mutable.prepare("DELETE FROM seerr_items WHERE media_item_id = ?").run(fixture.boundMediaItemId);
    mutable.prepare("DELETE FROM requests WHERE media_item_id = ?").run(fixture.boundMediaItemId);
    mutable.prepare("DELETE FROM request_audit WHERE media_item_id = ?").run(fixture.boundMediaItemId);
    mutable.prepare(
      "UPDATE request_creation_operations SET response_json = ? WHERE media_item_id = ? AND status = 'created'"
    ).run(JSON.stringify({ request: { mediaId: 777 } }), fixture.boundMediaItemId);
    const operationBefore = mutable.prepare("SELECT * FROM request_creation_operations WHERE media_item_id = ?").get(fixture.boundMediaItemId);
    mutable.close();
    writeFileSync(inputPath, fixture.body, "utf8");

    const recovered = runImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "trusted-refresh-v2",
      "--rehydrate-required",
      "--expected-refresh-required", "1",
      "--expected-refresh-source-records", "1",
      "--expected-source-records", "1",
      "--expected-type-repairs", "1",
      "--expected-recovery-source-records", "1",
      "--expected-file-sha256", sha256(fixture.body)
    ]);

    expect(recovered.status, recovered.stderr).toBe(0);
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(inspection.prepare("SELECT 1 FROM external_ids WHERE media_item_id = ? AND source = 'tmdb' AND value = '654'").get(fixture.boundMediaItemId))
        .toBeUndefined();
      expect(inspection.prepare("SELECT * FROM request_creation_operations WHERE media_item_id = ?").get(fixture.boundMediaItemId))
        .toEqual(operationBefore);
    } finally {
      inspection.close();
    }
  });

  it("fails closed when a trusted repair target resolves to multiple existing items", () => {
    const directory = temporaryDirectory("moodarr-catalog-rehydrate-ambiguous-target-");
    const inputPath = join(directory, "refresh.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    const fixture = seedLegacyCrossTypeCollision(databasePath, false);
    const mutable = createDatabase(databasePath);
    const repository = new MediaRepository(mutable, { runStartupRepairs: false });
    repository.upsert({ source: "live", mediaType: "movie", title: "TMDB owner", externalIds: { tmdb: 654 } });
    repository.upsert({ source: "live", mediaType: "movie", title: "IMDb owner", externalIds: { imdb: "tt0047296" } });
    mutable.close();
    writeFileSync(inputPath, fixture.body, "utf8");
    const before = catalogRepairState(databasePath);

    const rejected = runImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "trusted-refresh-v2",
      "--rehydrate-required",
      "--expected-refresh-required", "1",
      "--expected-refresh-source-records", "1",
      "--expected-source-records", "1",
      "--expected-file-sha256", sha256(fixture.body),
      "--dry-run"
    ]);

    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("Media identifiers resolve to multiple existing items.");
    expect(catalogRepairState(databasePath)).toEqual(before);
  });

  it("does not let an unsupported external-ID owner select a trusted repair target", () => {
    const directory = temporaryDirectory("moodarr-catalog-rehydrate-unsupported-target-");
    const inputPath = join(directory, "refresh.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    const fixture = seedLegacyCrossTypeCollision(databasePath, false);
    const mutable = createDatabase(databasePath);
    const repository = new MediaRepository(mutable, { runStartupRepairs: false });
    repository.upsert({
      source: "live",
      mediaType: "movie",
      title: "Unsupported custom identity owner",
      year: 1954,
      externalIds: { custom: "shared-wrong-record-id" }
    });
    mutable.close();
    writeFileSync(inputPath, fixture.body, "utf8");
    const before = catalogRepairState(databasePath);

    const rejected = runImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "trusted-refresh-v2",
      "--rehydrate-required",
      "--expected-refresh-required", "1",
      "--expected-refresh-source-records", "1",
      "--expected-source-records", "1",
      "--expected-type-repairs", "1",
      "--expected-recovery-source-records", "1",
      "--expected-file-sha256", sha256(fixture.body)
    ]);

    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("Media identifiers resolve to multiple existing items.");
    expect(catalogRepairState(databasePath)).toEqual(before);
  });

  it("rejects distinct repair source identities that converge on one target", () => {
    const directory = temporaryDirectory("moodarr-catalog-rehydrate-converging-target-");
    const inputPath = join(directory, "refresh.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    const fixture = seedLegacyCrossTypeCollision(databasePath, true);
    const expanded = addWrongTypeSourceRecord(databasePath, fixture, {
      id: "Q211373",
      mediaType: "film",
      label: "On the Waterfront duplicate source",
      publicationDate: "1954-01-01",
      imdbId: "tt0047296",
      tmdbMovieId: 654,
      tvdbId: 999
    });
    writeFileSync(inputPath, expanded.body, "utf8");
    const before = catalogRepairState(databasePath);

    const rejected = runImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "trusted-refresh-v2",
      "--rehydrate-required",
      "--expected-refresh-required", "1",
      "--expected-source-records", "3",
      "--expected-file-sha256", sha256(expanded.body),
      "--dry-run"
    ]);

    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("cannot converge distinct source identities on one repair target");
    expect(catalogRepairState(databasePath)).toEqual(before);
  });

  it("rejects duplicate cleanup identities that would be inserted into different repair targets", () => {
    const directory = temporaryDirectory("moodarr-catalog-rehydrate-duplicate-cleanup-");
    const inputPath = join(directory, "refresh.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    const fixture = seedLegacyCrossTypeCollision(databasePath, true);
    const expanded = addWrongTypeSourceRecord(databasePath, fixture, {
      id: "Q211374",
      mediaType: "film",
      label: "Different movie sharing a poisoned external identity",
      publicationDate: "1955-01-01",
      imdbId: "tt0047297",
      tmdbMovieId: 655,
      externalIds: { custom: "shared-wrong-record-id" }
    });
    writeFileSync(inputPath, expanded.body, "utf8");
    const before = catalogRepairState(databasePath);

    const rejected = runImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "trusted-refresh-v2",
      "--rehydrate-required",
      "--expected-refresh-required", "1",
      "--expected-source-records", "3",
      "--expected-file-sha256", sha256(expanded.body),
      "--dry-run"
    ]);

    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("maps one external media identity to multiple repair targets");
    expect(catalogRepairState(databasePath)).toEqual(before);
  });

  it("fails closed when the deterministic repair target ID is occupied by the wrong type", () => {
    const directory = temporaryDirectory("moodarr-catalog-rehydrate-wrong-target-type-");
    const inputPath = join(directory, "refresh.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    const fixture = seedLegacyCrossTypeCollision(databasePath, false);
    const mutable = new DatabaseSync(databasePath);
    mutable.prepare(
      `INSERT INTO media_items (id, media_type, title, normalized_title, source, created_at, updated_at)
       VALUES ('movie:654', 'tv', 'Wrong target type', 'wrong target type', 'live', ?, ?)`
    ).run("2026-07-01T00:00:00.000Z", "2026-07-01T00:00:00.000Z");
    mutable.close();
    writeFileSync(inputPath, fixture.body, "utf8");
    const before = catalogRepairState(databasePath);

    const rejected = runImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "trusted-refresh-v2",
      "--rehydrate-required",
      "--expected-refresh-required", "1",
      "--expected-refresh-source-records", "1",
      "--expected-source-records", "1",
      "--expected-file-sha256", sha256(fixture.body),
      "--dry-run"
    ]);

    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("repair target has an incompatible media type");
    expect(catalogRepairState(databasePath)).toEqual(before);
  });

  it("authoritatively rematerializes catalog-owned scalar and list metadata and clears stale derived caches", () => {
    const directory = temporaryDirectory("moodarr-catalog-rehydrate-authoritative-");
    const inputPath = join(directory, "refresh.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    const fixture = seedCatalogOwnedCollision(databasePath);
    writeFileSync(inputPath, fixture.body, "utf8");

    const recovered = runImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "trusted-refresh-v2",
      "--rehydrate-required",
      "--expected-refresh-required", "1",
      "--expected-refresh-source-records", "1",
      "--expected-source-records", "2",
      "--expected-type-repairs", "1",
      "--expected-recovery-source-records", "2",
      "--expected-file-sha256", sha256(fixture.body)
    ]);

    expect(recovered.status, recovered.stderr).toBe(0);
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(inspection.prepare(
        `SELECT year, summary, runtime_minutes, content_rating, poster_path,
          critic_rating, audience_rating, user_rating
         FROM media_items WHERE id = ?`
      ).get(fixture.boundMediaItemId)).toEqual({
        year: null,
        summary: null,
        runtime_minutes: null,
        content_rating: null,
        poster_path: null,
        critic_rating: null,
        audience_rating: null,
        user_rating: null
      });
      expect(inspection.prepare("SELECT name FROM genres WHERE media_item_id = ? ORDER BY name").all(fixture.boundMediaItemId))
        .toEqual([{ name: "Comedy" }]);
      expect(inspection.prepare("SELECT name, role FROM people WHERE media_item_id = ? ORDER BY role, name").all(fixture.boundMediaItemId))
        .toEqual([
          { name: "Correct Actor", role: "cast" },
          { name: "Correct Director", role: "director" }
        ]);
      expect(inspection.prepare("SELECT 1 FROM poster_cache WHERE media_item_id = ?").get(fixture.boundMediaItemId)).toBeUndefined();
      expect(inspection.prepare("SELECT 1 FROM media_embeddings WHERE media_item_id = ?").get(fixture.boundMediaItemId)).toBeUndefined();
      expect(inspection.prepare("SELECT 1 FROM media_features WHERE media_item_id = ?").get(fixture.boundMediaItemId)).toEqual({ 1: 1 });
      expect(inspection.prepare("SELECT 1 FROM catalog_search_index WHERE media_item_id = ?").get(fixture.boundMediaItemId)).toEqual({ 1: 1 });
      expect(inspection.prepare(
        "SELECT media_item_id FROM external_ids WHERE source = 'imdb' AND media_type = 'tv' AND value = 'tt0047296'"
      ).get()).toEqual({ media_item_id: fixture.boundMediaItemId });
      expect(inspection.prepare(
        "SELECT media_item_id FROM external_ids WHERE source = 'imdb' AND media_type = 'movie' AND value = 'tt0047296'"
      ).get()).toEqual({ media_item_id: "movie:654" });
    } finally {
      inspection.close();
    }
  });

  it("authoritatively rematerializes a refresh-only catalog row and closes all derived state", () => {
    const directory = temporaryDirectory("moodarr-catalog-rehydrate-refresh-only-");
    const inputPath = join(directory, "refresh.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    const rawRecord = {
      id: "Q900002",
      mediaType: "film",
      label: "Authoritative Refresh Only",
      genreLabels: ["Drama"]
    };
    const body = `${JSON.stringify(rawRecord)}\n`;
    writeFileSync(inputPath, body, "utf8");
    const db = createDatabase(databasePath);
    const repository = new MediaRepository(db, { runStartupRepairs: false });
    const mediaItemId = repository.upsertCatalogRecord({
      source: "wikidata",
      sourceVersion: "legacy-v1",
      sourceItemId: rawRecord.id,
      licensePolicy: "wikidata-cc0",
      payloadHash: sha256(JSON.stringify(rawRecord)),
      media: {
        mediaType: "movie",
        title: rawRecord.label,
        genres: rawRecord.genreLabels,
        externalIds: { wikidata: rawRecord.id }
      }
    });
    const now = "2026-07-01T05:37:32.390Z";
    db.prepare(
      `UPDATE media_items SET title='Stale refresh title', normalized_title='stale refresh title', year=1999,
        summary='Stale refresh summary', runtime_minutes=199, content_rating='WRONG', poster_path='fixture://stale-refresh',
        critic_rating=1, audience_rating=2, user_rating=3 WHERE id=?`
    ).run(mediaItemId);
    db.prepare("DELETE FROM genres WHERE media_item_id=?").run(mediaItemId);
    db.prepare("INSERT INTO genres(media_item_id,name) VALUES(?,'Stale refresh genre')").run(mediaItemId);
    db.prepare("UPDATE catalog_source_records SET materialization_stale=1 WHERE source='wikidata' AND source_item_id=?").run(rawRecord.id);
    repository.savePosterCache(mediaItemId, "stale-refresh", "image/jpeg", Buffer.from("stale-refresh-poster"));
    db.prepare(
      `INSERT INTO media_embeddings (
        media_item_id, provider, model, feature_version, input_hash, dimensions, vector_json, updated_at
      ) VALUES (?, 'stale-refresh', 'stale-refresh', 'stale-refresh', 'stale-refresh', 1, '[0.1]', ?)`
    ).run(mediaItemId, now);
    db.prepare(
      `UPDATE catalog_search_index SET title='Stale refresh search', media_type='tv', source='catalog',
        search_text='Stale refresh search', mood_text='Stale refresh search' WHERE media_item_id=?`
    ).run(mediaItemId);
    db.prepare(
      `UPDATE catalog_search_index_fts SET title='Stale refresh search', search_text='Stale refresh search',
        mood_text='Stale refresh search' WHERE media_item_id=?`
    ).run(mediaItemId);
    db.prepare(
      `INSERT INTO plex_items (
        id,media_item_id,rating_key,guid,library_title,library_type,plex_url,available,last_seen_at
      ) VALUES ('plex:refresh-only',?,'refresh-only','plex://refresh-only','Movies','movie','https://plex.invalid/refresh-only',1,?)`
    ).run(mediaItemId, now);
    db.prepare(
      `INSERT INTO seerr_items (
        id,media_item_id,tmdb_id,tvdb_id,imdb_id,seerr_media_id,media_type,status,request_status,requestable,seerr_url,last_seen_at
      ) VALUES ('seerr:refresh-only',?,900002,NULL,'tt9000002',900002,'movie','pending','approved',0,'https://seerr.invalid/movie/900002',?)`
    ).run(mediaItemId, now);
    db.prepare(
      `INSERT INTO requests (media_item_id,media_type,media_id,seasons_json,status,external_request_id,created_at)
       VALUES (?,'movie',900002,NULL,'created','request:refresh-only',?)`
    ).run(mediaItemId, now);
    db.prepare(
      `INSERT INTO request_creation_operations (
        idempotency_key,request_fingerprint,auth_scope,media_item_id,status,response_json,error,created_at,updated_at
      ) VALUES ('operation:refresh-only','fingerprint:refresh-only','anonymous',?,'pending','{"sentinel":"refresh-only"}',NULL,?,?)`
    ).run(mediaItemId, now, now);
    const operationalBefore = Object.fromEntries([
      "plex_items", "seerr_items", "requests", "request_creation_operations"
    ].map((table) => [table, db.prepare(`SELECT * FROM ${table} WHERE media_item_id=? ORDER BY rowid`).all(mediaItemId)]));
    db.close();

    const recovered = runImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "trusted-refresh-v2",
      "--rehydrate-required",
      "--expected-refresh-required", "1",
      "--expected-refresh-source-records", "1",
      "--expected-source-records", "1",
      "--expected-type-repairs", "0",
      "--expected-recovery-source-records", "1",
      "--expected-file-sha256", sha256(body)
    ]);

    expect(recovered.status, recovered.stderr).toBe(0);
    expect(JSON.parse(recovered.stdout)).toMatchObject({
      refreshRequiredRemaining: 0,
      recoveryDerivedItemsRemaining: 0,
      recoverySourceRecordsImported: 1,
      recoverySourceRecordsRemaining: 0,
      typeRepairSourceRecordsBefore: 0
    });
    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(inspection.prepare(
        `SELECT media_type,title,normalized_title,year,summary,runtime_minutes,content_rating,poster_path,
          critic_rating,audience_rating,user_rating,source FROM media_items WHERE id=?`
      ).get(mediaItemId)).toEqual({
        media_type: "movie",
        title: rawRecord.label,
        normalized_title: rawRecord.label.toLowerCase(),
        year: null,
        summary: null,
        runtime_minutes: null,
        content_rating: null,
        poster_path: null,
        critic_rating: null,
        audience_rating: null,
        user_rating: null,
        source: "catalog"
      });
      expect(inspection.prepare("SELECT name FROM genres WHERE media_item_id=? ORDER BY name").all(mediaItemId))
        .toEqual([{ name: rawRecord.genreLabels[0] }]);
      expect(inspection.prepare(
        "SELECT title,media_type,source FROM catalog_search_index WHERE media_item_id=?"
      ).get(mediaItemId)).toEqual({ title: rawRecord.label, media_type: "movie", source: "catalog" });
      expect(inspection.prepare(
        "SELECT title FROM catalog_search_index_fts WHERE media_item_id=?"
      ).get(mediaItemId)).toEqual({ title: rawRecord.label });
      expect(inspection.prepare("SELECT 1 FROM poster_cache WHERE media_item_id=?").get(mediaItemId)).toBeUndefined();
      expect(inspection.prepare("SELECT 1 FROM media_embeddings WHERE media_item_id=? AND provider='stale-refresh'").get(mediaItemId)).toBeUndefined();
      expect(inspection.prepare(
        `SELECT materialization_stale,source_version,last_seen_source_version,content_hash,payload_hash
         FROM catalog_source_records WHERE source='wikidata' AND source_item_id=?`
      ).get(rawRecord.id)).toEqual({
        materialization_stale: 0,
        source_version: "trusted-refresh-v2",
        last_seen_source_version: "trusted-refresh-v2",
        content_hash: sha256(JSON.stringify(rawRecord)),
        payload_hash: sha256(JSON.stringify(rawRecord))
      });
      expect(Object.fromEntries([
        "plex_items", "seerr_items", "requests", "request_creation_operations"
      ].map((table) => [table, inspection.prepare(`SELECT * FROM ${table} WHERE media_item_id=? ORDER BY rowid`).all(mediaItemId)])))
        .toEqual(operationalBefore);
    } finally {
      inspection.close();
    }
  });

  it("rejects a repair that would leave a catalog-owned media item without provenance", () => {
    const directory = temporaryDirectory("moodarr-catalog-rehydrate-orphan-");
    const inputPath = join(directory, "refresh.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    const fixture = seedLegacyCrossTypeCollision(databasePath, false);
    const mutable = new DatabaseSync(databasePath);
    mutable.prepare("UPDATE media_items SET source = 'catalog' WHERE id = ?").run(fixture.boundMediaItemId);
    mutable.close();
    writeFileSync(inputPath, fixture.body, "utf8");
    const before = catalogRepairState(databasePath);

    const rejected = runImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "trusted-refresh-v2",
      "--rehydrate-required",
      "--expected-refresh-required", "1",
      "--expected-refresh-source-records", "1",
      "--expected-source-records", "1",
      "--expected-file-sha256", sha256(fixture.body),
      "--dry-run"
    ]);

    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("without a same-type active catalog companion");
    expect(catalogRepairState(databasePath)).toEqual(before);
  });

  it("removes an orphaned old rank signal when the repaired source was its only catalog relationship", () => {
    const directory = temporaryDirectory("moodarr-catalog-type-rebind-single-");
    const inputPath = join(directory, "refresh.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    const fixture = seedLegacyCrossTypeCollision(databasePath, false);
    writeFileSync(inputPath, fixture.body, "utf8");

    const recovered = runImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "trusted-refresh-v2",
      "--rehydrate-required",
      "--expected-refresh-required", "1",
      "--expected-refresh-source-records", "1",
      "--expected-source-records", "1",
      "--expected-type-repairs", "1",
      "--expected-recovery-source-records", "1",
      "--expected-file-sha256", sha256(fixture.body),
      "--batch-size", "1"
    ]);
    expect(recovered.status, recovered.stderr).toBe(0);

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(inspection.prepare("SELECT media_item_id FROM catalog_source_records WHERE source_item_id = 'Q211372'").get()).toEqual({
        media_item_id: "movie:654"
      });
      expect(inspection.prepare("SELECT 1 FROM catalog_rank_signals WHERE media_item_id = ? AND source = 'wikidata'").get(fixture.boundMediaItemId)).toBeUndefined();
      expect(inspection.prepare("SELECT 1 FROM catalog_rank_signals WHERE media_item_id = 'movie:654' AND source = 'wikidata'").get()).toEqual({ 1: 1 });
    } finally {
      inspection.close();
    }
  });

  it("rolls back every trusted-rehydrate batch when a later source record fails", () => {
    const directory = temporaryDirectory("moodarr-catalog-rehydrate-atomic-");
    const inputPath = join(directory, "refresh.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    const fixture = seedLegacyCrossTypeCollision(databasePath, true, true);
    writeFileSync(inputPath, fixture.body, "utf8");

    const failed = runImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "trusted-refresh-v2",
      "--rehydrate-required",
      "--expected-refresh-required", "1",
      "--expected-refresh-source-records", "1",
      "--expected-source-records", "2",
      "--expected-type-repairs", "1",
      "--expected-recovery-source-records", "2",
      "--expected-file-sha256", sha256(fixture.body),
      "--batch-size", "1"
    ]);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("forced late trusted-rehydrate failure");

    const inspection = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(
        inspection.prepare("SELECT source_item_id, media_item_id, content_version, materialization_stale FROM catalog_source_records ORDER BY source_item_id").all()
      ).toEqual([
        { source_item_id: "Q211372", media_item_id: fixture.boundMediaItemId, content_version: 7, materialization_stale: 0 },
        { source_item_id: "Q762739", media_item_id: fixture.boundMediaItemId, content_version: 1, materialization_stale: 1 }
      ]);
      expect(inspection.prepare("SELECT 1 FROM media_items WHERE id = 'movie:654'").get()).toBeUndefined();
      expect(
        inspection.prepare("SELECT media_item_id, media_type FROM external_ids WHERE source = 'wikidata' AND value = 'Q211372'").all()
      ).toEqual([{ media_item_id: fixture.boundMediaItemId, media_type: "tv" }]);
      expect(inspection.prepare("SELECT COUNT(*) AS value FROM catalog_sync_runs").get()).toEqual({ value: 0 });
    } finally {
      inspection.close();
    }
  });

  it("rolls back when exact post-write recovery content-hash closure is corrupted", () => {
    const directory = temporaryDirectory("moodarr-catalog-rehydrate-content-closure-");
    const inputPath = join(directory, "refresh.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    const fixture = seedLegacyCrossTypeCollision(databasePath, true);
    writeFileSync(inputPath, fixture.body, "utf8");
    const mutable = new DatabaseSync(databasePath);
    mutable.exec(`CREATE TRIGGER corrupt_recovery_content_hash
      AFTER UPDATE ON catalog_source_records
      WHEN NEW.source_item_id = 'Q762739'
      BEGIN
        UPDATE catalog_source_records SET content_hash = NULL
        WHERE source = NEW.source AND source_item_id = NEW.source_item_id;
      END`);
    mutable.close();
    const before = catalogRepairState(databasePath);

    const rejected = runImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "trusted-refresh-v2",
      "--rehydrate-required",
      "--expected-refresh-required", "1",
      "--expected-refresh-source-records", "1",
      "--expected-source-records", "2",
      "--expected-type-repairs", "1",
      "--expected-recovery-source-records", "2",
      "--expected-file-sha256", sha256(fixture.body),
      "--batch-size", "1"
    ]);

    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("recoverySources=1");
    expect(catalogRepairState(databasePath)).toEqual(before);
  });

  it("rolls back when a recovered search index has the wrong media type", () => {
    const directory = temporaryDirectory("moodarr-catalog-rehydrate-index-type-closure-");
    const inputPath = join(directory, "refresh.jsonl");
    const databasePath = join(directory, "moodarr.sqlite");
    const fixture = seedLegacyCrossTypeCollision(databasePath, true);
    writeFileSync(inputPath, fixture.body, "utf8");
    const mutable = new DatabaseSync(databasePath);
    mutable.exec(`CREATE TRIGGER corrupt_recovery_index_type
      AFTER UPDATE ON catalog_search_index
      WHEN NEW.media_item_id = '${fixture.boundMediaItemId}'
      BEGIN
        UPDATE catalog_search_index SET media_type = 'movie' WHERE media_item_id = NEW.media_item_id;
      END`);
    mutable.close();
    const before = catalogRepairState(databasePath);

    const rejected = runImporter(directory, databasePath, [
      "--file", inputPath,
      "--version", "trusted-refresh-v2",
      "--rehydrate-required",
      "--expected-refresh-required", "1",
      "--expected-refresh-source-records", "1",
      "--expected-source-records", "2",
      "--expected-type-repairs", "1",
      "--expected-recovery-source-records", "2",
      "--expected-file-sha256", sha256(fixture.body),
      "--batch-size", "1"
    ]);

    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain("derivedItems=1");
    expect(catalogRepairState(databasePath)).toEqual(before);
  });
});

function seedLegacyCrossTypeCollision(databasePath: string, includeCompanion: boolean, failCompanion = false) {
  const wrongTypeRecord = {
    id: "Q211372",
    mediaType: "film",
    label: "On the Waterfront",
    publicationDate: "1954-01-01",
    imdbId: "tt0047296",
    tmdbMovieId: 654,
    tvdbId: 999,
    externalIds: { plex: "plex://show/legacy-reba", custom: "shared-wrong-record-id" }
  };
  const companionRecord = {
    id: "Q762739",
    mediaType: "television series",
    label: "Reba",
    publicationDate: "2001-01-01",
    imdbId: "tt0284722",
    tmdbTvId: 654
  };
  const records = [wrongTypeRecord, ...(includeCompanion ? [companionRecord] : [])];
  const db = createDatabase(databasePath);
  const repository = new MediaRepository(db, { runStartupRepairs: false });
  const boundMediaItemId = repository.upsert({
    source: "live",
    mediaType: "tv",
    title: "Reba",
    year: 2001,
    externalIds: { tmdb: 654, imdb: "tt0284722", wikidata: "Q762739" },
    plex: { ratingKey: "legacy-reba", guid: "plex://show/legacy-reba", available: true },
    seerr: {
      tmdbId: 654,
      tvdbId: 2778,
      imdbId: "tt0284722",
      seerrMediaId: 42,
      status: "available",
      requestable: false
    }
  });
  if (includeCompanion) {
    repository.upsertCatalogRecord({
      source: "wikidata",
      sourceVersion: "legacy-v1",
      sourceItemId: "Q762739",
      licensePolicy: "wikidata-cc0",
      payloadHash: sha256(JSON.stringify(companionRecord)),
      media: {
        mediaType: "tv",
        title: "Reba",
        year: 2001,
        externalIds: { tmdb: 654, imdb: "tt0284722", wikidata: "Q762739" }
      }
    });
  }
  const now = "2026-07-01T05:37:32.390Z";
  db.prepare(
    `INSERT INTO catalog_source_records (
      media_item_id, source, source_version, source_item_id, source_url, license_policy,
      payload_hash, content_hash, content_version, metadata_json, fetched_at, expires_at,
      active, last_seen_source_version, materialization_stale, deleted_at, updated_at
    ) VALUES (?, 'wikidata', 'legacy-v1', 'Q211372', 'https://www.wikidata.org/wiki/Q211372', 'wikidata-cc0',
      ?, ?, 7, '{}', ?, NULL, 1, 'legacy-v1', 1, NULL, ?)`
  ).run(boundMediaItemId, sha256(JSON.stringify(wrongTypeRecord)), sha256(JSON.stringify(wrongTypeRecord)), now, now);
  db.prepare(
    `INSERT INTO external_ids (media_item_id, source, media_type, value)
     VALUES (?, 'wikidata', 'tv', 'Q211372')`
  ).run(boundMediaItemId);
  db.prepare(
    `INSERT INTO external_ids (media_item_id, source, media_type, value)
     VALUES (?, 'tvdb', 'tv', '999')`
  ).run(boundMediaItemId);
  db.prepare(
    `INSERT INTO external_ids (media_item_id, source, media_type, value)
     VALUES (?, 'custom', 'tv', 'shared-wrong-record-id')`
  ).run(boundMediaItemId);
  db.prepare(
    `INSERT INTO app_users (
      id, provider, provider_user_id, username, enabled, created_at, updated_at, can_request, can_use_ai
    ) VALUES ('user:catalog-repair', 'plex', 'catalog-repair', 'catalog-repair', 1, ?, ?, 1, 1)`
  ).run(now, now);
  db.prepare(
    `INSERT INTO user_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at)
     VALUES ('session:catalog-repair', 'user:catalog-repair', 'catalog-repair-token-hash', ?, '2027-01-01T00:00:00.000Z', ?)`
  ).run(now, now);
  db.prepare(
    `INSERT INTO requests (media_item_id, media_type, media_id, seasons_json, status, external_request_id, created_at)
     VALUES (?, 'tv', 654, '[1]', 'created', 'request:catalog-repair', ?)`
  ).run(boundMediaItemId, now);
  repository.recordRequestAudit({
    mediaItemId: boundMediaItemId,
    authUserId: "user:catalog-repair",
    action: "create",
    status: "created",
    mediaType: "tv",
    mediaId: 654,
    title: "Reba",
    seasons: [1],
    externalRequestId: "request:catalog-repair"
  });
  db.prepare(
    `INSERT INTO request_creation_operations (
      idempotency_key, request_fingerprint, auth_scope, media_item_id, status, response_json, error, created_at, updated_at
    ) VALUES ('operation:catalog-repair', 'fingerprint:catalog-repair', 'user:catalog-repair', ?, 'created', '{}', NULL, ?, ?)`
  ).run(boundMediaItemId, now, now);
  db.prepare(
    `INSERT INTO recommendation_sessions (
      id, query_hash, engine_version, watch_context, result_count, candidate_count,
      rerank_candidate_count, used_ai, seerr_augmented, latency_ms, auth_user_id, created_at
    ) VALUES ('recommendation:catalog-repair', 'query-hash', 'test-engine', 'solo', 1, 1, 1, 0, 0, 1, 'user:catalog-repair', ?)`
  ).run(now);
  db.prepare(
    `INSERT INTO recommendation_results (
      session_id, media_item_id, rank, score, score_breakdown_json, availability_group
    ) VALUES ('recommendation:catalog-repair', ?, 1, 50, '{}', 'available')`
  ).run(boundMediaItemId);
  db.prepare(
    `INSERT INTO recommendation_feedback (session_id, media_item_id, watch_context, feedback, created_at)
     VALUES ('recommendation:catalog-repair', ?, 'solo', 'more_like', ?)`
  ).run(boundMediaItemId, now);
  db.prepare(
    `INSERT INTO query_review_queue (
      id, session_id, query_text, watch_context, result_count, results_json, created_at, updated_at
    ) VALUES ('review:catalog-repair', 'recommendation:catalog-repair', 'catalog repair query', 'solo', 1, '[]', ?, ?)`
  ).run(now, now);
  db.prepare(
    `INSERT INTO recommendation_candidate_provenance (
      session_id, media_item_id, source, score, source_rank, detail_json, created_at
    ) VALUES ('recommendation:catalog-repair', ?, 'catalog', 1, 1, '{}', ?)`
  ).run(boundMediaItemId, now);
  db.prepare(
    `INSERT INTO recommendation_rejections (
      session_id, media_item_id, stage, reason_code, score, detail_json, sampled, created_at
    ) VALUES ('recommendation:catalog-repair', ?, 'retrieval', 'sentinel', 0, '{}', 1, ?)`
  ).run(boundMediaItemId, now);
  db.prepare(
    `INSERT INTO recommendation_impressions (
      session_id, media_item_id, rank_shown, surface, visibility, metadata_json, created_at
    ) VALUES ('recommendation:catalog-repair', ?, 1, 'results', 'visible', '{}', ?)`
  ).run(boundMediaItemId, now);
  db.prepare(
    `INSERT INTO feel_feedback_events (
      session_id, media_item_id, watch_context, source, action, metadata_json, created_at,
      reliability, profile_version, profile_update_applied, profile_holdout
    ) VALUES ('recommendation:catalog-repair', ?, 'solo', 'web', 'save', '{}', ?, 'high', 0, 0, 0)`
  ).run(boundMediaItemId, now);
  if (includeCompanion) {
    db.prepare(
      "UPDATE catalog_source_records SET materialization_stale = CASE WHEN source_item_id = 'Q762739' THEN 1 ELSE 0 END"
    ).run();
  } else {
    db.prepare(
      `INSERT INTO catalog_rank_signals (
        media_item_id, source, source_version, mainstream_score, metadata_confidence,
        sitelink_count, external_id_count, award_count, updated_at
      ) VALUES (?, 'wikidata', 'legacy-v1', 50, 0.5, 10, 2, 0, ?)`
    ).run(boundMediaItemId, now);
  }
  if (failCompanion) {
    db.exec(`CREATE TRIGGER fail_late_trusted_rehydrate
      BEFORE UPDATE ON catalog_source_records
      WHEN OLD.source_item_id = 'Q762739'
      BEGIN
        SELECT RAISE(ABORT, 'forced late trusted-rehydrate failure');
      END`);
  }
  db.close();

  return { boundMediaItemId, body: records.map((record) => JSON.stringify(record)).join("\n") + "\n" };
}

function seedCatalogOwnedCollision(databasePath: string) {
  const wrongTypeRecord = {
    id: "Q211372",
    mediaType: "film",
    label: "On the Waterfront",
    publicationDate: "1954-01-01",
    tmdbMovieId: 654,
    imdbId: "tt0047296"
  };
  const companionRecord = {
    id: "Q762739",
    mediaType: "television series",
    label: "Reba",
    tmdbTvId: 654,
    genreLabels: ["Comedy"],
    castLabels: ["Correct Actor"],
    directorLabels: ["Correct Director"]
  };
  const db = createDatabase(databasePath);
  const repository = new MediaRepository(db, { runStartupRepairs: false });
  const boundMediaItemId = repository.upsert({
    source: "catalog",
    mediaType: "tv",
    title: "Poisoned Reba",
    year: 1999,
    summary: "Wrong summary",
    runtimeMinutes: 99,
    contentRating: "Wrong rating",
    posterPath: "https://wrong.invalid/poster.jpg",
    ratings: { critic: 1, audience: 2, user: 3 },
    genres: ["Wrong Genre"],
    cast: ["Wrong Actor"],
    directors: ["Wrong Director"],
    externalIds: { tmdb: 654, wikidata: "Q762739" }
  });
  repository.upsertCatalogRecord({
    source: "wikidata",
    sourceVersion: "legacy-v1",
    sourceItemId: "Q762739",
    licensePolicy: "wikidata-cc0",
    payloadHash: sha256(JSON.stringify(companionRecord)),
    media: {
      mediaType: "tv",
      title: "Reba",
      genres: ["Comedy"],
      cast: ["Correct Actor"],
      directors: ["Correct Director"],
      externalIds: { tmdb: 654, wikidata: "Q762739" }
    }
  });
  const now = "2026-07-01T05:37:32.390Z";
  db.prepare(
    `INSERT INTO catalog_source_records (
      media_item_id, source, source_version, source_item_id, source_url, license_policy,
      payload_hash, content_hash, content_version, metadata_json, fetched_at, expires_at,
      active, last_seen_source_version, materialization_stale, deleted_at, updated_at
    ) VALUES (?, 'wikidata', 'legacy-v1', 'Q211372', 'https://www.wikidata.org/wiki/Q211372', 'wikidata-cc0',
      ?, ?, 3, '{}', ?, NULL, 1, 'legacy-v1', 0, NULL, ?)`
  ).run(boundMediaItemId, sha256(JSON.stringify(wrongTypeRecord)), sha256(JSON.stringify(wrongTypeRecord)), now, now);
  db.prepare(
    `INSERT INTO external_ids (media_item_id, source, media_type, value)
     VALUES (?, 'wikidata', 'tv', 'Q211372')`
  ).run(boundMediaItemId);
  db.prepare(
    `INSERT INTO external_ids (media_item_id, source, media_type, value)
     VALUES (?, 'imdb', 'tv', 'tt0047296')`
  ).run(boundMediaItemId);
  db.prepare(
    `INSERT INTO seerr_items (
      id, media_item_id, tmdb_id, tvdb_id, imdb_id, seerr_media_id, media_type,
      status, request_status, requestable, seerr_url, last_seen_at
    ) VALUES ('seerr:catalog-owned-collision', ?, NULL, NULL, 'tt0047296', 900001, 'tv',
      'unknown', NULL, 1, NULL, ?)`
  ).run(boundMediaItemId, now);
  db.prepare("UPDATE catalog_source_records SET materialization_stale = 1 WHERE source_item_id = 'Q762739'").run();
  repository.savePosterCache(boundMediaItemId, "wrong-source", "image/jpeg", Buffer.from("wrong-poster"));
  db.prepare(
    `INSERT INTO media_embeddings (
      media_item_id, provider, model, feature_version, input_hash, dimensions, vector_json, updated_at
    ) VALUES (?, 'test', 'stale-model', 'stale-feature', 'stale-input', 1, '[0.1]', ?)`
  ).run(boundMediaItemId, now);
  db.close();
  const records = [wrongTypeRecord, companionRecord];
  return { boundMediaItemId, body: records.map((record) => JSON.stringify(record)).join("\n") + "\n" };
}

function addWrongTypeSourceRecord(
  databasePath: string,
  fixture: { boundMediaItemId: string; body: string },
  record: Record<string, unknown>
) {
  const sourceItemId = String(record.id);
  const payloadHash = sha256(JSON.stringify(record));
  const now = "2026-07-01T05:37:32.390Z";
  const db = new DatabaseSync(databasePath);
  db.prepare(
    `INSERT INTO catalog_source_records (
      media_item_id, source, source_version, source_item_id, source_url, license_policy,
      payload_hash, content_hash, content_version, metadata_json, fetched_at, expires_at,
      active, last_seen_source_version, materialization_stale, deleted_at, updated_at
    ) VALUES (?, 'wikidata', 'legacy-v1', ?, ?, 'wikidata-cc0', ?, ?, 1, '{}', ?, NULL, 1, 'legacy-v1', 0, NULL, ?)`
  ).run(
    fixture.boundMediaItemId,
    sourceItemId,
    `https://www.wikidata.org/wiki/${sourceItemId}`,
    payloadHash,
    payloadHash,
    now,
    now
  );
  db.prepare(
    `INSERT INTO external_ids (media_item_id, source, media_type, value)
     VALUES (?, 'wikidata', 'tv', ?)`
  ).run(fixture.boundMediaItemId, sourceItemId);
  db.close();
  return { ...fixture, body: `${fixture.body}${JSON.stringify(record)}\n` };
}

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
  let boundArgs = args;
  if (
    args.includes("--rehydrate-required")
    && !args.includes("--dry-run")
    && !args.includes("--expected-recovery-plan-sha256")
  ) {
    const discovery = spawnImporter(directory, databasePath, [...args, "--dry-run"]);
    if (discovery.status !== 0) return discovery;
    const recoveryPlanSha256 = JSON.parse(discovery.stdout).recoveryPlanSha256 as unknown;
    if (typeof recoveryPlanSha256 !== "string") return discovery;
    boundArgs = [...args, "--expected-recovery-plan-sha256", recoveryPlanSha256];
  }
  return spawnImporter(directory, databasePath, boundArgs);
}

function spawnImporter(directory: string, databasePath: string, args: string[]) {
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

function protectedOperationalState(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Object.fromEntries([
      "plex_items",
      "seerr_items",
      "requests",
      "request_audit",
      "request_creation_operations",
      "app_users",
      "user_sessions",
      "recommendation_sessions",
      "recommendation_results",
      "recommendation_feedback",
      "query_review_queue",
      "recommendation_candidate_provenance",
      "recommendation_rejections",
      "recommendation_impressions",
      "feel_feedback_events"
    ].map((table) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  } finally {
    database.close();
  }
}

function catalogRepairState(databasePath: string) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Object.fromEntries([
      "media_items",
      "external_ids",
      "catalog_source_records",
      "catalog_rank_signals",
      "catalog_sync_runs",
      "catalog_search_index",
      "media_features",
      "media_content_fingerprints"
    ].map((table) => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  } finally {
    database.close();
  }
}

function temporaryDirectory(prefix: string) {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  tempDirectories.push(directory);
  return directory;
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
