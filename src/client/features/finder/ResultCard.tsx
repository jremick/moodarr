import { BookmarkSimple, Heart, Info, Play, SpinnerGap, ThumbsDown, ThumbsUp } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { availabilityLabels } from "../../availability";
import type { ItemSummary, RequestPreview } from "../../../shared/types";
import { cleanFitExplanation, formatItemDescription, posterMeta, trailerUrl, type RecommendationFeedback } from "./finderModel";

export function ResultCard({
  item,
  index,
  displayScore,
  preview,
  feedback,
  preferredExample,
  busy,
  seasonSelection,
  onSeasonSelection,
  onFeedback,
  onPreferredExample,
  onPreviewRequest,
  onCreateRequest,
  canRequest
}: {
  item: ItemSummary;
  index: number;
  displayScore: number;
  preview: RequestPreview | null;
  feedback?: RecommendationFeedback;
  preferredExample: boolean;
  busy: string;
  seasonSelection: string;
  onSeasonSelection: (value: string) => void;
  onFeedback: (item: ItemSummary, feedback: RecommendationFeedback) => void;
  onPreferredExample: (item: ItemSummary) => void;
  onPreviewRequest: (item: ItemSummary, selectedSeason?: number) => Promise<void>;
  onCreateRequest: () => Promise<void>;
  canRequest: boolean;
}) {
  const [showDescription, setShowDescription] = useState(false);
  const isPreviewForItem = preview?.item.id === item.id;
  const needsSeason = !item.plex?.available && Boolean(item.seerr?.requestable) && item.mediaType === "tv";
  const selectedSeason = Number(seasonSelection);
  const canPreviewRequest = !needsSeason || (Number.isInteger(selectedSeason) && selectedSeason > 0);
  const genres = item.genres.slice(0, 4);
  const plexHref = item.plex?.url ?? item.plex?.appUrl;
  const hasPlexAction = Boolean(item.plex?.available && plexHref);
  const hasRequestAction = !item.plex?.available && Boolean(item.seerr?.requestable);
  const hasSeerrLinkAction = !item.plex?.available && Boolean(item.seerr?.url) && !hasRequestAction;
  const hasTabAction = hasPlexAction || hasRequestAction || hasSeerrLinkAction;
  const [failedPosterUrl, setFailedPosterUrl] = useState<string | null>(null);
  const posterFailed = failedPosterUrl === item.posterUrl;
  const confirmationRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (isPreviewForItem) confirmationRef.current?.focus({ preventScroll: false });
  }, [isPreviewForItem]);

  return (
    <article className={`result-card ${item.availabilityGroup}${hasTabAction ? " has-tab-action" : ""}`} style={{ "--index": index } as CSSProperties}>
      <button
        type="button"
        className={preferredExample ? "preferred-example-button active" : "preferred-example-button"}
        onClick={() => onPreferredExample(item)}
        aria-pressed={preferredExample}
        aria-label={preferredExample ? `Remove ${item.title} as a preferred mood example` : `Mark ${item.title} as a preferred mood example`}
        title={preferredExample ? "Preferred mood example" : "Mark as preferred mood example"}
      >
        <Heart size={18} weight={preferredExample ? "fill" : "regular"} />
      </button>
      <div className="feedback-actions floating-feedback" aria-label={`Feedback for ${item.title}`}>
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
          className={feedback === "maybe" ? "active maybe" : ""}
          onClick={() => onFeedback(item, "maybe")}
          aria-pressed={feedback === "maybe"}
          aria-label={`Maybe ${item.title}`}
          title="Maybe"
        >
          <BookmarkSimple size={15} />
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
      <div className="poster-column">
        <div className="poster-frame">
          {posterFailed ? (
            <div className="poster-placeholder">Poster unavailable</div>
          ) : (
            <img
              src={item.posterUrl}
              alt={`${item.title} poster`}
              width="336"
              height="504"
              loading="lazy"
              decoding="async"
              onError={() => setFailedPosterUrl(item.posterUrl)}
            />
          )}
          <div className={`poster-overlay-actions${item.imdbUrl ? "" : " single-action"}`}>
            <a className="poster-overlay-action trailer-overlay" href={trailerUrl(item)} target="_blank" rel="noreferrer" aria-label={`Find trailer for ${item.title}`}>
              <Play size={14} />
              Trailer
            </a>
            {item.imdbUrl ? (
              <a className="poster-overlay-action imdb-overlay" href={item.imdbUrl} target="_blank" rel="noreferrer" aria-label={`Open ${item.title} on IMDb`}>
                <Info size={14} />
                IMDb
              </a>
            ) : null}
          </div>
        </div>
        <div className="poster-meta" aria-label={posterMeta(item)}>
          {item.year ? <span>{item.year}</span> : null}
          <span>{item.runtimeMinutes ? `${item.runtimeMinutes} min` : "Runtime unknown"}</span>
        </div>
      </div>
      <div className="result-copy">
        <div className="card-title">
          <strong>{item.title}</strong>
        </div>
        <div className={`availability-state ${item.availabilityGroup}`}>
          <span className="availability-dot" aria-hidden="true" />
          <span>{availabilityLabels[item.availabilityGroup]}</span>
        </div>
        <p className="reason">{cleanFitExplanation(item)}</p>
        <ul className="card-facts">
          <li>{genres.length ? genres.join(", ") : "Genres not cached"}</li>
        </ul>
        <button type="button" className="description-toggle" onClick={() => setShowDescription((current) => !current)}>
          {showDescription ? "Hide Description" : "Show Description"}
        </button>
        {showDescription ? <p className="description">{formatItemDescription(item)}</p> : null}
        <div className="card-actions">
          {needsSeason ? (
            <label className="season-field">
              <span>Season</span>
              <input type="number" min="1" max="99" value={seasonSelection} onChange={(event) => onSeasonSelection(event.target.value)} />
            </label>
          ) : null}
          <div className="score-badge" aria-label={`${displayScore} percent match`}>
            {displayScore}%
          </div>
          {item.plex?.available && plexHref ? (
            <a className="plex-tab" href={plexHref} target="_blank" rel="noreferrer" aria-label={`Open ${item.title} in Plex`} title="Open in Plex">
              <PlexGlyph />
            </a>
          ) : null}
          {hasSeerrLinkAction && item.seerr?.url ? (
            <a className="seerr-tab" href={item.seerr.url} target="_blank" rel="noreferrer" aria-label={`Open ${item.title} in Seerr`} title="Open in Seerr">
              <SeerrGlyph />
              <span>Seerr</span>
            </a>
          ) : null}
          {hasRequestAction ? (
            <button
              type="button"
              className="request-tab"
              onClick={() => void onPreviewRequest(item, needsSeason ? selectedSeason : undefined)}
              disabled={busy === "preview" || !canPreviewRequest || !canRequest}
              title={canRequest ? "Preview request in Seerr" : "Requests are disabled for this account"}
            >
              {busy === "preview" && isPreviewForItem ? <SpinnerGap size={15} className="spin" /> : <SeerrGlyph />}
              Request
            </button>
          ) : null}
        </div>
        {hasRequestAction && !canRequest ? <p className="card-capability-note">Requests are disabled for this account.</p> : null}
        {isPreviewForItem ? (
          <div ref={confirmationRef} className="confirm-box compact-confirm" role="status" aria-live="polite" aria-atomic="true" tabIndex={-1}>
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

function SeerrGlyph() {
  return (
    <svg viewBox="0 0 40 40" aria-hidden="true" focusable="false" className="seerr-glyph">
      <circle cx="20" cy="20" r="17" />
      <path d="M12.4 24.4c2 2.3 4.4 3.4 7.5 3.4 3.7 0 5.9-1.4 5.9-3.5 0-1.7-1.1-2.6-3.7-3.1l-4.1-.8c-4.2-.8-6.4-2.9-6.4-6.1 0-4.1 3.5-6.9 8.7-6.9 4 0 7.2 1.3 9.5 3.9l-3.2 3.2c-1.7-1.8-3.7-2.7-6.2-2.7-2.8 0-4.5 1.1-4.5 2.9 0 1.5 1.1 2.3 3.6 2.8l4 .8c4.5.9 6.7 3 6.7 6.4 0 4.4-3.8 7.3-9.7 7.3-4.8 0-8.6-1.7-11.1-4.9l3.4-2.7Z" />
    </svg>
  );
}
