import { useState, type FormEvent } from "react";
import { moodarrApi, getAdminToken, setAdminToken } from "./api";
import type {
  AdminSettings,
  AdminSettingsUpdate,
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

export function useAdminConsole(runAction: RunAction, setNotice: NoticeSetter) {
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [recommendationDiagnostics, setRecommendationDiagnostics] = useState<RecommendationDiagnostics | null>(null);
  const [adminToken, setAdminTokenState] = useState(getAdminToken());
  const [adminDraft, setAdminDraft] = useState<AdminSettingsUpdate>({});

  async function refreshAdmin() {
    const [adminSettings, scheduler, diagnostics] = await Promise.all([moodarrApi.adminSettings(), moodarrApi.syncStatus(), moodarrApi.recommendationDiagnostics()]);
    setSettings(adminSettings);
    setSyncStatus(scheduler);
    setRecommendationDiagnostics(diagnostics);
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

  function persistAdminToken() {
    setAdminToken(adminToken);
    setNotice(adminToken.trim() ? "Admin token saved in this browser." : "Admin token cleared from this browser.");
  }

  return {
    settings,
    syncStatus,
    recommendationDiagnostics,
    adminToken,
    setAdminTokenState,
    adminDraft,
    setAdminDraft,
    refreshAdmin,
    saveAdminSettings,
    persistAdminToken
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
      openaiEmbeddingModel: adminSettings.ai.openaiEmbeddingModel
    },
    sync: {
      intervalMinutes: adminSettings.sync.intervalMinutes,
      syncSeerr: adminSettings.sync.syncSeerr
    },
    reviewQueue: {
      retentionDays: adminSettings.reviewQueue.retentionDays,
      maxQueries: adminSettings.reviewQueue.maxQueries
    }
  };
}
