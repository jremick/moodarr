import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { moodRankTraceSchemaVersion } from "../src/server/recommendation/tracing";
import { recommendationEngineVersion } from "../src/server/recommendation/version";

interface Args {
  dbPath?: string;
  minTraces: number;
  sampleTraces: number;
}

interface TableSpec {
  name: string;
  requiredColumns: string[];
}

interface TableInfoRow {
  name: string;
}

interface TraceSessionRow {
  id: string;
}

interface ScoreTracePersistence {
  itemId: string;
  score: number;
  rank: number;
  usedAiRerank?: boolean;
  candidateCount: number;
  rerankCandidateCount: number;
  resultCount: number;
  serializedCandidateCount: number;
  aiRankedCandidateCount: number;
}

const coreTraceTables: TableSpec[] = [
  {
    name: "recommendation_sessions",
    requiredColumns: [
      "id", "query_hash", "watch_context", "trace_schema_version", "trace_flags_json", "brief_trace_json",
      "retrieval_trace_json", "rerank_trace_json", "candidate_count", "rerank_candidate_count", "result_count", "created_at"
    ]
  },
  {
    name: "recommendation_results",
    requiredColumns: ["session_id", "media_item_id", "rank", "score", "availability_group", "provenance_json", "score_trace_json"]
  },
  {
    name: "recommendation_candidate_provenance",
    requiredColumns: ["session_id", "media_item_id", "source", "score", "source_rank", "detail_json"]
  },
  {
    name: "recommendation_rejections",
    requiredColumns: ["session_id", "media_item_id", "stage", "reason_code", "score", "detail_json", "sampled"]
  },
  {
    name: "recommendation_impressions",
    requiredColumns: ["session_id", "media_item_id", "rank_shown", "surface", "visibility", "action", "dwell_ms", "metadata_json"]
  },
  {
    name: "query_review_queue",
    requiredColumns: ["session_id", "query_text", "optimized_query"]
  }
];

const allowedRejectionReasons = new Set(["outside_result_limit", "outside_rerank_serialized_limit"]);
const allowedRejectionStages = new Set(["result_window_cut", "rerank_window_cut"]);

function runCli() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = resolve(args.dbPath ?? process.env.MOODARR_DB_PATH ?? `${process.env.MOODARR_DATA_DIR ?? ".data"}/moodarr.sqlite`);

  if (!existsSync(dbPath)) {
    console.error(`MoodRank trace eval could not find a SQLite database at ${dbPath}. Pass --db-path or set MOODARR_DB_PATH.`);
    process.exitCode = 1;
    return;
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const result = evaluateTracePersistence(db, args, dbPath);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } finally {
    db.close();
  }
}

