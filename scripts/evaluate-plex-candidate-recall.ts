import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpus, platform, arch } from "node:os";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import { NoopRanker } from "../src/server/ai/ranker";
import { parseRecommendationIntent } from "../src/server/recommendation/intent";
import { buildRecommendationBrief } from "../src/server/recommendation/brief";
import { retrieveRecommendationCandidates } from "../src/server/recommendation/retrieval";
import { matchesRecommendationFilters, scoreLibraryCandidates } from "../src/server/recommendation/scoring";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { compareFrozenRecall } from "./lib/plexCandidateMetrics";
import type { AvailabilityGroup, SearchFilters } from "../src/shared/types";

// Failure checks: never open a configured DB or network; verify corpus/window
// counts, filter eligibility, and oracle membership independently of rank scores.
// This is a capacity/recall diagnostic, not a representative quality benchmark.
// Only this executable changes the availability channel. Its actual retained
// reservation is asserted after all production retrieval channels and the cap.
class ReservationRepository extends MediaRepository {
  protectedPlexIds: string[] | undefined;
  override availabilityCandidateIds(groups: AvailabilityGroup[], filters: SearchFilters = {}, limit = 120) {
    if (this.protectedPlexIds && groups.length === 1 && groups[0] === "available_in_plex") return this.protectedPlexIds;
    return super.availabilityCandidateIds(groups, filters, limit);
  }
}
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const verifiedRequestable = !process.argv.includes("--unverified-catalogue");
const setupStarted = performance.now();
const db = createDatabase(":memory:");
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Recall evaluation must remain offline"); };
try {
  const repository = new ReservationRepository(db);
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
  if (verifiedRequestable) {
    const verifiedIds = repository.upsertMany(Array.from({ length: 6 }, (_, index) => ({
      ...media(index, "Catalogue observation"), posterPath: "fixture://synthetic-recall",
      seerr: { status: "unknown" as const, requestable: true }
    })));
    assert.deepEqual(verifiedIds, seeds, "Synthetic verification must enrich the existing canonical rows");
  }
  const tables = ["media_items", "genres", "media_features", "catalog_source_records", "catalog_rank_signals",
    "catalog_search_index", "media_feature_fts", "catalog_search_index_fts", ...(verifiedRequestable ? ["seerr_items"] : [])];
  db.exec("BEGIN");
  for (const [seedIndex, seedId] of seeds.entries()) {
    for (const table of tables) {
      const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(row => row.name);
      const key = table === "media_items" ? "id" : "media_item_id";
      const id = `'synthetic:catalog:${seedIndex}:' || n`;
      const title = `'Catalogue observation ${seedIndex} ' || printf('%06d', n)`;
      const values = columns.map(column => column === key || column === "source_item_id" ? id
        : table === "seerr_items" && column === "id" ? `'seerr:' || ${id}`
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
  const allIds = (db.prepare("SELECT id FROM media_items ORDER BY id").all() as { id: string }[]).map(row => row.id);
  // Repository hydration intentionally caps each call at 3,000. Exhaustive
  // diagnostic pools must page rather than silently adopting that window.
  const allItems = allIds.flatMap((_, index) => index % 3000 === 0 ? repository.inflateByIds(allIds.slice(index, index + 3000)) : []);
  const plex = allItems.filter(item => item.availabilityGroup === "available_in_plex");
  const catalogue = allItems.filter(item => item.availabilityGroup !== "available_in_plex");
  assert.equal(plex.length, plexIds.length);
  assert.equal(catalogue.length, 90_000);
  assert.equal(new Set(allItems.map(item => `${item.mediaType}:${item.title}:${item.year}`)).size, allItems.length,
    "Synthetic corpus must already have distinct canonical identities; production dedup still runs in every engine arm");
  const features = new Map(allIds.flatMap((_, index) => index % 3000 === 0 ? [...repository.featureMapByIds(allIds.slice(index, index + 3000))] : []));
  const corpusSha256 = digest(allItems.map(item => ({ id: item.id, title: item.title, year: item.year,
    runtimeMinutes: item.runtimeMinutes, summary: item.summary, genres: item.genres, ratings: item.ratings,
    availability: item.availabilityGroup, featureText: features.get(item.id)?.featureText })));
  const setupMs = performance.now() - setupStarted;
  const engine = new RecommendationEngine(repository, { allowsDescriptiveContent: () => false } as unknown as SeerrClient, new NoopRanker());
  const queries = ["something funny", "a comedy for tonight", "cozy mystery", "something light", "an adventure movie", "a thriller"];
  const policies = ["baseline", 512, 1024, "all"] as const;
  const rows = [];
  for (const query of queries) {
    const intent = parseRecommendationIntent(query);
    const brief = buildRecommendationBrief({ query }, intent, intent.hardFilters, "solo", 10);
    const eligiblePlex = plex.filter(item => matchesRecommendationFilters(item, brief.hardFilters, intent));
    const eligibleCatalogue = catalogue.filter(item => matchesRecommendationFilters(item, brief.hardFilters, intent));
    assert.equal(eligibleCatalogue.length, verifiedRequestable ? 90_000 : 0,
      "Operationally unverified catalogue rows cannot form a relevant eligible denominator");
    const plexSet = new Set(eligiblePlex.map(item => item.id));
    const catalogueSet = new Set(eligibleCatalogue.map(item => item.id));
    const oracleStarted = performance.now();
    // These are frozen exhaustive *scorer* pools. They intentionally carry no
    // policy's retrieval context and are never called independent judgments.
    const oraclePlex = scoreLibraryCandidates(eligiblePlex, query, brief.hardFilters, "solo", { allItems, features }).results.slice(0, 10).map(item => item.id);
    const oracleCatalogue = scoreLibraryCandidates(eligibleCatalogue, query, brief.hardFilters, "solo", { allItems, features }).results.slice(0, 10).map(item => item.id);
    const oracleMs = performance.now() - oracleStarted;
    const reservationOrder = repository.availabilityCandidateIds(["available_in_plex"], brief.hardFilters, 3000).filter(id => plexSet.has(id));
    assert.equal(reservationOrder.length, eligiblePlex.length, "All-Plex experiment requires its eligible population to fit the existing 3,000 bound");
    let baselineWindow = new Set<string>();
    const arms = [];
    for (const policy of policies) {
      repository.protectedPlexIds = policy === "baseline" ? undefined
        : reservationOrder.slice(0, policy === "all" ? reservationOrder.length : policy);
      const retrievalStarted = performance.now();
      const retrieved = await retrieveRecommendationCandidates(repository, brief);
      const retrievalMs = performance.now() - retrievalStarted;
      const window = new Set(retrieved.candidates.filter(item => matchesRecommendationFilters(item, brief.hardFilters, intent)).map(item => item.id));
      assert.equal(new Set(retrieved.candidates.map(item => item.id)).size, retrieved.candidates.length);
      assert.ok(retrieved.candidates.length <= 3000);
      for (const id of repository.protectedPlexIds ?? []) assert.ok(window.has(id), `Reservation truncated: ${policy} ${id}`);
      if (policy === "baseline") baselineWindow = window;
      const started = performance.now();
      let response = await engine.recommend({ query, useAi: false });
      const firstEngineRequestMs = performance.now() - started;
      const samples: number[] = [];
      for (let iteration = 0; iteration < 2; iteration++) {
        const start = performance.now();
        response = await engine.recommend({ query, useAi: false });
        samples.push(performance.now() - start);
        assert.ok(response.results.every(item => window.has(item.id)), "Final engine output must come from the compared eligible window");
      }
      assert.equal(new Set(response.results.map(item => item.id)).size, response.results.length);
      const plexWindow = [...window].filter(id => plexSet.has(id));
      const catalogueWindow = [...window].filter(id => catalogueSet.has(id));
      arms.push({ policy, rawCandidates: retrieved.candidates.length, eligibleCandidates: window.size,
        protectedPlexCount: repository.protectedPlexIds?.length ?? null,
        retainedPlex: plexWindow.length, retainedCatalogue: catalogueWindow.length,
        plexPopulationRecall: eligiblePlex.length ? plexWindow.length / eligiblePlex.length : null,
        cataloguePopulationRecall: eligibleCatalogue.length ? catalogueWindow.length / eligibleCatalogue.length : null,
        diagnosticOraclePlex: compareFrozenRecall(oraclePlex, baselineWindow, window),
        diagnosticOracleCatalogue: compareFrozenRecall(oracleCatalogue, baselineWindow, window),
        allCandidateChanges: { gainedPlex: plexWindow.filter(id => !baselineWindow.has(id)).length,
          lostPlex: [...baselineWindow].filter(id => plexSet.has(id) && !window.has(id)).length,
          gainedCatalogue: catalogueWindow.filter(id => !baselineWindow.has(id)).length,
          lostCatalogue: [...baselineWindow].filter(id => catalogueSet.has(id) && !window.has(id)).length,
          lostCatalogueSample: [...baselineWindow].filter(id => catalogueSet.has(id) && !window.has(id)).slice(0, 10) },
        independentJudgedPlexRecall: null, independentJudgedCatalogueRecall: null, finalNdcgAt3: null,
        finalIds: response.results.map(item => item.id), retrievalMs, firstEngineRequestMs, warmEngineMs: samples });
    }
    repository.protectedPlexIds = undefined;
    rows.push({ query, eligiblePlex: eligiblePlex.length, eligibleCatalogue: eligibleCatalogue.length, oracleMs,
      oraclePoolSha256: digest({ query, oraclePlex, oracleCatalogue }), oraclePlex, oracleCatalogue, arms });
  }
  console.log(JSON.stringify({ schemaVersion: "plex-window-recall-v2", synthetic: true, plexItems: 2000, catalogueItems: 90_000,
    catalogueMode: verifiedRequestable ? "synthetic-verified-requestable" : "legacy-unverified",
    runtime: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model }, corpusSha256,
    limits: { queries: queries.length, policies: policies.length, maximumCandidates: 3000, concurrency: 1,
      firstRequestsPerArm: 1, warmRequestsPerArm: 2, semanticProvider: false, encoderInference: "not run" },
    setupMs, totalMs: performance.now() - setupStarted, memory: process.memoryUsage(),
    limitations: ["Deliberately low Plex popularity; six repeated catalogue archetypes with valid stored feature shapes; no real-library quality inference.",
      "Frozen separate exhaustive Plex/catalogue scorer top tens measure diagnostic agreement, not independent relevance. They omit retrieval-context boosts equally.",
      "No independent judged pool was supplied; independent recall and final NDCG are null, not zero. Oracle overlap is not NDCG.",
      "Default mode adds fake in-memory Seerr verification to make the catalogue eligible. --unverified-catalogue reproduces the original operationally ineligible catalogue stress case and its null catalogue oracle denominator. Neither mode contacts Seerr.",
      "Every policy uses the same in-memory catalogue, repository eligibility, canonical identities, real engine scoring and presentation. Only the experiment-local availability channel differs.",
      "Protected IDs are asserted after the 3,000 cap. All-Plex is only evaluated when the eligible population fits that cap; it is not a general production policy.",
      "Setup and oracle construction are separate. First engine request follows retrieval/oracle work and is not a cold-start measurement; subsequent timings are warm synthetic complete-engine requests.",
      "Finite work bounds are reported, not a service deadline guarantee; no concurrency, real encoder, metadata churn, or private-library performance is measured."], rows }, null, 2));
} finally { db.close(); globalThis.fetch = originalFetch; }
