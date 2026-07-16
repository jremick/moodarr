import {
  ArrowClockwise,
  BookmarkSimple,
  ChatCircleDots,
  ClockCounterClockwise,
  CopySimple,
  Database,
  GearSix,
  Info,
  List,
  ListChecks,
  Microphone,
  PaperPlaneTilt,
  Sparkle,
  SpinnerGap,
  ThumbsUp,
  Trash,
  User,
  Users,
  WarningCircle
} from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState, type CSSProperties, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from "react";
import { ResultCard } from "./ResultCard";
import { finderAvailabilityLabels, summarizeAvailability, type FinderAvailabilityGroup } from "../../availability";
import { maxSearchQueryLength, maxSearchResultLimit } from "../../chatCriteria";
import { applyRuntimeRange, clearRuntimeRange, describeRuntimeRange } from "../../../shared/runtime";
import { defaultSearchResultLimit } from "../../../shared/types";
import type { ItemSummary, MediaType, RequestPreview, SearchFilters, WatchContext } from "../../../shared/types";
import {
  availabilityFromScope,
  availabilityScopeFromFilters,
  displayMatchScore,
  type AvailabilityScope,
  type ChatMessage,
  type DisplayMode,
  type RecommendationFeedback,
  type SavedQuery,
  type SearchProgressState,
  type VoiceState
} from "./finderModel";

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

type FinderRailMode = "collapsed" | "menu" | "queries" | "chat";

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
      <select name="result-view-mode" value={displayMode} onChange={(event) => onDisplayModeChange(event.target.value as DisplayMode)} aria-label="Result view mode" title="Result view mode">
        <option value="compact">Compact</option>
        <option value="comfortable">Comfort</option>
        <option value="list">List</option>
      </select>
    </label>
  );
}