function parseArgs(values: string[]): Args {
  const parsed: Args = {
    minTraces: 1,
    sampleTraces: 5
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--db-path") parsed.dbPath = values[++index];
    else if (value === "--min-traces") parsed.minTraces = parseNonNegativeInteger(values[++index], parsed.minTraces);
    else if (value === "--sample-traces") parsed.sampleTraces = parsePositiveInteger(values[++index], parsed.sampleTraces);
  }
  return parsed;
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseNonNegativeInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function evaluateTracePersistence(db: DatabaseSync, input: Args, dbPath: string) {
  const existingTables = tableNames(db);
  const missingCoreTables = coreTraceTables.map((table) => table.name).filter((table) => !existingTables.has(table));
  const schemaFailures = coreTraceTables
    .filter((table) => existingTables.has(table.name))
    .flatMap((table) => missingColumns(db, table).map((column) => `${table.name}: missing required column ${column}`));

  if (missingCoreTables.length > 0 || schemaFailures.length > 0) {
    return {
      ok: false,
      status: missingCoreTables.length > 0 ? "trace_tables_missing" : "trace_schema_invalid",
      generatedAt: new Date().toISOString(),
      engineVersion: recommendationEngineVersion,
      traceSchemaVersion: moodRankTraceSchemaVersion,
      dbPath,
      missingCoreTables,
      schemaFailures
    };
  }

  const assertionFailures = [
    ...schemaFailures,
    ...assertTraceSessions(db, input),
    ...assertTracePrivacy(db, input),
    ...assertFinalResultsHaveTrace(db, input),
    ...assertRejectionRows(db),
    ...assertRerankTraceJson(db, input)
  ];

  return {
    ok: assertionFailures.length === 0,
    status: assertionFailures.length === 0 ? "passed" : "failed",
    generatedAt: new Date().toISOString(),
    engineVersion: recommendationEngineVersion,
    traceSchemaVersion: moodRankTraceSchemaVersion,
    dbPath,
    minTraces: input.minTraces,
    sampleTraces: input.sampleTraces,
    assertionFailures
  };
}

function tableNames(db: DatabaseSync) {
  const rows = db
    .prepare(
      `SELECT name
       FROM sqlite_schema
       WHERE type IN ('table', 'view')
       ORDER BY name`
    )
    .all() as unknown as TableInfoRow[];
  return new Set(rows.map((row) => row.name));
}

function missingColumns(db: DatabaseSync, table: TableSpec) {
  const columns = new Set((db.prepare(`PRAGMA table_info(${table.name})`).all() as unknown as TableInfoRow[]).map((row) => row.name));
  return table.requiredColumns.filter((column) => !columns.has(column));
}

function recentTraceSessions(db: DatabaseSync, limit: number) {
  return db
    .prepare(
      `SELECT id
       FROM recommendation_sessions
       WHERE trace_schema_version = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`
    )
    .all(moodRankTraceSchemaVersion, limit) as unknown as TraceSessionRow[];
}

function assertTraceSessions(db: DatabaseSync, input: Args) {
  const failures: string[] = [];
  const summary = db
    .prepare(
      `SELECT COUNT(*) AS value
       FROM recommendation_sessions
       WHERE trace_schema_version = ?`
    )
    .get(moodRankTraceSchemaVersion) as { value: number };
  if (summary.value < input.minTraces) failures.push(`recommendation_sessions: expected at least ${input.minTraces} traced session(s), found ${summary.value}.`);

  const invalidRows = db
    .prepare(
      `SELECT COUNT(*) AS value
       FROM recommendation_sessions
       WHERE trace_schema_version = ?
        AND (
          query_hash IS NULL
          OR length(query_hash) != 64
          OR brief_trace_json IS NULL
          OR trim(brief_trace_json) IN ('', '{}', '[]', 'null')
          OR retrieval_trace_json IS NULL
          OR trim(retrieval_trace_json) IN ('', '{}', '[]', 'null')
          OR trace_flags_json IS NULL
          OR trim(trace_flags_json) IN ('', '{}', '[]', 'null')
          OR watch_context NOT IN ('solo', 'group')
        )`
    )
    .get(moodRankTraceSchemaVersion) as { value: number };
  if (invalidRows.value > 0) failures.push(`recommendation_sessions: ${invalidRows.value} traced row(s) have invalid hashes, trace JSON, flags, or watch context.`);
  return failures;
}

function assertTracePrivacy(db: DatabaseSync, input: Args) {
  const failures: string[] = [];
  const sessionColumns = new Set((db.prepare("PRAGMA table_info(recommendation_sessions)").all() as unknown as TableInfoRow[]).map((row) => row.name));
  for (const forbidden of ["query", "raw_query", "prompt", "raw_prompt"]) {
    if (sessionColumns.has(forbidden)) failures.push(`recommendation_sessions: raw prompt column "${forbidden}" should not be persisted.`);
  }

  const sampledSessionIds = recentTraceSessions(db, input.sampleTraces).map((session) => session.id);
  if (sampledSessionIds.length === 0) return failures;
  const placeholders = sampledSessionIds.map(() => "?").join(", ");
  const jsonRows = db
    .prepare(
      `SELECT brief_trace_json AS value FROM recommendation_sessions WHERE id IN (${placeholders})
       UNION ALL SELECT retrieval_trace_json FROM recommendation_sessions WHERE id IN (${placeholders})
       UNION ALL SELECT rerank_trace_json FROM recommendation_sessions WHERE id IN (${placeholders})
       UNION ALL SELECT provenance_json FROM recommendation_results WHERE session_id IN (${placeholders}) AND provenance_json IS NOT NULL
       UNION ALL SELECT score_trace_json FROM recommendation_results WHERE session_id IN (${placeholders}) AND score_trace_json IS NOT NULL
       UNION ALL SELECT detail_json FROM recommendation_candidate_provenance WHERE session_id IN (${placeholders}) AND detail_json IS NOT NULL
       UNION ALL SELECT detail_json FROM recommendation_rejections WHERE session_id IN (${placeholders}) AND detail_json IS NOT NULL`
    )
    .all(...sampledSessionIds, ...sampledSessionIds, ...sampledSessionIds, ...sampledSessionIds, ...sampledSessionIds, ...sampledSessionIds, ...sampledSessionIds) as Array<{ value: string }>;
  const reviewRows = db
    .prepare(
      `SELECT query_text AS value FROM query_review_queue WHERE session_id IN (${placeholders})
       UNION ALL SELECT optimized_query FROM query_review_queue WHERE session_id IN (${placeholders}) AND optimized_query IS NOT NULL`
    )
    .all(...sampledSessionIds, ...sampledSessionIds) as Array<{ value: string }>;
  const unsafeRows = jsonRows.filter((row) => traceJsonContainsPrivateMaterial(row.value)).length
    + reviewRows.filter((row) => traceTextContainsPrivateMaterial(row.value)).length;
  if (unsafeRows > 0) failures.push(`trace privacy: ${unsafeRows} text field(s) appear to contain URLs or secret-like strings.`);
  return failures;
}

export function traceJsonContainsPrivateMaterial(serialized: string) {
  try {
    return structuredStrings(JSON.parse(serialized)).some(traceTextContainsPrivateMaterial);
  } catch {
    return traceTextContainsPrivateMaterial(serialized);
  }
}

export function traceTextContainsPrivateMaterial(value: string) {
  const normalized = value.toLowerCase();
  return normalized.includes("http://")
    || normalized.includes("https://")
    || normalized.includes("api_key")
    || normalized.includes("token")
    || normalized.includes("bearer ")
    || normalized.includes("plex_url")
    || normalized.includes("seerr_url")
    || normalized.includes("localhost")
    || normalized.includes("127.0.0.1")
    || /\b192\.168(?:\.\d{1,3}){2}\b/.test(normalized)
    || /\b10(?:\.\d{1,3}){3}\b/.test(normalized)
    || /\b172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}\b/.test(normalized)
    || normalized.includes("poster");
}

function structuredStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(structuredStrings);
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => [key, ...structuredStrings(nested)]);
}

function assertFinalResultsHaveTrace(db: DatabaseSync, input: Args) {
  const failures: string[] = [];
  for (const session of recentTraceSessions(db, input.sampleTraces)) {
    const resultRankSummary = db
      .prepare(
        `SELECT s.result_count,
                COUNT(r.media_item_id) AS row_count,
                COUNT(DISTINCT r.rank) AS distinct_rank_count,
                MIN(r.rank) AS min_rank,
                MAX(r.rank) AS max_rank
         FROM recommendation_sessions s
         LEFT JOIN recommendation_results r ON r.session_id = s.id
         WHERE s.id = ?
         GROUP BY s.id, s.result_count`
      )
      .get(session.id) as {
        result_count: number;
        row_count: number;
        distinct_rank_count: number;
        min_rank: number | null;
        max_rank: number | null;
      } | undefined;
    if (!resultRankSummary || persistedResultRanksHaveMismatch(resultRankSummary)) {
      failures.push(`${session.id}: persisted result ranks are not unique, contiguous, or consistent with result_count.`);
    }

    const missingJson = db
      .prepare(
        `SELECT COUNT(*) AS value
         FROM recommendation_results
         WHERE session_id = ?
          AND (
            provenance_json IS NULL
            OR score_trace_json IS NULL
            OR trim(provenance_json) IN ('', '{}', '[]', 'null')
            OR trim(score_trace_json) IN ('', '{}', '[]', 'null')
          )`
      )
      .get(session.id) as { value: number };
    if (missingJson.value > 0) failures.push(`${session.id}: ${missingJson.value} final result(s) lack provenance or score trace JSON.`);

    const missingProvenanceRows = db
      .prepare(
        `SELECT COUNT(*) AS value
         FROM recommendation_results r
         LEFT JOIN recommendation_candidate_provenance p
          ON p.session_id = r.session_id
          AND p.media_item_id = r.media_item_id
         WHERE r.session_id = ?
          AND p.media_item_id IS NULL`
      )
      .get(session.id) as { value: number };
    if (missingProvenanceRows.value > 0) failures.push(`${session.id}: ${missingProvenanceRows.value} final result(s) lack normalized provenance rows.`);

    const mismatchedScores = scoreTraceMismatches(db, session.id);
    failures.push(...mismatchedScores.map((itemId) => `${session.id}: ${itemId} score trace is inconsistent with persisted score, rank, or contribution math.`));
    const mismatchedProvenance = (db.prepare(
      `SELECT media_item_id, provenance_json
       FROM recommendation_results
       WHERE session_id = ? AND provenance_json IS NOT NULL`
    ).all(session.id) as Array<{ media_item_id: string; provenance_json: string }>).filter((row) =>
      provenanceTraceHasMismatch(parseJson(row.provenance_json), row.media_item_id)
    );
    failures.push(...mismatchedProvenance.map((row) => `${session.id}: ${row.media_item_id} provenance trace is bound to the wrong schema or item.`));
    if (scoreTraceStageRanksHaveDuplicate(
      (db.prepare(
        `SELECT score_trace_json
         FROM recommendation_results
         WHERE session_id = ? AND score_trace_json IS NOT NULL`
      ).all(session.id) as Array<{ score_trace_json: string }>).map((row) => parseJson(row.score_trace_json))
    )) {
      failures.push(`${session.id}: score traces contain a duplicate intermediate-stage rank.`);
    }
  }
  return failures;
}

