import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import { Miniflare, convertV4MiniflareOptions, CoreHeaders, Headers, Response } from "miniflare";
import { MoodarrHttpFixtures, instanceRegistry, publicOrigin } from "./worker-fixtures.js";

/*
 * Authoring gate: TEST_PLAN.md records the failure cases before production work.
 * This suite protects observable HTTP/OAuth/MCP and persisted transaction behavior.
 * Portable tool tests cannot catch a missing real auth binding, a browser-cookie
 * mismatch, incorrect PKCE discovery, or request-local tenant context leakage.
 * Only outbound network responses are synthetic; no production auth hook is used.
 */
const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const bundlePath = `${packageRoot}dist/index.js`;
const callback = "https://client.example/callback";
const resource = `${publicOrigin}/mcp`;
const readScope = "moodarr:read";
const allScopes = "moodarr:read moodarr:feedback moodarr:requests moodarr:watchlist";

type Json = Record<string, any>;
interface Form { action: string; fields: Record<string, string> }
interface OAuthClient { client_id: string }
interface Authorization { browser: Browser; client: OAuthClient; verifier: string; state: string; continueForm: Form }
interface Grant { client: OAuthClient; access_token: string; refresh_token: string; scope: string }

function decodeHtml(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, (entity) => {
    const named: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">" };
    if (named[entity]) return named[entity];
    return String.fromCodePoint(entity.toLowerCase().startsWith("&#x") ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10));
  });
}

function attributes(tag: string): Record<string, string> {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map((match) => [match[1].toLowerCase(), decodeHtml(match[2] ?? match[3])]));
}

function form(html: string, action: string): Form {
  for (const match of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const formAttributes = attributes(match[1]);
    if (new URL(formAttributes.action ?? "", publicOrigin).pathname !== action) continue;
    const fields: Record<string, string> = {};
    for (const input of match[2].matchAll(/<input\b([^>]*)>/gi)) {
      const inputAttributes = attributes(input[1]);
      if (inputAttributes.type === "hidden" && inputAttributes.name) fields[inputAttributes.name] = inputAttributes.value ?? "";
    }
    return { action, fields };
  }
  assert.fail(`The browser did not receive its expected ${action} form.`);
}

/** Miniflare dispatchFetch rewrites Host. Use its local HTTP socket so the real
 * public Host header reaches the SDK guard; its own URL header models routing. */
async function dispatch(worker: Miniflare, input: string, options: { method?: string; headers?: Record<string, string>; body?: string; redirect?: "manual" } = {}): Promise<Response> {
  const publicUrl = new URL(input);
  const localUrl = new URL(publicUrl.pathname + publicUrl.search, await worker.ready);
  return new Promise((resolve, reject) => {
    const request = httpRequest(localUrl, { method: options.method ?? "GET", headers: {
      Host: publicUrl.host, ...options.headers,
      [CoreHeaders.ORIGINAL_URL]: publicUrl.toString(), [CoreHeaders.DISABLE_PRETTY_ERROR]: "true"
    } }, (incoming) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
        const headers = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1]);
        const status = incoming.statusCode ?? 500;
        resolve(new Response([204, 205, 304].includes(status) ? null : Buffer.concat(chunks), { status, headers }));
      })().catch(reject);
    });
    request.on("error", reject);
    request.setTimeout(70_000, () => request.destroy(new Error("Local HTTP journey timed out.")));
    request.end(options.body);
  });
}

class Browser {
  private readonly cookies = new Map<string, string>();
  constructor(private readonly worker: Miniflare) {}

  async request(path: string, options: { method?: string; fields?: Record<string, string>; origin?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = {};
    if (this.cookies.size) headers.Cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    const method = options.method ?? "GET";
    if (method === "POST") {
      headers.Origin = options.origin ?? publicOrigin;
      headers["Content-Type"] = "application/x-www-form-urlencoded";
    }
    const response = await dispatch(this.worker, new URL(path, publicOrigin).toString(), {
      method, headers, body: options.fields ? new URLSearchParams(options.fields).toString() : undefined, redirect: "manual"
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0];
      const separator = pair.indexOf("=");
      const name = pair.slice(0, separator);
      const value = pair.slice(separator + 1);
      if (/\bmax-age=0\b/i.test(cookie) || value === "") this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return response;
  }

  post(target: Form, fields: Record<string, string> = {}) {
    return this.request(target.action, { method: "POST", fields: { ...target.fields, ...fields } });
  }
}

async function json(response: Response, expectedStatus = 200): Promise<Json> {
  assert.equal(response.status, expectedStatus, "Unexpected HTTP status at a public boundary.");
  return await response.json() as Json;
}

async function register(worker: Miniflare): Promise<OAuthClient> {
  const client = await json(await dispatch(worker, `${publicOrigin}/register`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      client_name: "Moodarr HTTP journey <script>alert(1)</script>",
      redirect_uris: [callback], token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"], response_types: ["code"]
    })
  }), 201);
  assert.equal(typeof client.client_id, "string");
  assert.equal(client.token_endpoint_auth_method, "none");
  return client as OAuthClient;
}

