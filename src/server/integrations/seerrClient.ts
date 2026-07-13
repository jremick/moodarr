import { createHash } from "node:crypto";
import type { AppConfig } from "../config";
import type { IngestMediaRecord } from "../db/mediaRepository";
import { fixtureSeerrItems } from "../fixtures/media";
import { fetchWithSameOriginRedirects, readBoundedJson, timeoutSignal } from "../security/http";
import { safeErrorMessage } from "../security/redact";
import { isSameHttpOrigin, normalizeHttpBaseUrl, trimSlash } from "../security/urlPolicy";
import { getTmdbContentPolicy } from "../config";
import { enrichPolicyRecords, searchPolicyRecords } from "./seerrContentPolicy";

interface OperationalSeerrRequest {
  id?: number;
  status: string;
  media: {
    id?: number;
    tmdbId: number;
    tvdbId?: number;
    imdbId?: string;
    mediaType: "movie" | "tv";
    status: ReturnType<typeof normalizeSeerrStatus>;
  };
}

const maximumRequestPages = 200;
const requestPageSize = 100;
const maximumRequestRecords = maximumRequestPages * requestPageSize;
const maximumRequestPageBytes = 2 * 1024 * 1024;
const maximumSeerrJsonBytes = 1024 * 1024;
const maximumCreateResponseBytes = 64 * 1024;
const maximumSyncDurationMs = 5 * 60_000;
const searchCacheTtlMs = 30_000;
const malformedRequestRowError = "Seerr request response contained a malformed supported media row.";

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

    const syncSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(maximumSyncDurationMs)]) : AbortSignal.timeout(maximumSyncDurationMs);
    const rows = consolidateOperationalSeerrRequests(await this.fetchRequestPages(syncSignal));
    const records = rows.flatMap((request) => {
      const media = request.media;
      if (!media?.mediaType || !media.tmdbId) return [];
      const status = normalizeSeerrStatus(media.status);
      // Every row came from Seerr's request endpoint. An absent or future
      // status must therefore remain non-requestable until it is understood;
      // treating it as no request could create a duplicate upstream write.
      const requestStatus = request.status ?? "unknown";
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
    return enrichPolicyRecords(records, this.fetchJson.bind(this), syncSignal, this.mediaUrl.bind(this), 500);
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

    const result = await this.fetchJson<unknown>(
      "/api/v1/request",
      {
        method: "POST",
        body: JSON.stringify(body)
      },
      maximumCreateResponseBytes
    );
    return toOperationalSeerrCreateResult(result);
  }

  private async fetchRequestPages(signal?: AbortSignal) {
    const rows: OperationalSeerrRequest[] = [];
    const seenRowIdentities = new Set<string>();
    let consumedRows = 0;
    let expectedTotal: number | undefined;

    for (let skip = 0, page = 0; page < maximumRequestPages; page += 1) {
      const data = await this.fetchJson<unknown>(
        `/api/v1/request?take=${requestPageSize}&skip=${skip}`,
        { signal },
        maximumRequestPageBytes
      );
      const pageResult = parseOperationalSeerrRequestPage(data);
      for (const identity of pageResult.identities) {
        if (seenRowIdentities.has(identity)) {
          throw new Error("Seerr request pagination repeated or overlapped an earlier record.");
        }
        seenRowIdentities.add(identity);
      }
      const pageRows = pageResult.rows;
      rows.push(...pageRows);
      consumedRows += pageResult.consumed;
      if (consumedRows > maximumRequestRecords) throw new Error("Seerr request pagination exceeded the safe record limit.");
      if (pageResult.unpaginated) return rows;

      if (pageResult.total !== undefined) {
        if (expectedTotal !== undefined && pageResult.total !== expectedTotal) {
          throw new Error("Seerr request response changed its pagination total during sync.");
        }
        expectedTotal = pageResult.total;
      }
      if (expectedTotal !== undefined && consumedRows > expectedTotal) {
        throw new Error("Seerr request response contained inconsistent pagination metadata.");
      }
      if (pageResult.consumed === 0) {
        if (expectedTotal !== undefined && consumedRows < expectedTotal) {
          throw new Error("Seerr request response ended before its reported total.");
        }
        return rows;
      }
      if (expectedTotal !== undefined && consumedRows >= expectedTotal) return rows;
      if (expectedTotal === undefined && pageResult.consumed < requestPageSize) return rows;

      skip += pageResult.consumed;
    }
    throw new Error("Seerr request pagination exceeded the safe page limit.");
  }

  private async fetchJson<T>(path: string, init: RequestInit = {}, maxBytes = maximumSeerrJsonBytes): Promise<T> {
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
        if (response.ok) return readOperationalSeerrJson<T>(response, maxBytes);
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

export function normalizeSeerrStatus(value: unknown): "unknown" | "available" | "partially_available" | "requested" | "pending" | "approved" | "declined" | "processing" {
  if (typeof value === "number") return (statusByNumber[value] ?? "unknown") as ReturnType<typeof normalizeSeerrStatus>;
  const normalized = typeof value === "string" && value.length <= 64 ? value.trim().toLowerCase().replaceAll(" ", "_") : "unknown";
  if (normalized === "blacklisted") return "declined";
  if (["unknown", "available", "partially_available", "requested", "pending", "approved", "declined", "processing"].includes(normalized)) {
    return normalized as ReturnType<typeof normalizeSeerrStatus>;
  }
  return "unknown";
}

export function normalizeRequestStatus(value: unknown) {
  if (typeof value === "number") return requestStatusByNumber[value] ?? "unknown";
  if (typeof value !== "string" || !value.trim()) return undefined;
  if (value.length > 64) return "unknown";
  const normalized = value.trim().toLowerCase().replaceAll(" ", "_");
  return operationalRequestStatuses.has(normalized) ? normalized : "unknown";
}

function parseOperationalSeerrRequestPage(value: unknown): {
  rows: OperationalSeerrRequest[];
  identities: string[];
  consumed: number;
  total?: number;
  unpaginated: boolean;
} {
  const page = jsonObject(value);
  const rawRows = Array.isArray(value) ? value : page?.results;
  if (!Array.isArray(rawRows)) throw new Error("Seerr request response did not contain a valid results array.");
  if (rawRows.length > maximumRequestRecords || (!Array.isArray(value) && rawRows.length > requestPageSize)) {
    throw new Error("Seerr request response exceeded the safe page size.");
  }

  const rows = rawRows.map(toOperationalSeerrRequest).filter((row): row is OperationalSeerrRequest => Boolean(row));
  const identities = rawRows.map(operationalSeerrRowIdentity);

  if (Array.isArray(value)) return { rows, identities, consumed: rawRows.length, unpaginated: true };
  if (page?.pageInfo === undefined) return { rows, identities, consumed: rawRows.length, unpaginated: false };
  const pageInfo = jsonObject(page.pageInfo);
  if (!pageInfo) throw new Error("Seerr request response contained invalid pagination metadata.");
  if (pageInfo.results === undefined) return { rows, identities, consumed: rawRows.length, unpaginated: false };
  const total = nonNegativeSafeInteger(pageInfo.results);
  if (total === undefined || total > maximumRequestRecords) throw new Error("Seerr request response contained invalid pagination metadata.");
  return { rows, identities, consumed: rawRows.length, total, unpaginated: false };
}

function consolidateOperationalSeerrRequests(rows: OperationalSeerrRequest[]) {
  const byMedia = new Map<string, OperationalSeerrRequest>();
  for (const row of rows) {
    const key = `${row.media.mediaType}:${row.media.tmdbId}`;
    const existing = byMedia.get(key);
    if (!existing) {
      byMedia.set(key, row);
      continue;
    }

    // Seerr can retain more than one historical request for the same media.
    // Collapse those rows independently of response order: any active or
    // uncertain request must dominate a declined request so a stale row can
    // never make the item appear safe to request again.
    byMedia.set(key, {
      ...existing,
      status: conservativeRequestStatus(existing.status, row.status),
      media: {
        ...existing.media,
        ...(existing.media.id === undefined && row.media.id !== undefined ? { id: row.media.id } : {}),
        ...(existing.media.tvdbId === undefined && row.media.tvdbId !== undefined ? { tvdbId: row.media.tvdbId } : {}),
        ...(existing.media.imdbId === undefined && row.media.imdbId !== undefined ? { imdbId: row.media.imdbId } : {}),
        status: conservativeMediaStatus(existing.media.status, row.media.status)
      }
    });
  }
  return [...byMedia.values()];
}

function conservativeRequestStatus(left: string, right: string) {
  return statusWithHigherPriority(left, right, requestStatusSafetyPriority);
}

function conservativeMediaStatus(
  left: ReturnType<typeof normalizeSeerrStatus>,
  right: ReturnType<typeof normalizeSeerrStatus>
) {
  return statusWithHigherPriority(left, right, mediaStatusSafetyPriority) as ReturnType<typeof normalizeSeerrStatus>;
}

function statusWithHigherPriority(left: string, right: string, priorities: ReadonlyMap<string, number>) {
  const leftPriority = priorities.get(left) ?? priorities.get("unknown") ?? 0;
  const rightPriority = priorities.get(right) ?? priorities.get("unknown") ?? 0;
  return rightPriority > leftPriority ? right : left;
}

async function readOperationalSeerrJson<T>(response: Response, maximumBytes: number): Promise<T> {
  try {
    return await readBoundedJson<T>(response, maximumBytes);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Seerr returned malformed JSON.");
    throw error;
  }
}

function operationalSeerrRowIdentity(value: unknown) {
  const request = jsonObject(value);
  const requestId = positiveSafeInteger(request?.id);
  if (requestId !== undefined) return `request:${requestId}`;
  const media = jsonObject(request?.media);
  const mediaId = positiveSafeInteger(media?.id);
  if (mediaId !== undefined) return `media:${mediaId}`;
  const tmdbId = positiveSafeInteger(media?.tmdbId);
  if (tmdbId !== undefined && (media?.mediaType === "movie" || media?.mediaType === "tv")) {
    return `tmdb:${media.mediaType}:${tmdbId}`;
  }
  return `raw:${createHash("sha256").update(JSON.stringify(value) ?? String(value)).digest("base64url")}`;
}

function toOperationalSeerrRequest(value: unknown): OperationalSeerrRequest | undefined {
  const request = jsonObject(value);
  const media = jsonObject(request?.media);
  if (!request || !media || typeof media.mediaType !== "string" || !media.mediaType.trim() || media.mediaType.length > 64) {
    throw new Error(malformedRequestRowError);
  }
  if (media.mediaType !== "movie" && media.mediaType !== "tv") return undefined;
  const tmdbId = positiveSafeInteger(media.tmdbId);
  // A movie/TV request without a safe upstream identity cannot be omitted as
  // though it did not exist. Failing the snapshot keeps the last known request
  // state intact instead of allowing a later action to create a duplicate.
  if (tmdbId === undefined) throw new Error(malformedRequestRowError);

  const seerrMediaId = positiveSafeInteger(media.id);
  const tvdbId = positiveSafeInteger(media.tvdbId);
  const imdbId = operationalImdbId(media.imdbId);
  const requestId = positiveSafeInteger(request.id);
  return {
    ...(requestId === undefined ? {} : { id: requestId }),
    status: normalizeRequestStatus(request.status) ?? "unknown",
    media: {
      ...(seerrMediaId === undefined ? {} : { id: seerrMediaId }),
      tmdbId,
      ...(tvdbId === undefined ? {} : { tvdbId }),
      ...(imdbId === undefined ? {} : { imdbId }),
      mediaType: media.mediaType,
      status: normalizeSeerrStatus(media.status)
    }
  };
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function positiveSafeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function nonNegativeSafeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function operationalImdbId(value: unknown) {
  return typeof value === "string" && /^tt\d{7,10}$/i.test(value.trim()) ? value.trim().toLowerCase() : undefined;
}

export function toOperationalSeerrCreateResult(
  value: unknown,
  options: { allowFixtureId?: boolean } = {}
): { id: number | string; status: string } {
  const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const id = operationalSeerrRequestId(record.id, options.allowFixtureId === true);
  if (id === undefined) throw new Error("Seerr did not return a confirmed request identifier.");
  const status = operationalSeerrRequestStatus(record.status);
  return { id, status };
}

function operationalSeerrRequestId(value: unknown, allowFixtureId: boolean) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (allowFixtureId && typeof value === "string" && /^fixture-request-(?:movie|tv)-\d{1,16}$/.test(value)) return value;
  return undefined;
}

function operationalSeerrRequestStatus(value: unknown) {
  const normalized =
    typeof value === "string" || typeof value === "number"
      ? normalizeRequestStatus(value)
      : undefined;
  return normalized && operationalRequestStatuses.has(normalized) ? normalized : "requested";
}

const operationalRequestStatuses = new Set([
  "pending",
  "approved",
  "declined",
  "available",
  "requested",
  "processing",
  "created",
  "created_fixture_request"
]);

const requestStatusSafetyPriority = new Map([
  ["declined", 0],
  ["created_fixture_request", 1],
  ["created", 2],
  ["requested", 3],
  ["pending", 4],
  ["approved", 5],
  ["processing", 6],
  ["unknown", 7],
  ["available", 8]
]);

const mediaStatusSafetyPriority = new Map([
  ["declined", 0],
  ["requested", 1],
  ["pending", 2],
  ["approved", 3],
  ["processing", 4],
  ["unknown", 5],
  ["partially_available", 6],
  ["available", 7]
]);
