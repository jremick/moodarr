import type {
  FeelFeedbackAction,
  FeelFeedbackReasonChip,
  ItemSummary,
  ProfileReplayEvaluationResponse,
  WatchContext
} from "../../shared/types";
import { NoopRanker } from "../ai/ranker";
import { createDatabase } from "../db/database";
import { MediaRepository } from "../db/mediaRepository";
import type { SeerrClient } from "../integrations/seerrClient";
import { RecommendationEngine } from "./engine";
import { syntheticAdversarialEvalCatalog } from "./profileEvalFixtures";
import { recommendationEngineVersion } from "./version";

interface SyntheticJourneyStep {
  query: string;
  action: FeelFeedbackAction;
  targetTitles: string[];
  comparedTitles?: string[];
  watchContext?: WatchContext;
  moodTerm?: string;
  reason?: FeelFeedbackReasonChip;
  strength?: number;
}

interface SyntheticJourneyContextIsolationExpectation {
  term: string;
  contexts: WatchContext[];
  minVersionPerContext: number;
}

interface SyntheticFeelJourney {
  id: string;
  label: string;
  watchContext: WatchContext;
  moodTerm: string;
  expectedDriftAlert?: boolean;
  expectProfileTraining?: boolean;
  minHoldoutEvents?: number;
  minReplayComparisons?: number;
  contextIsolation?: SyntheticJourneyContextIsolationExpectation;
  steps: SyntheticJourneyStep[];
}

export interface SyntheticJourneyStepResult {
  query: string;
  action: FeelFeedbackAction;
  targetTitle?: string;
  comparedTitle?: string;
  sessionId?: string;
  profileVersion?: number;
  profileHoldout?: boolean;
  appliedProfileSignal?: boolean;
}

export interface SyntheticJourneyContextIsolationResult {
  checked: boolean;
  isolated: boolean;
  term: string;
  contexts: Array<{
    watchContext: WatchContext;
    version: number;
    effectiveEvidence: number;
    featureWeights: Record<string, number>;
  }>;
}

export interface SyntheticJourneyResult {
  id: string;
  label: string;
  watchContext: WatchContext;
  moodTerm: string;
  steps: number;
  feedbackEvents: number;
  checkpoints: number;
  holdoutEvents: number;
  replayCompared: number;
  replayWins: number;
  replayLosses: number;
  replayTies: number;
  driftAlerts: number;
  expectedDriftAlert: boolean;
  expectedProfileTraining: boolean;
  finalProfileVersion: number;
  finalConflictScore: number;
  finalEffectiveEvidence: number;
  contextIsolation?: SyntheticJourneyContextIsolationResult;
  stepResults: SyntheticJourneyStepResult[];
  replay: ProfileReplayEvaluationResponse;
  failures: string[];
}

export interface SyntheticJourneyEvaluationResult {
  engineVersion: string;
  generatedAt: string;
  journeys: number;
  steps: number;
  holdoutEvents: number;
  replayCompared: number;
  replayWins: number;
  replayLosses: number;
  replayTies: number;
  consistentJourneyReplayLosses: number;
  driftAlerts: number;
  failures: string[];
  journeyResults: SyntheticJourneyResult[];
}

