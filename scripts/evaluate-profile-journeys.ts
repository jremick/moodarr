import { evaluateSyntheticFeelJourneys } from "../src/server/recommendation/profileJourneyEvaluation";

const result = await evaluateSyntheticFeelJourneys();

console.log(JSON.stringify(result, null, 2));

if (result.failures.length > 0 || result.consistentJourneyReplayLosses > 0 || result.holdoutEvents < result.journeys) {
  process.exitCode = 1;
}
