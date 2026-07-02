import { loadConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";
import { buildMediaFeatureDocument, parseFeatureVector, type MediaFeatureDocument } from "../src/server/recommendation/features";
import {
  CONTENT_FINGERPRINT_MOOD_SCORE_SOURCE,
  CONTENT_FINGERPRINT_MOOD_SCORE_VERSION,
  CONTENT_FINGERPRINT_VERSION,
  buildContentFingerprint,
  contentFingerprintMoodFeatureScores,
  fingerprintToJson
} from "../src/server/recommendation/contentFingerprint";
import { normalizeMoodFeatureKey } from "../src/server/recommendation/moodFeatureIndex";
import { normalizeTitle } from "../src/server/db/mediaRepository";
import type { AvailabilityGroup, ItemDetail, MediaSource, MediaType, SeerrStatus } from "../src/shared/types";

interface Args {
  all: boolean;
  dryRun: boolean;
  batchSize: number;
  limit?: number;
}

interface MediaRow {
  id: string;
  media_type: MediaType;
  title: string;
  year?: number | null;
  summary?: string | null;
  runtime_minutes?: number | null;
  content_rating?: string | null;
  poster_path?: string | null;
  critic_rating?: number | null;
  audience_rating?: number | null;
  user_rating?: number | null;
  source?: MediaSource | null;
}

interface PlexRow {
  media_item_id: string;
  available: number;
  library_title?: string | null;
}

interface SeerrRow {
  media_item_id: string;
  status: SeerrStatus;
  request_status?: string | null;
  requestable: number;
  seerr_url?: string | null;
  tmdb_id?: number | null;
}

interface FeatureRow {
  media_item_id: string;
  feature_text: string;
  mood_terms_json: string;
  tone_terms_json: string;
  watchability_terms_json: string;
  vector_json: string;
  feature_version: string;
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();
const db = createDatabase(config.dbPath);
const scoreSource = normalizeTitle(CONTENT_FINGERPRINT_MOOD_SCORE_SOURCE);
const startedAt = Date.now();

db.exec("PRAGMA busy_timeout = 10000");

const upsertFingerprint = db.prepare(`INSERT INTO media_content_fingerprints (
  media_item_id, schema_version, fingerprint_version, source, source_version,
  input_hash, fingerprint_json, generated_at, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(media_item_id) DO UPDATE SET
  schema_version = excluded.schema_version,
  fingerprint_version = excluded.fingerprint_version,
  source = excluded.source,
  source_version = excluded.source_version,
  input_hash = excluded.input_hash,
  fingerprint_json = excluded.fingerprint_json,
  generated_at = excluded.generated_at,
  updated_at = excluded.updated_at`);
const deleteScoreRows = db.prepare("DELETE FROM media_mood_feature_scores WHERE media_item_id = ? AND source = ?");
const insertScoreRow = db.prepare(`INSERT INTO media_mood_feature_scores (
  media_item_id, source, source_version, feature, score, confidence, updated_at
) VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(media_item_id, source, feature) DO UPDATE SET
  source_version = excluded.source_version,
  score = excluded.score,
  confidence = excluded.confidence,
  updated_at = excluded.updated_at`);
const featureStatement = db.prepare(
  "SELECT media_item_id, feature_text, mood_terms_json, tone_terms_json, watchability_terms_json, vector_json, feature_version FROM media_features WHERE media_item_id = ?"
);

const totalItems = count("SELECT COUNT(*) AS value FROM media_items");
let currentFingerprints = count("SELECT COUNT(*) AS value FROM media_content_fingerprints WHERE fingerprint_version = ?", CONTENT_FINGERPRINT_VERSION);
let processed = 0;
let rebuilt = 0;
let projectedRows = 0;
let lastTitle = "";
let lastId = "";
let batch = 0;

printProgress("start", {
  totalItems,
  currentFingerprints,
  currentProjectedItems: count("SELECT COUNT(DISTINCT media_item_id) AS value FROM media_mood_feature_scores WHERE source = ?", scoreSource),
  currentProjectedRows: count("SELECT COUNT(*) AS value FROM media_mood_feature_scores WHERE source = ?", scoreSource),
  batchSize: args.batchSize,
  limit: args.limit,
  mode: args.all ? "all" : "stale-only",
  dryRun: args.dryRun
});

while (processed < (args.limit ?? Number.POSITIVE_INFINITY)) {
  const rows = nextRows(lastTitle, lastId, Math.min(args.batchSize, (args.limit ?? Number.POSITIVE_INFINITY) - processed));
  if (rows.length === 0) break;
  const items = inflateMany(rows);
  const now = new Date().toISOString();
  batch += 1;

  if (!args.dryRun) db.exec("BEGIN IMMEDIATE");
  try {
    for (const item of items) {
      const feature = storedFeatureForItem(item.id) ?? buildMediaFeatureDocument(item);
      const fingerprint = buildContentFingerprint(item, feature, now);
      const scores = contentFingerprintMoodFeatureScores(fingerprint);
      if (!args.dryRun) {
        upsertFingerprint.run(
          item.id,
          fingerprint.schemaVersion,
          fingerprint.fingerprintVersion,
          fingerprint.source,
          fingerprint.sourceVersion,
          fingerprint.inputHash,
          fingerprintToJson(fingerprint),
          fingerprint.generatedAt,
          now
        );
        deleteScoreRows.run(item.id, scoreSource);
        for (const score of scores) {
          const normalizedFeature = normalizeMoodFeatureKey(score.feature);
          if (!normalizedFeature) continue;
          const normalizedScore = clamp(score.score, 0, 100);
          const normalizedConfidence = clamp(score.confidence ?? 1, 0, 1);
          if (normalizedScore <= 0 || normalizedConfidence <= 0) continue;
          insertScoreRow.run(item.id, scoreSource, CONTENT_FINGERPRINT_MOOD_SCORE_VERSION, normalizedFeature, normalizedScore, normalizedConfidence, now);
          projectedRows += 1;
        }
      } else {
        projectedRows += scores.length;
      }
      rebuilt += 1;
    }
    if (!args.dryRun) db.exec("COMMIT");
  } catch (error) {
    if (!args.dryRun) db.exec("ROLLBACK");
    throw error;
  }

  const lastRow = rows[rows.length - 1]!;
  lastTitle = lastRow.title;
  lastId = lastRow.id;
  processed += rows.length;
  currentFingerprints = args.dryRun
    ? currentFingerprints
    : count("SELECT COUNT(*) AS value FROM media_content_fingerprints WHERE fingerprint_version = ?", CONTENT_FINGERPRINT_VERSION);
  printProgress("batch", {
    batch,
    rows: rows.length,
    processed,
    rebuilt,
    projectedRows,
    currentFingerprints,
    currentProjectedItems: args.dryRun ? undefined : count("SELECT COUNT(DISTINCT media_item_id) AS value FROM media_mood_feature_scores WHERE source = ?", scoreSource),
    currentProjectedRows: args.dryRun ? undefined : count("SELECT COUNT(*) AS value FROM media_mood_feature_scores WHERE source = ?", scoreSource)
  });
}

printProgress("complete", {
  totalItems,
  rebuilt,
  projectedRows,
  currentFingerprints: count("SELECT COUNT(*) AS value FROM media_content_fingerprints WHERE fingerprint_version = ?", CONTENT_FINGERPRINT_VERSION),
  staleFingerprints: count("SELECT COUNT(*) AS value FROM media_content_fingerprints WHERE fingerprint_version != ?", CONTENT_FINGERPRINT_VERSION),
  currentProjectedItems: count("SELECT COUNT(DISTINCT media_item_id) AS value FROM media_mood_feature_scores WHERE source = ?", scoreSource),
  currentProjectedRows: count("SELECT COUNT(*) AS value FROM media_mood_feature_scores WHERE source = ?", scoreSource),
  elapsedMs: Date.now() - startedAt,
  dryRun: args.dryRun
});

function nextRows(lastSeenTitle: string, lastSeenId: string, limit: number) {
  const values: Array<string | number> = [];
  const clauses = ["(m.title > ? OR (m.title = ? AND m.id > ?))"];
  values.push(lastSeenTitle, lastSeenTitle, lastSeenId);
  if (!args.all) {
    clauses.push("(f.media_item_id IS NULL OR f.fingerprint_version != ?)");
    values.push(CONTENT_FINGERPRINT_VERSION);
  }
  values.push(limit);
  return db
    .prepare(
      `SELECT m.*
       FROM media_items m
       LEFT JOIN media_content_fingerprints f ON f.media_item_id = m.id
       WHERE ${clauses.join(" AND ")}
       ORDER BY m.title, m.id
       LIMIT ?`
    )
    .all(...values) as unknown as MediaRow[];
}

function inflateMany(rows: MediaRow[]): ItemDetail[] {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const scope = scoped(ids);
  const genresById = groupNameRows(
    db.prepare(`SELECT media_item_id, name FROM genres WHERE media_item_id IN (${scope.placeholders}) ORDER BY media_item_id, name`).all(...scope.values) as Array<{
      media_item_id: string;
      name: string;
    }>
  );
  const people = db
    .prepare(
      `SELECT media_item_id, name, role
       FROM people
       WHERE role IN ('cast', 'director') AND media_item_id IN (${scope.placeholders})
       ORDER BY media_item_id, role, name`
    )
    .all(...scope.values) as Array<{ media_item_id: string; name: string; role: "cast" | "director" }>;
  const castById = groupNameRows(people.filter((person) => person.role === "cast"));
  const directorsById = groupNameRows(people.filter((person) => person.role === "director"));
  const externalIdsById = new Map<string, Record<string, string>>();
  for (const row of db
    .prepare(`SELECT media_item_id, source, value FROM external_ids WHERE media_item_id IN (${scope.placeholders}) ORDER BY media_item_id, source`)
    .all(...scope.values) as Array<{ media_item_id: string; source: string; value: string }>) {
    const values = externalIdsById.get(row.media_item_id) ?? {};
    values[row.source] = row.value;
    externalIdsById.set(row.media_item_id, values);
  }
  const plexById = new Map(
    (
      db
        .prepare(`SELECT media_item_id, available, library_title FROM plex_items WHERE media_item_id IN (${scope.placeholders}) ORDER BY media_item_id`)
        .all(...scope.values) as unknown as PlexRow[]
    ).map((row) => [row.media_item_id, row])
  );
  const seerrById = new Map(
    (
      db
        .prepare(
          `SELECT media_item_id, status, request_status, requestable, seerr_url, tmdb_id
           FROM seerr_items
           WHERE media_item_id IN (${scope.placeholders})
           ORDER BY media_item_id`
        )
        .all(...scope.values) as unknown as SeerrRow[]
    ).map((row) => [row.media_item_id, row])
  );
  const catalogCountById = new Map(
    (
      db
        .prepare(
          `SELECT media_item_id, COUNT(*) AS value
           FROM catalog_source_records
           WHERE active = 1 AND media_item_id IN (${scope.placeholders})
           GROUP BY media_item_id`
        )
        .all(...scope.values) as Array<{ media_item_id: string; value: number }>
    ).map((row) => [row.media_item_id, row.value])
  );

  return rows.map((row) =>
    inflate(row, {
      genres: genresById.get(row.id) ?? [],
      cast: castById.get(row.id) ?? [],
      directors: directorsById.get(row.id) ?? [],
      externalIds: externalIdsById.get(row.id) ?? {},
      plex: plexById.get(row.id),
      seerr: seerrById.get(row.id),
      catalogSourceCount: catalogCountById.get(row.id) ?? 0
    })
  );
}

function inflate(
  row: MediaRow,
  parts: {
    genres: string[];
    cast: string[];
    directors: string[];
    externalIds: Record<string, string>;
    plex?: PlexRow;
    seerr?: SeerrRow;
    catalogSourceCount: number;
  }
): ItemDetail {
  const availabilityGroup = getAvailabilityGroup(parts.plex, parts.seerr);
  return {
    id: row.id,
    mediaType: row.media_type,
    title: row.title,
    year: row.year ?? undefined,
    runtimeMinutes: row.runtime_minutes ?? undefined,
    summary: row.summary ?? undefined,
    genres: parts.genres,
    contentRating: row.content_rating ?? undefined,
    ratings: {
      critic: row.critic_rating ?? undefined,
      audience: row.audience_rating ?? undefined,
      user: row.user_rating ?? undefined
    },
    posterUrl: `/api/items/${encodeURIComponent(row.id)}/poster`,
    availabilityGroup,
    availabilityExplanation: "Backfill metadata.",
    matchExplanation: "Matched by local metadata.",
    score: 0,
    metadata: {
      hasPoster: Boolean(row.poster_path),
      sparse: isSparseSeerrPlaceholder(row.title) || !row.summary?.trim(),
      source: row.source ?? undefined,
      catalogSourceCount: parts.catalogSourceCount
    },
    plex: parts.plex ? { available: Boolean(parts.plex.available), library: parts.plex.library_title ?? undefined } : undefined,
    seerr: parts.seerr
      ? {
          status: parts.seerr.status,
          requestStatus: parts.seerr.request_status ?? undefined,
          requestable: Boolean(parts.seerr.requestable),
          url: parts.seerr.seerr_url ?? undefined,
          mediaId: parts.seerr.tmdb_id ?? undefined
        }
      : undefined,
    cast: parts.cast,
    directors: parts.directors,
    externalIds: parts.externalIds
  };
}

function storedFeatureForItem(itemId: string): MediaFeatureDocument | undefined {
  const row = featureStatement.get(itemId) as FeatureRow | undefined;
  if (!row) return undefined;
  return {
    mediaItemId: row.media_item_id,
    featureText: row.feature_text,
    moodTerms: parseStringArray(row.mood_terms_json),
    toneTerms: parseStringArray(row.tone_terms_json),
    watchabilityTerms: parseStringArray(row.watchability_terms_json),
    vector: parseFeatureVector(row.vector_json),
    version: row.feature_version
  };
}

function getAvailabilityGroup(plex: PlexRow | undefined, seerr: SeerrRow | undefined): AvailabilityGroup {
  if (plex?.available) return "available_in_plex";
  if (seerr?.status === "partially_available") return "partially_available";
  if (seerr?.request_status || ["requested", "pending", "approved", "processing"].includes(seerr?.status ?? "")) return "already_requested";
  if (seerr?.requestable) return "not_in_plex_requestable";
  return "unavailable";
}

function scoped(ids: string[]) {
  return { values: ids, placeholders: ids.map(() => "?").join(", ") };
}

function groupNameRows(rows: Array<{ media_item_id: string; name: string }>) {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const values = grouped.get(row.media_item_id) ?? [];
    values.push(row.name);
    grouped.set(row.media_item_id, values);
  }
  return grouped;
}

function parseStringArray(value: string | undefined) {
  try {
    const parsed = JSON.parse(value ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function parseArgs(values: string[]): Args {
  const parsed: Args = { all: false, dryRun: false, batchSize: 1000 };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--all") parsed.all = true;
    else if (value === "--dry-run") parsed.dryRun = true;
    else if (value === "--batch-size") parsed.batchSize = Math.max(1, parsePositiveInteger(values[++index], parsed.batchSize));
    else if (value === "--limit") parsed.limit = parsePositiveInteger(values[++index], parsed.limit ?? 0);
  }
  return parsed;
}

function parsePositiveInteger(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function count(sql: string, ...values: Array<string | number>) {
  return (db.prepare(sql).get(...values) as { value: number }).value;
}

function isSparseSeerrPlaceholder(title: string) {
  return /^(movie|tv)\s+\d+$/i.test(title.trim());
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Number(value)));
}

function printProgress(event: string, payload: Record<string, unknown>) {
  console.log(JSON.stringify({ event, generatedAt: new Date().toISOString(), ...payload }));
}
