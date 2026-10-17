import { afterEach, describe, expect, it, vi } from "vitest";
import { buildConversationQuery, deriveChatCriteria, searchWatchContextFields, settledWatchContext, type ChatCriteria } from "../src/client/chatCriteria";
import {
  currentWatchModeCriteria,
  initialWatchMode,
  pickWatchMode,
  resetWatchMode,
  watchModeAfterSearch,
  watchModeBeforeSearch,
  type WatchModeState
} from "../src/client/watchMode";
import { OpenAiBriefParser } from "../src/server/ai/briefParser";
import { optimizeQueryDeterministically } from "../src/server/ai/queryOptimizer";
import type { AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { RecommendationEngine } from "../src/server/recommendation/engine";
import { parseRecommendationIntent } from "../src/server/recommendation/intent";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { createApp } from "../src/server/app";
import { isNearExactCatalogueTitle } from "../src/server/recommendation/catalogueTitleQuery";
import { inferWatchContext, resolveWatchContext, sharedWatchContextBriefGuidance } from "../src/shared/watchContext";
import type { SearchResponse } from "../src/shared/types";

const coupleQueries = [
  "something funny, under 2 hours, for both of us",
  "something funny, under 2 hours, for us",
  "something funny, under 2 hours, date night",
  "something funny, under 2 hours, me and my partner",
  "something funny, under 2 hours, with my wife",
  "something funny, under 2 hours, with my husband",
  "something funny, under 2 hours, the two of us",
  "something funny, under 2 hours, with my spouse",
  "something funny, under 2 hours, me and my boyfriend",
  "something funny, under 2 hours, with my girlfriend",
  "something funny, under 2 hours, as a couple",
  "couple's night, something funny",
  "something together",
  "watch together",
  "watching together",
  "watch something together",
  "together tonight",
  "comedy for a group",
  "a group watch",
  "for a group",
  "as a group",
  "with a group",
  "group watch",
  "watching with someone",
  "group movie night with friends",
  "family night comedy",
  "together for family night",
  "with friends",
  "something with friends",
  "group movie night",
  "family night",
  "a movie for me and my girlfriend",
  "something for me and my wife",
  "for me and my husband",
  "for me and my spouse",
  "for me and my partner",
  "for me and my boyfriend",
  "for my girlfriend and me",
  "for my wife and me",
  "for my husband and me",
  "for my spouse and me",
  "for my partner and me",
  "for my boyfriend and me",
  "my partner and I",
  "my wife and I",
  "my husband and I",
  "my spouse and I",
  "my girlfriend and I",
  "my boyfriend and I",
  "both-of-us",
  "something both-of-us",
  "for both-of-us"
];

const notSharedQueries = [
  "couple of hours",
  "a couple films",
  "Couples Retreat",
  "The Couple Next Door",
  "US",
  "Us (2019)",
  "us history documentary",
  "our planet",
  "My Super Ex-Girlfriend",
  "Bride Wars",
  "The Spouse",
  "family comedy",
  "a group of films",
  "group therapy",
  "movie night",
  "someone like you",
  "Friends",
  "for my girlfriend",
  "my girlfriend",
  "both of them",
  "The Group",
  "Together",
  "Together (2018)",
  "Better Together",
  "All Together Now"
];

afterEach(() => vi.unstubAllGlobals());

describe("watch context phrases", () => {
  it.each(coupleQueries)("reads a shared watch context from %s", (query) => {
    expect(inferWatchContext(query)).toBe("group");
    expect(deriveChatCriteria(query, {}, 20, "solo").watchContext).toBe("group");
    expect(resolveWatchContext(query)).toBe("group");
  });

  it.each([
    "solo",
    "just me",
    "for me",
    "by myself",
    "a quiet movie just for me",
    "a movie for me",
    "something for me tonight",
    "for me and my friend",
    "just me and my wife"
  ])("keeps personal viewing on %s", (query) => {
    expect(inferWatchContext(query)).toBe("solo");
    expect(deriveChatCriteria(query, {}, 20, "group").watchContext).toBe("solo");
    expect(resolveWatchContext(query)).toBe("solo");
  });

  it.each(notSharedQueries)("does not treat %s as shared viewing", (query) => {
    expect(inferWatchContext(query)).toBeUndefined();
    expect(deriveChatCriteria(query, {}, 20, "solo").watchContext).toBe("solo");
    expect(resolveWatchContext(query)).toBe("solo");
  });

  it("lets an explicit solo phrase win over a shared phrase", () => {
    const query = "just me, nothing for us";
    expect(inferWatchContext(query)).toBe("solo");
    expect(deriveChatCriteria(query, {}, 20, "group").watchContext).toBe("solo");
    expect(resolveWatchContext(query)).toBe("solo");
  });

  it.each([
    "not for me, this is for us",
    "not solo, we're watching together",
    "not solo—we're watching together",
    "not just me, something for both of us",
    "this isn't for me, it's date night",
    "Not for me. Watch something together",
    "not really for me, this is for us",
    "not really for me, we're watching together"
  ])("ignores negated solo wording and lets the shared phrase win: %s", (query) => {
    expect(inferWatchContext(query)).toBe("group");
    expect(deriveChatCriteria(query, {}, 20, "solo").watchContext).toBe("group");
    expect(resolveWatchContext(query)).toBe("group");
  });

  it("does not read negated solo wording alone as solo", () => {
    expect(inferWatchContext("not for me")).toBeUndefined();
    expect(inferWatchContext("not solo")).toBeUndefined();
    expect(deriveChatCriteria("not solo", {}, 20, "group").watchContext).toBe("group");
    expect(inferWatchContext("not for us, just me")).toBe("solo");
    expect(inferWatchContext("not for us, this one is for me")).toBe("solo");
    // "knot" is not a negation, so this stays solo.
    expect(inferWatchContext("knot for me")).toBe("solo");
    expect(inferWatchContext("a knot for me, not for us")).toBe("solo");
    expect(inferWatchContext("not really for me")).toBeUndefined();
  });

  it("restores together for family night as shared viewing", () => {
    expect(deriveChatCriteria("together for family night", {}, 20, "solo").watchContext).toBe("group");
  });

  it("does not treat a quantity or a plain runtime as shared viewing", () => {
    expect(inferWatchContext("something funny, under 2 hours")).toBeUndefined();
    expect(inferWatchContext("a couple of comedies")).toBeUndefined();
    expect(deriveChatCriteria("something funny, under 2 hours", {}, 20, "solo").watchContext).toBe("solo");
    expect(deriveChatCriteria("a couple of comedies under two hours", {}, 20, "solo").watchContext).toBe("solo");
  });

  it("keeps an explicit watch context when the caller already set one", () => {
    expect(resolveWatchContext("funny movie under two hours", "group")).toBe("group");
    expect(resolveWatchContext("funny movie under two hours", "solo")).toBe("solo");
    expect(resolveWatchContext("something funny, under 2 hours, for both of us", "group")).toBe("group");
  });
});

describe("search watch context", () => {
  it("resolves an omitted watch context from the query", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const seerrClient = { search: vi.fn(async () => []) } as unknown as SeerrClient;
    const response = await new RecommendationEngine(repository, seerrClient, {
      rank: vi.fn(async ({ candidates }) => ({ usedAi: false, results: candidates }))
    }).recommend({
      query: "something funny, under 2 hours, for both of us",
      useAi: false
    });

    expect(response.watchContext).toBe("group");
    db.close();
  });

  it.each(["family comedy", "comedy for the family", "not animated, family friendly"])("leaves a family group query unchanged: %s", (query) => {
    expect(optimizeQueryDeterministically({
      query,
      filters: {},
      watchContext: "group"
    })).toBe(query);
  });

  it("keeps an exact catalogue title on the personal watch context", () => {
    expect(resolveWatchContext("Family Night", undefined, { catalogueTitle: true })).toBe("solo");
    expect(resolveWatchContext("Sleeping with Someone", undefined, { catalogueTitle: true })).toBe("solo");
    expect(resolveWatchContext("Family Night", "group", { catalogueTitle: true })).toBe("group");
  });

  it("still names the group when a group search does not already say so", () => {
    expect(optimizeQueryDeterministically({
      query: "funny movie",
      filters: {},
      watchContext: "group"
    })).toBe("funny movie; for a group");
  });

  it("keeps catalogue titles at the top of /api/search and still reads watching phrases as group", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    repository.upsertMany([
      ["Together", 2018, "Two people begin to merge.", ["Horror", "Drama"]],
      ["Family Night", 2010, "A bleak night indoors.", ["Drama", "Thriller"]],
      ["Sleeping with Someone", 2009, "An uneasy affair.", ["Drama"]],
      ["The Group", 1966, "College friends after graduation.", ["Drama"]],
      ["Red Ledger", 2011, "A heist goes wrong.", ["Action", "Crime"]],
      ["Harbor Lights", 2004, "A quiet coastal mystery.", ["Mystery"]],
      ["Paper Trail", 1998, "A reporter follows a cold case.", ["Crime"]],
      ["Silver Hour", 2016, "An astronaut waits for a signal.", ["Science Fiction"]]
    ].map(([title, year, summary, genres], index) => ({
      mediaType: "movie" as const,
      title: String(title),
      year: Number(year),
      summary: String(summary),
      genres: genres as string[],
      externalIds: { tmdb: 940000 + index },
      plex: { ratingKey: `catalogue-title-${index}`, available: true }
    })));
    expect(isNearExactCatalogueTitle(repository, "Together (2018)")).toBe(true);
    expect(isNearExactCatalogueTitle(repository, "Together")).toBe(true);
    expect(isNearExactCatalogueTitle(repository, "Family Night")).toBe(true);
    expect(isNearExactCatalogueTitle(repository, "Sleeping with Someone")).toBe(true);
    expect(isNearExactCatalogueTitle(repository, "The Group")).toBe(true);
    expect(isNearExactCatalogueTitle(repository, "watch something together")).toBe(false);
    expect(isNearExactCatalogueTitle(repository, "together for family night")).toBe(false);
    expect(isNearExactCatalogueTitle(repository, "family night comedy")).toBe(false);

    const app = createApp({ config: catalogueSearchConfig(), db });
    try {
      for (const [query, title] of [
        ["Together (2018)", "Together"],
        ["Together", "Together"],
        ["Family Night", "Family Night"]
      ] as const) {
        const response = await searchWithoutWatchContext(app, query);
        expect(response.watchContext).toBe("solo");
        expect(response.results[0]?.title).toBe(title);
      }
      const sleeping = await searchWithoutWatchContext(app, "Sleeping with Someone");
      expect(sleeping.watchContext).toBe("solo");
      expect(sleeping.results[0]?.title).toBe("Sleeping with Someone");
      const groupTitle = await searchWithoutWatchContext(app, "The Group");
      expect(groupTitle.watchContext).toBe("solo");
      expect(groupTitle.results[0]?.title).toBe("The Group");

      expect((await searchWithoutWatchContext(app, "watch something together")).watchContext).toBe("group");
      expect((await searchWithoutWatchContext(app, "together for family night")).watchContext).toBe("group");
      expect((await searchWithoutWatchContext(app, "comedy for a group")).watchContext).toBe("group");
      expect((await searchWithoutWatchContext(app, "a group watch")).watchContext).toBe("group");
    } finally {
      await app.close();
      db.close();
    }
  });

  it("lets an explicit pick win over a catalogue title and the title win over an inferred context", () => {
    expect(resolveWatchContext("Date Night", "group", { catalogueTitle: true, source: "explicit" })).toBe("group");
    expect(resolveWatchContext("Date Night", "solo", { catalogueTitle: true, source: "explicit" })).toBe("solo");
    expect(resolveWatchContext("Date Night", "group", { catalogueTitle: true })).toBe("group");
    expect(resolveWatchContext("Date Night", "group", { catalogueTitle: true, source: "inferred" })).toBe("solo");
    expect(resolveWatchContext("date night comedy", "group", { catalogueTitle: false, source: "inferred" })).toBe("group");
  });

  it("keeps a picked mode explicit over any wording and marks wording or a carried-over context inferred", () => {
    // Together picked; the pick is sent as explicit whatever the wording.
    expect(searchWatchContextFields(deriveChatCriteria("Date Night", {}, 20, "group", true))).toEqual({ watchContext: "group", watchContextSource: "explicit" });
    expect(searchWatchContextFields(deriveChatCriteria("Red Ledger", {}, 20, "group", true))).toEqual({ watchContext: "group", watchContextSource: "explicit" });
    expect(searchWatchContextFields(deriveChatCriteria("Red Ledger", {}, 20, "solo", true))).toEqual({ watchContext: "solo", watchContextSource: "explicit" });
    expect(searchWatchContextFields(deriveChatCriteria("just me tonight", {}, 20, "group", true))).toEqual({ watchContext: "group", watchContextSource: "explicit" });
    // For Me picked; wording for the other mode does not replace the pick.
    expect(searchWatchContextFields(deriveChatCriteria("Date Night", {}, 20, "solo", true))).toEqual({ watchContext: "solo", watchContextSource: "explicit" });
    expect(searchWatchContextFields(deriveChatCriteria("for us tonight", {}, 20, "solo", true))).toEqual({ watchContext: "solo", watchContextSource: "explicit" });
    expect(deriveChatCriteria("for us tonight", {}, 20, "solo", true).applied).not.toContain("watching together");
    // Nothing picked: the context is read from wording, or carried over from earlier wording.
    expect(searchWatchContextFields(deriveChatCriteria("Date Night", {}, 20, "solo"))).toEqual({ watchContext: "group", watchContextSource: "inferred" });
    expect(searchWatchContextFields(deriveChatCriteria("Red Ledger", {}, 20, "group"))).toEqual({ watchContext: "group", watchContextSource: "inferred" });
    // Other API callers that omit the source keep explicit behaviour.
    expect(searchWatchContextFields({ watchContext: "group" })).toEqual({ watchContext: "group", watchContextSource: "explicit" });
  });

  it("never flips a picked mode after a search and lets an inferred one follow the server", () => {
    expect(settledWatchContext(deriveChatCriteria("Date Night", {}, 20, "group", true), "group")).toEqual({ watchContext: "group", picked: true });
    expect(settledWatchContext({ watchContext: "group", watchContextSource: "explicit" }, "solo")).toEqual({ watchContext: "group", picked: true });
    expect(settledWatchContext(deriveChatCriteria("Date Night", {}, 20, "solo"), "solo")).toEqual({ watchContext: "solo", picked: false });
    expect(settledWatchContext(deriveChatCriteria("just me tonight", {}, 20, "group", true), "group")).toEqual({ watchContext: "group", picked: true });
  });

  it("follows the client search flow: picked modes win and inferred contexts let the title win", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    repository.upsertMany([
      ["Date Night", 2010, "A dinner reservation goes wrong.", ["Comedy", "Crime"]],
      ["Family Night", 2010, "A bleak night indoors.", ["Drama", "Thriller"]],
      ["Sleeping with Someone", 2009, "An uneasy affair.", ["Drama"]],
      ["Red Ledger", 2011, "A heist goes wrong.", ["Action", "Crime"]],
      ["Harbor Lights", 2004, "A quiet coastal mystery.", ["Mystery"]]
    ].map(([title, year, summary, genres], index) => ({
      mediaType: "movie" as const,
      title: String(title),
      year: Number(year),
      summary: String(summary),
      genres: genres as string[],
      externalIds: { tmdb: 960000 + index },
      plex: { ratingKey: `client-title-${index}`, available: true }
    })));
    const app = createApp({ config: catalogueSearchConfig(), db });
    try {
      for (const title of ["Date Night", "Family Night", "Sleeping with Someone"]) {
        // Inferred from wording or carried over (nothing picked): the title wins.
        for (const [currentContext, picked] of [["solo", false], ["group", false]] as const) {
          const criteria = deriveChatCriteria(title, {}, 5, currentContext, picked);
          expect(criteria.watchContext).toBe("group");
          expect(criteria.watchContextSource).toBe("inferred");
          const response = await searchFromClientCriteria(app, criteria);
          expect(response.watchContext).toBe("solo");
          expect(response.results[0]?.title).toBe(title);
          expect(settledWatchContext(criteria, response.watchContext)).toEqual({ watchContext: "solo", picked: false });
        }
        // Together picked: the pick wins and the toggle does not flip.
        const picked = deriveChatCriteria(title, {}, 5, "group", true);
        expect(picked.watchContextSource).toBe("explicit");
        const response = await searchFromClientCriteria(app, picked);
        expect(response.watchContext).toBe("group");
        expect(response.results.map((item) => item.title)).toContain(title);
        expect(settledWatchContext(picked, response.watchContext)).toEqual({ watchContext: "group", picked: true });
        // For Me picked: the pick wins over the title's wording and stays picked.
        const pickedSolo = deriveChatCriteria(title, {}, 5, "solo", true);
        expect(pickedSolo).toMatchObject({ watchContext: "solo", watchContextSource: "explicit" });
        const soloResponse = await searchFromClientCriteria(app, pickedSolo);
        expect(soloResponse.watchContext).toBe("solo");
        expect(soloResponse.results[0]?.title).toBe(title);
        expect(settledWatchContext(pickedSolo, soloResponse.watchContext)).toEqual({ watchContext: "solo", picked: true });
      }
      // A shared phrase around the title still searches together, and a picked mode wins on any title.
      expect((await searchFromClientCriteria(app, deriveChatCriteria("date night comedy for us", {}, 5, "solo"))).watchContext).toBe("group");
      expect((await searchFromClientCriteria(app, deriveChatCriteria("Red Ledger", {}, 5, "group", true))).watchContext).toBe("group");
      expect((await searchFromClientCriteria(app, deriveChatCriteria("Red Ledger", {}, 5, "group"))).watchContext).toBe("solo");
      expect((await searchFromClientCriteria(app, deriveChatCriteria("not for me, this is for us", {}, 5, "solo"))).watchContext).toBe("group");
    } finally {
      await app.close();
      db.close();
    }
  });

  it("keeps Better Together and All Together Now personal when they are catalogue titles", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    repository.upsertMany([
      ["Better Together", 2012, "A music documentary.", ["Documentary"]],
      ["All Together Now", 2020, "A teen music story.", ["Drama", "Music"]],
      ["Together", 2018, "Two people begin to merge.", ["Horror", "Drama"]],
      ["Red Ledger", 2011, "A heist goes wrong.", ["Action", "Crime"]]
    ].map(([title, year, summary, genres], index) => ({
      mediaType: "movie" as const,
      title: String(title),
      year: Number(year),
      summary: String(summary),
      genres: genres as string[],
      externalIds: { tmdb: 950000 + index },
      plex: { ratingKey: `together-title-${index}`, available: true }
    })));
    const app = createApp({ config: catalogueSearchConfig(), db });
    try {
      for (const title of ["Better Together", "All Together Now"]) {
        const response = await searchWithoutWatchContext(app, title);
        expect(response.watchContext).toBe("solo");
        expect(response.results[0]?.title).toBe(title);
      }
      const dated = await searchWithoutWatchContext(app, "Together (2018)");
      expect(dated.watchContext).toBe("solo");
      expect(dated.results[0]?.title).toBe("Together");
    } finally {
      await app.close();
      db.close();
    }
  });
});

