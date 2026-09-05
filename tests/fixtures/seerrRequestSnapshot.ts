import type { IngestMediaRecord } from "../../src/server/db/mediaRepository";
import type { SeerrRequestSnapshot } from "../../src/server/integrations/seerrClient";
import type { SeerrRequestFact } from "../../src/server/requests/seerrRequestOutcome";

export function completeSeerrSnapshot(records: IngestMediaRecord[], requests?: SeerrRequestFact[]): SeerrRequestSnapshot {
  return {
    startedAt: new Date().toISOString(),
    complete: true,
    records,
    requests: requests ?? records.flatMap((record, index) => record.seerr?.tmdbId && record.seerr.requestStatus ? [{
      requestId: index + 1,
      mediaType: record.mediaType,
      mediaId: record.seerr.tmdbId,
      status: record.seerr.requestStatus,
      is4k: false
    }] : [])
  };
}
