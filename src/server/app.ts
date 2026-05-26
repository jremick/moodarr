import cors from "@fastify/cors";
import fastify, { type FastifyInstance } from "fastify";
import staticPlugin from "@fastify/static";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { requireAdmin } from "./admin/auth";
import { getAdminSettings, updateAdminSettings } from "./admin/configStore";
import type { AppConfig } from "./config";
import { getPublicConfigStatus, loadConfig } from "./config";
import { createBriefParser } from "./ai/briefParser";
import { createEmbeddingProvider } from "./ai/embeddings";
import { createRanker } from "./ai/ranker";
import { createDatabase, type SqliteDatabase } from "./db/database";
import { MediaRepository } from "./db/mediaRepository";
import { fixturePosterSvg } from "./fixtures/media";
import { PlexClient } from "./integrations/plexClient";
import { SeerrClient } from "./integrations/seerrClient";
import { SyncScheduler } from "./jobs/syncScheduler";
import { SearchService } from "./search/searchService";
import { redactSecrets, safeErrorMessage } from "./security/redact";
import type { CreateRequestBody, MediaType, PreviewRequest, SearchRequest } from "../shared/types";

interface CreateAppOptions {
  config?: AppConfig;
  db?: SqliteDatabase;
}

const searchSchema = z.object({
  query: z.string().trim().min(1),
  useAi: z.boolean().optional(),
  resultLimit: z.number().int().min(1).max(50).optional(),
  watchContext: z.enum(["solo", "group"]).optional(),
  filters: z
    .object({
      mediaTypes: z.array(z.enum(["movie", "tv"])).optional(),
      minRuntimeMinutes: z.number().int().positive().optional(),
      maxRuntimeMinutes: z.number().int().positive().optional(),
      minYear: z.number().int().optional(),
      maxYear: z.number().int().optional(),
      genres: z.array(z.string()).optional(),
      contentRating: z.string().optional(),
      availability: z
        .array(z.enum(["available_in_plex", "not_in_plex_requestable", "already_requested", "partially_available", "unavailable"]))
        .optional(),
      requestStatus: z.array(z.string()).optional()
    })
    .optional(),
  feedbackContext: z
    .object({
      moreLikeItemIds: z.array(z.string()).optional(),
      lessLikeItemIds: z.array(z.string()).optional(),
      hiddenItemIds: z.array(z.string()).optional(),
      showRatedItems: z.boolean().optional()
    })
    .optional()
});

const connectionTestSchema = z.object({
  baseUrl: z.string().url().optional(),
  token: z.string().optional(),
  apiKey: z.string().optional()
});

const previewSchema = z.object({
  itemId: z.string().optional(),
  mediaType: z.enum(["movie", "tv"]).optional(),
  tmdbId: z.number().int().positive().optional(),
  seasons: z.array(z.number().int().positive()).optional()
});

const createRequestSchema = previewSchema.extend({
  confirmed: z.boolean().optional(),
  confirmationPhrase: z.string().optional()
});

const adminSettingsSchema = z.object({
  fixtureMode: z.boolean().optional(),
  plex: z
    .object({
      baseUrl: z.string().optional(),
      token: z.string().optional(),
      webBaseUrl: z.string().optional(),
      clearToken: z.boolean().optional()
    })
    .optional(),
  seerr: z
    .object({
      baseUrl: z.string().optional(),
      apiKey: z.string().optional(),
      clearApiKey: z.boolean().optional()
    })
    .optional(),
  ai: z
    .object({
      provider: z.enum(["none", "openai"]).optional(),
      openaiApiKey: z.string().optional(),
      openaiModel: z.string().optional(),
      openaiEmbeddingModel: z.string().optional(),
      clearOpenaiApiKey: z.boolean().optional()
    })
    .optional(),
  sync: z
    .object({
      intervalMinutes: z.number().int().min(0).max(10080).optional(),
      syncSeerr: z.boolean().optional()
    })
    .optional()
});

export function createApp(options: CreateAppOptions = {}) {
  const config = options.config ?? loadConfig();
  const db = options.db ?? createDatabase(config.dbPath);
  const repository = new MediaRepository(db);
  const plexClient = new PlexClient(config);
  const seerrClient = new SeerrClient(config);
  const searchService = new SearchService(repository, seerrClient, createRanker(config), createEmbeddingProvider(config), createBriefParser(config));
  const scheduler = new SyncScheduler(config, repository, plexClient, seerrClient);

  const app = fastify({
    logger:
      process.env.NODE_ENV === "test"
        ? false
        : {
            redact: [
              "req.headers.authorization",
              "req.headers.x-api-key",
              "req.headers.x-feelerr-admin-token",
              "req.headers.cookie",
              "body.token",
              "body.apiKey",
              "body.plex.token",
              "body.seerr.apiKey",
              "body.ai.openaiApiKey"
            ]
          }
  });

  app.register(cors, { origin: config.webOrigin });
  registerSecurityHeaders(app);
  registerRoutes(app, { config, repository, plexClient, seerrClient, searchService, scheduler });

  app.setErrorHandler((error, request, reply) => {
    const message = safeErrorMessage(error, config.knownSecrets);
    const statusCode = getStatusCode(error);
    request.log.error({ message, statusCode }, "Request failed");
    reply.code(statusCode).send({ error: message });
  });

  if (config.serveClient) {
    const distClient = join(process.cwd(), "dist", "client");
    if (existsSync(distClient)) {
      app.register(staticPlugin, { root: distClient, prefix: "/" });
      app.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith("/api/")) {
          return reply.code(404).send({ error: "Route not found." });
        }
        return reply.type("text/html; charset=utf-8").send(readFileSync(join(distClient, "index.html"), "utf8"));
      });
    }
  }

  if (process.env.NODE_ENV !== "test") scheduler.start();
  return app;
}

