import { performance } from "node:perf_hooks";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import { NoopRanker } from "../src/server/ai/ranker";
import { reviewCandidateRankingExperiments } from "../src/server/recommendation/rankingExperiments";
import type { SeerrClient } from "../src/server/integrations/seerrClient";

// Fixed synthetic mechanical workload only: no private catalogue, model or network.
const db = createDatabase(":memory:");
const repository = new MediaRepository(db);
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("synthetic_benchmark_must_be_offline"); };
try {
  const descriptions = [
    { summary: "A warm comedy about gentle friendship and dry witty conversations.", genres: ["Comedy"] },
    { summary: "A tense, grounded mystery with quiet suspense and an intricate investigation.", genres: ["Mystery", "Drama"] },
    { summary: "A thoughtful science fiction adventure about discovery and wonder.", genres: ["Science Fiction", "Adventure"] }
  ];
  repository.upsertMany(Array.from({ length: 750 }, (_, i) => ({ title: `Synthetic performance record ${String(i).padStart(4, "0")}`,
    ...descriptions[i % descriptions.length], mediaType: "movie" as const, year: 1990 + i % 35, runtimeMinutes: 85 + i % 50,
    contentRating: "PG-13", ratings: { critic: 65 + i % 30 }, plex: { available: true, ratingKey: String(i) } })));
  const seerr = { allowsDescriptiveContent: () => false } as unknown as SeerrClient;
  const baseline = new RecommendationEngine(repository, seerr, new NoopRanker());
  const candidate = new RecommendationEngine(repository, seerr, new NoopRanker(), undefined, undefined, undefined, undefined, undefined, undefined, reviewCandidateRankingExperiments);
  const queries = ["warm comedy", "quiet mystery", "thoughtful adventure", "gentle story under 110 minutes", "not surreal, something offbeat", "I am tired; help me unwind"];
  for (const engine of [baseline, candidate]) for (const query of queries.slice(0, 2)) await engine.recommend({ query, useAi: false, resultLimit: 10 });
  const observations = { default: [] as number[], candidate: [] as number[] };
  let peakRss = process.memoryUsage().rss;
  // Alternate order to reduce systematic warmup/order bias; not a production SLA.
  for (let repeat = 0; repeat < 4; repeat += 1) for (const query of queries) {
    const arms = repeat % 2 ? [["candidate", candidate], ["default", baseline]] as const : [["default", baseline], ["candidate", candidate]] as const;
    for (const [name, engine] of arms) {
      const start = performance.now();
      await engine.recommend({ query, useAi: false, resultLimit: 10 });
      observations[name].push(performance.now() - start);
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }
  }
  const summarize = (values: number[]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return { samples: sorted.length, p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maximumMs: sorted.at(-1) };
  };
  console.log(JSON.stringify({ scope: "synthetic-750-record-final-engine-no-ai-no-learned-profile", node: process.version,
    platform: process.platform, architecture: process.arch, catalogueRecords: repository.count(), peakProcessRssBytes: peakRss,
    default: summarize(observations.default), candidate: summarize(observations.candidate), productionLatencyEstablished: false }, null, 2));
} finally { globalThis.fetch = originalFetch; db.close(); }
