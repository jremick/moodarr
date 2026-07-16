import { BookmarkSimple, Heart, Info, Play, SpinnerGap, ThumbsDown, ThumbsUp } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { availabilityLabels } from "../../availability";
import type { ItemSummary, RequestPreview } from "../../../shared/types";
import { cleanFitExplanation, formatItemDescription, posterMeta, requestActionKind, resultAvailabilityFocusId, trailerUrl, type RecommendationFeedback } from "./finderModel";

export function ResultCard({
  item,
  index,
  displayScore,
  preview,
  previewPending,
  feedback,
  preferredExample,
  busy,
  seasonSelection,
  onSeasonSelection,
  onFeedback,
  onPreferredExample,
  onPreviewRequest,
  onCreateRequest,
  onCancelRequestPreview,
  canRequest
}: {
  item: ItemSummary;
  index: number;
  displayScore: number;
  preview: RequestPreview | null;
  previewPending: boolean;
  feedback?: RecommendationFeedback;
  preferredExample: boolean;
  busy: string;
  seasonSelection: string;
  onSeasonSelection: (value: string) => void;
  onFeedback: (item: ItemSummary, feedback: RecommendationFeedback) => void;
  onPreferredExample: (item: ItemSummary) => void;
  onPreviewRequest: (item: ItemSummary, selectedSeason?: number) => Promise<void>;
  onCreateRequest: () => Promise<void>;
  onCancelRequestPreview: () => void;
  canRequest: boolean;
}) {
  const [showDescription, setShowDescription] = useState(false);
  const descriptionId = useId();
  const requestAttemptDescriptionId = useId();
  const isPreviewForItem = preview?.item.id === item.id;
  const isCreatingRequest = busy === "create" && isPreviewForItem;
  const requestAction = requestActionKind(item);
  const isRequestAttempt = requestAction === "attempt";
  const needsSeason = Boolean(requestAction) && item.mediaType === "tv";
  const selectedSeason = Number(seasonSelection);
  const canPreviewRequest = !needsSeason || (Number.isInteger(selectedSeason) && selectedSeason > 0);
  const genres = item.genres.slice(0, 4);
  const hasPlexItemLink = Boolean(item.plex?.url || item.plex?.appUrl);
  const plexHref = item.plex?.url ?? item.plex?.appUrl ?? (item.plex?.available ? "https://app.plex.tv/desktop/" : undefined);
  const hasPlexAction = Boolean(item.plex?.available && plexHref);
  const hasRequestAction = Boolean(requestAction);
  const hasSeerrLinkAction = !item.plex?.available && Boolean(item.seerr?.url) && !hasRequestAction;
  const hasTabAction = hasPlexAction || (hasRequestAction && !isPreviewForItem) || hasSeerrLinkAction;
  const [failedPosterUrl, setFailedPosterUrl] = useState<string | null>(null);
  const posterFailed = failedPosterUrl === item.posterUrl;
  const confirmationRef = useRef<HTMLDivElement | null>(null);
  const requestTriggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (isPreviewForItem) confirmationRef.current?.focus({ preventScroll: false });
  }, [isPreviewForItem]);

  function cancelRequestPreview() {
    onCancelRequestPreview();
    window.requestAnimationFrame(() => requestTriggerRef.current?.focus({ preventScroll: true }));
  }

  return (
    <article
      className={`result-card ${item.availabilityGroup}${hasTabAction ? " has-tab-action" : ""}${isPreviewForItem ? " has-request-preview" : ""}`}
      style={{ "--index": index } as CSSProperties}
    >
      <button
        type="button"
        className={preferredExample ? "preferred-example-button active" : "preferred-example-button"}
        onClick={() => onPreferredExample(item)}
        aria-pressed={preferredExample}
        aria-label={preferredExample ? `Remove ${item.title} as a preferred mood example` : `Mark ${item.title} as a preferred mood example`}
        title={preferredExample ? "Preferred mood example" : "Mark as preferred mood example"}
      >
        <Heart size={18} weight={preferredExample ? "fill" : "regular"} aria-hidden="true" />
      </button>
      {!isPreviewForItem ? <div className="feedback-actions floating-feedback" aria-label={`Feedback for ${item.title}`}>
        <button
          type="button"
          className={feedback === "up" ? "active positive" : ""}
          onClick={() => onFeedback(item, "up")}
          aria-pressed={feedback === "up"}
          aria-label={`More like ${item.title}`}
        >
          <ThumbsUp size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={feedback === "maybe" ? "active maybe" : ""}
          onClick={() => onFeedback(item, "maybe")}
          aria-pressed={feedback === "maybe"}
          aria-label={`Maybe ${item.title}`}
          title="Maybe"
        >
          <BookmarkSimple size={15} aria-hidden="true" />
        </button>
        <button
          type="button"
          className={feedback === "down" ? "active negative" : ""}
          onClick={() => onFeedback(item, "down")}
          aria-pressed={feedback === "down"}
          aria-label={`Less like ${item.title}`}
        >
          <ThumbsDown size={15} aria-hidden="true" />
        </button>
      </div> : null}
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
              <Play size={14} aria-hidden="true" />
              Trailer
            </a>
            {item.imdbUrl ? (
              <a className="poster-overlay-action imdb-overlay" href={item.imdbUrl} target="_blank" rel="noreferrer" aria-label={`Open ${item.title} on IMDb`}>
                <Info size={14} aria-hidden="true" />
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
        {item.availabilityGroup !== "available_in_plex" ? (
          <div id={resultAvailabilityFocusId(item.id)} className={`availability-state ${item.availabilityGroup}`} tabIndex={-1}>
            <span className="availability-dot" aria-hidden="true" />
            <span>{isRequestAttempt ? "Availability unknown" : availabilityLabels[item.availabilityGroup]}</span>
          </div>
        ) : null}
        {isRequestAttempt ? (
          <div id={requestAttemptDescriptionId} className="request-attempt-note">
            <strong>Seerr request attempt</strong>
            <span>Catalog match not checked by Seerr</span>
            <span>Availability not checked</span>
          </div>
        ) : null}
        <p className="reason">{cleanFitExplanation(item)}</p>
        <ul className="card-facts">
          <li>{genres.length ? genres.join(", ") : "Genres not cached"}</li>
        </ul>
        <button
          type="button"
          className="description-toggle"
          onClick={() => setShowDescription((current) => !current)}
          aria-expanded={showDescription}
          aria-controls={descriptionId}
        >
          {showDescription ? "Hide Description" : "Show Description"}
        </button>
        <p id={descriptionId} className="description" hidden={!showDescription}>
          {formatItemDescription(item)}
        </p>
        <div className="card-actions">
          {needsSeason ? (
            <label className="season-field">
              <span>Season</span>
              <input
                name={`season-${encodeURIComponent(item.id)}`}
                type="number"
                inputMode="numeric"
                autoComplete="off"
                min="1"
                max="99"
                required
                value={seasonSelection}
                onChange={(event) => onSeasonSelection(event.target.value)}
              />
            </label>
          ) : null}
          <div className="score-badge" aria-label={`${displayScore} percent match`}>
            {displayScore}%
          </div>
          {item.plex?.available && plexHref ? (
            <a
              className="plex-tab"
              href={plexHref}
              target="_blank"
              rel="noreferrer"
              aria-label={hasPlexItemLink ? `Open Plex: ${item.title}` : `Open Plex home; ${item.title} is available`}
              title={hasPlexItemLink ? "Open in Plex" : "Open Plex home"}
            >
              Open Plex
            </a>
          ) : null}
          {hasSeerrLinkAction && item.seerr?.url ? (
            <a className="seerr-tab" href={item.seerr.url} target="_blank" rel="noreferrer" aria-label={`Open Seerr: ${item.title}`} title="Open in Seerr">
              Open Seerr
            </a>
          ) : null}
          {hasRequestAction && !isPreviewForItem ? (
            <>
              <button
                ref={requestTriggerRef}
                type="button"
                className={isRequestAttempt ? "request-tab request-attempt-tab" : "request-tab"}
                onClick={() => void onPreviewRequest(item, needsSeason ? selectedSeason : undefined)}
                disabled={Boolean(busy) || !canPreviewRequest || !canRequest}
                aria-busy={previewPending}
                aria-describedby={isRequestAttempt ? requestAttemptDescriptionId : undefined}
                aria-label={previewPending
                  ? `${isRequestAttempt ? "Preparing Seerr request attempt preview" : "Preparing Seerr request preview"} for ${item.title}`
                  : isRequestAttempt
                    ? `Preview Seerr request attempt for ${item.title}`
                    : undefined}
                title={canRequest
                  ? previewPending
                    ? "Preparing request preview"
                    : isRequestAttempt
                      ? "Preview Seerr request attempt; catalog match and availability not checked by Seerr"
                      : "Preview request in Seerr"
                  : "Requests are disabled for this account"}
              >
                {previewPending ? <SpinnerGap size={15} className="spin" aria-hidden="true" /> : null}
                {previewPending ? "Preparing…" : isRequestAttempt ? "Try Request" : "Request"}
              </button>
              {previewPending ? (
                <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                  Preparing {isRequestAttempt ? "Seerr request attempt" : "Seerr request"} preview for {item.title}.
                </span>
              ) : null}
            </>
          ) : null}
        </div>
        {hasRequestAction && !canRequest ? <p className="card-capability-note">Requests are disabled for this account.</p> : null}
        {isPreviewForItem ? (
          <div
            ref={confirmationRef}
            className="confirm-box compact-confirm"
            role="region"
            aria-label={`${isRequestAttempt ? "Confirm request attempt" : "Confirm request"} for ${preview.request.title}`}
            aria-busy={isCreatingRequest}
            tabIndex={-1}
          >
            <strong>{preview.confirmationPhrase}</strong>
            <span>
              {preview.canRequest
                ? isRequestAttempt
                  ? "Ready to attempt Seerr request"
                  : "Ready to request"
                : preview.blockedReason ?? "Request blocked"}: {preview.request.title}
              {preview.request.seasons?.length ? `, season ${preview.request.seasons.join(", ")}` : ""}
            </span>
            {preview.canRequest && isRequestAttempt ? (
              <span className="request-attempt-warning">
                Catalog match and availability have not been checked by Seerr. Moodarr will send TMDB {preview.request.mediaId}. Confirm the resulting title in Seerr.
              </span>
            ) : null}
            <div className="confirm-actions">
              {preview.canRequest ? (
                <button type="button" onClick={() => void onCreateRequest()} disabled={Boolean(busy)} aria-busy={isCreatingRequest}>
                  {isCreatingRequest ? <SpinnerGap size={15} className="spin" aria-hidden="true" /> : null}
                  {isCreatingRequest ? "Requesting…" : isRequestAttempt ? "Confirm Request Attempt" : "Confirm Request"}
                </button>
              ) : null}
              <button type="button" className="confirm-cancel" onClick={cancelRequestPreview} disabled={Boolean(busy)}>
                {isRequestAttempt ? "Cancel Request Attempt" : "Cancel Request"}
              </button>
              {isCreatingRequest ? (
                <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
                  Requesting {preview.request.title} in Seerr.
                </span>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </article>
  );
}
