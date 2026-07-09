import cors from "@fastify/cors";
import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import staticPlugin from "@fastify/static";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  adminTokenIsValid,
  adminSessionIsLocked,
  attachAdminSessionCookie,
  attachExplicitAdminSessionCookie,
  clearAdminSessionCookie,
  isAdminAuthenticated,
  parseCookie,
  requireAdmin
} from "./admin/auth";
import { getAdminSettings, updateAdminSettings } from "./admin/configStore";
import type { AppConfig } from "./config";
import { getPublicConfigStatus, loadConfig } from "./config";
import { UserRepository, userSessionCookieName } from "./auth/userRepository";
import { PlexAuthChallengeRepository } from "./auth/plexAuthChallengeRepository";
import { createBriefParser } from "./ai/briefParser";
import { createEmbeddingProvider } from "./ai/embeddings";
import { createQueryOptimizer } from "./ai/queryOptimizer";
import { createRanker } from "./ai/ranker";
import { createTasteScout } from "./ai/tasteScout";
import { createDatabase, type SqliteDatabase } from "./db/database";
import { MediaRepository } from "./db/mediaRepository";
import { fixturePosterSvg } from "./fixtures/media";
import { PlexAuthClient } from "./integrations/plexAuthClient";
import { PlexClient } from "./integrations/plexClient";
import { SeerrClient } from "./integrations/seerrClient";
import { SyncScheduler } from "./jobs/syncScheduler";
import { warmProviderEmbeddings } from "./recommendation/embeddingWarmup";
import { SearchService } from "./search/searchService";
import { isSafePosterContentType, maxPosterBytes, readSafePoster, timeoutSignal } from "./security/http";
import { redactSecrets, safeErrorMessage } from "./security/redact";
import { getRuntimeInfo } from "./runtimeInfo";
import {
  feelFeedbackActions,
  feelFeedbackSources,
  openAiReasoningEfforts,
  type AuthUser,
  type CreateRequestBody,
  type FeelFeedbackRequest,
  type MediaType,
  type PreviewRequest,
  type SearchRequest
} from "../shared/types";

interface CreateAppOptions {
  config?: AppConfig;
  db?: SqliteDatabase;
}

const searchSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  useAi: z.boolean().optional(),
  resultLimit: z.number().int().min(1).max(200).optional(),
  watchContext: z.enum(["solo", "group"]).optional(),
  filters: z
    .object({
      mediaTypes: z.array(z.enum(["movie", "tv"])).max(2).optional(),
      minRuntimeMinutes: z.number().int().positive().optional(),
      maxRuntimeMinutes: z.number().int().positive().optional(),
      minYear: z.number().int().optional(),
      maxYear: z.number().int().optional(),
      genres: z.array(z.string().trim().min(1).max(80)).max(24).optional(),
      excludedGenres: z.array(z.string().trim().min(1).max(80)).max(24).optional(),
      contentRating: z.string().trim().max(40).optional(),
      availability: z
        .array(z.enum(["available_in_plex", "not_in_plex_requestable", "already_requested", "partially_available", "unavailable"]))
        .max(5)
        .optional(),
      requestStatus: z.array(z.string().trim().min(1).max(80)).max(12).optional()
    })
    .optional(),
  feedbackContext: z
    .object({
      moreLikeItemIds: z.array(z.string().trim().min(1).max(240)).max(100).optional(),
      preferredExampleItemIds: z.array(z.string().trim().min(1).max(240)).max(100).optional(),
      maybeItemIds: z.array(z.string().trim().min(1).max(240)).max(100).optional(),
      lessLikeItemIds: z.array(z.string().trim().min(1).max(240)).max(100).optional(),
      hiddenItemIds: z.array(z.string().trim().min(1).max(240)).max(500).optional(),
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

const watchlistSchema = z.object({
  itemId: z.string().trim().min(1).max(240)
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
      openaiReasoningEffort: z.enum(openAiReasoningEfforts).optional(),
      clearOpenaiApiKey: z.boolean().optional()
    })
    .optional(),
  sync: z
    .object({
      intervalMinutes: z.number().int().min(0).max(10080).optional(),
      syncSeerr: z.boolean().optional()
    })
    .optional(),
  search: z
    .object({
      defaultResultLimit: z.number().int().min(1).max(200).optional()
    })
    .optional(),
  reviewQueue: z
    .object({
      retentionDays: z.number().int().min(1).max(3650).optional(),
      maxQueries: z.number().int().min(1).max(10000).optional(),
      captureRawQueries: z.boolean().optional()
    })
    .optional(),
  plexAuth: z
    .object({
      enabled: z.boolean().optional(),
      allowNewUsers: z.boolean().optional()
    })
    .optional()
});

