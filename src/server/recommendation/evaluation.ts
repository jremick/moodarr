import type { AvailabilityGroup, ItemSummary, MediaType, WatchContext } from "../../shared/types";

export interface GoldenRecommendationCase {
  id: string;
  query: string;
  watchContext: WatchContext;
  mustIncludeTop3?: string[];
  mustIncludeTop10?: string[];
  shouldNotTop3?: string[];
  constraints?: {
    mediaTypes?: MediaType[];
    maxRuntimeMinutes?: number;
    availability?: AvailabilityGroup[];
    excludedGenres?: string[];
  };
}

export interface EvaluationResult {
  cases: number;
  top3HitRate: number;
  top10Recall: number;
  preRerankRecall: number;
  meanReciprocalRank: number;
  constraintAccuracy: number;
  availabilityAccuracy: number;
  failures: string[];
}

export const goldenRecommendationCases: GoldenRecommendationCase[] = [
  {
    id: "funny-fantasy-under-two-hours",
    query: "funny fantasy movie under two hours",
    watchContext: "group",
    mustIncludeTop10: ["The Princess Bride"],
    shouldNotTop3: ["The Do-Over"],
    constraints: { mediaTypes: ["movie"], maxRuntimeMinutes: 120 }
  },
  {
    id: "like-stardust",
    query: "something like Stardust",
    watchContext: "group",
    mustIncludeTop10: ["The Princess Bride", "Dungeons & Dragons: Honor Among Thieves"]
  },
  {
    id: "feel-good-comedy",
    query: "feel-good comedy for tonight",
    watchContext: "group",
    mustIncludeTop3: ["Paddington 2", "Hunt for the Wilderpeople"],
    shouldNotTop3: ["The Do-Over"]
  },
  {
    id: "short-tv-series",
    query: "short TV series we can start",
    watchContext: "group",
    mustIncludeTop3: ["Over the Garden Wall"],
    constraints: { mediaTypes: ["tv"], maxRuntimeMinutes: 600 }
  },
  {
    id: "do-over-but-better",
    query: "movie like The Do-Over but better",
    watchContext: "solo",
    mustIncludeTop3: ["Hunt for the Wilderpeople", "Paddington 2"],
    shouldNotTop3: ["The Do-Over"],
    constraints: { mediaTypes: ["movie"] }
  },
  {
    id: "not-animated-fantasy",
    query: "funny fantasy movie that is not animated",
    watchContext: "group",
    mustIncludeTop10: ["The Princess Bride", "Stardust"],
    shouldNotTop3: ["Over the Garden Wall"],
    constraints: { mediaTypes: ["movie"], excludedGenres: ["Animation"] }
  },
  {
    id: "plex-only-feel-good",
    query: "feel-good comedy already in Plex",
    watchContext: "group",
    mustIncludeTop10: ["Paddington 2", "Hunt for the Wilderpeople"],
    constraints: { availability: ["available_in_plex"] }
  },
  {
    id: "requestable-like-stardust",
    query: "something like Stardust that I can request if it is not in Plex",
    watchContext: "group",
    mustIncludeTop10: ["The Princess Bride"],
    constraints: { availability: ["not_in_plex_requestable", "available_in_plex"] }
  }
];

export function evaluateRecommendationResults(
  cases: GoldenRecommendationCase[],
  outputs: Map<string, ItemSummary[]>,
  candidateOutputs: Map<string, ItemSummary[]> = outputs
): EvaluationResult {
  const failures: string[] = [];
  let top3Hits = 0;
  let top3Expected = 0;
  let top10Hits = 0;
  let top10Expected = 0;
  let preRerankHits = 0;
  let preRerankExpected = 0;
  let reciprocalRankTotal = 0;
  let reciprocalRankExpected = 0;
  let constraintsPassed = 0;
  let availabilityPassed = 0;
  let availabilityExpected = 0;

  for (const testCase of cases) {
    const results = outputs.get(testCase.id) ?? [];
    const candidates = candidateOutputs.get(testCase.id) ?? [];
    const top3 = results.slice(0, 3).map((item) => item.title);
    const top10 = results.slice(0, 10).map((item) => item.title);
    const candidateTitles = candidates.map((item) => item.title);
    const expectedTitles = [...(testCase.mustIncludeTop3 ?? []), ...(testCase.mustIncludeTop10 ?? [])];

    if (testCase.mustIncludeTop3?.length) {
      top3Expected += 1;
      if (testCase.mustIncludeTop3.some((title) => top3.includes(title))) top3Hits += 1;
    }
    for (const title of testCase.mustIncludeTop10 ?? []) {
      top10Expected += 1;
      if (top10.includes(title)) top10Hits += 1;
      else failures.push(`${testCase.id}: expected ${title} in top 10.`);
    }
    for (const title of expectedTitles) {
      preRerankExpected += 1;
      if (candidateTitles.includes(title)) preRerankHits += 1;
      else failures.push(`${testCase.id}: expected ${title} in pre-rerank candidates.`);
    }
    const firstExpectedRank = expectedTitles
      .map((title) => results.findIndex((item) => item.title === title))
      .filter((rank) => rank >= 0)
      .sort((a, b) => a - b)[0];
    if (expectedTitles.length) {
      reciprocalRankExpected += 1;
      if (firstExpectedRank !== undefined) reciprocalRankTotal += 1 / (firstExpectedRank + 1);
    }
    for (const title of testCase.mustIncludeTop3 ?? []) {
      if (!top3.includes(title)) failures.push(`${testCase.id}: expected ${title} in top 3.`);
    }
    for (const title of testCase.shouldNotTop3 ?? []) {
      if (top3.includes(title)) failures.push(`${testCase.id}: ${title} should not rank in top 3.`);
    }
    if (matchesConstraints(results, testCase.constraints)) constraintsPassed += 1;
    else failures.push(`${testCase.id}: one or more hard constraints failed.`);
    if (testCase.constraints?.availability?.length) {
      availabilityExpected += 1;
      if (results.every((item) => testCase.constraints?.availability?.includes(item.availabilityGroup))) availabilityPassed += 1;
      else failures.push(`${testCase.id}: one or more availability constraints failed.`);
    }
  }

  return {
    cases: cases.length,
    top3HitRate: top3Expected ? top3Hits / top3Expected : 1,
    top10Recall: top10Expected ? top10Hits / top10Expected : 1,
    preRerankRecall: preRerankExpected ? preRerankHits / preRerankExpected : 1,
    meanReciprocalRank: reciprocalRankExpected ? reciprocalRankTotal / reciprocalRankExpected : 1,
    constraintAccuracy: cases.length ? constraintsPassed / cases.length : 0,
    availabilityAccuracy: availabilityExpected ? availabilityPassed / availabilityExpected : 1,
    failures
  };
}

function matchesConstraints(results: ItemSummary[], constraints: GoldenRecommendationCase["constraints"]) {
  if (!constraints) return true;
  return results.every((item) => {
    if (constraints.mediaTypes?.length && !constraints.mediaTypes.includes(item.mediaType)) return false;
    if (constraints.maxRuntimeMinutes && item.runtimeMinutes && item.runtimeMinutes > constraints.maxRuntimeMinutes) return false;
    if (constraints.availability?.length && !constraints.availability.includes(item.availabilityGroup)) return false;
    if (constraints.excludedGenres?.some((genre) => item.genres.some((itemGenre) => itemGenre.toLowerCase() === genre.toLowerCase()))) return false;
    return true;
  });
}
