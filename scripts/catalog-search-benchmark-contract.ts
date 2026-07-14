import type { SearchFilters, WatchContext } from "../src/shared/types";

export type CatalogSearchBenchmarkProfile = "operational" | "catalog-request-attempt";

export interface CatalogBenchmarkCaseDefinition {
  id: string;
  query: string;
  watchContext: WatchContext;
  filters?: SearchFilters;
  expectedResult?: "scored" | "zero";
}

export interface CatalogSearchBenchmarkArgs {
  enforceAdvisoryTargets: boolean;
  limit?: number;
  iterations: number;
  profile: CatalogSearchBenchmarkProfile;
  skipEngine: boolean;
}

export interface CatalogBenchmarkSample {
  caseId: string;
  totalLocalMs: number;
  engineMs?: number;
  engineResultCount?: number;
  scoredItemCount: number;
}

export interface CatalogBenchmarkThresholds {
  localP50Ms: number;
  localP95Ms: number;
  engineP95Ms: number;
}

export interface CatalogBenchmarkCorpus {
  totalItems: number;
  catalogOnlyItems: number;
  plexVerifiedItems: number;
  seerrVerifiedItems: number;
  requestableVerifiedItems: number;
  requestAttemptProbeCount: number;
  requestAttemptProbeLimit: number;
}

export const operationalBenchmarkCases: CatalogBenchmarkCaseDefinition[] = [
  { id: "cozy-fantasy", query: "cozy gentle fantasy adventure not scary", watchContext: "solo" },
  { id: "shows-not-scary", query: "shows that are clever and not scary", watchContext: "group", filters: { mediaTypes: ["tv"] } },
  { id: "requestable-fantasy", query: "requestable gentle fantasy adventure only, not already available", watchContext: "solo" },
  { id: "low-commitment-comedy", query: "low commitment warm comedy for a tired weeknight", watchContext: "solo" },
  { id: "dark-detective", query: "grounded detective mystery with quiet tension", watchContext: "solo" },
  { id: "family-warm", query: "warm family-safe movie with gentle stakes", watchContext: "group" },
  { id: "weird-offbeat", query: "weird offbeat comedy with heart", watchContext: "solo" },
  { id: "romantic-date", query: "romantic date night movie that is not too heavy", watchContext: "group" },
  { id: "classic-sci-fi", query: "classic thoughtful sci-fi movie", watchContext: "solo" },
  { id: "british-comedy", query: "classic british comedy requestable", watchContext: "solo" },
  { id: "short-tv", query: "short easy tv episodes for background watching", watchContext: "solo", filters: { mediaTypes: ["tv"] } },
  { id: "not-animation", query: "live action adventure not animation", watchContext: "group", filters: { excludedGenres: ["Animation"] } },
  { id: "no-horror", query: "suspenseful mystery but no horror", watchContext: "solo", filters: { excludedGenres: ["Horror"] } },
  { id: "plex-only", query: "plex only light movie, no requestable options", watchContext: "solo", filters: { availability: ["available_in_plex"] } },
  { id: "requestable-not-plex", query: "requestable fantasy adventure not in Plex", watchContext: "solo", filters: { availability: ["not_in_plex_requestable"] } },
  { id: "comfort-tv", query: "comforting sitcom with low friction", watchContext: "group", filters: { mediaTypes: ["tv"] } },
  { id: "intense-thriller", query: "intense thriller with smart plotting", watchContext: "solo" },
  { id: "heartfelt-animation", query: "heartfelt animated family adventure", watchContext: "group", filters: { mediaTypes: ["movie"] } },
  { id: "surprise-cozy", query: "surprise me with something cozy and emotionally sincere", watchContext: "solo" },
  { id: "older-classic", query: "older classic movie with gentle humor", watchContext: "solo", filters: { maxYear: 1985 } },
  { id: "newer-series", query: "newer clever tv series not too dark", watchContext: "solo", filters: { mediaTypes: ["tv"], minYear: 2015 } },
  { id: "group-friendly", query: "group friendly crowd pleaser with adventure", watchContext: "group" },
  { id: "quiet-drama", query: "quiet sincere drama with warmth", watchContext: "solo" },
  { id: "fantasy-like-stardust", query: "more like Stardust but gentler", watchContext: "solo" },
  { id: "not-scary-fantasy-shows", query: "not scary fantasy shows with adventure", watchContext: "group", filters: { mediaTypes: ["tv"], excludedGenres: ["Horror"] } }
];

