import { useState, type FormEvent } from "react";
import { moodarrApi } from "./api";
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

export function useReviewQueueState(setBusy: BusySetter, setNotice: NoticeSetter) {
  const [reviewQueue, setReviewQueue] = useState<QueryReviewQueueResponse | null>(null);
  const [reviewStatus, setReviewStatus] = useState<QueryReviewStatus>("pending");
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, string>>({});
  const [reviewRatings, setReviewRatings] = useState<Record<string, number>>({});

  async function refreshReviewQueue(statusOverride = reviewStatus) {
    setBusy("review-refresh");
    setNotice("");
    try {
      const queue = await moodarrApi.reviewQueue(statusOverride, 50);
      setReviewQueue(queue);
      setReviewDrafts(Object.fromEntries(queue.items.map((item) => [item.id, item.moodFeedbackText ?? ""])));
      setReviewRatings(Object.fromEntries(queue.items.flatMap((item) => (item.moodFitRating ? [[item.id, item.moodFitRating] as const] : []))));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
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
  const [adminDraft, setAdminDraft] = useState<AdminSettingsUpdate>({});

  async function refreshAdmin() {
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
    setAdminDraft(buildAdminDraft(adminSettings));
  }

  async function saveAdminSettings(event: FormEvent) {
    event.preventDefault();
    const saved = await runAction("admin-save", () => moodarrApi.updateAdminSettings(adminDraft), () => "Settings saved.");
    if (saved) {
      setSettings(saved);
      await refreshAdmin();
    }
  }

  async function updateAdminUser(user: AuthUser, enabled: boolean) {
    await runAction(`admin-user-${user.id}`, () => moodarrApi.updateAdminUser(user.id, { enabled }), () => `${displayUserName(user)} ${enabled ? "enabled" : "disabled"}.`);
    await refreshAdmin();
  }

  return {
    settings,
    syncStatus,
    recommendationDiagnostics,
    adminUsers,
    adminDraft,
    setAdminDraft,
    refreshAdmin,
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
