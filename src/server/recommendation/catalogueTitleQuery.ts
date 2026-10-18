import type { MediaType } from "../../shared/types";
import { normalizeTitle } from "../db/textNormalization";

interface CatalogueTitleMatch {
  title: string;
  year?: number;
}

interface CatalogueTitleLookup {
  findByTitleYear(title: string, year: number | undefined, mediaType?: MediaType): CatalogueTitleMatch | undefined;
}

const trailingYearPattern = /^(.*?)(?:\s*[([]\s*((?:19|20)\d{2})\s*[)\]]|\s+((?:19|20)\d{2}))\s*$/;

/**
 * True when the query is only a catalogue title, or that title plus its year.
 * Extra viewing words keep the query available for phrase inference.
 */
export function isNearExactCatalogueTitle(lookup: CatalogueTitleLookup, query: string): boolean {
  const trimmed = query.trim().replace(/^["“”']+|["“”']+$/g, "").replace(/\s+/g, " ").trim();
  const normalizedQuery = normalizeTitle(trimmed);
  if (!normalizedQuery) return false;

  const candidates: Array<{ title: string; year?: number }> = [{ title: trimmed }];
  const yearMatch = trimmed.match(trailingYearPattern);
  const bareTitle = yearMatch?.[1]?.trim();
  const year = Number(yearMatch?.[2] ?? yearMatch?.[3]);
  if (bareTitle && Number.isInteger(year)) candidates.push({ title: bareTitle, year });

  for (const candidate of candidates) {
    const item = lookup.findByTitleYear(candidate.title, candidate.year);
    if (!item) continue;
    const normalizedTitle = normalizeTitle(item.title);
    if (!normalizedTitle) continue;
    if (normalizedQuery === normalizedTitle) return true;
    if (item.year && (normalizedQuery === `${normalizedTitle} ${item.year}` || normalizedQuery === `${item.year} ${normalizedTitle}`)) return true;
  }
  return false;
}