function scoreTraceMismatches(db: DatabaseSync, sessionId: string) {
  const rerankTrace = parseJson(
    (db.prepare("SELECT rerank_trace_json FROM recommendation_sessions WHERE id = ?").get(sessionId) as { rerank_trace_json?: string | null } | undefined)
      ?.rerank_trace_json ?? ""
  ) as { usedAi?: boolean; serializedCandidateCount?: number; aiRankedCandidateCount?: number } | undefined;
  const session = db
    .prepare(
      `SELECT candidate_count, rerank_candidate_count, result_count
       FROM recommendation_sessions
       WHERE id = ?`
    )
    .get(sessionId) as {
      candidate_count: number;
      rerank_candidate_count: number;
      result_count: number;
    } | undefined;
  if (!session) return ["missing_session"];
  const rows = db
    .prepare(
      `SELECT media_item_id, rank, score, score_trace_json
       FROM recommendation_results
       WHERE session_id = ?
        AND score_trace_json IS NOT NULL`
    )
    .all(sessionId) as Array<{ media_item_id: string; rank: number; score: number; score_trace_json: string }>;
  return rows.flatMap((row) => {
    return scoreTraceHasMismatch(parseJson(row.score_trace_json), {
      itemId: row.media_item_id,
      score: row.score,
      rank: row.rank,
      usedAiRerank: rerankTrace?.usedAi,
      candidateCount: session.candidate_count,
      rerankCandidateCount: session.rerank_candidate_count,
      resultCount: session.result_count,
      serializedCandidateCount: rerankTrace?.serializedCandidateCount ?? 0,
      aiRankedCandidateCount: rerankTrace?.aiRankedCandidateCount ?? 0
    }) ? [row.media_item_id] : [];
  });
}

