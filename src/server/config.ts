import "dotenv/config";
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { defaultSearchResultLimit, maxSearchResultLimit, openAiReasoningEfforts, type OpenAiReasoningEffort } from "../shared/types";
import { preparePrivateFile } from "./security/filePermissions";
import { normalizeHttpBaseUrl } from "./security/urlPolicy";

export interface PersistedAppSettings {
  fixtureMode?: boolean;
  plex?: {
    baseUrl?: string;
    token?: string;
    webBaseUrl?: string;
  };
  seerr?: {
    baseUrl?: string;
    apiKey?: string;
  };
  ai?: {
    provider?: "none" | "openai";
    openaiApiKey?: string;
    openaiModel?: string;
    openaiEmbeddingModel?: string;
    openaiReasoningEffort?: OpenAiReasoningEffort;
  };
  sync?: {
    intervalMinutes?: number;
    syncSeerr?: boolean;
  };
  search?: {
    defaultResultLimit?: number;
  };
  reviewQueue?: {
    retentionDays?: number;
    maxQueries?: number;
    captureRawQueries?: boolean;
  };
  plexAuth?: {
    enabled?: boolean;
    allowNewUsers?: boolean;
    clientIdentifier?: string;
    productName?: string;
  };
}

export interface AppConfig {
  fixtureMode: boolean;
  dataDir: string;
  configPath: string;
  dbPath: string;
  apiPort: number;
  apiHost: string;
  webOrigin: string;
  serveClient: boolean;
  adminToken?: string;
  requireAdminToken: boolean;
  adminAutoSession: boolean;
  plexAuth: {
    enabled: boolean;
    allowNewUsers: boolean;
    clientIdentifier: string;
    productName: string;
  };
  plex: {
    baseUrl?: string;
    token?: string;
    webBaseUrl: string;
  };
  seerr: {
    baseUrl?: string;
    apiKey?: string;
  };
  ai: {
    provider: "none" | "openai";
    openaiApiKey?: string;
    openaiModel: string;
    openaiEmbeddingModel: string;
    openaiReasoningEffort: OpenAiReasoningEffort;
  };
  sync: {
    intervalMinutes: number;
    syncSeerr: boolean;
  };
  search: {
    defaultResultLimit: number;
  };
  reviewQueue: {
    retentionDays: number;
    maxQueries: number;
    captureRawQueries: boolean;
  };
  knownSecrets: string[];
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function parsePort(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = resolve(optional(env.MOODARR_DATA_DIR) ?? ".data");
  const configPath = resolve(optional(env.MOODARR_CONFIG_PATH) ?? `${dataDir}/config.json`);
  preparePrivateFile(configPath);
  const persisted = loadPersistedSettings(configPath);
  const plexBaseUrl = normalizeHttpBaseUrl(optional(env.PLEX_BASE_URL) ?? optional(persisted.plex?.baseUrl), "Plex base URL");
  const plexToken = optional(env.PLEX_TOKEN) ?? optional(persisted.plex?.token);
  const seerrBaseUrl = normalizeHttpBaseUrl(optional(env.SEERR_BASE_URL) ?? optional(persisted.seerr?.baseUrl), "Seerr base URL");
  const seerrApiKey = optional(env.SEERR_API_KEY) ?? optional(persisted.seerr?.apiKey);
  const openaiApiKey = optional(env.OPENAI_API_KEY) ?? optional(persisted.ai?.openaiApiKey);
  const openaiModel = optional(env.OPENAI_MODEL) ?? optional(persisted.ai?.openaiModel) ?? "gpt-5.5";
  const openaiEmbeddingModel = optional(env.OPENAI_EMBEDDING_MODEL) ?? optional(persisted.ai?.openaiEmbeddingModel) ?? "text-embedding-3-large";
  const openaiReasoningEffort = parseOpenAiReasoningEffort(optional(env.OPENAI_REASONING_EFFORT) ?? optional(persisted.ai?.openaiReasoningEffort), openaiModel);
  const inferredFixtureMode = !(plexBaseUrl && plexToken && seerrBaseUrl && seerrApiKey);
  const requestedProvider = optional(env.AI_PROVIDER) ?? persisted.ai?.provider;
  const provider = requestedProvider === "openai" && openaiApiKey ? "openai" : "none";
  const adminToken = optional(env.MOODARR_ADMIN_TOKEN);
  const requireAdminAuth = env.MOODARR_REQUIRE_ADMIN_TOKEN ?? env.MOODARR_ADMIN_AUTH_REQUIRED;
  const explicitDbPath = optional(env.MOODARR_DB_PATH);
  const defaultDbPath = `${dataDir}/moodarr.sqlite`;
  const fixtureMode = parseBool(env.MOODARR_FIXTURE_MODE, persisted.fixtureMode ?? inferredFixtureMode);
  const apiHost = optional(env.MOODARR_API_HOST) ?? "127.0.0.1";
  const webOrigin = normalizeHttpBaseUrl(optional(env.MOODARR_WEB_ORIGIN) ?? "http://127.0.0.1:5173", "Moodarr web origin")!;
  const requireAdminToken = parseBool(requireAdminAuth, env.NODE_ENV === "production");
  const serveClient = parseBool(env.MOODARR_SERVE_CLIENT, env.NODE_ENV === "production");
  const adminAutoSession = parseBool(env.MOODARR_ADMIN_AUTO_SESSION, false);
  const plexAuthEnabled = parseBool(env.MOODARR_PLEX_AUTH_ENABLED, persisted.plexAuth?.enabled ?? false);
  const plexAuthAllowNewUsers = parseBool(env.MOODARR_PLEX_AUTH_ALLOW_NEW_USERS, persisted.plexAuth?.allowNewUsers ?? true);
  const plexAuthProductName = optional(env.MOODARR_PLEX_AUTH_PRODUCT_NAME) ?? optional(persisted.plexAuth?.productName) ?? "Moodarr";
  const plexAuthClientIdentifier =
    optional(env.MOODARR_PLEX_AUTH_CLIENT_ID) ?? optional(persisted.plexAuth?.clientIdentifier) ?? defaultPlexAuthClientIdentifier(configPath);
  validateAuthBoundary({ apiHost, fixtureMode, requireAdminToken });

  const knownSecrets = [plexToken, seerrApiKey, openaiApiKey, adminToken].filter((value): value is string => Boolean(value));

  return {
    fixtureMode,
    dataDir,
    configPath,
    dbPath: resolve(explicitDbPath ?? defaultDbPath),
    apiPort: parsePort(env.MOODARR_API_PORT, 4401),
    apiHost,
    webOrigin,
    serveClient,
    adminToken,
    requireAdminToken,
    adminAutoSession,
    plexAuth: {
      enabled: plexAuthEnabled,
      allowNewUsers: plexAuthAllowNewUsers,
      clientIdentifier: plexAuthClientIdentifier,
      productName: plexAuthProductName
    },
    plex: {
      baseUrl: plexBaseUrl,
      token: plexToken,
      webBaseUrl: normalizeHttpBaseUrl(optional(env.PLEX_WEB_BASE_URL) ?? optional(persisted.plex?.webBaseUrl) ?? "https://app.plex.tv/desktop", "Plex web URL")!
    },
    seerr: {
      baseUrl: seerrBaseUrl,
      apiKey: seerrApiKey
    },
    ai: {
      provider,
      openaiApiKey,
      openaiModel,
      openaiEmbeddingModel,
      openaiReasoningEffort
    },
    sync: {
      intervalMinutes: parsePositiveInteger(env.MOODARR_SYNC_INTERVAL_MINUTES, persisted.sync?.intervalMinutes ?? 360),
      syncSeerr: parseBool(env.MOODARR_SYNC_SEERR, persisted.sync?.syncSeerr ?? true)
    },
    search: {
      defaultResultLimit: parseResultLimit(env.MOODARR_DEFAULT_RESULT_LIMIT, persisted.search?.defaultResultLimit ?? defaultSearchResultLimit)
    },
    reviewQueue: {
      retentionDays: Math.max(1, parsePositiveInteger(env.MOODARR_REVIEW_RETENTION_DAYS, persisted.reviewQueue?.retentionDays ?? 90)),
      maxQueries: Math.max(1, parsePositiveInteger(env.MOODARR_REVIEW_MAX_QUERIES, persisted.reviewQueue?.maxQueries ?? 500)),
      captureRawQueries: parseBool(env.MOODARR_REVIEW_CAPTURE_RAW_QUERIES, persisted.reviewQueue?.captureRawQueries ?? false)
    },
    knownSecrets
  };
}

export function getPublicConfigStatus(config: AppConfig) {
  return {
    fixtureMode: config.fixtureMode,
    plex: {
      configured: Boolean(config.plex.baseUrl && config.plex.token),
      baseUrlConfigured: Boolean(config.plex.baseUrl)
    },
    seerr: {
      configured: Boolean(config.seerr.baseUrl && config.seerr.apiKey),
      baseUrlConfigured: Boolean(config.seerr.baseUrl)
    },
    ai: {
      provider: config.ai.provider,
      configured: config.ai.provider === "openai" && Boolean(config.ai.openaiApiKey),
      openaiModel: config.ai.openaiModel,
      openaiEmbeddingModel: config.ai.openaiEmbeddingModel,
      openaiReasoningEffort: config.ai.openaiReasoningEffort
    },
    admin: {
      authRequired: config.requireAdminToken,
      configured: Boolean(config.adminToken),
      autoSession: config.adminAutoSession
    },
    auth: {
      plexAuthEnabled: config.plexAuth.enabled,
      allowNewPlexUsers: config.plexAuth.allowNewUsers
    },
    runtime: {
      serveClient: config.serveClient,
      syncIntervalMinutes: config.sync.intervalMinutes,
      syncSeerr: config.sync.syncSeerr,
      defaultResultLimit: config.search.defaultResultLimit
    }
  };
}

function defaultPlexAuthClientIdentifier(configPath: string) {
  return `moodarr-${crypto.createHash("sha256").update(configPath).digest("hex").slice(0, 32)}`;
}

export function loadPersistedSettings(configPath: string): PersistedAppSettings {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as PersistedAppSettings;
  } catch (error) {
    throw new Error(`Moodarr settings at ${configPath} could not be read or parsed. The original file was preserved.`, { cause: error });
  }
}

