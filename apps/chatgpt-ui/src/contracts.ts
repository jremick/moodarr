import { z } from "zod";
import { decodePosterMetadata, POSTER_META_KEY, type ItemPoster } from "../server/artwork-contract";

/**
 * UI-owned snapshot of the public MCP projection, inspected 2026-09-30.
 * Source: apps/mcp-cloudflare/src/{schemas,tools,types}.ts in the backend worktree.
 * Backend base: b3bd90ddd47eac1f56700063cf98829696d35e75; files were uncommitted.
 * SHA-256 schemas: 88aaaa2b79436b324e811ace231d1b56bacff5e131db33b2a3abdfa6566a816d
 * SHA-256 tools: 0347af2aec610523edcb3a3d8a3772c4f7091da0d9c7e7e1810092b33de04d7c
 * SHA-256 types: dac8a566b448f8972f2521b5339a99d323f2ec3b06e40ca4ff6dc4ff4db53064
 * This snapshot has no runtime import from the backend. Unknown body fields fail closed.
 */
export const CONTRACT_VERSION = "moodarr-mcp-ui-v1";

const text = (max: number) => z.string().max(max);
const finite = z.number().finite();
const count = z.number().int().nonnegative();
const itemId = z.string().min(1).max(240).regex(/^[A-Za-z0-9][A-Za-z0-9:_-]*$/);
const eventId = z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9:_.-]*$/);
const mediaType = z.enum(["movie", "tv"]);
const watchContext = z.enum(["solo", "group"]);
const seasons = z.array(z.number().int().min(1).max(1000)).min(1).max(100);
const availability = z.enum(["available_in_plex", "not_in_plex_requestable", "already_requested", "partially_available", "unavailable"]);
const filters = z.strictObject({
  mediaTypes: z.array(mediaType).max(2).optional(),
  minRuntimeMinutes: z.number().int().positive().optional(), maxRuntimeMinutes: z.number().int().positive().optional(),
  minYear: z.number().int().optional(), maxYear: z.number().int().optional(),
  genres: z.array(z.string().trim().min(1).max(80)).max(24).optional(),
  excludedGenres: z.array(z.string().trim().min(1).max(80)).max(24).optional(),
  contentRating: z.string().trim().max(40).optional(), availability: z.array(availability).max(5).optional(),
  requestStatus: z.array(z.string().trim().min(1).max(80)).max(12).optional(),
});

const itemSchema = z.strictObject({
  id: itemId, mediaType, title: text(300), year: finite.optional(), runtimeMinutes: finite.optional(),
  summary: text(2000).optional(), genres: z.array(text(80)).max(24), contentRating: text(40).optional(),
  ratings: z.strictObject({ critic: finite.optional(), audience: finite.optional(), user: finite.optional() }),
  availabilityGroup: availability, availabilityExplanation: text(500), matchExplanation: text(1000), score: finite,
  requestAttempt: z.strictObject({ available: z.literal(true), seerrAvailabilityChecked: z.literal(false) }).optional(),
  catalogIdentityAmbiguous: z.literal(true).optional(),
  plex: z.strictObject({ available: z.boolean(), library: text(200).optional() }).optional(),
  seerr: z.strictObject({
    status: z.enum(["unknown", "available", "partially_available", "requested", "pending", "approved", "declined", "processing"]),
    requestStatus: text(80).optional(), requestable: z.boolean(),
  }).optional(),
});
const detailSchema = itemSchema.extend({ cast: z.array(text(120)).max(30), directors: z.array(text(120)).max(20) });
const targetSchema = z.strictObject({ mediaType, mediaId: z.number().int().positive(), seasons: seasons.optional(), title: text(300) });

