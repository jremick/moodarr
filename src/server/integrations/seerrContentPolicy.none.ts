import type { IngestMediaRecord } from "../db/mediaRepository";

type FetchJson = <T>(path: string, init?: RequestInit) => Promise<T>;
type MediaUrl = (mediaType: "movie" | "tv", tmdbId: number) => string | undefined;

export function searchPolicyRecords(
  query: string,
  fetchJson: FetchJson,
  signal: AbortSignal | undefined,
  mediaUrl: MediaUrl
): Promise<IngestMediaRecord[]> {
  void query;
  void fetchJson;
  void signal;
  void mediaUrl;
  return Promise.resolve([]);
}

export function enrichPolicyRecords(
  records: IngestMediaRecord[],
  fetchJson: FetchJson,
  signal: AbortSignal | undefined,
  mediaUrl: MediaUrl,
  maximumDetails: number
): Promise<IngestMediaRecord[]> {
  void fetchJson;
  void signal;
  void mediaUrl;
  void maximumDetails;
  return Promise.resolve(records);
}
