import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { NoopRanker } from "../src/server/ai/ranker";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { fixturePlexItems, fixtureSeerrItems } from "../src/server/fixtures/media";
import { interpretPlexWatchPayloads } from "../src/server/integrations/plexWatchState";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import {
  emptyPlexWatchSuppression,
  queryNamesTitle,
  queryRequestsRewatch,
  summaryNamesDemotedTitle,
  suppressWatchedResults,
  type PlexWatchSuppression,
  type WatchSuppressionItem
} from "../src/server/recommendation/watchSuppression";
import type { SeerrClient } from "../src/server/integrations/seerrClient";

const nowMs = 1_760_630_400_000;
const viewer = { providerUserId: "333", username: "viewer" };

function fixture(name: string) {
  return JSON.parse(readFileSync(new URL(`./fixtures/plex-watch/${name}.json`, import.meta.url), "utf8")) as unknown;
}

function viewerWatchState(): PlexWatchSuppression {
  return interpretPlexWatchPayloads({
    accounts: fixture("accounts"),
    historyPages: [fixture("history")],
    libraryPages: [fixture("movies"), fixture("shows-recent"), fixture("shows-completed")],
    identity: viewer,
    nowMs,
    recentWatchDays: 180
  });
}

function item(id: string, title: string, mediaType: WatchSuppressionItem["mediaType"] = "movie", year?: number): WatchSuppressionItem {
  return { id, mediaType, title, year };
}

describe("Plex watch suppression", () => {
  const state = viewerWatchState();
  const results = [
    item("recent", "Recent Movie", "movie", 2016),
    item("old", "Old Movie", "movie", 1999),
    item("finished", "Finished Show", "tv", 2011),
    item("partial", "Partial Show", "tv", 2020),
    item("cleared", "Cleared Movie", "movie", 2018),
    item("shared", "Shared Only", "movie", 2019),
    item("history", "History Only", "movie", 2021),
    item("fresh", "Unwatched Movie", "movie", 2024)
  ];
  const ratingKeys = new Map([
    ["recent", ["movie-recent"]],
    ["old", ["movie-old"]],
    ["finished", ["show-finished"]],
    ["partial", ["show-partial"]],
    ["cleared", ["movie-cleared"]],
    ["shared", ["movie-shared"]],
    ["history", ["movie-history"]],
    ["fresh", ["movie-unwatched"]]
  ]);

  it("sinks this user's recent plays and fully watched shows below unwatched titles", () => {
    expect(suppressWatchedResults(results, state, "funny tonight", ratingKeys).map((entry) => entry.id)).toEqual([
      "old",
      "cleared",
      "shared",
      "fresh",
      "recent",
      "finished",
      "partial",
      "history"
    ]);
  });

  it("keeps a named title and every result when the query asks for a rewatch", () => {
    expect(queryRequestsRewatch("comfort rewatch, not another sitcom")).toBe(true);
    expect(queryRequestsRewatch("not a rewatch, something new")).toBe(false);
    expect(queryRequestsRewatch("don't want a rewatch")).toBe(false);
    expect(suppressWatchedResults(results, state, "comfort rewatch", ratingKeys).map((entry) => entry.id)).toEqual(results.map((entry) => entry.id));
    expect(suppressWatchedResults(results, state, "not a rewatch, something new", ratingKeys).map((entry) => entry.id)[0]).not.toBe("recent");
    expect(queryNamesTitle("please watch Recent Movie tonight", "Recent Movie")).toBe(true);
    expect(queryNamesTitle("cozy mystery", "Mystery")).toBe(false);
    expect(queryNamesTitle("something like Finished Show", "Finished Show")).toBe(true);
    expect(queryNamesTitle("without Recent Movie", "Recent Movie")).toBe(false);
    expect(suppressWatchedResults(results, state, "please watch Recent Movie tonight", ratingKeys).map((entry) => entry.id)).toEqual([
      "recent",
      "old",
      "cleared",
      "shared",
      "fresh",
      "finished",
      "partial",
      "history"
    ]);
  });

  it("matches title and year when a result has no Plex rating key", () => {
    const untitledKeys = new Map<string, string[]>();
    const ranked = [
      item("history", "History Only", "movie", 2021),
      item("remake", "History Only", "movie", 1990),
      item("fresh", "Unwatched Movie", "movie", 2024)
    ];
    expect(suppressWatchedResults(ranked, state, "something light", untitledKeys).map((entry) => entry.id)).toEqual(["remake", "fresh", "history"]);
  });

  it("leaves results alone when no watch state was loaded", () => {
    expect(suppressWatchedResults(results, undefined, "funny tonight", ratingKeys)).toBe(results);
    expect(suppressWatchedResults(results, emptyPlexWatchSuppression(), "funny tonight", ratingKeys)).toBe(results);
  });
});

