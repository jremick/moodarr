import {
  CheckCircle,
  Database,
  DownloadSimple,
  FloppyDisk,
  GearSix,
  HardDrives,
  Key,
  MagnifyingGlass,
  Microphone,
  PaperPlaneTilt,
  Play,
  Plus,
  Sparkle,
  SpinnerGap,
  Stack,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  User,
  Users,
  WarningCircle
} from "@phosphor-icons/react";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { feelerrApi, getAdminToken, setAdminToken } from "./api";
import type {
  AdminSettings,
  AdminSettingsUpdate,
  AvailabilityGroup,
  ConfigStatusResponse,
  ItemSummary,
  LibraryStats,
  MediaType,
  RequestPreview,
  SearchFilters,
  SyncStatus,
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

const numberWords: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  "twenty-five": 25,
  thirty: 30,
  forty: 40,
  fifty: 50
};

type ActiveView = "finder" | "admin";
type VoiceState = "idle" | "listening" | "unsupported";
type RecommendationFeedback = "up" | "down";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
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

export interface ChatCriteria {
  query: string;
  filters: SearchFilters;
  resultLimit: number;
  watchContext: WatchContext;
  applied: string[];
}

type AvailabilityScope = "plex" | "plex-seerr";

export function App() {
  const [activeView, setActiveView] = useState<ActiveView>("finder");
  const [status, setStatus] = useState<ConfigStatusResponse | null>(null);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [adminToken, setAdminTokenState] = useState(getAdminToken());
  const [chatDraft, setChatDraft] = useState("");
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [filters, setFilters] = useState<SearchFilters>({ availability: ["available_in_plex"] });
  const [resultLimit, setResultLimit] = useState(20);
  const [watchContext, setWatchContext] = useState<WatchContext>("solo");
  const [results, setResults] = useState<ItemSummary[]>([]);
  const [feedbackByItem, setFeedbackByItem] = useState<Record<string, RecommendationFeedback>>({});
  const [feedbackTitleByItem, setFeedbackTitleByItem] = useState<Record<string, string>>({});
  const [showRatedItems, setShowRatedItems] = useState(true);
  const [submittedFeedbackByItem, setSubmittedFeedbackByItem] = useState<Record<string, RecommendationFeedback>>({});
  const [preview, setPreview] = useState<RequestPreview | null>(null);
  const [seasonSelections, setSeasonSelections] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string>("");
  const [busy, setBusy] = useState<string>("");
  const [voiceState, setVoiceState] = useState<VoiceState>("idle");
  const [adminDraft, setAdminDraft] = useState<AdminSettingsUpdate>({});
  const voiceRecognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const baseScoreByItemIdRef = useRef<Record<string, number>>({});

  useEffect(() => {
    void refreshStatus();
  }, []);

  useEffect(() => {
    if (!getSpeechRecognitionConstructor()) setVoiceState("unsupported");
  }, []);

  const grouped = useMemo(() => {
    return groupOrder.map((group) => ({
      group,
      items: results.filter((item) => item.availabilityGroup === group)
    }));
  }, [results]);

  async function refreshStatus() {
    const [configStatus, libraryStats] = await Promise.all([feelerrApi.configStatus(), feelerrApi.stats().catch(() => null)]);
    setStatus(configStatus);
    setStats(libraryStats);
  }

  async function refreshAdmin() {
    const [adminSettings, scheduler] = await Promise.all([feelerrApi.adminSettings(), feelerrApi.syncStatus()]);
    setSettings(adminSettings);
    setSyncStatus(scheduler);
    setAdminDraft({
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
        openaiModel: adminSettings.ai.openaiModel
      },
      sync: {
        intervalMinutes: adminSettings.sync.intervalMinutes,
        syncSeerr: adminSettings.sync.syncSeerr
      }
    });
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

  async function submitChat(event?: React.FormEvent, promptOverride?: string) {
    event?.preventDefault();
    const prompt = (promptOverride ?? chatDraft).trim();
    if (!prompt) return;
    const criteria = deriveChatCriteria(prompt, filters, resultLimit, watchContext);
    const userMessage: ChatMessage = { id: createId(), role: "user", text: prompt };
    const assistantMessage: ChatMessage = {
      id: createId(),
      role: "assistant",
      text: summarizeAppliedCriteria(criteria)
    };

    setChatMessages((current) => [...current, userMessage, assistantMessage]);
    setChatDraft("");
    setFilters(criteria.filters);
    setResultLimit(criteria.resultLimit);
    setWatchContext(criteria.watchContext);
    setSubmittedFeedbackByItem(feedbackByItem);
    setBusy("search");
    setNotice("");
    setPreview(null);
    try {
      const requestedLimit = showRatedItems ? criteria.resultLimit : Math.min(50, criteria.resultLimit + Object.keys(feedbackByItem).length);
      const response = await feelerrApi.search({
        query: criteria.query,
        watchContext: criteria.watchContext,
        resultLimit: requestedLimit,
        filters: criteria.filters
      });
      baseScoreByItemIdRef.current = Object.fromEntries(response.results.map((item) => [item.id, item.score]));
      const ranked = applyFeedbackRanking(response.results, feedbackByItem, baseScoreByItemIdRef.current);
      setResults(filterRatedItems(ranked, feedbackByItem, showRatedItems).slice(0, criteria.resultLimit));
      await refreshStatus();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
    }
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
      () => feelerrApi.previewRequest({ itemId: item.id, seasons }),
      (result) => (result.canRequest ? "Request preview ready." : result.blockedReason ?? "Request blocked.")
    );
    if (request) setPreview(request);
  }

  async function createRequest() {
    if (!preview) return;
    await runAction(
      "create",
      () =>
        feelerrApi.createRequest({
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
    const feedbackText = summarizeFeedbackSelection(nextFeedback, nextTitles, submittedFeedbackByItem);
    setChatDraft(feedbackText);
  }

  async function saveAdminSettings(event: React.FormEvent) {
    event.preventDefault();
    const saved = await runAction("admin-save", () => feelerrApi.updateAdminSettings(adminDraft), () => "Settings saved.");
    if (saved) {
      setSettings(saved);
      await refreshAdmin();
    }
  }

  function persistAdminToken() {
    setAdminToken(adminToken);
    setNotice(adminToken.trim() ? "Admin token saved in this browser." : "Admin token cleared from this browser.");
  }

  return (
    <main className="app-shell">
      <section className="topbar">
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
            <h1>Feelerr</h1>
            <p>Availability-first watch finder</p>
          </div>
        </div>
        {activeView === "finder" ? (
          <CriteriaBar
            filters={filters}
            setFilters={setFilters}
            resultLimit={resultLimit}
            setResultLimit={setResultLimit}
            watchContext={watchContext}
            setWatchContext={setWatchContext}
            showRatedItems={showRatedItems}
            setShowRatedItems={setShowRatedItems}
          />
        ) : null}
        <div className="topbar-actions">
          {activeView === "finder" ? (
            <button
              className="tab-button icon-only"
              onClick={() => {
                setActiveView("admin");
                void runAction("admin-refresh", refreshAdmin, () => "Admin state refreshed.");
              }}
              aria-label="Open admin settings"
              title="Admin settings"
            >
              <GearSix size={18} />
            </button>
          ) : (
            <button className="tab-button icon-only" onClick={() => setActiveView("finder")} aria-label="Open finder" title="Finder">
              <MagnifyingGlass size={18} />
            </button>
          )}
        </div>
      </section>

      {notice && activeView === "admin" ? (
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
        />
      ) : (
        <AdminView
          status={status}
          stats={stats}
          settings={settings}
          syncStatus={syncStatus}
          adminToken={adminToken}
          setAdminTokenState={setAdminTokenState}
          persistAdminToken={persistAdminToken}
          adminDraft={adminDraft}
          setAdminDraft={setAdminDraft}
          saveAdminSettings={saveAdminSettings}
          busy={busy}
          runAction={runAction}
          refreshAdmin={refreshAdmin}
        />
      )}
    </main>
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
    setSeasonSelections
  } = props;
  const visibleGroups = grouped.filter(({ items }) => items.length > 0);
  const hasResults = visibleGroups.length > 0;
  return (
    <section className="workspace finder-workspace">
      <section className="finder-panel">
        <section className="results">
          {busy === "search" ? <ResultSkeletons /> : null}
          {!busy && !hasResults ? <SearchEmptyState /> : null}
          {!busy
            ? visibleGroups.map(({ group, items }) => (
                <section className="result-group" key={group}>
                  <div className="card-grid">
                    {items.map((item, index) => (
                      <ResultCard
                        key={item.id}
                        item={item}
                        index={index}
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
        <ResultsStatus grouped={grouped} busy={busy} />
        {notice ? (
          <div className="notice rail-notice">
            <WarningCircle size={16} />
            {notice}
          </div>
        ) : null}
        <form className="chat-panel" onSubmit={(event) => void props.submitChat(event)}>
          <div className="chat-log" aria-live="polite" aria-label="Conversation history">
            {chatMessages.map((message) => (
              <div className={`chat-message ${message.role}`} key={message.id}>
                {message.text}
              </div>
            ))}
          </div>
          <div className="chat-composer">
            <textarea
              value={chatDraft}
              rows={4}
              onChange={(event) => setChatDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void props.submitChat();
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
              <button type="submit" disabled={busy === "search" || !chatDraft.trim()} aria-label="Send chat prompt">
                {busy === "search" ? <SpinnerGap size={16} className="spin" /> : <PaperPlaneTilt size={16} />}
              </button>
            </div>
          </div>
        </form>
      </aside>
    </section>
  );
}

function CriteriaBar({
  filters,
  setFilters,
  resultLimit,
  setResultLimit,
  watchContext,
  setWatchContext,
  showRatedItems,
  setShowRatedItems
}: {
  filters: SearchFilters;
  setFilters: React.Dispatch<React.SetStateAction<SearchFilters>>;
  resultLimit: number;
  setResultLimit: (value: number) => void;
  watchContext: WatchContext;
  setWatchContext: (value: WatchContext) => void;
  showRatedItems: boolean;
  setShowRatedItems: (value: boolean) => void;
}) {
  return (
    <section className="criteria-strip" aria-label="Active criteria">
      <div className="criteria-strip-controls filter-stack">
        <FilterSelect
          label="Type"
          value={mediaTypeFilterValue(filters.mediaTypes)}
          onChange={(value) => setFilters((current) => ({ ...current, mediaTypes: mediaTypesFromFilterValue(value) }))}
          options={[
            ["all", "Movies & TV"],
            ["movie", "Movie"],
            ["tv", "TV"]
          ]}
        />
        <button
          type="button"
          className={watchContext === "group" ? "context-toggle group" : "context-toggle"}
          onClick={() => setWatchContext(watchContext === "solo" ? "group" : "solo")}
          aria-pressed={watchContext === "group"}
          aria-label={watchContext === "solo" ? "Recommendation context for me" : "Recommendation context together"}
        >
          {watchContext === "solo" ? <User size={14} /> : <Users size={14} />}
          {watchContext === "solo" ? "For Me" : "Together"}
        </button>
        <FilterSelect
          label="Runtime"
          value={String(filters.maxRuntimeMinutes ?? "")}
          onChange={(value) => setFilters((current) => ({ ...current, maxRuntimeMinutes: value ? Number(value) : undefined }))}
          options={[
            ["", "Any length"],
            ["90", "90 min"],
            ["120", "2 hours"],
            ["600", "Short series"]
          ]}
        />
        <label className="result-limit-field">
          <span className="sr-only">Results</span>
          <input type="number" min="1" max="50" value={resultLimit} onChange={(event) => setResultLimit(Math.max(1, Math.min(50, Number(event.target.value) || 20)))} />
        </label>
        <FilterSelect
          label="Genre"
          value={filters.genres?.[0] ?? ""}
          onChange={(value) => setFilters((current) => ({ ...current, genres: value ? [value] : [] }))}
          options={genreOptions}
        />
        <FilterSelect
          label="Availability"
          value={availabilityScopeFromFilters(filters)}
          onChange={(value) => setFilters((current) => ({ ...current, availability: availabilityFromScope(value as AvailabilityScope) }))}
          options={[
            ["plex", "In Plex"],
            ["plex-seerr", "Plex + Seerr"]
          ]}
        />
        <button
          type="button"
          className={showRatedItems ? "rated-toggle active" : "rated-toggle"}
          onClick={() => setShowRatedItems(!showRatedItems)}
          aria-pressed={showRatedItems}
          aria-label={showRatedItems ? "Showing rated recommendations" : "Hiding rated recommendations"}
          title={showRatedItems ? "Rated items shown" : "Rated items hidden"}
        >
          <ThumbsUp size={16} />
        </button>
      </div>
    </section>
  );
}

function ResultsStatus({ grouped, busy }: { grouped: { group: AvailabilityGroup; items: ItemSummary[] }[]; busy: string }) {
  const counts = grouped.map(({ group, items }) => ({ group, count: items.length })).filter(({ count }) => count > 0);
  if (busy === "search") {
    return (
      <div className="rail-status">
        <strong>Finding matches</strong>
        <span>Ranking Plex and Seerr candidates</span>
      </div>
    );
  }
  if (counts.length === 0) {
    return (
      <div className="rail-status">
        <strong>Ready</strong>
        <span>Ask for a mood to start</span>
      </div>
    );
  }
  const primary = counts[0];
  const total = counts.reduce((sum, item) => sum + item.count, 0);
  return (
    <div className="rail-status">
      <strong>{groupLabels[primary.group]}</strong>
      <span>{total} shown</span>
    </div>
  );
}

function AdminView(props: {
  status: ConfigStatusResponse | null;
  stats: LibraryStats | null;
  settings: AdminSettings | null;
  syncStatus: SyncStatus | null;
  adminToken: string;
  setAdminTokenState: (value: string) => void;
  persistAdminToken: () => void;
  adminDraft: AdminSettingsUpdate;
  setAdminDraft: React.Dispatch<React.SetStateAction<AdminSettingsUpdate>>;
  saveAdminSettings: (event: React.FormEvent) => Promise<void>;
  busy: string;
  runAction: <T>(name: string, action: () => Promise<T>, message: (result: T) => string) => Promise<T | undefined>;
  refreshAdmin: () => Promise<void>;
}) {
  const { status, stats, settings, syncStatus, adminDraft, setAdminDraft, busy } = props;
  return (
    <section className="admin-grid">
      <form
        className="admin-panel"
        onSubmit={(event) => {
          event.preventDefault();
          props.persistAdminToken();
        }}
      >
        <PanelTitle icon={<ShieldCheck size={18} />} title="Access" />
        <p className="panel-copy">Store an admin token for protected actions on this browser.</p>
        <div className="field-row">
          <label>
            Admin token
            <input
              type="password"
              autoComplete="off"
              value={props.adminToken}
              onChange={(event) => props.setAdminTokenState(event.target.value)}
              placeholder="Stored only in this browser"
            />
          </label>
          <button type="submit">
            <Key size={16} />
            Store
          </button>
        </div>
        <div className="status-list">
          <StatusRow label="Auth required" ready={!status?.admin.authRequired || Boolean(status.admin.configured)} detail={status?.admin.authRequired ? "Yes" : "No"} />
          <StatusRow label="Client served" ready={Boolean(status?.runtime.serveClient)} detail={status?.runtime.serveClient ? "Single container" : "Dev split"} />
          <StatusRow label="Fixture mode" ready={Boolean(status?.fixtureMode)} detail={status?.fixtureMode ? "On" : "Off"} />
        </div>
      </form>

      <form className="admin-panel wide" onSubmit={(event) => void props.saveAdminSettings(event)}>
        <PanelTitle icon={<GearSix size={18} />} title="Integrations" />
        <div className="admin-columns">
          <fieldset>
            <legend>Plex</legend>
            <label>
              Base URL
              <input value={adminDraft.plex?.baseUrl ?? ""} onChange={(event) => setAdminDraft((current) => ({ ...current, plex: { ...current.plex, baseUrl: event.target.value } }))} placeholder="http://plex:32400" />
            </label>
            <label>
              Plex Web URL
              <input value={adminDraft.plex?.webBaseUrl ?? ""} onChange={(event) => setAdminDraft((current) => ({ ...current, plex: { ...current.plex, webBaseUrl: event.target.value } }))} placeholder="https://app.plex.tv/desktop" />
            </label>
            <label>
              Plex token
              <input
                type="password"
                autoComplete="off"
                required={!adminDraft.fixtureMode && !settings?.plex.tokenConfigured}
                onChange={(event) => setAdminDraft((current) => ({ ...current, plex: { ...current.plex, token: event.target.value } }))}
                placeholder={settings?.plex.tokenConfigured ? "Configured" : "Required"}
              />
            </label>
          </fieldset>

          <fieldset>
            <legend>Seerr</legend>
            <label>
              Base URL
              <input value={adminDraft.seerr?.baseUrl ?? ""} onChange={(event) => setAdminDraft((current) => ({ ...current, seerr: { ...current.seerr, baseUrl: event.target.value } }))} placeholder="http://seerr:5055" />
            </label>
            <label>
              API key
              <input
                type="password"
                autoComplete="off"
                onChange={(event) => setAdminDraft((current) => ({ ...current, seerr: { ...current.seerr, apiKey: event.target.value } }))}
                placeholder={settings?.seerr.apiKeyConfigured ? "Configured" : "Paste API key"}
              />
            </label>
          </fieldset>

          <fieldset>
            <legend>Recommendations</legend>
            <label>
              Provider
              <select value={adminDraft.ai?.provider ?? "none"} onChange={(event) => setAdminDraft((current) => ({ ...current, ai: { ...current.ai, provider: event.target.value as "none" | "openai" } }))}>
                <option value="none">None</option>
                <option value="openai">OpenAI provider</option>
              </select>
            </label>
            <label>
              Model
              <input value={adminDraft.ai?.openaiModel ?? ""} onChange={(event) => setAdminDraft((current) => ({ ...current, ai: { ...current.ai, openaiModel: event.target.value } }))} placeholder="gpt-5-mini" />
            </label>
            <label>
              API key
              <input
                type="password"
                autoComplete="off"
                onChange={(event) => setAdminDraft((current) => ({ ...current, ai: { ...current.ai, openaiApiKey: event.target.value } }))}
                placeholder={settings?.ai.openaiApiKeyConfigured ? "Configured" : "Optional"}
              />
            </label>
          </fieldset>
        </div>

        <div className="admin-actions">
          <label className="toggle-row">
            <input type="checkbox" checked={Boolean(adminDraft.fixtureMode)} onChange={(event) => setAdminDraft((current) => ({ ...current, fixtureMode: event.target.checked }))} />
            Fixture mode
          </label>
          <label>
            Sync interval
            <input type="number" min="0" max="10080" value={adminDraft.sync?.intervalMinutes ?? 0} onChange={(event) => setAdminDraft((current) => ({ ...current, sync: { ...current.sync, intervalMinutes: Number(event.target.value) } }))} />
          </label>
          <label className="toggle-row">
            <input type="checkbox" checked={adminDraft.sync?.syncSeerr ?? true} onChange={(event) => setAdminDraft((current) => ({ ...current, sync: { ...current.sync, syncSeerr: event.target.checked } }))} />
            Sync Seerr
          </label>
          <button type="submit" disabled={busy === "admin-save"}>
            {busy === "admin-save" ? <SpinnerGap size={16} className="spin" /> : <FloppyDisk size={16} />}
            Save settings
          </button>
        </div>
      </form>

      <HealthPanel status={status} stats={stats} busy={busy} runAction={props.runAction} />

      <section className="admin-panel">
        <PanelTitle icon={<Database size={18} />} title="Runtime" />
        <div className="runtime-list">
          <RuntimeFact label="Data" value={status?.runtime.dataDir ?? "-"} />
          <RuntimeFact label="Database" value={status?.runtime.dbPath ?? "-"} />
          <RuntimeFact label="Config" value={status?.runtime.configPath ?? "-"} />
          <RuntimeFact label="Next sync" value={formatDate(syncStatus?.nextRunAt)} />
          <RuntimeFact label="Items" value={String(stats?.totalItems ?? 0)} />
        </div>
        <div className="button-stack">
          <button onClick={() => void props.runAction("admin-refresh", props.refreshAdmin, () => "Admin state refreshed.")} disabled={Boolean(busy)}>
            <HardDrives size={16} />
            Refresh
          </button>
          <button onClick={() => void props.runAction("admin-sync", feelerrApi.runSync, (result) => (result.ok ? `Synced ${result.plexItems ?? 0} Plex and ${result.seerrItems ?? 0} Seerr items.` : result.error ?? "Sync skipped."))} disabled={Boolean(busy)}>
            <Stack size={16} />
            Run sync
          </button>
          <button onClick={() => void props.runAction("support", feelerrApi.supportBundle, () => "Support bundle generated without secrets.")} disabled={Boolean(busy)}>
            <DownloadSimple size={16} />
            Support bundle
          </button>
        </div>
      </section>
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
      <StatusRow label="Admin" ready={Boolean(!status?.admin.authRequired || status.admin.configured)} detail={status?.admin.authRequired ? (status.admin.configured ? "Protected" : "Needs token") : "LAN"} />
      <div className="metric-grid">
        <Metric label="Items" value={stats?.totalItems ?? 0} />
        <Metric label="Plex" value={stats?.availableInPlex ?? 0} />
        <Metric label="Requestable" value={stats?.requestable ?? 0} />
        <Metric label="Partial" value={stats?.partiallyAvailable ?? 0} />
      </div>
      <div className="button-stack">
        <button onClick={() => void runAction("plex-test", feelerrApi.testPlex, (result) => result.message)} disabled={Boolean(busy)}>
          {busy === "plex-test" ? <SpinnerGap size={16} className="spin" /> : <CheckCircle size={16} />}
          Test Plex
        </button>
        <button onClick={() => void runAction("seerr-test", feelerrApi.testSeerr, (result) => result.message)} disabled={Boolean(busy)}>
          {busy === "seerr-test" ? <SpinnerGap size={16} className="spin" /> : <CheckCircle size={16} />}
          Test Seerr
        </button>
        <button
          onClick={() => void runAction("admin-sync", feelerrApi.runSync, (result) => (result.ok ? `Synced ${result.plexItems ?? 0} Plex and ${result.seerrItems ?? 0} Seerr items.` : result.error ?? "Sync skipped."))}
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

function Metric({ label, value }: { label: string; value: number }) {
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

function mediaTypeFilterValue(value: MediaType[] | undefined) {
  return value?.length === 1 ? value[0] : "all";
}

function mediaTypesFromFilterValue(value: string): MediaType[] | undefined {
  if (value === "movie" || value === "tv") return [value];
  return undefined;
}

function SearchEmptyState() {
  return (
    <section className="empty-results">
      <Sparkle size={26} />
      <h2>Ask for a watch mood</h2>
      <p>Feelerr will rank cached Plex matches first, then label Seerr request options.</p>
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
  preview: RequestPreview | null;
  feedback?: RecommendationFeedback;
  busy: string;
  seasonSelection: string;
  onSeasonSelection: (value: string) => void;
  onFeedback: (item: ItemSummary, feedback: RecommendationFeedback) => void;
  onPreviewRequest: (item: ItemSummary, selectedSeason?: number) => Promise<void>;
  onCreateRequest: () => Promise<void>;
}) {
  const isPreviewForItem = preview?.item.id === item.id;
  const needsSeason = !item.plex?.available && Boolean(item.seerr?.requestable) && item.mediaType === "tv";
  const selectedSeason = Number(seasonSelection);
  const canPreviewRequest = !needsSeason || (Number.isInteger(selectedSeason) && selectedSeason > 0);
  const genres = item.genres.slice(0, 4);
  const hasPlexAction = Boolean(item.plex?.available && item.plex.url);
  return (
    <article className={`result-card ${item.availabilityGroup}${hasPlexAction ? " has-plex-action" : ""}`} style={{ "--index": index } as CSSProperties}>
      <div className="score-badge">{Math.round(item.score)}%</div>
      <div className="poster-column">
        <div className="poster-frame">
          <img src={item.posterUrl} alt={`${item.title} poster`} />
          <a className="trailer-overlay" href={trailerUrl(item)} target="_blank" rel="noreferrer" aria-label={`Find trailer for ${item.title}`}>
            <Play size={14} />
            Trailer
          </a>
        </div>
        <div className="poster-meta">{posterMeta(item)}</div>
      </div>
      <div className="result-copy">
        <div className="card-title">
          <strong>{item.title}</strong>
        </div>
        <p className="reason"><span>Why</span> {item.matchExplanation}</p>
        <p className="description"><span>About</span> {item.summary ?? "No description is cached for this item yet."}</p>
        <ul className="card-facts">
          <li>{genres.length ? genres.join(", ") : "Genres not cached"}</li>
        </ul>
        <div className="card-actions">
          <div className="feedback-actions" aria-label={`Feedback for ${item.title}`}>
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
              className={feedback === "down" ? "active negative" : ""}
              onClick={() => onFeedback(item, "down")}
              aria-pressed={feedback === "down"}
              aria-label={`Less like ${item.title}`}
            >
              <ThumbsDown size={15} />
            </button>
          </div>
          {item.plex?.available && item.plex.url ? (
            <a className="plex-tab" href={item.plex.url} target="_blank" rel="noreferrer" aria-label={`Open ${item.title} in Plex`} title="Open in Plex">
              <PlexGlyph />
            </a>
          ) : null}
          {needsSeason ? (
            <label className="season-field">
              <span>Season</span>
              <input type="number" min="1" max="99" value={seasonSelection} onChange={(event) => onSeasonSelection(event.target.value)} />
            </label>
          ) : null}
          {!item.plex?.available && item.seerr?.requestable ? (
            <button onClick={() => void onPreviewRequest(item, needsSeason ? selectedSeason : undefined)} disabled={busy === "preview" || !canPreviewRequest}>
              {busy === "preview" && isPreviewForItem ? <SpinnerGap size={15} className="spin" /> : <Plus size={15} />}
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
        const direction = feedback === "up" ? 1 : -1;
        if (item.id === feedbackItemId) score += direction * 14;
        score += direction * sharedGenreCount(item, reference) * 8;
        if (item.mediaType === reference.mediaType) score += direction * 3;
      }
      return { ...item, score: Math.max(0, Math.min(100, Math.round(score))) };
    })
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

function filterRatedItems(items: ItemSummary[], feedbackByItem: Record<string, RecommendationFeedback>, showRatedItems: boolean) {
  if (showRatedItems) return items;
  const ratedItemIds = new Set(Object.keys(feedbackByItem));
  if (ratedItemIds.size === 0) return items;
  return items.filter((item) => !ratedItemIds.has(item.id));
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
  const parts = [];
  if (moreLike.length) parts.push(`More like ${formatList(moreLike)}.`);
  if (lessLike.length) parts.push(`Less like ${formatList(lessLike)}.`);
  return parts.join(" ");
}

function sharedGenreCount(first: ItemSummary, second: ItemSummary) {
  const secondGenres = new Set(second.genres.map((genre) => genre.toLowerCase()));
  return first.genres.filter((genre) => secondGenres.has(genre.toLowerCase())).length;
}

export function deriveChatCriteria(prompt: string, currentFilters: SearchFilters, currentLimit: number, currentContext: WatchContext): ChatCriteria {
  const normalized = normalizeText(prompt);
  const filters: SearchFilters = {
    ...currentFilters,
    mediaTypes: currentFilters.mediaTypes ? [...currentFilters.mediaTypes] : undefined,
    genres: currentFilters.genres ? [...currentFilters.genres] : undefined,
    availability: currentFilters.availability ? [...currentFilters.availability] : undefined,
    requestStatus: currentFilters.requestStatus ? [...currentFilters.requestStatus] : undefined
  };
  const applied: string[] = [];
  let resultLimit = currentLimit;
  let watchContext = currentContext;

  const mediaTypes = extractMediaTypes(normalized);
  if (mediaTypes) {
    filters.mediaTypes = mediaTypes;
    applied.push(mediaTypes.length === 2 ? "movies and TV" : mediaTypes[0] === "movie" ? "movies" : "TV series");
  }

  const runtime = extractRuntimeLimit(normalized, mediaTypes ?? filters.mediaTypes);
  if (runtime) {
    filters.maxRuntimeMinutes = runtime;
    applied.push(runtime >= 300 ? "short series" : `under ${runtime} min`);
  } else if (/\b(any runtime|no runtime|clear runtime)\b/.test(normalized)) {
    delete filters.maxRuntimeMinutes;
    applied.push("any runtime");
  }

  const availability = extractAvailability(normalized);
  if (availability === "plex") {
    filters.availability = ["available_in_plex"];
    applied.push("in Plex");
  } else if (availability === "plex-seerr") {
    delete filters.availability;
    applied.push("Plex and Seerr");
  } else if (/\b(any availability|all availability|include everything|clear availability)\b/.test(normalized)) {
    delete filters.availability;
    applied.push("Plex and Seerr");
  }

  if (/\b(any genre|no genre|clear genre|any style|no style|clear style)\b/.test(normalized)) {
    delete filters.genres;
    applied.push("any style");
  }

  const limit = extractResultLimit(normalized);
  if (limit) {
    resultLimit = limit;
    applied.push(`${limit} results`);
  }

  const context = extractWatchContext(normalized);
  if (context) {
    watchContext = context;
    applied.push(context === "group" ? "watching together" : "for me");
  }

  return { query: prompt, filters, resultLimit, watchContext, applied };
}

function summarizeAppliedCriteria(criteria: ChatCriteria) {
  if (criteria.applied.length === 0) return "I’ll keep the same criteria and use your latest note to tune the recommendations.";
  return `Got it. I’ll look for ${formatList(criteria.applied)} and use the rest of your message for the recommendation feel.`;
}

function extractMediaTypes(normalized: string): MediaType[] | undefined {
  const wantsMovie = /\b(movies?|films?)\b/.test(normalized);
  const wantsTv = /\b(tv|shows?|series)\b/.test(normalized);
  if (wantsMovie && wantsTv) return ["movie", "tv"];
  if (wantsMovie) return ["movie"];
  if (wantsTv) return ["tv"];
  return undefined;
}

function extractRuntimeLimit(normalized: string, mediaTypes?: MediaType[]) {
  const runtimeMatch = normalized.match(/\b(?:under|less than|shorter than|below|maximum|max|no more than|within)\s+([a-z0-9-]+)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/);
  if (runtimeMatch) {
    const amount = parseNumber(runtimeMatch[1]);
    if (amount) return runtimeMatch[2].startsWith("h") ? amount * 60 : amount;
  }
  if (/\bshort\b/.test(normalized) && mediaTypes?.includes("tv")) return 600;
  if (/\bshort\b/.test(normalized)) return 95;
  return undefined;
}

function extractAvailability(normalized: string): AvailabilityScope | undefined {
  if (/\b(plex \+ seerr|plex and seerr|include seerr|requestable|can request|request options|don't have|dont have|not in plex|unavailable)\b/.test(normalized)) return "plex-seerr";
  if (/\b(in plex|on plex|available in plex|plex only|we have|already have|local library)\b/.test(normalized)) return "plex";
  return undefined;
}

function availabilityScopeFromFilters(filters: SearchFilters): AvailabilityScope {
  return filters.availability?.length === 1 && filters.availability[0] === "available_in_plex" ? "plex" : "plex-seerr";
}

function availabilityFromScope(scope: AvailabilityScope): AvailabilityGroup[] | undefined {
  return scope === "plex" ? ["available_in_plex"] : undefined;
}

function extractResultLimit(normalized: string) {
  const digitMatch =
    normalized.match(/\b(?:find|show|give me|return|get|top|list)\s+(\d{1,2})\b/) ??
    normalized.match(/\b(\d{1,2})\s+(?:movies?|films?|shows?|series|options|results|recommendations|picks)\b/);
  if (digitMatch) return clampResultLimit(Number(digitMatch[1]));

  const wordMatch =
    normalized.match(/\b(?:find|show|give me|return|get|top|list)\s+([a-z]+(?:-[a-z]+)?)\b/) ??
    normalized.match(/\b([a-z]+(?:-[a-z]+)?)\s+(?:movies?|films?|shows?|series|options|results|recommendations|picks)\b/);
  if (wordMatch) return clampResultLimit(parseNumber(wordMatch[1]));
  return undefined;
}

function extractWatchContext(normalized: string): WatchContext | undefined {
  if (/\b(with someone|together|for us|we|us|our|group|date night|family night)\b/.test(normalized)) return "group";
  if (/\b(for me|solo|by myself|just me)\b/.test(normalized)) return "solo";
  return undefined;
}

function parseNumber(value: string | undefined) {
  if (!value) return undefined;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  return numberWords[value];
}

function clampResultLimit(value: number | undefined) {
  if (!value || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(50, Math.round(value)));
}

function normalizeText(value: string) {
  return value
    .toLowerCase()
    .replace(/\bfeel good\b/g, "feel-good")
    .replace(/\bscience fiction\b/g, "science-fiction")
    .replace(/\brom com\b/g, "rom-com")
    .replace(/\btwo hours?\b/g, "2 hours")
    .replace(/\btwenty five\b/g, "twenty-five");
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

function formatDate(value?: string) {
  if (!value) return "not synced";
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
