import { describe, expect, it } from "vitest";
import { LatestRequestLifecycle } from "../src/client/requestLifecycle";

describe("latest client request lifecycle", () => {
  it("aborts the previous request and accepts only the latest generation", () => {
    const lifecycle = new LatestRequestLifecycle();
    const first = lifecycle.begin();
    const second = lifecycle.begin();

    expect(first.signal.aborted).toBe(true);
    expect(lifecycle.isCurrent(first.generation)).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(lifecycle.isCurrent(second.generation)).toBe(true);
  });

  it("invalidates the active generation when the owning view unmounts", () => {
    const lifecycle = new LatestRequestLifecycle();
    const request = lifecycle.begin();

    lifecycle.abort();

    expect(request.signal.aborted).toBe(true);
    expect(lifecycle.isCurrent(request.generation)).toBe(false);
  });
});