export function scoreTraceHasMismatch(parsedValue: unknown, persisted: ScoreTracePersistence) {
  const parsed = parsedValue as {
    schemaVersion?: string;
    scoreTraceVersion?: string;
    itemId?: string;
    finalScore?: number;
    buckets?: Array<{ value?: number; weight?: number; contribution?: number }>;
    deterministic?: {
      score?: number;
      unroundedScore?: number;
      disqualified?: boolean;
      adjustments?: Array<{ adjustment?: string; value?: number; contribution?: number }>;
    };
    scores?: {
      deterministic?: number;
      ai?: number;
      scout?: number;
      scoutOrderingDelta?: number;
      postScoutOrderingScore?: number;
      preResponse?: number;
      response?: number;
      responseClampDelta?: number;
    };
    ranks?: {
      preDiversity?: number;
      postDiversity?: number;
      postScoringFallback?: number;
      ai?: number;
      postRerank?: number;
      postScout?: number;
      postMerge?: number;
      response?: number;
    };
    orderingReason?: string;
    explanationSource?: string;
    scoutAppliedToOrdering?: boolean;
    diversity?: {
      strategy?: string;
      score?: number;
      lambda?: number;
      maxSimilarity?: number;
      mmr?: number;
      rankMovement?: number;
    };
  } | undefined;
  if (
    !parsed ||
    parsed.schemaVersion !== moodRankTraceSchemaVersion ||
    parsed.itemId !== persisted.itemId ||
    !isFiniteNumber(persisted.score) ||
    persisted.score < 0 ||
    persisted.score > 100 ||
    !Number.isInteger(persisted.rank) ||
    persisted.rank < 1 ||
    !validScoreTracePersistenceBounds(persisted) ||
    persisted.rank > persisted.resultCount ||
    parsed.finalScore !== persisted.score ||
    !Array.isArray(parsed.buckets) ||
    parsed.buckets.length === 0
  ) return true;
  if (parsed.scoreTraceVersion === "score-trace-v1") return false;
  if (parsed.scoreTraceVersion !== "score-trace-v2") return true;
  if (
    typeof persisted.usedAiRerank !== "boolean" ||
    !parsed.deterministic ||
    !parsed.scores ||
    !parsed.ranks ||
    typeof parsed.deterministic.disqualified !== "boolean" ||
    !Array.isArray(parsed.deterministic.adjustments) ||
    !isFiniteNumber(parsed.deterministic.score) ||
    !Number.isInteger(parsed.deterministic.score) ||
    !isFiniteNumber(parsed.deterministic.unroundedScore) ||
    !isFiniteNumber(parsed.scores?.deterministic) ||
    parsed.scores.deterministic !== parsed.deterministic.score ||
    parsed.scores.response !== persisted.score ||
    parsed.ranks?.response !== persisted.rank ||
    !isFiniteNumber(parsed.scores.preResponse) ||
    !isFiniteNumber(parsed.scores.response) ||
    parsed.scores.response < 0 ||
    parsed.scores.response > 100 ||
    !isFiniteNumber(parsed.scores.responseClampDelta) ||
    !approximatelyEqual(parsed.scores.responseClampDelta, parsed.scores.response - parsed.scores.preResponse) ||
    ((parsed.scores.ai === undefined) !== (parsed.ranks.ai === undefined)) ||
    (parsed.scores.ai !== undefined &&
      (!isFiniteNumber(parsed.scores.ai) || parsed.scores.ai < 0 || parsed.scores.ai > 100)) ||
    !["pre_diversity", "diversity", "rerank_stage", "taste_scout", "merge_dedupe", "request_attempt_fallback"].includes(parsed.orderingReason ?? "") ||
    !["deterministic", "ai", "reranker_unknown"].includes(parsed.explanationSource ?? "") ||
    (parsed.explanationSource === "ai") !== (parsed.scores.ai !== undefined) ||
    Object.values(parsed.ranks).some((rank) => rank !== undefined && (!Number.isInteger(rank) || rank < 1)) ||
    rankExceedsBound(parsed.ranks.preDiversity, persisted.candidateCount) ||
    rankExceedsBound(parsed.ranks.postDiversity, persisted.candidateCount) ||
    rankExceedsBound(parsed.ranks.postScoringFallback, persisted.candidateCount) ||
    rankExceedsBound(parsed.ranks.ai, persisted.aiRankedCandidateCount) ||
    rankExceedsBound(parsed.ranks.postRerank, persisted.rerankCandidateCount) ||
    rankExceedsBound(parsed.ranks.postScout, persisted.candidateCount) ||
    rankExceedsBound(parsed.ranks.postMerge, persisted.candidateCount) ||
    rankExceedsBound(parsed.ranks.response, persisted.resultCount) ||
    parsed.orderingReason !== expectedScoreTraceOrderingReason(parsed.ranks, persisted.usedAiRerank)
  ) return true;
  if (
    parsed.buckets.some(
      (bucket) =>
        !isFiniteNumber(bucket.value) ||
        !isFiniteNumber(bucket.weight) ||
        !isFiniteNumber(bucket.contribution) ||
        !approximatelyEqual(bucket.contribution, bucket.value * bucket.weight)
    ) ||
    parsed.deterministic.adjustments.some(
      (adjustment) =>
        !["profile_delta", "rank_index_delta"].includes(adjustment.adjustment ?? "") ||
        !isFiniteNumber(adjustment.contribution) ||
        (adjustment.value !== undefined && !isFiniteNumber(adjustment.value))
    )
  ) return true;
  const scoutFields = [parsed.scores.scout, parsed.scores.scoutOrderingDelta, parsed.scores.postScoutOrderingScore];
  const hasScoutEvidence = scoutFields.every((value) => value !== undefined);
  if (
    scoutFields.some((value) => value !== undefined) !== hasScoutEvidence ||
    (hasScoutEvidence && typeof parsed.scoutAppliedToOrdering !== "boolean") ||
    (!hasScoutEvidence && parsed.scoutAppliedToOrdering !== undefined) ||
    (hasScoutEvidence &&
      (!scoutFields.every(isFiniteNumber) ||
        parsed.scores.scout! < 0 ||
        parsed.scores.scout! > 100 ||
        parsed.scores.scoutOrderingDelta !==
          (parsed.scoutAppliedToOrdering ? Math.round((parsed.scores.scout! - 50) * 0.24) : 0) ||
        !approximatelyEqual(
          parsed.scores.postScoutOrderingScore!,
          parsed.scores.preResponse + parsed.scores.scoutOrderingDelta!
        )))
  ) return true;
  if (parsed.diversity) {
    if (
      !["small_pool", "precision_protected", "mmr", "outside_diversity_pool"].includes(parsed.diversity.strategy ?? "") ||
      !isFiniteNumber(parsed.diversity.score) ||
      parsed.diversity.score < 0 ||
      parsed.diversity.score > 100 ||
      [parsed.diversity.lambda, parsed.diversity.maxSimilarity, parsed.diversity.mmr].some(
        (value) => value !== undefined && !isFiniteNumber(value)
      ) ||
      (parsed.diversity.rankMovement !== undefined && !Number.isInteger(parsed.diversity.rankMovement)) ||
      (parsed.diversity.rankMovement !== undefined &&
        (parsed.ranks.preDiversity === undefined ||
          parsed.ranks.postDiversity === undefined ||
          parsed.diversity.rankMovement !== parsed.ranks.postDiversity - parsed.ranks.preDiversity))
    ) return true;
  }
  const reconstructed =
    parsed.buckets.reduce((total, bucket) => total + bucket.contribution!, 0) +
    parsed.deterministic.adjustments.reduce((total, adjustment) => total + adjustment.contribution!, 0);
  if (!approximatelyEqual(reconstructed, parsed.deterministic.unroundedScore)) return true;
  const expectedDeterministicScore = parsed.deterministic.disqualified ? 0 : Math.round(reconstructed);
  return parsed.deterministic.score !== expectedDeterministicScore;
}

