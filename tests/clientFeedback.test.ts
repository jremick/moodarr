import { describe, expect, it } from "vitest";
import { __appTestInternals } from "../src/client/App";
import type { ItemSummary } from "../src/shared/types";

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
});
