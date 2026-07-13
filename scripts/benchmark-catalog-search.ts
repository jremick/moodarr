import { performance } from "node:perf_hooks";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { NoopRanker } from "../src/server/ai/ranker";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import { buildRecommendationBrief } from "../src/server/recommendation/brief";
import { mergeHardFilters, parseRecommendationIntent } from "../src/server/recommendation/intent";
import { scoreRankIndexedLibrary } from "../src/server/recommendation/rankIndex";
import { retrieveRecommendationCandidates } from "../src/server/recommendation/retrieval";
import { loadConfig } from "../src/server/config";
import type { SearchRequest, WatchContext } from "../src/shared/types";
import type { SeerrClient } from "../src/server/integrations/seerrClient";

interface BenchmarkCase {
  id: string;
  query: string;
  watchContext: WatchContext;
  filters?: SearchRequest["filters"];
}

interface Args {
  limit?: number;
  skipEngine: boolean;
}

interface TimingSample {
  caseId: string;
  query: string;
  retrievalMs: number;
  scoringMs: number;
  totalLocalMs: number;
  engineMs?: number;
  engineStageLatencyMs?: Record<string, number>;
  candidateCount: number;
  scoredItemCount: number;
  resultCount: number;
  topResults: string[];
}

const benchmarkCases: BenchmarkCase[] = [
  { id: "cozy-fantasy", query: "cozy gentle fantasy adventure not scary", watchContext: "solo" },
  { id: "shows-not-scary", query: "shows that are clever and not scary", watchContext: "group", filters: { mediaTypes: ["tv"] } },
  { id: "requestable-fantasy", query: "requestable gentle fantasy adventure only, not already available", watchContext: "solo" },
  { id: "low-commitment-comedy", query: "low commitment warm comedy for a tired weeknight", watchContext: "solo" },
  { id: "dark-detective", query: "grounded detective mystery with quiet tension", watchContext: "solo" },
  { id: "family-warm", query: "warm family-safe movie with gentle stakes", watchContext: "group" },
  { id: "weird-offbeat", query: "weird offbeat comedy with heart", watchContext: "solo" },
  { id: "romantic-date", query: "romantic date night movie that is not too heavy", watchContext: "group" },
  { id: "classic-sci-fi", query: "classic thoughtful sci-fi movie", watchContext: "solo" },
  { id: "british-comedy", query: "classic british comedy requestable", watchContext: "solo" },
  { id: "short-tv", query: "short easy tv episodes for background watching", watchContext: "solo", filters: { mediaTypes: ["tv"] } },
  { id: "not-animation", query: "live action adventure not animation", watchContext: "group", filters: { excludedGenres: ["Animation"] } },
  { id: "no-horror", query: "suspenseful mystery but no horror", watchContext: "solo", filters: { excludedGenres: ["Horror"] } },
  { id: "plex-only", query: "plex only light movie, no requestable options", watchContext: "solo", filters: { availability: ["available_in_plex"] } },
  { id: "requestable-not-plex", query: "requestable fantasy adventure not in Plex", watchContext: "solo", filters: { availability: ["not_in_plex_requestable"] } },
  { id: "comfort-tv", query: "comforting sitcom with low friction", watchContext: "group", filters: { mediaTypes: ["tv"] } },
  { id: "intense-thriller", query: "intense thriller with smart plotting", watchContext: "solo" },
  { id: "heartfelt-animation", query: "heartfelt animated family adventure", watchContext: "group", filters: { mediaTypes: ["movie"] } },
  { id: "surprise-cozy", query: "surprise me with something cozy and emotionally sincere", watchContext: "solo" },
  { id: "older-classic", query: "older classic movie with gentle humor", watchContext: "solo", filters: { maxYear: 1985 } },
  { id: "newer-series", query: "newer clever tv series not too dark", watchContext: "solo", filters: { mediaTypes: ["tv"], minYear: 2015 } },
  { id: "group-friendly", query: "group friendly crowd pleaser with adventure", watchContext: "group" },
  { id: "quiet-drama", query: "quiet sincere drama with warmth", watchContext: "solo" },
  { id: "fantasy-like-stardust", query: "more like Stardust but gentler", watchContext: "solo" },
  { id: "not-scary-fantasy-shows", query: "not scary fantasy shows with adventure", watchContext: "group", filters: { mediaTypes: ["tv"], excludedGenres: ["Horror"] } }
];

