import crypto from "node:crypto";
import type { MediaType } from "../../shared/types";
import type { CatalogIngestRecord, MediaRepository } from "../db/mediaRepository";

export interface WikidataCatalogRecord {
  id?: string;
  wikidataId?: string;
  qid?: string;
  mediaType?: string;
  instanceOf?: unknown;
  title?: string;
  label?: string;
  labels?: Record<string, string | undefined>;
  description?: string;
  descriptions?: Record<string, string | undefined>;
  aliases?: unknown;
  year?: number | string;
  publicationDate?: string;
  firstPublicationDate?: string;
  genres?: unknown;
  genreLabels?: unknown;
  cast?: unknown;
  castLabels?: unknown;
  directors?: unknown;
  directorLabels?: unknown;
  countries?: unknown;
  countryLabels?: unknown;
  languages?: unknown;
  languageLabels?: unknown;
  franchises?: unknown;
  franchiseLabels?: unknown;
  imdbId?: string | number;
  tmdbId?: string | number;
  tmdbMovieId?: string | number;
  tmdbTvId?: string | number;
  tvdbId?: string | number;
  externalIds?: Record<string, string | number | undefined>;
  sitelinkCount?: number | string;
  awardCount?: number | string;
  hasEnglishWikipedia?: boolean;
}

export interface WikidataCatalogImportOptions {
  sourceVersion: string;
  source?: string;
  fetchedAt?: string;
}

export interface WikidataCatalogImportSummary {
  source: string;
  sourceVersion: string;
  records: number;
  imported: number;
  skipped: number;
  mediaItemsUpserted: number;
  sourceRecordsUpserted: number;
  changedSourceRecords: number;
  unchangedSourceRecords: number;
  skippedReasons: Record<string, number>;
}

export function validateCatalogImportSafety(
  mode: "incremental" | "full_snapshot",
  limit: number | undefined,
  rehydrateRequired = false,
  expectedRefreshRequired?: number,
  expectedSourceRecords?: number
) {
  if (mode === "full_snapshot" && limit !== undefined) {
    throw new Error("--limit cannot be combined with --mode full-snapshot because a partial snapshot would deactivate unseen catalog rows.");
  }
  if (rehydrateRequired && mode === "full_snapshot") {
    throw new Error("--rehydrate-required only supports incremental mode because a partial recovery import must not deactivate unseen catalog records.");
  }
  if (rehydrateRequired && (typeof expectedRefreshRequired !== "number" || !Number.isInteger(expectedRefreshRequired) || expectedRefreshRequired <= 0)) {
    throw new Error("--rehydrate-required requires --expected-refresh-required with the exact positive source-specific item count shown before recovery.");
  }
  if (!rehydrateRequired && expectedRefreshRequired !== undefined) {
    throw new Error("--expected-refresh-required can only be used with --rehydrate-required.");
  }
  if (
    mode === "full_snapshot" &&
    (typeof expectedSourceRecords !== "number" || !Number.isInteger(expectedSourceRecords) || expectedSourceRecords <= 0)
  ) {
    throw new Error("--mode full-snapshot requires --expected-source-records with the exact positive unique importable-record count from the validated manifest.");
  }
  if (mode !== "full_snapshot" && expectedSourceRecords !== undefined) {
    throw new Error("--expected-source-records can only be used with --mode full-snapshot.");
  }
}

export function assertCatalogFullSnapshotSourceCount(
  mode: "incremental" | "full_snapshot",
  expectedSourceRecords: number | undefined,
  sourceItemIds: Iterable<string>
) {
  const uniqueSourceRecords = new Set(sourceItemIds).size;
  if (mode === "full_snapshot" && uniqueSourceRecords !== expectedSourceRecords) {
    throw new Error(
      `Full-snapshot validation expected ${expectedSourceRecords} unique importable source records but found ${uniqueSourceRecords}; no existing source records were deactivated.`
    );
  }
  return uniqueSourceRecords;
}

