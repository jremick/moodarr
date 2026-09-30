import { authorizationErrorRedirect, AuthorizationError, CimdFetchError, OAuthError, type AuthRequest, type ConsentDescription, type TokenExchangeCallbackOptions, type TokenExchangeCallbackResult } from "@cloudflare/workers-oauth-provider";
import { configuredInstances, configuredOrigin, resolveInstance, validateConnection } from "./config.js";
import { hash, protect, randomSecret, unprotect, type AuthPhase } from "./auth-state.js";
import type { Env } from "./env.js";
import { moodarrScopes, type MoodarrConnection, type MoodarrInstance } from "./types.js";

const lifetimeMs = 300_000;
const maximumNativeSessionMs = 30 * 86_400_000;
const permissionLabels: Record<string, string> = {
  "moodarr:read": "Search and view the library",
  "moodarr:feedback": "Record feedback and preferences",
  "moodarr:requests": "Preview and create media requests after confirmation",
  "moodarr:watchlist": "Add titles to your Plex Watchlist",
  "offline_access": "Keep this connection until your Moodarr session expires"
};
interface Transaction {
  id: string;
  browserHash: string;
  csrfHash: string;
  expiresAt: number;
  request: AuthRequest;
  client: ConsentDescription;
  instance?: MoodarrInstance;
  plex?: { pinId: string; code: string; cookie: string; authUrl: string };
  connection?: MoodarrConnection;
}
class FlowError extends Error {
  constructor(readonly status = 400, readonly publicMessage = "This authorization is invalid, expired or already used. Start again from your assistant.") { super(publicMessage); }
}
const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
const fields = (transaction: string, csrf: string) => `<input type="hidden" name="transaction" value="${escape(transaction)}"><input type="hidden" name="csrf" value="${escape(csrf)}">`;

