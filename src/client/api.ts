import type {
  AdminSettings,
  AdminSettingsUpdate,
  ConfigStatusResponse,
  CreateRequestBody,
  HealthResponse,
  ItemDetail,
  LibraryStats,
  PreviewRequest,
  RecommendationDiagnostics,
  RequestPreview,
  SearchRequest,
  SearchResponse,
  SyncStatus
} from "../shared/types";

const adminTokenKey = "feelerr.adminToken";

export function getAdminToken() {
  return localStorage.getItem(adminTokenKey) ?? "";
}

export function setAdminToken(token: string) {
  if (token.trim()) localStorage.setItem(adminTokenKey, token.trim());
  else localStorage.removeItem(adminTokenKey);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const adminToken = getAdminToken();
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(adminToken ? { "X-Feelerr-Admin-Token": adminToken } : {}),
      ...init?.headers
    }
  });
  const data = (await response.json()) as T;
  if (!response.ok) {
    const message = typeof (data as { error?: unknown }).error === "string" ? (data as { error: string }).error : `Request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return data;
}

export const feelerrApi = {
  health: () => api<HealthResponse>("/api/health"),
  configStatus: () => api<ConfigStatusResponse>("/api/config/status"),
  stats: () => api<LibraryStats>("/api/library/stats"),
  testPlex: () => api<{ ok: boolean; message: string }>("/api/plex/test", { method: "POST", body: "{}" }),
  testSeerr: () => api<{ ok: boolean; message: string }>("/api/seerr/test", { method: "POST", body: "{}" }),
  syncLibrary: () => api<{ ok: boolean; itemCount: number; source: string }>("/api/library/sync", { method: "POST" }),
  syncSeerr: () => api<{ ok: boolean; itemCount: number; source: string }>("/api/seerr/sync", { method: "POST" }),
  search: (body: SearchRequest) => api<SearchResponse>("/api/search", { method: "POST", body: JSON.stringify(body) }),
  item: (id: string) => api<ItemDetail>(`/api/items/${encodeURIComponent(id)}`),
  previewRequest: (body: PreviewRequest) => api<RequestPreview>("/api/requests/preview", { method: "POST", body: JSON.stringify(body) }),
  createRequest: (body: CreateRequestBody) => api<{ ok: boolean }>("/api/requests/create", { method: "POST", body: JSON.stringify(body) }),
  adminSettings: () => api<AdminSettings>("/api/admin/settings"),
  updateAdminSettings: (body: AdminSettingsUpdate) => api<AdminSettings>("/api/admin/settings", { method: "PUT", body: JSON.stringify(body) }),
  syncStatus: () => api<SyncStatus>("/api/admin/sync/status"),
  runSync: () => api<{ ok: boolean; plexItems?: number; seerrItems?: number; error?: string }>("/api/admin/sync/run", { method: "POST" }),
  recommendationDiagnostics: () => api<RecommendationDiagnostics>("/api/admin/recommendations/diagnostics"),
  supportBundle: () => api<Record<string, unknown>>("/api/admin/support-bundle")
};
