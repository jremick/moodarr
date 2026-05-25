import { mkdirSync, writeFileSync } from "node:fs";
import type { AdminSettings, AdminSettingsUpdate } from "../../shared/types";
import type { AppConfig, PersistedAppSettings } from "../config";
import { getConfigDir, loadPersistedSettings } from "../config";

export function getAdminSettings(config: AppConfig): AdminSettings {
  return {
    fixtureMode: config.fixtureMode,
    plex: {
      baseUrl: config.plex.baseUrl,
      webBaseUrl: config.plex.webBaseUrl,
      tokenConfigured: Boolean(config.plex.token)
    },
    seerr: {
      baseUrl: config.seerr.baseUrl,
      apiKeyConfigured: Boolean(config.seerr.apiKey)
    },
    ai: {
      provider: config.ai.provider,
      openaiModel: config.ai.openaiModel,
      openaiApiKeyConfigured: Boolean(config.ai.openaiApiKey)
    },
    sync: {
      intervalMinutes: config.sync.intervalMinutes,
      syncSeerr: config.sync.syncSeerr
    }
  };
}

export function updateAdminSettings(config: AppConfig, update: AdminSettingsUpdate): AdminSettings {
  validatePlexAuth(config, update);
  const persisted = loadPersistedSettings(config.configPath);
  const next: PersistedAppSettings = {
    ...persisted,
    plex: { ...persisted.plex },
    seerr: { ...persisted.seerr },
    ai: { ...persisted.ai },
    sync: { ...persisted.sync }
  };

  if (typeof update.fixtureMode === "boolean") {
    next.fixtureMode = update.fixtureMode;
    config.fixtureMode = update.fixtureMode;
  }

  if (update.plex) {
    if (update.plex.baseUrl !== undefined) next.plex = { ...next.plex, baseUrl: emptyToUndefined(update.plex.baseUrl) };
    if (update.plex.webBaseUrl !== undefined) next.plex = { ...next.plex, webBaseUrl: emptyToUndefined(update.plex.webBaseUrl) };
    if (update.plex.clearToken) next.plex = { ...next.plex, token: undefined };
    if (update.plex.token) next.plex = { ...next.plex, token: update.plex.token };
    config.plex.baseUrl = next.plex?.baseUrl;
    config.plex.webBaseUrl = next.plex?.webBaseUrl ?? "https://app.plex.tv/desktop";
    config.plex.token = next.plex?.token;
  }

  if (update.seerr) {
    if (update.seerr.baseUrl !== undefined) next.seerr = { ...next.seerr, baseUrl: emptyToUndefined(update.seerr.baseUrl) };
    if (update.seerr.clearApiKey) next.seerr = { ...next.seerr, apiKey: undefined };
    if (update.seerr.apiKey) next.seerr = { ...next.seerr, apiKey: update.seerr.apiKey };
    config.seerr.baseUrl = next.seerr?.baseUrl;
    config.seerr.apiKey = next.seerr?.apiKey;
  }

  if (update.ai) {
    if (update.ai.provider) next.ai = { ...next.ai, provider: update.ai.provider };
    if (update.ai.openaiModel !== undefined) next.ai = { ...next.ai, openaiModel: emptyToUndefined(update.ai.openaiModel) };
    if (update.ai.clearOpenaiApiKey) next.ai = { ...next.ai, openaiApiKey: undefined };
    if (update.ai.openaiApiKey) next.ai = { ...next.ai, openaiApiKey: update.ai.openaiApiKey };
    config.ai.openaiApiKey = next.ai?.openaiApiKey;
    config.ai.openaiModel = next.ai?.openaiModel ?? "gpt-5-mini";
    config.ai.provider = next.ai?.provider === "openai" && config.ai.openaiApiKey ? "openai" : "none";
  }

  if (update.sync) {
    if (update.sync.intervalMinutes !== undefined) next.sync = { ...next.sync, intervalMinutes: update.sync.intervalMinutes };
    if (update.sync.syncSeerr !== undefined) next.sync = { ...next.sync, syncSeerr: update.sync.syncSeerr };
    config.sync.intervalMinutes = next.sync?.intervalMinutes ?? config.sync.intervalMinutes;
    config.sync.syncSeerr = next.sync?.syncSeerr ?? config.sync.syncSeerr;
  }

  config.knownSecrets = [config.plex.token, config.seerr.apiKey, config.ai.openaiApiKey, config.adminToken].filter(
    (value): value is string => Boolean(value)
  );

  mkdirSync(getConfigDir(config), { recursive: true });
  writeFileSync(config.configPath, JSON.stringify(stripUndefined(next), null, 2));
  return getAdminSettings(config);
}

function validatePlexAuth(config: AppConfig, update: AdminSettingsUpdate) {
  const fixtureMode = typeof update.fixtureMode === "boolean" ? update.fixtureMode : config.fixtureMode;
  const plexBaseUrl = update.plex?.baseUrl !== undefined ? emptyToUndefined(update.plex.baseUrl) : config.plex.baseUrl;
  const plexToken = update.plex?.clearToken ? undefined : update.plex?.token ? update.plex.token : config.plex.token;

  if (!fixtureMode && (!plexBaseUrl || !plexToken)) {
    throw Object.assign(new Error("Plex base URL and Plex token are required when fixture mode is off."), { statusCode: 400 });
  }
}

function emptyToUndefined(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefined) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== undefined)
        .map(([key, entry]) => [key, stripUndefined(entry)])
    ) as T;
  }
  return value;
}
