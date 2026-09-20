import type { RequestPreview } from "../../../shared/types";

// Match the existing request API: 1–1000, with at most 100 submitted entries.
export function parseSeasonSelection(value: string): number[] | null {
  const entries = value.trim().split(",").map((entry) => entry.trim());
  if (entries.length > 100 || entries.some((entry) => !/^\d+$/.test(entry))) return null;
  const seasons = entries.map(Number);
  if (seasons.some((season) => !Number.isInteger(season) || season < 1 || season > 1000)) return null;
  return [...new Set(seasons)].sort((left, right) => left - right);
}

export function requestPreviewMatchesSeasons(preview: RequestPreview, selection: string): boolean {
  if (preview.request.mediaType !== "tv") return true;
  const selected = parseSeasonSelection(selection);
  const confirmed = [...new Set(preview.request.seasons ?? [])].sort((left, right) => left - right);
  return selected !== null && selected.length === confirmed.length && selected.every((season, index) => season === confirmed[index]);
}