describe("Finder watch mode state (App.tsx transitions)", () => {
  // Mirrors App.tsx: submitChat → runRecommendationSearch → watchModeBeforeSearch, the request,
  // then watchModeAfterSearch on success only. The toggle is pickWatchMode and reset is resetWatchMode.
  async function chat(
    state: WatchModeState,
    prompt: string,
    search: (criteria: ChatCriteria) => Promise<SearchResponse>,
    previousQuery = ""
  ) {
    const criteria = deriveChatCriteria(prompt, {}, 5, state.watchContext, state.picked);
    const sent = { ...criteria, query: buildConversationQuery(prompt, previousQuery) };
    let current = watchModeBeforeSearch(state, sent);
    const beforeRequest = current;
    let response: SearchResponse | undefined;
    try {
      response = await search(sent);
      current = watchModeAfterSearch(current, sent, response.watchContext);
    } catch {
      // A failed search leaves the mode as it was before the request.
    }
    return { state: current, beforeRequest, sent: searchWatchContextFields(sent), response };
  }

  async function withCatalogue(run: (search: (criteria: ChatCriteria) => Promise<SearchResponse>) => Promise<void>) {
    const db = createDatabase(":memory:");
    new MediaRepository(db).upsertMany([
      ["Date Night", 2010, "A dinner reservation goes wrong.", ["Comedy", "Crime"]],
      ["Family Night", 2010, "A bleak night indoors.", ["Drama", "Thriller"]],
      ["Red Ledger", 2011, "A heist goes wrong.", ["Action", "Crime"]],
      ["Harbor Lights", 2004, "A quiet coastal mystery.", ["Mystery"]]
    ].map(([title, year, summary, genres], index) => ({
      mediaType: "movie" as const,
      title: String(title),
      year: Number(year),
      summary: String(summary),
      genres: genres as string[],
      externalIds: { tmdb: 970000 + index },
      plex: { ratingKey: `watch-mode-${index}`, available: true }
    })));
    const app = createApp({ config: catalogueSearchConfig(), db });
    try {
      await run((criteria) => searchFromClientCriteria(app, criteria));
    } finally {
      await app.close();
      db.close();
    }
  }

  it("starts unpicked on For Me, the toggle picks, and reset clears the pick", () => {
    expect(initialWatchMode).toEqual({ watchContext: "solo", picked: false });
    expect(pickWatchMode("group")).toEqual({ watchContext: "group", picked: true });
    expect(pickWatchMode("solo")).toEqual({ watchContext: "solo", picked: true });
    expect(resetWatchMode()).toEqual({ watchContext: "solo", picked: false });
    expect(currentWatchModeCriteria(pickWatchMode("group"))).toEqual({ watchContext: "group", watchContextSource: "explicit" });
    expect(currentWatchModeCriteria({ watchContext: "group", picked: false })).toEqual({ watchContext: "group", watchContextSource: "inferred" });
  });

  it.each([
    ["solo", "for us tonight"],
    ["solo", "with my partner"],
    ["solo", "not for me, this is for us"],
    ["solo", "the two of us"],
    ["solo", "Date Night"],
    ["group", "just me"],
    ["group", "by myself"],
    ["group", "Date Night"],
    ["group", "Red Ledger"]
  ] as const)("keeps a picked %s mode and the pick when the user types %s", async (mode, prompt) => {
    await withCatalogue(async (search) => {
      const result = await chat(pickWatchMode(mode), prompt, search);
      expect(result.sent).toEqual({ watchContext: mode, watchContextSource: "explicit" });
      expect(result.beforeRequest).toEqual({ watchContext: mode, picked: true });
      expect(result.response?.watchContext).toBe(mode);
      expect(result.state).toEqual({ watchContext: mode, picked: true });
    });
  });

  it("keeps the pick through follow-ups, saved searches and reruns, until reset", async () => {
    await withCatalogue(async (search) => {
      let state = pickWatchMode("solo");
      let result = await chat(state, "for us tonight", search);
      state = result.state;
      result = await chat(state, "with my partner", search, "for us tonight");
      expect(result.sent.watchContextSource).toBe("explicit");
      state = result.state;
      // Saved search: the prompt is sent as the query without a follow-up prefix.
      const saved = deriveChatCriteria("Date Night", {}, 5, state.watchContext, state.picked);
      const savedResponse = await search(saved);
      state = watchModeAfterSearch(watchModeBeforeSearch(state, saved), saved, savedResponse.watchContext);
      expect(savedResponse.watchContext).toBe("solo");
      expect(state).toEqual({ watchContext: "solo", picked: true });
      // Rerun with the current criteria.
      const rerun = { query: "Date Night", filters: {}, resultLimit: 5, applied: [], ...currentWatchModeCriteria(state) };
      expect(rerun.watchContextSource).toBe("explicit");
      state = watchModeAfterSearch(watchModeBeforeSearch(state, rerun), rerun, (await search(rerun)).watchContext);
      expect(state).toEqual({ watchContext: "solo", picked: true });
      // Reset clears the pick; the wording then decides again.
      state = resetWatchMode();
      result = await chat(state, "for us tonight", search);
      expect(result.sent).toEqual({ watchContext: "group", watchContextSource: "inferred" });
      expect(result.state).toEqual({ watchContext: "group", picked: false });
    });
  });

  it("carries an unpicked context over as inferred so a bare title still wins", async () => {
    await withCatalogue(async (search) => {
      let result = await chat(initialWatchMode, "date night comedy for us", search);
      expect(result.state).toEqual({ watchContext: "group", picked: false });
      result = await chat(result.state, "Red Ledger", search);
      expect(result.sent).toEqual({ watchContext: "group", watchContextSource: "inferred" });
      expect(result.response?.watchContext).toBe("solo");
      expect(result.state).toEqual({ watchContext: "solo", picked: false });
      result = await chat(initialWatchMode, "Date Night", search);
      expect(result.beforeRequest).toEqual({ watchContext: "group", picked: false });
      expect(result.state).toEqual({ watchContext: "solo", picked: false });
    });
  });

  it("keeps the pick when a search fails", async () => {
    const failing = async () => {
      throw new Error("search failed");
    };
    for (const [mode, prompt] of [["solo", "for us tonight"], ["group", "just me"], ["solo", "Date Night"]] as const) {
      const result = await chat(pickWatchMode(mode), prompt, failing);
      expect(result.response).toBeUndefined();
      expect(result.state).toEqual({ watchContext: mode, picked: true });
    }
    // Unpicked: the mode shows what was sent and stays unpicked.
    const unpicked = await chat(initialWatchMode, "for us tonight", failing);
    expect(unpicked.state).toEqual({ watchContext: "group", picked: false });
  });

  it("keeps a mode picked while a search is running", () => {
    const sent = deriveChatCriteria("Date Night", {}, 5, "solo", false);
    const running = watchModeBeforeSearch(initialWatchMode, sent);
    const toggled = pickWatchMode("group");
    expect(watchModeAfterSearch(toggled, sent, "solo")).toEqual({ watchContext: "group", picked: true });
    expect(watchModeAfterSearch(running, sent, "solo")).toEqual({ watchContext: "solo", picked: false });
  });
});

