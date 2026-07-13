import { readSafePoster, timeoutSignal } from "../security/http";

const tmdbPosterOrigin = "https://image.tmdb.org";
const supportedTmdbPosterSize = "w500";
const tmdbPosterPathPattern = /^tmdb:\/\/w500\/([A-Za-z0-9_-]+\.(?:avif|gif|jpe?g|png|webp))$/;

export function tmdbPosterUrl(posterPath: string) {
  const match = tmdbPosterPathPattern.exec(posterPath);
  if (!match) throw new Error("TMDB poster path is not in the supported format.");
  return `${tmdbPosterOrigin}/t/p/${supportedTmdbPosterSize}/${match[1]}`;
}

export async function fetchTmdbPoster(posterPath: string, fetchPoster: typeof fetch = fetch) {
  const response = await fetchPoster(tmdbPosterUrl(posterPath), {
    headers: { "User-Agent": "Moodarr (+https://github.com/jremick/moodarr)" },
    redirect: "error",
    signal: timeoutSignal()
  });
  if (!response.ok) throw new Error(`TMDB poster request returned HTTP ${response.status}.`);
  return readSafePoster(response);
}
