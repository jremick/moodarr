import crypto from "node:crypto";
import type { AvailabilityGroup, ItemDetail, ItemSummary, MediaType, RatingSet, SeerrStatus } from "../../shared/types";
import type { SqliteDatabase } from "./database";

export interface IngestMediaRecord {
  mediaType: MediaType;
  title: string;
  year?: number;
  summary?: string;
  runtimeMinutes?: number;
  contentRating?: string;
  posterPath?: string;
  ratings?: RatingSet;
  genres?: string[];
  cast?: string[];
  directors?: string[];
  externalIds?: Record<string, string | number | undefined>;
  plex?: {
    ratingKey?: string;
    guid?: string;
    libraryTitle?: string;
    libraryType?: string;
    url?: string;
    available?: boolean;
  };
  seerr?: {
    tmdbId?: number;
    tvdbId?: number;
    imdbId?: string;
    seerrMediaId?: number;
    status: SeerrStatus;
    requestStatus?: string;
    requestable: boolean;
    url?: string;
  };
}

interface MediaRow {
  id: string;
  media_type: MediaType;
  title: string;
  year?: number;
  summary?: string;
  runtime_minutes?: number;
  content_rating?: string;
  poster_path?: string;
  critic_rating?: number;
  audience_rating?: number;
  user_rating?: number;
}

interface PlexRow {
  available: number;
  plex_url?: string;
  library_title?: string;
}

interface SeerrRow {
  status: SeerrStatus;
  request_status?: string;
  requestable: number;
  seerr_url?: string;
  tmdb_id?: number;
}

export class MediaRepository {
  constructor(private readonly db: SqliteDatabase) {}

