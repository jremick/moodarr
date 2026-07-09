import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/config";
import type { MediaRepository } from "../src/server/db/mediaRepository";
import type { PlexClient } from "../src/server/integrations/plexClient";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { SyncScheduler } from "../src/server/jobs/syncScheduler";

describe("SyncScheduler", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps the next scheduled run stable when an admin triggers a manual sync", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T00:00:00.000Z"));
    const scheduler = createScheduler();

    scheduler.start();
    expect(scheduler.status().nextRunAt).toBe("2026-07-10T00:30:00.000Z");

    vi.setSystemTime(new Date("2026-07-10T00:05:00.000Z"));
    await scheduler.runOnce();

    expect(scheduler.status().nextRunAt).toBe("2026-07-10T00:30:00.000Z");
    scheduler.stop();
  });

  it("reports the next real execution after a scheduled run completes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T00:00:00.000Z"));
    const scheduler = createScheduler();

    scheduler.start();
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);

    expect(scheduler.status()).toMatchObject({
      enabled: true,
      running: false,
      nextRunAt: "2026-07-10T01:00:00.000Z"
    });
    scheduler.stop();
  });

  it("does not let a stale in-flight callback create a duplicate timer after restart", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-10T00:00:00.000Z"));
    let resolveSync!: (value: []) => void;
    const pending = new Promise<[]>((resolve) => {
      resolveSync = resolve;
    });
    const plexClient = { syncLibrary: vi.fn(() => pending) } as unknown as PlexClient;
    const scheduler = createScheduler(plexClient);

    scheduler.start();
    vi.advanceTimersByTime(30 * 60 * 1000);
    await Promise.resolve();
    expect(scheduler.status().running).toBe(true);

    scheduler.restart();
    expect(scheduler.status().nextRunAt).toBe("2026-07-10T01:00:00.000Z");
    resolveSync([]);
    await Promise.resolve();
    await Promise.resolve();

    expect(scheduler.status().nextRunAt).toBe("2026-07-10T01:00:00.000Z");
    await scheduler.stopAndWait();
  });

  it("does not persist or record success for results returned after cancellation", async () => {
    let resolveSync!: (value: Awaited<ReturnType<SeerrClient["syncRequests"]>>) => void;
    const pending = new Promise<Awaited<ReturnType<SeerrClient["syncRequests"]>>>((resolve) => {
      resolveSync = resolve;
    });
    const seerrClient = { syncRequests: vi.fn(() => pending) } as unknown as SeerrClient;
    const repository = {
      upsertMany: vi.fn(() => []),
      markPlexUnavailableExcept: vi.fn(() => 0),
      recordSync: vi.fn(),
      syncHistory: vi.fn(() => [])
    } as unknown as MediaRepository;
    const scheduler = createScheduler(undefined, repository, seerrClient);

    const run = scheduler.runOnce({ syncPlex: false, syncSeerr: true, warmEmbeddings: false });
    await Promise.resolve();
    scheduler.stop();
    resolveSync([{ mediaType: "movie", title: "Late cancelled result" }]);
    const result = await run;

    expect(result.ok).toBe(false);
    expect(repository.upsertMany).not.toHaveBeenCalled();
    expect(repository.markPlexUnavailableExcept).not.toHaveBeenCalled();
    expect(repository.recordSync).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), "ok", expect.anything());
  });
});

function createScheduler(plexClientOverride?: PlexClient, repositoryOverride?: MediaRepository, seerrClientOverride?: SeerrClient) {
  const config = {
    fixtureMode: true,
    knownSecrets: [],
    sync: { intervalMinutes: 30, syncSeerr: false }
  } as unknown as AppConfig;
  const repository = repositoryOverride ?? ({
    upsertMany: vi.fn(() => []),
    markPlexUnavailableExcept: vi.fn(() => 0),
    recordSync: vi.fn(),
    syncHistory: vi.fn(() => [])
  } as unknown as MediaRepository);
  const plexClient = plexClientOverride ?? ({ syncLibrary: vi.fn(async () => []) } as unknown as PlexClient);
  const seerrClient = seerrClientOverride ?? ({ syncRequests: vi.fn(async () => []) } as unknown as SeerrClient);
  return new SyncScheduler(config, repository, plexClient, seerrClient);
}
