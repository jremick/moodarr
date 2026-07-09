import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AdminSettings, AdminSettingsUpdate } from "../../shared/types";
import type { AppConfig, PersistedAppSettings } from "../config";
import { defaultOpenAiReasoningEffort, loadPersistedSettings, parseResultLimit } from "../config";
import { ensurePrivateDirectory, repairPrivateFile } from "../security/filePermissions";
import { isSameHttpOrigin, normalizeHttpBaseUrl } from "../security/urlPolicy";

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
      openaiReasoningEffort: config.ai.openaiReasoningEffort,
      openaiApiKeyConfigured: Boolean(config.ai.openaiApiKey)
    },
    sync: {
      intervalMinutes: config.sync.intervalMinutes,
      syncSeerr: config.sync.syncSeerr
    },
    search: {
      defaultResultLimit: config.search.defaultResultLimit
    },
    reviewQueue: {
      retentionDays: config.reviewQueue.retentionDays,
      maxQueries: config.reviewQueue.maxQueries,
      captureRawQueries: config.reviewQueue.captureRawQueries
    },
    plexAuth: {
      enabled: config.plexAuth.enabled,
      allowNewUsers: config.plexAuth.allowNewUsers
    }
  };
}

export function updateAdminSettings(config: AppConfig, update: AdminSettingsUpdate): AdminSettings {
  const persisted = loadPersistedSettings(config.configPath);
  const next = buildPersistedSettings(config, persisted, update);
  validateLiveSettings(config, next, update);
  applyRuntimeSettings(config, next, update);
  persistSettings(config, next);
  return getAdminSettings(config);
}

function buildPersistedSettings(config: AppConfig, persisted: PersistedAppSettings, update: AdminSettingsUpdate): PersistedAppSettings {
  const next: PersistedAppSettings = clonePersistedSettings(persisted);

  if (typeof update.fixtureMode === "boolean") {
    next.fixtureMode = update.fixtureMode;
  }

  if (update.plex) {
    const nextBaseUrl = update.plex.baseUrl !== undefined ? normalizeHttpBaseUrl(update.plex.baseUrl, "Plex base URL") : next.plex?.baseUrl;
    const baseUrlChanged = update.plex.baseUrl !== undefined && !isSameHttpOrigin(nextBaseUrl, config.plex.baseUrl);
    if (update.plex.baseUrl !== undefined) next.plex = { ...next.plex, baseUrl: nextBaseUrl };
    if (update.plex.webBaseUrl !== undefined) next.plex = { ...next.plex, webBaseUrl: normalizeHttpBaseUrl(update.plex.webBaseUrl, "Plex web URL") };
    if (update.plex.clearToken) next.plex = { ...next.plex, token: undefined };
    if (update.plex.token) next.plex = { ...next.plex, token: update.plex.token };
    if (baseUrlChanged && !update.plex.token) next.plex = { ...next.plex, token: undefined };
  }

  if (update.seerr) {
    const nextBaseUrl = update.seerr.baseUrl !== undefined ? normalizeHttpBaseUrl(update.seerr.baseUrl, "Seerr base URL") : next.seerr?.baseUrl;
    const baseUrlChanged = update.seerr.baseUrl !== undefined && !isSameHttpOrigin(nextBaseUrl, config.seerr.baseUrl);
    if (update.seerr.baseUrl !== undefined) next.seerr = { ...next.seerr, baseUrl: nextBaseUrl };
    if (update.seerr.clearApiKey) next.seerr = { ...next.seerr, apiKey: undefined };
    if (update.seerr.apiKey) next.seerr = { ...next.seerr, apiKey: update.seerr.apiKey };
    if (baseUrlChanged && !update.seerr.apiKey) next.seerr = { ...next.seerr, apiKey: undefined };
  }

  if (update.ai) {
    if (update.ai.provider) next.ai = { ...next.ai, provider: update.ai.provider };
    if (update.ai.openaiModel !== undefined) next.ai = { ...next.ai, openaiModel: emptyToUndefined(update.ai.openaiModel) };
    if (update.ai.openaiEmbeddingModel !== undefined) next.ai = { ...next.ai, openaiEmbeddingModel: emptyToUndefined(update.ai.openaiEmbeddingModel) };
    if (update.ai.openaiReasoningEffort !== undefined) next.ai = { ...next.ai, openaiReasoningEffort: update.ai.openaiReasoningEffort };
    if (update.ai.clearOpenaiApiKey) next.ai = { ...next.ai, openaiApiKey: undefined };
    if (update.ai.openaiApiKey) next.ai = { ...next.ai, openaiApiKey: update.ai.openaiApiKey };
  }

  if (update.sync) {
    if (update.sync.intervalMinutes !== undefined) next.sync = { ...next.sync, intervalMinutes: update.sync.intervalMinutes };
    if (update.sync.syncSeerr !== undefined) next.sync = { ...next.sync, syncSeerr: update.sync.syncSeerr };
  }

  if (update.search) {
    if (update.search.defaultResultLimit !== undefined) {
      next.search = { ...next.search, defaultResultLimit: parseResultLimit(update.search.defaultResultLimit, config.search.defaultResultLimit) };
    }
  }

  if (update.reviewQueue) {
    if (update.reviewQueue.retentionDays !== undefined) next.reviewQueue = { ...next.reviewQueue, retentionDays: update.reviewQueue.retentionDays };
    if (update.reviewQueue.maxQueries !== undefined) next.reviewQueue = { ...next.reviewQueue, maxQueries: update.reviewQueue.maxQueries };
    if (update.reviewQueue.captureRawQueries !== undefined) next.reviewQueue = { ...next.reviewQueue, captureRawQueries: update.reviewQueue.captureRawQueries };
  }

  if (update.plexAuth) {
    if (update.plexAuth.enabled !== undefined) next.plexAuth = { ...next.plexAuth, enabled: update.plexAuth.enabled };
    if (update.plexAuth.allowNewUsers !== undefined) next.plexAuth = { ...next.plexAuth, allowNewUsers: update.plexAuth.allowNewUsers };
  }

  return next;
}