export function importWikidataCatalogRecords(
  repository: MediaRepository,
  records: WikidataCatalogRecord[],
  options: WikidataCatalogImportOptions
): WikidataCatalogImportSummary {
  const source = options.source ?? "wikidata";
  const mapped: CatalogIngestRecord[] = [];
  const skippedReasons: Record<string, number> = {};

  for (const record of records) {
    const catalogRecord = toCatalogIngestRecord(record, { ...options, source });
    if (catalogRecord.ok) {
      mapped.push(catalogRecord.record);
    } else {
      skippedReasons[catalogRecord.reason] = (skippedReasons[catalogRecord.reason] ?? 0) + 1;
    }
  }

  const upsert = mapped.length ? repository.upsertCatalogRecordsWithStats(mapped) : { mediaItemIds: [], inserted: 0, changed: 0, unchanged: 0 };
  repository.recordCatalogSync(source, options.sourceVersion, "ok", {
    itemCount: records.length,
    mediaItemsUpserted: upsert.mediaItemIds.length,
    sourceRecordsUpserted: mapped.length,
    changedSourceRecords: upsert.inserted + upsert.changed,
    unchangedSourceRecords: upsert.unchanged
  });

  return {
    source,
    sourceVersion: options.sourceVersion,
    records: records.length,
    imported: mapped.length,
    skipped: records.length - mapped.length,
    mediaItemsUpserted: upsert.mediaItemIds.length,
    sourceRecordsUpserted: mapped.length,
    changedSourceRecords: upsert.inserted + upsert.changed,
    unchangedSourceRecords: upsert.unchanged,
    skippedReasons
  };
}

export function toCatalogIngestRecord(
  record: WikidataCatalogRecord,
  options: Required<Pick<WikidataCatalogImportOptions, "source" | "sourceVersion">> & Pick<WikidataCatalogImportOptions, "fetchedAt">
): { ok: true; record: CatalogIngestRecord } | { ok: false; reason: string } {
  const wikidataId = normalizeWikidataId(record.wikidataId ?? record.qid ?? record.id);
  if (!wikidataId) return { ok: false, reason: "missing_wikidata_id" };

  const mediaType = normalizeMediaType(record.mediaType, record.instanceOf);
  if (!mediaType) return { ok: false, reason: "unsupported_media_type" };

  const title = firstText(record.title, record.label, record.labels?.en);
  if (!title) return { ok: false, reason: "missing_title" };

  const year = normalizeYear(record.year) ?? yearFromDate(record.publicationDate) ?? yearFromDate(record.firstPublicationDate);
  const description = firstText(record.description, record.descriptions?.en);
  const genres = preferLabels(record.genreLabels, record.genres);
  const cast = preferLabels(record.castLabels, record.cast).slice(0, 16);
  const directors = preferLabels(record.directorLabels, record.directors).slice(0, 8);
  const countries = preferLabels(record.countryLabels, record.countries).slice(0, 16);
  const languages = preferLabels(record.languageLabels, record.languages).slice(0, 16);
  const franchises = preferLabels(record.franchiseLabels, record.franchises).slice(0, 16);
  const externalIds = cleanExternalIds({
    ...record.externalIds,
    wikidata: wikidataId,
    imdb: record.imdbId,
    tmdb: record.tmdbId ?? record.tmdbMovieId ?? record.tmdbTvId,
    tvdb: record.tvdbId
  });
  const sitelinkCount = normalizeCount(record.sitelinkCount);
  const externalIdCount = Object.keys(externalIds).length;
  const awardCount = normalizeCount(record.awardCount);
  const aliases = preferLabels(record.aliases).slice(0, 24);

  return {
    ok: true,
    record: {
      source: options.source,
      sourceVersion: options.sourceVersion,
      sourceItemId: wikidataId,
      sourceUrl: `https://www.wikidata.org/wiki/${wikidataId}`,
      licensePolicy: "wikidata-cc0",
      fetchedAt: options.fetchedAt,
      payloadHash: sha256Json(record),
      media: {
        mediaType,
        title,
        year,
        summary: description,
        genres,
        cast,
        directors,
        externalIds
      },
      mainstreamScore: wikidataMainstreamScore({
        sitelinkCount,
        externalIdCount,
        awardCount,
        hasEnglishWikipedia: record.hasEnglishWikipedia ?? Boolean(record.labels?.en || record.descriptions?.en)
      }),
      metadataConfidence: wikidataMetadataConfidence({
        description,
        genres,
        cast,
        directors,
        externalIdCount,
        sitelinkCount
      }),
      sitelinkCount,
      externalIdCount,
      awardCount,
      metadata: {
        aliases,
        countries,
        languages,
        franchises,
        has_english_wikipedia: record.hasEnglishWikipedia ?? Boolean(record.labels?.en || record.descriptions?.en)
      }
    }
  };
}

