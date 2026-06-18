import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { fixturePlexItems, fixtureSeerrItems } from "../src/server/fixtures/media";
import { NoopRanker } from "../src/server/ai/ranker";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import { buildRecommendationBrief } from "../src/server/recommendation/brief";
import {
  adversarialRecommendationCases,
  evaluateAdversarialRecommendationResults,
  evaluateProfileRecommendationResults,
  evaluateRecommendationResults,
  goldenRecommendationCases,
  profileRecommendationCases
} from "../src/server/recommendation/evaluation";
import { mergeHardFilters, parseRecommendationIntent } from "../src/server/recommendation/intent";
import { retrieveRecommendationCandidates } from "../src/server/recommendation/retrieval";
import { scoreLibraryCandidates } from "../src/server/recommendation/scoring";
import { syntheticAdversarialEvalCatalog, syntheticProfileEvalCatalog } from "../src/server/recommendation/profileEvalFixtures";
import { recommendationEngineVersion } from "../src/server/recommendation/version";
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
const candidateOutputs = new Map();

for (const testCase of goldenRecommendationCases) {
  const intent = parseRecommendationIntent(testCase.query);
  const filters = mergeHardFilters(intent.hardFilters, {});
  const brief = buildRecommendationBrief({ query: testCase.query, watchContext: testCase.watchContext }, intent, filters, testCase.watchContext, 10);
  candidateOutputs.set(testCase.id, (await retrieveRecommendationCandidates(repository, brief)).candidates);
  const response = await engine.recommend({
    query: testCase.query,
    watchContext: testCase.watchContext,
    resultLimit: 10,
    useAi: false
  });
  outputs.set(testCase.id, response.results);
}

const result = evaluateRecommendationResults(goldenRecommendationCases, outputs, candidateOutputs);
const profileDb = createDatabase(":memory:");
const profileRepository = new MediaRepository(profileDb);
profileRepository.upsertMany(syntheticProfileEvalCatalog);
const profileFeatureMap = profileRepository.featureMap();
const profileGenericOutputs = new Map();
const profilePersonalizedOutputs = new Map();
for (const testCase of profileRecommendationCases) {
  profileGenericOutputs.set(
    testCase.id,
    scoreLibraryCandidates(profileRepository.list(), testCase.query, {}, testCase.watchContext, {
      allItems: profileRepository.list(),
      features: profileFeatureMap
    }).results
  );
  profilePersonalizedOutputs.set(
    testCase.id,
    scoreLibraryCandidates(profileRepository.list(), testCase.query, {}, testCase.watchContext, {
      allItems: profileRepository.list(),
      features: profileFeatureMap,
      feelProfile: testCase.profile
    }).results
  );
}
const profileResult = evaluateProfileRecommendationResults(profileRecommendationCases, profileGenericOutputs, profilePersonalizedOutputs);
const adversarialDb = createDatabase(":memory:");
const adversarialRepository = new MediaRepository(adversarialDb);
adversarialRepository.upsertMany(syntheticAdversarialEvalCatalog);
const adversarialFeatureMap = adversarialRepository.featureMap();
const adversarialOutputs = new Map();
for (const testCase of adversarialRecommendationCases) {
  adversarialOutputs.set(
    testCase.id,
    scoreLibraryCandidates(adversarialRepository.list(), testCase.query, {}, testCase.watchContext, {
      allItems: adversarialRepository.list(),
      features: adversarialFeatureMap
    }).results
  );
}
const adversarialResult = evaluateAdversarialRecommendationResults(adversarialRecommendationCases, adversarialOutputs);
console.log(
  JSON.stringify(
    {
      engineVersion: recommendationEngineVersion,
      generatedAt: new Date().toISOString(),
      result,
      profileResult,
      adversarialResult
    },
    null,
    2
  )
);
if (
  result.failures.length > 0 ||
  profileResult.failures.length > 0 ||
  profileResult.personalizationLiftAt3 < 0.65 ||
  adversarialResult.gatingPassRate < 1
) {
  process.exitCode = 1;
}