  upsertMany(records: IngestMediaRecord[]) {
    this.db.exec("BEGIN");
    try {
      for (const record of records) {
        this.upsert(record);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  upsert(record: IngestMediaRecord): string {
    const now = new Date().toISOString();
    const normalizedTitle = normalizeTitle(record.title);
    const externalIds = cleanExternalIds(record.externalIds);
    if (record.seerr?.tmdbId) externalIds.tmdb = String(record.seerr.tmdbId);
    if (record.seerr?.tvdbId) externalIds.tvdb = String(record.seerr.tvdbId);
    if (record.seerr?.imdbId) externalIds.imdb = record.seerr.imdbId;
    if (record.plex?.guid) externalIds.plex = record.plex.guid;

    const existingId = this.findExistingId(record.mediaType, normalizedTitle, record.year, externalIds);
    const id = existingId ?? makeMediaId(record.mediaType, normalizedTitle, record.year, externalIds);

    this.db
      .prepare(
        `INSERT INTO media_items (
          id, media_type, title, normalized_title, year, summary, runtime_minutes, content_rating,
          poster_path, critic_rating, audience_rating, user_rating, created_at, updated_at
        ) VALUES (
          @id, @mediaType, @title, @normalizedTitle, @year, @summary, @runtimeMinutes, @contentRating,
          @posterPath, @criticRating, @audienceRating, @userRating, @now, @now
        )
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          normalized_title = excluded.normalized_title,
          year = COALESCE(excluded.year, media_items.year),
          summary = COALESCE(excluded.summary, media_items.summary),
          runtime_minutes = COALESCE(excluded.runtime_minutes, media_items.runtime_minutes),
          content_rating = COALESCE(excluded.content_rating, media_items.content_rating),
          poster_path = COALESCE(excluded.poster_path, media_items.poster_path),
          critic_rating = COALESCE(excluded.critic_rating, media_items.critic_rating),
          audience_rating = COALESCE(excluded.audience_rating, media_items.audience_rating),
          user_rating = COALESCE(excluded.user_rating, media_items.user_rating),
          updated_at = excluded.updated_at`
      )
      .run({
        id,
        mediaType: record.mediaType,
        title: record.title,
        normalizedTitle,
        year: record.year ?? null,
        summary: record.summary ?? null,
        runtimeMinutes: record.runtimeMinutes ?? null,
        contentRating: record.contentRating ?? null,
        posterPath: record.posterPath ?? null,
        criticRating: record.ratings?.critic ?? null,
        audienceRating: record.ratings?.audience ?? null,
        userRating: record.ratings?.user ?? null,
        now
      });

    this.replaceList("genres", id, record.genres ?? []);
    this.replacePeople(id, record.cast ?? [], "cast");
    this.replacePeople(id, record.directors ?? [], "director");
    this.upsertExternalIds(id, externalIds);
    if (record.plex) this.upsertPlex(id, record.plex, now);
    if (record.seerr) this.upsertSeerr(id, record.mediaType, record.seerr, now);
    return id;
  }

  list(): ItemDetail[] {
    const rows = this.db.prepare("SELECT * FROM media_items ORDER BY title").all() as unknown as MediaRow[];
    return rows.map((row) => this.inflate(row));
  }

  findById(id: string): ItemDetail | undefined {
    const row = this.db.prepare("SELECT * FROM media_items WHERE id = ?").get(id) as MediaRow | undefined;
    return row ? this.inflate(row) : undefined;
  }

  getPosterPath(id: string): string | undefined {
    const row = this.db.prepare("SELECT poster_path FROM media_items WHERE id = ?").get(id) as { poster_path?: string } | undefined;
    return row?.poster_path;
  }

  saveRequest(mediaItemId: string, mediaType: MediaType, mediaId: number, seasons: number[] | undefined, status: string, externalRequestId?: string) {
    this.db
      .prepare(
        `INSERT INTO requests (media_item_id, media_type, media_id, seasons_json, status, external_request_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(mediaItemId, mediaType, mediaId, seasons ? JSON.stringify(seasons) : null, status, externalRequestId ?? null, new Date().toISOString());
  }

  recordSync(kind: "library" | "seerr", source: string, status: string, itemCount: number, error?: string) {
    const table = kind === "library" ? "library_sync_runs" : "seerr_sync_runs";
    const now = new Date().toISOString();
    this.db
      .prepare(`INSERT INTO ${table} (source, status, started_at, finished_at, item_count, error) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(source, status, now, now, itemCount, error ?? null);
  }

  recordSearch(query: string, resultCount: number, usedAi: boolean) {
    const hash = crypto.createHash("sha256").update(query.toLowerCase().trim()).digest("hex");
    this.db
      .prepare("INSERT INTO search_events (query_hash, result_count, used_ai, created_at) VALUES (?, ?, ?, ?)")
      .run(hash, resultCount, usedAi ? 1 : 0, new Date().toISOString());
  }

  stats() {
    const one = <T>(sql: string) => (this.db.prepare(sql).get() as { value: T }).value;
    const lastLibrarySync = this.lastSync("library_sync_runs");
    const lastSeerrSync = this.lastSync("seerr_sync_runs");
    return {
      totalItems: one<number>("SELECT COUNT(*) AS value FROM media_items"),
      plexItems: one<number>("SELECT COUNT(*) AS value FROM plex_items WHERE available = 1"),
      seerrItems: one<number>("SELECT COUNT(*) AS value FROM seerr_items"),
      movies: one<number>("SELECT COUNT(*) AS value FROM media_items WHERE media_type = 'movie'"),
      tv: one<number>("SELECT COUNT(*) AS value FROM media_items WHERE media_type = 'tv'"),
      availableInPlex: one<number>("SELECT COUNT(*) AS value FROM plex_items WHERE available = 1"),
      requestable: one<number>("SELECT COUNT(*) AS value FROM seerr_items WHERE requestable = 1"),
      alreadyRequested: one<number>("SELECT COUNT(*) AS value FROM seerr_items WHERE request_status IS NOT NULL AND request_status != ''"),
      partiallyAvailable: one<number>("SELECT COUNT(*) AS value FROM seerr_items WHERE status = 'partially_available'"),
      lastLibrarySync,
      lastSeerrSync
    };
  }

  private findExistingId(mediaType: MediaType, normalizedTitle: string, year: number | undefined, externalIds: Record<string, string>) {
    for (const [source, value] of Object.entries(externalIds)) {
      const row = this.db.prepare("SELECT media_item_id FROM external_ids WHERE source = ? AND value = ?").get(source, value) as
        | { media_item_id: string }
        | undefined;
      if (row) return row.media_item_id;
    }

    const row = this.db
      .prepare("SELECT id FROM media_items WHERE media_type = ? AND normalized_title = ? AND COALESCE(year, 0) = COALESCE(?, 0)")
      .get(mediaType, normalizedTitle, year ?? null) as { id: string } | undefined;
    return row?.id;
  }

  private replaceList(table: "genres", mediaItemId: string, values: string[]) {
    this.db.prepare(`DELETE FROM ${table} WHERE media_item_id = ?`).run(mediaItemId);
    const insert = this.db.prepare(`INSERT OR IGNORE INTO ${table} (media_item_id, name) VALUES (?, ?)`);
    for (const value of unique(values)) {
      insert.run(mediaItemId, value);
    }
  }

  private replacePeople(mediaItemId: string, values: string[], role: "cast" | "director") {
    this.db.prepare("DELETE FROM people WHERE media_item_id = ? AND role = ?").run(mediaItemId, role);
    const insert = this.db.prepare("INSERT OR IGNORE INTO people (media_item_id, name, role) VALUES (?, ?, ?)");
    for (const value of unique(values)) {
      insert.run(mediaItemId, value, role);
    }
  }

  private upsertExternalIds(mediaItemId: string, externalIds: Record<string, string>) {
    const insert = this.db.prepare("INSERT OR REPLACE INTO external_ids (media_item_id, source, value) VALUES (?, ?, ?)");
    for (const [source, value] of Object.entries(externalIds)) {
      insert.run(mediaItemId, source, value);
    }
  }

  private upsertPlex(mediaItemId: string, plex: NonNullable<IngestMediaRecord["plex"]>, now: string) {
    const id = `plex:${plex.ratingKey ?? plex.guid ?? mediaItemId}`;
    this.db
      .prepare(
        `INSERT INTO plex_items (id, media_item_id, rating_key, guid, library_title, library_type, plex_url, available, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          media_item_id = excluded.media_item_id,
          rating_key = excluded.rating_key,
          guid = excluded.guid,
          library_title = excluded.library_title,
          library_type = excluded.library_type,
          plex_url = excluded.plex_url,
          available = excluded.available,
          last_seen_at = excluded.last_seen_at`
      )
      .run(
        id,
        mediaItemId,
        plex.ratingKey ?? null,
        plex.guid ?? null,
        plex.libraryTitle ?? null,
        plex.libraryType ?? null,
        plex.url ?? null,
        plex.available === false ? 0 : 1,
        now
      );
  }

  private upsertSeerr(mediaItemId: string, mediaType: MediaType, seerr: NonNullable<IngestMediaRecord["seerr"]>, now: string) {
    const id = `seerr:${seerr.seerrMediaId ?? `${mediaType}:${seerr.tmdbId ?? mediaItemId}`}`;
    this.db
      .prepare(
        `INSERT INTO seerr_items (
          id, media_item_id, tmdb_id, tvdb_id, imdb_id, seerr_media_id, media_type, status, request_status, requestable, seerr_url, last_seen_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          media_item_id = excluded.media_item_id,
          tmdb_id = excluded.tmdb_id,
          tvdb_id = excluded.tvdb_id,
          imdb_id = excluded.imdb_id,
          seerr_media_id = excluded.seerr_media_id,
          status = excluded.status,
          request_status = excluded.request_status,
          requestable = excluded.requestable,
          seerr_url = excluded.seerr_url,
          last_seen_at = excluded.last_seen_at`
      )
      .run(
        id,
        mediaItemId,
        seerr.tmdbId ?? null,
        seerr.tvdbId ?? null,
        seerr.imdbId ?? null,
        seerr.seerrMediaId ?? null,
        mediaType,
        seerr.status,
        seerr.requestStatus ?? null,
        seerr.requestable ? 1 : 0,
        seerr.url ?? null,
        now
      );
  }

  private inflate(row: MediaRow): ItemDetail {
    const id = row.id;
    const genres = (this.db.prepare("SELECT name FROM genres WHERE media_item_id = ? ORDER BY name").all(id) as { name: string }[]).map((entry) => entry.name);
    const cast = (this.db.prepare("SELECT name FROM people WHERE media_item_id = ? AND role = 'cast' ORDER BY name").all(id) as { name: string }[]).map(
      (entry) => entry.name
    );
    const directors = (
      this.db.prepare("SELECT name FROM people WHERE media_item_id = ? AND role = 'director' ORDER BY name").all(id) as { name: string }[]
    ).map((entry) => entry.name);
    const externalIds = Object.fromEntries(
      (this.db.prepare("SELECT source, value FROM external_ids WHERE media_item_id = ?").all(id) as { source: string; value: string }[]).map((entry) => [
        entry.source,
        entry.value
      ])
    );
    const plex = this.db.prepare("SELECT available, plex_url, library_title FROM plex_items WHERE media_item_id = ? LIMIT 1").get(id) as PlexRow | undefined;
    const seerr = this.db.prepare("SELECT status, request_status, requestable, seerr_url, tmdb_id FROM seerr_items WHERE media_item_id = ? LIMIT 1").get(id) as
      | SeerrRow
      | undefined;
    const availabilityGroup = getAvailabilityGroup(plex, seerr);
    const summary: ItemSummary = {
      id,
      mediaType: row.media_type,
      title: row.title,
      year: row.year ?? undefined,
      runtimeMinutes: row.runtime_minutes ?? undefined,
      summary: row.summary ?? undefined,
      genres,
      contentRating: row.content_rating ?? undefined,
      ratings: {
        critic: row.critic_rating ?? undefined,
        audience: row.audience_rating ?? undefined,
        user: row.user_rating ?? undefined
      },
      posterUrl: `/api/items/${encodeURIComponent(id)}/poster`,
      availabilityGroup,
      availabilityExplanation: explainAvailability(plex, seerr),
      matchExplanation: "Matched by local metadata.",
      score: 0,
      plex: plex
        ? {
            available: Boolean(plex.available),
            url: plex.plex_url,
            library: plex.library_title
          }
        : undefined,
      seerr: seerr
        ? {
            status: seerr.status,
            requestStatus: seerr.request_status,
            requestable: Boolean(seerr.requestable),
            url: seerr.seerr_url,
            mediaId: seerr.tmdb_id
          }
        : undefined
    };

    return {
      ...summary,
      cast,
      directors,
      externalIds
    };
  }

  private lastSync(table: "library_sync_runs" | "seerr_sync_runs"): string | undefined {
    const row = this.db.prepare(`SELECT finished_at FROM ${table} WHERE status = 'ok' ORDER BY id DESC LIMIT 1`).get() as
      | { finished_at?: string }
      | undefined;
    return row?.finished_at;
  }
}

export function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function cleanExternalIds(ids: IngestMediaRecord["externalIds"] = {}) {
  return Object.fromEntries(
    Object.entries(ids)
      .filter((entry): entry is [string, string | number] => entry[1] !== undefined && entry[1] !== null && String(entry[1]).trim().length > 0)
      .map(([source, value]) => [source.toLowerCase(), String(value)])
  );
}

function makeMediaId(mediaType: MediaType, normalizedTitle: string, year: number | undefined, externalIds: Record<string, string>) {
  const stableKey = externalIds.tmdb ?? externalIds.imdb ?? externalIds.tvdb ?? externalIds.plex ?? `${normalizedTitle}:${year ?? "unknown"}`;
  return `${mediaType}:${stableKey}`;
}

function unique(values: string[]) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function getAvailabilityGroup(plex: PlexRow | undefined, seerr: SeerrRow | undefined): AvailabilityGroup {
  if (plex?.available) return "available_in_plex";
  if (seerr?.status === "partially_available") return "partially_available";
  if (seerr?.request_status || ["requested", "pending", "approved", "processing"].includes(seerr?.status ?? "")) return "already_requested";
  if (seerr?.requestable) return "not_in_plex_requestable";
  return "unavailable";
}

function explainAvailability(plex: PlexRow | undefined, seerr: SeerrRow | undefined): string {
  if (plex?.available && seerr?.status && seerr.status !== "available") {
    return `Plex reports this as available; Seerr reports ${seerr.status.replaceAll("_", " ")}.`;
  }
  if (plex?.available) return "Available in Plex.";
  if (seerr?.status === "partially_available") return "Seerr reports this as partially available; Plex did not report a full local match.";
  if (seerr?.request_status) return `Not found in Plex. Seerr request status is ${seerr.request_status}.`;
  if (seerr?.requestable) return "Not found in Plex and Seerr reports it can be requested.";
  return "Not found in Plex and no requestable Seerr status is cached.";
}
