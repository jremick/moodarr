import { describe, expect, it } from "vitest";
import { parseSeasonSelection, requestPreviewMatchesSeasons } from "../src/client/features/finder/seasonSelection";
import type { RequestPreview } from "../src/shared/types";

describe("explicit TV season selection", () => {
  it("normalizes reordered and repeated entries to an exact sorted set", () => {
    expect(parseSeasonSelection(" 3, 1, 03, 2 ")).toEqual([1, 2, 3]);
    expect(parseSeasonSelection("1000")).toEqual([1000]);
  });

  it.each(["", " ", "0", "-1", "1001", "2.5", "1e2", "0x2", "+2", "1-3", "1,,2", "1,", ",1", "1 2", "all"])("rejects ambiguous or invalid input %j", (input) => {
    expect(parseSeasonSelection(input)).toBeNull();
  });

  it("enforces the API entry bound before deduplication", () => {
    expect(parseSeasonSelection(Array.from({ length: 100 }, (_, index) => index + 1).join(","))).toHaveLength(100);
    expect(parseSeasonSelection(Array(101).fill("1").join(","))).toBeNull();
  });

  it("requires a new preview when any confirmed season changes or becomes invalid", () => {
    const preview = tvPreview([1, 3]);
    expect(requestPreviewMatchesSeasons(preview, "3, 1, 1")).toBe(true);
    for (const selection of ["1", "1, 2, 3", "2, 3", "", "1,,3"]) {
      expect(requestPreviewMatchesSeasons(preview, selection)).toBe(false);
    }
    expect(requestPreviewMatchesSeasons(tvPreview([]), "")).toBe(false);
  });

  it("does not impose TV selection on movie previews", () => {
    const preview = tvPreview([]);
    preview.request.mediaType = "movie";
    expect(requestPreviewMatchesSeasons(preview, "")).toBe(true);
  });
});

function tvPreview(seasons: number[]): RequestPreview {
  return {
    canRequest: true, requiresConfirmation: true, confirmationPhrase: "REQUEST TEST SERIES", confirmationToken: "a".repeat(64),
    requestMode: "attempt", seerrAvailabilityChecked: false,
    request: { mediaType: "tv", mediaId: 1, seasons, title: "Test series" },
    item: { id: "tv-1", mediaType: "tv", title: "Test series", genres: [], ratings: {}, posterUrl: "/fixture.svg", availabilityGroup: "not_in_plex_requestable", availabilityExplanation: "Requestable", matchExplanation: "Fixture", score: 1 }
  };
}
