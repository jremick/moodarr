import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config";
import { createDatabase } from "../src/server/db/database";
import { MediaRepository } from "../src/server/db/mediaRepository";
import { SearchWorkerPool } from "../src/server/search/searchWorkerPool";

describe("SearchWorkerPool", () => {
  it("keeps the parent event loop responsive and bounds concurrent search admission", async () => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-search-worker-"));
    const config = loadConfig({
      MOODARR_DATA_DIR: directory,
      MOODARR_DB_PATH: join(directory, "moodarr.sqlite"),
      MOODARR_CONFIG_PATH: join(directory, "config.json"),
      MOODARR_FIXTURE_MODE: "true",
      MOODARR_REQUIRE_ADMIN_TOKEN: "false",
      MOODARR_API_HOST: "127.0.0.1",
      MOODARR_SYNC_INTERVAL_MINUTES: "0"
    });
    const db = createDatabase(config.dbPath);
    const repository = new MediaRepository(db);
    repository.upsertMany(
      Array.from({ length: 120 }, (_, index) => ({
        mediaType: "movie" as const,
        title: `Worker Movie ${index}`,
        year: 2000 + (index % 20),
        summary: "A cozy synthetic adventure with warm humor.",
        genres: ["Adventure", "Comedy"]
      }))
    );
    db.close();

    const pool = new SearchWorkerPool(config);
    try {
      await waitUntil(() => pool.status().ready);
      const startedAt = performance.now();
      const eventLoopTick = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - startedAt), 20));
      const searches = [1, 2, 3].map(() => pool.search({ query: "cozy adventure", useAi: false, resultLimit: 5 }));
      await expect(pool.search({ query: "overflow", useAi: false })).rejects.toMatchObject({ statusCode: 503 });

      expect(await eventLoopTick).toBeLessThan(200);
      const results = await Promise.all(searches);
      expect(results.every((result) => result.results.length > 0)).toBe(true);

      const diagnosticsStartedAt = performance.now();
      const diagnosticsTick = new Promise<number>((resolve) => setTimeout(() => resolve(performance.now() - diagnosticsStartedAt), 20));
      const diagnostics = pool.recommendationDiagnostics();
      expect(pool.recommendationDiagnostics()).toBe(diagnostics);
      expect(await diagnosticsTick).toBeLessThan(200);
      await expect(diagnostics).resolves.toMatchObject({
        engineVersion: expect.any(String),
        features: { mediaFeatureCount: 120 }
      });
      const cachedDiagnosticsStartedAt = performance.now();
      await expect(pool.recommendationDiagnostics()).resolves.toMatchObject({ features: { mediaFeatureCount: 120 } });
      expect(performance.now() - cachedDiagnosticsStartedAt).toBeLessThan(200);
      const verificationDb = createDatabase(config.dbPath);
      expect((verificationDb.prepare("SELECT COUNT(*) AS value FROM preference_profiles").get() as { value: number }).value).toBe(0);
      verificationDb.close();

      await Promise.all(Array.from({ length: 20 }, () => pool.restart(config)));
      await waitUntil(() => pool.status().ready);
      expect(pool.status()).toMatchObject({ closed: false, ready: true, workerCount: 2 });

      const closingRestarts = Array.from({ length: 20 }, () => pool.restart(config));
      await Promise.all([...closingRestarts, pool.close()]);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(pool.status()).toMatchObject({ closed: true, ready: false, running: false, queued: 0, workerCount: 0 });
    } finally {
      await pool.close();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);
});

async function waitUntil(predicate: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Search worker did not become ready.");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