function page(title: string, content: string, status = 200, cookie?: string): Response {
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-content-type-options": "nosniff", "x-frame-options": "DENY",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
  });
  if (cookie) headers.set("set-cookie", cookie);
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Moodarr</title><style>:root{color-scheme:light;--bg:#fbf6ee;--panel:#fffdf8;--ink:#2f3d3a;--muted:#576862;--line:#eadfd1;--accent:#4a7d75;font-family:"Avenir Next",system-ui,sans-serif;color:var(--ink);background:var(--bg)}*{box-sizing:border-box}body{margin:0;padding:36px 16px}main{max-width:640px;margin:auto;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:28px;box-shadow:0 18px 46px #5b4b3714}h1{font-size:26px;margin-top:12px}p,li{line-height:1.55}small{color:var(--muted)}label{display:block;font-weight:650;margin-top:20px}select,input[type=url]{width:100%;padding:12px;border:1px solid var(--line);background:var(--bg);border-radius:8px;color:var(--ink);margin:8px 0}button,.button{display:inline-block;padding:12px 16px;background:var(--accent);color:white;border:0;border-radius:8px;font:inherit;font-weight:650;text-decoration:none;cursor:pointer;margin:12px 8px 0 0}.secondary{background:#e9f0ec;color:var(--ink)}a{color:var(--accent);overflow-wrap:anywhere}.detail{padding:14px;border:1px solid var(--line);border-radius:10px;background:#f4eee6;overflow-wrap:anywhere}ul{padding-left:20px}:focus-visible{outline:3px solid #bf7f70;outline-offset:3px}</style></head><body><main><small>MOODARR · SCREENING DESK</small><h1>${escape(title)}</h1>${content}</main></body></html>`, { status, headers });
}
function clientSummary(transaction: Transaction): string {
  const { client, request } = transaction;
  const publisher = client.clientDomain ? `<p>Published by <strong>${escape(client.clientDomain)}</strong>.</p>` : "<p>This client registered its own name. Its name is not verified.</p>";
  return `<div class="detail"><p>Client: <strong>${escape(client.clientName)}</strong></p>${publisher}<p>Access returns to <strong>${escape(new URL(request.redirectUri).origin)}</strong>.</p>${client.redirectIsLoopback ? "<p>This connects to an app on your computer. Continue only if you started this sign-in.</p>" : ""}<p>Requested permissions:</p><ul>${request.scope.map(scope => `<li>${escape(permissionLabels[scope] ?? scope)}</li>`).join("")}</ul></div>`;
}
function pairingPage(transaction: Transaction, csrf: string, pending = false): Response {
  return page(pending ? "Waiting for Plex approval" : "Sign in with Plex", `${clientSummary(transaction)}<p>Connect <strong>${escape(transaction.instance!.name)}</strong> at ${escape(transaction.instance!.origin)}.</p><p>Open Plex in a new tab, approve sign-in, then return here and select Continue. This pairing expires within five minutes.</p><p><a class="button" href="${escape(transaction.plex!.authUrl)}" target="_blank" rel="noopener noreferrer">Open Plex sign-in</a></p><form method="post" action="/authorize/continue">${fields(transaction.id, csrf)}<button>Continue</button></form>`, pending ? 202 : 200);
}
function finalPage(transaction: Transaction, csrf: string): Response {
  return page("Allow this connection?", `${clientSummary(transaction)}<p>Signed in as <strong>${escape(transaction.connection!.displayName)}</strong>.</p><p>Instance: <strong>${escape(transaction.instance!.name)}</strong><br>${escape(transaction.instance!.origin)}</p><p>The assistant will use this Moodarr user account with the listed permissions. Moodarr still controls media request permissions.</p><form method="post" action="/authorize/approve">${fields(transaction.id, csrf)}<button name="decision" value="approve">Allow connection</button><button class="secondary" name="decision" value="deny">Deny</button></form>`);
}
function cookieName(id: string): string { return `__Host-moodarr-auth-${id}`; }
function browserCookie(request: Request, id: string): string {
  const key = `${cookieName(id)}=`;
  return (request.headers.get("cookie") ?? "").split(";").map(value => value.trim()).find(value => value.startsWith(key))?.slice(key.length) ?? "";
}
function cookieValue(id: string, nonce = "", maxAge = 300): string { return `${cookieName(id)}=${nonce}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`; }

