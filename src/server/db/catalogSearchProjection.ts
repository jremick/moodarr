import type { SqliteDatabase } from "./database";
import { normalizeTitle } from "./textNormalization";

export function registerCatalogSearchProjectionFunctions(db: SqliteDatabase) {
  db.function(
    "moodarr_normalize_title",
    { deterministic: true, directOnly: true },
    (value) => typeof value === "string" || typeof value === "number" ? normalizeTitle(String(value)) : ""
  );
}

export const catalogSearchEligibleMediaIdsSql = `
  SELECT m.id AS media_item_id
  FROM media_items m
  WHERE m.source != 'operational'
    AND NOT (
      m.source = 'catalog'
      AND EXISTS (
        SELECT 1
        FROM catalog_source_records catalog_record
        WHERE catalog_record.media_item_id = m.id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM catalog_source_records active_catalog_record
        WHERE active_catalog_record.media_item_id = m.id
          AND active_catalog_record.active = 1
      )
      AND (
        EXISTS (
          SELECT 1
          FROM media_identity_quarantine quarantine
          WHERE quarantine.media_item_id = m.id
        )
        OR (
          NOT EXISTS (
            SELECT 1
            FROM plex_items plex
            WHERE plex.media_item_id = m.id
              AND plex.available = 1
          )
          AND NOT EXISTS (
            SELECT 1
            FROM seerr_items seerr
            WHERE seerr.media_item_id = m.id
              AND (
                seerr.status = 'partially_available'
                OR seerr.request_status IS NOT NULL
                OR seerr.status IN ('requested', 'pending', 'approved', 'processing')
                OR seerr.requestable = 1
              )
          )
        )
      )
    )`;

/**
 * Rebuilds every derived catalog search row inside the caller's transaction.
 * Catalog source records remain unchanged; only explicitly allowlisted metadata
 * values are projected into lexical search text.
 */
export function rebuildCatalogSearchProjection(db: SqliteDatabase, updatedAt: string) {
  projectCatalogSearchRows(db, updatedAt);
  return (db.prepare("SELECT COUNT(*) AS value FROM catalog_search_index").get() as { value: number }).value;
}

/** Refreshes one item through the same projection used by full rebuilds. */
export function refreshCatalogSearchProjection(db: SqliteDatabase, mediaItemId: string, updatedAt: string) {
  refreshCatalogSearchProjections(db, [mediaItemId], updatedAt);
}

export function refreshCatalogSearchProjections(db: SqliteDatabase, mediaItemIds: string[], updatedAt: string) {
  const uniqueIds = [...new Set(mediaItemIds)].filter(Boolean);
  for (let offset = 0; offset < uniqueIds.length; offset += 400) {
    const batchIds = uniqueIds.slice(offset, offset + 400);
    db.exec("SAVEPOINT catalog_search_projection_refresh");
    try {
      projectCatalogSearchRows(db, updatedAt, batchIds);
      db.exec("RELEASE SAVEPOINT catalog_search_projection_refresh");
    } catch (error) {
      try {
        db.exec("ROLLBACK TO SAVEPOINT catalog_search_projection_refresh");
      } finally {
        db.exec("RELEASE SAVEPOINT catalog_search_projection_refresh");
      }
      throw error;
    }
  }
}