function clonePersistedSettings(persisted: PersistedAppSettings): PersistedAppSettings {
  return {
    ...persisted,
    plex: { ...persisted.plex },
    seerr: { ...persisted.seerr },
    ai: { ...persisted.ai },
    sync: { ...persisted.sync },
    search: { ...persisted.search },
    reviewQueue: { ...persisted.reviewQueue },
    plexAuth: { ...persisted.plexAuth }
  };
}

function applyRuntimeSettings(config: AppConfig, next: PersistedAppSettings, update: AdminSettingsUpdate) {
  if (typeof update.fixtureMode === "boolean") config.fixtureMode = update.fixtureMode;

  if (update.plex) {
    config.plex.baseUrl = update.plex.baseUrl !== undefined ? next.plex?.baseUrl : next.plex?.baseUrl ?? config.plex.baseUrl;
    config.plex.webBaseUrl = update.plex.webBaseUrl !== undefined ? next.plex?.webBaseUrl ?? "https://app.plex.tv/desktop" : next.plex?.webBaseUrl ?? config.plex.webBaseUrl;
    config.plex.token = shouldUsePersistedPlexToken(config, update, next) ? next.plex?.token : next.plex?.token ?? config.plex.token;
  }

  if (update.seerr) {
    config.seerr.baseUrl = update.seerr.baseUrl !== undefined ? next.seerr?.baseUrl : next.seerr?.baseUrl ?? config.seerr.baseUrl;
    config.seerr.apiKey = shouldUsePersistedSeerrKey(config, update, next) ? next.seerr?.apiKey : next.seerr?.apiKey ?? config.seerr.apiKey;
  }

  if (update.ai) {
    config.ai.openaiApiKey = update.ai.clearOpenaiApiKey || update.ai.openaiApiKey ? next.ai?.openaiApiKey : next.ai?.openaiApiKey ?? config.ai.openaiApiKey;
    config.ai.openaiModel = update.ai.openaiModel !== undefined ? next.ai?.openaiModel ?? "gpt-5.5" : next.ai?.openaiModel ?? config.ai.openaiModel;
    config.ai.openaiEmbeddingModel =
      update.ai.openaiEmbeddingModel !== undefined ? next.ai?.openaiEmbeddingModel ?? "text-embedding-3-large" : next.ai?.openaiEmbeddingModel ?? config.ai.openaiEmbeddingModel;
    config.ai.openaiReasoningEffort =
      update.ai.openaiReasoningEffort !== undefined
        ? next.ai?.openaiReasoningEffort ?? defaultOpenAiReasoningEffort(config.ai.openaiModel)
        : next.ai?.openaiReasoningEffort ?? config.ai.openaiReasoningEffort;
    const provider = update.ai.provider ?? next.ai?.provider ?? config.ai.provider;
    config.ai.provider = provider === "openai" && config.ai.openaiApiKey ? "openai" : "none";
  }

  if (update.sync) {
    config.sync.intervalMinutes = next.sync?.intervalMinutes ?? config.sync.intervalMinutes;
    config.sync.syncSeerr = next.sync?.syncSeerr ?? config.sync.syncSeerr;
  }

  if (update.search) {
    config.search.defaultResultLimit = next.search?.defaultResultLimit ?? config.search.defaultResultLimit;
  }

  if (update.reviewQueue) {
    config.reviewQueue.retentionDays = next.reviewQueue?.retentionDays ?? config.reviewQueue.retentionDays;
    config.reviewQueue.maxQueries = next.reviewQueue?.maxQueries ?? config.reviewQueue.maxQueries;
    config.reviewQueue.captureRawQueries = next.reviewQueue?.captureRawQueries ?? config.reviewQueue.captureRawQueries;
  }

  if (update.plexAuth) {
    config.plexAuth.enabled = next.plexAuth?.enabled ?? config.plexAuth.enabled;
    config.plexAuth.allowNewUsers = next.plexAuth?.allowNewUsers ?? config.plexAuth.allowNewUsers;
  }

  config.knownSecrets = [config.plex.token, config.seerr.apiKey, config.ai.openaiApiKey, config.adminToken].filter(
    (value): value is string => Boolean(value)
  );
}

