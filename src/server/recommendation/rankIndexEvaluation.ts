import type { ItemSummary, SearchRequest, WatchContext } from "../../shared/types";
import { createDatabase } from "../db/database";
import { MediaRepository, type IngestMediaRecord } from "../db/mediaRepository";
import { buildRecommendationBrief } from "./brief";
import { mergeHardFilters, parseRecommendationIntent } from "./intent";
import { scoreMoodRankV3RetrievedCandidates, scoreRankIndexedLibrary } from "./rankIndex";
import { retrieveRecommendationCandidates } from "./retrieval";

export interface RankIndexCoverageCase {
  id: string;
  query: string;
  watchContext: WatchContext;
  expectedTitle: string;
  records: IngestMediaRecord[];
}

export interface RankIndexCoverageCaseResult {
  id: string;
  query: string;
  expectedTitle: string;
  libraryItemCount: number;
  retrievalCandidateCount: number;
  targetInRetrievedCandidates: boolean;
  baselineHit: boolean;
  candidateHit: boolean;
  candidateOnlyHit: boolean;
  candidateScoredItemCount: number;
  baselineTopTitles: string[];
  candidateTopTitles: string[];
}

export interface RankIndexCoverageEvaluationResult {
  cases: number;
  baselineHits: number;
  candidateHits: number;
  candidateOnlyHits: number;
  retrievalCapMisses: number;
  failures: string[];
  caseResults: RankIndexCoverageCaseResult[];
}

const decoyCount = 540;
const targetRatings = { critic: 60, audience: 61, user: 6.1 };

export const rankIndexCoverageCases: RankIndexCoverageCase[] = [
  {
    id: "late-runtime-valid-match",
    query: "funny fantasy movie under two hours",
    watchContext: "group",
    expectedTitle: "Z Hidden Lantern",
    records: [
      ...decoys((index) =>
        fixtureMovie(index, {
          title: `A Funny Fantasy Decoy ${String(index).padStart(3, "0")}`,
          runtimeMinutes: 181,
          contentRating: "PG",
          summary: "A funny fantasy adventure comedy with magic, jokes, romance, and quests, but it is too long for the requested runtime.",
          genres: ["Adventure", "Fantasy", "Comedy"]
        })
      ),
      fixtureMovie(900, {
        title: "Z Hidden Lantern",
        runtimeMinutes: 94,
        contentRating: "PG",
        summary: "A breezy lantern quest with playful banter, romance, and a concise shape.",
        genres: ["Adventure", "Romance"],
        ratings: targetRatings
      })
    ]
  },
  {
    id: "late-animation-negation-valid-match",
    query: "funny fantasy movie that is not animated",
    watchContext: "group",
    expectedTitle: "Z Brass Lantern",
    records: [
      ...decoys((index) =>
        fixtureMovie(index, {
          title: `A Animated Fantasy Decoy ${String(index).padStart(3, "0")}`,
          runtimeMinutes: 89,
          contentRating: "PG",
          summary: "A funny animated fantasy movie with magic, jokes, adventure, and family comedy.",
          genres: ["Animation", "Fantasy", "Comedy"]
        })
      ),
      fixtureMovie(901, {
        title: "Z Brass Lantern",
        runtimeMinutes: 101,
        contentRating: "PG",
        summary: "A breezy lantern quest with playful banter, romance, and a concise live-action shape.",
        genres: ["Adventure", "Romance"],
        ratings: targetRatings
      })
    ]
  },
  {
    id: "late-requestable-runtime-valid-match",
    query: "requestable gentle fantasy adventure under two hours not already available",
    watchContext: "group",
    expectedTitle: "Z Cloud Lantern",
    records: [
      ...decoys((index) =>
        fixtureSeerrMovie(index, "requestable", {
          title: `A Requestable Fantasy Decoy ${String(index).padStart(3, "0")}`,
          runtimeMinutes: 181,
          contentRating: "PG",
          summary: "A requestable gentle fantasy adventure with harbor magic, but far over two hours.",
          genres: ["Adventure", "Fantasy", "Family"]
        })
      ),
      fixtureSeerrMovie(902, "requestable", {
        title: "Z Cloud Lantern",
        runtimeMinutes: 106,
        contentRating: "PG",
        summary: "A quiet harbor story with a concise shape.",
        genres: ["Drama"],
        ratings: targetRatings
      })
    ]
  },
  {
    id: "late-excluded-horror-valid-match",
    query: "cozy group movie, not horror",
    watchContext: "group",
    expectedTitle: "Z Plain Lantern",
    records: [
      ...decoys((index) =>
        fixtureMovie(index, {
          title: `A Cozy Horror Decoy ${String(index).padStart(3, "0")}`,
          runtimeMinutes: 96,
          contentRating: "R",
          summary: "A cozy group movie on paper, but with horror scenes, violent dread, and high-friction intensity.",
          genres: ["Horror", "Thriller"]
        })
      ),
      fixtureMovie(904, {
        title: "Z Plain Lantern",
        runtimeMinutes: 89,
        summary: undefined,
        genres: ["Drama"],
        ratings: targetRatings
      })
    ]
  }
];

