import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createApp } from "../src/server/app";
import type { AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository, type IngestMediaRecord, type StoredMediaFeature } from "../src/server/db/mediaRepository";
import { fixturePlexItems } from "../src/server/fixtures/media";
import { buildMediaFeatureDocument } from "../src/server/recommendation/features";
import { parseRecommendationIntent, tokenize } from "../src/server/recommendation/intent";
import { scoreLibraryCandidates, shouldAugmentWithSeerr } from "../src/server/recommendation/scoring";
import { stripAudienceAndRuntimePhrases } from "../src/shared/audienceRuntimePhrases";
import type { ItemSummary, SearchResponse } from "../src/shared/types";

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
    expect(ownedResult?.rankAdjustment).toBeUndefined();
  });

  it("does not collapse a year that belongs to the title", () => {
    const original = movie("Blade Runner", 1982, 40);
    const sequel = movie("Blade Runner 2049", 2017, 99);
    const deathRace = movie("Death Race", 2008, 40);
    const deathRace2000 = movie("Death Race 2000", 1975, 99);

    expect(rankQuery([sequel, original], "Blade Runner").results[0]?.title).toBe("Blade Runner");
    expect(rankQuery([original, sequel], "Blade Runner 2049").results[0]?.title).toBe("Blade Runner 2049");
    expect(rankQuery([deathRace2000, deathRace], "Death Race").results[0]?.title).toBe("Death Race");
    expect(rankQuery([deathRace, deathRace2000], "Death Race 2000").results[0]?.title).toBe("Death Race 2000");
    expect(rankQuery([sequel, original], "Blade Runner").results[0]?.matchExplanation).toMatch(/direct title match|title hits directly/i);
    expect(rankQuery([sequel, original], "Blade Runner").results.find((item) => item.title === "Blade Runner 2049")?.matchExplanation ?? "").not.toMatch(/direct title match|title hits directly/i);
  });

  it("keeps a release year on a numbered title", () => {
    const original = movie("Blade Runner", 1982, 99);
    const sequel = movie("Blade Runner 2049", 2017, 40);
    const deathRace = movie("Death Race", 2008, 99);
    const deathRace2000 = movie("Death Race 2000", 1975, 40);

    expect(rankQuery([original, sequel], "Blade Runner 2017").results[0]?.title).toBe("Blade Runner 2049");
    expect(rankQuery([deathRace, deathRace2000], "Death Race 1975").results[0]?.title).toBe("Death Race 2000");
    expect(rankQuery([original, sequel], "Blade Runner 2017").results[0]?.matchExplanation).toMatch(/direct title match|title hits directly/i);
    expect(rankQuery([original, sequel], "Blade Runner 2017").results.find((item) => item.title === "Blade Runner")?.matchExplanation ?? "").not.toMatch(/direct title match|title hits directly/i);
  });

  it("treats a mismatched query year as the same title lookup", () => {
    const something = movie("Something Funny", 2021, 55, "A witty funny comedy full of jokes, farce, and an easy sitcom pace.", ["Comedy"]);
    const rival = movie("Library Laugh", 2016, 96, "A witty funny comedy full of jokes, farce, and an easy sitcom pace.", ["Comedy"]);
    const bare = rankQuery([rival, something], "Something Funny");
    const mismatched = rankQuery([rival, something], "Something Funny 2020");

    expect(bare.results[0]?.title).toBe("Something Funny");
    expect(mismatched.results[0]?.title).toBe("Something Funny");
    expect(mismatched.results[0]?.score).toBe(bare.results[0]?.score);
    expect(mismatched.results[0]?.matchExplanation).toMatch(/direct title match|title hits directly/i);
  });

  it("ranks an exact numbered title above a nearby one", () => {
    const apollo13 = movie("Apollo 13", 1995, 40, "Astronauts fight to return to Earth.", ["Drama"]);
    const apollo11 = movie("Apollo 11", 2019, 99, "A documentary about the moon landing.", ["Documentary"]);
    const scored = rankQuery([apollo11, apollo13], "Apollo 13");

    expect(scored.results[0]?.title).toBe("Apollo 13");
    expect(scored.results[0]?.matchExplanation).toMatch(/title match|title hits directly/i);
    expect(scored.results.find((item) => item.title === "Apollo 11")?.matchExplanation ?? "").not.toMatch(/title match|title hits directly|nearby numbered title/i);
  });

  it("does not treat a nearby year as a title boost", () => {
    const godzilla = movie("Godzilla 2000", 1999, 40);
    const mothra = movie("Mothra", 1961, 90, "A giant moth protects the city.", ["Fantasy"]);
    const scored = rankQuery([godzilla, mothra], "Godzilla 1999");
    const match = scored.results.find((item) => item.title === "Godzilla 2000");

    expect(scored.results[0]?.title).toBe("Mothra");
    expect(match?.matchExplanation ?? "").not.toMatch(/direct title match|title hits directly|nearby numbered title/i);
  });

  it("ranks the closest numbered title above an unrelated show", () => {
    const detectorists: IngestMediaRecord = {
      mediaType: "tv",
      title: "Detectorists",
      year: 2014,
      runtimeMinutes: 30,
      summary: "A low-key feel-good British comedy series about friendship, hobbies, and gentle countryside absurdity.",
      genres: ["Comedy"],
      ratings: { critic: 100, audience: 95 },
      posterPath: "fixture://detectorists",
      externalIds: { tmdb: 63162 },
      plex: {
        ratingKey: "fixture-plex-detectorists",
        guid: "tmdb://63162",
        libraryTitle: "TV Shows",
        libraryType: "show",
        available: true
      }
    };
    const day180 = movie("Day 180", 2019, 40);
    const day181 = movie("Day 181", 2020, 40);
    const scored = rankQuery([detectorists, day181, day180], "Day 179");
    const titles = scored.results.map((item) => item.title);

    expect(titles.indexOf("Day 180")).toBeGreaterThanOrEqual(0);
    expect(titles.indexOf("Day 180")).toBeLessThan(titles.indexOf("Detectorists"));
    expect(titles.indexOf("Day 181")).toBeLessThan(titles.indexOf("Detectorists"));
    expect(titles.indexOf("Day 180")).toBeLessThan(titles.indexOf("Day 181"));
  });
});

