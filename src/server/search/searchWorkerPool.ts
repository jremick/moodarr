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

interface SearchWorkerPoolOptions {
  runtimeUrl?: URL;
  recommendationDiagnosticsDeadlineMs?: number;
  workerTerminationGraceMs?: number;
  workerReadyDeadlineMs?: number;
  maxWorkerReadyAttempts?: number;
}

const maximumQueuedSearches = 2;
const searchCapacity = maximumQueuedSearches + 1;
const diagnosticsCapacity = 1;
const searchDeadlineMs = 15_000;
const recommendationDiagnosticsDeadlineMs = 30_000;
// Diagnostics aggregate the full catalog. Keep them isolated from user searches and reuse the snapshot between Admin refreshes.
const recommendationDiagnosticsCacheMs = 5 * 60_000;
const workerTerminationGraceMs = 2_000;
const workerReadyDeadlineMs = 15_000;
const maxWorkerReadyAttempts = 2;

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
  private readyTimer: NodeJS.Timeout | undefined;
  private diagnosticsPending: RecommendationDiagnosticsTask | undefined;
  private diagnosticsActive: RecommendationDiagnosticsTask | undefined;
  private diagnosticsDeadlineTimer: NodeJS.Timeout | undefined;
  private diagnosticsReadyTimer: NodeJS.Timeout | undefined;
  private diagnosticsCache: { result: RecommendationDiagnostics; expiresAt: number } | undefined;
  private lifecycle: Promise<void> = Promise.resolve();
  private recommendationDiagnosticsPromise: Promise<RecommendationDiagnostics> | undefined;
  private resetQueued = false;
  private searchDegraded = false;
  private diagnosticsDegraded = false;
  private searchReadinessFailures = 0;
  private diagnosticsReadinessFailures = 0;
  private readonly workers = new Set<Worker>();
  private readonly resettingWorkers = new WeakSet<Worker>();

  constructor(config: AppConfig, private readonly options: SearchWorkerPoolOptions = {}) {
    this.config = structuredClone(config);
    this.spawn();
  }

  search(request: SearchRequest, context: { authUserId?: string } = {}) {
    if (this.closed) return Promise.reject(statusError("Search worker is shutting down.", 503));
    if (this.searchDegraded) return Promise.reject(statusError("Search worker is unavailable because it did not become ready.", 503));
    if (this.queue.length + (this.active ? 1 : 0) >= searchCapacity) {
      return Promise.reject(statusError("Search capacity is busy. Retry shortly.", 503));
    }
    return new Promise<SearchResponse>((resolve, reject) => {
      this.queue.push({ type: "search", id: this.nextId++, request, authUserId: context.authUserId, resolve, reject });
      this.pump();
    });
  }

  recommendationDiagnostics(options: { fresh?: boolean } = {}) {
    if (this.closed) return Promise.reject(statusError("Diagnostics worker is shutting down.", 503));
    if (this.diagnosticsDegraded) {
      return Promise.reject(statusError("Diagnostics worker is unavailable because it did not become ready.", 503));
    }
    if (!options.fresh && this.diagnosticsCache && this.diagnosticsCache.expiresAt > Date.now()) {
      return Promise.resolve(this.diagnosticsCache.result);
    }
    if (options.fresh) this.diagnosticsCache = undefined;
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
    const searchRunning = Boolean(this.active);
    const diagnosticsRunning = Boolean(this.diagnosticsActive);
    const searchQueued = this.queue.length;
    const diagnosticsQueued = this.diagnosticsPending ? 1 : 0;
    const degraded = this.searchDegraded || this.diagnosticsDegraded;
    const ready = this.ready && this.diagnosticsReady;
    return {
      mode: "worker" as const,
      ready,
      state: workerState(this.closed, degraded, ready),
      degraded,
      running: searchRunning || diagnosticsRunning,
      runningCount: Number(searchRunning) + Number(diagnosticsRunning),
      queued: searchQueued + diagnosticsQueued,
      capacity: searchCapacity + diagnosticsCapacity,
      roles: {
        search: {
          ready: this.ready,
          state: workerState(this.closed, this.searchDegraded, this.ready),
          degraded: this.searchDegraded,
          running: searchRunning,
          queued: searchQueued,
          capacity: searchCapacity
        },
        diagnostics: {
          ready: this.diagnosticsReady,
          state: workerState(this.closed, this.diagnosticsDegraded, this.diagnosticsReady),
          degraded: this.diagnosticsDegraded,
          running: diagnosticsRunning,
          queued: diagnosticsQueued,
          capacity: diagnosticsCapacity
        }
      },
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
    this.spawnSearchWorker();
    this.spawnDiagnosticsWorker();
  }

  private spawnSearchWorker() {
    if (this.closed || this.worker) return;
    this.ready = false;
    this.searchDegraded = false;
    const runtimeUrl = this.runtimeUrl();
    const sourceRuntime = runtimeUrl.pathname.endsWith(".ts");
    this.worker = this.spawnWorker(runtimeUrl, sourceRuntime, "search");
  }

  private spawnDiagnosticsWorker() {
    if (this.closed || this.diagnosticsWorker) return;
    this.diagnosticsReady = false;
    this.diagnosticsDegraded = false;
    const runtimeUrl = this.runtimeUrl();
    const sourceRuntime = runtimeUrl.pathname.endsWith(".ts");
    this.diagnosticsWorker = this.spawnWorker(runtimeUrl, sourceRuntime, "diagnostics");
  }

  private onMessage(worker: Worker, message: WorkerResponse) {
    if (this.resettingWorkers.has(worker)) return;
    if (this.diagnosticsWorker === worker) {
      this.onDiagnosticsMessage(worker, message);
      return;
    }
    if (this.worker !== worker) return;
    if (message.type === "ready") {
      if (message.role !== "search") return;
      clearTimeout(this.readyTimer);
      this.readyTimer = undefined;
      this.ready = true;
      this.searchDegraded = false;
      this.searchReadinessFailures = 0;
      this.pump();
      return;
    }
    if (!this.active || message.id !== this.active.id) return;
    clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
    const task = this.active;
    this.active = undefined;
    if (message.type === "searchResult") {
      this.diagnosticsCache = undefined;
      task.resolve(message.result);
    }
    else if (message.type === "error") task.reject(statusError(message.error ?? "Repository worker failed.", message.statusCode ?? 500));
    else task.reject(statusError("Repository worker returned an unexpected response.", 500));
    this.pump();
  }

  private onDiagnosticsMessage(worker: Worker, message: WorkerResponse) {
    if (this.diagnosticsWorker !== worker || this.resettingWorkers.has(worker)) return;
    if (message.type === "ready") {
      if (message.role !== "diagnostics") return;
      clearTimeout(this.diagnosticsReadyTimer);
      this.diagnosticsReadyTimer = undefined;
      this.diagnosticsReady = true;
      this.diagnosticsDegraded = false;
      this.diagnosticsReadinessFailures = 0;
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
    const readyTimer = setTimeout(
      () => void this.onWorkerFailure(worker, statusError(`${role === "search" ? "Search" : "Diagnostics"} worker did not become ready before its startup deadline.`, 503)),
      Math.max(1, this.options.workerReadyDeadlineMs ?? workerReadyDeadlineMs)
    );
    readyTimer.unref();
    if (role === "search") this.readyTimer = readyTimer;
    else this.diagnosticsReadyTimer = readyTimer;
    return worker;
  }

  private pump() {
    if (!this.ready || !this.worker || this.active || this.closed) return;
    const task = this.queue.shift();
    if (!task) return;
    const worker = this.worker;
    this.active = task;
    worker.postMessage({ type: task.type, id: task.id, request: task.request, authUserId: task.authUserId, deadlineMs: searchDeadlineMs });
    this.deadlineTimer = setTimeout(() => {
      task.reject(statusError("Search exceeded its execution deadline.", 504));
      if (this.active?.id === task.id) this.active = undefined;
      void this.enqueueSearchReset(statusError("Repository worker was restarted after a deadline.", 503), false, worker);
    }, searchDeadlineMs + workerTerminationGraceMs);
    this.deadlineTimer.unref();
  }

  private pumpDiagnostics() {
    if (!this.diagnosticsReady || !this.diagnosticsWorker || this.diagnosticsActive || !this.diagnosticsPending || this.closed) return;
    const task = this.diagnosticsPending;
    this.diagnosticsPending = undefined;
    this.diagnosticsActive = task;
    const worker = this.diagnosticsWorker;
    worker.postMessage({ type: task.type, id: task.id });
    const deadlineMs = this.options.recommendationDiagnosticsDeadlineMs ?? recommendationDiagnosticsDeadlineMs;
    const terminationGraceMs = this.options.workerTerminationGraceMs ?? workerTerminationGraceMs;
    this.diagnosticsDeadlineTimer = setTimeout(() => {
      task.reject(statusError("Recommendation diagnostics exceeded its execution deadline.", 504));
      if (this.diagnosticsActive?.id === task.id) this.diagnosticsActive = undefined;
      void this.enqueueDiagnosticsReset(statusError("Diagnostics worker was restarted after a deadline.", 503), false, worker);
    }, deadlineMs + terminationGraceMs);
    this.diagnosticsDeadlineTimer.unref();
  }

  private async onWorkerFailure(worker: Worker, error: Error) {
    if (this.closed || this.resettingWorkers.has(worker)) return;
    if (this.diagnosticsWorker === worker) {
      const readinessFailure = !this.diagnosticsReady;
      this.resettingWorkers.add(worker);
      await this.enqueueDiagnosticsReset(statusError(error.message, 503), readinessFailure, worker);
      return;
    }
    if (this.worker !== worker) return;
    const readinessFailure = !this.ready;
    this.resettingWorkers.add(worker);
    await this.enqueueSearchReset(statusError(error.message, 503), readinessFailure, worker);
  }

  private enqueueSearchReset(error: Error & { statusCode?: number }, readinessFailure: boolean, expectedWorker: Worker) {
    this.lifecycle = this.lifecycle.then(
      () => this.resetSearch(error, readinessFailure, expectedWorker),
      () => this.resetSearch(error, readinessFailure, expectedWorker)
    );
    return this.lifecycle;
  }

  private enqueueDiagnosticsReset(error: Error & { statusCode?: number }, readinessFailure: boolean, expectedWorker: Worker) {
    this.lifecycle = this.lifecycle.then(
      () => this.resetDiagnostics(error, readinessFailure, expectedWorker),
      () => this.resetDiagnostics(error, readinessFailure, expectedWorker)
    );
    return this.lifecycle;
  }

  private enqueueReset(error: Error & { statusCode?: number }) {
    if (this.resetQueued) return this.lifecycle;
    this.resetQueued = true;
    this.lifecycle = this.lifecycle.then(
      () => this.resetAll(error),
      () => this.resetAll(error)
    ).finally(() => {
      this.resetQueued = false;
    });
    return this.lifecycle;
  }

  private async resetAll(error: Error & { statusCode?: number }) {
    clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
    clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    clearTimeout(this.diagnosticsDeadlineTimer);
    this.diagnosticsDeadlineTimer = undefined;
    clearTimeout(this.diagnosticsReadyTimer);
    this.diagnosticsReadyTimer = undefined;
    this.ready = false;
    this.diagnosticsReady = false;
    this.searchDegraded = false;
    this.diagnosticsDegraded = false;
    this.searchReadinessFailures = 0;
    this.diagnosticsReadinessFailures = 0;
    this.diagnosticsCache = undefined;
    this.rejectAll(error);
    const workers = [...this.workers];
    this.worker = undefined;
    this.diagnosticsWorker = undefined;
    for (const worker of workers) this.resettingWorkers.add(worker);
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

  private async resetSearch(error: Error & { statusCode?: number }, readinessFailure: boolean, expectedWorker: Worker) {
    if (this.worker !== expectedWorker) return;
    clearTimeout(this.deadlineTimer);
    this.deadlineTimer = undefined;
    clearTimeout(this.readyTimer);
    this.readyTimer = undefined;
    this.ready = false;
    if (readinessFailure) this.searchReadinessFailures += 1;
    if (this.active) this.active.reject(error);
    this.active = undefined;
    for (const task of this.queue.splice(0)) task.reject(error);
    const worker = expectedWorker;
    this.worker = undefined;
    this.resettingWorkers.add(worker);
    try {
      await worker.terminate();
    } finally {
      this.workers.delete(worker);
    }
    if (this.closed || this.resetQueued) return;
    if (readinessFailure && this.searchReadinessFailures >= this.maximumReadyAttempts()) {
      this.searchDegraded = true;
      return;
    }
    this.spawnSearchWorker();
  }

  private async resetDiagnostics(error: Error & { statusCode?: number }, readinessFailure: boolean, expectedWorker: Worker) {
    if (this.diagnosticsWorker !== expectedWorker) return;
    clearTimeout(this.diagnosticsDeadlineTimer);
    this.diagnosticsDeadlineTimer = undefined;
    clearTimeout(this.diagnosticsReadyTimer);
    this.diagnosticsReadyTimer = undefined;
    this.diagnosticsReady = false;
    if (readinessFailure) this.diagnosticsReadinessFailures += 1;
    this.diagnosticsCache = undefined;
    this.diagnosticsPending?.reject(error);
    this.diagnosticsPending = undefined;
    this.diagnosticsActive?.reject(error);
    this.diagnosticsActive = undefined;
    const worker = expectedWorker;
    this.diagnosticsWorker = undefined;
    this.resettingWorkers.add(worker);
    try {
      await worker.terminate();
    } finally {
      this.workers.delete(worker);
    }
    if (this.closed || this.resetQueued) return;
    if (readinessFailure && this.diagnosticsReadinessFailures >= this.maximumReadyAttempts()) {
      this.diagnosticsDegraded = true;
      return;
    }
    this.spawnDiagnosticsWorker();
  }

  private maximumReadyAttempts() {
    return Math.max(1, this.options.maxWorkerReadyAttempts ?? maxWorkerReadyAttempts);
  }

  private runtimeUrl() {
    return this.options.runtimeUrl ?? (import.meta.url.endsWith(".ts") ? new URL("./searchWorkerRuntime.ts", import.meta.url) : new URL("./searchWorker.js", import.meta.url));
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

function workerState(closed: boolean, degraded: boolean, ready: boolean) {
  if (closed) return "closed" as const;
  if (degraded) return "degraded" as const;
  return ready ? "ready" as const : "starting" as const;
}