export function persistedResultRanksHaveMismatch(summary: {
  result_count: number;
  row_count: number;
  distinct_rank_count: number;
  min_rank: number | null;
  max_rank: number | null;
}) {
  if (!Number.isInteger(summary.result_count) || summary.result_count < 0) return true;
  if (summary.row_count !== summary.result_count || summary.distinct_rank_count !== summary.result_count) return true;
  if (summary.result_count === 0) return summary.min_rank !== null || summary.max_rank !== null;
  return summary.min_rank !== 1 || summary.max_rank !== summary.result_count;
}

export function provenanceTraceHasMismatch(parsedValue: unknown, persistedItemId: string) {
  const parsed = parsedValue as { schemaVersion?: string; itemId?: string; sources?: unknown[] } | undefined;
  return !parsed ||
    parsed.schemaVersion !== moodRankTraceSchemaVersion ||
    parsed.itemId !== persistedItemId ||
    !Array.isArray(parsed.sources) ||
    parsed.sources.length === 0;
}

export function scoreTraceStageRanksHaveDuplicate(parsedValues: unknown[]) {
  const seenByStage = new Map<string, Set<number>>();
  for (const parsedValue of parsedValues) {
    const parsed = parsedValue as { scoreTraceVersion?: string; ranks?: Record<string, unknown> } | undefined;
    if (parsed?.scoreTraceVersion !== "score-trace-v2" || !parsed.ranks) continue;
    for (const [stage, value] of Object.entries(parsed.ranks)) {
      if (!Number.isInteger(value)) continue;
      const rank = value as number;
      const seen = seenByStage.get(stage) ?? new Set<number>();
      if (seen.has(rank)) return true;
      seen.add(rank);
      seenByStage.set(stage, seen);
    }
  }
  return false;
}

