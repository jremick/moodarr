import type { SyncCompletionResult, SyncRunResult } from "../../shared/types";
import type { AppConfig } from "../config";
import type { EmbeddingProvider } from "../ai/embeddings";
import type { MediaRepository } from "../db/mediaRepository";
import type { PlexClient } from "../integrations/plexClient";
import type { SeerrClient } from "../integrations/seerrClient";
import { safeErrorMessage } from "../security/redact";
import { executeSyncRun, type SyncRunOptions } from "./syncRunner";
import type { SyncWorkerPool } from "./syncWorkerPool";

export class SyncScheduler {
  private timer: NodeJS.Timeout | undefined;
  private nextRunAt: string | undefined;
  private running = false;
  private started = false;
  private generation = 0;
  private abortController: AbortController | undefined;
  private activeRun: Promise<SyncCompletionResult> | undefined;
  private lastResult: SyncCompletionResult | undefined;
  private currentStartedAt: string | undefined;

  constructor(
    private readonly config: AppConfig,
    private readonly repository: MediaRepository,
    private readonly plexClient: PlexClient,
    private readonly seerrClient: SeerrClient,
    private readonly embeddingProviderFactory?: () => EmbeddingProvider,
    private readonly syncWorker?: SyncWorkerPool
  ) {}

  start() {
    this.stop();
    if (this.config.sync.intervalMinutes <= 0) return;
    this.started = true;
    this.generation += 1;
    this.scheduleNextRun();
  }

  stop() {
    this.started = false;
    this.generation += 1;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.nextRunAt = undefined;
    this.abortController?.abort(new Error("Sync stopped."));
    this.syncWorker?.cancel("Sync stopped.");
  }

  async stopAndWait() {
    this.stop();
    try {
      await this.activeRun;
    } catch {
      // The run records its own safe error result.
    }
  }

  async close() {
    await this.stopAndWait();
    await this.syncWorker?.close();
  }

  status() {
    const worker = this.syncWorker?.status();
    const progress = worker?.progress ?? this.startingProgress();
    return {
      enabled: this.started,
      intervalMinutes: this.config.sync.intervalMinutes,
      syncSeerr: this.config.sync.syncSeerr,
      nextRunAt: this.nextRunAt,
      running: this.running,
      worker: worker
        ? {
            mode: worker.mode,
            ready: worker.ready,
            running: worker.running,
            closed: worker.closed,
            workerCount: worker.workerCount
          }
        : { mode: "inline" as const, ready: true, running: this.running, closed: false, workerCount: 0 },
      progress,
      lastResult: this.lastResult ?? worker?.lastResult,
      history: this.repository.syncHistory()
    };
  }

  healthStatus() {
    const worker = this.syncWorker?.status();
    return {
      mode: worker?.mode ?? ("inline" as const),
      ready: worker?.ready ?? true,
      running: this.running,
      closed: worker?.closed ?? false,
      workerCount: worker?.workerCount ?? 0
    };
  }

  requestRun(options: SyncRunOptions = {}): SyncRunResult {
    if (this.running) {
      return {
        accepted: false,
        running: true,
        message: "Sync is already running.",
        startedAt: this.currentStartedAt ?? this.syncWorker?.status().progress?.startedAt
      };
    }
    void this.runOnce(options);
    return { accepted: true, running: true, message: "Sync accepted.", startedAt: this.currentStartedAt };
  }

  async runOnce(options: SyncRunOptions = {}): Promise<SyncCompletionResult> {
    if (this.running) return failureResult("Sync is already running.");
    this.running = true;
    const runStartedAt = new Date().toISOString();
    this.currentStartedAt = runStartedAt;
    const controller = new AbortController();
    this.abortController = controller;
    const runOptions = { ...options, runStartedAt };
    const run = this.syncWorker
      ? this.syncWorker.run(runOptions)
      : executeSyncRun(
          {
            config: this.config,
            repository: this.repository,
            plexClient: this.plexClient,
            seerrClient: this.seerrClient,
            embeddingProviderFactory: this.embeddingProviderFactory
          },
          controller.signal,
          runOptions
        );
    this.activeRun = run;
    try {
      const result = await run;
      this.lastResult = result;
      return result;
    } catch (error) {
      const result = failureResult(safeErrorMessage(error, this.config.knownSecrets), runStartedAt);
      this.lastResult = result;
      return result;
    } finally {
      if (this.activeRun === run) this.activeRun = undefined;
      if (this.abortController === controller) this.abortController = undefined;
      this.running = false;
      this.currentStartedAt = undefined;
    }
  }

  async restart() {
    this.stop();
    this.start();
    await this.syncWorker?.restart(this.config);
  }

  private scheduleNextRun() {
    if (!this.started || this.config.sync.intervalMinutes <= 0) return;
    const generation = this.generation;
    const intervalMs = this.config.sync.intervalMinutes * 60 * 1000;
    this.nextRunAt = new Date(Date.now() + intervalMs).toISOString();
    this.timer = setTimeout(async () => {
      this.timer = undefined;
      this.nextRunAt = undefined;
      await this.runOnce();
      if (this.started && this.generation === generation) this.scheduleNextRun();
    }, intervalMs);
    this.timer.unref();
  }

  private startingProgress() {
    if (!this.running || !this.currentStartedAt) return undefined;
    return { stage: "starting" as const, startedAt: this.currentStartedAt, updatedAt: this.currentStartedAt };
  }
}

function failureResult(error: string, acceptedStartedAt?: string): SyncCompletionResult {
  const finishedMs = Date.now();
  const acceptedMs = Date.parse(acceptedStartedAt ?? "");
  const startedMs = Number.isFinite(acceptedMs) ? acceptedMs : finishedMs;
  return {
    ok: false,
    error,
    startedAt: new Date(startedMs).toISOString(),
    finishedAt: new Date(finishedMs).toISOString(),
    durationMs: Math.max(0, finishedMs - startedMs),
    stageDurationsMs: {}
  };
}