export const syntheticFeelJourneys: SyntheticFeelJourney[] = [
  {
    id: "cozy-witty-unsentimental",
    label: "Cozy means witty, warm, unsentimental, low-stakes comfort",
    watchContext: "solo",
    moodTerm: "cozy",
    steps: repeatTargets(
      "cozy movie but not cute or sentimental",
      "right_mood",
      [["Dry Harbor"], ["Candle Street Caper"], ["Tea Shop Time Loop"]],
      11
    )
  },
  {
    id: "dark-grounded-tension",
    label: "Dark means grounded psychological tension without horror",
    watchContext: "solo",
    moodTerm: "dark",
    steps: repeatTargets(
      "dark but not scary, grounded mystery tension",
      "right_mood",
      [["The Basement Signal"], ["Dial Tone Road"], ["Noir Bus Stop"], ["Velvet Window"]],
      11
    )
  },
  {
    id: "weird-playful-group-safe",
    label: "Weird means playful offbeat group-safe comedy",
    watchContext: "group",
    moodTerm: "weird",
    steps: repeatTargets(
      "weird conversation starter for a group",
      "right_mood",
      [["Odd Jobs Department"], ["Bubblegum Bureau"], ["Deadpan Lighthouse"]],
      11
    )
  },
  {
    id: "dark-conflicting-drift",
    label: "Dark profile receives contradictory horror feedback and should raise drift review",
    watchContext: "solo",
    moodTerm: "dark",
    expectedDriftAlert: true,
    steps: [
      ...repeatTargets("dark intense movie", "right_mood", [["Midnight Chainsaw Club"], ["The Hollow Carnival"]], 5),
      ...repeatTargets("dark intense movie", "wrong_mood", [["Midnight Chainsaw Club"], ["The Hollow Carnival"]], 5, {
        reason: "too_scary"
      }),
      {
        query: "dark but not scary, grounded mystery tension",
        action: "right_mood",
        targetTitles: ["The Basement Signal", "Dial Tone Road"]
      }
    ]
  },
  {
    id: "weak-actions-do-not-train",
    label: "Weak and diagnostic actions are observed without changing term-profile meaning",
    watchContext: "solo",
    moodTerm: "cozy",
    expectProfileTraining: false,
    steps: [
      ...repeatTargets(
        "cozy movie but not cute or sentimental",
        "open",
        [["Dry Harbor"], ["Candle Street Caper"], ["Tea Shop Time Loop"]],
        3
      ),
      ...repeatTargets(
        "cozy movie but not cute or sentimental",
        "expand",
        [["Dry Harbor"], ["Candle Street Caper"], ["Tea Shop Time Loop"]],
        3
      ),
      ...repeatTargets(
        "cozy movie but not cute or sentimental",
        "swipe_skip",
        [["Dry Harbor"], ["Candle Street Caper"], ["Tea Shop Time Loop"]],
        2
      ),
      ...repeatTargets(
        "cozy gentle fantasy adventure requestable",
        "request_preview",
        [["Cloud Harbor Quest"], ["Already Pending Caper"]],
        2
      ),
      ...repeatTargets(
        "cozy gentle fantasy adventure requestable",
        "request_create",
        [["Cloud Harbor Quest"], ["Already Pending Caper"]],
        2
      )
    ]
  },
  {
    id: "pairwise-cozy-contrast",
    label: "Pairwise picks teach cozy as dry, witty, and warm instead of sugary sentiment",
    watchContext: "solo",
    moodTerm: "cozy",
    steps: repeatTargets(
      "cozy movie but not cute or sentimental",
      "pairwise_pick",
      [["Dry Harbor"], ["Candle Street Caper"], ["Tea Shop Time Loop"]],
      11,
      {
        comparedTitles: ["Sugar Quilt", "Sincere Autumn", "Soft Rain Sunday"]
      }
    )
  },
  {
    id: "context-isolated-cozy",
    label: "Solo cozy and group cozy learn separate meanings from the same term",
    watchContext: "solo",
    moodTerm: "cozy",
    minHoldoutEvents: 2,
    minReplayComparisons: 2,
    contextIsolation: {
      term: "cozy",
      contexts: ["solo", "group"],
      minVersionPerContext: 10
    },
    steps: [
      ...repeatTargets(
        "cozy movie but not cute or sentimental",
        "right_mood",
        [["Dry Harbor"], ["Candle Street Caper"], ["Tea Shop Time Loop"]],
        11,
        { watchContext: "solo", moodTerm: "cozy" }
      ),
      ...repeatTargets(
        "cozy movie for a group, gentle and broadly warm",
        "right_mood",
        [["Quiet County Fair"], ["Soft Rain Sunday"], ["Candle Street Caper"]],
        11,
        { watchContext: "group", moodTerm: "cozy" }
      )
    ]
  }
];

export async function evaluateSyntheticFeelJourneys(journeys = syntheticFeelJourneys): Promise<SyntheticJourneyEvaluationResult> {
  const journeyResults: SyntheticJourneyResult[] = [];
  const failures: string[] = [];

  for (const journey of journeys) {
    const result = await runSyntheticJourney(journey);
    journeyResults.push(result);
    failures.push(...result.failures.map((failure) => `${journey.id}: ${failure}`));
  }

  const consistentJourneyReplayLosses = journeyResults
    .filter((result) => !result.expectedDriftAlert)
    .reduce((sum, result) => sum + result.replayLosses, 0);
  if (consistentJourneyReplayLosses > 0) {
    failures.push(`consistent_journey_replay_loss: expected zero replay losses, saw ${consistentJourneyReplayLosses}.`);
  }

  return {
    engineVersion: recommendationEngineVersion,
    generatedAt: new Date().toISOString(),
    journeys: journeyResults.length,
    steps: journeyResults.reduce((sum, result) => sum + result.steps, 0),
    holdoutEvents: journeyResults.reduce((sum, result) => sum + result.holdoutEvents, 0),
    replayCompared: journeyResults.reduce((sum, result) => sum + result.replayCompared, 0),
    replayWins: journeyResults.reduce((sum, result) => sum + result.replayWins, 0),
    replayLosses: journeyResults.reduce((sum, result) => sum + result.replayLosses, 0),
    replayTies: journeyResults.reduce((sum, result) => sum + result.replayTies, 0),
    consistentJourneyReplayLosses,
    driftAlerts: journeyResults.reduce((sum, result) => sum + result.driftAlerts, 0),
    failures,
    journeyResults
  };
}

