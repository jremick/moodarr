import type {
  AdminSettings,
  AdminSettingsUpdate,
  AuthSessionResponse,
  AuthUser,
  ConfigStatusResponse,
  CreateRequestBody,
  EmbeddingWarmupStatus,
  FeelFeedbackRequest,
  FeelFeedbackResponse,
  FeelProfileExportResponse,
  FeelProfileRollbackResponse,
  FeelProfileResetResponse,
  FeelProfileResponse,
  HealthResponse,
  ItemDetail,
  LibraryStats,
  PreviewRequest,
  QueryReviewQueueResponse,
  QueryReviewStatus,
  QueryReviewUpdate,
  RecommendationDiagnostics,
  RequestPreview,
  PlexAuthCompleteResponse,
  PlexAuthStartResponse,
  SearchRequest,
  SearchResponse,
  SyncRunResult,
  SyncStatus,
  WatchContext
} from "../shared/types";

function authenticatedHeaders(init?: RequestInit) {
  return {
    "Content-Type": "application/json",
    ...init?.headers
  };
}

export const defaultApiTimeoutMs = 30_000;
export const plexAuthCompletionApiTimeoutMs = 45_000;
export const queuedSearchApiTimeoutMs = 60_000;
export const diagnosticsApiTimeoutMs = 60_000;
export const embeddingWarmupApiTimeoutMs = 90_000;
export const unauthorizedApiEvent = "moodarr:unauthorized";

export class MoodarrApiError<T = unknown> extends Error {
  readonly name = "MoodarrApiError";

  constructor(
    message: string,
    readonly status: number,
    readonly body: T | null
  ) {
    super(message);
  }
}

export class MoodarrConnectionError extends Error {
  readonly name = "MoodarrConnectionError";

