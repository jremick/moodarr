import { afterEach, describe, expect, it, vi } from "vitest";
import { moodarrApi } from "../src/client/api";

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

  it("forwards cancellation signals for search and review reads", async () => {
    const fetchMock = mockJsonResponse({ items: [] });
    const searchController = new AbortController();
    const reviewController = new AbortController();

    await moodarrApi.search({ query: "cozy", watchContext: "solo" }, searchController.signal);
    await moodarrApi.reviewQueue("pending", 50, reviewController.signal);

    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ signal: searchController.signal }));
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(expect.objectContaining({ signal: reviewController.signal }));
  });
});
