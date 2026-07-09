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

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: authenticatedHeaders(init)
  });
  const data = (await response.json()) as T;
  if (!response.ok) {
    const message = typeof (data as { error?: unknown }).error === "string" ? (data as { error: string }).error : `Request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

export const moodarrApi = {
  health: () => api<HealthResponse>("/api/health"),
  adminSession: () => api<{ ok: boolean; autoSession: boolean }>("/api/admin/session"),
  createAdminSession: (token: string) =>
    api<{ ok: boolean; autoSession: boolean }>("/api/admin/session", { method: "POST", body: JSON.stringify({ token }) }),
  lockAdminSession: () => api<{ ok: boolean }>("/api/admin/session", { method: "DELETE", body: "{}" }),
  authSession: () => api<AuthSessionResponse>("/api/auth/session"),
  startPlexAuth: (body: { returnUrl?: string }) => api<PlexAuthStartResponse>("/api/auth/plex/start", { method: "POST", body: JSON.stringify(body) }),
  completePlexAuth: (body: { pinId: string; code: string }) => api<PlexAuthCompleteResponse>("/api/auth/plex/complete", { method: "POST", body: JSON.stringify(body) }),
  logout: () => api<{ ok: boolean }>("/api/auth/logout", { method: "POST", body: "{}" }),
  configStatus: () => api<ConfigStatusResponse>("/api/config/status"),
  stats: () => api<LibraryStats>("/api/library/stats"),
  testPlex: () => api<{ ok: boolean; message: string }>("/api/plex/test", { method: "POST", body: "{}" }),
  testSeerr: () => api<{ ok: boolean; message: string }>("/api/seerr/test", { method: "POST", body: "{}" }),
  syncLibrary: () => api<{ ok: boolean; itemCount: number; source: string }>("/api/library/sync", { method: "POST" }),
  syncSeerr: () => api<{ ok: boolean; itemCount: number; source: string }>("/api/seerr/sync", { method: "POST" }),
  search: (body: SearchRequest, signal?: AbortSignal) => api<SearchResponse>("/api/search", { method: "POST", body: JSON.stringify(body), signal }),
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
  createRequest: (body: CreateRequestBody) => api<{ ok: boolean }>("/api/requests/create", { method: "POST", body: JSON.stringify(body) }),
  adminSettings: () => api<AdminSettings>("/api/admin/settings"),
  adminUsers: () => api<{ users: AuthUser[] }>("/api/admin/users"),
  updateAdminUser: (id: string, body: { enabled?: boolean; canRequest?: boolean; canUseAi?: boolean }) =>
    api<AuthUser>(`/api/admin/users/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  updateAdminSettings: (body: AdminSettingsUpdate) => api<AdminSettings>("/api/admin/settings", { method: "PUT", body: JSON.stringify(body) }),
  syncStatus: () => api<SyncStatus>("/api/admin/sync/status"),
  runSync: () => api<SyncRunResult>("/api/admin/sync/run", { method: "POST" }),
  warmEmbeddings: (body: { limit?: number; batchSize?: number } = {}) =>
    api<EmbeddingWarmupStatus>("/api/admin/embeddings/warmup", { method: "POST", body: JSON.stringify(body) }),
  recommendationDiagnostics: () => api<RecommendationDiagnostics>("/api/admin/recommendations/diagnostics"),
  supportBundle: () => api<Record<string, unknown>>("/api/admin/support-bundle")
};
