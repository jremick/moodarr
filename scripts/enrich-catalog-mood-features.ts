import { createDatabase, tryRollbackTransaction } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
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
  batchSize: number;
  limit?: number;
  dryRun: boolean;
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
const summary = enrichCatalogMoodFeatures({ ...args, catalogVersion, sourceVersion });
console.log(JSON.stringify(summary, null, 2));

function parseArgs(values: string[]): Args {
  const parsed: Args = {
    catalogSource: "wikidata",
    source: CATALOG_MOOD_ENRICHMENT_SOURCE,
    rulesVersion: CATALOG_MOOD_ENRICHMENT_RULESET_VERSION,
    batchSize: 2000,
    dryRun: false
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--catalog-source") parsed.catalogSource = values[++index] ?? parsed.catalogSource;
    else if (value === "--catalog-version") parsed.catalogVersion = values[++index];
    else if (value === "--source") parsed.source = values[++index] ?? parsed.source;
    else if (value === "--source-version") parsed.sourceVersion = values[++index];
    else if (value === "--rules-version") parsed.rulesVersion = values[++index] ?? parsed.rulesVersion;
    else if (value === "--batch-size") parsed.batchSize = Math.max(1, parsePositiveInteger(values[++index], parsed.batchSize));
    else if (value === "--limit") parsed.limit = parsePositiveInteger(values[++index], parsed.limit ?? 0);
    else if (value === "--dry-run") parsed.dryRun = true;
  }
  return parsed;
}

function enrichCatalogMoodFeatures(input: Required<Pick<Args, "catalogVersion" | "sourceVersion">> & Args) {
  const items = catalogItems(input.catalogSource, input.catalogVersion, input.limit);
  let enrichedItems = 0;
  let skippedNoScores = 0;
  let scoreRows = 0;
  let nonGenreFeatureItems = 0;
  let pendingWrites = 0;
  let transactionOpen = false;

  const begin = () => {
    if (input.dryRun || transactionOpen) return;
    db.exec("BEGIN");
    transactionOpen = true;
  };
  const commit = () => {
    if (input.dryRun || !transactionOpen) return;
    db.exec("COMMIT");
    transactionOpen = false;
    pendingWrites = 0;
  };
  const rollback = () => {
    if (input.dryRun || !transactionOpen) return;
    tryRollbackTransaction(db);
    transactionOpen = false;
    pendingWrites = 0;
  };

  try {
    for (const item of items) {
      const enrichment = buildCatalogMoodEnrichment(item);
      if (enrichment.scores.length === 0) {
        skippedNoScores += 1;
        if (!input.dryRun) {
          begin();
          repository.upsertMoodFeatureScores(item.id, input.source, input.sourceVersion, []);
          pendingWrites += 1;
          if (pendingWrites >= input.batchSize) commit();
        }
        continue;
      }

      enrichedItems += 1;
      scoreRows += enrichment.scores.length;
      if (enrichment.nonGenreFeatureCount > 0) nonGenreFeatureItems += 1;
      if (!input.dryRun) {
        begin();
        repository.upsertMoodFeatureScores(item.id, input.source, input.sourceVersion, enrichment.scores);
        pendingWrites += 1;
        if (pendingWrites >= input.batchSize) commit();
      }
    }
    commit();
  } catch (error) {
    rollback();
    throw error;
  }

  return {
    source: input.source,
    sourceVersion: input.sourceVersion,
    rulesVersion: input.rulesVersion,
    catalogSource: input.catalogSource,
    catalogVersion: input.catalogVersion,
    catalogItems: items.length,
    enrichedItems,
    skippedNoScores,
    scoreRows,
    nonGenreFeatureItems,
    coverage: ratio(enrichedItems, items.length),
    nonGenreCoverage: ratio(nonGenreFeatureItems, items.length),
    dryRun: input.dryRun,
    batchSize: input.batchSize,
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

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function ratio(numerator: number, denominator: number) {
  return denominator > 0 ? Number((numerator / denominator).toFixed(4)) : 0;
}