export const catalogRequestAttemptBenchmarkCases: CatalogBenchmarkCaseDefinition[] = [
  { id: "attempt-warm-fantasy-movie", query: "I want to request a warm fantasy movie", watchContext: "solo", expectedResult: "scored" },
  { id: "attempt-missing-fantasy", query: "find a missing fantasy title to request", watchContext: "solo", expectedResult: "scored" },
  { id: "attempt-gentle-adventure", query: "try to request a gentle adventure movie", watchContext: "solo", expectedResult: "scored" },
  { id: "attempt-funny-movie", query: "I need to request a funny movie", watchContext: "group", expectedResult: "scored" },
  { id: "attempt-clever-tv", query: "we want to request a clever TV series", watchContext: "group", expectedResult: "scored" },
  { id: "attempt-cozy-film", query: "show me a cozy film to request", watchContext: "solo", expectedResult: "scored" },
  { id: "attempt-family-movie", query: "recommend a family movie to request", watchContext: "group", expectedResult: "scored" },
  { id: "attempt-light-tv", query: "suggest a light TV show to request", watchContext: "solo", expectedResult: "scored" },
  { id: "attempt-classic-sci-fi", query: "I would like to request a classic science fiction movie", watchContext: "solo", expectedResult: "scored" },
  { id: "attempt-older-comedy", query: "I want to request an older comedy film", watchContext: "group", expectedResult: "scored" },
  { id: "attempt-newer-drama-tv", query: "we need to request a newer drama series", watchContext: "solo", expectedResult: "scored" },
  { id: "attempt-romantic-movie", query: "attempt to request a romantic movie", watchContext: "group", expectedResult: "scored" },
  { id: "attempt-mystery-movie", query: "request a mystery movie", watchContext: "solo", expectedResult: "scored" },
  { id: "attempt-weird-offbeat", query: "request something weird and offbeat", watchContext: "solo", expectedResult: "scored" },
  { id: "attempt-quiet-drama", query: "find a quiet drama to request", watchContext: "solo", expectedResult: "scored" },
  { id: "attempt-group-adventure", query: "show a group-friendly adventure to request", watchContext: "group", expectedResult: "scored" },
  { id: "attempt-heartfelt-animation", query: "recommend a heartfelt animated movie to request", watchContext: "group", expectedResult: "scored" },
  { id: "attempt-british-comedy", query: "suggest a British comedy to request", watchContext: "solo", expectedResult: "scored" },
  { id: "attempt-not-horror-fantasy-tv", query: "I want to request a fantasy show but not horror", watchContext: "group", expectedResult: "scored" },
  { id: "attempt-thoughtful-sci-fi", query: "try to request a thoughtful science fiction film", watchContext: "solo", expectedResult: "scored" },
  { id: "isolation-generic", query: "warm fantasy movie", watchContext: "solo", expectedResult: "zero" },
  { id: "isolation-requestable-wording", query: "show requestable fantasy options", watchContext: "solo", expectedResult: "zero" },
  { id: "isolation-verified-requestable", query: "requestable fantasy movie only", watchContext: "solo", filters: { availability: ["not_in_plex_requestable"] }, expectedResult: "zero" },
  { id: "isolation-plex-only", query: "light movie already in Plex", watchContext: "solo", filters: { availability: ["available_in_plex"] }, expectedResult: "zero" }
];

export class CatalogBenchmarkArgumentError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "CatalogBenchmarkArgumentError";
  }
}

export function benchmarkCasesForProfile(profile: CatalogSearchBenchmarkProfile) {
  return profile === "catalog-request-attempt" ? catalogRequestAttemptBenchmarkCases : operationalBenchmarkCases;
}

