import { useEffect, useRef, useState, type Dispatch, type FormEvent, type SetStateAction } from "react";
import { moodarrApi } from "./api";
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
type BusySetter = (message: string) => void;
type RunAction = <T>(name: string, action: () => Promise<T>, message: (result: T) => string) => Promise<T | undefined>;
export type AdminUserUpdate = { enabled?: boolean; canRequest?: boolean; canUseAi?: boolean };

export function useReviewQueueState(setBusy: BusySetter, setNotice: NoticeSetter) {
  const [reviewQueue, setReviewQueue] = useState<QueryReviewQueueResponse | null>(null);
  const [reviewStatus, setReviewStatus] = useState<QueryReviewStatus>("pending");
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, string>>({});
  const [reviewRatings, setReviewRatings] = useState<Record<string, number>>({});
  const reviewRequestRef = useRef<LatestRequestLifecycle | null>(null);
  reviewRequestRef.current ??= new LatestRequestLifecycle();

  useEffect(() => () => reviewRequestRef.current?.abort(), []);

  async function refreshReviewQueue(statusOverride = reviewStatus) {
    const request = reviewRequestRef.current!.begin();
    setBusy("review-refresh");
    setNotice("");
    try {
      const queue = await moodarrApi.reviewQueue(statusOverride, 50, request.signal);
      if (!reviewRequestRef.current!.isCurrent(request.generation)) return;
      setReviewQueue(queue);
      setReviewDrafts(Object.fromEntries(queue.items.map((item) => [item.id, item.moodFeedbackText ?? ""])));
      setReviewRatings(Object.fromEntries(queue.items.flatMap((item) => (item.moodFitRating ? [[item.id, item.moodFitRating] as const] : []))));
    } catch (error) {
      if (isAbortError(error)) return;
      if (!reviewRequestRef.current!.isCurrent(request.generation)) return;
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      if (reviewRequestRef.current!.isCurrent(request.generation)) setBusy("");
    }
  }

  function updateReviewDraft(id: string, value: string) {
    setReviewDrafts((current) => ({ ...current, [id]: value }));
  }

  function updateReviewRating(id: string, value: number) {
    setReviewRatings((current) => ({ ...current, [id]: value }));
  }

  async function submitReviewFeedback(item: QueryReviewQueueItem) {
    const moodFitRating = reviewRatings[item.id] ?? item.moodFitRating;
    if (!moodFitRating) {
      setNotice("Choose a mood fit rating before saving the review.");
      return;
    }

    setBusy(`review-save:${item.id}`);
    setNotice("");
    try {
      const saved = await moodarrApi.updateReviewQueueItem(item.id, {
        moodFitRating,
        moodFeedbackText: reviewDrafts[item.id] ?? item.moodFeedbackText ?? ""
      });
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
      setBusy("");
    }
  }

  return {
    reviewQueue,
    reviewStatus,
    setReviewStatus,
    reviewDrafts,
    reviewRatings,
    refreshReviewQueue,
    updateReviewDraft,
    updateReviewRating,
    submitReviewFeedback
  };
}

export function useAdminConsole(runAction: RunAction) {
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [recommendationDiagnostics, setRecommendationDiagnostics] = useState<RecommendationDiagnostics | null>(null);
  const [adminUsers, setAdminUsers] = useState<AuthUser[]>([]);
  const [adminDraft, setAdminDraftState] = useState<AdminSettingsUpdate>({});
  const [adminLoaded, setAdminLoaded] = useState(false);
  const [adminLoading, setAdminLoading] = useState(false);
  const [adminDirty, setAdminDirty] = useState(false);
  const adminDraftRevisionRef = useRef(0);

  useEffect(() => {
    if (!syncStatus?.running) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const current = await moodarrApi.syncStatus();
        if (!cancelled) setSyncStatus(current);
      } catch {
        // A later poll or manual refresh can recover a transient failure.
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
    setAdminDirty(true);
    setAdminDraftState(update);
  };

  async function refreshAdmin(options: { discardChanges?: boolean } = {}) {
    const revisionAtStart = adminDraftRevisionRef.current;
    const draftWasDirty = adminDirty;
    setAdminLoading(true);
    try {
      const [adminSettings, scheduler, diagnostics, users] = await Promise.all([
        moodarrApi.adminSettings(),
        moodarrApi.syncStatus(),
        moodarrApi.recommendationDiagnostics(),
        moodarrApi.adminUsers()
      ]);
      setSettings(adminSettings);
      setSyncStatus(scheduler);
      setRecommendationDiagnostics(diagnostics);
      setAdminUsers(users.users);
      if (options.discardChanges || (!draftWasDirty && adminDraftRevisionRef.current === revisionAtStart)) {
        adminDraftRevisionRef.current += 1;
        setAdminDraftState(buildAdminDraft(adminSettings));
        setAdminDirty(false);
      }
      setAdminLoaded(true);
    } finally {
      setAdminLoading(false);
    }
  }

  async function saveAdminSettings(event: FormEvent) {
    event.preventDefault();
    const saved = await runAction("admin-save", () => moodarrApi.updateAdminSettings(adminDraft), () => "Settings saved.");
    if (saved) {
      setSettings(saved);
      adminDraftRevisionRef.current += 1;
      setAdminDraftState(buildAdminDraft(saved));
      setAdminDirty(false);
      await refreshAdmin({ discardChanges: true });
    }
  }

  function discardAdminChanges() {
    if (!settings) return;
    adminDraftRevisionRef.current += 1;
    setAdminDraftState(buildAdminDraft(settings));
    setAdminDirty(false);
  }

  async function updateAdminUser(user: AuthUser, update: AdminUserUpdate) {
    await runAction(`admin-user-${user.id}`, () => moodarrApi.updateAdminUser(user.id, update), () => `${displayUserName(user)} access updated.`);
    await refreshAdmin();
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
