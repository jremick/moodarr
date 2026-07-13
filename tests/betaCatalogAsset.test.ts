import crypto from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  BetaCatalogAssetError,
  parseBetaCatalogManifest,
  validateBetaCatalogAsset,
  type BetaCatalogManifest
} from "../scripts/validate-beta-catalog-asset";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("beta catalog asset contract", () => {
  it("validates exact gzip JSONL bytes, record schema, uniqueness, and counts", async () => {
    const fixture = createFixture();
    const result = await validateBetaCatalogAsset({ file: fixture.assetPath, manifest: fixture.manifestPath });

    expect(result).toMatchObject({
      schemaVersion: "moodarr-beta-catalog-validation-v1",
      status: "passed",
      releaseTarget: "0.1.0-beta.1",
      catalogVersion: "wikidata-20260622-min5-v1",
      asset: {
        filename: "moodarr-wikidata-20260622-min5-v1.jsonl.gz",
        counts: fixture.manifest.asset.counts
      }
    });
    expect(JSON.stringify(result)).not.toContain(fixture.directory);
  });

  it("counts request-attempt eligibility only with complete metadata and a media-matching positive TMDB ID", async () => {
    const fixture = createFixture([
      { id: "Q1", mediaType: "film", label: "Eligible film", description: "Summary", genreLabels: ["drama"], tmdbMovieId: "11", sitelinkCount: 5, hasEnglishWikipedia: true },
      { id: "Q2", mediaType: "television series", label: "Eligible TV", description: "Summary", genreLabels: ["comedy"], tmdbTvId: "22", sitelinkCount: 5, hasEnglishWikipedia: true },
      { id: "Q3", mediaType: "film", label: "No summary", genreLabels: ["drama"], tmdbMovieId: "33", sitelinkCount: 5, hasEnglishWikipedia: true },
      { id: "Q4", mediaType: "television series", label: "No genres", description: "Summary", genreLabels: [], tmdbTvId: "44", sitelinkCount: 5, hasEnglishWikipedia: true },
      { id: "Q5", mediaType: "film", label: "Wrong TMDB type", description: "Summary", genreLabels: ["drama"], tmdbTvId: "55", sitelinkCount: 5, hasEnglishWikipedia: true },
      { id: "Q6", mediaType: "television series", label: "Nonpositive TMDB", description: "Summary", genreLabels: ["drama"], tmdbTvId: "0", sitelinkCount: 5, hasEnglishWikipedia: true }
    ]);

    await expect(validateBetaCatalogAsset({ file: fixture.assetPath, manifest: fixture.manifestPath })).resolves.toMatchObject({
      asset: {
        counts: {
          recordsWithTmdb: 6,
          recordsWithTypeMatchedTmdb: 4,
          wrongNamespaceOnlyRecords: 1,
          invalidTypeMatchedTmdbRecords: 1,
          recordsWithSummary: 5,
          recordsWithGenres: 5,
          requestAttemptPreAmbiguityEligibleRecords: 2,
          ambiguousIdentityGroups: 0,
          ambiguousIdentityRecords: 0,
          ambiguousEligibleRecords: 0,
          requestAttemptEligibleRecords: 2,
          eligibleMovieRecords: 1,
          eligibleTvRecords: 1
        }
      }
    });
  });

  it("keeps wrong-namespace-only TMDB rows outside matched coverage and eligibility", async () => {
    const complete = { description: "Summary", genreLabels: ["drama"], sitelinkCount: 5, hasEnglishWikipedia: true };
    const fixture = createFixture([
      { ...complete, id: "Q1", mediaType: "film", label: "Movie with TV namespace", tmdbTvId: "11" },
      { ...complete, id: "Q2", mediaType: "television series", label: "TV with movie namespace", tmdbMovieId: "22" },
      { ...complete, id: "Q3", mediaType: "film", label: "Matched movie", tmdbMovieId: "33" }
    ]);

    await expect(validateBetaCatalogAsset({ file: fixture.assetPath, manifest: fixture.manifestPath })).resolves.toMatchObject({
      asset: {
        counts: {
          recordsWithTmdb: 3,
          recordsWithTypeMatchedTmdb: 1,
          wrongNamespaceOnlyRecords: 2,
          invalidTypeMatchedTmdbRecords: 0,
          requestAttemptPreAmbiguityEligibleRecords: 1,
          requestAttemptEligibleRecords: 1
        }
      }
    });
  });

  it("canonicalizes safe TMDB integers for identity and rejects oversized values", async () => {
    const complete = { description: "Summary", genreLabels: ["drama"], sitelinkCount: 5, hasEnglishWikipedia: true };
    const fixture = createFixture([
      { ...complete, id: "Q1", mediaType: "film", label: "Leading zero", tmdbMovieId: "00123" },
      { ...complete, id: "Q2", mediaType: "film", label: "Canonical", tmdbMovieId: "123" },
      { ...complete, id: "Q3", mediaType: "film", label: "Oversized", tmdbMovieId: "9007199254740992" }
    ]);

    await expect(validateBetaCatalogAsset({ file: fixture.assetPath, manifest: fixture.manifestPath })).resolves.toMatchObject({
      asset: {
        counts: {
          recordsWithTmdb: 3,
          recordsWithTypeMatchedTmdb: 2,
          wrongNamespaceOnlyRecords: 0,
          invalidTypeMatchedTmdbRecords: 1,
          requestAttemptPreAmbiguityEligibleRecords: 2,
          ambiguousIdentityGroups: 1,
          ambiguousIdentityRecords: 2,
          ambiguousEligibleRecords: 2,
          requestAttemptEligibleRecords: 0
        }
      }
    });
  });

  it("excludes complete candidates in media-scoped strong-identifier components", async () => {
    const complete = { description: "Summary", genreLabels: ["drama"], sitelinkCount: 5, hasEnglishWikipedia: true };
    const fixture = createFixture([
      { ...complete, id: "Q1", mediaType: "film", label: "IMDb pair one", imdbId: "tt-shared", tmdbMovieId: "11" },
      { ...complete, id: "Q2", mediaType: "film", label: "IMDb pair two", imdbId: "tt-shared", tmdbMovieId: "12" },
      { ...complete, id: "Q3", mediaType: "television series", label: "TVDB pair one", tvdbId: "tv-shared", tmdbTvId: "21" },
      { ...complete, id: "Q4", mediaType: "television series", label: "TVDB pair two", tvdbId: "tv-shared", tmdbTvId: "22" },
      { ...complete, id: "Q5", mediaType: "film", label: "Cross-media film", tmdbMovieId: "33" },
      { ...complete, id: "Q6", mediaType: "television series", label: "Cross-media TV", tmdbTvId: "33" },
      { ...complete, id: "Q7", mediaType: "film", label: "Transitive one", imdbId: "tt-a", tmdbMovieId: "44" },
      { ...complete, id: "Q8", mediaType: "film", label: "Transitive two", imdbId: "tt-b", tmdbMovieId: "44" },
      { ...complete, id: "Q9", mediaType: "film", label: "Transitive three", imdbId: "tt-b", tmdbMovieId: "45" }
    ]);

    await expect(validateBetaCatalogAsset({ file: fixture.assetPath, manifest: fixture.manifestPath })).resolves.toMatchObject({
      asset: {
        counts: {
          requestAttemptPreAmbiguityEligibleRecords: 9,
          ambiguousIdentityGroups: 3,
          ambiguousIdentityRecords: 7,
          ambiguousEligibleRecords: 7,
          ambiguousEligibleMovieRecords: 5,
          ambiguousEligibleTvRecords: 2,
          requestAttemptEligibleRecords: 2,
          eligibleMovieRecords: 1,
          eligibleTvRecords: 1
        }
      }
    });
  });

  it("rejects size drift and same-size hash drift before decompression", async () => {
    const wrongSize = createFixture();
    writeManifest(wrongSize.manifestPath, {
      ...wrongSize.manifest,
      asset: { ...wrongSize.manifest.asset, bytes: wrongSize.manifest.asset.bytes + 1 }
    });
    await expectValidationCode(wrongSize, "asset_size_mismatch");

    const wrongHash = createFixture();
    writeManifest(wrongHash.manifestPath, {
      ...wrongHash.manifest,
      asset: { ...wrongHash.manifest.asset, sha256: "e".repeat(64) }
    });
    await expectValidationCode(wrongHash, "asset_sha256_mismatch");
  });

  it("rejects malformed manifests without echoing their contents", async () => {
    const fixture = createFixture();
    writeFileSync(fixture.manifestPath, '{"private":"do-not-echo"', "utf8");
    await expectValidationCode(fixture, "manifest_json_invalid");

    const schemaDrift = createFixture();
    writeManifest(schemaDrift.manifestPath, { ...schemaDrift.manifest, workstationPath: "/private/host" });
    await expectValidationCode(schemaDrift, "manifest_schema_invalid");
  });

  it("rejects symlinked and non-regular artifact inputs", async () => {
    const symlink = createFixture();
    const linkPath = join(symlink.directory, "catalog-link.jsonl.gz");
    symlinkSync(symlink.assetPath, linkPath);
    await expectValidationCode({ ...symlink, assetPath: linkPath }, "asset_file_invalid");

    const directory = createFixture();
    const directoryPath = join(directory.directory, "catalog-directory");
    mkdirSync(directoryPath);
    await expectValidationCode({ ...directory, assetPath: directoryPath }, "asset_file_invalid");
  });

  it("rejects invalid record shape, duplicate IDs, and aggregate-count drift", async () => {
    const invalid = createFixture([{ id: "not-a-qid", mediaType: "film", label: "Invalid", sitelinkCount: 5, hasEnglishWikipedia: true }]);
    await expectValidationCode(invalid, "asset_record_schema_invalid");

    const duplicate = createFixture([
      { id: "Q1", mediaType: "film", label: "One", sitelinkCount: 5, hasEnglishWikipedia: true },
      { id: "Q1", mediaType: "television series", label: "Two", sitelinkCount: 5, hasEnglishWikipedia: true }
    ]);
    await expectValidationCode(duplicate, "asset_duplicate_wikidata_id");

    const countDrift = createFixture();
    writeManifest(countDrift.manifestPath, {
      ...countDrift.manifest,
      asset: {
        ...countDrift.manifest.asset,
        counts: {
          ...countDrift.manifest.asset.counts,
          requestAttemptPreAmbiguityEligibleRecords: 0,
          requestAttemptEligibleRecords: 0,
          eligibleMovieRecords: 0,
          eligibleTvRecords: 0
        }
      }
    });
    await expectValidationCode(countDrift, "asset_record_counts_mismatch");
  });

  it("pins the committed beta asset provenance without private environment data", () => {
    const raw = readFileSync(new URL("../catalog/moodarr-wikidata-20260622-min5-v1.manifest.json", import.meta.url), "utf8");
    const manifest = parseBetaCatalogManifest(raw);

    expect(manifest).toMatchObject({
      releaseTarget: "0.1.0-beta.1",
      catalogVersion: "wikidata-20260622-min5-v1",
      asset: {
        bytes: 14_160_185,
        uncompressedBytes: 46_157_079,
        sha256: "dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a",
        counts: {
          records: 90_397,
          importableRecords: 90_397,
          uniqueWikidataIds: 90_397,
          skippedRecords: 0,
          movieRecords: 75_608,
          tvRecords: 14_789,
          recordsWithTmdb: 87_310,
          recordsWithTypeMatchedTmdb: 87_160,
          wrongNamespaceOnlyRecords: 150,
          invalidTypeMatchedTmdbRecords: 0,
          recordsWithSummary: 90_372,
          recordsWithGenres: 85_588,
          requestAttemptPreAmbiguityEligibleRecords: 82_924,
          ambiguousIdentityGroups: 36,
          ambiguousIdentityRecords: 72,
          ambiguousEligibleRecords: 59,
          ambiguousEligibleMovieRecords: 10,
          ambiguousEligibleTvRecords: 49,
          requestAttemptEligibleRecords: 82_865,
          eligibleMovieRecords: 70_841,
          eligibleTvRecords: 12_024
        }
      },
      source: {
        bytes: 101_881_782_812,
        sha1: "0ccd6763fac76c0fcd6c249d4ed83029aa7136d6",
        sha256: "3566f9974747ba3a2bdcd602cdfc48785497a2bd2347afb78b85472d98e97a6c",
        license: "CC0-1.0"
      },
      normalization: {
        normalizerRevision: "944ac7259cf4d6abaf2483860a6ef975c5e8b164",
        normalizerSha256: "89da67977d71efd0c7adebf5dd170f93c04d96ae0d5aa4eec092ebf8535f1640"
      }
    });
    expect(raw).not.toMatch(/(?:\/Users\/|[A-Za-z]:\\|\\\\|\b(?:10|127)\.\d+\.\d+\.\d+|\b192\.168\.|\b172\.(?:1[6-9]|2\d|3[01])\.|\bjarel\b|\bw11\b)/i);
  });

  it("keeps future normalizer outputs deterministic and emitted manifests path-free", () => {
    for (const relativePath of ["../scripts/normalize-wikidata-dump.py", "../scripts/normalize-wikidata-dump-fast.py"]) {
      const source = readFileSync(new URL(relativePath, import.meta.url), "utf8");
      expect(source).toContain('gzip.GzipFile(filename="", mode="wb", fileobj=raw');
      expect(source).toContain("mtime=0");
      expect(source).toContain('"deterministicGzipHeader"');
      expect(source).toContain("type=public_identifier");
      expect(source).toContain("finalize_request_attempt_counts");
      expect(source).not.toMatch(/"(?:dumpPath|outputPath|workDir|intermediateFiles|sourcePath|path)"\s*:/);
    }
  });
});