export function parseCatalogSearchBenchmarkArgs(values: string[]): CatalogSearchBenchmarkArgs {
  const parsed: CatalogSearchBenchmarkArgs = {
    enforceAdvisoryTargets: false,
    iterations: 3,
    profile: "operational",
    skipEngine: false
  };
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index]!;
    if (seen.has(key)) throw new CatalogBenchmarkArgumentError("duplicate_option");
    seen.add(key);
    if (key === "--skip-engine") {
      parsed.skipEngine = true;
      continue;
    }
    if (key === "--enforce-advisory-targets") {
      parsed.enforceAdvisoryTargets = true;
      continue;
    }
    if (key !== "--limit" && key !== "--iterations" && key !== "--profile") {
      throw new CatalogBenchmarkArgumentError("unknown_option");
    }
    const value = values[++index];
    if (value === undefined || value.startsWith("--")) throw new CatalogBenchmarkArgumentError("missing_option_value");
    if (key === "--profile") {
      if (value !== "operational" && value !== "catalog-request-attempt") {
        throw new CatalogBenchmarkArgumentError("invalid_profile");
      }
      parsed.profile = value;
      continue;
    }
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 1) throw new CatalogBenchmarkArgumentError("invalid_positive_integer");
    if (key === "--limit") parsed.limit = number;
    else parsed.iterations = number;
  }
  return parsed;
}

export function evaluateCatalogBenchmarkCorpusPreflight(profile: CatalogSearchBenchmarkProfile, corpus: CatalogBenchmarkCorpus) {
  const counts = Object.values(corpus);
  if (!counts.every((value) => Number.isSafeInteger(value) && value >= 0)) throw new Error("invalid_corpus_counts");
  if (corpus.requestAttemptProbeCount > corpus.requestAttemptProbeLimit) throw new Error("invalid_request_attempt_probe");

  const failures: string[] = [];
  if (corpus.totalItems < 1) failures.push("empty_corpus");
  if (profile === "operational") {
    if (corpus.plexVerifiedItems < 1) failures.push("missing_plex_verified_items");
    if (corpus.seerrVerifiedItems < 1) failures.push("missing_seerr_verified_items");
  } else {
    if (corpus.catalogOnlyItems < 1) failures.push("missing_catalog_only_items");
    if (corpus.requestAttemptProbeCount < 1) failures.push("missing_request_attempt_candidates");
    if (corpus.plexVerifiedItems > 0 || corpus.seerrVerifiedItems > 0) failures.push("operational_items_contaminate_isolation_corpus");
  }

  return {
    profile,
    status: failures.length === 0 ? "pass" as const : "fail" as const,
    failures,
    corpus
  };
}

