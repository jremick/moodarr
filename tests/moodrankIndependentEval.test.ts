import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ItemSummary } from "../src/shared/types";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import {
  IndependentEvalContractError,
  aggregateIndependentEvalMetrics,
  calculateCaseObservation,
  evidenceStatusForCaseCount,
  evaluateConstraintSlate,
  parseBlindCaseSet,
  parseBlindJudgmentSet,
  validateBlindEvaluationInputs,
  type BlindCaseJudgmentV1,
  type IndependentEvalCaseObservation
} from "../scripts/moodrank-independent-eval-contract";
import {
  aggregateSafeReport,
  independentEvaluationEvidenceState,
  installIndependentEvaluationFetchGuard,
  parseIndependentEvalArgs,
  runIndependentEvaluation,
  type IndependentEvalSourceState
} from "../scripts/evaluate-moodrank-independent";

const fixtureCasesRaw = readFileSync(new URL("./fixtures/moodrank-independent-eval/cases.valid.json", import.meta.url), "utf8");
const fixtureJudgmentsRaw = readFileSync(new URL("./fixtures/moodrank-independent-eval/judgments.valid.json", import.meta.url), "utf8");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("MoodRank independent evaluation contract", () => {
  it("strictly parses separate case and judgment documents", () => {
    const caseSet = parseBlindCaseSet(fixtureCasesRaw);
    const judgmentSet = parseBlindJudgmentSet(fixtureJudgmentsRaw);

    expect(caseSet.schemaVersion).toBe("moodrank-blind-cases-v1");
    expect(judgmentSet.schemaVersion).toBe("moodrank-blind-judgments-v1");
    expect(validateBlindEvaluationInputs(caseSet, judgmentSet).caseIds).toEqual(new Set(["warm-comedy"]));
  });

  it("rejects malformed JSON, unknown nested fields, invalid privacy bindings, and caller pass flags", () => {
    expect(() => parseBlindCaseSet("{")) .toThrowError(IndependentEvalContractError);

    const unknownCaseField = jsonFixture(fixtureCasesRaw);
    unknownCaseField.cases[0].unexpected = true;
    expect(() => parseBlindCaseSet(JSON.stringify(unknownCaseField))).toThrow(/invalid_cases_document/);

    const invalidPrivacy = jsonFixture(fixtureCasesRaw);
    invalidPrivacy.cases[0].sourceKind = "sanitized-real";
    expect(() => parseBlindCaseSet(JSON.stringify(invalidPrivacy))).toThrow(/privacyReview must be sanitized/);

    const callerPassFlag = jsonFixture(fixtureJudgmentsRaw);
    callerPassFlag.cases[0].passed = true;
    expect(() => parseBlindJudgmentSet(JSON.stringify(callerPassFlag))).toThrow(/invalid_judgments_document/);
  });

  it("rejects duplicate IDs, invalid grades, self-pairs, missing judgments, and dangling refs", () => {
    const duplicateCases = jsonFixture(fixtureCasesRaw);
    duplicateCases.cases.push({ ...duplicateCases.cases[0] });
    expect(() => parseBlindCaseSet(JSON.stringify(duplicateCases))).toThrow(/duplicate case ID/);

    const invalidGrade = jsonFixture(fixtureJudgmentsRaw);
    invalidGrade.cases[0].gradedRelevance[0].grade = 4;
    expect(() => parseBlindJudgmentSet(JSON.stringify(invalidGrade))).toThrow(/invalid_judgments_document/);

    const selfPair = jsonFixture(fixtureJudgmentsRaw);
    selfPair.cases[0].pairwise = [{ preferredItemRef: "warm-comedy-2024", otherItemRef: "warm-comedy-2024", outcome: "preferred" }];
    expect(() => parseBlindJudgmentSet(JSON.stringify(selfPair))).toThrow(/pairwise item refs must differ/);

    const duplicatePair = jsonFixture(fixtureJudgmentsRaw);
    duplicatePair.items.push({ ref: "other", externalId: { source: "tmdb", value: "990002" }, mediaType: "movie" });
    duplicatePair.cases[0].pairwise = [
      { preferredItemRef: "warm-comedy-2024", otherItemRef: "other", outcome: "preferred" },
      { preferredItemRef: "other", otherItemRef: "warm-comedy-2024", outcome: "preferred" }
    ];
    expect(() => parseBlindJudgmentSet(JSON.stringify(duplicatePair))).toThrow(/duplicate pairwise item pair/);

    const extraCaseSet = jsonFixture(fixtureCasesRaw);
    extraCaseSet.cases.push({ ...extraCaseSet.cases[0], id: "second-case" });
    expectContractCode(
      () => validateBlindEvaluationInputs(parseBlindCaseSet(JSON.stringify(extraCaseSet)), parseBlindJudgmentSet(fixtureJudgmentsRaw)),
      "missing_case_judgments"
    );

    const dangling = jsonFixture(fixtureJudgmentsRaw);
    dangling.cases[0].acceptableFamilies[0].itemRefs = ["missing-ref"];
    const parsedDangling = parseBlindJudgmentSet(JSON.stringify(dangling));
    expectContractCode(() => validateBlindEvaluationInputs(parseBlindCaseSet(fixtureCasesRaw), parsedDangling), "dangling_item_ref");
  });

  it("binds source, media type, and value without rejecting valid cross-type numeric overlaps", () => {
    const judgments = jsonFixture(fixtureJudgmentsRaw);
    judgments.items.push({
      ref: "same-tmdb-tv",
      externalId: { source: "tmdb", value: "990001" },
      title: "Synthetic Series",
      mediaType: "tv"
    });
    expect(parseBlindJudgmentSet(JSON.stringify(judgments)).items).toHaveLength(2);

    judgments.items.push({
      ref: "same-tmdb-movie-duplicate",
      externalId: { source: "tmdb", value: "990001" },
      mediaType: "movie"
    });
    expect(() => parseBlindJudgmentSet(JSON.stringify(judgments))).toThrow(/duplicate external item ID/);
  });

  it("calculates hand-checkable retrieval, ranking, family, pairwise, and constraint metrics", () => {
    const judgment: BlindCaseJudgmentV1 = {
      caseId: "case-a",
      acceptableFamilies: [
        { familyId: "family-one", itemRefs: ["a", "b"] },
        { familyId: "family-two", itemRefs: ["d"] }
      ],
      gradedRelevance: [
        { itemRef: "a", grade: 3 },
        { itemRef: "b", grade: 2 },
        { itemRef: "d", grade: 1 }
      ],
      pairwise: [{ preferredItemRef: "a", otherItemRef: "b", outcome: "preferred" }],
      constraintChecks: [
        { id: "movie", filters: { mediaTypes: ["movie"] }, resultCutoff: 3, expected: "pass" },
        { id: "future", filters: { minYear: 2030 }, resultCutoff: 3, expected: "fail" },
        { id: "runtime", filters: { maxRuntimeMinutes: 120 }, resultCutoff: 3, expected: "unknown" }
      ],
      reviewerCount: 2,
      adjudicationStatus: "complete"
    };
    const itemIdByRef = new Map(["a", "b", "c", "d"].map((ref) => [ref, ref]));
    const rankedItems = [
      item("a", { year: 2024, runtimeMinutes: 90, genres: ["Comedy"] }),
      item("c", { year: 2024, runtimeMinutes: 100, genres: ["Drama"] }),
      item("b", { year: 2024, genres: ["Comedy"] })
    ];
    const observation = calculateCaseObservation({
      caseId: "case-a",
      judgment,
      itemIdByRef,
      preRerankItemIds: ["a", "c"],
      rankedItems,
      retrievalMs: 2,
      scoringMs: 3
    });

    expect(observation.preRerankRecall).toBeCloseTo(1 / 3);
    expect(observation.ndcgAt3).toBeCloseTo(8.5 / (7 + 3 / Math.log2(3) + 1 / Math.log2(4)));
    expect(observation.ndcgAt10).toBeCloseTo(observation.ndcgAt3!);
    expect(observation.acceptableFamilyHitAt3).toBe(0.5);
    expect(observation.pairwiseCoverage).toBe(1);
    expect(observation.pairwiseAccuracy).toBe(1);
    expect(observation.constraintCounts).toEqual({ pass: 1, fail: 1, unknown: 1 });
    expect(observation.constraintExpectedMatches).toBe(3);
  });

  it("keeps unknown constraint metadata distinct from pass and fail", () => {
    expect(evaluateConstraintSlate([item("known", { runtimeMinutes: 90 })], { maxRuntimeMinutes: 120 })).toBe("pass");
    expect(evaluateConstraintSlate([item("slow", { runtimeMinutes: 140 })], { maxRuntimeMinutes: 120 })).toBe("fail");
    expect(evaluateConstraintSlate([item("unknown")], { maxRuntimeMinutes: 120 })).toBe("unknown");
    expect(evaluateConstraintSlate([], { maxRuntimeMinutes: 120 })).toBe("unknown");
  });

  it("marks NDCG as skipped when a case has acceptable families but no graded relevance", () => {
    const judgment: BlindCaseJudgmentV1 = {
      caseId: "family-only",
      acceptableFamilies: [{ familyId: "acceptable", itemRefs: ["a"] }],
      gradedRelevance: [],
      pairwise: [],
      constraintChecks: [],
      reviewerCount: 1,
      adjudicationStatus: "complete"
    };
    const result = calculateCaseObservation({
      caseId: "family-only",
      judgment,
      itemIdByRef: new Map([["a", "a"]]),
      preRerankItemIds: ["a"],
      rankedItems: [item("a")],
      retrievalMs: 1,
      scoringMs: 1
    });
    const aggregate = aggregateIndependentEvalMetrics([result], 123, 10);

    expect(result.ndcgAt3).toBeNull();
    expect(result.ndcgAt10).toBeNull();
    expect(aggregate.ndcgAt3).toEqual({ value: null, ci95: null, contributingCases: 0 });
    expect(aggregate.ndcgAt10).toEqual({ value: null, ci95: null, contributingCases: 0 });
  });

  it("uses deterministic case-clustered bootstrap intervals and evidence maturity", () => {
    const observations = [observation("b", 0.2), observation("a", 0.8), observation("c", 0.5)];
    const first = aggregateIndependentEvalMetrics(observations, 123, 500);
    const repeated = aggregateIndependentEvalMetrics([...observations].reverse(), 123, 500);
    expect(repeated).toEqual(first);
    expect(first.judgedRelevantPreRerankRecall.value).toBe(0.5);
    expect(first.judgedRelevantPreRerankRecall.ci95).not.toBeNull();
    expect(evidenceStatusForCaseCount(29)).toBe("insufficient");
    expect(evidenceStatusForCaseCount(30)).toBe("pilot");
    expect(evidenceStatusForCaseCount(99)).toBe("pilot");
    expect(evidenceStatusForCaseCount(100)).toBe("gate_eligible");
  });
});

