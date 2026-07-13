import type { AppConfig } from "../config";
import type { IngestMediaRecord } from "../db/mediaRepository";
import { fixturePlexItems } from "../fixtures/media";
import { fetchWithSameOriginRedirects, readBoundedJson, readSafePoster, timeoutSignal } from "../security/http";
import { safeErrorMessage } from "../security/redact";
import { isSameHttpOrigin, normalizeHttpBaseUrl, trimSlash } from "../security/urlPolicy";
import { buildPlexWebUrl } from "./plexLinks";

interface PlexMetadata {
  ratingKey: string;
  key?: string;
  guid?: string;
  type?: string;
  title: string;
  year?: number;
  summary?: string;
  duration?: number;
  contentRating?: string;
  thumb?: string;
  audienceRating?: number;
  rating?: number;
  userRating?: number;
  Genre?: { tag: string }[];
  Role?: { tag: string }[];
  Director?: { tag: string }[];
  Guid?: { id: string }[];
}

const plexPageSize = 500;
const maximumPlexPagesPerSection = 200;
const maximumPlexSections = 128;
const maximumPlexRecords = 100_000;
const maximumPlexRecordsPerSection = plexPageSize * maximumPlexPagesPerSection;
const maximumPlexIdentityBytes = 64 * 1024;
const maximumPlexSectionsBytes = 256 * 1024;
const maximumPlexPageBytes = 4 * 1024 * 1024;
const maximumPlexSyncDurationMs = 5 * 60_000;
const maximumPlexTitleLength = 500;
const maximumPlexSummaryLength = 10_000;
const maximumPlexOptionalTextLength = 2_000;
const maximumPlexIdentifierLength = 160;
const maximumPlexGenres = 32;
const maximumPlexCast = 12;
const maximumPlexDirectors = 8;
const maximumPlexGuids = 32;
const maximumPlexTagLength = 160;

interface PlexSection {
  key: string;
  title?: string;
  type: "movie" | "show";
}

export interface PlexLibrarySnapshot {
  records: IngestMediaRecord[];
  complete: true;
  sectionCount: number;
}

export class PlexClient {
  constructor(private readonly config: AppConfig) {}

  async testConnection(credentials?: { baseUrl?: string; token?: string }) {
    if (this.config.fixtureMode && !credentials?.baseUrl && !credentials?.token) {
      return { ok: true, mode: "fixture", message: "Fixture Plex connection ready." };
    }

    const baseUrl = normalizeHttpBaseUrl(credentials?.baseUrl ?? this.config.plex.baseUrl, "Plex base URL");
    const usesDifferentOrigin = credentials?.baseUrl !== undefined && !isSameHttpOrigin(baseUrl, this.config.plex.baseUrl);
    const token = credentials?.token ?? (usesDifferentOrigin ? undefined : this.config.plex.token);
    if (!baseUrl || !token) {
      return { ok: false, mode: "unconfigured", message: "Plex base URL and token are required." };
    }

    try {
      const response = await fetchWithSameOriginRedirects(`${trimSlash(baseUrl)}/identity`, {
        signal: timeoutSignal(),
        headers: { Accept: "application/json", "X-Plex-Token": token }
      });
      if (!response.ok) {
        return { ok: false, mode: "live", message: `Plex returned HTTP ${response.status}.` };
      }
      const identity = await readPlexJson(response, maximumPlexIdentityBytes);
      parsePlexIdentity(identity, [...this.config.knownSecrets, token]);
      return { ok: true, mode: "live", message: "Plex connection succeeded." };
    } catch (error) {
      return { ok: false, mode: "live", message: safeErrorMessage(error, [...this.config.knownSecrets, token]) };
    }
  }