export function getConfigDir(config: AppConfig) {
  return dirname(config.configPath);
}

function validateAuthBoundary(input: { apiHost: string; fixtureMode: boolean; requireAdminToken: boolean }) {
  if (input.requireAdminToken) return;
  if (!input.fixtureMode) {
    throw new Error("MOODARR_REQUIRE_ADMIN_TOKEN=true is required when fixture mode is off.");
  }
  if (!isLoopbackHost(input.apiHost)) {
    throw new Error("MOODARR_REQUIRE_ADMIN_TOKEN=true is required when binding outside loopback.");
  }
}

function isLoopbackHost(value: string) {
  const host = value.trim().toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function defaultOpenAiReasoningEffort(model: string): OpenAiReasoningEffort {
  return model.trim().toLowerCase().startsWith("gpt-5.5") ? "low" : "none";
}

export function parseOpenAiReasoningEffort(value: string | undefined, model: string): OpenAiReasoningEffort {
  const normalized = value?.trim().toLowerCase();
  if (openAiReasoningEfforts.includes(normalized as OpenAiReasoningEffort)) return normalized as OpenAiReasoningEffort;
  return defaultOpenAiReasoningEffort(model);
}

export function parseResultLimit(value: string | number | undefined, fallback: number): number {
  const parsed = typeof value === "number" ? value : Number(value);
  const candidate = Number.isInteger(parsed) ? parsed : fallback;
  return Math.max(1, Math.min(maxSearchResultLimit, candidate));
}
