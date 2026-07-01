import {
  ArrowClockwise,
  BookmarkSimple,
  CheckCircle,
  CopySimple,
  Database,
  DownloadSimple,
  FloppyDisk,
  GearSix,
  HardDrives,
  ListChecks,
  MagnifyingGlass,
  Microphone,
  PaperPlaneTilt,
  Play,
  Sparkle,
  SignOut,
  SpinnerGap,
  Stack,
  Star,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  Trash,
  User,
  Users,
  WarningCircle
} from "@phosphor-icons/react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { moodarrApi } from "./api";
import { useAdminConsole, useReviewQueueState } from "./appHooks";
import { buildConversationQuery, deriveChatCriteria, maxSearchQueryLength, maxSearchResultLimit, type ChatCriteria } from "./chatCriteria";
import { buildPlexAuthReturnUrl, cleanPlexAuthReturnUrl, clearPendingPlexAuth, isPlexAuthReturnUrl, loadPendingPlexAuth, savePendingPlexAuth, type PendingPlexAuth } from "./plexAuthState";
import { applyRuntimeRange, clearRuntimeRange, describeRuntimeRange } from "../shared/runtime";
import { defaultSearchResultLimit, openAiReasoningEfforts } from "../shared/types";
import type {
  AdminSettings,
  AdminSettingsUpdate,
  AuthSessionResponse,
  AuthUser,
  AvailabilityGroup,
  ConfigStatusResponse,
  FeelProfileCheckpointSummary,
  FeelProfileDriftAlert,
  FeelProfileResponse,
  ItemSummary,
  LibraryStats,
  MediaType,
  QueryReviewQueueItem,
  QueryReviewQueueResponse,
  QueryReviewStatus,
  RecommendationDiagnostics,
  RefinementOption,
  RequestPreview,
  SearchFilters,
  SyncRunResult,
  SyncStatus,
  OpenAiReasoningEffort,
  WatchContext
} from "../shared/types";

const groupLabels: Record<AvailabilityGroup, string> = {
  available_in_plex: "Available in Plex",
  not_in_plex_requestable: "Not in Plex but requestable",
  already_requested: "Already requested",
  partially_available: "Partially available",
  unavailable: "Unavailable"
};

const groupOrder: AvailabilityGroup[] = ["available_in_plex", "not_in_plex_requestable", "already_requested", "partially_available", "unavailable"];

const genreOptions: [string, string][] = [
  ["", "Any style"],
  ["Comedy", "Comedy"],
  ["Documentary", "Documentary"],
  ["Fantasy", "Fantasy"],
  ["Adventure", "Adventure"],
  ["Family", "Family"],
  ["Animation", "Animation"],
  ["Action", "Action"],
  ["Drama", "Drama"],
  ["Horror", "Horror"],
  ["Mystery", "Mystery"],
  ["Romance", "Romance"],
  ["Science Fiction", "Sci-Fi"],
  ["Thriller", "Thriller"]
];

const savedQueryStorageKey = "moodarr.savedQueries";
const maxSavedQueries = 12;

type ActiveView = "finder" | "review" | "admin";
type VoiceState = "idle" | "listening" | "unsupported";
type RecommendationFeedback = "up" | "maybe" | "down";
type DisplayMode = "compact" | "comfortable" | "list";

const feedbackMoodTerms = [
  "low commitment",
  "feel good",
  "cozy",
  "dark",
  "weird",
  "light",
  "funny",
  "comfort",
  "gentle",
  "warm",
  "tense",
  "intense",
  "clever",
  "romantic",
  "magical",
  "bleak",
  "whimsical"
];

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  kind?: "criteria" | "search";
  refinementOptions?: RefinementOption[];
}

interface SavedQuery {
  id: string;
  query: string;
  createdAt: string;
}

interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { results: ArrayLike<{ 0?: { transcript: string } }> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

type AvailabilityScope = "plex" | "plex-seerr";

export function App() {
  const [activeView, setActiveView] = useState<ActiveView>("finder");
  const [status, setStatus] = useState<ConfigStatusResponse | null>(null);
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
  const [showRatedItems, setShowRatedItems] = useState(true);
  const [submittedFeedbackByItem, setSubmittedFeedbackByItem] = useState<Record<string, RecommendationFeedback>>({});
  const [criteriaDirty, setCriteriaDirty] = useState(false);
  const [lastSearchQuery, setLastSearchQuery] = useState("");
  const [latestSuccessfulQuery, setLatestSuccessfulQuery] = useState("");
  const [savedQueries, setSavedQueries] = useState<SavedQuery[]>(() => loadSavedQueries());
  const [preview, setPreview] = useState<RequestPreview | null>(null);
  const [seasonSelections, setSeasonSelections] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string>("");
  const [busy, setBusy] = useState<string>("");
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const voiceRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const plexReturnHandledRef = useRef(false);
  const baseScoreByItemIdRef = useRef<Record<string, number>>({});
  const previousDefaultResultLimitRef = useRef(defaultSearchResultLimit);
  const {
    reviewQueue,
    reviewStatus,
    setReviewStatus,
    reviewDrafts,
    reviewRatings,
    refreshReviewQueue,
    updateReviewDraft,
    updateReviewRating,
    submitReviewFeedback
  } = useReviewQueueState(setBusy, setNotice);
  const {
    settings,
    syncStatus,
    recommendationDiagnostics,
    adminUsers,
    adminDraft,
    setAdminDraft,
    refreshAdmin,
    saveAdminSettings,
    updateAdminUser
  } = useAdminConsole(runAction);

  useEffect(() => {
    void refreshStatus();
  }, []);

  useEffect(() => {
    const refreshVisibleSession = () => {
      if (document.visibilityState === "visible") void refreshStatus();
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
    if (activeView === "review") void refreshReviewQueue();
  }, [activeView, reviewStatus]);

  const grouped = useMemo(() => {
    return groupOrder.map((group) => ({
      group,
      items: results.filter((item) => item.availabilityGroup === group)
    }));
  }, [results]);
  const hasSearchSession = chatMessages.length > 0 || results.length > 0 || Object.keys(feedbackByItem).length > 0;
  const configuredDefaultResultLimit = status?.runtime.defaultResultLimit ?? defaultSearchResultLimit;

  useEffect(() => {
    const nextDefault = status?.runtime.defaultResultLimit;
    if (nextDefault === undefined) return;
    setResultLimit((current) => {
      const previousDefault = previousDefaultResultLimitRef.current;
      previousDefaultResultLimitRef.current = nextDefault;
      return !hasSearchSession && current === previousDefault ? nextDefault : current;
    });
  }, [status?.runtime.defaultResultLimit, hasSearchSession]);

  async function refreshStatus() {
    await moodarrApi.adminSession().catch(() => undefined);
    const [configStatus, libraryStats, session] = await Promise.all([moodarrApi.configStatus(), moodarrApi.stats().catch(() => null), moodarrApi.authSession().catch(() => null)]);
    setStatus(configStatus);
    setStats(libraryStats);
    setAuthSession(session);
    if (session?.authenticated) {
      clearPendingPlexAuth(window.localStorage);
      setPendingPlexAuth(null);
    }
  }

  async function runAction<T>(name: string, action: () => Promise<T>, message: (result: T) => string) {
    setBusy(name);
    setNotice("");
    try {
      const result = await action();
      setNotice(message(result));
      await refreshStatus();
      return result;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      return undefined;
    } finally {
      setBusy("");
    }
  }

  async function startPlexSignIn() {
    const result = await runAction(
      "plex-sign-in",
      () => moodarrApi.startPlexAuth({ returnUrl: buildPlexAuthReturnUrl(window.location.href) }),
      () => "Plex authorization opened."
    );
    if (!result) return;
    const pendingAuth = { pinId: result.pinId, code: result.code, createdAt: Date.now() };
    savePendingPlexAuth(window.localStorage, pendingAuth);
    setPendingPlexAuth(pendingAuth);
    window.open(result.authUrl, "_blank", "noopener,noreferrer");
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
    const userMessage: ChatMessage = { id: createId(), role: "user", text: userText };
    setChatMessages((current) => [...current, userMessage]);
    setChatDraft("");
    setFilters(criteria.filters);
    setResultLimit(criteria.resultLimit);
    setWatchContext(criteria.watchContext);
    setSubmittedFeedbackByItem(feedbackByItem);
    setCriteriaDirty(false);
    setLastSearchQuery(criteria.query);
    setBusy("search");
    setNotice("");
    setPreview(null);
    try {
      const requestedLimit = Math.min(maxSearchResultLimit, criteria.resultLimit + hiddenFeedbackCount(feedbackByItem, showRatedItems));
      const response = await moodarrApi.search({
        query: criteria.query,
        watchContext: criteria.watchContext,
        resultLimit: requestedLimit,
        filters: criteria.filters,
        feedbackContext: buildFeedbackContext(feedbackByItem, showRatedItems)
      });
      baseScoreByItemIdRef.current = Object.fromEntries(response.results.map((item) => [item.id, item.score]));
      const retainedPotentials = retainedPotentialItems(response.results, resultPool, feedbackByItem);
      const ranked = applyFeedbackRanking(mergeUniqueItems(response.results, retainedPotentials), feedbackByItem, baseScoreByItemIdRef.current);
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
      setBusy("");
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
    const request = await runAction(
      "preview",
      () => moodarrApi.previewRequest({ itemId: item.id, seasons }),
      (result) => (result.canRequest ? "Request preview ready." : result.blockedReason ?? "Request blocked.")
    );
    if (request) setPreview(request);
  }

  async function createRequest() {
    if (!preview) return;
    await runAction(
      "create",
      () =>
        moodarrApi.createRequest({
          itemId: preview.item.id,
          seasons: preview.request.seasons,
          confirmed: true,
          confirmationPhrase: preview.confirmationPhrase
        }),
      () => "Request created."
    );
    setPreview(null);
  }

  function updateRecommendationFeedback(item: ItemSummary, feedback: RecommendationFeedback) {
    const nextFeedback = nextFeedbackState(feedbackByItem, item.id, feedback);
    const nextTitles = nextFeedbackTitleState(feedbackTitleByItem, item, nextFeedback);
    setFeedbackByItem(nextFeedback);
    setFeedbackTitleByItem(nextTitles);
    const pool = resultPool.length ? resultPool : results;
    setResults(visibleResultsFromPool(pool, nextFeedback, showRatedItems, resultLimit));
    if (nextFeedback[item.id] === "down") setPreview((current) => (current?.item.id === item.id ? null : current));
    const feedbackText = summarizeFeedbackSelection(nextFeedback, nextTitles, submittedFeedbackByItem);
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
    setShowRatedItems(true);
    setSubmittedFeedbackByItem({});
    setCriteriaDirty(false);
    setLastSearchQuery("");
    setLatestSuccessfulQuery("");
    setPreview(null);
    setSeasonSelections({});
    setNotice("");
    baseScoreByItemIdRef.current = {};
  }

  return (
    <main className="app-shell">
      <section className={activeView === "finder" ? "topbar finder-topbar" : "topbar admin-topbar"}>
        {activeView === "finder" ? (
          <CriteriaBar
            filters={filters}
            resultLimit={resultLimit}
            watchContext={watchContext}
            showRatedItems={showRatedItems}
            displayMode={displayMode}
            onCriteriaChange={updateManualCriteria}
            onDisplayModeChange={setDisplayMode}
          />
        ) : null}
        <div className="topbar-meta">
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
              <p>I feel like watching...</p>
            </div>
          </div>
          <div className="topbar-actions">
            <AccountControls
              status={status}
              authSession={authSession}
              pendingPlexAuth={pendingPlexAuth}
              busy={busy}
              onStartPlexSignIn={startPlexSignIn}
              onCompletePlexSignIn={completePlexSignIn}
            />
            {activeView !== "finder" ? (
              <button className="tab-button icon-only" onClick={() => setActiveView("finder")} aria-label="Open finder" title="Finder">
                <MagnifyingGlass size={18} />
              </button>
            ) : null}
            <button className={activeView === "review" ? "tab-button icon-only active" : "tab-button icon-only"} onClick={() => setActiveView("review")} aria-label="Open review queue" title="Review queue">
              <ListChecks size={18} />
            </button>
            <button
              className={activeView === "admin" ? "tab-button icon-only active" : "tab-button icon-only"}
              onClick={() => {
                setActiveView("admin");
                void runAction("admin-refresh", refreshAdmin, () => "Admin state refreshed.");
              }}
              aria-label="Open admin settings"
              title="Admin settings"
            >
              <GearSix size={18} />
            </button>
          </div>
        </div>
      </section>

      {notice && activeView !== "finder" ? (
        <div className="notice global-notice">
          <WarningCircle size={16} />
          {notice}
        </div>
      ) : null}

      {activeView === "finder" ? (
        <FinderView
          chatDraft={chatDraft}
          setChatDraft={setChatDraft}
          chatMessages={chatMessages}
          notice={notice}
          voiceState={voiceState}
          startVoiceTranscription={startVoiceTranscription}
          busy={busy}
          grouped={grouped}
          preview={preview}
          feedbackByItem={feedbackByItem}
          seasonSelections={seasonSelections}
          setSeasonSelections={setSeasonSelections}
          submitChat={submitChat}
          updateRecommendationFeedback={updateRecommendationFeedback}
          previewRequest={previewRequest}
          createRequest={createRequest}
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
        />
      ) : activeView === "review" ? (
        <ReviewQueueView
          queue={reviewQueue}
          status={reviewStatus}
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
          saveAdminSettings={saveAdminSettings}
          busy={busy}
          runAction={runAction}
          logout={logout}
          refreshAdmin={refreshAdmin}
        />
      )}
    </main>
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
    return (
      <div className="account-chip">
        <User size={16} />
        <span>{displayUserName(authSession.user)}</span>
      </div>
    );
  }
  if (pendingPlexAuth) {
    return (
      <button type="button" className="tab-button account-button" onClick={() => void onCompletePlexSignIn()} disabled={busy === "plex-sign-in-check"}>
        {busy === "plex-sign-in-check" ? <SpinnerGap size={16} className="spin" /> : <User size={16} />}
        Check sign-in
      </button>
    );
  }
  return (
    <button type="button" className="tab-button account-button" onClick={() => void onStartPlexSignIn()} disabled={Boolean(busy)}>
      {busy === "plex-sign-in" ? <SpinnerGap size={16} className="spin" /> : <User size={16} />}
      Sign in
    </button>
  );
}

function DisplayModeSelect({
  displayMode,
  onDisplayModeChange
}: {
  displayMode: DisplayMode;
  onDisplayModeChange: (mode: DisplayMode) => void;
}) {
  return (
    <label className="display-mode-field">
      <span className="sr-only">View mode</span>
      <select value={displayMode} onChange={(event) => onDisplayModeChange(event.target.value as DisplayMode)} aria-label="Result view mode" title="Result view mode">
        <option value="compact">Compact</option>
        <option value="comfortable">Comfort</option>
        <option value="list">List</option>
      </select>
    </label>
  );
}

function FinderView(props: {
  chatDraft: string;
  setChatDraft: (value: string) => void;
  chatMessages: ChatMessage[];
  notice: string;
  voiceState: VoiceState;
  startVoiceTranscription: () => void;
  busy: string;
  grouped: { group: AvailabilityGroup; items: ItemSummary[] }[];
  preview: RequestPreview | null;
  feedbackByItem: Record<string, RecommendationFeedback>;
  seasonSelections: Record<string, string>;
  setSeasonSelections: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  submitChat: (event?: React.FormEvent, promptOverride?: string) => Promise<void>;
  updateRecommendationFeedback: (item: ItemSummary, feedback: RecommendationFeedback) => void;
  previewRequest: (item: ItemSummary, selectedSeason?: number) => Promise<void>;
  createRequest: () => Promise<void>;
  displayMode: DisplayMode;
  hasSearchSession: boolean;
  criteriaDirty: boolean;
  latestSuccessfulQuery: string;
  savedQueries: SavedQuery[];
  copyLatestSuccessfulQuery: () => Promise<void>;
  saveLatestSuccessfulQuery: () => void;
  runSavedQuery: (query: string) => Promise<void>;
  deleteSavedQuery: (id: string) => void;
  resetSearchSession: () => void;
  rerunWithCurrentCriteria: () => Promise<void>;
}) {
  const {
    chatDraft,
    setChatDraft,
    chatMessages,
    notice,
    voiceState,
    startVoiceTranscription,
    busy,
    grouped,
    preview,
    feedbackByItem,
    seasonSelections,
    setSeasonSelections,
    displayMode,
    hasSearchSession,
    criteriaDirty,
    latestSuccessfulQuery,
    savedQueries
  } = props;
  const chatLogRef = useRef<HTMLDivElement | null>(null);
  const visibleGroups = grouped.filter(({ items }) => items.length > 0);
  const visibleItems = visibleGroups.flatMap(({ items }) => items);
  const visibleIndexByItemId = new Map(visibleItems.map((item, index) => [item.id, index]));
  const hasResults = visibleGroups.length > 0;
  const hasChatDraft = Boolean(chatDraft.trim());
  const composerRefreshMode = criteriaDirty && hasSearchSession && !hasChatDraft;

  useEffect(() => {
    const chatLog = chatLogRef.current;
    if (!chatLog) return;
    chatLog.scrollTo({ top: chatLog.scrollHeight, behavior: "smooth" });
  }, [chatMessages, busy]);

  return (
    <section className="workspace finder-workspace">
      <section className="finder-panel">
        <section className="results">
          {busy === "search" ? <ResultSkeletons /> : null}
          {!busy && !hasResults ? <SearchEmptyState /> : null}
          {!busy
            ? visibleGroups.map(({ group, items }) => (
                <section className="result-group" key={group}>
                  <div className={resultGridClassName(displayMode)}>
                    {items.map((item, index) => (
                      <ResultCard
                        key={item.id}
                        item={item}
                        index={index}
                        displayScore={displayMatchScore(item, visibleIndexByItemId.get(item.id) ?? index, visibleItems)}
                        preview={preview}
                        feedback={feedbackByItem[item.id]}
                        busy={busy}
                        seasonSelection={seasonSelections[item.id] ?? ""}
                        onSeasonSelection={(value) => setSeasonSelections((current) => ({ ...current, [item.id]: value }))}
                        onFeedback={props.updateRecommendationFeedback}
                        onPreviewRequest={props.previewRequest}
                        onCreateRequest={props.createRequest}
                      />
                    ))}
                  </div>
                </section>
              ))
            : null}
        </section>
      </section>

      <aside className="conversation-rail" aria-label="Finder chat and filters">
        <ResultsStatus
          grouped={grouped}
          busy={busy}
          hasSearchSession={hasSearchSession}
          criteriaDirty={criteriaDirty}
          onReset={props.resetSearchSession}
          onUpdate={props.rerunWithCurrentCriteria}
        />
        {notice ? (
          <div className="notice rail-notice">
            <WarningCircle size={16} />
            {notice}
          </div>
        ) : null}
        <SavedQueriesPanel
          latestSuccessfulQuery={latestSuccessfulQuery}
          savedQueries={savedQueries}
          busy={busy}
          onCopyLatest={props.copyLatestSuccessfulQuery}
          onSaveLatest={props.saveLatestSuccessfulQuery}
          onRunSaved={props.runSavedQuery}
          onDeleteSaved={props.deleteSavedQuery}
        />
        <form
          className="chat-panel"
          onSubmit={(event) => {
            event.preventDefault();
            if (composerRefreshMode) void props.rerunWithCurrentCriteria();
            else void props.submitChat();
          }}
        >
          <div className="chat-log" aria-live="polite" aria-label="Conversation history" ref={chatLogRef}>
            {chatMessages.map((message) => (
              <div className={`chat-message ${message.role}`} key={message.id}>
                <span>{message.text}</span>
                {message.refinementOptions?.length ? (
                  <div className="refinement-options" aria-label="Follow-up refinement options">
                    {message.refinementOptions.map((option) => (
                      <button key={`${message.id}-${option.label}`} type="button" onClick={() => void props.submitChat(undefined, option.prompt)} disabled={busy === "search"}>
                        {option.label}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
          <div className="chat-composer">
            <textarea
              value={chatDraft}
              rows={4}
              maxLength={maxSearchQueryLength}
              onChange={(event) => setChatDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  if (composerRefreshMode) void props.rerunWithCurrentCriteria();
                  else void props.submitChat();
                }
              }}
              aria-label="Finder chat prompt"
              placeholder="Ask for a mood, runtime, availability, count, or a follow-up refinement"
            />
            <div className="composer-actions">
              <button
                type="button"
                className={voiceState === "listening" ? "voice-button listening" : "voice-button"}
                onClick={startVoiceTranscription}
                disabled={voiceState === "unsupported"}
                aria-label={voiceState === "listening" ? "Stop voice transcription" : "Start voice transcription"}
              >
                <Microphone size={16} />
              </button>
              <button type="submit" disabled={busy === "search" || (!hasChatDraft && !composerRefreshMode)} aria-label={composerRefreshMode ? "Refresh recommendations" : "Send chat prompt"} title={composerRefreshMode ? "Refresh" : "Send"}>
                {busy === "search" ? <SpinnerGap size={16} className="spin" /> : composerRefreshMode ? <ArrowClockwise size={16} /> : <PaperPlaneTilt size={16} />}
              </button>
            </div>
          </div>
        </form>
      </aside>
    </section>
  );
}

function SavedQueriesPanel({
  latestSuccessfulQuery,
  savedQueries,
  busy,
  onCopyLatest,
  onSaveLatest,
  onRunSaved,
  onDeleteSaved
}: {
  latestSuccessfulQuery: string;
  savedQueries: SavedQuery[];
  busy: string;
  onCopyLatest: () => Promise<void>;
  onSaveLatest: () => void;
  onRunSaved: (query: string) => Promise<void>;
  onDeleteSaved: (id: string) => void;
}) {
  const hasLatest = Boolean(latestSuccessfulQuery.trim());
  if (!hasLatest && savedQueries.length === 0) return null;

  return (
    <section className="saved-queries" aria-label="Saved queries">
      <div className="saved-queries-header">
        <strong>Queries</strong>
        <div className="saved-query-actions">
          <button type="button" onClick={() => void onCopyLatest()} disabled={!hasLatest} aria-label="Copy latest successful query" title="Copy latest">
            <CopySimple size={15} />
          </button>
          <button type="button" onClick={onSaveLatest} disabled={!hasLatest} aria-label="Save latest successful query" title="Save latest">
            <BookmarkSimple size={15} />
          </button>
        </div>
      </div>
      {hasLatest ? <p className="latest-query">{latestSuccessfulQuery}</p> : null}
      {savedQueries.length ? (
        <div className="saved-query-list">
          {savedQueries.map((entry) => (
            <div className="saved-query-row" key={entry.id}>
              <button type="button" className="saved-query-run" onClick={() => void onRunSaved(entry.query)} disabled={busy === "search"} title={entry.query}>
                {entry.query}
              </button>
              <button type="button" className="saved-query-delete" onClick={() => onDeleteSaved(entry.id)} aria-label="Delete saved query" title="Delete">
                <Trash size={14} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function CriteriaBar({
  filters,
  resultLimit,
  watchContext,
  showRatedItems,
  displayMode,
  onCriteriaChange,
  onDisplayModeChange
}: {
  filters: SearchFilters;
  resultLimit: number;
  watchContext: WatchContext;
  showRatedItems: boolean;
  displayMode: DisplayMode;
  onCriteriaChange: (change: { filters?: SearchFilters; resultLimit?: number; watchContext?: WatchContext; showRatedItems?: boolean }) => void;
  onDisplayModeChange: (mode: DisplayMode) => void;
}) {
  return (
    <section className="criteria-strip" aria-label="Active criteria">
      <div className="criteria-strip-controls filter-stack">
        <button
          type="button"
          className={watchContext === "group" ? "context-toggle group" : "context-toggle"}
          onClick={() => onCriteriaChange({ watchContext: watchContext === "solo" ? "group" : "solo" })}
          aria-pressed={watchContext === "group"}
          aria-label={watchContext === "solo" ? "Recommendation context for me" : "Recommendation context together"}
        >
          {watchContext === "solo" ? <User size={14} /> : <Users size={14} />}
          {watchContext === "solo" ? "For Me" : "Together"}
        </button>
        <label className="result-limit-field">
          <span className="sr-only">Results</span>
          <input
            type="number"
            min="1"
            max={maxSearchResultLimit}
            value={resultLimit}
            onChange={(event) => onCriteriaChange({ resultLimit: Math.max(1, Math.min(maxSearchResultLimit, Number(event.target.value) || defaultSearchResultLimit)) })}
          />
        </label>
        <FilterSelect
          label="Type"
          value={mediaTypeFilterValue(filters.mediaTypes)}
          onChange={(value) => onCriteriaChange({ filters: { ...filters, mediaTypes: mediaTypesFromFilterValue(value) } })}
          options={[
            ["all", "Movies & TV"],
            ["movie", "Movies"],
            ["tv", "TV"]
          ]}
        />
        <FilterSelect
          label="Runtime"
          value={runtimeFilterValue(filters)}
          onChange={(value) => {
            if (value === "custom") return;
            onCriteriaChange({ filters: value ? applyRuntimeRange(filters, { maxRuntimeMinutes: Number(value) }) : clearRuntimeRange(filters) });
          }}
          options={runtimeFilterOptions(filters)}
        />
        <FilterSelect
          label="Genre"
          value={filters.genres?.[0] ?? ""}
          onChange={(value) => onCriteriaChange({ filters: { ...filters, genres: value ? [value] : [] } })}
          options={genreOptions}
        />
        <FilterSelect
          label="Availability"
          value={availabilityScopeFromFilters(filters)}
          onChange={(value) => onCriteriaChange({ filters: { ...filters, availability: availabilityFromScope(value as AvailabilityScope) } })}
          options={[
            ["plex", "Plex Only"],
            ["plex-seerr", "Plex + Seerr"]
          ]}
        />
        <button
          type="button"
          className={showRatedItems ? "rated-toggle active" : "rated-toggle"}
          onClick={() => onCriteriaChange({ showRatedItems: !showRatedItems })}
          aria-pressed={showRatedItems}
          aria-label={showRatedItems ? "Showing rated recommendations" : "Hiding rated recommendations"}
          title={showRatedItems ? "Rated items shown" : "Rated items hidden"}
        >
          <ThumbsUp size={16} />
        </button>
        <DisplayModeSelect displayMode={displayMode} onDisplayModeChange={onDisplayModeChange} />
      </div>
    </section>
  );
}

function resultGridClassName(displayMode: DisplayMode) {
  if (displayMode === "list") return "card-grid list-layout";
  if (displayMode === "compact") return "card-grid compact-layout";
  return "card-grid";
}

function ResultsStatus({
  grouped,
  busy,
  hasSearchSession,
  criteriaDirty,
  onReset,
  onUpdate
}: {
  grouped: { group: AvailabilityGroup; items: ItemSummary[] }[];
  busy: string;
  hasSearchSession: boolean;
  criteriaDirty: boolean;
  onReset: () => void;
  onUpdate: () => Promise<void>;
}) {
  const counts = grouped.map(({ group, items }) => ({ group, count: items.length })).filter(({ count }) => count > 0);
  if (busy === "search") {
    return (
      <div className="rail-status">
        <strong>Finding matches</strong>
        <RailStatusActions text="Ranking Plex and Seerr candidates" showReset={hasSearchSession} showUpdate={false} onReset={onReset} onUpdate={onUpdate} disabled />
      </div>
    );
  }
  if (counts.length === 0) {
    return (
      <div className="rail-status">
        <strong>Ready</strong>
        <RailStatusActions text="Ask for a mood to start" showReset={hasSearchSession} showUpdate={criteriaDirty} onReset={onReset} onUpdate={onUpdate} />
      </div>
    );
  }
  const primary = counts[0];
  const total = counts.reduce((sum, item) => sum + item.count, 0);
  return (
    <div className="rail-status">
      <strong>{criteriaDirty ? "Criteria changed" : groupLabels[primary.group]}</strong>
      <RailStatusActions text={`${total} shown`} showReset={hasSearchSession} showUpdate={criteriaDirty} onReset={onReset} onUpdate={onUpdate} />
    </div>
  );
}

function RailStatusActions({
  text,
  showReset,
  showUpdate,
  onReset,
  onUpdate,
  disabled = false
}: {
  text: string;
  showReset: boolean;
  showUpdate: boolean;
  onReset: () => void;
  onUpdate: () => Promise<void>;
  disabled?: boolean;
}) {
  return (
    <span className="rail-status-actions">
      <span>{text}</span>
      {showUpdate ? (
        <button type="button" className="primary-status-action" onClick={() => void onUpdate()} disabled={disabled}>
          Update
        </button>
      ) : null}
      {showReset ? (
        <button type="button" onClick={onReset} disabled={disabled}>
          Reset
        </button>
      ) : null}
    </span>
  );
}

function ReviewQueueView({
  queue,
  status,
  setStatus,
  drafts,
  ratings,
  busy,
  refreshReviewQueue,
  updateReviewDraft,
  updateReviewRating,
  submitReviewFeedback
}: {
  queue: QueryReviewQueueResponse | null;
  status: QueryReviewStatus;
  setStatus: (status: QueryReviewStatus) => void;
  drafts: Record<string, string>;
  ratings: Record<string, number>;
  busy: string;
  refreshReviewQueue: () => Promise<void>;
  updateReviewDraft: (id: string, value: string) => void;
  updateReviewRating: (id: string, value: number) => void;
  submitReviewFeedback: (item: QueryReviewQueueItem) => Promise<void>;
}) {
  const items = queue?.items ?? [];
  return (
    <section className="review-queue-layout">
      <section className="admin-panel review-header-panel">
        <PanelTitle icon={<ListChecks size={18} />} title="Review Queue" />
        <div className="review-toolbar">
          <div className="review-status-tabs" role="tablist" aria-label="Review queue status">
            {(["pending", "reviewed", "all"] as QueryReviewStatus[]).map((entry) => (
              <button key={entry} type="button" className={status === entry ? "tab-button active" : "tab-button"} onClick={() => setStatus(entry)}>
                {reviewStatusLabel(entry)}
              </button>
            ))}
          </div>
          <button type="button" className="tab-button" onClick={() => void refreshReviewQueue()} disabled={busy === "review-refresh"}>
            {busy === "review-refresh" ? <SpinnerGap size={16} className="spin" /> : <ArrowClockwise size={16} />}
            Refresh
          </button>
        </div>
        <div className="metric-grid review-metrics">
          <Metric label="Queue" value={queue?.count ?? 0} />
          <Metric label="Loaded" value={items.length} />
        </div>
      </section>

      <section className="review-list" aria-label="Query review queue">
        {busy === "review-refresh" && !queue ? <div className="empty-results">Loading queue</div> : null}
        {busy !== "review-refresh" && items.length === 0 ? <div className="empty-results">No queries in this view</div> : null}
        {items.map((item) => (
          <ReviewQueueCard
            key={item.id}
            item={item}
            draft={drafts[item.id] ?? ""}
            rating={ratings[item.id] ?? item.moodFitRating ?? 0}
            busy={busy}
            onDraftChange={updateReviewDraft}
            onRatingChange={updateReviewRating}
            onSubmit={submitReviewFeedback}
          />
        ))}
      </section>
    </section>
  );
}

function ReviewQueueCard({
  item,
  draft,
  rating,
  busy,
  onDraftChange,
  onRatingChange,
  onSubmit
}: {
  item: QueryReviewQueueItem;
  draft: string;
  rating: number;
  busy: string;
  onDraftChange: (id: string, value: string) => void;
  onRatingChange: (id: string, value: number) => void;
  onSubmit: (item: QueryReviewQueueItem) => Promise<void>;
}) {
  const isSaving = busy === `review-save:${item.id}`;
  return (
    <article className="review-item">
      <header className="review-item-header">
        <div>
          <span className="review-date">{formatDate(item.createdAt)}</span>
          <h2>{item.query}</h2>
          {item.optimizedQuery && item.optimizedQuery !== item.query ? <p>{item.optimizedQuery}</p> : null}
        </div>
        <div className="review-meta">
          <span>{item.watchContext === "group" ? "Together" : "For Me"}</span>
          <span>{item.resultCount} results</span>
          {item.reviewedAt ? <span>Reviewed {formatDate(item.reviewedAt)}</span> : null}
        </div>
      </header>

      <ol className="review-results">
        {item.results.slice(0, 6).map((result, index) => (
          <li key={result.id}>
            <span>{displayMatchScore(result, index, item.results)}%</span>
            <strong>
              {result.title}
              {result.year ? ` (${result.year})` : ""}
            </strong>
            <em>{result.genres.slice(0, 3).join(", ") || groupLabels[result.availabilityGroup]}</em>
          </li>
        ))}
      </ol>

      <div className="review-feedback-row">
        <div className="review-rating" role="group" aria-label={`Mood fit rating for ${item.query}`}>
          {[1, 2, 3, 4, 5].map((value) => (
            <button
              key={value}
              type="button"
              className={rating === value ? "active" : ""}
              onClick={() => onRatingChange(item.id, value)}
              aria-pressed={rating === value}
              title={reviewRatingLabel(value)}
            >
              <Star size={14} weight={rating >= value ? "fill" : "regular"} />
              {value}
            </button>
          ))}
        </div>
        <label className="review-note">
          <span>What missed the mood</span>
          <textarea rows={3} maxLength={1000} value={draft} onChange={(event) => onDraftChange(item.id, event.target.value)} />
        </label>
        <button type="button" className="review-save-button" onClick={() => void onSubmit(item)} disabled={isSaving || rating < 1}>
          {isSaving ? <SpinnerGap size={16} className="spin" /> : <CheckCircle size={16} />}
          Save review
        </button>
      </div>
    </article>
  );
}

function AdminView(props: {
  status: ConfigStatusResponse | null;
  stats: LibraryStats | null;
  settings: AdminSettings | null;
  syncStatus: SyncStatus | null;
  recommendationDiagnostics: RecommendationDiagnostics | null;
  authSession: AuthSessionResponse | null;
  adminUsers: AuthUser[];
  updateAdminUser: (user: AuthUser, enabled: boolean) => Promise<void>;
  adminDraft: AdminSettingsUpdate;
  setAdminDraft: React.Dispatch<React.SetStateAction<AdminSettingsUpdate>>;
  saveAdminSettings: (event: React.FormEvent) => Promise<void>;
  busy: string;
  runAction: <T>(name: string, action: () => Promise<T>, message: (result: T) => string) => Promise<T | undefined>;
  logout: () => Promise<void>;
  refreshAdmin: () => Promise<void>;
}) {
  const { status, stats, settings, syncStatus, recommendationDiagnostics, authSession, adminUsers, adminDraft, setAdminDraft, busy } = props;
  const authReady = browserAdminReady(status);
  const fixtureMode = Boolean(adminDraft.fixtureMode ?? status?.fixtureMode);
  return (
    <section className="admin-grid admin-redesign-grid">
      <aside className="admin-side">
        <section className="admin-panel">
	          <input type="text" name="admin-username" autoComplete="username" value="moodarr-admin" readOnly hidden />
	          <div className="panel-heading-row">
	            <PanelTitle icon={<ShieldCheck size={18} />} title="Access" />
            <span className={authReady ? "admin-tag live" : "admin-tag warn"}>
              <span className="tag-dot" />
              {authReady ? "Protected" : "Needs session"}
            </span>
          </div>
          <p className="panel-copy">Admin auth is configured in the container. The bundled UI uses an HTTP-only same-origin session; API clients can still send the admin token as a header.</p>
          <div className="status-list">
            <StatusRow label="Auth required" ready={authReady} detail={status?.admin.authRequired ? "Yes" : "No"} />
            <StatusRow label="Container session" ready={Boolean(status?.admin.autoSession)} detail={status?.admin.autoSession ? "Enabled" : "Disabled"} />
            <StatusRow label="Plex sign-in" ready={Boolean(status?.auth.plexAuthEnabled)} detail={status?.auth.plexAuthEnabled ? "Enabled" : "Disabled"} />
            <StatusRow label="New Plex sign-ins" ready={status ? Boolean(!status.auth.plexAuthEnabled || status.auth.allowNewPlexUsers) : false} detail={status ? (status.auth.allowNewPlexUsers ? "Allowed" : "Closed") : "Unknown"} />
            <StatusRow label="Client served" ready={Boolean(status?.runtime.serveClient)} detail={status?.runtime.serveClient ? "Single container" : "Dev split"} />
            <StatusRow label="Fixture mode" ready={!fixtureMode} detail={fixtureMode ? "On" : "Off"} />
          </div>
          {authSession?.authenticated ? (
            <div className="button-stack access-actions">
              <button type="button" onClick={() => void props.logout()} disabled={busy === "logout"}>
                {busy === "logout" ? <SpinnerGap size={16} className="spin" /> : <SignOut size={16} />}
                Sign out
              </button>
            </div>
          ) : null}
          <PlexUsersPanel users={adminUsers} busy={busy} onUpdateUser={props.updateAdminUser} />
        </section>

        <HealthPanel status={status} stats={stats} busy={busy} runAction={props.runAction} />

        <section className="admin-panel">
          <PanelTitle icon={<Database size={18} />} title="Runtime" />
          <div className="runtime-list">
            <RuntimeFact label="Storage" value="Server-side" />
            <RuntimeFact label="Database" value="SQLite" />
            <RuntimeFact label="Config" value="Server JSON" />
            <RuntimeFact label="Next sync" value={formatDate(syncStatus?.nextRunAt)} />
            <RuntimeFact label="Items" value={String(stats?.totalItems ?? 0)} />
          </div>
          <div className="button-stack">
            <button onClick={() => void props.runAction("admin-refresh", props.refreshAdmin, () => "Admin state refreshed.")} disabled={Boolean(busy)}>
              <HardDrives size={16} />
              Refresh state
            </button>
            <button onClick={() => void props.runAction("admin-sync", moodarrApi.runSync, syncResultMessage)} disabled={Boolean(busy)}>
              {busy === "admin-sync" ? <SpinnerGap size={16} className="spin" /> : <Stack size={16} />}
              Run sync now
            </button>
            <button onClick={() => void props.runAction("support", moodarrApi.supportBundle, () => "Support bundle generated without secrets.")} disabled={Boolean(busy)}>
              <DownloadSimple size={16} />
              Support bundle
            </button>
          </div>
          <p className="runtime-note">Support bundles redact tokens and keys before export.</p>
        </section>
      </aside>

	      <div className="admin-main">
	        <form className="admin-panel wide admin-settings-panel" onSubmit={(event) => void props.saveAdminSettings(event)}>
	          <input type="text" name="settings-username" autoComplete="username" value="moodarr-admin" readOnly hidden />
	          <div className="panel-heading-row">
            <PanelTitle icon={<GearSix size={18} />} title="Integrations" />
            <span className="admin-tag">Endpoints & credentials</span>
          </div>
          <p className="panel-copy">Credentials stay server-side. Leaving a secret field blank keeps the stored value; entering one rotates it.</p>

          <div className="admin-columns">
            <fieldset>
              <legend>
                Plex <span className="legend-badge plex">Source</span>
              </legend>
	              <label>
	                Base URL
	                <input name="plex-base-url" autoComplete="off" value={adminDraft.plex?.baseUrl ?? ""} onChange={(event) => setAdminDraft((current) => ({ ...current, plex: { ...current.plex, baseUrl: event.target.value } }))} placeholder="http://plex:32400" />
	                <small>Server-side sync and poster fetch origin.</small>
	              </label>
	              <label>
	                Plex Web URL
	                <input name="plex-web-base-url" autoComplete="off" value={adminDraft.plex?.webBaseUrl ?? ""} onChange={(event) => setAdminDraft((current) => ({ ...current, plex: { ...current.plex, webBaseUrl: event.target.value } }))} placeholder="https://app.plex.tv/desktop" />
	                <small>Destination for open-in-Plex actions.</small>
	              </label>
              <label className="field-with-state">
                Plex token
                <span className="field-wrap">
	                  <input
	                    name="plex-token"
	                    type="password"
	                    autoComplete="off"
	                    required={!fixtureMode && !settings?.plex.tokenConfigured}
	                    onChange={(event) => setAdminDraft((current) => ({ ...current, plex: { ...current.plex, token: event.target.value } }))}
                    placeholder={settings?.plex.tokenConfigured ? "Configured" : "Required"}
                  />
                  <ConfigState configured={Boolean(settings?.plex.tokenConfigured)} />
                </span>
              </label>
              <div className="test-line">
                <CheckCircle size={15} />
                {status?.plex.configured || status?.fixtureMode ? "Ready for library sync" : "Base URL and token required"}
              </div>
            </fieldset>

            <fieldset>
              <legend>
                Seerr <span className="legend-badge seerr">Requests</span>
              </legend>
	              <label>
	                Base URL
	                <input name="seerr-base-url" autoComplete="off" value={adminDraft.seerr?.baseUrl ?? ""} onChange={(event) => setAdminDraft((current) => ({ ...current, seerr: { ...current.seerr, baseUrl: event.target.value } }))} placeholder="http://seerr:5055" />
	                <small>Requestable catalog and request creation endpoint.</small>
	              </label>
              <label className="field-with-state">
                API key
                <span className="field-wrap">
	                  <input
	                    name="seerr-api-key"
	                    type="password"
	                    autoComplete="off"
	                    onChange={(event) => setAdminDraft((current) => ({ ...current, seerr: { ...current.seerr, apiKey: event.target.value } }))}
                    placeholder={settings?.seerr.apiKeyConfigured ? "Configured" : "Paste API key"}
                  />
                  <ConfigState configured={Boolean(settings?.seerr.apiKeyConfigured)} />
                </span>
              </label>
              <div className="test-line">
                <CheckCircle size={15} />
                {status?.seerr.configured || status?.fixtureMode ? "Request API ready" : "Base URL and API key required"}
              </div>
            </fieldset>

            <fieldset>
              <legend>
                Recommendations <span className="legend-badge ai">{adminDraft.ai?.provider === "openai" ? "OpenAI" : "Local"}</span>
              </legend>
	              <label>
	                Provider
	                <select name="ai-provider" value={adminDraft.ai?.provider ?? "none"} onChange={(event) => setAdminDraft((current) => ({ ...current, ai: { ...current.ai, provider: event.target.value as "none" | "openai" } }))}>
	                  <option value="none">None</option>
	                  <option value="openai">OpenAI provider</option>
	                </select>
	              </label>
		              <label>
		                Model
		                <input name="openai-model" autoComplete="off" value={adminDraft.ai?.openaiModel ?? ""} onChange={(event) => setAdminDraft((current) => ({ ...current, ai: { ...current.ai, openaiModel: event.target.value } }))} placeholder="gpt-5.5" />
		              </label>
                  <label>
                    Effort
                    <select
                      name="openai-reasoning-effort"
                      value={adminDraft.ai?.openaiReasoningEffort ?? "low"}
                      onChange={(event) =>
                        setAdminDraft((current) => ({
                          ...current,
                          ai: { ...current.ai, openaiReasoningEffort: event.target.value as OpenAiReasoningEffort }
                        }))
                      }
                    >
                      {openAiReasoningEfforts.map((effort) => (
                        <option key={effort} value={effort}>
                          {formatReasoningEffort(effort)}
                        </option>
                      ))}
                    </select>
                  </label>
		              <label>
		                Embeddings
	                <input
	                  name="openai-embedding-model"
	                  autoComplete="off"
	                  value={adminDraft.ai?.openaiEmbeddingModel ?? ""}
	                  onChange={(event) => setAdminDraft((current) => ({ ...current, ai: { ...current.ai, openaiEmbeddingModel: event.target.value } }))}
                  placeholder="text-embedding-3-large"
                />
              </label>
              <label className="field-with-state">
                API key
                <span className="field-wrap">
	                  <input
	                    name="openai-api-key"
	                    type="password"
	                    autoComplete="off"
	                    onChange={(event) => setAdminDraft((current) => ({ ...current, ai: { ...current.ai, openaiApiKey: event.target.value } }))}
                    placeholder={settings?.ai.openaiApiKeyConfigured ? "Configured" : "Optional"}
                  />
                  <ConfigState configured={Boolean(settings?.ai.openaiApiKeyConfigured)} unsetLabel="Optional" />
                </span>
              </label>
            </fieldset>
          </div>

          <div className="admin-subsection">
            <span className="admin-subsection-title">Sync and review retention</span>
	            <div className="admin-actions enhanced">
	              <label className="toggle-row">
	                <input name="fixture-mode" type="checkbox" checked={Boolean(adminDraft.fixtureMode)} onChange={(event) => setAdminDraft((current) => ({ ...current, fixtureMode: event.target.checked }))} />
	                <span>
	                  <strong>Fixture mode</strong>
	                  <small>Use bundled sample data instead of live services.</small>
                </span>
              </label>
	              <label>
	                Sync interval
	                <input name="sync-interval-minutes" type="number" min="0" max="10080" value={adminDraft.sync?.intervalMinutes ?? 0} onChange={(event) => setAdminDraft((current) => ({ ...current, sync: { ...current.sync, intervalMinutes: Number(event.target.value) } }))} />
	                <small>0 disables scheduled sync.</small>
	              </label>
              <label>
                Default results
                <input
                  name="search-default-result-limit"
                  type="number"
                  min="1"
                  max={maxSearchResultLimit}
                  value={adminDraft.search?.defaultResultLimit ?? settings?.search.defaultResultLimit ?? defaultSearchResultLimit}
                  onChange={(event) => setAdminDraft((current) => ({ ...current, search: { ...current.search, defaultResultLimit: Number(event.target.value) } }))}
                />
                <small>Initial content count shown in Finder.</small>
              </label>
              <label className="toggle-row">
                <input name="sync-seerr" type="checkbox" checked={adminDraft.sync?.syncSeerr ?? true} onChange={(event) => setAdminDraft((current) => ({ ...current, sync: { ...current.sync, syncSeerr: event.target.checked } }))} />
                <span>
                  <strong>Sync Seerr</strong>
                  <small>Include requestable catalog updates.</small>
                </span>
              </label>
              <label className="toggle-row">
                <input name="plex-auth-enabled" type="checkbox" checked={adminDraft.plexAuth?.enabled ?? false} onChange={(event) => setAdminDraft((current) => ({ ...current, plexAuth: { ...current.plexAuth, enabled: event.target.checked } }))} />
                <span>
                  <strong>Plex sign-in</strong>
                  <small>Let Plex users open Finder without the admin token.</small>
                </span>
              </label>
              <label className="toggle-row">
                <input
                  name="plex-auth-new-users"
                  type="checkbox"
                  checked={adminDraft.plexAuth?.allowNewUsers ?? true}
                  onChange={(event) => setAdminDraft((current) => ({ ...current, plexAuth: { ...current.plexAuth, allowNewUsers: event.target.checked } }))}
                  disabled={!adminDraft.plexAuth?.enabled}
                />
                <span>
                  <strong>New Plex users</strong>
                  <small>Allow first sign-in for accounts with server access.</small>
                </span>
              </label>
              <label>
                Review retention
	                <input
	                  name="review-retention-days"
	                  type="number"
                  min="1"
                  max="3650"
                  value={adminDraft.reviewQueue?.retentionDays ?? settings?.reviewQueue.retentionDays ?? 90}
                  onChange={(event) => setAdminDraft((current) => ({ ...current, reviewQueue: { ...current.reviewQueue, retentionDays: Number(event.target.value) } }))}
                />
              </label>
              <label>
                Max review queries
	                <input
	                  name="review-max-queries"
	                  type="number"
                  min="1"
                  max="10000"
                  value={adminDraft.reviewQueue?.maxQueries ?? settings?.reviewQueue.maxQueries ?? 500}
                  onChange={(event) => setAdminDraft((current) => ({ ...current, reviewQueue: { ...current.reviewQueue, maxQueries: Number(event.target.value) } }))}
                />
              </label>
            </div>
          </div>

          <div className="admin-save-bar">
            <span>Changes apply on save. Secret fields left blank keep their stored value.</span>
            <div>
              <button type="button" className="secondary-admin-button" onClick={() => void props.runAction("admin-refresh", props.refreshAdmin, () => "Admin state refreshed.")} disabled={Boolean(busy)}>
                Discard
              </button>
              <button type="submit" disabled={busy === "admin-save"}>
                {busy === "admin-save" ? <SpinnerGap size={16} className="spin" /> : <FloppyDisk size={16} />}
                Save settings
              </button>
            </div>
          </div>
        </form>

        <SyncPanel syncStatus={syncStatus} busy={busy} runAction={props.runAction} />

        <RecommendationDiagnosticsPanel diagnostics={recommendationDiagnostics} busy={busy} runAction={props.runAction} refreshAdmin={props.refreshAdmin} />
      </div>
    </section>
  );
}

function HealthPanel({
  status,
  stats,
  busy,
  runAction
}: {
  status: ConfigStatusResponse | null;
  stats: LibraryStats | null;
  busy: string;
  runAction: <T>(name: string, action: () => Promise<T>, message: (result: T) => string) => Promise<T | undefined>;
}) {
  return (
    <section className="admin-panel">
      <PanelTitle icon={<Database size={18} />} title="Health" />
      <StatusRow label="Plex" ready={Boolean(status?.plex.configured || status?.fixtureMode)} detail={status?.fixtureMode ? "Fixture" : status?.plex.configured ? "Configured" : "Missing"} />
      <StatusRow label="Seerr" ready={Boolean(status?.seerr.configured || status?.fixtureMode)} detail={status?.fixtureMode ? "Fixture" : status?.seerr.configured ? "Configured" : "Missing"} />
      <StatusRow label="Recommendations" ready={Boolean(status?.ai.configured)} detail={status?.ai.configured ? "Provider configured" : "Local ranking"} />
      <StatusRow label="Admin" ready={browserAdminReady(status)} detail={adminStatusDetail(status)} />
      <div className="metric-grid">
        <Metric label="Items" value={stats?.totalItems ?? 0} />
        <Metric label="Plex" value={stats?.availableInPlex ?? 0} />
        <Metric label="Requestable" value={stats?.requestable ?? 0} />
        <Metric label="Partial" value={stats?.partiallyAvailable ?? 0} />
      </div>
      <div className="button-stack">
        <button onClick={() => void runAction("plex-test", moodarrApi.testPlex, (result) => result.message)} disabled={Boolean(busy)}>
          {busy === "plex-test" ? <SpinnerGap size={16} className="spin" /> : <CheckCircle size={16} />}
          Test Plex
        </button>
        <button onClick={() => void runAction("seerr-test", moodarrApi.testSeerr, (result) => result.message)} disabled={Boolean(busy)}>
          {busy === "seerr-test" ? <SpinnerGap size={16} className="spin" /> : <CheckCircle size={16} />}
          Test Seerr
        </button>
        <button
          onClick={() => void runAction("admin-sync", moodarrApi.runSync, syncResultMessage)}
          disabled={Boolean(busy)}
        >
          {busy === "admin-sync" ? <SpinnerGap size={16} className="spin" /> : <Stack size={16} />}
          Run Sync
        </button>
      </div>
      <div className="sync-times">
        <span>Library {formatDate(stats?.lastLibrarySync)}</span>
        <span>Seerr {formatDate(stats?.lastSeerrSync)}</span>
      </div>
    </section>
  );
}

function PlexUsersPanel({
  users,
  busy,
  onUpdateUser
}: {
  users: AuthUser[];
  busy: string;
  onUpdateUser: (user: AuthUser, enabled: boolean) => Promise<void>;
}) {
  const enabledUsers = users.filter((user) => user.enabled).length;
  return (
    <div className="user-management">
      <div className="mini-heading">
        <Users size={15} />
        <span>Plex users</span>
        <strong>{enabledUsers}/{users.length}</strong>
      </div>
      {users.length === 0 ? (
        <p className="mini-empty">No Plex users have signed in yet.</p>
      ) : (
        <div className="user-list">
          {users.slice(0, 8).map((user) => {
            const actionBusy = busy === `admin-user-${user.id}`;
            return (
              <div className="user-row" key={user.id}>
                <span className={user.enabled ? "dot ready" : "dot"} />
                <div>
                  <strong>{displayUserName(user)}</strong>
                  <small>{user.lastLoginAt ? `Last ${formatDate(user.lastLoginAt)}` : "Never signed in"} · {requestCountLabel(user.requestCount)}</small>
                </div>
                <button type="button" onClick={() => void onUpdateUser(user, !user.enabled)} disabled={actionBusy}>
                  {actionBusy ? <SpinnerGap size={13} className="spin" /> : user.enabled ? "Disable" : "Enable"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SyncPanel({
  syncStatus,
  busy,
  runAction
}: {
  syncStatus: SyncStatus | null;
  busy: string;
  runAction: <T>(name: string, action: () => Promise<T>, message: (result: T) => string) => Promise<T | undefined>;
}) {
  return (
    <section className="admin-panel wide">
      <div className="panel-heading-row">
        <PanelTitle icon={<Stack size={18} />} title="Sync" />
        <span className={syncStatus?.enabled ? "admin-tag live" : "admin-tag warn"}>
          <span className="tag-dot" />
          {syncStatus?.enabled ? `Every ${syncStatus.intervalMinutes}m` : "Disabled"}
        </span>
      </div>
      <div className="metric-grid sync-metrics">
        <Metric label="Next sync" value={syncStatus?.nextRunAt ? formatShortTime(syncStatus.nextRunAt) : "Off"} />
        <Metric label="Interval" value={syncStatus?.intervalMinutes ?? 0} />
        <Metric label="Seerr sync" value={syncStatus?.syncSeerr ? "On" : "Off"} />
        <Metric label="State" value={syncStatus?.running ? "Running" : "Idle"} />
      </div>
	      <div className="admin-sync-summary">
	        <RuntimeFact label="Last scheduler read" value={syncStatus ? "Available" : "Not loaded"} />
	        <button className="secondary-admin-button" onClick={() => void runAction("embedding-warmup", () => moodarrApi.warmEmbeddings(), embeddingWarmupMessage)} disabled={Boolean(busy)}>
	          {busy === "embedding-warmup" ? <SpinnerGap size={16} className="spin" /> : <Sparkle size={16} />}
	          Warm embeddings
	        </button>
	        <button onClick={() => void runAction("admin-sync", moodarrApi.runSync, syncResultMessage)} disabled={Boolean(busy)}>
	          {busy === "admin-sync" ? <SpinnerGap size={16} className="spin" /> : <Stack size={16} />}
	          Sync now
	        </button>
	      </div>
      <SyncHistory history={syncStatus?.history} />
    </section>
  );
}

function RecommendationDiagnosticsPanel({
  diagnostics,
  busy,
  runAction,
  refreshAdmin
}: {
  diagnostics: RecommendationDiagnostics | null;
  busy: string;
  runAction: <T>(name: string, action: () => Promise<T>, message: (result: T) => string) => Promise<T | undefined>;
  refreshAdmin: () => Promise<void>;
}) {
  const embeddingModel = diagnostics?.features.embeddingModels[0];
  const replayStorage = diagnostics?.replayStorage;
  const driftAlerts = diagnostics?.feelProfileDrift?.alerts ?? [];
  const timeline = diagnostics?.feelProfileTimeline?.recent ?? [];
  const readiness = diagnostics?.usageReadiness;
  async function exportFeelProfiles() {
    const data = await moodarrApi.exportFeelProfiles();
    downloadJson(`moodarr-feel-profiles-${new Date().toISOString().slice(0, 10)}.json`, data);
    return data;
  }
  async function resetFeelProfileContext(watchContext: WatchContext) {
    const result = await moodarrApi.resetFeelProfile({ watchContext });
    await refreshAdmin();
    return result;
  }
  async function rollbackFeelProfile(alert: FeelProfileDriftAlert) {
    const result = await moodarrApi.rollbackFeelProfile({
      watchContext: alert.watchContext,
      term: alert.term,
      version: Math.max(1, alert.version - 1)
    });
    await refreshAdmin();
    return result;
  }
  return (
    <section className="admin-panel wide">
      <div className="panel-heading-row">
        <PanelTitle icon={<Sparkle size={18} />} title="Recommendation engine" />
        <span className="admin-tag live">
          <span className="tag-dot" />
          {diagnostics?.engineVersion ?? "moodrank-v0.4"}
        </span>
      </div>
      <p className="panel-copy">Coverage, recent runs, and preference signals without exposing tokens or raw prompts.</p>
      <UsageReadinessPanel readiness={readiness} />
      <div className="metric-grid">
        <Metric label="Runs" value={diagnostics?.sessions.total ?? 0} />
        <Metric label="AI runs" value={diagnostics?.sessions.withAi ?? 0} />
        <Metric label="Embeddings" value={diagnostics?.features.providerEmbeddingCount ?? 0} />
        <Metric label="Avg ms" value={diagnostics?.sessions.averageLatencyMs ?? 0} />
      </div>
      <div className="metric-grid replay-metrics">
        <Metric label="Replay sessions" value={replayStorage?.sessions ?? 0} />
        <Metric label="Holdouts" value={replayStorage?.holdoutEvents ?? 0} />
        <Metric label="Checkpoints" value={replayStorage?.checkpoints ?? 0} />
        <Metric label="Drift alerts" value={diagnostics?.feelProfileDrift?.totalAlerts ?? 0} />
      </div>
      <div className="runtime-list diagnostic-facts">
        <RuntimeFact label="Feature rows" value={String(diagnostics?.features.mediaFeatureCount ?? 0)} />
        <RuntimeFact label="Mood scores" value={String(diagnostics?.features.moodFeatureScoreCount ?? 0)} />
        <RuntimeFact label="Embedding model" value={embeddingModel ? `${embeddingModel.model} (${embeddingModel.count})` : "Local fallback"} />
        <RuntimeFact label="Replay retention" value={replayStorage ? `${replayStorage.retentionPolicy.retentionDays}d / ${replayStorage.retentionPolicy.maxCheckpointsPerTerm} checkpoints` : "Not loaded"} />
      </div>
      <div className="admin-action-row">
        <button
          type="button"
          className="secondary-admin-button"
          onClick={() => void runAction("feel-profile-export", exportFeelProfiles, (result) => `Exported ${result.feedbackSummary.total} feel signals.`)}
          disabled={Boolean(busy)}
        >
          {busy === "feel-profile-export" ? <SpinnerGap size={16} className="spin" /> : <DownloadSimple size={16} />}
          Export profiles
        </button>
        <button
          type="button"
          className="secondary-admin-button"
          onClick={() => void runAction("feel-profile-reset-solo", () => resetFeelProfileContext("solo"), (result) => `Reset ${result.deletedTerms} solo terms.`)}
          disabled={Boolean(busy)}
        >
          <Trash size={16} />
          Reset solo
        </button>
        <button
          type="button"
          className="secondary-admin-button"
          onClick={() => void runAction("feel-profile-reset-group", () => resetFeelProfileContext("group"), (result) => `Reset ${result.deletedTerms} together terms.`)}
          disabled={Boolean(busy)}
        >
          <Trash size={16} />
          Reset together
        </button>
      </div>
      <div className="signal-section">
        <span>Solo preference signals</span>
        <PreferenceSignals signals={diagnostics?.preferences.solo.positive} />
      </div>
      <div className="signal-section">
        <span>Together preference signals</span>
        <PreferenceSignals signals={diagnostics?.preferences.group.positive} />
      </div>
      <div className="signal-section">
        <span>Solo feel profile</span>
        <FeelProfileTerms profile={diagnostics?.feelProfiles?.solo} />
      </div>
      <div className="signal-section">
        <span>Together feel profile</span>
        <FeelProfileTerms profile={diagnostics?.feelProfiles?.group} />
      </div>
      <div className="signal-section">
        <span>Drift review</span>
        <ProfileDriftAlerts alerts={driftAlerts} busy={busy} onRollback={(alert) => runAction(`rollback-${alert.watchContext}-${alert.term}`, () => rollbackFeelProfile(alert), (result) => `Rolled ${result.term} back to v${result.restoredVersion}.`)} />
      </div>
      <div className="signal-section">
        <span>Checkpoint timeline</span>
        <ProfileTimeline checkpoints={timeline} />
      </div>
      <RecentRecommendationRuns runs={diagnostics?.recentRuns} />
    </section>
  );
}

function UsageReadinessPanel({ readiness }: { readiness: RecommendationDiagnostics["usageReadiness"] | undefined }) {
  if (!readiness) {
    return (
      <div className="usage-readiness collecting">
        <div className="usage-readiness-status">
          <WarningCircle size={18} />
          <div>
            <span>Usage readiness</span>
            <strong>Not loaded</strong>
          </div>
        </div>
        <p>Refresh diagnostics to inspect real feel-signal readiness.</p>
      </div>
    );
  }

  return (
    <div className={`usage-readiness ${readiness.status}`}>
      <div className="usage-readiness-status">
        {readiness.ready ? <CheckCircle size={18} /> : <WarningCircle size={18} />}
        <div>
          <span>Usage readiness</span>
          <strong>{readiness.label}</strong>
        </div>
      </div>
      <div className="usage-readiness-facts">
        <RuntimeFact label="Profile updates" value={`${readiness.signalProgress.appliedProfileUpdates}/${readiness.signalProgress.targetAppliedProfileUpdates}`} />
        <RuntimeFact label="Holdouts" value={`${readiness.signalProgress.holdouts}/${readiness.signalProgress.targetHoldouts}`} />
        <RuntimeFact label="Replay checks" value={`${readiness.signalProgress.replayComparisons}/${readiness.signalProgress.targetReplayComparisons}`} />
        <RuntimeFact label="Profiles" value={`${readiness.profileVersions.learnedTerms} terms / v${readiness.profileVersions.max}`} />
      </div>
      <div className="usage-readiness-review">
        <RuntimeFact label="Review" value={readiness.review.driftAlerts > 0 ? `${readiness.review.driftAlerts} drift alert${readiness.review.driftAlerts === 1 ? "" : "s"}` : "No drift alerts"} />
        <RuntimeFact label="Last signal" value={readiness.recentActivity.lastSignalAt ? formatShortTime(readiness.recentActivity.lastSignalAt) : "None"} />
      </div>
      <p>{readiness.nextAction}</p>
    </div>
  );
}

function PanelTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="panel-title">
      {icon}
      <h2>{title}</h2>
    </div>
  );
}

function StatusRow({ label, ready, detail }: { label: string; ready: boolean; detail: string }) {
  return (
    <div className="status-row">
      <span className={ready ? "dot ready" : "dot"} />
      <span>{label}</span>
      <strong>{detail}</strong>
    </div>
  );
}

function ConfigState({ configured, label = "Configured", unsetLabel = "Missing" }: { configured: boolean; label?: string; unsetLabel?: string }) {
  return (
    <span className={configured ? "field-state set" : "field-state unset"}>
      {configured ? <CheckCircle size={13} /> : <WarningCircle size={13} />}
      {configured ? label : unsetLabel}
    </span>
  );
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: [string, string][] }) {
  return (
    <label>
      <span className="sr-only">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
    </label>
  );
}

const runtimePresetOptions: [string, string][] = [
  ["", "Any length"],
  ["90", "90 min"],
  ["120", "2 hours"],
  ["600", "Short series"]
];

function runtimeFilterValue(filters: SearchFilters) {
  if (filters.minRuntimeMinutes) return "custom";
  const maxRuntime = String(filters.maxRuntimeMinutes ?? "");
  if (runtimePresetOptions.some(([value]) => value === maxRuntime)) return maxRuntime;
  return filters.maxRuntimeMinutes ? "custom" : "";
}

function runtimeFilterOptions(filters: SearchFilters): [string, string][] {
  return runtimeFilterValue(filters) === "custom" ? [["custom", describeRuntimeRange(filters)], ...runtimePresetOptions] : runtimePresetOptions;
}

function mediaTypeFilterValue(value: MediaType[] | undefined) {
  return value?.length === 1 ? value[0] : "all";
}

function mediaTypesFromFilterValue(value: string): MediaType[] | undefined {
  if (value === "movie" || value === "tv") return [value];
  return undefined;
}

function describeChangedCriteria(
  change: {
    filters?: SearchFilters;
    resultLimit?: number;
    watchContext?: WatchContext;
    showRatedItems?: boolean;
  },
  watchContext: WatchContext
) {
  const parts: string[] = [];
  if (change.watchContext) parts.push(watchContext === "group" ? "a better together mode" : "a more personal mode");
  if (change.resultLimit !== undefined) parts.push("the new result count");
  if (change.filters) {
    parts.push("the updated filters");
  }
  return parts;
}

function SearchEmptyState() {
  return (
    <section className="empty-results">
      <Sparkle size={26} />
      <h2>Describe what you're in the mood for watching</h2>
      <p>Keep chatting with Moodarr to find better options closer to your mood, style, or feel.</p>
    </section>
  );
}

function ResultSkeletons() {
  return (
    <section className="result-group" aria-label="Loading results">
      <div className="card-grid">
        {[0, 1, 2, 3].map((index) => (
          <div className="result-card skeleton-card" key={index} style={{ "--index": index } as CSSProperties}>
            <div className="skeleton-poster" />
            <div>
              <div className="skeleton-line wide" />
              <div className="skeleton-line" />
              <div className="skeleton-line short" />
              <div className="mini-meta">
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function ResultCard({
  item,
  index,
  displayScore,
  preview,
  feedback,
  busy,
  seasonSelection,
  onSeasonSelection,
  onFeedback,
  onPreviewRequest,
  onCreateRequest
}: {
  item: ItemSummary;
  index: number;
  displayScore: number;
  preview: RequestPreview | null;
  feedback?: RecommendationFeedback;
  busy: string;
  seasonSelection: string;
  onSeasonSelection: (value: string) => void;
  onFeedback: (item: ItemSummary, feedback: RecommendationFeedback) => void;
  onPreviewRequest: (item: ItemSummary, selectedSeason?: number) => Promise<void>;
  onCreateRequest: () => Promise<void>;
}) {
  const [showDescription, setShowDescription] = useState(false);
  const isPreviewForItem = preview?.item.id === item.id;
  const needsSeason = !item.plex?.available && Boolean(item.seerr?.requestable) && item.mediaType === "tv";
  const selectedSeason = Number(seasonSelection);
  const canPreviewRequest = !needsSeason || (Number.isInteger(selectedSeason) && selectedSeason > 0);
  const genres = item.genres.slice(0, 4);
  const plexHref = item.plex?.appUrl ?? item.plex?.url;
  const hasPlexAction = Boolean(item.plex?.available && plexHref);
  const hasRequestAction = !item.plex?.available && Boolean(item.seerr?.requestable);
  const hasTabAction = hasPlexAction || hasRequestAction;
  const [posterSrc, setPosterSrc] = useState<string | null>(null);
  const [posterFailed, setPosterFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let objectUrl: string | undefined;
    setPosterSrc(null);
    setPosterFailed(false);
    moodarrApi
      .posterObjectUrl(item.posterUrl)
      .then((url) => {
        objectUrl = url;
        if (active) setPosterSrc(url);
        else URL.revokeObjectURL(url);
      })
      .catch(() => {
        if (active) setPosterFailed(true);
      });
    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [item.posterUrl]);

  return (
    <article className={`result-card ${item.availabilityGroup}${hasTabAction ? " has-tab-action" : ""}`} style={{ "--index": index } as CSSProperties}>
      <div className="feedback-actions floating-feedback" aria-label={`Feedback for ${item.title}`}>
        <button
          type="button"
          className={feedback === "up" ? "active positive" : ""}
          onClick={() => onFeedback(item, "up")}
          aria-pressed={feedback === "up"}
          aria-label={`More like ${item.title}`}
        >
          <ThumbsUp size={15} />
        </button>
        <button
          type="button"
          className={feedback === "maybe" ? "active maybe" : ""}
          onClick={() => onFeedback(item, "maybe")}
          aria-pressed={feedback === "maybe"}
          aria-label={`Maybe ${item.title}`}
          title="Maybe"
        >
          <BookmarkSimple size={15} />
        </button>
        <button
          type="button"
          className={feedback === "down" ? "active negative" : ""}
          onClick={() => onFeedback(item, "down")}
          aria-pressed={feedback === "down"}
          aria-label={`Less like ${item.title}`}
        >
          <ThumbsDown size={15} />
        </button>
      </div>
      <div className="poster-column">
        <div className="poster-frame">
          {posterSrc ? <img src={posterSrc} alt={`${item.title} poster`} /> : <div className="poster-placeholder">{posterFailed ? "Poster unavailable" : "Loading poster"}</div>}
          <a className="trailer-overlay" href={trailerUrl(item)} target="_blank" rel="noreferrer" aria-label={`Find trailer for ${item.title}`}>
            <Play size={14} />
            Trailer
          </a>
        </div>
        <div className="poster-meta" aria-label={posterMeta(item)}>
          {item.year ? <span>{item.year}</span> : null}
          <span>{item.runtimeMinutes ? `${item.runtimeMinutes} min` : "Runtime unknown"}</span>
        </div>
      </div>
      <div className="result-copy">
        <div className="card-title">
          <strong>{item.title}</strong>
        </div>
        <p className="reason">{cleanFitExplanation(item)}</p>
        <ul className="card-facts">
          <li>{genres.length ? genres.join(", ") : "Genres not cached"}</li>
        </ul>
        <button type="button" className="description-toggle" onClick={() => setShowDescription((current) => !current)}>
          {showDescription ? "Hide Description" : "Show Description"}
        </button>
        {showDescription ? <p className="description">{formatItemDescription(item)}</p> : null}
        <div className="card-actions">
          {needsSeason ? (
            <label className="season-field">
              <span>Season</span>
              <input type="number" min="1" max="99" value={seasonSelection} onChange={(event) => onSeasonSelection(event.target.value)} />
            </label>
          ) : null}
          <div className="score-badge" aria-label={`${displayScore} percent match`}>
            {displayScore}%
          </div>
          {item.plex?.available && plexHref ? (
            <a className="plex-tab" href={plexHref} target="_blank" rel="noreferrer" aria-label={`Open ${item.title} in Plex`} title="Open in Plex">
              <PlexGlyph />
            </a>
          ) : null}
          {!item.plex?.available && item.seerr?.url ? (
            <a className="primary-link seerr-link" href={item.seerr.url} target="_blank" rel="noreferrer" aria-label={`Open ${item.title} in Seerr`} title="Open in Seerr">
              Seerr
            </a>
          ) : null}
          {hasRequestAction ? (
            <button type="button" className="request-tab" onClick={() => void onPreviewRequest(item, needsSeason ? selectedSeason : undefined)} disabled={busy === "preview" || !canPreviewRequest} title="Request in Seerr">
              {busy === "preview" && isPreviewForItem ? <SpinnerGap size={15} className="spin" /> : null}
              Request
            </button>
          ) : null}
        </div>
        {isPreviewForItem ? (
          <div className="confirm-box compact-confirm">
            <strong>{preview.confirmationPhrase}</strong>
            <span>
              {preview.canRequest ? "Ready to request" : preview.blockedReason ?? "Request blocked"}: {preview.request.title}
              {preview.request.seasons?.length ? `, season ${preview.request.seasons.join(", ")}` : ""}
            </span>
            {preview.canRequest ? (
              <button onClick={() => void onCreateRequest()} disabled={busy === "create"}>
                Confirm request
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

function PlexGlyph() {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true" focusable="false" className="plex-glyph">
      <path d="M13 8h8.4L28 20l-6.6 12H13l6.5-12L13 8Z" />
    </svg>
  );
}

function posterMeta(item: ItemSummary) {
  const parts = [];
  if (item.year) parts.push(String(item.year));
  parts.push(item.runtimeMinutes ? `${item.runtimeMinutes} min` : "Runtime unknown");
  return parts.join(", ");
}

function cleanFitExplanation(item: ItemSummary) {
  const titlePrefix = new RegExp(`^${escapeRegExp(item.title)}\\s*(?:-|:|is\\s+|fits\\s+because\\s+|fits\\s+|works\\s+because\\s+|works\\s+)`, "i");
  const explanation = item.matchExplanation
    .trim()
    .replace(titlePrefix, "")
    .replace(/\bgood fit because(?: of)?\b/gi, "strong match for")
    .replace(/\ba good fit\b/gi, "a strong match")
    .replace(/\bThis looks like a good fit\b/gi, "This looks well matched")
    .replace(/\s*It is already available in Plex\.\s*/gi, " ")
    .trim();
  return threeSentenceText(explanation, [
    item.genres.length ? `The ${item.genres.slice(0, 2).join(" and ").toLowerCase()} mix keeps it close to the requested mood.` : "The cached library cues keep it close to the requested mood.",
    item.runtimeMinutes ? `The ${item.runtimeMinutes <= 95 ? "shorter" : item.runtimeMinutes <= 125 ? "standard" : "longer"} shape gives you a clear sense of its commitment before choosing.` : "The result card gives you enough context to decide whether it is worth opening."
  ]);
}

function formatItemDescription(item: ItemSummary) {
  return threeSentenceText(item.summary ?? "", [
    item.summary ? "" : "No cached synopsis is available for this item yet.",
    item.genres.length ? `Moodarr has it filed under ${item.genres.slice(0, 3).join(", ").toLowerCase()}.` : "Moodarr does not have detailed genre metadata cached yet.",
    item.runtimeMinutes ? `The cached runtime is ${item.runtimeMinutes} minutes, so the card still gives a basic commitment signal.` : "The runtime is not cached yet, so use the linked service for more detail."
  ]);
}

function threeSentenceText(text: string, fallbacks: string[]) {
  const sentences = splitSentences(text).filter((sentence) => !/^\s*it is already available in plex\.?\s*$/i.test(sentence));
  for (const fallback of fallbacks) {
    if (sentences.length >= 3) break;
    if (fallback.trim()) sentences.push(fallback.trim());
  }
  while (sentences.length < 3) {
    sentences.push("Use this as a directional signal alongside the poster, genres, and service links.");
  }
  return sentences.slice(0, 3).map(ensureSentencePunctuation).join(" ");
}

function splitSentences(text: string) {
  return text
    .replace(/\s+/g, " ")
    .match(/[^.!?]+[.!?]+|[^.!?]+$/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) ?? [];
}

function ensureSentencePunctuation(sentence: string) {
  const trimmed = sentence.trim();
  if (!trimmed) return "";
  const capitalized = trimmed[0]?.toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function trailerUrl(item: ItemSummary) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${item.title} ${item.year ?? ""} trailer`)}`;
}

function applyFeedbackRanking(items: ItemSummary[], feedbackByItem: Record<string, RecommendationFeedback>, baseScores: Record<string, number>) {
  const feedbackEntries = Object.entries(feedbackByItem);
  if (feedbackEntries.length === 0) return items;
  const itemById = new Map(items.map((item) => [item.id, item]));
  return items
    .map((item) => {
      let score = baseScores[item.id] ?? item.score;
      for (const [feedbackItemId, feedback] of feedbackEntries) {
        const reference = itemById.get(feedbackItemId);
        if (!reference) continue;
        const direction = feedback === "up" ? 1 : feedback === "down" ? -1 : 0.35;
        if (item.id === feedbackItemId) score += direction * 14;
        score += direction * sharedGenreCount(item, reference) * 8;
        if (item.mediaType === reference.mediaType) score += direction * 3;
      }
      return { ...item, score: Math.max(0, Math.round(score)) };
    })
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

function displayMatchScore(item: { score: number }, index: number, visibleItems: Array<{ score: number }>) {
  const rawScore = safeScore(item.score);
  const scores = visibleItems.map((entry) => safeScore(entry.score));
  const topScore = Math.max(rawScore, ...scores);
  const bottomScore = Math.min(rawScore, ...scores);
  const spread = topScore - bottomScore;
  const topTieCount = scores.filter((score) => score === topScore).length;
  const secondScore = scores
    .filter((score) => score < topScore)
    .sort((left, right) => right - left)[0];
  const distinctTopGap = topTieCount === 1 ? (secondScore === undefined ? 8 : topScore - secondScore) : 0;
  const highConfidenceBonus = Math.max(0, Math.min(3, (rawScore - 92) / 8));
  const absoluteAnchor = 48 + Math.min(42, Math.max(0, rawScore) * 0.42);
  const relativeScore = spread >= 8 ? 64 + ((rawScore - bottomScore) / spread) * 32 : absoluteAnchor + (rawScore - topScore) * 0.35;
  const rankPenalty = Math.min(20, Math.max(0, index) * 0.65);
  const rankCeiling = index === 0 ? 100 : Math.max(76, 99 - Math.ceil(index / 2));
  const topCeiling = index === 0 && rawScore >= 98 && distinctTopGap >= 4 ? 100 : Math.min(rankCeiling, 99);
  return Math.max(1, Math.min(topCeiling, Math.round(relativeScore + highConfidenceBonus - rankPenalty)));
}

function safeScore(score: number) {
  return Number.isFinite(score) ? score : 0;
}

function filterFeedbackItems(items: ItemSummary[], feedbackByItem: Record<string, RecommendationFeedback>, showRatedItems: boolean) {
  const hiddenItemIds = new Set(
    Object.entries(feedbackByItem)
      .filter(([, feedback]) => feedback === "down" || (!showRatedItems && feedback === "up"))
      .map(([itemId]) => itemId)
  );
  if (hiddenItemIds.size === 0) return items;
  return items.filter((item) => !hiddenItemIds.has(item.id));
}

function visibleResultsFromPool(items: ItemSummary[], feedbackByItem: Record<string, RecommendationFeedback>, showRatedItems: boolean, limit: number) {
  return filterFeedbackItems(items, feedbackByItem, showRatedItems).slice(0, limit);
}

function hiddenFeedbackCount(feedbackByItem: Record<string, RecommendationFeedback>, showRatedItems: boolean) {
  return Object.values(feedbackByItem).filter((feedback) => feedback === "down" || (!showRatedItems && feedback === "up")).length;
}

function extractFeedbackMoodTerm(query: string) {
  const normalized = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (!normalized) return undefined;
  return feedbackMoodTerms.find((term) => normalized.includes(term));
}

function buildFeedbackContext(feedbackByItem: Record<string, RecommendationFeedback>, showRatedItems: boolean) {
  const moreLikeItemIds = Object.entries(feedbackByItem)
    .filter(([, feedback]) => feedback === "up")
    .map(([itemId]) => itemId);
  const maybeItemIds = Object.entries(feedbackByItem)
    .filter(([, feedback]) => feedback === "maybe")
    .map(([itemId]) => itemId);
  const lessLikeItemIds = Object.entries(feedbackByItem)
    .filter(([, feedback]) => feedback === "down")
    .map(([itemId]) => itemId);
  const hiddenItemIds = Object.entries(feedbackByItem)
    .filter(([, feedback]) => feedback === "down" || (!showRatedItems && feedback === "up"))
    .map(([itemId]) => itemId);
  return { moreLikeItemIds, maybeItemIds, lessLikeItemIds, hiddenItemIds, showRatedItems };
}

function nextFeedbackState(current: Record<string, RecommendationFeedback>, itemId: string, feedback: RecommendationFeedback) {
  const next = { ...current };
  if (next[itemId] === feedback) delete next[itemId];
  else next[itemId] = feedback;
  return next;
}

function nextFeedbackTitleState(current: Record<string, string>, item: ItemSummary, feedbackByItem: Record<string, RecommendationFeedback>) {
  const next = { ...current };
  if (feedbackByItem[item.id]) next[item.id] = item.title;
  else delete next[item.id];
  return next;
}

function summarizeFeedbackSelection(
  feedbackByItem: Record<string, RecommendationFeedback>,
  titleByItem: Record<string, string>,
  submittedFeedbackByItem: Record<string, RecommendationFeedback> = {}
) {
  const moreLike = Object.entries(feedbackByItem)
    .filter(([, feedback]) => feedback === "up")
    .filter(([itemId, feedback]) => submittedFeedbackByItem[itemId] !== feedback)
    .map(([itemId]) => titleByItem[itemId])
    .filter((title): title is string => Boolean(title));
  const lessLike = Object.entries(feedbackByItem)
    .filter(([, feedback]) => feedback === "down")
    .filter(([itemId, feedback]) => submittedFeedbackByItem[itemId] !== feedback)
    .map(([itemId]) => titleByItem[itemId])
    .filter((title): title is string => Boolean(title));
  const maybe = Object.entries(feedbackByItem)
    .filter(([, feedback]) => feedback === "maybe")
    .filter(([itemId, feedback]) => submittedFeedbackByItem[itemId] !== feedback)
    .map(([itemId]) => titleByItem[itemId])
    .filter((title): title is string => Boolean(title));
  const parts = [];
  if (moreLike.length) parts.push(`More like ${formatList(moreLike)}.`);
  if (maybe.length) parts.push(`Maybe keep ${formatList(maybe)} as potentials.`);
  if (lessLike.length) parts.push(`Less like ${formatList(lessLike)}.`);
  return parts.join(" ");
}

function retainedPotentialItems(freshItems: ItemSummary[], previousItems: ItemSummary[], feedbackByItem: Record<string, RecommendationFeedback>) {
  if (previousItems.length === 0) return [];
  const freshIds = new Set(freshItems.map((item) => item.id));
  const maybeIds = new Set(Object.entries(feedbackByItem).filter(([, feedback]) => feedback === "maybe").map(([itemId]) => itemId));
  return previousItems.filter((item) => maybeIds.has(item.id) && !freshIds.has(item.id));
}

function mergeUniqueItems(primaryItems: ItemSummary[], retainedItems: ItemSummary[]) {
  if (retainedItems.length === 0) return primaryItems;
  const itemById = new Map<string, ItemSummary>();
  for (const item of [...primaryItems, ...retainedItems]) itemById.set(item.id, item);
  return [...itemById.values()];
}

function sharedGenreCount(first: ItemSummary, second: ItemSummary) {
  const secondGenres = new Set(second.genres.map((genre) => genre.toLowerCase()));
  return first.genres.filter((genre) => secondGenres.has(genre.toLowerCase())).length;
}

function availabilityScopeFromFilters(filters: SearchFilters): AvailabilityScope {
  return filters.availability?.length === 1 && filters.availability[0] === "available_in_plex" ? "plex" : "plex-seerr";
}

function availabilityFromScope(scope: AvailabilityScope): AvailabilityGroup[] | undefined {
  return scope === "plex" ? ["available_in_plex"] : undefined;
}

function loadSavedQueries(): SavedQuery[] {
  try {
    const raw = localStorage.getItem(savedQueryStorageKey);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const query = typeof (entry as SavedQuery).query === "string" ? (entry as SavedQuery).query.trim() : "";
      if (!query) return [];
      return [
        {
          id: typeof (entry as SavedQuery).id === "string" ? (entry as SavedQuery).id : createId(),
          query,
          createdAt: typeof (entry as SavedQuery).createdAt === "string" ? (entry as SavedQuery).createdAt : new Date().toISOString()
        }
      ];
    });
  } catch {
    return [];
  }
}

function persistSavedQueries(queries: SavedQuery[]) {
  const next = queries.slice(0, maxSavedQueries);
  localStorage.setItem(savedQueryStorageKey, JSON.stringify(next));
  return next;
}

function upsertSavedQuery(current: SavedQuery[], query: string) {
  const normalized = query.trim();
  const withoutDuplicate = current.filter((entry) => entry.query.trim() !== normalized);
  return [{ id: createId(), query: normalized, createdAt: new Date().toISOString() }, ...withoutDuplicate].slice(0, maxSavedQueries);
}

async function copyText(value: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const element = document.createElement("textarea");
  element.value = value;
  element.setAttribute("readonly", "");
  element.style.position = "fixed";
  element.style.left = "-9999px";
  document.body.appendChild(element);
  element.select();
  try {
    if (!document.execCommand("copy")) throw new Error("Could not copy query.");
  } finally {
    document.body.removeChild(element);
  }
}

function formatList(values: string[]) {
  if (values.length <= 1) return values[0] ?? "";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values[values.length - 1]}`;
}

function createId() {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getSpeechRecognitionConstructor() {
  if (typeof window === "undefined") return undefined;
  const speechWindow = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition;
}

function RuntimeFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="runtime-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SyncHistory({ history }: { history: SyncStatus["history"] | undefined }) {
  const runs = [
    ...(history?.library ?? []).map((run) => ({ ...run, label: "Plex library" })),
    ...(history?.seerr ?? []).map((run) => ({ ...run, label: "Seerr requests" }))
  ]
    .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime())
    .slice(0, 4);

  if (runs.length === 0) {
    return (
      <div className="history-list">
        <div className="history-row empty">
          <span className="dot" />
          <div>
            <strong>No sync history yet</strong>
            <span>Run a sync to populate recent activity.</span>
          </div>
          <em>idle</em>
        </div>
      </div>
    );
  }

  return (
    <div className="history-list" aria-label="Recent sync history">
      {runs.map((run) => (
        <div className="history-row" key={`${run.label}-${run.id}`}>
          <span className={run.status === "ok" ? "dot ready" : "dot"} />
          <div>
            <strong>{run.label}</strong>
            <span>{run.error ? run.error : `${run.itemCount} items from ${run.source}`}</span>
          </div>
          <em>{formatDate(run.startedAt)}</em>
        </div>
      ))}
    </div>
  );
}

function PreferenceSignals({ signals }: { signals: { feature: string; weight: number }[] | undefined }) {
  if (!signals?.length) {
    return (
      <div className="signal-wrap">
        <span className="signal-chip">Learning</span>
      </div>
    );
  }

  return (
    <div className="signal-wrap">
      {signals.slice(0, 3).map((signal) => (
        <span className="signal-chip" key={`${signal.feature}-${signal.weight}`}>
          {formatSignalFeature(signal.feature)} <strong>{formatWeight(signal.weight)}</strong>
        </span>
      ))}
    </div>
  );
}

function FeelProfileTerms({ profile }: { profile: FeelProfileResponse | undefined }) {
  if (!profile?.terms.length) {
    return (
      <div className="signal-wrap">
        <span className="signal-chip">Learning</span>
      </div>
    );
  }

  return (
    <div className="signal-wrap">
      {profile.terms.slice(0, 4).map((term) => (
        <span className="signal-chip" key={`${profile.id}-${term.term}`}>
          {term.term} <strong>{Math.round(term.confidence * 100)}%</strong>
        </span>
      ))}
    </div>
  );
}

function ProfileDriftAlerts({
  alerts,
  busy,
  onRollback
}: {
  alerts: FeelProfileDriftAlert[];
  busy: string;
  onRollback: (alert: FeelProfileDriftAlert) => Promise<unknown>;
}) {
  if (!alerts.length) {
    return (
      <div className="signal-wrap">
        <span className="signal-chip">Stable</span>
      </div>
    );
  }

  return (
    <div className="profile-alert-list">
      {alerts.slice(0, 4).map((alert) => (
        <div className="profile-alert-row" key={`${alert.profileId}-${alert.term}-${alert.version}`}>
          <div>
            <strong>{alert.term}</strong>
            <span>
              {alert.watchContext} / v{alert.version} / conflict {Math.round(alert.conflictScore * 100)}%
            </span>
          </div>
          <span className={alert.severity === "review" ? "admin-tag warn" : "admin-tag"}>
            <span className="tag-dot" />
            {alert.severity}
          </span>
          <button type="button" className="icon-admin-button" onClick={() => void onRollback(alert)} disabled={Boolean(busy)} aria-label={`Rollback ${alert.term}`}>
            <ArrowClockwise size={15} />
            Rollback
          </button>
        </div>
      ))}
    </div>
  );
}

function ProfileTimeline({ checkpoints }: { checkpoints: FeelProfileCheckpointSummary[] }) {
  if (!checkpoints.length) {
    return (
      <div className="diagnostic-runs">
        <div className="diagnostic-run empty">
          <span>No checkpoints</span>
          <strong>Waiting</strong>
          <span>Profile feedback creates checkpoint history.</span>
          <em>-</em>
        </div>
      </div>
    );
  }

  return (
    <div className="profile-timeline-list" aria-label="Recent feel profile checkpoints">
      {checkpoints.slice(0, 5).map((checkpoint) => (
        <div className="profile-timeline-row" key={`${checkpoint.profileId}-${checkpoint.term}-${checkpoint.version}`}>
          <span>{formatShortTime(checkpoint.createdAt)}</span>
          <strong>
            {checkpoint.term} v{checkpoint.version}
          </strong>
          <span>
            {checkpoint.watchContext} / confidence {Math.round(checkpoint.effectiveEvidence)} / conflict {Math.round(checkpoint.conflictScore * 100)}%
          </span>
          <em>{formatWeight(checkpoint.positiveWeight - checkpoint.negativeWeight)}</em>
        </div>
      ))}
    </div>
  );
}

function RecentRecommendationRuns({ runs }: { runs: RecommendationDiagnostics["recentRuns"] | undefined }) {
  if (!runs?.length) {
    return (
      <div className="diagnostic-runs">
        <div className="diagnostic-run empty">
          <span>No recent runs</span>
          <strong>Waiting</strong>
          <span>Run a recommendation search to populate diagnostics.</span>
          <em>-</em>
        </div>
      </div>
    );
  }

  return (
    <div className="diagnostic-runs" aria-label="Recent recommendation runs">
      {runs.slice(0, 4).map((run) => (
        <div className="diagnostic-run" key={run.id}>
          <span>{formatShortTime(run.createdAt)}</span>
          <strong>{run.watchContext}</strong>
          <span>
            {run.candidateCount} candidates / {run.rerankCandidateCount} reranked / {run.seerrAugmented ? "Seerr augmented" : "library only"}
          </span>
          <em>{run.latencyMs} ms</em>
        </div>
      ))}
    </div>
  );
}

function formatDate(value?: string) {
  if (!value) return "not synced";
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatShortTime(value?: string) {
  if (!value) return "not synced";
  return new Date(value).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function syncResultMessage(result: SyncRunResult) {
  if (!result.ok) return result.error ?? "Sync skipped.";
  const unavailable = result.plexUnavailable ? `, marked ${result.plexUnavailable} unavailable` : "";
  const embeddings = result.providerEmbeddings?.configured ? ` Warmed ${result.providerEmbeddings.embedded} embeddings.` : "";
  return `Synced ${result.plexItems ?? 0} Plex and ${result.seerrItems ?? 0} Seerr items${unavailable}.${embeddings}`;
}

function formatReasoningEffort(effort: OpenAiReasoningEffort) {
  return effort === "xhigh" ? "X-high" : effort.charAt(0).toUpperCase() + effort.slice(1);
}

function browserAdminReady(status: ConfigStatusResponse | null) {
  return Boolean(!status?.admin.authRequired || (status.admin.configured && status.admin.autoSession));
}

function adminStatusDetail(status: ConfigStatusResponse | null) {
  if (!status?.admin.authRequired) return "LAN";
  if (!status.admin.configured) return "Needs token";
  return status.admin.autoSession ? "Container session" : "Session disabled";
}

function displayUserName(user: AuthUser | undefined) {
  return user?.displayName || user?.username || user?.email || "Plex user";
}

function requestCountLabel(count: number | undefined) {
  const value = count ?? 0;
  return `${value} ${value === 1 ? "request" : "requests"}`;
}

function embeddingWarmupMessage(result: NonNullable<SyncRunResult["providerEmbeddings"]>) {
  if (!result.configured) return "Embedding provider is not configured.";
  if (result.error) return result.error;
  const remaining = result.hasMore ? " More remain." : "";
  return `Warmed ${result.embedded} embeddings.${remaining}`;
}

function downloadJson(filename: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function reviewStatusLabel(status: QueryReviewStatus) {
  if (status === "pending") return "Pending";
  if (status === "reviewed") return "Reviewed";
  return "All";
}

function reviewRatingLabel(value: number) {
  if (value <= 1) return "Poor mood fit";
  if (value === 2) return "Weak mood fit";
  if (value === 3) return "Mixed mood fit";
  if (value === 4) return "Good mood fit";
  return "Excellent mood fit";
}

function formatSignalFeature(feature: string) {
  return feature.replace(/^[a-z]+:/, "").replaceAll("-", " ");
}

function formatWeight(weight: number) {
  return `${weight >= 0 ? "+" : ""}${weight.toFixed(2)}`;
}