const searchSchema = z.strictObject({
  status: z.literal("ok"), sessionId: itemId.optional(), query: text(2000), optimizedQuery: text(2000),
  usedAi: z.boolean(), summary: text(3000),
  refinementOptions: z.array(z.strictObject({ label: text(120), prompt: text(1000) })).max(10),
  resolvedFilters: filters, watchContext, resultLimit: z.number().int().min(1).max(200),
  aiRerank: z.strictObject({
    requested: z.boolean(), status: z.enum(["not_requested", "applied", "fallback"]),
    failureCategory: z.enum(["not_attempted", "timeout", "http_failure", "malformed_or_truncated_output", "empty_ranking", "request_failure"]).optional(),
  }),
  results: z.array(itemSchema).max(50),
});
const detailResultSchema = z.strictObject({ status: z.literal("ok"), item: detailSchema });
const statsSchema = z.strictObject({
  status: z.literal("ok"), totalItems: count, plexItems: count, seerrItems: count, movies: count, tv: count,
  availableInPlex: count, requestable: count, alreadyRequested: count, partiallyAvailable: count,
  lastLibrarySync: text(80).optional(), lastSeerrSync: text(80).optional(),
});
const feedbackSchema = z.strictObject({
  status: z.literal("recorded"), clientEventId: eventId, ok: z.literal(true), eventId: count, deduped: z.boolean().optional(),
  reliability: z.enum(["high", "medium", "weak", "diagnostic"]), profileVersion: count.optional(),
  profileHoldout: z.boolean().optional(), appliedPreferenceSignal: z.boolean(), appliedProfileSignal: z.boolean().optional(),
});
const previewFields = {
  blockedReason: text(500).optional(), requestMode: z.literal("attempt"), seerrAvailabilityChecked: z.literal(false),
  requiresConfirmation: z.literal(true), request: targetSchema, item: itemSchema,
};
const previewReadySchema = z.strictObject({
  ...previewFields, status: z.literal("ready_for_confirmation"), canRequest: z.literal(true),
  // Opaque capability: never decode, log, persist or send to model context.
  previewHandle: z.string().min(1).max(8000), previewExpiresAt: z.iso.datetime({ offset: true }),
});
const previewBlockedSchema = z.strictObject({
  ...previewFields, status: z.literal("blocked"), canRequest: z.literal(false), automaticRetryAllowed: z.literal(false).optional(),
});
const previewSchema = z.union([previewReadySchema, previewBlockedSchema]);
const requestSchema = z.strictObject({
  status: z.enum(["created", "reconciled"]), ok: z.literal(true), reconciled: z.boolean().optional(),
  request: targetSchema, automaticRetryAllowed: z.literal(false),
  seerr: z.strictObject({ id: z.union([count, text(120)]).optional(), status: text(80), reconciled: z.boolean().optional() }),
});
const watchlistSchema = z.strictObject({ status: z.literal("added"), ok: z.literal(true), itemId, alreadyWatchlisted: z.boolean() });
const errorSchema = z.strictObject({
  status: z.enum(["error", "uncertain"]), code: text(100), message: text(1500),
  httpStatus: z.number().int().min(100).max(599).optional(), automaticRetryAllowed: z.literal(false),
});

const toolInputSchemas = {
  moodarr_search: z.strictObject({
    query: z.string().trim().min(1).max(2000), filters: filters.optional(),
    watchContext: watchContext.default("solo"), resultLimit: z.number().int().min(1).max(50).default(10),
  }),
  moodarr_get_item: z.strictObject({ itemId }),
  moodarr_library_stats: z.strictObject({}),
  moodarr_record_feedback: z.strictObject({
    action: z.enum(["more_like", "less_like", "right_mood", "wrong_mood", "hide", "pairwise_pick"]),
    sessionId: itemId, itemId, clientEventId: eventId, comparedItemId: itemId.optional(),
    watchContext: watchContext.default("solo"), moodTerm: z.string().trim().min(1).max(80).optional(),
    reason: z.string().trim().max(240).optional(), strength: z.number().int().min(1).max(5).optional(),
  }).refine((value) => value.action !== "pairwise_pick" || Boolean(value.comparedItemId), "Pairwise feedback requires comparedItemId."),
  moodarr_preview_request: z.strictObject({ itemId, seasons: seasons.optional() }),
  moodarr_create_request: z.strictObject({ previewHandle: z.string().min(1).max(8000), confirmed: z.literal(true), idempotencyKey: eventId }),
  moodarr_add_to_watchlist: z.strictObject({ itemId }),
};

export type ToolName = keyof typeof toolInputSchemas;
export type ToolInputMap = { [K in ToolName]: z.input<(typeof toolInputSchemas)[K]> };
export type Item = z.output<typeof itemSchema> & { poster?: ItemPoster };
export type ItemDetail = z.output<typeof detailSchema> & { poster?: ItemPoster };
export type SearchResult = Omit<z.output<typeof searchSchema>, "results"> & { results: Item[] };
export type LibraryStats = z.output<typeof statsSchema>;
export type FeedbackResult = z.output<typeof feedbackSchema>;
export type PreviewResult = z.output<typeof previewSchema> & { item: Item };
export type RequestResult = z.output<typeof requestSchema>;
export type WatchlistResult = z.output<typeof watchlistSchema>;
export type ErrorResult = z.output<typeof errorSchema>;
export type MoodarrResult =
  | { kind: "search"; data: SearchResult }
  | { kind: "item"; data: { status: "ok"; item: ItemDetail } }
  | { kind: "stats"; data: LibraryStats }
  | { kind: "feedback"; data: FeedbackResult }
  | { kind: "preview"; data: PreviewResult }
  | { kind: "request"; data: RequestResult }
  | { kind: "watchlist"; data: WatchlistResult }
  | { kind: "error"; data: ErrorResult };

export class ContractFault extends Error {
  constructor(message = "Moodarr returned data outside the supported contract.") { super(message); this.name = "ContractFault"; }
}
export function isToolName(value: unknown): value is ToolName {
  return typeof value === "string" && Object.hasOwn(toolInputSchemas, value);
}
export function isMutation(name: ToolName): boolean {
  return name === "moodarr_record_feedback" || name === "moodarr_create_request" || name === "moodarr_add_to_watchlist";
}
export function parseToolInput<K extends ToolName>(name: K, value: unknown): ToolInputMap[K] {
  const parsed = toolInputSchemas[name].safeParse(value);
  if (!parsed.success) throw new ContractFault("The tool arguments do not match the supported Moodarr contract.");
  return parsed.data as ToolInputMap[K];
}