const reviewQueueQuerySchema = z.object({
  status: z.enum(["pending", "reviewed", "all"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional()
});

const reviewQueueUpdateSchema = z.object({
  moodFitRating: z.number().int().min(1).max(5),
  moodFeedbackText: z.string().trim().max(1000).optional()
});

const feelFeedbackSchema = z
  .object({
    action: z.enum(feelFeedbackActions),
    source: z.enum(feelFeedbackSources).optional(),
    clientEventId: z.string().trim().min(1).max(120).optional(),
    watchContext: z.enum(["solo", "group"]).optional(),
    sessionId: z.string().trim().min(1).max(240).optional(),
    itemId: z.string().trim().min(1).max(240).optional(),
    comparedItemId: z.string().trim().min(1).max(240).optional(),
    moodTerm: z.string().trim().max(80).optional(),
    reason: z.string().trim().max(240).optional(),
    strength: z.number().int().min(1).max(5).optional(),
    metadata: z
      .record(z.string(), z.union([z.string().max(120), z.number(), z.boolean(), z.null()]))
      .optional()
  })
  .superRefine((value, ctx) => {
    const itemActions = new Set([
      "swipe_right",
      "swipe_left",
      "swipe_skip",
      "open",
      "expand",
      "save",
      "hide",
      "more_like",
      "less_like",
      "right_mood",
      "wrong_mood",
      "request_preview",
      "request_create"
    ]);
    if (itemActions.has(value.action) && !value.itemId) {
      ctx.addIssue({ code: "custom", path: ["itemId"], message: "itemId is required for this feel feedback action." });
    }
    if (value.action === "pairwise_pick" && (!value.itemId || !value.comparedItemId)) {
      ctx.addIssue({ code: "custom", path: ["comparedItemId"], message: "pairwise_pick requires itemId and comparedItemId." });
    }
  });

const feelProfileQuerySchema = z.object({
  watchContext: z.enum(["solo", "group"]).optional(),
  authUserId: z.string().trim().min(1).max(200).optional()
});

const feelProfileResetSchema = z.object({
  watchContext: z.enum(["solo", "group"]).optional(),
  term: z.string().trim().min(1).max(80).optional(),
  authUserId: z.string().trim().min(1).max(200).optional()
});

const feelProfileRollbackSchema = z.object({
  watchContext: z.enum(["solo", "group"]),
  term: z.string().trim().min(1).max(80),
  version: z.number().int().min(1).optional(),
  authUserId: z.string().trim().min(1).max(200).optional()
});

const embeddingWarmupSchema = z.object({
  limit: z.number().int().min(1).max(2000).optional(),
  batchSize: z.number().int().min(1).max(256).optional()
});

const plexAuthStartSchema = z.object({
  returnUrl: z.string().url().max(2000).optional()
});

const plexAuthCompleteSchema = z.object({
  pinId: z.string().trim().min(1).max(80),
  code: z.string().trim().min(1).max(40),
  nativeSession: z.boolean().optional()
});

const plexAuthStateCookieName = "moodarr_plex_auth_state";
const plexAuthStateLifetimeMs = 5 * 60_000;

const adminUserUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  canRequest: z.boolean().optional(),
  canUseAi: z.boolean().optional()
});

const adminSessionSchema = z.object({
  token: z.string().trim().min(1).max(4096)
});

export function createApp(options: CreateAppOptions = {}) {
  const config = options.config ?? loadConfig();
  const ownsDatabase = !options.db;
  const db = options.db ?? createDatabase(config.dbPath);
  const repository = new MediaRepository(db);
  const userRepository = new UserRepository(db);
  const plexAuthChallenges = new PlexAuthChallengeRepository(db);
  if (!config.fixtureMode) repository.purgeFixtureData();
  const plexClient = new PlexClient(config);
  const plexAuthClient = new PlexAuthClient(config);
  const seerrClient = new SeerrClient(config);
  const searchService = { current: createSearchService(config, repository, seerrClient) };
  const scheduler = new SyncScheduler(config, repository, plexClient, seerrClient, () => createEmbeddingProvider(config));

  const app = fastify({
    logger:
      process.env.NODE_ENV === "test"
        ? false
        : {
            redact: [
              "req.headers.authorization",
              "req.headers.x-api-key",
              "req.headers.x-moodarr-admin-token",
              "req.headers.cookie",
              "body.token",
              "body.apiKey",
              "body.code",
              "body.pinId",
              "body.plex.token",
              "body.seerr.apiKey",
              "body.ai.openaiApiKey"
            ]
          }
  });

  app.register(cors, { origin: config.webOrigin });
  registerSecurityHeaders(app, config);
  registerRateLimits(app);
  registerRoutes(app, { config, db, repository, userRepository, plexAuthChallenges, plexClient, plexAuthClient, seerrClient, searchService, scheduler });

  app.addHook("onClose", async () => {
    scheduler.stop();
    if (!ownsDatabase) return;
    try {
      db.close();
    } catch {
      // The database may already be closed after a startup or readiness failure.
    }
  });

  app.setErrorHandler((error, request, reply) => {
    const message = getErrorMessage(error, config.knownSecrets);
    const statusCode = getStatusCode(error);
    request.log.error({ message, statusCode }, "Request failed");
    reply.code(statusCode).send({ error: message });
  });

  if (config.serveClient) {
    const distClient = join(process.cwd(), "dist", "client");
    if (existsSync(distClient)) {
      app.addHook("onRequest", async (request, reply) => {
        if (request.method === "GET" && !request.url.startsWith("/api/")) attachAdminSessionCookie(config, reply, request);
      });
      app.register(staticPlugin, { root: distClient, prefix: "/" });
      app.setNotFoundHandler((request, reply) => {
        if (request.url.startsWith("/api/")) {
          return reply.code(404).send({ error: "Route not found." });
        }
        attachAdminSessionCookie(config, reply, request);
        return reply.type("text/html; charset=utf-8").send(readFileSync(join(distClient, "index.html"), "utf8"));
      });
    }
  }

  if (process.env.NODE_ENV !== "test") scheduler.start();
  return app;
}

function getStatusCode(error: unknown) {
  if (error instanceof z.ZodError) return 400;
  if (typeof error === "object" && error && "statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }
  return 500;
}

function getErrorMessage(error: unknown, knownSecrets: string[] = []) {
  if (error instanceof z.ZodError) {
    return `Invalid request: ${error.issues.map(formatValidationIssue).join("; ")}.`;
  }
  return safeErrorMessage(error, knownSecrets);
}

function formatValidationIssue(issue: z.ZodIssue) {
  const path = issue.path.length ? issue.path.join(".") : "request";
  const maximum = "maximum" in issue && typeof issue.maximum === "number" ? issue.maximum : undefined;
  const origin = "origin" in issue && typeof issue.origin === "string" ? issue.origin : undefined;
  if (issue.code === "too_big" && origin === "string" && maximum) {
    return `${path} must be ${maximum} characters or fewer`;
  }
  if (issue.code === "too_big" && origin === "number" && maximum) {
    return `${path} must be ${maximum} or less`;
  }
  return `${path}: ${issue.message}`;
}

function registerSecurityHeaders(app: FastifyInstance, config: AppConfig) {
  const connectSources = new Set(["'self'", new URL(config.webOrigin).origin]);
  app.addHook("onRequest", async (_request, reply) => {
    reply.header(
      "Content-Security-Policy",
      `default-src 'self'; base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src ${[...connectSources].join(" ")}`
    );
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "same-origin");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  });
}

