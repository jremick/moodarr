import { describe, expect, it } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository, type IngestMediaRecord } from "../src/server/db/mediaRepository";
import { scoreLibraryCandidates } from "../src/server/recommendation/scoring";
import type { ItemDetail, SearchFilters } from "../src/shared/types";

describe("recommendation year filters", () => {
  it("rejects an unknown year only when an explicit year bound is present", () => {
    const unknownYear = candidate("unknown", undefined);
    const inRange = candidate("in-range", 2005);
    const tooOld = candidate("too-old", 1995);
    const items = [unknownYear, inRange, tooOld];

    expect(resultIds(scoreLibraryCandidates(items, "warm drama", {}, "solo", { allItems: items }))).toContain(unknownYear.id);
    expect(resultIds(scoreLibraryCandidates(items, "warm drama", { minYear: 2000 }, "solo", { allItems: items }))).toEqual([inRange.id]);
    expect(resultIds(scoreLibraryCandidates(items, "warm drama", { maxYear: 2000 }, "solo", { allItems: items }))).toEqual([tooOld.id]);
  });

  it("applies the same unknown-year rule to every catalog candidate query", () => {
    const db = createDatabase(":memory:");
    try {
      const repository = new MediaRepository(db);
      const ids = new Map(
        [
          record("Unknown Harbor", undefined),
          record("Modern Harbor", 2024),
          record("Classic Harbor", 1994)
        ].map((entry) => [entry.title, repository.upsert(entry)])
      );

      const unfiltered = repository.catalogRankCandidateIds({}, 20);
      expect(unfiltered).toEqual(expect.arrayContaining([...ids.values()]));

      assertCatalogCandidateMethods(repository, { minYear: 2020 }, [ids.get("Modern Harbor")!]);
      assertCatalogCandidateMethods(repository, { maxYear: 2000 }, [ids.get("Classic Harbor")!]);
    } finally {
      db.close();
    }
  });
});

function candidate(id: string, year: number | undefined): ItemDetail {
  return {
    id,
    mediaType: "movie",
    title: `Candidate ${id}`,
    year,
    runtimeMinutes: 100,
    summary: "A warm, thoughtful drama about friendship.",
    genres: ["Drama"],
    ratings: { critic: 80 },
    posterUrl: "",
    availabilityGroup: "available_in_plex",
    availabilityExplanation: "Available in Plex.",
    matchExplanation: "Candidate.",
    score: 0,
    cast: [],
    directors: [],
    externalIds: {},
    plex: { available: true }
  };
}

function record(title: string, year: number | undefined): IngestMediaRecord {
  return {
    mediaType: "movie",
    title,
    year,
    summary: "A quiet harbor drama with a complete catalog summary.",
    genres: ["Drama"],
    plex: { ratingKey: title, available: true }
  };
}

function resultIds(result: ReturnType<typeof scoreLibraryCandidates>) {
  return result.results.map((item) => item.id);
}

function assertCatalogCandidateMethods(repository: MediaRepository, filters: SearchFilters, expectedIds: string[]) {
  expect(repository.catalogSearchCandidateIds("harbor", filters, 20)).toEqual(expectedIds);
  expect(repository.catalogRankCandidateIds(filters, 20)).toEqual(expectedIds);
  expect(repository.availabilityCandidateIds(["available_in_plex"], filters, 20)).toEqual(expectedIds);
  expect(repository.filteredCandidateIds(filters, 20, { requireSummary: true })).toEqual(expectedIds);
}