export function FinderView(props: {
  chatDraft: string;
  setChatDraft: (value: string) => void;
  chatMessages: ChatMessage[];
  notice: string;
  voiceState: VoiceState;
  startVoiceTranscription: () => void;
  busy: string;
  searchProgress: SearchProgressState | null;
  grouped: { group: FinderAvailabilityGroup; items: ItemSummary[] }[];
  preview: RequestPreview | null;
  previewPendingItemId: string | null;
  feedbackByItem: Record<string, RecommendationFeedback>;
  preferredExampleByItem: Record<string, boolean>;
  seasonSelections: Record<string, string>;
  setSeasonSelections: Dispatch<SetStateAction<Record<string, string>>>;
  submitChat: (event?: FormEvent, promptOverride?: string) => Promise<void>;
  updateRecommendationFeedback: (item: ItemSummary, feedback: RecommendationFeedback) => void;
  togglePreferredExample: (item: ItemSummary) => void;
  previewRequest: (item: ItemSummary, selectedSeason?: number) => Promise<void>;
  createRequest: () => Promise<void>;
  cancelRequestPreview: () => void;
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
  canRequest: boolean;
  canUseAi: boolean;
  filters: SearchFilters;
  resultLimit: number;
  watchContext: WatchContext;
  showRatedItems: boolean;
  onCriteriaChange: (change: { filters?: SearchFilters; resultLimit?: number; watchContext?: WatchContext; showRatedItems?: boolean }) => void;
  onDisplayModeChange: (mode: DisplayMode) => void;
  brand: ReactNode;
  accountControl: ReactNode;
  adminAccessRequired: boolean;
  aboutOpen: boolean;
  onOpenReview: () => void;
  onOpenSettings: () => void;
  onToggleAbout: () => void;
}) {
  const {
    chatDraft,
    setChatDraft,
    chatMessages,
    notice,
    voiceState,
    startVoiceTranscription,
    busy,
    searchProgress,
    grouped,
    preview,
    previewPendingItemId,
    feedbackByItem,
    preferredExampleByItem,
    seasonSelections,
    setSeasonSelections,
    displayMode,
    hasSearchSession,
    criteriaDirty,
    latestSuccessfulQuery,
    savedQueries
  } = props;
  const chatLogRef = useRef<HTMLDivElement | null>(null);
  const chatPromptRef = useRef<HTMLTextAreaElement | null>(null);
  const [renderedResultLimit, setRenderedResultLimit] = useState(50);
  const [railMode, setRailMode] = useState<FinderRailMode>("collapsed");
  const visibleGroups = grouped.filter(({ items }) => items.length > 0);
  const visibleItems = visibleGroups.flatMap(({ items }) => items);
  const visibleIndexByItemId = new Map(visibleItems.map((item, index) => [item.id, index]));
  const renderedItemIds = new Set(visibleItems.slice(0, renderedResultLimit).map((item) => item.id));
  const renderedGroups = visibleGroups
    .map(({ group, items }) => ({ group, items: items.filter((item) => renderedItemIds.has(item.id)) }))
    .filter(({ items }) => items.length > 0);
  const renderedResultCount = Math.min(renderedResultLimit, visibleItems.length);
  const hasResults = visibleGroups.length > 0;
  const showResultGroups = !busy || previewPendingItemId !== null || busy === "create";
  const hasChatDraft = Boolean(chatDraft.trim());
  const railExpanded = railMode !== "collapsed";
  const queriesExpanded = railMode === "queries";
  const actionMode = recommendationActionMode(hasSearchSession, hasChatDraft, criteriaDirty);
  const recommendationActionLabel =
    actionMode === "send" ? "Send prompt and update recommendations" : actionMode === "update" ? "Update recommendations" : actionMode === "refresh" ? "Refresh recommendations" : "Start recommendations";
  const recommendationActionShortLabel = actionMode === "send" ? "Send" : actionMode === "update" ? "Update" : actionMode === "refresh" ? "Refresh" : "Start";

  useEffect(() => {
    setRenderedResultLimit(50);
  }, [grouped]);

  useEffect(() => {
    const chatLog = chatLogRef.current;
    if (!chatLog) return;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    chatLog.scrollTo({ top: chatLog.scrollHeight, behavior: reducedMotion ? "auto" : "smooth" });
  }, [chatMessages, busy]);

  function toggleRail() {
    if (railExpanded) {
      setRailMode("collapsed");
      return;
    }
    setRailMode("menu");
  }

  function toggleQueries() {
    setRailMode((current) => (current === "queries" ? "menu" : "queries"));
  }

  function openChat() {
    setRailMode("chat");
    window.requestAnimationFrame(() => chatPromptRef.current?.focus({ preventScroll: true }));
  }

  async function runRecommendationAction() {
    if (actionMode === "send") {
      await props.submitChat();
      return;
    }
    if (actionMode === "refresh" || actionMode === "update") {
      await props.rerunWithCurrentCriteria();
      return;
    }
    openChat();
  }

  return (
    <section
      id="finder-view"
      className={["workspace", "finder-workspace", hasResults ? "has-results" : "", railExpanded ? "rail-expanded" : "rail-collapsed"].filter(Boolean).join(" ")}
      tabIndex={-1}
    >
      <section className="finder-panel">
        <CriteriaBar
          filters={props.filters}
          resultLimit={props.resultLimit}
          watchContext={props.watchContext}
          showRatedItems={props.showRatedItems}
          displayMode={displayMode}
          onCriteriaChange={props.onCriteriaChange}
          onDisplayModeChange={props.onDisplayModeChange}
        />
        {!props.canUseAi || notice ? (
          <div className="finder-notices">
            {!props.canUseAi ? (
              <div className="notice capability-notice" role="status">
                <Info size={16} aria-hidden="true" />
                AI ranking is disabled for this account. Moodarr will use local ranking.
              </div>
            ) : null}
            {notice ? (
              <div className="notice finder-notice" role="status" aria-live="polite" aria-atomic="true">
                <WarningCircle size={16} aria-hidden="true" />
                {notice}
              </div>
            ) : null}
          </div>
        ) : null}
        <ResultsStatus
          grouped={grouped}
          renderedCount={renderedResultCount}
          busy={busy}
          hasSearchSession={hasSearchSession}
          onReset={props.resetSearchSession}
        />
        <section className="results">
          {busy === "search" && searchProgress ? <SearchProcessingOverlay progress={searchProgress} /> : null}
          {busy === "search" ? <ResultSkeletons /> : null}
          {!busy && !hasResults ? <SearchEmptyState /> : null}
          {showResultGroups
            ? renderedGroups.map(({ group, items }, groupIndex) => (
                <section
                  className={groupIndex === 0 ? "result-group first-result-group" : "result-group"}
                  key={group}
                  aria-label={groupIndex === 0 ? finderAvailabilityLabels[group] : undefined}
                  aria-labelledby={groupIndex === 0 ? undefined : `result-group-${group}`}
                >
                  {groupIndex > 0 ? (
                    <div className="result-heading">
                      <h2 id={`result-group-${group}`}>{finderAvailabilityLabels[group]}</h2>
                      <span>{grouped.find((entry) => entry.group === group)?.items.length ?? items.length}</span>
                    </div>
                  ) : null}
                  <div className={resultGridClassName(displayMode)}>
                    {items.map((item) => (
                      <ResultCard
                        key={item.id}
                        item={item}
                        index={visibleIndexByItemId.get(item.id) ?? 0}
                        displayScore={displayMatchScore(item, visibleIndexByItemId.get(item.id) ?? 0, visibleItems)}
                        preview={preview}
                        previewPending={previewPendingItemId === item.id}
                        feedback={feedbackByItem[item.id]}
                        preferredExample={Boolean(preferredExampleByItem[item.id])}
                        busy={busy}
                        seasonSelection={seasonSelections[item.id] ?? ""}
                        onSeasonSelection={(value) => setSeasonSelections((current) => ({ ...current, [item.id]: value }))}
                        onFeedback={props.updateRecommendationFeedback}
                        onPreferredExample={props.togglePreferredExample}
                        onPreviewRequest={props.previewRequest}
                        onCreateRequest={props.createRequest}
                        onCancelRequestPreview={props.cancelRequestPreview}
                        canRequest={props.canRequest}
                      />
                    ))}
                  </div>
                </section>
              ))
            : null}
          {!busy && renderedResultCount < visibleItems.length ? (
            <button type="button" className="load-more-results" onClick={() => setRenderedResultLimit((current) => Math.min(visibleItems.length, current + 50))}>
              Show 50 more results · {renderedResultCount} of {visibleItems.length} loaded
            </button>
          ) : null}
        </section>
      </section>

      <aside className={railExpanded ? "conversation-rail rail-expanded" : "conversation-rail rail-collapsed"} aria-label="Moodarr finder controls">
        <header className="finder-rail-header">
          <div className="finder-rail-brand">{props.brand}</div>
          <button
            id="credits-button"
            type="button"
            className={props.aboutOpen ? "rail-about-button active" : "rail-about-button"}
            onClick={props.onToggleAbout}
            aria-label={props.aboutOpen ? "Close About and credits" : "Open About and credits"}
            aria-expanded={props.aboutOpen}
            aria-controls="credits-panel"
            title="About & credits"
          >
            <Info size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="finder-rail-actions" role="group" aria-label="Finder tools">
          <button
            type="button"
            className={railMode === "menu" ? "rail-command active" : "rail-command"}
            onClick={toggleRail}
            aria-expanded={railExpanded}
            aria-controls="finder-rail-content"
            aria-label={railExpanded ? "Collapse finder column" : "Expand finder column"}
            title={railExpanded ? "Collapse" : "Menu"}
          >
            <List size={20} aria-hidden="true" />
            <span>{railExpanded ? "Collapse" : "Menu"}</span>
          </button>
          <button
            type="button"
            className={railMode === "queries" ? "rail-command active" : "rail-command"}
            onClick={toggleQueries}
            aria-expanded={railExpanded && queriesExpanded}
            aria-controls="finder-query-history"
            aria-label="Show queries"
            title="Queries"
          >
            <ClockCounterClockwise size={20} aria-hidden="true" />
            <span>Queries</span>
          </button>
          <button
            type="button"
            className={railMode === "chat" ? "rail-command active" : "rail-command"}
            onClick={openChat}
            aria-expanded={railMode === "chat"}
            aria-controls="finder-chat-panel"
            aria-label="Open Finder chat"
            title="Chat"
          >
            <ChatCircleDots size={20} aria-hidden="true" />
            <span>Chat</span>
          </button>
          <button
            id="finder-recommendation-action"
            type="button"
            className={`rail-command recommendation-command ${criteriaDirty || hasChatDraft ? "pending" : ""}`.trim()}
            onClick={() => void runRecommendationAction()}
            disabled={Boolean(busy)}
            aria-label={recommendationActionLabel}
            title={recommendationActionShortLabel}
          >
            {busy === "search" ? (
              <SpinnerGap size={20} className="spin" aria-hidden="true" />
            ) : actionMode === "refresh" || actionMode === "update" ? (
              <ArrowClockwise size={20} aria-hidden="true" />
            ) : (
              <PaperPlaneTilt size={20} aria-hidden="true" />
            )}
            <span>{recommendationActionShortLabel}</span>
          </button>
        </div>

        <div id="finder-rail-content" className="finder-rail-content" hidden={!railExpanded}>
          <SavedQueriesPanel
            expanded={queriesExpanded}
            latestSuccessfulQuery={latestSuccessfulQuery}
            savedQueries={savedQueries}
            busy={busy}
            onCopyLatest={props.copyLatestSuccessfulQuery}
            onSaveLatest={props.saveLatestSuccessfulQuery}
            onRunSaved={props.runSavedQuery}
            onDeleteSaved={props.deleteSavedQuery}
          />
          <form
            id="finder-chat-panel"
            className="chat-panel"
            onSubmit={(event) => {
              event.preventDefault();
              void runRecommendationAction();
            }}
          >
            <div className="chat-log" role="log" aria-live="polite" aria-relevant="additions text" aria-label="Conversation history" ref={chatLogRef}>
              {chatMessages.map((message) => (
                <div className={`chat-message ${message.role}`} key={message.id}>
                  <span>{message.text}</span>
                  {message.refinementOptions?.length ? (
                    <div className="refinement-options" aria-label="Follow-up refinement options">
                      {message.refinementOptions.map((option) => (
                        <button key={`${message.id}-${option.label}`} type="button" onClick={() => void props.submitChat(undefined, option.prompt)} disabled={Boolean(busy)}>
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
                ref={chatPromptRef}
                id="finder-chat-prompt"
                name="moodarr-query"
                autoComplete="off"
                value={chatDraft}
                rows={4}
                maxLength={maxSearchQueryLength}
                onChange={(event) => setChatDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !busy && actionMode !== "open-chat") {
                    event.preventDefault();
                    void runRecommendationAction();
                  }
                }}
                aria-label="Finder chat prompt"
                placeholder="Ask for a mood, runtime, availability, count, or a follow-up refinement…"
              />
              <div className="composer-actions">
                <button
                  type="button"
                  className={voiceState === "listening" ? "voice-button listening" : "voice-button"}
                  onClick={startVoiceTranscription}
                  disabled={voiceState === "unsupported"}
                  aria-label={voiceState === "listening" ? "Stop voice transcription" : "Start voice transcription"}
                >
                  <Microphone size={16} aria-hidden="true" />
                </button>
                <button type="submit" disabled={Boolean(busy) || actionMode === "open-chat"} aria-label={recommendationActionLabel} title={recommendationActionShortLabel}>
                  {busy === "search" ? (
                    <SpinnerGap size={16} className="spin" aria-hidden="true" />
                  ) : actionMode === "refresh" || actionMode === "update" ? (
                    <ArrowClockwise size={16} aria-hidden="true" />
                  ) : (
                    <PaperPlaneTilt size={16} aria-hidden="true" />
                  )}
                </button>
              </div>
            </div>
          </form>
        </div>

        <footer className="finder-rail-footer">
          <nav className="finder-rail-destinations" aria-label="Administration">
            <button
              type="button"
              className="rail-destination"
              onClick={props.onOpenReview}
              disabled={Boolean(busy)}
              aria-label={props.adminAccessRequired ? "Open review queue and unlock admin access" : "Open review queue"}
              title={props.adminAccessRequired ? "Review queue · admin access required" : "Review queue"}
            >
              <ListChecks size={19} aria-hidden="true" />
              <span>Review</span>
            </button>
            <button
              type="button"
              className="rail-destination"
              onClick={props.onOpenSettings}
              disabled={Boolean(busy)}
              aria-label={props.adminAccessRequired ? "Open settings and unlock admin access" : "Open settings"}
              title={props.adminAccessRequired ? "Settings · admin access required" : "Settings"}
            >
              <GearSix size={19} aria-hidden="true" />
              <span>Settings</span>
            </button>
          </nav>
          <div className="finder-rail-account">{props.accountControl}</div>
        </footer>
      </aside>
    </section>
  );
}

function SavedQueriesPanel({
  expanded,
  latestSuccessfulQuery,
  savedQueries,
  busy,
  onCopyLatest,
  onSaveLatest,
  onRunSaved,
  onDeleteSaved
}: {
  expanded: boolean;
  latestSuccessfulQuery: string;
  savedQueries: SavedQuery[];
  busy: string;
  onCopyLatest: () => Promise<void>;
  onSaveLatest: () => void;
  onRunSaved: (query: string) => Promise<void>;
  onDeleteSaved: (id: string) => void;
}) {
  const hasLatest = Boolean(latestSuccessfulQuery.trim());

  return (
    <section id="finder-query-history" className="saved-queries" aria-label="Queries" hidden={!expanded}>
      <div className="saved-queries-header">
        <strong>Queries</strong>
        <div className="saved-query-actions">
          <button type="button" onClick={() => void onCopyLatest()} disabled={!hasLatest} aria-label="Copy latest successful query" title="Copy latest">
            <CopySimple size={15} aria-hidden="true" />
          </button>
          <button type="button" onClick={onSaveLatest} disabled={!hasLatest} aria-label="Save latest successful query" title="Save latest">
            <BookmarkSimple size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
      {hasLatest ? <p className="latest-query">{latestSuccessfulQuery}</p> : null}
      {!hasLatest && savedQueries.length === 0 ? <p className="empty-query-history">Saved queries will appear here.</p> : null}
      {savedQueries.length ? (
        <div className="saved-query-list">
          {savedQueries.map((entry) => (
            <div className="saved-query-row" key={entry.id}>
              <button type="button" className="saved-query-run" onClick={() => void onRunSaved(entry.query)} disabled={Boolean(busy)} title={entry.query}>
                {entry.query}
              </button>
              <button type="button" className="saved-query-delete" onClick={() => onDeleteSaved(entry.id)} aria-label="Delete saved query" title="Delete">
                <Trash size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function CriteriaBar({
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
          {watchContext === "solo" ? <User size={14} aria-hidden="true" /> : <Users size={14} aria-hidden="true" />}
          {watchContext === "solo" ? "For Me" : "Together"}
        </button>
        <label className="result-limit-field">
          <span className="sr-only">Results</span>
          <input
            name="result-limit"
            type="number"
            inputMode="numeric"
            autoComplete="off"
            min="1"
            max={maxSearchResultLimit}
            value={resultLimit}
            onChange={(event) => onCriteriaChange({ resultLimit: Math.max(1, Math.min(maxSearchResultLimit, Number(event.target.value) || defaultSearchResultLimit)) })}
          />
        </label>
        <FilterSelect
          label="Type"
          name="media-type"
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
          name="runtime"
          value={runtimeFilterValue(filters)}
          onChange={(value) => {
            if (value === "custom") return;
            onCriteriaChange({ filters: value ? applyRuntimeRange(filters, { maxRuntimeMinutes: Number(value) }) : clearRuntimeRange(filters) });
          }}
          options={runtimeFilterOptions(filters)}
        />
        <FilterSelect
          label="Genre"
          name="genre"
          value={filters.genres?.[0] ?? ""}
          onChange={(value) => onCriteriaChange({ filters: { ...filters, genres: value ? [value] : [] } })}
          options={genreOptions}
        />
        <FilterSelect
          label="Availability"
          name="availability"
          help="Verified Requestable shows Seerr-checked request options. Unchecked catalog request attempts appear only after an explicit request prompt or selecting Verified + Unchecked."
          value={availabilityScopeFromFilters(filters)}
          onChange={(value) => onCriteriaChange({ filters: { ...filters, availability: availabilityFromScope(value as AvailabilityScope) } })}
          options={[
            ["plex", "Plex Only"],
            ["plex-seerr", "Plex + Seerr"],
            ["verified-requestable", "Verified Requestable"],
            ["request-attempts", "Verified + Unchecked"]
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
          <ThumbsUp size={16} aria-hidden="true" />
        </button>
        <DisplayModeSelect displayMode={displayMode} onDisplayModeChange={onDisplayModeChange} />
      </div>
      <p className="criteria-scope-help">
        Plex + Seerr shows known availability. Verified Requestable narrows to Seerr-checked options. Verified + Unchecked explicitly adds catalog matches that Seerr has not checked.
      </p>
    </section>
  );
}

function resultGridClassName(displayMode: DisplayMode) {
  if (displayMode === "list") return "card-grid list-layout";
  if (displayMode === "compact") return "card-grid compact-layout";
  return "card-grid";
}

export function recommendationActionMode(hasSearchSession: boolean, hasChatDraft: boolean, criteriaDirty: boolean): "open-chat" | "send" | "update" | "refresh" {
  if (hasChatDraft) return "send";
  if (hasSearchSession) return criteriaDirty ? "update" : "refresh";
  return "open-chat";
}

function ResultsStatus({
  grouped,
  renderedCount,
  busy,
  hasSearchSession,
  onReset
}: {
  grouped: { group: FinderAvailabilityGroup; items: ItemSummary[] }[];
  renderedCount: number;
  busy: string;
  hasSearchSession: boolean;
  onReset: () => void;
}) {
  const counts = grouped.map(({ group, items }) => ({ group, count: items.length })).filter(({ count }) => count > 0);
  const summary = summarizeAvailability(counts, renderedCount);
  const heading = busy === "search" ? "Finding matches" : summary.heading;
  const detail = busy === "search" ? (summary.total > 0 ? `Ranking a new slate · ${summary.detail}` : "Ranking local catalog and Plex candidates") : summary.detail;
  return (
    <div className="results-status">
      <div className="results-status-copy" role="status" aria-live="polite" aria-atomic="true">
        <h2 id="finder-results-heading">{heading}</h2>
        <span>{detail}</span>
      </div>
      {hasSearchSession ? (
        <button type="button" onClick={onReset} disabled={Boolean(busy)}>
          Reset
        </button>
      ) : null}
    </div>
  );
}

function FilterSelect({
  label,
  name,
  help,
  value,
  onChange,
  options
}: {
  label: string;
  name: string;
  help?: string;
  value: string;
  onChange: (value: string) => void;
  options: [string, string][];
}) {
  const selectId = useId();
  const helpId = useId();
  return (
    <div className="criteria-filter-field">
      <label className="sr-only" htmlFor={selectId}>{label}</label>
      <select
        id={selectId}
        name={name}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={help ? helpId : undefined}
      >
        {options.map(([optionValue, optionLabel]) => (
          <option key={optionValue} value={optionValue}>
            {optionLabel}
          </option>
        ))}
      </select>
      {help ? <span id={helpId} className="sr-only">{help}</span> : null}
    </div>
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

function SearchEmptyState() {
  return (
    <section className="empty-results">
      <Sparkle size={26} aria-hidden="true" />
      <h2>Describe what you're in the mood for watching</h2>
      <p>Keep chatting with Moodarr to find better options closer to your mood, style, or feel.</p>
    </section>
  );
}

function SearchProcessingOverlay({ progress }: { progress: SearchProgressState }) {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const updateElapsed = () => setElapsedMs(Math.max(0, Date.now() - progress.startedAt));
    updateElapsed();
    const interval = window.setInterval(updateElapsed, 180);
    return () => window.clearInterval(interval);
  }, [progress.id, progress.startedAt]);

  const snapshot = searchProgressSnapshot(progress, elapsedMs);
  const catalogProgress =
    progress.catalogTotal > 0 ? `${formatProgressCount(snapshot.catalogIndex)} / ${formatProgressCount(progress.catalogTotal)} catalog records` : "Catalog index active";
  const resultTarget = progress.requestedLimit > progress.resultLimit ? `${formatProgressCount(progress.resultLimit)} shown, ${formatProgressCount(progress.requestedLimit)} checked` : `Top ${formatProgressCount(progress.resultLimit)} slate`;
  const announcement = searchProgressAnnouncement(snapshot.stage);

  return (
    <>
      <section className="search-processing-overlay" aria-hidden="true">
        <div className="search-processing-header">
          <div>
            <span className="search-processing-kicker">Search processing</span>
            <h2>{snapshot.stage}</h2>
          </div>
          <strong>{snapshot.percent}%</strong>
        </div>
        <div className="search-progress-track">
          <span style={{ "--search-progress": `${snapshot.percent}%` } as CSSProperties} />
        </div>
        <div className="search-progress-metrics">
          <span>
            <Database size={14} aria-hidden="true" />
            {catalogProgress}
          </span>
          <span>
            <ListChecks size={14} aria-hidden="true" />
            {resultTarget}
          </span>
        </div>
        <p>
          {progress.kind === "refinement"
            ? "Rechecking the catalog against your latest feedback and filters."
            : "Building a ranked slate from the local catalog, Plex, and mood signals."}
        </p>
      </section>
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </>
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

function searchProgressSnapshot(progress: SearchProgressState, elapsedMs: number) {
  const phases = [
    { stage: "Scanning catalog index", durationMs: 4200, start: 7, end: 58 },
    { stage: "Applying mood and filters", durationMs: 2600, start: 58, end: 73 },
    { stage: "Ranking recommendation slate", durationMs: 4800, start: 73, end: 91 },
    { stage: "Preparing result cards", durationMs: 5200, start: 91, end: 97 }
  ];
  let remainingMs = elapsedMs;
  let stage = phases[phases.length - 1].stage;
  let percent = 97;

  for (const phase of phases) {
    if (remainingMs <= phase.durationMs) {
      stage = phase.stage;
      percent = phase.start + (phase.end - phase.start) * easeOutCubic(remainingMs / phase.durationMs);
      break;
    }
    remainingMs -= phase.durationMs;
  }

  const roundedPercent = Math.max(1, Math.min(97, Math.round(percent)));
  const scanRatio = Math.min(0.99, Math.max(0.01, roundedPercent / 74));
  const catalogIndex = progress.catalogTotal > 0 ? Math.min(progress.catalogTotal, Math.max(1, Math.round(progress.catalogTotal * scanRatio))) : 0;
  return { stage, percent: roundedPercent, catalogIndex };
}

function searchProgressAnnouncement(stage: string) {
  return `Search processing. ${stage}.`;
}

function easeOutCubic(value: number) {
  const clamped = Math.max(0, Math.min(1, value));
  return 1 - (1 - clamped) ** 3;
}

function formatProgressCount(value: number) {
  return Math.round(value).toLocaleString();
}

export const __finderViewTestInternals = {
  searchProgressAnnouncement,
  searchProgressSnapshot
};
