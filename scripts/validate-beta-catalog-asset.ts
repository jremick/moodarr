import crypto from "node:crypto";
import {
  closeSync,
  constants,
  createReadStream,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync
} from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGunzip } from "node:zlib";
import { z } from "zod";

const manifestSchemaVersion = "moodarr-beta-catalog-asset-v1";
const validationSchemaVersion = "moodarr-beta-catalog-validation-v1";
const recordSchemaVersion = "moodarr-wikidata-catalog-record-v1";
const defaultManifestPath = fileURLToPath(
  new URL("../catalog/moodarr-wikidata-20260622-min5-v1.manifest.json", import.meta.url)
);
const maximumManifestBytes = 32 * 1024;
const maximumAssetBytes = 2 * 1024 * 1024 * 1024;
const maximumUncompressedBytes = 8 * 1024 * 1024 * 1024;
const sha1Schema = z.string().regex(/^[0-9a-f]{40}$/).refine((value) => !/^0+$/.test(value));
const sha256Schema = z.string().regex(/^[0-9a-f]{64}$/).refine((value) => !/^0+$/.test(value));
const safePositiveIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const safeNonnegativeIntegerSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const compactTextSchema = z.string().min(1).max(512).refine((value) => value === value.trim());
const labelArraySchema = z.array(compactTextSchema).max(32).refine((values) => new Set(values).size === values.length);

const recordSchema = z.object({
  id: z.string().regex(/^Q[1-9][0-9]*$/),
  mediaType: z.enum(["film", "television series"]),
  label: compactTextSchema,
  description: z.string().min(1).max(4_096).refine((value) => value === value.trim()).optional(),
  aliases: labelArraySchema.optional(),
  publicationDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  imdbId: compactTextSchema.optional(),
  tmdbMovieId: compactTextSchema.optional(),
  tmdbTvId: compactTextSchema.optional(),
  tvdbId: compactTextSchema.optional(),
  sitelinkCount: safeNonnegativeIntegerSchema,
  hasEnglishWikipedia: z.boolean(),
  genreLabels: labelArraySchema.optional(),
  castLabels: labelArraySchema.optional(),
  directorLabels: labelArraySchema.optional(),
  countryLabels: labelArraySchema.optional(),
  languageLabels: labelArraySchema.optional(),
  franchiseLabels: labelArraySchema.optional()
}).strict();