  async syncLibrary(signal?: AbortSignal): Promise<PlexLibrarySnapshot> {
    if (this.config.fixtureMode) {
      return { records: fixturePlexItems.map((item) => ({ ...item, source: "fixture" as const })), complete: true, sectionCount: 1 };
    }

    const baseUrl = normalizeHttpBaseUrl(this.config.plex.baseUrl, "Plex base URL");
    const token = this.config.plex.token;
    if (!baseUrl || !token) throw new Error("Plex is not configured.");
    const syncSignal = timeoutSignal(maximumPlexSyncDurationMs, signal);
    const knownSecrets = [...this.config.knownSecrets, token];
    syncSignal.throwIfAborted();

    const identity = await this.fetchJson(`${trimSlash(baseUrl)}/identity`, syncSignal, {}, maximumPlexIdentityBytes);
    syncSignal.throwIfAborted();
    const serverId = parsePlexIdentity(identity, knownSecrets);
    const sectionsResponse = await this.fetchJson(`${trimSlash(baseUrl)}/library/sections`, syncSignal, {}, maximumPlexSectionsBytes);
    syncSignal.throwIfAborted();
    const sections = parsePlexSections(sectionsResponse, knownSecrets);
    const records: IngestMediaRecord[] = [];
    const snapshotRatingKeys = new Set<string>();
    const snapshotMetadataKeys = new Set<string>();
    let declaredRecords = 0;

    for (const section of sections) {
      const mediaType = section.type === "show" ? "tv" : "movie";
      let sectionRecords = 0;
      let expectedTotal: number | undefined;
      let complete = false;
      for (let page = 0, start = 0; page < maximumPlexPagesPerSection; page += 1) {
        syncSignal.throwIfAborted();
        const data = await this.fetchJson(
          `${trimSlash(baseUrl)}/library/sections/${encodeURIComponent(section.key)}/all`,
          syncSignal,
          {
            "X-Plex-Container-Start": String(start),
            "X-Plex-Container-Size": String(plexPageSize)
          },
          maximumPlexPageBytes
        );
        syncSignal.throwIfAborted();
        const pageResult = parsePlexPage(data, knownSecrets);
        const pageItems = pageResult.items;
        const reportedTotal = pageResult.total;
        const sectionTotal = expectedTotal ?? reportedTotal;
        if (expectedTotal === undefined) {
          declaredRecords += sectionTotal;
          if (declaredRecords > maximumPlexRecords) throw new Error("Plex library snapshot exceeded the safe global record limit.");
        }
        expectedTotal = sectionTotal;
        if (reportedTotal !== sectionTotal) {
          throw new Error("Plex changed the reported total while syncing a library section.");
        }
        const requiresPaginationMetadata = start > 0 || sectionTotal > pageItems.length;
        if (requiresPaginationMetadata && (pageResult.offset === undefined || pageResult.size === undefined)) {
          throw new Error("Plex omitted required pagination metadata for a multi-page library section.");
        }
        if (pageResult.offset !== undefined && pageResult.offset !== start) {
          throw new Error("Plex returned an unexpected page offset for a library section.");
        }
        if (pageResult.size !== undefined && pageResult.size !== pageItems.length) {
          throw new Error("Plex returned an inconsistent page size for a library section.");
        }
        for (const item of pageItems) {
          if (snapshotRatingKeys.has(item.ratingKey)) {
            throw new Error("Plex returned duplicate or overlapping media identities in the library snapshot.");
          }
          snapshotRatingKeys.add(item.ratingKey);
          if (item.key) {
            if (snapshotMetadataKeys.has(item.key)) {
              throw new Error("Plex returned duplicate or overlapping media identities in the library snapshot.");
            }
            snapshotMetadataKeys.add(item.key);
          }
        }
        const pageRecords = pageItems.map((item) => this.toIngestRecord(item, section, mediaType, serverId));
        sectionRecords += pageRecords.length;
        if (sectionRecords > sectionTotal || records.length + pageRecords.length > maximumPlexRecords) {
          throw new Error("Plex returned more records than the safe snapshot limits allow.");
        }
        records.push(...pageRecords);
        if (sectionRecords === sectionTotal) {
          complete = true;
          break;
        }
        if (pageItems.length === 0) {
          throw new Error("Plex ended library section before its reported total was reached.");
        }
        start += pageItems.length;
      }
      if (!complete) throw new Error("Plex library section exceeded the safe page limit before completion.");
    }

    return { records, complete: true, sectionCount: sections.length };
  }

  async fetchPoster(posterPath: string) {
    if (!this.config.plex.baseUrl || !this.config.plex.token) throw new Error("Plex is not configured.");
    const baseUrl = normalizeHttpBaseUrl(this.config.plex.baseUrl, "Plex base URL");
    if (!baseUrl) throw new Error("Plex is not configured.");
    const url = posterPath.startsWith("http") ? posterPath : `${baseUrl}${posterPath}`;
    if (new URL(url).origin !== new URL(baseUrl).origin) {
      throw new Error("Plex poster URL must match the configured Plex origin.");
    }
    const response = await fetchWithSameOriginRedirects(url, {
      signal: timeoutSignal(),
      headers: { "X-Plex-Token": this.config.plex.token }
    });
    if (!response.ok) throw new Error(`Plex poster request returned HTTP ${response.status}.`);
    return readSafePoster(response);
  }

