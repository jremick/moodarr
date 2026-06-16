import { normalizeHttpBaseUrl, safeExternalHref } from "../security/urlPolicy";

export function buildPlexWebUrl(input: { webBaseUrl: string; key?: string; ratingKey?: string; serverId?: string }) {
  const key = normalizePlexMetadataKey(input.key ?? (input.ratingKey ? `/library/metadata/${input.ratingKey}` : undefined));
  if (!key) return undefined;

  const route = input.serverId ? `/server/${encodeURIComponent(input.serverId)}/details` : "/details";
  const webBaseUrl = normalizeHttpBaseUrl(input.webBaseUrl, "Plex web URL");
  if (!webBaseUrl) return undefined;
  return `${webBaseUrl}/#!${route}?key=${encodeURIComponent(key)}`;
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

function normalizePlexMetadataKey(value: string | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith("/")) return trimmed;
  return trimmed.startsWith("library/") ? `/${trimmed}` : trimmed;
}

function decodeUrlComponent(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
