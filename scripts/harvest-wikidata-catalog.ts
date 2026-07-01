import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { WikidataCatalogRecord } from "../src/server/catalog/wikidataCatalogImporter";

interface Args {
  output: string;
  movieLimit: number;
  tvLimit: number;
  pageSize: number;
  minSitelinks: number;
  sleepMs: number;
  endpoint: string;
  includeGenres: boolean;
  retries: number;
  timeoutMs: number;
}

interface SparqlBinding {
  value: string;
}

interface SparqlRow {
  item?: SparqlBinding;
  itemLabel?: SparqlBinding;
  itemDescription?: SparqlBinding;
  publicationDate?: SparqlBinding;
  imdbId?: SparqlBinding;
  tmdbMovieId?: SparqlBinding;
  tmdbTvId?: SparqlBinding;
  tvdbId?: SparqlBinding;
  sitelinkCount?: SparqlBinding;
  hasEnglishWikipedia?: SparqlBinding;
  genreLabels?: SparqlBinding;
}

interface SparqlResponse {
  results?: {
    bindings?: SparqlRow[];
  };
}

const userAgent = "MoodarrCatalogAlpha/0.1 (https://github.com/jremick/feelerr-app; local alpha catalog import)";
const args = parseArgs(process.argv.slice(2));
const records: WikidataCatalogRecord[] = [];

for (const mediaType of ["movie", "tv"] as const) {
  const limit = mediaType === "movie" ? args.movieLimit : args.tvLimit;
  for (let offset = 0; offset < limit; offset += args.pageSize) {
    const pageLimit = Math.min(args.pageSize, limit - offset);
    const rows = await queryWikidata(mediaType, pageLimit, offset);
    records.push(...rows.map((row) => toCatalogRecord(mediaType, row)).filter((record): record is WikidataCatalogRecord => Boolean(record)));
    console.error(`${mediaType}: fetched ${rows.length} rows at offset ${offset}; total records ${records.length}`);
    if (rows.length < pageLimit) break;
    if (args.sleepMs > 0) await sleep(args.sleepMs);
  }
}

mkdirSync(dirname(args.output), { recursive: true });
const dedupedRecords = dedupeRecords(records);
writeFileSync(args.output, `${dedupedRecords.map((record) => JSON.stringify(record)).join("\n")}\n`);
console.log(JSON.stringify({ output: args.output, records: dedupedRecords.length, rawRecords: records.length, movieLimit: args.movieLimit, tvLimit: args.tvLimit, minSitelinks: args.minSitelinks }, null, 2));

async function queryWikidata(mediaType: "movie" | "tv", limit: number, offset: number): Promise<SparqlRow[]> {
  return queryWikidataWithRetries(mediaType, limit, offset, args.retries);
}

