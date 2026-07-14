import { X } from "@phosphor-icons/react";

export const betaDataBoundary =
  "The official beta uses Plex and the local catalog for discovery. Seerr is limited to request status and explicitly confirmed request creation; Moodarr does not call TMDB or serve TMDB artwork.";

type CreditsPanelProps = {
  onClose: () => void;
};

export function CreditsPanel({ onClose }: CreditsPanelProps) {
  return (
    <section id="credits-panel" className="credits-panel" aria-labelledby="credits-title" tabIndex={-1}>
      <header className="credits-panel-header">
        <div>
          <span className="credits-kicker">About &amp; credits</span>
          <h2 id="credits-title">Open source, built for your own library.</h2>
        </div>
        <button className="credits-close" type="button" onClick={onClose} aria-label="Close About and credits" title="Close">
          <X size={18} aria-hidden="true" />
        </button>
      </header>

      <div className="credits-grid">
        <div className="credits-about">
          <h3>Moodarr</h3>
          <p>Find what to watch across your Plex library and request missing titles through Seerr.</p>
          <p className="credits-meta">Open-source software licensed under the Apache License 2.0.</p>
        </div>

        <div className="credits-boundary">
          <span className="credits-kicker">Beta data boundary</span>
          <p className="credits-boundary-copy">{betaDataBoundary}</p>
          <p className="credits-meta">Locally supplied TMDB IDs may be retained only as interoperability identifiers for Seerr requests.</p>
        </div>
      </div>
    </section>
  );
}
