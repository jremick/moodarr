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
});
