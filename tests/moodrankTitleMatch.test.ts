import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository, type IngestMediaRecord, type StoredMediaFeature } from "../src/server/db/mediaRepository";
import { fixturePlexItems } from "../src/server/fixtures/media";
import { buildMediaFeatureDocument } from "../src/server/recommendation/features";
import { scoreLibraryCandidates } from "../src/server/recommendation/scoring";

const databases: DatabaseSync[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

const funnyAdventure: IngestMediaRecord = {
  mediaType: "movie",
  title: "Funny Adventure",
  year: 1982,
  runtimeMinutes: 94,
  summary: "A light comedy about a courier who keeps stumbling into jokes on a quiet countryside road.",
  genres: ["Comedy", "Adventure"],
  posterPath: "fixture://funny-adventure",
  externalIds: { tmdb: 1982001 },
  seerr: {
    tmdbId: 1982001,
    status: "unknown",
    requestable: true,
    url: "http://fixture-seerr.local/movie/1982001"
  }
};

function rankQuery(records: IngestMediaRecord[], query: string) {
  const db = createDatabase(":memory:");
  databases.push(db);
  const repository = new MediaRepository(db);
  repository.upsertMany(records);
  const items = repository.list();
  const features = new Map<string, StoredMediaFeature>(items.map((item) => {
    const feature = buildMediaFeatureDocument(item);
    return [item.id, { ...feature, featureVersion: feature.version }];
  }));
  return scoreLibraryCandidates(items, query, {}, "solo", { allItems: items, features });
}

describe("mood query title matching", () => {
  const library = [...fixturePlexItems, funnyAdventure];

  it("does not rank an unowned title hit above in-library comedies for a mood query", () => {
    const scored = rankQuery(library, "something funny, under 2 hours");
    const ranked = scored.results.map((item) => item.title);
    const funnyRank = ranked.indexOf("Funny Adventure");
    const inLibrary = scored.results.filter((item) => item.availabilityGroup === "available_in_plex");

    expect(funnyRank).toBeGreaterThan(0);
    expect(ranked[0]).not.toBe("Funny Adventure");
    expect(inLibrary.length).toBeGreaterThan(0);
    for (const item of inLibrary) {
      expect(ranked.indexOf(item.title)).toBeLessThan(funnyRank);
    }
    expect(scored.results.find((item) => item.title === "Funny Adventure")?.matchExplanation ?? "").not.toMatch(/direct title match|title hits directly/i);
    expect(scored.results.every((item) => !item.runtimeMinutes || item.runtimeMinutes <= 120)).toBe(true);
  });

  it("still boosts a quoted title and a query that names the title", () => {
    const quoted = rankQuery(library, "\"Funny Adventure\"");
    const named = rankQuery(library, "Funny Adventure");

    expect(quoted.results[0]?.title).toBe("Funny Adventure");
    expect(quoted.results[0]?.matchExplanation).toMatch(/direct title match|title hits directly/i);
    expect(named.results[0]?.title).toBe("Funny Adventure");
    expect(named.results[0]?.matchExplanation).toMatch(/direct title match|title hits directly/i);
  });

  it("keeps a distinctive title lookup such as Everest", () => {
    const everest: IngestMediaRecord = {
      mediaType: "movie",
      title: "Everest",
      year: 2015,
      runtimeMinutes: 121,
      summary: "Climbers fight to survive a dangerous expedition on Mount Everest.",
      genres: ["Adventure", "Drama"],
      posterPath: "fixture://everest",
      externalIds: { tmdb: 253412 },
      plex: {
        ratingKey: "fixture-plex-everest",
        guid: "tmdb://253412",
        libraryTitle: "Movies",
        libraryType: "movie",
        available: true
      }
    };
    const scored = rankQuery([everest, funnyAdventure], "adventure everest");
    const match = scored.results.find((item) => item.title === "Everest");

    expect(scored.results[0]?.title).toBe("Everest");
    expect(match?.matchExplanation).toMatch(/direct title match|title hits directly/i);
  });

  it("ranks a similar in-library comedy above a slightly stronger unowned one", () => {
    const owned: IngestMediaRecord = {
      mediaType: "movie",
      title: "Quiet Punchline",
      year: 2019,
      runtimeMinutes: 99,
      summary: "A funny, warm comedy about neighbors who host a tiny joke night.",
      genres: ["Comedy"],
      ratings: { critic: 70, audience: 68 },
      posterPath: "fixture://quiet-punchline",
      externalIds: { tmdb: 2019002 },
      plex: {
        ratingKey: "fixture-plex-punchline",
        guid: "tmdb://2019002",
        libraryTitle: "Movies",
        libraryType: "movie",
        available: true
      }
    };
    const unowned: IngestMediaRecord = {
      mediaType: "movie",
      title: "County Gag Reel",
      year: 2018,
      runtimeMinutes: 99,
      summary: "A funny, warm comedy about neighbors who host a tiny joke night.",
      genres: ["Comedy"],
      ratings: { critic: 86, audience: 84 },
      posterPath: "fixture://county-gag-reel",
      externalIds: { tmdb: 2018002 },
      seerr: {
        tmdbId: 2018002,
        status: "unknown",
        requestable: true,
        url: "http://fixture-seerr.local/movie/2018002"
      }
    };
    const scored = rankQuery([owned, unowned], "something funny, under 2 hours");
    const ownedResult = scored.results.find((item) => item.title === "Quiet Punchline");
    const unownedResult = scored.results.find((item) => item.title === "County Gag Reel");

    expect(ownedResult?.availabilityGroup).toBe("available_in_plex");
    expect(unownedResult?.availabilityGroup).toBe("not_in_plex_requestable");
    expect(Math.abs((ownedResult?.score ?? 0) - (unownedResult?.score ?? 0))).toBeLessThanOrEqual(2);
    expect(scored.results[0]?.title).toBe("Quiet Punchline");
  });
});
