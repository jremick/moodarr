import { Worker } from "node:worker_threads";
import type { SyncCompletionResult, SyncProgress } from "../../shared/types";
import type { AppConfig } from "../config";
import type { SyncRunOptions } from "./syncRunner";

type WorkerResponse =
  | { type: "ready" }
  | { type: "progress"; id: number; progress: SyncProgress }
  | { type: "result"; id: number; result: SyncCompletionResult }
  | { type: "error"; id: number; error?: string };

interface ActiveRun {
  id: number;
  options: SyncRunOptions;
  dispatched: boolean;
  resolve: (result: SyncCompletionResult) => void;
  reject: (error: Error) => void;
}

const cancellationGraceMs = 2_000;

export class SyncWorkerPool {
  private config: AppConfig;
  private worker: Worker | undefined;
  private ready = false;
  private closed = false;
  private nextId = 1;
  private active: ActiveRun | undefined;
  private progress: SyncProgress | undefined;
  private lastResult: SyncCompletionResult | undefined;
  private lifecycle: Promise<void> = Promise.resolve();
  private cancelTimer: NodeJS.Timeout | undefined;
  private readonly workers = new Set<Worker>();

  constructor(config: AppConfig, private readonly runtimeOverride?: URL) {
    this.config = structuredClone(config);
    this.spawn();
  }

  run(options: SyncRunOptions = {}) {
    if (this.closed) return Promise.reject(new Error("Sync worker is shutting down."));
    if (this.active) return Promise.reject(new Error("Sync is already running."));
    return new Promise<SyncCompletionResult>((resolve, reject) => {
      this.active = { id: this.nextId++, options, dispatched: false, resolve, reject };
      this.progress = undefined;
      this.pump();
    });
  }

  status() {
    return {
      mode: "worker" as const,
      ready: this.ready,
      running: Boolean(this.active),
      closed: this.closed,
      workerCount: this.workers.size,
      progress: this.progress,
      lastResult: this.lastResult
    };
  }

  cancel(reason = "Sync stopped.") {
    const active = this.active;
    if (!active) return;
    if (!active.dispatched || !this.worker) {
      this.active = undefined;
      this.progress = undefined;
      active.reject(new Error(reason));
      return;
    }
    this.worker.postMessage({ type: "cancel", id: active.id });
    clearTimeout(this.cancelTimer);
    this.cancelTimer = setTimeout(() => void this.reset(new Error(reason)), cancellationGraceMs);
    this.cancelTimer.unref();
  }

  restart(config: AppConfig) {
    this.config = structuredClone(config);
    return this.enqueueReset(new Error("Sync configuration changed."));
  }

  close() {
    if (this.closed) return this.lifecycle;
    this.closed = true;
    return this.enqueueReset(new Error("Sync worker is shutting down."));
  }

  private spawn() {
    if (this.closed) return;
    this.ready = false;
    const runtimeUrl =
      this.runtimeOverride ??
      (import.meta.url.endsWith(".ts") ? new URL("./syncWorkerRuntime.ts", import.meta.url) : new URL("./syncWorker.js", import.meta.url));
    const worker = new Worker(runtimeUrl, {
      workerData: { config: this.config },
      name: "moodarr-sync",
      execArgv: runtimeUrl.pathname.endsWith(".ts") ? ["--import", "tsx"] : undefined
    });
    this.worker = worker;
    this.workers.add(worker);
    worker.on("message", (message: WorkerResponse) => this.onMessage(worker, message));
    worker.on("error", (error) => void this.onFailure(worker, error));
    worker.on("exit", (code) => {
      this.workers.delete(worker);
      if (!this.closed && this.worker === worker) void this.onFailure(worker, new Error(`Sync worker exited with code ${code}.`));
    });
  }

  private onMessage(worker: Worker, message: WorkerResponse) {
    if (worker !== this.worker) return;
    if (message.type === "ready") {
      this.ready = true;
      this.pump();
      return;
    }
    const active = this.active;
    if (!active || message.id !== active.id) return;
    if (message.type === "progress") {
      this.progress = message.progress;
      return;
    }
    clearTimeout(this.cancelTimer);
    this.cancelTimer = undefined;
    this.active = undefined;
    this.progress = undefined;
    if (message.type === "result") {
      this.lastResult = message.result;
      active.resolve(message.result);
    } else {
      active.reject(new Error(message.error ?? "Sync worker failed."));
    }
  }

  private pump() {
    if (!this.ready || !this.worker || !this.active) return;
    this.active.dispatched = true;
    this.worker.postMessage({ type: "run", id: this.active.id, options: this.active.options });
  }

  private async onFailure(worker: Worker, error: Error) {
    if (this.closed || worker !== this.worker) return;
    await this.enqueueReset(error);
  }

  private enqueueReset(error: Error) {
    this.lifecycle = this.lifecycle.then(
      () => this.reset(error),
      () => this.reset(error)
    );
    return this.lifecycle;
  }

  private async reset(error: Error) {
    clearTimeout(this.cancelTimer);
    this.cancelTimer = undefined;
    this.ready = false;
    if (this.active) this.active.reject(error);
    this.active = undefined;
    this.progress = undefined;
    const workers = [...this.workers];
    this.worker = undefined;
    await Promise.allSettled(workers.map((worker) => worker.terminate()));
    this.workers.clear();
    if (!this.closed) this.spawn();
  }
}