type FixtureRecord = Record<string, unknown>;

function createFixture(records: FixtureRecord[] = [
  {
    id: "Q1",
    mediaType: "film",
    label: "Film",
    description: "A film summary",
    genreLabels: ["drama"],
    tmdbMovieId: "11",
    sitelinkCount: 5,
    hasEnglishWikipedia: true
  },
  {
    id: "Q2",
    mediaType: "television series",
    label: "Series",
    description: "A series summary",
    genreLabels: ["comedy"],
    tmdbTvId: "22",
    sitelinkCount: 6,
    hasEnglishWikipedia: true
  }
]) {
  const directory = mkdtempSync(join(tmpdir(), "moodarr-beta-catalog-"));
  temporaryDirectories.push(directory);
  const raw = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
  const compressed = gzipSync(raw, { level: 1 });
  const assetPath = join(directory, "local-source-name.jsonl.gz");
  const manifestPath = join(directory, "manifest.json");
  writeFileSync(assetPath, compressed);
  const movieRecords = records.filter((record) => record.mediaType === "film").length;
  const tvRecords = records.filter((record) => record.mediaType === "television series").length;
  const importableRecords = records.length;
  const recordsWithTmdb = records.filter((record) => record.tmdbMovieId || record.tmdbTvId);
  const recordsWithRawTypeMatchedTmdb = records.filter((record) => (
    record.mediaType === "film" ? record.tmdbMovieId : record.tmdbTvId
  ));
  const recordsWithTypeMatchedTmdb = records.filter((record) => fixtureCanonicalTypeMatchedTmdbId(record));
  const identitySummary = fixtureIdentitySummary(records);
  const manifest: BetaCatalogManifest = {
    schemaVersion: "moodarr-beta-catalog-asset-v1",
    releaseTarget: "0.1.0-beta.1",
    catalogVersion: "wikidata-20260622-min5-v1",
    asset: {
      filename: "moodarr-wikidata-20260622-min5-v1.jsonl.gz",
      format: "gzip-jsonl",
      mediaType: "application/gzip",
      bytes: compressed.byteLength,
      uncompressedBytes: Buffer.byteLength(raw),
      sha256: crypto.createHash("sha256").update(compressed).digest("hex"),
      recordSchemaVersion: "moodarr-wikidata-catalog-record-v1",
      counts: {
        records: records.length,
        importableRecords,
        uniqueWikidataIds: importableRecords,
        skippedRecords: 0,
        movieRecords,
        tvRecords,
        recordsWithTmdb: recordsWithTmdb.length,
        recordsWithTypeMatchedTmdb: recordsWithTypeMatchedTmdb.length,
        wrongNamespaceOnlyRecords: recordsWithTmdb.length - recordsWithRawTypeMatchedTmdb.length,
        invalidTypeMatchedTmdbRecords: recordsWithRawTypeMatchedTmdb.length - recordsWithTypeMatchedTmdb.length,
        recordsWithSummary: records.filter((record) => typeof record.description === "string" && record.description.length > 0).length,
        recordsWithGenres: records.filter((record) => Array.isArray(record.genreLabels) && record.genreLabels.length > 0).length,
        ...identitySummary
      }
    },
    source: {
      provider: "Wikidata",
      dumpDate: "2026-06-22",
      dumpUrl: "https://dumps.wikimedia.org/wikidatawiki/entities/20260622/wikidata-20260622-all.json.bz2",
      bytes: 1,
      sha1: "a".repeat(40),
      sha256: "b".repeat(64),
      license: "CC0-1.0",
      licenseScope: "Wikidata structured main-namespace data",
      licenseUrl: "https://www.wikidata.org/wiki/Wikidata:Licensing"
    },
    normalization: {
      normalizer: "scripts/normalize-wikidata-dump-fast.py",
      normalizerRevision: "c".repeat(40),
      normalizerSha256: "d".repeat(64),
      minimumSitelinks: 5,
      requireExternalId: false
    }
  };
  writeManifest(manifestPath, manifest);
  return { directory, assetPath, manifestPath, manifest };
}

