import type { IngestMediaRecord } from "../db/mediaRepository";

type FetchJson = <T>(path: string, init?: RequestInit) => Promise<T>;
type MediaUrl = (mediaType: "movie" | "tv", tmdbId: number) => string | undefined;

export async function searchPolicyRecords(query: string, fetchJson: FetchJson, signal: AbortSignal | undefined, mediaUrl: MediaUrl) {
  const descriptive = await import("./seerrDescriptiveContent");
  return descriptive.searchSeerrContent(query, fetchJson, signal, mediaUrl);
}

export async function enrichPolicyRecords(
  records: IngestMediaRecord[],
  fetchJson: FetchJson,
  signal: AbortSignal | undefined,
  mediaUrl: MediaUrl,
  maximumDetails: number
) {
  const descriptive = await import("./seerrDescriptiveContent");
  return descriptive.enrichSeerrRecords(records, fetchJson, signal, mediaUrl, maximumDetails);
}
