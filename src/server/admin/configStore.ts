import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
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
      openaiEmbeddingModel: config.ai.openaiEmbeddingModel,
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
    config.plex.baseUrl = update.plex.baseUrl !== undefined ? next.plex?.baseUrl : next.plex?.baseUrl ?? config.plex.baseUrl;
    config.plex.webBaseUrl = update.plex.webBaseUrl !== undefined ? next.plex?.webBaseUrl ?? "https://app.plex.tv/desktop" : next.plex?.webBaseUrl ?? config.plex.webBaseUrl;
    config.plex.token = update.plex.clearToken || update.plex.token ? next.plex?.token : next.plex?.token ?? config.plex.token;
  }

  if (update.seerr) {
    if (update.seerr.baseUrl !== undefined) next.seerr = { ...next.seerr, baseUrl: emptyToUndefined(update.seerr.baseUrl) };
    if (update.seerr.clearApiKey) next.seerr = { ...next.seerr, apiKey: undefined };
    if (update.seerr.apiKey) next.seerr = { ...next.seerr, apiKey: update.seerr.apiKey };
    config.seerr.baseUrl = update.seerr.baseUrl !== undefined ? next.seerr?.baseUrl : next.seerr?.baseUrl ?? config.seerr.baseUrl;
    config.seerr.apiKey = update.seerr.clearApiKey || update.seerr.apiKey ? next.seerr?.apiKey : next.seerr?.apiKey ?? config.seerr.apiKey;
  }

  if (update.ai) {
    if (update.ai.provider) next.ai = { ...next.ai, provider: update.ai.provider };
    if (update.ai.openaiModel !== undefined) next.ai = { ...next.ai, openaiModel: emptyToUndefined(update.ai.openaiModel) };
    if (update.ai.openaiEmbeddingModel !== undefined) next.ai = { ...next.ai, openaiEmbeddingModel: emptyToUndefined(update.ai.openaiEmbeddingModel) };
    if (update.ai.clearOpenaiApiKey) next.ai = { ...next.ai, openaiApiKey: undefined };
    if (update.ai.openaiApiKey) next.ai = { ...next.ai, openaiApiKey: update.ai.openaiApiKey };
    config.ai.openaiApiKey = update.ai.clearOpenaiApiKey || update.ai.openaiApiKey ? next.ai?.openaiApiKey : next.ai?.openaiApiKey ?? config.ai.openaiApiKey;
    config.ai.openaiModel = update.ai.openaiModel !== undefined ? next.ai?.openaiModel ?? "gpt-5.5" : next.ai?.openaiModel ?? config.ai.openaiModel;
    config.ai.openaiEmbeddingModel =
      update.ai.openaiEmbeddingModel !== undefined ? next.ai?.openaiEmbeddingModel ?? "text-embedding-3-large" : next.ai?.openaiEmbeddingModel ?? config.ai.openaiEmbeddingModel;
    const provider = update.ai.provider ?? next.ai?.provider ?? config.ai.provider;
    config.ai.provider = provider === "openai" && config.ai.openaiApiKey ? "openai" : "none";
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

  mkdirSync(getConfigDir(config), { recursive: true, mode: 0o700 });
  try {
    chmodSync(getConfigDir(config), 0o700);
  } catch {
    // Best effort: some host-mounted volumes do not support POSIX mode changes.
  }
  writeFileSync(config.configPath, JSON.stringify(stripUndefined(next), null, 2), { mode: 0o600 });
  try {
    chmodSync(config.configPath, 0o600);
  } catch {
    // Best effort: keep running on filesystems that ignore chmod.
  }
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
