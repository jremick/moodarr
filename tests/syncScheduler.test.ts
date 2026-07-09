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
});

function createScheduler() {
  const config = {
    fixtureMode: true,
    knownSecrets: [],
    sync: { intervalMinutes: 30, syncSeerr: false }
  } as unknown as AppConfig;
  const repository = {
    upsertMany: vi.fn(() => []),
    markPlexUnavailableExcept: vi.fn(() => 0),
    recordSync: vi.fn(),
    syncHistory: vi.fn(() => [])
  } as unknown as MediaRepository;
  const plexClient = { syncLibrary: vi.fn(async () => []) } as unknown as PlexClient;
  const seerrClient = { syncRequests: vi.fn(async () => []) } as unknown as SeerrClient;
  return new SyncScheduler(config, repository, plexClient, seerrClient);
}