function getStatusCode(error: unknown) {
  if (typeof error === "object" && error && "statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }
  return 500;
}

function registerSecurityHeaders(app: FastifyInstance) {
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  });
}

function registerRoutes(
  app: FastifyInstance,
  deps: {
    config: AppConfig;
    repository: MediaRepository;
    plexClient: PlexClient;
    seerrClient: SeerrClient;
    searchService: SearchService;
    scheduler: SyncScheduler;
  }
) {
  const { config, repository, plexClient, seerrClient, searchService, scheduler } = deps;

  app.get("/api/health", async () => ({
    ok: true,
    fixtureMode: config.fixtureMode,
    version: process.env.npm_package_version ?? "0.1.0",
    database: "ok"
  }));

  app.get("/api/config/status", async () => getPublicConfigStatus(config));
  app.get("/api/admin/settings", async (request, reply) => {
    if (!requireAdmin(config, request, reply)) return reply;
    return getAdminSettings(config);
  });

  app.put("/api/admin/settings", async (request, reply) => {
    if (!requireAdmin(config, request, reply)) return reply;
    const body = adminSettingsSchema.parse(request.body ?? {});
    const settings = updateAdminSettings(config, body);
    scheduler.restart();
    return settings;
  });

  app.get("/api/admin/sync/status", async (request, reply) => {
    if (!requireAdmin(config, request, reply)) return reply;
    return scheduler.status();
  });

  app.post("/api/admin/sync/run", async (request, reply) => {
    if (!requireAdmin(config, request, reply)) return reply;
    return scheduler.runOnce();
  });

  app.get("/api/admin/support-bundle", async (request, reply) => {
    if (!requireAdmin(config, request, reply)) return reply;
    return {
      generatedAt: new Date().toISOString(),
      config: getPublicConfigStatus(config),
      settings: getAdminSettings(config),
      stats: repository.stats(),
      sync: scheduler.status(),
      recommendations: repository.recommendationDiagnostics()
    };
  });

  app.get("/api/admin/recommendations/diagnostics", async (request, reply) => {
    if (!requireAdmin(config, request, reply)) return reply;
    return repository.recommendationDiagnostics();
  });

  app.post("/api/plex/test", async (request, reply) => {
    if (config.requireAdminToken && !requireAdmin(config, request, reply)) return reply;
    const body = connectionTestSchema.parse(request.body ?? {});
    return plexClient.testConnection({ baseUrl: body.baseUrl, token: body.token });
  });

  app.post("/api/seerr/test", async (request, reply) => {
    if (config.requireAdminToken && !requireAdmin(config, request, reply)) return reply;
    const body = connectionTestSchema.parse(request.body ?? {});
    return seerrClient.testConnection({ baseUrl: body.baseUrl, apiKey: body.apiKey });
  });

  app.post("/api/library/sync", async (request, reply) => {
    if (config.requireAdminToken && !requireAdmin(config, request, reply)) return reply;
    const records = await plexClient.syncLibrary();
    repository.upsertMany(records);
    repository.recordSync("library", config.fixtureMode ? "fixture" : "plex", "ok", records.length);
    return { ok: true, source: config.fixtureMode ? "fixture" : "plex", itemCount: records.length };
  });

  app.post("/api/seerr/sync", async (request, reply) => {
    if (config.requireAdminToken && !requireAdmin(config, request, reply)) return reply;
    const records = await seerrClient.syncRequests();
    repository.upsertMany(records);
    repository.recordSync("seerr", config.fixtureMode ? "fixture" : "seerr", "ok", records.length);
    return { ok: true, source: config.fixtureMode ? "fixture" : "seerr", itemCount: records.length };
  });

  app.get("/api/library/stats", async () => repository.stats());

  app.post("/api/search", async (request) => {
    await ensureFixtureSeeded(config, repository, plexClient, seerrClient);
    const body = searchSchema.parse(request.body) as SearchRequest;
    return searchService.search(body);
  });

  app.get<{ Params: { id: string } }>("/api/items/:id", async (request, reply) => {
    const item = repository.findById(decodeURIComponent(request.params.id));
    if (!item) return reply.code(404).send({ error: "Item not found." });
    return item;
  });

  app.get<{ Params: { id: string } }>("/api/items/:id/poster", async (request, reply) => {
    const id = decodeURIComponent(request.params.id);
    const item = repository.findById(id);
    if (!item) return reply.code(404).send({ error: "Item not found." });
    const posterPath = repository.getPosterPath(id);
    if (!posterPath?.startsWith("fixture://") && posterPath) {
      try {
        if (posterPath.startsWith("tmdb://")) {
          const image = await fetchTmdbPoster(posterPath);
          return reply.header("Content-Type", image.contentType).send(image.body);
        }
        const image = await plexClient.fetchPoster(posterPath);
        return reply.header("Content-Type", image.contentType).send(image.body);
      } catch {
        const svg = fixturePosterSvg(item.title);
        return reply.header("Content-Type", "image/svg+xml; charset=utf-8").send(svg);
      }
    }

    const svg = fixturePosterSvg(item.title);
    return reply.header("Content-Type", "image/svg+xml; charset=utf-8").send(svg);
  });

  app.post("/api/requests/preview", async (request, reply) => {
    await ensureFixtureSeeded(config, repository, plexClient, seerrClient);
    const previewInput = previewSchema.parse(request.body ?? {}) as PreviewRequest;
    const preview = buildPreview(repository, previewInput);
    if (!preview.canRequest) return reply.code(409).send(preview);
    return preview;
  });

  app.post("/api/requests/create", async (request, reply) => {
    if (config.requireAdminToken && !requireAdmin(config, request, reply)) return reply;
    await ensureFixtureSeeded(config, repository, plexClient, seerrClient);
    const body = createRequestSchema.parse(request.body ?? {}) as CreateRequestBody;
    const preview = buildPreview(repository, body);
    if (!preview.canRequest) return reply.code(409).send(preview);
    if (body.confirmed !== true || body.confirmationPhrase !== preview.confirmationPhrase) {
      return reply.code(409).send({
        error: "Request creation requires explicit confirmation.",
        requiredConfirmationPhrase: preview.confirmationPhrase
      });
    }

    const result = await seerrClient.createRequest({
      mediaType: preview.request.mediaType,
      mediaId: preview.request.mediaId,
      seasons: preview.request.seasons
    });
    repository.saveRequest(
      preview.item.id,
      preview.request.mediaType,
      preview.request.mediaId,
      preview.request.seasons,
      String(result.status ?? "created"),
      result.id ? String(result.id) : undefined
    );
    return { ok: true, request: preview.request, seerr: redactSecrets(result, config.knownSecrets) };
  });
}