async function runSyntheticJourney(journey: SyntheticFeelJourney): Promise<SyntheticJourneyResult> {
  const db = createDatabase(":memory:");
  const repository = new MediaRepository(db);
  repository.upsertMany(syntheticAdversarialEvalCatalog);
  const engine = new RecommendationEngine(repository, emptySeerrClient(), new NoopRanker());
  const failures: string[] = [];
  const stepResults: SyntheticJourneyStepResult[] = [];
  const expectedProfileTraining = journey.expectProfileTraining ?? true;

  for (const step of journey.steps) {
    const watchContext = step.watchContext ?? journey.watchContext;
    const moodTerm = step.moodTerm ?? journey.moodTerm;
    const search = await engine.recommend({
      query: step.query,
      watchContext,
      resultLimit: 18,
      useAi: false
    });
    const sessionId = latestRecommendationSessionId(db);
    const target = findPreferredItem(repository, search.results, step.targetTitles);
    const compared = step.comparedTitles?.length ? findPreferredItem(repository, search.results, step.comparedTitles) : undefined;
    if (!sessionId) failures.push(`missing_session: ${step.query}`);
    if (!target) failures.push(`missing_target: ${step.targetTitles.join(" or ")} for "${step.query}".`);
    if (step.action === "pairwise_pick" && !compared) {
      failures.push(`missing_pairwise_compared: ${step.comparedTitles?.join(" or ") ?? "none"} for "${step.query}".`);
    }

    if (!sessionId || !target || (step.action === "pairwise_pick" && !compared)) {
      stepResults.push({ query: step.query, action: step.action });
      continue;
    }

    const feedback = repository.recordFeelFeedback({
      action: step.action,
      source: "admin",
      sessionId,
      itemId: target.id,
      comparedItemId: compared?.id,
      watchContext,
      moodTerm,
      reason: step.reason,
      strength: step.strength,
      metadata: {
        surface: "synthetic_profile_journey",
        calibration: true,
        sourceVersion: "v2"
      }
    });
    stepResults.push({
      query: step.query,
      action: step.action,
      targetTitle: target.title,
      comparedTitle: compared?.title,
      sessionId,
      profileVersion: feedback.profileVersion,
      profileHoldout: feedback.profileHoldout,
      appliedProfileSignal: feedback.appliedProfileSignal
    });
  }

  const replay = repository.profileReplayEvaluation();
  const diagnostics = repository.recommendationDiagnostics();
  const term = diagnostics.feelProfiles?.[journey.watchContext].terms.find((entry) => entry.term === journey.moodTerm);
  const driftContexts = journey.contextIsolation?.contexts ?? [journey.watchContext];
  const driftTerm = journey.contextIsolation?.term ?? journey.moodTerm;
  const driftAlerts = diagnostics.feelProfileDrift?.alerts.filter(
    (alert) => driftContexts.includes(alert.watchContext) && alert.term === driftTerm
  ).length ?? 0;
  const checkpointCount = diagnostics.feelProfileTimeline?.totalCheckpoints ?? 0;
  const feedbackEvents = diagnostics.feelSignals?.total ?? 0;
  const minHoldoutEvents = journey.minHoldoutEvents ?? (expectedProfileTraining ? 1 : 0);
  const minReplayComparisons = journey.minReplayComparisons ?? (expectedProfileTraining ? 1 : 0);
  const contextIsolation = journey.contextIsolation
    ? summarizeContextIsolation(diagnostics.feelProfiles, journey.contextIsolation)
    : undefined;

  if (expectedProfileTraining && replay.holdoutEvents < minHoldoutEvents) {
    failures.push(`missing_holdout: expected at least ${minHoldoutEvents} synthetic holdout event(s), saw ${replay.holdoutEvents}.`);
  }
  if (!expectedProfileTraining && replay.holdoutEvents > 0) failures.push(`unexpected_holdout: saw ${replay.holdoutEvents} holdout events.`);
  if (expectedProfileTraining && replay.compared < minReplayComparisons) {
    failures.push(`missing_replay_comparison: expected at least ${minReplayComparisons}, saw ${replay.compared}; skipped=${JSON.stringify(replay.skipped)}.`);
  }
  if (!expectedProfileTraining && replay.compared > 0) failures.push(`unexpected_replay_comparison: saw ${replay.compared} replay comparisons.`);
  if (!expectedProfileTraining && checkpointCount > 0) failures.push(`unexpected_checkpoint: saw ${checkpointCount} profile checkpoints.`);
  if (!expectedProfileTraining && stepResults.some((step) => step.appliedProfileSignal)) {
    failures.push("unexpected_profile_signal: weak/diagnostic journey applied profile learning.");
  }
  if (!journey.expectedDriftAlert && expectedProfileTraining && replay.losses > 0) failures.push(`replay_loss: expected no replay losses, saw ${replay.losses}.`);
  if (journey.expectedDriftAlert && driftAlerts < 1) failures.push("missing_drift_alert: expected a profile drift alert.");
  if (!journey.expectedDriftAlert && driftAlerts > 0) failures.push(`unexpected_drift_alert: saw ${driftAlerts} alerts for a stable journey.`);
  if (expectedProfileTraining && !term) failures.push(`missing_profile_term: ${journey.moodTerm}.`);
  if (!expectedProfileTraining && term) failures.push(`unexpected_profile_term: ${journey.moodTerm}.`);
  if (contextIsolation && !contextIsolation.isolated) {
    failures.push(`context_not_isolated: expected ${contextIsolation.term} to learn separate ${journey.contextIsolation?.contexts.join(" and ")} profiles.`);
  }

  return {
    id: journey.id,
    label: journey.label,
    watchContext: journey.watchContext,
    moodTerm: journey.moodTerm,
    steps: journey.steps.length,
    feedbackEvents,
    checkpoints: checkpointCount,
    holdoutEvents: replay.holdoutEvents,
    replayCompared: replay.compared,
    replayWins: replay.wins,
    replayLosses: replay.losses,
    replayTies: replay.ties,
    driftAlerts,
    expectedDriftAlert: Boolean(journey.expectedDriftAlert),
    expectedProfileTraining,
    finalProfileVersion: term?.version ?? 0,
    finalConflictScore: term?.conflictScore ?? 0,
    finalEffectiveEvidence: term?.effectiveEvidence ?? 0,
    contextIsolation,
    stepResults,
    replay,
    failures
  };
}

