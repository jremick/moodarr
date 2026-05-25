import { Check, CircleAlert, Clock3, Database, Film, Heart, Library, Loader2, Play, Plus, Search, Server, Sparkles, Tv } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { feelerrApi } from "./api";
import type { AvailabilityGroup, ConfigStatusResponse, ItemDetail, ItemSummary, LibraryStats, MediaType, RequestPreview, SearchFilters } from "../shared/types";

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

export function App() {
  const [status, setStatus] = useState<ConfigStatusResponse | null>(null);
  const [stats, setStats] = useState<LibraryStats | null>(null);
  const [query, setQuery] = useState(samplePrompts[0]);
  const [filters, setFilters] = useState<SearchFilters>({});
  const [useAi, setUseAi] = useState(false);
  const [results, setResults] = useState<ItemSummary[]>([]);
  const [selected, setSelected] = useState<ItemDetail | null>(null);
  const [preview, setPreview] = useState<RequestPreview | null>(null);
  const [notice, setNotice] = useState<string>("");
  const [busy, setBusy] = useState<string>("");

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
    setUseAi(configStatus.ai.configured);
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
    const response = await runAction(
      "search",
      () =>
        feelerrApi.search({
          query,
          useAi,
          filters
        }),
      (result) => `${result.results.length} ranked result${result.results.length === 1 ? "" : "s"}${result.usedAi ? " with AI reranking" : ""}.`
    );
    if (response) setResults(response.results);
  }

  async function openDetail(item: ItemSummary) {
    setPreview(null);
    const detail = await feelerrApi.item(item.id);
    setSelected(detail);
  }

  async function previewRequest(item: ItemDetail) {
    const seasons = item.mediaType === "tv" ? [1] : undefined;
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

  return (
    <main className="app-shell">
      <section className="topbar">
        <div>
          <h1>Feelerr</h1>
          <p>Plex + Seerr finder</p>
        </div>
        <div className="topbar-actions">
          <button className="icon-button" onClick={() => void refreshStatus()} aria-label="Refresh status">
            <Server size={18} />
          </button>
        </div>
      </section>

      <section className="workspace">
        <aside className="setup-panel">
          <PanelTitle icon={<Database size={18} />} title="Config" />
          <StatusRow label="Plex" ready={Boolean(status?.plex.configured || status?.fixtureMode)} detail={status?.fixtureMode ? "Fixture" : status?.plex.configured ? "Configured" : "Missing env"} />
          <StatusRow label="Seerr" ready={Boolean(status?.seerr.configured || status?.fixtureMode)} detail={status?.fixtureMode ? "Fixture" : status?.seerr.configured ? "Configured" : "Missing env"} />
          <StatusRow label="AI" ready={Boolean(status?.ai.configured)} detail={status?.ai.configured ? status.ai.provider : "Deterministic"} />
          <div className="metric-grid">
            <Metric label="Items" value={stats?.totalItems ?? 0} />
            <Metric label="Plex" value={stats?.availableInPlex ?? 0} />
            <Metric label="Requestable" value={stats?.requestable ?? 0} />
            <Metric label="Partial" value={stats?.partiallyAvailable ?? 0} />
          </div>
          <div className="button-stack">
            <button onClick={() => void runAction("plex-test", feelerrApi.testPlex, (result) => result.message)} disabled={Boolean(busy)}>
              {busy === "plex-test" ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
              Test Plex
            </button>
            <button onClick={() => void runAction("seerr-test", feelerrApi.testSeerr, (result) => result.message)} disabled={Boolean(busy)}>
              {busy === "seerr-test" ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
              Test Seerr
            </button>
            <button onClick={() => void runAction("plex-sync", feelerrApi.syncLibrary, (result) => `Synced ${result.itemCount} Plex item${result.itemCount === 1 ? "" : "s"}.`)} disabled={Boolean(busy)}>
              {busy === "plex-sync" ? <Loader2 size={16} className="spin" /> : <Library size={16} />}
              Sync Plex
            </button>
            <button onClick={() => void runAction("seerr-sync", feelerrApi.syncSeerr, (result) => `Synced ${result.itemCount} Seerr item${result.itemCount === 1 ? "" : "s"}.`)} disabled={Boolean(busy)}>
              {busy === "seerr-sync" ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
              Sync Seerr
            </button>
          </div>
          <div className="sync-times">
            <span>Library {formatDate(stats?.lastLibrarySync)}</span>
            <span>Seerr {formatDate(stats?.lastSeerrSync)}</span>
          </div>
        </aside>

        <section className="finder-panel">
          <form className="search-panel" onSubmit={(event) => void submitSearch(event)}>
            <div className="prompt-row">
              <Search size={20} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search prompt" />
              <button type="submit" disabled={busy === "search"}>
                {busy === "search" ? <Loader2 size={16} className="spin" /> : <Sparkles size={16} />}
                Search
              </button>
            </div>
            <div className="sample-row">
              {samplePrompts.map((prompt) => (
                <button type="button" key={prompt} onClick={() => setQuery(prompt)}>
                  {prompt}
                </button>
              ))}
            </div>
            <div className="filters-row">
              <SegmentedMedia value={filters.mediaTypes ?? []} onChange={(mediaTypes) => setFilters((current) => ({ ...current, mediaTypes }))} />
              <label>
                Runtime
                <select value={filters.maxRuntimeMinutes ?? ""} onChange={(event) => setFilters((current) => ({ ...current, maxRuntimeMinutes: event.target.value ? Number(event.target.value) : undefined }))}>
                  <option value="">Any</option>
                  <option value="90">90 min</option>
                  <option value="120">2 hours</option>
                  <option value="600">Short series</option>
                </select>
              </label>
              <label>
                Genre
                <select value={filters.genres?.[0] ?? ""} onChange={(event) => setFilters((current) => ({ ...current, genres: event.target.value ? [event.target.value] : [] }))}>
                  <option value="">Any</option>
                  <option value="Comedy">Comedy</option>
                  <option value="Fantasy">Fantasy</option>
                  <option value="Adventure">Adventure</option>
                  <option value="Family">Family</option>
                </select>
              </label>
              <label>
                Availability
                <select value={filters.availability?.[0] ?? ""} onChange={(event) => setFilters((current) => ({ ...current, availability: event.target.value ? [event.target.value as AvailabilityGroup] : [] }))}>
                  <option value="">Any</option>
                  {groupOrder.map((group) => (
                    <option key={group} value={group}>
                      {groupLabels[group]}
                    </option>
                  ))}
                </select>
              </label>
              <label className="toggle-row">
                <input type="checkbox" checked={useAi} disabled={!status?.ai.configured} onChange={(event) => setUseAi(event.target.checked)} />
                AI
              </label>
            </div>
          </form>

          {notice ? (
            <div className="notice">
              <CircleAlert size={16} />
              {notice}
            </div>
          ) : null}

          <section className="results">
            {grouped.map(({ group, items }) =>
              items.length ? (
                <section className="result-group" key={group}>
                  <h2>{groupLabels[group]}</h2>
                  <div className="card-grid">
                    {items.map((item) => (
                      <ResultCard key={item.id} item={item} onOpen={() => void openDetail(item)} />
                    ))}
                  </div>
                </section>
              ) : null
            )}
          </section>
        </section>

        <aside className="detail-panel">
          {selected ? (
            <>
              <img src={selected.posterUrl} alt={`${selected.title} poster`} />
              <div className="detail-copy">
                <div className="title-line">
                  <h2>{selected.title}</h2>
                  <span>{selected.year}</span>
                </div>
                <p>{selected.summary}</p>
                <div className="tag-row">
                  {selected.genres.map((genre) => (
                    <span key={genre}>{genre}</span>
                  ))}
                </div>
                <DetailFact icon={<Clock3 size={15} />} label={`${selected.runtimeMinutes ?? "Unknown"} min`} />
                <DetailFact icon={<Heart size={15} />} label={`Critic ${selected.ratings.critic ?? "-"} / Audience ${selected.ratings.audience ?? "-"}`} />
                <p className="explanation">{selected.availabilityExplanation}</p>
                <p className="explanation">{selected.matchExplanation}</p>
                <div className="detail-actions">
                  {selected.plex?.available && selected.plex.url ? (
                    <a className="primary-link" href={selected.plex.url} target="_blank" rel="noreferrer">
                      <Play size={16} />
                      Open in Plex
                    </a>
                  ) : null}
                  {!selected.plex?.available && selected.seerr?.url ? (
                    <a className="secondary-link" href={selected.seerr.url} target="_blank" rel="noreferrer">
                      Open in Seerr
                    </a>
                  ) : null}
                  {!selected.plex?.available && selected.seerr?.requestable ? (
                    <button onClick={() => void previewRequest(selected)} disabled={busy === "preview"}>
                      <Plus size={16} />
                      Request
                    </button>
                  ) : null}
                </div>
                {preview ? (
                  <div className="confirm-box">
                    <strong>{preview.confirmationPhrase}</strong>
                    <span>
                      {preview.request.mediaType} {preview.request.mediaId}
                      {preview.request.seasons?.length ? `, seasons ${preview.request.seasons.join(", ")}` : ""}
                    </span>
                    <button onClick={() => void createRequest()} disabled={busy === "create"}>
                      Confirm request
                    </button>
                  </div>
                ) : null}
              </div>
            </>
          ) : (
            <div className="empty-detail">
              <Film size={30} />
              <span>Select a result</span>
            </div>
          )}
        </aside>
      </section>
    </main>
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
        <Film size={15} />
        Movies
      </button>
      <button type="button" className={value.includes("tv") ? "active" : ""} onClick={() => toggle("tv")}>
        <Tv size={15} />
        TV
      </button>
    </div>
  );
}

function ResultCard({ item, onOpen }: { item: ItemSummary; onOpen: () => void }) {
  return (
    <button className="result-card" onClick={onOpen}>
      <img src={item.posterUrl} alt={`${item.title} poster`} />
      <div>
        <div className="card-title">
          <strong>{item.title}</strong>
          <span>{item.year}</span>
        </div>
        <p>{item.matchExplanation}</p>
        <div className="mini-meta">
          <span>{item.mediaType}</span>
          <span>{item.runtimeMinutes ? `${item.runtimeMinutes} min` : "runtime unknown"}</span>
          <span>{Math.round(item.score)}</span>
        </div>
      </div>
    </button>
  );
}

function DetailFact({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div className="detail-fact">
      {icon}
      <span>{label}</span>
    </div>
  );
}

function formatDate(value?: string) {
  if (!value) return "not synced";
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
