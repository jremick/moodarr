import { Worker } from "node:worker_threads";
import type { RecommendationDiagnostics, SearchRequest, SearchResponse } from "../../shared/types";
import type { AppConfig } from "../config";

interface SearchTask {
  type: "search";
  id: number;
  request: SearchRequest;
  authUserId?: string;
  resolve: (response: SearchResponse) => void;
  reject: (error: Error & { statusCode?: number }) => void;
}

interface RecommendationDiagnosticsTask {
  type: "recommendationDiagnostics";
  id: number;
  resolve: (response: RecommendationDiagnostics) => void;
  reject: (error: Error & { statusCode?: number }) => void;
}

type WorkerResponse =
  | { type: "ready"; role: "search" | "diagnostics" }
  | { type: "searchResult"; id: number; result: SearchResponse }
  | { type: "recommendationDiagnosticsResult"; id: number; result: RecommendationDiagnostics }
  | { type: "error"; id: number; error?: string; statusCode?: number };

const maximumQueuedSearches = 2;
const searchDeadlineMs = 15_000;
const recommendationDiagnosticsDeadlineMs = 30_000;
// Diagnostics aggregate the full catalog. Keep them isolated from user searches and reuse the snapshot between Admin refreshes.
const recommendationDiagnosticsCacheMs = 5 * 60_000;
const workerTerminationGraceMs = 2_000;

export class SearchWorkerPool {
  private config: AppConfig;
  private worker: Worker | undefined;
  private diagnosticsWorker: Worker | undefined;
  private ready = false;
  private diagnosticsReady = false;
  private closed = false;
  private nextId = 1;
  private active: SearchTask | undefined;
  private readonly queue: SearchTask[] = [];
  private deadlineTimer: NodeJS.Timeout | undefined;
  private diagnosticsPending: RecommendationDiagnosticsTask | undefined;
  private diagnosticsActive: RecommendationDiagnosticsTask | undefined;
  private diagnosticsDeadlineTimer: NodeJS.Timeout | undefined;
  private diagnosticsCache: { result: RecommendationDiagnostics; expiresAt: number } | undefined;
  private lifecycle: Promise<void> = Promise.resolve();
  private recommendationDiagnosticsPromise: Promise<RecommendationDiagnostics> | undefined;
  private resetQueued = false;
  private readonly workers = new Set<Worker>();

  constructor(config: AppConfig) {
    this.config = structuredClone(config);
    this.spawn();
  }

  search(request: SearchRequest, context: { authUserId?: string } = {}) {
    if (this.closed) return Promise.reject(statusError("Search worker is shutting down.", 503));
    if (this.queue.length + (this.active ? 1 : 0) >= maximumQueuedSearches + 1) {
      return Promise.reject(statusError("Search capacity is busy. Retry shortly.", 503));
    }
    return new Promise<SearchResponse>((resolve, reject) => {
      this.queue.push({ type: "search", id: this.nextId++, request, authUserId: context.authUserId, resolve, reject });
      this.pump();
    });
  }

  recommendationDiagnostics() {
    if (this.closed) return Promise.reject(statusError("Diagnostics worker is shutting down.", 503));
    if (this.diagnosticsCache && this.diagnosticsCache.expiresAt > Date.now()) {
      return Promise.resolve(this.diagnosticsCache.result);
    }
    if (this.recommendationDiagnosticsPromise) return this.recommendationDiagnosticsPromise;
    const task = new Promise<RecommendationDiagnostics>((resolve, reject) => {
      this.diagnosticsPending = { type: "recommendationDiagnostics", id: this.nextId++, resolve, reject };
      this.pumpDiagnostics();
    });
    const shared = task.finally(() => {
      if (this.recommendationDiagnosticsPromise === shared) this.recommendationDiagnosticsPromise = undefined;
    });
    this.recommendationDiagnosticsPromise = shared;
    return shared;
  }

  restart(config: AppConfig): Promise<void> {
    if (this.closed) return this.lifecycle;
    this.config = structuredClone(config);
    return this.enqueueReset(statusError("Search configuration changed. Retry the search.", 503));
  }

  status() {
    return {
      mode: "worker" as const,
      ready: this.ready && this.diagnosticsReady,
      running: Boolean(this.active || this.diagnosticsActive),
      queued: this.queue.length + (this.diagnosticsPending ? 1 : 0),
      capacity: maximumQueuedSearches + 1,
      closed: this.closed,
      workerCount: this.workers.size
    };
  }

  async close() {
    if (this.closed) return this.lifecycle;
    this.closed = true;
    return this.enqueueReset(statusError("Search worker is shutting down.", 503));
  }

  private spawn() {
    if (this.closed) return;
    this.ready = false;
    this.diagnosticsReady = false;
    const runtimeUrl = import.meta.url.endsWith(".ts")
      ? new URL("./searchWorkerRuntime.ts", import.meta.url)
      : new URL("./searchWorker.js", import.meta.url);
    const sourceRuntime = runtimeUrl.pathname.endsWith(".ts");
    this.worker = this.spawnWorker(runtimeUrl, sourceRuntime, "search");
    this.diagnosticsWorker = this.spawnWorker(runtimeUrl, sourceRuntime, "diagnostics");
  }

