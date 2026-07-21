import { GearSix, Info, ListChecks, MagnifyingGlass, ShieldCheck, SpinnerGap, User, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type * as React from "react";
import { moodarrApi } from "./api";
import { finderAvailabilityGroup, type FinderAvailabilityGroup } from "./availability";
import { ExclusiveActionLock, isActionNavigationBlocked, runActionTask, settleRefreshTasks } from "./actionTask";
import { AdminAccessGate, type AdminCapability } from "./AdminAccessGate";
import { useAdminConsole, useReviewQueueState } from "./appHooks";
import { activeViewFromPathname, pathnameForActiveView, type ActiveView } from "./navigation";
import { isAbortError, LatestRequestLifecycle } from "./requestLifecycle";
import {
  buildPlexAuthReturnUrl,
  cleanPlexAuthReturnUrl,
  clearPendingPlexAuth,
  isPlexAuthReturnUrl,
  loadPendingPlexAuth,
  savePendingPlexAuth,
  type PendingPlexAuth
} from "./plexAuthState";
import { FinderView } from "./features/finder/FinderView";
import {
  applyFeedbackRanking,
  buildFeedbackContext,
  clearFeedbackState,
  clearPreferredExampleState,
  clearTitleState,
  copyText,
  createId,
  describeChangedCriteria,
  extractFeedbackMoodTerm,
  formatList,
  getSpeechRecognitionConstructor,
  hiddenFeedbackCount,
  loadSavedQueries,
  markRequestCreated,
  mergeUniqueItems,
  nextFeedbackState,
  nextFeedbackTitleState,
  nextPreferredExampleState,
  nextPreferredExampleTitleState,
  persistSavedQueries,
  retainedPotentialItems,
  resultAvailabilityFocusId,
  summarizeFeedbackSelection,
  upsertSavedQuery,
  visibleResultsFromPool,
  type ChatMessage,
  type DisplayMode,
  type RecommendationFeedback,
  type SavedQuery,
  type SearchProgressState,
  type SpeechRecognitionLike,
  type VoiceState
} from "./features/finder/finderModel";
import { ReviewQueueView } from "./features/review/ReviewQueueView";
import { AdminView } from "./features/admin/AdminView";
import { buildConversationQuery, deriveChatCriteria, maxSearchResultLimit, type ChatCriteria } from "./chatCriteria";
import { CreditsPanel } from "./CreditsPanel";
import { defaultSearchResultLimit } from "../shared/types";
import type {
  AuthSessionResponse,
  AuthUser,
  ConfigStatusResponse,
  ItemSummary,
  LibraryStats,
  RequestPreview,
  SearchFilters,
  SyncStatus,
  WatchContext
} from "../shared/types";

const groupOrder: FinderAvailabilityGroup[] = [
  "available_in_plex",
  "not_in_plex_requestable",
  "already_requested",
  "partially_available",
  "request_attempt",
  "unavailable"
];

type BootstrapConnectionState =
  | { phase: "checking" }
  | { phase: "ready" }
  | { phase: "unavailable"; message: string };

export function App() {
  const [activeView, setActiveView] = useState<ActiveView>(() => activeViewFromPathname(window.location.pathname));
  const [adminCapability, setAdminCapability] = useState<AdminCapability>("unknown");
  const [adminTokenDraft, setAdminTokenDraft] = useState("");
  const [status, setStatus] = useState<ConfigStatusResponse | null>(null);
  const [bootstrapConnection, setBootstrapConnection] = useState<BootstrapConnectionState>({ phase: "checking" });
  const [authSession, setAuthSession] = useState<AuthSessionResponse | null>(null);
  const [pendingPlexAuth, setPendingPlexAuth] = useState<PendingPlexAuth | null>(() => loadPendingPlexAuth(window.localStorage));
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [chatDraft, setChatDraft] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [filters, setFilters] = useState<SearchFilters>({});
  const [resultLimit, setResultLimit] = useState(defaultSearchResultLimit);
  const [watchContext, setWatchContext] = useState<WatchContext>("solo");
  const [resultPool, setResultPool] = useState<ItemSummary[]>([]);
  const [results, setResults] = useState<ItemSummary[]>([]);
  const [displayMode, setDisplayMode] = useState<DisplayMode>("comfortable");
  const [feedbackByItem, setFeedbackByItem] = useState<Record<string, RecommendationFeedback>>({});
  const [feedbackTitleByItem, setFeedbackTitleByItem] = useState<Record<string, string>>({});
  const [preferredExampleByItem, setPreferredExampleByItem] = useState<Record<string, boolean>>({});
  const [preferredExampleTitleByItem, setPreferredExampleTitleByItem] = useState<Record<string, string>>({});
  const [showRatedItems, setShowRatedItems] = useState(true);
  const [submittedFeedbackByItem, setSubmittedFeedbackByItem] = useState<Record<string, RecommendationFeedback>>({});
  const [submittedPreferredExampleByItem, setSubmittedPreferredExampleByItem] = useState<Record<string, boolean>>({});
  const [criteriaDirty, setCriteriaDirty] = useState(false);
  const [lastSearchQuery, setLastSearchQuery] = useState("");
  const [latestSuccessfulQuery, setLatestSuccessfulQuery] = useState("");
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>(() => loadSavedQueries());
  const [preview, setPreview] = useState<RequestPreview | null>(null);
  const [previewPendingItemId, setPreviewPendingItemId] = useState<string | null>(null);
  const [seasonSelections, setSeasonSelections] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string>("");
  const [showCredits, setShowCredits] = useState(false);
  const [busy, setBusy] = useState<string>("");
  const [searchProgress, setSearchProgress] = useState<SearchProgressState | null>(null);
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const voiceRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const plexReturnHandledRef = useRef(false);
  const adminLoadRequestedRef = useRef(false);
  const baseScoreByItemIdRef = useRef<Record<string, number>>({});
  const previousDefaultResultLimitRef = useRef(defaultSearchResultLimit);
  const bootstrapReadyRef = useRef(false);
  const statusRefreshGenerationRef = useRef(0);
  const statusRefreshInFlightRef = useRef<Promise<void> | null>(null);
  const searchRequestRef = useRef<LatestRequestLifecycle | null>(null);
  searchRequestRef.current ??= new LatestRequestLifecycle();
  const actionLockRef = useRef<ExclusiveActionLock | null>(null);
  actionLockRef.current ??= new ExclusiveActionLock();
  const {
    reviewQueue,
    reviewStatus,
    reviewLoadState,
    setReviewStatus,
    reviewDrafts,
    reviewRatings,
    refreshReviewQueue,
    updateReviewDraft,
    updateReviewRating,
    submitReviewFeedback
  } = useReviewQueueState(beginBusy, endBusy, setNotice);
  const {
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
  } = useAdminConsole(runAction, handleSyncSettled);

  useEffect(() => {
    void refreshStatus({ preserveReadyOnFailure: false }).catch(() => undefined);
    return () => searchRequestRef.current?.abort();
  }, []);

  useEffect(() => {
    const refreshVisibleSession = () => {
      if (document.visibilityState === "visible") refreshStatusInBackground();
    };
    window.addEventListener("focus", refreshVisibleSession);
    document.addEventListener("visibilitychange", refreshVisibleSession);
    return () => {
      window.removeEventListener("focus", refreshVisibleSession);
      document.removeEventListener("visibilitychange", refreshVisibleSession);
    };
  }, []);

  useEffect(() => {
    if (plexReturnHandledRef.current || !isPlexAuthReturnUrl(window.location.href)) return;
    plexReturnHandledRef.current = true;
    window.history.replaceState(window.history.state, "", cleanPlexAuthReturnUrl(window.location.href));
    const storedAuth = loadPendingPlexAuth(window.localStorage);
    if (!storedAuth) {
      setNotice("Plex authorization returned, but the sign-in request expired. Start Plex sign-in again.");
      return;
    }
    setPendingPlexAuth(storedAuth);
    void completePlexSignIn(storedAuth);
  }, []);

  useEffect(() => {
    if (!getSpeechRecognitionConstructor()) setVoiceState("unsupported");
  }, []);

  useEffect(() => {
    if (activeView === "review" && adminCapability === "available") void refreshReviewQueue();
  }, [activeView, reviewStatus, adminCapability]);

  useEffect(() => {
    if (
      activeView === "admin"
      && adminCapability === "available"
      && !adminLoaded
      && !adminLoading
      && !adminLoadRequestedRef.current
      && !isActionNavigationBlocked(actionLockRef.current!)
    ) {
      adminLoadRequestedRef.current = true;
      void runAction("admin-refresh", refreshAdmin, () => "");
    }
  }, [activeView, adminCapability, adminLoaded, adminLoading, busy]);

  useEffect(() => {
    const handlePopState = () => {
      const nextView = activeViewFromPathname(window.location.pathname);
      if (isActionNavigationBlocked(actionLockRef.current!) || !confirmAdminNavigation(nextView)) {
        window.history.pushState(window.history.state, "", pathnameForActiveView(activeView));
        return;
      }
      setActiveView(nextView);
      focusActiveView(nextView);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [activeView, adminDirty]);

  useEffect(() => {
    if (!adminDirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [adminDirty]);

  useEffect(() => {
    if (!showCredits) return;
    const closeCreditsOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setShowCredits(false);
      window.requestAnimationFrame(() => document.getElementById("credits-button")?.focus({ preventScroll: true }));
    };
    document.addEventListener("keydown", closeCreditsOnEscape);
    return () => document.removeEventListener("keydown", closeCreditsOnEscape);
  }, [showCredits]);

  const grouped = useMemo(() => {
    return groupOrder.map((group) => ({
      group,
      items: results.filter((item) => finderAvailabilityGroup(item) === group)
    }));
  }, [results]);
  const hasSearchSession = chatMessages.length > 0 || results.length > 0 || Object.keys(feedbackByItem).length > 0 || Object.keys(preferredExampleByItem).length > 0;
  const configuredDefaultResultLimit = status?.runtime.defaultResultLimit ?? defaultSearchResultLimit;
  const finderCanRequest = authSession?.authenticated ? authSession.user?.canRequest !== false : true;
  const finderCanUseAi = authSession?.authenticated ? authSession.user?.canUseAi !== false : true;
  const finderAccessBlocked = isFinderAccessBlocked(status, adminCapability, authSession);

  useEffect(() => {
    const nextDefault = status?.runtime.defaultResultLimit;
    if (nextDefault === undefined) return;
    setResultLimit((current) => {
      const previousDefault = previousDefaultResultLimitRef.current;
      previousDefaultResultLimitRef.current = nextDefault;
      return !hasSearchSession && current === previousDefault ? nextDefault : current;
    });
  }, [status?.runtime.defaultResultLimit, hasSearchSession]);

  function refreshStatus({ preserveReadyOnFailure = bootstrapReadyRef.current }: { preserveReadyOnFailure?: boolean } = {}) {
    const request = performStatusRefresh(preserveReadyOnFailure);
    statusRefreshInFlightRef.current = request;
    void request.then(
      () => {
        if (statusRefreshInFlightRef.current === request) statusRefreshInFlightRef.current = null;
      },
      () => {
        if (statusRefreshInFlightRef.current === request) statusRefreshInFlightRef.current = null;
      }
    );
    return request;
  }

  function refreshStatusInBackground() {
    if (statusRefreshInFlightRef.current) return;
    void refreshStatus({ preserveReadyOnFailure: true }).catch(() => undefined);
  }

  async function performStatusRefresh(preserveReadyOnFailure: boolean) {
    const generation = ++statusRefreshGenerationRef.current;
    try {
      const [adminSessionResult, configStatus, sessionResult] = await Promise.all([
        settleStatusCall(moodarrApi.adminSession()),
        moodarrApi.configStatus(),
        settleStatusCall(moodarrApi.authSession())
      ]);
      const accessGranted = canLoadLibraryStats({
        adminSessionAvailable: adminSessionResult.ok && adminSessionResult.value.ok,
        adminAuthRequired: configStatus.admin.authRequired,
        userAuthenticated: sessionResult.ok && Boolean(sessionResult.value.authenticated)
      });
      const accessResolved = !configStatus.admin.authRequired || (adminSessionResult.ok && sessionResult.ok);
      const libraryStats = accessGranted
        ? await moodarrApi.stats().catch(() => null)
        : accessResolved
          ? null
          : undefined;
      if (generation !== statusRefreshGenerationRef.current) return;
      setAdminCapability((current) =>
        adminSessionResult.ok
          ? adminSessionResult.value.ok
            ? "available"
            : "unavailable"
          : current === "unknown"
            ? "unavailable"
            : current
      );
      setStatus(configStatus);
      if (libraryStats !== undefined) setStats(libraryStats);
      if (sessionResult.ok) setAuthSession(sessionResult.value);
      bootstrapReadyRef.current = true;
      setBootstrapConnection({ phase: "ready" });
      if (sessionResult.ok && sessionResult.value.authenticated) {
        clearPendingPlexAuth(window.localStorage);
        setPendingPlexAuth(null);
      }
    } catch (error) {
      if (generation === statusRefreshGenerationRef.current && (!preserveReadyOnFailure || !bootstrapReadyRef.current)) {
        bootstrapReadyRef.current = false;
        setAdminCapability((current) => current === "unknown" ? "unavailable" : current);
        setBootstrapConnection({ phase: "unavailable", message: describeBootstrapFailure(error) });
      }
      throw error;
    }
  }

  function retryBootstrap() {
    bootstrapReadyRef.current = false;
    setBootstrapConnection({ phase: "checking" });
    void refreshStatus({ preserveReadyOnFailure: false }).catch(() => undefined);
  }

  async function handleSyncSettled(finalStatus: SyncStatus) {
    await refreshStatus();
    if (finalStatus.lastResult && !finalStatus.lastResult.ok) {
      setNotice(`Sync failed: ${finalStatus.lastResult.error ?? "Check the sync history and server logs."}`);
    }
  }

  async function runAction<T>(
    name: string,
    action: () => Promise<T>,
    message: (result: T) => string,
    refreshAfter?: () => Promise<unknown>
  ) {
    if (!beginBusy(name)) return undefined;
    setNotice("");
    try {
      return await runActionTask(
        action,
        message,
        refreshAfter ? () => settleRefreshTasks([refreshStatus, refreshAfter]) : refreshStatus,
        setNotice
      );
    } finally {
      endBusy(name);
    }
  }

  function beginBusy(name: string) {
    if (!actionLockRef.current!.tryAcquire(name)) return false;
    setBusy(name);
    return true;
  }

  function endBusy(name: string) {
    if (!actionLockRef.current!.release(name)) return;
    setBusy("");
  }

  function confirmAdminNavigation(nextView: ActiveView) {
    if (activeView !== "admin" || nextView === "admin" || !adminDirty) return true;
    if (!window.confirm("Discard unsaved Admin settings?")) return false;
    discardAdminChanges();
    return true;
  }

  function navigateToView(nextView: ActiveView) {
    if (nextView === activeView) return;
    if (isActionNavigationBlocked(actionLockRef.current!)) return;
    if (!confirmAdminNavigation(nextView)) return;
    window.history.pushState(window.history.state, "", pathnameForActiveView(nextView));
    setActiveView(nextView);
    focusActiveView(nextView);
  }

  function toggleCredits() {
    const nextOpen = !showCredits;
    setShowCredits(nextOpen);
    window.requestAnimationFrame(() => {
      if (nextOpen) document.getElementById("credits-panel")?.focus({ preventScroll: true });
      else document.getElementById("credits-button")?.focus({ preventScroll: true });
    });
  }

  function closeCredits() {
    setShowCredits(false);
    window.requestAnimationFrame(() => document.getElementById("credits-button")?.focus({ preventScroll: true }));
  }

  async function lockAdminSession() {
    if (adminDirty && !window.confirm("Lock Admin and discard unsaved settings?")) return;
    if (adminDirty) discardAdminChanges();
    const result = await runAction("admin-lock", moodarrApi.lockAdminSession, () => "Admin access locked for this browser.");
    if (!result?.ok) return;
    setAdminCapability("unavailable");
    adminLoadRequestedRef.current = false;
    window.history.pushState(window.history.state, "", pathnameForActiveView("finder"));
    setActiveView("finder");
    focusActiveView("finder");
  }

  async function createAdminSession(event: React.FormEvent) {
    event.preventDefault();
    const token = adminTokenDraft.trim();
    if (!token) return;
    try {
      const result = await runAction("admin-sign-in", () => moodarrApi.createAdminSession(token), () => "Admin access unlocked for this browser session.");
      if (result?.ok) {
        setAdminCapability("available");
        focusActiveView(activeView);
      }
    } finally {
      setAdminTokenDraft("");
    }
  }

  async function startPlexSignIn() {
    const authWindow = window.open("about:blank", "_blank");
    if (authWindow) authWindow.opener = null;
    const result = await runAction(
      "plex-sign-in",
      () => moodarrApi.startPlexAuth({ returnUrl: buildPlexAuthReturnUrl(window.location.href) }),
      () => "Plex authorization opened."
    );
    if (!result) {
      authWindow?.close();
      return;
    }
    const pendingAuth = { pinId: result.pinId, code: result.code, createdAt: Date.now() };
    savePendingPlexAuth(window.localStorage, pendingAuth);
    setPendingPlexAuth(pendingAuth);
    if (authWindow && !authWindow.closed) authWindow.location.replace(result.authUrl);
    else window.location.assign(result.authUrl);
  }

  async function completePlexSignIn(auth: PendingPlexAuth | null = pendingPlexAuth) {
    if (!auth) return;
    const result = await runAction(
      "plex-sign-in-check",
      () => moodarrApi.completePlexAuth({ pinId: auth.pinId, code: auth.code }),
      (session) => (session.authenticated ? `Signed in as ${displayUserName(session.user)}.` : "Plex authorization is still pending.")
    );
    if (result?.authenticated) {
      setAuthSession(result);
      setPendingPlexAuth(null);
      clearPendingPlexAuth(window.localStorage);
    }
  }

  async function logout() {
    await runAction("logout", moodarrApi.logout, () => "Signed out.");
    setAuthSession({ authenticated: false, plexAuthEnabled: Boolean(status?.auth.plexAuthEnabled), allowNewPlexUsers: Boolean(status?.auth.allowNewPlexUsers) });
  }

  async function submitChat(event?: React.FormEvent, promptOverride?: string) {
    event?.preventDefault();
    const prompt = (promptOverride ?? chatDraft).trim();
    if (!prompt) return;
    const criteria = deriveChatCriteria(prompt, filters, resultLimit, watchContext);
    await runRecommendationSearch({ ...criteria, query: buildConversationQuery(prompt, lastSearchQuery) }, prompt);
  }

  async function rerunWithCurrentCriteria() {
    const query = lastSearchQuery || chatMessages.findLast((message) => message.role === "user")?.text || "Update recommendations with the current filters.";
    await runRecommendationSearch(
      {
        query,
        filters,
        resultLimit,
        watchContext,
        applied: []
      },
      "Update recommendations with the current filters."
    );
  }

  async function runRecommendationSearch(criteria: ChatCriteria, userText: string) {
    if (!beginBusy("search")) return;
    const request = searchRequestRef.current!.begin();
    const userMessage: ChatMessage = { id: createId(), role: "user", text: userText };
    const requestedLimit = Math.min(maxSearchResultLimit, criteria.resultLimit + hiddenFeedbackCount(feedbackByItem, showRatedItems));
    setChatMessages((current) => [...current, userMessage]);
    setChatDraft("");
    setFilters(criteria.filters);
    setResultLimit(criteria.resultLimit);
    setWatchContext(criteria.watchContext);
    setSubmittedFeedbackByItem(feedbackByItem);
    setSubmittedPreferredExampleByItem(preferredExampleByItem);
    setCriteriaDirty(false);
    setLastSearchQuery(criteria.query);
    setSearchProgress({
      id: createId(),
      kind: hasSearchSession ? "refinement" : "search",
      catalogTotal: stats?.totalItems ?? 0,
      resultLimit: criteria.resultLimit,
      requestedLimit,
      startedAt: Date.now()
    });
    setNotice("");
    setPreview(null);
    try {
      const response = await moodarrApi.search(
        {
          query: criteria.query,
          watchContext: criteria.watchContext,
          resultLimit: requestedLimit,
          filters: criteria.filters,
          feedbackContext: buildFeedbackContext(feedbackByItem, preferredExampleByItem, showRatedItems)
        },
        request.signal
      );
      if (!searchRequestRef.current!.isCurrent(request.generation)) return;
      baseScoreByItemIdRef.current = Object.fromEntries(response.results.map((item) => [item.id, item.score]));
      const retainedPotentials = retainedPotentialItems(response.results, resultPool, feedbackByItem);
      const ranked = applyFeedbackRanking(mergeUniqueItems(response.results, retainedPotentials), feedbackByItem, preferredExampleByItem, baseScoreByItemIdRef.current);
      setResultPool(ranked);
      setResults(visibleResultsFromPool(ranked, feedbackByItem, showRatedItems, criteria.resultLimit));
      setLatestSuccessfulQuery(response.optimizedQuery || criteria.query);
      setChatMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "assistant",
          kind: "search",
          text: response.summary,
          refinementOptions: response.refinementOptions
        }
      ]);
      await refreshStatus();
    } catch (error) {
      if (isAbortError(error)) return;
      if (!searchRequestRef.current!.isCurrent(request.generation)) return;
      const message = error instanceof Error ? error.message : String(error);
      setNotice(message);
      setChatMessages((current) => [
        ...current,
        {
          id: createId(),
          role: "assistant",
          kind: "search",
          text: `I couldn’t finish that search: ${message}`
        }
      ]);
    } finally {
      if (searchRequestRef.current!.isCurrent(request.generation)) {
        setSearchProgress(null);
        endBusy("search");
        if (activeView === "finder") focusFinderAfterSearch();
      }
    }
  }

  async function copyLatestSuccessfulQuery() {
    const query = latestSuccessfulQuery.trim();
    if (!query) return;
    try {
      await copyText(query);
      setNotice("Copied latest successful query.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not copy query.");
    }
  }

  function saveLatestSuccessfulQuery() {
    const query = latestSuccessfulQuery.trim();
    if (!query) return;
    setSavedQueries((current) => persistSavedQueries(upsertSavedQuery(current, query)));
    setNotice("Saved latest successful query.");
  }

  async function runSavedQuery(query: string) {
    const prompt = query.trim();
    if (!prompt) return;
    const criteria = deriveChatCriteria(prompt, filters, resultLimit, watchContext);
    await runRecommendationSearch({ ...criteria, query: prompt }, prompt);
  }

  function deleteSavedQuery(id: string) {
    setSavedQueries((current) => persistSavedQueries(current.filter((entry) => entry.id !== id)));
  }

  function updateManualCriteria(change: {
    filters?: SearchFilters;
    resultLimit?: number;
    watchContext?: WatchContext;
    showRatedItems?: boolean;
  }) {
    const nextFilters = change.filters ?? filters;
    const nextLimit = change.resultLimit ?? resultLimit;
    const nextContext = change.watchContext ?? watchContext;
    const nextShowRatedItems = change.showRatedItems ?? showRatedItems;
    const nextCriteriaDirty = Boolean(change.filters || change.watchContext || change.resultLimit !== undefined);

    if (change.filters) setFilters(nextFilters);
    if (change.resultLimit !== undefined) setResultLimit(nextLimit);
    if (change.watchContext) setWatchContext(nextContext);
    if (change.showRatedItems !== undefined) setShowRatedItems(nextShowRatedItems);
    if (resultPool.length > 0 && (change.showRatedItems !== undefined || change.resultLimit !== undefined)) {
      setResults(visibleResultsFromPool(resultPool, feedbackByItem, nextShowRatedItems, nextLimit));
    }
    if (nextCriteriaDirty && hasSearchSession) setCriteriaDirty(true);
    noteCriteriaChange(change, nextContext, nextShowRatedItems);
  }

  function noteCriteriaChange(
    change: {
      filters?: SearchFilters;
      resultLimit?: number;
      watchContext?: WatchContext;
      showRatedItems?: boolean;
    },
    nextContext: WatchContext,
    nextShowRatedItems: boolean
  ) {
    const changedCriteria = describeChangedCriteria(change, nextContext);
    const text =
      changedCriteria.length > 0
        ? hasSearchSession
          ? `Got it. I’ll keep the same mood and use ${formatList(changedCriteria)} on the next pass. Tap Update when you’re ready to refresh the recommendations.`
          : `Got it. I’ll use ${formatList(changedCriteria)} when you describe what you feel like watching.`
        : nextShowRatedItems
          ? "Got it. I’ll show things you’ve already rated again for this round."
          : "Got it. I’ll hide things you’ve already rated for this round.";
    setChatMessages((current) => {
      const next = [...current];
      const message: ChatMessage = { id: createId(), role: "assistant", kind: "criteria", text };
      if (next[next.length - 1]?.kind === "criteria") {
        next[next.length - 1] = { ...message, id: next[next.length - 1].id };
        return next;
      }
      return [...next, message];
    });
  }

  function startVoiceTranscription() {
    const SpeechRecognition = getSpeechRecognitionConstructor();
    if (!SpeechRecognition) {
      setVoiceState("unsupported");
      return;
    }
    if (voiceState === "listening") {
      voiceRecognitionRef.current?.stop();
      setVoiceState("idle");
      return;
    }

    const recognition = new SpeechRecognition();
    voiceRecognitionRef.current = recognition;
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = navigator.language || "en-US";
    recognition.onresult = (event) => {
      const transcript = Array.from(event.results)
        .map((result) => result[0]?.transcript ?? "")
        .join(" ")
        .trim();
      if (transcript) setChatDraft((current) => (current.trim() ? `${current.trim()} ${transcript}` : transcript));
    };
    recognition.onerror = () => {
      setVoiceState("idle");
      setNotice("Voice transcription was not available.");
    };
    recognition.onend = () => setVoiceState("idle");
    try {
      setVoiceState("listening");
      recognition.start();
    } catch {
      setVoiceState("idle");
      setNotice("Voice transcription was not available.");
    }
  }

  async function previewRequest(item: ItemSummary, selectedSeason?: number) {
    const seasons = item.mediaType === "tv" && selectedSeason ? [selectedSeason] : undefined;
    if (actionLockRef.current!.active) return;
    await runRequestPreviewLifecycle({
      itemId: item.id,
      load: () =>
        runAction(
          "preview",
          () => moodarrApi.previewRequest({ itemId: item.id, seasons }),
          (result) => (result.canRequest ? "Request preview ready." : result.blockedReason ?? "Request blocked.")
        ),
      setPreview,
      beginPending: setPreviewPendingItemId,
      endPending: (itemId) => setPreviewPendingItemId((current) => (current === itemId ? null : current))
    });
  }

  async function createRequest() {
    const requestPreview = preview;
    if (!requestPreview) return;
    const result = await runAction(
      "create",
      () =>
        moodarrApi.createRequest({
          itemId: requestPreview.item.id,
          mediaType: requestPreview.request.mediaType,
          tmdbId: requestPreview.request.mediaId,
          seasons: requestPreview.request.seasons,
          confirmed: true,
          confirmationPhrase: requestPreview.confirmationPhrase,
          confirmationToken: requestPreview.confirmationToken
        }),
      () => "Request created."
    );
    if (!result?.ok) return;
    setResultPool((current) => markRequestCreated(current, requestPreview.item.id, result.seerr?.status));
    setResults((current) => markRequestCreated(current, requestPreview.item.id, result.seerr?.status));
    setPreview(null);
    setPreviewPendingItemId(null);
    window.requestAnimationFrame(() => document.getElementById(resultAvailabilityFocusId(requestPreview.item.id))?.focus({ preventScroll: false }));
  }

  function cancelRequestPreview() {
    setPreview(null);
    setNotice("Request preview cancelled.");
  }

  function updateRecommendationFeedback(item: ItemSummary, feedback: RecommendationFeedback) {
    const nextFeedback = nextFeedbackState(feedbackByItem, item.id, feedback);
    const nextPreferredExamples = feedback === "down" && nextFeedback[item.id] === "down" ? clearPreferredExampleState(preferredExampleByItem, item.id) : preferredExampleByItem;
    const nextPreferredTitles =
      feedback === "down" && nextFeedback[item.id] === "down" ? clearTitleState(preferredExampleTitleByItem, item.id) : preferredExampleTitleByItem;
    const nextTitles = nextFeedbackTitleState(feedbackTitleByItem, item, nextFeedback);
    setFeedbackByItem(nextFeedback);
    setFeedbackTitleByItem(nextTitles);
    if (nextPreferredExamples !== preferredExampleByItem) setPreferredExampleByItem(nextPreferredExamples);
    if (nextPreferredTitles !== preferredExampleTitleByItem) setPreferredExampleTitleByItem(nextPreferredTitles);
    const pool = resultPool.length ? resultPool : results;
    setResults(visibleResultsFromPool(pool, nextFeedback, showRatedItems, resultLimit));
    if (nextFeedback[item.id] === "down") setPreview((current) => (current?.item.id === item.id ? null : current));
    const feedbackText = summarizeFeedbackSelection(nextFeedback, nextTitles, nextPreferredExamples, nextPreferredTitles, submittedFeedbackByItem, submittedPreferredExampleByItem);
    setChatDraft(feedbackText);
    const selectedFeedback = nextFeedback[item.id];
    if (selectedFeedback) {
      void moodarrApi
        .feelFeedback({
          action: selectedFeedback === "up" ? "more_like" : selectedFeedback === "down" ? "less_like" : "swipe_skip",
          source: "web",
          watchContext,
          itemId: item.id,
          moodTerm: extractFeedbackMoodTerm(lastSearchQuery),
          metadata: {
            surface: "finder-result-card",
            resultCount: results.length
          }
        })
        .catch((error) => {
          setNotice(error instanceof Error ? error.message : String(error));
        });
    }
  }

  function togglePreferredExample(item: ItemSummary) {
    const nextPreferredExamples = nextPreferredExampleState(preferredExampleByItem, item.id);
    const nextPreferredTitles = nextPreferredExampleTitleState(preferredExampleTitleByItem, item, nextPreferredExamples);
    const nextFeedback = nextPreferredExamples[item.id] && feedbackByItem[item.id] === "down" ? clearFeedbackState(feedbackByItem, item.id) : feedbackByItem;
    const nextFeedbackTitles = nextPreferredExamples[item.id] && feedbackByItem[item.id] === "down" ? clearTitleState(feedbackTitleByItem, item.id) : feedbackTitleByItem;
    setPreferredExampleByItem(nextPreferredExamples);
    setPreferredExampleTitleByItem(nextPreferredTitles);
    if (nextFeedback !== feedbackByItem) setFeedbackByItem(nextFeedback);
    if (nextFeedbackTitles !== feedbackTitleByItem) setFeedbackTitleByItem(nextFeedbackTitles);
    const pool = resultPool.length ? resultPool : results;
    const ranked = applyFeedbackRanking(pool, nextFeedback, nextPreferredExamples, baseScoreByItemIdRef.current);
    setResultPool(ranked);
    setResults(visibleResultsFromPool(ranked, nextFeedback, showRatedItems, resultLimit));
    const feedbackText = summarizeFeedbackSelection(
      nextFeedback,
      nextFeedbackTitles,
      nextPreferredExamples,
      nextPreferredTitles,
      submittedFeedbackByItem,
      submittedPreferredExampleByItem
    );
    setChatDraft(feedbackText);
    if (nextPreferredExamples[item.id]) {
      void moodarrApi
        .feelFeedback({
          action: "right_mood",
          source: "web",
          watchContext,
          itemId: item.id,
          moodTerm: extractFeedbackMoodTerm(lastSearchQuery),
          strength: 5,
          metadata: {
            surface: "finder-result-card-heart",
            resultCount: results.length
          }
        })
        .catch((error) => {
          setNotice(error instanceof Error ? error.message : String(error));
        });
    }
  }

  function resetSearchSession() {
    setChatDraft("");
    setChatMessages([]);
    setFilters({});
    setResultLimit(configuredDefaultResultLimit);
    setWatchContext("solo");
    setResultPool([]);
    setResults([]);
    setFeedbackByItem({});
    setFeedbackTitleByItem({});
    setPreferredExampleByItem({});
    setPreferredExampleTitleByItem({});
    setShowRatedItems(true);
    setSubmittedFeedbackByItem({});
    setSubmittedPreferredExampleByItem({});
    setCriteriaDirty(false);
    setLastSearchQuery("");
    setLatestSuccessfulQuery("");
    setPreview(null);
    setPreviewPendingItemId(null);
    setSeasonSelections({});
    setNotice("");
    baseScoreByItemIdRef.current = {};
  }

  return (
    <main id="main-content" className="app-shell" tabIndex={-1}>
      <a
        className="skip-link"
        href={`#${activeView}-view`}
        onClick={(event) => {
          event.preventDefault();
          focusActiveView(activeView);
        }}
      >
        Skip to {activeView === "finder" ? "Finder" : activeView === "review" ? "Review Queue" : "Admin"}
      </a>
      {activeView !== "finder" || finderAccessBlocked || bootstrapConnection.phase !== "ready" ? (
        <section className="topbar admin-topbar">
          <div className="topbar-meta">
            <MoodarrBrand
              subtitle={activeView === "admin" ? "Admin · Screening Desk console" : activeView === "review" ? "Review queue · Screening Desk" : "I feel like watching…"}
            />
            <nav className="topbar-actions" aria-label="Primary">
              <AccountControls
                status={status}
                authSession={authSession}
                pendingPlexAuth={pendingPlexAuth}
                busy={busy}
                onStartPlexSignIn={startPlexSignIn}
                onCompletePlexSignIn={completePlexSignIn}
              />
              {activeView !== "finder" ? (
                <button className="tab-button icon-only" onClick={() => navigateToView("finder")} disabled={Boolean(busy)} aria-label="Open finder" title="Finder">
                  <MagnifyingGlass size={18} aria-hidden="true" />
                </button>
              ) : null}
              <button
                className={activeView === "review" ? "tab-button icon-only active" : "tab-button icon-only"}
                onClick={() => navigateToView("review")}
                disabled={Boolean(busy)}
                aria-label={adminCapability === "unavailable" ? "Open review queue and unlock admin access" : "Open review queue"}
                aria-current={activeView === "review" ? "page" : undefined}
                title={adminCapability === "unavailable" ? "Review queue · admin access required" : "Review queue"}
              >
                <ListChecks size={18} aria-hidden="true" />
              </button>
              <button
                className={activeView === "admin" ? "tab-button icon-only active" : "tab-button icon-only"}
                onClick={() => navigateToView("admin")}
                disabled={Boolean(busy)}
                aria-label={adminCapability === "unavailable" ? "Open admin settings and unlock admin access" : "Open admin settings"}
                aria-current={activeView === "admin" ? "page" : undefined}
                title={adminCapability === "unavailable" ? "Admin settings · access required" : "Admin settings"}
              >
                <GearSix size={18} aria-hidden="true" />
              </button>
              <button
                id="credits-button"
                className={showCredits ? "tab-button icon-only active" : "tab-button icon-only"}
                type="button"
                onClick={toggleCredits}
                aria-label={showCredits ? "Close About and credits" : "Open About and credits"}
                aria-expanded={showCredits}
                aria-controls="credits-panel"
                title="About & credits"
              >
                <Info size={18} aria-hidden="true" />
              </button>
            </nav>
          </div>
        </section>
      ) : null}

      {showCredits ? <CreditsPanel onClose={closeCredits} /> : null}

      {notice && activeView !== "finder" ? (
        <div className="notice global-notice" role="status" aria-live="polite" aria-atomic="true">
          <WarningCircle size={16} aria-hidden="true" />
          {notice}
        </div>
      ) : null}

      {bootstrapConnection.phase !== "ready" ? (
        <BootstrapConnectionNotice
          destination={activeView}
          state={bootstrapConnection}
          onRetry={retryBootstrap}
        />
      ) : activeView === "finder" && finderAccessBlocked ? (
        <FinderAccessGate
          plexAuthEnabled={Boolean(status?.auth.plexAuthEnabled)}
          onUnlockAdmin={() => navigateToView("admin")}
        />
      ) : activeView === "finder" ? (
        <FinderView
          chatDraft={chatDraft}
          setChatDraft={setChatDraft}
          chatMessages={chatMessages}
          notice={notice}
          voiceState={voiceState}
          startVoiceTranscription={startVoiceTranscription}
          busy={busy}
          searchProgress={searchProgress}
          grouped={grouped}
          preview={preview}
          previewPendingItemId={previewPendingItemId}
          feedbackByItem={feedbackByItem}
          preferredExampleByItem={preferredExampleByItem}
          seasonSelections={seasonSelections}
          setSeasonSelections={setSeasonSelections}
          submitChat={submitChat}
          updateRecommendationFeedback={updateRecommendationFeedback}
          togglePreferredExample={togglePreferredExample}
          previewRequest={previewRequest}
          createRequest={createRequest}
          cancelRequestPreview={cancelRequestPreview}
          displayMode={displayMode}
          hasSearchSession={hasSearchSession}
          criteriaDirty={criteriaDirty}
          latestSuccessfulQuery={latestSuccessfulQuery}
          savedQueries={savedQueries}
          copyLatestSuccessfulQuery={copyLatestSuccessfulQuery}
          saveLatestSuccessfulQuery={saveLatestSuccessfulQuery}
          runSavedQuery={runSavedQuery}
          deleteSavedQuery={deleteSavedQuery}
          resetSearchSession={resetSearchSession}
          rerunWithCurrentCriteria={rerunWithCurrentCriteria}
          canRequest={finderCanRequest}
          canUseAi={finderCanUseAi}
          filters={filters}
          resultLimit={resultLimit}
          watchContext={watchContext}
          showRatedItems={showRatedItems}
          onCriteriaChange={updateManualCriteria}
          onDisplayModeChange={setDisplayMode}
          brand={<MoodarrBrand />}
          accountControl={
            <AccountControls
              status={status}
              authSession={authSession}
              pendingPlexAuth={pendingPlexAuth}
              busy={busy}
              onStartPlexSignIn={startPlexSignIn}
              onCompletePlexSignIn={completePlexSignIn}
            />
          }
          adminAccessRequired={adminCapability === "unavailable"}
          aboutOpen={showCredits}
          onOpenReview={() => navigateToView("review")}
          onOpenSettings={() => navigateToView("admin")}
          onToggleAbout={toggleCredits}
        />
      ) : adminCapability !== "available" ? (
        <AdminAccessGate
          destination={activeView}
          capability={adminCapability}
          token={adminTokenDraft}
          busy={busy === "admin-sign-in"}
          onTokenChange={setAdminTokenDraft}
          onSubmit={createAdminSession}
          onReturnToFinder={() => navigateToView("finder")}
        />
      ) : activeView === "review" ? (
        <ReviewQueueView
          queue={reviewQueue}
          status={reviewStatus}
          loadState={reviewLoadState}
          setStatus={setReviewStatus}
          drafts={reviewDrafts}
          ratings={reviewRatings}
          busy={busy}
          refreshReviewQueue={refreshReviewQueue}
          updateReviewDraft={updateReviewDraft}
          updateReviewRating={updateReviewRating}
          submitReviewFeedback={submitReviewFeedback}
        />
      ) : (
        <AdminView
          status={status}
          stats={stats}
          settings={settings}
          syncStatus={syncStatus}
          recommendationDiagnostics={recommendationDiagnostics}
          authSession={authSession}
          adminUsers={adminUsers}
          updateAdminUser={updateAdminUser}
          adminDraft={adminDraft}
          setAdminDraft={setAdminDraft}
          adminLoaded={adminLoaded}
          adminLoading={adminLoading}
          adminDirty={adminDirty}
          discardAdminChanges={discardAdminChanges}
          saveAdminSettings={saveAdminSettings}
          busy={busy}
          runAction={runAction}
          logout={logout}
          refreshAdmin={refreshAdmin}
          onLock={lockAdminSession}
        />
      )}
    </main>
  );
}

function MoodarrBrand({ subtitle = "I feel like watching…" }: { subtitle?: string }) {
  return (
    <div className="brand-lockup">
      <span className="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 64 64" focusable="false">
          <rect className="mark-stub-bg" width="64" height="64" rx="14" />
          <path
            className="mark-stub-ticket"
            fillRule="evenodd"
            d="M10 18a6 6 0 0 1 6-6h32a6 6 0 0 1 6 6v8a6 6 0 0 0 0 12v8a6 6 0 0 1-6 6H16a6 6 0 0 1-6-6v-8a6 6 0 0 0 0-12v-8Z"
          />
          <path className="mark-stub-lines" d="M26 24h18M26 32h13M26 40h18" />
          <circle className="mark-stub-punch" cx="18" cy="32" r="5" />
        </svg>
      </span>
      <div>
        <h1>Moodarr</h1>
        <p>{subtitle}</p>
      </div>
    </div>
  );
}

function focusActiveView(view: ActiveView) {
  window.requestAnimationFrame(() => {
    document.getElementById(`${view}-view`)?.focus({ preventScroll: true });
  });
}

function focusFinderAfterSearch() {
  window.requestAnimationFrame(() => {
    const prompt = document.getElementById("finder-chat-prompt");
    const compactAction = document.getElementById("finder-recommendation-action");
    const target = prompt?.getClientRects().length ? prompt : compactAction ?? prompt;
    target?.focus({ preventScroll: true });
  });
}

function BootstrapConnectionNotice({
  destination,
  state,
  onRetry
}: {
  destination: ActiveView;
  state: Exclude<BootstrapConnectionState, { phase: "ready" }>;
  onRetry: () => void;
}) {
  const checking = state.phase === "checking";
  return (
    <section
      id={`${destination}-view`}
      className="bootstrap-connection-state"
      aria-labelledby="bootstrap-connection-title"
      aria-busy={checking}
      tabIndex={-1}
    >
      <div className={checking ? "notice server-connection-notice checking" : "notice server-connection-notice"} role="status" aria-live="polite" aria-atomic="true">
        {checking ? (
          <SpinnerGap size={18} className="spin" aria-hidden="true" />
        ) : (
          <WarningCircle size={18} aria-hidden="true" />
        )}
        <div className="server-connection-copy">
          <strong id="bootstrap-connection-title">{checking ? "Connecting to Moodarr" : "Moodarr server is unavailable"}</strong>
          <span>{checking ? "Checking the server before the Screening Desk is ready." : state.message}</span>
        </div>
        {!checking ? (
          <button type="button" className="secondary-admin-button" onClick={onRetry}>
            Retry
          </button>
        ) : null}
      </div>
    </section>
  );
}

function describeBootstrapFailure(error: unknown): string {
  const fallback = "Check the Moodarr server or proxy, then try again.";
  if (!(error instanceof Error)) return fallback;
  const message = error.message.trim();
  if (!message || /<\/?[a-z!][^>]*>/i.test(message)) return fallback;
  return message.length <= 320 ? message : `${message.slice(0, 319).trimEnd()}\u2026`;
}

async function settleStatusCall<T>(request: Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await request };
  } catch {
    return { ok: false };
  }
}

