import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

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
  };
  sync?: {
    intervalMinutes?: number;
    syncSeerr?: boolean;
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
  };
  sync: {
    intervalMinutes: number;
    syncSeerr: boolean;
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
  const dataDir = resolve(optional(env.FEELERR_DATA_DIR) ?? ".data");
  const configPath = resolve(optional(env.FEELERR_CONFIG_PATH) ?? `${dataDir}/config.json`);
  const persisted = loadPersistedSettings(configPath);
  const plexBaseUrl = optional(env.PLEX_BASE_URL) ?? optional(persisted.plex?.baseUrl);
  const plexToken = optional(env.PLEX_TOKEN) ?? optional(persisted.plex?.token);
  const seerrBaseUrl = optional(env.SEERR_BASE_URL) ?? optional(persisted.seerr?.baseUrl);
  const seerrApiKey = optional(env.SEERR_API_KEY) ?? optional(persisted.seerr?.apiKey);
  const openaiApiKey = optional(env.OPENAI_API_KEY) ?? optional(persisted.ai?.openaiApiKey);
  const openaiEmbeddingModel = optional(env.OPENAI_EMBEDDING_MODEL) ?? optional(persisted.ai?.openaiEmbeddingModel) ?? "text-embedding-3-large";
  const inferredFixtureMode = !(plexBaseUrl && plexToken && seerrBaseUrl && seerrApiKey);
  const requestedProvider = optional(env.AI_PROVIDER) ?? persisted.ai?.provider;
  const provider = requestedProvider === "openai" && openaiApiKey ? "openai" : "none";
  const adminToken = optional(env.FEELERR_ADMIN_TOKEN);
  const requireAdminAuth = env.FEELERR_REQUIRE_ADMIN_TOKEN ?? env.FEELERR_ADMIN_AUTH_REQUIRED;

  const knownSecrets = [plexToken, seerrApiKey, openaiApiKey, adminToken].filter((value): value is string => Boolean(value));

  return {
    fixtureMode: parseBool(env.FEELERR_FIXTURE_MODE, persisted.fixtureMode ?? inferredFixtureMode),
    dataDir,
    configPath,
    dbPath: resolve(optional(env.FEELERR_DB_PATH) ?? `${dataDir}/feelerr.sqlite`),
    apiPort: parsePort(env.FEELERR_API_PORT, 4401),
    apiHost: optional(env.FEELERR_API_HOST) ?? "127.0.0.1",
    webOrigin: optional(env.FEELERR_WEB_ORIGIN) ?? "http://127.0.0.1:5173",
    serveClient: parseBool(env.FEELERR_SERVE_CLIENT, env.NODE_ENV === "production"),
    adminToken,
    requireAdminToken: parseBool(requireAdminAuth, env.NODE_ENV === "production"),
    plex: {
      baseUrl: plexBaseUrl,
      token: plexToken,
      webBaseUrl: optional(env.PLEX_WEB_BASE_URL) ?? optional(persisted.plex?.webBaseUrl) ?? "https://app.plex.tv/desktop"
    },
    seerr: {
      baseUrl: seerrBaseUrl,
      apiKey: seerrApiKey
    },
    ai: {
      provider,
      openaiApiKey,
      openaiModel: optional(env.OPENAI_MODEL) ?? optional(persisted.ai?.openaiModel) ?? "gpt-5.5",
      openaiEmbeddingModel
    },
    sync: {
      intervalMinutes: parsePositiveInteger(env.FEELERR_SYNC_INTERVAL_MINUTES, persisted.sync?.intervalMinutes ?? 360),
      syncSeerr: parseBool(env.FEELERR_SYNC_SEERR, persisted.sync?.syncSeerr ?? true)
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
      openaiEmbeddingModel: config.ai.openaiEmbeddingModel
    },
    admin: {
      authRequired: config.requireAdminToken,
      configured: Boolean(config.adminToken)
    },
    runtime: {
      dataDir: config.dataDir,
      configPath: config.configPath,
      dbPath: config.dbPath,
      serveClient: config.serveClient,
      syncIntervalMinutes: config.sync.intervalMinutes,
      syncSeerr: config.sync.syncSeerr
    }
  };
}

export function loadPersistedSettings(configPath: string): PersistedAppSettings {
  if (!existsSync(configPath)) return {};
  try {
    return JSON.parse(readFileSync(configPath, "utf8")) as PersistedAppSettings;
  } catch {
    return {};
  }
}

export function getConfigDir(config: AppConfig) {
  return dirname(config.configPath);
}
