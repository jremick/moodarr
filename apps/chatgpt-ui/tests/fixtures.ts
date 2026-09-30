import type { CallToolResult } from "@modelcontextprotocol/client";

// Test host fixtures only. Shapes come from apps/mcp-cloudflare/src/{schemas,tools}.ts.
// No fixture is imported by the production entry or resource bundle.
export const movie = {
  id: "plex:chef", mediaType: "movie", title: "Chef", year: 2014, runtimeMinutes: 114,
  summary: "A chef takes a road trip with his son and a food truck.", genres: ["Comedy", "Drama"],
  contentRating: "M", ratings: { critic: 87, audience: 85 }, score: 3.4,
  availabilityGroup: "available_in_plex", availabilityExplanation: "Available in your Plex library.",
  matchExplanation: "Warm company, food and a hopeful fresh start.", plex: { available: true, library: "Movies" }
};

export const tv = {
  id: "seerr:detectorists", mediaType: "tv", title: "Detectorists", year: 2014, runtimeMinutes: 30,
  summary: "Two friends search for treasure in the English countryside.", genres: ["Comedy"],
  ratings: {}, score: 2.8, availabilityGroup: "not_in_plex_requestable",
  availabilityExplanation: "Not in Plex. A request can be attempted.", matchExplanation: "Quiet humor and patient friendship.",
  requestAttempt: { available: true, seerrAvailabilityChecked: false }, plex: { available: false },
  seerr: { status: "unknown", requestable: true }
};

export function result(data: Record<string, unknown>, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data) }], structuredContent: data, ...(isError ? { isError: true } : {}) };
}

export const searchData = {
  status: "ok", sessionId: "recommendation:fixture-42", query: "Something warm and gently funny",
  optimizedQuery: "warm gentle comedy", usedAi: false, summary: "Two picks for a gentle evening.",
  refinementOptions: [{ label: "Shorter watch", prompt: "Keep the same feeling with a shorter runtime." }],
  resolvedFilters: {}, watchContext: "solo", resultLimit: 8,
  aiRerank: { requested: false, status: "not_requested" }, results: [movie, tv]
};

export function previewData(expiresAt = new Date(Date.now() + 600_000).toISOString()) {
  return {
    status: "ready_for_confirmation", canRequest: true, requestMode: "attempt", seerrAvailabilityChecked: false,
    requiresConfirmation: true, request: { mediaType: "tv", mediaId: 61835, seasons: [1, 3], title: "Detectorists" },
    item: tv, previewHandle: "fixture-preview-handle.bound-to-detectorists-seasons-1-3", previewExpiresAt: expiresAt
  };
}

export function failure(code: string, message = "The action could not be confirmed.", uncertain = false): CallToolResult {
  return result({ status: uncertain ? "uncertain" : "error", code, message, automaticRetryAllowed: false }, true);
}

export type HostCard = { tool: string; args: Record<string, unknown>; result: CallToolResult };
export const cards: Record<string, () => HostCard> = {
  search: () => ({ tool: "moodarr_search", args: { query: searchData.query, watchContext: "solo", resultLimit: 8 }, result: result(searchData) }),
  item: () => ({ tool: "moodarr_get_item", args: { itemId: movie.id }, result: result({ status: "ok", item: { ...movie, cast: ["Jon Favreau"], directors: ["Jon Favreau"] } }) }),
  tv: () => ({ tool: "moodarr_get_item", args: { itemId: tv.id }, result: result({ status: "ok", item: { ...tv, cast: ["Mackenzie Crook"], directors: ["Mackenzie Crook"] } }) }),
  preview: () => ({ tool: "moodarr_preview_request", args: { itemId: tv.id, seasons: [1, 3] }, result: result(previewData()) }),
  expired: () => ({ tool: "moodarr_preview_request", args: { itemId: tv.id, seasons: [1, 3] }, result: result(previewData(new Date(Date.now() - 1000).toISOString())) }),
  blocked: () => ({ tool: "moodarr_preview_request", args: { itemId: tv.id, seasons: [1, 3] }, result: result({ status: "blocked", canRequest: false,
    requestMode: "attempt", seerrAvailabilityChecked: false, requiresConfirmation: true,
    request: { mediaType: "tv", mediaId: 61835, seasons: [1, 3], title: "Detectorists" }, item: tv, blockedReason: "This account cannot request this title." }) }),
  receipt: () => ({ tool: "moodarr_create_request", args: { previewHandle: "fixture-preview-handle.bound-to-detectorists-seasons-1-3", confirmed: true, idempotencyKey: "fixture:create:42" }, result: result({ status: "created", ok: true, request: { mediaType: "tv", mediaId: 61835, title: "Detectorists", seasons: [1, 3] }, seerr: { id: 704, status: "pending" }, automaticRetryAllowed: false }) }),
  invalid: () => ({ tool: "moodarr_search", args: { query: "fixture" }, result: result({ status: "ok", results: "not-an-array" }) }),
  reconnect: () => ({ tool: "moodarr_search", args: { query: "fixture" }, result: failure("reconnect_required", "Reconnect Moodarr to continue.") })
};

export function defaultToolResult(name: string, args: Record<string, unknown>): CallToolResult {
  switch (name) {
    case "moodarr_record_feedback": return result({ status: "recorded", clientEventId: args.clientEventId, ok: true, eventId: 501,
      reliability: "high", appliedPreferenceSignal: true });
    case "moodarr_add_to_watchlist": return result({ status: "added", ok: true, itemId: args.itemId, alreadyWatchlisted: false });
    case "moodarr_create_request": return cards.receipt!().result;
    default: return failure("unsupported_tool", "The local host has no fixture for this tool.");
  }
}