function repeatTargets(
  query: string,
  action: FeelFeedbackAction,
  targetTitleSets: string[][],
  count: number,
  overrides: Partial<Omit<SyntheticJourneyStep, "query" | "action" | "targetTitles">> = {}
) {
  return Array.from({ length: count }, (_, index) => ({
    query,
    action,
    targetTitles: targetTitleSets[index % targetTitleSets.length]!,
    ...overrides
  }));
}

function summarizeContextIsolation(
  profiles: ReturnType<MediaRepository["feelProfiles"]> | undefined,
  expectation: SyntheticJourneyContextIsolationExpectation
): SyntheticJourneyContextIsolationResult {
  const contexts = expectation.contexts.map((watchContext) => {
    const term = profiles?.[watchContext].terms.find((entry) => entry.term === expectation.term);
    return {
      watchContext,
      version: term?.version ?? 0,
      effectiveEvidence: term?.effectiveEvidence ?? 0,
      featureWeights: term?.featureWeights ?? {}
    };
  });
  const signatures = new Set(contexts.map((context) => featureWeightSignature(context.featureWeights)));
  const isolated =
    contexts.every((context) => context.version >= expectation.minVersionPerContext && context.effectiveEvidence > 0) &&
    signatures.size === contexts.length;
  return {
    checked: true,
    isolated,
    term: expectation.term,
    contexts
  };
}

function featureWeightSignature(weights: Record<string, number>) {
  return Object.entries(weights)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([feature, weight]) => `${feature}:${weight.toFixed(3)}`)
    .join("|");
}

function latestRecommendationSessionId(db: ReturnType<typeof createDatabase>) {
  const row = db.prepare("SELECT id FROM recommendation_sessions ORDER BY rowid DESC LIMIT 1").get() as { id: string } | undefined;
  return row?.id;
}

function findPreferredItem(repository: MediaRepository, results: ItemSummary[], titles: string[]) {
  for (const title of titles) {
    const result = results.find((item) => item.title === title);
    if (result) return result;
  }
  for (const title of titles) {
    const item = repository.findByTitleYear(title, undefined, "movie");
    if (item) return item;
  }
  return undefined;
}

function emptySeerrClient() {
  return {
    async search() {
      return [];
    }
  } as unknown as SeerrClient;
}