  private async fetchJson(url: string, signal: AbortSignal, extraHeaders: Record<string, string>, maximumBytes: number): Promise<unknown> {
    const token = this.config.plex.token;
    if (!token) throw new Error("Plex token is missing.");
    const response = await fetchWithSameOriginRedirects(url, {
      signal: timeoutSignal(undefined, signal),
      headers: { Accept: "application/json", "X-Plex-Token": token, ...extraHeaders }
    });
    if (!response.ok) throw new Error(`Plex request returned HTTP ${response.status}.`);
    return readPlexJson(response, maximumBytes);
  }

  private toIngestRecord(item: PlexMetadata, section: PlexSection, mediaType: "movie" | "tv", serverId: string): IngestMediaRecord {
    return {
      mediaType,
      title: item.title,
      year: item.year,
      summary: item.summary,
      runtimeMinutes: item.duration ? Math.round(item.duration / 60000) : undefined,
      contentRating: item.contentRating,
      posterPath: item.thumb,
      ratings: {
        critic: item.rating,
        audience: item.audienceRating,
        user: item.userRating
      },
      genres: item.Genre?.map((entry) => entry.tag),
      cast: item.Role?.map((entry) => entry.tag),
      directors: item.Director?.map((entry) => entry.tag),
      externalIds: parsePlexGuids(item),
      plex: {
        ratingKey: item.ratingKey,
        guid: item.guid,
        libraryTitle: section.title,
        libraryType: section.type,
        url: this.buildPlexUrl(item, serverId),
        available: true
      }
    };
  }

  private buildPlexUrl(item: PlexMetadata, serverId?: string) {
    return buildPlexWebUrl({
      webBaseUrl: this.config.plex.webBaseUrl,
      key: item.key,
      ratingKey: item.ratingKey,
      serverId
    });
  }
}

function parsePlexIdentity(value: unknown, knownSecrets: string[]) {
  const container = jsonObject(jsonObject(value)?.MediaContainer);
  if (!container) throw new Error("Plex returned an invalid identity response.");
  return requiredSafeString(container.machineIdentifier, maximumPlexIdentifierLength, knownSecrets, "Plex returned an invalid identity response.");
}

function parsePlexSections(value: unknown, knownSecrets: string[]): PlexSection[] {
  const container = jsonObject(jsonObject(value)?.MediaContainer);
  const directory = container?.Directory;
  if (!Array.isArray(directory)) throw new Error("Plex returned an incomplete library-section response.");
  if (directory.length > maximumPlexSections) throw new Error("Plex library-section response exceeded the safe section limit.");

  const sections: PlexSection[] = [];
  const sectionKeys = new Set<string>();
  for (const rawSection of directory) {
    const section = jsonObject(rawSection);
    if (!section) throw new Error("Plex returned an invalid library-section response.");
    const key = requiredSafeString(section.key, maximumPlexIdentifierLength, knownSecrets, "Plex returned an invalid library-section response.");
    const type = requiredSafeString(section.type, 32, knownSecrets, "Plex returned an invalid library-section response.");
    if (sectionKeys.has(key)) throw new Error("Plex returned duplicate library-section identifiers.");
    sectionKeys.add(key);
    if (type !== "movie" && type !== "show") continue;
    sections.push({
      key,
      type,
      title: optionalSafeString(section.title, maximumPlexTitleLength, knownSecrets)
    });
  }
  return sections;
}

function parsePlexPage(value: unknown, knownSecrets: string[]) {
  const container = jsonObject(jsonObject(value)?.MediaContainer);
  if (!container) throw new Error("Plex returned an incomplete response for a library section.");
  const total = nonNegativeSafeInteger(container.totalSize);
  if (total === undefined || total > maximumPlexRecordsPerSection) {
    throw new Error("Plex did not report a valid bounded total for a library section.");
  }
  const rawItems = container.Metadata === undefined && total === 0 ? [] : container.Metadata;
  if (!Array.isArray(rawItems) || rawItems.length > plexPageSize) {
    throw new Error("Plex returned an invalid page for a library section.");
  }
  const offset = optionalNonNegativeSafeInteger(container.offset);
  const size = optionalNonNegativeSafeInteger(container.size);
  if ((container.offset !== undefined && offset === undefined) || (container.size !== undefined && size === undefined)) {
    throw new Error("Plex returned invalid pagination metadata for a library section.");
  }
  return {
    total,
    offset,
    size,
    items: rawItems.map((item) => parsePlexMetadata(item, knownSecrets))
  };
}

