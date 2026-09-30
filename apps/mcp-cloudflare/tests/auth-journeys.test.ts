import assert from "node:assert/strict";
import { test } from "node:test";
import { brokerOrigin, fixture, GrantType, hidden, instances, lifecycleFixture, openConsent, post, startPairing, syntheticCode, tokenExchangeCallback, tokenRequest, upstream, verifier } from "./auth-fixture";

test("initial consent names the client, exact redirect origin, instances and scopes without persistent or upstream writes", async () => {
  const f = await fixture();
  const before = JSON.stringify([...f.kv.records]);
  const consent = await openConsent(f);
  assert.equal(consent.response.status, 200);
  assert.match(consent.html, /Synthetic assistant &lt;script&gt;/);
  assert.match(consent.html, /https:\/\/assistant.example/);
  assert.match(consent.html, /https:\/\/alpha.moodarr.example/);
  assert.match(consent.html, /Search and view the library/);
  assert.match(consent.html, /Preview and create media requests after confirmation/);
  assert.match(consent.response.headers.get("set-cookie")!, /HttpOnly/);
  assert.match(consent.response.headers.get("set-cookie")!, /SameSite=Strict/);
  assert.match(consent.response.headers.get("content-security-policy")!, /frame-ancestors 'none'/);
  assert.equal(JSON.stringify([...f.kv.records]), before);
  assert.equal(f.transactions.stores.size, 0);
});

test("invalid client, unregistered redirect, wrong audience, unsupported scopes and missing/plain PKCE fail before pairing", async () => {
  const f = await fixture();
  for (const [key, value] of [["client_id", "unknown"], ["redirect_uri", "https://evil.example/callback"], ["resource", "https://evil.example/mcp"], ["scope", "moodarr:admin"], ["code_challenge", ""], ["code_challenge_method", "plain"]]) {
    const url = new URL(f.authorize); url.searchParams.set(key, value);
    const response = await f.fetch(new Request(url));
    assert.equal(response.status, 400, key);
    assert.equal(response.headers.has("location"), false, key);
  }
  assert.equal(f.transactions.stores.size, 0);
});

test("cross-browser CSRF, a forged intent, foreign POST origin and unregistered instance cannot start Plex", async () => {
  const f = await fixture(); const consent = await openConsent(f);
  const original = globalThis.fetch; const plex = upstream(); globalThis.fetch = plex.fetch as typeof fetch;
  try {
    for (const request of [
      post("/authorize/start", { intent: consent.intent, csrf: consent.csrf, instance: "alpha" }, ""),
      post("/authorize/start", { intent: consent.intent, csrf: "forged", instance: "alpha" }, consent.browserCookie),
      post("/authorize/start", { intent: "forged", csrf: consent.csrf, instance: "alpha" }, consent.browserCookie),
      post("/authorize/start", { intent: consent.intent, csrf: consent.csrf, instance: "alpha" }, consent.browserCookie, "https://evil.example"),
      post("/authorize/start", { intent: consent.intent, csrf: consent.csrf, instance: "https://evil.example" }, consent.browserCookie)
    ]) assert.ok((await f.fetch(request)).status >= 400);
    assert.equal(plex.calls.length, 0);
  } finally { globalThis.fetch = original; }
});

