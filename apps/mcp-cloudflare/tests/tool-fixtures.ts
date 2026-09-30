import type { MoodarrConnection } from "../src/types.js";

export const previewSecret = "synthetic-preview-signing-secret-with-at-least-32-bytes";
export const connection: MoodarrConnection = {
  instanceId: "household-a", instanceOrigin: "https://media.example.com", userId: "same-user-id",
  displayName: "Alex", sessionToken: "synthetic-user-session-token-a",
  sessionExpiresAt: new Date(Date.now() + 86_400_000).toISOString(),
  scopes: ["moodarr:read", "moodarr:feedback", "moodarr:requests", "moodarr:watchlist"]
};

export const item = {
  id: "tv:9911", mediaType: "tv", title: "Night Trains", year: 2023, runtimeMinutes: 48,
  summary: "A strange but hopeful journey.", genres: ["Drama", "Mystery"], ratings: { critic: 82 },
  posterUrl: "/api/items/tv%3A9911/poster", availabilityGroup: "not_in_plex_requestable",
  availabilityExplanation: "A local request attempt is available; Seerr has not checked it.",
  matchExplanation: "Fits a reflective evening.", score: 0.82,
  requestAttempt: { available: true, seerrAvailabilityChecked: false },
  seerr: { status: "unknown", requestable: true, mediaId: 9911 }
};

export function searchResponse() {
  return {
    sessionId: "recommendation-session-a", query: "hopeful mystery under an hour", optimizedQuery: "hopeful mystery",
    usedAi: false, summary: "These titles fit the requested mood.", refinementOptions: [{ label: "Warmer", prompt: "more hopeful" }],
    resolvedFilters: { mediaTypes: ["tv"], maxRuntimeMinutes: 60 }, watchContext: "solo", resultLimit: 10,
    aiRerank: { requested: false, status: "not_requested" }, results: [item], groups: {},
    diagnostics: { rawSecret: connection.sessionToken, prompts: "must never be returned" }
  };
}

export function previewResponse(canRequest = true) {
  return {
    canRequest, ...(canRequest ? {} : { blockedReason: "Seerr already reports status pending." }),
    requestMode: "attempt", seerrAvailabilityChecked: false, requiresConfirmation: true,
    confirmationPhrase: "REQUEST NIGHT TRAINS", confirmationToken: "a".repeat(64),
    request: { mediaType: "tv", mediaId: 9911, seasons: [1, 3], title: "Night Trains" }, item
  };
}

export interface UpstreamCall { url: string; init: RequestInit; body?: Record<string, unknown> }
export function fixtureFetch(
  subject: MoodarrConnection = connection,
  handle: (call: UpstreamCall) => Response | Promise<Response> = () => json(searchResponse())
) {
  const calls: UpstreamCall[] = [];
  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init.headers);
    if (headers.get("authorization") !== `Bearer ${subject.sessionToken}`) throw new Error("Wrong synthetic bearer");
    if (init.redirect !== "manual") throw new Error("Redirect policy missing");
    if (!url.startsWith(`${subject.instanceOrigin}/api/`)) throw new Error("Unexpected synthetic destination");
    const call = { url, init, body: typeof init.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined };
    calls.push(call);
    if (new URL(url).pathname === "/api/auth/session") {
      return json({ authenticated: true, user: { id: subject.userId, enabled: true, canRequest: true, canUseAi: false } });
    }
    return handle(call);
  };
  // Existing action assertions exclude auxiliary identity/artwork reads; calls retains the complete ledger.
  return { fetcher, calls, operations: () => calls.filter((call) => !call.url.endsWith("/api/auth/session") && !call.url.endsWith("/poster")) };
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
