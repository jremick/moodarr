export const mediaTypes = ["movie", "tv"] as const;
export type MediaType = (typeof mediaTypes)[number];
export type MediaSource = "live" | "fixture" | "catalog" | "operational";

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

export const openAiReasoningEfforts = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
export type OpenAiReasoningEffort = (typeof openAiReasoningEfforts)[number];
export const defaultSearchResultLimit = 50;
export const maxSearchResultLimit = 200;

export type AvailabilityGroup =
  | "available_in_plex"
  | "not_in_plex_requestable"
  | "already_requested"
  | "partially_available"
  | "unavailable";

export type WatchContext = "solo" | "group";

export const feelFeedbackActions = [
  "swipe_right",
  "swipe_left",
  "swipe_skip",
  "open",
  "expand",
  "save",
  "hide",
  "more_like",
  "less_like",
  "right_mood",
  "wrong_mood",
  "pairwise_pick",
  "request_preview",
  "request_create"
] as const;
export type FeelFeedbackAction = (typeof feelFeedbackActions)[number];

export const feelFeedbackSources = ["web", "ios", "admin"] as const;
export type FeelFeedbackSource = (typeof feelFeedbackSources)[number];

export const feelFeedbackReliabilities = ["high", "medium", "weak", "diagnostic"] as const;
export type FeelFeedbackReliability = (typeof feelFeedbackReliabilities)[number];

export const feelFeedbackReasonChips = [
  "too_scary",
  "too_bleak",
  "too_slow",
  "too_silly",
  "too_cute",
  "too_sentimental",
  "wrong_kind_of_weird",
  "not_available_enough"
] as const;
export type FeelFeedbackReasonChip = (typeof feelFeedbackReasonChips)[number];