function shouldUsePersistedPlexToken(config: AppConfig, update: AdminSettingsUpdate, next: PersistedAppSettings) {
  if (update.plex?.clearToken || update.plex?.token) return true;
  if (update.plex?.baseUrl !== undefined && !isSameHttpOrigin(next.plex?.baseUrl, config.plex.baseUrl)) return true;
  return false;
}

function shouldUsePersistedSeerrKey(config: AppConfig, update: AdminSettingsUpdate, next: PersistedAppSettings) {
  if (update.seerr?.clearApiKey || update.seerr?.apiKey) return true;
  if (update.seerr?.baseUrl !== undefined && !isSameHttpOrigin(next.seerr?.baseUrl, config.seerr.baseUrl)) return true;
  return false;
}

function persistSettings(config: AppConfig, next: PersistedAppSettings) {
  ensurePrivateDirectory(dirname(config.configPath));
  const temporaryPath = `${config.configPath}.tmp-${process.pid}-${Date.now()}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, "wx", 0o600);
    writeFileSync(descriptor, JSON.stringify(stripUndefined(next), null, 2));
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, config.configPath);
    repairPrivateFile(config.configPath);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created or may already have been renamed.
    }
    throw error;
  }
}

function validateLiveSettings(config: AppConfig, next: PersistedAppSettings, update: AdminSettingsUpdate) {
  const fixtureMode = typeof update.fixtureMode === "boolean" ? update.fixtureMode : config.fixtureMode;
  const plexBaseUrl = update.plex?.baseUrl !== undefined ? next.plex?.baseUrl : next.plex?.baseUrl ?? config.plex.baseUrl;
  const plexOriginChanged = update.plex?.baseUrl !== undefined && !isSameHttpOrigin(next.plex?.baseUrl, config.plex.baseUrl);
  const plexToken = update.plex?.clearToken || update.plex?.token || plexOriginChanged ? next.plex?.token : next.plex?.token ?? config.plex.token;
  const seerrBaseUrl = update.seerr?.baseUrl !== undefined ? next.seerr?.baseUrl : next.seerr?.baseUrl ?? config.seerr.baseUrl;
  const seerrOriginChanged = update.seerr?.baseUrl !== undefined && !isSameHttpOrigin(next.seerr?.baseUrl, config.seerr.baseUrl);
  const seerrApiKey = update.seerr?.clearApiKey || update.seerr?.apiKey || seerrOriginChanged ? next.seerr?.apiKey : next.seerr?.apiKey ?? config.seerr.apiKey;

  if (!fixtureMode && (!plexBaseUrl || !plexToken)) {
    throw Object.assign(new Error("Plex base URL and Plex token are required when fixture mode is off."), { statusCode: 400 });
  }
  if (!fixtureMode && (!seerrBaseUrl || !seerrApiKey)) {
    throw Object.assign(new Error("Seerr base URL and Seerr API key are required when fixture mode is off."), { statusCode: 400 });
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