function projectCatalogSearchRows(db: SqliteDatabase, updatedAt: string, mediaItemIds?: string[]) {
  const targeted = mediaItemIds !== undefined;
  if (!targeted) {
    db.prepare("DELETE FROM catalog_search_index_fts").run();
    db.prepare("DELETE FROM catalog_search_index").run();
  } else {
    const placeholders = mediaItemIds.map(() => "?").join(", ");
    db.prepare(`DELETE FROM catalog_search_index_fts WHERE media_item_id IN (${placeholders})`).run(...mediaItemIds);
    db.prepare(`DELETE FROM catalog_search_index WHERE media_item_id IN (${placeholders})`).run(...mediaItemIds);
  }

  const targetClause = targeted ? `WHERE media_item_id IN (${mediaItemIds.map(() => "?").join(", ")})` : "";
  db
    .prepare(
      `INSERT INTO catalog_search_index (
        media_item_id, title, media_type, year, source, rank_score, availability_group,
        plex_available, seerr_requestable, has_seerr, has_summary, search_text, mood_text, updated_at
      )
      WITH target_media AS (
        SELECT media_item_id
        FROM (${catalogSearchEligibleMediaIdsSql}) eligible_media
        ${targetClause}
      ),
      active_rank AS (
        SELECT s.media_item_id, MAX(s.mainstream_score * s.metadata_confidence) AS rank_score
        FROM catalog_rank_signals s
        JOIN target_media target ON target.media_item_id = s.media_item_id
        JOIN catalog_source_records r ON r.media_item_id = s.media_item_id AND r.source = s.source
        WHERE r.active = 1
        GROUP BY s.media_item_id
      ),
      active_catalog_records AS (
        SELECT
          r.media_item_id,
          r.source,
          r.source_item_id,
          CASE
            WHEN json_valid(r.metadata_json) AND json_type(r.metadata_json) = 'object' THEN r.metadata_json
            ELSE '{}'
          END AS metadata_json,
          s.mainstream_score,
          s.sitelink_count,
          s.award_count
        FROM catalog_source_records r
        JOIN target_media target ON target.media_item_id = r.media_item_id
        LEFT JOIN catalog_rank_signals s ON s.media_item_id = r.media_item_id AND s.source = r.source
        WHERE r.active = 1
      ),
      allowlisted_catalog_values AS (
        SELECT
          r.media_item_id,
          'alias' AS kind,
          1 AS kind_order,
          r.source,
          r.source_item_id,
          CAST(metadata_value.key AS INTEGER) AS value_position,
          trim(CAST(metadata_value.value AS TEXT)) AS term
        FROM active_catalog_records r
        JOIN json_each(
          CASE WHEN json_type(r.metadata_json, '$.aliases') = 'array' THEN r.metadata_json ELSE '{}' END,
          '$.aliases'
        ) metadata_value
        WHERE metadata_value.type IN ('text', 'integer', 'real') AND trim(CAST(metadata_value.value AS TEXT)) != ''
        UNION ALL
        SELECT
          r.media_item_id,
          'country' AS kind,
          2 AS kind_order,
          r.source,
          r.source_item_id,
          CAST(metadata_value.key AS INTEGER) AS value_position,
          trim(CAST(metadata_value.value AS TEXT)) AS term
        FROM active_catalog_records r
        JOIN json_each(
          CASE WHEN json_type(r.metadata_json, '$.countries') = 'array' THEN r.metadata_json ELSE '{}' END,
          '$.countries'
        ) metadata_value
        WHERE metadata_value.type IN ('text', 'integer', 'real') AND trim(CAST(metadata_value.value AS TEXT)) != ''
        UNION ALL
        SELECT
          r.media_item_id,
          'language' AS kind,
          3 AS kind_order,
          r.source,
          r.source_item_id,
          CAST(metadata_value.key AS INTEGER) AS value_position,
          trim(CAST(metadata_value.value AS TEXT)) AS term
        FROM active_catalog_records r
        JOIN json_each(
          CASE WHEN json_type(r.metadata_json, '$.languages') = 'array' THEN r.metadata_json ELSE '{}' END,
          '$.languages'
        ) metadata_value
        WHERE metadata_value.type IN ('text', 'integer', 'real') AND trim(CAST(metadata_value.value AS TEXT)) != ''
        UNION ALL
        SELECT
          r.media_item_id,
          'franchise' AS kind,
          4 AS kind_order,
          r.source,
          r.source_item_id,
          CAST(metadata_value.key AS INTEGER) AS value_position,
          trim(CAST(metadata_value.value AS TEXT)) AS term
        FROM active_catalog_records r
        JOIN json_each(
          CASE WHEN json_type(r.metadata_json, '$.franchises') = 'array' THEN r.metadata_json ELSE '{}' END,
          '$.franchises'
        ) metadata_value
        WHERE metadata_value.type IN ('text', 'integer', 'real') AND trim(CAST(metadata_value.value AS TEXT)) != ''
      ),
      first_catalog_values AS (
        SELECT media_item_id, kind, kind_order, source, source_item_id, value_position, term
        FROM (
          SELECT
            media_item_id,
            kind,
            kind_order,
            source,
            source_item_id,
            value_position,
            term,
            ROW_NUMBER() OVER (
              PARTITION BY media_item_id, kind, term
              ORDER BY source, source_item_id, value_position
            ) AS occurrence_position
          FROM allowlisted_catalog_values
        )
        WHERE occurrence_position = 1
      ),
      bounded_catalog_values AS (
        SELECT media_item_id, kind, kind_order, term, term_position
        FROM (
          SELECT
            media_item_id,
            kind,
            kind_order,
            term,
            ROW_NUMBER() OVER (
              PARTITION BY media_item_id, kind
              ORDER BY source, source_item_id, value_position, term
            ) AS term_position
          FROM first_catalog_values
        )
        WHERE term_position <= CASE WHEN kind = 'franchise' THEN 8 ELSE 12 END
      ),
      catalog_metadata_terms AS (
        SELECT
          media_item_id,
          GROUP_CONCAT(CASE WHEN kind = 'alias' THEN term END, ' ') AS aliases_text,
          GROUP_CONCAT(CASE WHEN kind = 'country' THEN term END, ' ') AS countries_text,
          GROUP_CONCAT(CASE WHEN kind = 'language' THEN term END, ' ') AS languages_text,
          GROUP_CONCAT(CASE WHEN kind = 'franchise' THEN term END, ' ') AS franchises_text,
          MAX(CASE WHEN kind = 'franchise' THEN 1 ELSE 0 END) AS has_franchise
        FROM (
          SELECT media_item_id, kind, kind_order, term, term_position
          FROM bounded_catalog_values
          ORDER BY media_item_id, kind_order, term_position
        )
        GROUP BY media_item_id
      ),
      catalog_source_terms AS (
        SELECT media_item_id, GROUP_CONCAT(source, ' ') AS source_text
        FROM (
          SELECT DISTINCT media_item_id, source
          FROM active_catalog_records
          ORDER BY media_item_id, source
        )
        GROUP BY media_item_id
      ),
      catalog_geographic_mood_terms AS (
        SELECT media_item_id, GROUP_CONCAT(mood_term, ' ') AS mood_text
        FROM (
          SELECT
            media_item_id,
            kind_order,
            term_position,
            kind || '-' || replace(moodarr_normalize_title(term), ' ', '-') AS mood_term
          FROM bounded_catalog_values
          WHERE kind IN ('country', 'language') AND moodarr_normalize_title(term) != ''
          ORDER BY media_item_id, kind_order, term_position
        )
        GROUP BY media_item_id
      ),
      catalog_terms AS (
        SELECT
          r.media_item_id,
          MAX(r.mainstream_score) AS mainstream_score,
          MAX(r.sitelink_count) AS sitelink_count,
          MAX(r.award_count) AS award_count,
          MAX(CASE WHEN json_type(r.metadata_json, '$."has english wikipedia"') = 'true' THEN 1 ELSE 0 END) AS has_english_wikipedia
        FROM active_catalog_records r
        GROUP BY r.media_item_id
      ),
      feature_mood_values AS (
        SELECT f.media_item_id, 1 AS kind_order, CAST(value.key AS INTEGER) AS term_position, CAST(value.value AS TEXT) AS term
        FROM media_features f
        JOIN target_media target ON target.media_item_id = f.media_item_id
        JOIN json_each(
          CASE WHEN json_valid(f.mood_terms_json) AND json_type(f.mood_terms_json) = 'array' THEN f.mood_terms_json ELSE '[]' END
        ) value
        WHERE value.type = 'text'
        UNION ALL
        SELECT f.media_item_id, 2 AS kind_order, CAST(value.key AS INTEGER) AS term_position, CAST(value.value AS TEXT) AS term
        FROM media_features f
        JOIN target_media target ON target.media_item_id = f.media_item_id
        JOIN json_each(
          CASE WHEN json_valid(f.tone_terms_json) AND json_type(f.tone_terms_json) = 'array' THEN f.tone_terms_json ELSE '[]' END
        ) value
        WHERE value.type = 'text'
        UNION ALL
        SELECT f.media_item_id, 3 AS kind_order, CAST(value.key AS INTEGER) AS term_position, CAST(value.value AS TEXT) AS term
        FROM media_features f
        JOIN target_media target ON target.media_item_id = f.media_item_id
        JOIN json_each(
          CASE WHEN json_valid(f.watchability_terms_json) AND json_type(f.watchability_terms_json) = 'array' THEN f.watchability_terms_json ELSE '[]' END
        ) value
        WHERE value.type = 'text'
      ),
      feature_mood_terms AS (
        SELECT media_item_id, GROUP_CONCAT(term, ' ') AS mood_text
        FROM (
          SELECT media_item_id, kind_order, term_position, term
          FROM feature_mood_values
          ORDER BY media_item_id, kind_order, term_position
        )
        GROUP BY media_item_id
      ),
      genre_terms AS (
        SELECT media_item_id, GROUP_CONCAT(name, ' ') AS genre_text
        FROM (
          SELECT genres.media_item_id, genres.name
          FROM genres
          JOIN target_media target ON target.media_item_id = genres.media_item_id
          ORDER BY genres.media_item_id, genres.name
        )
        GROUP BY media_item_id
      ),
      cast_terms AS (
        SELECT media_item_id, GROUP_CONCAT(name, ' ') AS cast_text
        FROM (
          SELECT people.media_item_id, people.name
          FROM people
          JOIN target_media target ON target.media_item_id = people.media_item_id
          WHERE people.role = 'cast'
          ORDER BY people.media_item_id, people.name
        )
        GROUP BY media_item_id
      ),
      director_terms AS (
        SELECT media_item_id, GROUP_CONCAT(name, ' ') AS director_text
        FROM (
          SELECT people.media_item_id, people.name
          FROM people
          JOIN target_media target ON target.media_item_id = people.media_item_id
          WHERE people.role = 'director'
          ORDER BY people.media_item_id, people.name
        )
        GROUP BY media_item_id
      ),
      plex_status AS (
        SELECT plex_items.media_item_id, MAX(plex_items.available) AS available
        FROM plex_items
        JOIN target_media target ON target.media_item_id = plex_items.media_item_id
        GROUP BY plex_items.media_item_id
      ),
      seerr_status AS (
        SELECT
          seerr_items.media_item_id,
          MAX(seerr_items.requestable) AS requestable,
          MAX(CASE WHEN seerr_items.status = 'partially_available' THEN 1 ELSE 0 END) AS partially_available,
          MAX(CASE WHEN seerr_items.request_status IS NOT NULL OR seerr_items.status IN ('requested', 'pending', 'approved', 'processing') THEN 1 ELSE 0 END) AS already_requested,
          COUNT(*) AS seerr_count
        FROM seerr_items
        JOIN target_media target ON target.media_item_id = seerr_items.media_item_id
        GROUP BY seerr_items.media_item_id
      ),
      quarantine_status AS (
        SELECT quarantine.media_item_id
        FROM media_identity_quarantine quarantine
        JOIN target_media target ON target.media_item_id = quarantine.media_item_id
      )
      SELECT
        m.id,
        m.title,
        m.media_type,
        m.year,
        m.source,
        COALESCE(active_rank.rank_score, 0),
        CASE
          WHEN quarantine_status.media_item_id IS NOT NULL THEN 'unavailable'
          WHEN COALESCE(plex_status.available, 0) = 1 THEN 'available_in_plex'
          WHEN COALESCE(seerr_status.partially_available, 0) = 1 THEN 'partially_available'
          WHEN COALESCE(seerr_status.already_requested, 0) = 1 THEN 'already_requested'
          WHEN COALESCE(seerr_status.requestable, 0) = 1 THEN 'not_in_plex_requestable'
          ELSE 'unavailable'
        END,
        COALESCE(plex_status.available, 0),
        COALESCE(seerr_status.requestable, 0),
        CASE WHEN COALESCE(seerr_status.seerr_count, 0) > 0 THEN 1 ELSE 0 END,
        CASE WHEN m.summary IS NOT NULL AND trim(m.summary) != '' THEN 1 ELSE 0 END,
        trim(
          COALESCE(m.title, '') || ' ' ||
          CASE WHEN trim(COALESCE(m.summary, '')) != '' THEN m.summary || ' ' ELSE '' END ||
          CASE WHEN trim(COALESCE(f.feature_text, '')) != '' THEN f.feature_text || ' ' ELSE '' END ||
          CASE WHEN trim(COALESCE(catalog_source_terms.source_text, '')) != '' THEN catalog_source_terms.source_text || ' ' ELSE '' END ||
          CASE WHEN trim(COALESCE(catalog_metadata_terms.aliases_text, '')) != '' THEN catalog_metadata_terms.aliases_text || ' ' ELSE '' END ||
          CASE WHEN trim(COALESCE(catalog_metadata_terms.countries_text, '')) != '' THEN catalog_metadata_terms.countries_text || ' ' ELSE '' END ||
          CASE WHEN trim(COALESCE(catalog_metadata_terms.languages_text, '')) != '' THEN catalog_metadata_terms.languages_text || ' ' ELSE '' END ||
          CASE WHEN trim(COALESCE(catalog_metadata_terms.franchises_text, '')) != '' THEN catalog_metadata_terms.franchises_text || ' ' ELSE '' END ||
          CASE WHEN COALESCE(catalog_terms.mainstream_score, 0) >= 76 THEN 'mainstream friendly popular recognizable ' ELSE '' END ||
          CASE WHEN COALESCE(catalog_terms.sitelink_count, 0) >= 80 THEN 'well known ' ELSE '' END ||
          CASE WHEN COALESCE(catalog_terms.award_count, 0) >= 2 THEN 'award recognized acclaimed ' ELSE '' END ||
          CASE WHEN COALESCE(catalog_terms.has_english_wikipedia, 0) = 1 THEN 'english wikipedia ' ELSE '' END ||
          CASE WHEN trim(COALESCE(genre_terms.genre_text, '')) != '' THEN genre_terms.genre_text || ' ' ELSE '' END ||
          CASE WHEN trim(COALESCE(cast_terms.cast_text, '')) != '' THEN cast_terms.cast_text || ' ' ELSE '' END ||
          COALESCE(director_terms.director_text, '')
        ),
        trim(
          CASE WHEN trim(COALESCE(feature_mood_terms.mood_text, '')) != '' THEN feature_mood_terms.mood_text || ' ' ELSE '' END ||
          CASE WHEN COALESCE(catalog_terms.mainstream_score, 0) >= 76 THEN 'mainstream-friendly ' ELSE '' END ||
          CASE WHEN COALESCE(catalog_terms.mainstream_score, 0) >= 52 THEN 'recognizable ' ELSE '' END ||
          CASE WHEN COALESCE(catalog_terms.award_count, 0) >= 2 THEN 'award-recognized ' ELSE '' END ||
          CASE WHEN COALESCE(catalog_metadata_terms.has_franchise, 0) = 1 THEN 'franchise-entry familiar-world ' ELSE '' END ||
          COALESCE(catalog_geographic_mood_terms.mood_text, '')
        ),
        ?
      FROM media_items m
      JOIN target_media target ON target.media_item_id = m.id
      LEFT JOIN media_features f ON f.media_item_id = m.id
      LEFT JOIN active_rank ON active_rank.media_item_id = m.id
      LEFT JOIN catalog_terms ON catalog_terms.media_item_id = m.id
      LEFT JOIN catalog_metadata_terms ON catalog_metadata_terms.media_item_id = m.id
      LEFT JOIN catalog_source_terms ON catalog_source_terms.media_item_id = m.id
      LEFT JOIN catalog_geographic_mood_terms ON catalog_geographic_mood_terms.media_item_id = m.id
      LEFT JOIN feature_mood_terms ON feature_mood_terms.media_item_id = m.id
      LEFT JOIN genre_terms ON genre_terms.media_item_id = m.id
      LEFT JOIN cast_terms ON cast_terms.media_item_id = m.id
      LEFT JOIN director_terms ON director_terms.media_item_id = m.id
      LEFT JOIN plex_status ON plex_status.media_item_id = m.id
      LEFT JOIN seerr_status ON seerr_status.media_item_id = m.id
      LEFT JOIN quarantine_status ON quarantine_status.media_item_id = m.id
      `
    )
    .run(...(mediaItemIds ?? []), updatedAt);

  if (targeted) {
    const placeholders = mediaItemIds.map(() => "?").join(", ");
    db
      .prepare(
        `INSERT INTO catalog_search_index_fts (media_item_id, title, search_text, mood_text)
         SELECT media_item_id, title, search_text, mood_text
         FROM catalog_search_index
         WHERE media_item_id IN (${placeholders})`
      )
      .run(...mediaItemIds);
  } else {
    db
      .prepare(
        `INSERT INTO catalog_search_index_fts (media_item_id, title, search_text, mood_text)
         SELECT media_item_id, title, search_text, mood_text
         FROM catalog_search_index`
      )
      .run();
  }
}
