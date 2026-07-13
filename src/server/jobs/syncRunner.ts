import type { EmbeddingWarmupStatus, SyncCompletionResult, SyncProgress } from "../../shared/types";
import type { AppConfig } from "../config";
import type { IngestMediaRecord, MediaRepository } from "../db/mediaRepository";
import type { EmbeddingProvider } from "../ai/embeddings";
import type { PlexClient } from "../integrations/plexClient";
import type { SeerrClient } from "../integrations/seerrClient";
import { warmProviderEmbeddings } from "../recommendation/embeddingWarmup";
import { safeErrorMessage } from "../security/redact";

export const syncIngestBatchSize = 100;
export const seerrSyncCountSource = "seerr_snapshot_v1";

export interface SyncRunOptions {
  syncPlex?: boolean;
  syncSeerr?: boolean;
  warmEmbeddings?: boolean;
  runStartedAt?: string;
}

interface SyncRunnerDependencies {
  config: AppConfig;
  repository: MediaRepository;
  plexClient: PlexClient;
  seerrClient: SeerrClient;
  embeddingProviderFactory?: () => EmbeddingProvider;
  onProgress?: (progress: SyncProgress) => void;
}

export async function executeSyncRun(
  dependencies: SyncRunnerDependencies,
  signal: AbortSignal,
  options: SyncRunOptions = {}
): Promise<SyncCompletionResult> {
  const { config, repository, plexClient, seerrClient, onProgress } = dependencies;
  const requestedStartedMs = Date.parse(options.runStartedAt ?? "");
  const startedMs = Number.isFinite(requestedStartedMs) ? requestedStartedMs : Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const stageDurationsMs: Record<string, number> = {};
  const syncPlex = options.syncPlex ?? true;
  const syncSeerr = options.syncSeerr ?? config.sync.syncSeerr;
  let plexCount = 0;
  let plexMediaCount = 0;
  let seerrCount = 0;
  let seerrMediaCount = 0;
  let plexUnavailableCount = 0;

  const progress = (stage: SyncProgress["stage"], processed?: number, total?: number) => {
    onProgress?.({ stage, processed, total, startedAt, updatedAt: new Date().toISOString() });
  };
  const timed = async <T>(stage: SyncProgress["stage"], operation: () => Promise<T>) => {
    const stageStarted = Date.now();
    progress(stage);
    try {
      return await operation();
    } finally {
      stageDurationsMs[stage] = Date.now() - stageStarted;
    }
  };

  try {
    if (syncPlex) {
      try {
        const plexSnapshot = await timed("fetching_plex", () => plexClient.syncLibrary(signal));
        if (!plexSnapshot.complete) throw new Error("Plex library snapshot was incomplete.");
        const plexRecords = plexSnapshot.records;
        const plexRatingKeys = assertUniquePlexSnapshotIdentities(plexRecords);
        signal.throwIfAborted();
        const plexMediaItemIds = await timed("ingesting_plex", () =>
          upsertInBatches(repository, plexRecords, signal, (processed) => progress("ingesting_plex", processed, plexRecords.length))
        );
        plexMediaCount = new Set(plexMediaItemIds).size;
        signal.throwIfAborted();
        plexUnavailableCount = await timed("finalizing_plex", async () => repository.markPlexUnavailableExceptRatingKeys(plexRatingKeys));
        repository.recordSync("library", config.fixtureMode ? "fixture" : "plex", "ok", plexRecords.length);
        plexCount = plexRecords.length;
      } catch (error) {
        const message = safeErrorMessage(error, config.knownSecrets);
        if (!signal.aborted) repository.recordSync("library", config.fixtureMode ? "fixture" : "plex", "error", 0, message);
        return finish({ ok: false, error: message, plexItems: 0, plexMediaItems: 0, seerrItems: 0, seerrMediaItems: 0 });
      }
    }

    if (syncSeerr) {
      try {
        const seerrRecords = await timed("fetching_seerr", () => seerrClient.syncRequests(signal));
        signal.throwIfAborted();
        const seerrMediaItemIds = await timed("ingesting_seerr", () =>
          upsertInBatches(repository, seerrRecords, signal, (processed) => progress("ingesting_seerr", processed, seerrRecords.length))
        );
        seerrMediaCount = new Set(seerrMediaItemIds).size;
        signal.throwIfAborted();
        repository.recordSync("seerr", config.fixtureMode ? "fixture" : seerrSyncCountSource, "ok", seerrRecords.length);
        seerrCount = seerrRecords.length;
      } catch (error) {
        const message = safeErrorMessage(error, config.knownSecrets);
        if (!signal.aborted) repository.recordSync("seerr", config.fixtureMode ? "fixture" : seerrSyncCountSource, "error", 0, message);
        return finish({
          ok: false,
          error: message,
          plexItems: plexCount,
          plexMediaItems: plexMediaCount,
          seerrItems: 0,
          seerrMediaItems: 0
        });
      }
    }

    let providerEmbeddings: EmbeddingWarmupStatus | undefined;
    if (options.warmEmbeddings !== false) {
      signal.throwIfAborted();
      providerEmbeddings = await timed("warming_embeddings", async () => {
        try {
          return await warmProviderEmbeddings(repository, dependencies.embeddingProviderFactory?.(), { signal });
        } catch (error) {
          if (signal.aborted) signal.throwIfAborted();
          return {
            configured: true,
            attempted: 0,
            embedded: 0,
            hasMore: true,
            error: safeErrorMessage(error, config.knownSecrets)
          };
        }
      });
    }
    signal.throwIfAborted();
    return finish({
      ok: true,
      plexItems: plexCount,
      plexMediaItems: plexMediaCount,
      seerrItems: seerrCount,
      seerrMediaItems: seerrMediaCount,
      plexUnavailable: plexUnavailableCount,
      providerEmbeddings
    });
  } catch (error) {
    return finish({ ok: false, error: safeErrorMessage(error, config.knownSecrets) });
  }

  function finish(result: Omit<SyncCompletionResult, "startedAt" | "finishedAt" | "durationMs" | "stageDurationsMs">): SyncCompletionResult {
    return {
      ...result,
      startedAt,
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - startedMs,
      stageDurationsMs
    };
  }
}

export function assertUniquePlexSnapshotIdentities(records: IngestMediaRecord[]) {
  const ratingKeys = new Set<string>();
  for (const record of records) {
    const ratingKey = record.plex?.ratingKey;
    if (!ratingKey || ratingKeys.has(ratingKey)) {
      throw new Error("Plex library snapshot contained a missing or duplicate media identity.");
    }
    ratingKeys.add(ratingKey);
  }
  return [...ratingKeys];
}

export async function upsertInBatches(
  repository: Pick<MediaRepository, "upsertMany">,
  records: IngestMediaRecord[],
  signal: AbortSignal,
  onProgress?: (processed: number) => void,
  batchSize = syncIngestBatchSize
) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error("Sync ingest batch size must be a positive integer.");
  const mediaItemIds: string[] = [];
  for (let offset = 0; offset < records.length; offset += batchSize) {
    signal.throwIfAborted();
    mediaItemIds.push(...repository.upsertMany(records.slice(offset, offset + batchSize)));
    onProgress?.(Math.min(records.length, offset + batchSize));
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  signal.throwIfAborted();
  return mediaItemIds;
}
