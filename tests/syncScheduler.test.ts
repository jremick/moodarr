import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/config";
import type { MediaRepository } from "../src/server/db/mediaRepository";
import type { PlexClient } from "../src/server/integrations/plexClient";
import type { PlexLibrarySnapshot } from "../src/server/integrations/plexClient";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import { SyncScheduler } from "../src/server/jobs/syncScheduler";
import type { SyncWorkerPool } from "../src/server/jobs/syncWorkerPool";

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
    let resolveSync!: (value: PlexLibrarySnapshot) => void;
    const pending = new Promise<PlexLibrarySnapshot>((resolve) => {
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
    resolveSync({ records: [], complete: true, sectionCount: 0 });
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

  it("accepts a manual run without awaiting it and rejects a concurrent run", async () => {
    let resolveSync!: (value: PlexLibrarySnapshot) => void;
    const pending = new Promise<PlexLibrarySnapshot>((resolve) => {
      resolveSync = resolve;
    });
    const plexClient = { syncLibrary: vi.fn(() => pending) } as unknown as PlexClient;
    const scheduler = createScheduler(plexClient);

    const accepted = scheduler.requestRun({ warmEmbeddings: false });
    expect(accepted).toMatchObject({ accepted: true, running: true, startedAt: expect.any(String) });
    expect(scheduler.requestRun()).toMatchObject({ accepted: false, running: true, message: "Sync is already running." });
    expect(scheduler.status()).toMatchObject({ running: true, progress: { stage: "starting", startedAt: accepted.startedAt } });

    resolveSync({ records: [], complete: true, sectionCount: 0 });
    await vi.waitFor(() => expect(scheduler.status().running).toBe(false));
    expect(scheduler.status().lastResult).toMatchObject({ ok: true, startedAt: accepted.startedAt, durationMs: expect.any(Number) });
  });

  it("preserves the accepted timestamp when the worker rejects", async () => {
    let rejectWorker!: (error: Error) => void;
    const syncWorker = {
      run: vi.fn(
        () =>
          new Promise((_, reject) => {
            rejectWorker = reject;
          })
      ),
      status: vi.fn(() => ({
        mode: "worker" as const,
        ready: true,
        running: false,
        closed: false,
        workerCount: 1,
        progress: undefined,
        lastResult: undefined
      }))
    } as unknown as SyncWorkerPool;
    const scheduler = createScheduler(undefined, undefined, undefined, syncWorker);

    const accepted = scheduler.requestRun({ warmEmbeddings: false });
    rejectWorker(new Error("Worker failed."));

    await vi.waitFor(() => expect(scheduler.status().running).toBe(false));
    expect(scheduler.status().lastResult).toMatchObject({
      ok: false,
      error: "Worker failed.",
      startedAt: accepted.startedAt,
      durationMs: expect.any(Number)
    });
  });
});

function createScheduler(
  plexClientOverride?: PlexClient,
  repositoryOverride?: MediaRepository,
  seerrClientOverride?: SeerrClient,
  syncWorkerOverride?: SyncWorkerPool
) {
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
  const plexClient =
    plexClientOverride ??
    ({ syncLibrary: vi.fn(async () => ({ records: [], complete: true as const, sectionCount: 0 })) } as unknown as PlexClient);
  const seerrClient = seerrClientOverride ?? ({ syncRequests: vi.fn(async () => []) } as unknown as SeerrClient);
  return new SyncScheduler(config, repository, plexClient, seerrClient, undefined, syncWorkerOverride);
}