test("Plex pairing preserves its cookie, waits for approval, exposes identity at final consent, and grants separate users on two instances", async () => {
  const f = await fixture(); const original = globalThis.fetch; const plex = upstream(); globalThis.fetch = plex.fetch as typeof fetch;
  try {
    const userIds: string[] = [];
    for (const instance of instances) {
      plex.reset();
      const pairing = await startPairing(f, instance.id);
      assert.equal(pairing.response.status, 200);
      assert.match(pairing.html, /target="_blank"/);
      assert.doesNotMatch(pairing.html, /challenge-secret/);
      const initialCall = plex.calls.at(-1)!;
      assert.deepEqual(JSON.parse(String(initialCall.init!.body)), {});
      const pending = await f.fetch(post("/authorize/continue", { transaction: pairing.transaction, csrf: pairing.csrf }, pairing.browserCookie));
      assert.equal(pending.status, 202);
      assert.match(await pending.text(), /waiting|approval/i);
      plex.approve();
      const complete = await f.fetch(post("/authorize/continue", { transaction: pairing.transaction, csrf: pairing.csrf }, pairing.browserCookie));
      const html = await complete.text();
      assert.equal(complete.status, 200);
      assert.match(html, /Synthetic Viewer/);
      assert.match(html, new RegExp(instance.origin));
      assert.doesNotMatch(html, /session-secret|challenge-secret/);
      const call = plex.calls.at(-1)!;
      assert.equal(new Headers(call.init!.headers).get("cookie"), "moodarr_plex_auth_state=challenge-secret");
      assert.deepEqual(JSON.parse(String(call.init!.body)), { pinId: "pin-123", code: "plex-pin-secret", nativeSession: true });
      const approved = await f.fetch(post("/authorize/approve", { transaction: hidden(html, "transaction"), csrf: pairing.csrf, decision: "approve" }, pairing.browserCookie));
      assert.equal(approved.status, 302);
      const code = new URL(approved.headers.get("location")!).searchParams.get("code")!;
      userIds.push(code.split(":")[0]);
      const token = await f.fetch(new Request(`${brokerOrigin}/token`, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", client_id: f.client.clientId, code, redirect_uri: f.client.redirectUris[0], code_verifier: verifier, resource: `${brokerOrigin}/mcp` }) }));
      assert.equal(token.status, 200);
      const issued = await token.json() as { access_token: string; refresh_token: string };
      assert.ok(issued.refresh_token);
      const resource = await f.fetch(new Request(`${brokerOrigin}/mcp`, { headers: { authorization: `Bearer ${issued.access_token}` } }));
      const connection = await resource.json() as Record<string, unknown>;
      assert.equal(connection.instanceOrigin, instance.origin);
      assert.equal(connection.userId, "same-user");
      assert.deepEqual(connection.scopes, ["moodarr:read", "moodarr:requests"]);
      const replay = await f.fetch(post("/authorize/approve", { transaction: pairing.transaction, csrf: pairing.csrf, decision: "approve" }, pairing.browserCookie));
      assert.equal(replay.status, 400);
    }
    assert.notEqual(userIds[0], userIds[1]);
    const persisted = JSON.stringify([...f.kv.records]) + JSON.stringify([...f.transactions.stores].map(([, store]) => [...store.data]));
    assert.doesNotMatch(persisted, /session-secret-|challenge-secret|plex-pin-secret/);
  } finally { globalThis.fetch = original; }
});

test("replayed initial consent and concurrent Continue submissions cannot duplicate upstream session creation", async () => {
  const f = await fixture(); const original = globalThis.fetch; const plex = upstream(); plex.approve(); globalThis.fetch = plex.fetch as typeof fetch;
  try {
    const pairing = await startPairing(f);
    const repeat = await f.fetch(post("/authorize/start", { intent: pairing.intent, csrf: pairing.csrf, instance: "alpha" }, pairing.browserCookie));
    assert.equal(repeat.status, 400);
    const responses = await Promise.all([1, 2].map(() => f.fetch(post("/authorize/continue", { transaction: pairing.transaction, csrf: pairing.csrf }, pairing.browserCookie))));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 400]);
    assert.equal(plex.calls.filter(call => call.url.endsWith("/complete")).length, 1);
  } finally { globalThis.fetch = original; }
});

test("expired browser intents and transactions fail before another upstream check", async () => {
  const f = await fixture(); const original = globalThis.fetch; const plex = upstream(); globalThis.fetch = plex.fetch as typeof fetch;
  const now = Date.now;
  try {
    const pairing = await startPairing(f);
    Date.now = () => now() + 301_000;
    assert.equal((await f.fetch(post("/authorize/start", { intent: pairing.intent, csrf: pairing.csrf, instance: "alpha" }, pairing.browserCookie))).status, 400);
    assert.equal((await f.fetch(post("/authorize/continue", { transaction: pairing.transaction, csrf: pairing.csrf }, pairing.browserCookie))).status, 400);
    assert.equal(plex.calls.length, 1);
  } finally { Date.now = now; globalThis.fetch = original; }
});

