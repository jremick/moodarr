import type { AppConfig } from "../config";
import type { IngestMediaRecord } from "../db/mediaRepository";
import { fixtureSeerrItems } from "../fixtures/media";
import { fetchWithSameOriginRedirects, readBoundedJson, timeoutSignal } from "../security/http";
import { safeErrorMessage } from "../security/redact";
import { isSameHttpOrigin, normalizeHttpBaseUrl, trimSlash } from "../security/urlPolicy";
import { getTmdbContentPolicy } from "../config";
import { enrichPolicyRecords, searchPolicyRecords } from "./seerrContentPolicy";

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

const maximumRequestPages = 200;
const searchCacheTtlMs = 30_000;

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

export class SeerrClient {
  private readonly searchCache = new Map<string, { expiresAt: number; records: IngestMediaRecord[] }>();

  constructor(private readonly config: AppConfig) {}

  allowsDescriptiveContent() {
    return this.config.fixtureMode || getTmdbContentPolicy(this.config) === "configurable";
  }

  async testConnection(credentials?: { baseUrl?: string; apiKey?: string }) {
    if (this.config.fixtureMode && !credentials?.baseUrl && !credentials?.apiKey) {
      return { ok: true, mode: "fixture", message: "Fixture Seerr connection ready." };
    }

    const baseUrl = normalizeHttpBaseUrl(credentials?.baseUrl ?? this.config.seerr.baseUrl, "Seerr base URL");
    const usesDifferentOrigin = credentials?.baseUrl !== undefined && !isSameHttpOrigin(baseUrl, this.config.seerr.baseUrl);
    const apiKey = credentials?.apiKey ?? (usesDifferentOrigin ? undefined : this.config.seerr.apiKey);
    if (!baseUrl || !apiKey) {
      return { ok: false, mode: "unconfigured", message: "Seerr base URL and API key are required." };
    }

    try {
      const response = await fetchWithSameOriginRedirects(`${trimSlash(baseUrl)}/api/v1/status`, {
        signal: timeoutSignal(),
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

  async syncRequests(signal?: AbortSignal): Promise<IngestMediaRecord[]> {
    if (this.config.fixtureMode) return fixtureSeerrItems.map((item) => ({ ...item, source: "fixture" as const }));

    const rows = await this.fetchRequestPages(signal);
    const records = rows.flatMap((request) => {
      const media = request.media;
      if (!media?.mediaType || !media.tmdbId) return [];
      const status = normalizeSeerrStatus(media.status);
      const requestStatus = normalizeRequestStatus(request.status);
      return [
        {
          source: this.allowsDescriptiveContent() ? "live" as const : "operational" as const,
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
            status,
            requestStatus,
            requestable: status !== "available" && (!requestStatus || requestStatus === "declined"),
            url: this.mediaUrl(media.mediaType, media.tmdbId)
          }
        } satisfies IngestMediaRecord
      ];
    });
    if (!this.allowsDescriptiveContent()) return records;
    return enrichPolicyRecords(records, this.fetchJson.bind(this), signal, this.mediaUrl.bind(this), 500);
  }

  async search(query: string, signal?: AbortSignal): Promise<IngestMediaRecord[]> {
    if (this.config.fixtureMode) {
      const terms = query.toLowerCase().split(/\W+/).filter(Boolean);
      return fixtureSeerrItems.filter((item) => {
        const haystack = `${item.title} ${item.summary ?? ""} ${(item.genres ?? []).join(" ")}`.toLowerCase();
        return terms.some((term) => haystack.includes(term));
      }).map((item) => ({ ...item, source: "fixture" as const }));
    }

    if (!this.allowsDescriptiveContent()) return [];

    const cacheKey = query.trim().toLowerCase();
    const cached = this.searchCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.records;
    const enriched = await searchPolicyRecords(query, this.fetchJson.bind(this), signal, this.mediaUrl.bind(this));
    this.searchCache.set(cacheKey, { expiresAt: Date.now() + searchCacheTtlMs, records: enriched });
    if (this.searchCache.size > 100) {
      for (const [key, entry] of this.searchCache) {
        if (entry.expiresAt <= Date.now() || this.searchCache.size > 100) this.searchCache.delete(key);
      }
    }
    return enriched;
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

    const result = await this.fetchJson<{ id?: number; status?: string | number }>("/api/v1/request", {
      method: "POST",
      body: JSON.stringify(body)
    });
    return { ...result, status: normalizeRequestStatus(result.status) ?? "requested" };
  }

  private async fetchRequestPages(signal?: AbortSignal) {
    const pageSize = 100;
    const rows: SeerrRequest[] = [];

    for (let skip = 0, page = 0; page < maximumRequestPages; page += 1) {
      const data = await this.fetchJson<SeerrPage<SeerrRequest> | SeerrRequest[]>(`/api/v1/request?take=${pageSize}&skip=${skip}`, { signal });
      if (Array.isArray(data)) return data;

      const pageRows = data.results ?? [];
      rows.push(...pageRows);

      const total = data.pageInfo?.results;
      if (pageRows.length === 0 || (total !== undefined && rows.length >= total) || (total === undefined && pageRows.length < pageSize)) {
        return rows;
      }

      skip += pageRows.length;
    }
    throw new Error("Seerr request pagination exceeded the safe page limit.");
  }

  private async fetchJson<T>(path: string, init: RequestInit = {}): Promise<T> {
    const baseUrl = normalizeHttpBaseUrl(this.config.seerr.baseUrl, "Seerr base URL");
    const apiKey = this.config.seerr.apiKey;
    if (!baseUrl || !apiKey) throw new Error("Seerr is not configured.");
    const method = String(init.method ?? "GET").toUpperCase();
    const maximumAttempts = method === "GET" ? 2 : 1;
    let lastError: unknown;
    for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
      try {
        const response = await fetchWithSameOriginRedirects(`${trimSlash(baseUrl)}${path}`, {
          ...init,
          signal: timeoutSignal(12_000, init.signal),
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
            "X-Api-Key": apiKey,
            ...init.headers
          }
        });
        if (response.ok) return readBoundedJson<T>(response);
        if (attempt + 1 >= maximumAttempts || (response.status !== 429 && response.status < 500)) {
          throw new Error(`Seerr request returned HTTP ${response.status}.`);
        }
        await abortableDelay(retryDelayMs(response), init.signal);
      } catch (error) {
        lastError = error;
        if (init.signal?.aborted || attempt + 1 >= maximumAttempts) throw error;
        await abortableDelay(100, init.signal);
      }
    }
    throw lastError instanceof Error ? lastError : new Error("Seerr request failed.");
  }

  private mediaUrl(mediaType: "movie" | "tv", tmdbId: number) {
    const baseUrl = normalizeHttpBaseUrl(this.config.seerr.baseUrl, "Seerr base URL");
    return baseUrl ? `${trimSlash(baseUrl)}/${mediaType}/${tmdbId}` : undefined;
  }
}

function retryDelayMs(response: Response) {
  const seconds = Number(response.headers.get("retry-after"));
  return Number.isFinite(seconds) && seconds >= 0 ? Math.min(1_000, seconds * 1_000) : 100;
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal | null) {
  if (!signal) {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    return;
  }
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true }
    );
  });
}

export function normalizeSeerrStatus(value: string | number | undefined): "unknown" | "available" | "partially_available" | "requested" | "pending" | "approved" | "declined" | "processing" {
  if (typeof value === "number") return (statusByNumber[value] ?? "unknown") as ReturnType<typeof normalizeSeerrStatus>;
  const normalized = String(value ?? "unknown").toLowerCase().replaceAll(" ", "_");
  if (normalized === "blacklisted") return "declined";
  if (["unknown", "available", "partially_available", "requested", "pending", "approved", "declined", "processing"].includes(normalized)) {
    return normalized as ReturnType<typeof normalizeSeerrStatus>;
  }
  return "unknown";
}

export function normalizeRequestStatus(value: string | number | undefined) {
  if (typeof value === "number") return requestStatusByNumber[value] ?? String(value);
  return value ? String(value).toLowerCase().replaceAll(" ", "_") : undefined;
}
