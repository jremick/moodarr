import type {
  AdminSettings,
  AdminSettingsUpdate,
  ConfigStatusResponse,
  CreateRequestBody,
  EmbeddingWarmupStatus,
  HealthResponse,
  ItemDetail,
  LibraryStats,
  PreviewRequest,
  QueryReviewQueueResponse,
  QueryReviewStatus,
  QueryReviewUpdate,
  RecommendationDiagnostics,
  RequestPreview,
  SearchRequest,
  SearchResponse,
  SyncRunResult,
  SyncStatus
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

async function posterObjectUrl(path: string) {
  const response = await fetch(path, { credentials: "same-origin", headers: authenticatedHeaders() });
  if (!response.ok) throw new Error(`Poster request failed with HTTP ${response.status}`);
  return URL.createObjectURL(await response.blob());
}

export const moodarrApi = {
  health: () => api<HealthResponse>("/api/health"),
  adminSession: () => api<{ ok: boolean; autoSession: boolean }>("/api/admin/session"),
  configStatus: () => api<ConfigStatusResponse>("/api/config/status"),
  stats: () => api<LibraryStats>("/api/library/stats"),
  testPlex: () => api<{ ok: boolean; message: string }>("/api/plex/test", { method: "POST", body: "{}" }),
  testSeerr: () => api<{ ok: boolean; message: string }>("/api/seerr/test", { method: "POST", body: "{}" }),
  syncLibrary: () => api<{ ok: boolean; itemCount: number; source: string }>("/api/library/sync", { method: "POST" }),
  syncSeerr: () => api<{ ok: boolean; itemCount: number; source: string }>("/api/seerr/sync", { method: "POST" }),
  search: (body: SearchRequest) => api<SearchResponse>("/api/search", { method: "POST", body: JSON.stringify(body) }),
  reviewQueue: (status: QueryReviewStatus = "pending", limit = 50) => api<QueryReviewQueueResponse>(`/api/review-queue?status=${encodeURIComponent(status)}&limit=${limit}`),
  updateReviewQueueItem: (id: string, body: QueryReviewUpdate) =>
    api<QueryReviewQueueResponse["items"][number]>(`/api/review-queue/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) }),
  item: (id: string) => api<ItemDetail>(`/api/items/${encodeURIComponent(id)}`),
  previewRequest: (body: PreviewRequest) => api<RequestPreview>("/api/requests/preview", { method: "POST", body: JSON.stringify(body) }),
  createRequest: (body: CreateRequestBody) => api<{ ok: boolean }>("/api/requests/create", { method: "POST", body: JSON.stringify(body) }),
  adminSettings: () => api<AdminSettings>("/api/admin/settings"),
  updateAdminSettings: (body: AdminSettingsUpdate) => api<AdminSettings>("/api/admin/settings", { method: "PUT", body: JSON.stringify(body) }),
  syncStatus: () => api<SyncStatus>("/api/admin/sync/status"),
  runSync: () => api<SyncRunResult>("/api/admin/sync/run", { method: "POST" }),
  warmEmbeddings: (body: { limit?: number; batchSize?: number } = {}) =>
    api<EmbeddingWarmupStatus>("/api/admin/embeddings/warmup", { method: "POST", body: JSON.stringify(body) }),
  recommendationDiagnostics: () => api<RecommendationDiagnostics>("/api/admin/recommendations/diagnostics"),
  supportBundle: () => api<Record<string, unknown>>("/api/admin/support-bundle"),
  posterObjectUrl
};