  constructor(
    message: string,
    readonly kind: "network" | "timeout" | "invalid-response",
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

const maxErrorMessageLength = 320;

async function api<T>(path: string, init?: RequestInit, timeoutMs: number | null = defaultApiTimeoutMs): Promise<T> {
  const callerSignal = init?.signal ?? undefined;
  const requestController = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => requestController.abort(callerSignal?.reason);
  if (callerSignal?.aborted) abortFromCaller();
  else callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = timeoutMs === null
    ? undefined
    : globalThis.setTimeout(() => {
        timedOut = true;
        requestController.abort(new DOMException("Moodarr request timed out.", "TimeoutError"));
      }, timeoutMs);

  try {
    const response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: authenticatedHeaders(init),
      signal: requestController.signal
    });
    const rawBody = await response.text();
    const parsedBody = parseJsonBody(rawBody);
    if (!response.ok) {
      if (response.status === 401 && typeof window !== "undefined") window.dispatchEvent(new Event(unauthorizedApiEvent));
      throw new MoodarrApiError(errorResponseMessage(response.status, parsedBody, rawBody), response.status, parsedBody);
    }
    if (parsedBody === null && rawBody.trim()) {
      throw new MoodarrConnectionError(
        "Moodarr returned an unexpected response. Check the server or proxy and try again.",
        "invalid-response"
      );
    }
    return parsedBody as T;
  } catch (error) {
    if (callerSignal?.aborted) throw callerAbortReason(callerSignal, error);
    if (timedOut) {
      throw new MoodarrConnectionError(
        `Moodarr did not respond within ${Math.ceil((timeoutMs ?? defaultApiTimeoutMs) / 1_000)} seconds. Check the server or network connection and try again.`,
        "timeout",
        { cause: error }
      );
    }
    if (error instanceof MoodarrApiError || error instanceof MoodarrConnectionError) throw error;
    throw new MoodarrConnectionError(
      "Could not reach the Moodarr server. Check the server or network connection and try again.",
      "network",
      { cause: error }
    );
  } finally {
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

function parseJsonBody(rawBody: string): unknown | null {
  if (!rawBody.trim()) return null;
  try {
    return JSON.parse(rawBody) as unknown;
  } catch {
    return null;
  }
}

function errorResponseMessage(status: number, body: unknown, rawBody: string): string {
  const structuredMessage = structuredErrorMessage(body);
  if (structuredMessage) return structuredMessage;
  if (!rawBody.trim()) {
    return `Moodarr request failed (HTTP ${status}). The server returned no error details. Check the server or proxy and try again.`;
  }
  return `Moodarr request failed (HTTP ${status}). The server or proxy returned an unexpected response. Try again or check the Moodarr logs.`;
}

function structuredErrorMessage(body: unknown): string | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const candidate = "error" in body && typeof body.error === "string"
    ? body.error
    : "message" in body && typeof body.message === "string"
      ? body.message
      : "";
  const normalized = candidate.trim();
  if (!normalized || /<\/?[a-z!][^>]*>/i.test(normalized)) return null;
  return normalized.length <= maxErrorMessageLength
    ? normalized
    : `${normalized.slice(0, maxErrorMessageLength - 1).trimEnd()}\u2026`;
}

function callerAbortReason(signal: AbortSignal, fetchError: unknown): unknown {
  if (signal.reason !== undefined) return signal.reason;
  if (fetchError instanceof Error && fetchError.name === "AbortError") return fetchError;
  return new DOMException("The request was aborted.", "AbortError");
}

export const moodarrApi = {
  health: () => api<HealthResponse>("/api/health"),
  adminSession: () => api<{ ok: boolean; autoSession: boolean }>("/api/admin/session"),
  createAdminSession: (token: string) =>
    api<{ ok: boolean; autoSession: boolean }>("/api/admin/session", { method: "POST", body: JSON.stringify({ token }) }),
  lockAdminSession: () => api<{ ok: boolean }>("/api/admin/session", { method: "DELETE", body: "{}" }),
  authSession: () => api<AuthSessionResponse>("/api/auth/session"),
  startPlexAuth: (body: { returnUrl?: string }) => api<PlexAuthStartResponse>("/api/auth/plex/start", { method: "POST", body: JSON.stringify(body) }),
  completePlexAuth: (body: { pinId: string; code: string }) =>
    api<PlexAuthCompleteResponse>("/api/auth/plex/complete", { method: "POST", body: JSON.stringify(body) }, plexAuthCompletionApiTimeoutMs),
  logout: () => api<{ ok: boolean }>("/api/auth/logout", { method: "POST", body: "{}" }),
  configStatus: () => api<ConfigStatusResponse>("/api/config/status"),
  stats: () => api<LibraryStats>("/api/library/stats"),
  testPlex: () => api<{ ok: boolean; message: string }>("/api/plex/test", { method: "POST", body: "{}" }),
  testSeerr: () => api<{ ok: boolean; message: string }>("/api/seerr/test", { method: "POST", body: "{}" }),
  syncLibrary: () => api<SyncRunResult>("/api/library/sync", { method: "POST", body: "{}" }),
  syncSeerr: () => api<SyncRunResult>("/api/seerr/sync", { method: "POST", body: "{}" }),
  search: (body: SearchRequest, signal?: AbortSignal) =>
    api<SearchResponse>("/api/search", { method: "POST", body: JSON.stringify(body), signal }, queuedSearchApiTimeoutMs),
  feelFeedback: (body: FeelFeedbackRequest) => api<FeelFeedbackResponse>("/api/feel-feedback", { method: "POST", body: JSON.stringify(body) }),
  feelProfiles: () => api<Record<WatchContext, FeelProfileResponse>>("/api/admin/feel-profiles"),
  feelProfile: (watchContext: WatchContext, authUserId?: string) =>
    api<FeelProfileResponse>(`/api/admin/feel-profiles?watchContext=${encodeURIComponent(watchContext)}${authUserId ? `&authUserId=${encodeURIComponent(authUserId)}` : ""}`),
  exportFeelProfiles: (authUserId?: string) =>
    api<FeelProfileExportResponse>(`/api/admin/feel-profiles/export${authUserId ? `?authUserId=${encodeURIComponent(authUserId)}` : ""}`),
  resetFeelProfile: (body: { watchContext?: WatchContext; term?: string; authUserId?: string }) =>
    api<FeelProfileResetResponse>("/api/admin/feel-profiles", { method: "DELETE", body: JSON.stringify(body) }),
  rollbackFeelProfile: (body: { watchContext: WatchContext; term: string; version?: number; authUserId?: string }) =>
    api<FeelProfileRollbackResponse>("/api/admin/feel-profiles/rollback", { method: "POST", body: JSON.stringify(body) }),
  reviewQueue: (status: QueryReviewStatus = "pending", limit = 50, signal?: AbortSignal) =>
    api<QueryReviewQueueResponse>(`/api/review-queue?status=${encodeURIComponent(status)}&limit=${limit}`, { signal }),
  updateReviewQueueItem: (id: string, body: QueryReviewUpdate) =>
    api<QueryReviewQueueResponse["items"][number]>(`/api/review-queue/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }),
  item: (id: string) => api<ItemDetail>(`/api/items/${encodeURIComponent(id)}`),
  previewRequest: (body: PreviewRequest) => api<RequestPreview>("/api/requests/preview", { method: "POST", body: JSON.stringify(body) }),
  createRequest: (body: CreateRequestBody) =>
    api<{ ok: boolean; request?: RequestPreview["request"]; seerr?: { status?: string; reconciled?: boolean }; reconciled?: boolean }>("/api/requests/create", {
      method: "POST",
      body: JSON.stringify(body)
    }),
  adminSettings: () => api<AdminSettings>("/api/admin/settings"),
  adminUsers: () => api<{ users: AuthUser[] }>("/api/admin/users"),
  updateAdminUser: (id: string, body: { enabled?: boolean; canRequest?: boolean; canUseAi?: boolean }) =>
    api<AuthUser>(`/api/admin/users/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  updateAdminSettings: (body: AdminSettingsUpdate) => api<AdminSettings>("/api/admin/settings", { method: "PUT", body: JSON.stringify(body) }),
  syncStatus: () => api<SyncStatus>("/api/admin/sync/status"),
  runSync: () => api<SyncRunResult>("/api/admin/sync/run", { method: "POST", body: "{}" }),
  warmEmbeddings: () =>
    api<EmbeddingWarmupStatus>("/api/admin/embeddings/warmup", { method: "POST", body: "{}" }, embeddingWarmupApiTimeoutMs),
  recommendationDiagnostics: () => api<RecommendationDiagnostics>("/api/admin/recommendations/diagnostics?fresh=true", undefined, diagnosticsApiTimeoutMs),
  supportBundle: () => api<Record<string, unknown>>("/api/admin/support-bundle", undefined, diagnosticsApiTimeoutMs)
};