function isFixtureRequestAttemptPreAmbiguityEligible(record: FixtureRecord) {
  if (typeof record.description !== "string" || record.description.length === 0) return false;
  if (!Array.isArray(record.genreLabels) || record.genreLabels.length === 0) return false;
  return fixtureCanonicalTypeMatchedTmdbId(record) !== undefined;
}

function fixtureIdentitySummary(records: FixtureRecord[]) {
  const parents = records.map((_, index) => index);
  const owners = new Map<string, number>();
  const find = (index: number): number => parents[index] === index ? index : (parents[index] = find(parents[index]!));
  const union = (left: number, right: number) => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  records.forEach((record, index) => {
    for (const identity of fixtureStrongIdentityKeys(record)) {
      const owner = owners.get(identity);
      if (owner === undefined) owners.set(identity, index);
      else union(index, owner);
    }
  });
  const groups = new Map<number, FixtureRecord[]>();
  records.forEach((record, index) => groups.set(find(index), [...(groups.get(find(index)) ?? []), record]));
  const preAmbiguityEligible = records.filter(isFixtureRequestAttemptPreAmbiguityEligible);
  const ambiguousGroups = [...groups.values()].filter((group) => group.length > 1);
  const ambiguousRecords = ambiguousGroups.flat();
  const ambiguousEligible = ambiguousRecords.filter(isFixtureRequestAttemptPreAmbiguityEligible);
  const ambiguousIds = new Set(ambiguousRecords.map((record) => record.id));
  const eligible = preAmbiguityEligible.filter((record) => !ambiguousIds.has(record.id));
  return {
    requestAttemptPreAmbiguityEligibleRecords: preAmbiguityEligible.length,
    ambiguousIdentityGroups: ambiguousGroups.length,
    ambiguousIdentityRecords: ambiguousRecords.length,
    ambiguousEligibleRecords: ambiguousEligible.length,
    ambiguousEligibleMovieRecords: ambiguousEligible.filter((record) => record.mediaType === "film").length,
    ambiguousEligibleTvRecords: ambiguousEligible.filter((record) => record.mediaType === "television series").length,
    requestAttemptEligibleRecords: eligible.length,
    eligibleMovieRecords: eligible.filter((record) => record.mediaType === "film").length,
    eligibleTvRecords: eligible.filter((record) => record.mediaType === "television series").length
  };
}

