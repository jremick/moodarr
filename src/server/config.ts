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

function envValue(env: NodeJS.ProcessEnv, primary: string, legacy?: string): string | undefined {
  return optional(env[primary]) ?? (legacy ? optional(env[legacy]) : undefined);
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
  const dataDir = resolve(envValue(env, "MOODARR_DATA_DIR", "FEELERR_DATA_DIR") ?? ".data");
  const configPath = resolve(envValue(env, "MOODARR_CONFIG_PATH", "FEELERR_CONFIG_PATH") ?? `${dataDir}/config.json`);
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
  const adminToken = envValue(env, "MOODARR_ADMIN_TOKEN", "FEELERR_ADMIN_TOKEN");
  const requireAdminAuth = env.MOODARR_REQUIRE_ADMIN_TOKEN ?? env.MOODARR_ADMIN_AUTH_REQUIRED ?? env.FEELERR_REQUIRE_ADMIN_TOKEN ?? env.FEELERR_ADMIN_AUTH_REQUIRED;
  const explicitDbPath = envValue(env, "MOODARR_DB_PATH", "FEELERR_DB_PATH");
  const defaultDbPath = existingLegacyDbPath(dataDir) ?? `${dataDir}/moodarr.sqlite`;

  const knownSecrets = [plexToken, seerrApiKey, openaiApiKey, adminToken].filter((value): value is string => Boolean(value));

  return {
    fixtureMode: parseBool(env.MOODARR_FIXTURE_MODE ?? env.FEELERR_FIXTURE_MODE, persisted.fixtureMode ?? inferredFixtureMode),
    dataDir,
    configPath,
    dbPath: resolve(explicitDbPath ?? defaultDbPath),
    apiPort: parsePort(env.MOODARR_API_PORT ?? env.FEELERR_API_PORT, 4401),
    apiHost: envValue(env, "MOODARR_API_HOST", "FEELERR_API_HOST") ?? "127.0.0.1",
    webOrigin: envValue(env, "MOODARR_WEB_ORIGIN", "FEELERR_WEB_ORIGIN") ?? "http://127.0.0.1:5173",
    serveClient: parseBool(env.MOODARR_SERVE_CLIENT ?? env.FEELERR_SERVE_CLIENT, env.NODE_ENV === "production"),
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
      intervalMinutes: parsePositiveInteger(env.MOODARR_SYNC_INTERVAL_MINUTES ?? env.FEELERR_SYNC_INTERVAL_MINUTES, persisted.sync?.intervalMinutes ?? 360),
      syncSeerr: parseBool(env.MOODARR_SYNC_SEERR ?? env.FEELERR_SYNC_SEERR, persisted.sync?.syncSeerr ?? true)
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

function existingLegacyDbPath(dataDir: string) {
  const legacyPath = `${dataDir}/feelerr.sqlite`;
  const moodarrPath = `${dataDir}/moodarr.sqlite`;
  if (existsSync(legacyPath) && !existsSync(moodarrPath)) return legacyPath;
  return undefined;
}
