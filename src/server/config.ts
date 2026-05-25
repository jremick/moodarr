import "dotenv/config";
import { resolve } from "node:path";

export interface AppConfig {
  fixtureMode: boolean;
  dbPath: string;
  apiPort: number;
  webOrigin: string;
  serveClient: boolean;
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

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const plexBaseUrl = optional(env.PLEX_BASE_URL);
  const plexToken = optional(env.PLEX_TOKEN);
  const seerrBaseUrl = optional(env.SEERR_BASE_URL);
  const seerrApiKey = optional(env.SEERR_API_KEY);
  const openaiApiKey = optional(env.OPENAI_API_KEY);
  const inferredFixtureMode = !(plexBaseUrl && plexToken && seerrBaseUrl && seerrApiKey);
  const provider = optional(env.AI_PROVIDER) === "openai" && openaiApiKey ? "openai" : "none";

  const knownSecrets = [plexToken, seerrApiKey, openaiApiKey].filter((value): value is string => Boolean(value));

  return {
    fixtureMode: parseBool(env.FEELERR_FIXTURE_MODE, inferredFixtureMode),
    dbPath: resolve(optional(env.FEELERR_DB_PATH) ?? ".data/feelerr.sqlite"),
    apiPort: parsePort(env.FEELERR_API_PORT, 4401),
    webOrigin: optional(env.FEELERR_WEB_ORIGIN) ?? "http://127.0.0.1:5173",
    serveClient: parseBool(env.FEELERR_SERVE_CLIENT, false),
    plex: {
      baseUrl: plexBaseUrl,
      token: plexToken,
      webBaseUrl: optional(env.PLEX_WEB_BASE_URL) ?? "https://app.plex.tv/desktop"
    },
    seerr: {
      baseUrl: seerrBaseUrl,
      apiKey: seerrApiKey
    },
    ai: {
      provider,
      openaiApiKey,
      openaiModel: optional(env.OPENAI_MODEL) ?? "gpt-5-mini"
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
      configured: config.ai.provider === "openai" && Boolean(config.ai.openaiApiKey)
    }
  };
}
