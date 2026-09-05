import type { MediaType } from "../../shared/types";

/** Only operational facts needed to verify the target of a confirmed request. */
export interface SeerrRequestFact {
  requestId: number;
  mediaType: MediaType;
  mediaId: number;
  status: string;
  is4k?: boolean;
  seasons?: Array<{ seasonNumber: number; status: string }>;
}

/** These outcomes are affirmative evidence that this attempt did not create a request. */
export class SeerrWriteNotAcceptedError extends Error {
  readonly statusCode = 503;
  constructor(message: string, readonly outcome: "not_sent" | "authorization_rejected") {
    super(message);
    this.name = "SeerrWriteNotAcceptedError";
  }
}

export class SeerrSnapshotSupersededError extends Error {
  readonly statusCode = 409;
  constructor() {
    super("A newer complete Seerr request snapshot has already been applied. Retry with a fresh snapshot.");
    this.name = "SeerrSnapshotSupersededError";
  }
}

const acceptedStatuses = new Set(["pending", "approved", "available", "requested", "processing", "created", "created_fixture_request"]);

export function matchingAcceptedSeerrRequest(
  requests: readonly SeerrRequestFact[],
  target: { mediaType: MediaType; mediaId: number; seasons?: readonly number[] }
) {
  return requests.find((request) => {
    if (
      request.mediaType !== target.mediaType
      || request.mediaId !== target.mediaId
      || request.is4k !== false
      || !acceptedStatuses.has(request.status)
    ) return false;
    if (target.mediaType === "movie") return true;
    if (!target.seasons?.length || !request.seasons?.length) return false;
    return target.seasons.every((seasonNumber) => request.seasons!.some(
      (season) => season.seasonNumber === seasonNumber && acceptedStatuses.has(season.status)
    ));
  });
}