export function canLoadLibraryStats(input: { adminSessionAvailable: boolean; adminAuthRequired: boolean; userAuthenticated: boolean }): boolean {
  return input.adminSessionAvailable || input.userAuthenticated || !input.adminAuthRequired;
}

function isFinderAccessBlocked(
  status: ConfigStatusResponse | null,
  adminCapability: AdminCapability,
  authSession: AuthSessionResponse | null
) {
  return Boolean(status?.admin.authRequired && adminCapability === "unavailable" && !authSession?.authenticated);
}

function FinderAccessGate({ plexAuthEnabled, onUnlockAdmin }: { plexAuthEnabled: boolean; onUnlockAdmin: () => void }) {
  return (
    <section id="finder-view" className="admin-access-gate finder-access-gate" aria-labelledby="finder-access-title" tabIndex={-1}>
      <div className="admin-panel">
        <div className="panel-title">
          <ShieldCheck size={18} aria-hidden="true" />
          <h2>Protected Finder</h2>
        </div>
        <h2 id="finder-access-title" className="access-gate-heading">
          Unlock Moodarr
        </h2>
        <p className="panel-copy">
          {plexAuthEnabled
            ? "Sign in with Plex from the header, or unlock Admin with the instance token."
            : "Unlock Admin to configure integrations and use Finder on this protected instance."}
        </p>
        <div className="access-gate-actions">
          <button type="button" onClick={onUnlockAdmin}>
            <ShieldCheck size={16} aria-hidden="true" />
            Unlock Admin
          </button>
        </div>
      </div>
    </section>
  );
}