export interface FeelFeedbackRequest {
  action: FeelFeedbackAction;
  source?: FeelFeedbackSource;
  clientEventId?: string;
  watchContext?: WatchContext;
  sessionId?: string;
  itemId?: string;
  comparedItemId?: string;
  moodTerm?: string;
  reason?: string;
  strength?: number;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface FeelFeedbackResponse {
  ok: true;
  eventId: number;
  deduped?: boolean;
  reliability: FeelFeedbackReliability;
  profileVersion?: number;
  profileHoldout?: boolean;
  appliedPreferenceSignal: boolean;
  appliedProfileSignal?: boolean;
}

export interface FeelProfileTermSummary {
  term: string;
  featureWeights: Record<string, number>;
  confidence: number;
  evidenceCount: number;
  positiveCount: number;
  negativeCount: number;
  positiveWeight: number;
  negativeWeight: number;
  effectiveEvidence: number;
  conflictScore: number;
  version: number;
  updatedAt: string;
}

export interface FeelProfileResponse {
  id: string;
  label: string;
  watchContext: WatchContext;
  terms: FeelProfileTermSummary[];
}

export interface FeelProfileResetResponse {
  ok: true;
  watchContext?: WatchContext;
  term?: string;
  deletedTerms: number;
  deletedCheckpoints?: number;
}

export interface FeelProfileRollbackResponse {
  ok: true;
  watchContext: WatchContext;
  term: string;
  restoredVersion: number;
  profileVersion: number;
  checkpointEventId?: number;
}

export interface RecommendationReplaySlateResult {
  itemId: string;
  rank: number;
  score: number;
  scoreBreakdown: Record<string, number>;
  availabilityGroup: AvailabilityGroup;
  featureVersion?: string;
}

export interface RecommendationReplaySlate {
  sessionId: string;
  queryHash: string;
  engineVersion: string;
  model?: string;
  watchContext: WatchContext;
  resultCount: number;
  candidateCount: number;
  rerankCandidateCount: number;
  usedAi: boolean;
  seerrAugmented: boolean;
  latencyMs: number;
  profileId?: string;
  profileVersion: number;
  createdAt: string;
  results: RecommendationReplaySlateResult[];
}

export interface FeelProfileExportResponse {
  schemaVersion: "feel-profile-export-v1";
  exportedAt: string;
  engineVersion: string;
  profiles: Record<WatchContext, FeelProfileResponse>;
  preferences: Record<
    WatchContext,
    {
      positive: { feature: string; weight: number }[];
      negative: { feature: string; weight: number }[];
    }
  >;
  feedbackSummary: {
    total: number;
    byReliability: { reliability: FeelFeedbackReliability; count: number }[];
    holdouts: number;
    appliedProfileUpdates: number;
  };
  recentSlates: RecommendationReplaySlate[];
}

export interface ProfileReplayEvaluationCase {
  eventId: number;
  sessionId: string;
  itemId: string;
  action: FeelFeedbackAction;
  watchContext: WatchContext;
  moodTerm: string;
  slateRank?: number;
  eventProfileVersion: number;
  nextProfileVersion: number;
  beforeProfileScore: number;
  afterProfileScore: number;
  outcome: "win" | "loss" | "tie";
}

export interface ProfileReplayEvaluationResponse {
  engineVersion: string;
  generatedAt: string;
  holdoutEvents: number;
  compared: number;
  wins: number;
  losses: number;
  ties: number;
  skipped: Record<string, number>;
  cases: ProfileReplayEvaluationCase[];
}

export interface FeelProfileCheckpointSummary {
  profileId: string;
  watchContext: WatchContext;
  term: string;
  version: number;
  confidence: number;
  evidenceCount: number;
  effectiveEvidence: number;
  conflictScore: number;
  positiveWeight: number;
  negativeWeight: number;
  eventId?: number;
  createdAt: string;
}

export interface FeelProfileDriftAlert {
  profileId: string;
  watchContext: WatchContext;
  term: string;
  version: number;
  severity: "watch" | "review";
  conflictScore: number;
  effectiveEvidence: number;
  evidenceCount: number;
  positiveWeight: number;
  negativeWeight: number;
  recommendation: "monitor" | "review_or_rollback";
  updatedAt: string;
}

export interface ReplayRetentionPolicy {
  retentionDays: number;
  maxSessions: number;
  maxFeedbackEvents: number;
  maxCheckpointsPerTerm: number;
}

export interface ReplayCompactionSummary {
  policy: ReplayRetentionPolicy;
  deletedSessions: number;
  deletedFeedbackEvents: number;
  deletedCheckpoints: number;
}

export interface RatingSet {
  critic?: number;
  audience?: number;
  user?: number;
}

export interface AuthUser {
  id: string;
  provider: "plex";
  providerUserId: string;
  username?: string;
  displayName?: string;
  email?: string;
  avatarUrl?: string;
  enabled: boolean;
  canRequest: boolean;
  canUseAi: boolean;
  requestCount: number;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

export interface AuthSessionResponse {
  authenticated: boolean;
  plexAuthEnabled: boolean;
  allowNewPlexUsers: boolean;
  user?: AuthUser;
}

export interface PlexAuthStartResponse {
  ok: true;
  pinId: string;
  code: string;
  authUrl: string;
  expiresAt?: string;
}

export interface PlexAuthCompleteResponse extends AuthSessionResponse {
  pending?: boolean;
  sessionToken?: string;
  sessionExpiresAt?: string;
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
  imdbUrl?: string;
  availabilityGroup: AvailabilityGroup;
  availabilityExplanation: string;
  requestAttempt?: {
    available: true;
    seerrAvailabilityChecked: false;
  };
  catalogIdentityAmbiguous?: true;
  matchExplanation: string;
  score: number;
  scoreBreakdown?: {
    query: number;
    semantic?: number;
    mood?: number;
    reference?: number;
    taste: number;
    preference?: number;
    profile?: number;
    feedback?: number;
    scout?: number;
    rankIndex?: number;
    availability: number;
    quality: number;
    friction?: number;
    novelty?: number;
    diversity?: number;
  };
  metadata?: {
    hasPoster: boolean;
    sparse: boolean;
    source?: MediaSource;
    catalogSourceCount?: number;
    catalog?: CatalogMetadataSummary;
  };
  plex?: {
    available: boolean;
    url?: string;
    appUrl?: string;
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

export interface CatalogMetadataSummary {
  sourceCount: number;
  sources?: string[];
  mainstreamScore?: number;
  metadataConfidence?: number;
  sitelinkCount?: number;
  externalIdCount?: number;
  awardCount?: number;
  countries?: string[];
  languages?: string[];
  franchises?: string[];
  aliases?: string[];
  hasEnglishWikipedia?: boolean;
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
    preferredExampleItemIds?: string[];
    maybeItemIds?: string[];
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
  sessionId?: string;
  query: string;
  optimizedQuery: string;
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
    libraryItemCount?: number;
    scoredItemCount?: number;
    rankIndexCandidateCount?: number;
    retrievalCandidateCount?: number;
    rerankCandidateCount: number;
    resultLimit?: number;
    providerEmbeddingCount?: number;
    providerEmbeddingBackfillCount?: number;
    moodCandidateCount?: number;
    feedbackCandidateCount?: number;
    feedbackHiddenCount?: number;
    catalogVerificationCount?: number;
    catalogRankCandidateCount?: number;
    diversityApplied?: boolean;
    aiBriefParsed?: boolean;
    tasteScoutUsed?: boolean;
    queryOptimized?: boolean;
    traceSchemaVersion?: string;
    traceWriteMode?: "off" | "on" | "strict";
    traceBuildMs?: number;
    telemetryWriteMs?: number;
    seerrAugmented: boolean;
    latencyMs: number;
    stageLatencyMs?: Record<string, number>;
  };
  groups: Record<AvailabilityGroup, ItemSummary[]>;
  results: ItemSummary[];
}

export type QueryReviewStatus = "pending" | "reviewed" | "all";

export interface QueryReviewResultSnapshot {
  id: string;
  title: string;
  mediaType: MediaType;
  year?: number;
  genres: string[];
  score: number;
  matchExplanation: string;
  availabilityGroup: AvailabilityGroup;
}

export interface QueryReviewQueueItem {
  id: string;
  sessionId: string;
  query: string;
  optimizedQuery?: string;
  watchContext: WatchContext;
  resultCount: number;
  results: QueryReviewResultSnapshot[];
  moodFitRating?: number;
  moodFeedbackText?: string;
  reviewedAt?: string;
  createdAt: string;
}

export interface QueryReviewQueueResponse {
  status: QueryReviewStatus;
  count: number;
  items: QueryReviewQueueItem[];
}

export interface QueryReviewUpdate {
  moodFitRating: number;
  moodFeedbackText?: string;
}

export interface HealthResponse {
  ok: boolean;
  fixtureMode: boolean;
  version: string;
  revision?: string;
  database: "ok" | "error";
  policies?: {
    aiProvider: "configurable" | "none";
    tmdbContent: "configurable" | "none";
  };
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
    tmdbContentPolicy: "configurable" | "none";
  };
  ai: {
    providerPolicy: "configurable" | "none";
    provider: "none" | "openai";
    configured: boolean;
    openaiModel?: string;
    openaiEmbeddingModel?: string;
    openaiReasoningEffort?: OpenAiReasoningEffort;
  };
  admin: {
    authRequired: boolean;
    configured: boolean;
    autoSession: boolean;
  };
  auth: {
    plexAuthEnabled: boolean;
    allowNewPlexUsers: boolean;
  };
  runtime: {
    serveClient: boolean;
    syncIntervalMinutes: number;
    syncSeerr: boolean;
    defaultResultLimit: number;
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
    tmdbContentPolicy: "configurable" | "none";
  };
  ai: {
    providerPolicy: "configurable" | "none";
    provider: "none" | "openai";
    openaiModel: string;
    openaiEmbeddingModel: string;
    openaiReasoningEffort: OpenAiReasoningEffort;
    openaiApiKeyConfigured: boolean;
  };
  sync: {
    intervalMinutes: number;
    syncSeerr: boolean;
  };
  search: {
    defaultResultLimit: number;
  };
  reviewQueue: {
    retentionDays: number;
    maxQueries: number;
    captureRawQueries: boolean;
  };
  plexAuth: {
    enabled: boolean;
    allowNewUsers: boolean;
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
    openaiReasoningEffort?: OpenAiReasoningEffort;
    clearOpenaiApiKey?: boolean;
  };
  sync?: {
    intervalMinutes?: number;
    syncSeerr?: boolean;
  };
  search?: {
    defaultResultLimit?: number;
  };
  reviewQueue?: {
    retentionDays?: number;
    maxQueries?: number;
    captureRawQueries?: boolean;
  };
  plexAuth?: {
    enabled?: boolean;
    allowNewUsers?: boolean;
  };
}

export interface SyncStatus {
  enabled: boolean;
  intervalMinutes: number;
  syncSeerr: boolean;
  nextRunAt?: string;
  running: boolean;
  worker?: {
    mode: "worker" | "inline";
    ready: boolean;
    running: boolean;
    closed: boolean;
    workerCount: number;
  };
  progress?: SyncProgress;
  lastResult?: SyncCompletionResult;
  history?: {
    library: SyncRunSummary[];
    seerr: SyncRunSummary[];
  };
}

export interface SyncProgress {
  stage: "starting" | "fetching_plex" | "ingesting_plex" | "finalizing_plex" | "fetching_seerr" | "ingesting_seerr" | "warming_embeddings";
  processed?: number;
  total?: number;
  startedAt: string;
  updatedAt: string;
}

export interface EmbeddingWarmupStatus {
  provider?: string;
  model?: string;
  dimensions?: number;
  configured: boolean;
  attempted: number;
  embedded: number;
  compatibleCount?: number;
  staleCount?: number;
  hasMore: boolean;
  error?: string;
}

export interface SyncRunResult {
  accepted: boolean;
  running: boolean;
  message: string;
  startedAt?: string;
}

export interface SyncCompletionResult {
  ok: boolean;
  /** Raw Plex snapshot rows (one per rating key/edition). */
  plexItems?: number;
  /** Distinct Moodarr media items represented by the Plex snapshot. */
  plexMediaItems?: number;
  /** Plex rows skipped because their integration identities resolved to different existing items. */
  plexIdentityConflicts?: number;
  /** Consolidated upstream Seerr request records. */
  seerrItems?: number;
  /** Distinct Moodarr media items persisted from the Seerr snapshot. */
  seerrMediaItems?: number;
  /** Seerr rows skipped because their integration identities resolved to different existing items. */
  seerrIdentityConflicts?: number;
  /** Stale per-item identity quarantines cleared after one successful full Plex plus Seerr revalidation run. */
  identityQuarantinesCleared?: number;
  plexUnavailable?: number;
  providerEmbeddings?: EmbeddingWarmupStatus;
  error?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  stageDurationsMs: Record<string, number>;
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
    contentFingerprintCount?: number;
    contentFingerprints?: {
      total: number;
      current: number;
      stale: number;
      missing: number;
      projectedItemCount: number;
      projectedScoreCount: number;
      summaryMissing: number;
      summaryThin: number;
      genreMissing: number;
      genreThin: number;
      peopleMissing: number;
      ratingsMissing: number;
      warningCount: number;
      catalogOnlyUnverified: number;
    };
    moodFeatureScoreCount?: number;
    moodFeatureSources?: {
      source: string;
      sourceVersion: string;
      itemCount: number;
      scoreCount: number;
      updatedAt?: string;
    }[];
    catalogSources?: {
      source: string;
      sourceVersion: string;
      itemCount: number;
      activeItemCount?: number;
      inactiveItemCount?: number;
      averageMainstreamScore?: number;
      averageMetadataConfidence?: number;
      updatedAt?: string;
    }[];
    catalog?: {
      totalCatalogItems: number;
      activeCatalogItems?: number;
      inactiveCatalogItems?: number;
      catalogOnlyItems: number;
      plexVerifiedItems: number;
      seerrVerifiedItems: number;
      requestableVerifiedItems: number;
      trustedRefreshRequiredItems: number;
      requestableTrustedRefreshRequiredItems: number;
      catalogRefreshRequiredItems: number;
      plexRefreshRequiredItems: number;
      operationalOnlyItems: number;
      requestableOperationalOnlyItems: number;
      staleSourceRecords: number;
      rankSignalItems: number;
      featureIndexedItems: number;
      moodIndexedItems: number;
      rankedSearchReadyItems: number;
      latestRun?: {
        source: string;
        sourceVersion: string;
        status: string;
        updateMode?: string;
        itemCount: number;
        changedSourceRecords?: number;
        unchangedSourceRecords?: number;
        inactiveSourceRecords?: number;
        finishedAt?: string;
        ageSeconds?: number;
        error?: string;
      };
      verificationCandidateCount: number;
      verificationCandidates: {
        id: string;
        mediaType: MediaType;
        title: string;
        year?: number;
        catalogSourceCount?: number;
        hasSummary: boolean;
      }[];
    };
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
  usageReadiness?: {
    status: "cold_start" | "collecting" | "replay_ready" | "review_needed";
    label: string;
    ready: boolean;
    nextAction: string;
    signalProgress: {
      total: number;
      appliedProfileUpdates: number;
      targetAppliedProfileUpdates: number;
      holdouts: number;
      targetHoldouts: number;
      replayComparisons: number;
      targetReplayComparisons: number;
    };
    profileVersions: {
      solo: number;
      group: number;
      max: number;
      learnedTerms: number;
    };
    review: {
      driftAlerts: number;
      rollbackRecommended: boolean;
    };
    recentActivity: {
      lastSignalAt?: string;
      lastRunAt?: string;
    };
  };
  feelProfiles?: Record<WatchContext, FeelProfileResponse>;
  feelProfileTimeline?: {
    totalCheckpoints: number;
    recent: FeelProfileCheckpointSummary[];
  };
  feelProfileDrift?: {
    totalAlerts: number;
    alerts: FeelProfileDriftAlert[];
  };
  replayStorage?: {
    sessions: number;
    resultRows: number;
    feedbackEvents: number;
    holdoutEvents: number;
    checkpoints: number;
    retentionPolicy: ReplayRetentionPolicy;
  };
  feelSignals?: {
    total: number;
    positive: number;
    negative: number;
    pairwise: number;
    byReliability: { reliability: FeelFeedbackReliability; count: number }[];
    byAction: { action: FeelFeedbackAction; count: number }[];
    recent: {
      id: number;
      action: FeelFeedbackAction;
      reliability: FeelFeedbackReliability;
      source: FeelFeedbackSource;
      watchContext: WatchContext;
      itemId?: string;
      comparedItemId?: string;
      moodTerm?: string;
      reason?: string;
      profileVersion: number;
      profileUpdateApplied: boolean;
      profileHoldout: boolean;
      createdAt: string;
    }[];
  };
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
    profileId?: string;
    profileVersion: number;
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
    authUser?: {
      id: string;
      displayName: string;
    };
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
  requestMode: "attempt";
  seerrAvailabilityChecked: false;
  requiresConfirmation: true;
  confirmationPhrase: string;
  confirmationToken: string;
  request: {
    mediaType: MediaType;
    mediaId: number;
    seasons?: number[];
    title: string;
  };
  item: ItemSummary;
}

export interface CreateRequestBody {
  itemId?: string;
  mediaType: MediaType;
  tmdbId: number;
  seasons?: number[];
  confirmed: boolean;
  confirmationPhrase: string;
  confirmationToken: string;
}
