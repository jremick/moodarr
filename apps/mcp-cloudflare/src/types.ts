/** Provider-independent connection contract. Secrets remain inside the MCP service. */
export const moodarrScopes = ["moodarr:read", "moodarr:feedback", "moodarr:requests", "moodarr:watchlist"] as const;
export type MoodarrScope = (typeof moodarrScopes)[number];

export interface MoodarrInstance {
  id: string;
  name: string;
  origin: string;
}

export interface MoodarrConnection {
  instanceId: string;
  instanceOrigin: string;
  userId: string;
  displayName: string;
  sessionToken: string;
  sessionExpiresAt: string;
  scopes: MoodarrScope[];
}

export interface RequestConfirmationBinding {
  instanceId: string;
  instanceOrigin: string;
  userId: string;
  sessionDigest: string;
}

export interface RequestConfirmationTarget {
  itemId: string;
  mediaType: "movie" | "tv";
  tmdbId: number;
  seasons?: number[];
  title: string;
  confirmationPhrase: string;
  confirmationToken: string;
}

export type RequestConfirmationConsumeResult =
  | { status: "approved"; confirmationPhrase: string; confirmationToken: string }
  | { status: "pending" }
  | { status: "invalid" };

/** Server-owned approval state. Implementations must atomically bind the first claim to its idempotency key. */
export interface RequestConfirmationStore {
  prepare(input: {
    binding: RequestConfirmationBinding;
    request: RequestConfirmationTarget;
    expiresAt: number;
  }): Promise<{ confirmationId: string; confirmationUrl: string }>;
  consume(input: {
    confirmationId: string;
    binding: RequestConfirmationBinding;
    request: Omit<RequestConfirmationTarget, "title" | "confirmationPhrase" | "confirmationToken">;
    idempotencyKey: string;
  }): Promise<RequestConfirmationConsumeResult>;
}
