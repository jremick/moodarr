import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
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
      expect(pool.status()).toMatchObject({ running: false, progress: undefined, workerCount: 1 });
    } finally {
      await pool.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("commits ingestion in conservative batches and observes cancellation between batches", async () => {
    expect(syncIngestBatchSize).toBe(100);
    const records = Array.from({ length: 250 }, (_, index) => ({ mediaType: "movie" as const, title: `Batch ${index}` }));
    const repository = {
      upsertMany: vi.fn((batch: typeof records) => batch.map((record) => record.title))
    } as unknown as MediaRepository;
    const completed = await upsertInBatches(repository, records, new AbortController().signal);
    expect(completed).toHaveLength(250);
    expect(repository.upsertMany).toHaveBeenCalledTimes(3);
    expect(vi.mocked(repository.upsertMany).mock.calls.map(([batch]) => batch.length)).toEqual([100, 100, 50]);

    const controller = new AbortController();
    vi.mocked(repository.upsertMany).mockClear();
    vi.mocked(repository.upsertMany).mockImplementation((batch) => {
      controller.abort(new Error("cancelled between batches"));
      return batch.map((record) => record.title);
    });
    await expect(upsertInBatches(repository, records, controller.signal)).rejects.toThrow("cancelled between batches");
    expect(repository.upsertMany).toHaveBeenCalledTimes(1);
  });

  it("never marks Plex items unavailable after cancelled batched ingestion", async () => {
    const controller = new AbortController();
    const repository = {
      upsertMany: vi.fn(() => {
        controller.abort(new Error("cancel before finalization"));
        return ["one"];
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

  it("never ingests or finalizes availability from duplicate Plex snapshot identities", async () => {
    const repository = {
      upsertMany: vi.fn(),
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
    expect(repository.upsertMany).not.toHaveBeenCalled();
    expect(repository.markPlexUnavailableExceptRatingKeys).not.toHaveBeenCalled();
    expect(repository.recordSync).toHaveBeenCalledWith("library", "fixture", "error", 0, expect.any(String));
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
      ).resolves.toMatchObject({ ok: true, plexItems: 2, plexUnavailable: 0 });

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
      ).resolves.toMatchObject({ ok: true, plexItems: 1, plexUnavailable: 1 });

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
      upsertMany: vi.fn(() => ["one"]),
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
    expect(repository.upsertMany).not.toHaveBeenCalled();
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
