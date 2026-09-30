import { z } from "zod";

const mediaType = z.enum(["movie", "tv"]);
const watchContext = z.enum(["solo", "group"]);
export const itemIdSchema = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/);
const seasons = z.array(z.number().int().min(1).max(1000)).min(1).max(100);
const eventId = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9:_.-]*$/);
const availability = z.enum(["available_in_plex", "not_in_plex_requestable", "already_requested", "partially_available", "unavailable"]);
const filters = z.strictObject({
  mediaTypes: z.array(mediaType).max(2).optional(),
  minRuntimeMinutes: z.number().int().positive().optional(), maxRuntimeMinutes: z.number().int().positive().optional(),
  minYear: z.number().int().optional(), maxYear: z.number().int().optional(),
  genres: z.array(z.string().trim().min(1).max(80)).max(24).optional(),
  excludedGenres: z.array(z.string().trim().min(1).max(80)).max(24).optional(),
  contentRating: z.string().trim().max(40).optional(), availability: z.array(availability).max(5).optional(),
  requestStatus: z.array(z.string().trim().min(1).max(80)).max(12).optional()
});

export const searchInput = z.strictObject({
  query: z.string().trim().min(1).max(2000), filters: filters.optional(),
  watchContext: watchContext.default("solo"), resultLimit: z.number().int().min(1).max(50).default(10)
});
export const itemInput = z.strictObject({ itemId: itemIdSchema });
export const statsInput = z.strictObject({});
export const feedbackInput = z.strictObject({
  action: z.enum(["more_like", "less_like", "right_mood", "wrong_mood", "hide", "pairwise_pick"]),
  sessionId: itemIdSchema, itemId: itemIdSchema, clientEventId: eventId,
  comparedItemId: itemIdSchema.optional(), watchContext: watchContext.default("solo"),
  moodTerm: z.string().trim().min(1).max(80).optional(), reason: z.string().trim().max(240).optional(),
  strength: z.number().int().min(1).max(5).optional()
}).superRefine((value, ctx) => {
  if (value.action === "pairwise_pick" && !value.comparedItemId) {
    ctx.addIssue({ code: "custom", path: ["comparedItemId"], message: "Pairwise feedback requires comparedItemId." });
  }
});
export const previewInput = z.strictObject({ itemId: itemIdSchema, seasons: seasons.optional() });
export const createInput = z.strictObject({
  previewHandle: z.string().min(1).max(8000), confirmed: z.literal(true), idempotencyKey: eventId
});

const text = (maximum: number) => z.string().transform((value) => value.slice(0, maximum));
const number = z.number().finite();
const strings = (limit: number, width: number) => z.array(text(width)).transform((values) => values.slice(0, limit));

/** Explicit projections omit diagnostics, tokens, arbitrary metadata and internal IDs. */
export const itemOutput = z.object({
  id: itemIdSchema, mediaType, title: text(300), year: number.optional(), runtimeMinutes: number.optional(),
  summary: text(2000).optional(), genres: strings(24, 80), contentRating: text(40).optional(),
  ratings: z.object({ critic: number.optional(), audience: number.optional(), user: number.optional() }),
  availabilityGroup: availability, availabilityExplanation: text(500), matchExplanation: text(1000), score: number,
  requestAttempt: z.object({ available: z.literal(true), seerrAvailabilityChecked: z.literal(false) }).optional(),
  catalogIdentityAmbiguous: z.literal(true).optional(),
  plex: z.object({ available: z.boolean(), library: text(200).optional() }).optional(),
  seerr: z.object({ status: z.enum(["unknown", "available", "partially_available", "requested", "pending", "approved", "declined", "processing"]),
    requestStatus: text(80).nullish().transform((value) => value ?? undefined), requestable: z.boolean() }).optional()
});
export const detailOutput = itemOutput.extend({ cast: strings(30, 120), directors: strings(20, 120) });
export const searchOutput = z.object({
  sessionId: itemIdSchema.optional(), query: text(2000), optimizedQuery: text(2000), usedAi: z.boolean(), summary: text(3000),
  refinementOptions: z.array(z.object({ label: text(120), prompt: text(1000) })).transform((values) => values.slice(0, 10)),
  resolvedFilters: filters, watchContext, resultLimit: z.number().int().min(1).max(200),
  aiRerank: z.object({ requested: z.boolean(), status: z.enum(["not_requested", "applied", "fallback"]),
    failureCategory: z.enum(["not_attempted", "timeout", "http_failure", "malformed_or_truncated_output", "empty_ranking", "request_failure"]).optional() }),
  results: z.array(itemOutput).max(200)
});
const count = z.number().int().nonnegative();
export const statsOutput = z.object({
  totalItems: count, plexItems: count, seerrItems: count, movies: count, tv: count, availableInPlex: count,
  requestable: count, alreadyRequested: count, partiallyAvailable: count,
  lastLibrarySync: text(80).optional(), lastSeerrSync: text(80).optional()
});
export const feedbackOutput = z.object({
  ok: z.literal(true), eventId: count, deduped: z.boolean().optional(),
  reliability: z.enum(["high", "medium", "weak", "diagnostic"]), profileVersion: count.optional(),
  profileHoldout: z.boolean().optional(), appliedPreferenceSignal: z.boolean(), appliedProfileSignal: z.boolean().optional()
});
export const requestTarget = z.object({ mediaType, mediaId: z.number().int().positive(), seasons: seasons.optional(), title: text(300) });
export const previewOutput = z.object({
  canRequest: z.boolean(), blockedReason: text(500).optional(), requestMode: z.literal("attempt"),
  seerrAvailabilityChecked: z.literal(false), requiresConfirmation: z.literal(true),
  confirmationPhrase: z.string().min(1).max(500), confirmationToken: z.string().regex(/^[0-9a-f]{64}$/),
  request: requestTarget, item: itemOutput
});
export const createOutput = z.object({
  ok: z.literal(true), reconciled: z.boolean().optional(), request: requestTarget,
  seerr: z.object({ id: z.union([count, text(120)]).optional(), status: text(80), reconciled: z.boolean().optional() })
});
export const watchlistOutput = z.object({ ok: z.literal(true), itemId: itemIdSchema, alreadyWatchlisted: z.boolean() });
export const previewHandlePayload = z.strictObject({
  version: z.literal(1), instanceId: z.string().min(1).max(200), instanceOrigin: z.string().max(2000),
  userId: z.string().min(1).max(200), sessionDigest: z.string().regex(/^[0-9a-f]{64}$/), expiresAt: z.number().int().positive(),
  request: z.strictObject({ itemId: itemIdSchema, mediaType, tmdbId: z.number().int().positive(), seasons: seasons.optional(),
    confirmationPhrase: z.string().min(1).max(500), confirmationToken: z.string().regex(/^[0-9a-f]{64}$/) })
});
