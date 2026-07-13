import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/config";
import { PlexClient } from "../src/server/integrations/plexClient";

const reflectedSecret = "plex-boundary-token-sentinel";
const config = {
  fixtureMode: false,
  dataDir: ".data-test",
  configPath: ".data-test/config.json",
  dbPath: ":memory:",
  apiPort: 0,
  apiHost: "127.0.0.1",
  webOrigin: "http://127.0.0.1:5173",
  serveClient: false,
  requireAdminToken: false,
  adminAutoSession: false,
  plexAuth: {
    enabled: false,
    allowNewUsers: true,
    clientIdentifier: "moodarr-test",
    productName: "Moodarr Test"
  },
  plex: {
    baseUrl: "http://plex.example:32400",
    token: reflectedSecret,
    webBaseUrl: "https://app.plex.tv/desktop"
  },
  seerr: {
    baseUrl: "http://seerr.example",
    apiKey: "test-seerr-key"
  },
  ai: {
    provider: "none",
    openaiModel: "gpt-5.5",
    openaiEmbeddingModel: "text-embedding-3-large",
    openaiReasoningEffort: "low"
  },
  sync: {
    intervalMinutes: 0,
    syncSeerr: true
  },
  knownSecrets: [reflectedSecret, "test-seerr-key"]
} as AppConfig;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("Plex library response boundaries", () => {
  it("normalizes each page into bounded records and drops optional secret reflections", async () => {
    vi.stubGlobal(
      "fetch",
      plexFetch({
        sections: [{ key: "1", title: `Movies ${reflectedSecret}`, type: "movie" }],
        page: {
          MediaContainer: {
            totalSize: 1,
            offset: 0,
            size: 1,
            Metadata: [{
              title: "Boundary-safe movie",
              summary: `Reflected ${reflectedSecret}`,
              ratingKey: "boundary-safe-rating-key",
              key: `/library/metadata/${reflectedSecret}`,
              guid: `plex://movie/${reflectedSecret}`,
              contentRating: reflectedSecret,
              thumb: `/library/metadata/${reflectedSecret}/thumb`,
              Genre: Array.from({ length: 40 }, (_, index) => ({ tag: `Genre ${index}` })),
              Role: Array.from({ length: 20 }, (_, index) => ({ tag: `Cast ${index}` })),
              Director: Array.from({ length: 12 }, (_, index) => ({ tag: `Director ${index}` })),
              Guid: [
                { id: `tmdb://${reflectedSecret}` },
                ...Array.from({ length: 40 }, (_, index) => ({ id: `source${index}://value${index}` }))
              ]
            }]
          }
        }
      })
    );

    const snapshot = await new PlexClient(config).syncLibrary();
    const [record] = snapshot.records;

    expect(snapshot).toMatchObject({ complete: true, sectionCount: 1 });
    expect(record).toMatchObject({ title: "Boundary-safe movie", mediaType: "movie" });
    expect(record?.summary).toBeUndefined();
    expect(record?.plex).toMatchObject({ libraryTitle: undefined, ratingKey: "boundary-safe-rating-key", guid: undefined });
    expect(record?.plex?.url).toBe(
      "https://app.plex.tv/desktop/#!/server/server-safe/details?key=%2Flibrary%2Fmetadata%2Fboundary-safe-rating-key"
    );
    expect(record?.genres).toHaveLength(32);
    expect(record?.cast).toHaveLength(12);
    expect(record?.directors).toHaveLength(8);
    expect(Object.keys(record?.externalIds ?? {})).toHaveLength(31);
    expect(JSON.stringify(snapshot)).not.toContain(reflectedSecret);
  });

  it("rejects configured-secret reflection in required identity fields without echoing it", async () => {
    const scenarios = [
      { machineIdentifier: `server-${reflectedSecret}` },
      { sections: [{ key: reflectedSecret, title: "Movies", type: "movie" }] },
      { page: page([{ ratingKey: "safe-title-check", title: `Movie ${reflectedSecret}` }]) },
      { page: page([{ ratingKey: reflectedSecret, title: "Safe title" }]) }
    ];

    for (const scenario of scenarios) {
      vi.stubGlobal("fetch", plexFetch(scenario));
      const result = await new PlexClient(config).syncLibrary().catch((error: unknown) => error);
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).not.toContain(reflectedSecret);
    }
  });

  it("enforces endpoint-specific response byte limits", async () => {
    const scenarios = [
      { endpoint: "identity", contentLength: 64 * 1024 + 1 },
      { endpoint: "sections", contentLength: 256 * 1024 + 1 },
      { endpoint: "page", contentLength: 4 * 1024 * 1024 + 1 }
    ] as const;

    for (const scenario of scenarios) {
      vi.stubGlobal(
        "fetch",
        plexFetch({
          responseOverride: (endpoint) => endpoint === scenario.endpoint ? oversizedResponse(scenario.contentLength) : undefined
        })
      );
      await expect(new PlexClient(config).syncLibrary()).rejects.toThrow(/byte limit/);
    }
  });

  it("rejects section lists and declared totals above the snapshot limits", async () => {
    vi.stubGlobal(
      "fetch",
      plexFetch({
        sections: Array.from({ length: 129 }, (_, index) => ({ key: String(index), title: `Section ${index}`, type: "movie" }))
      })
    );
    await expect(new PlexClient(config).syncLibrary()).rejects.toThrow(/safe section limit/);

    vi.stubGlobal("fetch", plexFetch({ page: { MediaContainer: { Metadata: [], totalSize: 100_001 } } }));
    await expect(new PlexClient(config).syncLibrary()).rejects.toThrow(/valid bounded total/);
  });

  it("requires deterministic pagination metadata before accepting a multi-page snapshot", async () => {
    const fetchMock = plexFetch({
      page: { MediaContainer: { Metadata: [{ ratingKey: "repeated-page-item", title: "Repeated page item" }], totalSize: 2 } }
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new PlexClient(config).syncLibrary()).rejects.toThrow(/required pagination metadata/);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps metadata-free zero-total and complete single-page responses compatible", async () => {
    vi.stubGlobal("fetch", plexFetch({ page: { MediaContainer: { totalSize: 0 } } }));
    await expect(new PlexClient(config).syncLibrary()).resolves.toMatchObject({ records: [], complete: true, sectionCount: 1 });

    vi.stubGlobal("fetch", plexFetch({
      page: { MediaContainer: { Metadata: [{ ratingKey: "legacy-one-page", title: "Legacy one-page movie" }], totalSize: 1 } }
    }));
    await expect(new PlexClient(config).syncLibrary()).resolves.toMatchObject({
      records: [{ title: "Legacy one-page movie" }],
      complete: true,
      sectionCount: 1
    });
  });

  it("rejects repeated or overlapping Plex media identities across otherwise consistent pages", async () => {
    const repeated = { ratingKey: "duplicate-rating-key", key: "/library/metadata/42", title: "Repeated page item" };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/identity")) return jsonResponse({ MediaContainer: { machineIdentifier: "server-safe" } });
      if (url.endsWith("/library/sections")) {
        return jsonResponse({ MediaContainer: { Directory: [{ key: "1", title: "Movies", type: "movie" }] } });
      }
      const start = Number(new Headers(init?.headers).get("X-Plex-Container-Start") ?? 0);
      return jsonResponse({ MediaContainer: { totalSize: 2, offset: start, size: 1, Metadata: [repeated] } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new PlexClient(config).syncLibrary()).rejects.toThrow("duplicate or overlapping media identities");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("rejects malformed required strings while safely dropping oversized optional text", async () => {
    vi.stubGlobal("fetch", plexFetch({ page: page([{ title: "x".repeat(501) }]) }));
    await expect(new PlexClient(config).syncLibrary()).rejects.toThrow(/malformed metadata/);

    vi.stubGlobal("fetch", plexFetch({ page: page([{ ratingKey: "safe-title", title: "Safe title", summary: "x".repeat(10_001) }]) }));
    const snapshot = await new PlexClient(config).syncLibrary();
    expect(snapshot.records[0]).toMatchObject({ title: "Safe title", summary: undefined });
  });

  it("applies one aggregate deadline across identity, sections, and pages", async () => {
    const deadline = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((milliseconds) =>
      milliseconds === 5 * 60_000 ? deadline.signal : new AbortController().signal
    );
    const fetchMock = plexFetch({
      afterResponse: (endpoint) => {
        if (endpoint === "identity") deadline.abort(new Error("Plex aggregate sync deadline reached."));
      }
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(new PlexClient(config).syncLibrary()).rejects.toThrow("Plex aggregate sync deadline reached.");
    expect(timeoutSpy).toHaveBeenCalledWith(5 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("composes the aggregate deadline with an existing caller abort signal", async () => {
    const caller = new AbortController();
    const reason = new Error("Caller cancelled Plex sync.");
    caller.abort(reason);
    const fetchMock = plexFetch();
    vi.stubGlobal("fetch", fetchMock);

    await expect(new PlexClient(config).syncLibrary(caller.signal)).rejects.toBe(reason);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not reflect an attacker-controlled section key in snapshot failures", async () => {
    const sectionKey = "attacker-controlled-section-key";
    vi.stubGlobal(
      "fetch",
      plexFetch({
        sections: [{ key: sectionKey, title: "Movies", type: "movie" }],
        page: { MediaContainer: { Metadata: [], totalSize: 1, offset: 0, size: 0 } }
      })
    );

    const result = await new PlexClient(config).syncLibrary().catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("ended library section");
    expect((result as Error).message).not.toContain(sectionKey);
  });

  it("replaces malformed JSON parser diagnostics with a static safe error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`{"value":"${reflectedSecret}"`, {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })));

    const result = await new PlexClient(config).syncLibrary().catch((error: unknown) => error);
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toBe("Plex returned a malformed JSON response.");
    expect((result as Error).message).not.toContain(reflectedSecret);
  });
});

type Endpoint = "identity" | "sections" | "page";

function plexFetch(options: {
  machineIdentifier?: string;
  sections?: unknown[];
  page?: unknown;
  responseOverride?: (endpoint: Endpoint) => Response | undefined;
  afterResponse?: (endpoint: Endpoint) => void;
} = {}) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const endpoint: Endpoint = url.endsWith("/identity") ? "identity" : url.endsWith("/library/sections") ? "sections" : "page";
    const override = options.responseOverride?.(endpoint);
    const response = override ?? (endpoint === "identity"
      ? jsonResponse({ MediaContainer: { machineIdentifier: options.machineIdentifier ?? "server-safe" } })
      : endpoint === "sections"
        ? jsonResponse({ MediaContainer: { Directory: options.sections ?? [{ key: "1", title: "Movies", type: "movie" }] } })
        : jsonResponse(options.page ?? page([{ ratingKey: "safe-movie", title: "Safe movie" }])));
    options.afterResponse?.(endpoint);
    return response;
  });
}

function page(items: unknown[]) {
  return { MediaContainer: { Metadata: items, totalSize: items.length, offset: 0, size: items.length } };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function oversizedResponse(contentLength: number) {
  return new Response("{}", {
    status: 200,
    headers: { "Content-Type": "application/json", "Content-Length": String(contentLength) }
  });
}