function movie(title: string, year: number, critic: number, summary = "A science fiction story.", genres = ["Science Fiction"]): IngestMediaRecord {
  return {
    mediaType: "movie",
    title,
    year,
    runtimeMinutes: 110,
    summary,
    genres,
    ratings: { critic, audience: critic },
    posterPath: `fixture://${title}`,
    externalIds: { tmdb: year + critic },
    seerr: { tmdbId: year + critic, status: "unknown", requestable: true }
  };
}

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

function ownedComedy(
  title: string,
  id: number,
  ratings: { critic: number; audience: number } = { critic: 62, audience: 60 },
  detail: { summary?: string; genres?: string[]; runtimeMinutes?: number } = {}
): IngestMediaRecord {
  return {
    mediaType: "movie",
    title,
    year: 2010 + (id % 10),
    runtimeMinutes: detail.runtimeMinutes ?? 96,
    summary: detail.summary ?? "A light comedy about neighbors sharing an easy evening.",
    genres: detail.genres ?? ["Comedy"],
    ratings,
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

function resultSummary(title: string, score: number): ItemSummary {
  return {
    id: title,
    mediaType: "movie",
    title,
    genres: ["Comedy"],
    ratings: {},
    posterUrl: "fixture://score",
    availabilityGroup: title.startsWith("Owned") ? "available_in_plex" : "not_in_plex_requestable",
    availabilityExplanation: title,
    matchExplanation: title,
    score
  };
}

describe("Seerr augmentation threshold", () => {
  it("uses the highest raw score in the top window after an owned reorder", () => {
    const intent = parseRecommendationIntent("something funny");
    const fillers = Array.from({ length: 8 }, (_, index) => resultSummary(`Filler ${index}`, 40));
    const reordered = [resultSummary("Owned Close", 51.5), resultSummary("Unowned Strong", 53), ...fillers];

    expect(shouldAugmentWithSeerr(reordered, 20, intent, {})).toBe(false);
    expect(shouldAugmentWithSeerr([resultSummary("Owned Close", 51.5), ...fillers, resultSummary("Tail", 40)], 20, intent, {})).toBe(true);
  });
});

describe("audience and runtime phrases", () => {
  it("removes audience and runtime wording that would otherwise look like a title", () => {
    const phrases = [
      "2hrs",
      "2 hrs",
      "an hour and a half",
      "less than 2 hours",
      "no longer than 90 minutes",
      "for my wife and me",
      "my wife and I",
      "for my girlfriend and me",
      "we can both enjoy",
      "for two",
      "with friends",
      "this evening",
      "for both of us",
      "for us",
      "for the kids",
      "with my partner",
      "under 2 hours",
      "under 90 minutes",
      "tonight",
      "watch together",
      "together tonight",
      "as a group",
      "with a group",
      "both-of-us",
      "want",
      "wants",
      "looking for",
      "after",
      "in the mood for"
    ];
    expect(tokenize(stripAudienceAndRuntimePhrases("my wife and I want something funny"))).toEqual(["funny"]);
    for (const phrase of phrases) {
      const stripped = stripAudienceAndRuntimePhrases(`something funny, ${phrase}`);
      expect(tokenize(stripped), phrase).toEqual(["funny"]);
      expect(stripped.toLowerCase(), phrase).not.toContain(phrase.toLowerCase());
    }
  });
});

describe("mood query title matching through /api/search", () => {
  let app: ReturnType<typeof createApp>;
  let db: DatabaseSync;

  beforeAll(() => {
    db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    // Owned comedies sit just under Funny Adventure. Something Funny stays clearly ahead, so only the within-2 margin should move Funny Adventure.
    repository.upsertMany([
      ...Array.from({ length: 12 }, (_, index) => ownedComedy(`Library Laugh ${index + 1}`, index + 1)),
      ownedComedy("Owned Near Miss", 40, { critic: 84, audience: 80 }, {
        summary: "A witty light comedy about a courier who keeps stumbling into jokes on a quiet countryside road.",
        genres: ["Comedy", "Adventure"],
        runtimeMinutes: 94
      }),
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

  async function search(query: string, watchContext?: "solo" | "group") {
    const response = await app.inject({
      method: "POST",
      url: "/api/search",
      payload: { query, resultLimit: 20, useAi: false, ...(watchContext ? { watchContext } : {}) }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as SearchResponse;
    expect(body.diagnostics?.seerrAugmented).toBe(false);
    return body;
  }

  function expectDirectTitle(body: SearchResponse, title: string, allowTie = false) {
    const ranked = body.results.map((item) => `${item.title} ${item.score}`).slice(0, 4).join(" | ");
    expect(body.results[0]?.title, ranked).toBe(title);
    expect(body.results[0]?.matchExplanation).toMatch(/direct title match|title hits directly/i);
    expect(body.results.some((item) => item.rankAdjustment), ranked).toBe(false);
    if (title !== "Funny Adventure") return;
    const rival = body.results.find((item) => item.title === "Owned Near Miss");
    const gap = (body.results[0]?.score ?? 0) - (rival?.score ?? 0);
    expect(gap, ranked).toBeGreaterThan(allowTie ? -1 : 0);
    expect(gap, ranked).toBeLessThan(2);
  }

  it("ranks a close owned comedy above Funny Adventure for the couple runtime phrasing", async () => {
    const body = await search("something funny, under 2 hours, for both of us", "group");
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

  it("keeps the mood reorder when audience and runtime phrases use the shared list", async () => {
    const body = await search("something funny, 2hrs, an hour and a half, less than 2 hours, for my wife and me, we can both enjoy, with friends, this evening", "group");
    const target = body.results.find((item) => item.title === "Something Funny");
    const targetIndex = body.results.findIndex((item) => item.title === "Something Funny");
    const ownedAbove = body.results.slice(0, targetIndex).filter((item) => item.availabilityGroup === "available_in_plex");
    const ranked = body.results.map((item, index) => `${index + 1}. ${item.title} ${item.score} ${item.rankAdjustment ?? "-"}`).join("\n");

    expect(targetIndex, ranked).toBeGreaterThan(0);
    expect(ownedAbove.some((item) => item.rankAdjustment === "owned_within_2" && item.score < (target?.score ?? 0) && (target?.score ?? 0) - item.score <= 2), ranked).toBe(true);
  });

  it("keeps a bare Funny Adventure lookup ahead of a close owned rival", async () => {
    const body = await search("Funny Adventure");
    const rival = body.results.find((item) => item.title === "Owned Near Miss");
    expectDirectTitle(body, "Funny Adventure");
    expect(rival?.availabilityGroup).toBe("available_in_plex");
    const ranked = body.results.map((item, index) => `${index + 1}. ${item.title} ${item.score}`).join("\n");
    const gap = (body.results[0]?.score ?? 0) - (rival?.score ?? 0);
    expect(gap, ranked).toBeGreaterThan(0);
    expect(gap, ranked).toBeLessThanOrEqual(2);
  });

  it("keeps a bare Something Funny lookup at the top without an owned boost", async () => {
    const body = await search("Something Funny");
    expectDirectTitle(body, "Something Funny");
  });

  it.each([
    ["the funny adventure", "Funny Adventure", false],
    ["a funny adventure", "Funny Adventure", false],
    ["funny adventure (2019)", "Funny Adventure", true],
    ["Funny Adventure 1982", "Funny Adventure", false],
    ["Something Funny (2021)", "Something Funny", false]
  ])("keeps %s on %s ahead of the close owned rival", async (query, title, allowTie) => {
    const body = await search(query);
    expectDirectTitle(body, title, allowTie);
  });

});
