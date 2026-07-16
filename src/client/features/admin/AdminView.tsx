import {
  CheckCircle,
  Database,
  DownloadSimple,
  FloppyDisk,
  GearSix,
  HardDrives,
  LockKey,
  ShieldCheck,
  SignOut,
  Sparkle,
  SpinnerGap,
  Stack,
  Users,
  WarningCircle
} from "@phosphor-icons/react";
import { useEffect, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from "react";
import { moodarrApi } from "../../api";
import type { AdminUserUpdate } from "../../appHooks";
import { RecommendationDiagnosticsPanel } from "./RecommendationDiagnosticsPanel";
import { catalogRecoveryGuidance } from "./catalogRecovery";
import { maxSearchResultLimit } from "../../chatCriteria";
import { defaultSearchResultLimit, openAiReasoningEfforts } from "../../../shared/types";
import type {
  AdminSettings,
  AdminSettingsUpdate,
  AuthSessionResponse,
  AuthUser,
  ConfigStatusResponse,
  EmbeddingWarmupStatus,
  LibraryStats,
  OpenAiReasoningEffort,
  RecommendationDiagnostics,
  SyncRunResult,
  SyncStatus,
} from "../../../shared/types";

const adminSections = [
  { id: "overview", label: "Overview", icon: HardDrives },
  { id: "connections", label: "Connections", icon: GearSix },
  { id: "preferences", label: "Preferences", icon: Stack },
  { id: "access", label: "Access & Users", icon: Users },
  { id: "moodrank", label: "MoodRank", icon: Sparkle }
] as const;

type AdminSection = (typeof adminSections)[number]["id"];

export function AdminView(props: {
  status: ConfigStatusResponse | null;
  stats: LibraryStats | null;
  settings: AdminSettings | null;
  syncStatus: SyncStatus | null;
  recommendationDiagnostics: RecommendationDiagnostics | null;
  authSession: AuthSessionResponse | null;
  adminUsers: AuthUser[];
  updateAdminUser: (user: AuthUser, update: AdminUserUpdate) => Promise<void>;
  adminDraft: AdminSettingsUpdate;
  setAdminDraft: Dispatch<SetStateAction<AdminSettingsUpdate>>;
  adminLoaded: boolean;
  adminLoading: boolean;
  adminDirty: boolean;
  discardAdminChanges: () => void;
  saveAdminSettings: (event: FormEvent) => Promise<void>;
  busy: string;
  runAction: <T>(name: string, action: () => Promise<T>, message: (result: T) => string) => Promise<T | undefined>;
  logout: () => Promise<void>;
  refreshAdmin: () => Promise<void>;
  onLock: () => Promise<void>;
}) {
  const { status, stats, settings, syncStatus, recommendationDiagnostics, authSession, adminUsers, adminDraft, setAdminDraft, busy, adminLoaded, adminLoading, adminDirty } = props;
  const authReady = true;
  const fixtureMode = Boolean(adminDraft.fixtureMode ?? status?.fixtureMode);
  const openAiConfigurable = (settings?.ai.providerPolicy ?? status?.ai.providerPolicy ?? "none") === "configurable";
  const runSync = async () => {
    await props.runAction("admin-sync", moodarrApi.runSync, syncResultMessage);
    await props.refreshAdmin();
  };
  const [activeSection, setActiveSection] = useState<AdminSection>(() => adminSectionFromHash(typeof window === "undefined" ? "" : window.location.hash));

  useEffect(() => {
    const syncSectionFromHash = () => setActiveSection(adminSectionFromHash(window.location.hash));
    window.addEventListener("hashchange", syncSectionFromHash);
    return () => window.removeEventListener("hashchange", syncSectionFromHash);
  }, []);

  return (
    <section id="admin-view" className="admin-redesign-grid" aria-label="Moodarr administration" tabIndex={-1}>
      <AdminSectionNavigation activeSection={activeSection} dirty={adminDirty} onSelect={setActiveSection} />

      <section id="admin-overview-panel" className="admin-section" aria-labelledby="admin-overview-title" hidden={activeSection !== "overview"}>
        <AdminSectionHeader
          id="admin-overview-title"
          title="Overview"
          description="Check service health, sync activity, and the runtime state that needs attention."
        />
        <TrustedRefreshNotice catalog={recommendationDiagnostics?.features.catalog} />
        <div className="admin-overview-grid">
          <HealthPanel status={status} stats={stats} busy={busy} runAction={props.runAction} />
          <RuntimePanel status={status} busy={busy} runAction={props.runAction} refreshAdmin={props.refreshAdmin} />
          <SyncPanel syncStatus={syncStatus} busy={busy} openAiConfigurable={openAiConfigurable} runAction={props.runAction} onSync={runSync} />
        </div>
      </section>

      <form
        id="admin-connections-panel"
        className="admin-section admin-settings-form"
        onSubmit={(event) => void props.saveAdminSettings(event)}
        aria-labelledby="admin-connections-title"
        aria-busy={adminLoading}
        hidden={activeSection !== "connections"}
      >
        <input type="text" name="settings-username" autoComplete="username" value="moodarr-admin" readOnly hidden />
        <AdminSectionHeader
          id="admin-connections-title"
          title="Connections"
          description="Configure the services Moodarr reads from and writes to. Secret values stay on the server."
        />
        <fieldset className="admin-panel admin-settings-body" disabled={!adminLoaded || adminLoading || busy === "admin-save"}>
          <legend className="sr-only">Connection settings</legend>
          <SettingsGroup
            title="Plex"
            description="Library source, artwork origin, and destination for Open Plex actions."
            badge={<span className="legend-badge plex">Source</span>}
          >
            <AdminField id="plex-base-url" label="Base URL" description="Server-side sync and poster fetch origin.">
              <input id="plex-base-url" name="plex-base-url" type="url" inputMode="url" autoComplete="off" spellCheck={false} value={adminDraft.plex?.baseUrl ?? ""} onChange={(event) => setAdminDraft((current) => ({ ...current, plex: { ...current.plex, baseUrl: event.target.value } }))} placeholder="e.g. http://plex:32400…" />
            </AdminField>
            <AdminField id="plex-web-base-url" label="Plex Web URL" description="Used for Open Plex links in Finder.">
              <input id="plex-web-base-url" name="plex-web-base-url" type="url" inputMode="url" autoComplete="off" spellCheck={false} value={adminDraft.plex?.webBaseUrl ?? ""} onChange={(event) => setAdminDraft((current) => ({ ...current, plex: { ...current.plex, webBaseUrl: event.target.value } }))} placeholder="e.g. https://app.plex.tv/desktop…" />
            </AdminField>
            <AdminField id="plex-token" label="Plex token" description={fixtureMode ? "Optional while bundled fixture data is active." : "Leave blank to keep the configured token."}>
              <span className="field-wrap field-with-state">
                <input id="plex-token" name="plex-token" type="password" autoComplete="off" required={!fixtureMode && !settings?.plex.tokenConfigured} onChange={(event) => setAdminDraft((current) => ({ ...current, plex: { ...current.plex, token: event.target.value } }))} placeholder={fixtureMode && !settings?.plex.tokenConfigured ? "Not needed in fixture mode…" : settings?.plex.tokenConfigured ? "Configured…" : "Required…"} />
                <ConfigState
                  configured={Boolean(settings?.plex.tokenConfigured || fixtureMode)}
                  label={fixtureMode && !settings?.plex.tokenConfigured ? "Not needed" : "Configured"}
                />
              </span>
            </AdminField>
            <IntegrationReadiness ready={Boolean(status?.plex.configured || status?.fixtureMode)}>
              {fixtureMode ? "Fixture library data active" : status?.plex.configured ? "Ready for library sync" : "Base URL and token required"}
            </IntegrationReadiness>
          </SettingsGroup>

          <SettingsGroup
            title="Seerr"
            description="Operational availability and confirmed media request creation."
            badge={<span className="legend-badge seerr">Requests</span>}
          >
            <AdminField id="seerr-base-url" label="Base URL" description="Origin for request status and request creation.">
              <input id="seerr-base-url" name="seerr-base-url" type="url" inputMode="url" autoComplete="off" spellCheck={false} value={adminDraft.seerr?.baseUrl ?? ""} onChange={(event) => setAdminDraft((current) => ({ ...current, seerr: { ...current.seerr, baseUrl: event.target.value } }))} placeholder="e.g. http://seerr:5055…" />
            </AdminField>
            <AdminField id="seerr-api-key" label="API key" description={fixtureMode ? "Optional while bundled fixture data is active." : "Leave blank to keep the configured key."}>
              <span className="field-wrap field-with-state">
                <input id="seerr-api-key" name="seerr-api-key" type="password" autoComplete="off" onChange={(event) => setAdminDraft((current) => ({ ...current, seerr: { ...current.seerr, apiKey: event.target.value } }))} placeholder={fixtureMode && !settings?.seerr.apiKeyConfigured ? "Not needed in fixture mode…" : settings?.seerr.apiKeyConfigured ? "Configured…" : "Paste API key…"} />
                <ConfigState
                  configured={Boolean(settings?.seerr.apiKeyConfigured || fixtureMode)}
                  label={fixtureMode && !settings?.seerr.apiKeyConfigured ? "Not needed" : "Configured"}
                />
              </span>
            </AdminField>
            <IntegrationReadiness ready={Boolean(status?.seerr.configured || status?.fixtureMode)}>
              {fixtureMode ? "Fixture request data active" : status?.seerr.configured ? "Request API ready" : "Base URL and API key required"}
            </IntegrationReadiness>
          </SettingsGroup>

          <SettingsGroup
            title="Recommendations"
            description={openAiConfigurable ? "Choose the interpretation provider and the models used by this build." : "This beta build uses local ranking and does not expose the OpenAI network endpoint."}
            badge={<span className="legend-badge ai">{openAiConfigurable && adminDraft.ai?.provider === "openai" ? "OpenAI" : "Local"}</span>}
          >
            {!openAiConfigurable ? (
              settings?.ai.openaiApiKeyConfigured ? (
                <AdminField id="clear-openai-api-key" label="Stored OpenAI key" description="Remove a key left by an earlier or locally configurable build.">
                  <AdminToggle id="clear-openai-api-key" name="clear-openai-api-key" checked={Boolean(adminDraft.ai?.clearOpenaiApiKey)} onChange={(checked) => setAdminDraft((current) => ({ ...current, ai: { ...current.ai, clearOpenaiApiKey: checked } }))} label="Remove on save" />
                </AdminField>
              ) : (
                <p className="admin-settings-empty">No provider credentials are required for local ranking.</p>
              )
            ) : (
              <>
                <AdminField id="ai-provider" label="Provider" description="Use local ranking or optional OpenAI interpretation.">
                  <select id="ai-provider" name="ai-provider" value={adminDraft.ai?.provider ?? "none"} onChange={(event) => setAdminDraft((current) => ({ ...current, ai: { ...current.ai, provider: event.target.value as "none" | "openai" } }))}>
                    <option value="none">Local ranking</option>
                    <option value="openai">OpenAI provider</option>
                  </select>
                </AdminField>
                <AdminField id="openai-model" label="Model" description="Model used to interpret a natural-language brief.">
                  <input id="openai-model" name="openai-model" autoComplete="off" value={adminDraft.ai?.openaiModel ?? ""} onChange={(event) => setAdminDraft((current) => ({ ...current, ai: { ...current.ai, openaiModel: event.target.value } }))} placeholder="e.g. gpt-5.5…" />
                </AdminField>
                <AdminField id="openai-reasoning-effort" label="Reasoning effort" description="Controls provider latency and depth.">
                  <select id="openai-reasoning-effort" name="openai-reasoning-effort" value={adminDraft.ai?.openaiReasoningEffort ?? "low"} onChange={(event) => setAdminDraft((current) => ({ ...current, ai: { ...current.ai, openaiReasoningEffort: event.target.value as OpenAiReasoningEffort } }))}>
                    {openAiReasoningEfforts.map((effort) => <option key={effort} value={effort}>{formatReasoningEffort(effort)}</option>)}
                  </select>
                </AdminField>
                <AdminField id="openai-embedding-model" label="Embedding model" description="Model used for semantic similarity features.">
                  <input id="openai-embedding-model" name="openai-embedding-model" autoComplete="off" value={adminDraft.ai?.openaiEmbeddingModel ?? ""} onChange={(event) => setAdminDraft((current) => ({ ...current, ai: { ...current.ai, openaiEmbeddingModel: event.target.value } }))} placeholder="e.g. text-embedding-3-large…" />
                </AdminField>
                <AdminField id="openai-api-key" label="API key" description="Leave blank to keep the configured key.">
                  <span className="field-wrap field-with-state">
                    <input id="openai-api-key" name="openai-api-key" type="password" autoComplete="off" onChange={(event) => setAdminDraft((current) => ({ ...current, ai: { ...current.ai, openaiApiKey: event.target.value } }))} placeholder={settings?.ai.openaiApiKeyConfigured ? "Configured…" : "Optional…"} />
                    <ConfigState configured={Boolean(settings?.ai.openaiApiKeyConfigured)} unsetLabel="Optional" />
                  </span>
                </AdminField>
              </>
            )}
          </SettingsGroup>
        </fieldset>
        <AdminSaveBar dirty={adminDirty} loading={adminLoading} loaded={adminLoaded} busy={busy} note="Secret fields left blank keep their stored value." onDiscard={props.discardAdminChanges} />
      </form>

      <form
        id="admin-preferences-panel"
        className="admin-section admin-settings-form"
        onSubmit={(event) => void props.saveAdminSettings(event)}
        aria-labelledby="admin-preferences-title"
        aria-busy={adminLoading}
        hidden={activeSection !== "preferences"}
      >
        <AdminSectionHeader id="admin-preferences-title" title="Preferences" description="Set sync behavior, Finder defaults, and review-queue retention without mixing them into connection credentials." />
        <fieldset className="admin-panel admin-settings-body" disabled={!adminLoaded || adminLoading || busy === "admin-save"}>
          <legend className="sr-only">Moodarr preferences</legend>
          <SettingsGroup title="Library & requests" description="Control scheduled refreshes and the data source used by this instance.">
            <AdminField id="sync-interval-minutes" label="Sync interval" description="Minutes between scheduled runs. Enter 0 to disable scheduling.">
              <input id="sync-interval-minutes" name="sync-interval-minutes" type="number" inputMode="numeric" min="0" max="10080" value={adminDraft.sync?.intervalMinutes ?? 0} onChange={(event) => setAdminDraft((current) => ({ ...current, sync: { ...current.sync, intervalMinutes: Number(event.target.value) } }))} />
            </AdminField>
            <AdminField id="sync-seerr" label="Sync Seerr" description="Refresh operational request state on each sync.">
              <AdminToggle id="sync-seerr" name="sync-seerr" checked={adminDraft.sync?.syncSeerr ?? true} onChange={(checked) => setAdminDraft((current) => ({ ...current, sync: { ...current.sync, syncSeerr: checked } }))} />
            </AdminField>
            <AdminField id="fixture-mode" label="Fixture mode" description="Use bundled sample data instead of live Plex and Seerr services.">
              <AdminToggle id="fixture-mode" name="fixture-mode" checked={Boolean(adminDraft.fixtureMode)} onChange={(checked) => setAdminDraft((current) => ({ ...current, fixtureMode: checked }))} />
            </AdminField>
          </SettingsGroup>
          <SettingsGroup title="Finder" description="Choose the initial result volume for a new discovery session.">
            <AdminField id="search-default-result-limit" label="Default results" description={`Choose between 1 and ${maxSearchResultLimit} titles.`}>
              <input id="search-default-result-limit" name="search-default-result-limit" type="number" inputMode="numeric" min="1" max={maxSearchResultLimit} value={adminDraft.search?.defaultResultLimit ?? settings?.search.defaultResultLimit ?? defaultSearchResultLimit} onChange={(event) => setAdminDraft((current) => ({ ...current, search: { ...current.search, defaultResultLimit: Number(event.target.value) } }))} />
            </AdminField>
          </SettingsGroup>
          <SettingsGroup title="Review queue" description="Bound how long operational review data remains available.">
            <AdminField id="review-retention-days" label="Retention" description="Days to retain completed review activity.">
              <input id="review-retention-days" name="review-retention-days" type="number" inputMode="numeric" min="1" max="3650" value={adminDraft.reviewQueue?.retentionDays ?? settings?.reviewQueue.retentionDays ?? 90} onChange={(event) => setAdminDraft((current) => ({ ...current, reviewQueue: { ...current.reviewQueue, retentionDays: Number(event.target.value) } }))} />
            </AdminField>
            <AdminField id="review-max-queries" label="Maximum queries" description="Maximum saved query records before older activity is removed.">
              <input id="review-max-queries" name="review-max-queries" type="number" inputMode="numeric" min="1" max="10000" value={adminDraft.reviewQueue?.maxQueries ?? settings?.reviewQueue.maxQueries ?? 500} onChange={(event) => setAdminDraft((current) => ({ ...current, reviewQueue: { ...current.reviewQueue, maxQueries: Number(event.target.value) } }))} />
            </AdminField>
          </SettingsGroup>
        </fieldset>
        <AdminSaveBar dirty={adminDirty} loading={adminLoading} loaded={adminLoaded} busy={busy} note="Changes apply to new Finder, sync, and review activity after saving." onDiscard={props.discardAdminChanges} />
      </form>

      <section id="admin-access-panel" className="admin-section" aria-labelledby="admin-access-title" hidden={activeSection !== "access"}>
        <AdminSectionHeader id="admin-access-title" title="Access & Users" description="Manage the current admin session, Plex sign-in policy, and per-user capabilities." />
        <div className="admin-access-grid">
          <section className="admin-panel">
            <input type="text" name="admin-username" autoComplete="username" value="moodarr-admin" readOnly hidden />
            <div className="panel-heading-row">
              <PanelTitle icon={<ShieldCheck size={18} aria-hidden="true" />} title="Admin session" />
              <span className={authReady ? "admin-tag live" : "admin-tag warn"}><span className="tag-dot" aria-hidden="true" />{authReady ? "Protected" : "Needs session"}</span>
            </div>
            <p className="panel-copy">The bundled UI uses an HTTP-only same-origin session. API clients can still authenticate with the admin-token header.</p>
            <div className="status-list">
              <StatusRow label="Session" ready={authReady} detail="Active" />
              <StatusRow label="Automatic unlock" ready={!status?.admin.autoSession} detail={status?.admin.autoSession ? "On · trusted LAN only" : "Off"} />
            </div>
            <div className="admin-action-row access-actions">
              {authSession?.authenticated ? <button type="button" onClick={() => void props.logout()} disabled={busy === "logout"}>{busy === "logout" ? <SpinnerGap size={16} className="spin" aria-hidden="true" /> : <SignOut size={16} aria-hidden="true" />}Sign Out</button> : null}
              <button type="button" className="secondary-admin-button" onClick={() => void props.onLock()} disabled={busy === "admin-lock"}>{busy === "admin-lock" ? <SpinnerGap size={16} className="spin" aria-hidden="true" /> : <LockKey size={16} aria-hidden="true" />}Lock Admin</button>
            </div>
          </section>

          <form className="admin-panel admin-access-settings" onSubmit={(event) => void props.saveAdminSettings(event)} aria-busy={adminLoading}>
            <div className="panel-heading-row">
              <PanelTitle icon={<Users size={18} aria-hidden="true" />} title="Plex sign-in" />
              <span className={adminDraft.plexAuth?.enabled ? "admin-tag live" : "admin-tag"}>{adminDraft.plexAuth?.enabled ? "Enabled" : "Disabled"}</span>
            </div>
            <fieldset className="admin-settings-body" disabled={!adminLoaded || adminLoading || busy === "admin-save"}>
              <legend className="sr-only">Plex sign-in settings</legend>
              <AdminField id="plex-auth-enabled" label="Plex sign-in" description="Let Plex users open Finder without the admin token.">
                <AdminToggle id="plex-auth-enabled" name="plex-auth-enabled" checked={adminDraft.plexAuth?.enabled ?? false} onChange={(checked) => setAdminDraft((current) => ({ ...current, plexAuth: { ...current.plexAuth, enabled: checked } }))} />
              </AdminField>
              <AdminField id="plex-auth-new-users" label="New Plex users" description="Allow first sign-in for Plex accounts with server access.">
                <AdminToggle id="plex-auth-new-users" name="plex-auth-new-users" checked={adminDraft.plexAuth?.allowNewUsers ?? true} disabled={!adminDraft.plexAuth?.enabled} onChange={(checked) => setAdminDraft((current) => ({ ...current, plexAuth: { ...current.plexAuth, allowNewUsers: checked } }))} />
              </AdminField>
            </fieldset>
            <AdminSaveBar dirty={adminDirty} loading={adminLoading} loaded={adminLoaded} busy={busy} note="Policy changes apply after saving." onDiscard={props.discardAdminChanges} />
          </form>

          <PlexUsersPanel users={adminUsers} busy={busy} openAiConfigurable={openAiConfigurable} onUpdateUser={props.updateAdminUser} />
        </div>
      </section>

      <section id="admin-moodrank-panel" className="admin-section" aria-labelledby="admin-moodrank-title" hidden={activeSection !== "moodrank"}>
        <AdminSectionHeader id="admin-moodrank-title" title="MoodRank" description="Inspect recommendation readiness, feel profiles, drift, and recent ranking activity." />
        <RecommendationDiagnosticsPanel diagnostics={recommendationDiagnostics} users={adminUsers} busy={busy} runAction={props.runAction} refreshAdmin={props.refreshAdmin} />
      </section>
    </section>
  );
}

function adminSectionFromHash(hash: string): AdminSection {
  const requested = hash.replace(/^#admin-/, "");
  return adminSections.some((section) => section.id === requested) ? requested as AdminSection : "overview";
}

function AdminSectionNavigation({
  activeSection,
  dirty,
  onSelect
}: {
  activeSection: AdminSection;
  dirty: boolean;
  onSelect: (section: AdminSection) => void;
}) {
  return (
    <div className="admin-section-nav-shell">
      <nav className="admin-section-nav" aria-label="Admin sections">
        {adminSections.map((section) => {
          const Icon = section.icon;
          return (
            <a
              key={section.id}
              href={`#admin-${section.id}`}
              className={activeSection === section.id ? "active" : undefined}
              aria-current={activeSection === section.id ? "page" : undefined}
              onClick={() => onSelect(section.id)}
            >
              <Icon size={16} aria-hidden="true" />
              {section.label}
            </a>
          );
        })}
      </nav>
      <label className="admin-section-select">
        <span>Admin section</span>
        <select
          value={activeSection}
          onChange={(event) => {
            const nextSection = event.target.value as AdminSection;
            onSelect(nextSection);
            window.location.hash = `admin-${nextSection}`;
          }}
        >
          {adminSections.map((section) => <option key={section.id} value={section.id}>{section.label}</option>)}
        </select>
      </label>
      {dirty ? <span className="admin-tag warn admin-draft-tag">Unsaved changes</span> : null}
    </div>
  );
}

function AdminSectionHeader({ id, title, description }: { id: string; title: string; description: string }) {
  return (
    <header className="admin-section-header">
      <h2 id={id}>{title}</h2>
      <p>{description}</p>
    </header>
  );
}

function SettingsGroup({
  title,
  description,
  badge,
  children
}: {
  title: string;
  description: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="admin-settings-group">
      <header className="admin-settings-group-header">
        <div>
          <h3>{title}</h3>
          <p>{description}</p>
        </div>
        {badge}
      </header>
      <div className="admin-form-rows">{children}</div>
    </section>
  );
}

function AdminField({ id, label, description, children }: { id: string; label: string; description: string; children: ReactNode }) {
  return (
    <div className="admin-form-row">
      <label htmlFor={id}>
        <strong>{label}</strong>
        <small>{description}</small>
      </label>
      <div className="admin-control">{children}</div>
    </div>
  );
}

function AdminToggle({
  id,
  name,
  checked,
  disabled = false,
  label,
  onChange
}: {
  id: string;
  name: string;
  checked: boolean;
  disabled?: boolean;
  label?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="admin-toggle-control" htmlFor={id}>
      <input id={id} name={name} type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span>{label ?? (checked ? "On" : "Off")}</span>
    </label>
  );
}

function IntegrationReadiness({ ready, children }: { ready: boolean; children: ReactNode }) {
  return (
    <div className={ready ? "test-line ready" : "test-line"} role="status" aria-live="polite">
      {ready ? <CheckCircle size={15} aria-hidden="true" /> : <WarningCircle size={15} aria-hidden="true" />}
      {children}
    </div>
  );
}

function AdminSaveBar({
  dirty,
  loading,
  loaded,
  busy,
  note,
  onDiscard
}: {
  dirty: boolean;
  loading: boolean;
  loaded: boolean;
  busy: string;
  note: string;
  onDiscard: () => void;
}) {
  return (
    <div className="admin-save-bar">
      <span>{loading ? "Loading settings…" : dirty ? note : "Settings are up to date."}</span>
      <div>
        <button type="button" className="secondary-admin-button" onClick={onDiscard} disabled={Boolean(busy) || !dirty}>Discard</button>
        <button type="submit" disabled={busy === "admin-save" || loading || !loaded || !dirty}>
          {busy === "admin-save" ? <SpinnerGap size={16} className="spin" aria-hidden="true" /> : <FloppyDisk size={16} aria-hidden="true" />}
          Save Settings
        </button>
      </div>
    </div>
  );
}

function TrustedRefreshNotice({ catalog }: { catalog: RecommendationDiagnostics["features"]["catalog"] | undefined }) {
  if (!catalog) return null;
  const guidance = catalogRecoveryGuidance(catalog);
  if (!guidance.requiresAction) return null;
  return (
    <div className="usage-readiness review_needed admin-trusted-refresh-notice" role="status" aria-live="polite">
      <div className="usage-readiness-status">
        <WarningCircle size={18} aria-hidden="true" />
        <div>
          <span>{guidance.noticeLabel}</span>
          <strong>{guidance.noticeHeadline}</strong>
        </div>
      </div>
      <div className="usage-readiness-facts">
        <RuntimeFact label="Unique affected" value={String(catalog.trustedRefreshRequiredItems)} />
        <RuntimeFact label="Catalog reimport" value={String(catalog.catalogRefreshRequiredItems)} />
        <RuntimeFact label="Plex resync" value={String(catalog.plexRefreshRequiredItems)} />
        <RuntimeFact label="Requestable affected" value={String(catalog.requestableTrustedRefreshRequiredItems)} />
      </div>
      <p>
        {guidance.instructions} <a href="#admin-moodrank">Open MoodRank</a> to inspect the completion state.
      </p>
    </div>
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
      <PanelTitle icon={<Database size={18} aria-hidden="true" />} title="Health" />
      <div className="status-list">
        <StatusRow label="Plex" ready={status ? Boolean(status.plex.configured || status.fixtureMode) : undefined} detail={!status ? "Checking…" : status.fixtureMode ? "Fixture" : status.plex.configured ? "Configured" : "Missing"} />
        <StatusRow label="Seerr" ready={status ? Boolean(status.seerr.configured || status.fixtureMode) : undefined} detail={!status ? "Checking…" : status.fixtureMode ? "Fixture" : status.seerr.configured ? "Requests only" : "Missing"} />
        <StatusRow
          label="Recommendations"
          ready={status ? Boolean(status.ai.providerPolicy === "none" || status.ai.configured) : undefined}
          detail={!status ? "Checking…" : status.ai.providerPolicy === "none" ? "Local ranking" : status.ai.configured ? "Provider configured" : "Needs configuration"}
        />
      </div>
      <div className="metric-grid">
        <Metric label="Items" value={stats ? stats.totalItems : "—"} />
        <Metric label="Plex" value={stats ? stats.availableInPlex : "—"} />
        <Metric label="Requestable" value={stats ? stats.requestable : "—"} />
        <Metric label="Partial" value={stats ? stats.partiallyAvailable : "—"} />
      </div>
      <div className="admin-action-row health-actions">
        <button type="button" onClick={() => void runAction("plex-test", moodarrApi.testPlex, (result) => result.message)} disabled={Boolean(busy)}>
          {busy === "plex-test" ? <SpinnerGap size={16} className="spin" aria-hidden="true" /> : <CheckCircle size={16} aria-hidden="true" />}
          Test Plex
        </button>
        <button type="button" className="secondary-admin-button" onClick={() => void runAction("seerr-test", moodarrApi.testSeerr, (result) => result.message)} disabled={Boolean(busy)}>
          {busy === "seerr-test" ? <SpinnerGap size={16} className="spin" aria-hidden="true" /> : <CheckCircle size={16} aria-hidden="true" />}
          Test Seerr
        </button>
      </div>
      <div className="sync-times">
        <span>Library {formatDate(stats?.lastLibrarySync)}</span>
        <span>Requests {formatDate(stats?.lastSeerrSync)}</span>
      </div>
    </section>
  );
}

function RuntimePanel({
  status,
  busy,
  runAction,
  refreshAdmin
}: {
  status: ConfigStatusResponse | null;
  busy: string;
  runAction: <T>(name: string, action: () => Promise<T>, message: (result: T) => string) => Promise<T | undefined>;
  refreshAdmin: () => Promise<void>;
}) {
  return (
    <section className="admin-panel">
      <PanelTitle icon={<HardDrives size={18} aria-hidden="true" />} title="Runtime" />
      <div className="runtime-list">
        <RuntimeFact label="Storage" value="Server-side" />
        <RuntimeFact label="Database" value="SQLite" />
        <RuntimeFact label="Configuration" value="Server JSON" />
        <RuntimeFact label="Client" value={!status ? "Checking…" : status.runtime.serveClient ? "Single container" : "Development split"} />
      </div>
      <div className="admin-action-row runtime-actions">
        <button type="button" onClick={() => void runAction("admin-refresh", refreshAdmin, () => "Admin state refreshed.")} disabled={Boolean(busy)}>
          <HardDrives size={16} aria-hidden="true" />
          Refresh State
        </button>
        <button
          type="button"
          className="secondary-admin-button"
          onClick={() =>
            void runAction(
              "support",
              async () => {
                const bundle = await moodarrApi.supportBundle();
                downloadJson(`moodarr-support-${new Date().toISOString().slice(0, 10)}.json`, bundle);
                return bundle;
              },
              () => "Support bundle downloaded. Inspect it before sharing."
            )
          }
          disabled={Boolean(busy)}
        >
          <DownloadSimple size={16} aria-hidden="true" />
          Support Bundle
        </button>
      </div>
      <p className="runtime-note">Credentials are redacted. Inspect a support bundle before sharing it.</p>
    </section>
  );
}

function PlexUsersPanel({
  users,
  busy,
  openAiConfigurable,
  onUpdateUser
}: {
  users: AuthUser[];
  busy: string;
  openAiConfigurable: boolean;
  onUpdateUser: (user: AuthUser, update: AdminUserUpdate) => Promise<void>;
}) {
  const enabledUsers = users.filter((user) => user.enabled).length;
  return (
    <section className="admin-panel admin-users-panel">
      <div className="panel-heading-row">
        <PanelTitle icon={<Users size={18} aria-hidden="true" />} title="Plex users" />
        <span className="admin-tag">{enabledUsers} active · {users.length} total</span>
      </div>
      <p className="panel-copy">Capabilities apply immediately to each Plex account. Access policy above controls whether new accounts can sign in.</p>
      {users.length === 0 ? (
        <p className="mini-empty">No Plex users have signed in yet.</p>
      ) : (
        <div className="user-list" role="list">
          {users.map((user) => {
            const actionBusy = busy === `admin-user-${user.id}`;
            return (
              <div className="user-row" key={user.id} role="listitem">
                <span className={user.enabled ? "dot ready" : "dot"} aria-hidden="true" />
                <div>
                  <strong>{displayUserName(user)}</strong>
                  <small>{user.lastLoginAt ? `Last ${formatDate(user.lastLoginAt)}` : "Never signed in"} · {requestCountLabel(user.requestCount)}</small>
                </div>
                <div className="user-capabilities" aria-label={`Capabilities for ${displayUserName(user)}`}>
                  <label title="Allow Seerr request creation">
                    <input
                      type="checkbox"
                      aria-label={`${displayUserName(user)} · request permission`}
                      checked={user.canRequest}
                      onChange={(event) => void onUpdateUser(user, { canRequest: event.target.checked })}
                      disabled={actionBusy || !user.enabled}
                    />
                    Request
                  </label>
                  {openAiConfigurable ? (
                    <label title="Allow optional AI interpretation and reranking">
                      <input
                        type="checkbox"
                        aria-label={`${displayUserName(user)} · AI permission`}
                        checked={user.canUseAi}
                        onChange={(event) => void onUpdateUser(user, { canUseAi: event.target.checked })}
                        disabled={actionBusy || !user.enabled}
                      />
                      AI
                    </label>
                  ) : null}
                  <button type="button" aria-label={`${user.enabled ? "Disable" : "Enable"} ${displayUserName(user)}`} onClick={() => void onUpdateUser(user, { enabled: !user.enabled })} disabled={actionBusy}>
                    {actionBusy ? <SpinnerGap size={13} className="spin" aria-hidden="true" /> : user.enabled ? "Disable" : "Enable"}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

function SyncPanel({
  syncStatus,
  busy,
  openAiConfigurable,
  runAction,
  onSync
}: {
  syncStatus: SyncStatus | null;
  busy: string;
  openAiConfigurable: boolean;
  runAction: <T>(name: string, action: () => Promise<T>, message: (result: T) => string) => Promise<T | undefined>;
  onSync: () => Promise<void>;
}) {
  return (
    <section className="admin-panel admin-sync-panel">
      <div className="panel-heading-row">
        <PanelTitle icon={<Stack size={18} aria-hidden="true" />} title="Sync" />
        <span className={syncStatus?.enabled ? "admin-tag live" : "admin-tag warn"}>
          <span className="tag-dot" aria-hidden="true" />
          {!syncStatus ? "Loading…" : syncStatus.enabled ? `Every ${syncStatus.intervalMinutes}m` : "Disabled"}
        </span>
      </div>
      <div className="metric-grid sync-metrics">
        <Metric label="Next sync" value={!syncStatus ? "—" : syncStatus.nextRunAt ? formatShortTime(syncStatus.nextRunAt) : "Off"} />
        <Metric label="Interval" value={syncStatus ? syncStatus.intervalMinutes : "—"} />
        <Metric label="Seerr sync" value={!syncStatus ? "—" : syncStatus.syncSeerr ? "On" : "Off"} />
        <Metric label="State" value={syncStateLabel(syncStatus)} />
      </div>
	      <div className="admin-sync-summary">
	        <RuntimeFact label="Last result" value={syncLastResultLabel(syncStatus)} />
	        {openAiConfigurable ? (
	          <button type="button" className="secondary-admin-button" onClick={() => void runAction("embedding-warmup", () => moodarrApi.warmEmbeddings(), embeddingWarmupMessage)} disabled={Boolean(busy)}>
	            {busy === "embedding-warmup" ? <SpinnerGap size={16} className="spin" aria-hidden="true" /> : <Sparkle size={16} aria-hidden="true" />}
	            Warm embeddings
	          </button>
	        ) : null}
	        <button type="button" onClick={() => void onSync()} disabled={Boolean(busy) || Boolean(syncStatus?.running)}>
	          {busy === "admin-sync" ? <SpinnerGap size={16} className="spin" aria-hidden="true" /> : <Stack size={16} aria-hidden="true" />}
	          Sync Now
	        </button>
	      </div>
        <p className="runtime-note">
          Stale quarantines clear only after both phases complete; reproduced conflicts remain blocked.
        </p>
      <SyncHistory history={syncStatus?.history} />
    </section>
  );
}


function PanelTitle({ icon, title }: { icon: ReactNode; title: string }) {
  return (
    <div className="panel-title">
      {icon}
      <h3>{title}</h3>
    </div>
  );
}

function StatusRow({ label, ready, detail }: { label: string; ready: boolean | undefined; detail: string }) {
  return (
    <div className="status-row">
      <span className={ready === undefined ? "dot neutral" : ready ? "dot ready" : "dot"} aria-hidden="true" />
      <span>{label}</span>
      <strong>{detail}</strong>
    </div>
  );
}

function ConfigState({ configured, label = "Configured", unsetLabel = "Missing" }: { configured: boolean; label?: string; unsetLabel?: string }) {
  return (
    <span className={configured ? "field-state set" : "field-state unset"}>
      {configured ? <CheckCircle size={13} aria-hidden="true" /> : <WarningCircle size={13} aria-hidden="true" />}
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
    .sort((left, right) => new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime());

  if (runs.length === 0) {
    return (
      <div className="history-list">
        <div className="history-row empty">
          <span className="dot" aria-hidden="true" />
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


function formatDate(value?: string) {
  if (!value) return "not synced";
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function formatShortTime(value?: string) {
  if (!value) return "not synced";
  return new Date(value).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function syncResultMessage(result: SyncRunResult) {
  return result.accepted ? "Sync started. Progress is available in the sync status panel." : result.message;
}

function syncProgressLabel(status: SyncStatus) {
  const stage = status.progress?.stage.replaceAll("_", " ") ?? "starting";
  const count = status.progress?.total === undefined ? "" : ` ${status.progress.processed ?? 0}/${status.progress.total}`;
  return `${stage}${count}`;
}

function syncStateLabel(status: SyncStatus | null) {
  if (!status) return "Not loaded";
  if (status.running) return syncProgressLabel(status);
  if (!status.lastResult) return "Idle";
  if (!status.lastResult.ok) return "Failed";
  return syncIdentityConflictCount(status.lastResult) > 0 ? "Complete with warning" : "Complete";
}

function syncLastResultLabel(status: SyncStatus | null) {
  const result = status?.lastResult;
  if (!result) return "No completed run";
  if (!result.ok) return result.error ?? "Sync failed; check server logs.";
  const counts = [`${result.plexItems ?? 0} Plex`, `${result.seerrItems ?? 0} request records`];
  const identityConflicts = syncIdentityConflictCount(result);
  const warning = identityConflicts > 0
    ? ` · Warning: ${identityConflicts} identity ${identityConflicts === 1 ? "conflict" : "conflicts"} skipped`
    : "";
  const cleared = result.identityQuarantinesCleared ?? 0;
  const recovery = cleared > 0
    ? ` · ${cleared} stale identity ${cleared === 1 ? "quarantine" : "quarantines"} cleared`
    : "";
  return `${counts.join(" · ")} · ${result.durationMs}ms${warning}${recovery}`;
}

function syncIdentityConflictCount(result: NonNullable<SyncStatus["lastResult"]>) {
  return (result.plexIdentityConflicts ?? 0) + (result.seerrIdentityConflicts ?? 0);
}

function formatReasoningEffort(effort: OpenAiReasoningEffort) {
  return effort === "xhigh" ? "X-high" : effort.charAt(0).toUpperCase() + effort.slice(1);
}

function displayUserName(user: AuthUser | undefined) {
  return user?.displayName || user?.username || user?.email || "Plex user";
}

function requestCountLabel(count: number | undefined) {
  const value = count ?? 0;
  return `${value} ${value === 1 ? "request" : "requests"}`;
}

function embeddingWarmupMessage(result: EmbeddingWarmupStatus) {
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
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