interface RateLimitRule {
  method: string;
  path: RegExp;
  limit: number;
  windowMs: number;
}

function registerRateLimits(app: FastifyInstance) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const rules: RateLimitRule[] = [
    { method: "POST", path: /^\/api\/search$/, limit: 40, windowMs: 60_000 },
    { method: "POST", path: /^\/api\/feel-feedback$/, limit: 120, windowMs: 60_000 },
    { method: "POST", path: /^\/api\/requests\/(?:preview|create)$/, limit: 20, windowMs: 60_000 },
    { method: "POST", path: /^\/api\/(?:plex|seerr)\/test$/, limit: 20, windowMs: 60_000 },
    { method: "POST", path: /^\/api\/auth\/plex\/(?:start|complete)$/, limit: 12, windowMs: 60_000 },
    { method: "POST", path: /^\/api\/admin\/session$/, limit: 8, windowMs: 60_000 },
    { method: "POST", path: /^\/api\/(?:library|seerr)\/sync$/, limit: 8, windowMs: 60_000 },
    { method: "POST", path: /^\/api\/admin\/sync\/run$/, limit: 8, windowMs: 60_000 }
  ];

  app.addHook("onRequest", async (request, reply) => {
    const rule = rules.find((entry) => entry.method === request.method && entry.path.test(request.url.split("?")[0] ?? request.url));
    if (!rule) return;

    const now = Date.now();
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= now) buckets.delete(key);
    }

    const key = `${request.ip}:${rule.method}:${rule.path.source}`;
    const bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + rule.windowMs });
      return;
    }

    bucket.count += 1;
    if (bucket.count <= rule.limit) return;

    const retryAfter = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));
    return reply.header("Retry-After", String(retryAfter)).code(429).send({ error: "Too many requests. Please wait and retry." });
  });
}