  private onMessage(worker: Worker, message: WorkerResponse) {
    if (this.diagnosticsWorker === worker) {
      this.onDiagnosticsMessage(worker, message);
      return;
    }
    if (this.worker !== worker) return;
    if (message.type === "ready") {
      this.ready = true;
      this.pump();
      return;
    }
    if (!this.active || message.id !== this.active.id) return;
    clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
    const task = this.active;
    this.active = undefined;
    if (message.type === "searchResult") task.resolve(message.result);
    else if (message.type === "error") task.reject(statusError(message.error ?? "Repository worker failed.", message.statusCode ?? 500));
    else task.reject(statusError("Repository worker returned an unexpected response.", 500));
    this.pump();
  }

  private onDiagnosticsMessage(worker: Worker, message: WorkerResponse) {
    if (this.diagnosticsWorker !== worker) return;
    if (message.type === "ready") {
      this.diagnosticsReady = true;
      this.pumpDiagnostics();
      return;
    }
    if (!this.diagnosticsActive || message.id !== this.diagnosticsActive.id) return;
    clearTimeout(this.diagnosticsDeadlineTimer);
    this.diagnosticsDeadlineTimer = undefined;
    const task = this.diagnosticsActive;
    this.diagnosticsActive = undefined;
    if (message.type === "recommendationDiagnosticsResult") {
      this.diagnosticsCache = { result: message.result, expiresAt: Date.now() + recommendationDiagnosticsCacheMs };
      task.resolve(message.result);
    } else if (message.type === "error") {
      task.reject(statusError(message.error ?? "Diagnostics worker failed.", message.statusCode ?? 500));
    } else {
      task.reject(statusError("Diagnostics worker returned an unexpected response.", 500));
    }
    this.pumpDiagnostics();
  }

  private spawnWorker(runtimeUrl: URL, sourceRuntime: boolean, role: "search" | "diagnostics") {
    const worker = new Worker(runtimeUrl, {
      workerData: { config: this.config, role },
      name: `moodarr-${role}`,
      execArgv: sourceRuntime ? ["--import", "tsx"] : undefined
    });
    this.workers.add(worker);
    worker.on("message", (message: WorkerResponse) => this.onMessage(worker, message));
    worker.on("error", (error) => void this.onWorkerFailure(worker, error));
    worker.on("exit", (code) => {
      this.workers.delete(worker);
      const isCurrent = this.worker === worker || this.diagnosticsWorker === worker;
      if (!this.closed && isCurrent) void this.onWorkerFailure(worker, new Error(`${role} worker exited with code ${code}.`));
    });
    return worker;
  }

  private pump() {
    if (!this.ready || !this.worker || this.active || this.closed) return;
    const task = this.queue.shift();
    if (!task) return;
    this.active = task;
    this.worker.postMessage({ type: task.type, id: task.id, request: task.request, authUserId: task.authUserId, deadlineMs: searchDeadlineMs });
    this.deadlineTimer = setTimeout(() => {
      task.reject(statusError("Search exceeded its execution deadline.", 504));
      if (this.active?.id === task.id) this.active = undefined;
      void this.enqueueReset(statusError("Repository worker was restarted after a deadline.", 503));
    }, searchDeadlineMs + workerTerminationGraceMs);
    this.deadlineTimer.unref();
  }

  private pumpDiagnostics() {
    if (!this.diagnosticsReady || !this.diagnosticsWorker || this.diagnosticsActive || !this.diagnosticsPending || this.closed) return;
    const task = this.diagnosticsPending;
    this.diagnosticsPending = undefined;
    this.diagnosticsActive = task;
    this.diagnosticsWorker.postMessage({ type: task.type, id: task.id });
    this.diagnosticsDeadlineTimer = setTimeout(() => {
      task.reject(statusError("Recommendation diagnostics exceeded its execution deadline.", 504));
      if (this.diagnosticsActive?.id === task.id) this.diagnosticsActive = undefined;
      void this.enqueueReset(statusError("Repository workers were restarted after a diagnostics deadline.", 503));
    }, recommendationDiagnosticsDeadlineMs + workerTerminationGraceMs);
    this.diagnosticsDeadlineTimer.unref();
  }

  private async onWorkerFailure(worker: Worker, error: Error) {
    if (this.closed || (this.worker !== worker && this.diagnosticsWorker !== worker)) return;
    await this.enqueueReset(statusError(error.message, 503));
  }

  private enqueueReset(error: Error & { statusCode?: number }) {
    if (this.resetQueued) return this.lifecycle;
    this.resetQueued = true;
    this.lifecycle = this.lifecycle.then(
      () => this.reset(error),
      () => this.reset(error)
    ).finally(() => {
      this.resetQueued = false;
    });
    return this.lifecycle;
  }

  private async reset(error: Error & { statusCode?: number }) {
    clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
    clearTimeout(this.diagnosticsDeadlineTimer);
    this.diagnosticsDeadlineTimer = undefined;
    this.ready = false;
    this.diagnosticsReady = false;
    this.diagnosticsCache = undefined;
    this.rejectAll(error);
    const workers = [...this.workers];
    this.worker = undefined;
    this.diagnosticsWorker = undefined;
    await Promise.allSettled(
      workers.map(async (worker) => {
        try {
          await worker.terminate();
        } finally {
          this.workers.delete(worker);
        }
      })
    );
    if (!this.closed) this.spawn();
  }

  private rejectAll(error: Error & { statusCode?: number }) {
    if (this.active) this.active.reject(error);
    this.active = undefined;
    for (const task of this.queue.splice(0)) task.reject(error);
    this.diagnosticsPending?.reject(error);
    this.diagnosticsPending = undefined;
    this.diagnosticsActive?.reject(error);
    this.diagnosticsActive = undefined;
  }
}

function statusError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}