async function boundedText(source: Request | Response, maximum: number, signal?: AbortSignal): Promise<string> {
  if (Number(source.headers.get("content-length")) > maximum) throw new Error("Body limit exceeded.");
  if (!source.body) return "";
  const reader = source.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error("Request timed out."));
    if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximum) throw new Error("Body limit exceeded.");
      chunks.push(part.value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { if (onAbort) signal?.removeEventListener("abort", onAbort); reader.releaseLock(); }
}
async function formBody(request: Request, origin: string): Promise<URLSearchParams> {
  if (request.headers.get("origin") !== origin || !request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) throw new FlowError();
  try {
    const form = new URLSearchParams(await boundedText(request, 16_384, AbortSignal.timeout(5000)));
    if ([...form.keys()].some(key => form.getAll(key).length !== 1)) throw new FlowError();
    return form;
  } catch { throw new FlowError(); }
}
async function verifyBrowser(request: Request, transaction: Transaction, csrf: string): Promise<void> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(transaction.id) || transaction.expiresAt <= Date.now()
    || transaction.browserHash !== await hash(browserCookie(request, transaction.id))
    || transaction.csrfHash !== await hash(csrf)) throw new FlowError();
}
async function store(env: Env, id: string, action: string, input: Record<string, unknown>): Promise<string> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(id)) throw new FlowError();
  const stub = env.AUTH_TRANSACTIONS.get(env.AUTH_TRANSACTIONS.idFromName(id));
  const response = await stub.fetch(new Request(`https://transaction.internal/${action}`, { method: "POST", body: JSON.stringify(input) }));
  if (!response.ok) throw new FlowError();
  return (await response.json() as { ciphertext: string }).ciphertext;
}
async function claim(env: Env, request: Request, form: URLSearchParams, expectedPhase: AuthPhase, nextPhase: AuthPhase): Promise<Transaction> {
  const id = form.get("transaction") ?? "";
  const ciphertext = await store(env, id, "claim", { browserHash: await hash(browserCookie(request, id)), csrfHash: await hash(form.get("csrf") ?? ""), expectedPhase, nextPhase });
  const transaction = await unprotect<Transaction>(ciphertext, env.AUTH_SECRET);
  await verifyBrowser(request, transaction, form.get("csrf") ?? "");
  const registered = resolveInstance(env, transaction.instance!.id);
  if (registered.origin !== transaction.instance!.origin) throw new FlowError();
  return transaction;
}
async function save(env: Env, transaction: Transaction, expectedPhase: AuthPhase, phase: AuthPhase): Promise<void> {
  await store(env, transaction.id, "save", { browserHash: transaction.browserHash, csrfHash: transaction.csrfHash, expectedPhase, phase, ciphertext: await protect(transaction, env.AUTH_SECRET) });
}
async function consume(env: Env, transaction: Transaction, expectedPhase: AuthPhase): Promise<void> {
  await store(env, transaction.id, "consume", { browserHash: transaction.browserHash, csrfHash: transaction.csrfHash, expectedPhase });
}
async function upstreamJson(instance: MoodarrInstance, path: "/api/auth/plex/start" | "/api/auth/plex/complete", body: unknown, cookie?: string): Promise<{ response: Response; data: Record<string, unknown> }> {
  const signal = AbortSignal.timeout(15_000);
  try {
    const response = await fetch(`${instance.origin}${path}`, { method: "POST", redirect: "manual", signal, headers: { "content-type": "application/json", "accept": "application/json", "origin": instance.origin, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
    if (!response.ok || (response.status !== 200 && response.status !== 202)) throw new Error("Upstream sign-in failed.");
    const data: unknown = JSON.parse(await boundedText(response, 65_536, signal));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid upstream response.");
    return { response, data: data as Record<string, unknown> };
  } catch { throw new FlowError(502, "Moodarr could not complete sign-in. Start again or check that Plex sign-in is enabled on this instance."); }
}
function string(value: unknown, maximum: number): string {
  if (typeof value !== "string" || !value.length || value.length > maximum || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new FlowError(502, "Moodarr returned an invalid sign-in response. Start again.");
  return value;
}
function parsePin(data: Record<string, unknown>, response: Response, instance: MoodarrInstance): Transaction["plex"] & { expiresAt: number } {
  const pinId = string(data.pinId, 80), code = string(data.code, 40);
  const url = new URL(string(data.authUrl, 4096));
  const fragment = new URLSearchParams(url.hash.replace(/^#\??/, ""));
  const forward = new URL(fragment.get("forwardUrl") ?? "");
  if (url.origin !== "https://app.plex.tv" || url.pathname !== "/auth" || url.search || url.username || url.password
    || fragment.get("code") !== code || fragment.getAll("code").length !== 1 || fragment.getAll("forwardUrl").length !== 1
    || forward.origin !== instance.origin || forward.username || forward.password || forward.search || forward.hash) throw new FlowError(502, "Moodarr returned an invalid Plex sign-in link. Start again.");
  const match = response.headers.get("set-cookie")?.match(/(?:^|,\s*)moodarr_plex_auth_state=([A-Za-z0-9._~%+-]{1,512})(?:;|$)/);
  // Moodarr bounds its challenge even when Plex omits the optional PIN expiry.
  // The caller also clamps this fallback to the original browser transaction.
  const expiresAt = data.expiresAt === undefined ? Date.now() + lifetimeMs : Date.parse(string(data.expiresAt, 80));
  if (!match || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new FlowError(502, "Moodarr returned an invalid sign-in challenge. Start again.");
  return { pinId, code, cookie: `moodarr_plex_auth_state=${match[1]}`, authUrl: url.toString(), expiresAt };
}
function parseConnection(data: Record<string, unknown>, transaction: Transaction): MoodarrConnection {
  const user = data.user as Record<string, unknown> | undefined;
  const sessionToken = string(data.sessionToken, 4096);
  const expiresAt = Date.parse(string(data.sessionExpiresAt, 80));
  if (data.authenticated !== true || !user || user.provider !== "plex" || user.enabled !== true
    || sessionToken.length < 20 || !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60_000 || expiresAt > Date.now() + maximumNativeSessionMs + 5000) throw new FlowError(502, "Moodarr returned an invalid user session. Start again.");
  return { instanceId: transaction.instance!.id, instanceOrigin: transaction.instance!.origin, userId: string(user.id, 240), displayName: string(user.displayName ?? user.username ?? user.id, 240), sessionToken, sessionExpiresAt: new Date(expiresAt).toISOString(), scopes: transaction.request.scope.filter(scope => scope !== "offline_access") as MoodarrConnection["scopes"] };
}

export const authHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const origin = configuredOrigin(env), url = new URL(request.url);
      if (url.origin !== origin) throw new FlowError();
      if (url.pathname === "/authorize" && request.method === "GET") {
        if (url.toString().length > 8192 || [...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1)) throw new FlowError();
        const authRequest = await env.OAUTH_PROVIDER.parseAuthRequest(request);
        if (url.searchParams.get("resource") !== `${origin}/mcp` || authRequest.resource !== `${origin}/mcp`
          || authRequest.responseType !== "code" || authRequest.codeChallengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(authRequest.codeChallenge ?? "")
          || !authRequest.scope.includes("moodarr:read") || authRequest.scope.some(scope => scope !== "offline_access" && !(moodarrScopes as readonly string[]).includes(scope)) || new Set(authRequest.scope).size !== authRequest.scope.length) throw new FlowError();
        const nonce = randomSecret(), csrf = randomSecret();
        const transaction: Transaction = { id: randomSecret(), browserHash: await hash(nonce), csrfHash: await hash(csrf), expiresAt: Date.now() + lifetimeMs, request: authRequest, client: await env.OAUTH_PROVIDER.describeConsent(authRequest) };
        const instances = configuredInstances(env);
        const intent = await protect(transaction, env.AUTH_SECRET);
        return page("Connect your Moodarr instance", `${clientSummary(transaction)}<p>Choose your public HTTPS Moodarr instance. This service uses Plex to sign in to your Moodarr user account.</p><form method="post" action="/authorize/start"><input type="hidden" name="intent" value="${escape(intent)}"><input type="hidden" name="csrf" value="${escape(csrf)}"><label for="instance">Moodarr instance</label><select id="instance" name="instance">${instances.map(instance => `<option value="${escape(instance.id)}">${escape(instance.name)} — ${escape(instance.origin)}</option>`).join("")}</select><button>Continue to Plex sign-in</button></form><p><small>Only instances registered by this service operator can connect. Cloudflare can host this service; your Moodarr instance can use any public HTTPS host.</small></p>`, 200, cookieValue(transaction.id, nonce));
      }
      if (request.method !== "POST" || !["/authorize/start", "/authorize/continue", "/authorize/approve"].includes(url.pathname)) return page("Page unavailable", "<p>Start this connection from your assistant.</p>", 404);
      const form = await formBody(request, origin), csrf = form.get("csrf") ?? "";
      if (url.pathname === "/authorize/start") {
        let transaction: Transaction;
        try { transaction = await unprotect<Transaction>(form.get("intent") ?? "", env.AUTH_SECRET); }
        catch { throw new FlowError(); }
        await verifyBrowser(request, transaction, csrf);
        try { transaction.instance = resolveInstance(env, form.get("instance") ?? ""); }
        catch { throw new FlowError(); }
        await store(env, transaction.id, "create", { browserHash: transaction.browserHash, csrfHash: transaction.csrfHash, expiresAt: transaction.expiresAt, phase: "starting", ciphertext: await protect(transaction, env.AUTH_SECRET) });
        try {
          const { response, data } = await upstreamJson(transaction.instance, "/api/auth/plex/start", {});
          if (response.status !== 200) throw new FlowError(502, "Moodarr could not start Plex sign-in. Start again.");
          const pin = parsePin(data, response, transaction.instance);
          transaction.expiresAt = Math.min(transaction.expiresAt, pin.expiresAt);
          transaction.plex = { pinId: pin.pinId, code: pin.code, cookie: pin.cookie, authUrl: pin.authUrl };
          await save(env, transaction, "starting", "pairing");
          return pairingPage(transaction, csrf);
        } catch (error) {
          await consume(env, transaction, "starting");
          if (error instanceof FlowError) throw error;
          throw new FlowError(502, "Moodarr returned an invalid sign-in response. Start again.");
        }
      }
      if (url.pathname === "/authorize/continue") {
        const transaction = await claim(env, request, form, "pairing", "checking");
        try {
          const { response, data } = await upstreamJson(transaction.instance!, "/api/auth/plex/complete", { pinId: transaction.plex!.pinId, code: transaction.plex!.code, nativeSession: true }, transaction.plex!.cookie);
          if (response.status === 202 && data.authenticated === false && data.pending === true) {
            await save(env, transaction, "checking", "pairing");
            return pairingPage(transaction, csrf, true);
          }
          if (response.status !== 200) throw new FlowError(502, "Moodarr returned an invalid sign-in response. Start again.");
          transaction.connection = parseConnection(data, transaction);
          delete transaction.plex;
          await save(env, transaction, "checking", "consent");
          return finalPage(transaction, csrf);
        } catch (error) { await consume(env, transaction, "checking"); throw error; }
      }
      const transaction = await claim(env, request, form, "consent", "finishing");
      await consume(env, transaction, "finishing");
      let redirectTo: string;
      if (form.get("decision") === "deny") redirectTo = authorizationErrorRedirect(transaction.request, "access_denied");
      else if (form.get("decision") === "approve") {
        const connection = validateConnection(env, transaction.connection);
        const subject = await hash(JSON.stringify([connection.instanceId, connection.instanceOrigin, connection.userId]));
        ({ redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({ request: transaction.request, userId: subject, metadata: { instanceId: connection.instanceId, instanceOrigin: connection.instanceOrigin, userId: connection.userId }, scope: transaction.request.scope, props: connection }));
      } else throw new FlowError();
      return new Response(null, { status: 302, headers: { location: redirectTo, "cache-control": "no-store", "referrer-policy": "no-referrer", "set-cookie": cookieValue(transaction.id, "", 0) } });
    } catch (error) {
      if (error instanceof FlowError) return page("Connection could not complete", `<p>${escape(error.publicMessage)}</p>`, error.status);
      // Client-supplied metadata, diagnostics and credentials never reach this page.
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) return page("Connection could not complete", "<p>This sign-in request could not be verified. Start again from your assistant.</p>", 400);
      return page("Sign-in is temporarily unavailable", "<p>This service could not complete sign-in. Start again from your assistant.</p>", 503);
    }
  }
};

/** Refreshing the broker credential cannot refresh Moodarr's fixed native session. */
export async function tokenExchangeCallback(options: TokenExchangeCallbackOptions<Env>): Promise<TokenExchangeCallbackResult> {
  try {
    const connection = validateConnection(options.env, options.props);
    const remaining = Math.floor((Date.parse(connection.sessionExpiresAt) - Date.now()) / 1000) - 1;
    if (options.resource !== `${configuredOrigin(options.env)}/mcp` || remaining < 60
      || options.requestedScope.some(scope => scope !== "offline_access" && !connection.scopes.includes(scope as MoodarrConnection["scopes"][number]))) throw new Error("Invalid grant.");
    return { accessTokenTTL: Math.min(900, remaining), refreshTokenTTL: remaining };
  } catch { throw new OAuthError("invalid_grant", { description: "Reconnect this Moodarr instance to continue." }); }
}