test("a Moodarr PIN response without optional expiry can pair, but remains bounded to five minutes", async () => {
  const f = await fixture(); const original = globalThis.fetch; const plex = upstream();
  const now = Date.now;
  globalThis.fetch = (async (url, init) => {
    const response = await plex.fetch(url, init);
    if (!String(url).endsWith("/api/auth/plex/start")) return response;
    const data = await response.json() as Record<string, unknown>;
    delete data.expiresAt;
    return Response.json(data, { headers: response.headers });
  }) as typeof fetch;
  try {
    const consent = await openConsent(f);
    const response = await f.fetch(post("/authorize/start", { intent: consent.intent, csrf: consent.csrf, instance: "alpha" }, consent.browserCookie));
    assert.equal(response.status, 200);
    const pairing = { ...consent, transaction: hidden(await response.text(), "transaction") };
    const pending = await f.fetch(post("/authorize/continue", { transaction: pairing.transaction, csrf: pairing.csrf }, pairing.browserCookie));
    assert.equal(pending.status, 202);
    Date.now = () => now() + 301_000;
    const expired = await f.fetch(post("/authorize/continue", { transaction: pairing.transaction, csrf: pairing.csrf }, pairing.browserCookie));
    assert.equal(expired.status, 400);
    assert.equal(plex.calls.filter(call => call.url.endsWith("/complete")).length, 1);
  } finally { Date.now = now; globalThis.fetch = original; }
});

test("denial does not create a grant; disabled identities and expired native sessions never reach final approval", async () => {
  for (const completion of [{ user: { id: "same-user", provider: "plex", enabled: false } }, { sessionExpiresAt: new Date(Date.now() - 1).toISOString() }]) {
    const f = await fixture(); const original = globalThis.fetch; const plex = upstream(completion); plex.approve(); globalThis.fetch = plex.fetch as typeof fetch;
    try {
      const pairing = await startPairing(f);
      const response = await f.fetch(post("/authorize/continue", { transaction: pairing.transaction, csrf: pairing.csrf }, pairing.browserCookie));
      assert.equal(response.status, 502);
      assert.doesNotMatch(await response.text(), /session-secret|challenge-secret/);
      assert.equal([...f.kv.records.keys()].some(key => key.startsWith("grant:")), false);
    } finally { globalThis.fetch = original; }
  }
  const f = await fixture(); const original = globalThis.fetch; const plex = upstream(); plex.approve(); globalThis.fetch = plex.fetch as typeof fetch;
  try {
    const pairing = await startPairing(f);
    await f.fetch(post("/authorize/continue", { transaction: pairing.transaction, csrf: pairing.csrf }, pairing.browserCookie));
    const denied = await f.fetch(post("/authorize/approve", { transaction: pairing.transaction, csrf: pairing.csrf, decision: "deny" }, pairing.browserCookie));
    assert.equal(denied.status, 302);
    assert.equal(new URL(denied.headers.get("location")!).searchParams.get("error"), "access_denied");
    assert.equal([...f.kv.records.keys()].some(key => key.startsWith("grant:")), false);
  } finally { globalThis.fetch = original; }
});

test("untrusted Plex URLs, redirects, oversized/malformed JSON and diagnostic errors stay local and secret-free", async () => {
  const original = globalThis.fetch;
  try {
    for (const response of [
      Response.json({ pinId: "secret-pin", code: "secret-code", authUrl: "https://evil.example/auth", expiresAt: new Date(Date.now() + 240_000).toISOString() }, { headers: { "set-cookie": "moodarr_plex_auth_state=secret-cookie" } }),
      ...["invalid-timestamp", null].map(expiresAt => Response.json({ pinId: "pin-123", code: "plex-pin-secret", authUrl: "https://app.plex.tv/auth#?code=plex-pin-secret&forwardUrl=https%3A%2F%2Falpha.moodarr.example", expiresAt }, { headers: { "set-cookie": "moodarr_plex_auth_state=challenge-secret" } })),
      new Response("secret-body", { status: 302, headers: { location: "https://evil.example" } }),
      new Response("x".repeat(70_000), { headers: { "content-type": "application/json" } }),
      new Response("{invalid secret diagnostic", { headers: { "content-type": "application/json" } }),
      Response.json({ error: "secret-token diagnostic" }, { status: 403 })
    ]) {
      const f = await fixture(); const consent = await openConsent(f);
      globalThis.fetch = (async () => response) as typeof fetch;
      const failed = await f.fetch(post("/authorize/start", { intent: consent.intent, csrf: consent.csrf, instance: "alpha" }, consent.browserCookie));
      assert.equal(failed.status, 502);
      assert.equal(failed.headers.has("location"), false);
      assert.doesNotMatch(await failed.text(), /secret-|diagnostic|evil.example/);
    }
  } finally { globalThis.fetch = original; }
});

