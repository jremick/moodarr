import type { AppConfig } from "../config";
import type { IngestMediaRecord } from "../db/mediaRepository";
import { fixturePlexItems } from "../fixtures/media";
import { fetchWithSameOriginRedirects, readBoundedJson, readSafePoster, timeoutSignal } from "../security/http";
import { safeErrorMessage } from "../security/redact";
import { isSameHttpOrigin, normalizeHttpBaseUrl, trimSlash } from "../security/urlPolicy";
import { buildPlexWebUrl } from "./plexLinks";

interface PlexMetadata {
  ratingKey?: string;
  key?: string;
  guid?: string;
  type?: string;
  title?: string;
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

interface PlexIdentity {
  MediaContainer?: {
    machineIdentifier?: string;
  };
}

interface PlexLibraryContainer {
  Metadata?: PlexMetadata[];
  totalSize?: number;
}

const plexPageSize = 500;
const maximumPlexPagesPerSection = 200;

interface PlexSection {
  key: string;
  title?: string;
  type?: string;
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
      return { ok: true, mode: "live", message: "Plex connection succeeded." };
    } catch (error) {
      return { ok: false, mode: "live", message: safeErrorMessage(error, [token]) };
    }
  }

  async syncLibrary(signal?: AbortSignal): Promise<IngestMediaRecord[]> {
    if (this.config.fixtureMode) return fixturePlexItems.map((item) => ({ ...item, source: "fixture" as const }));

    const baseUrl = normalizeHttpBaseUrl(this.config.plex.baseUrl, "Plex base URL");
    const token = this.config.plex.token;
    if (!baseUrl || !token) throw new Error("Plex is not configured.");

    const identity = await this.fetchJson<PlexIdentity>(`${trimSlash(baseUrl)}/identity`, signal);
    const serverId = identity.MediaContainer?.machineIdentifier;
    const sections = await this.fetchJson<{ MediaContainer?: { Directory?: PlexSection[] } }>(`${trimSlash(baseUrl)}/library/sections`, signal);
    const records: IngestMediaRecord[] = [];

    for (const section of sections.MediaContainer?.Directory ?? []) {
      if (!["movie", "show"].includes(section.type ?? "")) continue;
      const mediaType = section.type === "show" ? "tv" : "movie";
      const sectionItems: PlexMetadata[] = [];
      for (let page = 0, start = 0; page < maximumPlexPagesPerSection; page += 1) {
        const data = await this.fetchJson<{ MediaContainer?: PlexLibraryContainer }>(
          `${trimSlash(baseUrl)}/library/sections/${encodeURIComponent(section.key)}/all`,
          signal,
          {
            "X-Plex-Container-Start": String(start),
            "X-Plex-Container-Size": String(plexPageSize)
          }
        );
        const pageItems = data.MediaContainer?.Metadata ?? [];
        sectionItems.push(...pageItems);
        const total = data.MediaContainer?.totalSize;
        if (pageItems.length === 0 || pageItems.length > plexPageSize || pageItems.length < plexPageSize || (total !== undefined && sectionItems.length >= total)) break;
        start += pageItems.length;
        if (page === maximumPlexPagesPerSection - 1) throw new Error("Plex library pagination exceeded the safe page limit.");
      }
      for (const item of sectionItems) {
        const title = item.title?.trim();
        if (!title) continue;
        const externalIds = parsePlexGuids(item);
        records.push({
          mediaType,
          title,
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
          cast: item.Role?.slice(0, 12).map((entry) => entry.tag),
          directors: item.Director?.map((entry) => entry.tag),
          externalIds,
          plex: {
            ratingKey: item.ratingKey,
            guid: item.guid,
            libraryTitle: section.title,
            libraryType: section.type,
            url: this.buildPlexUrl(item, serverId),
            available: true
          }
        });
      }
    }

    return records;
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

  private async fetchJson<T>(url: string, signal?: AbortSignal, extraHeaders: Record<string, string> = {}): Promise<T> {
    const token = this.config.plex.token;
    if (!token) throw new Error("Plex token is missing.");
    const response = await fetchWithSameOriginRedirects(url, {
      signal: timeoutSignal(undefined, signal),
      headers: { Accept: "application/json", "X-Plex-Token": token, ...extraHeaders }
    });
    if (!response.ok) throw new Error(`Plex request returned HTTP ${response.status}.`);
    return readBoundedJson<T>(response);
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

function parsePlexGuids(item: PlexMetadata) {
  const ids: Record<string, string> = {};
  for (const guid of item.Guid ?? []) {
    const [source, value] = guid.id.split("://");
    if (source && value) ids[source] = value;
  }
  if (item.guid) ids.plex = item.guid;
  return ids;
}
