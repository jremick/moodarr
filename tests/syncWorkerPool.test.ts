import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import type { PlexClient } from "../src/server/integrations/plexClient";
import type { SeerrClient } from "../src/server/integrations/seerrClient";
import type { EmbeddingProvider } from "../src/server/ai/embeddings";
import { loadConfig } from "../src/server/config";
import { executeSyncRun, syncIngestBatchSize, upsertInBatches } from "../src/server/jobs/syncRunner";
import { SyncWorkerPool } from "../src/server/jobs/syncWorkerPool";

describe("sync worker", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the parent event loop responsive, admits one run, cancels, and closes without a worker leak", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-sync-worker-"));
    const config = loadConfig({
      MOODARR_DATA_DIR: directory,
      MOODARR_DB_PATH: join(directory, "moodarr.sqlite"),
      MOODARR_CONFIG_PATH: join(directory, "config.json"),
      MOODARR_FIXTURE_MODE: "true",
      MOODARR_REQUIRE_ADMIN_TOKEN: "false",
      MOODARR_API_HOST: "127.0.0.1",
      MOODARR_SYNC_INTERVAL_MINUTES: "0"
    });
    const pool = new SyncWorkerPool(config, new URL("./fixtures/blockingSyncWorker.ts", import.meta.url));
    try {
      await waitUntil(() => pool.status().ready);
      const runStartedAt = "2026-07-13T07:30:00.123Z";
      const run = pool.run({ syncPlex: true, syncSeerr: false, warmEmbeddings: false, runStartedAt });
      await waitUntil(() => pool.status().progress?.stage === "fetching_plex");
      expect(pool.status().progress?.startedAt).toBe(runStartedAt);

      const startedAt = performance.now();
      const tick = await new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - startedAt), 20));
      expect(tick).toBeLessThan(200);
      await expect(pool.run()).rejects.toThrow("already running");

      pool.cancel();
      await expect(run).resolves.toMatchObject({ ok: false, error: expect.any(String), startedAt: runStartedAt });
      expect(pool.status().running).toBe(false);

      await pool.close();
      expect(pool.status()).toMatchObject({ closed: true, ready: false, running: false, workerCount: 0 });
    } finally {
      await pool.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("cancels a queued run before the worker becomes ready", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-sync-worker-pending-"));
    const config = loadConfig({
      MOODARR_DATA_DIR: directory,
      MOODARR_DB_PATH: join(directory, "moodarr.sqlite"),
      MOODARR_CONFIG_PATH: join(directory, "config.json"),
      MOODARR_FIXTURE_MODE: "true",
      MOODARR_REQUIRE_ADMIN_TOKEN: "false",
      MOODARR_API_HOST: "127.0.0.1",
      MOODARR_SYNC_INTERVAL_MINUTES: "0"
    });
    const pool = new SyncWorkerPool(config, new URL("./fixtures/slowReadySyncWorker.ts", import.meta.url));
    try {
      const run = pool.run();
      pool.cancel("Cancelled before readiness.");
      await expect(run).rejects.toThrow("Cancelled before readiness.");
      await waitUntil(() => pool.status().ready);
      expect(pool.status()).toMatchObject({ ready: true, running: false, progress: undefined, workerCount: 1 });
    } finally {
      await pool.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects queued work and becomes degraded after bounded worker readiness attempts", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-sync-worker-never-ready-"));
    const config = loadConfig({
      MOODARR_DATA_DIR: directory,
      MOODARR_DB_PATH: join(directory, "moodarr.sqlite"),
      MOODARR_CONFIG_PATH: join(directory, "config.json"),
      MOODARR_FIXTURE_MODE: "true",
      MOODARR_REQUIRE_ADMIN_TOKEN: "false",
      MOODARR_API_HOST: "127.0.0.1",
      MOODARR_SYNC_INTERVAL_MINUTES: "0"
    });
    const pool = new SyncWorkerPool(config, new URL("./fixtures/neverReadyWorker.ts", import.meta.url), {
      workerReadyDeadlineMs: 25,
      maxWorkerReadyAttempts: 2
    });

    try {
      const run = pool.run();
      await expect(run).rejects.toThrow("did not become ready");
      await waitUntil(() => pool.status().state === "degraded");
      expect(pool.status()).toMatchObject({
        ready: false,
        state: "degraded",
        degraded: true,
        running: false,
        workerCount: 0
      });
      await expect(pool.run()).rejects.toThrow("unavailable because it did not become ready");
      await new Promise((resolve) => setTimeout(resolve, 75));
      expect(pool.status().workerCount).toBe(0);
    } finally {
      await pool.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("ignores a stale worker failure after restart has installed a replacement generation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-sync-worker-stale-reset-"));
    const config = loadConfig({
      MOODARR_DATA_DIR: directory,
      MOODARR_DB_PATH: join(directory, "moodarr.sqlite"),
      MOODARR_CONFIG_PATH: join(directory, "config.json"),
      MOODARR_FIXTURE_MODE: "true",
      MOODARR_REQUIRE_ADMIN_TOKEN: "false",
      MOODARR_API_HOST: "127.0.0.1",
      MOODARR_SYNC_INTERVAL_MINUTES: "0"
    });
    const pool = new SyncWorkerPool(config, new URL("./fixtures/neverReadyWorker.ts", import.meta.url), {
      workerReadyDeadlineMs: 60_000
    });
    const internals = pool as unknown as {
      lifecycle: Promise<void>;
      worker: Worker | undefined;
      readinessFailures: number;
      spawn: () => void;
      onFailure: (worker: Worker, error: Error) => Promise<void>;
    };

    try {
      const oldWorker = internals.worker;
      expect(oldWorker).toBeDefined();

      let releaseLifecycle!: () => void;
      internals.lifecycle = new Promise<void>((resolve) => {
        releaseLifecycle = resolve;
      });
      const spawned: Worker[] = [];
      const spawn = internals.spawn.bind(pool);
      internals.spawn = () => {
        spawn();
        if (internals.worker) spawned.push(internals.worker);
      };

      const restart = pool.restart(config);
      const staleFailure = internals.onFailure(oldWorker!, new Error("Stale sync worker failure."));
      releaseLifecycle();
      await Promise.all([restart, staleFailure]);

      expect(spawned).toHaveLength(1);
      expect(internals.worker).toBe(spawned[0]);
      expect(internals.readinessFailures).toBe(0);
      expect(pool.status()).toMatchObject({ ready: false, state: "starting", degraded: false, workerCount: 1 });
    } finally {
      await pool.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("commits ingestion in conservative batches and observes cancellation between batches", async () => {
    expect(syncIngestBatchSize).toBe(100);
    const records = Array.from({ length: 250 }, (_, index) => ({ mediaType: "movie" as const, title: `Batch ${index}` }));
    const repository = {
      upsertIntegrationRecords: vi.fn((batch: typeof records) => ({
        mediaItemIds: batch.map((record) => record.title),
        identityConflictCount: batch.length === 50 ? 1 : 0
      }))
    } as unknown as MediaRepository;
    const completed = await upsertInBatches(repository, records, new AbortController().signal);
    expect(completed).toEqual({ mediaItemIds: records.map((record) => record.title), identityConflictCount: 1 });
    expect(repository.upsertIntegrationRecords).toHaveBeenCalledTimes(3);
    expect(vi.mocked(repository.upsertIntegrationRecords).mock.calls.map(([batch]) => batch.length)).toEqual([100, 100, 50]);

    const controller = new AbortController();
    vi.mocked(repository.upsertIntegrationRecords).mockClear();
    vi.mocked(repository.upsertIntegrationRecords).mockImplementation((batch) => {
      controller.abort(new Error("cancelled between batches"));
      return { mediaItemIds: batch.map((record) => record.title), identityConflictCount: 0 };
    });
    await expect(upsertInBatches(repository, records, controller.signal)).rejects.toThrow("cancelled between batches");
    expect(repository.upsertIntegrationRecords).toHaveBeenCalledTimes(1);
  });

  it("never marks Plex items unavailable after cancelled batched ingestion", async () => {
    const controller = new AbortController();
    const repository = {
      upsertIntegrationRecords: vi.fn(() => {
        controller.abort(new Error("cancel before finalization"));
        return { mediaItemIds: ["one"], identityConflictCount: 0 };
      }),
      markPlexUnavailableExceptRatingKeys: vi.fn(),
      recordSync: vi.fn()
    } as unknown as MediaRepository;
    const config = loadConfig({ MOODARR_FIXTURE_MODE: "true", MOODARR_SYNC_INTERVAL_MINUTES: "0" });
    const plexClient = {
      syncLibrary: vi.fn(async () => ({
        records: [{ mediaType: "movie" as const, title: "One", plex: { ratingKey: "one", available: true } }],
        complete: true as const,
        sectionCount: 1
      }))
    } as unknown as PlexClient;
    const seerrClient = { syncRequests: vi.fn(async () => []) } as unknown as SeerrClient;

    const result = await executeSyncRun({ config, repository, plexClient, seerrClient }, controller.signal, {
      syncPlex: true,
      syncSeerr: false,
      warmEmbeddings: false
    });

    expect(result.ok).toBe(false);
    expect(repository.markPlexUnavailableExceptRatingKeys).not.toHaveBeenCalled();
    expect(repository.recordSync).not.toHaveBeenCalledWith(expect.anything(), expect.anything(), "ok", expect.anything());
  });

  it("fails the sync and skips finalization for unexpected integration ingest errors", async () => {
    const repository = {
      upsertIntegrationRecords: vi.fn(() => {
        throw new Error("unexpected storage failure");
      }),
      markPlexUnavailableExceptRatingKeys: vi.fn(),
      recordSync: vi.fn()
    } as unknown as MediaRepository;
    const config = loadConfig({ MOODARR_FIXTURE_MODE: "true", MOODARR_SYNC_INTERVAL_MINUTES: "0" });
    const plexClient = {
      syncLibrary: vi.fn(async () => ({
        records: [{ mediaType: "movie" as const, title: "One", plex: { ratingKey: "one", available: true } }],
        complete: true as const,
        sectionCount: 1
      }))
    } as unknown as PlexClient;
    const seerrClient = { syncRequests: vi.fn(async () => []) } as unknown as SeerrClient;

    const result = await executeSyncRun({ config, repository, plexClient, seerrClient }, new AbortController().signal, {
      syncPlex: true,
      syncSeerr: false,
      warmEmbeddings: false
    });

    expect(result).toMatchObject({ ok: false, error: "unexpected storage failure" });
    expect(repository.markPlexUnavailableExceptRatingKeys).not.toHaveBeenCalled();
    expect(repository.recordSync).toHaveBeenCalledWith("library", "fixture", "error", 0, "unexpected storage failure");
  });

  it("never ingests or finalizes availability from duplicate Plex snapshot identities", async () => {
    const repository = {
      upsertIntegrationRecords: vi.fn(),
      markPlexUnavailableExceptRatingKeys: vi.fn(),
      recordSync: vi.fn()
    } as unknown as MediaRepository;
    const config = loadConfig({ MOODARR_FIXTURE_MODE: "true", MOODARR_SYNC_INTERVAL_MINUTES: "0" });
    const plexClient = {
      syncLibrary: vi.fn(async () => ({
        records: [
          { mediaType: "movie" as const, title: "First", plex: { ratingKey: "duplicate", available: true } },
          { mediaType: "movie" as const, title: "Repeated", plex: { ratingKey: "duplicate", available: true } }
        ],
        complete: true as const,
        sectionCount: 1
      }))
    } as unknown as PlexClient;
    const seerrClient = { syncRequests: vi.fn(async () => []) } as unknown as SeerrClient;

    const result = await executeSyncRun({ config, repository, plexClient, seerrClient }, new AbortController().signal, {
      syncPlex: true,
      syncSeerr: false,
      warmEmbeddings: false
    });

    expect(result).toMatchObject({ ok: false, error: "Plex library snapshot contained a missing or duplicate media identity." });
    expect(repository.upsertIntegrationRecords).not.toHaveBeenCalled();
    expect(repository.markPlexUnavailableExceptRatingKeys).not.toHaveBeenCalled();
    expect(repository.recordSync).toHaveBeenCalledWith("library", "fixture", "error", 0, expect.any(String));
  });

  it("contains integration identity conflicts, persists later records, and still finalizes Plex", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const firstIdentity = repository.upsert({
      source: "live",
      mediaType: "movie",
      title: "First Live Identity",
      year: 2020,
      externalIds: { tmdb: 880001 }
    });
    const secondIdentity = repository.upsert({
      source: "live",
      mediaType: "movie",
      title: "Second Live Identity",
      year: 2021,
      externalIds: { imdb: "tt880002" }
    });
    const stalePlexItem = repository.upsert({
      source: "live",
      mediaType: "movie",
      title: "Stale Plex Item",
      year: 2019,
      externalIds: { tmdb: 880000 },
      plex: { ratingKey: "stale-plex", available: true }
    });
    const conflictingRecord = {
      source: "fixture" as const,
      mediaType: "movie" as const,
      title: "Conflicting Fixture Identity",
      year: 2022,
      externalIds: { tmdb: 880001, imdb: "tt880002" }
    };
    const plexClient = {
      syncLibrary: vi.fn(async () => ({
        records: [
          { ...conflictingRecord, plex: { ratingKey: "conflicting-plex", available: true } },
          {
            source: "fixture" as const,
            mediaType: "movie" as const,
            title: "Safe Later Plex Record",
            year: 2023,
            externalIds: { tmdb: 880003 },
            plex: { ratingKey: "safe-later-plex", available: true }
          }
        ],
        complete: true as const,
        sectionCount: 1
      }))
    } as unknown as PlexClient;
    const seerrClient = {
      syncRequests: vi.fn(async () => [
        {
          ...conflictingRecord,
          seerr: { tmdbId: 880001, imdbId: "tt880002", status: "unknown" as const, requestable: true }
        },
        {
          source: "fixture" as const,
          mediaType: "movie" as const,
          title: "Safe Later Seerr Record",
          year: 2024,
          externalIds: { tmdb: 880004 },
          seerr: { tmdbId: 880004, status: "unknown" as const, requestable: true }
        }
      ])
    } as unknown as SeerrClient;
    const config = loadConfig({ MOODARR_FIXTURE_MODE: "true", MOODARR_SYNC_INTERVAL_MINUTES: "0" });

    try {
      const result = await executeSyncRun({ config, repository, plexClient, seerrClient }, new AbortController().signal, {
        syncPlex: true,
        syncSeerr: true,
        warmEmbeddings: false
      });

      expect(result).toMatchObject({
        ok: true,
        plexItems: 2,
        plexMediaItems: 1,
        plexIdentityConflicts: 1,
        plexUnavailable: 1,
        seerrItems: 2,
        seerrMediaItems: 1,
        seerrIdentityConflicts: 1
      });
      expect(repository.findByExternalId("tmdb", "880003", "movie")?.plex?.available).toBe(true);
      expect(repository.findByExternalId("tmdb", "880004", "movie")?.seerr?.requestable).toBe(true);
      expect(repository.findById(stalePlexItem)?.plex?.available).toBe(false);
      expect(repository.findById(firstIdentity)?.catalogIdentityAmbiguous).toBe(true);
      expect(repository.findById(secondIdentity)?.catalogIdentityAmbiguous).toBe(true);
      expect(repository.list().some((item) => item.title === conflictingRecord.title)).toBe(false);
    } finally {
      db.close();
    }
  });

  it("clears stale identity quarantine only after one successful full Plex and Seerr run", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const firstId = repository.upsert({ mediaType: "movie", title: "Full Sync Recovery One", externalIds: { tmdb: 889101 } });
    const secondId = repository.upsert({ mediaType: "movie", title: "Full Sync Recovery Two", externalIds: { tmdb: 889102 } });
    const insert = db.prepare(
      `INSERT INTO media_identity_quarantine (
        media_item_id, reason_code, first_seen_at, last_seen_at, occurrence_count
      ) VALUES (?, 'external_identity_conflict', ?, ?, 1)`
    );
    insert.run(firstId, "2026-07-13T00:00:00.000Z", "2026-07-13T00:00:00.000Z");
    insert.run(secondId, "2026-07-13T00:00:00.000Z", "2026-07-13T00:00:00.000Z");
    const plexClient = {
      syncLibrary: vi.fn(async () => ({ records: [], complete: true as const, sectionCount: 1 }))
    } as unknown as PlexClient;
    const seerrClient = { syncRequests: vi.fn(async () => []) } as unknown as SeerrClient;
    const config = loadConfig({ MOODARR_FIXTURE_MODE: "true", MOODARR_SYNC_INTERVAL_MINUTES: "0" });

    try {
      const result = await executeSyncRun({ config, repository, plexClient, seerrClient }, new AbortController().signal, {
        syncPlex: true,
        syncSeerr: true,
        warmEmbeddings: false,
        runStartedAt: "2026-07-14T00:00:00.000Z"
      });

      expect(result).toMatchObject({ ok: true, identityQuarantinesCleared: 2 });
      expect(plexClient.syncLibrary).toHaveBeenCalledTimes(1);
      expect(seerrClient.syncRequests).toHaveBeenCalledTimes(1);
      expect(db.prepare("SELECT COUNT(*) AS value FROM media_identity_quarantine").get()).toEqual({ value: 0 });
      expect(JSON.stringify(result)).not.toContain(firstId);
      expect(JSON.stringify(result)).not.toContain(secondId);
    } finally {
      db.close();
    }
  });

  it("retains quarantine for an identity conflict reproduced during the full sync", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const firstId = repository.upsert({ mediaType: "movie", title: "Reproduced Identity One", externalIds: { tmdb: 889201 } });
    const secondId = repository.upsert({ mediaType: "movie", title: "Reproduced Identity Two", externalIds: { imdb: "tt0889202" } });
    const conflict = {
      source: "fixture" as const,
      mediaType: "movie" as const,
      title: "Reproduced Identity Conflict",
      externalIds: { tmdb: 889201, imdb: "tt0889202" },
      seerr: { tmdbId: 889201, imdbId: "tt0889202", status: "unknown" as const, requestable: true }
    };
    expect(repository.upsertIntegrationRecords([conflict])).toEqual({ mediaItemIds: [], identityConflictCount: 1 });
    db.prepare("UPDATE media_identity_quarantine SET last_seen_at = ?").run("2026-07-13T00:00:00.000Z");
    const plexClient = {
      syncLibrary: vi.fn(async () => ({ records: [], complete: true as const, sectionCount: 1 }))
    } as unknown as PlexClient;
    const seerrClient = { syncRequests: vi.fn(async () => [conflict]) } as unknown as SeerrClient;
    const config = loadConfig({ MOODARR_FIXTURE_MODE: "true", MOODARR_SYNC_INTERVAL_MINUTES: "0" });

    try {
      const result = await executeSyncRun({ config, repository, plexClient, seerrClient }, new AbortController().signal, {
        syncPlex: true,
        syncSeerr: true,
        warmEmbeddings: false,
        runStartedAt: new Date(Date.now() - 60_000).toISOString()
      });

      expect(result).toMatchObject({ ok: true, seerrIdentityConflicts: 1, identityQuarantinesCleared: 0 });
      expect(db.prepare("SELECT media_item_id, occurrence_count FROM media_identity_quarantine ORDER BY media_item_id").all()).toEqual(
        [firstId, secondId].sort().map((media_item_id) => ({ media_item_id, occurrence_count: 2 }))
      );
    } finally {
      db.close();
    }
  });

  it("does not clear quarantine after a single-source run or a failed full run", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const itemId = repository.upsert({ mediaType: "movie", title: "Preserved Recovery Boundary", externalIds: { tmdb: 889301 } });
    db.prepare(
      `INSERT INTO media_identity_quarantine (
        media_item_id, reason_code, first_seen_at, last_seen_at, occurrence_count
      ) VALUES (?, 'external_identity_conflict', ?, ?, 1)`
    ).run(itemId, "2026-07-13T00:00:00.000Z", "2026-07-13T00:00:00.000Z");
    const clearQuarantine = vi.spyOn(repository, "clearStaleMediaIdentityQuarantine");
    const plexClient = {
      syncLibrary: vi.fn(async () => ({ records: [], complete: true as const, sectionCount: 1 }))
    } as unknown as PlexClient;
    const seerrClient = { syncRequests: vi.fn(async () => []) } as unknown as SeerrClient;
    const config = loadConfig({ MOODARR_FIXTURE_MODE: "true", MOODARR_SYNC_INTERVAL_MINUTES: "0" });

    try {
      const singleSource = await executeSyncRun({ config, repository, plexClient, seerrClient }, new AbortController().signal, {
        syncPlex: true,
        syncSeerr: false,
        warmEmbeddings: false,
        runStartedAt: "2026-07-14T00:00:00.000Z"
      });
      expect(singleSource).toMatchObject({ ok: true, identityQuarantinesCleared: 0 });
      expect(clearQuarantine).not.toHaveBeenCalled();

      vi.mocked(seerrClient.syncRequests).mockRejectedValueOnce(new Error("authoritative Seerr phase failed"));
      const failedFull = await executeSyncRun({ config, repository, plexClient, seerrClient }, new AbortController().signal, {
        syncPlex: true,
        syncSeerr: true,
        warmEmbeddings: false,
        runStartedAt: "2026-07-14T00:01:00.000Z"
      });
      expect(failedFull).toMatchObject({ ok: false, identityQuarantinesCleared: 0 });
      expect(clearQuarantine).not.toHaveBeenCalled();
      expect(db.prepare("SELECT media_item_id FROM media_identity_quarantine").all()).toEqual([{ media_item_id: itemId }]);
    } finally {
      db.close();
    }
  });

  it("finalizes merged Plex editions by rating key and projects the remaining available edition", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const config = loadConfig({ MOODARR_FIXTURE_MODE: "true", MOODARR_SYNC_INTERVAL_MINUTES: "0" });
    const editionAUrl =
      "https://app.plex.tv/desktop/#!/server/server-a/details?key=%2Flibrary%2Fmetadata%2Fedition-a";
    const editionBUrl =
      "https://app.plex.tv/desktop/#!/server/server-a/details?key=%2Flibrary%2Fmetadata%2Fedition-b";
    const editionA = {
      mediaType: "movie" as const,
      title: "Shared Cut",
      year: 2026,
      externalIds: { tmdb: 4242 },
      plex: { ratingKey: "edition-a", libraryTitle: "Movies", url: editionAUrl, available: true }
    };
    const editionB = {
      ...editionA,
      plex: { ratingKey: "edition-b", libraryTitle: "4K Movies", url: editionBUrl, available: true }
    };
    const plexClient = {
      syncLibrary: vi
        .fn()
        .mockResolvedValueOnce({ records: [editionA, editionB], complete: true as const, sectionCount: 2 })
        .mockResolvedValueOnce({ records: [editionA], complete: true as const, sectionCount: 1 })
    } as unknown as PlexClient;
    const seerrClient = { syncRequests: vi.fn(async () => []) } as unknown as SeerrClient;

    try {
      await expect(
        executeSyncRun({ config, repository, plexClient, seerrClient }, new AbortController().signal, {
          syncPlex: true,
          syncSeerr: false,
          warmEmbeddings: false
        })
      ).resolves.toMatchObject({ ok: true, plexItems: 2, plexMediaItems: 1, plexUnavailable: 0 });

      const mergedRows = db
        .prepare("SELECT media_item_id, rating_key, available FROM plex_items ORDER BY rating_key")
        .all() as Array<{ media_item_id: string; rating_key: string; available: number }>;
      expect(mergedRows).toHaveLength(2);
      expect(new Set(mergedRows.map((row) => row.media_item_id)).size).toBe(1);
      expect(repository.stats()).toMatchObject({ plexItems: 1, availableInPlex: 1 });

      db.prepare("UPDATE plex_items SET last_seen_at = ? WHERE rating_key = ?").run("2026-07-13T00:00:00.000Z", "edition-a");
      db.prepare("UPDATE plex_items SET last_seen_at = ? WHERE rating_key = ?").run("2026-07-13T01:00:00.000Z", "edition-b");
      expect(repository.findById(mergedRows[0].media_item_id)?.plex).toMatchObject({
        available: true,
        url: editionBUrl,
        library: "4K Movies"
      });
      expect(repository.list()[0]?.plex).toMatchObject({ available: true, url: editionBUrl, library: "4K Movies" });

      await expect(
        executeSyncRun({ config, repository, plexClient, seerrClient }, new AbortController().signal, {
          syncPlex: true,
          syncSeerr: false,
          warmEmbeddings: false
        })
      ).resolves.toMatchObject({ ok: true, plexItems: 1, plexMediaItems: 1, plexUnavailable: 1 });

      expect(
        db.prepare("SELECT rating_key, available FROM plex_items ORDER BY rating_key").all()
      ).toEqual([
        { rating_key: "edition-a", available: 1 },
        { rating_key: "edition-b", available: 0 }
      ]);
      expect(repository.findById(mergedRows[0].media_item_id)?.plex).toMatchObject({
        available: true,
        url: editionAUrl,
        library: "Movies"
      });
      expect(repository.list()[0]?.plex).toMatchObject({ available: true, url: editionAUrl, library: "Movies" });
      expect(repository.stats()).toMatchObject({ plexItems: 1, availableInPlex: 1 });
    } finally {
      db.close();
    }
  });

  it("reports distinct persisted Seerr media even when historical request rows share one item", async () => {
    const db = createDatabase(":memory:");
    const repository = new MediaRepository(db);
    const config = loadConfig({ MOODARR_FIXTURE_MODE: "true", MOODARR_SYNC_INTERVAL_MINUTES: "0" });
    const plexClient = { syncLibrary: vi.fn() } as unknown as PlexClient;
    const shared = {
      source: "fixture" as const,
      mediaType: "movie" as const,
      title: "Shared Seerr Item",
      externalIds: { tmdb: 8181 }
    };
    const seerrClient = {
      syncRequests: vi.fn(async () => [
        {
          ...shared,
          seerr: { tmdbId: 8181, seerrMediaId: 91, status: "requested" as const, requestStatus: "approved", requestable: false }
        },
        {
          ...shared,
          seerr: { tmdbId: 8181, seerrMediaId: 92, status: "requested" as const, requestStatus: "pending", requestable: false }
        }
      ])
    } as unknown as SeerrClient;

    try {
      await expect(
        executeSyncRun({ config, repository, plexClient, seerrClient }, new AbortController().signal, {
          syncPlex: false,
          syncSeerr: true,
          warmEmbeddings: false
        })
      ).resolves.toMatchObject({ ok: true, seerrItems: 2, seerrMediaItems: 1 });

      expect(db.prepare("SELECT COUNT(*) AS value FROM seerr_items").get()).toEqual({ value: 2 });
      expect(repository.stats()).toMatchObject({ seerrItems: 2, alreadyRequested: 1 });
    } finally {
      db.close();
    }
  });

  it("reports embedding cancellation as a failed sync without a cache write", async () => {
    const controller = new AbortController();
    const repository = {
      pruneProviderEmbeddings: vi.fn(),
      providerEmbeddingCount: vi.fn(() => 0),
      providerEmbeddingStaleCount: vi.fn(() => 0),
      missingProviderEmbeddingInputs: vi.fn(() => [
        { mediaItemId: "one", featureText: "One", featureVersion: "v1", inputHash: "hash" }
      ]),
      upsertProviderEmbeddings: vi.fn(),
      recordSync: vi.fn()
    } as unknown as MediaRepository;
    const provider: EmbeddingProvider = {
      providerName: "test-provider",
      modelName: "test-model",
      outputDimensions: 2,
      configured: true,
      embed: vi.fn(async () => {
        controller.abort(new Error("Embedding cancelled."));
        return [[1, 0]];
      })
    };
    const config = loadConfig({ MOODARR_FIXTURE_MODE: "true", MOODARR_SYNC_INTERVAL_MINUTES: "0" });
    const plexClient = { syncLibrary: vi.fn() } as unknown as PlexClient;
    const seerrClient = { syncRequests: vi.fn() } as unknown as SeerrClient;

    const result = await executeSyncRun(
      { config, repository, plexClient, seerrClient, embeddingProviderFactory: () => provider },
      controller.signal,
      { syncPlex: false, syncSeerr: false }
    );

    expect(result).toMatchObject({ ok: false, error: "Embedding cancelled." });
    expect(repository.upsertProviderEmbeddings).not.toHaveBeenCalled();
  });

  it("does not finalize Plex availability from an incomplete snapshot", async () => {
    const repository = {
      upsertIntegrationRecords: vi.fn(() => ({ mediaItemIds: ["one"], identityConflictCount: 0 })),
      markPlexUnavailableExceptRatingKeys: vi.fn(),
      recordSync: vi.fn()
    } as unknown as MediaRepository;
    const config = loadConfig({ MOODARR_FIXTURE_MODE: "true", MOODARR_SYNC_INTERVAL_MINUTES: "0" });
    const plexClient = {
      syncLibrary: vi.fn(async () => ({ records: [{ mediaType: "movie" as const, title: "One" }], complete: false, sectionCount: 1 }))
    } as unknown as PlexClient;
    const seerrClient = { syncRequests: vi.fn(async () => []) } as unknown as SeerrClient;

    const result = await executeSyncRun({ config, repository, plexClient, seerrClient }, new AbortController().signal, {
      syncPlex: true,
      syncSeerr: false,
      warmEmbeddings: false
    });

    expect(result.ok).toBe(false);
    expect(repository.upsertIntegrationRecords).not.toHaveBeenCalled();
    expect(repository.markPlexUnavailableExceptRatingKeys).not.toHaveBeenCalled();
  });
});

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Sync worker did not reach the expected state.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
