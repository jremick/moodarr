interface QueuedTask<T> {
  key: string;
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

export class PosterFetchCoordinator {
  private active = 0;
  private readonly queue: Array<QueuedTask<unknown>> = [];
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly concurrency = 6, private readonly maximumQueue = 100) {}

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;
    if (this.queue.length >= this.maximumQueue) return Promise.reject(Object.assign(new Error("Poster fetch capacity is busy."), { statusCode: 503 }));
    const promise = new Promise<T>((resolve, reject) => {
      this.queue.push({ key, task, resolve, reject } as QueuedTask<unknown>);
      this.pump();
    });
    this.inFlight.set(key, promise);
    void promise.finally(() => this.inFlight.delete(key)).catch(() => undefined);
    return promise;
  }

  private pump() {
    while (this.active < this.concurrency) {
      const next = this.queue.shift();
      if (!next) return;
      this.active += 1;
      void next
        .task()
        .then(next.resolve, next.reject)
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }
}
