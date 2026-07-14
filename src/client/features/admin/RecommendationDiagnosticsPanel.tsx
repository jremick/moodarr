import {
  ArrowClockwise,
  CheckCircle,
  DownloadSimple,
  Sparkle,
  SpinnerGap,
  Trash,
  WarningCircle
} from "@phosphor-icons/react";
import { useEffect, useState, type ReactNode } from "react";
import { moodarrApi } from "../../api";
import { catalogRecoveryGuidance } from "./catalogRecovery";
import type {
  AuthUser,
  FeelProfileCheckpointSummary,
  FeelProfileDriftAlert,
  FeelProfileResponse,
  RecommendationDiagnostics,
  WatchContext
} from "../../../shared/types";

export function RecommendationDiagnosticsPanel({
  diagnostics,
  users,
  busy,
  runAction,
  refreshAdmin
}: {
  diagnostics: RecommendationDiagnostics | null;
  users: AuthUser[];
  busy: string;
  runAction: <T>(name: string, action: () => Promise<T>, message: (result: T) => string) => Promise<T | undefined>;
  refreshAdmin: () => Promise<void>;
}) {
  const embeddingModel = diagnostics?.features.embeddingModels[0];
  const replayStorage = diagnostics?.replayStorage;
  const fingerprintCoverage = diagnostics?.features.contentFingerprints;
  const driftAlerts = diagnostics?.feelProfileDrift?.alerts ?? [];
  const timeline = diagnostics?.feelProfileTimeline?.recent ?? [];
  const readiness = diagnostics?.usageReadiness;
  const catalogDiagnostics = diagnostics?.features.catalog;
  const [selectedUserId, setSelectedUserId] = useState("");
  const [selectedSoloProfile, setSelectedSoloProfile] = useState<FeelProfileResponse | null>(null);
  const [selectedProfileState, setSelectedProfileState] = useState<"idle" | "loading" | "error">("idle");
  const selectedUser = users.find((user) => user.id === selectedUserId);

  useEffect(() => {
    if (users.some((user) => user.id === selectedUserId)) return;
    setSelectedUserId(users[0]?.id ?? "");
  }, [selectedUserId, users]);

  useEffect(() => {
    let active = true;
    if (!selectedUserId) {
      setSelectedSoloProfile(null);
      setSelectedProfileState("idle");
      return;
    }
    setSelectedProfileState("loading");
    void moodarrApi
      .feelProfile("solo", selectedUserId)
      .then((profile) => {
        if (!active) return;
        setSelectedSoloProfile(profile);
        setSelectedProfileState("idle");
      })
      .catch(() => {
        if (!active) return;
        setSelectedSoloProfile(null);
        setSelectedProfileState("error");
      });
    return () => {
      active = false;
    };
  }, [selectedUserId]);

  async function refreshSelectedSoloProfile() {
    if (!selectedUserId) return;
    setSelectedSoloProfile(await moodarrApi.feelProfile("solo", selectedUserId));
  }

  async function exportFeelProfiles() {
    if (!selectedUserId) throw new Error("Choose a Plex user before exporting feel profiles.");
    const data = await moodarrApi.exportFeelProfiles(selectedUserId);
    downloadJson(`moodarr-feel-profiles-${selectedUserId}-${new Date().toISOString().slice(0, 10)}.json`, data);
    return data;
  }
  async function resetFeelProfileContext(watchContext: WatchContext, authUserId?: string) {
    const result = await moodarrApi.resetFeelProfile({ watchContext, ...(watchContext === "solo" && authUserId ? { authUserId } : {}) });
    await refreshAdmin();
    if (watchContext === "solo") await refreshSelectedSoloProfile();
    return result;
  }
  async function rollbackFeelProfile(alert: Pick<FeelProfileDriftAlert, "watchContext" | "term" | "version">, authUserId?: string) {
    const result = await moodarrApi.rollbackFeelProfile({
      watchContext: alert.watchContext,
      term: alert.term,
      version: Math.max(1, alert.version - 1),
      ...(alert.watchContext === "solo" && authUserId ? { authUserId } : {})
    });
    await refreshAdmin();
    if (alert.watchContext === "solo") await refreshSelectedSoloProfile();
    return result;
  }
  return (
    <section className="admin-panel wide">
      <div className="panel-heading-row">
        <PanelTitle icon={<Sparkle size={18} aria-hidden="true" />} title="Recommendation engine" />
        <span className="admin-tag live">
          <span className="tag-dot" />
          {diagnostics?.engineVersion ?? "moodrank-v0.4"}
        </span>
      </div>
      <p className="panel-copy">Coverage, recent runs, and preference signals without exposing tokens or raw prompts.</p>
      <TrustedRefreshPanel catalog={catalogDiagnostics} />
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
        <RuntimeFact
          label="Fingerprints"
          value={fingerprintCoverage ? `${fingerprintCoverage.current}/${fingerprintCoverage.total} current` : String(diagnostics?.features.contentFingerprintCount ?? 0)}
        />
        <RuntimeFact
          label="Thin fingerprints"
          value={fingerprintCoverage ? `${fingerprintCoverage.summaryThin + fingerprintCoverage.summaryMissing} summary / ${fingerprintCoverage.genreThin + fingerprintCoverage.genreMissing} genre` : "Not loaded"}
        />
        <RuntimeFact
          label="Projected fingerprint rows"
          value={fingerprintCoverage ? `${fingerprintCoverage.projectedScoreCount} rows / ${fingerprintCoverage.projectedItemCount} items` : "Not loaded"}
        />
        <RuntimeFact label="Mood scores" value={String(diagnostics?.features.moodFeatureScoreCount ?? 0)} />
        <RuntimeFact label="Embedding model" value={embeddingModel ? `${embeddingModel.model} (${embeddingModel.count})` : "Local fallback"} />
        <RuntimeFact label="Replay retention" value={replayStorage ? `${replayStorage.retentionPolicy.retentionDays}d / ${replayStorage.retentionPolicy.maxCheckpointsPerTerm} checkpoints` : "Not loaded"} />
        <RuntimeFact label="Operational-only" value={catalogDiagnostics ? String(catalogDiagnostics.operationalOnlyItems) : "Not loaded"} />
        <RuntimeFact label="Requestable operational" value={catalogDiagnostics ? String(catalogDiagnostics.requestableOperationalOnlyItems) : "Not loaded"} />
      </div>
      <div className="profile-owner-control">
        <label>
          Solo profile owner
          <select name="solo-profile-owner" value={selectedUserId} onChange={(event) => setSelectedUserId(event.target.value)} disabled={users.length === 0 || Boolean(busy)}>
            {users.length === 0 ? <option value="">No Plex users</option> : null}
            {users.map((user) => (
              <option key={user.id} value={user.id}>
                {displayUserName(user)} · {user.id}
              </option>
            ))}
          </select>
          <small>Solo learning is scoped to this Plex account. Together learning remains shared.</small>
        </label>
      </div>
      <div className="admin-action-row">
        <button
          type="button"
          className="secondary-admin-button"
          onClick={() => void runAction("feel-profile-export", exportFeelProfiles, (result) => `Exported ${result.feedbackSummary.total} feel signals.`)}
          disabled={Boolean(busy) || !selectedUserId}
        >
          {busy === "feel-profile-export" ? <SpinnerGap size={16} className="spin" aria-hidden="true" /> : <DownloadSimple size={16} aria-hidden="true" />}
          Export selected + shared
        </button>
        <button
          type="button"
          className="secondary-admin-button"
          onClick={() => {
            if (!window.confirm(`Reset all solo feel-profile terms for ${displayUserName(selectedUser)}? This cannot be undone.`)) return;
            void runAction("feel-profile-reset-solo", () => resetFeelProfileContext("solo", selectedUserId), (result) => `Reset ${result.deletedTerms} solo terms for ${displayUserName(selectedUser)}.`);
          }}
          disabled={Boolean(busy) || !selectedUserId}
        >
          <Trash size={16} aria-hidden="true" />
          Reset selected solo
        </button>
        <button
          type="button"
          className="secondary-admin-button"
          onClick={() => {
            if (!window.confirm("Reset all shared together feel-profile terms? This cannot be undone.")) return;
            void runAction("feel-profile-reset-group", () => resetFeelProfileContext("group"), (result) => `Reset ${result.deletedTerms} together terms.`);
          }}
          disabled={Boolean(busy)}
        >
          <Trash size={16} aria-hidden="true" />
          Reset shared together
        </button>
      </div>
      <div className="signal-section">
        <span>Selected solo feel profile · {displayUserName(selectedUser)}</span>
        {!selectedUserId ? <span className="signal-chip">No Plex user profiles yet</span> : null}
        {selectedUserId && selectedProfileState === "loading" ? <span className="signal-chip">Loading</span> : null}
        {selectedUserId && selectedProfileState === "error" ? <span className="signal-chip">Could not load this profile</span> : null}
        {selectedUserId && selectedProfileState === "idle" ? (
          <SoloProfileTerms
            profile={selectedSoloProfile}
            busy={busy}
            onRollback={(term, version) =>
              runAction(
                `rollback-solo-${selectedUserId}-${term}`,
                () => rollbackFeelProfile({ watchContext: "solo", term, version }, selectedUserId),
                (result) => `Rolled ${result.term} back to v${result.restoredVersion} for ${displayUserName(selectedUser)}.`
              )
            }
          />
        ) : null}
      </div>
      <div className="signal-section">
        <span>Shared together preference signals</span>
        <PreferenceSignals signals={diagnostics?.preferences.group.positive} />
      </div>
      <div className="signal-section">
        <span>Shared together feel profile</span>
        <FeelProfileTerms profile={diagnostics?.feelProfiles?.group} />
      </div>
      <div className="signal-section">
        <span>Shared together drift review</span>
        <ProfileDriftAlerts
          alerts={driftAlerts.filter((alert) => alert.watchContext === "group")}
          busy={busy}
          onRollback={(alert) => runAction(`rollback-group-${alert.term}`, () => rollbackFeelProfile(alert), (result) => `Rolled shared ${result.term} back to v${result.restoredVersion}.`)}
        />
      </div>
      <div className="signal-section">
        <span>Checkpoint timeline</span>
        <ProfileTimeline checkpoints={timeline} />
      </div>
      <RecentRecommendationRuns runs={diagnostics?.recentRuns} />
    </section>
  );
}

