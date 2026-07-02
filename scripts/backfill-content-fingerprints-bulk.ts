import { loadConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";
import { FEATURE_VERSION, buildMediaFeatureDocument, parseFeatureVector, type MediaFeatureDocument } from "../src/server/recommendation/features";
import {
  CONTENT_FINGERPRINT_MOOD_SCORE_SOURCE,
  CONTENT_FINGERPRINT_MOOD_SCORE_VERSION,
  CONTENT_FINGERPRINT_VERSION,
  buildContentFingerprint,
  contentFingerprintMoodFeatureScores,
  fingerprintToJson
} from "../src/server/recommendation/contentFingerprint";
import { deterministicMoodFeatureScores, normalizeMoodFeatureKey } from "../src/server/recommendation/moodFeatureIndex";
import { summarizeCatalogMetadataRows, type CatalogMetadataSourceRow } from "../src/server/recommendation/catalogMetadata";
import { normalizeTitle } from "../src/server/db/mediaRepository";
import type { AvailabilityGroup, ItemDetail, MediaSource, MediaType, SeerrStatus } from "../src/shared/types";

interface Args {
  all: boolean;
  dryRun: boolean;
  refreshFeatures: boolean;
  skipContentFingerprints: boolean;
  deferFeatureFts: boolean;
  cleanupMalformed: boolean;
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

interface ExistingMoodScoreRow {
  media_item_id: string;
  source_version: string;
  feature: string;
  score: number;
  confidence: number;
}

interface NormalizedMoodScore {
  feature: string;
  score: number;
  confidence: number;
}

const args = parseArgs(process.argv.slice(2));
const config = loadConfig();
const db = createDatabase(config.dbPath);
const scoreSource = normalizeTitle(CONTENT_FINGERPRINT_MOOD_SCORE_SOURCE);
const deterministicSource = "deterministic";
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
const upsertFeature = db.prepare(
  `INSERT INTO media_features (
    media_item_id, feature_text, mood_terms_json, tone_terms_json, watchability_terms_json, vector_json, feature_version, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(media_item_id) DO UPDATE SET
    feature_text = excluded.feature_text,
    mood_terms_json = excluded.mood_terms_json,
    tone_terms_json = excluded.tone_terms_json,
    watchability_terms_json = excluded.watchability_terms_json,
    vector_json = excluded.vector_json,
    feature_version = excluded.feature_version,
    updated_at = excluded.updated_at`
);
const deleteFeatureFts = db.prepare("DELETE FROM media_feature_fts WHERE media_item_id = ?");
const insertFeatureFts = db.prepare("INSERT INTO media_feature_fts (media_item_id, title, feature_text, genres, people) VALUES (?, ?, ?, ?, ?)");

const totalItems = count("SELECT COUNT(*) AS value FROM media_items");
let currentFingerprints = count("SELECT COUNT(*) AS value FROM media_content_fingerprints WHERE fingerprint_version = ?", CONTENT_FINGERPRINT_VERSION);
let processed = 0;
let rebuilt = 0;
let projectedRows = 0;
let skippedProjectedRows = 0;
let refreshedFeatures = 0;
let projectedDeterministicRows = 0;
let rebuiltFeatureFtsRows = 0;
let deletedMalformedMoodFeatures = 0;
let lastTitle = "";
let lastId = "";
let batch = 0;

printProgress("start", {
  totalItems,
  currentFingerprints,
  currentProjectedItems: count("SELECT COUNT(DISTINCT media_item_id) AS value FROM media_mood_feature_scores WHERE source = ?", scoreSource),
  currentProjectedRows: count("SELECT COUNT(*) AS value FROM media_mood_feature_scores WHERE source = ?", scoreSource),
  currentFeatureDocuments: count("SELECT COUNT(*) AS value FROM media_features WHERE feature_version = ?", FEATURE_VERSION),
  staleFeatureDocuments: count("SELECT COUNT(*) AS value FROM media_features WHERE feature_version != ?", FEATURE_VERSION),
  batchSize: args.batchSize,
  limit: args.limit,
  mode: args.all ? "all" : "stale-only",
  refreshFeatures: args.refreshFeatures,
  skipContentFingerprints: args.skipContentFingerprints,
  deferFeatureFts: args.deferFeatureFts,
  cleanupMalformed: args.cleanupMalformed,
  dryRun: args.dryRun
});

while (processed < (args.limit ?? Number.POSITIVE_INFINITY)) {
  const rows = nextRows(lastTitle, lastId, Math.min(args.batchSize, (args.limit ?? Number.POSITIVE_INFINITY) - processed));
  if (rows.length === 0) break;
  const items = inflateMany(rows);
  const existingFingerprintScoreSignatures =
    args.dryRun || args.skipContentFingerprints ? new Map<string, string>() : existingMoodScoreSignatures(items.map((item) => item.id), scoreSource);
  const now = new Date().toISOString();
  batch += 1;

  if (!args.dryRun) db.exec("BEGIN IMMEDIATE");
  try {
    for (const item of items) {
      const storedFeature = args.refreshFeatures ? undefined : storedFeatureForItem(item.id);
      const feature = args.refreshFeatures || storedFeature?.version !== FEATURE_VERSION ? buildMediaFeatureDocument(item) : storedFeature;
      if (args.refreshFeatures) {
        const deterministicScores = normalizeMoodScores(deterministicMoodFeatureScores(feature));
        if (!args.dryRun) {
          upsertFeature.run(
            item.id,
            feature.featureText,
            JSON.stringify(feature.moodTerms),
            JSON.stringify(feature.toneTerms),
            JSON.stringify(feature.watchabilityTerms),
            JSON.stringify(feature.vector),
            feature.version,
            now
          );
          if (!args.deferFeatureFts) {
            deleteFeatureFts.run(item.id);
            insertFeatureFts.run(item.id, item.title, feature.featureText, item.genres.join(" "), [...item.cast, ...item.directors].join(" "));
          }
          deleteScoreRows.run(item.id, deterministicSource);
          for (const score of deterministicScores) {
            insertScoreRow.run(item.id, deterministicSource, feature.version, score.feature, score.score, score.confidence, now);
            projectedDeterministicRows += 1;
          }
        } else {
          projectedDeterministicRows += deterministicScores.length;
        }
        refreshedFeatures += 1;
      }
      if (!args.skipContentFingerprints) {
        const fingerprint = buildContentFingerprint(item, feature, now);
        const scores = normalizeMoodScores(contentFingerprintMoodFeatureScores(fingerprint));
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
          const scoreSignature = moodScoreSignature(CONTENT_FINGERPRINT_MOOD_SCORE_VERSION, scores);
          if (existingFingerprintScoreSignatures.get(item.id) === scoreSignature) {
            skippedProjectedRows += scores.length;
          } else {
            deleteScoreRows.run(item.id, scoreSource);
            for (const score of scores) {
              insertScoreRow.run(item.id, scoreSource, CONTENT_FINGERPRINT_MOOD_SCORE_VERSION, score.feature, score.score, score.confidence, now);
              projectedRows += 1;
            }
          }
        } else {
          projectedRows += scores.length;
        }
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
    skippedProjectedRows,
    refreshedFeatures,
    projectedDeterministicRows,
    currentFingerprints,
    currentProjectedItems: args.dryRun ? undefined : count("SELECT COUNT(DISTINCT media_item_id) AS value FROM media_mood_feature_scores WHERE source = ?", scoreSource),
    currentProjectedRows: args.dryRun ? undefined : count("SELECT COUNT(*) AS value FROM media_mood_feature_scores WHERE source = ?", scoreSource),
    currentFeatureDocuments: args.dryRun ? undefined : count("SELECT COUNT(*) AS value FROM media_features WHERE feature_version = ?", FEATURE_VERSION),
    staleFeatureDocuments: args.dryRun ? undefined : count("SELECT COUNT(*) AS value FROM media_features WHERE feature_version != ?", FEATURE_VERSION)
  });
}

if (!args.dryRun && args.refreshFeatures && args.deferFeatureFts) {
  rebuiltFeatureFtsRows = rebuildFeatureFts();
}

if (!args.dryRun && args.cleanupMalformed) {
  deletedMalformedMoodFeatures = cleanupMalformedMoodFeatures();
}

printProgress("complete", {
  totalItems,
  rebuilt,
  projectedRows,
  skippedProjectedRows,
  refreshedFeatures,
  projectedDeterministicRows,
  rebuiltFeatureFtsRows,
  deletedMalformedMoodFeatures,
  currentFingerprints: count("SELECT COUNT(*) AS value FROM media_content_fingerprints WHERE fingerprint_version = ?", CONTENT_FINGERPRINT_VERSION),
  staleFingerprints: count("SELECT COUNT(*) AS value FROM media_content_fingerprints WHERE fingerprint_version != ?", CONTENT_FINGERPRINT_VERSION),
  currentProjectedItems: count("SELECT COUNT(DISTINCT media_item_id) AS value FROM media_mood_feature_scores WHERE source = ?", scoreSource),
  currentProjectedRows: count("SELECT COUNT(*) AS value FROM media_mood_feature_scores WHERE source = ?", scoreSource),
  currentFeatureDocuments: count("SELECT COUNT(*) AS value FROM media_features WHERE feature_version = ?", FEATURE_VERSION),
  staleFeatureDocuments: count("SELECT COUNT(*) AS value FROM media_features WHERE feature_version != ?", FEATURE_VERSION),
  malformedMoodFeatures: count("SELECT COUNT(*) AS value FROM media_mood_feature_scores WHERE feature LIKE char(58) || char(37)"),
  elapsedMs: Date.now() - startedAt,
  dryRun: args.dryRun
});

function nextRows(lastSeenTitle: string, lastSeenId: string, limit: number) {
  const values: Array<string | number> = [];
  const clauses = ["(m.title > ? OR (m.title = ? AND m.id > ?))"];
  values.push(lastSeenTitle, lastSeenTitle, lastSeenId);
  if (!args.all) {
    if (args.refreshFeatures) {
      clauses.push("(f.media_item_id IS NULL OR f.fingerprint_version != ? OR mf.media_item_id IS NULL OR mf.feature_version != ?)");
      values.push(CONTENT_FINGERPRINT_VERSION, FEATURE_VERSION);
    } else {
      clauses.push("(f.media_item_id IS NULL OR f.fingerprint_version != ?)");
      values.push(CONTENT_FINGERPRINT_VERSION);
    }
  }
  values.push(limit);
  return db
    .prepare(
      `SELECT m.*
       FROM media_items m
       LEFT JOIN media_content_fingerprints f ON f.media_item_id = m.id
       ${args.refreshFeatures ? "LEFT JOIN media_features mf ON mf.media_item_id = m.id" : ""}
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
  const catalogMetadataById = summarizeCatalogMetadataRows(
    db
      .prepare(
        `SELECT
          r.media_item_id AS mediaItemId,
          r.source,
          r.metadata_json AS metadataJson,
          s.mainstream_score AS mainstreamScore,
          s.metadata_confidence AS metadataConfidence,
          s.sitelink_count AS sitelinkCount,
          s.external_id_count AS externalIdCount,
          s.award_count AS awardCount
         FROM catalog_source_records r
         LEFT JOIN catalog_rank_signals s
          ON s.media_item_id = r.media_item_id AND s.source = r.source
         WHERE r.active = 1 AND r.media_item_id IN (${scope.placeholders})
         ORDER BY r.media_item_id, r.source`
      )
      .all(...scope.values) as unknown as CatalogMetadataSourceRow[]
  );

  return rows.map((row) =>
    inflate(row, {
      genres: genresById.get(row.id) ?? [],
      cast: castById.get(row.id) ?? [],
      directors: directorsById.get(row.id) ?? [],
      externalIds: externalIdsById.get(row.id) ?? {},
      plex: plexById.get(row.id),
      seerr: seerrById.get(row.id),
      catalogMetadata: catalogMetadataById.get(row.id)
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
    catalogMetadata?: NonNullable<ItemDetail["metadata"]>["catalog"];
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
      catalogSourceCount: parts.catalogMetadata?.sourceCount ?? 0,
      catalog: parts.catalogMetadata
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

function existingMoodScoreSignatures(itemIds: string[], source: string) {
  const signatures = new Map<string, string>();
  if (itemIds.length === 0) return signatures;
  const scope = scoped(itemIds);
  const rows = db
    .prepare(
      `SELECT media_item_id, source_version, feature, score, confidence
       FROM media_mood_feature_scores
       WHERE source = ? AND media_item_id IN (${scope.placeholders})
       ORDER BY media_item_id, feature`
    )
    .all(source, ...scope.values) as unknown as ExistingMoodScoreRow[];
  const grouped = new Map<string, NormalizedMoodScore[]>();
  const sourceVersions = new Map<string, string>();
  for (const row of rows) {
    sourceVersions.set(row.media_item_id, row.source_version);
    const values = grouped.get(row.media_item_id) ?? [];
    values.push({
      feature: row.feature,
      score: clamp(row.score, 0, 100),
      confidence: clamp(row.confidence, 0, 1)
    });
    grouped.set(row.media_item_id, values);
  }
  for (const [mediaItemId, scores] of grouped.entries()) {
    signatures.set(mediaItemId, moodScoreSignature(sourceVersions.get(mediaItemId) ?? "", scores));
  }
  return signatures;
}

function rebuildFeatureFts() {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("DELETE FROM media_feature_fts").run();
    const result = db
      .prepare(
        `INSERT INTO media_feature_fts (media_item_id, title, feature_text, genres, people)
         SELECT
          m.id,
          m.title,
          f.feature_text,
          COALESCE((SELECT group_concat(g.name, ' ') FROM genres g WHERE g.media_item_id = m.id), ''),
          COALESCE((SELECT group_concat(p.name, ' ') FROM people p WHERE p.media_item_id = m.id AND p.role IN ('cast', 'director')), '')
         FROM media_items m
         JOIN media_features f ON f.media_item_id = m.id`
      )
      .run();
    db.exec("COMMIT");
    return Number(result.changes);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function cleanupMalformedMoodFeatures() {
  return Number(db.prepare("DELETE FROM media_mood_feature_scores WHERE feature LIKE char(58) || char(37)").run().changes);
}

function normalizeMoodScores(scores: Array<{ feature: string; score: number; confidence?: number }>): NormalizedMoodScore[] {
  return scores
    .map((score) => ({
      feature: normalizeMoodFeatureKey(score.feature),
      score: clamp(score.score, 0, 100),
      confidence: clamp(score.confidence ?? 1, 0, 1)
    }))
    .filter((score) => score.feature && score.score > 0 && score.confidence > 0)
    .sort((left, right) => left.feature.localeCompare(right.feature));
}

function moodScoreSignature(sourceVersion: string, scores: NormalizedMoodScore[]) {
  return [sourceVersion, ...scores.map((score) => `${score.feature}:${score.score.toFixed(4)}:${score.confidence.toFixed(4)}`)].join("|");
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
  const parsed: Args = {
    all: false,
    dryRun: false,
    refreshFeatures: false,
    skipContentFingerprints: false,
    deferFeatureFts: false,
    cleanupMalformed: false,
    batchSize: 1000
  };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--all") parsed.all = true;
    else if (value === "--dry-run") parsed.dryRun = true;
    else if (value === "--refresh-features") parsed.refreshFeatures = true;
    else if (value === "--skip-content-fingerprints") parsed.skipContentFingerprints = true;
    else if (value === "--defer-feature-fts") parsed.deferFeatureFts = true;
    else if (value === "--cleanup-malformed") parsed.cleanupMalformed = true;
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
