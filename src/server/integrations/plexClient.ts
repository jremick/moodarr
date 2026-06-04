import type { AppConfig } from "../config";
import type { IngestMediaRecord } from "../db/mediaRepository";
import { fixturePlexItems } from "../fixtures/media";
import { safeErrorMessage } from "../security/redact";

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

    const baseUrl = credentials?.baseUrl ?? this.config.plex.baseUrl;
    const token = credentials?.token ?? this.config.plex.token;
    if (!baseUrl || !token) {
      return { ok: false, mode: "unconfigured", message: "Plex base URL and token are required." };
    }

    try {
      const response = await fetch(`${trimSlash(baseUrl)}/identity`, {
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

  async syncLibrary(): Promise<IngestMediaRecord[]> {
    if (this.config.fixtureMode) return fixturePlexItems.map((item) => ({ ...item, source: "fixture" as const }));

    const baseUrl = this.config.plex.baseUrl;
    const token = this.config.plex.token;
    if (!baseUrl || !token) throw new Error("Plex is not configured.");

    const sections = await this.fetchJson<{ MediaContainer?: { Directory?: PlexSection[] } }>(`${trimSlash(baseUrl)}/library/sections`);
    const records: IngestMediaRecord[] = [];

    for (const section of sections.MediaContainer?.Directory ?? []) {
      if (!["movie", "show"].includes(section.type ?? "")) continue;
      const mediaType = section.type === "show" ? "tv" : "movie";
      const data = await this.fetchJson<{ MediaContainer?: { Metadata?: PlexMetadata[] } }>(
        `${trimSlash(baseUrl)}/library/sections/${encodeURIComponent(section.key)}/all`
      );
      for (const item of data.MediaContainer?.Metadata ?? []) {
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
            url: this.buildPlexUrl(item),
            available: true
          }
        });
      }
    }

    return records;
  }

  async fetchPoster(posterPath: string) {
    if (!this.config.plex.baseUrl || !this.config.plex.token) throw new Error("Plex is not configured.");
    const baseUrl = trimSlash(this.config.plex.baseUrl);
    const url = posterPath.startsWith("http") ? posterPath : `${baseUrl}${posterPath}`;
    if (new URL(url).origin !== new URL(baseUrl).origin) {
      throw new Error("Plex poster URL must match the configured Plex origin.");
    }
    const response = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: { "X-Plex-Token": this.config.plex.token }
    });
    if (!response.ok) throw new Error(`Plex poster request returned HTTP ${response.status}.`);
    return {
      contentType: response.headers.get("content-type") ?? "image/jpeg",
      body: Buffer.from(await response.arrayBuffer())
    };
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const token = this.config.plex.token;
    if (!token) throw new Error("Plex token is missing.");
    const response = await fetch(url, {
      headers: { Accept: "application/json", "X-Plex-Token": token }
    });
    if (!response.ok) throw new Error(`Plex request returned HTTP ${response.status}.`);
    return (await response.json()) as T;
  }

  private buildPlexUrl(item: PlexMetadata) {
    const key = item.key ?? (item.ratingKey ? `/library/metadata/${item.ratingKey}` : undefined);
    if (!key) return undefined;
    return `${this.config.plex.webBaseUrl}/#!/details?key=${encodeURIComponent(key)}`;
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

function trimSlash(value: string) {
  return value.replace(/\/+$/, "");
}
