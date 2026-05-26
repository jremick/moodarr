export const mediaTypes = ["movie", "tv"] as const;
export type MediaType = (typeof mediaTypes)[number];

export const seerrStatuses = [
  "unknown",
  "available",
  "partially_available",
  "requested",
  "pending",
  "approved",
  "declined",
  "processing"
] as const;
export type SeerrStatus = (typeof seerrStatuses)[number];

export type AvailabilityGroup =
  | "available_in_plex"
  | "not_in_plex_requestable"
  | "already_requested"
  | "partially_available"
  | "unavailable";

export type WatchContext = "solo" | "group";

export interface RatingSet {
  critic?: number;
  audience?: number;
  user?: number;
}

export interface ItemSummary {
  id: string;
  mediaType: MediaType;
  title: string;
  year?: number;
  runtimeMinutes?: number;
  summary?: string;
  genres: string[];
  contentRating?: string;
  ratings: RatingSet;
  posterUrl: string;
  availabilityGroup: AvailabilityGroup;
  availabilityExplanation: string;
  matchExplanation: string;
  score: number;
  scoreBreakdown?: {
    query: number;
    taste: number;
    availability: number;
    quality: number;
  };
  plex?: {
    available: boolean;
    url?: string;
    library?: string;
  };
  seerr?: {
    status: SeerrStatus;
    requestStatus?: string;
    requestable: boolean;
    url?: string;
    mediaId?: number;
  };
}

export interface ItemDetail extends ItemSummary {
  cast: string[];
  directors: string[];
  externalIds: Record<string, string>;
}

export interface SearchFilters {
  mediaTypes?: MediaType[];
  minRuntimeMinutes?: number;
  maxRuntimeMinutes?: number;
  minYear?: number;
  maxYear?: number;
  genres?: string[];
  contentRating?: string;
  availability?: AvailabilityGroup[];
  requestStatus?: string[];
}

export interface SearchRequest {
  query: string;
  filters?: SearchFilters;
  useAi?: boolean;
  resultLimit?: number;
  watchContext?: WatchContext;
}

export interface SearchResponse {
  query: string;
  usedAi: boolean;
  summary: string;
  resolvedFilters: SearchFilters;
  watchContext: WatchContext;
  resultLimit: number;
  groups: Record<AvailabilityGroup, ItemSummary[]>;
  results: ItemSummary[];
}

export interface HealthResponse {
  ok: boolean;
  fixtureMode: boolean;
  version: string;
}

export interface ConfigStatusResponse {
  fixtureMode: boolean;
  plex: {
    configured: boolean;
    baseUrlConfigured: boolean;
  };
  seerr: {
    configured: boolean;
    baseUrlConfigured: boolean;
  };
  ai: {
    provider: "none" | "openai";
    configured: boolean;
  };
  admin: {
    authRequired: boolean;
    configured: boolean;
  };
  runtime: {
    dataDir: string;
    configPath: string;
    dbPath: string;
    serveClient: boolean;
    syncIntervalMinutes: number;
    syncSeerr: boolean;
  };
}

export interface AdminSettings {
  fixtureMode: boolean;
  plex: {
    baseUrl?: string;
    webBaseUrl?: string;
    tokenConfigured: boolean;
  };
  seerr: {
    baseUrl?: string;
    apiKeyConfigured: boolean;
  };
  ai: {
    provider: "none" | "openai";
    openaiModel: string;
    openaiApiKeyConfigured: boolean;
  };
  sync: {
    intervalMinutes: number;
    syncSeerr: boolean;
  };
}

export interface AdminSettingsUpdate {
  fixtureMode?: boolean;
  plex?: {
    baseUrl?: string;
    token?: string;
    webBaseUrl?: string;
    clearToken?: boolean;
  };
  seerr?: {
    baseUrl?: string;
    apiKey?: string;
    clearApiKey?: boolean;
  };
  ai?: {
    provider?: "none" | "openai";
    openaiApiKey?: string;
    openaiModel?: string;
    clearOpenaiApiKey?: boolean;
  };
  sync?: {
    intervalMinutes?: number;
    syncSeerr?: boolean;
  };
}

export interface SyncStatus {
  enabled: boolean;
  intervalMinutes: number;
  syncSeerr: boolean;
  nextRunAt?: string;
  running: boolean;
}

export interface LibraryStats {
  totalItems: number;
  plexItems: number;
  seerrItems: number;
  movies: number;
  tv: number;
  availableInPlex: number;
  requestable: number;
  alreadyRequested: number;
  partiallyAvailable: number;
  lastLibrarySync?: string;
  lastSeerrSync?: string;
}

export interface PreviewRequest {
  itemId?: string;
  mediaType?: MediaType;
  tmdbId?: number;
  seasons?: number[];
}

export interface RequestPreview {
  canRequest: boolean;
  blockedReason?: string;
  requiresConfirmation: true;
  confirmationPhrase: string;
  request: {
    mediaType: MediaType;
    mediaId: number;
    seasons?: number[];
    title: string;
  };
  item: ItemSummary;
}

export interface CreateRequestBody extends PreviewRequest {
  confirmed?: boolean;
  confirmationPhrase?: string;
}