function validScoreTracePersistenceBounds(persisted: ScoreTracePersistence) {
  return [
    persisted.candidateCount,
    persisted.rerankCandidateCount,
    persisted.resultCount,
    persisted.serializedCandidateCount,
    persisted.aiRankedCandidateCount
  ]
    .every((value) => Number.isInteger(value) && value >= 0) &&
    persisted.resultCount <= persisted.candidateCount &&
    persisted.rerankCandidateCount <= persisted.candidateCount &&
    persisted.serializedCandidateCount <= persisted.rerankCandidateCount &&
    persisted.aiRankedCandidateCount <= persisted.serializedCandidateCount;
}

function rankExceedsBound(rank: number | undefined, bound: number) {
  return rank !== undefined && rank > bound;
}

function expectedScoreTraceOrderingReason(ranks: {
  preDiversity?: number;
  postDiversity?: number;
  postScoringFallback?: number;
  postRerank?: number;
  postScout?: number;
  postMerge?: number;
  response?: number;
}, usedAiRerank: boolean) {
  if (ranks.postMerge !== undefined && ranks.response !== ranks.postMerge) return "request_attempt_fallback";
  if (ranks.postScout !== undefined && ranks.postMerge !== undefined && ranks.postScout !== ranks.postMerge) return "merge_dedupe";
  if (ranks.postRerank !== undefined && ranks.postScout !== undefined && ranks.postRerank !== ranks.postScout) return "taste_scout";
  if (usedAiRerank && ranks.postScoringFallback !== undefined && ranks.postRerank !== undefined && ranks.postScoringFallback !== ranks.postRerank) return "rerank_stage";
  if (ranks.postDiversity !== undefined && ranks.postScoringFallback !== undefined && ranks.postDiversity !== ranks.postScoringFallback) return "request_attempt_fallback";
  if (ranks.preDiversity !== undefined && ranks.postDiversity !== undefined && ranks.preDiversity !== ranks.postDiversity) return "diversity";
  return "pre_diversity";
}

function assertRejectionRows(db: DatabaseSync) {
  const failures: string[] = [];
  const reasons = db
    .prepare(
      `SELECT DISTINCT reason_code
       FROM recommendation_rejections
       ORDER BY reason_code`
    )
    .all() as Array<{ reason_code: string }>;
  for (const row of reasons) {
    if (!allowedRejectionReasons.has(row.reason_code)) failures.push(`recommendation_rejections: unsupported reason_code "${row.reason_code}".`);
  }

  const stages = db
    .prepare(
      `SELECT DISTINCT stage
       FROM recommendation_rejections
       ORDER BY stage`
    )
    .all() as Array<{ stage: string }>;
  for (const row of stages) {
    if (!allowedRejectionStages.has(row.stage)) failures.push(`recommendation_rejections: unsupported stage "${row.stage}".`);
  }
  return failures;
}

