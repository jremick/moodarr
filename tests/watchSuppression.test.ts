import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { NoopRanker } from "../src/server/ai/ranker";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { fixturePlexItems, fixtureSeerrItems } from "../src/server/fixtures/media";
import { interpretPlexWatchPayloads } from "../src/server/integrations/plexWatchState";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import { COMMON_ENGLISH_LIST_FILE, COMMON_ENGLISH_SUPPLEMENT_FILE } from "../src/server/recommendation/commonEnglishFiles";
import {
  emptyPlexWatchSuppression,
  loadCommonWordList,
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

const rewatchCases: ReadonlyArray<readonly [string, boolean]> = [
  ["comfort rewatch", true],
  ["comfort rewatch, not another sitcom", true],
  ["something I've seen", true],
  ["something I\u2019ve seen", true],
  ["an old favourite", true],
  ["an old favorite", true],
  ["an old fave", true],
  ["an old faves", true],
  ["old faves", true],
  ["old favourite", true],
  ["old favorite", true],
  ["old favorites", true],
  ["old favourites", true],
  ["my old faves", true],
  ["no horror rewatch something", true],
  ["not too long rewatch", true],
  ["skip the intro rewatch a classic", true],
  ["exclude horror rewatch", true],
  ["anything but horror rewatch", true],
  ["not horror rewatch", true],
  ["no long rewatch", true],
  ["skip comedy rewatch", true],
  ["exclude action rewatch", true],
  ["anything but romance rewatch", true],
  ["not scary rewatch", true],
  ["no short rewatch", true],
  ["watch again", true],
  ["seen before", true],
  ["already watched", true],
  ["already seen", true],
  ["watched before", true],
  ["a classic I love", true],
  ["rewatch a classic I love", true],
  ["something I have seen", true],
  ["something I have watched", true],
  ["something I have already seen", true],
  ["something I have already watched", true],
  ["we've seen this", true],
  ["we've watched this", true],
  ["we've already seen this", true],
  ["we've already watched this", true],
  ["we have seen this", true],
  ["we have watched this", true],
  ["we have already seen this", true],
  ["play it watch again", true],
  ["my old favourites", true],
  ["re-watch", true],
  ["comedy rewatch", true],
  ["I want a rewatch", true],
  ["show me old favorites", true],
  ["rewatching the good ones", true],
  ["rewatches please", true],
  ["put on a rewatch", true],
  ["comedy I've seen", true],
  ["horror I've watched", true],
  ["rewatch tonight", true],
  ["I want to watch again", true],
  ["please rewatch", true],
  ["rewatch", true],
  ["something we've already seen", true],
  ["watch again please", true],
  ["seen before tonight", true],
  ["already watched this", true],
  ["a classic i love tonight", true],
  ["not horror, rewatch something", true],
  ["comfort rewatch please", true],
  ["an old favourite please", true],
  ["put on something I've watched", true],
  ["I have watched this", true],
  ["something we've watched", true],
  ["not a rewatch", false],
  ["not a rewatch, something new", false],
  ["don't want a rewatch", false],
  ["don\u2019t want a rewatch", false],
  ["nothing I've already seen", false],
  ["I don't want anything I've seen", false],
  ["I have seen everything, surprise me", false],
  ["skip anything I've seen", false],
  ["exclude what I've watched", false],
  ["anything but a rewatch", false],
  ["sick of rewatching", false],
  ["tired of rewatches", false],
  ["I've seen too many rewatches", false],
  ["nothing we've already seen", false],
  ["don't show me rewatches", false],
  ["skip films I've already watched", false],
  ["not interested in rewatching", false],
  ["no movies I've already seen", false],
  ["not in the mood to rewatch", false],
  ["tired of watching things I've seen", false],
  ["never rewatch", false],
  ["not rewatch", false],
  ["do not rewatch", false],
  ["avoid a rewatch", false],
  ["without a rewatch", false],
  ["haven't already seen", false],
  ["no rewatches", false],
  ["not rewatching", false],
  ["skip rewatching", false],
  ["exclude rewatches", false],
  ["nothing I have seen", false],
  ["I don't want a rewatch", false],
  ["not a classic I love", false],
  ["no old faves", false],
  ["sick of old favourites", false],
  ["tired of watch again", false],
  ["don't want something I've seen", false],
  ["nothing already watched", false],
  ["skip what I have watched", false],
  ["not interested in a rewatch", false],
  ["avoid rewatching", false],
  ["never watch again", false],
  ["I have seen it all", false],
  ["seen everything", false],
  ["already seen everything", false],
  ["I've seen all of them", false],
  ["seen all of it", false],
  ["not an old favourite", false],
  ["exclude old favorites", false],
  ["anything but old faves", false],
  ["don't show me something I've watched", false],
  ["no films I've seen", false],
  ["skip shows I've already seen", false],
  ["without anything I've seen", false],
  ["have not seen before", false],
  ["do not watch again", false],
  ["nothing watched before", false],
  ["not a re-watch", false],
  ["no re-watches", false],
  ["tired of re-watching", false],
  ["I have seen too many rewatches", false],
  ["seen all of these", false],
  ["seen all of those", false],
  ["nothing we've watched", false],
  ["havent watched before", false],
  ["not the mood for something I've watched", false],
  ["no more rewatches please", false],
  ["dont want a rewatch", false],
  ["nothing i have already watched", false],
  ["skip anything we've already seen", false],
  ["not in the mood for a rewatch", false],
  ["avoid old faves", false],
  ["exclude a classic I love", false],
  ["sick of a classic I love", false],
  ["never an old favourite", false],
  ["do not show me rewatches", false],
  ["without rewatching", false],
  ["haven't seen before", false],
  ["no movies I have watched", false],
  ["no horror old faves", false],
  ["no horror, just a rewatch", true],
  ["nothing new, I want to rewatch", true],
  ["nothing scary, something I've seen", true],
  ["never mind, an old favourite", true],
  ["nothing long. a rewatch please", true],
  ["no horror – something I've watched before", true],
  ["exclude horror, something I've seen", true],
  ["anything but horror, an old favourite", true],
  ["without ads, something I've seen", true],
  ["rewatch? no", false],
  ["no horror - just a rewatch", true],
  ["no horror: just a rewatch", true],
  ["no horror (just a rewatch)", true],
  ["no horror\njust a rewatch", true],
  ["nothing scary & a rewatch", true],
  ["nothing new\u2026 an old favourite", true],
  ["rewatch? nope", false],
  ["rewatch? no thanks", false],
  ["a feel-good re-watch", true],
  ["feel-good", false]
];

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
    expect(queryRequestsRewatch("nothing I've already seen")).toBe(false);
    expect(queryRequestsRewatch("I don't want anything I've seen")).toBe(false);
    expect(queryRequestsRewatch("I have seen everything, surprise me")).toBe(false);
    expect(queryRequestsRewatch("don\u2019t want a rewatch")).toBe(false);
    expect(queryRequestsRewatch("something I\u2019ve seen")).toBe(true);
    expect(queryRequestsRewatch("an old favourite")).toBe(true);
    expect(queryRequestsRewatch("an old favorite")).toBe(true);
    expect(queryRequestsRewatch("an old fave")).toBe(true);
    expect(queryRequestsRewatch("an old faves")).toBe(true);
    expect(queryRequestsRewatch("no horror rewatch something")).toBe(true);
    expect(queryRequestsRewatch("not too long rewatch")).toBe(true);
    expect(queryRequestsRewatch("skip the intro rewatch a classic")).toBe(true);
    expect(queryRequestsRewatch("exclude horror rewatch")).toBe(true);
    expect(queryRequestsRewatch("anything but horror rewatch")).toBe(true);
    expect(queryRequestsRewatch("skip anything I've seen")).toBe(false);
    expect(queryRequestsRewatch("exclude what I've watched")).toBe(false);
    expect(queryRequestsRewatch("anything but a rewatch")).toBe(false);
    expect(queryRequestsRewatch("sick of rewatching")).toBe(false);
    expect(queryRequestsRewatch("tired of rewatches")).toBe(false);
    expect(queryRequestsRewatch("I've seen too many rewatches")).toBe(false);
    expect(suppressWatchedResults(results, state, "comfort rewatch", ratingKeys).map((entry) => entry.id)).toEqual(results.map((entry) => entry.id));
    expect(suppressWatchedResults(results, state, "not a rewatch, something new", ratingKeys).map((entry) => entry.id)[0]).not.toBe("recent");
    expect(queryNamesTitle("please watch Recent Movie tonight", "Recent Movie")).toBe(true);
    expect(queryNamesTitle("cozy mystery", "Mystery")).toBe(false);
    expect(queryNamesTitle("something like Finished Show", "Finished Show")).toBe(true);
    expect(queryNamesTitle("without Recent Movie", "Recent Movie")).toBe(false);
    expect(queryNamesTitle("wilderpeople", "Hunt for the Wilderpeople")).toBe(true);
    expect(queryNamesTitle("wilder", "Hunt for the Wilderpeople")).toBe(false);
    expect(queryNamesTitle("wilderpeople", "Wild Tales")).toBe(false);
    expect(queryNamesTitle("hunt for the wilderpeople", "The Hunt")).toBe(false);
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

  it("does not treat a mood or genre query as a named title", () => {
    const watched = [
      item("funny-people", "Funny People"),
      item("dark-waters", "Dark Waters"),
      item("some-like", "Some Like It Hot"),
      item("scary", "Scary Movie"),
      item("wild-tales", "Wild Tales"),
      item("fresh", "Unwatched Movie")
    ];
    const moodState: PlexWatchSuppression = {
      recentRatingKeys: new Set(),
      recentTitles: new Set([
        "movie|funny people|",
        "movie|dark waters|",
        "movie|some like it hot|",
        "movie|scary movie|",
        "movie|wild tales|"
      ]),
      completedShowRatingKeys: new Set(),
      completedShowTitles: new Set()
    };
    const keys = new Map<string, string[]>();
    for (const query of ["funny", "dark", "something funny", "comedy", "family", "christmas", "love", "night", "adventure", "movie night", "a funny movie"]) {
      expect(suppressWatchedResults(watched, moodState, query, keys).map((entry) => entry.id)).toEqual([
        "fresh",
        "funny-people",
        "dark-waters",
        "some-like",
        "scary",
        "wild-tales"
      ]);
    }
  });

  it("keeps only the contiguous title a partial lookup names", () => {
    const ranked = [
      item("hunt", "The Hunt"),
      item("tales", "Wild Tales"),
      item("wild", "Hunt for the Wilderpeople"),
      item("fresh", "Unwatched Movie")
    ];
    const partialState: PlexWatchSuppression = {
      recentRatingKeys: new Set(),
      recentTitles: new Set(["movie|the hunt|", "movie|wild tales|", "movie|hunt for the wilderpeople|"]),
      completedShowRatingKeys: new Set(),
      completedShowTitles: new Set()
    };
    const keys = new Map<string, string[]>();
    for (const query of ["wilderpeople", "hunt for the wilderpeople"]) {
      expect(suppressWatchedResults(ranked, partialState, query, keys).map((entry) => entry.id)).toEqual(["wild", "fresh", "hunt", "tales"]);
    }
    expect(queryNamesTitle("hunt", "The Hunt")).toBe(false);
    expect(queryNamesTitle("hunt", "Hunt for the Wilderpeople")).toBe(false);
    expect(queryNamesTitle("the hunt", "The Hunt")).toBe(true);
    expect(queryNamesTitle("the hunt", "Hunt for the Wilderpeople")).toBe(false);
    expect(suppressWatchedResults(ranked, partialState, "hunt", keys).map((entry) => entry.id)).toEqual(["fresh", "hunt", "tales", "wild"]);
    expect(suppressWatchedResults(ranked, partialState, "the hunt", keys).map((entry) => entry.id)).toEqual(["hunt", "fresh", "tales", "wild"]);
  });

  it("does not treat one common word plus filler as a named title", () => {
    const pairs = [
      ["a kids movie", "Spy Kids"],
      ["a war movie", "War Dogs"],
      ["a spy movie", "Spy Kids"],
      ["a superhero movie", "Superhero Movie"],
      ["a monster movie", "Monster House"],
      ["a space movie", "Space Jam"],
      ["fun", "Fun Mom Dinner"],
      ["a fun movie", "Fun Mom Dinner"],
      ["silly", "Silly Season"],
      ["holiday", "The Holiday"],
      ["laugh", "Laugh Riot"],
      ["a laugh", "Laugh Riot"],
      ["crazy", "Crazy Stupid Love"],
      ["hot", "Some Like It Hot"],
      ["mom", "Fun Mom Dinner"],
      ["rich", "Crazy Rich Asians"],
      ["a princess movie", "The Princess Bride"],
      ["a detective movie", "Detective Story"],
      ["a vacation movie", "Vacation Friends"],
      ["vampires", "Vampires in Brooklyn"],
      ["halloween", "Hubie Halloween"],
      ["holidays", "Holidays in the Sun"],
      ["dinosaur", "The Good Dinosaur"],
      ["football", "The Football Factory"],
      ["heartwarming", "A Heartwarming Tale"],
      ["a high school movie", "High School Musical"],
      ["a road trip movie", "Road Trip"],
      ["a werewolf movie", "An American Werewolf in London"],
      ["a gangster movie", "Gangster Squad"],
      ["a disaster movie", "Disaster Movie"],
      ["best friends", "Best Friends Forever"],
      ["true crime", "True Crime Story"],
      ["new york", "New York Stories"]
    ] as const;
    const watched = pairs.map(([, title], index) => item(`watched-${index}`, title));
    const ranked = [...watched, item("fresh", "Unwatched Movie")];
    const moodState: PlexWatchSuppression = {
      recentRatingKeys: new Set(watched.map((entry) => entry.id)),
      recentTitles: new Set(),
      completedShowRatingKeys: new Set(),
      completedShowTitles: new Set()
    };
    const keys = new Map(watched.map((entry) => [entry.id, [entry.id]]));
    for (const [query, title] of pairs) {
      expect(queryNamesTitle(query, title)).toBe(false);
      expect(suppressWatchedResults(ranked, moodState, query, keys)[0]?.id).toBe("fresh");
    }
  });

  it("names a title from a full lookup, a quote, or a rare word", () => {
    expect(queryNamesTitle("watch jaws", "Jaws")).toBe(true);
    expect(queryNamesTitle("jaws please", "Jaws")).toBe(true);
    expect(queryNamesTitle("the movie coco", "Coco")).toBe(true);
    expect(queryNamesTitle("frozen tonight", "Frozen")).toBe(true);
    expect(queryNamesTitle("watch shrek", "Shrek")).toBe(true);
    expect(queryNamesTitle("watch the hunt", "The Hunt")).toBe(true);
    expect(queryNamesTitle("watch the hunt", "Hunt for the Wilderpeople")).toBe(false);
    expect(queryNamesTitle("the hunt tonight", "The Hunt")).toBe(true);
    expect(queryNamesTitle("the hunt tonight", "Hunt for the Wilderpeople")).toBe(false);
    expect(queryNamesTitle("jaws 1975", "Jaws")).toBe(true);
    expect(queryNamesTitle("put on the movie jaws tonight please", "Jaws")).toBe(true);
    expect(queryNamesTitle("\"Jaws\"", "Jaws")).toBe(true);
    expect(queryNamesTitle("\u201cFinished Show\u201d", "Finished Show")).toBe(true);
    expect(queryNamesTitle("the coco", "Coco")).toBe(true);
    expect(queryNamesTitle("dark knight", "The Dark Knight")).toBe(true);
    expect(queryNamesTitle("quiet place", "A Quiet Place")).toBe(true);
    expect(queryNamesTitle("hunt", "The Hunt")).toBe(false);
    expect(queryNamesTitle("holiday", "The Holiday")).toBe(false);
    expect(queryNamesTitle("halloween", "Halloween")).toBe(true);
    expect(queryNamesTitle("heartwarming", "Heartwarming")).toBe(true);
    expect(queryNamesTitle("best friends", "Best Friends")).toBe(true);
    expect(queryNamesTitle("wilder", "Hunt for the Wilderpeople")).toBe(false);

    const titles = [
      ["Jaws", "jaws"],
      ["Coco", "coco"],
      ["Frozen", "frozen"],
      ["Shrek", "shrek"],
      ["The Hunt", "the hunt"],
      ["Hunt for the Wilderpeople", "hunt for the wilderpeople"],
      ["Recent Movie", "recent movie"],
      ["Finished Show", "finished show"]
    ] as const;
    const forms = [
      (title: string) => `watch ${title}`,
      (title: string) => `play ${title}`,
      (title: string) => `put on ${title}`,
      (title: string) => `the movie ${title}`,
      (title: string) => `the film ${title}`,
      (title: string) => `${title} please`,
      (title: string) => `${title} tonight`,
      (title: string) => `${title} now`
    ];
    const lookups = titles.flatMap(([title, core]) => forms.map((form) => [form(core), title] as const));
    expect(lookups).toHaveLength(64);
    for (const [query, title] of lookups) {
      expect(queryNamesTitle(query, title), query).toBe(true);
      expect(queryNamesTitle(query, "Unwatched Movie"), query).toBe(false);
    }
    for (const [query] of lookups.filter(([, title]) => title === "The Hunt")) {
      expect(queryNamesTitle(query, "Hunt for the Wilderpeople"), query).toBe(false);
    }
    for (const [query] of lookups.filter(([, title]) => title === "Hunt for the Wilderpeople")) {
      expect(queryNamesTitle(query, "The Hunt"), query).toBe(false);
      expect(queryNamesTitle(query, "Wild Tales"), query).toBe(false);
    }
  });

  it("reads the bundled common-English list instead of a hand-built word list", () => {
    const list = readFileSync(new URL(`../src/server/recommendation/${COMMON_ENGLISH_LIST_FILE}`, import.meta.url), "utf8");
    expect(COMMON_ENGLISH_LIST_FILE).toBe("common-english.txt");
    expect(list).toContain("https://github.com/hermitdave/FrequencyWords/blob/master/content/2018/en/en_50k.txt");
    expect(list).toContain("CC-BY-SA-4.0");
    const words = list.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
    expect(words).toHaveLength(40000);
    expect(words).toContain("heartwarming");
    expect(words).not.toContain("wilderpeople");
    const supplement = readFileSync(new URL(`../src/server/recommendation/${COMMON_ENGLISH_SUPPLEMENT_FILE}`, import.meta.url), "utf8");
    for (const word of ["biopic", "feelgood", "tearjerker", "spoof", "satirical", "slapstick", "romcom", "whodunit", "dystopian", "mockumentary", "kaiju"]) {
      expect(supplement).toContain(word);
      expect(queryNamesTitle(word, `${word[0]?.toUpperCase()}${word.slice(1)} Story`)).toBe(false);
    }
  });

  it("keeps whole-title naming when the word list is missing, empty, or too small", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const readers = [
      () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); },
      () => { throw Object.assign(new Error("unreadable"), { code: "EACCES" }); },
      () => "",
      () => "# comments only\n",
      () => Array.from({ length: 9999 }, (_, index) => `word${index}`).join("\n")
    ];
    const ranked = [item("pikachu", "Detective Pikachu"), item("fresh", "Unwatched Movie")];
    const moodState: PlexWatchSuppression = {
      recentRatingKeys: new Set(["pikachu"]),
      recentTitles: new Set(),
      completedShowRatingKeys: new Set(),
      completedShowTitles: new Set()
    };
    const keys = new Map([["pikachu", ["pikachu"]]]);
    for (const read of readers) {
      warn.mockClear();
      expect(loadCommonWordList(read)).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(queryNamesTitle("a detective movie", "Detective Pikachu", null)).toBe(false);
      expect(suppressWatchedResults(ranked, moodState, "a detective movie", keys, null)[0]?.id).toBe("fresh");
    }
    warn.mockRestore();
  });

  it("treats digits as common and still names a whole numbered title", () => {
    const ranked = [
      item("ten", "10 Things I Hate About You"),
      item("pad", "Paddington 2"),
      item("pikachu", "Detective Pikachu"),
      item("fresh", "Unwatched Movie")
    ];
    const moodState: PlexWatchSuppression = {
      recentRatingKeys: new Set(["ten", "pad", "pikachu"]),
      recentTitles: new Set(),
      completedShowRatingKeys: new Set(),
      completedShowTitles: new Set()
    };
    const keys = new Map([["ten", ["ten"]], ["pad", ["pad"]], ["pikachu", ["pikachu"]]]);
    const sunk = [
      ["top 10 comedies", "10 Things I Hate About You"],
      ["something under 2 hours", "Paddington 2"],
      ["top 2 family comedies", "Paddington 2"],
      ["paddington", "Paddington 2"],
      ["pikachu", "Detective Pikachu"]
    ] as const;
    for (const [query, title] of sunk) {
      expect(queryNamesTitle(query, title)).toBe(false);
      expect(suppressWatchedResults(ranked, moodState, query, keys)[0]?.id).toBe("fresh");
    }
    expect(queryNamesTitle("paddington 2", "Paddington 2")).toBe(true);
    expect(suppressWatchedResults(ranked, moodState, "paddington 2", keys)[0]?.id).toBe("pad");
  });

  it("keeps a partial title lookup in place", () => {
    const ranked = [
      item("wild", "Hunt for the Wilderpeople", "movie", 2016),
      item("fresh", "Unwatched Movie", "movie", 2024)
    ];
    const keys = new Map<string, string[]>([["wild", ["movie-recent"]]]);
    expect(suppressWatchedResults(ranked, state, "wilderpeople", keys).map((entry) => entry.id)).toEqual(["wild", "fresh"]);
  });

  it("decides rewatch requests across the negation table", () => {
    const mismatches = rewatchCases.filter(([query, expected]) => queryRequestsRewatch(query) !== expected);
    expect(rewatchCases.length).toBeGreaterThanOrEqual(123);
    expect(mismatches.map(([query, expected]) => `${JSON.stringify(query)} expected ${expected}`)).toEqual([]);
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

  it("keeps a single-word title lookup at rank 1", async () => {
    const { repository } = repositoryWithFixtures();
    const state: PlexWatchSuppression = {
      recentRatingKeys: new Set(["fixture-plex-3"]),
      recentTitles: new Set(),
      completedShowRatingKeys: new Set(),
      completedShowTitles: new Set()
    };
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
      { loadForUser: async () => state }
    );
    const response = await engine.recommend({ query: "wilderpeople", useAi: false, resultLimit: 5 }, { authUserId: "viewer" });
    expect(response.results[0]?.title).toBe("Hunt for the Wilderpeople");
  });

  it("keeps the group watch context refinement", async () => {
    const { repository } = repositoryWithFixtures();
    const engine = new RecommendationEngine(repository, offlineSeerr(), new NoopRanker());
    const response = await engine.recommend({ query: "comedy", useAi: false, watchContext: "group", resultLimit: 5 });
    expect(response.refinementOptions.map((option) => option.label)).toContain("Crowd pleasers");
  });

  it("infers a group refinement when the query names a group", async () => {
    const { repository } = repositoryWithFixtures();
    const engine = new RecommendationEngine(repository, offlineSeerr(), new NoopRanker());
    const response = await engine.recommend({ query: "comedy for a group", useAi: false, resultLimit: 5 });
    expect(response.refinementOptions.map((option) => option.label)).toContain("Crowd pleasers");
  });

  it("does not treat a bare group word as a group refinement", async () => {
    const { repository } = repositoryWithFixtures();
    const engine = new RecommendationEngine(repository, offlineSeerr(), new NoopRanker());
    for (const query of ["together", "group", "The Group", "group therapy drama", "comedy together", "comedy group"]) {
      const response = await engine.recommend({ query, useAi: false, resultLimit: 5 });
      expect(response.refinementOptions.map((option) => option.label), query).not.toContain("Crowd pleasers");
    }
    const comedy = await engine.recommend({ query: "comedy together", useAi: false, resultLimit: 5 });
    expect(comedy.results.length).toBeGreaterThan(0);
  });

  it("does not let a group phrase override an explicit solo watch", async () => {
    const { repository } = repositoryWithFixtures();
    const engine = new RecommendationEngine(repository, offlineSeerr(), new NoopRanker());
    const response = await engine.recommend({ query: "comedy for a group", useAi: false, watchContext: "solo", resultLimit: 5 });
    expect(response.results.length).toBeGreaterThan(0);
    expect(response.refinementOptions.map((option) => option.label)).not.toContain("Crowd pleasers");
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
