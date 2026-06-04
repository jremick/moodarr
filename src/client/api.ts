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

const adminTokenKey = "moodarr.adminToken";

export function getAdminToken() {
  return localStorage.getItem(adminTokenKey) ?? "";
}

export function setAdminToken(token: string) {
  if (token.trim()) localStorage.setItem(adminTokenKey, token.trim());
  else localStorage.removeItem(adminTokenKey);
}

function authenticatedHeaders(init?: RequestInit) {
  const adminToken = getAdminToken();
  return {
    "Content-Type": "application/json",
    ...(adminToken ? { "X-Moodarr-Admin-Token": adminToken } : {}),
    ...init?.headers
  };
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
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
  const response = await fetch(path, { headers: authenticatedHeaders() });
  if (!response.ok) throw new Error(`Poster request failed with HTTP ${response.status}`);
  return URL.createObjectURL(await response.blob());
}

export const moodarrApi = {
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
  runSync: () => api<{ ok: boolean; plexItems?: number; seerrItems?: number; plexUnavailable?: number; error?: string }>("/api/admin/sync/run", { method: "POST" }),
  recommendationDiagnostics: () => api<RecommendationDiagnostics>("/api/admin/recommendations/diagnostics"),
  supportBundle: () => api<Record<string, unknown>>("/api/admin/support-bundle"),
  posterObjectUrl
};
