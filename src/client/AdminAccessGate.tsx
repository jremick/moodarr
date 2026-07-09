import { ShieldCheck, SpinnerGap } from "@phosphor-icons/react";
import type { FormEvent } from "react";
import type { ActiveView } from "./navigation";

export type AdminCapability = "unknown" | "available" | "unavailable";

export function AdminAccessGate({
  destination,
  capability,
  token,
  busy,
  onTokenChange,
  onSubmit,
  onReturnToFinder
}: {
  destination: ActiveView;
  capability: AdminCapability;
  token: string;
  busy: boolean;
  onTokenChange: (value: string) => void;
  onSubmit: (event: FormEvent) => Promise<void>;
  onReturnToFinder: () => void;
}) {
  const destinationLabel = destination === "review" ? "Review Queue" : "Admin";
  return (
    <section className="admin-access-gate" aria-labelledby="admin-access-title" aria-busy={capability === "unknown" || busy}>
      <div className="admin-panel">
        <div className="panel-title">
          <ShieldCheck size={18} />
          <h2>Admin Access</h2>
        </div>
        <h2 id="admin-access-title" className="access-gate-heading">
          Unlock {destinationLabel}
        </h2>
        {capability === "unknown" ? (
          <div className="access-gate-check" role="status">
            <SpinnerGap size={18} className="spin" />
            Checking this browser session…
          </div>
        ) : (
          <form onSubmit={(event) => void onSubmit(event)}>
            <p className="panel-copy">Enter the Moodarr admin token. It is exchanged for an HTTP-only same-origin session and is never stored in the browser.</p>
            <label>
              Admin token
              <input
                name="admin-token"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={token}
                onChange={(event) => onTokenChange(event.target.value)}
                placeholder="Enter admin token…"
              />
            </label>
            <div className="access-gate-actions">
              <button type="button" className="secondary-admin-button" onClick={onReturnToFinder} disabled={busy}>
                Return to Finder
              </button>
              <button type="submit" disabled={busy || !token.trim()}>
                {busy ? <SpinnerGap size={16} className="spin" /> : <ShieldCheck size={16} />}
                Unlock {destinationLabel}
              </button>
            </div>
          </form>
        )}
      </div>
    </section>
  );
}