function catalogueSearchConfig(): AppConfig {
  return {
    fixtureMode: false,
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
      clientIdentifier: "moodarr-test",
      productName: "Moodarr Test"
    },
    plex: { webBaseUrl: "https://app.plex.tv/desktop" },
    seerr: {},
    ai: {
      provider: "none",
      openaiModel: "gpt-test",
      openaiEmbeddingModel: "text-embedding-3-large",
      openaiReasoningEffort: "low",
      openaiServiceTier: "default"
    },
    sync: { intervalMinutes: 0, syncSeerr: false },
    search: { defaultResultLimit: 10 },
    reviewQueue: { retentionDays: 90, maxQueries: 500, captureRawQueries: false },
    knownSecrets: []
  };
}

async function searchFromClientCriteria(app: ReturnType<typeof createApp>, criteria: ReturnType<typeof deriveChatCriteria>) {
  const response = await app.inject({
    method: "POST",
    url: "/api/search",
    payload: { query: criteria.query, ...searchWatchContextFields(criteria), useAi: false, resultLimit: criteria.resultLimit, filters: criteria.filters }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as SearchResponse;
}

async function searchWithoutWatchContext(app: ReturnType<typeof createApp>, query: string) {
  const response = await app.inject({
    method: "POST",
    url: "/api/search",
    payload: { query, useAi: false, resultLimit: 5 }
  });
  expect(response.statusCode).toBe(200);
  return response.json() as SearchResponse;
}

describe("brief parser watch context guidance", () => {
  it("tells the brief model that couple phrases are the shared watch context", async () => {
    const fetchMock = vi.fn<(url: unknown, init?: RequestInit) => Promise<Response>>(async () => Response.json({
      output: [{ content: [{ type: "output_text", text: JSON.stringify({
        terms: [],
        softGenres: [],
        moods: [],
        referenceTitle: null,
        hardFilters: {
          mediaTypes: [],
          minRuntimeMinutes: null,
          maxRuntimeMinutes: null,
          minYear: null,
          maxYear: null,
          genres: [],
          excludedGenres: [],
          contentRating: null,
          availability: [],
          requestStatus: []
        },
        wantsBetter: false,
        wantsRequestOptions: false
      }) }] }]
    }));
    vi.stubGlobal("fetch", fetchMock);
    const config = {
      ai: {
        provider: "openai",
        openaiApiKey: "test-only",
        openaiModel: "gpt-test",
        openaiReasoningEffort: "low",
        openaiServiceTier: "default"
      }
    } as AppConfig;

    await new OpenAiBriefParser(config).parse({
      query: "something funny, under 2 hours, for both of us",
      deterministicIntent: parseRecommendationIntent("something funny, under 2 hours, for both of us"),
      explicitFilters: {},
      watchContext: "group"
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const developerPrompt = body.input[0].content[0].text as string;
    const userPayload = JSON.parse(body.input[1].content[0].text as string);
    expect(developerPrompt).toContain(sharedWatchContextBriefGuidance);
    expect(developerPrompt).toContain("for both of us");
    expect(developerPrompt).toContain("with my husband");
    expect(developerPrompt).toContain("with my spouse");
    expect(developerPrompt).toContain("just me");
    expect(userPayload.watchContext).toBe("group");
  });
});
