/** Visible-fixture diagnostics only. No live configuration, provider or private corpus. */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { NoopRanker } from "../src/server/ai/ranker";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import { fixturePlexItems, fixtureSeerrItems } from "../src/server/fixtures/media";
import { syntheticAdversarialEvalCatalog, syntheticProfileEvalCatalog } from "../src/server/recommendation/profileEvalFixtures";
import { goldenRecommendationCases, adversarialRecommendationCases, profileRecommendationCases, evaluateRecommendationResults,
  evaluateAdversarialRecommendationResults, evaluateProfileRecommendationResults } from "../src/server/recommendation/evaluation";
import { scoreLibraryCandidates } from "../src/server/recommendation/scoring";
import { parseRecommendationIntent } from "../src/server/recommendation/intent";
import { buildRecommendationBrief } from "../src/server/recommendation/brief";
import { projectViewingBrief } from "../src/server/recommendation/viewingIntent";
import { resolveRankingExperiments, rankingExperimentSuffix, type RankingExperiments } from "../src/server/recommendation/rankingExperiments";
import { recommendationEngineVersion } from "../src/server/recommendation/version";
import type { ItemSummary } from "../src/shared/types";

export const rankingAblationArms: Array<{ name: string; flags: RankingExperiments }> = [
  { name: "repaired-default", flags: {} },
  { name: "shared-intent", flags: { sharedIntent: true } },
  { name: "normalised-feedback", flags: { normalizedFeedback: true } },
  { name: "bounded-personalisation", flags: { boundedPersonalization: true } },
  { name: "experiential-diversity", flags: { experientialDiversity: true } },
  { name: "contribution-explanations", flags: { groundedExplanations: true } },
  { name: "combined", flags: { sharedIntent: true, normalizedFeedback: true, boundedPersonalization: true, experientialDiversity: true, groundedExplanations: true } }
];

export async function evaluateRankingAblations() {
  const arms = [];
  // This runner is sequential and self-contained, with a fresh disposable DB per
  // arm/catalogue. It deliberately never loads loadConfig() or a disk database.
  for (const arm of rankingAblationArms) {
    const flags = resolveRankingExperiments(arm.flags);
    const databases: ReturnType<typeof createDatabase>[] = [];
    try {
      const repository = (records: typeof fixturePlexItems) => {
        const db = createDatabase(":memory:"); databases.push(db);
        const result = new MediaRepository(db); result.upsertMany(records); return result;
      };
      const goldenRepo = repository([...fixturePlexItems, ...fixtureSeerrItems]);
      const adversarialRepo = repository(syntheticAdversarialEvalCatalog);
      const profileRepo = repository(syntheticProfileEvalCatalog);
      const offlineSeerr = { allowsDescriptiveContent: () => false } as unknown as SeerrClient;
      const engine = (repo: MediaRepository) => new RecommendationEngine(repo, offlineSeerr, new NoopRanker(), undefined, undefined, undefined, undefined, undefined, undefined, flags);
      const goldenEngine = engine(goldenRepo); const adversarialEngine = engine(adversarialRepo);
      const goldenOutputs = new Map<string, ItemSummary[]>(); const adversarialOutputs = new Map<string, ItemSummary[]>();
      for (const [cases, target, runner] of [[goldenRecommendationCases, goldenOutputs, goldenEngine], [adversarialRecommendationCases, adversarialOutputs, adversarialEngine]] as const) {
        for (const testCase of cases) {
          const response = await runner.recommend({ query: testCase.query, watchContext: testCase.watchContext, useAi: false, resultLimit: 10 });
          target.set(testCase.id, response.results);
        }
      }
      const items = profileRepo.list(); const features = profileRepo.featureMap();
      const generic = new Map<string, ItemSummary[]>(); const personal = new Map<string, ItemSummary[]>();
      for (const testCase of profileRecommendationCases) {
        let intent = parseRecommendationIntent(testCase.query);
        if (flags.sharedIntent) intent = projectViewingBrief(testCase.query,
          buildRecommendationBrief({ query: testCase.query }, intent, intent.hardFilters, testCase.watchContext, 10), intent).intent;
        const context = { allItems: items, features, rankingExperiments: flags, resolvedIntent: intent };
        generic.set(testCase.id, scoreLibraryCandidates(items, testCase.query, {}, testCase.watchContext, context).results);
        personal.set(testCase.id, scoreLibraryCandidates(items, testCase.query, {}, testCase.watchContext, { ...context, feelProfile: testCase.profile }).results);
      }
      const golden = evaluateRecommendationResults(goldenRecommendationCases, goldenOutputs);
      const adversarial = evaluateAdversarialRecommendationResults(adversarialRecommendationCases, adversarialOutputs);
      const profiles = evaluateProfileRecommendationResults(profileRecommendationCases, generic, personal);
      arms.push({ name: arm.name, engineVersion: recommendationEngineVersion + rankingExperimentSuffix(flags),
        golden: { cases: golden.cases, ndcgAt3: golden.ndcgAt3, constraintAccuracy: golden.constraintAccuracy, availabilityAccuracy: golden.availabilityAccuracy, failures: golden.failures },
        adversarial: { cases: adversarial.cases, passRate: adversarial.passRate, gatingPassRate: adversarial.gatingPassRate, failures: adversarial.failures },
        profiles: { cases: profiles.cases, wins: profiles.wins, losses: profiles.losses, ties: profiles.ties, genericNdcgAt3: profiles.genericNdcgAt3, personalizedNdcgAt3: profiles.personalizedNdcgAt3, failures: profiles.failures }
      });
    } finally { for (const db of databases) db.close(); }
  }
  return { schemaVersion: "ranking-ablations-v1", promotionApproved: false,
    limitations: ["Visible developer fixtures, not blind quality evidence.", "Golden/adversarial measurements use actual final engine responses without Seerr augmentation; profile measurements are scorer-stage synthetic calibrations.",
      "These case sets do not exercise multi-example feedback; dedicated mechanical regression tests cover that arm.", "No real encoder, production catalogue, statistical generalisation or production latency is evaluated.",
      "An unchanged metric does not prove an inactive or unexercised arm is useful. Failed expectations are reported, never rewritten or treated as release approval."], arms };
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  console.log(JSON.stringify(await evaluateRankingAblations(), null, 2));
}