export const betaCatalogManifestSchema = z.object({
  schemaVersion: z.literal(manifestSchemaVersion),
  releaseTarget: z.literal("0.1.0-beta.1"),
  catalogVersion: z.string().regex(/^wikidata-\d{8}-min\d+-v\d+$/),
  asset: z.object({
    filename: z.string().regex(/^moodarr-wikidata-\d{8}-min\d+-v\d+\.jsonl\.gz$/),
    format: z.literal("gzip-jsonl"),
    mediaType: z.literal("application/gzip"),
    bytes: safePositiveIntegerSchema.max(maximumAssetBytes),
    uncompressedBytes: safePositiveIntegerSchema.max(maximumUncompressedBytes),
    sha256: sha256Schema,
    recordSchemaVersion: z.literal(recordSchemaVersion),
    counts: z.object({
      records: safePositiveIntegerSchema,
      importableRecords: safePositiveIntegerSchema,
      uniqueWikidataIds: safePositiveIntegerSchema,
      skippedRecords: z.literal(0),
      movieRecords: safeNonnegativeIntegerSchema,
      tvRecords: safeNonnegativeIntegerSchema,
      recordsWithTmdb: safeNonnegativeIntegerSchema,
      recordsWithTypeMatchedTmdb: safeNonnegativeIntegerSchema,
      wrongNamespaceOnlyRecords: safeNonnegativeIntegerSchema,
      invalidTypeMatchedTmdbRecords: safeNonnegativeIntegerSchema,
      recordsWithSummary: safeNonnegativeIntegerSchema,
      recordsWithGenres: safeNonnegativeIntegerSchema,
      requestAttemptPreAmbiguityEligibleRecords: safeNonnegativeIntegerSchema,
      ambiguousIdentityGroups: safeNonnegativeIntegerSchema,
      ambiguousIdentityRecords: safeNonnegativeIntegerSchema,
      ambiguousEligibleRecords: safeNonnegativeIntegerSchema,
      ambiguousEligibleMovieRecords: safeNonnegativeIntegerSchema,
      ambiguousEligibleTvRecords: safeNonnegativeIntegerSchema,
      requestAttemptEligibleRecords: safeNonnegativeIntegerSchema,
      eligibleMovieRecords: safeNonnegativeIntegerSchema,
      eligibleTvRecords: safeNonnegativeIntegerSchema
    }).strict()
  }).strict(),
  source: z.object({
    provider: z.literal("Wikidata"),
    dumpDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    dumpUrl: z.string().url().startsWith("https://dumps.wikimedia.org/wikidatawiki/entities/"),
    bytes: safePositiveIntegerSchema,
    sha1: sha1Schema,
    sha256: sha256Schema,
    license: z.literal("CC0-1.0"),
    licenseScope: z.literal("Wikidata structured main-namespace data"),
    licenseUrl: z.literal("https://www.wikidata.org/wiki/Wikidata:Licensing")
  }).strict(),
  normalization: z.object({
    normalizer: z.literal("scripts/normalize-wikidata-dump-fast.py"),
    normalizerRevision: sha1Schema,
    normalizerSha256: sha256Schema,
    minimumSitelinks: safeNonnegativeIntegerSchema,
    requireExternalId: z.literal(false)
  }).strict()
}).strict().superRefine((manifest, context) => {
  const compactDate = manifest.source.dumpDate.replaceAll("-", "");
  const suffix = `${compactDate}-min${manifest.normalization.minimumSitelinks}-v1`;
  const expectedDumpUrl = `https://dumps.wikimedia.org/wikidatawiki/entities/${compactDate}/wikidata-${compactDate}-all.json.bz2`;
  const counts = manifest.asset.counts;
  if (manifest.catalogVersion !== `wikidata-${suffix}`) {
    context.addIssue({ code: "custom", path: ["catalogVersion"], message: "catalog version does not match source and normalization" });
  }
  if (manifest.asset.filename !== `moodarr-wikidata-${suffix}.jsonl.gz`) {
    context.addIssue({ code: "custom", path: ["asset", "filename"], message: "asset filename does not match catalog version" });
  }
  if (manifest.source.dumpUrl !== expectedDumpUrl) {
    context.addIssue({ code: "custom", path: ["source", "dumpUrl"], message: "dump URL does not match dump date" });
  }
  if (counts.records !== counts.movieRecords + counts.tvRecords) {
    context.addIssue({ code: "custom", path: ["asset", "counts"], message: "media counts do not equal total records" });
  }
  if (counts.importableRecords + counts.skippedRecords !== counts.records) {
    context.addIssue({ code: "custom", path: ["asset", "counts"], message: "import disposition does not equal total records" });
  }
  if (
    counts.uniqueWikidataIds !== counts.importableRecords
    || counts.recordsWithTmdb > counts.importableRecords
    || counts.recordsWithTmdb !== (
      counts.recordsWithTypeMatchedTmdb + counts.wrongNamespaceOnlyRecords + counts.invalidTypeMatchedTmdbRecords
    )
  ) {
    context.addIssue({ code: "custom", path: ["asset", "counts"], message: "unique or TMDB counts exceed importable records" });
  }
  if (counts.recordsWithSummary > counts.importableRecords || counts.recordsWithGenres > counts.importableRecords) {
    context.addIssue({ code: "custom", path: ["asset", "counts"], message: "metadata coverage counts exceed importable records" });
  }
  if (
    counts.requestAttemptEligibleRecords !== counts.eligibleMovieRecords + counts.eligibleTvRecords
    || counts.requestAttemptPreAmbiguityEligibleRecords !== counts.requestAttemptEligibleRecords + counts.ambiguousEligibleRecords
    || counts.requestAttemptPreAmbiguityEligibleRecords > counts.recordsWithSummary
    || counts.requestAttemptPreAmbiguityEligibleRecords > counts.recordsWithGenres
    || counts.requestAttemptPreAmbiguityEligibleRecords > counts.recordsWithTypeMatchedTmdb
    || counts.eligibleMovieRecords > counts.movieRecords
    || counts.eligibleTvRecords > counts.tvRecords
  ) {
    context.addIssue({ code: "custom", path: ["asset", "counts"], message: "request-attempt coverage counts are inconsistent" });
  }
  if (
    (counts.ambiguousIdentityGroups === 0) !== (counts.ambiguousIdentityRecords === 0)
    || counts.ambiguousIdentityRecords < counts.ambiguousIdentityGroups * 2
    || counts.ambiguousIdentityRecords > counts.importableRecords
    || counts.ambiguousEligibleRecords !== counts.ambiguousEligibleMovieRecords + counts.ambiguousEligibleTvRecords
    || counts.ambiguousEligibleRecords > counts.ambiguousIdentityRecords
    || counts.eligibleMovieRecords + counts.ambiguousEligibleMovieRecords > counts.movieRecords
    || counts.eligibleTvRecords + counts.ambiguousEligibleTvRecords > counts.tvRecords
  ) {
    context.addIssue({ code: "custom", path: ["asset", "counts"], message: "strong-identity ambiguity counts are inconsistent" });
  }
});

