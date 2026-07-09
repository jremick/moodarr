import { describe, expect, it } from "vitest";
import { summarizeAvailability } from "../src/client/availability";

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
});
