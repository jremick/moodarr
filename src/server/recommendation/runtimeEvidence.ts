import type { MediaType } from "../../shared/types";

/**
 * Legacy TV runtime does not declare whether it describes an episode, season,
 * or series. It therefore cannot establish total commitment. Do not reinterpret
 * existing API runtime filters here or migrate old series weights into new facts.
 */
export function movieRuntimeFeature(runtime: number | undefined, mediaType: MediaType): string | undefined {
  if (mediaType !== "movie" || runtime === undefined || !Number.isFinite(runtime) || runtime <= 0) return undefined;
  if (runtime <= 95) return "short movie";
  if (runtime <= 125) return "normal movie";
  return "long movie";
}