describe("recommendation search watch suppression", () => {
  it("drops the signed-in user's recently watched and finished shows out of a short result list", async () => {
    const { repository } = repositoryWithFixtures();
    const state: PlexWatchSuppression = {
      recentRatingKeys: new Set(["fixture-plex-4"]),
      recentTitles: new Set(),
      completedShowRatingKeys: new Set(["fixture-plex-6"]),
      completedShowTitles: new Set()
    };
    const loadForUser = vi.fn(async () => state);
    const engine = new RecommendationEngine(repository, offlineSeerr(), new NoopRanker(), undefined, undefined, undefined, undefined, undefined, undefined, undefined, { loadForUser });
    const baseline = new RecommendationEngine(repository, offlineSeerr(), new NoopRanker());

    const filtered = await engine.recommend({ query: "comedy", useAi: false, resultLimit: 4 }, { authUserId: "viewer" });
    expect(loadForUser).toHaveBeenCalledWith("viewer", undefined);
    const filteredTitles = filtered.results.map((entry) => entry.title);
    expect(filteredTitles).not.toContain("Paddington 2");
    expect(filteredTitles).not.toContain("Detectorists");

    const broad = await engine.recommend({ query: "comedy", useAi: false, resultLimit: 20 }, { authUserId: "viewer" });
    const titles = broad.results.map((entry) => entry.title);
    const firstSunk = titles.findIndex((title) => title === "Paddington 2" || title === "Detectorists");
    expect(firstSunk).toBeGreaterThan(0);
    expect(titles.slice(0, firstSunk)).not.toContain("Paddington 2");
    expect(titles.slice(0, firstSunk)).not.toContain("Detectorists");
    expect(titles).toContain("Paddington 2");
    expect(titles).toContain("Detectorists");

    const named = await engine.recommend({ query: "Paddington 2", useAi: false, resultLimit: 5 }, { authUserId: "viewer" });
    const namedBaseline = await baseline.recommend({ query: "Paddington 2", useAi: false, resultLimit: 5 }, { authUserId: "viewer" });
    expect(named.results.map((entry) => entry.title)).toEqual(namedBaseline.results.map((entry) => entry.title));
    expect(named.results.map((entry) => entry.title)).toContain("Paddington 2");

    const rewatch = await engine.recommend({ query: "comedy rewatch", useAi: false, resultLimit: 20 }, { authUserId: "viewer" });
    const rewatchBaseline = await baseline.recommend({ query: "comedy rewatch", useAi: false, resultLimit: 20 });
    expect(rewatch.results.map((entry) => entry.title)).toEqual(rewatchBaseline.results.map((entry) => entry.title));

    loadForUser.mockClear();
    await engine.recommend({ query: "comedy", useAi: false, resultLimit: 4 });
    expect(loadForUser).not.toHaveBeenCalled();
  });

  it("does not name a demoted title in the search summary", async () => {
    const { repository } = repositoryWithFixtures();
    const state: PlexWatchSuppression = {
      recentRatingKeys: new Set(["fixture-plex-4"]),
      recentTitles: new Set(),
      completedShowRatingKeys: new Set(),
      completedShowTitles: new Set()
    };
    const engine = new RecommendationEngine(
      repository,
      offlineSeerr(),
      {
        async rank(input: { candidates: Array<{ id: string }> }) {
          return { usedAi: true, results: input.candidates, summary: "Paddington 2 is the one to start with." };
        }
      } as unknown as ConstructorParameters<typeof RecommendationEngine>[2],
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { loadForUser: async () => state }
    );
    const response = await engine.recommend({ query: "comedy", useAi: true, resultLimit: 4 }, { authUserId: "viewer" });
    expect(response.results.map((entry) => entry.title)).not.toContain("Paddington 2");
    expect(response.summary).not.toContain("Paddington 2");
    expect(summaryNamesDemotedTitle("Paddington 2 is the one to start with.", ["Paddington 2"])).toBe(true);
    expect(summaryNamesDemotedTitle("A lighter comedy is the better start.", ["Paddington 2"])).toBe(false);
  });

  it("still returns recommendations when the Plex watch read fails", async () => {
    const { repository } = repositoryWithFixtures();
    const engine = new RecommendationEngine(
      repository,
      offlineSeerr(),
      new NoopRanker(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { loadForUser: async () => { throw new Error("plex down"); } }
    );
    const response = await engine.recommend({ query: "comedy", useAi: false, resultLimit: 4 }, { authUserId: "viewer" });
    expect(response.results.length).toBeGreaterThan(0);
  });
});

function repositoryWithFixtures() {
  const db = createDatabase(":memory:");
  const repository = new MediaRepository(db);
  repository.upsertMany([...fixturePlexItems, ...fixtureSeerrItems]);
  return { db, repository };
}

function offlineSeerr() {
  return { allowsDescriptiveContent: () => false, search: async () => [] } as unknown as SeerrClient;
}