const resultSchemas = {
  moodarr_search: searchSchema, moodarr_get_item: detailResultSchema, moodarr_library_stats: statsSchema,
  moodarr_record_feedback: feedbackSchema, moodarr_preview_request: previewSchema,
  moodarr_create_request: z.union([requestSchema, previewBlockedSchema]), moodarr_add_to_watchlist: watchlistSchema,
};
const kinds = {
  moodarr_search: "search", moodarr_get_item: "item", moodarr_library_stats: "stats", moodarr_record_feedback: "feedback",
  moodarr_preview_request: "preview", moodarr_create_request: "request", moodarr_add_to_watchlist: "watchlist",
} as const;
const envelopeSchema = z.object({
  structuredContent: z.record(z.string(), z.unknown()), isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.literal("text"), text: z.string().max(300_000) })).max(1),
});
function sameSeasons(a?: number[], b?: number[]): boolean {
  const normalized = (values?: number[]) => [...new Set(values ?? [])].sort((x, y) => x - y).join(",");
  return normalized(a) === normalized(b);
}
function attachPosters(result: MoodarrResult, envelope: unknown): MoodarrResult {
  if (result.kind !== "search" && result.kind !== "item" && result.kind !== "preview") return result;
  const items = result.kind === "search" ? result.data.results : [result.data.item];
  const meta = typeof envelope === "object" && envelope !== null && "_meta" in envelope ? envelope._meta : undefined;
  const artwork = typeof meta === "object" && meta !== null && POSTER_META_KEY in meta ? meta[POSTER_META_KEY] : undefined;
  const posters = decodePosterMetadata(artwork, items.map((item) => item.id));
  if (!posters.size) return result;
  if (result.kind === "search") return { ...result, data: { ...result.data, results: result.data.results.map((item) => ({ ...item, poster: posters.get(item.id) })) } };
  return { ...result, data: { ...result.data, item: { ...result.data.item, poster: posters.get(result.data.item.id) } } } as MoodarrResult;
}

/** Only structuredContent is authoritative; arbitrary metadata/content is never rendered. */
export function parseToolResult(envelope: unknown, expectedName?: ToolName, expectedInput?: ToolInputMap[ToolName]): MoodarrResult {
  const parsed = envelopeSchema.safeParse(envelope);
  if (!parsed.success) throw new ContractFault();
  const { structuredContent: body, isError } = parsed.data;
  if (body.status === "error" || body.status === "uncertain") {
    const error = errorSchema.safeParse(body);
    if (!error.success || isError !== true) throw new ContractFault();
    return { kind: "error", data: error.data };
  }
  const names: ToolName[] = expectedName ? [expectedName] : Object.keys(resultSchemas) as ToolName[];
  for (const name of names) {
    const output = resultSchemas[name].safeParse(body);
    if (!output.success) continue;
    if (isError && !(name === "moodarr_create_request" && body.status === "blocked")) {
      if (expectedName) throw new ContractFault();
      continue;
    }
    let result = { kind: kinds[name], data: output.data } as MoodarrResult;
    if (name === "moodarr_create_request" && body.status === "blocked") result = { kind: "preview", data: previewBlockedSchema.parse(body) };
    if (result.kind === "preview" && (result.data.request.mediaType !== result.data.item.mediaType
      || result.data.request.title !== result.data.item.title
      || (result.data.canRequest && result.data.request.mediaType === "tv" && !result.data.request.seasons?.length))) throw new ContractFault();
    if (expectedInput) {
      if (result.kind === "search" && "query" in expectedInput && result.data.query !== expectedInput.query) throw new ContractFault();
      if (result.kind === "item" && "itemId" in expectedInput && result.data.item.id !== expectedInput.itemId) throw new ContractFault();
      if (result.kind === "preview" && "itemId" in expectedInput && (result.data.item.id !== expectedInput.itemId
        || !sameSeasons(result.data.request.seasons, "seasons" in expectedInput ? expectedInput.seasons : undefined))) throw new ContractFault();
      if (result.kind === "feedback" && "clientEventId" in expectedInput && result.data.clientEventId !== expectedInput.clientEventId) throw new ContractFault();
      if (result.kind === "watchlist" && "itemId" in expectedInput && result.data.itemId !== expectedInput.itemId) throw new ContractFault();
    }
    return attachPosters(result, envelope);
  }
  throw new ContractFault();
}

export function uncertainResult(code = "outcome_unconfirmed"): MoodarrResult {
  return { kind: "error", data: { status: "uncertain", code,
    message: "Moodarr has not confirmed this action. Verify the same attempt before trying again.", automaticRetryAllowed: false } };
}