function normalizeWikidataId(value: string | undefined) {
  const cleaned = value?.trim().toUpperCase();
  return cleaned && /^Q\d+$/.test(cleaned) ? cleaned : undefined;
}

function normalizeMediaType(value: string | undefined, instanceOf: unknown): MediaType | undefined {
  const candidates = [value, ...preferLabels(instanceOf)]
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => entry.toLowerCase());
  if (candidates.some((entry) => /\b(?:movie|film|feature film|television film)\b/.test(entry) || entry === "q11424")) return "movie";
  if (candidates.some((entry) => /\b(?:tv|television|series|miniseries|show)\b/.test(entry) || entry === "q5398426" || entry === "q15416")) return "tv";
  return undefined;
}

function firstText(...values: Array<string | undefined>) {
  return values.map((value) => value?.trim()).find((value): value is string => Boolean(value));
}

function preferLabels(primary: unknown, fallback?: unknown) {
  const values = stringArray(primary);
  return values.length ? values : stringArray(fallback);
}

function stringArray(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === "string") return value.split("|").map(cleanLabel).filter(Boolean);
  if (!Array.isArray(value)) return [];
  return [...new Set(value.flatMap((entry) => {
    if (typeof entry === "string" || typeof entry === "number") return [cleanLabel(String(entry))].filter(Boolean);
    if (entry && typeof entry === "object") {
      const row = entry as { label?: unknown; title?: unknown; name?: unknown; id?: unknown };
      return stringArray(row.label ?? row.title ?? row.name ?? row.id);
    }
    return [];
  }))];
}

function cleanLabel(value: string) {
  return value.trim().replace(/\s+/g, " ").slice(0, 160);
}

function cleanExternalIds(ids: Record<string, string | number | undefined>) {
  return Object.fromEntries(
    Object.entries(ids)
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== null && String(entry[1]).trim().length > 0)
      .map(([source, value]) => [normalizeExternalIdSource(source), String(value).trim()])
      .filter(([source, value]) => source.length > 0 && value.length > 0)
  );
}

function normalizeExternalIdSource(value: string) {
  const normalized = value.toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (normalized === "imdbid") return "imdb";
  if (normalized === "tmdbid" || normalized === "tmdbmovieid" || normalized === "tmdbtvid") return "tmdb";
  if (normalized === "tvdbid") return "tvdb";
  if (normalized === "wikidataid" || normalized === "qid") return "wikidata";
  return normalized;
}

function normalizeYear(value: number | string | undefined) {
  if (typeof value === "number" && Number.isInteger(value) && value > 1800 && value < 2200) return value;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed > 1800 && parsed < 2200) return parsed;
  return yearFromDate(value);
}

function yearFromDate(value: string | undefined) {
  const match = value?.match(/\b(18\d{2}|19\d{2}|20\d{2}|21\d{2})\b/);
  return match ? Number(match[1]) : undefined;
}

function normalizeCount(value: number | string | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

function wikidataMainstreamScore(input: { sitelinkCount: number; externalIdCount: number; awardCount: number; hasEnglishWikipedia: boolean }) {
  const sitelinkScore = Math.min(48, Math.log2(input.sitelinkCount + 1) * 7.5);
  const externalScore = Math.min(22, input.externalIdCount * 5.5);
  const awardScore = Math.min(15, input.awardCount * 3);
  const enwikiScore = input.hasEnglishWikipedia ? 15 : 0;
  return Math.round(Math.max(0, Math.min(100, sitelinkScore + externalScore + awardScore + enwikiScore)));
}

function wikidataMetadataConfidence(input: {
  description?: string;
  genres: string[];
  cast: string[];
  directors: string[];
  externalIdCount: number;
  sitelinkCount: number;
}) {
  let score = 0.32;
  if (input.description) score += 0.14;
  if (input.genres.length > 0) score += 0.13;
  if (input.cast.length > 0) score += 0.08;
  if (input.directors.length > 0) score += 0.08;
  score += Math.min(0.12, input.externalIdCount * 0.04);
  score += Math.min(0.13, input.sitelinkCount / 500);
  return Number(Math.max(0.2, Math.min(0.86, score)).toFixed(3));
}

function sha256Json(value: unknown) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
