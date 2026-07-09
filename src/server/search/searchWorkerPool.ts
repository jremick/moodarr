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

type WorkerTask = SearchTask | RecommendationDiagnosticsTask;

type WorkerResponse =
  | { type: "ready" }
  | { type: "searchResult"; id: number; result: SearchResponse }
  | { type: "recommendationDiagnosticsResult"; id: number; result: RecommendationDiagnostics }
  | { type: "error"; id: number; error?: string; statusCode?: number };

const maximumQueuedSearches = 2;
const searchDeadlineMs = 15_000;
const recommendationDiagnosticsDeadlineMs = 30_000;
const workerTerminationGraceMs = 2_000;

export class SearchWorkerPool {
  private config: AppConfig;
  private worker: Worker | undefined;
  private ready = false;
  private closed = false;
  private nextId = 1;
  private active: WorkerTask | undefined;
  private readonly queue: WorkerTask[] = [];
  private deadlineTimer: NodeJS.Timeout | undefined;
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
    if (this.recommendationDiagnosticsPromise) return this.recommendationDiagnosticsPromise;
    if (this.queue.length + (this.active ? 1 : 0) >= maximumQueuedSearches + 1) {
      return Promise.reject(statusError("Diagnostics capacity is busy. Retry shortly.", 503));
    }
    const task = new Promise<RecommendationDiagnostics>((resolve, reject) => {
      this.queue.push({ type: "recommendationDiagnostics", id: this.nextId++, resolve, reject });
      this.pump();
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
      ready: this.ready,
      running: Boolean(this.active),
      queued: this.queue.length,
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
    const runtimeUrl = import.meta.url.endsWith(".ts")
      ? new URL("./searchWorkerRuntime.ts", import.meta.url)
      : new URL("./searchWorker.js", import.meta.url);
    const sourceRuntime = runtimeUrl.pathname.endsWith(".ts");
    const worker = new Worker(runtimeUrl, {
      workerData: { config: this.config },
      name: "moodarr-search",
      execArgv: sourceRuntime ? ["--import", "tsx"] : undefined
    });
    this.worker = worker;
    this.workers.add(worker);
    worker.on("message", (message: WorkerResponse) => this.onMessage(worker, message));
    worker.on("error", (error) => void this.onWorkerFailure(worker, error));
    worker.on("exit", (code) => {
      this.workers.delete(worker);
      if (!this.closed && this.worker === worker) void this.onWorkerFailure(worker, new Error(`Search worker exited with code ${code}.`));
    });
  }

  private onMessage(worker: Worker, message: WorkerResponse) {
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
    if (message.type === "searchResult" && task.type === "search") task.resolve(message.result);
    else if (message.type === "recommendationDiagnosticsResult" && task.type === "recommendationDiagnostics") task.resolve(message.result);
    else if (message.type === "error") task.reject(statusError(message.error ?? "Repository worker failed.", message.statusCode ?? 500));
    else task.reject(statusError("Repository worker returned an unexpected response.", 500));
    this.pump();
  }

  private pump() {
    if (!this.ready || !this.worker || this.active || this.closed) return;
    const task = this.queue.shift();
    if (!task) return;
    this.active = task;
    const deadlineMs = task.type === "search" ? searchDeadlineMs : recommendationDiagnosticsDeadlineMs;
    if (task.type === "search") {
      this.worker.postMessage({ type: task.type, id: task.id, request: task.request, authUserId: task.authUserId, deadlineMs });
    } else {
      this.worker.postMessage({ type: task.type, id: task.id });
    }
    this.deadlineTimer = setTimeout(() => {
      const label = task.type === "search" ? "Search" : "Recommendation diagnostics";
      task.reject(statusError(`${label} exceeded its execution deadline.`, 504));
      if (this.active?.id === task.id) this.active = undefined;
      void this.enqueueReset(statusError("Repository worker was restarted after a deadline.", 503));
    }, deadlineMs + workerTerminationGraceMs);
    this.deadlineTimer.unref();
  }

  private async onWorkerFailure(worker: Worker, error: Error) {
    if (this.closed || this.worker !== worker) return;
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
    this.ready = false;
    this.rejectAll(error);
    const workers = [...this.workers];
    this.worker = undefined;
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
  }
}

function statusError(message: string, statusCode: number) {
  return Object.assign(new Error(message), { statusCode });
}
