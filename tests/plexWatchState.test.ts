import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";
import { UserRepository } from "../src/server/auth/userRepository";
import { interpretPlexWatchPayloads, PlexWatchStateReader } from "../src/server/integrations/plexWatchState";

const nowSeconds = 1_760_630_400;
const nowMs = nowSeconds * 1000;
const viewerToken = "viewer-plex-token";
const sharedToken = "shared-plex-token";
const serverToken = "server-plex-token";

function fixture(name: string) {
  return JSON.parse(readFileSync(new URL(`./fixtures/plex-watch/${name}.json`, import.meta.url), "utf8")) as unknown;
}

function config(recentWatchDays = 180, fixtureMode = false): AppConfig {
  return {
    fixtureMode,
    plex: { baseUrl: "http://plex.example:32400", token: serverToken, webBaseUrl: "https://app.plex.tv/desktop" },
    search: { defaultResultLimit: 50, recentWatchDays },
    knownSecrets: [serverToken]
  } as AppConfig;
}

function sorted(values: Iterable<string>) {
  return [...values].sort();
}

describe("Plex watch payload interpretation", () => {
  const payloads = {
    accounts: fixture("accounts"),
    historyPages: [fixture("history")],
    libraryPages: [fixture("movies"), fixture("shows-recent"), fixture("shows-completed")],
    nowMs,
    recentWatchDays: 180
  };

  it("uses viewCount, lastViewedAt, and this account's history only", () => {
    const state = interpretPlexWatchPayloads({ ...payloads, identity: { providerUserId: "333", username: "viewer" } });

    expect(sorted(state.recentRatingKeys)).toEqual(["movie-boundary-in", "movie-history", "movie-recent", "show-partial"]);
    expect(sorted(state.completedShowRatingKeys)).toEqual(["show-finished"]);
    expect(state.recentRatingKeys.has("movie-shared")).toBe(false);
    expect(state.recentRatingKeys.has("show-shared")).toBe(false);
    expect(state.recentRatingKeys.has("episode-1")).toBe(false);
    expect(state.recentRatingKeys.has("movie-cleared")).toBe(false);
    expect(state.recentRatingKeys.has("movie-old")).toBe(false);
    expect(state.recentRatingKeys.has("movie-boundary-out")).toBe(false);
    expect(state.recentRatingKeys.has("movie-owner")).toBe(false);
    expect(state.recentTitles.has("movie|recent movie|2016")).toBe(true);
    expect(state.completedShowTitles.has("tv|finished show|2011")).toBe(true);
    expect(state.recentTitles.has("movie|shared only|2019")).toBe(false);
  });

  it("does not let a shared account's plays count for the server owner token", () => {
    const state = interpretPlexWatchPayloads({
      ...payloads,
      libraryPages: [],
      identity: { providerUserId: "999", username: "plexowner", preferLocalOwnerAccount: true }
    });

    expect(sorted(state.recentRatingKeys)).toEqual(["movie-owner"]);
    expect(state.recentRatingKeys.has("movie-shared")).toBe(false);
    expect(state.recentRatingKeys.has("show-shared")).toBe(false);
  });

  it("ignores history when the Plex account cannot be resolved, and still trusts token-scoped library state", () => {
    const state = interpretPlexWatchPayloads({
      ...payloads,
      identity: { providerUserId: "999", username: "nobody" }
    });

    expect(state.recentRatingKeys.has("movie-history")).toBe(false);
    expect(state.recentRatingKeys.has("movie-shared")).toBe(false);
    expect(state.recentRatingKeys.has("movie-recent")).toBe(true);
    expect(state.completedShowRatingKeys.has("show-finished")).toBe(true);
  });

  it("disables the recency window and still marks fully watched shows", () => {
    const state = interpretPlexWatchPayloads({
      ...payloads,
      identity: { providerUserId: "333", username: "viewer" },
      recentWatchDays: 0
    });

    expect(state.recentRatingKeys.size).toBe(0);
    expect(sorted(state.completedShowRatingKeys)).toEqual(["show-finished"]);
  });

  it("drops reflected secrets and rejects malformed watch payloads without echoing them", () => {
    const secret = "watch-state-secret-token";
    const movies = fixture("movies") as { MediaContainer: { Metadata: Array<Record<string, unknown>> } };
    movies.MediaContainer.Metadata.push({ ratingKey: "movie-secret", type: "movie", title: `Leaked ${secret}`, year: 2020, viewCount: 1, lastViewedAt: 1759900000 });
    const state = interpretPlexWatchPayloads({
      ...payloads,
      libraryPages: [movies],
      identity: { providerUserId: "333", username: "viewer" },
      knownSecrets: [secret]
    });

    expect([...state.recentTitles, ...state.completedShowTitles].join("\n")).not.toContain(secret);
    expect(state.recentRatingKeys.has("movie-secret")).toBe(true);

    expect(() => interpretPlexWatchPayloads({
      accounts: null,
      historyPages: [],
      libraryPages: [],
      identity: { providerUserId: secret },
      nowMs,
      recentWatchDays: 180,
      knownSecrets: [secret]
    })).toThrow(/invalid accounts response/);
    try {
      interpretPlexWatchPayloads({
        accounts: null,
        historyPages: [],
        libraryPages: [],
        identity: { providerUserId: secret },
        nowMs,
        recentWatchDays: 180,
        knownSecrets: [secret]
      });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe("Plex watch state reader", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("reads with the signed-in user's token, caches the result, and keeps shared history out", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const token = new Headers(init?.headers).get("x-plex-token");
      expect(token).not.toBe(serverToken);
      calls.push(`${token ?? ""} ${url.pathname}${url.search}`);
      return jsonResponse(responseFor(url, token));
    });

    const { users, viewer, shared } = usersWithTokens();
    let now = nowMs;
    const reader = new PlexWatchStateReader(config(), users, { now: () => now });
    const first = reader.loadForUser(viewer.id);
    const second = reader.loadForUser(viewer.id);
    const [viewerState, duplicate] = await Promise.all([first, second]);
    expect(duplicate).toBe(viewerState);
    expect(calls.filter((call) => call.startsWith(viewerToken)).length).toBe(6);
    expect(viewerState?.recentRatingKeys.has("movie-shared")).toBe(false);
    expect(viewerState?.recentRatingKeys.has("movie-history")).toBe(true);
    expect(viewerState?.completedShowRatingKeys.has("show-finished")).toBe(true);

    const sharedState = await reader.loadForUser(shared.id);
    expect(sorted(sharedState?.recentRatingKeys ?? [])).toEqual(["movie-shared", "show-shared"]);
    expect(sharedState?.recentRatingKeys.has("movie-history")).toBe(false);
    expect(sharedState?.recentRatingKeys.has("movie-recent")).toBe(false);
    expect(sharedState?.completedShowRatingKeys.size).toBe(0);

    const callsAfterCache = calls.length;
    await reader.loadForUser(viewer.id);
    expect(calls.length).toBe(callsAfterCache);
    now += 11 * 60 * 1000;
    await reader.loadForUser(viewer.id);
    expect(calls.length).toBeGreaterThan(callsAfterCache);
  });

  it("caches a failed read briefly and does not call Plex without a user token or in fixture mode", async () => {
    let fetches = 0;
    vi.stubGlobal("fetch", () => {
      fetches += 1;
      return jsonResponse({ error: "nope" }, 500);
    });
    const { users, viewer } = usersWithTokens();
    let now = nowMs;
    const reader = new PlexWatchStateReader(config(), users, { now: () => now, failureTtlMs: 60_000 });
    const failed = await reader.loadForUser(viewer.id);
    expect(failed?.recentRatingKeys.size).toBe(0);
    expect(fetches).toBeGreaterThan(0);
    const fetchesAfterFailure = fetches;
    await reader.loadForUser(viewer.id);
    expect(fetches).toBe(fetchesAfterFailure);
    now += 61_000;
    await reader.loadForUser(viewer.id);
    expect(fetches).toBeGreaterThan(fetchesAfterFailure);

    const fetchesBeforeIdle = fetches;
    const noToken = users.upsertPlexUser({ providerUserId: "444", username: "quiet" }, true);
    expect(await reader.loadForUser(noToken.id)).toBeUndefined();
    const fixtureReader = new PlexWatchStateReader(config(180, true), users, { now: () => now });
    expect(await fixtureReader.loadForUser(viewer.id)).toBeUndefined();
    expect(fetches).toBe(fetchesBeforeIdle);
  });
});

function usersWithTokens() {
  const db = createDatabase(":memory:");
  const users = new UserRepository(db);
  const viewer = users.upsertPlexUser({ providerUserId: "333", username: "viewer" }, true, viewerToken);
  const shared = users.upsertPlexUser({ providerUserId: "222", username: "shared" }, true, sharedToken);
  return { users, viewer, shared };
}

function responseFor(url: URL, token: string | null) {
  if (url.pathname === "/accounts") return fixture("accounts");
  if (url.pathname === "/library/sections") return fixture("sections");
  if (url.pathname === "/status/sessions/history/all") {
    const start = Number(url.searchParams.get("X-Plex-Container-Start") ?? 0);
    return start > 0 ? { MediaContainer: { Metadata: [] } } : fixture("history");
  }
  if (url.pathname === "/library/sections/1/all") return token === sharedToken ? fixture("shared-library") : fixture("movies");
  if (url.pathname === "/library/sections/2/all") {
    if (token === sharedToken) return { MediaContainer: { Metadata: [] } };
    return url.searchParams.get("unwatched") === "0" ? fixture("shows-completed") : fixture("shows-recent");
  }
  return { MediaContainer: {} };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
