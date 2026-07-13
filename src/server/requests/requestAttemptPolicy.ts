import type { ItemSummary } from "../../shared/types";

export interface RequestAttemptPolicyInput {
  externalTmdbId?: string | number;
  hasActiveNonStaleCatalogSource: boolean;
  hasPlexSource: boolean;
  plexAvailable: boolean;
  summary?: string;
  genres: readonly string[];
  seerr?: {
    status?: string;
    requestStatus?: string;
    requestable?: boolean;
  };
}

export interface RequestAttemptPolicy {
  trustedLocalMediaId?: number;
  requestAttempt?: NonNullable<ItemSummary["requestAttempt"]>;
}

const blockingSeerrStatuses = new Set(["available", "requested", "pending", "approved", "processing"]);

export function deriveRequestAttemptPolicy(input: RequestAttemptPolicyInput): RequestAttemptPolicy {
  const mediaId = positiveMediaId(input.externalTmdbId);
  const requestStatus = input.seerr?.requestStatus?.trim().toLowerCase();
  const seerrStatus = input.seerr?.status?.trim().toLowerCase();
  const blockedBySeerr = Boolean(
    input.seerr?.requestable ||
      (requestStatus && requestStatus !== "declined") ||
      (seerrStatus && blockingSeerrStatuses.has(seerrStatus))
  );
  const completeCatalogRecord = Boolean(input.summary?.trim() && input.genres.length > 0);
  const attemptAvailable = Boolean(
    mediaId &&
      input.hasActiveNonStaleCatalogSource &&
      completeCatalogRecord &&
      !input.plexAvailable &&
      !input.seerr &&
      !blockedBySeerr
  );
  const trustedLocalMediaId = mediaId && (input.hasPlexSource || attemptAvailable) ? mediaId : undefined;

  return {
    trustedLocalMediaId,
    requestAttempt: attemptAvailable
      ? {
          available: true,
          seerrAvailabilityChecked: false
        }
      : undefined
  };
}

function positiveMediaId(value: string | number | undefined) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
