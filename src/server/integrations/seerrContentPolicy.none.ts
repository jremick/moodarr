import type { IngestMediaRecord } from "../db/mediaRepository";

type FetchJson = <T>(path: string, init?: RequestInit) => Promise<T>;
type MediaUrl = (mediaType: "movie" | "tv", tmdbId: number) => string | undefined;
type GetKnownSecrets = () => readonly string[];

export function searchPolicyRecords(
  query: string,
  fetchJson: FetchJson,
  signal: AbortSignal | undefined,
  mediaUrl: MediaUrl,
  knownSecrets: GetKnownSecrets
): Promise<IngestMediaRecord[]> {
  void query;
  void fetchJson;
  void signal;
  void mediaUrl;
  void knownSecrets;
  return Promise.resolve([]);
}

export function enrichPolicyRecords(
  records: IngestMediaRecord[],
  fetchJson: FetchJson,
  signal: AbortSignal | undefined,
  mediaUrl: MediaUrl,
  maximumDetails: number,
  knownSecrets: GetKnownSecrets
): Promise<IngestMediaRecord[]> {
  void fetchJson;
  void signal;
  void mediaUrl;
  void maximumDetails;
  void knownSecrets;
  return Promise.resolve(records);
}
