import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

const coreTraceTables: TableSpec[] = [
  {
    name: "recommendation_sessions",
    requiredColumns: ["id", "query_hash", "watch_context", "trace_schema_version", "trace_flags_json", "brief_trace_json", "retrieval_trace_json", "rerank_trace_json"]
  },
  {
    name: "recommendation_results",
    requiredColumns: ["session_id", "media_item_id", "score", "availability_group", "provenance_json", "score_trace_json"]
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
  }
];

const allowedRejectionReasons = new Set(["outside_result_limit", "outside_rerank_serialized_limit"]);
const allowedRejectionStages = new Set(["result_window_cut", "rerank_window_cut"]);

const args = parseArgs(process.argv.slice(2));
const dbPath = resolve(args.dbPath ?? process.env.MOODARR_DB_PATH ?? `${process.env.MOODARR_DATA_DIR ?? ".data"}/moodarr.sqlite`);

if (!existsSync(dbPath)) {
  console.error(`MoodRank trace eval could not find a SQLite database at ${dbPath}. Pass --db-path or set MOODARR_DB_PATH.`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });

try {
  const result = evaluateTracePersistence(db, args, dbPath);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
} finally {
  db.close();
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

function evaluateTracePersistence(db: DatabaseSync, input: Args, dbPath: string) {
  const existingTables = tableNames(db);
  const missingCoreTables = coreTraceTables.map((table) => table.name).filter((table) => !existingTables.has(table));
  const schemaFailures = coreTraceTables
    .filter((table) => existingTables.has(table.name))
    .flatMap((table) => missingColumns(db, table).map((column) => `${table.name}: missing required column ${column}`));

  if (missingCoreTables.length > 0) {
    return {
      ok: false,
      status: "trace_tables_missing",
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
  const unsafeRows = db
    .prepare(
      `SELECT COUNT(*) AS value
       FROM (
         SELECT brief_trace_json AS text_value FROM recommendation_sessions WHERE id IN (${placeholders})
         UNION ALL SELECT retrieval_trace_json FROM recommendation_sessions WHERE id IN (${placeholders})
         UNION ALL SELECT rerank_trace_json FROM recommendation_sessions WHERE id IN (${placeholders})
         UNION ALL SELECT provenance_json FROM recommendation_results WHERE session_id IN (${placeholders}) AND provenance_json IS NOT NULL
         UNION ALL SELECT score_trace_json FROM recommendation_results WHERE session_id IN (${placeholders}) AND score_trace_json IS NOT NULL
         UNION ALL SELECT detail_json FROM recommendation_candidate_provenance WHERE session_id IN (${placeholders}) AND detail_json IS NOT NULL
         UNION ALL SELECT detail_json FROM recommendation_rejections WHERE session_id IN (${placeholders}) AND detail_json IS NOT NULL
         UNION ALL SELECT query_text FROM query_review_queue WHERE session_id IN (${placeholders})
         UNION ALL SELECT optimized_query FROM query_review_queue WHERE session_id IN (${placeholders}) AND optimized_query IS NOT NULL
       )
       WHERE lower(text_value) GLOB '*http://*'
          OR lower(text_value) GLOB '*https://*'
          OR lower(text_value) GLOB '*api_key*'
          OR lower(text_value) GLOB '*token*'
          OR lower(text_value) GLOB '*bearer *'
          OR lower(text_value) GLOB '*plex_url*'
          OR lower(text_value) GLOB '*seerr_url*'
          OR lower(text_value) GLOB '*localhost*'
          OR lower(text_value) GLOB '*127.0.0.1*'
          OR lower(text_value) GLOB '*192.168.*'
          OR lower(text_value) GLOB '*10.*.*.*'
          OR lower(text_value) GLOB '*172.16.*'
          OR lower(text_value) GLOB '*poster*'`
    )
    .get(...sampledSessionIds, ...sampledSessionIds, ...sampledSessionIds, ...sampledSessionIds, ...sampledSessionIds, ...sampledSessionIds, ...sampledSessionIds, ...sampledSessionIds, ...sampledSessionIds) as { value: number };
  if (unsafeRows.value > 0) failures.push(`trace privacy: ${unsafeRows.value} text field(s) appear to contain URLs or secret-like strings.`);
  return failures;
}

function assertFinalResultsHaveTrace(db: DatabaseSync, input: Args) {
  const failures: string[] = [];
  for (const session of recentTraceSessions(db, input.sampleTraces)) {
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
    failures.push(...mismatchedScores.map((itemId) => `${session.id}: ${itemId} score trace finalScore does not match persisted result score.`));
  }
  return failures;
}

function scoreTraceMismatches(db: DatabaseSync, sessionId: string) {
  const rows = db
    .prepare(
      `SELECT media_item_id, score, score_trace_json
       FROM recommendation_results
       WHERE session_id = ?
        AND score_trace_json IS NOT NULL`
    )
    .all(sessionId) as Array<{ media_item_id: string; score: number; score_trace_json: string }>;
  return rows.flatMap((row) => {
    const parsed = parseJson(row.score_trace_json) as { finalScore?: number; buckets?: unknown[] } | undefined;
    if (!parsed || parsed.finalScore !== row.score || !Array.isArray(parsed.buckets) || parsed.buckets.length === 0) return [row.media_item_id];
    return [];
  });
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
    const parsed = parseJson(row.rerank_trace_json ?? "") as { offeredCandidateCount?: number; serializedCandidateLimit?: number } | undefined;
    if (!parsed) {
      failures.push(`${row.id}: rerank_trace_json is missing or invalid.`);
      continue;
    }
    if (parsed.offeredCandidateCount !== row.rerank_candidate_count) failures.push(`${row.id}: rerank trace candidate count does not match session rerank_candidate_count.`);
    if (typeof parsed.serializedCandidateLimit !== "number" || parsed.serializedCandidateLimit > 60) failures.push(`${row.id}: rerank trace serializedCandidateLimit is invalid.`);
  }
  return failures;
}

function parseJson(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