export type BetaCatalogManifest = z.infer<typeof betaCatalogManifestSchema>;

export class BetaCatalogAssetError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

export function parseBetaCatalogManifest(raw: string): BetaCatalogManifest {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new BetaCatalogAssetError("manifest_json_invalid");
  }
  const parsed = betaCatalogManifestSchema.safeParse(value);
  if (!parsed.success) throw new BetaCatalogAssetError("manifest_schema_invalid");
  return parsed.data;
}

export async function validateBetaCatalogAsset(options: { file: string; manifest?: string }) {
  const manifest = readManifest(options.manifest ?? defaultManifestPath);
  const artifact = await validateArtifact(resolve(options.file), manifest);
  return {
    schemaVersion: validationSchemaVersion,
    status: "passed" as const,
    releaseTarget: manifest.releaseTarget,
    catalogVersion: manifest.catalogVersion,
    asset: {
      filename: manifest.asset.filename,
      bytes: artifact.bytes,
      uncompressedBytes: artifact.uncompressedBytes,
      sha256: artifact.sha256,
      counts: artifact.counts
    },
    provenance: {
      source: manifest.source.provider,
      dumpDate: manifest.source.dumpDate,
      dumpSha256: manifest.source.sha256,
      license: manifest.source.license,
      normalizerRevision: manifest.normalization.normalizerRevision,
      normalizerSha256: manifest.normalization.normalizerSha256
    }
  };
}