function AccountControls({
  status,
  authSession,
  pendingPlexAuth,
  busy,
  onStartPlexSignIn,
  onCompletePlexSignIn
}: {
  status: ConfigStatusResponse | null;
  authSession: AuthSessionResponse | null;
  pendingPlexAuth: PendingPlexAuth | null;
  busy: string;
  onStartPlexSignIn: () => Promise<void>;
  onCompletePlexSignIn: () => Promise<void>;
}) {
  const plexAuthEnabled = Boolean(status?.auth.plexAuthEnabled || authSession?.plexAuthEnabled);
  if (!plexAuthEnabled) return null;
  if (authSession?.authenticated) {
    const userName = displayUserName(authSession.user);
    return (
      <div className="account-chip" aria-label={`Signed in as ${userName}`} title={userName}>
        <User size={16} aria-hidden="true" />
        <span>{userName}</span>
      </div>
    );
  }
  if (pendingPlexAuth) {
    return (
      <button type="button" className="tab-button account-button" onClick={() => void onCompletePlexSignIn()} disabled={Boolean(busy)} aria-label="Check Plex sign-in" title="Check Plex sign-in">
        {busy === "plex-sign-in-check" ? <SpinnerGap size={16} className="spin" aria-hidden="true" /> : <User size={16} aria-hidden="true" />}
        <span>Check sign-in</span>
      </button>
    );
  }
  return (
    <button type="button" className="tab-button account-button" onClick={() => void onStartPlexSignIn()} disabled={Boolean(busy)} aria-label="Sign in with Plex" title="Sign in with Plex">
      {busy === "plex-sign-in" ? <SpinnerGap size={16} className="spin" aria-hidden="true" /> : <User size={16} aria-hidden="true" />}
      <span>Sign in</span>
    </button>
  );
}

function displayUserName(user: AuthUser | undefined) {
  return user?.displayName || user?.username || user?.email || "Plex user";
}

async function runRequestPreviewLifecycle({
  itemId,
  load,
  setPreview,
  beginPending,
  endPending
}: {
  itemId: string;
  load: () => Promise<RequestPreview | undefined>;
  setPreview: (preview: RequestPreview | null) => void;
  beginPending: (itemId: string) => void;
  endPending: (itemId: string) => void;
}) {
  setPreview(null);
  beginPending(itemId);
  try {
    const request = await load();
    if (request) setPreview(request);
    return request;
  } finally {
    endPending(itemId);
  }
}

export const __appTestInternals = {
  applyFeedbackRanking,
  buildFeedbackContext,
  nextFeedbackState,
  nextPreferredExampleState,
  nextPreferredExampleTitleState,
  summarizeFeedbackSelection,
  visibleResultsFromPool,
  isFinderAccessBlocked,
  runRequestPreviewLifecycle,
  BootstrapConnectionNotice,
  describeBootstrapFailure
};
