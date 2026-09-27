import { writeFileSync } from "node:fs";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { fixturePlexItems, fixtureSeerrItems } from "../src/server/fixtures/media";
import { syntheticAdversarialEvalCatalog, syntheticPersonaReleaseCatalog, syntheticProfileEvalCatalog } from "../src/server/recommendation/profileEvalFixtures";
import { structuralCatalog } from "../tests/fixtures/moodrankStructuralCatalog";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import { NoopRanker } from "../src/server/ai/ranker";
import { cosineSimilarity } from "../src/server/recommendation/features";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import type { ItemSummary, SearchFilters } from "../src/shared/types";

// This diagnostic adds evidence. It does not reclassify or replace release gates.
const catalogues = { structural: structuralCatalog, golden: [...fixturePlexItems, ...fixtureSeerrItems],
  adversarial: syntheticAdversarialEvalCatalog, profile: syntheticProfileEvalCatalog, persona: syntheticPersonaReleaseCatalog };
const queries = ["something funny", "a comedy for tonight", "cozy mystery", "something light", "an adventure movie", "a thriller"];
const facets = { horror: "Horror", animated: "Animation", romance: "Romance", war: "War", crime: "Crime", comedy: "Comedy" };
const variants = [(q: string, x: string) => `${q}, not ${x}`, (q: string, x: string) => `${q} but nothing ${x}`,
  (q: string, x: string) => `I don't like ${x}, ${q}`, (q: string, x: string) => `${q} without ${x}`,
  (q: string, x: string) => `no ${x}, ${q}`, (q: string, x: string) => `${q}, anything but ${x}`];
const selected = process.argv.includes("--structural") ? ["structural"] : Object.keys(catalogues);
const failures: { id: string; family: string; blocking: boolean }[] = [];
let checks = 0, searches = 0, tiedTopFive = 0;
const latencies: number[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Invariant evaluation must remain offline"); };
const check = (id: string, family: string, passed: boolean, blocking = false) => { checks++; if (!passed) failures.push({ id, family, blocking }); };
const rank = (items: ItemSummary[], id: string) => { const index = items.findIndex(item => item.id === id); return index < 0 ? Infinity : index; };
try {
  for (const name of selected) {
    const db = createDatabase(":memory:");
    try {
      const repository = new MediaRepository(db);
      repository.upsertMany(catalogues[name as keyof typeof catalogues]);
      const engine = new RecommendationEngine(repository, { allowsDescriptiveContent: () => false } as unknown as SeerrClient, new NoopRanker());
      const featureMap = repository.featureMap();
      const search = async (query: string, filters?: SearchFilters) => {
        const start = performance.now();
        const response = await engine.recommend({ query, filters, resultLimit: 10, useAi: false });
        latencies.push(performance.now() - start); searches++;
        const scores = response.results.slice(0, 5).map(item => item.score);
        if (new Set(scores).size < scores.length) tiedTopFive++;
        const f = response.resolvedFilters;
        check(`${name}:hard:${searches}`, "INV-HARD", response.results.every(item =>
          (!f.excludedGenres?.some(genre => item.genres.includes(genre))) &&
          (!f.availability?.length || f.availability.includes(item.availabilityGroup)) &&
          (f.minRuntimeMinutes === undefined || (item.runtimeMinutes ?? -Infinity) >= f.minRuntimeMinutes) &&
          (f.maxRuntimeMinutes === undefined || (item.runtimeMinutes ?? Infinity) <= f.maxRuntimeMinutes) &&
          (f.minYear === undefined || (item.year ?? -Infinity) >= f.minYear) &&
          (f.maxYear === undefined || (item.year ?? Infinity) <= f.maxYear)), true);
        return response.results;
      };
      for (const [qi, query] of queries.entries()) {
        const base = await search(query);
        for (const [facet, genre] of Object.entries(facets)) {
          if ((genre === "Comedy" && /funny|comedy/.test(query)) || (genre === "Crime" && /crime/.test(query))) continue;
          for (const [vi, variant] of variants.entries()) {
            const results = await search(variant(query, facet));
            for (const k of [5, 10]) {
              const xItems = results.slice(0, k).filter(item => item.genres.includes(genre));
              const passed = xItems.length <= base.slice(0, k).filter(item => item.genres.includes(genre)).length
                && xItems.every(item => rank(results, item.id) >= rank(base, item.id));
              check(`${name}:q${qi}:${facet}:v${vi}:k${k}`, "INV-NEG", passed);
            }
          }
        }
        const reference = base[0];
        if (reference) {
          const vector = featureMap.get(reference.id)?.vector;
          const sibling = vector ? [...featureMap].filter(([id]) => id !== reference.id)
            .sort((a, b) => cosineSimilarity(vector, b[1].vector) - cosineSimilarity(vector, a[1].vector) || a[0].localeCompare(b[0]))[0]?.[0] : undefined;
          const less = await search(`${query}. Less like ${reference.title}.`);
          check(`${name}:q${qi}:reference`, "INV-LESS", rank(less, reference.id) > rank(base, reference.id));
          if (sibling) {
            // Relative-rank movement is diagnostic, not a universal score-sign invariant.
            check(`${name}:q${qi}:sibling`, "LESS-SIBLING-DIAGNOSTIC", rank(less, sibling) >= rank(base, sibling));
            const more = await search(`${query}. More like ${reference.title}.`);
            check(`${name}:q${qi}:sibling`, "MORE-SIBLING-DIAGNOSTIC", rank(more, sibling) <= rank(base, sibling));
          }
        }
        await search(query, { excludedGenres: ["Horror"], availability: ["available_in_plex"], minRuntimeMinutes: 60, maxRuntimeMinutes: 110, minYear: 2000, maxYear: 2025 });
      }
    } finally { db.close(); }
  }
} finally { globalThis.fetch = originalFetch; }
latencies.sort((a, b) => a - b);
const report = { schemaVersion: 1, scope: "synthetic final engine responses; no quality or promotion claim", catalogues: selected,
  checks, searches, tiedTopFive, blockingFailures: failures.filter(f => f.blocking).length, failures,
  latencyMs: { p50: latencies[Math.floor(latencies.length * 0.5)], p95: latencies[Math.floor(latencies.length * 0.95)] } };
const output = process.argv.find(arg => arg.startsWith("--output="))?.slice(9);
if (output) writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify(report, null, 2));
if (report.blockingFailures) process.exitCode = 1;
