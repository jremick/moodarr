import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReviewQueueView } from "../src/client/features/review/ReviewQueueView";
import type { QueryReviewQueueResponse, QueryReviewStatus } from "../src/shared/types";

const reviewedQueue: QueryReviewQueueResponse = {
  status: "reviewed",
  count: 1,
  items: [
    {
      id: "review-1",
      sessionId: "session-1",
      query: "A quiet reviewed query",
      watchContext: "solo",
      resultCount: 1,
      moodFitRating: 3,
      moodFeedbackText: "A little too bleak",
      reviewedAt: "2026-07-13T02:00:00.000Z",
      createdAt: "2026-07-13T01:00:00.000Z",
      results: [
        {
          id: "result-1",
          title: "Old Review Result",
          mediaType: "movie",
          year: 2024,
          genres: ["Drama"],
          score: 0.84,
          matchExplanation: "Quiet and reflective.",
          availabilityGroup: "available_in_plex"
        }
      ]
    }
  ]
};

function renderReviewQueue({
  queue = reviewedQueue,
  status = "reviewed",
  loadState = { status: "reviewed", phase: "loaded" },
  busy = ""
}: {
  queue?: QueryReviewQueueResponse | null;
  status?: QueryReviewStatus;
  loadState?: { status: QueryReviewStatus | null; phase: "idle" | "loading" | "loaded" | "error" };
  busy?: string;
} = {}) {
  return renderToStaticMarkup(
    createElement(ReviewQueueView, {
      queue,
      status,
      loadState,
      setStatus: () => undefined,
      drafts: {},
      ratings: {},
      busy,
      refreshReviewQueue: async () => undefined,
      updateReviewDraft: () => undefined,
      updateReviewRating: () => undefined,
      submitReviewFeedback: async () => undefined
    })
  );
}

describe("Review Queue states", () => {
  it("treats a newly selected status as loading instead of announcing a false error", () => {
    const markup = renderReviewQueue({ queue: reviewedQueue, status: "pending" });

    expect(markup).not.toContain("A quiet reviewed query");
    expect(markup).not.toContain("Old Review Result");
    expect(markup).toContain("Loading queue…");
    expect(markup).not.toContain("Queue unavailable.");
    expect(markup).toContain('role="status"');
    expect(markup).toContain('aria-live="polite"');
  });

  it("replaces stale queue content with an announced loading state during refresh", () => {
    const markup = renderReviewQueue({ queue: reviewedQueue, busy: "review-refresh" });

    expect(markup).not.toContain("A quiet reviewed query");
    expect(markup).toContain("Loading queue…");
    expect(markup).toContain('aria-busy="true"');
  });

  it("distinguishes unloaded and empty queues", () => {
    const unavailableMarkup = renderReviewQueue({ queue: null, status: "pending", loadState: { status: "pending", phase: "error" } });
    const emptyMarkup = renderReviewQueue({
      queue: { status: "pending", count: 0, items: [] },
      status: "pending",
      loadState: { status: "pending", phase: "loaded" }
    });

    expect(unavailableMarkup).toContain("Queue unavailable. Refresh to try again.");
    expect(unavailableMarkup).not.toContain("No queries in this view.");
    expect(emptyMarkup).toContain("No queries in this view.");
    expect(emptyMarkup).not.toContain("Queue unavailable.");
  });

  it("keeps its live loading status outside the busy results region", () => {
    const markup = renderReviewQueue({ queue: reviewedQueue, busy: "review-refresh", loadState: { status: "reviewed", phase: "loading" } });
    const statusIndex = markup.indexOf('role="status"');
    const busyIndex = markup.indexOf('aria-busy="true"');

    expect(statusIndex).toBeGreaterThan(-1);
    expect(busyIndex).toBeGreaterThan(statusIndex);
  });

  it("gives each mood-fit rating a descriptive accessible name", () => {
    const markup = renderReviewQueue();

    expect(markup).toContain('aria-label="1 of 5: Poor mood fit"');
    expect(markup).toContain('aria-label="3 of 5: Mixed mood fit"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('name="review-note-review-1"');
    expect(markup).toContain('autoComplete="off"');
  });
});