async function ensureFixtureSeeded(config: AppConfig, repository: MediaRepository, plexClient: PlexClient, seerrClient: SeerrClient) {
  if (!config.fixtureMode || repository.stats().totalItems > 0) return;
  const [plexRecords, seerrRecords] = await Promise.all([plexClient.syncLibrary(), seerrClient.syncRequests()]);
  repository.upsertMany([...plexRecords, ...seerrRecords]);
  repository.recordSync("library", "fixture", "ok", plexRecords.length);
  repository.recordSync("seerr", "fixture", "ok", seerrRecords.length);
}

function buildPreview(repository: MediaRepository, input: PreviewRequest) {
  const item =
    (input.itemId ? repository.findById(input.itemId) : undefined) ??
    repository.list().find((candidate) => candidate.mediaType === input.mediaType && candidate.seerr?.mediaId === input.tmdbId);

  if (!item) {
    throw Object.assign(new Error("Request preview needs a known item or a synced Seerr search result."), { statusCode: 400 });
  }

  const mediaType = input.mediaType ?? item.mediaType;
  const mediaId = input.tmdbId ?? item.seerr?.mediaId;
  const blockedReason = getRequestBlocker(item, mediaType, mediaId, input.seasons);
  return {
    canRequest: !blockedReason,
    blockedReason,
    requiresConfirmation: true as const,
    confirmationPhrase: `REQUEST ${item.title.toUpperCase()}`,
    request: {
      mediaType,
      mediaId: mediaId ?? 0,
      seasons: mediaType === "tv" ? input.seasons : undefined,
      title: item.title
    },
    item
  };
}

function getRequestBlocker(item: { plex?: { available: boolean }; seerr?: { requestable: boolean; requestStatus?: string } }, mediaType: MediaType, mediaId: number | undefined, seasons?: number[]) {
  if (!mediaId) return "A TMDB media ID is required before a Seerr request can be created.";
  if (item.plex?.available) return "Plex already reports this item as available.";
  if (item.seerr?.requestStatus && item.seerr.requestStatus !== "declined") return `Seerr already has request status ${item.seerr.requestStatus}.`;
  if (!item.seerr?.requestable) return "Seerr does not report this item as requestable.";
  if (mediaType === "tv" && (!seasons || seasons.length === 0)) return "TV requests require at least one season selection.";
  return undefined;
}

async function fetchTmdbPoster(posterPath: string) {
  const path = posterPath.replace("tmdb://", "");
  const response = await fetch(`https://image.tmdb.org/t/p/${path}`);
  if (!response.ok) throw new Error(`TMDB poster request returned HTTP ${response.status}.`);
  return {
    contentType: response.headers.get("content-type") ?? "image/jpeg",
    body: Buffer.from(await response.arrayBuffer())
  };
}