describe("MoodRank independent evaluation runner", () => {
  const cleanSourceState: IndependentEvalSourceState = {
    commit: "a".repeat(40),
    dirty: false,
    treeSha256: `sha256:${"b".repeat(64)}`
  };
  const cleanSourceDependencies = { sourceState: () => cleanSourceState };

  it("strictly parses its bounded CLI surface", () => {
    const args = parseIndependentEvalArgs(["--cases", "cases.json", "--judgments", "judgments.json", "--catalog", "catalog.sqlite", "--seed", "42"]);
    expect(args.seed).toBe(42);
    expect(args.casesPath).toMatch(/cases\.json$/);
    for (const invalid of [
      [],
      ["--cases", "a", "--judgments", "b"],
      ["--unknown", "x"],
      ["--cases", "a", "--cases", "b", "--judgments", "c", "--catalog", "d"],
      ["--cases", "a", "--judgments", "b", "--catalog", "c", "--seed", "-1"]
    ]) {
      expect(() => parseIndependentEvalArgs(invalid)).toThrow();
    }
  });

  it("blocks fetch and restores the original implementation idempotently", async () => {
    const originalFetch = globalThis.fetch;
    const restoreFetch = installIndependentEvaluationFetchGuard();
    try {
      await expect(globalThis.fetch("https://example.invalid/evaluation-must-stay-offline")).rejects.toMatchObject({
        code: "network_call_blocked"
      });
      expect(() => installIndependentEvaluationFetchGuard()).toThrowError(
        expect.objectContaining({ code: "concurrent_evaluation_not_supported" })
      );
    } finally {
      restoreFetch();
      restoreFetch();
    }
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("runs against a cold read-only snapshot without changing it or exposing case details by default", async () => {
    const fixture = createRunnerFixture();
    const beforeHash = fileHash(fixture.catalogPath);
    const report = await runIndependentEvaluation({
      casesPath: fixture.casesPath,
      judgmentsPath: fixture.judgmentsPath,
      catalogPath: fixture.catalogPath,
      seed: 42
    }, cleanSourceDependencies);

    expect(report.status).toBe("completed");
    expect(report.evidenceStatus).toBe("insufficient");
    expect(report.evaluationStages).toEqual({
      preRerank: "retrieved_candidates",
      ranked: "deterministic_rank_index_slate",
      productResponseParity: false
    });
    expect(report.details).toBeUndefined();
    expect(fileHash(fixture.catalogPath)).toBe(beforeHash);
    expect(JSON.stringify(aggregateSafeReport(report))).not.toContain("warm comedy for a quiet evening");
    expect(JSON.stringify(aggregateSafeReport(report))).not.toContain(fixture.directory);
    expect(report.provenance.sourceDirty).not.toBe("unknown");
    expect(report.provenance.sourceTreeSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.provenance.executionPolicy).toMatchObject({
      databaseReadOnly: true,
      sqliteQueryOnly: true,
      startupRepairsDisabled: true,
      aiDisabled: true,
      personalizationDisabled: true,
      globalFetchBlocked: true,
      networkClientsInstantiated: false,
      recommendationSessionWritesDisabled: true
    });

    const repeated = await runIndependentEvaluation({
      casesPath: fixture.casesPath,
      judgmentsPath: fixture.judgmentsPath,
      catalogPath: fixture.catalogPath,
      seed: 42
    }, cleanSourceDependencies);
    expect(repeated.provenance.contentHashes).toEqual(report.provenance.contentHashes);
    expect(qualityMetricsJson(repeated.metrics)).toBe(qualityMetricsJson(report.metrics));
  });

  it("rejects a symlinked catalog snapshot", async () => {
    const fixture = createRunnerFixture();
    const catalogAlias = join(fixture.directory, "catalog-alias.sqlite");
    symlinkSync(fixture.catalogPath, catalogAlias);
    await expect(runIndependentEvaluation({
      casesPath: fixture.casesPath,
      judgmentsPath: fixture.judgmentsPath,
      catalogPath: catalogAlias,
      seed: 42
    }, cleanSourceDependencies)).rejects.toMatchObject({ code: "catalog_file_not_regular" });
  });

  it("keeps dirty and unknown source runs incomplete and ineligible for gate evidence", () => {
    expect(independentEvaluationEvidenceState(100, cleanSourceState)).toEqual({
      status: "completed",
      evidenceStatus: "gate_eligible"
    });
    expect(independentEvaluationEvidenceState(100, { ...cleanSourceState, dirty: true })).toEqual({
      status: "incomplete",
      evidenceStatus: "insufficient"
    });
    expect(independentEvaluationEvidenceState(100, {
      commit: "unknown",
      dirty: "unknown",
      treeSha256: "unknown"
    })).toEqual({
      status: "incomplete",
      evidenceStatus: "insufficient"
    });
  });

  it("returns exploratory metrics for a stable dirty source without completing evidence", async () => {
    const fixture = createRunnerFixture();
    const report = await runIndependentEvaluation({
      casesPath: fixture.casesPath,
      judgmentsPath: fixture.judgmentsPath,
      catalogPath: fixture.catalogPath,
      seed: 42
    }, {
      sourceState: () => ({ ...cleanSourceState, dirty: true })
    });

    expect(report.status).toBe("incomplete");
    expect(report.evidenceStatus).toBe("insufficient");
    expect(report.evaluatedCases).toBe(1);
    expect(report.metrics.judgedRelevantPreRerankRecall.contributingCases).toBe(1);
  });

  it("rejects evidence when source state changes during evaluation", async () => {
    const fixture = createRunnerFixture();
    const changedSourceState = { ...cleanSourceState, treeSha256: `sha256:${"c".repeat(64)}` };
    let sourceReadCount = 0;

    await expect(runIndependentEvaluation({
      casesPath: fixture.casesPath,
      judgmentsPath: fixture.judgmentsPath,
      catalogPath: fixture.catalogPath,
      seed: 42
    }, {
      sourceState: () => sourceReadCount++ === 0 ? cleanSourceState : changedSourceState
    })).rejects.toMatchObject({ code: "source_state_changed_during_evaluation" });

    expect(sourceReadCount).toBe(2);
  });

  it("writes case detail only to an explicitly named private output file", async () => {
    const fixture = createRunnerFixture();
    const outputPath = join(fixture.directory, "full-report.json");
    const report = await runIndependentEvaluation({
      casesPath: fixture.casesPath,
      judgmentsPath: fixture.judgmentsPath,
      catalogPath: fixture.catalogPath,
      outputPath,
      seed: 42
    }, cleanSourceDependencies);
    const saved = JSON.parse(readFileSync(outputPath, "utf8")) as { details?: unknown[] };

    expect(report.details).toHaveLength(1);
    expect(saved.details).toHaveLength(1);
    expect(statSync(outputPath).mode & 0o777).toBe(0o600);
    await expect(runIndependentEvaluation({
      casesPath: fixture.casesPath,
      judgmentsPath: fixture.judgmentsPath,
      catalogPath: fixture.catalogPath,
      outputPath,
      seed: 42
    })).rejects.toMatchObject({ code: "output_file_already_exists" });
  });

  it("rejects a private report inside the repository", async () => {
    const fixture = createRunnerFixture();
    await expect(runIndependentEvaluation({
      casesPath: fixture.casesPath,
      judgmentsPath: fixture.judgmentsPath,
      catalogPath: fixture.catalogPath,
      outputPath: join(process.cwd(), ".data", "private-independent-eval-test.json"),
      seed: 42
    }, cleanSourceDependencies)).rejects.toMatchObject({ code: "private_output_must_be_outside_repository" });
  });

  it("rejects an unresolved item ref before evaluating cases", async () => {
    const fixture = createRunnerFixture();
    const originalFetch = globalThis.fetch;
    const judgments = jsonFixture(readFileSync(fixture.judgmentsPath, "utf8"));
    judgments.items[0].externalId.value = "999999999";
    writeFileSync(fixture.judgmentsPath, JSON.stringify(judgments));

    await expect(runIndependentEvaluation({
      casesPath: fixture.casesPath,
      judgmentsPath: fixture.judgmentsPath,
      catalogPath: fixture.catalogPath,
      seed: 42
    })).rejects.toMatchObject({ code: "unresolved_item_ref" });

    expect(globalThis.fetch).toBe(originalFetch);
    const validFixture = createRunnerFixture();
    await expect(runIndependentEvaluation({
      casesPath: validFixture.casesPath,
      judgmentsPath: validFixture.judgmentsPath,
      catalogPath: validFixture.catalogPath,
      seed: 42
    }, cleanSourceDependencies)).resolves.toMatchObject({ status: "completed" });
  });

  it("rejects cross-type ambiguity and two refs that resolve to the same catalog item", async () => {
    const ambiguousFixture = createRunnerFixture();
    const ambiguousJudgments = jsonFixture(readFileSync(ambiguousFixture.judgmentsPath, "utf8"));
    delete ambiguousJudgments.items[0].mediaType;
    writeFileSync(ambiguousFixture.judgmentsPath, JSON.stringify(ambiguousJudgments));
    await expect(runIndependentEvaluation({
      casesPath: ambiguousFixture.casesPath,
      judgmentsPath: ambiguousFixture.judgmentsPath,
      catalogPath: ambiguousFixture.catalogPath,
      seed: 42
    })).rejects.toMatchObject({ code: "ambiguous_item_ref" });

    const duplicateFixture = createRunnerFixture();
    const duplicateJudgments = jsonFixture(readFileSync(duplicateFixture.judgmentsPath, "utf8"));
    duplicateJudgments.items.push({
      ref: "warm-comedy-imdb-alias",
      externalId: { source: "imdb", value: "tt0990001" },
      mediaType: "movie"
    });
    writeFileSync(duplicateFixture.judgmentsPath, JSON.stringify(duplicateJudgments));
    await expect(runIndependentEvaluation({
      casesPath: duplicateFixture.casesPath,
      judgmentsPath: duplicateFixture.judgmentsPath,
      catalogPath: duplicateFixture.catalogPath,
      seed: 42
    })).rejects.toMatchObject({ code: "duplicate_resolved_item_ref" });
  });
});

function createRunnerFixture() {
  const directory = mkdtempSync(join(tmpdir(), "moodrank-independent-eval-"));
  temporaryDirectories.push(directory);
  const catalogPath = join(directory, "catalog.sqlite");
  const db = createDatabase(catalogPath);
  const repository = new MediaRepository(db);
  repository.upsert({
    mediaType: "movie",
    title: "Synthetic Warm Comedy",
    year: 2024,
    runtimeMinutes: 96,
    summary: "A kind and funny story about a close community.",
    genres: ["Comedy"],
    externalIds: { tmdb: 990001, imdb: "tt0990001" }
  });
  repository.upsert({
    mediaType: "tv",
    title: "Synthetic Warm Comedy Series",
    year: 2024,
    runtimeMinutes: 30,
    summary: "A kind and funny episodic story about a close community.",
    genres: ["Comedy"],
    externalIds: { tmdb: 990001 }
  });
  repository.upsert({
    mediaType: "movie",
    title: "Synthetic Cold Thriller",
    year: 2022,
    runtimeMinutes: 108,
    summary: "A severe and tense mystery.",
    genres: ["Thriller"],
    externalIds: { tmdb: 990002 }
  });
  db.close();
  chmodSync(catalogPath, 0o600);
  const catalogSnapshotId = `sha256:${fileHash(catalogPath)}`;
  const cases = jsonFixture(fixtureCasesRaw);
  cases.catalogSnapshotId = catalogSnapshotId;
  const judgments = jsonFixture(fixtureJudgmentsRaw);
  judgments.catalogSnapshotId = catalogSnapshotId;
  const casesPath = join(directory, "cases.json");
  const judgmentsPath = join(directory, "judgments.json");
  writeFileSync(casesPath, JSON.stringify(cases));
  writeFileSync(judgmentsPath, JSON.stringify(judgments));
  return { directory, catalogPath, casesPath, judgmentsPath };
}

function fileHash(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function jsonFixture(raw: string): any {
  return JSON.parse(raw);
}

function item(id: string, overrides: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id,
    mediaType: "movie",
    title: `Synthetic ${id}`,
    genres: [],
    ratings: {},
    posterUrl: "",
    availabilityGroup: "available_in_plex",
    availabilityExplanation: "Synthetic fixture",
    matchExplanation: "Synthetic fixture",
    score: 50,
    ...overrides
  };
}

function observation(caseId: string, value: number): IndependentEvalCaseObservation {
  return {
    caseId,
    preRerankRecall: value,
    ndcgAt3: value,
    ndcgAt10: value,
    acceptableFamilyHitAt3: value,
    acceptableFamilyHitAt10: value,
    pairwiseCoverage: value,
    pairwiseAccuracy: value,
    pairwiseTieCount: 0,
    constraintCounts: { pass: 1, fail: 0, unknown: 0 },
    constraintExpectedMatches: 1,
    constraintTotal: 1,
    retrievalMs: 1,
    scoringMs: 2
  };
}

function expectContractCode(action: () => unknown, code: string) {
  try {
    action();
    throw new Error("expected contract validation to fail");
  } catch (error) {
    expect(error).toMatchObject({ code });
  }
}

function qualityMetricsJson(metrics: ReturnType<typeof aggregateIndependentEvalMetrics>) {
  return JSON.stringify(metrics, (key, value) => key === "timingMs" ? undefined : value);
}