function parsePlexMetadata(value: unknown, knownSecrets: string[]): PlexMetadata {
  const item = jsonObject(value);
  if (!item) throw new Error("Plex returned malformed metadata in a library page.");
  return {
    title: requiredSafeString(item.title, maximumPlexTitleLength, knownSecrets, "Plex returned malformed metadata in a library page."),
    ratingKey: requiredSafeString(
      item.ratingKey,
      maximumPlexIdentifierLength,
      knownSecrets,
      "Plex returned metadata without a safe rating key."
    ),
    key: optionalSafeString(item.key, maximumPlexOptionalTextLength, knownSecrets),
    guid: optionalSafeString(item.guid, maximumPlexIdentifierLength, knownSecrets),
    type: optionalSafeString(item.type, 32, knownSecrets),
    year: optionalSafeIntegerInRange(item.year, 1800, 3000),
    summary: optionalSafeString(item.summary, maximumPlexSummaryLength, knownSecrets),
    duration: optionalFiniteNumberInRange(item.duration, 1, 31 * 24 * 60 * 60 * 1000),
    contentRating: optionalSafeString(item.contentRating, maximumPlexTagLength, knownSecrets),
    thumb: optionalSafeString(item.thumb, maximumPlexOptionalTextLength, knownSecrets),
    audienceRating: optionalFiniteNumberInRange(item.audienceRating, 0, 10),
    rating: optionalFiniteNumberInRange(item.rating, 0, 10),
    userRating: optionalFiniteNumberInRange(item.userRating, 0, 10),
    Genre: optionalTagArray(item.Genre, maximumPlexGenres, knownSecrets),
    Role: optionalTagArray(item.Role, maximumPlexCast, knownSecrets),
    Director: optionalTagArray(item.Director, maximumPlexDirectors, knownSecrets),
    Guid: optionalGuidArray(item.Guid, knownSecrets)
  };
}

function requiredSafeString(value: unknown, maximumLength: number, knownSecrets: string[], message: string) {
  if (typeof value !== "string") throw new Error(message);
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || containsUnsafeControlCharacter(normalized) || containsKnownSecret(normalized, knownSecrets)) {
    throw new Error(message);
  }
  return normalized;
}

function optionalSafeString(value: unknown, maximumLength: number, knownSecrets: string[]) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || containsUnsafeControlCharacter(normalized) || containsKnownSecret(normalized, knownSecrets)) {
    return undefined;
  }
  return normalized;
}

function optionalTagArray(value: unknown, maximumItems: number, knownSecrets: string[]) {
  if (!Array.isArray(value)) return undefined;
  const tags: { tag: string }[] = [];
  for (const entry of value.slice(0, maximumItems)) {
    const tag = optionalSafeString(jsonObject(entry)?.tag, maximumPlexTagLength, knownSecrets);
    if (tag) tags.push({ tag });
  }
  return tags.length ? tags : undefined;
}

function optionalGuidArray(value: unknown, knownSecrets: string[]) {
  if (!Array.isArray(value)) return undefined;
  const guids: { id: string }[] = [];
  for (const entry of value.slice(0, maximumPlexGuids)) {
    const id = optionalSafeString(jsonObject(entry)?.id, maximumPlexIdentifierLength, knownSecrets);
    if (id) guids.push({ id });
  }
  return guids.length ? guids : undefined;
}

function containsKnownSecret(value: string, knownSecrets: string[]) {
  return knownSecrets.some((secret) => typeof secret === "string" && secret.length >= 4 && value.includes(secret));
}

function containsUnsafeControlCharacter(value: string) {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code >= 0 && code <= 31) || code === 127) return true;
  }
  return false;
}

function jsonObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function nonNegativeSafeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function optionalNonNegativeSafeInteger(value: unknown) {
  return value === undefined ? undefined : nonNegativeSafeInteger(value);
}

function optionalSafeIntegerInRange(value: unknown, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}

function optionalFiniteNumberInRange(value: unknown, minimum: number, maximum: number) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum && value <= maximum ? value : undefined;
}

async function readPlexJson(response: Response, maximumBytes: number) {
  try {
    return await readBoundedJson<unknown>(response, maximumBytes);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Plex returned a malformed JSON response.");
    throw error;
  }
}

function parsePlexGuids(item: PlexMetadata) {
  const ids: Record<string, string> = {};
  for (const guid of item.Guid ?? []) {
    const [source, value] = guid.id.split("://");
    if (source && value && /^[a-z0-9._-]{1,32}$/i.test(source) && value.length <= maximumPlexIdentifierLength) ids[source] = value;
  }
  if (item.guid) ids.plex = item.guid;
  return ids;
}
