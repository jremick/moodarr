import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { Headers, Response, type V4FetchHandler } from "miniflare";

export const publicOrigin = "https://mcp.example";
export const instanceRegistry = [
  { id: "alice", name: "Alice's Moodarr", origin: "https://alice.example" },
  { id: "bob", name: "Bob's Moodarr", origin: "https://bob.example" }
];

type Json = Record<string, unknown>;
export interface FixtureCall {
  instanceId: string;
  path: string;
  method: string;
  body?: Json;
  authorized: boolean;
  idempotencyKey?: string;
  challengeCookieValid?: boolean;
}

interface Challenge {
  code: string;
  cookie: string;
  polls: number;
  consumed: boolean;
}

interface FixtureInstance {
  challenges: Map<string, Challenge>;
  sessions: Set<string>;
  enabled: boolean;
  pendingPolls: number;
  expiredSession: boolean;
  searchFailure?: "redirect" | "malformed" | "diagnostic";
  creationFailure?: "unknown" | "blocked";
}

/** Synthetic external API, reached only through workerd's network boundary. */
export class MoodarrHttpFixtures {
  readonly calls: FixtureCall[] = [];
  readonly deniedDestinations: string[] = [];
  readonly instances = new Map<string, FixtureInstance>(instanceRegistry.map(({ id }) => [id, {
    challenges: new Map(), sessions: new Set(), enabled: true, pendingPolls: 1, expiredSession: false
  }]));

