import assert from "node:assert/strict";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import { NoopRanker } from "../src/server/ai/ranker";
import { parseRecommendationIntent } from "../src/server/recommendation/intent";
import { buildRecommendationBrief } from "../src/server/recommendation/brief";
import { retrieveRecommendationCandidates } from "../src/server/recommendation/retrieval";
import { matchesRecommendationFilters, scoreLibraryCandidates } from "../src/server/recommendation/scoring";
import type { SeerrClient } from "../src/server/integrations/seerrClient";

// Failure checks: never open a configured DB or network; verify corpus/window
// counts, filter eligibility, and oracle membership independently of rank scores.
// This is a capacity/recall diagnostic, not a representative quality benchmark.
const db = createDatabase(":memory:");
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Recall evaluation must remain offline"); };
try {
  const repository = new MediaRepository(db);
  const genres = ["Comedy", "Mystery", "Adventure", "Thriller", "Romance", "Drama"];
  const summaries = ["A funny comedy about daily life.", "A cozy mystery about an investigation.", "A lively adventure across a landscape.",
    "A tense thriller about a dangerous pursuit.", "A light and gentle romantic story.", "An observer records changing patterns."];
  const media = (index: number, prefix: string) => ({ title: `${prefix} ${String(index).padStart(6, "0")}`, mediaType: "movie" as const,
    year: 2000 + index % 25, runtimeMinutes: 85 + index % 45, genres: [genres[index % genres.length]],
    summary: summaries[index % summaries.length], ratings: { critic: 5 + (index % 501) / 100 } });
  const plexIds = repository.upsertMany(Array.from({ length: 2000 }, (_, index) => ({ ...media(index, "Library observation"),
    plex: { available: true, ratingKey: `synthetic-${index}`, libraryTitle: "Synthetic", libraryType: "movie" } })));
  // Seed valid repository shapes, then replicate six synthetic archetypes in
  // SQLite. This measures retrieval rather than 90k individual ingest calls.
  const seeds = repository.upsertCatalogRecords(Array.from({ length: 6 }, (_, index) => ({
    source: "synthetic-recall", sourceVersion: "v1", sourceItemId: `seed-${index}`, licensePolicy: "synthetic",
    mainstreamScore: 90 + index, metadataConfidence: 1, media: media(index, "Catalogue observation")
  })));
  const tables = ["media_items", "genres", "media_features", "catalog_source_records", "catalog_rank_signals",
    "catalog_search_index", "media_feature_fts", "catalog_search_index_fts"];
  db.exec("BEGIN");
  for (const [seedIndex, seedId] of seeds.entries()) {
    for (const table of tables) {
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);
      const key = table === "media_items" ? "id" : "media_item_id";
      const id = `'synthetic:catalog:${seedIndex}:' || n`;
      const title = `'Catalogue observation ${seedIndex} ' || printf('%06d', n)`;
      const values = columns.map(column => column === key || column === "source_item_id" ? id
        : column === "title" ? title : column === "normalized_title" ? `lower(${title})` : `s."${column}"`);
      db.prepare(`WITH RECURSIVE copies(n) AS (VALUES(1) UNION ALL SELECT n + 1 FROM copies WHERE n < 14999)
        INSERT INTO ${table} (${columns.map(column => `"${column}"`).join(",")})
        SELECT ${values.join(",")} FROM ${table} s CROSS JOIN copies WHERE s.${key} = ?`).run(seedId);
    }
  }
  db.exec("COMMIT");
  db.prepare("UPDATE catalog_search_index SET rank_score = 0 WHERE availability_group = 'available_in_plex'").run();
  assert.equal(repository.count(), 92_000);
  assert.equal(repository.catalogSearchIndexCount(), 92_000);
  const plex = repository.inflateByIds(plexIds);
  assert.equal(plex.length, 2000);
  const features = repository.featureMapByIds(plexIds);
  const engine = new RecommendationEngine(repository, { allowsDescriptiveContent: () => false } as unknown as SeerrClient, new NoopRanker());
  const queries = ["something funny", "a comedy for tonight", "cozy mystery", "something light", "an adventure movie", "a thriller"];
  const rows = [], timings: number[] = [];
  for (const query of queries) {
    const intent = parseRecommendationIntent(query);
    const brief = buildRecommendationBrief({ query }, intent, intent.hardFilters, "solo", 10);
    const retrieved = await retrieveRecommendationCandidates(repository, brief);
    const window = new Set(retrieved.candidates.map(item => item.id));
    assert.ok(window.size <= 3000);
    const eligible = plex.filter(item => matchesRecommendationFilters(item, brief.hardFilters, intent));
    const oracle = scoreLibraryCandidates(eligible, query, brief.hardFilters, "solo", { allItems: eligible, features }).results.slice(0, 10);
    const retained = eligible.filter(item => window.has(item.id)).length;
    const oracleHits = oracle.filter(item => window.has(item.id)).length;
    const samples: number[] = [];
    await engine.recommend({ query, useAi: false });
    for (let iteration = 0; iteration < 5; iteration++) {
      const start = performance.now();
      await engine.recommend({ query, useAi: false });
      samples.push(performance.now() - start);
    }
    timings.push(...samples);
    rows.push({ query, candidates: window.size, eligiblePlex: eligible.length, retainedPlex: retained,
      eligiblePlexShare: retained / eligible.length, oracleTopTenCount: oracle.length, oracleTopTenRetained: oracleHits,
      oracleTopTenRecall: oracle.length ? oracleHits / oracle.length : null, engineMs: samples });
  }
  timings.sort((a, b) => a - b);
  console.log(JSON.stringify({ schemaVersion: "plex-window-recall-v1", synthetic: true, plexItems: 2000, catalogueItems: 90_000,
    iterationsPerQuery: 5, p50Ms: timings[Math.ceil(timings.length * 0.5) - 1], p95Ms: timings[Math.ceil(timings.length * 0.95) - 1],
    limitations: ["Deliberately low Plex popularity; six repeated catalogue archetypes with valid stored feature shapes; no real-library quality inference.",
      "Oracle ranks all eligible Plex items with deterministic scorer inputs, not independent relevance judgments.",
      "No candidate reservation policy changed; cold construction time is excluded from warm engine timings."], rows }, null, 2));
} finally { db.close(); globalThis.fetch = originalFetch; }
