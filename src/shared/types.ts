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
    semantic?: number;
    taste: number;
    preference?: number;
    feedback?: number;
    scout?: number;
    availability: number;
    quality: number;
    novelty?: number;
  };
  metadata?: {
    hasPoster: boolean;
    sparse: boolean;
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
  excludedGenres?: string[];
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
  feedbackContext?: {
    moreLikeItemIds?: string[];
    lessLikeItemIds?: string[];
    hiddenItemIds?: string[];
    showRatedItems?: boolean;
  };
}

export interface RefinementOption {
  label: string;
  prompt: string;
}

export interface SearchResponse {
  query: string;
  usedAi: boolean;
  summary: string;
  refinementOptions: RefinementOption[];
  resolvedFilters: SearchFilters;
  watchContext: WatchContext;
  resultLimit: number;
  diagnostics?: {
    engineVersion: string;
    model?: string;
    embeddingModel?: string;
    candidateCount: number;
    rerankCandidateCount: number;
    providerEmbeddingCount?: number;
    providerEmbeddingBackfillCount?: number;
    aiBriefParsed?: boolean;
    tasteScoutUsed?: boolean;
    seerrAugmented: boolean;
    latencyMs: number;
  };
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
    openaiModel?: string;
    openaiEmbeddingModel?: string;
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
    openaiEmbeddingModel: string;
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
    openaiEmbeddingModel?: string;
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
  history?: {
    library: SyncRunSummary[];
    seerr: SyncRunSummary[];
  };
}

export interface SyncRunSummary {
  id: number;
  source: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  itemCount: number;
  error?: string;
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

export interface RecommendationDiagnostics {
  engineVersion: string;
  sessions: {
    total: number;
    withAi: number;
    withSeerrAugmentation: number;
    averageLatencyMs: number;
  };
  features: {
    mediaFeatureCount: number;
    providerEmbeddingCount: number;
    embeddingModels: {
      provider: string;
      model: string;
      count: number;
      dimensions?: number;
      lastUpdatedAt?: string;
    }[];
  };
  preferences: Record<
    WatchContext,
    {
      positive: { feature: string; weight: number }[];
      negative: { feature: string; weight: number }[];
    }
  >;
  recentRuns: {
    id: string;
    engineVersion: string;
    model?: string;
    watchContext: WatchContext;
    resultCount: number;
    candidateCount: number;
    rerankCandidateCount: number;
    usedAi: boolean;
    seerrAugmented: boolean;
    latencyMs: number;
    createdAt: string;
  }[];
}

export interface RequestAuditDiagnostics {
  total: number;
  previews: number;
  creates: number;
  blocked: number;
  failed: number;
  recent: {
    id: number;
    action: "preview" | "create";
    status: "allowed" | "blocked" | "created" | "failed";
    title?: string;
    mediaType?: MediaType;
    mediaId?: number;
    seasons?: number[];
    blockedReason?: string;
    createdAt: string;
  }[];
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
