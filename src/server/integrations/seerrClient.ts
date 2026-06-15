import type { AppConfig } from "../config";
import type { IngestMediaRecord } from "../db/mediaRepository";
import { fixtureSeerrItems } from "../fixtures/media";
import { safeErrorMessage } from "../security/redact";

interface SeerrSearchResult {
  id?: number;
  mediaId?: number;
  mediaType?: "movie" | "tv" | "person";
  title?: string;
  name?: string;
  releaseDate?: string;
  firstAirDate?: string;
  overview?: string;
  runtime?: number;
  posterPath?: string;
  genreIds?: number[];
  genres?: { name: string }[];
  mediaInfo?: {
    id?: number;
    status?: number | string;
    requests?: { status?: number | string }[];
  };
  imdbId?: string;
  tvdbId?: number;
}

interface SeerrDetails {
  title?: string;
  name?: string;
  releaseDate?: string;
  firstAirDate?: string;
  overview?: string;
  runtime?: number;
  episodeRunTime?: number[];
  posterPath?: string;
  genres?: { name?: string }[];
  imdbId?: string;
  externalIds?: {
    imdbId?: string;
    tvdbId?: number;
  };
  mediaInfo?: {
    id?: number;
    status?: number | string;
    requests?: { status?: number | string }[];
  };
}

interface SeerrRequest {
  id?: number;
  status?: string | number;
  media?: {
    id?: number;
    tmdbId?: number;
    tvdbId?: number;
    imdbId?: string;
    mediaType?: "movie" | "tv";
    status?: string | number;
  };
  requestedBy?: unknown;
}

interface SeerrPage<T> {
  pageInfo?: {
    results?: number;
  };
  results?: T[];
}

const statusByNumber: Record<number, string> = {
  1: "unknown",
  2: "pending",
  3: "processing",
  4: "partially_available",
  5: "available"
};

const requestStatusByNumber: Record<number, string> = {
  1: "pending",
  2: "approved",
  3: "declined",
  4: "available"
};

const tmdbGenreById: Record<number, string> = {
  12: "Adventure",
  14: "Fantasy",
  16: "Animation",
  18: "Drama",
  27: "Horror",
  28: "Action",
  35: "Comedy",
  36: "History",
  37: "Western",
  53: "Thriller",
  80: "Crime",
  99: "Documentary",
  878: "Science Fiction",
  9648: "Mystery",
  10402: "Music",
  10749: "Romance",
  10751: "Family",
  10752: "War",
  10759: "Action & Adventure",
  10762: "Kids",
  10763: "News",
  10764: "Reality",
  10765: "Sci-Fi & Fantasy",
  10766: "Soap",
  10767: "Talk",
  10768: "War & Politics",
  10770: "TV Movie"
};

export class SeerrClient {
  constructor(private readonly config: AppConfig) {}

  async testConnection(credentials?: { baseUrl?: string; apiKey?: string }) {
    if (this.config.fixtureMode && !credentials?.baseUrl && !credentials?.apiKey) {
      return { ok: true, mode: "fixture", message: "Fixture Seerr connection ready." };
    }

    const baseUrl = credentials?.baseUrl ?? this.config.seerr.baseUrl;
    const apiKey = credentials?.apiKey ?? this.config.seerr.apiKey;
    if (!baseUrl || !apiKey) {
      return { ok: false, mode: "unconfigured", message: "Seerr base URL and API key are required." };
    }

    try {
      const response = await fetch(`${trimSlash(baseUrl)}/api/v1/status`, {
        headers: { Accept: "application/json", "X-Api-Key": apiKey }
      });
      if (!response.ok) {
        return { ok: false, mode: "live", message: `Seerr returned HTTP ${response.status}.` };
      }
      return { ok: true, mode: "live", message: "Seerr connection succeeded." };
    } catch (error) {
      return { ok: false, mode: "live", message: safeErrorMessage(error, [apiKey]) };
    }
  }

  async syncRequests(): Promise<IngestMediaRecord[]> {
    if (this.config.fixtureMode) return fixtureSeerrItems.map((item) => ({ ...item, source: "fixture" as const }));

    const rows = await this.fetchRequestPages();
    const records = rows.flatMap((request) => {
      const media = request.media;
      if (!media?.mediaType || !media.tmdbId) return [];
      return [
        {
          mediaType: media.mediaType,
          title: `${media.mediaType === "movie" ? "Movie" : "TV"} ${media.tmdbId}`,
          externalIds: {
            tmdb: media.tmdbId,
            tvdb: media.tvdbId,
            imdb: media.imdbId
          },
          seerr: {
            tmdbId: media.tmdbId,
            tvdbId: media.tvdbId,
            imdbId: media.imdbId,
            seerrMediaId: media.id,
            status: normalizeSeerrStatus(media.status),
            requestStatus: normalizeRequestStatus(request.status),
            requestable: normalizeSeerrStatus(media.status) !== "available",
            url: this.mediaUrl(media.mediaType, media.tmdbId)
          }
        } satisfies IngestMediaRecord
      ];
    });
    return this.enrichRecords(records);
  }