const args = parseArgs(process.argv.slice(2));
const selectedCases = benchmarkCases.slice(0, args.limit ?? benchmarkCases.length);
const config = loadConfig();
const db = createDatabase(config.dbPath);
const repository = new MediaRepository(db);
const indexStartedAt = performance.now();
const searchableMediaItemCount = (
  db.prepare("SELECT COUNT(*) AS value FROM media_items WHERE source != 'operational'").get() as { value: number }
).value;
const existingIndexCount = repository.catalogSearchIndexCount();
const existingFtsIndexCount = (
  db.prepare("SELECT COUNT(*) AS value FROM catalog_search_index_fts").get() as { value: number }
).value;
const indexNeedsRebuild = existingIndexCount !== searchableMediaItemCount || existingFtsIndexCount !== existingIndexCount;
const rebuiltIndexCount = indexNeedsRebuild ? repository.rebuildCatalogSearchIndex() : existingIndexCount;
const rebuiltFtsIndexCount = (
  db.prepare("SELECT COUNT(*) AS value FROM catalog_search_index_fts").get() as { value: number }
).value;
const indexBuildMs = performance.now() - indexStartedAt;
const seerrClient = { async search() { return []; } } as unknown as SeerrClient;
const engine = new RecommendationEngine(repository, seerrClient, new NoopRanker());
const samples: TimingSample[] = [];

for (const testCase of selectedCases) {
  const request: SearchRequest = {
    query: testCase.query,
    watchContext: testCase.watchContext,
    filters: testCase.filters,
    resultLimit: 10,
    useAi: false
  };
  const intent = parseRecommendationIntent(testCase.query);
  const filters = mergeHardFilters(intent.hardFilters, testCase.filters ?? {});
  const brief = buildRecommendationBrief({ ...request, filters }, intent, filters, testCase.watchContext, 10);

  const retrievalStartedAt = performance.now();
  const retrieved = await retrieveRecommendationCandidates(repository, brief);
  const retrievalMs = performance.now() - retrievalStartedAt;

  const scoringStartedAt = performance.now();
  const scored = scoreRankIndexedLibrary(retrieved, request, testCase.watchContext);
  const scoringMs = performance.now() - scoringStartedAt;

  let engineMs: number | undefined;
  let engineStageLatencyMs: Record<string, number> | undefined;
  if (!args.skipEngine) {
    const engineStartedAt = performance.now();
    const response = await engine.recommend(request);
    engineMs = performance.now() - engineStartedAt;
    engineStageLatencyMs = response.diagnostics?.stageLatencyMs;
  }

  samples.push({
    caseId: testCase.id,
    query: testCase.query,
    retrievalMs: round(retrievalMs),
    scoringMs: round(scoringMs),
    totalLocalMs: round(retrievalMs + scoringMs),
    engineMs: engineMs === undefined ? undefined : round(engineMs),
    engineStageLatencyMs,
    candidateCount: retrieved.candidates.length,
    scoredItemCount: scored.results.length,
    resultCount: scored.results.slice(0, 10).length,
    topResults: scored.results.slice(0, 5).map((item) => `${item.title}${item.year ? ` (${item.year})` : ""}`)
  });
}

const retrievalValues = samples.map((sample) => sample.retrievalMs);
const scoringValues = samples.map((sample) => sample.scoringMs);
const localValues = samples.map((sample) => sample.totalLocalMs);
const engineValues = samples.flatMap((sample) => (sample.engineMs === undefined ? [] : [sample.engineMs]));
const diagnostics = repository.recommendationDiagnostics();
const stats = repository.stats();

console.log(JSON.stringify(
  {
    generatedAt: new Date().toISOString(),
    dbPath: config.dbPath,
    caseCount: samples.length,
    itemCount: stats.totalItems,
    catalogSearchIndex: {
      before: existingIndexCount,
      beforeFts: existingFtsIndexCount,
      after: rebuiltIndexCount,
      afterFts: rebuiltFtsIndexCount,
      searchableItemCount: searchableMediaItemCount,
      rebuilt: indexNeedsRebuild,
      rebuildMs: round(indexBuildMs)
    },
    catalog: diagnostics.features.catalog,
    target: {
      localNoAiP50Ms: 250,
      localNoAiP95Ms: 750,
      apiCachedNoRemoteP95Ms: 1000,
      apiBoundedSeerrP95Ms: 2000
    },
    summary: {
      retrieval: summarize(retrievalValues),
      scoring: summarize(scoringValues),
      localRetrievalAndScoring: summarize(localValues),
      apiNoAiNoRemote: engineValues.length > 0 ? summarize(engineValues) : undefined
    },
    targetStatus: {
      localNoAiP50: percentile(localValues, 0.5) <= 250 ? "pass" : "fail",
      localNoAiP95: percentile(localValues, 0.95) <= 750 ? "pass" : "fail",
      apiCachedNoRemoteP95: engineValues.length === 0 ? "skipped" : percentile(engineValues, 0.95) <= 1000 ? "pass" : "fail"
    },
    samples
  },
  null,
  2
));

function parseArgs(values: string[]): Args {
  const parsed: Args = { skipEngine: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--limit") parsed.limit = parsePositiveInteger(values[++index]);
    if (value === "--skip-engine") parsed.skipEngine = true;
  }
  return parsed;
}

function parsePositiveInteger(value: string | undefined) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function summarize(values: number[]) {
  return {
    min: round(Math.min(...values)),
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    max: round(Math.max(...values))
  };
}

function percentile(values: number[], percentileValue: number) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1);
  return sorted[index];
}

function round(value: number) {
  return Math.round(value * 10) / 10;
}