function registerRoutes(
  app: FastifyInstance,
  deps: {
    config: AppConfig;
    db: SqliteDatabase;
    repository: MediaRepository;
    userRepository: UserRepository;
    plexAuthChallenges: PlexAuthChallengeRepository;
    plexClient: PlexClient;
    plexAuthClient: PlexAuthClient;
    seerrClient: SeerrClient;
    searchService: { current: SearchService };
    scheduler: SyncScheduler;
  }
) {
  const { config, db, repository, userRepository, plexAuthChallenges, plexClient, plexAuthClient, seerrClient, searchService, scheduler } = deps;
  const requestCreations = new Map<string, { fingerprint: string; promise: Promise<Record<string, unknown>> }>();

  app.get("/api/health", async (_request, reply) => {
    const runtime = getRuntimeInfo();
    try {
      db.prepare("SELECT 1 AS ready").get();
      return { ok: true, fixtureMode: config.fixtureMode, database: "ok" as const, ...runtime };
    } catch {
      return reply.code(503).send({ ok: false, fixtureMode: config.fixtureMode, database: "error" as const, ...runtime });
    }
  });

  app.get("/api/config/status", async () => getPublicConfigStatus(config));
  app.get("/api/auth/session", async (request) => authSessionResponse(config, userRepository, request));
  app.post("/api/auth/plex/start", async (request, reply) => {
    const body = plexAuthStartSchema.parse(request.body ?? {});
    const pin = await plexAuthClient.createPin(safeReturnUrl(config, request, body.returnUrl));
    const stateToken = crypto.randomBytes(32).toString("base64url");
    const expiresAt = plexAuthChallengeExpiry(pin.expiresAt);
    plexAuthChallenges.save(pin.pinId, {
      code: pin.code,
      stateHash: hashPlexAuthState(stateToken),
      expiresAt
    });
    const maxAge = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
    reply.header(
      "Set-Cookie",
      `${plexAuthStateCookieName}=${encodeURIComponent(stateToken)}; Path=/api/auth/plex; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookieAttribute(config)}`
    );
    return { ok: true as const, ...pin };
  });
  app.post("/api/auth/plex/complete", async (request, reply) => {
    const body = plexAuthCompleteSchema.parse(request.body ?? {});
    if (!config.plexAuth.enabled) {
      throw Object.assign(new Error("Plex sign-in is disabled."), { statusCode: 404 });
    }
    if (!config.plex.baseUrl || !config.plex.token) {
      throw Object.assign(new Error("Plex sign-in requires configured Plex base URL and token."), { statusCode: 503 });
    }
    const challenge = plexAuthChallenges.find(body.pinId);
    const stateToken = parseCookie(request.headers.cookie)[plexAuthStateCookieName];
    if (!challenge || challenge.code !== body.code || !plexAuthStateMatches(challenge.stateHash, stateToken)) {
      return reply.code(400).send({ error: "Plex sign-in challenge is invalid or expired. Start sign-in again." });
    }
    const result = await plexAuthClient.completePin(body.pinId, body.code);
    if (result.pending) return reply.code(202).send({ authenticated: false, pending: true, plexAuthEnabled: config.plexAuth.enabled, allowNewPlexUsers: config.plexAuth.allowNewUsers });
    let user: ReturnType<UserRepository["upsertPlexUser"]>;
    let session: ReturnType<UserRepository["createSession"]>;
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!plexAuthChallenges.consume(body.pinId)) {
        throw Object.assign(new Error("Plex sign-in challenge is invalid or expired. Start sign-in again."), { statusCode: 400 });
      }
      user = userRepository.upsertPlexUser(result.user, config.plexAuth.allowNewUsers, result.token);
      session = userRepository.createSession(user.id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    attachUserSessionCookie(config, reply, session.token, session.expiresAt);
    if (body.nativeSession) {
      return {
        authenticated: true,
        plexAuthEnabled: config.plexAuth.enabled,
        allowNewPlexUsers: config.plexAuth.allowNewUsers,
        user,
        sessionToken: session.token,
        sessionExpiresAt: session.expiresAt
      };
    }
    return { authenticated: true, plexAuthEnabled: config.plexAuth.enabled, allowNewPlexUsers: config.plexAuth.allowNewUsers, user };
  });
  app.post("/api/auth/logout", async (request, reply) => {
    userRepository.revokeSession(userSessionTokenFromRequest(request));
    clearUserSessionCookie(config, reply);
    return { ok: true };
  });
  app.get("/api/admin/session", async (request, reply) => {
    attachAdminSessionCookie(config, reply, request);
    return {
      ok: Boolean(!config.requireAdminToken || isAdminAuthenticated(config, request) || (config.adminAutoSession && !adminSessionIsLocked(request))),
      autoSession: config.adminAutoSession
    };
  });
  app.post("/api/admin/session", async (request, reply) => {
    const body = adminSessionSchema.parse(request.body ?? {});
    if (!adminTokenIsValid(config, body.token)) return reply.code(401).send({ error: "Admin authentication required." });
    attachExplicitAdminSessionCookie(config, reply);
    return { ok: true, autoSession: config.adminAutoSession };
  });
  app.delete("/api/admin/session", async (_request, reply) => {
    clearAdminSessionCookie(config, reply);
    return { ok: true, autoSession: config.adminAutoSession };
  });
  app.get("/api/admin/settings", async (request, reply) => {
    if (!requireStrictAdmin(config, request, reply)) return reply;
    return getAdminSettings(config);
  });

  app.get("/api/admin/users", async (request, reply) => {
    if (!requireStrictAdmin(config, request, reply)) return reply;
    return { users: userRepository.listUsers() };
  });

  app.patch<{ Params: { id: string } }>("/api/admin/users/:id", async (request, reply) => {
    if (!requireStrictAdmin(config, request, reply)) return reply;
    const body = adminUserUpdateSchema.parse(request.body ?? {});
    const user = userRepository.updateUser(decodeURIComponent(request.params.id), body);
    if (!user) return reply.code(404).send({ error: "User not found." });
    return user;
  });

  app.put("/api/admin/settings", async (request, reply) => {
    if (!requireStrictAdmin(config, request, reply)) return reply;
    const body = adminSettingsSchema.parse(request.body ?? {});
    const wasFixtureMode = config.fixtureMode;
    const settings = updateAdminSettings(config, body);
    if (wasFixtureMode && !config.fixtureMode) repository.purgeFixtureData();
    searchService.current = createSearchService(config, repository, seerrClient);
    scheduler.restart();
    return settings;
  });

  app.get("/api/admin/sync/status", async (request, reply) => {
    if (!requireStrictAdmin(config, request, reply)) return reply;
    return scheduler.status();
  });

  app.post("/api/admin/sync/run", async (request, reply) => {
    if (!requireStrictAdmin(config, request, reply)) return reply;
    return scheduler.runOnce();
  });

  app.post("/api/admin/embeddings/warmup", async (request, reply) => {
    if (!requireStrictAdmin(config, request, reply)) return reply;
    const body = embeddingWarmupSchema.parse(request.body ?? {});
    return warmProviderEmbeddings(repository, createEmbeddingProvider(config), body);
  });

  app.get("/api/admin/support-bundle", async (request, reply) => {
    if (!requireStrictAdmin(config, request, reply)) return reply;
    return {
      generatedAt: new Date().toISOString(),
      build: getRuntimeInfo(),
      config: getPublicConfigStatus(config),
      settings: getAdminSettings(config),
      stats: repository.stats(),
      sync: scheduler.status(),
      requests: repository.requestAuditDiagnostics(),
      recommendations: repository.recommendationDiagnostics()
    };
  });

  app.get("/api/admin/recommendations/diagnostics", async (request, reply) => {
    if (!requireStrictAdmin(config, request, reply)) return reply;
    return repository.recommendationDiagnostics();
  });

  app.get("/api/admin/feel-profiles", async (request, reply) => {
    if (!requireStrictAdmin(config, request, reply)) return reply;
    const query = feelProfileQuerySchema.parse(request.query ?? {});
    validateFeelProfileUserScope(userRepository, query.authUserId, query.watchContext, false);
    return query.watchContext ? repository.feelProfile(query.watchContext, query.authUserId) : repository.feelProfiles(query.authUserId);
  });

  app.get("/api/admin/feel-profiles/export", async (request, reply) => {
    if (!requireStrictAdmin(config, request, reply)) return reply;
    const query = feelProfileQuerySchema.pick({ authUserId: true }).parse(request.query ?? {});
    validateFeelProfileUserScope(userRepository, query.authUserId, undefined, false);
    return repository.exportFeelProfiles(20, query.authUserId);
  });

  app.delete("/api/admin/feel-profiles", async (request, reply) => {
    if (!requireStrictAdmin(config, request, reply)) return reply;
    const body = feelProfileResetSchema.parse(request.body ?? {});
    validateFeelProfileUserScope(userRepository, body.authUserId, body.watchContext, true);
    return repository.resetFeelProfile(body.watchContext, body.term, body.authUserId);
  });

  app.post("/api/admin/feel-profiles/rollback", async (request, reply) => {
    if (!requireStrictAdmin(config, request, reply)) return reply;
    const body = feelProfileRollbackSchema.parse(request.body ?? {});
    validateFeelProfileUserScope(userRepository, body.authUserId, body.watchContext, false);
    return repository.rollbackFeelProfileTerm(body.watchContext, body.term, body.version, body.authUserId);
  });

  app.post("/api/plex/test", async (request, reply) => {
    if (!requireConfiguredAdmin(config, request, reply)) return reply;
    const body = connectionTestSchema.parse(request.body ?? {});
    return plexClient.testConnection({ baseUrl: body.baseUrl, token: body.token });
  });

  app.post("/api/seerr/test", async (request, reply) => {
    if (!requireConfiguredAdmin(config, request, reply)) return reply;
    const body = connectionTestSchema.parse(request.body ?? {});
    return seerrClient.testConnection({ baseUrl: body.baseUrl, apiKey: body.apiKey });
  });

  app.post("/api/library/sync", async (request, reply) => {
    if (!requireConfiguredAdmin(config, request, reply)) return reply;
    const records = await plexClient.syncLibrary();
    const mediaItemIds = repository.upsertMany(records);
    const unavailableCount = repository.markPlexUnavailableExcept(mediaItemIds);
    repository.recordSync("library", config.fixtureMode ? "fixture" : "plex", "ok", records.length);
    return { ok: true, source: config.fixtureMode ? "fixture" : "plex", itemCount: records.length, unavailableCount };
  });

  app.post("/api/seerr/sync", async (request, reply) => {
    if (!requireConfiguredAdmin(config, request, reply)) return reply;
    const records = await seerrClient.syncRequests();
    repository.upsertMany(records);
    repository.recordSync("seerr", config.fixtureMode ? "fixture" : "seerr", "ok", records.length);
    return { ok: true, source: config.fixtureMode ? "fixture" : "seerr", itemCount: records.length };
  });

  app.get("/api/library/stats", async (request, reply) => {
    if (!requireUserAccess(config, userRepository, request, reply)) return reply;
    return repository.stats();
  });

  app.post("/api/search", async (request, reply) => {
    if (!requireUserAccess(config, userRepository, request, reply)) return reply;
    await ensureFixtureSeeded(config, repository, plexClient, seerrClient);
    const body = searchSchema.parse(request.body) as SearchRequest;
    const authUser = requestAuthUser(config, userRepository, request);
    if (authUser && !authUser.canUseAi) body.useAi = false;
    body.resultLimit ??= config.search.defaultResultLimit;
    return searchService.current.search(body, { authUserId: authUser?.id });
  });

  app.get("/api/review-queue", async (request, reply) => {
    if (!requireConfiguredAdmin(config, request, reply)) return reply;
    const query = reviewQueueQuerySchema.parse(request.query ?? {});
    return repository.queryReviewQueue(query.status ?? "pending", query.limit ?? 50);
  });

  app.put<{ Params: { id: string } }>("/api/review-queue/:id", async (request, reply) => {
    if (!requireConfiguredAdmin(config, request, reply)) return reply;
    const body = reviewQueueUpdateSchema.parse(request.body ?? {});
    const item = repository.updateQueryReviewQueueItem(decodeURIComponent(request.params.id), body);
    if (!item) return reply.code(404).send({ error: "Review queue item not found." });
    return item;
  });

  app.post("/api/feel-feedback", async (request, reply) => {
    if (!requireUserAccess(config, userRepository, request, reply)) return reply;
    const body = feelFeedbackSchema.parse(request.body ?? {}) as FeelFeedbackRequest;
    const authUser = requestAuthUser(config, userRepository, request);
    return repository.recordFeelFeedback(body, authUser?.id);
  });

  app.get<{ Params: { id: string } }>("/api/items/:id", async (request, reply) => {
    if (!requireUserAccess(config, userRepository, request, reply)) return reply;
    const item = repository.findById(decodeURIComponent(request.params.id));
    if (!item) return reply.code(404).send({ error: "Item not found." });
    return item;
  });

  app.get<{ Params: { id: string } }>("/api/items/:id/poster", async (request, reply) => {
    if (!requireUserAccess(config, userRepository, request, reply)) return reply;
    const id = decodeURIComponent(request.params.id);
    const item = repository.findById(id);
    if (!item) return reply.code(404).send({ error: "Item not found." });
    const posterPath = repository.getPosterPath(id);
    const cached = repository.getPosterCache(id);
    if (canServeCachedPoster(cached)) {
      return reply.header("Content-Type", cached.contentType).header("Cache-Control", "private, max-age=86400").send(cached.body);
    }
    if (!posterPath?.startsWith("fixture://") && posterPath) {
      try {
        if (posterPath.startsWith("tmdb://")) {
          const image = await fetchTmdbPoster(posterPath);
          cachePoster(repository, id, image);
          return reply.header("Content-Type", image.contentType).send(image.body);
        }
        const image = await plexClient.fetchPoster(posterPath);
        cachePoster(repository, id, image);
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
    if (!requireUserAccess(config, userRepository, request, reply)) return reply;
    await ensureFixtureSeeded(config, repository, plexClient, seerrClient);
    const authUser = requestAuthUser(config, userRepository, request);
    const previewInput = previewSchema.parse(request.body ?? {}) as PreviewRequest;
    const preview = buildPreview(repository, previewInput);
    auditPreview(repository, preview, authUser);
    if (!preview.canRequest) return reply.code(409).send(preview);
    return preview;
  });

  app.post("/api/requests/create", async (request, reply) => {
    if (!requireUserAccess(config, userRepository, request, reply)) return reply;
    await ensureFixtureSeeded(config, repository, plexClient, seerrClient);
    const authUser = requestAuthUser(config, userRepository, request);
    if (authUser && !authUser.canRequest) return reply.code(403).send({ error: "This Moodarr user is not allowed to create requests." });
    const body = createRequestSchema.parse(request.body ?? {}) as CreateRequestBody;
    const operationIdentity = requestCreationIdentity(request, body, authUser);
    const inFlight = requestCreations.get(operationIdentity.key);
    if (inFlight) {
      if (inFlight.fingerprint !== operationIdentity.fingerprint) {
        return reply.code(409).send({ error: "Idempotency key was already used for a different request." });
      }
      return inFlight.promise;
    }
    const existingOperation = repository.requestCreationOperation(operationIdentity.key);
    if (existingOperation && existingOperation.requestFingerprint !== operationIdentity.fingerprint) {
      return reply.code(409).send({ error: "Idempotency key was already used for a different request." });
    }
    if (existingOperation?.status === "created" && existingOperation.response) return existingOperation.response;
    const activeOperation = existingOperation ?? repository.activeRequestCreationOperation(operationIdentity.authScope, operationIdentity.fingerprint);
    const activeOperationKey = activeOperation?.idempotencyKey ?? operationIdentity.key;
    if (activeOperation?.status === "pending") {
      const pendingAgeMs = Date.now() - Date.parse(activeOperation.updatedAt);
      if (Number.isFinite(pendingAgeMs) && pendingAgeMs <= 120_000) {
        return reply.code(409).send({ error: "This request is already being created. Retry shortly." });
      }
      return reconcileRequestCreation(repository, seerrClient, config, activeOperationKey, body, authUser);
    }
    if (activeOperation?.status === "uncertain") {
      return reconcileRequestCreation(repository, seerrClient, config, activeOperationKey, body, authUser);
    }
    const preview = buildPreview(repository, body);
    if (!preview.canRequest) {
      auditCreate(repository, preview, "blocked", preview.blockedReason, undefined, authUser);
      return reply.code(409).send(preview);
    }
    if (body.confirmed !== true || body.confirmationPhrase !== preview.confirmationPhrase) {
      auditCreate(repository, preview, "blocked", "Request creation requires explicit confirmation.", undefined, authUser);
      return reply.code(409).send({
        error: "Request creation requires explicit confirmation.",
        requiredConfirmationPhrase: preview.confirmationPhrase
      });
    }

    const creation = (async (): Promise<Record<string, unknown>> => {
      const acquired = repository.beginRequestCreationOperation(
        operationIdentity.key,
        operationIdentity.fingerprint,
        operationIdentity.authScope,
        preview.item.id
      );
      if (!acquired) {
        const concurrentOperation = repository.requestCreationOperation(operationIdentity.key);
        if (concurrentOperation?.status === "created" && concurrentOperation.response) return concurrentOperation.response;
        const activeOperation = repository.activeRequestCreationOperation(operationIdentity.authScope, operationIdentity.fingerprint);
        if (activeOperation?.status === "uncertain") {
          throw Object.assign(
            new Error("A previous request attempt has an uncertain Seerr outcome. Retry to reconcile it; Moodarr will not resend automatically."),
            { statusCode: 409 }
          );
        }
        throw Object.assign(new Error("This request is already being created. Retry shortly."), { statusCode: 409 });
      }
      let result: Awaited<ReturnType<SeerrClient["createRequest"]>>;
      try {
        result = await seerrClient.createRequest({
          mediaType: preview.request.mediaType,
          mediaId: preview.request.mediaId,
          seasons: preview.request.seasons
        });
      } catch (error) {
        const message = safeErrorMessage(error, config.knownSecrets);
        repository.markRequestCreationOperationUncertain(
          operationIdentity.key,
          `Seerr request outcome requires reconciliation: ${message}`
        );
        auditCreate(repository, preview, "failed", message, undefined, authUser);
        throw Object.assign(
          new Error("Seerr did not return a confirmed request outcome. Moodarr will reconcile before any retry and will not resend automatically."),
          { statusCode: 409 }
        );
      }
      const response = { ok: true, request: preview.request, seerr: redactSecrets(result, config.knownSecrets) };
      repository.saveRequest(
        preview.item.id,
        preview.request.mediaType,
        preview.request.mediaId,
        preview.request.seasons,
        String(result.status ?? "created"),
        result.id ? String(result.id) : undefined
      );
      repository.completeRequestCreationOperation(operationIdentity.key, response);
      auditCreate(repository, preview, "created", undefined, result.id ? String(result.id) : undefined, authUser);
      return response;
    })();
    requestCreations.set(operationIdentity.key, { fingerprint: operationIdentity.fingerprint, promise: creation });
    try {
      return await creation;
    } finally {
      requestCreations.delete(operationIdentity.key);
    }
  });

  app.post("/api/plex/watchlist", async (request, reply) => {
    if (!requireUserAccess(config, userRepository, request, reply)) return reply;
    await ensureFixtureSeeded(config, repository, plexClient, seerrClient);
    const authUser = requestAuthUser(config, userRepository, request);
    if (!authUser) return reply.code(401).send({ error: "Plex sign-in is required for Watchlist actions." });
    const token = userRepository.findPlexTokenForUser(authUser.id);
    if (!token) return reply.code(409).send({ error: "Reconnect Plex before adding items to your Watchlist." });

    const body = watchlistSchema.parse(request.body ?? {});
    const item = repository.findById(body.itemId);
    if (!item) return reply.code(404).send({ error: "Item not found." });
    if (item.availabilityGroup !== "available_in_plex") return reply.code(409).send({ error: "Only available Plex items can be added to Watchlist." });
    const ratingKey = plexDiscoverRatingKey(item);
    if (!ratingKey) return reply.code(409).send({ error: "This item does not have a Plex Discover rating key for Watchlist." });

    const result = await plexAuthClient.addToWatchlist(token, ratingKey);
    return { ok: true, itemId: item.id, alreadyWatchlisted: result.alreadyWatchlisted };
  });
}

function requireStrictAdmin(config: AppConfig, request: FastifyRequest, reply: FastifyReply) {
  return requireAdmin(config, request, reply);
}

function requireConfiguredAdmin(config: AppConfig, request: FastifyRequest, reply: FastifyReply) {
  return !config.requireAdminToken || requireAdmin(config, request, reply);
}

function validateFeelProfileUserScope(
  userRepository: UserRepository,
  authUserId: string | undefined,
  watchContext: "solo" | "group" | undefined,
  requireSoloContext: boolean
) {
  if (!authUserId) return;
  if (!userRepository.findById(authUserId)) {
    throw Object.assign(new Error("Feel Profile user was not found."), { statusCode: 404 });
  }
  if (watchContext === "group") {
    throw Object.assign(new Error("Group Feel Profiles are shared and cannot be scoped to one user."), { statusCode: 400 });
  }
  if (requireSoloContext && watchContext !== "solo") {
    throw Object.assign(new Error("A user-scoped Feel Profile reset must specify watchContext solo."), { statusCode: 400 });
  }
}

function requireUserAccess(config: AppConfig, userRepository: UserRepository, request: FastifyRequest, reply: FastifyReply) {
  if (!config.requireAdminToken || isAdminAuthenticated(config, request)) return true;
  const user = requestAuthUser(config, userRepository, request);
  if (config.plexAuth.enabled && user) return true;
  reply.code(401).send({ error: "Authentication required." });
  return false;
}

function authSessionResponse(config: AppConfig, userRepository: UserRepository, request: FastifyRequest) {
  const user = requestAuthUser(config, userRepository, request);
  return {
    authenticated: Boolean(user),
    plexAuthEnabled: config.plexAuth.enabled,
    allowNewPlexUsers: config.plexAuth.allowNewUsers,
    user
  };
}

function requestAuthUser(config: AppConfig, userRepository: UserRepository, request: FastifyRequest) {
  if (!config.plexAuth.enabled) return undefined;
  return userRepository.findSessionUser(userSessionTokenFromRequest(request));
}

function userSessionTokenFromRequest(request: FastifyRequest) {
  const auth = request.headers.authorization;
  const bearerToken = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
  return bearerToken || parseCookie(request.headers.cookie)[userSessionCookieName];
}

function requestCreationIdentity(request: FastifyRequest, body: CreateRequestBody, authUser?: AuthUser) {
  const header = request.headers["idempotency-key"];
  const clientKey = typeof header === "string" ? header.trim() : undefined;
  if (clientKey && clientKey.length > 200) {
    throw Object.assign(new Error("Idempotency-Key must be 200 characters or fewer."), { statusCode: 400 });
  }
  const authScope = authUser ? `user:${authUser.id}` : "admin";
  const fingerprint = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        itemId: body.itemId ?? null,
        mediaType: body.mediaType ?? null,
        tmdbId: body.tmdbId ?? null,
        seasons: [...new Set(body.seasons ?? [])].sort((left, right) => left - right)
      })
    )
    .digest("hex");
  const key = crypto.createHash("sha256").update(`${authScope}:${clientKey || fingerprint}`).digest("hex");
  return { key, fingerprint, authScope };
}