function readManifest(path: string) {
  let fd: number | undefined;
  try {
    const initial = lstatSync(path);
    if (!initial.isFile() || initial.isSymbolicLink() || initial.size <= 0 || initial.size > maximumManifestBytes) {
      throw new BetaCatalogAssetError("manifest_file_invalid");
    }
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size !== initial.size || opened.size > maximumManifestBytes) {
      throw new BetaCatalogAssetError("manifest_file_invalid");
    }
    return parseBetaCatalogManifest(readFileSync(fd, "utf8"));
  } catch (error) {
    if (error instanceof BetaCatalogAssetError) throw error;
    throw new BetaCatalogAssetError("manifest_file_invalid");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function validateArtifact(path: string, manifest: BetaCatalogManifest) {
  try {
    const initial = lstatSync(path);
    if (!initial.isFile() || initial.isSymbolicLink()) throw new BetaCatalogAssetError("asset_file_invalid");
    if (initial.size !== manifest.asset.bytes) throw new BetaCatalogAssetError("asset_size_mismatch");

    const sha256 = await hashArtifactFile(path, manifest.asset.bytes);
    if (sha256 !== manifest.asset.sha256) throw new BetaCatalogAssetError("asset_sha256_mismatch");

    const parsed = await inspectGzipJsonl(path, manifest);
    const after = lstatSync(path);
    if (!after.isFile() || after.isSymbolicLink() || after.size !== initial.size || parsed.sha256 !== sha256) {
      throw new BetaCatalogAssetError("asset_changed_during_validation");
    }
    return { bytes: after.size, ...parsed };
  } catch (error) {
    if (error instanceof BetaCatalogAssetError) throw error;
    throw new BetaCatalogAssetError("asset_file_invalid");
  }
}

async function hashArtifactFile(path: string, expectedBytes: number) {
  const hash = crypto.createHash("sha256");
  const stream = openArtifactStream(path, expectedBytes);
  try {
    for await (const chunk of stream) hash.update(chunk as Buffer);
  } catch {
    throw new BetaCatalogAssetError("asset_file_invalid");
  }
  return hash.digest("hex");
}

async function inspectGzipJsonl(path: string, manifest: BetaCatalogManifest) {
  const compressedHash = crypto.createHash("sha256");
  const source = openArtifactStream(path, manifest.asset.bytes);
  const gunzip = createGunzip();
  let uncompressedBytes = 0;
  source.on("data", (chunk) => {
    compressedHash.update(chunk);
  });
  source.on("error", (error) => gunzip.destroy(error));
  gunzip.on("data", (chunk: Buffer) => {
    uncompressedBytes += chunk.byteLength;
    if (uncompressedBytes > manifest.asset.uncompressedBytes) {
      gunzip.destroy(new BetaCatalogAssetError("asset_uncompressed_size_mismatch"));
    }
  });
  source.pipe(gunzip);

  const lines = createInterface({ input: gunzip, crlfDelay: Infinity });
  const ids = new Set<string>();
  const identityGraph = new IdentityGraph();
  const counts = {
    records: 0,
    importableRecords: 0,
    uniqueWikidataIds: 0,
    skippedRecords: 0 as const,
    movieRecords: 0,
    tvRecords: 0,
    recordsWithTmdb: 0,
    recordsWithTypeMatchedTmdb: 0,
    wrongNamespaceOnlyRecords: 0,
    invalidTypeMatchedTmdbRecords: 0,
    recordsWithSummary: 0,
    recordsWithGenres: 0,
    requestAttemptPreAmbiguityEligibleRecords: 0,
    ambiguousIdentityGroups: 0,
    ambiguousIdentityRecords: 0,
    ambiguousEligibleRecords: 0,
    ambiguousEligibleMovieRecords: 0,
    ambiguousEligibleTvRecords: 0,
    requestAttemptEligibleRecords: 0,
    eligibleMovieRecords: 0,
    eligibleTvRecords: 0
  };
  try {
    for await (const line of lines) {
      if (!line) throw new BetaCatalogAssetError("asset_blank_record");
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw new BetaCatalogAssetError("asset_record_json_invalid");
      }
      const parsed = recordSchema.safeParse(value);
      if (!parsed.success || parsed.data.sitelinkCount < manifest.normalization.minimumSitelinks) {
        throw new BetaCatalogAssetError("asset_record_schema_invalid");
      }
      if (ids.has(parsed.data.id)) throw new BetaCatalogAssetError("asset_duplicate_wikidata_id");
      ids.add(parsed.data.id);
      counts.records += 1;
      counts.importableRecords += 1;
      if (parsed.data.mediaType === "film") counts.movieRecords += 1;
      else counts.tvRecords += 1;
      const hasRawTmdb = Boolean(parsed.data.tmdbMovieId || parsed.data.tmdbTvId);
      const hasRawTypeMatchedTmdb = Boolean(
        parsed.data.mediaType === "film" ? parsed.data.tmdbMovieId : parsed.data.tmdbTvId
      );
      const canonicalTmdbId = canonicalTypeMatchedTmdbId(parsed.data);
      if (hasRawTmdb) counts.recordsWithTmdb += 1;
      if (canonicalTmdbId) counts.recordsWithTypeMatchedTmdb += 1;
      else if (hasRawTypeMatchedTmdb) counts.invalidTypeMatchedTmdbRecords += 1;
      else if (hasRawTmdb) counts.wrongNamespaceOnlyRecords += 1;
      if (parsed.data.description) counts.recordsWithSummary += 1;
      if (parsed.data.genreLabels?.length) counts.recordsWithGenres += 1;
      identityGraph.add(
        parsed.data,
        Boolean(parsed.data.description && parsed.data.genreLabels?.length && canonicalTmdbId),
        canonicalTmdbId
      );
    }
  } catch (error) {
    source.destroy();
    gunzip.destroy();
    if (error instanceof BetaCatalogAssetError) throw error;
    throw new BetaCatalogAssetError("asset_gzip_invalid");
  } finally {
    lines.close();
  }
  counts.uniqueWikidataIds = ids.size;
  finalizeRequestAttemptCounts(counts, identityGraph.components());
  if (uncompressedBytes !== manifest.asset.uncompressedBytes) {
    throw new BetaCatalogAssetError("asset_uncompressed_size_mismatch");
  }
  if (!sameCounts(counts, manifest.asset.counts)) throw new BetaCatalogAssetError("asset_record_counts_mismatch");
  return { uncompressedBytes, sha256: compressedHash.digest("hex"), counts };
}

function openArtifactStream(path: string, expectedBytes: number) {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile()) throw new BetaCatalogAssetError("asset_file_invalid");
    if (opened.size !== expectedBytes) throw new BetaCatalogAssetError("asset_size_mismatch");
    const stream = createReadStream("catalog-asset", { fd, autoClose: true, start: 0 });
    fd = undefined;
    return stream;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (error instanceof BetaCatalogAssetError) throw error;
    throw new BetaCatalogAssetError("asset_file_invalid");
  }
}

function sameCounts(actual: BetaCatalogManifest["asset"]["counts"], expected: BetaCatalogManifest["asset"]["counts"]) {
  return (Object.keys(expected) as Array<keyof typeof expected>).every((key) => actual[key] === expected[key]);
}

function canonicalTypeMatchedTmdbId(record: z.infer<typeof recordSchema>) {
  const rawTmdbId = record.mediaType === "film" ? record.tmdbMovieId : record.tmdbTvId;
  if (typeof rawTmdbId !== "string" || !/^[0-9]+$/.test(rawTmdbId)) return undefined;
  const tmdbId = Number(rawTmdbId);
  return Number.isSafeInteger(tmdbId) && tmdbId > 0 ? String(tmdbId) : undefined;
}

