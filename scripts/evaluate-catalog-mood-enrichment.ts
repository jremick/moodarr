import crypto from "node:crypto";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository, normalizeTitle } from "../src/server/db/mediaRepository";
import { loadConfig } from "../src/server/config";
import {
  CATALOG_MOOD_ENRICHMENT_RULESET_VERSION,
  CATALOG_MOOD_ENRICHMENT_SOURCE,
  buildCatalogMoodEnrichment,
  catalogMoodSourceVersion,
  type CatalogMoodEnrichmentItem
} from "../src/server/recommendation/catalogMoodEnrichment";
import type { MediaType } from "../src/shared/types";

interface Args {
  catalogSource: string;
  catalogVersion?: string;
  source: string;
  sourceVersion?: string;
  rulesVersion: string;
  minCoverage: number;
  minNonGenreCoverage: number;
  minTwoFeatureCoverage: number;
  minReady?: number;
  requireStored: boolean;
  limit?: number;
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();
const db = createDatabase(config.dbPath);
const repository = new MediaRepository(db);
const catalogVersion = args.catalogVersion ?? latestCatalogVersion(args.catalogSource);
if (!catalogVersion) {
  console.error(`No catalog source version found for source "${args.catalogSource}". Pass --catalog-version explicitly.`);
  process.exit(1);
}

const sourceVersion = args.sourceVersion ?? catalogMoodSourceVersion(catalogVersion, args.rulesVersion);
const result = evaluateCatalogMoodEnrichment({ ...args, catalogVersion, sourceVersion });
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;

function parseArgs(values: string[]): Args {
  const parsed: Args = {
    catalogSource: "wikidata",
    source: CATALOG_MOOD_ENRICHMENT_SOURCE,
    rulesVersion: CATALOG_MOOD_ENRICHMENT_RULESET_VERSION,
    minCoverage: 0.85,
    minNonGenreCoverage: 0.1,
    minTwoFeatureCoverage: 0.85,
    requireStored: false
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--catalog-source") parsed.catalogSource = values[++index] ?? parsed.catalogSource;
    else if (value === "--catalog-version") parsed.catalogVersion = values[++index];
    else if (value === "--source") parsed.source = values[++index] ?? parsed.source;
    else if (value === "--source-version") parsed.sourceVersion = values[++index];
    else if (value === "--rules-version") parsed.rulesVersion = values[++index] ?? parsed.rulesVersion;
    else if (value === "--min-coverage") parsed.minCoverage = parseRatio(values[++index], parsed.minCoverage);
    else if (value === "--min-non-genre") parsed.minNonGenreCoverage = parseRatio(values[++index], parsed.minNonGenreCoverage);
    else if (value === "--min-two-feature") parsed.minTwoFeatureCoverage = parseRatio(values[++index], parsed.minTwoFeatureCoverage);
    else if (value === "--min-ready") parsed.minReady = parsePositiveInteger(values[++index], parsed.minReady ?? 0);
    else if (value === "--limit") parsed.limit = parsePositiveInteger(values[++index], parsed.limit ?? 0);
    else if (value === "--require-stored") parsed.requireStored = true;
  }
  return parsed;
}

function evaluateCatalogMoodEnrichment(input: Required<Pick<Args, "catalogVersion" | "sourceVersion">> & Args) {
  const items = catalogItems(input.catalogSource, input.catalogVersion, input.limit);
  const ids = items.map((item) => item.id);
  const hash = crypto.createHash("sha256");
  let enrichedItems = 0;
  let twoFeatureItems = 0;
  let nonGenreFeatureItems = 0;
  let scoreRows = 0;
  const featureCounts = new Map<string, number>();

  for (const item of items) {
    const enrichment = buildCatalogMoodEnrichment(item);
    if (enrichment.scores.length > 0) enrichedItems += 1;
    if (enrichment.scores.length >= 2) twoFeatureItems += 1;
    if (enrichment.nonGenreFeatureCount > 0) nonGenreFeatureItems += 1;
    scoreRows += enrichment.scores.length;
    const signature = enrichment.scores.map((score) => `${score.feature}:${score.score}:${score.confidence}`).join("|");
    hash.update(`${item.id}\t${signature}\n`);
    for (const score of enrichment.scores) featureCounts.set(score.feature, (featureCounts.get(score.feature) ?? 0) + 1);
  }

  const stored = storedCoverage(input.source, input.sourceVersion, input.catalogSource, input.catalogVersion, input.limit);
  const catalogDiagnostics = repository.catalogDiagnostics();
  const coverage = ratio(enrichedItems, ids.length);
  const twoFeatureCoverage = ratio(twoFeatureItems, ids.length);
  const nonGenreCoverage = ratio(nonGenreFeatureItems, ids.length);
  const storedCoverageRatio = ratio(stored.items, ids.length);
  const failures = [
    coverage < input.minCoverage ? `Coverage ${coverage} below ${input.minCoverage}.` : "",
    twoFeatureCoverage < input.minTwoFeatureCoverage ? `Two-feature coverage ${twoFeatureCoverage} below ${input.minTwoFeatureCoverage}.` : "",
    nonGenreCoverage < input.minNonGenreCoverage ? `Non-genre coverage ${nonGenreCoverage} below ${input.minNonGenreCoverage}.` : "",
    input.requireStored && storedCoverageRatio < input.minCoverage ? `Stored source coverage ${storedCoverageRatio} below ${input.minCoverage}.` : "",
    input.minReady && catalogDiagnostics.rankedSearchReadyItems < input.minReady
      ? `Ranked search-ready items ${catalogDiagnostics.rankedSearchReadyItems} below ${input.minReady}.`
      : ""
  ].filter(Boolean);

  return {
    ok: failures.length === 0,
    generatedAt: new Date().toISOString(),
    failures,
    source: input.source,
    sourceVersion: input.sourceVersion,
    rulesVersion: input.rulesVersion,
    catalogSource: input.catalogSource,
    catalogVersion: input.catalogVersion,
    catalogItems: ids.length,
    computed: {
      enrichedItems,
      twoFeatureItems,
      nonGenreFeatureItems,
      scoreRows,
      coverage,
      twoFeatureCoverage,
      nonGenreCoverage,
      featureHash: hash.digest("hex"),
      topFeatures: [...featureCounts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .slice(0, 20)
        .map(([feature, count]) => ({ feature, count }))
    },
    stored,
    catalogReadiness: {
      rankedSearchReadyItems: catalogDiagnostics.rankedSearchReadyItems,
      moodIndexedItems: catalogDiagnostics.moodIndexedItems,
      featureIndexedItems: catalogDiagnostics.featureIndexedItems,
      rankSignalItems: catalogDiagnostics.rankSignalItems
    },
    thresholds: {
      minCoverage: input.minCoverage,
      minTwoFeatureCoverage: input.minTwoFeatureCoverage,
      minNonGenreCoverage: input.minNonGenreCoverage,
      minReady: input.minReady,
      requireStored: input.requireStored
    },
    limit: input.limit
  };
}

function latestCatalogVersion(source: string) {
  const row = db
    .prepare(
      `SELECT source_version
       FROM catalog_source_records
       WHERE source = ?
        AND active = 1
       GROUP BY source_version
       ORDER BY MAX(updated_at) DESC, source_version DESC
       LIMIT 1`
    )
    .get(source) as { source_version: string } | undefined;
  return row?.source_version;
}

function catalogItemIds(source: string, sourceVersion: string, limit: number | undefined) {
  const limitClause = limit ? " LIMIT ?" : "";
  const values: Array<string | number> = [source, sourceVersion];
  if (limit) values.push(limit);
  const rows = db
    .prepare(
      `SELECT DISTINCT media_item_id
       FROM catalog_source_records
       WHERE source = ?
        AND source_version = ?
        AND active = 1
       ORDER BY media_item_id${limitClause}`
    )
    .all(...values) as { media_item_id: string }[];
  return rows.map((row) => row.media_item_id);
}

function catalogItems(source: string, sourceVersion: string, limit: number | undefined): CatalogMoodEnrichmentItem[] {
  const limitClause = limit ? " LIMIT ?" : "";
  const values: Array<string | number> = [source, sourceVersion];
  if (limit) values.push(limit);
  const catalogCte = `WITH catalog_items AS (
    SELECT DISTINCT media_item_id
    FROM catalog_source_records
    WHERE source = ?
     AND source_version = ?
     AND active = 1
    ORDER BY media_item_id${limitClause}
  )`;
  const rows = db
    .prepare(
      `${catalogCte}
       SELECT m.id, m.media_type, m.title, m.summary
       FROM media_items m
       JOIN catalog_items c ON c.media_item_id = m.id
       ORDER BY m.id`
    )
    .all(...values) as Array<{ id: string; media_type: MediaType; title: string; summary?: string | null }>;
  const genres = db
    .prepare(
      `${catalogCte}
       SELECT g.media_item_id, g.name
       FROM genres g
       JOIN catalog_items c ON c.media_item_id = g.media_item_id
       ORDER BY g.media_item_id, g.name`
    )
    .all(...values) as Array<{ media_item_id: string; name: string }>;
  const genresById = groupValues(genres);
  return rows.map((row) => ({
    id: row.id,
    mediaType: row.media_type,
    title: row.title,
    summary: row.summary ?? undefined,
    genres: genresById.get(row.id) ?? [],
    cast: [],
    directors: []
  }));
}

function groupValues(rows: Array<{ media_item_id: string; name: string }>) {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const values = grouped.get(row.media_item_id) ?? [];
    values.push(row.name);
    grouped.set(row.media_item_id, values);
  }
  return grouped;
}

function storedCoverage(source: string, sourceVersion: string, catalogSource: string, catalogVersion: string, limit: number | undefined) {
  const sourceName = normalizeTitle(source);
  const limitedIds = limit ? catalogItemIds(catalogSource, catalogVersion, limit) : undefined;
  if (limitedIds) {
    db.exec("CREATE TEMP TABLE IF NOT EXISTS catalog_mood_eval_ids (media_item_id TEXT PRIMARY KEY)");
    db.exec("DELETE FROM catalog_mood_eval_ids");
    const insert = db.prepare("INSERT OR IGNORE INTO catalog_mood_eval_ids (media_item_id) VALUES (?)");
    for (const id of limitedIds) insert.run(id);
  }
  const limitJoin = limitedIds ? "JOIN catalog_mood_eval_ids e ON e.media_item_id = s.media_item_id" : "";
  const row = db
    .prepare(
      `SELECT COUNT(DISTINCT s.media_item_id) AS items, COUNT(*) AS score_rows
       FROM media_mood_feature_scores s
       JOIN catalog_source_records r ON r.media_item_id = s.media_item_id
       ${limitJoin}
       WHERE s.source = ?
        AND s.source_version = ?
        AND r.source = ?
        AND r.source_version = ?`
    )
    .get(sourceName, sourceVersion, catalogSource, catalogVersion) as { items: number; score_rows: number };
  return {
    source: sourceName,
    sourceVersion,
    items: row.items,
    scoreRows: row.score_rows,
    coverage: ratio(row.items, limitedIds?.length ?? catalogItemIds(catalogSource, catalogVersion, undefined).length)
  };
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseRatio(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}
