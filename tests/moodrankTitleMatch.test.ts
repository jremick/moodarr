import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository, type IngestMediaRecord, type StoredMediaFeature } from "../src/server/db/mediaRepository";
import { fixturePlexItems } from "../src/server/fixtures/media";
import { buildMediaFeatureDocument } from "../src/server/recommendation/features";
import { scoreLibraryCandidates } from "../src/server/recommendation/scoring";
import type { SearchResponse } from "../src/shared/types";

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
    expect(ownedResult?.rankAdjustment).toBe("owned_within_2");
  });
});

function searchConfig(): AppConfig {
  return {
    fixtureMode: true,
    dataDir: ".data-test",
    configPath: ".data-test/config.json",
    dbPath: ":memory:",
    apiPort: 0,
    apiHost: "127.0.0.1",
    webOrigin: "http://127.0.0.1:5173",
    serveClient: false,
    requireAdminToken: false,
    adminAutoSession: false,
    plexAuth: {
      enabled: false,
      allowNewUsers: true,
      clientIdentifier: "moodarr-test-client",
      productName: "Moodarr Test"
    },
    plex: {
      baseUrl: "http://plex.example",
      token: "test-plex-token",
      webBaseUrl: "https://app.plex.tv/desktop"
    },
    seerr: {
      baseUrl: "http://seerr.example",
      apiKey: "test-seerr-key"
    },
    ai: {
      provider: "none",
      openaiModel: "gpt-5.5",
      openaiEmbeddingModel: "text-embedding-3-large",
      openaiReasoningEffort: "low",
      openaiServiceTier: "default"
    },
    sync: {
      intervalMinutes: 0,
      syncSeerr: true
    },
    search: {
      defaultResultLimit: 50
    },
    reviewQueue: {
      retentionDays: 90,
      maxQueries: 500,
      captureRawQueries: false
    },
    knownSecrets: ["test-plex-token", "test-seerr-key"]
  };
}

function ownedComedy(title: string, id: number): IngestMediaRecord {
  return {
    mediaType: "movie",
    title,
    year: 2010 + (id % 10),
    runtimeMinutes: 96,
    summary: "A light comedy about neighbors sharing an easy evening.",
    genres: ["Comedy"],
    ratings: { critic: 62, audience: 60 },
    posterPath: `fixture://owned-${id}`,
    externalIds: { tmdb: 700000 + id },
    plex: {
      ratingKey: `plex-${id}`,
      guid: `tmdb://${700000 + id}`,
      libraryTitle: "Movies",
      libraryType: "movie",
      available: true
    }
  };
}

describe("mood query title matching through /api/search", () => {
  let app: ReturnType<typeof createApp>;
  let db: DatabaseSync;

  beforeAll(() => {
    db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    // Owned comedies sit just under Funny Adventure. Something Funny stays clearly ahead, so only the within-2 margin should move Funny Adventure.
    repository.upsertMany([
      ...Array.from({ length: 12 }, (_, index) => ownedComedy(`Library Laugh ${index + 1}`, index + 1)),
      {
        mediaType: "movie",
        title: "Funny Adventure",
        year: 1982,
        runtimeMinutes: 94,
        summary: "A witty light comedy about a courier who keeps stumbling into jokes on a quiet countryside road.",
        genres: ["Comedy", "Adventure"],
        ratings: { critic: 84, audience: 80 },
        posterPath: "fixture://funny-adventure-search",
        externalIds: { tmdb: 1982001 },
        seerr: { tmdbId: 1982001, status: "unknown", requestable: true }
      },
      {
        mediaType: "movie",
        title: "Something Funny",
        year: 1994,
        runtimeMinutes: 91,
        summary: "A witty funny comedy full of jokes, farce, and an easy sitcom pace.",
        genres: ["Comedy"],
        ratings: { critic: 97, audience: 94 },
        posterPath: "fixture://something-funny-search",
        externalIds: { tmdb: 1994001 },
        seerr: { tmdbId: 1994001, status: "unknown", requestable: true }
      }
    ]);
    app = createApp({ config: searchConfig(), db });
  });

  afterAll(async () => {
    await app.close();
    db.close();
  });

  async function search(query: string) {
    const response = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query, resultLimit: 20, useAi: false }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as SearchResponse;
    expect(body.diagnostics?.seerrAugmented).toBe(false);
    return body;
  }

  it("ranks a close owned comedy above Funny Adventure for the couple runtime phrasing", async () => {
    const body = await search("something funny, under 2 hours, for both of us");
    const funnyIndex = body.results.findIndex((item) => item.title === "Funny Adventure");
    const funny = body.results[funnyIndex];
    const ownedAbove = body.results.slice(0, funnyIndex).filter((item) => item.availabilityGroup === "available_in_plex");

    expect(body.watchContext).toBe("group");
    expect(funny?.availabilityGroup).toBe("not_in_plex_requestable");
    expect(funny?.rankAdjustment).toBeUndefined();
    expect(funny?.matchExplanation ?? "").not.toMatch(/direct title match|title hits directly/i);
    expect(ownedAbove.length).toBeGreaterThan(0);
    expect(ownedAbove.some((item) => item.rankAdjustment === "owned_within_2" && item.score < (funny?.score ?? 0) && (funny?.score ?? 0) - item.score <= 2)).toBe(true);
  });

  it("keeps a bare Funny Adventure lookup at the top without an owned boost", async () => {
    const body = await search("Funny Adventure");
    expect(body.results[0]?.title).toBe("Funny Adventure");
    expect(body.results[0]?.matchExplanation).toMatch(/direct title match|title hits directly/i);
    expect(body.results.some((item) => item.rankAdjustment)).toBe(false);
    expect(body.results.every((item, index) => index === 0 || item.score <= (body.results[0]?.score ?? 0))).toBe(true);
  });

  it("keeps a bare Something Funny lookup at the top without an owned boost", async () => {
    const body = await search("Something Funny");
    expect(body.results[0]?.title).toBe("Something Funny");
    expect(body.results[0]?.matchExplanation).toMatch(/direct title match|title hits directly/i);
    expect(body.results.some((item) => item.rankAdjustment)).toBe(false);
    expect(body.results.every((item, index) => index === 0 || item.score <= (body.results[0]?.score ?? 0))).toBe(true);
  });
});
