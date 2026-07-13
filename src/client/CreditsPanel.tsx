import { X } from "@phosphor-icons/react";

export const tmdbAttributionNotice = "This product uses TMDB and the TMDB APIs but is not endorsed, certified, or otherwise approved by TMDB.";

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

        <div className="tmdb-credit">
          <span className="credits-kicker">Data &amp; artwork attribution</span>
          <a href="https://www.themoviedb.org" target="_blank" rel="noreferrer noopener">
            <img
              className="tmdb-logo"
              src="/tmdb-logo.svg"
              width={273}
              height={36}
              alt="The Movie Database (TMDB)"
            />
          </a>
          <p className="tmdb-notice">{tmdbAttributionNotice}</p>
        </div>
      </div>
    </section>
  );
}