test("refresh expiry remains bounded by the native session and a removed or rebound instance fails closed", async () => {
  const f = await fixture();
  const props = { instanceId: "alpha", instanceOrigin: instances[0].origin, userId: "same-user", displayName: "Viewer", sessionToken: "synthetic-native-session-secret", sessionExpiresAt: new Date(Date.now() + 3600_000).toISOString(), scopes: ["moodarr:read"] };
  const options = { env: f.env, grantType: GrantType.REFRESH_TOKEN, clientId: "client", subjectClientId: "client", userId: "subject", grantId: "grant", scope: ["moodarr:read"], requestedScope: ["moodarr:read"], resource: `${brokerOrigin}/mcp`, props };
  const result = await tokenExchangeCallback(options);
  assert.ok(result.accessTokenTTL! <= 3600);
  assert.equal(result.newProps, undefined);
  assert.equal(result.refreshTokenIdleTTL, undefined);
  await assert.rejects(() => tokenExchangeCallback({ ...options, props: { ...props, sessionExpiresAt: new Date(Date.now() - 1).toISOString() } }));
  f.env.INSTANCE_REGISTRY = JSON.stringify([{ ...instances[0], origin: "https://replacement.example" }]);
  await assert.rejects(() => tokenExchangeCallback(options));
});

test("unprotected pinned provider baseline can mint two tokens from the same held code snapshot", async () => {
  const f = await fixture(); const { fields } = await syntheticCode(f);
  const held = f.kv.holdGrantReads(2);
  const requests = [f.fetch(tokenRequest(fields)), f.fetch(tokenRequest(fields))];
  await held.ready; held.release();
  const responses = await Promise.all(requests);
  const results = await Promise.all(responses.map(response => response.json())) as { access_token: string }[];
  assert.deepEqual(responses.map(response => response.status), [200, 200], "This is the dependency's unsafe baseline, separate from the guarded flow.");
  assert.notEqual(results[0].access_token, results[1].access_token);
});

test("unprotected pinned provider baseline can restore a revoked grant from a held refresh snapshot", async () => {
  const f = await fixture(); const { fields } = await syntheticCode(f);
  const tokens = await (await f.fetch(tokenRequest(fields))).json() as { access_token: string; refresh_token: string };
  const held = f.kv.holdGrantReads(1);
  const refreshing = f.fetch(tokenRequest({ grant_type: "refresh_token", client_id: f.client.clientId, refresh_token: tokens.refresh_token, resource: `${brokerOrigin}/mcp` }));
  await held.ready;
  const revoked = await f.fetch(tokenRequest({ token: tokens.refresh_token, client_id: f.client.clientId }));
  assert.equal(revoked.status, 200);
  held.release();
  const refreshed = await refreshing;
  assert.equal(refreshed.status, 200);
  const issued = await refreshed.json() as { access_token: string; refresh_token: string };
  const access = await f.fetch(new Request(`${brokerOrigin}/mcp`, { headers: { authorization: `Bearer ${issued.access_token}` } }));
  assert.equal(access.status, 200, "The dependency alone serves a credential issued after its grant was revoked.");
});

test("the lifecycle guard admits one code exchange and preserves valid retry after deterministic PKCE rejection", async () => {
  const f = await lifecycleFixture(); const { fields } = await syntheticCode(f);
  const invalid = await f.fetch(tokenRequest({ ...fields, code_verifier: "B".repeat(43) }));
  assert.equal(invalid.status, 400);
  const held = f.kv.holdGrantReads(1);
  const first = f.fetch(tokenRequest(fields));
  await held.ready;
  const contender = await f.fetch(tokenRequest(fields));
  assert.equal(contender.status, 400);
  held.release();
  assert.equal((await first).status, 200);
  assert.equal((await f.fetch(tokenRequest(fields))).status, 400);
});