function TrustedRefreshPanel({ catalog }: { catalog: RecommendationDiagnostics["features"]["catalog"] | undefined }) {
  if (!catalog) {
    return (
      <div className="usage-readiness collecting">
        <div className="usage-readiness-status">
          <WarningCircle size={18} aria-hidden="true" />
          <div>
            <span>Catalog readiness</span>
            <strong>Not loaded</strong>
          </div>
        </div>
        <p>Refresh diagnostics to inspect trusted metadata recovery state.</p>
      </div>
    );
  }
  const guidance = catalogRecoveryGuidance(catalog);
  return (
    <div className={`usage-readiness ${guidance.requiresAction ? "review_needed" : "replay_ready"}`} role="status" aria-live="polite">
      <div className="usage-readiness-status">
        {guidance.requiresAction ? <WarningCircle size={18} aria-hidden="true" /> : <CheckCircle size={18} aria-hidden="true" />}
        <div>
          <span>Catalog readiness</span>
          <strong>{guidance.panelHeadline}</strong>
        </div>
      </div>
      <div className="usage-readiness-facts">
        <RuntimeFact label="Unique affected" value={String(catalog.trustedRefreshRequiredItems)} />
        <RuntimeFact label="Catalog reimport" value={String(catalog.catalogRefreshRequiredItems)} />
        <RuntimeFact label="Plex resync" value={String(catalog.plexRefreshRequiredItems)} />
        <RuntimeFact label="Requestable affected" value={String(catalog.requestableTrustedRefreshRequiredItems)} />
      </div>
      <p>{guidance.instructions}</p>
    </div>
  );
}

