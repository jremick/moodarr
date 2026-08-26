import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import type { AiRanker } from "../src/server/ai/ranker";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import type { IndependentEvalCaseObservation } from "../scripts/moodrank-independent-eval-contract";
import {
  aggregatePairedComparisons,
  aggregateSafeProductReport,
  parseProductEvalArgs,
  productRerankCoverage,
  runProductEvaluation
} from "../scripts/evaluate-moodrank-product";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("MoodRank product-response evaluation runner", () => {
  it("requires explicit external-processing confirmation and a bounded CLI surface", () => {
    const required = [
      "--cases", "cases.json",
      "--judgments", "judgments.json",
      "--catalog", "catalog.sqlite",
      "--config", "config.json",
      "--work-db", "work.sqlite",
      "--output", "report.json"
    ];
    expect(() => parseProductEvalArgs(required)).toThrow(/external_processing_confirmation_required/);
    expect(parseProductEvalArgs([...required, "--confirm-external-processing", "--seed", "42"])).toMatchObject({
      seed: 42,
      maxExternalRequests: 100,
      confirmExternalProcessing: true
    });
    expect(parseProductEvalArgs([
      ...required,
      "--confirm-external-processing",
      "--max-external-requests",
      "250"
    ])).toMatchObject({ maxExternalRequests: 250 });
    expect(() => parseProductEvalArgs([
      ...required,
      "--confirm-external-processing",
      "--max-external-requests",
      "0"
    ])).toThrow(/invalid_max_external_requests/);
    expect(() => parseProductEvalArgs([...required, "--confirm-external-processing", "--unknown", "x"])).toThrow(/unknown_option/);
    expect(() => parseProductEvalArgs([...required, "--confirm-external-processing", "--confirm-external-processing"])).toThrow(/duplicate_option/);
  });

  it("runs paired real SearchService responses on a disposable schema-32 copy without external calls in tests", async () => {
    const fixture = createProductFixture();
    const sourceHashBefore = fileHash(fixture.catalogPath);
    const report = await runProductEvaluation({
      ...fixture.args,
      outputPath: join(fixture.directory, "product-report.json")
    }, {
      createAiRanker: () => successfulFakeRanker()
    });
    const saved = JSON.parse(readFileSync(join(fixture.directory, "product-report.json"), "utf8"));

    expect(report.evaluationStages).toEqual({
      deterministic: "search_service_final_response",
      aiRequestedFailSoft: "search_service_final_response",
      finalSearchServiceResponseEvaluated: true,
      runtimeConfigurationParity: "controlled",
      retrievalMetricsReported: false
    });
    expect(report.status).toBe("simulated");
    expect(report.completeCaseSetEvidenceStatus).toBe("insufficient");
    expect(report.provenance).toMatchObject({
      executionMode: "simulated",
      provider: "simulated",
      model: "fake-openai",
      providerEvidenceEligible: false
    });
    expect(report.provenance.sourceTreeSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(report.provenance.database).toMatchObject({
      sourceSha256: `sha256:${sourceHashBefore}`,
      sourceUnchanged: true,
      schemaMigrationCount: 32,
      schema32MigrationPresent: true
    });
    expect(report.provenance.database.workSha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(fileHash(fixture.workDatabasePath)).toBe(report.provenance.database.workSha256.replace("sha256:", ""));
    expect(statSync(fixture.workDatabasePath).mode & 0o777).toBe(0o600);
    const retained = new DatabaseSync(fixture.workDatabasePath, { readOnly: true });
    for (const table of [
      "app_users",
      "feel_feedback_events",
      "feel_profile_checkpoints",
      "feel_profile_terms",
      "library_sync_runs",
      "catalog_sync_runs",
      "plex_auth_challenges",
      "preference_feature_weights",
      "preference_profiles",
      "query_review_queue",
      "recommendation_feedback",
      "request_audit",
      "request_creation_operations",
      "requests",
      "search_events",
      "seerr_sync_runs",
      "user_sessions"
    ]) {
      expect((retained.prepare(`SELECT COUNT(*) AS value FROM ${table}`).get() as { value: number }).value).toBe(0);
    }
    expect((retained.prepare("SELECT COUNT(*) AS value FROM app_users WHERE plex_token IS NOT NULL").get() as { value: number }).value).toBe(0);
    expect((retained.prepare("SELECT COUNT(*) AS value FROM recommendation_sessions").get() as { value: number }).value).toBe(2);
    expect((retained.prepare(
      "SELECT COUNT(*) AS value FROM recommendation_sessions WHERE trace_schema_version IS NOT NULL AND trace_flags_json LIKE '%strict%'"
    ).get() as { value: number }).value).toBe(2);
    const traceRows = retained.prepare(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN score_trace_json IS NOT NULL THEN 1 ELSE 0 END) AS score_traced,
              SUM(CASE WHEN provenance_json IS NOT NULL THEN 1 ELSE 0 END) AS provenance_traced
       FROM recommendation_results`
    ).get() as { total: number; score_traced: number; provenance_traced: number };
    expect(traceRows.score_traced).toBe(traceRows.total);
    expect(traceRows.provenance_traced).toBe(traceRows.total);
    retained.close();
    expect(report.provenance.executionPolicy).toMatchObject({
      plexDisabled: true,
      seerrDisabled: true,
      descriptiveAugmentationDisabled: true,
      providerEmbeddingsDisabled: true,
      providerEmbeddingBackfillDisabled: true,
      aiBriefParsingDisabled: true,
      aiQueryOptimizationDisabled: true,
      aiTasteScoutDisabled: true,
      personalizationStateCleared: true,
      importedAuthRequestAndTelemetryStateCleared: true,
      strictTraceWritesRequired: true,
      releaseThresholdDefined: false
    });
    expect(report.aiRerankCompleteness).toMatchObject({
      casesRequested: 1,
      casesUsedAi: 1,
      casesFallback: 0,
      casesCompleteForResponseComparison: 1,
      externalRequestCount: 0
    });
    expect(report.details?.[0]?.aiAssisted).toMatchObject({ usedAi: true, fallback: false });
    expect(report.details?.[0]?.aiAssisted.rerank).toMatchObject({
      serializedPayloadComplete: true,
      finalResponseComplete: true,
      completeForResponseComparison: true
    });
    expect(report.metrics.completeAiCases.caseCount).toBe(1);
    expect(report.metrics.completeAiCases.pairedComparisons).not.toBeNull();
    expect(report.metrics.completeAiCases.aiReranked?.ndcgAt10).toMatchObject({
      contributingCases: 1,
      ci95: null,
      evidenceStatus: "insufficient"
    });
    expect(saved.details).toHaveLength(1);
    expect(statSync(join(fixture.directory, "product-report.json")).mode & 0o777).toBe(0o600);
    expect(fileHash(fixture.catalogPath)).toBe(sourceHashBefore);

    const aggregate = JSON.stringify(aggregateSafeProductReport(report));
    expect(aggregate).not.toContain("quiet warm comedy after a long day");
    expect(aggregate).not.toContain("Synthetic Warm Comedy");
    expect(aggregate).not.toContain(fixture.directory);
  });

  it("reports AI fallback without converting it into a release threshold", async () => {
    const fixture = createProductFixture();
    const report = await runProductEvaluation({
      ...fixture.args,
      outputPath: join(fixture.directory, "fallback-report.json")
    }, {
      createAiRanker: () => ({
        modelName: "fake-openai",
        async rank(input) {
          return {
            usedAi: false,
            results: input.candidates,
            trace: { serializedCandidateCount: input.candidates.length, rankedItems: [] }
          };
        }
      })
    });

    expect(report.aiRerankCompleteness).toMatchObject({
      casesRequested: 1,
      casesUsedAi: 0,
      casesFallback: 1,
      casesCompleteForResponseComparison: 0
    });
    expect(report.status).toBe("simulated");
    expect(report.metrics.completeAiCases.caseCount).toBe(0);
    expect(report.metrics.completeAiCases.pairedComparisons).toBeNull();
    expect(report.details?.[0]?.aiAssisted.fallback).toBe(true);
    expect(report.provenance.executionPolicy.releaseThresholdDefined).toBe(false);
  });

  it("rejects a project config that is not mode 0600", async () => {
    const fixture = createProductFixture();
    chmodSync(fixture.configPath, 0o644);
    await expect(runProductEvaluation({
      ...fixture.args,
      outputPath: join(fixture.directory, "rejected-report.json")
    }, {
      createAiRanker: () => successfulFakeRanker()
    })).rejects.toMatchObject({ code: "config_file_mode_not_0600" });
  });

  it("rejects a case set that exceeds the explicit external-request budget before ranking", async () => {
    const fixture = createProductFixture();
    const cases = JSON.parse(readFileSync(fixture.casesPath, "utf8"));
    cases.cases.push({ ...cases.cases[0], id: "warm-comedy-second" });
    writeFileSync(fixture.casesPath, JSON.stringify(cases));
    const judgments = JSON.parse(readFileSync(fixture.judgmentsPath, "utf8"));
    judgments.cases.push({ ...judgments.cases[0], caseId: "warm-comedy-second" });
    writeFileSync(fixture.judgmentsPath, JSON.stringify(judgments));
    let rankerCreated = false;
    await expect(runProductEvaluation({
      ...fixture.args,
      maxExternalRequests: 1,
      outputPath: join(fixture.directory, "budget-report.json")
    }, {
      createAiRanker: () => {
        rankerCreated = true;
        return successfulFakeRanker();
      }
    })).rejects.toMatchObject({ code: "external_request_budget_exceeded" });
    expect(rankerCreated).toBe(false);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0, 1.5, 10_001])(
    "rejects an invalid direct-call external-request budget %s",
    async (maxExternalRequests) => {
      const fixture = createProductFixture();
      await expect(runProductEvaluation({
        ...fixture.args,
        maxExternalRequests,
        outputPath: join(fixture.directory, "invalid-budget-report.json")
      }, {
        createAiRanker: () => successfulFakeRanker()
      })).rejects.toMatchObject({ code: "invalid_max_external_requests" });
    }
  );

  it("rejects an external symlink whose resolved output parent is inside the repository", async () => {
    const fixture = createProductFixture();
    const repositoryLink = join(fixture.directory, "repository-link");
    symlinkSync(process.cwd(), repositoryLink, "dir");
    await expect(runProductEvaluation({
      ...fixture.args,
      outputPath: join(repositoryLink, ".data", "private-product-eval-test.json")
    }, {
      createAiRanker: () => successfulFakeRanker()
    })).rejects.toMatchObject({ code: "private_output_must_be_outside_repository" });
  });

  it("rejects a concurrent evaluator before either global guard can interleave", async () => {
    const firstFixture = createProductFixture();
    const secondFixture = createProductFixture();
    const firstRun = runProductEvaluation({
      ...firstFixture.args,
      outputPath: join(firstFixture.directory, "first-report.json")
    }, {
      createAiRanker: () => successfulFakeRanker()
    });
    await expect(runProductEvaluation({
      ...secondFixture.args,
      outputPath: join(secondFixture.directory, "second-report.json")
    }, {
      createAiRanker: () => successfulFakeRanker()
    })).rejects.toMatchObject({ code: "product_evaluation_already_active" });
    await expect(firstRun).resolves.toMatchObject({ status: "simulated" });
  });
});

describe("MoodRank product-response paired comparison", () => {
  it("reports deterministic wins, losses, ties, and bootstrap intervals", () => {
    const deterministic = [observation("a", 0.2), observation("b", 0.8), observation("c", 0.5)];
    const ai = [observation("a", 0.4), observation("b", 0.6), observation("c", 0.5)];
    const first = aggregatePairedComparisons(deterministic, ai, 42, 500);
    const repeated = aggregatePairedComparisons([...deterministic].reverse(), [...ai].reverse(), 42, 500);

    expect(repeated).toEqual(first);
    expect(first.ndcgAt10).toMatchObject({ wins: 1, losses: 1, ties: 1, contributingCases: 3, meanDelta: 0 });
    expect(first.ndcgAt10.evidenceStatus).toBe("insufficient");
    expect(first.ndcgAt10.meanDeltaCi95).not.toBeNull();
  });

  it("separates provider-payload limits from complete final-response coverage", () => {
    const rankedItems = Array.from({ length: 60 }, (_, index) => ({
      itemId: `item-${index + 1}`,
      aiRank: index + 1,
      aiScore: 100 - index
    }));
    const coverage = productRerankCoverage({
      usedAi: true,
      offeredCandidateCount: 100,
      finalResponseItemIds: rankedItems.slice(0, 10).map((item) => item.itemId),
      rankerResult: {
        usedAi: true,
        results: [],
        trace: { serializedCandidateCount: 60, rankedItems }
      }
    });

    expect(coverage).toMatchObject({
      offeredWindowComplete: false,
      serializedPayloadComplete: true,
      finalResponseItemCount: 10,
      finalResponseAiCoveredCount: 10,
      finalResponseComplete: true,
      completeForResponseComparison: true
    });
  });
});

function createProductFixture() {
  const directory = mkdtempSync(join(tmpdir(), "moodrank-product-eval-test-"));
  temporaryDirectories.push(directory);
  const catalogPath = join(directory, "catalog.sqlite");
  const database = createDatabase(catalogPath);
  const repository = new MediaRepository(database);
  const warmId = repository.upsert({
    mediaType: "movie",
    title: "Synthetic Warm Comedy",
    year: 2024,
    runtimeMinutes: 96,
    summary: "A gentle funny story about a close community.",
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
  seedPrivateState(database, warmId);
  database.close();
  chmodSync(catalogPath, 0o600);
  const catalogSnapshotId = `sha256:${fileHash(catalogPath)}`;
  const casesPath = join(directory, "cases.json");
  const judgmentsPath = join(directory, "judgments.json");
  const configPath = join(directory, "config.json");
  const workDatabasePath = join(directory, "product-work.sqlite");
  writeFileSync(casesPath, JSON.stringify({
    schemaVersion: "moodrank-blind-cases-v1",
    corpusId: "synthetic-product-eval",
    catalogSnapshotId,
    frozenAt: "2026-08-27T00:00:00.000Z",
    cases: [{
      id: "warm-comedy",
      query: "quiet warm comedy after a long day",
      watchContext: "solo",
      resultLimit: 2,
      queryFamilyTags: ["mood"],
      sourceKind: "synthetic",
      privacyReview: "synthetic"
    }]
  }));
  writeFileSync(judgmentsPath, JSON.stringify({
    schemaVersion: "moodrank-blind-judgments-v1",
    corpusId: "synthetic-product-eval",
    catalogSnapshotId,
    judgmentVersion: "synthetic-v1",
    items: [
      { ref: "warm", externalId: { source: "tmdb", value: "990001" }, title: "Synthetic Warm Comedy", mediaType: "movie" },
      { ref: "cold", externalId: { source: "tmdb", value: "990002" }, title: "Synthetic Cold Thriller", mediaType: "movie" }
    ],
    cases: [{
      caseId: "warm-comedy",
      acceptableFamilies: [{ familyId: "warm-family", itemRefs: ["warm"] }],
      gradedRelevance: [{ itemRef: "warm", grade: 3 }, { itemRef: "cold", grade: 1 }],
      pairwise: [{ preferredItemRef: "warm", otherItemRef: "cold", outcome: "preferred" }],
      constraintChecks: [{ id: "comedy", filters: { genres: ["Comedy"] }, resultCutoff: 1, expected: "pass" }],
      reviewerCount: 2,
      adjudicationStatus: "complete"
    }]
  }));
  writeFileSync(configPath, JSON.stringify({
    ai: {
      provider: "openai",
      openaiApiKey: "test-openai-key-not-real",
      openaiModel: "gpt-5.5-test",
      openaiReasoningEffort: "low"
    }
  }), { mode: 0o600 });
  chmodSync(configPath, 0o600);
  return {
    directory,
    catalogPath,
    casesPath,
    judgmentsPath,
    configPath,
    workDatabasePath,
    args: {
      casesPath,
      judgmentsPath,
      catalogPath,
      configPath,
      workDatabasePath,
      outputPath: "",
      seed: 42,
      maxExternalRequests: 100,
      confirmExternalProcessing: true as const
    }
  };
}

function seedPrivateState(database: DatabaseSync, mediaItemId: string) {
  const now = "2026-08-27T00:00:00.000Z";
  database.prepare(
    `INSERT INTO app_users (
       id, provider, provider_user_id, username, enabled, created_at, updated_at,
       plex_token, can_request, can_use_ai
     ) VALUES (?, 'plex', ?, ?, 1, ?, ?, ?, 1, 1)`
  ).run("user-private", "plex-private", "private-user", now, now, "private-plex-token");
  database.prepare(
    `INSERT INTO user_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run("session-private", "user-private", "private-token-hash", now, "2026-08-28T00:00:00.000Z", now);
  database.prepare(
    `INSERT INTO preference_profiles (id, watch_context, label, created_at, updated_at, auth_user_id)
     VALUES (?, 'solo', ?, ?, ?, ?)`
  ).run("profile-private", "Private profile", now, now, "user-private");
  database.prepare(
    `INSERT INTO preference_feature_weights (profile_id, feature, weight, updated_at)
     VALUES (?, ?, ?, ?)`
  ).run("profile-private", "warm", 2, now);
  database.prepare(
    `INSERT INTO recommendation_sessions (
       id, query_hash, engine_version, watch_context, result_count, candidate_count,
       rerank_candidate_count, used_ai, seerr_augmented, latency_ms, created_at, auth_user_id
     ) VALUES (?, ?, ?, 'solo', 0, 0, 0, 0, 0, 0, ?, ?)`
  ).run("recommendation-private", "private-query-hash", "test", now, "user-private");
  database.prepare(
    `INSERT INTO query_review_queue (
       id, session_id, query_text, watch_context, results_json, created_at, updated_at
     ) VALUES (?, ?, ?, 'solo', '[]', ?, ?)`
  ).run("review-private", "recommendation-private", "private raw query", now, now);
  database.prepare(
    `INSERT INTO requests (media_item_id, media_type, media_id, status, external_request_id, created_at)
     VALUES (?, 'movie', 990001, 'pending', ?, ?)`
  ).run(mediaItemId, "private-request-id", now);
  database.prepare(
    `INSERT INTO request_audit (
       media_item_id, action, status, media_type, media_id, title, external_request_id, created_at, auth_user_id
     ) VALUES (?, 'create', 'created', 'movie', 990001, ?, ?, ?, ?)`
  ).run(mediaItemId, "Private title", "private-request-id", now, "user-private");
  database.prepare(
    `INSERT INTO request_creation_operations (
       idempotency_key, request_fingerprint, auth_scope, media_item_id, status,
       response_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'created', ?, ?, ?)`
  ).run("private-idempotency", "private-fingerprint", "private-scope", mediaItemId, "{}", now, now);
  database.prepare(
    `INSERT INTO plex_auth_challenges (pin_id, code, state_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run("private-pin", "private-code", "private-state", "2026-08-28T00:00:00.000Z", now);
}

function successfulFakeRanker(): AiRanker {
  return {
    modelName: "fake-openai",
    async rank(input) {
      const results = [...input.candidates].sort((left, right) => Number(right.title.includes("Warm")) - Number(left.title.includes("Warm")));
      return {
        usedAi: results.length > 0,
        results,
        trace: {
          serializedCandidateCount: results.length,
          rankedItems: results.map((item, index) => ({ itemId: item.id, aiRank: index + 1, aiScore: 90 - index }))
        }
      };
    }
  };
}

function fileHash(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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
