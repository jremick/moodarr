import { createReadStream, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { loadConfig } from "../src/server/config";
import { toCatalogIngestRecord, validateCatalogImportSafety, type WikidataCatalogRecord } from "../src/server/catalog/wikidataCatalogImporter";

interface Args {
  file?: string;
  version?: string;
  source?: string;
  mode: "incremental" | "full_snapshot";
  batchSize: number;
  limit?: number;
  dryRun: boolean;
}

const args = parseArgs(process.argv.slice(2));
if (!args.file || !args.version) {
  console.error(
    "Usage: npm run import:wikidata-catalog -- --file wikidata-catalog.jsonl[.gz] --version wikidata-2026-06-29 [--mode incremental|full-snapshot] [--batch-size 1000] [--limit 10000] [--dry-run]"
  );
  process.exit(1);
}
try {
  validateCatalogImportSafety(args.mode, args.limit);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const config = loadConfig();
const db = createDatabase(config.dbPath);
const repository = new MediaRepository(db);
const summary = await importCatalogFile(repository, { ...args, file: args.file, version: args.version });

console.log(JSON.stringify(summary, null, 2));

function parseArgs(values: string[]): Args {
  const parsed: Args = {
    mode: "incremental",
    batchSize: 1000,
    dryRun: false
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--file") parsed.file = values[++index];
    else if (value === "--version") parsed.version = values[++index];
    else if (value === "--source") parsed.source = values[++index];
    else if (value === "--mode") parsed.mode = parseMode(values[++index]);
    else if (value === "--batch-size") parsed.batchSize = Math.max(1, parsePositiveInteger(values[++index], parsed.batchSize));
    else if (value === "--limit") parsed.limit = parsePositiveInteger(values[++index], parsed.limit ?? 0);
    else if (value === "--dry-run") parsed.dryRun = true;
  }
  return parsed;
}

async function importCatalogFile(repository: MediaRepository, args: Required<Pick<Args, "file" | "version">> & Args) {
  const source = args.source ?? "wikidata";
  const skippedReasons: Record<string, number> = {};
  const batch = [];
  const activeSourceItemIds: string[] = [];
  let records = 0;
  let imported = 0;
  let mediaItemsUpserted = 0;
  let changedSourceRecords = 0;
  let unchangedSourceRecords = 0;
  let inactiveSourceRecords = 0;

  for await (const record of readCatalogRecords(args.file, args.limit)) {
    records += 1;
    const catalogRecord = toCatalogIngestRecord(record, { source, sourceVersion: args.version });
    if (catalogRecord.ok) {
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

  if (!args.dryRun && args.mode === "full_snapshot") {
    inactiveSourceRecords = repository.markCatalogRecordsInactiveExcept(source, args.version, activeSourceItemIds);
  }

  if (!args.dryRun) {
    repository.recordCatalogSync(source, args.version, "ok", {
      itemCount: records,
      mediaItemsUpserted,
      sourceRecordsUpserted: imported,
      updateMode: args.mode,
      changedSourceRecords,
      unchangedSourceRecords,
      inactiveSourceRecords
    });
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
    dryRun: args.dryRun,
    mode: args.mode,
    batchSize: args.batchSize,
    limit: args.limit
  };
}

function flushBatch(repository: MediaRepository, batch: Parameters<MediaRepository["upsertCatalogRecords"]>[0], dryRun: boolean) {
  if (batch.length === 0) return { mediaItemsUpserted: 0, changedSourceRecords: 0, unchangedSourceRecords: 0 };
  const result = dryRun
    ? { mediaItemIds: batch.map((record) => record.sourceItemId), inserted: batch.length, changed: 0, unchanged: 0 }
    : repository.upsertCatalogRecordsWithStats(batch);
  batch.splice(0, batch.length);
  return {
    mediaItemsUpserted: result.mediaItemIds.length,
    changedSourceRecords: result.inserted + result.changed,
    unchangedSourceRecords: result.unchanged
  };
}

async function* readCatalogRecords(file: string, limit: number | undefined): AsyncGenerator<WikidataCatalogRecord> {
  let count = 0;
  if (file.endsWith(".gz")) {
    for await (const record of readJsonlStream(file)) {
      yield record;
      count += 1;
      if (limit && count >= limit) return;
    }
    return;
  }

  for (const record of parseCatalogFile(readFileSync(file, "utf8"))) {
    yield record;
    count += 1;
    if (limit && count >= limit) return;
  }
}

async function* readJsonlStream(file: string): AsyncGenerator<WikidataCatalogRecord> {
  const stream = createReadStream(file).pipe(createGunzip());
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

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseMode(value: string | undefined): Args["mode"] {
  if (value === "full-snapshot" || value === "full_snapshot") return "full_snapshot";
  return "incremental";
}