  readonly outbound: V4FetchHandler = async (request) => {
    const url = new URL(request.url);
    const registered = instanceRegistry.find(({ origin }) => origin === url.origin);
    if (!registered) {
      this.deniedDestinations.push(`${url.origin}${url.pathname}`);
      return Response.json({ error: "Synthetic egress denied." }, { status: 502 });
    }
    const instance = this.instances.get(registered.id)!;
    let body: Json | undefined;
    if (request.method !== "GET" && request.method !== "HEAD") {
      try { body = await request.json() as Json; }
      catch { return Response.json({ error: "Expected JSON request." }, { status: 400 }); }
    }
    const token = request.headers.get("Authorization")?.replace(/^Bearer /, "");
    const authorized = Boolean(token && instance.sessions.has(token) && instance.enabled);
    const call: FixtureCall = {
      instanceId: registered.id, path: url.pathname, method: request.method, body, authorized,
      idempotencyKey: request.headers.get("Idempotency-Key") ?? undefined
    };
    this.calls.push(call);

    if (url.pathname === "/api/auth/plex/start" && request.method === "POST") {
      const pinId = `${registered.id}-${instance.challenges.size + 1}`;
      const code = `fixture-pin-${pinId}`;
      const cookie = `fixture-challenge-${pinId}-${Buffer.from(randomBytes(20)).toString("hex")}`;
      instance.challenges.set(pinId, { code, cookie, polls: 0, consumed: false });
      const headers = new Headers();
      headers.append("Set-Cookie", `moodarr_plex_auth_state=${cookie}; HttpOnly; SameSite=Strict; Path=/api/auth/plex; Secure`);
      headers.append("Set-Cookie", "irrelevant_cookie=must-not-be-forwarded; HttpOnly; Secure");
      return Response.json({
        ok: true, pinId, code,
        authUrl: `https://app.plex.tv/auth#?code=${code}&forwardUrl=${encodeURIComponent(registered.origin + "/")}`,
        expiresAt: new Date(Date.now() + 5 * 60_000).toISOString()
      }, { headers });
    }
    if (url.pathname === "/api/auth/plex/complete" && request.method === "POST") {
      const challenge = instance.challenges.get(String(body?.pinId));
      const cookie = request.headers.get("Cookie");
      call.challengeCookieValid = Boolean(challenge && cookie === `moodarr_plex_auth_state=${challenge.cookie}`);
      if (!challenge || challenge.consumed || body?.code !== challenge.code || !call.challengeCookieValid || body?.nativeSession !== true) {
        return Response.json({ error: "Invalid synthetic native sign-in." }, { status: 400 });
      }
      if (challenge.polls++ < instance.pendingPolls) return Response.json({ authenticated: false, pending: true }, { status: 202 });
      challenge.consumed = true;
      if (!instance.enabled) return Response.json({ error: "User is disabled." }, { status: 403 });
      const sessionToken = `fixture-session-${registered.id}-${Buffer.from(randomBytes(32)).toString("base64url")}`;
      instance.sessions.add(sessionToken);
      return Response.json({
        authenticated: true, plexAuthEnabled: true, allowNewPlexUsers: true,
        user: this.user(registered.id), sessionToken,
        sessionExpiresAt: new Date(Date.now() + (instance.expiredSession ? -60_000 : 30 * 24 * 60 * 60_000)).toISOString()
      });
    }
    if (!authorized) return Response.json({ error: "Synthetic session no longer valid." }, { status: 401 });
    if (url.pathname === "/api/auth/session" && request.method === "GET") {
      return Response.json({ authenticated: true, user: this.user(registered.id) });
    }
    const item = this.item(registered.id);
    if (url.pathname === "/api/search" && request.method === "POST") {
      if (instance.searchFailure === "redirect") {
        return new Response(null, { status: 307, headers: { Location: "https://unregistered.example/api/search" } });
      }
      if (instance.searchFailure === "malformed") return new Response("not-json", { headers: { "Content-Type": "application/json" } });
      if (instance.searchFailure === "diagnostic") {
        return Response.json({ error: `Internal detail ${token}`, cookie: "fixture-secret-cookie", diagnostics: { upstreamToken: token } }, { status: 500 });
      }
      return Response.json({
        sessionId: `${registered.id}-recommendation-session`, query: body?.query,
        optimizedQuery: body?.query, usedAi: false, summary: `${registered.name} matches`,
        refinementOptions: [], resolvedFilters: body?.filters ?? {}, watchContext: body?.watchContext ?? "solo",
        resultLimit: body?.resultLimit ?? 10, aiRerank: { requested: false, status: "not_requested" },
        results: [item], groups: { not_in_plex_requestable: [item] },
        diagnostics: { upstreamToken: token, cookie: "fixture-secret-cookie" }
      });
    }
    if (url.pathname === "/api/items/shared-tv" && request.method === "GET") {
      return Response.json({ ...item, cast: [], directors: [], externalIds: { tmdb: "9911" } });
    }
    if (url.pathname === "/api/library/stats" && request.method === "GET") return Response.json({ totalItems: registered.id === "alice" ? 11 : 22 });
    if (url.pathname === "/api/feel-feedback" && request.method === "POST") {
      return Response.json({ ok: true, eventId: 31, reliability: "high", appliedPreferenceSignal: true });
    }
    if (url.pathname === "/api/requests/preview" && request.method === "POST") {
      return Response.json({
        canRequest: instance.creationFailure !== "blocked",
        blockedReason: instance.creationFailure === "blocked" ? "Synthetic user cannot request this title." : undefined,
        requestMode: "attempt", seerrAvailabilityChecked: false, requiresConfirmation: true,
        confirmationPhrase: `REQUEST ${item.title}`, confirmationToken: registered.id === "alice" ? "a".repeat(64) : "b".repeat(64),
        request: { mediaType: "tv", mediaId: 9911, seasons: body?.seasons ?? [1, 3], title: item.title }, item
      });
    }
    if (url.pathname === "/api/requests/create" && request.method === "POST") {
      if (instance.creationFailure === "unknown") return Response.json({ error: "Synthetic request outcome is unknown." }, { status: 503 });
      return Response.json({ ok: true, request: { mediaType: "tv", mediaId: body?.tmdbId, seasons: body?.seasons, title: item.title }, seerr: { id: 778, status: "pending" } });
    }
    if (url.pathname === "/api/plex/watchlist" && request.method === "POST") return Response.json({ ok: true, itemId: body?.itemId, alreadyWatchlisted: false });
    return Response.json({ error: "Synthetic route does not exist." }, { status: 404 });
  };

  private user(instanceId: string) {
    return { id: "same-upstream-user", provider: "plex", enabled: true, displayName: instanceId === "alice" ? "Alice" : "Bob", canRequest: true, canUseAi: false };
  }

  private item(instanceId: string) {
    return {
      id: "shared-tv", mediaType: "tv", title: instanceId === "alice" ? "Alice's winter mystery" : "Bob's summer comedy",
      genres: ["Mystery"], ratings: {}, availabilityGroup: "not_in_plex_requestable",
      availabilityExplanation: "Synthetic title can be requested.", matchExplanation: "Synthetic seasonal match.", score: 0.8,
      posterUrl: "/api/items/shared-tv/poster"
    };
  }
}