  async search(query: string): Promise<IngestMediaRecord[]> {
    if (this.config.fixtureMode) {
      const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
      return fixtureSeerrItems.filter((item) => {
        const haystack = `${item.title} ${item.summary ?? ""} ${(item.genres ?? []).join(" ")}`.toLowerCase();
        return terms.some((term) => haystack.includes(term));
      }).map((item) => ({ ...item, source: "fixture" as const }));
    }

    const data = await this.fetchJson<{ results?: SeerrSearchResult[] }>(`/api/v1/search?query=${encodeURIComponent(query)}`);
    const records = (data.results ?? [])
      .filter((result) => result.mediaType === "movie" || result.mediaType === "tv")
      .map((result) => this.mapSearchResult(result));
    return Promise.all(records.map((record) => this.enrichWithDetails(record)));
  }

  async createRequest(input: { mediaType: "movie" | "tv"; mediaId: number; seasons?: number[] }) {
    if (this.config.fixtureMode) {
      return { id: `fixture-request-${input.mediaType}-${input.mediaId}`, status: "created_fixture_request" };
    }

    const body = {
      mediaType: input.mediaType,
      mediaId: input.mediaId,
      ...(input.mediaType === "tv" && input.seasons?.length ? { seasons: input.seasons } : {})
    };

    return this.fetchJson<{ id?: number; status?: string | number }>("/api/v1/request", {
      method: "POST",
      body: JSON.stringify(body)
    });
  }

  private mapSearchResult(result: SeerrSearchResult): IngestMediaRecord {
    const mediaType = result.mediaType === "tv" ? "tv" : "movie";
    const title = result.title ?? result.name ?? `${mediaType} ${result.id}`;
    const yearSource = result.releaseDate ?? result.firstAirDate;
    const status = normalizeSeerrStatus(result.mediaInfo?.status);
    const requestStatus = normalizeRequestStatus(result.mediaInfo?.requests?.[0]?.status);
    const tmdbId = result.id ?? result.mediaId;

    return {
      mediaType,
      title,
      year: yearSource ? Number(yearSource.slice(0, 4)) : undefined,
      summary: result.overview,
      runtimeMinutes: result.runtime,
      posterPath: result.posterPath ? `tmdb://w500${result.posterPath}` : undefined,
      genres: mapSearchGenres(result.genres, result.genreIds),
      externalIds: {
        tmdb: tmdbId,
        tvdb: result.tvdbId,
        imdb: result.imdbId
      },
      seerr: {
        tmdbId,
        tvdbId: result.tvdbId,
        imdbId: result.imdbId,
        seerrMediaId: result.mediaInfo?.id,
        status,
        requestStatus,
        requestable: status !== "available" && requestStatus !== "pending" && requestStatus !== "approved",
        url: tmdbId ? this.mediaUrl(mediaType, tmdbId) : undefined
      }
    };
  }

  private async enrichWithDetails(record: IngestMediaRecord): Promise<IngestMediaRecord> {
    const tmdbId = record.seerr?.tmdbId;
    if (!tmdbId) return record;

    try {
      const details = await this.fetchJson<SeerrDetails>(`/api/v1/${record.mediaType === "movie" ? "movie" : "tv"}/${tmdbId}`);
      const detailGenres = mapDetailGenres(details.genres);
      const runtimeMinutes = record.mediaType === "movie" ? details.runtime : firstRuntime(details.episodeRunTime) ?? details.runtime;
      const yearSource = details.releaseDate ?? details.firstAirDate;
      const imdbId = details.imdbId ?? details.externalIds?.imdbId ?? stringExternalId(record.externalIds?.imdb);
      const tvdbId = details.externalIds?.tvdbId ?? record.seerr?.tvdbId;
      const status = record.seerr ? (details.mediaInfo?.status !== undefined ? normalizeSeerrStatus(details.mediaInfo.status) : record.seerr.status) : undefined;
      const requestStatus = record.seerr
        ? details.mediaInfo?.requests?.[0]?.status !== undefined
          ? normalizeRequestStatus(details.mediaInfo.requests[0].status)
          : record.seerr.requestStatus
        : undefined;
      return {
        ...record,
        title: details.title ?? details.name ?? record.title,
        year: yearSource ? Number(yearSource.slice(0, 4)) : record.year,
        summary: details.overview ?? record.summary,
        runtimeMinutes: runtimeMinutes ?? record.runtimeMinutes,
        posterPath: details.posterPath ? `tmdb://w500${details.posterPath}` : record.posterPath,
        genres: detailGenres ?? record.genres,
        externalIds: {
          ...record.externalIds,
          imdb: imdbId,
          tvdb: tvdbId
        },
        seerr: record.seerr
          ? {
              ...record.seerr,
              imdbId,
              tvdbId,
              seerrMediaId: details.mediaInfo?.id ?? record.seerr.seerrMediaId,
              status: status ?? record.seerr.status,
              requestStatus,
              requestable: status ? status !== "available" && requestStatus !== "pending" && requestStatus !== "approved" : record.seerr.requestable,
              url: tmdbId ? this.mediaUrl(record.mediaType, tmdbId) : record.seerr.url
            }
          : record.seerr
      };
    } catch {
      return record;
    }
  }

