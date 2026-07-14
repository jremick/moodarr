import { describe, expect, it } from "vitest";
import { finderAvailabilityGroup, summarizeAvailability } from "../src/client/availability";
import type { ItemSummary } from "../src/shared/types";

describe("Finder availability summaries", () => {
  it("names a single availability group", () => {
    expect(summarizeAvailability([{ group: "available_in_plex", count: 4 }], 4)).toEqual({
      total: 4,
      heading: "Available in Plex",
      detail: "4 shown · 4 Plex"
    });
  });

  it("reports a mixed slate without hiding minority groups", () => {
    expect(
      summarizeAvailability(
        [
          { group: "available_in_plex", count: 42 },
          { group: "not_in_plex_requestable", count: 7 },
          { group: "unavailable", count: 1 }
        ],
        30
      )
    ).toEqual({
      total: 50,
      heading: "Mixed availability",
      detail: "30 of 50 loaded · 42 Plex · 7 requestable · 1 unavailable"
    });
  });

  it("reports unchecked request attempts separately from known unavailable titles", () => {
    const attempt: ItemSummary = {
      id: "tv:unchecked",
      mediaType: "tv",
      title: "Unchecked Harbor",
      genres: ["Fantasy"],
      ratings: {},
      posterUrl: "/poster",
      availabilityGroup: "unavailable",
      availabilityExplanation: "Not checked by Seerr.",
      requestAttempt: { available: true, seerrAvailabilityChecked: false },
      matchExplanation: "A warm fantasy series.",
      score: 88
    };

    expect(finderAvailabilityGroup(attempt)).toBe("request_attempt");
    expect(
      summarizeAvailability(
        [
          { group: "not_in_plex_requestable", count: 1 },
          { group: "request_attempt", count: 1 }
        ],
        2
      )
    ).toEqual({
      total: 2,
      heading: "Mixed availability",
      detail: "2 shown · 1 requestable · 1 unchecked"
    });
  });
});