function finalizeRequestAttemptCounts(
  counts: BetaCatalogManifest["asset"]["counts"],
  identityGroups: Array<{ mediaType: "film" | "television series"; records: number; preAmbiguityEligibleRecords: number }>
) {
  for (const group of identityGroups) {
    counts.requestAttemptPreAmbiguityEligibleRecords += group.preAmbiguityEligibleRecords;
    if (group.records <= 1) {
      counts.requestAttemptEligibleRecords += group.preAmbiguityEligibleRecords;
      if (group.mediaType === "film") counts.eligibleMovieRecords += group.preAmbiguityEligibleRecords;
      else counts.eligibleTvRecords += group.preAmbiguityEligibleRecords;
      continue;
    }
    counts.ambiguousIdentityGroups += 1;
    counts.ambiguousIdentityRecords += group.records;
    counts.ambiguousEligibleRecords += group.preAmbiguityEligibleRecords;
    if (group.mediaType === "film") {
      counts.ambiguousEligibleMovieRecords += group.preAmbiguityEligibleRecords;
    } else {
      counts.ambiguousEligibleTvRecords += group.preAmbiguityEligibleRecords;
    }
  }
}

class IdentityGraph {
  private readonly parents: number[] = [];
  private readonly ranks: number[] = [];
  private readonly records: Array<{ mediaType: "film" | "television series"; preAmbiguityEligible: boolean }> = [];
  private readonly identityOwners = new Map<string, number>();

  add(record: z.infer<typeof recordSchema>, preAmbiguityEligible: boolean, canonicalTmdbId: string | undefined) {
    const index = this.parents.length;
    this.parents.push(index);
    this.ranks.push(0);
    this.records.push({ mediaType: record.mediaType, preAmbiguityEligible });
    for (const identity of strongIdentityKeys(record, canonicalTmdbId)) {
      const owner = this.identityOwners.get(identity);
      if (owner === undefined) this.identityOwners.set(identity, index);
      else this.union(index, owner);
    }
  }

  components() {
    const groups = new Map<number, { mediaType: "film" | "television series"; records: number; preAmbiguityEligibleRecords: number }>();
    for (let index = 0; index < this.records.length; index += 1) {
      const record = this.records[index]!;
      const root = this.find(index);
      const group = groups.get(root) ?? { mediaType: record.mediaType, records: 0, preAmbiguityEligibleRecords: 0 };
      if (group.mediaType !== record.mediaType) throw new BetaCatalogAssetError("asset_identity_scope_invalid");
      group.records += 1;
      if (record.preAmbiguityEligible) group.preAmbiguityEligibleRecords += 1;
      groups.set(root, group);
    }
    return [...groups.values()];
  }

  private find(index: number): number {
    const parent = this.parents[index]!;
    if (parent === index) return index;
    const root = this.find(parent);
    this.parents[index] = root;
    return root;
  }

  private union(left: number, right: number) {
    let leftRoot = this.find(left);
    let rightRoot = this.find(right);
    if (leftRoot === rightRoot) return;
    if (this.ranks[leftRoot]! < this.ranks[rightRoot]!) [leftRoot, rightRoot] = [rightRoot, leftRoot];
    this.parents[rightRoot] = leftRoot;
    if (this.ranks[leftRoot] === this.ranks[rightRoot]) this.ranks[leftRoot]! += 1;
  }
}

function strongIdentityKeys(record: z.infer<typeof recordSchema>, canonicalTmdbId: string | undefined) {
  const mediaScope = record.mediaType;
  return [
    ["wikidata", record.id],
    ["imdb", record.imdbId],
    ["tmdb", canonicalTmdbId],
    ["tvdb", record.tvdbId]
  ].flatMap(([source, value]) => typeof value === "string" && value.length > 0 ? [`${mediaScope}:${source}:${value}`] : []);
}

function parseArgs(values: string[]) {
  if (values.length !== 2 || values[0] !== "--file" || !values[1] || values[1].startsWith("--")) {
    throw new BetaCatalogAssetError("input_argument_invalid");
  }
  return { file: values[1] };
}

async function main() {
  try {
    const result = await validateBetaCatalogAsset(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    const code = error instanceof BetaCatalogAssetError ? error.code : "catalog_validation_failed";
    process.stdout.write(`${JSON.stringify({ schemaVersion: validationSchemaVersion, status: "failed", failures: [code] }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedPath === import.meta.url) void main();
