import { afterEach, describe, expect, it, vi } from "vitest";
import { SharedRateLimitStore } from "../src/server/security/sharedRateLimitStore";

function increment(store: SharedRateLimitStore, key: string, timeWindow = 60_000) {
  let value: { current: number; ttl: number } | undefined;
  let failure: Error | null = null;
  store.incr(
    key,
    (error, result) => {
      failure = error;
      value = result;
    },
    timeWindow
  );
  if (failure) throw failure;
  if (!value) throw new Error("Rate-limit store did not return a counter.");
  return value;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SharedRateLimitStore", () => {
  it("shares child counters and resets an expired key", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00Z"));
    const store = new SharedRateLimitStore();
    const child = store.child();

    expect(child).toBe(store);
    expect(increment(store, "client:group", 1_000)).toMatchObject({ current: 1, ttl: 1_000 });
    expect(increment(child, "client:group", 1_000).current).toBe(2);

    vi.advanceTimersByTime(1_001);
    expect(increment(store, "client:group", 1_000)).toMatchObject({ current: 1, ttl: 1_000 });
  });

  it("caps distinct buckets and evicts the oldest entry", () => {
    const store = new SharedRateLimitStore();
    expect(increment(store, "oldest").current).toBe(1);
    expect(increment(store, "oldest").current).toBe(2);

    for (let index = 1; index <= 5_000; index += 1) increment(store, `client:${index}`);

    expect(increment(store, "oldest").current).toBe(1);
  });
});
