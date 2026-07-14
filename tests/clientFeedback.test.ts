import { describe, expect, it } from "vitest";
import { __appTestInternals } from "../src/client/App";
import { markRequestCreated, resultAvailabilityFocusId } from "../src/client/features/finder/finderModel";
import type { ConfigStatusResponse, ItemSummary } from "../src/shared/types";

function item(id: string, title: string, genres: string[], score: number): ItemSummary {
  return {
    id,
    mediaType: "movie",
    title,
    genres,
    ratings: {},
    posterUrl: "",
    availabilityGroup: "available_in_plex",
    availabilityExplanation: "Available.",
    matchExplanation: "A plausible match.",
    score
  };
}

describe("client recommendation feedback helpers", () => {
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
      showRatedItems: false
    });
  });

  it("lets a few hearted examples push similar items ahead locally", () => {
    const preferred = item("preferred", "Harbor Comfort", ["Comedy", "Family"], 48);
    const similar = item("similar", "Harbor Lights", ["Comedy", "Family"], 70);
    const offMood = item("off-mood", "Steel Siege", ["Action", "War"], 82);

    const ranked = __appTestInternals.applyFeedbackRanking([preferred, similar, offMood], {}, { preferred: true }, {
      preferred: preferred.score,
      similar: similar.score,
      "off-mood": offMood.score
    });

    expect(ranked[0]?.id).toBe("similar");
    expect(ranked.map((entry) => entry.id)).toEqual(["similar", "preferred", "off-mood"]);
  });

  it("preserves current result order when an item is only thumbed up", () => {
    const first = item("first", "Steel Siege", ["Action", "War"], 82);
    const second = item("second", "Harbor Lights", ["Comedy", "Family"], 70);

    const visible = __appTestInternals.visibleResultsFromPool([first, second], { second: "up" }, true, 2);

    expect(visible.map((entry) => entry.id)).toEqual(["first", "second"]);
  });

  it("summarizes newly hearted examples in the draft prompt", () => {
    const selected = __appTestInternals.nextPreferredExampleState({}, "preferred");
    const titles = __appTestInternals.nextPreferredExampleTitleState({}, item("preferred", "Harbor Comfort", ["Comedy"], 80), selected);
    const summary = __appTestInternals.summarizeFeedbackSelection({}, {}, selected, titles);

    expect(summary).toBe("Use Harbor Comfort as a preferred example of the mood.");
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