function authorizationUrl(client: OAuthClient, verifier: string, state: string, scope: string) {
  return `/authorize?${new URLSearchParams({
    client_id: client.client_id, redirect_uri: callback, response_type: "code", resource,
    scope, state, code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url")
  })}`;
}

async function start(worker: Miniflare, instance: string, scope = readScope, client?: OAuthClient): Promise<Authorization> {
  const registered = client ?? await register(worker);
  const verifier = Buffer.from(randomBytes(32)).toString("base64url");
  const state = Buffer.from(randomBytes(16)).toString("base64url");
  const browser = new Browser(worker);
  const initial = await browser.request(authorizationUrl(registered, verifier, state, scope));
  assert.equal(initial.status, 200);
  assert.ok(initial.headers.getSetCookie().some((cookie) => cookie.startsWith("__Host-moodarr-auth-") && /HttpOnly/i.test(cookie) && /Secure/i.test(cookie)));
  const initialHtml = await initial.text();
  assert.ok(initialHtml.includes("client.example"), "Consent identifies the registered token destination.");
  assert.ok(!initialHtml.includes("<script>alert(1)</script>"), "DCR client metadata cannot become executable HTML.");
  const linked = await browser.post(form(initialHtml, "/authorize/start"), { instance });
  assert.equal(linked.status, 200);
  const linkHtml = await linked.text();
  assert.ok(linkHtml.includes("https://app.plex.tv/auth"));
  return { browser, client: registered, verifier, state, continueForm: form(linkHtml, "/authorize/continue") };
}

async function finish(auth: Authorization): Promise<Form> {
  let continuation = auth.continueForm;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await auth.browser.post(continuation);
    const html = await response.text();
    if (response.status === 202) {
      continuation = form(html, "/authorize/continue");
      continue;
    }
    assert.equal(response.status, 200, "Plex completion must yield a final identity consent form.");
    return form(html, "/authorize/approve");
  }
  assert.fail("Synthetic Plex sign-in never completed.");
}

async function approve(auth: Authorization, preparedForm?: Form): Promise<{ code: string; form: Form }> {
  const finalForm = preparedForm ?? await finish(auth);
  const approved = await auth.browser.post(finalForm, { decision: "approve" });
  assert.equal(approved.status, 302);
  const location = new URL(approved.headers.get("Location")!);
  assert.equal(`${location.origin}${location.pathname}`, callback);
  assert.equal(location.searchParams.get("state"), auth.state);
  assert.equal(location.searchParams.get("iss"), publicOrigin);
  const code = location.searchParams.get("code");
  assert.ok(code, "Approval issues an authorization code.");
  return { code, form: finalForm };
}

