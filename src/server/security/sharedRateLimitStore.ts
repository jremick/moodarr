interface RateLimitBucket {
  current: number;
  expiresAt: number;
}

type RateLimitCallback = (error: Error | null, result?: { current: number; ttl: number }) => void;

const maxRateLimitBuckets = 5_000;

export class SharedRateLimitStore {
  private readonly buckets = new Map<string, RateLimitBucket>();
  private nextPruneAt = 0;

  child() {
    return this;
  }

  incr(key: string, callback: RateLimitCallback, timeWindow: number) {
    try {
      const now = Date.now();
      const existing = this.buckets.get(key);
      if (existing && existing.expiresAt > now) {
        existing.current += 1;
        this.buckets.delete(key);
        this.buckets.set(key, existing);
        callback(null, { current: existing.current, ttl: existing.expiresAt - now });
        return;
      }

      if (existing) this.buckets.delete(key);
      this.pruneExpiredIfDue(now, timeWindow);
      this.evictOldestIfFull();
      this.buckets.set(key, { current: 1, expiresAt: now + timeWindow });
      callback(null, { current: 1, ttl: timeWindow });
    } catch (error) {
      callback(error instanceof Error ? error : new Error("Rate-limit store failed."));
    }
  }

  private pruneExpiredIfDue(now: number, timeWindow: number) {
    if (this.buckets.size < maxRateLimitBuckets || now < this.nextPruneAt) return;
    this.nextPruneAt = now + Math.max(1, Math.min(timeWindow, 60_000));
    for (const [key, bucket] of this.buckets) {
      if (bucket.expiresAt <= now) this.buckets.delete(key);
    }
  }

  private evictOldestIfFull() {
    while (this.buckets.size >= maxRateLimitBuckets) {
      const oldestKey = this.buckets.keys().next().value;
      if (typeof oldestKey !== "string") return;
      this.buckets.delete(oldestKey);
    }
  }
}
