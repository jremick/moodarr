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

  const withHashRouteSlash = safeUrl.replace(/([^/])#!\//, "$1/#!/");
  return withHashRouteSlash.replace(/([?&]key=)([^&#]+)/, (match, prefix: string, rawKey: string) => {
    const key = normalizePlexMetadataKey(decodeUrlComponent(rawKey));
    return key ? `${prefix}${encodeURIComponent(key)}` : match;
  });
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

function decodeUrlComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
