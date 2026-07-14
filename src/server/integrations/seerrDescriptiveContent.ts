import type { IngestMediaRecord } from "../db/mediaRepository";
import { normalizeRequestStatus, normalizeSeerrStatus } from "./seerrClient";

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

type FetchJson = <T>(path: string, init?: RequestInit) => Promise<T>;
type MediaUrl = (mediaType: "movie" | "tv", tmdbId: number) => string | undefined;

const maxSearchResults = 24;
const maxSearchDetailEnrichments = 12;
const enrichmentChunkSize = 6;

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

export async function searchSeerrContent(query: string, fetchJson: FetchJson, signal: AbortSignal | undefined, mediaUrl: MediaUrl) {
  const data = await fetchJson<{ results?: SeerrSearchResult[] }>(`/api/v1/search?query=${encodeURIComponent(query)}`, { signal });
  const records = (data.results ?? [])
    .filter((result) => result.mediaType === "movie" || result.mediaType === "tv")
    .slice(0, maxSearchResults)
    .map((result) => mapSearchResult(result, mediaUrl));
  return enrichSeerrRecords(records, fetchJson, signal, mediaUrl, maxSearchDetailEnrichments);
}

export async function enrichSeerrRecords(
  records: IngestMediaRecord[],
  fetchJson: FetchJson,
  signal: AbortSignal | undefined,
  mediaUrl: MediaUrl,
  maximumDetails: number
) {
  const detailRecords = records.slice(0, maximumDetails);
  const enriched: IngestMediaRecord[] = [];
  for (let index = 0; index < detailRecords.length; index += enrichmentChunkSize) {
    enriched.push(
      ...(await Promise.all(
        detailRecords.slice(index, index + enrichmentChunkSize).map((record) => enrichWithDetails(record, fetchJson, signal, mediaUrl))
      ))
    );
  }
  return [...enriched, ...records.slice(maximumDetails)];
}

function mapSearchResult(result: SeerrSearchResult, mediaUrl: MediaUrl): IngestMediaRecord {
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
      url: tmdbId ? mediaUrl(mediaType, tmdbId) : undefined
    }
  };
}

async function enrichWithDetails(record: IngestMediaRecord, fetchJson: FetchJson, signal: AbortSignal | undefined, mediaUrl: MediaUrl) {
  const tmdbId = record.seerr?.tmdbId;
  if (!tmdbId) return record;

  try {
    const details = await fetchJson<SeerrDetails>(`/api/v1/${record.mediaType === "movie" ? "movie" : "tv"}/${tmdbId}`, { signal });
    const detailGenres = mapDetailGenres(details.genres);
    const runtimeMinutes = record.mediaType === "movie" ? details.runtime : firstRuntime(details.episodeRunTime) ?? details.runtime;
    const yearSource = details.releaseDate ?? details.firstAirDate;
    const imdbId = details.imdbId ?? details.externalIds?.imdbId ?? stringExternalId(record.externalIds?.imdb);
    const tvdbId = details.externalIds?.tvdbId ?? record.seerr?.tvdbId;
    const status = record.seerr
      ? details.mediaInfo?.status !== undefined
        ? normalizeSeerrStatus(details.mediaInfo.status)
        : record.seerr.status
      : undefined;
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
            url: mediaUrl(record.mediaType, tmdbId) ?? record.seerr.url
          }
        : record.seerr
    };
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    return record;
  }
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