test("a reported successful refresh revocation fences stale KV, concurrent replacements and the whole family", async () => {
  const f = await lifecycleFixture(); const { fields } = await syntheticCode(f);
  const tokens = await (await f.fetch(tokenRequest(fields))).json() as { access_token: string; refresh_token: string };
  const held = f.kv.holdGrantReads(1);
  const refreshing = f.fetch(tokenRequest({ grant_type: "refresh_token", client_id: f.client.clientId, refresh_token: tokens.refresh_token, resource: `${brokerOrigin}/mcp` }));
  await held.ready;
  const contending = await f.fetch(tokenRequest({ token: tokens.refresh_token, client_id: f.client.clientId }));
  assert.equal(contending.status, 429, "An operation that cannot revoke must not claim success.");
  assert.equal(contending.headers.get("retry-after"), "1");
  held.release();
  const issued = await (await refreshing).json() as { access_token: string; refresh_token: string };
  const staleKv = structuredClone([...f.kv.records]);
  const revoked = await f.fetch(tokenRequest({ token: tokens.refresh_token, client_id: f.client.clientId }));
  assert.equal(revoked.status, 200);
  // Reintroduce old snapshots to exercise the actor's tombstone independently
  // of provider KV deletion, as edge reads can lag behind a successful write.
  f.kv.records = new Map(staleKv);
  for (const token of [tokens.access_token, issued.access_token]) {
    assert.equal((await f.fetch(new Request(`${brokerOrigin}/mcp`, { headers: { authorization: `Bearer ${token}` } }))).status, 401);
  }
  for (const token of [tokens.refresh_token, issued.refresh_token]) {
    assert.equal((await f.fetch(tokenRequest({ grant_type: "refresh_token", client_id: f.client.clientId, refresh_token: token, resource: `${brokerOrigin}/mcp` }))).status, 400);
  }
});

test("revocation needs an issued digest and its original client; access revocation does not disconnect refresh", async () => {
  const f = await lifecycleFixture(); const { fields } = await syntheticCode(f);
  const tokens = await (await f.fetch(tokenRequest(fields))).json() as { access_token: string; refresh_token: string };
  const other = await f.env.OAUTH_PROVIDER.createClient({ redirectUris: ["https://second-assistant.example/callback"], tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code", "refresh_token"], responseTypes: ["code"] });
  const prefix = tokens.refresh_token.split(":").slice(0, 2).join(":");
  for (const request of [
    tokenRequest({ token: `${prefix}:${"A".repeat(32)}`, client_id: f.client.clientId }),
    tokenRequest({ token: tokens.refresh_token, client_id: other.clientId })
  ]) assert.equal((await f.fetch(request)).status, 200);
  assert.equal((await f.fetch(new Request(`${brokerOrigin}/mcp`, { headers: { authorization: `Bearer ${tokens.access_token}` } }))).status, 200);
  const revoked = await f.fetch(tokenRequest({ token: tokens.access_token, token_type_hint: "refresh_token", client_id: f.client.clientId }));
  assert.equal(revoked.status, 200);
  assert.equal((await f.fetch(new Request(`${brokerOrigin}/mcp`, { headers: { authorization: `Bearer ${tokens.access_token}` } }))).status, 401);
  const refreshed = await f.fetch(tokenRequest({ grant_type: "refresh_token", client_id: f.client.clientId, refresh_token: tokens.refresh_token, resource: `${brokerOrigin}/mcp` }));
  assert.equal(refreshed.status, 200);
  const persisted = JSON.stringify([...f.transactions.stores].map(([, store]) => [...store.data]));
  assert.equal(persisted.includes(tokens.access_token), false);
  assert.equal(persisted.includes(tokens.refresh_token), false);
});

test("the family alarm never slides on refresh and uncertain mint outcomes remain closed", async () => {
  const f = await lifecycleFixture(); const { fields } = await syntheticCode(f);
  const tokens = await (await f.fetch(tokenRequest(fields))).json() as { access_token: string; refresh_token: string };
  const familyAlarm = [...f.transactions.alarms].find(([name]) => name.startsWith("oauth:"))!;
  assert.ok(familyAlarm[1] <= Date.now() + 31 * 86400_000);
  const now = Date.now;
  try {
    Date.now = () => now() + 60_000;
    assert.equal((await f.fetch(tokenRequest({ grant_type: "refresh_token", client_id: f.client.clientId, refresh_token: tokens.refresh_token, resource: `${brokerOrigin}/mcp` }))).status, 200);
    assert.equal(f.transactions.alarms.get(familyAlarm[0]), familyAlarm[1]);
  } finally { Date.now = now; }
  const fresh = await lifecycleFixture(); const nextCode = await syntheticCode(fresh);
  const { executeTokenRequest } = await import("../src/oauth-lifecycle");
  const uncertain = await executeTokenRequest(tokenRequest(nextCode.fields), fresh.env, async () => Response.json({ error: "temporarily_unavailable" }, { status: 503 }));
  assert.equal(uncertain.status, 503);
  assert.equal((await fresh.fetch(tokenRequest(nextCode.fields))).status, 400);
});
