import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import { createGunzip } from "node:zlib";
import type { MediaSource, MediaType } from "../src/shared/types";
import { createDatabase } from "../src/server/db/database";
import {
  MediaRepository,
  type CatalogExternalId,
  type CatalogIngestRecord,
  type TrustedCatalogTypeRepairPlan
} from "../src/server/db/mediaRepository";
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
  expectedRefreshSourceRecords?: number;
  expectedSourceRecords?: number;
  expectedFileSha256?: string;
  expectedTypeRepairs?: number;
  expectedRecoverySourceRecords?: number;
  expectedRecoveryPlanSha256?: string;
}

interface TrustedRehydratePlan {
  inputSourceRecordsValidated: number;
  recoveryPlanSha256: string;
  typeRepairs: ReadonlyMap<string, TrustedCatalogTypeRepairPlan>;
  affectedOldMediaItemIds: ReadonlySet<string>;
  affectedBindings: ReadonlyMap<string, { mediaItemId: string; mediaType: MediaType }>;
  expectedRecoveryBindings: ReadonlyMap<string, {
    mediaItemId: string;
    mediaType: MediaType;
    mediaSource: MediaSource;
    payloadHash: string;
  }>;
  rematerializeSourceItemIds: ReadonlySet<string>;
  recoverySourceItemIds: ReadonlySet<string>;
  externalIdCleanupCount: number;
}

const strongCatalogExternalIdSources = new Set(["tmdb", "imdb", "tvdb"]);

