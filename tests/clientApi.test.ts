import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defaultApiTimeoutMs,
  MoodarrApiError,
  MoodarrConnectionError,
  moodarrApi
} from "../src/client/api";

function mockJsonResponse(body: unknown) {
  const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
  fetchMock.mockImplementation(async (input, init) => {
    void input;
    void init;
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("Moodarr client admin API", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("locks the browser admin session with an explicit DELETE", async () => {
    const fetchMock = mockJsonResponse({ ok: true });

    await moodarrApi.lockAdminSession();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/admin/session",
      expect.objectContaining({ method: "DELETE", body: "{}", credentials: "same-origin" })
    );
  });

  it("sends valid JSON bodies for bodyless sync actions", async () => {
    const fetchMock = mockJsonResponse({ accepted: true, running: true, message: "Sync accepted." });

    await moodarrApi.syncLibrary();
    await moodarrApi.syncSeerr();
    await moodarrApi.runSync();

    expect(fetchMock.mock.calls.map(([path, init]) => [path, init?.method, init?.body])).toEqual([
      ["/api/library/sync", "POST", "{}"],
      ["/api/seerr/sync", "POST", "{}"],
      ["/api/admin/sync/run", "POST", "{}"]
    ]);
  });

  it("surfaces a busy sync response message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ accepted: false, running: true, message: "Sync is already running." }), {
          status: 409,
          headers: { "Content-Type": "application/json" }
        })
      )
    );

    await expect(moodarrApi.runSync()).rejects.toThrow("Sync is already running.");
  });

  it("preserves the HTTP status and structured JSON error body", async () => {
    const body = { error: "Sync is already running.", accepted: false, running: true, retryAfterSeconds: 12 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(body), {
          status: 409,
          headers: { "Content-Type": "application/json" }
        })
      )
    );

    const error = await moodarrApi.runSync().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(MoodarrApiError);
    expect(error).toMatchObject({ status: 409, body });
  });

  it.each([
    {
      label: "HTML",
      response: new Response("<html><body>upstream secret proxy page</body></html>", {
        status: 502,
        headers: { "Content-Type": "text/html" }
      }),
      expected: "Moodarr request failed (HTTP 502). The server or proxy returned an unexpected response. Try again or check the Moodarr logs."
    },
    {
      label: "empty",
      response: new Response(null, { status: 503 }),
      expected: "Moodarr request failed (HTTP 503). The server returned no error details. Check the server or proxy and try again."
    }
  ])("uses a bounded actionable message for a $label error response", async ({ response, expected }) => {
    vi.stubGlobal("fetch", vi.fn(async () => response));

    const error = await moodarrApi.configStatus().catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(MoodarrApiError);
    expect(error).toMatchObject({ body: null, message: expected });
    if (!(error instanceof MoodarrApiError)) throw error;
    expect(error.message).not.toMatch(/<html>|upstream secret proxy page/i);
  });

  it("surfaces actionable Web Origin guidance for a rejected search", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            error:
              "This browser address does not match Moodarr's configured Web Origin. Open Moodarr using the configured scheme, host, and port, or update the deployment setting and recreate the container."
          }),
          { status: 403, headers: { "Content-Type": "application/json" } }
        )
      )
    );

    await expect(moodarrApi.search({ query: "cozy adventure", watchContext: "group" })).rejects.toThrow(
      "This browser address does not match Moodarr's configured Web Origin. Open Moodarr using the configured scheme, host, and port, or update the deployment setting and recreate the container."
    );
  });

  it("scopes solo profile reads and exports to the selected Plex user", async () => {
    const fetchMock = mockJsonResponse({});

    await moodarrApi.feelProfile("solo", "user/id");
    await moodarrApi.exportFeelProfiles("user/id");

    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/admin/feel-profiles?watchContext=solo&authUserId=user%2Fid");
    expect(fetchMock.mock.calls[1]?.[0]).toBe("/api/admin/feel-profiles/export?authUserId=user%2Fid");
  });

  it("adds authUserId only to explicitly user-scoped mutations", async () => {
    const fetchMock = mockJsonResponse({ ok: true });

    await moodarrApi.resetFeelProfile({ watchContext: "solo", authUserId: "plex-user" });
    await moodarrApi.rollbackFeelProfile({ watchContext: "group", term: "cozy", version: 2 });

    const soloBody = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit | undefined)?.body));
    const groupBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit | undefined)?.body));
    expect(soloBody).toEqual({ watchContext: "solo", authUserId: "plex-user" });
    expect(groupBody).toEqual({ watchContext: "group", term: "cozy", version: 2 });
  });

  it("attaches cancellation-aware signals for search and review reads", async () => {
    const fetchMock = mockJsonResponse({ items: [] });
    const searchController = new AbortController();
    const reviewController = new AbortController();

    await moodarrApi.search({ query: "cozy", watchContext: "solo" }, searchController.signal);
    await moodarrApi.reviewQueue("pending", 50, reviewController.signal);

    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(fetchMock.mock.calls[1]?.[1]?.signal).toBeInstanceOf(AbortSignal);
  });

  it("preserves AbortError semantics when the caller cancels", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        })
      )
    );
    const controller = new AbortController();
    const request = moodarrApi.search({ query: "cozy", watchContext: "solo" }, controller.signal);

    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
  });

  it("replaces low-level fetch failures with actionable network guidance", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("Failed to fetch internal proxy page");
    }));

    await expect(moodarrApi.configStatus()).rejects.toMatchObject({
      name: "MoodarrConnectionError",
      kind: "network",
      message: "Could not reach the Moodarr server. Check the server or network connection and try again."
    } satisfies Partial<MoodarrConnectionError>);
  });

  it("turns the default timeout into an actionable connection error", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        })
      )
    );
    const request = moodarrApi.configStatus();
    const rejection = expect(request).rejects.toMatchObject({
      name: "MoodarrConnectionError",
      kind: "timeout",
      message: "Moodarr did not respond within 30 seconds. Check the server or network connection and try again."
    } satisfies Partial<MoodarrConnectionError>);

    await vi.advanceTimersByTimeAsync(defaultApiTimeoutMs);

    await rejection;
  });
});
