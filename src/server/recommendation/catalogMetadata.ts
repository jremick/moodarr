import type { CatalogMetadataSummary } from "../../shared/types";

export interface CatalogMetadataSourceRow {
  mediaItemId: string;
  source?: string | null;
  metadataJson?: string | null;
  mainstreamScore?: number | null;
  metadataConfidence?: number | null;
  sitelinkCount?: number | null;
  externalIdCount?: number | null;
  awardCount?: number | null;
}

export function summarizeCatalogMetadataRows(rows: CatalogMetadataSourceRow[]) {
  const byItem = new Map<string, CatalogMetadataSummary>();
  for (const row of rows) {
    const summary =
      byItem.get(row.mediaItemId) ??
      ({
        sourceCount: 0,
        sources: [],
        countries: [],
        languages: [],
        franchises: [],
        aliases: []
      } satisfies CatalogMetadataSummary);

    summary.sourceCount += 1;
    if (row.source) summary.sources = unique([...(summary.sources ?? []), row.source]);
    summary.mainstreamScore = maxDefined(summary.mainstreamScore, row.mainstreamScore);
    summary.metadataConfidence = maxDefined(summary.metadataConfidence, row.metadataConfidence);
    summary.sitelinkCount = maxDefined(summary.sitelinkCount, row.sitelinkCount);
    summary.externalIdCount = maxDefined(summary.externalIdCount, row.externalIdCount);
    summary.awardCount = maxDefined(summary.awardCount, row.awardCount);

    const metadata = parseCatalogMetadata(row.metadataJson);
    summary.countries = unique([...(summary.countries ?? []), ...stringArray(metadata, "countries")]).slice(0, 12);
    summary.languages = unique([...(summary.languages ?? []), ...stringArray(metadata, "languages")]).slice(0, 12);
    summary.franchises = unique([...(summary.franchises ?? []), ...stringArray(metadata, "franchises")]).slice(0, 8);
    summary.aliases = unique([...(summary.aliases ?? []), ...stringArray(metadata, "aliases")]).slice(0, 12);
    summary.hasEnglishWikipedia = Boolean(summary.hasEnglishWikipedia || booleanValue(metadata, "has english wikipedia"));

    byItem.set(row.mediaItemId, compactCatalogMetadata(summary));
  }
  return byItem;
}

function compactCatalogMetadata(summary: CatalogMetadataSummary): CatalogMetadataSummary {
  return {
    sourceCount: summary.sourceCount,
    sources: nonEmpty(summary.sources),
    mainstreamScore: numberOrUndefined(summary.mainstreamScore),
    metadataConfidence: numberOrUndefined(summary.metadataConfidence),
    sitelinkCount: integerOrUndefined(summary.sitelinkCount),
    externalIdCount: integerOrUndefined(summary.externalIdCount),
    awardCount: integerOrUndefined(summary.awardCount),
    countries: nonEmpty(summary.countries),
    languages: nonEmpty(summary.languages),
    franchises: nonEmpty(summary.franchises),
    aliases: nonEmpty(summary.aliases),
    hasEnglishWikipedia: summary.hasEnglishWikipedia || undefined
  };
}

function parseCatalogMetadata(value: string | null | undefined) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function stringArray(metadata: Record<string, unknown>, key: string) {
  const value = metadata[key];
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string | number => typeof entry === "string" || typeof entry === "number")
    .map((entry) => String(entry).trim())
    .filter(Boolean);
}

function booleanValue(metadata: Record<string, unknown>, key: string) {
  return metadata[key] === true;
}

function maxDefined(current: number | undefined, candidate: number | null | undefined) {
  if (typeof candidate !== "number" || !Number.isFinite(candidate)) return current;
  return current === undefined ? candidate : Math.max(current, candidate);
}

function numberOrUndefined(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Number(value.toFixed(3)) : undefined;
}

function integerOrUndefined(value: number | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}

function nonEmpty(values: string[] | undefined) {
  return values?.length ? values : undefined;
}

function unique(values: string[]) {
  return [...new Set(values.filter(Boolean))];
}
