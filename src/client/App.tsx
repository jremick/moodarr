import {
  CheckCircle,
  Database,
  DownloadSimple,
  FilmSlate,
  FloppyDisk,
  GearSix,
  HardDrives,
  Key,
  MagnifyingGlass,
  Play,
  Plus,
  Sparkle,
  SpinnerGap,
  Stack,
  ShieldCheck,
  Television,
  User,
  Users,
  WarningCircle
} from "@phosphor-icons/react";
import { type CSSProperties, useEffect, useMemo, useState } from "react";
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

const samplePrompts = [
  "funny fantasy movie under two hours",
  "something like Stardust",
  "feel-good comedy for tonight",
  "short TV series we can start",
  "movie like The Do-Over but better"
];

type ActiveView = "finder" | "admin";

export function App() {
  const [activeView, setActiveView] = useState<ActiveView>("finder");
  const [status, setStatus] = useState<ConfigStatusResponse | null>(null);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [adminToken, setAdminTokenState] = useState(getAdminToken());
  const [query, setQuery] = useState(samplePrompts[0]);
  const [filters, setFilters] = useState<SearchFilters>({});
  const [resultLimit, setResultLimit] = useState(20);
  const [watchContext, setWatchContext] = useState<WatchContext>("solo");
  const [results, setResults] = useState<ItemSummary[]>([]);
  const [preview, setPreview] = useState<RequestPreview | null>(null);
  const [seasonSelections, setSeasonSelections] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<string>("");
  const [busy, setBusy] = useState<string>("");
  const [adminDraft, setAdminDraft] = useState<AdminSettingsUpdate>({});

  useEffect(() => {
    void refreshStatus();
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

  async function submitSearch(event?: React.FormEvent) {
    event?.preventDefault();
    setBusy("search");
    setNotice("");
    setPreview(null);
    try {
      const response = await feelerrApi.search({ query, watchContext, resultLimit, filters });
      setResults(response.results);
      await refreshStatus();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy("");
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
        <div className="topbar-actions">
          <button className={activeView === "finder" ? "tab-button active" : "tab-button"} onClick={() => setActiveView("finder")}>
            <MagnifyingGlass size={16} />
            Finder
          </button>
          <button
            className={activeView === "admin" ? "tab-button active" : "tab-button"}
            onClick={() => {
              setActiveView("admin");
              void runAction("admin-refresh", refreshAdmin, () => "Admin state refreshed.");
            }}
          >
            <GearSix size={16} />
            Admin
          </button>
        </div>
      </section>

      {notice ? (
        <div className="notice global-notice">
          <WarningCircle size={16} />
          {notice}
        </div>
      ) : null}

      {activeView === "finder" ? (
        <FinderView
          query={query}
          setQuery={setQuery}
          filters={filters}
          setFilters={setFilters}
          resultLimit={resultLimit}
          setResultLimit={setResultLimit}
          watchContext={watchContext}
          setWatchContext={setWatchContext}
          busy={busy}
          grouped={grouped}
          preview={preview}
          seasonSelections={seasonSelections}
          setSeasonSelections={setSeasonSelections}
          submitSearch={submitSearch}
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
  query: string;
  setQuery: (query: string) => void;
  filters: SearchFilters;
  setFilters: React.Dispatch<React.SetStateAction<SearchFilters>>;
  resultLimit: number;
  setResultLimit: (value: number) => void;
  watchContext: WatchContext;
  setWatchContext: (value: WatchContext) => void;
  busy: string;
  grouped: { group: AvailabilityGroup; items: ItemSummary[] }[];
  preview: RequestPreview | null;
  seasonSelections: Record<string, string>;
  setSeasonSelections: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  submitSearch: (event?: React.FormEvent) => Promise<void>;
  previewRequest: (item: ItemSummary, selectedSeason?: number) => Promise<void>;
  createRequest: () => Promise<void>;
}) {
  const { query, setQuery, filters, setFilters, resultLimit, setResultLimit, watchContext, setWatchContext, busy, grouped, preview, seasonSelections, setSeasonSelections } = props;
  const visibleGroups = grouped.filter(({ items }) => items.length > 0);
  const hasResults = visibleGroups.length > 0;
  return (
    <section className="workspace finder-workspace">
      <section className="finder-panel">
        <form className="search-panel" onSubmit={(event) => void props.submitSearch(event)}>
          <div className="prompt-row">
            <label className="prompt-field">
              <span className="label-row">
                <span>Ask Feelerr</span>
                <span>Ranked for this prompt</span>
              </span>
              <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search prompt" />
            </label>
            <button type="submit" disabled={busy === "search"}>
              {busy === "search" ? <SpinnerGap size={16} className="spin" /> : <Sparkle size={16} />}
              Search
            </button>
          </div>
          <div className="watch-context-row" aria-label="Recommendation context">
            <button type="button" className={watchContext === "solo" ? "active" : ""} onClick={() => setWatchContext("solo")}>
              <User size={15} />
              For me
            </button>
            <button type="button" className={watchContext === "group" ? "active" : ""} onClick={() => setWatchContext("group")}>
              <Users size={15} />
              With someone
            </button>
          </div>
          <div className="sample-row">
            {samplePrompts.map((prompt) => (
              <button type="button" key={prompt} onClick={() => setQuery(prompt)}>
                {prompt}
              </button>
            ))}
          </div>
        </form>

        <section className="results">
          {busy === "search" ? <ResultSkeletons /> : null}
          {!busy && !hasResults ? <SearchEmptyState /> : null}
          {!busy
            ? visibleGroups.map(({ group, items }) => (
                <section className="result-group" key={group}>
                  <div className="result-heading">
                    <h2>{groupLabels[group]}</h2>
                    <span>{items.length}</span>
                  </div>
                  <div className="card-grid">
                    {items.map((item, index) => (
                      <ResultCard
                        key={item.id}
                        item={item}
                        index={index}
                        preview={preview}
                        busy={busy}
                        seasonSelection={seasonSelections[item.id] ?? ""}
                        onSeasonSelection={(value) => setSeasonSelections((current) => ({ ...current, [item.id]: value }))}
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

      <aside className="filters-panel" aria-label="Search filters">
        <PanelTitle icon={<FilmSlate size={18} />} title="Filters" />
        <div className="filter-stack">
          <SegmentedMedia value={filters.mediaTypes ?? []} onChange={(mediaTypes) => setFilters((current) => ({ ...current, mediaTypes }))} />
          <FilterSelect
            label="Runtime"
            value={String(filters.maxRuntimeMinutes ?? "")}
            onChange={(value) => setFilters((current) => ({ ...current, maxRuntimeMinutes: value ? Number(value) : undefined }))}
            options={[
              ["", "Any"],
              ["90", "90 min"],
              ["120", "2 hours"],
              ["600", "Short series"]
            ]}
          />
          <FilterSelect
            label="Genre"
            value={filters.genres?.[0] ?? ""}
            onChange={(value) => setFilters((current) => ({ ...current, genres: value ? [value] : [] }))}
            options={[
              ["", "Any"],
              ["Comedy", "Comedy"],
              ["Fantasy", "Fantasy"],
              ["Adventure", "Adventure"],
              ["Family", "Family"]
            ]}
          />
          <FilterSelect
            label="Availability"
            value={filters.availability?.[0] ?? ""}
            onChange={(value) => setFilters((current) => ({ ...current, availability: value ? [value as AvailabilityGroup] : [] }))}
            options={[["", "Any"], ...groupOrder.map((group): [string, string] => [group, groupLabels[group]])]}
          />
          <label className="result-limit-field">
            Results
            <input
              type="number"
              min="1"
              max="50"
              value={resultLimit}
              onChange={(event) => setResultLimit(Math.max(1, Math.min(50, Number(event.target.value) || 20)))}
            />
          </label>
        </div>
      </aside>
    </section>
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

function SegmentedMedia({ value, onChange }: { value: MediaType[]; onChange: (value: MediaType[]) => void }) {
  function toggle(type: MediaType) {
    onChange(value.includes(type) ? value.filter((entry) => entry !== type) : [...value, type]);
  }
  return (
    <div className="segmented" aria-label="Media type filter">
      <button type="button" className={value.includes("movie") ? "active" : ""} onClick={() => toggle("movie")}>
        <FilmSlate size={15} />
        Movies
      </button>
      <button type="button" className={value.includes("tv") ? "active" : ""} onClick={() => toggle("tv")}>
        <Television size={15} />
        TV
      </button>
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }: { label: string; value: string; onChange: (value: string) => void; options: [string, string][] }) {
  return (
    <label>
      {label}
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
      <div className="result-heading">
        <h2>Finding matches</h2>
        <span>sync</span>
      </div>
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
  busy,
  seasonSelection,
  onSeasonSelection,
  onPreviewRequest,
  onCreateRequest
}: {
  item: ItemSummary;
  index: number;
  preview: RequestPreview | null;
  busy: string;
  seasonSelection: string;
  onSeasonSelection: (value: string) => void;
  onPreviewRequest: (item: ItemSummary, selectedSeason?: number) => Promise<void>;
  onCreateRequest: () => Promise<void>;
}) {
  const isPreviewForItem = preview?.item.id === item.id;
  const needsSeason = !item.plex?.available && Boolean(item.seerr?.requestable) && item.mediaType === "tv";
  const selectedSeason = Number(seasonSelection);
  const canPreviewRequest = !needsSeason || (Number.isInteger(selectedSeason) && selectedSeason > 0);
  return (
    <article className={`result-card ${item.availabilityGroup}`} style={{ "--index": index } as CSSProperties}>
      <div className="poster-frame">
        <img src={item.posterUrl} alt={`${item.title} poster`} />
        <a className="trailer-overlay" href={trailerUrl(item)} target="_blank" rel="noreferrer" aria-label={`Find trailer for ${item.title}`}>
          <Play size={14} />
          Trailer
        </a>
      </div>
      <div className="result-copy">
        <div className="card-title">
          <strong>{item.title}</strong>
          <span>{item.year}</span>
        </div>
        <p className="reason"><span>Why</span> {item.matchExplanation}</p>
        <p className="description"><span>About</span> {item.summary ?? "No description is cached for this item yet."}</p>
        <div className="mini-meta">
          <span className={item.availabilityGroup === "available_in_plex" ? "source-pill plex" : "source-pill seerr"}>{shortAvailability(item.availabilityGroup)}</span>
          <span>{item.mediaType}</span>
          <span>{item.runtimeMinutes ? `${item.runtimeMinutes} min` : "runtime unknown"}</span>
          <span>{Math.round(item.score)}</span>
        </div>
        <div className="card-actions">
          {item.plex?.available && item.plex.url ? (
            <a className="primary-link" href={item.plex.url} target="_blank" rel="noreferrer">
              <Play size={15} />
              Plex
            </a>
          ) : null}
          {!item.plex?.available && item.seerr?.url ? (
            <a className="secondary-link" href={item.seerr.url} target="_blank" rel="noreferrer">
              Open Seerr
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

function trailerUrl(item: ItemSummary) {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(`${item.title} ${item.year ?? ""} trailer`)}`;
}

function shortAvailability(group: AvailabilityGroup) {
  if (group === "available_in_plex") return "Plex available";
  if (group === "not_in_plex_requestable") return "Requestable";
  if (group === "already_requested") return "Already requested";
  if (group === "partially_available") return "Partial";
  return "Unavailable";
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
