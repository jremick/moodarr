import { normalizeHttpBaseUrl, safeExternalHref } from "../security/urlPolicy";

export function buildPlexWebUrl(input: { webBaseUrl: string; key?: string; ratingKey?: string; serverId?: string }) {
  const key = normalizePlexMetadataKey(input.ratingKey ? `/library/metadata/${input.ratingKey}` : input.key);
  if (!key) return undefined;

  const route = input.serverId ? `/server/${encodeURIComponent(input.serverId)}/details` : "/details";
  const webBaseUrl = normalizeHttpBaseUrl(input.webBaseUrl, "Plex web URL");
  if (!webBaseUrl) return undefined;
  return `${webBaseUrl}/#!${route}?key=${encodeURIComponent(key)}`;
}

export function buildPlexAppUrl(input: { key?: string; ratingKey?: string; serverId?: string }) {
  const key = normalizePlexMetadataKey(input.ratingKey ? `/library/metadata/${input.ratingKey}` : input.key);
  const serverId = input.serverId?.trim();
  if (!key || !serverId) return undefined;
  return `plex://play/?metadataKey=${encodeURIComponent(key)}&server=${encodeURIComponent(serverId)}`;
}

export function normalizePlexWebUrl(url: string | undefined) {
  const safeUrl = safeExternalHref(url);
  if (!safeUrl) return undefined;

  const parsed = new URL(safeUrl);
  if (parsed.username || parsed.password || parsed.search) return undefined;

  const details = parsed.hash.match(/^#!\/(?:server\/([^/?#]+)\/)?details\?(.*)$/);
  if (!details) return undefined;

  let serverId: string | undefined;
  if (details[1]) {
    try {
      serverId = decodeURIComponent(details[1]);
    } catch {
      return undefined;
    }
    if (!/^[A-Za-z0-9._~-]+$/.test(serverId) || serverId === "." || serverId === "..") return undefined;
  }

  const parameters = new URLSearchParams(details[2]);
  if (parameters.size !== 1 || !parameters.has("key")) return undefined;
  const metadata = parameters.get("key")?.match(/^\/?library\/metadata\/([A-Za-z0-9._~-]+)(?:\/children\/?)?$/);
  if (!metadata || metadata[1] === "." || metadata[1] === "..") return undefined;

  const route = serverId ? `/server/${encodeURIComponent(serverId)}/details` : "/details";
  parsed.hash = `#!${route}?key=${encodeURIComponent(`/library/metadata/${metadata[1]}`)}`;
  return parsed.toString().replace(/([^/])#!\//, "$1/#!/");
}

export function plexAppUrlFromWebUrl(url: string | undefined) {
  const normalized = normalizePlexWebUrl(url);
  if (!normalized) return undefined;
  try {
    const parsed = new URL(normalized);
    const [route, query = ""] = parsed.hash.replace(/^#!/, "").split("?");
    const serverId = route?.match(/^\/server\/([^/]+)\/details$/)?.[1];
    const key = new URLSearchParams(query).get("key") ?? undefined;
    return buildPlexAppUrl({ key, serverId });
  } catch {
    return undefined;
  }
}

function normalizePlexMetadataKey(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const absolute = trimmed.startsWith("/") ? trimmed : trimmed.startsWith("library/") ? `/${trimmed}` : trimmed;
  return absolute.replace(/(\/library\/metadata\/[^/?#]+)\/children(?:[/?#].*)?$/, "$1");
}
