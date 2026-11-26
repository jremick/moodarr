import type { IngestMediaRecord } from "../db/mediaRepository";

type FetchJson = <T>(path: string, init?: RequestInit) => Promise<T>;
type MediaUrl = (mediaType: "movie" | "tv", tmdbId: number) => string | undefined;
type GetKnownSecrets = () => readonly string[];

export async function searchPolicyRecords(
  query: string,
  fetchJson: FetchJson,
  signal: AbortSignal | undefined,
  mediaUrl: MediaUrl,
  knownSecrets: GetKnownSecrets
) {
  const descriptive = await import("./seerrDescriptiveContent");
  return descriptive.searchSeerrContent(query, fetchJson, signal, mediaUrl, knownSecrets);
}

export async function enrichPolicyRecords(
  records: IngestMediaRecord[],
  fetchJson: FetchJson,
  signal: AbortSignal | undefined,
  mediaUrl: MediaUrl,
  maximumDetails: number,
  knownSecrets: GetKnownSecrets
) {
  const descriptive = await import("./seerrDescriptiveContent");
  return descriptive.enrichSeerrRecords(records, fetchJson, signal, mediaUrl, maximumDetails, knownSecrets);
}
