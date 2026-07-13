import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { fetchWithSameOriginRedirects } from "../src/server/security/http";
import { normalizeHttpBaseUrl } from "../src/server/security/urlPolicy";
import { PosterFetchCoordinator } from "../src/server/posters/posterFetchCoordinator";
import { posterCacheSourceKey } from "../src/server/posters/posterCacheKey";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("server hardening invariants", () => {
  it("configures a bounded SQLite lock wait", () => {
    const db = createDatabase(":memory:");
    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    db.close();
  });

  it("keeps the derived availability index consistent after Plex removal and request creation", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const id = repository.upsert({
      mediaType: "movie",
      title: "Index Invariant",
      year: 2026,
      summary: "A bounded test item.",
      plex: { ratingKey: "index-invariant", available: true },
      seerr: { tmdbId: 42, status: "unknown", requestable: true }
    });

    repository.markPlexUnavailableExceptRatingKeys([]);
    expect(repository.findById(id)?.availabilityGroup).toBe("not_in_plex_requestable");
    expect(db.prepare("SELECT availability_group FROM catalog_search_index WHERE media_item_id = ?").get(id)).toEqual({
      availability_group: "not_in_plex_requestable"
    });

    repository.saveRequest(id, "movie", 42, undefined, "created", "request-42");
    expect(repository.findById(id)?.availabilityGroup).toBe("already_requested");
    expect(db.prepare("SELECT availability_group FROM catalog_search_index WHERE media_item_id = ?").get(id)).toEqual({
      availability_group: "already_requested"
    });
    db.close();
  });

  it("attaches operational Seerr state without replacing trusted Plex metadata", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const id = repository.upsert({
      source: "live",
      mediaType: "movie",
      title: "Trusted Local Title",
      year: 2026,
      summary: "Trusted Plex summary.",
      runtimeMinutes: 101,
      contentRating: "PG",
      posterPath: "/library/metadata/42/thumb/7",
      ratings: { critic: 8.1, audience: 8.2, user: 8.3 },
      genres: ["Adventure", "Comedy"],
      cast: ["Trusted Performer"],
      directors: ["Trusted Director"],
      externalIds: { tmdb: 42 },
      plex: { ratingKey: "42", available: false }
    });

    const linkedId = repository.upsert({
      source: "operational",
      mediaType: "movie",
      title: "Forbidden Operational Title",
      year: 1900,
      summary: "Forbidden operational summary.",
      runtimeMinutes: 999,
      contentRating: "X",
      posterPath: "tmdb://w500/forbidden-operational-poster.jpg",
      ratings: { critic: 1.1, audience: 1.2, user: 1.3 },
      genres: ["Horror"],
      cast: ["Forbidden Performer"],
      directors: ["Forbidden Director"],
      externalIds: { tmdb: 42 },
      seerr: { tmdbId: 42, seerrMediaId: 9001, status: "pending", requestStatus: "approved", requestable: false }
    });

    expect(linkedId).toBe(id);
    expect(repository.findById(id)).toMatchObject({
      title: "Trusted Local Title",
      year: 2026,
      summary: "Trusted Plex summary.",
      runtimeMinutes: 101,
      contentRating: "PG",
      ratings: { critic: 8.1, audience: 8.2, user: 8.3 },
      genres: ["Adventure", "Comedy"],
      cast: ["Trusted Performer"],
      directors: ["Trusted Director"],
      metadata: { source: "live" },
      seerr: { mediaId: 42, status: "pending", requestStatus: "approved", requestable: false }
    });
    expect(repository.getPosterPath(id)).toBe("/library/metadata/42/thumb/7");
    db.close();
  });

  it("invalidates a cached poster when its source changes", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const id = repository.upsert({ mediaType: "movie", title: "Poster Source", year: 2026 });
    repository.savePosterCache(id, "source-a", "image/jpeg", Buffer.from("poster"));

    expect(repository.getPosterCache(id, "source-a")?.body.toString()).toBe("poster");
    expect(repository.getPosterCache(id, "source-b")).toBeUndefined();
    expect(repository.posterCacheDiagnostics().rows).toBe(0);
    db.close();
  });

  it("purges cached posters at the 180-day limit or with invalid dates while retaining fresh entries", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const staleId = repository.upsert({ mediaType: "movie", title: "Expired Poster", year: 2026 });
    const invalidDateId = repository.upsert({ mediaType: "movie", title: "Invalid Poster Date", year: 2026 });
    const futureDateId = repository.upsert({ mediaType: "movie", title: "Future Poster Date", year: 2026 });
    const freshId = repository.upsert({ mediaType: "movie", title: "Fresh Poster", year: 2026 });
    repository.savePosterCache(staleId, "source-stale", "image/jpeg", Buffer.from("stale"));
    repository.savePosterCache(invalidDateId, "source-invalid", "image/jpeg", Buffer.from("invalid"));
    repository.savePosterCache(futureDateId, "source-future", "image/jpeg", Buffer.from("future"));
    repository.savePosterCache(freshId, "source-fresh", "image/jpeg", Buffer.from("fresh"));
    db.prepare("UPDATE poster_cache SET fetched_at = datetime('now', '-180 days') WHERE media_item_id = ?").run(staleId);
    db.prepare("UPDATE poster_cache SET fetched_at = 'invalid' WHERE media_item_id = ?").run(invalidDateId);
    db.prepare("UPDATE poster_cache SET fetched_at = datetime('now', '+1 day') WHERE media_item_id = ?").run(futureDateId);
    db.prepare("UPDATE poster_cache SET fetched_at = datetime('now', '-179 days') WHERE media_item_id = ?").run(freshId);

    expect(repository.purgeExpiredPosterCache()).toBe(3);
    expect(repository.getPosterCache(staleId, "source-stale")).toBeUndefined();
    expect(repository.getPosterCache(invalidDateId, "source-invalid")).toBeUndefined();
    expect(repository.getPosterCache(futureDateId, "source-future")).toBeUndefined();
    expect(repository.getPosterCache(freshId, "source-fresh")?.body.toString()).toBe("fresh");
    expect(repository.posterCacheDiagnostics().rows).toBe(1);
    db.close();
  });

  it("deletes an expired poster lazily instead of serving it", () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const id = repository.upsert({ mediaType: "movie", title: "Lazy Expiry", year: 2026 });
    repository.savePosterCache(id, "source", "image/jpeg", Buffer.from("stale"));
    db.prepare("UPDATE poster_cache SET fetched_at = datetime('now', '-181 days') WHERE media_item_id = ?").run(id);

    expect(repository.getPosterCache(id, "source")).toBeUndefined();
    expect(repository.posterCacheDiagnostics().rows).toBe(0);
    db.close();
  });

  it("keys poster cache entries by upstream origin and source type", () => {
    const plexPath = "/library/metadata/42/thumb/123";
    expect(posterCacheSourceKey(plexPath, "http://plex-a.example:32400")).not.toBe(
      posterCacheSourceKey(plexPath, "http://plex-b.example:32400")
    );
    expect(posterCacheSourceKey("tmdb://w500/poster.jpg", "http://plex-a.example:32400")).toBe(
      posterCacheSourceKey("tmdb://w500/poster.jpg", "http://plex-b.example:32400")
    );
  });

  it("coalesces duplicate poster fetches and respects the global concurrency bound", async () => {
    const coordinator = new PosterFetchCoordinator(2, 10);
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    const task = async (value: string) => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return value;
    };

    const [sameA, sameB, otherA, otherB] = await Promise.all([
      coordinator.run("same", () => task("same")),
      coordinator.run("same", () => task("duplicate")),
      coordinator.run("other-a", () => task("a")),
      coordinator.run("other-b", () => task("b"))
    ]);

    expect([sameA, sameB, otherA, otherB]).toEqual(["same", "same", "a", "b"]);
    expect(calls).toBe(3);
    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("rejects credential-bearing, query-bearing, and link-local integration base URLs", () => {
    expect(() => normalizeHttpBaseUrl("http://user:pass@plex.local:32400", "Plex base URL")).toThrow(/embedded credentials/i);
    expect(() => normalizeHttpBaseUrl("http://plex.local:32400/?token=secret", "Plex base URL")).toThrow(/query string/i);
    expect(() => normalizeHttpBaseUrl("http://169.254.169.254/latest", "Plex base URL")).toThrow(/link-local metadata/i);
    expect(normalizeHttpBaseUrl("http://192.168.1.20:32400", "Plex base URL")).toBe("http://192.168.1.20:32400");
  });

  it("does not forward integration headers across an origin-changing redirect", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Response(null, { status: 302, headers: { Location: "https://attacker.example/steal" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchWithSameOriginRedirects("http://plex.local/identity", { headers: { "X-Plex-Token": "secret" } })
    ).rejects.toThrow(/crossed the configured origin/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });
});
