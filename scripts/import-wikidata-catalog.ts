import { createReadStream, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { createGunzip } from "node:zlib";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { loadConfig } from "../src/server/config";
import {
  assertCatalogFullSnapshotSourceCount,
  toCatalogIngestRecord,
  validateCatalogImportSafety,
  type WikidataCatalogRecord
} from "../src/server/catalog/wikidataCatalogImporter";
import { CatalogFileBinding, validateExpectedCatalogFileSha256 } from "./catalog-file-binding";

interface Args {
  file?: string;
  version?: string;
  source?: string;
  mode: "incremental" | "full_snapshot";
  batchSize: number;
  limit?: number;
  dryRun: boolean;
  rehydrateRequired: boolean;
  expectedRefreshRequired?: number;
  expectedSourceRecords?: number;
  expectedFileSha256?: string;
}

try {
  const args = parseArgs(process.argv.slice(2));
  validateCatalogImportSafety(args.mode, args.limit, args.rehydrateRequired, args.expectedRefreshRequired, args.expectedSourceRecords);
  validateExpectedCatalogFileSha256(args.mode, args.expectedFileSha256);
  if (!args.file || !args.version) throw new Error(usageMessage());
  const summary = await runImport({ ...args, file: args.file, version: args.version });
  console.log(JSON.stringify(summary, null, 2));
  if (!args.dryRun && summary.refreshRequiredRemaining > 0) {
    console.error("Trusted catalog refresh is incomplete. Re-run with an operator-approved file for every recorded source required by the pending catalog records.");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function usageMessage() {
  return "Usage: npm run import:wikidata-catalog -- --file wikidata-catalog.jsonl[.gz] --version wikidata-2026-06-29 [--source wikidata] [--mode incremental|full-snapshot --expected-source-records 90397 --expected-file-sha256 <lowercase-sha256>] [--rehydrate-required --expected-refresh-required 42] [--batch-size 1000] [--limit 10000] [--dry-run]";
}

async function runImport(args: Required<Pick<Args, "file" | "version">> & Args) {
  let fullSnapshotInput: CatalogFileBinding | undefined;
  try {
    if (args.mode === "full_snapshot") {
      fullSnapshotInput = await CatalogFileBinding.open(args.file, args.expectedFileSha256!);
      await fullSnapshotInput.verifyBeforePreflight();
      await preflightFullSnapshotFile(args, fullSnapshotInput);
    }

    const recoveryDbPath = args.rehydrateRequired ? recoveryDatabasePath() : undefined;
    if (args.rehydrateRequired) {
      assertRecoveryDatabaseReady(recoveryDbPath!, args.source ?? "wikidata", args.expectedRefreshRequired!);
    }
    if (args.dryRun) {
      const readOnlyDb = recoveryDbPath ? new DatabaseSync(recoveryDbPath, { readOnly: true }) : undefined;
      try {
        const repository = readOnlyDb ? new MediaRepository(readOnlyDb, { runStartupRepairs: false }) : undefined;
        return await importAndVerify(repository, args, fullSnapshotInput);
      } finally {
        readOnlyDb?.close();
      }
    }

    const dbPath = recoveryDbPath ?? loadConfig().dbPath;
    const db = createDatabase(dbPath);
    try {
      const repository = new MediaRepository(db, {
        runStartupRepairs: !args.rehydrateRequired && args.mode !== "full_snapshot"
      });
      if (args.mode === "full_snapshot") {
        return await repository.withCatalogSnapshotTransaction(() => importAndVerify(repository, args, fullSnapshotInput));
      }
      return await importAndVerify(repository, args, fullSnapshotInput);
    } finally {
      db.close();
    }
  } finally {
    await fullSnapshotInput?.close();
  }
}

async function importAndVerify(
  repository: MediaRepository | undefined,
  args: Required<Pick<Args, "file" | "version">> & Args,
  fullSnapshotInput: CatalogFileBinding | undefined
) {
  const summary = await importCatalogFile(repository, args, fullSnapshotInput);
  if (!fullSnapshotInput) return summary;
  const fileSha256 = await fullSnapshotInput.verifyAfterWritePass();
  return { ...summary, fileSha256 };
}

function parseArgs(values: string[]): Args {
  const parsed: Args = {
    mode: "incremental",
    batchSize: 1000,
    dryRun: false,
    rehydrateRequired: false
  };
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (seen.has(value)) throw new Error(`Duplicate catalog-import argument: ${value}`);
    seen.add(value);
    if (value === "--file") parsed.file = optionValue(values, ++index, value);
    else if (value === "--version") parsed.version = optionValue(values, ++index, value);
    else if (value === "--source") parsed.source = optionValue(values, ++index, value);
    else if (value === "--mode") parsed.mode = parseMode(optionValue(values, ++index, value));
    else if (value === "--batch-size") parsed.batchSize = parsePositiveInteger(optionValue(values, ++index, value), value);
    else if (value === "--limit") parsed.limit = parsePositiveInteger(optionValue(values, ++index, value), value);
    else if (value === "--dry-run") parsed.dryRun = true;
    else if (value === "--rehydrate-required") parsed.rehydrateRequired = true;
    else if (value === "--expected-refresh-required") {
      parsed.expectedRefreshRequired = parsePositiveInteger(optionValue(values, ++index, value), value);
    } else if (value === "--expected-source-records") {
      parsed.expectedSourceRecords = parsePositiveInteger(optionValue(values, ++index, value), value);
    } else if (value === "--expected-file-sha256") {
      parsed.expectedFileSha256 = optionValue(values, ++index, value);
    } else {
      throw new Error(`Unknown catalog-import argument: ${value}`);
    }
  }
  return parsed;
}

async function importCatalogFile(
  repository: MediaRepository | undefined,
  args: Required<Pick<Args, "file" | "version">> & Args,
  fullSnapshotInput?: CatalogFileBinding
) {
  if (!args.dryRun && !repository) throw new Error("Catalog import repository is unavailable.");
  const source = args.source ?? "wikidata";
  const refreshRequirement = args.rehydrateRequired ? repository!.catalogRefreshRequirement(source) : undefined;
  const refreshRequiredIds = refreshRequirement?.sourceItemIds;
  const refreshRequiredBefore = refreshRequirement?.mediaItemCount ?? 0;
  const refreshRequiredSourceRecordsBefore = refreshRequiredIds?.size ?? 0;
  if (args.rehydrateRequired && refreshRequiredBefore !== args.expectedRefreshRequired) {
    throw new Error(
      `Trusted catalog refresh preflight expected ${args.expectedRefreshRequired} catalog items but found ${refreshRequiredBefore}. Verify the stopped data mount, recorded source, and Admin count before retrying.`
    );
  }
  const skippedReasons: Record<string, number> = {};
  const batch = [];
  const activeSourceItemIds: string[] = [];
  let records = 0;
  let imported = 0;
  let mediaItemsUpserted = 0;
  let changedSourceRecords = 0;
  let unchangedSourceRecords = 0;
  let inactiveSourceRecords = 0;
  let ignoredNotRequired = 0;

  for await (const record of readCatalogRecords(args.file, args.limit, fullSnapshotInput)) {
    records += 1;
    const catalogRecord = toCatalogIngestRecord(record, { source, sourceVersion: args.version });
    if (catalogRecord.ok) {
      if (refreshRequiredIds && !refreshRequiredIds.has(catalogRecord.record.sourceItemId)) {
        ignoredNotRequired += 1;
        continue;
      }
      batch.push(catalogRecord.record);
      activeSourceItemIds.push(catalogRecord.record.sourceItemId);
      imported += 1;
      if (batch.length >= args.batchSize) {
        const flushed = flushBatch(repository, batch, args.dryRun);
        mediaItemsUpserted += flushed.mediaItemsUpserted;
        changedSourceRecords += flushed.changedSourceRecords;
        unchangedSourceRecords += flushed.unchangedSourceRecords;
      }
    } else {
      skippedReasons[catalogRecord.reason] = (skippedReasons[catalogRecord.reason] ?? 0) + 1;
    }
  }
  const flushed = flushBatch(repository, batch, args.dryRun);
  mediaItemsUpserted += flushed.mediaItemsUpserted;
  changedSourceRecords += flushed.changedSourceRecords;
  unchangedSourceRecords += flushed.unchangedSourceRecords;

  const uniqueImportableSourceRecords = assertCatalogFullSnapshotSourceCount(args.mode, args.expectedSourceRecords, activeSourceItemIds);
  if (!args.dryRun && args.mode === "full_snapshot") {
    inactiveSourceRecords = repository!.markCatalogRecordsInactiveExcept(source, args.version, [...new Set(activeSourceItemIds)]);
  }

  const remainingRefreshRequirement = args.rehydrateRequired && !args.dryRun ? repository!.catalogRefreshRequirement(source) : refreshRequirement;
  const refreshRequiredRemaining = remainingRefreshRequirement?.mediaItemCount ?? 0;
  const refreshRequiredSourceRecordsRemaining = remainingRefreshRequirement?.sourceItemIds.size ?? 0;

  if (!args.dryRun) {
    const refreshIncomplete = args.rehydrateRequired && refreshRequiredRemaining > 0;
    repository!.recordCatalogSync(source, args.version, refreshIncomplete ? "failed" : "ok", {
      itemCount: records,
      mediaItemsUpserted,
      sourceRecordsUpserted: imported,
      updateMode: args.mode,
      changedSourceRecords,
      unchangedSourceRecords,
      inactiveSourceRecords
    }, refreshIncomplete ? "trusted catalog refresh incomplete" : undefined);
  }

  return {
    source,
    sourceVersion: args.version,
    records,
    imported,
    skipped: records - imported,
    mediaItemsUpserted,
    sourceRecordsUpserted: imported,
    changedSourceRecords,
    unchangedSourceRecords,
    inactiveSourceRecords,
    skippedReasons,
    ignoredNotRequired,
    dryRun: args.dryRun,
    rehydrateRequired: args.rehydrateRequired,
    expectedRefreshRequired: args.expectedRefreshRequired,
    expectedSourceRecords: args.expectedSourceRecords,
    expectedFileSha256: args.expectedFileSha256,
    uniqueImportableSourceRecords,
    refreshRequiredBefore,
    refreshRequiredSourceRecordsBefore,
    refreshRequiredRemaining,
    refreshRequiredSourceRecordsRemaining,
    mode: args.mode,
    batchSize: args.batchSize,
    limit: args.limit
  };
}

async function preflightFullSnapshotFile(
  args: Required<Pick<Args, "file" | "version">> & Args,
  fullSnapshotInput: CatalogFileBinding
) {
  const source = args.source ?? "wikidata";
  const sourceItemIds = new Set<string>();
  for await (const record of readCatalogRecords(args.file, undefined, fullSnapshotInput)) {
    const catalogRecord = toCatalogIngestRecord(record, { source, sourceVersion: args.version });
    if (catalogRecord.ok) sourceItemIds.add(catalogRecord.record.sourceItemId);
  }
  try {
    return assertCatalogFullSnapshotSourceCount(args.mode, args.expectedSourceRecords, sourceItemIds);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message} No catalog source records were inserted or updated.`);
  }
}

function flushBatch(repository: MediaRepository | undefined, batch: Parameters<MediaRepository["upsertCatalogRecords"]>[0], dryRun: boolean) {
  if (batch.length === 0) return { mediaItemsUpserted: 0, changedSourceRecords: 0, unchangedSourceRecords: 0 };
  const result = dryRun
    ? { mediaItemIds: batch.map((record) => record.sourceItemId), inserted: batch.length, changed: 0, unchanged: 0 }
    : repository!.upsertCatalogRecordsWithStats(batch);
  batch.splice(0, batch.length);
  return {
    mediaItemsUpserted: result.mediaItemIds.length,
    changedSourceRecords: result.inserted + result.changed,
    unchangedSourceRecords: result.unchanged
  };
}

async function* readCatalogRecords(
  file: string,
  limit: number | undefined,
  fullSnapshotInput?: CatalogFileBinding
): AsyncGenerator<WikidataCatalogRecord> {
  let count = 0;
  if (file.endsWith(".gz") || file.endsWith(".jsonl")) {
    for await (const record of readJsonlStream(file, file.endsWith(".gz"), fullSnapshotInput)) {
      yield record;
      count += 1;
      if (limit && count >= limit) return;
    }
    return;
  }

  const contents = fullSnapshotInput ? await fullSnapshotInput.readUtf8() : readFileSync(file, "utf8");
  for (const record of parseCatalogFile(contents)) {
    yield record;
    count += 1;
    if (limit && count >= limit) return;
  }
}

async function* readJsonlStream(
  file: string,
  compressed: boolean,
  fullSnapshotInput?: CatalogFileBinding
): AsyncGenerator<WikidataCatalogRecord> {
  const fileStream = fullSnapshotInput?.createReadStream() ?? createReadStream(file);
  const stream = compressed ? fileStream.pipe(createGunzip()) : fileStream;
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) yield JSON.parse(trimmed) as WikidataCatalogRecord;
  }
}

function parseCatalogFile(value: string): WikidataCatalogRecord[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) return JSON.parse(trimmed) as WikidataCatalogRecord[];
  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as WikidataCatalogRecord);
}

function optionValue(values: string[], index: number, option: string) {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value.`);
  return value;
}

function parsePositiveInteger(value: string, option: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${option} requires a positive integer.`);
  return parsed;
}

function parseMode(value: string): Args["mode"] {
  if (value === "incremental") return "incremental";
  if (value === "full-snapshot" || value === "full_snapshot") return "full_snapshot";
  throw new Error("--mode must be incremental or full-snapshot.");
}

function recoveryDatabasePath(env: NodeJS.ProcessEnv = process.env) {
  const explicit = env.MOODARR_DB_PATH?.trim();
  if (explicit) return resolve(explicit);
  const dataDir = env.MOODARR_DATA_DIR?.trim() || ".data";
  return resolve(dataDir, "moodarr.sqlite");
}

function assertRecoveryDatabaseReady(dbPath: string, source: string, expectedRefreshRequired: number) {
  if (!dbPath || dbPath === ":memory:" || !existsSync(dbPath)) {
    throw new Error("Trusted catalog refresh requires an existing stopped Moodarr database; verify the /data mount before retrying.");
  }
  let inspection: DatabaseSync | undefined;
  let refreshRequired = -1;
  try {
    inspection = new DatabaseSync(dbPath, { readOnly: true });
    const schemaVersion = Number((inspection.prepare("PRAGMA user_version").get() as { user_version?: number }).user_version ?? 0);
    const boundaryMigration = inspection.prepare("SELECT 1 AS value FROM schema_migrations WHERE id = '029_strict_tmdb_content_boundary'").get();
    const retrievalMigration = inspection.prepare("SELECT 1 AS value FROM schema_migrations WHERE id = '030_retrieval_performance_indexes'").get();
    const identityQuarantineMigration = inspection.prepare("SELECT 1 AS value FROM schema_migrations WHERE id = '031_integration_identity_quarantine'").get();
    const columns = inspection.prepare("PRAGMA table_info(catalog_source_records)").all() as Array<{ name?: string }>;
    if (
      schemaVersion !== 31
      || !boundaryMigration
      || !retrievalMigration
      || !identityQuarantineMigration
      || !columns.some((column) => column.name === "materialization_stale")
    ) {
      throw new Error("candidate schema not ready");
    }
    refreshRequired = new MediaRepository(inspection, { runStartupRepairs: false }).catalogRefreshRequirement(source).mediaItemCount;
  } catch {
    throw new Error("Trusted catalog refresh requires a stopped database that has completed the beta.1 schema-31 migrations.");
  } finally {
    inspection?.close();
  }
  if (refreshRequired !== expectedRefreshRequired) {
    throw new Error(
      `Trusted catalog refresh preflight expected ${expectedRefreshRequired} catalog items but found ${refreshRequired}. Verify the stopped data mount, recorded source, and Admin count before retrying.`
    );
  }
}