function attachUserSessionCookie(config: AppConfig, reply: FastifyReply, token: string, expiresAt: string) {
  const maxAge = Math.max(1, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  reply.header(
    "Set-Cookie",
    `${userSessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureCookieAttribute(config)}`
  );
}

function clearUserSessionCookie(config: AppConfig, reply: FastifyReply) {
  reply.header("Set-Cookie", `${userSessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookieAttribute(config)}`);
}

function secureCookieAttribute(config: AppConfig) {
  return new URL(config.webOrigin).protocol === "https:" ? "; Secure" : "";
}

function plexAuthChallengeExpiry(value: string | undefined) {
  const reportedExpiry = value ? Date.parse(value) : Number.NaN;
  const maximumExpiry = Date.now() + plexAuthStateLifetimeMs;
  if (!Number.isFinite(reportedExpiry) || reportedExpiry <= Date.now()) return maximumExpiry;
  return Math.min(reportedExpiry, maximumExpiry);
}

function hashPlexAuthState(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function plexAuthStateMatches(expectedHash: string, stateToken: string | undefined) {
  if (!stateToken) return false;
  const candidateHash = hashPlexAuthState(stateToken);
  const expected = Buffer.from(expectedHash);
  const candidate = Buffer.from(candidateHash);
  return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
}

function safeReturnUrl(config: AppConfig, request: FastifyRequest, candidate: string | undefined) {
  const fallback = `${config.webOrigin.replace(/\/+$/, "")}/`;
  if (!candidate) return fallback;
  try {
    const candidateUrl = new URL(candidate);
    if (candidateUrl.protocol === "moodarr:" && candidateUrl.hostname === "auth" && candidateUrl.pathname === "/plex") return "moodarr://auth/plex";
    if (candidateUrl.origin === new URL(config.webOrigin).origin) return candidateUrl.toString();
    if (["http:", "https:"].includes(candidateUrl.protocol) && request.headers.host && candidateUrl.host === request.headers.host) {
      return candidateUrl.toString();
    }
  } catch {
    // Ignore invalid return URLs and fall back to the configured app origin.
  }
  return fallback;
}

function createSearchService(config: AppConfig, repository: MediaRepository, seerrClient: SeerrClient) {
  return new SearchService(
    repository,
    seerrClient,
    createRanker(config),
    createEmbeddingProvider(config),
    createBriefParser(config),
    createTasteScout(config),
    createQueryOptimizer(config),
    config.reviewQueue
  );
}

async function ensureFixtureSeeded(config: AppConfig, repository: MediaRepository, plexClient: PlexClient, seerrClient: SeerrClient) {
  if (!config.fixtureMode || repository.stats().totalItems > 0) return;
  const [plexRecords, seerrRecords] = await Promise.all([plexClient.syncLibrary(), seerrClient.syncRequests()]);
  repository.upsertMany([...plexRecords, ...seerrRecords]);
  repository.recordSync("library", "fixture", "ok", plexRecords.length);
  repository.recordSync("seerr", "fixture", "ok", seerrRecords.length);
}

async function reconcileRequestCreation(
  repository: MediaRepository,
  seerrClient: SeerrClient,
  config: AppConfig,
  operationKey: string,
  body: CreateRequestBody,
  authUser?: AuthUser
): Promise<Record<string, unknown>> {
  const previousPreview = buildPreview(repository, body);
  try {
    const records = await seerrClient.syncRequests();
    repository.upsertMany(records);
    repository.recordSync("seerr", config.fixtureMode ? "fixture" : "seerr", "ok", records.length);
  } catch (error) {
    const message = safeErrorMessage(error, config.knownSecrets);
    repository.markRequestCreationOperationUncertain(operationKey, `Seerr reconciliation failed: ${message}`);
    auditCreate(repository, previousPreview, "failed", "Seerr reconciliation could not confirm the earlier request.", undefined, authUser);
    throw Object.assign(
      new Error("The earlier Seerr request outcome is uncertain because reconciliation failed. Moodarr will not resend automatically; retry later to reconcile again."),
      { statusCode: 409 }
    );
  }

  const reconciledPreview = buildPreview(repository, body);
  const requestStatus = reconciledPreview.item.seerr?.requestStatus;
  if (requestStatus && requestStatus !== "declined") {
    const response = {
      ok: true,
      reconciled: true,
      request: reconciledPreview.request,
      seerr: { status: requestStatus, reconciled: true }
    };
    repository.saveRequest(
      reconciledPreview.item.id,
      reconciledPreview.request.mediaType,
      reconciledPreview.request.mediaId,
      reconciledPreview.request.seasons,
      requestStatus
    );
    repository.completeRequestCreationOperation(operationKey, response);
    auditCreate(repository, reconciledPreview, "created", "Recovered by Seerr reconciliation.", undefined, authUser);
    return response;
  }

  const message = "Seerr reconciliation did not find a matching accepted request.";
  repository.markRequestCreationOperationUncertain(operationKey, message);
  auditCreate(repository, previousPreview, "failed", message, undefined, authUser);
  throw Object.assign(
    new Error("The earlier Seerr request outcome is uncertain. Moodarr did not resend it; verify in Seerr or retry later to reconcile again."),
    { statusCode: 409 }
  );
}

function buildPreview(repository: MediaRepository, input: PreviewRequest) {
  const item = input.itemId
    ? repository.findById(input.itemId)
    : input.mediaType && input.tmdbId
      ? repository.findByExternalId("tmdb", String(input.tmdbId), input.mediaType)
      : undefined;

  if (!item) {
    throw Object.assign(new Error("Request preview needs a known item or a synced Seerr search result."), { statusCode: 400 });
  }

  const storedMediaId = item.seerr?.mediaId;
  if (input.itemId && input.mediaType && input.mediaType !== item.mediaType) {
    throw Object.assign(new Error("Request media type must match the selected item."), { statusCode: 400 });
  }
  if (input.itemId && input.tmdbId && storedMediaId && input.tmdbId !== storedMediaId) {
    throw Object.assign(new Error("Request media ID must match the selected item."), { statusCode: 400 });
  }
  if (input.itemId && !storedMediaId) {
    throw Object.assign(new Error("Selected item is missing a Seerr media ID and cannot be requested."), { statusCode: 400 });
  }

  const mediaType = item.mediaType;
  const mediaId = storedMediaId ?? input.tmdbId;
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

function plexDiscoverRatingKey(item: ReturnType<MediaRepository["findById"]>) {
  const plexGuid = item?.externalIds.plex;
  if (!plexGuid) return undefined;
  const trimmed = String(plexGuid).trim();
  if (!trimmed) return undefined;
  const lastSegment = trimmed.split("/").filter(Boolean).at(-1);
  return lastSegment && lastSegment !== trimmed ? lastSegment : undefined;
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
  const response = await fetch(`https://image.tmdb.org/t/p/${path}`, { signal: timeoutSignal() });
  if (!response.ok) throw new Error(`TMDB poster request returned HTTP ${response.status}.`);
  return readSafePoster(response);
}

function cachePoster(repository: MediaRepository, mediaItemId: string, image: { contentType: string; body: Buffer }) {
  if (!isSafePosterContentType(image.contentType)) return;
  if (image.body.byteLength > maxPosterBytes) return;
  repository.savePosterCache(mediaItemId, image.contentType, image.body);
}

type PosterCache = NonNullable<ReturnType<MediaRepository["getPosterCache"]>>;

function canServeCachedPoster(cached: ReturnType<MediaRepository["getPosterCache"]>): cached is PosterCache {
  if (!cached) return false;
  return isSafePosterContentType(cached.contentType) && cached.body.byteLength <= maxPosterBytes;
}

function auditPreview(repository: MediaRepository, preview: ReturnType<typeof buildPreview>, authUser?: AuthUser) {
  repository.recordRequestAudit({
    mediaItemId: preview.item.id,
    authUserId: authUser?.id,
    action: "preview",
    status: preview.canRequest ? "allowed" : "blocked",
    mediaType: preview.request.mediaType,
    mediaId: preview.request.mediaId,
    title: preview.request.title,
    seasons: preview.request.seasons,
    blockedReason: preview.blockedReason
  });
}

function auditCreate(
  repository: MediaRepository,
  preview: ReturnType<typeof buildPreview>,
  status: "blocked" | "created" | "failed",
  blockedReason?: string,
  externalRequestId?: string,
  authUser?: AuthUser
) {
  repository.recordRequestAudit({
    mediaItemId: preview.item.id,
    authUserId: authUser?.id,
    action: "create",
    status,
    mediaType: preview.request.mediaType,
    mediaId: preview.request.mediaId,
    title: preview.request.title,
    seasons: preview.request.seasons,
    blockedReason,
    externalRequestId
  });
}
