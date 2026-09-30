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
