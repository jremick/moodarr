import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchRequest } from "../src/shared/types";

const runtime = vi.hoisted(() => ({
  handler: undefined as ((message: { type: "search"; id: number; request: SearchRequest; deadlineMs: number }) => Promise<void>) | undefined,
  search: vi.fn(),
  postMessage: vi.fn()
}));

vi.mock("node:worker_threads", () => ({
  parentPort: {
    on: (_event: string, handler: NonNullable<typeof runtime.handler>) => { runtime.handler = handler; },
    postMessage: runtime.postMessage
  },
  workerData: { config: { dbPath: ":memory:", knownSecrets: [] }, role: "search" }
}));
vi.mock("../src/server/db/database", () => ({ createDatabase: () => ({}) }));
vi.mock("../src/server/db/mediaRepository", () => ({ MediaRepository: class {} }));
vi.mock("../src/server/integrations/seerrClient", () => ({ SeerrClient: class {} }));
vi.mock("../src/server/search/searchService", () => ({ createConfiguredSearchService: () => ({ search: runtime.search }) }));

beforeEach(async () => {
  runtime.search.mockReset();
  runtime.postMessage.mockClear();
  await import("../src/server/search/searchWorkerRuntime");
});

describe("search worker abort handling", () => {
  it("marks its deadline as TimeoutError and returns the service's deterministic fallback", async () => {
    let deadline: unknown;
    const result = { results: [], aiRerank: { requested: true, status: "fallback", failureCategory: "timeout" } };
    runtime.search.mockImplementation(async (_request: SearchRequest, context: { signal: AbortSignal }) => {
      await new Promise<void>((resolve) => context.signal.addEventListener("abort", () => {
        deadline = context.signal.reason;
        resolve();
      }, { once: true }));
      return result;
    });
    await runtime.handler!({ type: "search", id: 7, request: { query: "warm comedy" }, deadlineMs: 0 });
    expect(deadline).toBeInstanceOf(DOMException);
    expect(deadline).toMatchObject({ name: "TimeoutError", message: "Search deadline exceeded." });
    expect(runtime.postMessage).toHaveBeenCalledWith({ type: "searchResult", id: 7, result });
  });

  it("forwards sanitized cancellation as an error instead of a successful provider fallback", async () => {
    runtime.search.mockRejectedValueOnce(new DOMException("Search cancelled.", "AbortError"));
    await runtime.handler!({ type: "search", id: 8, request: { query: "warm comedy" }, deadlineMs: 15_000 });
    expect(runtime.postMessage).toHaveBeenCalledWith({ type: "error", id: 8, statusCode: 500, error: "Search cancelled." });
    expect(runtime.postMessage.mock.calls.some(([message]) => message.type === "searchResult")).toBe(false);
  });
});