export async function evaluateRankIndexCoverageCases(cases = rankIndexCoverageCases): Promise<RankIndexCoverageEvaluationResult> {
  const failures: string[] = [];
  const caseResults: RankIndexCoverageCaseResult[] = [];

  for (const testCase of cases) {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    repository.upsertMany(testCase.records);

    const intent = parseRecommendationIntent(testCase.query);
    const filters = mergeHardFilters(intent.hardFilters, {});
    const brief = buildRecommendationBrief(
      { query: testCase.query, watchContext: testCase.watchContext },
      intent,
      filters,
      testCase.watchContext,
      10
    );
    const retrieved = await retrieveRecommendationCandidates(repository, brief);
    const request: SearchRequest = {
      query: testCase.query,
      watchContext: testCase.watchContext,
      resultLimit: 10,
      useAi: false,
      filters
    };
    const baseline = scoreMoodRankV3RetrievedCandidates(retrieved, request, testCase.watchContext);
    const candidate = scoreRankIndexedLibrary(retrieved, request, testCase.watchContext);
    const result = summarizeCase(
      testCase,
      retrieved.candidates,
      baseline.results,
      candidate.results,
      candidate.rankIndex.scoredItemCount,
      retrieved.allItems.length
    );
    caseResults.push(result);

    if (result.targetInRetrievedCandidates) {
      failures.push(`${testCase.id}: expected ${testCase.expectedTitle} to be outside the retrieved v0.3 candidate pool.`);
    }
    if (result.baselineHit) {
      failures.push(`${testCase.id}: MoodRank v0.3 unexpectedly found ${testCase.expectedTitle}; this case no longer proves rank-index coverage.`);
    }
    if (result.candidateTopTitles[0] !== testCase.expectedTitle) {
      failures.push(`${testCase.id}: MoodRank v0.4 expected ${testCase.expectedTitle} at rank 1, got ${result.candidateTopTitles[0] ?? "no result"}.`);
    }
  }

  return {
    cases: cases.length,
    baselineHits: caseResults.filter((result) => result.baselineHit).length,
    candidateHits: caseResults.filter((result) => result.candidateHit).length,
    candidateOnlyHits: caseResults.filter((result) => result.candidateOnlyHit).length,
    retrievalCapMisses: caseResults.filter((result) => !result.targetInRetrievedCandidates).length,
    failures,
    caseResults
  };
}

function summarizeCase(
  testCase: RankIndexCoverageCase,
  candidates: ItemSummary[],
  baselineResults: ItemSummary[],
  candidateResults: ItemSummary[],
  candidateScoredItemCount: number,
  libraryItemCount: number
): RankIndexCoverageCaseResult {
  const baselineTopTitles = titles(baselineResults);
  const candidateTopTitles = titles(candidateResults);
  const targetInRetrievedCandidates = candidates.some((item) => item.title === testCase.expectedTitle);
  const baselineHit = baselineTopTitles.includes(testCase.expectedTitle);
  const candidateHit = candidateTopTitles.includes(testCase.expectedTitle);
  return {
    id: testCase.id,
    query: testCase.query,
    expectedTitle: testCase.expectedTitle,
    libraryItemCount,
    retrievalCandidateCount: candidates.length,
    targetInRetrievedCandidates,
    baselineHit,
    candidateHit,
    candidateOnlyHit: candidateHit && !baselineHit,
    candidateScoredItemCount,
    baselineTopTitles,
    candidateTopTitles
  };
}

function titles(results: ItemSummary[]) {
  return results.slice(0, 10).map((item) => item.title);
}

function decoys(makeRecord: (index: number) => IngestMediaRecord) {
  return Array.from({ length: decoyCount }, (_, index) => makeRecord(index));
}

function fixtureMovie(
  index: number,
  record: {
    title: string;
    runtimeMinutes?: number;
    contentRating?: string;
    summary?: string;
    genres: string[];
    ratings?: IngestMediaRecord["ratings"];
  }
): IngestMediaRecord {
  const tmdbId = 970000 + index;
  return {
    source: "fixture",
    mediaType: "movie",
    title: record.title,
    year: 2000 + (index % 20),
    runtimeMinutes: record.runtimeMinutes,
    contentRating: record.contentRating,
    summary: record.summary,
    genres: record.genres,
    cast: ["Fixture Actor"],
    directors: ["Fixture Director"],
    ratings: record.ratings ?? { critic: 88, audience: 88, user: 7.4 },
    posterPath: `fixture://rank-index-eval/${index}`,
    externalIds: { tmdb: tmdbId }
  };
}

function fixtureSeerrMovie(
  index: number,
  availability: "requestable" | "pending" | "unavailable",
  record: Parameters<typeof fixtureMovie>[1]
): IngestMediaRecord {
  const tmdbId = 980000 + index;
  return {
    ...fixtureMovie(index, record),
    externalIds: { tmdb: tmdbId },
    seerr: {
      tmdbId,
      status: availability === "pending" ? "pending" : "unknown",
      requestStatus: availability === "pending" ? "pending" : undefined,
      requestable: availability === "requestable",
      url: `http://fixture-seerr.local/movie/${tmdbId}`
    }
  };
}
