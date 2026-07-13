import { ArrowClockwise, CheckCircle, ListChecks, SpinnerGap, Star } from "@phosphor-icons/react";
import { useRef, type ReactNode } from "react";
import { availabilityLabels } from "../../availability";
import type { QueryReviewQueueItem, QueryReviewQueueResponse, QueryReviewStatus } from "../../../shared/types";
import { displayMatchScore } from "../finder/finderModel";

const reviewStatuses: QueryReviewStatus[] = ["pending", "reviewed", "all"];

export function ReviewQueueView({
  queue,
  status,
  setStatus,
  drafts,
  ratings,
  busy,
  refreshReviewQueue,
  updateReviewDraft,
  updateReviewRating,
  submitReviewFeedback
}: {
  queue: QueryReviewQueueResponse | null;
  status: QueryReviewStatus;
  setStatus: (status: QueryReviewStatus) => void;
  drafts: Record<string, string>;
  ratings: Record<string, number>;
  busy: string;
  refreshReviewQueue: () => Promise<void>;
  updateReviewDraft: (id: string, value: string) => void;
  updateReviewRating: (id: string, value: number) => void;
  submitReviewFeedback: (item: QueryReviewQueueItem) => Promise<void>;
}) {
  const items = queue?.items ?? [];
  const reviewTabRefs = useRef<Partial<Record<QueryReviewStatus, HTMLButtonElement | null>>>({});

  function moveReviewTab(current: QueryReviewStatus, offset: number) {
    const currentIndex = reviewStatuses.indexOf(current);
    const nextStatus = reviewStatuses[(currentIndex + offset + reviewStatuses.length) % reviewStatuses.length];
    setStatus(nextStatus);
    reviewTabRefs.current[nextStatus]?.focus();
  }

  return (
    <section id="review-view" className="review-queue-layout" tabIndex={-1}>
      <section className="admin-panel review-header-panel">
        <PanelTitle icon={<ListChecks size={18} />} title="Review Queue" />
        <div className="review-toolbar">
          <div className="review-status-tabs" role="tablist" aria-label="Review queue status">
            {reviewStatuses.map((entry) => (
              <button
                key={entry}
                ref={(element) => {
                  reviewTabRefs.current[entry] = element;
                }}
                id={`review-tab-${entry}`}
                type="button"
                role="tab"
                aria-selected={status === entry}
                aria-controls="review-queue-panel"
                tabIndex={status === entry ? 0 : -1}
                className={status === entry ? "tab-button active" : "tab-button"}
                disabled={Boolean(busy)}
                onClick={() => setStatus(entry)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                    event.preventDefault();
                    moveReviewTab(entry, 1);
                  } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                    event.preventDefault();
                    moveReviewTab(entry, -1);
                  } else if (event.key === "Home" || event.key === "End") {
                    event.preventDefault();
                    const nextStatus = event.key === "Home" ? reviewStatuses[0] : reviewStatuses[reviewStatuses.length - 1];
                    setStatus(nextStatus);
                    reviewTabRefs.current[nextStatus]?.focus();
                  }
                }}
              >
                {reviewStatusLabel(entry)}
              </button>
            ))}
          </div>
          <button type="button" className="tab-button" onClick={() => void refreshReviewQueue()} disabled={Boolean(busy)}>
            {busy === "review-refresh" ? <SpinnerGap size={16} className="spin" /> : <ArrowClockwise size={16} />}
            Refresh
          </button>
        </div>
        <div className="metric-grid review-metrics">
          <Metric label="Queue" value={queue?.count ?? 0} />
          <Metric label="Loaded" value={items.length} />
        </div>
      </section>

      <section id="review-queue-panel" className="review-list" role="tabpanel" aria-labelledby={`review-tab-${status}`} tabIndex={0}>
        {busy === "review-refresh" && !queue ? <div className="empty-results">Loading queue</div> : null}
        {busy !== "review-refresh" && items.length === 0 ? <div className="empty-results">No queries in this view</div> : null}
        {items.map((item) => (
          <ReviewQueueCard
            key={item.id}
            item={item}
            draft={drafts[item.id] ?? ""}
            rating={ratings[item.id] ?? item.moodFitRating ?? 0}
            busy={busy}
            onDraftChange={updateReviewDraft}
            onRatingChange={updateReviewRating}
            onSubmit={submitReviewFeedback}
          />
        ))}
      </section>
    </section>
  );
}

function ReviewQueueCard({
  item,
  draft,
  rating,
  busy,
  onDraftChange,
  onRatingChange,
  onSubmit
}: {
  item: QueryReviewQueueItem;
  draft: string;
  rating: number;
  busy: string;
  onDraftChange: (id: string, value: string) => void;
  onRatingChange: (id: string, value: number) => void;
  onSubmit: (item: QueryReviewQueueItem) => Promise<void>;
}) {
  const isSaving = busy === `review-save:${item.id}`;
  return (
    <article className="review-item">
      <header className="review-item-header">
        <div>
          <span className="review-date">{formatDate(item.createdAt)}</span>
          <h2>{item.query}</h2>
          {item.optimizedQuery && item.optimizedQuery !== item.query ? <p>{item.optimizedQuery}</p> : null}
        </div>
        <div className="review-meta">
          <span>{item.watchContext === "group" ? "Together" : "For Me"}</span>
          <span>{item.resultCount} results</span>
          {item.reviewedAt ? <span>Reviewed {formatDate(item.reviewedAt)}</span> : null}
        </div>
      </header>

      <ol className="review-results">
        {item.results.slice(0, 6).map((result, index) => (
          <li key={result.id}>
            <span>{displayMatchScore(result, index, item.results)}%</span>
            <strong>
              {result.title}
              {result.year ? ` (${result.year})` : ""}
            </strong>
            <em>{result.genres.slice(0, 3).join(", ") || availabilityLabels[result.availabilityGroup]}</em>
          </li>
        ))}
      </ol>

      <div className="review-feedback-row">
        <div className="review-rating" role="group" aria-label={`Mood fit rating for ${item.query}`}>
          {[1, 2, 3, 4, 5].map((value) => (
            <button
              key={value}
              type="button"
              className={rating === value ? "active" : ""}
              onClick={() => onRatingChange(item.id, value)}
              disabled={Boolean(busy)}
              aria-pressed={rating === value}
              title={reviewRatingLabel(value)}
            >
              <Star size={14} weight={rating >= value ? "fill" : "regular"} />
              {value}
            </button>
          ))}
        </div>
        <label className="review-note">
          <span>What missed the mood</span>
          <textarea rows={3} maxLength={1000} value={draft} onChange={(event) => onDraftChange(item.id, event.target.value)} disabled={Boolean(busy)} />
        </label>
        <button type="button" className="review-save-button" onClick={() => void onSubmit(item)} disabled={Boolean(busy) || rating < 1}>
          {isSaving ? <SpinnerGap size={16} className="spin" /> : <CheckCircle size={16} />}
          Save review
        </button>
      </div>
    </article>
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

function Metric({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function formatDate(value?: string) {
  if (!value) return "not synced";
  return new Date(value).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function reviewStatusLabel(status: QueryReviewStatus) {
  if (status === "pending") return "Pending";
  if (status === "reviewed") return "Reviewed";
  return "All";
}

function reviewRatingLabel(value: number) {
  if (value <= 1) return "Poor mood fit";
  if (value === 2) return "Weak mood fit";
  if (value === 3) return "Mixed mood fit";
  if (value === 4) return "Good mood fit";
  return "Excellent mood fit";
}
