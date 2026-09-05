import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { __appTestInternals } from "../src/client/App";
import { ResultCard } from "../src/client/features/finder/ResultCard";
import { describeAppliedCriteria, hiddenFeedbackCount, markRequestCreated, resultAvailabilityFocusId } from "../src/client/features/finder/finderModel";
import type { ConfigStatusResponse, ItemSummary } from "../src/shared/types";

function item(id: string, title: string, genres: string[], score: number): ItemSummary {
  return {
    id,
    mediaType: "movie",
    title,
    genres,
    ratings: {},
    posterUrl: "/fixture-poster.svg",
    availabilityGroup: "available_in_plex",
    availabilityExplanation: "Available.",
    matchExplanation: "A plausible match.",
    score
  };
}

describe("client recommendation feedback helpers", () => {
  it("describes the applied availability and both runtime bounds", () => {
    expect(describeAppliedCriteria({ mediaTypes: ["tv"], minRuntimeMinutes: 20, maxRuntimeMinutes: 40, availability: ["available_in_plex"] }, 15, "group")).toBe("Together · 15 requested · TV · Any genre · 20-40 min · Plex only");
  });

  it("keeps preferred mood examples separate from thumbs feedback in the search context", () => {
    const context = __appTestInternals.buildFeedbackContext(
      { liked: "up", maybe: "maybe", disliked: "down" },
      { preferred: true },
      false
    );

    expect(context).toMatchObject({
      preferredExampleItemIds: ["preferred"],
      moreLikeItemIds: ["liked"],
      maybeItemIds: ["maybe"],
      lessLikeItemIds: ["disliked"],
      hiddenItemIds: ["liked", "disliked"],
      showRatedItems: false,
      persistence: "already_recorded"
    });
  });

  it("preserves authoritative result order, scores and ranks after feedback filters the slate", () => {
    const offMood = item("off-mood", "Steel Siege", ["Action", "War"], 82);
    const preferred = item("preferred", "Harbor Comfort", ["Comedy", "Family"], 48);
    const similar = item("similar", "Harbor Lights", ["Comedy", "Family"], 70);
    const responseItems = [offMood, preferred, similar];
    const responseRanks = __appTestInternals.responseRankIndexByItemId(responseItems);
    const visible = __appTestInternals.visibleResultsFromPool(responseItems, { "off-mood": "down", preferred: "maybe" }, false, 3);

    expect(visible).toEqual([preferred, similar]);
    expect(visible[0]).toBe(preferred);
    expect(visible[1]).toBe(similar);
    expect(responseItems.map((entry) => entry.score)).toEqual([82, 48, 70]);
    expect(responseRanks.get(offMood.id)).toBe(0);
    expect(responseRanks.get(preferred.id)).toBe(1);
    expect(responseRanks.get(similar.id)).toBe(2);
  });

  it("preserves current result order when an item is only thumbed up", () => {
    const first = item("first", "Steel Siege", ["Action", "War"], 82);
    const second = item("second", "Harbor Lights", ["Comedy", "Family"], 70);

    const visible = __appTestInternals.visibleResultsFromPool([first, second], { second: "up" }, true, 2);

    expect(visible.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("shows negative ratings for undo when Show rated items is enabled", () => {
    const items = [item("liked", "Harbor Comfort", [], 80), item("disliked", "Steel Siege", [], 70), item("maybe", "Quiet Nights", [], 60)];
    const feedback = { liked: "up", disliked: "down", maybe: "maybe" } as const;
    expect(__appTestInternals.visibleResultsFromPool(items, feedback, true, 3)).toEqual(items);
    expect(hiddenFeedbackCount(feedback, true)).toBe(0);
    expect(__appTestInternals.buildFeedbackContext(feedback, {}, true).hiddenItemIds).toEqual([]);
    expect(__appTestInternals.visibleResultsFromPool(items, feedback, false, 3)).toEqual([items[2]]);
    expect(hiddenFeedbackCount(feedback, false)).toBe(2);
  });

  it("summarizes newly hearted examples in the draft prompt", () => {
    const selected = { preferred: true };
    const titles = { preferred: "Harbor Comfort" };
    const summary = __appTestInternals.summarizeFeedbackSelection({}, {}, selected, titles);

    expect(summary).toBe("Use Harbor Comfort as a preferred example of the mood.");
  });

  it("disables pending card controls while preserving the last acknowledged selection", () => {
    const renderCard = (feedbackPending: boolean) => renderToStaticMarkup(createElement(ResultCard, {
      item: item("first", "Harbor Comfort", ["Comedy"], 80),
      animationIndex: 0,
      preview: null,
      previewPending: false,
      feedback: "up",
      feedbackPending,
      preferredExample: false,
      busy: "",
      seasonSelection: "",
      onSeasonSelection: () => undefined,
      onFeedback: () => undefined,
      onPreferredExample: () => undefined,
      onPreviewRequest: async () => undefined,
      onCreateRequest: async () => undefined,
      onCancelRequestPreview: () => undefined,
      canRequest: true
    }));
    const pending = renderCard(true);
    const ready = renderCard(false);
    expect(pending).toMatch(/<article[^>]+aria-busy="true"/);
    expect(pending.match(/<button[^>]+disabled=""/g)).toHaveLength(4);
    expect(pending).toMatch(/<button[^>]+aria-pressed="true"[^>]+aria-label="More like Harbor Comfort"/);
    expect(pending).toMatch(/<button[^>]+aria-pressed="false"[^>]+aria-label="Mark Harbor Comfort as a preferred mood example"/);
    expect(ready).not.toContain('disabled=""');
  });

  it("updates a successfully requested item without changing unrelated cards", () => {
    const requestable = {
      ...item("requestable", "Harbor Mystery", ["Mystery"], 72),
      availabilityGroup: "not_in_plex_requestable" as const,
      matchExplanation: "A warm mystery. Not in Plex yet, but it appears requestable.",
      seerr: { status: "unknown" as const, requestable: true, url: "https://seerr.example/movie/1" }
    };
    const untouched = item("available", "Harbor Comfort", ["Comedy"], 80);

    const updated = markRequestCreated([requestable, untouched], requestable.id, "pending");

    expect(updated[0]).toMatchObject({
      availabilityGroup: "already_requested",
      availabilityExplanation: "Not found in Plex. Seerr request status is pending.",
      matchExplanation: "A warm mystery. A request is now active in Seerr.",
      seerr: { status: "requested", requestStatus: "pending", requestable: false, url: "https://seerr.example/movie/1" }
    });
    expect(updated[1]).toBe(untouched);
  });

  it("creates a stable focus target for result availability updates", () => {
    expect(resultAvailabilityFocusId("movie:seerr/2493")).toBe("result-availability-movie%3Aseerr%2F2493");
    expect(resultAvailabilityFocusId("movie:seerr/2494")).not.toBe(resultAvailabilityFocusId("movie:seerr/2493"));
  });

  it("does not crash if an older server returns a numeric request status", () => {
    const requestable = {
      ...item("requestable", "Harbor Mystery", ["Mystery"], 72),
      availabilityGroup: "not_in_plex_requestable" as const,
      seerr: { status: "unknown" as const, requestable: true }
    };

    expect(markRequestCreated([requestable], requestable.id, 2)[0]).toMatchObject({
      availabilityGroup: "already_requested",
      seerr: { status: "requested", requestStatus: "2", requestable: false }
    });
  });

  it("blocks protected Finder only when neither admin nor a Plex user is authenticated", () => {
    const protectedStatus = {
      admin: { authRequired: true },
      auth: { plexAuthEnabled: true }
    } as ConfigStatusResponse;

    expect(__appTestInternals.isFinderAccessBlocked(protectedStatus, "unavailable", { authenticated: false, plexAuthEnabled: true, allowNewPlexUsers: true })).toBe(true);
    expect(__appTestInternals.isFinderAccessBlocked(protectedStatus, "available", null)).toBe(false);
    expect(__appTestInternals.isFinderAccessBlocked(protectedStatus, "unavailable", { authenticated: true, plexAuthEnabled: true, allowNewPlexUsers: true })).toBe(false);
  });
});