async function tokenRequest(worker: Miniflare, fields: Record<string, string>): Promise<Response> {
  return dispatch(worker, `${publicOrigin}/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString()
  });
}

function exchangeFields(auth: Authorization, code: string) {
  return { grant_type: "authorization_code", client_id: auth.client.client_id, redirect_uri: callback, resource, code, code_verifier: auth.verifier };
}

async function connect(worker: Miniflare, instance: string, scope = readScope, client?: OAuthClient): Promise<Grant> {
  const auth = await start(worker, instance, scope, client);
  const { code } = await approve(auth);
  const tokens = await json(await tokenRequest(worker, exchangeFields(auth, code)));
  assert.equal(tokens.token_type.toLowerCase(), "bearer");
  assert.ok(typeof tokens.access_token === "string" && typeof tokens.refresh_token === "string");
  return { client: auth.client, access_token: tokens.access_token, refresh_token: tokens.refresh_token, scope: tokens.scope };
}

let rpcId = 0;
async function rpc(worker: Miniflare, grant: Grant, method: string, params?: Json): Promise<Json> {
  const id = ++rpcId;
  const response = await dispatch(worker, resource, {
    method: "POST", headers: {
      Host: new URL(publicOrigin).host, Authorization: `Bearer ${grant.access_token}`, "Content-Type": "application/json",
      Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-11-25"
    }, body: JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })
  });
  const body = await response.text();
  const safeDiagnostic = body.slice(0, 240).replace(/[A-Za-z0-9._-]{32,}/g, "[redacted]");
  assert.equal(response.status, 200, `MCP ${method} should reach its authenticated transport: ${safeDiagnostic}`);
  const messages = response.headers.get("Content-Type")?.includes("text/event-stream")
    ? body.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => JSON.parse(line.slice(5)))
    : [JSON.parse(body)];
  const message = messages.find((candidate) => candidate.id === id);
  assert.ok(message, "MCP response preserves the JSON-RPC request ID.");
  return message;
}

async function initialize(worker: Miniflare, grant: Grant) {
  const initialized = await rpc(worker, grant, "initialize", {
    protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "moodarr-http-test", version: "1" }
  });
  assert.ok(initialized.result?.capabilities?.tools, "Real MCP initialization advertises tools.");
}

async function call(worker: Miniflare, grant: Grant, name: string, args: Json): Promise<Json> {
  const response = await rpc(worker, grant, "tools/call", { name, arguments: args });
  assert.ok(!response.error, "A registered tool reaches its own application contract.");
  return response.result;
}

function data(result: Json): Json {
  assert.ok(result && !result.isError, `Tool result should be successful (${result?.structuredContent?.code ?? "no code"}; ${result?.structuredContent?.status ?? "no status"}).`);
  if (result.structuredContent) return result.structuredContent;
  const content = result.content?.find((part: Json) => part.type === "text");
  assert.ok(content, "Tool returns inspectable content.");
  return JSON.parse(content.text);
}

async function assertFreshBundle(): Promise<string> {
  let bundle;
  try { bundle = await stat(bundlePath); }
  catch { assert.fail("Build the Worker with npm run build before running HTTP integration tests."); }
  const paths = (await readdir(`${packageRoot}src`)).filter((path) => path.endsWith(".ts"));
  for (const path of paths) {
    assert.ok((await stat(`${packageRoot}src/${path}`)).mtimeMs <= bundle.mtimeMs, "Worker bundle is stale; rebuild before testing.");
  }
  return createHash("sha256").update(await readFile(bundlePath)).digest("hex");
}

test("bundled Worker HTTP/OAuth/MCP journeys preserve identity, authority and failure boundaries", { timeout: 120_000 }, async (t) => {
  const bundleSha256 = await assertFreshBundle();
  const fixtures = new MoodarrHttpFixtures();
  const worker = new Miniflare(convertV4MiniflareOptions({
    modules: true, scriptPath: bundlePath, compatibilityDate: "2026-09-30",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    kvNamespaces: ["OAUTH_KV"], durableObjects: { AUTH_TRANSACTIONS: { className: "AuthTransactionStore", useSQLite: true } },
    ratelimits: { REQUEST_LIMITER: { namespace_id: "1", simple: { limit: 10_000, period: 60 } } },
    bindings: {
      PUBLIC_ORIGIN: publicOrigin, INSTANCE_REGISTRY: JSON.stringify(instanceRegistry),
      AUTH_SECRET: Buffer.from(randomBytes(32)).toString("base64url")
    }, outboundService: fixtures.outbound
  }));
  const cases: { name: string; status: "passed" | "failed" }[] = [];
  const scenario = async (name: string, run: (context: TestContext) => Promise<void>) => t.test(name, async (context) => {
    try { await run(context); cases.push({ name, status: "passed" }); }
    catch (error) { cases.push({ name, status: "failed" }); throw error; }
  });
  try {
    await worker.ready;
    await scenario("public discovery and browser guards expose only the pinned OAuth resource", async () => {
      const unauthenticated = await dispatch(worker, resource, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
      assert.equal(unauthenticated.status, 401);
      assert.ok(unauthenticated.headers.get("WWW-Authenticate")?.includes(`${publicOrigin}/.well-known/oauth-protected-resource/mcp`));
      const protectedResource = await json(await dispatch(worker, `${publicOrigin}/.well-known/oauth-protected-resource/mcp`));
      assert.equal(protectedResource.resource, resource);
      assert.deepEqual(protectedResource.authorization_servers, [publicOrigin]);
      const metadata = await json(await dispatch(worker, `${publicOrigin}/.well-known/oauth-authorization-server`));
      assert.equal(metadata.issuer, publicOrigin);
      assert.equal(metadata.authorization_endpoint, `${publicOrigin}/authorize`);
      assert.equal(metadata.token_endpoint, `${publicOrigin}/token`);
      assert.equal(metadata.registration_endpoint, `${publicOrigin}/register`);
      assert.ok(metadata.code_challenge_methods_supported.includes("S256"));
      assert.equal((await dispatch(worker, "https://untrusted.example/health")).status, 421);
      assert.equal((await dispatch(worker, `${publicOrigin}/health`, { headers: { Origin: "https://attacker.example" } })).status, 403);
      const preflight = await dispatch(worker, resource, { method: "OPTIONS", headers: { Origin: "https://chatgpt.com" } });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), "https://chatgpt.com");
      assert.equal(fixtures.calls.length, 0);
    });

    await scenario("cross-browser consent and unknown instances cannot initiate native sign-in", async () => {
      const client = await register(worker);
      const verifier = Buffer.from(randomBytes(32)).toString("base64url");
      const browser = new Browser(worker);
      const page = await browser.request(authorizationUrl(client, verifier, "guard-state", readScope));
      const startForm = form(await page.text(), "/authorize/start");
      const before = fixtures.calls.length;
      const impostor = new Browser(worker);
      const crossBrowser = await impostor.post(startForm, { instance: "alice" });
      assert.ok(crossBrowser.status >= 400 && crossBrowser.status < 500);
      const tamperedCsrf = await browser.post(startForm, { instance: "alice", csrf: "invalid-browser-proof" });
      assert.ok(tamperedCsrf.status >= 400 && tamperedCsrf.status < 500);
      for (const instance of ["https://unregistered.example", "https://127.0.0.1", "https://[::1]", "https://alice.example/api", "https://alice.example@unregistered.example"]) {
        const fresh = await browser.request(authorizationUrl(client, verifier, "guard-state", readScope));
        const refused = await browser.post(form(await fresh.text(), "/authorize/start"), { instance });
        assert.ok(refused.status >= 400 && refused.status < 500, "Unsafe or unregistered instance is refused.");
      }
      assert.equal(fixtures.calls.length, before);
      assert.equal(fixtures.deniedDestinations.length, 0, "Unsafe origins are rejected before egress.");
      for (const changes of [{ redirect_uri: "https://attacker.example/callback" }, { resource: "https://other.example/mcp" }, { code_challenge: "", code_challenge_method: "" }]) {
        const url = new URL(authorizationUrl(client, verifier, "guard-state", readScope), publicOrigin);
        for (const [key, value] of Object.entries(changes)) {
          if (value) url.searchParams.set(key, value);
          else url.searchParams.delete(key);
        }
        const denied = await browser.request(url.toString());
        assert.ok(denied.status >= 400 && denied.status < 500);
        assert.equal(denied.headers.get("Location"), null, "Unvalidated callbacks cannot become redirects.");
      }
      assert.equal(fixtures.calls.length, before);
    });

    await scenario("native sign-in pending, denial, PKCE mismatch and authorization replay fail safely", async () => {
      const auth = await start(worker, "alice");
      const pending = await auth.browser.post(auth.continueForm);
      assert.equal(pending.status, 202);
      const pendingForm = form(await pending.text(), "/authorize/continue");
      const crossBrowser = await new Browser(worker).post(pendingForm);
      assert.ok(crossBrowser.status >= 400 && crossBrowser.status < 500);
      auth.continueForm = pendingForm;
      const consent = await finish(auth);
      const beforeConsent = fixtures.calls.length;
      const crossedConsent = await new Browser(worker).post(consent, { decision: "approve" });
      assert.ok(crossedConsent.status >= 400 && crossedConsent.status < 500);
      const tamperedConsent = await auth.browser.post(consent, { decision: "approve", csrf: "invalid-browser-proof" });
      assert.ok(tamperedConsent.status >= 400 && tamperedConsent.status < 500);
      assert.equal(fixtures.calls.length, beforeConsent, "Cross-browser and altered final consent cannot make upstream calls.");
      const { code, form: approvedForm } = await approve(auth, consent);
      const wrongVerifier = await tokenRequest(worker, { ...exchangeFields(auth, code), code_verifier: Buffer.from(randomBytes(32)).toString("base64url") });
      assert.ok(wrongVerifier.status >= 400 && wrongVerifier.status < 500);
      const wrongResource = await tokenRequest(worker, { ...exchangeFields(auth, code), resource: "https://other.example/mcp" });
      assert.ok(wrongResource.status >= 400 && wrongResource.status < 500);
      const tokens = await json(await tokenRequest(worker, exchangeFields(auth, code)));
      assert.ok(typeof tokens.access_token === "string");
      const replay = await tokenRequest(worker, exchangeFields(auth, code));
      assert.ok(replay.status >= 400 && replay.status < 500);
      const approvalReplay = await auth.browser.post(approvedForm, { decision: "approve" });
      assert.ok(approvalReplay.status >= 400 && approvalReplay.status < 500);
      const deniedAuth = await start(worker, "bob");
      const finalForm = await finish(deniedAuth);
      const denied = await deniedAuth.browser.post(finalForm, { decision: "deny" });
      assert.equal(denied.status, 302);
      const deniedLocation = new URL(denied.headers.get("Location")!);
      assert.equal(deniedLocation.searchParams.get("error"), "access_denied");
      assert.equal(deniedLocation.searchParams.get("code"), null);
      const completions = fixtures.calls.filter((call) => call.path === "/api/auth/plex/complete");
      assert.ok(completions.length > 0 && completions.every((call) => call.challengeCookieValid && call.body?.nativeSession === true));
      assert.ok(fixtures.calls.filter((call) => call.path === "/api/auth/plex/start").every((call) => JSON.stringify(call.body) === "{}"));
    });

    await scenario("one authorization code admits exactly one concurrent valid exchange", async () => {
      const auth = await start(worker, "alice");
      const { code } = await approve(auth);
      const fields = exchangeFields(auth, code);
      const contenders = 16;
      const responses = await Promise.all(Array.from({ length: contenders }, () => tokenRequest(worker, fields)));
      const statuses = responses.map((response) => response.status);
      await Promise.all(responses.map((response) => response.arrayBuffer()));
      assert.equal(statuses.filter((status) => status === 200).length, 1, "An OAuth code has one successful exchange even under simultaneous delivery.");
      assert.equal(statuses.filter((status) => status >= 400 && status < 500).length, contenders - 1);
      const replay = await tokenRequest(worker, fields);
      assert.ok(replay.status >= 400 && replay.status < 500);
    });

    await scenario("successful revocation fences tokens issued during a concurrent refresh", async () => {
      const grant = await connect(worker, "bob", allScopes);
      const metadata = await json(await dispatch(worker, `${publicOrigin}/.well-known/oauth-authorization-server`));
      const revoke = () => dispatch(worker, metadata.revocation_endpoint, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: grant.refresh_token, token_type_hint: "refresh_token", client_id: grant.client.client_id }).toString()
      });
      const refresh = () => tokenRequest(worker, {
        grant_type: "refresh_token", client_id: grant.client.client_id, refresh_token: grant.refresh_token, resource
      });
      const [refreshed, revoked] = await Promise.all([refresh(), revoke()]);
      const issued = refreshed.status === 200 ? await refreshed.json() as Json : undefined;
      if (!issued) await refreshed.arrayBuffer();
      if (revoked.status !== 200) {
        assert.ok(revoked.status >= 400 && revoked.status < 600, "A failed concurrent revoke must report a retryable error rather than success.");
        await revoked.arrayBuffer();
        assert.equal((await revoke()).status, 200, "Explicit revocation retry completes the user's disconnect.");
      } else await revoked.arrayBuffer();
      for (const token of [grant.access_token, issued?.access_token].filter((value): value is string => typeof value === "string")) {
        const stopped = await dispatch(worker, resource, {
          method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{}"
        });
        assert.equal(stopped.status, 401, "A successful revoke invalidates every access token minted by a concurrent refresh.");
        await stopped.arrayBuffer();
      }
      for (const token of [grant.refresh_token, issued?.refresh_token].filter((value): value is string => typeof value === "string")) {
        const stopped = await tokenRequest(worker, { grant_type: "refresh_token", client_id: grant.client.client_id, refresh_token: token, resource });
        assert.ok(stopped.status >= 400 && stopped.status < 500, "A successful revoke prevents concurrent replacement refresh tokens from surviving.");
        await stopped.arrayBuffer();
      }
    });

    await scenario("concurrent users with identical upstream IDs keep MCP search and item data separate", async () => {
      const client = await register(worker);
      const [alice, bob] = await Promise.all([connect(worker, "alice", readScope, client), connect(worker, "bob", readScope, client)]);
      await Promise.all([initialize(worker, alice), initialize(worker, bob)]);
      const beforeHost = fixtures.calls.length;
      const hostileHost = await dispatch(worker, resource, {
        method: "POST", headers: { Host: "unregistered.example", Authorization: `Bearer ${alice.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: "moodarr_search", arguments: { query: "winter mystery" } } })
      });
      assert.equal(hostileHost.status, 403, "The real Host header must match the public MCP service.");
      assert.equal(fixtures.calls.length, beforeHost, "A hostile Host cannot invoke an authenticated upstream tool.");
      const listed = await rpc(worker, alice, "tools/list");
      const searchTool = listed.result.tools.find((tool: Json) => tool.name === "moodarr_search");
      assert.ok(searchTool);
      const uiUri = searchTool._meta?.ui?.resourceUri;
      assert.match(uiUri, /^ui:\/\/moodarr\/[a-f0-9]{64}\/app\.html$/);
      const beforeResource = fixtures.calls.length;
      const ui = await rpc(worker, alice, "resources/read", { uri: uiUri });
      assert.equal(ui.result.contents.length, 1);
      const component = ui.result.contents[0];
      assert.equal(component.uri, uiUri);
      assert.equal(component.mimeType, "text/html;profile=mcp-app");
      assert.equal(Buffer.byteLength(component.text), 526208);
      assert.equal(createHash("sha256").update(component.text).digest("hex"), "db064277173800a24f46d88b4a82f3b4b06c2da4a66d844a01e348a0e5ae1027");
      assert.equal(fixtures.calls.length, beforeResource, "Reading the bundled app needs no upstream credentials or requests.");
      const args = { query: "A winter mystery for a group, TV under 60 minutes, no horror", filters: { mediaTypes: ["tv"], maxRuntimeMinutes: 60, excludedGenres: ["Horror"] }, watchContext: "group", resultLimit: 7 };
      const before = fixtures.calls.length;
      const results = await Promise.all([call(worker, alice, "moodarr_search", args), call(worker, bob, "moodarr_search", args)]);
      assert.equal(data(results[0]).sessionId, "alice-recommendation-session");
      assert.equal(data(results[1]).sessionId, "bob-recommendation-session");
      assert.ok(JSON.stringify(data(results[0])).includes("Alice's winter mystery"));
      assert.ok(!JSON.stringify(data(results[0])).includes("Bob's summer comedy"));
      assert.ok(JSON.stringify(data(results[1])).includes("Bob's summer comedy"));
      const searches = fixtures.calls.slice(before).filter((call) => call.path === "/api/search");
      assert.equal(searches.length, 2);
      assert.ok(searches.every((call) => call.authorized && call.body?.useAi === false && !Object.hasOwn(call.body!, "feedbackContext")));
      assert.deepEqual(searches.map((call) => call.body?.filters), [args.filters, args.filters]);
      assert.equal(fixtures.calls.slice(before).filter((call) => call.path === "/api/feel-feedback").length, 0);
      const details = await Promise.all([call(worker, alice, "moodarr_get_item", { itemId: "shared-tv" }), call(worker, bob, "moodarr_get_item", { itemId: "shared-tv" })]);
      assert.ok(JSON.stringify(data(details[0])).includes("Alice's winter mystery"));
      assert.ok(JSON.stringify(data(details[1])).includes("Bob's summer comedy"));
      for (const result of [...results, ...details]) {
        const rendered = JSON.stringify(result);
        assert.ok(!rendered.includes("fixture-session-") && !rendered.includes("fixture-secret-cookie") && !rendered.includes("upstreamToken"));
      }
      const mutationStart = fixtures.calls.length;
      const mutation = await call(worker, alice, "moodarr_record_feedback", { action: "right_mood", sessionId: "alice-recommendation-session", itemId: "shared-tv", clientEventId: "no-write-event" });
      assert.equal(mutation.isError, true, "Read OAuth scope cannot perform a valid feedback mutation.");
      const destinationOverride = await call(worker, alice, "moodarr_search", { ...args, instanceOrigin: "https://bob.example" });
      assert.equal(destinationOverride.isError, true);
      assert.equal(fixtures.calls.length, mutationStart, "Rejected authority and arguments make no upstream calls.");
    });

    await scenario("TV confirmation binds preview identity and seasons to one tenant and preserves explicit feedback", async () => {
      const [alice, bob] = await Promise.all([connect(worker, "alice", allScopes), connect(worker, "bob", allScopes)]);
      const preview = data(await call(worker, alice, "moodarr_preview_request", { itemId: "shared-tv", seasons: [1, 3] }));
      assert.equal(typeof preview.previewHandle, "string");
      const beforeWrongTenant = fixtures.calls.length;
      const crossed = await call(worker, bob, "moodarr_create_request", { previewHandle: preview.previewHandle, confirmed: true, idempotencyKey: "tv-season-contract" });
      assert.equal(crossed.isError, true);
      assert.equal(fixtures.calls.slice(beforeWrongTenant).filter((call) => call.path === "/api/requests/create").length, 0);
      const beforeUnconfirmed = fixtures.calls.length;
      const unconfirmed = await call(worker, alice, "moodarr_create_request", { previewHandle: preview.previewHandle, confirmed: false, idempotencyKey: "tv-season-contract" });
      assert.equal(unconfirmed.isError, true);
      assert.equal(fixtures.calls.length, beforeUnconfirmed);
      const beforeCreation = fixtures.calls.length;
      const created = data(await call(worker, alice, "moodarr_create_request", { previewHandle: preview.previewHandle, confirmed: true, idempotencyKey: "tv-season-contract" }));
      assert.equal(created.status, "created");
      const writes = fixtures.calls.slice(beforeCreation).filter((call) => call.path === "/api/requests/create");
      assert.equal(writes.length, 1, "Explicit creation causes exactly one outbound write.");
      assert.equal(writes[0].instanceId, "alice");
      assert.deepEqual(writes[0].body, {
        itemId: "shared-tv", mediaType: "tv", tmdbId: 9911, seasons: [1, 3], confirmed: true,
        confirmationPhrase: "REQUEST Alice's winter mystery", confirmationToken: "a".repeat(64)
      });
      assert.ok(writes[0].idempotencyKey && writes[0].idempotencyKey !== "tv-season-contract", "Idempotency is namespaced to authenticated identity.");
      const feedback = { action: "right_mood", sessionId: "alice-recommendation-session", itemId: "shared-tv", clientEventId: "worker-feedback-contract", watchContext: "group" };
      const recordedResult = data(await call(worker, alice, "moodarr_record_feedback", feedback));
      assert.equal(recordedResult.clientEventId, feedback.clientEventId);
      const recorded = fixtures.calls.filter((call) => call.path === "/api/feel-feedback").at(-1)!;
      assert.equal(recorded.body?.sessionId, feedback.sessionId);
      assert.ok(typeof recorded.body?.clientEventId === "string" && recorded.body.clientEventId !== feedback.clientEventId);
      data(await call(worker, alice, "moodarr_record_feedback", feedback));
      const retried = fixtures.calls.filter((call) => call.path === "/api/feel-feedback").at(-1)!;
      assert.equal(retried.body?.clientEventId, recorded.body?.clientEventId, "An explicit retry preserves the exact namespaced event identity.");
    });

    await scenario("upstream redirects, diagnostics and uncertain writes stay bounded and never auto-retry", async () => {
      const grant = await connect(worker, "alice", allScopes);
      const instance = fixtures.instances.get("alice")!;
      try {
        for (const failure of ["redirect", "malformed", "diagnostic"] as const) {
          instance.searchFailure = failure;
          const before = fixtures.calls.length;
          const result = await call(worker, grant, "moodarr_search", { query: "winter mystery" });
          assert.equal(result.isError, true);
          assert.equal(fixtures.calls.slice(before).filter((call) => call.path === "/api/search").length, 1);
          const rendered = JSON.stringify(result);
          assert.ok(!rendered.includes("fixture-session-") && !rendered.includes("fixture-secret-cookie") && !rendered.includes("Internal detail"));
        }
        assert.equal(fixtures.deniedDestinations.length, 0, "A redirect is rejected without following it.");
        instance.searchFailure = undefined;
        const preview = data(await call(worker, grant, "moodarr_preview_request", { itemId: "shared-tv", seasons: [1, 3] }));
        instance.creationFailure = "unknown";
        const beforeWrite = fixtures.calls.length;
        const unknown = await call(worker, grant, "moodarr_create_request", { previewHandle: preview.previewHandle, confirmed: true, idempotencyKey: "uncertain-contract" });
        assert.equal(unknown.isError, true);
        assert.equal(unknown.structuredContent.status, "uncertain", "Uncertain write is distinguishable from successful creation.");
        assert.equal(unknown.structuredContent.automaticRetryAllowed, false);
        assert.equal(fixtures.calls.slice(beforeWrite).filter((call) => call.path === "/api/requests/create").length, 1);
        instance.creationFailure = "blocked";
        const blocked = data(await call(worker, grant, "moodarr_preview_request", { itemId: "shared-tv", seasons: [1, 3] }));
        assert.equal(blocked.canRequest, false);
        assert.ok(!blocked.previewHandle, "Blocked preview cannot authorize creation.");
      } finally { instance.searchFailure = undefined; instance.creationFailure = undefined; }
      const beforeOversize = fixtures.calls.length;
      const oversized = await dispatch(worker, resource, {
        method: "POST", headers: { Authorization: `Bearer ${grant.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ padding: "x".repeat(65 * 1024) })
      });
      assert.equal(oversized.status, 413);
      assert.equal(fixtures.calls.length, beforeOversize);
    });

    await scenario("refresh narrows authority, revocation stops transport and disabled or expired users cannot reconnect", async () => {
      const grant = await connect(worker, "bob", allScopes);
      const refreshed = await json(await tokenRequest(worker, { grant_type: "refresh_token", client_id: grant.client.client_id, refresh_token: grant.refresh_token, resource, scope: readScope }));
      assert.ok(refreshed.access_token !== grant.access_token && refreshed.refresh_token !== grant.refresh_token);
      assert.equal(refreshed.scope, readScope);
      const narrowed: Grant = { ...grant, ...refreshed };
      data(await call(worker, narrowed, "moodarr_search", { query: "summer comedy" }));
      const beforeMutation = fixtures.calls.length;
      assert.equal((await call(worker, narrowed, "moodarr_add_to_watchlist", { itemId: "shared-tv" })).isError, true);
      assert.equal(fixtures.calls.length, beforeMutation);
      const metadata = await json(await dispatch(worker, `${publicOrigin}/.well-known/oauth-authorization-server`));
      assert.equal(typeof metadata.revocation_endpoint, "string");
      const revoked = await dispatch(worker, metadata.revocation_endpoint, {
        method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: narrowed.refresh_token, token_type_hint: "refresh_token", client_id: grant.client.client_id }).toString()
      });
      assert.equal(revoked.status, 200);
      const afterRevocation = await dispatch(worker, resource, {
        method: "POST", headers: { Authorization: `Bearer ${narrowed.access_token}`, "Content-Type": "application/json" }, body: "{}"
      });
      assert.equal(afterRevocation.status, 401);
      const active = await connect(worker, "alice");
      const instance = fixtures.instances.get("alice")!;
      try {
        instance.enabled = false;
        const disabled = await call(worker, active, "moodarr_search", { query: "winter mystery" });
        assert.equal(disabled.isError, true);
        instance.enabled = true;
        instance.expiredSession = true;
        const auth = await start(worker, "alice");
        const pending = await auth.browser.post(auth.continueForm);
        assert.equal(pending.status, 202);
        const failed = await auth.browser.post(form(await pending.text(), "/authorize/continue"));
        assert.ok(failed.status >= 400 && failed.status < 600, "Already-expired native session cannot mint an OAuth grant.");
        assert.equal(failed.headers.get("Location"), null);
      } finally { instance.enabled = true; instance.expiredSession = false; }
    });
  } finally {
    await worker.dispose();
    await mkdir(`${packageRoot}artifacts`, { recursive: true });
    await writeFile(`${packageRoot}artifacts/worker-http.json`, JSON.stringify({
      schemaVersion: 1, generatedAt: new Date().toISOString(), environment: "local workerd with synthetic HTTP upstreams",
      bundleSha256, command: "npm run build && npx tsx --test tests/worker-http.test.ts", cases,
      calls: fixtures.calls.map(({ instanceId, path, method, authorized, challengeCookieValid }) => ({ instanceId, path, method, authorized, challengeCookieValid })),
      deniedEgressCount: fixtures.deniedDestinations.length,
      limitations: ["No live Moodarr, Plex or Seerr service", "No Cloudflare deployment", "No ChatGPT acceptance proof"]
    }, null, 2) + "\n");
  }
});
