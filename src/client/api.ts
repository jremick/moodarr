import type {
  ConfigStatusResponse,
  CreateRequestBody,
  HealthResponse,
  ItemDetail,
  LibraryStats,
  PreviewRequest,
  RequestPreview,
  SearchRequest,
  SearchResponse
} from "../shared/types";

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
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
  createRequest: (body: CreateRequestBody) => api<{ ok: boolean }>("/api/requests/create", { method: "POST", body: JSON.stringify(body) })
};
