import { useEffect, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { moodarrApi } from "./api";
import { settleAdminSurface, changedSettingsSections, settingsForSection, replaceSettingsSection, type AdminSettingsSection } from "./features/admin/adminSettingsModel";
import { hasReviewIntent, reconcileReviewEdits } from "./features/review/reviewEdits";
import { isAbortError, LatestRequestLifecycle } from "./requestLifecycle";
import type {
  AdminSettings,
  AdminSettingsUpdate,
  AuthUser,
  QueryReviewQueueItem,
  QueryReviewQueueResponse,
  QueryReviewStatus,
  RecommendationDiagnostics,
  SyncStatus
} from "../shared/types";

type NoticeSetter = (message: string) => void;
type BusyStarter = (name: string) => boolean;
type BusyEnder = (name: string) => void;
type RunAction = <T>(
  name: string,
  action: () => Promise<T>,
  message: (result: T) => string,
  refreshAfter?: () => Promise<unknown>
) => Promise<T | undefined>;
export type AdminUserUpdate = { enabled?: boolean; canRequest?: boolean; canUseAi?: boolean };

export type ReviewQueueLoadState = {
  status: QueryReviewStatus | null;
  phase: "idle" | "loading" | "loaded" | "error";
};

export async function settleAdminSyncState(
  finalStatus: SyncStatus,
  loadDiagnostics: () => Promise<RecommendationDiagnostics>,
  onSyncSettled?: (status: SyncStatus) => void | Promise<void>
): Promise<RecommendationDiagnostics | null> {
  const [diagnosticsResult] = await Promise.allSettled([
    Promise.resolve().then(loadDiagnostics),
    Promise.resolve().then(() => onSyncSettled?.(finalStatus))
  ]);
  return diagnosticsResult.status === "fulfilled" ? diagnosticsResult.value : null;
}

export function useReviewQueueState(beginBusy: BusyStarter, endBusy: BusyEnder, setNotice: NoticeSetter) {
  const [reviewQueue, setReviewQueue] = useState<QueryReviewQueueResponse | null>(null);
  const [reviewStatus, setReviewStatus] = useState<QueryReviewStatus>("pending");
  const [reviewLoadState, setReviewLoadState] = useState<ReviewQueueLoadState>({ status: null, phase: "idle" });
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, string>>({});
  const [reviewRatings, setReviewRatings] = useState<Record<string, number>>({});
  const [reviewDirtyIds, setReviewDirtyIds] = useState<Set<string>>(new Set());
  const reviewDirtyRef = useRef(reviewDirtyIds);
  reviewDirtyRef.current = reviewDirtyIds;
  const reviewRequestRef = useRef<LatestRequestLifecycle | null>(null);
  reviewRequestRef.current ??= new LatestRequestLifecycle();

  useEffect(() => () => reviewRequestRef.current?.abort(), []);

  async function refreshReviewQueue(statusOverride = reviewStatus, append = false) {
    const actionName = "review-refresh";
    if (!beginBusy(actionName)) return;
    const request = reviewRequestRef.current!.begin();
    setReviewLoadState({ status: statusOverride, phase: "loading" });
    setNotice("");
    try {
      const queue = await moodarrApi.reviewQueue(statusOverride, 50, request.signal, append ? reviewQueue?.nextCursor : undefined);
      if (!reviewRequestRef.current!.isCurrent(request.generation)) return;
      setReviewQueue((current) => append && current?.status === queue.status ? {
        ...queue, items: [...current.items, ...queue.items.filter((item) => !current.items.some((entry) => entry.id === item.id))]
      } : queue);
      setReviewLoadState({ status: statusOverride, phase: "loaded" });
      setReviewDrafts((current) => reconcileReviewEdits(current, queue.items, reviewDirtyRef.current, (item) => item.moodFeedbackText ?? ""));
      setReviewRatings((current) => reconcileReviewEdits(current, queue.items, reviewDirtyRef.current, (item) => item.moodFitRating ?? 0));
    } catch (error) {
      if (isAbortError(error)) return;
      if (!reviewRequestRef.current!.isCurrent(request.generation)) return;
      setReviewLoadState({ status: statusOverride, phase: "error" });
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      if (reviewRequestRef.current!.isCurrent(request.generation)) endBusy(actionName);
    }
  }

  function updateReviewDraft(id: string, value: string) {
    setReviewDirtyIds((current) => new Set(current).add(id));
    setReviewDrafts((current) => ({ ...current, [id]: value }));
  }

  function updateReviewRating(id: string, value: number) {
    setReviewDirtyIds((current) => new Set(current).add(id));
    setReviewRatings((current) => ({ ...current, [id]: value }));
  }

  function discardReviewEdits(item: QueryReviewQueueItem) {
    setReviewDrafts((current) => ({ ...current, [item.id]: item.moodFeedbackText ?? "" }));
    setReviewRatings((current) => ({ ...current, [item.id]: item.moodFitRating ?? 0 }));
    setReviewDirtyIds((current) => { const next = new Set(current); next.delete(item.id); return next; });
  }

  async function submitReviewFeedback(item: QueryReviewQueueItem) {
    if (!hasReviewIntent(item)) { setNotice("Mood fit cannot be rated because the search intent was not retained."); return; }
    const moodFitRating = reviewRatings[item.id] ?? item.moodFitRating;
    if (!moodFitRating) {
      setNotice("Choose a mood fit rating before saving the review.");
      return;
    }

    const actionName = `review-save:${item.id}`;
    if (!beginBusy(actionName)) return;
    setNotice("");
    try {
      const saved = await moodarrApi.updateReviewQueueItem(item.id, {
        moodFitRating,
        moodFeedbackText: reviewDrafts[item.id] ?? item.moodFeedbackText ?? ""
      });
      setReviewDrafts((current) => ({ ...current, [item.id]: saved.moodFeedbackText ?? "" }));
      setReviewRatings((current) => ({ ...current, [item.id]: saved.moodFitRating ?? 0 }));
      setReviewDirtyIds((current) => { const next = new Set(current); next.delete(item.id); return next; });
      setNotice("Review feedback saved.");
      setReviewQueue((current) => {
        if (!current) return current;
        if (current.status === "pending") {
          return {
            ...current,
            count: Math.max(0, current.count - 1),
            items: current.items.filter((entry) => entry.id !== item.id)
          };
        }
        return {
          ...current,
          items: current.items.map((entry) => (entry.id === saved.id ? saved : entry))
        };
      });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      endBusy(actionName);
    }
  }

  return {
    reviewQueue,
    reviewDirtyIds,
    discardReviewEdits,
    loadMoreReviews: () => refreshReviewQueue(reviewStatus, true),
    reviewStatus,
    reviewLoadState,
    setReviewStatus,
    reviewDrafts,
    reviewRatings,
    refreshReviewQueue,
    updateReviewDraft,
    updateReviewRating,
    submitReviewFeedback
  };
}

export function useAdminConsole(runAction: RunAction, onSyncSettled?: (status: SyncStatus) => void | Promise<void>) {
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [recommendationDiagnostics, setRecommendationDiagnostics] = useState<RecommendationDiagnostics | null>(null);
  const [adminUsers, setAdminUsers] = useState<AuthUser[]>([]);
  const [adminDraft, setAdminDraftState] = useState<AdminSettingsUpdate>({});
  const [adminLoaded, setAdminLoaded] = useState(false);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminLoadErrors, setAdminLoadErrors] = useState<Partial<Record<"settings" | "sync" | "diagnostics" | "users", string>>>({});
  const adminDirtySections = settings ? changedSettingsSections(adminDraft, buildAdminDraft(settings)) : [];
  const adminDirty = adminDirtySections.length > 0;
  const adminRefreshGenerationRef = useRef<Record<string, number>>({});
  const adminDraftRevisionRef = useRef(0);
  const onSyncSettledRef = useRef(onSyncSettled);
  onSyncSettledRef.current = onSyncSettled;

  useEffect(() => {
    if (!syncStatus?.running) return;
    let cancelled = false;
    let settled = false;
    let pollInFlight = false;
    const poll = async () => {
      if (pollInFlight || settled) return;
      pollInFlight = true;
      try {
        const current = await moodarrApi.syncStatus();
        if (cancelled) return;
        if (!current.running) {
          if (settled) return;
          settled = true;
          const diagnostics = await settleAdminSyncState(current, moodarrApi.recommendationDiagnostics, onSyncSettledRef.current);
          if (cancelled) return;
          if (diagnostics) setRecommendationDiagnostics(diagnostics);
          setSyncStatus(current);
          return;
        }
        setSyncStatus(current);
      } catch {
        // A later poll or manual refresh can recover a transient failure.
      } finally {
        pollInFlight = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 1_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [syncStatus?.running]);

  const setAdminDraft: Dispatch<SetStateAction<AdminSettingsUpdate>> = (update) => {
    adminDraftRevisionRef.current += 1;
    setAdminDraftState(update);
  };

  async function refreshAdmin(options: { discardChanges?: boolean; only?: "settings" | "sync" | "diagnostics" | "users" } = {}) {
    const revisionAtStart = adminDraftRevisionRef.current;
    const draftWasDirty = adminDirty;
    if (!options.only || options.only === "settings") setAdminLoading(true);
    async function loadSurface<T>(key: "settings" | "sync" | "diagnostics" | "users", load: () => Promise<T>, apply: (value: T) => void) {
      if (options.only && options.only !== key) return;
      const generation = (adminRefreshGenerationRef.current[key] ?? 0) + 1;
      adminRefreshGenerationRef.current[key] = generation;
      const isCurrent = () => generation === adminRefreshGenerationRef.current[key];
      await settleAdminSurface(load, (value) => {
        if (!isCurrent()) return;
        apply(value);
        setAdminLoadErrors((current) => { const next = { ...current }; delete next[key]; return next; });
      }, (message) => {
        if (isCurrent()) setAdminLoadErrors((current) => ({ ...current, [key]: message }));
      });
      if (key === "settings" && isCurrent()) setAdminLoading(false);
    }
    await Promise.allSettled([
      loadSurface("settings", moodarrApi.adminSettings, (adminSettings) => {
        setSettings(adminSettings);
        if (options.discardChanges || (!draftWasDirty && adminDraftRevisionRef.current === revisionAtStart)) {
          adminDraftRevisionRef.current += 1;
          setAdminDraftState(buildAdminDraft(adminSettings));
        }
        setAdminLoaded(true);
      }),
      loadSurface("sync", moodarrApi.syncStatus, setSyncStatus),
      loadSurface("diagnostics", moodarrApi.recommendationDiagnostics, setRecommendationDiagnostics),
      loadSurface("users", moodarrApi.adminUsers, (users) => setAdminUsers(users.users))
    ]);
  }

  async function saveAdminSettings(event: FormEvent, section: AdminSettingsSection = "connections") {
    event.preventDefault();
    const saved = await runAction("admin-save", () => moodarrApi.updateAdminSettings(settingsForSection(adminDraft, section)), () => `${section === "access" ? "Plex sign-in" : section === "connections" ? "Connection" : "Preference"} settings saved.`);
    if (saved) {
      setSettings(saved);
      adminDraftRevisionRef.current += 1;
      setAdminDraftState((current) => replaceSettingsSection(current, buildAdminDraft(saved), section));
    }
  }

  function discardAdminChanges(section?: AdminSettingsSection) {
    if (!settings) return;
    adminDraftRevisionRef.current += 1;
    setAdminDraftState((current) => section ? replaceSettingsSection(current, buildAdminDraft(settings), section) : buildAdminDraft(settings));
  }

  async function updateAdminUser(user: AuthUser, update: AdminUserUpdate) {
    await runAction(
      `admin-user-${user.id}`,
      () => moodarrApi.updateAdminUser(user.id, update),
      () => `${displayUserName(user)} access updated.`,
      refreshAdmin
    );
  }

  return {
    settings,
    syncStatus,
    recommendationDiagnostics,
    adminUsers,
    adminDraft,
    setAdminDraft,
    adminLoaded,
    adminLoading,
    adminDirty,
    adminDirtySections,
    adminLoadErrors,
    retryAdminSurface: (only: "settings" | "sync" | "diagnostics" | "users") => refreshAdmin({ only }),
    refreshAdmin,
    discardAdminChanges,
    saveAdminSettings,
    updateAdminUser
  };
}

function buildAdminDraft(adminSettings: AdminSettings): AdminSettingsUpdate {
  return {
    fixtureMode: adminSettings.fixtureMode,
    plex: {
      baseUrl: adminSettings.plex.baseUrl ?? "",
      webBaseUrl: adminSettings.plex.webBaseUrl ?? ""
    },
    seerr: {
      baseUrl: adminSettings.seerr.baseUrl ?? ""
    },
    ai: {
      provider: adminSettings.ai.provider,
      openaiModel: adminSettings.ai.openaiModel,
      openaiEmbeddingModel: adminSettings.ai.openaiEmbeddingModel,
      openaiReasoningEffort: adminSettings.ai.openaiReasoningEffort
    },
    sync: {
      intervalMinutes: adminSettings.sync.intervalMinutes,
      syncSeerr: adminSettings.sync.syncSeerr
    },
    search: {
      defaultResultLimit: adminSettings.search.defaultResultLimit
    },
    reviewQueue: {
      retentionDays: adminSettings.reviewQueue.retentionDays,
      maxQueries: adminSettings.reviewQueue.maxQueries
    },
    plexAuth: {
      enabled: adminSettings.plexAuth.enabled,
      allowNewUsers: adminSettings.plexAuth.allowNewUsers
    }
  };
}

function displayUserName(user: AuthUser) {
  return user.displayName || user.username || user.email || "Plex user";
}