try {
  const args = parseArgs(process.argv.slice(2));
  validateCatalogImportSafety(args.mode, args.limit, args.rehydrateRequired, args.expectedRefreshRequired, args.expectedSourceRecords);
  validateExpectedCatalogFileSha256(args.mode, args.expectedFileSha256, args.rehydrateRequired);
  validateTrustedRehydrateExpectations(args);
  if (!args.file || !args.version) throw new Error(usageMessage());
  const summary = await runImport({ ...args, file: args.file, version: args.version });
  console.log(JSON.stringify(summary, null, 2));
  if (!args.dryRun && (summary.refreshRequiredRemaining > 0 || summary.typeRepairSourceRecordsRemaining > 0)) {
    console.error("Trusted catalog refresh is incomplete. Re-run with an operator-approved file for every recorded source required by the pending catalog records.");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

function usageMessage() {
  return "Usage: npm run import:wikidata-catalog -- --file wikidata-catalog.jsonl[.gz] --version wikidata-2026-06-29 [--source wikidata] [--mode incremental|full-snapshot --expected-source-records 90397 --expected-file-sha256 <lowercase-sha256>] [--rehydrate-required --expected-refresh-required 3611 --expected-refresh-source-records 3925 --expected-source-records 90397 --expected-type-repairs 3937 --expected-recovery-source-records 11191 --expected-recovery-plan-sha256 <lowercase-sha256> --expected-file-sha256 <lowercase-sha256>] [--batch-size 1000] [--dry-run]";
}

async function runImport(args: Required<Pick<Args, "file" | "version">> & Args) {
  let catalogInput: CatalogFileBinding | undefined;
  try {
    if (args.mode === "full_snapshot" || args.rehydrateRequired) {
      catalogInput = await CatalogFileBinding.open(args.file, args.expectedFileSha256!);
      await catalogInput.verifyBeforePreflight();
    }
    if (args.mode === "full_snapshot") {
      await preflightFullSnapshotFile(args, catalogInput!);
    }

    const recoveryDbPath = args.rehydrateRequired ? recoveryDatabasePath() : undefined;
    if (args.rehydrateRequired) {
      assertRecoveryDatabaseReady(recoveryDbPath!, args.source ?? "wikidata", args.expectedRefreshRequired!);
    }
    if (args.dryRun) {
      const readOnlyDb = recoveryDbPath ? new DatabaseSync(recoveryDbPath, { readOnly: true }) : undefined;
      try {
        const repository = readOnlyDb ? new MediaRepository(readOnlyDb, { runStartupRepairs: false }) : undefined;
        const rehydratePlan = args.rehydrateRequired ? await preflightTrustedRehydrateFile(repository!, args, catalogInput!) : undefined;
        return await importAndVerify(repository, args, catalogInput, rehydratePlan);
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
      if (args.mode === "full_snapshot" || args.rehydrateRequired) {
        return await repository.withCatalogSnapshotTransaction(async () => {
          const rehydratePlan = args.rehydrateRequired ? await preflightTrustedRehydrateFile(repository, args, catalogInput!) : undefined;
          return importAndVerify(repository, args, catalogInput, rehydratePlan);
        });
      }
      return await importAndVerify(repository, args, catalogInput);
    } finally {
      db.close();
    }
  } finally {
    await catalogInput?.close();
  }
}

async function importAndVerify(
  repository: MediaRepository | undefined,
  args: Required<Pick<Args, "file" | "version">> & Args,
  catalogInput: CatalogFileBinding | undefined,
  rehydratePlan?: TrustedRehydratePlan
) {
  const summary = await importCatalogFile(repository, args, catalogInput, rehydratePlan);
  if (!catalogInput) return summary;
  const fileSha256 = await catalogInput.verifyAfterWritePass();
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
      parsed.expectedRefreshRequired = parseNonNegativeInteger(optionValue(values, ++index, value), value);
    } else if (value === "--expected-refresh-source-records") {
      parsed.expectedRefreshSourceRecords = parseNonNegativeInteger(optionValue(values, ++index, value), value);
    } else if (value === "--expected-source-records") {
      parsed.expectedSourceRecords = parsePositiveInteger(optionValue(values, ++index, value), value);
    } else if (value === "--expected-file-sha256") {
      parsed.expectedFileSha256 = optionValue(values, ++index, value);
    } else if (value === "--expected-type-repairs") {
      parsed.expectedTypeRepairs = parseNonNegativeInteger(optionValue(values, ++index, value), value);
    } else if (value === "--expected-recovery-source-records") {
      parsed.expectedRecoverySourceRecords = parsePositiveInteger(optionValue(values, ++index, value), value);
    } else if (value === "--expected-recovery-plan-sha256") {
      parsed.expectedRecoveryPlanSha256 = optionValue(values, ++index, value);
    } else {
      throw new Error(`Unknown catalog-import argument: ${value}`);
    }
  }
  return parsed;
}

function validateTrustedRehydrateExpectations(args: Args) {
  if (args.rehydrateRequired) {
    if ((args.source ?? "wikidata").trim().toLowerCase() !== "wikidata") {
      throw new Error("--rehydrate-required only supports the Wikidata source used by the beta.1 trusted-recovery contract.");
    }
    if (!args.dryRun && args.expectedRefreshSourceRecords === undefined) {
      throw new Error("--rehydrate-required writes require --expected-refresh-source-records with the exact nonnegative source-record count shown by the read-only preflight.");
    }
    if (!args.dryRun && args.expectedTypeRepairs === undefined) {
      throw new Error("--rehydrate-required requires --expected-type-repairs with the exact nonnegative read-only preflight count.");
    }
    if (!args.dryRun && args.expectedRecoverySourceRecords === undefined) {
      throw new Error("--rehydrate-required requires --expected-recovery-source-records with the exact positive read-only preflight count.");
    }
    if (!args.dryRun && !args.expectedRecoveryPlanSha256) {
      throw new Error("--rehydrate-required writes require --expected-recovery-plan-sha256 from the matching read-only preflight.");
    }
    if (args.expectedRecoveryPlanSha256 !== undefined && !/^[0-9a-f]{64}$/.test(args.expectedRecoveryPlanSha256)) {
      throw new Error("--expected-recovery-plan-sha256 requires exact lowercase 64-character SHA-256 text.");
    }
    return;
  }
  if (
    args.expectedRefreshSourceRecords !== undefined
    || args.expectedTypeRepairs !== undefined
    || args.expectedRecoverySourceRecords !== undefined
    || args.expectedRecoveryPlanSha256 !== undefined
  ) {
    throw new Error("Trusted recovery expectations can only be used with --rehydrate-required.");
  }
}

async function importCatalogFile(
  repository: MediaRepository | undefined,
  args: Required<Pick<Args, "file" | "version">> & Args,
  catalogInput?: CatalogFileBinding,
  rehydratePlan?: TrustedRehydratePlan
) {
  if (!args.dryRun && !repository) throw new Error("Catalog import repository is unavailable.");
  const source = args.source ?? "wikidata";
  const refreshRequirement = args.rehydrateRequired ? repository!.catalogRefreshRequirement(source) : undefined;
  const refreshRequiredIds = refreshRequirement?.sourceItemIds;
  const recoverySourceItemIds = rehydratePlan?.recoverySourceItemIds;
  const refreshRequiredBefore = refreshRequirement?.mediaItemCount ?? 0;
  const refreshRequiredSourceRecordsBefore = refreshRequiredIds?.size ?? 0;
  if (args.rehydrateRequired && refreshRequiredBefore !== args.expectedRefreshRequired) {
    throw new Error(
      `Trusted catalog refresh preflight expected ${args.expectedRefreshRequired} catalog items but found ${refreshRequiredBefore}. Verify the stopped data mount, recorded source, and Admin count before retrying.`
    );
  }
  if (
    args.rehydrateRequired
    && args.expectedRefreshSourceRecords !== undefined
    && refreshRequiredSourceRecordsBefore !== args.expectedRefreshSourceRecords
  ) {
    throw new Error(
      `Trusted catalog refresh expected ${args.expectedRefreshSourceRecords} source records but found ${refreshRequiredSourceRecordsBefore}. Verify the stopped data mount and read-only preflight before retrying.`
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
  let typeRepairSourceRecordsRebound = 0;

  for await (const record of readCatalogRecords(args.file, args.limit, catalogInput)) {
    records += 1;
    const catalogRecord = toCatalogIngestRecord(record, { source, sourceVersion: args.version });
    if (catalogRecord.ok) {
      if (
        recoverySourceItemIds
        && !recoverySourceItemIds.has(catalogRecord.record.sourceItemId)
      ) {
        ignoredNotRequired += 1;
        continue;
      }
      batch.push(catalogRecord.record);
      activeSourceItemIds.push(catalogRecord.record.sourceItemId);
      imported += 1;
      if (batch.length >= args.batchSize) {
        const flushed = flushBatch(repository, batch, args.dryRun, rehydratePlan);
        mediaItemsUpserted += flushed.mediaItemsUpserted;
        changedSourceRecords += flushed.changedSourceRecords;
        unchangedSourceRecords += flushed.unchangedSourceRecords;
        typeRepairSourceRecordsRebound += flushed.typeRepairSourceRecordsRebound;
      }
    } else {
      skippedReasons[catalogRecord.reason] = (skippedReasons[catalogRecord.reason] ?? 0) + 1;
    }
  }
  const flushed = flushBatch(repository, batch, args.dryRun, rehydratePlan);
  mediaItemsUpserted += flushed.mediaItemsUpserted;
  changedSourceRecords += flushed.changedSourceRecords;
  unchangedSourceRecords += flushed.unchangedSourceRecords;
  typeRepairSourceRecordsRebound += flushed.typeRepairSourceRecordsRebound;

  const uniqueImportableSourceRecords = rehydratePlan?.inputSourceRecordsValidated
    ?? assertCatalogFullSnapshotSourceCount(args.mode, args.expectedSourceRecords, activeSourceItemIds);
  if (!args.dryRun && args.mode === "full_snapshot") {
    inactiveSourceRecords = repository!.markCatalogRecordsInactiveExcept(source, args.version, [...new Set(activeSourceItemIds)]);
  }

  const remainingRefreshRequirement = args.rehydrateRequired && !args.dryRun ? repository!.catalogRefreshRequirement(source) : refreshRequirement;
  const refreshRequiredRemaining = remainingRefreshRequirement?.mediaItemCount ?? 0;
  const refreshRequiredSourceRecordsRemaining = remainingRefreshRequirement?.sourceItemIds.size ?? 0;
  const remainingTypeBindings = rehydratePlan && !args.dryRun ? repository!.activeCatalogSourceTypeBindings(source) : undefined;
  const typeRepairSourceRecordsRemaining = rehydratePlan
    ? [...rehydratePlan.typeRepairs].filter(([sourceItemId, repair]) => {
        const binding = remainingTypeBindings?.get(sourceItemId);
        return binding?.mediaItemId !== repair.targetMediaItemId || binding?.mediaType !== repair.targetMediaType;
      }).length
    : 0;
  const typeRepairAffectedBindingsRemaining = rehydratePlan
    ? [...rehydratePlan.affectedBindings].filter(([sourceItemId, expected]) => {
        const binding = remainingTypeBindings?.get(sourceItemId);
        return binding?.mediaItemId !== expected.mediaItemId || binding.mediaType !== expected.mediaType;
      }).length
    : 0;
  const recoverySourceRecordsRemaining = rehydratePlan && !args.dryRun
    ? [...rehydratePlan.expectedRecoveryBindings].filter(([sourceItemId, expected]) => {
        const binding = remainingTypeBindings?.get(sourceItemId);
        return binding?.mediaItemId !== expected.mediaItemId
          || binding.mediaType !== expected.mediaType
          || binding.sourceVersion !== args.version
          || binding.lastSeenSourceVersion !== args.version
          || binding.payloadHash !== expected.payloadHash
          || binding.contentHash !== expected.payloadHash
          || binding.mediaSource !== expected.mediaSource
          || binding.sourceIdentityExternalIdBound !== true;
      }).length
    : 0;
  const recoveredMediaItemIds = rehydratePlan && remainingTypeBindings
    ? [...rehydratePlan.recoverySourceItemIds].flatMap((sourceItemId) => {
        const mediaItemId = remainingTypeBindings.get(sourceItemId)?.mediaItemId;
        return mediaItemId ? [mediaItemId] : [];
      })
    : [];
  const recoveryDerivedItemsRemaining = rehydratePlan && !args.dryRun
    ? repository!.catalogDerivedMaterializationIssueCount([
        ...rehydratePlan.affectedOldMediaItemIds,
        ...recoveredMediaItemIds
      ])
    : 0;
  const typeRepairDerivedItemsRemaining = recoveryDerivedItemsRemaining;
  const typeRepairExternalIdsPlanned = rehydratePlan?.externalIdCleanupCount ?? 0;
  // Every planned deletion is guarded by an exact owner/type/value CAS in the
  // repository. Any missed deletion throws and rolls back the recovery transaction.
  const typeRepairExternalIdsRemoved = args.dryRun ? 0 : typeRepairExternalIdsPlanned;
  const recoveryAppliedCountMatches = !rehydratePlan
    || (imported === rehydratePlan.recoverySourceItemIds.size
      && typeRepairSourceRecordsRebound === rehydratePlan.typeRepairs.size
      && typeRepairExternalIdsRemoved === typeRepairExternalIdsPlanned);

  if (
    args.rehydrateRequired
    && !args.dryRun
    && (
      refreshRequiredRemaining > 0
      || typeRepairSourceRecordsRemaining > 0
      || typeRepairAffectedBindingsRemaining > 0
      || recoverySourceRecordsRemaining > 0
      || recoveryDerivedItemsRemaining > 0
      || !recoveryAppliedCountMatches
    )
  ) {
    throw new Error(
      "Trusted catalog recovery verification failed; every recovery write was rolled back "
      + `(refreshItems=${refreshRequiredRemaining}, refreshSources=${refreshRequiredSourceRecordsRemaining}, `
      + `repairSources=${typeRepairSourceRecordsRemaining}, affectedBindings=${typeRepairAffectedBindingsRemaining}, `
      + `recoverySources=${recoverySourceRecordsRemaining}, derivedItems=${recoveryDerivedItemsRemaining}, `
      + `appliedCountsMatch=${recoveryAppliedCountMatches}).`
    );
  }

  if (!args.dryRun) {
    repository!.recordCatalogSync(source, args.version, "ok", {
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
    recoverySourceRecordsSelected: rehydratePlan ? imported : undefined,
    recoverySourceRecordsImported: rehydratePlan ? (args.dryRun ? 0 : imported) : undefined,
    changedSourceRecords,
    unchangedSourceRecords,
    inactiveSourceRecords,
    skippedReasons,
    ignoredNotRequired,
    dryRun: args.dryRun,
    rehydrateRequired: args.rehydrateRequired,
    expectedRefreshRequired: args.expectedRefreshRequired,
    expectedRefreshSourceRecords: args.expectedRefreshSourceRecords,
    expectedSourceRecords: args.expectedSourceRecords,
    expectedFileSha256: args.expectedFileSha256,
    expectedTypeRepairs: args.expectedTypeRepairs,
    expectedRecoverySourceRecords: args.expectedRecoverySourceRecords,
    expectedRecoveryPlanSha256: args.expectedRecoveryPlanSha256,
    recoveryPlanSha256: rehydratePlan?.recoveryPlanSha256,
    uniqueImportableSourceRecords,
    refreshRequiredBefore,
    refreshRequiredSourceRecordsBefore,
    refreshRequiredRemaining,
    refreshRequiredSourceRecordsRemaining,
    typeRepairSourceRecordsBefore: rehydratePlan?.typeRepairs.size ?? 0,
    typeRepairSourceRecordsRebound,
    typeRepairSourceRecordsRemaining,
    typeRepairAffectedMediaItemsBefore: rehydratePlan?.affectedOldMediaItemIds.size ?? 0,
    typeRepairAffectedSourceRecordsBefore: rehydratePlan?.affectedBindings.size ?? 0,
    typeRepairAffectedBindingsRemaining,
    typeRepairExternalIdsPlanned,
    typeRepairExternalIdsRemoved,
    typeRepairDerivedItemsRemaining,
    recoveryDerivedItemsRemaining,
    recoverySourceRecordsPlanned: rehydratePlan?.recoverySourceItemIds.size ?? 0,
    recoverySourceRecordsRemaining,
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

async function preflightTrustedRehydrateFile(
  repository: MediaRepository,
  args: Required<Pick<Args, "file" | "version">> & Args,
  catalogInput: CatalogFileBinding
): Promise<TrustedRehydratePlan> {
  const source = args.source ?? "wikidata";
  const refreshRequirement = repository.catalogRefreshRequirement(source);
  if (refreshRequirement.mediaItemCount !== args.expectedRefreshRequired) {
    throw new Error(
      `Trusted catalog refresh preflight expected ${args.expectedRefreshRequired} catalog items but found ${refreshRequirement.mediaItemCount}. Verify the stopped data mount, recorded source, and Admin count before retrying.`
    );
  }
  if (
    args.expectedRefreshSourceRecords !== undefined
    && refreshRequirement.sourceItemIds.size !== args.expectedRefreshSourceRecords
  ) {
    throw new Error(
      `Trusted catalog refresh preflight expected ${args.expectedRefreshSourceRecords} source records but found ${refreshRequirement.sourceItemIds.size}; no database changes were made.`
    );
  }
  const activeBindings = repository.activeCatalogSourceTypeBindings(source);
  const foundRefreshIds = new Set<string>();
  const inputRecords = new Map<string, CatalogIngestRecord>();
  for await (const record of readCatalogRecords(args.file, undefined, catalogInput)) {
    const catalogRecord = toCatalogIngestRecord(record, { source, sourceVersion: args.version });
    if (!catalogRecord.ok) continue;
    const sourceItemId = catalogRecord.record.sourceItemId;
    if (inputRecords.has(sourceItemId)) {
      throw new Error(`Trusted catalog recovery contains duplicate source identity ${sourceItemId}; no database changes were made.`);
    }
    inputRecords.set(sourceItemId, catalogRecord.record);
    if (refreshRequirement.sourceItemIds.has(sourceItemId)) foundRefreshIds.add(sourceItemId);
  }
  if (inputRecords.size !== args.expectedSourceRecords) {
    throw new Error(
      `Trusted catalog recovery expected ${args.expectedSourceRecords} unique importable source records but found ${inputRecords.size}; no database changes were made.`
    );
  }
  const missingRefreshIds = [...refreshRequirement.sourceItemIds].filter((sourceItemId) => !foundRefreshIds.has(sourceItemId));
  if (missingRefreshIds.length > 0) {
    throw new Error(
      `Trusted catalog recovery is missing ${missingRefreshIds.length} required source identities from the operator-approved asset; no database changes were made.`
    );
  }

  const preliminaryRepairs = new Map<string, Omit<TrustedCatalogTypeRepairPlan, "targetAction" | "externalIdCleanup"> & {
    targetExisted: boolean;
  }>();
  const affectedOldMediaItemIds = new Set<string>();
  for (const [sourceItemId, catalogRecord] of inputRecords) {
    const binding = activeBindings.get(sourceItemId);
    if (!binding || binding.mediaType === catalogRecord.media.mediaType) continue;
    if (
      source !== "wikidata"
      || !binding.sourceIdentityExternalIdBound
      || !binding.contentHash
      || binding.contentHash !== catalogRecord.payloadHash
      || catalogRecord.media.externalIds?.wikidata !== sourceItemId
    ) {
      throw new Error(`Catalog source identity ${sourceItemId} cannot be safely repaired from this trusted asset; no database changes were made.`);
    }
    const target = repository.catalogTypeRepairTarget(catalogRecord);
    preliminaryRepairs.set(sourceItemId, {
      sourceItemId,
      expectedOldMediaItemId: binding.mediaItemId,
      expectedOldMediaType: binding.mediaType,
      expectedOldSourceVersion: binding.sourceVersion,
      expectedOldLastSeenSourceVersion: binding.lastSeenSourceVersion,
      expectedOldPayloadHash: binding.payloadHash,
      expectedContentHash: binding.contentHash,
      targetMediaItemId: target.mediaItemId,
      targetMediaType: catalogRecord.media.mediaType,
      expectedTargetMediaSource: target.mediaSource,
      expectedTargetExternalIds: target.externalIds,
      targetExisted: target.existed
    });
    affectedOldMediaItemIds.add(binding.mediaItemId);
  }
  if (args.expectedTypeRepairs !== undefined && preliminaryRepairs.size !== args.expectedTypeRepairs) {
    throw new Error(
      `Trusted catalog recovery expected ${args.expectedTypeRepairs} type repairs but found ${preliminaryRepairs.size}; no database changes were made.`
    );
  }
  const externalIdentityTargets = new Map<string, string>();
  const strongIdentitiesByTarget = new Map<string, string>();
  const repairSourceByTarget = new Map<string, string>();
  for (const [sourceItemId, repair] of preliminaryRepairs) {
    const existingSourceItemId = repairSourceByTarget.get(repair.targetMediaItemId);
    if (existingSourceItemId && existingSourceItemId !== sourceItemId) {
      throw new Error("Trusted catalog recovery cannot converge distinct source identities on one repair target; no database changes were made.");
    }
    repairSourceByTarget.set(repair.targetMediaItemId, sourceItemId);
    for (const externalId of catalogExternalIds(inputRecords.get(sourceItemId)!)) {
      if (externalId.source !== "wikidata") {
        const identityKey = externalIdKey({
          source: `${repair.targetMediaType}:${externalId.source}`,
          value: externalId.value
        });
        const existingTarget = externalIdentityTargets.get(identityKey);
        if (existingTarget && existingTarget !== repair.targetMediaItemId) {
          throw new Error("Trusted catalog recovery maps one external media identity to multiple repair targets; no database changes were made.");
        }
        externalIdentityTargets.set(identityKey, repair.targetMediaItemId);
      }
      if (!strongCatalogExternalIdSources.has(externalId.source)) continue;
      const targetSourceKey = externalIdKey({
        source: `${repair.targetMediaType}:${repair.targetMediaItemId}:${externalId.source}`,
        value: "claim"
      });
      const existingValue = strongIdentitiesByTarget.get(targetSourceKey);
      if (existingValue && existingValue !== externalId.value) {
        throw new Error(`Trusted catalog recovery maps conflicting strong media identities to one repair target; no database changes were made.`);
      }
      strongIdentitiesByTarget.set(targetSourceKey, externalId.value);
    }
  }

  const affectedBindingInputs = new Map<string, { mediaItemId: string; mediaType: MediaType }>();
  const sourceIdsByOldMedia = new Map<string, string[]>();
  for (const [sourceItemId, binding] of activeBindings) {
    if (!affectedOldMediaItemIds.has(binding.mediaItemId)) continue;
    const input = inputRecords.get(sourceItemId);
    if (!input) {
      throw new Error(`Trusted catalog recovery is missing affected companion ${sourceItemId}; no database changes were made.`);
    }
    affectedBindingInputs.set(sourceItemId, {
      mediaItemId: binding.mediaItemId,
      mediaType: input.media.mediaType
    });
    const ids = sourceIdsByOldMedia.get(binding.mediaItemId) ?? [];
    ids.push(sourceItemId);
    sourceIdsByOldMedia.set(binding.mediaItemId, ids);
  }
  for (const [oldMediaItemId, sourceItemIds] of sourceIdsByOldMedia) {
    const oldBinding = activeBindings.get(sourceItemIds[0]!)!;
    if (oldBinding.mediaSource !== "catalog") continue;
    const hasSameTypeCompanion = sourceItemIds.some(
      (sourceItemId) => inputRecords.get(sourceItemId)?.media.mediaType === oldBinding.mediaType
    );
    if (!hasSameTypeCompanion) {
      throw new Error(
        `Trusted catalog recovery would leave catalog media ${oldMediaItemId} without a same-type active catalog companion; no database changes were made.`
      );
    }
  }

  const ownedExternalIds = repository.externalIdsForMediaItems(affectedOldMediaItemIds);
  const operationalExternalIdEvidence = repository.operationalExternalIdEvidenceForMediaItems(affectedOldMediaItemIds);
  const cleanupByRepair = new Map<string, readonly CatalogExternalId[]>();
  const claimedCleanup = new Set<string>();
  for (const sourceItemId of preliminaryRepairs.keys()) {
    const binding = activeBindings.get(sourceItemId)!;
    const wrongRecord = inputRecords.get(sourceItemId)!;
    const owned = new Set((ownedExternalIds.get(binding.mediaItemId) ?? []).map(externalIdKey));
    const corroboratedOperationalIds = new Set(
      (operationalExternalIdEvidence.get(binding.mediaItemId) ?? []).map(externalIdKey)
    );
    const correctCompanionExternalIds = new Set<string>();
    for (const companionId of sourceIdsByOldMedia.get(binding.mediaItemId) ?? []) {
      const companion = inputRecords.get(companionId)!;
      if (companion.media.mediaType !== binding.mediaType) continue;
      for (const externalId of catalogExternalIds(companion)) correctCompanionExternalIds.add(externalIdKey(externalId));
    }
    const cleanup = catalogExternalIds(wrongRecord).filter((externalId) => {
      const key = externalIdKey(externalId);
      const shouldDelete = externalId.source === "wikidata" && externalId.value === sourceItemId
        ? owned.has(key)
        : owned.has(key)
          && !correctCompanionExternalIds.has(key)
          && !corroboratedOperationalIds.has(key);
      if (!shouldDelete) return false;
      const cleanupKey = externalIdKey({
        source: `${binding.mediaItemId}:${binding.mediaType}:${externalId.source}`,
        value: externalId.value
      });
      if (claimedCleanup.has(cleanupKey)) return false;
      claimedCleanup.add(cleanupKey);
      return true;
    });
    if (!cleanup.some((externalId) => externalId.source === "wikidata" && externalId.value === sourceItemId)) {
      throw new Error(`Catalog source identity ${sourceItemId} lost its exact external-ID owner during preflight; no database changes were made.`);
    }
    cleanupByRepair.set(sourceItemId, cleanup);
  }

  const typeRepairs = new Map<string, TrustedCatalogTypeRepairPlan>();
  for (const [sourceItemId, repair] of preliminaryRepairs) {
    const targetAction = repair.targetExisted ? "existing" as const : "create" as const;
    typeRepairs.set(sourceItemId, {
      sourceItemId: repair.sourceItemId,
      expectedOldMediaItemId: repair.expectedOldMediaItemId,
      expectedOldMediaType: repair.expectedOldMediaType,
      expectedOldSourceVersion: repair.expectedOldSourceVersion,
      expectedOldLastSeenSourceVersion: repair.expectedOldLastSeenSourceVersion,
      expectedOldPayloadHash: repair.expectedOldPayloadHash,
      expectedContentHash: repair.expectedContentHash,
      targetMediaItemId: repair.targetMediaItemId,
      targetMediaType: repair.targetMediaType,
      targetAction,
      expectedTargetMediaSource: repair.expectedTargetMediaSource,
      expectedTargetExternalIds: repair.expectedTargetExternalIds,
      externalIdCleanup: cleanupByRepair.get(sourceItemId)!
    });
  }

  const affectedBindings = new Map<string, { mediaItemId: string; mediaType: MediaType }>();
  for (const [sourceItemId, affected] of affectedBindingInputs) {
    const repair = typeRepairs.get(sourceItemId);
    affectedBindings.set(sourceItemId, repair
      ? { mediaItemId: repair.targetMediaItemId, mediaType: repair.targetMediaType }
      : affected);
  }

  const recoverySourceItemIds = new Set([...refreshRequirement.sourceItemIds, ...affectedBindings.keys()]);
  const rematerializeSourceItemIds = new Set(recoverySourceItemIds);
  const expectedRecoveryBindings = new Map<string, {
    mediaItemId: string;
    mediaType: MediaType;
    mediaSource: MediaSource;
    payloadHash: string;
  }>();
  for (const sourceItemId of recoverySourceItemIds) {
    const inputRecord = inputRecords.get(sourceItemId);
    const expectedBinding = affectedBindings.get(sourceItemId) ?? activeBindings.get(sourceItemId);
    if (!inputRecord?.payloadHash || !expectedBinding) {
      throw new Error(`Trusted catalog recovery lost expected binding evidence for ${sourceItemId}; no database changes were made.`);
    }
    const repair = typeRepairs.get(sourceItemId);
    const preWriteMediaSource = repair
      ? repair.expectedTargetMediaSource
      : activeBindings.get(sourceItemId)?.mediaSource;
    expectedRecoveryBindings.set(sourceItemId, {
      mediaItemId: expectedBinding.mediaItemId,
      mediaType: inputRecord.media.mediaType,
      mediaSource: preWriteMediaSource === "operational" || preWriteMediaSource === undefined ? "catalog" : preWriteMediaSource,
      payloadHash: inputRecord.payloadHash
    });
  }
  if (args.expectedRecoverySourceRecords !== undefined && recoverySourceItemIds.size !== args.expectedRecoverySourceRecords) {
    throw new Error(
      `Trusted catalog recovery expected ${args.expectedRecoverySourceRecords} planned source records but found ${recoverySourceItemIds.size}; no database changes were made.`
    );
  }
  const recoveryPlanSha256 = trustedRecoveryPlanSha256({
    source,
    sourceVersion: args.version,
    inputFileSha256: args.expectedFileSha256!,
    inputSourceRecordsValidated: inputRecords.size,
    refreshRequiredMediaItems: refreshRequirement.mediaItemCount,
    refreshRequiredSourceItemIds: refreshRequirement.sourceItemIds,
    typeRepairs,
    affectedBindings,
    preWriteBindings: activeBindings,
    recoverySourceItemIds
  });
  if (args.expectedRecoveryPlanSha256 !== undefined && recoveryPlanSha256 !== args.expectedRecoveryPlanSha256) {
    throw new Error("Trusted catalog recovery plan did not match --expected-recovery-plan-sha256; no database changes were made.");
  }
  return {
    inputSourceRecordsValidated: inputRecords.size,
    recoveryPlanSha256,
    typeRepairs,
    affectedOldMediaItemIds,
    affectedBindings,
    expectedRecoveryBindings,
    rematerializeSourceItemIds,
    recoverySourceItemIds,
    externalIdCleanupCount: [...typeRepairs.values()].reduce((count, repair) => count + repair.externalIdCleanup.length, 0)
  };
}

function trustedRecoveryPlanSha256(input: {
  source: string;
  sourceVersion: string;
  inputFileSha256: string;
  inputSourceRecordsValidated: number;
  refreshRequiredMediaItems: number;
  refreshRequiredSourceItemIds: ReadonlySet<string>;
  typeRepairs: ReadonlyMap<string, TrustedCatalogTypeRepairPlan>;
  affectedBindings: ReadonlyMap<string, { mediaItemId: string; mediaType: MediaType }>;
  preWriteBindings: ReturnType<MediaRepository["activeCatalogSourceTypeBindings"]>;
  recoverySourceItemIds: ReadonlySet<string>;
}) {
  const plan = {
    schema: "moodarr-trusted-catalog-recovery-plan-v2",
    source: input.source,
    sourceVersion: input.sourceVersion,
    inputFileSha256: input.inputFileSha256,
    inputSourceRecordsValidated: input.inputSourceRecordsValidated,
    refreshRequiredMediaItems: input.refreshRequiredMediaItems,
    refreshRequiredSourceItemIds: [...input.refreshRequiredSourceItemIds].sort(),
    repairs: [...input.typeRepairs.values()]
      .sort((left, right) => left.sourceItemId.localeCompare(right.sourceItemId))
      .map((repair) => ({
        sourceItemId: repair.sourceItemId,
        expectedOldMediaItemId: repair.expectedOldMediaItemId,
        expectedOldMediaType: repair.expectedOldMediaType,
        expectedOldSourceVersion: repair.expectedOldSourceVersion,
        expectedOldLastSeenSourceVersion: repair.expectedOldLastSeenSourceVersion,
        expectedOldPayloadHash: repair.expectedOldPayloadHash ?? null,
        expectedContentHash: repair.expectedContentHash,
        targetMediaItemId: repair.targetMediaItemId,
        targetMediaType: repair.targetMediaType,
        targetAction: repair.targetAction,
        expectedTargetMediaSource: repair.expectedTargetMediaSource ?? null,
        expectedTargetExternalIds: [...repair.expectedTargetExternalIds]
          .sort((left, right) => externalIdKey(left).localeCompare(externalIdKey(right))),
        externalIdCleanup: [...repair.externalIdCleanup]
          .sort((left, right) => externalIdKey(left).localeCompare(externalIdKey(right)))
      })),
    affectedBindings: [...input.affectedBindings]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([sourceItemId, binding]) => ({ sourceItemId, ...binding })),
    preWriteBindings: [...input.recoverySourceItemIds]
      .sort()
      .map((sourceItemId) => {
        const binding = input.preWriteBindings.get(sourceItemId);
        if (!binding) throw new Error(`Trusted catalog recovery source ${sourceItemId} lost its pre-write binding.`);
        return {
          sourceItemId,
          mediaItemId: binding.mediaItemId,
          mediaType: binding.mediaType,
          mediaSource: binding.mediaSource,
          sourceVersion: binding.sourceVersion,
          lastSeenSourceVersion: binding.lastSeenSourceVersion,
          payloadHash: binding.payloadHash ?? null,
          contentHash: binding.contentHash ?? null,
          sourceIdentityExternalIdBound: binding.sourceIdentityExternalIdBound
        };
      }),
    recoverySourceItemIds: [...input.recoverySourceItemIds].sort()
  };
  return createHash("sha256").update(JSON.stringify(plan)).digest("hex");
}

function catalogExternalIds(record: CatalogIngestRecord): CatalogExternalId[] {
  return Object.entries(record.media.externalIds ?? {})
    .filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== null && String(entry[1]).length > 0)
    .map(([source, value]) => ({ source: source.toLowerCase(), value: String(value) }));
}

function externalIdKey(externalId: CatalogExternalId) {
  return JSON.stringify([externalId.source, externalId.value]);
}

function flushBatch(
  repository: MediaRepository | undefined,
  batch: Parameters<MediaRepository["upsertCatalogRecords"]>[0],
  dryRun: boolean,
  rehydratePlan?: TrustedRehydratePlan
) {
  if (batch.length === 0) {
    return { mediaItemsUpserted: 0, changedSourceRecords: 0, unchangedSourceRecords: 0, typeRepairSourceRecordsRebound: 0 };
  }
  const typeRepairSourceRecordsRebound = dryRun
    ? 0
    : batch.filter((record) => rehydratePlan?.typeRepairs.has(record.sourceItemId)).length;
  const result = dryRun
    ? { mediaItemIds: batch.map((record) => record.sourceItemId), inserted: batch.length, changed: 0, unchanged: 0 }
    : repository!.upsertCatalogRecordsWithStats(batch, {
        trustedRehydrateTypeRepairs: rehydratePlan?.typeRepairs,
        trustedRehydrateRematerializations: rehydratePlan?.rematerializeSourceItemIds
      });
  batch.splice(0, batch.length);
  return {
    mediaItemsUpserted: result.mediaItemIds.length,
    changedSourceRecords: result.inserted + result.changed,
    unchangedSourceRecords: result.unchanged,
    typeRepairSourceRecordsRebound
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

function parseNonNegativeInteger(value: string, option: string) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${option} requires a nonnegative integer.`);
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