  private async fetchRequestPages() {
    const pageSize = 100;
    const rows: SeerrRequest[] = [];

    for (let skip = 0; ; ) {
      const data = await this.fetchJson<SeerrPage<SeerrRequest> | SeerrRequest[]>(`/api/v1/request?take=${pageSize}&skip=${skip}`);
      if (Array.isArray(data)) return data;

      const pageRows = data.results ?? [];
      rows.push(...pageRows);

      const total = data.pageInfo?.results;
      if (pageRows.length === 0 || (total !== undefined && rows.length >= total) || (total === undefined && pageRows.length < pageSize)) {
        return rows;
      }

      skip += pageRows.length;
    }
  }

  private async enrichRecords(records: IngestMediaRecord[]) {
    const chunkSize = 10;
    const enriched: IngestMediaRecord[] = [];
    for (let index = 0; index < records.length; index += chunkSize) {
      enriched.push(...(await Promise.all(records.slice(index, index + chunkSize).map((record) => this.enrichWithDetails(record)))));
    }
    return enriched;
  }

  private async fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const baseUrl = this.config.seerr.baseUrl;
    const apiKey = this.config.seerr.apiKey;
    if (!baseUrl || !apiKey) throw new Error("Seerr is not configured.");
    const response = await fetch(`${trimSlash(baseUrl)}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(12_000),
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-Api-Key": apiKey,
        ...init.headers
      }
    });
    if (!response.ok) throw new Error(`Seerr request returned HTTP ${response.status}.`);
    return (await response.json()) as T;
  }

  private mediaUrl(mediaType: "movie" | "tv", tmdbId: number) {
    const baseUrl = this.config.seerr.baseUrl;
    return baseUrl ? `${trimSlash(baseUrl)}/${mediaType}/${tmdbId}` : undefined;
  }
}

function normalizeSeerrStatus(value: string | number | undefined): "unknown" | "available" | "partially_available" | "requested" | "pending" | "approved" | "declined" | "processing" {
  if (typeof value === "number") return (statusByNumber[value] ?? "unknown") as ReturnType<typeof normalizeSeerrStatus>;
  const normalized = String(value ?? "unknown").toLowerCase().replaceAll(" ", "_");
  if (normalized === "blacklisted") return "declined";
  if (["unknown", "available", "partially_available", "requested", "pending", "approved", "declined", "processing"].includes(normalized)) {
    return normalized as ReturnType<typeof normalizeSeerrStatus>;
  }
  return "unknown";
}

function normalizeRequestStatus(value: string | number | undefined) {
  if (typeof value === "number") return requestStatusByNumber[value] ?? String(value);
  return value ? String(value).toLowerCase().replaceAll(" ", "_") : undefined;
}

function mapDetailGenres(genres: SeerrDetails["genres"]) {
  const values = genres?.map((genre) => genre.name?.trim()).filter((value): value is string => Boolean(value));
  return values?.length ? values : undefined;
}

function mapSearchGenres(genres: SeerrSearchResult["genres"], genreIds: number[] | undefined) {
  const values = genres?.map((genre) => genre.name?.trim()).filter((value): value is string => Boolean(value)) ?? [];
  for (const genreId of genreIds ?? []) {
    const name = tmdbGenreById[genreId];
    if (name) values.push(name);
  }
  const unique = [...new Set(values)];
  return unique.length ? unique : undefined;
}

function firstRuntime(values: number[] | undefined) {
  return values?.find((value) => Number.isFinite(value) && value > 0);
}

function stringExternalId(value: string | number | undefined) {
  return value === undefined ? undefined : String(value);
}

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}
