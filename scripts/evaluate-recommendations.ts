import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { fixturePlexItems, fixtureSeerrItems } from "../src/server/fixtures/media";
import { NoopRanker } from "../src/server/ai/ranker";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import { evaluateRecommendationResults, goldenRecommendationCases } from "../src/server/recommendation/evaluation";
import type { SeerrClient } from "../src/server/integrations/seerrClient";

const db = createDatabase(":memory:");
const repository = new MediaRepository(db);
repository.upsertMany([...fixturePlexItems, ...fixtureSeerrItems]);

const seerrClient = {
  async search() {
    return fixtureSeerrItems;
  }
} as unknown as SeerrClient;

const engine = new RecommendationEngine(repository, seerrClient, new NoopRanker());
const outputs = new Map();

for (const testCase of goldenRecommendationCases) {
  const response = await engine.recommend({
    query: testCase.query,
    watchContext: testCase.watchContext,
    resultLimit: 10,
    useAi: false
  });
  outputs.set(testCase.id, response.results);
}

const result = evaluateRecommendationResults(goldenRecommendationCases, outputs);
console.log(JSON.stringify(result, null, 2));
if (result.failures.length > 0) {
  process.exitCode = 1;
}
