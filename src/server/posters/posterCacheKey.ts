import crypto from "node:crypto";

const tmdbPosterOrigin = "https://image.tmdb.org";

export function posterCacheSourceKey(posterPath: string | undefined, plexBaseUrl: string | undefined) {
  if (!posterPath) return undefined;
  const source = posterPath.startsWith("tmdb://")
    ? `tmdb:${tmdbPosterOrigin}`
    : `plex:${httpOrigin(plexBaseUrl) ?? "unconfigured"}`;
  return crypto.createHash("sha256").update(`${source}:${posterPath}`).digest("base64url");
}

function httpOrigin(value: string | undefined) {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