export function evaluateCatalogBenchmarkContract<T extends CatalogBenchmarkSample>(input: {
  caseIds: string[];
  expectedZeroCaseIds?: string[];
  iterations: number;
  samples: T[];
  finalIndexHealthy: boolean;
  corpusPreflightPassed: boolean;
  measureEngine: boolean;
  noRemoteDescriptiveContentAllowed: boolean;
  noRemoteSearchCalls: number;
  enforceAdvisoryTargets: boolean;
  thresholds: CatalogBenchmarkThresholds;
}) {
  if (!Number.isSafeInteger(input.iterations) || input.iterations < 1) throw new Error("invalid_iterations");
  if (input.caseIds.length === 0 || new Set(input.caseIds).size !== input.caseIds.length) throw new Error("invalid_case_ids");
  if (!Number.isSafeInteger(input.noRemoteSearchCalls) || input.noRemoteSearchCalls < 0) throw new Error("invalid_no_remote_search_calls");
  const caseIdSet = new Set(input.caseIds);
  const expectedZeroCaseIds = input.expectedZeroCaseIds ?? [];
  if (new Set(expectedZeroCaseIds).size !== expectedZeroCaseIds.length || expectedZeroCaseIds.some((caseId) => !caseIdSet.has(caseId))) {
    throw new Error("invalid_expected_zero_case_ids");
  }
  const expectedZeroCaseIdSet = new Set(expectedZeroCaseIds);
  const expectedScoredCaseIds = input.caseIds.filter((caseId) => !expectedZeroCaseIdSet.has(caseId));
  const samplesIndividuallyValid =
    input.samples.length === input.caseIds.length * input.iterations &&
    input.samples.every(
      (sample) =>
        caseIdSet.has(sample.caseId) &&
        Number.isFinite(sample.totalLocalMs) &&
        sample.totalLocalMs >= 0 &&
        Number.isSafeInteger(sample.scoredItemCount) &&
        sample.scoredItemCount >= 0 &&
        (sample.engineMs === undefined || (Number.isFinite(sample.engineMs) && sample.engineMs >= 0)) &&
        (sample.engineResultCount === undefined || (Number.isSafeInteger(sample.engineResultCount) && sample.engineResultCount >= 0))
    );

  const sampleCountsByCase = new Map<string, number>();
  const scoredSampleCountsByCase = new Map<string, number>();
  const engineResultSampleCountsByCase = new Map<string, number>();
  for (const sample of input.samples) {
    sampleCountsByCase.set(sample.caseId, (sampleCountsByCase.get(sample.caseId) ?? 0) + 1);
    if (sample.scoredItemCount > 0) {
      scoredSampleCountsByCase.set(sample.caseId, (scoredSampleCountsByCase.get(sample.caseId) ?? 0) + 1);
    }
    if ((sample.engineResultCount ?? 0) > 0) {
      engineResultSampleCountsByCase.set(sample.caseId, (engineResultSampleCountsByCase.get(sample.caseId) ?? 0) + 1);
    }
  }
  const sampleSetValid =
    samplesIndividuallyValid && input.caseIds.every((caseId) => sampleCountsByCase.get(caseId) === input.iterations);

  const consistentlyScoredCaseIds = input.caseIds.filter(
    (caseId) => sampleCountsByCase.get(caseId) === input.iterations && scoredSampleCountsByCase.get(caseId) === input.iterations
  );
  const consistentlyZeroCaseIds = input.caseIds.filter(
    (caseId) => sampleCountsByCase.get(caseId) === input.iterations && (scoredSampleCountsByCase.get(caseId) ?? 0) === 0
  );
  const unstableCoverageCaseIds = input.caseIds.filter(
    (caseId) => !consistentlyScoredCaseIds.includes(caseId) && !consistentlyZeroCaseIds.includes(caseId)
  );
  const usesExplicitExpectations = input.expectedZeroCaseIds !== undefined;
  const requiredScoredCases = usesExplicitExpectations
    ? expectedScoredCaseIds.length
    : Math.max(1, Math.ceil(input.caseIds.length * 0.8));
  const explicitExpectationsSatisfied =
    !usesExplicitExpectations ||
    (expectedScoredCaseIds.every((caseId) => consistentlyScoredCaseIds.includes(caseId)) &&
      expectedZeroCaseIds.every((caseId) => consistentlyZeroCaseIds.includes(caseId)));
  const scoringCoverageValid =
    sampleSetValid &&
    consistentlyScoredCaseIds.length >= requiredScoredCases &&
    unstableCoverageCaseIds.length === 0 &&
    explicitExpectationsSatisfied;

  const engineResultPresenceMismatchCaseIds = input.measureEngine
    ? input.caseIds.filter((caseId) =>
        input.samples.some(
          (sample) =>
            sample.caseId === caseId &&
            ((sample.scoredItemCount > 0) !== ((sample.engineResultCount ?? 0) > 0))
        )
      )
    : [];
  const engineCoverageValid =
    sampleSetValid &&
    (!input.measureEngine ||
      (input.samples.every(
        (sample) =>
          typeof sample.engineMs === "number" &&
          Number.isFinite(sample.engineMs) &&
          Number.isSafeInteger(sample.engineResultCount) &&
          sample.engineResultCount! >= 0
      ) && engineResultPresenceMismatchCaseIds.length === 0));
  const noRemoteBoundaryValid = !input.noRemoteDescriptiveContentAllowed && input.noRemoteSearchCalls === 0;
  const scoredSamples = input.samples.filter((sample) => sample.scoredItemCount > 0);
  const allLocal = input.samples.map((sample) => sample.totalLocalMs);
  const scoredLocal = scoredSamples.map((sample) => sample.totalLocalMs);
  const allEngine = input.samples.flatMap((sample) => (sample.engineMs === undefined ? [] : [sample.engineMs]));
  const scoredEngine = scoredSamples.flatMap((sample) => (sample.engineMs === undefined ? [] : [sample.engineMs]));

  const validityStatus = {
    corpusPreflight: input.corpusPreflightPassed ? "pass" : "fail",
    sampleSet: sampleSetValid ? "pass" : "invalid_sample_set",
    catalogIndexHealth: input.finalIndexHealthy ? "pass" : "fail",
    scoringCoverage: scoringCoverageValid ? "pass" : "invalid_insufficient_scored_coverage",
    engineCoverage: engineCoverageValid ? "pass" : "invalid_incomplete_or_inconsistent_engine_coverage",
    noRemoteBoundary: noRemoteBoundaryValid ? "pass" : "fail"
  } as const;
  const advisoryTargetStatus = {
    localNoAiP50: !scoringCoverageValid
      ? "invalid_insufficient_scored_coverage"
      : worstPercentile(allLocal, scoredLocal, 0.5) <= input.thresholds.localP50Ms
        ? "pass"
        : "fail",
    localNoAiP95: !scoringCoverageValid
      ? "invalid_insufficient_scored_coverage"
      : worstPercentile(allLocal, scoredLocal, 0.95) <= input.thresholds.localP95Ms
        ? "pass"
        : "fail",
    engineNoAiNoRemoteP95: !input.measureEngine
      ? "skipped"
      : !scoringCoverageValid || !engineCoverageValid || !noRemoteBoundaryValid
        ? "invalid_incomplete_engine_evidence"
        : worstPercentile(allEngine, scoredEngine, 0.95) <= input.thresholds.engineP95Ms
          ? "pass"
          : "fail"
  } as const;
  const validityFailed = Object.values(validityStatus).some((status) => status !== "pass");
  const advisoryFailed = Object.values(advisoryTargetStatus).some((status) => status === "fail");

  return {
    scoredSamples,
    scoringCoverage: {
      valid: scoringCoverageValid,
      expectationMode: usesExplicitExpectations ? "explicit" as const : "minimum-80-percent" as const,
      scoredCases: consistentlyScoredCaseIds.length,
      requiredScoredCases,
      totalCases: input.caseIds.length,
      expectedScoredCaseIds: usesExplicitExpectations ? expectedScoredCaseIds : undefined,
      expectedZeroCaseIds: usesExplicitExpectations ? expectedZeroCaseIds : undefined,
      consistentlyScoredCaseIds,
      consistentlyZeroCaseIds,
      unstableCoverageCaseIds,
      scoredSamples: scoredSamples.length,
      zeroResultSamples: input.samples.length - scoredSamples.length,
      totalScoredResults: scoredSamples.reduce((total, sample) => total + sample.scoredItemCount, 0)
    },
    engineCoverage: {
      valid: engineCoverageValid,
      measured: input.measureEngine,
      samplesWithTiming: input.samples.filter((sample) => sample.engineMs !== undefined).length,
      samplesWithResultCount: input.samples.filter((sample) => sample.engineResultCount !== undefined).length,
      consistentlyResultCaseIds: input.caseIds.filter(
        (caseId) => engineResultSampleCountsByCase.get(caseId) === input.iterations
      ),
      resultPresenceMismatchCaseIds: engineResultPresenceMismatchCaseIds
    },
    noRemoteBoundary: {
      valid: noRemoteBoundaryValid,
      descriptiveContentAllowed: input.noRemoteDescriptiveContentAllowed,
      searchCalls: input.noRemoteSearchCalls
    },
    validityStatus,
    advisoryTargetStatus,
    exitCode: validityFailed || (input.enforceAdvisoryTargets && advisoryFailed) ? 1 : 0
  } as const;
}

function worstPercentile(all: number[], scored: number[], percentileValue: number) {
  return Math.max(nearestRankPercentile(all, percentileValue), nearestRankPercentile(scored, percentileValue));
}

function nearestRankPercentile(values: number[], percentileValue: number) {
  if (values.length === 0) return Number.POSITIVE_INFINITY;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * percentileValue) - 1)]!;
}