function UsageReadinessPanel({ readiness }: { readiness: RecommendationDiagnostics["usageReadiness"] | undefined }) {
  if (!readiness) {
    return (
      <div className="usage-readiness collecting">
        <div className="usage-readiness-status">
          <WarningCircle size={18} aria-hidden="true" />
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
        {readiness.ready ? <CheckCircle size={18} aria-hidden="true" /> : <WarningCircle size={18} aria-hidden="true" />}
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

function SoloProfileTerms({
  profile,
  busy,
  onRollback
}: {
  profile: FeelProfileResponse | null;
  busy: string;
  onRollback: (term: string, version: number) => Promise<unknown>;
}) {
  if (!profile?.terms.length) {
    return (
      <div className="signal-wrap">
        <span className="signal-chip">Learning</span>
      </div>
    );
  }

  return (
    <div className="profile-alert-list">
      {profile.terms.slice(0, 8).map((term) => (
        <div className="profile-alert-row" key={`${profile.id}-${term.term}`}>
          <div>
            <strong>{term.term}</strong>
            <span>
              confidence {Math.round(term.confidence * 100)}% / v{term.version}
            </span>
          </div>
          <span className="admin-tag">
            <span className="tag-dot" />
            {term.evidenceCount} signals
          </span>
          <button
            type="button"
            className="icon-admin-button"
            onClick={() => {
              if (!window.confirm(`Roll back ${term.term} to version ${term.version - 1}? This changes the selected solo profile immediately.`)) return;
              void onRollback(term.term, term.version);
            }}
            disabled={Boolean(busy) || term.version <= 1}
            aria-label={`Rollback ${term.term} for the selected solo profile`}
            title={term.version <= 1 ? "No earlier checkpoint" : `Restore version ${term.version - 1}`}
          >
            <ArrowClockwise size={15} aria-hidden="true" />
            Rollback
          </button>
        </div>
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
          <button
            type="button"
            className="icon-admin-button"
            onClick={() => {
              if (!window.confirm(`Roll back shared ${alert.term} to version ${Math.max(1, alert.version - 1)}? This changes the together profile immediately.`)) return;
              void onRollback(alert);
            }}
            disabled={Boolean(busy)}
            aria-label={`Rollback ${alert.term}`}
          >
            <ArrowClockwise size={15} aria-hidden="true" />
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


function downloadJson(filename: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function formatSignalFeature(feature: string) {
  return feature.replace(/^[a-z]+:/, "").replaceAll("-", " ");
}

function formatWeight(weight: number) {
  return `${weight >= 0 ? "+" : ""}${weight.toFixed(2)}`;
}

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
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

function RuntimeFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="runtime-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatShortTime(value?: string) {
  if (!value) return "not synced";
  return new Date(value).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function displayUserName(user: AuthUser | undefined) {
  return user?.displayName || user?.username || user?.email || "Plex user";
}
