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
import type { Dispatch, FormEvent, ReactNode, SetStateAction } from "react";
import { moodarrApi } from "../../api";
import type { AdminUserUpdate } from "../../appHooks";
import { RecommendationDiagnosticsPanel } from "./RecommendationDiagnosticsPanel";
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
  return (
    <section id="admin-view" className="admin-grid admin-redesign-grid" tabIndex={-1}>
      <aside className="admin-side">
        <section className="admin-panel">
	          <input type="text" name="admin-username" autoComplete="username" value="moodarr-admin" readOnly hidden />
	          <div className="panel-heading-row">
	            <PanelTitle icon={<ShieldCheck size={18} aria-hidden="true" />} title="Access" />
            <span className={authReady ? "admin-tag live" : "admin-tag warn"}>
              <span className="tag-dot" />
              {authReady ? "Protected" : "Needs session"}
            </span>
          </div>
          <p className="panel-copy">Admin auth is configured in the container. The bundled UI uses an HTTP-only same-origin session; API clients can still send the admin token as a header.</p>
          <div className="status-list">
            <StatusRow label="Admin access" ready={authReady} detail="Unlocked" />
            <StatusRow
              label="Automatic unlock"
              ready={!status?.admin.autoSession}
              detail={status?.admin.autoSession ? "On · trusted LAN only" : "Off"}
            />
            <StatusRow label="Plex sign-in" ready={Boolean(status?.auth.plexAuthEnabled)} detail={status?.auth.plexAuthEnabled ? "Enabled" : "Disabled"} />
            <StatusRow label="New Plex sign-ins" ready={status ? Boolean(!status.auth.plexAuthEnabled || status.auth.allowNewPlexUsers) : false} detail={status ? (status.auth.allowNewPlexUsers ? "Allowed" : "Closed") : "Unknown"} />
            <StatusRow label="Client served" ready={Boolean(status?.runtime.serveClient)} detail={status?.runtime.serveClient ? "Single container" : "Dev split"} />
            <StatusRow label="Fixture mode" ready={!fixtureMode} detail={fixtureMode ? "On" : "Off"} />
          </div>
          <div className="button-stack access-actions">
            {authSession?.authenticated ? (
              <button type="button" onClick={() => void props.logout()} disabled={busy === "logout"}>
                {busy === "logout" ? <SpinnerGap size={16} className="spin" aria-hidden="true" /> : <SignOut size={16} aria-hidden="true" />}
                Sign out
              </button>
            ) : null}
            <button type="button" className="secondary-admin-button" onClick={() => void props.onLock()} disabled={busy === "admin-lock"}>
              {busy === "admin-lock" ? <SpinnerGap size={16} className="spin" aria-hidden="true" /> : <LockKey size={16} aria-hidden="true" />}
              Lock Admin
            </button>
          </div>
          <PlexUsersPanel users={adminUsers} busy={busy} openAiConfigurable={openAiConfigurable} onUpdateUser={props.updateAdminUser} />
        </section>

        <HealthPanel
          status={status}
          stats={stats}
          busy={busy}
          syncRunning={Boolean(syncStatus?.running)}
          runAction={props.runAction}
          onSync={runSync}
        />

        <section className="admin-panel">
          <PanelTitle icon={<Database size={18} aria-hidden="true" />} title="Runtime" />
          <div className="runtime-list">
            <RuntimeFact label="Storage" value="Server-side" />
            <RuntimeFact label="Database" value="SQLite" />
            <RuntimeFact label="Config" value="Server JSON" />
            <RuntimeFact label="Next sync" value={formatDate(syncStatus?.nextRunAt)} />
            <RuntimeFact label="Items" value={String(stats?.totalItems ?? 0)} />
          </div>
          <div className="button-stack">
            <button onClick={() => void props.runAction("admin-refresh", props.refreshAdmin, () => "Admin state refreshed.")} disabled={Boolean(busy)}>
              <HardDrives size={16} aria-hidden="true" />
              Refresh state
            </button>
            <button onClick={() => void runSync()} disabled={Boolean(busy) || Boolean(syncStatus?.running)}>
              {busy === "admin-sync" ? <SpinnerGap size={16} className="spin" aria-hidden="true" /> : <Stack size={16} aria-hidden="true" />}
              Run sync now
            </button>
            <button
              onClick={() =>
                void props.runAction(
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
              Support bundle
            </button>
          </div>
          <p className="runtime-note">Known credentials are redacted; inspect the bundle before sharing.</p>
        </section>
      </aside>

	      <div className="admin-main">
	        <form className="admin-panel wide admin-settings-panel" onSubmit={(event) => void props.saveAdminSettings(event)} aria-busy={adminLoading}>
	          <input type="text" name="settings-username" autoComplete="username" value="moodarr-admin" readOnly hidden />
	          <div className="panel-heading-row">
            <PanelTitle icon={<GearSix size={18} aria-hidden="true" />} title="Integrations" />
            <span className={adminDirty ? "admin-tag warn" : "admin-tag"}>{adminLoading ? "Loading settings…" : adminDirty ? "Unsaved changes" : "Endpoints & credentials"}</span>
          </div>
          <p className="panel-copy">Credentials stay server-side. Leaving a secret field blank keeps the stored value; entering one rotates it.</p>

          <fieldset className="admin-settings-body" disabled={!adminLoaded || adminLoading || busy === "admin-save"}>
            <div className="admin-columns">
            <fieldset>
              <legend>
                Plex <span className="legend-badge plex">Source</span>
              </legend>
	              <label>
	                Base URL
	                <input name="plex-base-url" type="url" inputMode="url" autoComplete="off" spellCheck={false} value={adminDraft.plex?.baseUrl ?? ""} onChange={(event) => setAdminDraft((current) => ({ ...current, plex: { ...current.plex, baseUrl: event.target.value } }))} placeholder="http://plex:32400" />
	                <small>Server-side sync and poster fetch origin.</small>
	              </label>
	              <label>
	                Plex Web URL
	                <input name="plex-web-base-url" type="url" inputMode="url" autoComplete="off" spellCheck={false} value={adminDraft.plex?.webBaseUrl ?? ""} onChange={(event) => setAdminDraft((current) => ({ ...current, plex: { ...current.plex, webBaseUrl: event.target.value } }))} placeholder="https://app.plex.tv/desktop" />
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
                <CheckCircle size={15} aria-hidden="true" />
                {status?.plex.configured || status?.fixtureMode ? "Ready for library sync" : "Base URL and token required"}
              </div>
            </fieldset>

            <fieldset>
              <legend>
                Seerr <span className="legend-badge seerr">Requests</span>
              </legend>
	              <label>
	                Base URL
	                <input name="seerr-base-url" type="url" inputMode="url" autoComplete="off" spellCheck={false} value={adminDraft.seerr?.baseUrl ?? ""} onChange={(event) => setAdminDraft((current) => ({ ...current, seerr: { ...current.seerr, baseUrl: event.target.value } }))} placeholder="http://seerr:5055" />
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
                <CheckCircle size={15} aria-hidden="true" />
                {status?.seerr.configured || status?.fixtureMode ? "Request API ready" : "Base URL and API key required"}
              </div>
            </fieldset>

            <fieldset>
              <legend>
                Recommendations <span className="legend-badge ai">{openAiConfigurable && adminDraft.ai?.provider === "openai" ? "OpenAI" : "Local"}</span>
              </legend>
              {!openAiConfigurable ? (
                <>
                  <p className="panel-copy">This beta build uses local ranking only. The OpenAI network endpoint is excluded from the release server bundle; direct source and explicitly configurable EXP runs can still test it.</p>
                  {settings?.ai.openaiApiKeyConfigured ? (
                    <label className="toggle-row">
                      <input
                        name="clear-openai-api-key"
                        type="checkbox"
                        checked={Boolean(adminDraft.ai?.clearOpenaiApiKey)}
                        onChange={(event) => setAdminDraft((current) => ({ ...current, ai: { ...current.ai, clearOpenaiApiKey: event.target.checked } }))}
                      />
                      <span>
                        <strong>Remove stored OpenAI key</strong>
                        <small>Deletes a key left in /data by an earlier or locally configurable build when you save.</small>
                      </span>
                    </label>
                  ) : null}
                </>
              ) : (
                <>
                  <label>
                    Provider
                    <select name="ai-provider" value={adminDraft.ai?.provider ?? "none"} onChange={(event) => setAdminDraft((current) => ({ ...current, ai: { ...current.ai, provider: event.target.value as "none" | "openai" } }))}>
                      <option value="none">Local ranking</option>
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
                </>
              )}
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
          </fieldset>

          <div className="admin-save-bar">
            <span>Changes apply on save. Secret fields left blank keep their stored value.</span>
            <div>
              <button type="button" className="secondary-admin-button" onClick={props.discardAdminChanges} disabled={Boolean(busy) || !adminDirty}>
                Discard
              </button>
              <button type="submit" disabled={busy === "admin-save" || adminLoading || !adminLoaded || !adminDirty}>
                {busy === "admin-save" ? <SpinnerGap size={16} className="spin" aria-hidden="true" /> : <FloppyDisk size={16} aria-hidden="true" />}
                Save settings
              </button>
            </div>
          </div>
        </form>

        <SyncPanel syncStatus={syncStatus} busy={busy} openAiConfigurable={openAiConfigurable} runAction={props.runAction} onSync={runSync} />

        <RecommendationDiagnosticsPanel
          diagnostics={recommendationDiagnostics}
          users={adminUsers}
          busy={busy}
          runAction={props.runAction}
          refreshAdmin={props.refreshAdmin}
        />
      </div>
    </section>
  );
}

function HealthPanel({
  status,
  stats,
  busy,
  syncRunning,
  runAction,
  onSync
}: {
  status: ConfigStatusResponse | null;
  stats: LibraryStats | null;
  busy: string;
  syncRunning: boolean;
  runAction: <T>(name: string, action: () => Promise<T>, message: (result: T) => string) => Promise<T | undefined>;
  onSync: () => Promise<void>;
}) {
  return (
    <section className="admin-panel">
      <PanelTitle icon={<Database size={18} aria-hidden="true" />} title="Health" />
      <StatusRow label="Plex" ready={Boolean(status?.plex.configured || status?.fixtureMode)} detail={status?.fixtureMode ? "Fixture" : status?.plex.configured ? "Configured" : "Missing"} />
      <StatusRow label="Seerr" ready={Boolean(status?.seerr.configured || status?.fixtureMode)} detail={status?.fixtureMode ? "Fixture" : status?.seerr.configured ? "Configured" : "Missing"} />
      <StatusRow
        label="Recommendations"
        ready={Boolean(status && (status.ai.providerPolicy === "none" || status.ai.configured))}
        detail={status?.ai.providerPolicy === "none" ? "Local ranking" : status?.ai.configured ? "Provider configured" : "Local ranking"}
      />
      <StatusRow label="Admin" ready detail="Unlocked" />
      <div className="metric-grid">
        <Metric label="Items" value={stats?.totalItems ?? 0} />
        <Metric label="Plex" value={stats?.availableInPlex ?? 0} />
        <Metric label="Requestable" value={stats?.requestable ?? 0} />
        <Metric label="Partial" value={stats?.partiallyAvailable ?? 0} />
      </div>
      <div className="button-stack">
        <button onClick={() => void runAction("plex-test", moodarrApi.testPlex, (result) => result.message)} disabled={Boolean(busy)}>
          {busy === "plex-test" ? <SpinnerGap size={16} className="spin" aria-hidden="true" /> : <CheckCircle size={16} aria-hidden="true" />}
          Test Plex
        </button>
        <button onClick={() => void runAction("seerr-test", moodarrApi.testSeerr, (result) => result.message)} disabled={Boolean(busy)}>
          {busy === "seerr-test" ? <SpinnerGap size={16} className="spin" aria-hidden="true" /> : <CheckCircle size={16} aria-hidden="true" />}
          Test Seerr
        </button>
        <button
          onClick={() => void onSync()}
          disabled={Boolean(busy) || syncRunning}
        >
          {busy === "admin-sync" ? <SpinnerGap size={16} className="spin" aria-hidden="true" /> : <Stack size={16} aria-hidden="true" />}
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
    <div className="user-management">
      <div className="mini-heading">
        <Users size={15} aria-hidden="true" />
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
                <div className="user-capabilities" aria-label={`Capabilities for ${displayUserName(user)}`}>
                  <label title="Allow Seerr request creation">
                    <input
                      type="checkbox"
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
                        checked={user.canUseAi}
                        onChange={(event) => void onUpdateUser(user, { canUseAi: event.target.checked })}
                        disabled={actionBusy || !user.enabled}
                      />
                      AI
                    </label>
                  ) : null}
                  <button type="button" onClick={() => void onUpdateUser(user, { enabled: !user.enabled })} disabled={actionBusy}>
                    {actionBusy ? <SpinnerGap size={13} className="spin" aria-hidden="true" /> : user.enabled ? "Disable" : "Enable"}
                  </button>
                </div>
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
    <section className="admin-panel wide">
      <div className="panel-heading-row">
        <PanelTitle icon={<Stack size={18} aria-hidden="true" />} title="Sync" />
        <span className={syncStatus?.enabled ? "admin-tag live" : "admin-tag warn"}>
          <span className="tag-dot" />
          {syncStatus?.enabled ? `Every ${syncStatus.intervalMinutes}m` : "Disabled"}
        </span>
      </div>
      <div className="metric-grid sync-metrics">
        <Metric label="Next sync" value={syncStatus?.nextRunAt ? formatShortTime(syncStatus.nextRunAt) : "Off"} />
        <Metric label="Interval" value={syncStatus?.intervalMinutes ?? 0} />
        <Metric label="Seerr sync" value={syncStatus?.syncSeerr ? "On" : "Off"} />
        <Metric label="State" value={syncStateLabel(syncStatus)} />
      </div>
	      <div className="admin-sync-summary">
	        <RuntimeFact label="Last result" value={syncLastResultLabel(syncStatus)} />
	        {openAiConfigurable ? (
	          <button className="secondary-admin-button" onClick={() => void runAction("embedding-warmup", () => moodarrApi.warmEmbeddings(), embeddingWarmupMessage)} disabled={Boolean(busy)}>
	            {busy === "embedding-warmup" ? <SpinnerGap size={16} className="spin" aria-hidden="true" /> : <Sparkle size={16} aria-hidden="true" />}
	            Warm embeddings
	          </button>
	        ) : null}
	        <button onClick={() => void onSync()} disabled={Boolean(busy) || Boolean(syncStatus?.running)}>
	          {busy === "admin-sync" ? <SpinnerGap size={16} className="spin" aria-hidden="true" /> : <Stack size={16} aria-hidden="true" />}
	          Sync now
	        </button>
	      </div>
      <SyncHistory history={syncStatus?.history} />
    </section>
  );
}


function PanelTitle({ icon, title }: { icon: ReactNode; title: string }) {
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
  return status.lastResult.ok ? "Complete" : "Failed";
}

function syncLastResultLabel(status: SyncStatus | null) {
  const result = status?.lastResult;
  if (!result) return "No completed run";
  if (!result.ok) return result.error ?? "Sync failed; check server logs.";
  const counts = [`${result.plexItems ?? 0} Plex`, `${result.seerrItems ?? 0} Seerr`];
  return `${counts.join(" · ")} · ${result.durationMs}ms`;
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
