import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/server/config";
import { PlexAuthClient } from "../src/server/integrations/plexAuthClient";

const configuredPlexToken = "configured-plex-token-secret";
const userPlexToken = "user-plex-token-secret";

const config: AppConfig = {
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
    enabled: true,
    allowNewUsers: true,
    clientIdentifier: "moodarr-test-client",
    productName: "Moodarr Test"
  },
  plex: {
    baseUrl: "http://plex.example",
    token: configuredPlexToken,
    webBaseUrl: "https://app.plex.tv/desktop"
  },
  seerr: {},
  ai: {
    provider: "none",
    openaiModel: "gpt-5.5",
    openaiEmbeddingModel: "text-embedding-3-large",
    openaiReasoningEffort: "low"
  },
  sync: {
    intervalMinutes: 0,
    syncSeerr: false
  },
  search: {
    defaultResultLimit: 50
  },
  reviewQueue: {
    retentionDays: 90,
    maxQueries: 500,
    captureRawQueries: false
  },
  knownSecrets: [configuredPlexToken]
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("PlexAuthClient response boundaries", () => {
  it("preserves valid sign-in responses while dropping unsafe optional profile fields", async () => {
    vi.stubGlobal(
      "fetch",
      plexAuthFetch({
        user: {
          id: 42,
          username: "viewer",
          title: `Viewer ${userPlexToken}`,
          email: `${configuredPlexToken}@example.com`,
          thumb: "javascript:alert(1)"
        }
      })
    );

    const result = await new PlexAuthClient(config).completePin("123", "ABCD");

    expect(result).toEqual({
      pending: false,
      token: userPlexToken,
      user: { providerUserId: "42", username: "viewer" }
    });
    expect(JSON.stringify(result.user)).not.toContain(configuredPlexToken);
    expect(JSON.stringify(result.user)).not.toContain(userPlexToken);
  });

  it("rejects malformed required PIN and completion fields", async () => {
    vi.stubGlobal("fetch", plexAuthFetch({ pinStart: { id: { unsafe: true }, code: 1234 } }));
    await expect(new PlexAuthClient(config).createPin(config.webOrigin)).rejects.toThrow("invalid PIN response");

    vi.stubGlobal("fetch", plexAuthFetch({ pinComplete: { authToken: { unsafe: true } } }));
    await expect(new PlexAuthClient(config).completePin("123", "ABCD")).rejects.toThrow("invalid completion response");
  });

  it("does not reflect malformed upstream JSON in operational errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`{"authToken":"${userPlexToken}"`, { status: 200 })));

    const error = await caughtError(new PlexAuthClient(config).completePin("123", "ABCD"));

    expect(error.message).toBe("Plex auth returned an invalid completion response.");
    expect(error.message).not.toContain(userPlexToken);
  });

  it("rejects secret reflection in required user and server identity fields without echoing it", async () => {
    vi.stubGlobal("fetch", plexAuthFetch({ user: { uuid: `account-${userPlexToken}`, username: "viewer" } }));
    const userError = await caughtError(new PlexAuthClient(config).completePin("123", "ABCD"));
    expect(userError.message).toContain("safe account id");
    expect(userError.message).not.toContain(userPlexToken);

    vi.stubGlobal("fetch", plexAuthFetch({ identity: { MediaContainer: { machineIdentifier: `server-${configuredPlexToken}` } } }));
    const identityError = await caughtError(new PlexAuthClient({ ...config, knownSecrets: [] }).completePin("123", "ABCD"));
    expect(identityError.message).toContain("identity response was invalid");
    expect(identityError.message).not.toContain(configuredPlexToken);
  });

  it("enforces the small Plex auth response byte limit", async () => {
    vi.stubGlobal("fetch", plexAuthFetch({ pinStart: { id: 123, code: "ABCD", padding: "x".repeat(70 * 1024) } }));

    await expect(new PlexAuthClient(config).createPin(config.webOrigin)).rejects.toThrow("65536 byte limit");
  });

  it("enforces the larger Plex resources byte and record limits", async () => {
    vi.stubGlobal(
      "fetch",
      plexAuthFetch({ resources: { MediaContainer: { Device: [], padding: "x".repeat(1024 * 1024) } } })
    );
    await expect(new PlexAuthClient(config).completePin("123", "ABCD")).rejects.toThrow("1048576 byte limit");

    vi.stubGlobal(
      "fetch",
      plexAuthFetch({ resources: Array.from({ length: 1_001 }, (_, index) => ({ clientIdentifier: `server-${index}`, provides: "server" })) })
    );
    await expect(new PlexAuthClient(config).completePin("123", "ABCD")).rejects.toThrow("safe resource limit");
  });

  it("does not treat malformed resource permissions as unrestricted access", async () => {
    vi.stubGlobal("fetch", plexAuthFetch({ resources: [{ clientIdentifier: "server-abc", provides: { unsafe: true } }] }));

    await expect(new PlexAuthClient(config).completePin("123", "ABCD")).rejects.toThrow("does not have access");
  });
});

interface PlexAuthBodies {
  pinStart: unknown;
  pinComplete: unknown;
  user: unknown;
  identity: unknown;
  resources: unknown;
}

function plexAuthFetch(overrides: Partial<PlexAuthBodies> = {}) {
  const bodies: PlexAuthBodies = {
    pinStart: { id: 123, code: "ABCD", expiresAt: "2026-08-01T12:00:00.000Z" },
    pinComplete: { id: 123, code: "ABCD", authToken: userPlexToken },
    user: { id: 42, username: "viewer", title: "Viewer", email: "viewer@example.com", thumb: "https://example.com/avatar.jpg" },
    identity: { MediaContainer: { machineIdentifier: "server-abc" } },
    resources: [{ clientIdentifier: "server-abc", provides: "server" }],
    ...overrides
  };
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://plex.tv/api/v2/pins" && init?.method === "POST") return jsonResponse(bodies.pinStart);
    if (url.startsWith("https://plex.tv/api/v2/pins/123")) return jsonResponse(bodies.pinComplete);
    if (url === "https://plex.tv/api/v2/user") return jsonResponse(bodies.user);
    if (url === "http://plex.example/identity") return jsonResponse(bodies.identity);
    if (url.startsWith("https://plex.tv/api/v2/resources")) return jsonResponse(bodies.resources);
    return jsonResponse({}, 404);
  });
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

async function caughtError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("Expected operation to reject.");
}