async function queryWikidataWithRetries(mediaType: "movie" | "tv", limit: number, offset: number, retriesRemaining: number): Promise<SparqlRow[]> {
  const url = new URL(args.endpoint);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs);
  const body = new URLSearchParams({
    query: buildQuery(mediaType, limit, offset),
    format: "json"
  });
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      body,
      signal: controller.signal,
      headers: {
        "Accept": "application/sparql-results+json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": userAgent
      }
    });
  } catch (error) {
    if (retriesRemaining > 0) {
      await sleep(Math.max(args.sleepMs, 2000));
      return queryWikidataWithRetries(mediaType, limit, offset, retriesRemaining - 1);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  if (!response.ok) {
    const responseBody = await response.text();
    if (retriesRemaining > 0 && [429, 500, 502, 503, 504].includes(response.status)) {
      await sleep(retryDelayMs(response) ?? Math.max(args.sleepMs, 2000));
      return queryWikidataWithRetries(mediaType, limit, offset, retriesRemaining - 1);
    }
    throw new Error(`Wikidata query failed: ${response.status} ${response.statusText}: ${responseBody.slice(0, 500)}`);
  }
  const json = await response.json() as SparqlResponse;
  return json.results?.bindings ?? [];
}

function retryDelayMs(response: Response) {
  const retryAfter = response.headers.get("retry-after");
  if (!retryAfter) return undefined;
  const seconds = Number(retryAfter);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;
}

function buildQuery(mediaType: "movie" | "tv", limit: number, offset: number) {
  const classClause = mediaType === "movie"
    ? "?item wdt:P31/wdt:P279* wd:Q11424;"
    : "?item wdt:P31/wdt:P279* wd:Q5398426;";
  const tmdbClause = mediaType === "movie"
    ? "OPTIONAL { ?item wdt:P4947 ?tmdbMovieIdValue. }"
    : `OPTIONAL { ?item wdt:P4983 ?tmdbTvIdValue. }
  OPTIONAL { ?item wdt:P4835 ?tvdbIdValue. }`;
  const aggregateIds = mediaType === "movie" ? "(SAMPLE(?tmdbMovieIdValue) AS ?tmdbMovieId)" : "(SAMPLE(?tmdbTvIdValue) AS ?tmdbTvId) (SAMPLE(?tvdbIdValue) AS ?tvdbId)";
  const genreSelect = args.includeGenres ? `(GROUP_CONCAT(DISTINCT ?genreLabel; separator="|") AS ?genreLabels)` : "";
  const genreClause = args.includeGenres
    ? `OPTIONAL { ?item wdt:P136 ?genre. }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". ?item rdfs:label ?itemLabel. ?item schema:description ?itemDescription. ?genre rdfs:label ?genreLabel. }`
    : `SERVICE wikibase:label { bd:serviceParam wikibase:language "en". ?item rdfs:label ?itemLabel. ?item schema:description ?itemDescription. }`;
  const groupClause = `GROUP BY ?item ?itemLabel ?itemDescription ?sitelinkCount ?hasEnglishWikipedia`;

  return `SELECT ?item ?itemLabel ?itemDescription (MIN(?publicationDateValue) AS ?publicationDate) (SAMPLE(?imdbIdValue) AS ?imdbId) ${aggregateIds} ?sitelinkCount ?hasEnglishWikipedia ${genreSelect} WHERE {
  ${classClause}
        wikibase:sitelinks ?sitelinkCount.
  FILTER(?sitelinkCount >= ${args.minSitelinks})
  BIND(EXISTS { ?article schema:about ?item; schema:isPartOf <https://en.wikipedia.org/>. } AS ?hasEnglishWikipedia)
  OPTIONAL { ?item wdt:P577 ?publicationDateValue. }
  OPTIONAL { ?item wdt:P345 ?imdbIdValue. FILTER(STRSTARTS(?imdbIdValue, "tt")) }
  ${tmdbClause}
  ${genreClause}
  FILTER(!REGEX(STR(?itemLabel), "^Q[0-9]+$"))
}
${groupClause}
ORDER BY DESC(?sitelinkCount) ?item
LIMIT ${limit}
OFFSET ${offset}`;
}

function toCatalogRecord(mediaType: "movie" | "tv", row: SparqlRow): WikidataCatalogRecord | undefined {
  const id = row.item?.value.match(/Q\d+$/)?.[0];
  const label = cleanText(row.itemLabel?.value);
  if (!id || !label) return undefined;
  return {
    id,
    mediaType: mediaType === "movie" ? "film" : "television series",
    label,
    description: cleanText(row.itemDescription?.value),
    publicationDate: row.publicationDate?.value,
    genreLabels: splitLabels(row.genreLabels?.value),
    imdbId: cleanText(row.imdbId?.value),
    tmdbMovieId: cleanText(row.tmdbMovieId?.value),
    tmdbTvId: cleanText(row.tmdbTvId?.value),
    tvdbId: cleanText(row.tvdbId?.value),
    sitelinkCount: row.sitelinkCount?.value,
    hasEnglishWikipedia: row.hasEnglishWikipedia?.value === "true"
  };
}

function splitLabels(value: string | undefined) {
  return [...new Set((value ?? "").split("|").map(cleanText).filter((entry): entry is string => Boolean(entry)))];
}

function dedupeRecords(values: WikidataCatalogRecord[]) {
  const records = new Map<string, WikidataCatalogRecord>();
  for (const value of values) {
    const key = `${value.mediaType}:${value.id ?? value.wikidataId ?? value.qid}`;
    if (!records.has(key)) records.set(key, value);
  }
  return [...records.values()];
}

function cleanText(value: string | undefined) {
  const cleaned = value?.trim();
  return cleaned ? cleaned : undefined;
}

function parseArgs(values: string[]): Args {
  const parsed: Args = {
    output: ".data/wikidata-mainstream-alpha.jsonl",
    movieLimit: 5000,
    tvLimit: 2500,
    pageSize: 250,
    minSitelinks: 8,
    sleepMs: 1200,
    endpoint: "https://query.wikidata.org/sparql",
    includeGenres: false,
    retries: 2,
    timeoutMs: 65000
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--output") parsed.output = resolveRequired(values[++index], "output");
    else if (value === "--movie-limit") parsed.movieLimit = parseNonNegativeInteger(values[++index], parsed.movieLimit);
    else if (value === "--tv-limit") parsed.tvLimit = parseNonNegativeInteger(values[++index], parsed.tvLimit);
    else if (value === "--page-size") parsed.pageSize = Math.max(1, Math.min(500, parseNonNegativeInteger(values[++index], parsed.pageSize)));
    else if (value === "--min-sitelinks") parsed.minSitelinks = parseNonNegativeInteger(values[++index], parsed.minSitelinks);
    else if (value === "--sleep-ms") parsed.sleepMs = parseNonNegativeInteger(values[++index], parsed.sleepMs);
    else if (value === "--endpoint") parsed.endpoint = resolveRequired(values[++index], "endpoint");
    else if (value === "--include-genres") parsed.includeGenres = true;
    else if (value === "--retries") parsed.retries = parseNonNegativeInteger(values[++index], parsed.retries);
    else if (value === "--timeout-ms") parsed.timeoutMs = Math.max(1000, parseNonNegativeInteger(values[++index], parsed.timeoutMs));
  }
  parsed.output = resolve(parsed.output);
  return parsed;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolveRequired(value: string | undefined, label: string) {
  if (!value?.trim()) throw new Error(`Missing ${label}.`);
  return value;
}

function sleep(ms: number) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}