function assertRerankTraceJson(db: DatabaseSync, input: Args) {
  const failures: string[] = [];
  const sessions = recentTraceSessions(db, input.sampleTraces);
  const rows = sessions.length === 0
    ? []
    : (db
        .prepare(
          `SELECT id, rerank_candidate_count, rerank_trace_json
           FROM recommendation_sessions
           WHERE id IN (${sessions.map(() => "?").join(", ")})`
        )
        .all(...sessions.map((session) => session.id)) as Array<{ id: string; rerank_candidate_count: number; rerank_trace_json?: string | null }>);
  for (const row of rows) {
    const parsed = parseJson(row.rerank_trace_json ?? "") as {
      schemaVersion?: string;
      rerankTraceVersion?: string;
      offeredCandidateCount?: number;
      serializedCandidateLimit?: number;
      rerankWindowCandidateCount?: number;
      rerankRequested?: boolean;
      serializedCandidateCount?: number;
      aiRankedCandidateCount?: number;
      postRerankCandidateCount?: number;
      resultCount?: number;
    } | undefined;
    if (!parsed) {
      failures.push(`${row.id}: rerank_trace_json is missing or invalid.`);
      continue;
    }
    if (rerankTraceHasMismatch(parsed, row.rerank_candidate_count)) {
      failures.push(`${row.id}: rerank trace window, provider-serialized count, or result count is invalid.`);
    }
  }
  return failures;
}

export function rerankTraceHasMismatch(parsedValue: unknown, persistedCandidateCount: number) {
  const parsed = parsedValue as {
    schemaVersion?: string;
    rerankTraceVersion?: string;
    offeredCandidateCount?: number;
    serializedCandidateLimit?: number;
    rerankWindowCandidateCount?: number;
    rerankRequested?: boolean;
    serializedCandidateCount?: number;
    aiRankedCandidateCount?: number;
    postRerankCandidateCount?: number;
    usedAi?: boolean;
    resultCount?: number;
  } | undefined;
  if (
    !parsed ||
    parsed.schemaVersion !== moodRankTraceSchemaVersion ||
    !Number.isInteger(persistedCandidateCount) ||
    persistedCandidateCount < 0 ||
    parsed.offeredCandidateCount !== persistedCandidateCount ||
    !Number.isInteger(parsed.serializedCandidateLimit) ||
    parsed.serializedCandidateLimit! < 0 ||
    parsed.serializedCandidateLimit! > 60
  ) return true;
  if (parsed.rerankTraceVersion === "rerank-trace-v1") return false;
  if (parsed.rerankTraceVersion !== "rerank-trace-v2") return true;
  if (
    !Number.isInteger(parsed.rerankWindowCandidateCount) ||
    parsed.rerankWindowCandidateCount !== persistedCandidateCount ||
    typeof parsed.rerankRequested !== "boolean" ||
    typeof parsed.usedAi !== "boolean" ||
    !Number.isInteger(parsed.serializedCandidateCount) ||
    parsed.serializedCandidateCount! < 0 ||
    parsed.serializedCandidateCount! > 60 ||
    parsed.serializedCandidateCount! > persistedCandidateCount ||
    parsed.serializedCandidateLimit !== parsed.serializedCandidateCount ||
    !Number.isInteger(parsed.postRerankCandidateCount) ||
    parsed.postRerankCandidateCount! < 0 ||
    parsed.postRerankCandidateCount! > persistedCandidateCount ||
    !Number.isInteger(parsed.resultCount) ||
    parsed.resultCount! < 0 ||
    parsed.postRerankCandidateCount !== parsed.resultCount
  ) return true;
  if (
    (parsed.rerankRequested || parsed.usedAi) &&
    (parsed.serializedCandidateCount === undefined || parsed.aiRankedCandidateCount === undefined)
  ) return true;
  if (
    parsed.aiRankedCandidateCount !== undefined &&
    (!Number.isInteger(parsed.aiRankedCandidateCount) ||
      parsed.aiRankedCandidateCount < 0 ||
      parsed.serializedCandidateCount === undefined ||
      parsed.aiRankedCandidateCount > parsed.serializedCandidateCount)
  ) return true;
  if (
    (parsed.usedAi && ((parsed.serializedCandidateCount ?? 0) < 1 || (parsed.aiRankedCandidateCount ?? 0) < 1)) ||
    (!parsed.usedAi && (parsed.aiRankedCandidateCount ?? 0) > 0)
  ) return true;
  return parsed.rerankRequested === false && (
    parsed.serializedCandidateCount !== 0 ||
    (parsed.aiRankedCandidateCount ?? 0) !== 0
  );
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function approximatelyEqual(left: number, right: number) {
  return Math.abs(left - right) <= 1e-9;
}

const entryPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryPath === import.meta.url) runCli();