function fixtureStrongIdentityKeys(record: FixtureRecord) {
  const mediaScope = record.mediaType;
  const tmdbId = fixtureCanonicalTypeMatchedTmdbId(record);
  return [
    ["wikidata", record.id],
    ["imdb", record.imdbId],
    ["tmdb", tmdbId],
    ["tvdb", record.tvdbId]
  ].flatMap(([source, value]) => typeof value === "string" && value.length > 0 ? [`${mediaScope}:${source}:${value}`] : []);
}

function fixtureCanonicalTypeMatchedTmdbId(record: FixtureRecord) {
  const rawTmdbId = record.mediaType === "film" ? record.tmdbMovieId : record.tmdbTvId;
  if (typeof rawTmdbId !== "string" || !/^[0-9]+$/.test(rawTmdbId)) return undefined;
  const tmdbId = Number(rawTmdbId);
  return Number.isSafeInteger(tmdbId) && tmdbId > 0 ? String(tmdbId) : undefined;
}

function writeManifest(path: string, manifest: unknown) {
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function expectValidationCode(
  fixture: Pick<ReturnType<typeof createFixture>, "assetPath" | "manifestPath">,
  code: string
) {
  try {
    await validateBetaCatalogAsset({ file: fixture.assetPath, manifest: fixture.manifestPath });
    throw new Error("validation unexpectedly passed");
  } catch (error) {
    expect(error).toBeInstanceOf(BetaCatalogAssetError);
    expect((error as BetaCatalogAssetError).code).toBe(code);
  }
}
