import { registerHooks } from "node:module";
import type { OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import type { Env } from "../src/env";
import { moodarrScopes } from "../src/types";

// The portable path uses object handlers, so it never constructs this runtime
// base. All OAuth parsing, storage, crypto and endpoint code remains real.
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export class WorkerEntrypoint {}", shortCircuit: true };
  return nextResolve(specifier, context);
} });
const { default: OAuthProvider, getOAuthApi, GrantType } = await import("@cloudflare/workers-oauth-provider");
const { AuthTransactionStore } = await import("../src/auth-state");
const { authHandler, tokenExchangeCallback } = await import("../src/auth");
export { tokenExchangeCallback, GrantType };

// Portable adapters exercise the actual HTTP handler and OAuth library. They do
// not establish Cloudflare KV consistency, alarms or Durable Object lifecycle.
export class MemoryKv {
  records = new Map<string, { value: string; metadata?: unknown; expires?: number }>();
  private heldRead?: { remaining: number; reached: () => void; gate: Promise<void> };
  holdGrantReads(count: number) {
    let release!: () => void, reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { reached = resolve; });
    this.heldRead = { remaining: count, reached, gate };
    return { ready, release };
  }
  async put(key: string, value: string, options?: { metadata?: unknown; expirationTtl?: number; expiration?: number }) {
    this.records.set(key, { value, metadata: options?.metadata, expires: options?.expiration ?? (options?.expirationTtl ? Date.now() / 1000 + options.expirationTtl : undefined) });
  }
  async get(key: string, type?: string | { type?: string }) {
    const row = this.records.get(key);
    if (!row || (row.expires && row.expires <= Date.now() / 1000)) return null;
    // Capture the current value before holding the read, as an eventual KV read
    // can return a stale snapshot even after another request writes or deletes.
    const hold = this.heldRead;
    if (key.startsWith("grant:") && hold && hold.remaining > 0) {
      if (--hold.remaining === 0) hold.reached();
      await hold.gate;
    }
    return (typeof type === "string" ? type : type?.type) === "json" ? JSON.parse(row.value) : row.value;
  }
  async delete(key: string) { this.records.delete(key); }
  async list(options?: { prefix?: string }) {
    return { keys: [...this.records].filter(([key]) => key.startsWith(options?.prefix ?? "")).map(([name, row]) => ({ name, metadata: row.metadata })), list_complete: true, cursor: "", cacheStatus: null };
  }
}

export class MemoryTransactions {
  stores = new Map<string, { data: Map<string, unknown>; object: InstanceType<typeof AuthTransactionStore>; queue: Promise<unknown> }>();
  alarms = new Map<string, number>();
  constructor(private env: () => Env) {}
  idFromName(name: string) { return name; }
  get(id: unknown) {
    const name = String(id);
    let entry = this.stores.get(name);
    if (!entry) {
      const data = new Map<string, unknown>();
      const storage = {
        get: async (key: string) => structuredClone(data.get(key)),
        put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); },
        delete: async (key: string) => data.delete(key),
        deleteAll: async () => { data.clear(); },
        setAlarm: async (timestamp: number) => { this.alarms.set(name, timestamp); },
        transaction: async (action: (store: unknown) => unknown) => action(storage)
      };
      entry = { data, object: new AuthTransactionStore({ storage } as unknown as DurableObjectState, this.env()), queue: Promise.resolve() };
      this.stores.set(name, entry);
    }
    const current = entry;
    // A deterministic serial queue models one object's request admission.
    return { fetch: (request: Request) => {
      const result = current.queue.then(() => current.object.fetch(request));
      current.queue = result.then(() => undefined, () => undefined);
      return result;
    } };
  }
}

export const brokerOrigin = "https://connect.moodarr.example";
export const instances = [{ id: "alpha", name: "Alpha catalog", origin: "https://alpha.moodarr.example" }, { id: "beta", name: "Beta catalog", origin: "https://beta.moodarr.example" }];
export const verifier = "A".repeat(43);
export const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

export async function fixture() {
  const kv = new MemoryKv();
  // This closure is called only after the environment has been initialized.
  const transactions = new MemoryTransactions(() => env);
  const env = { OAUTH_KV: kv as unknown as KVNamespace, AUTH_TRANSACTIONS: transactions as unknown as DurableObjectNamespace, PUBLIC_ORIGIN: brokerOrigin, INSTANCE_REGISTRY: JSON.stringify(instances), AUTH_SECRET: "synthetic-auth-secret-".repeat(3) } as Env;
  const options: OAuthProviderOptions<Env> = {
    apiRoute: "/mcp", apiHandler: { fetch: async (_req, _env, context) => Response.json(context.props) }, defaultHandler: authHandler,
    authorizeEndpoint: "/authorize", tokenEndpoint: "/token", clientRegistrationEndpoint: "/register",
    scopesSupported: [...moodarrScopes, "offline_access"], resourceMetadata: { resource: `${brokerOrigin}/mcp`, authorization_servers: [brokerOrigin] }, tokenExchangeCallback
  };
  const provider = new OAuthProvider(options);
  env.OAUTH_PROVIDER = getOAuthApi(options, env);
  const client = await env.OAUTH_PROVIDER.createClient({ clientName: "Synthetic assistant <script>", redirectUris: ["https://assistant.example/callback"], tokenEndpointAuthMethod: "none", grantTypes: ["authorization_code", "refresh_token"], responseTypes: ["code"] });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  const challenge = Buffer.from(digest).toString("base64url");
  const authorize = new URL(`${brokerOrigin}/authorize`);
  authorize.search = new URLSearchParams({ client_id: client.clientId, redirect_uri: client.redirectUris[0], response_type: "code", code_challenge: challenge, code_challenge_method: "S256", scope: "moodarr:read moodarr:requests", resource: `${brokerOrigin}/mcp`, state: "synthetic-client-state" }).toString();
  return { env, kv, transactions, provider, options, client, authorize, fetch: (request: Request) => provider.fetch(request, env, ctx) };
}

export async function lifecycleFixture() {
  const { executeTokenRequest, checkAccessGrant } = await import("../src/oauth-lifecycle");
  const f = await fixture();
  const fetchRequest = async (request: Request) => {
    const providerOptions: OAuthProviderOptions<Env> = { ...f.options, apiHandler: {
      fetch: async (_request, env, context) => {
        const token = (context as ExecutionContext & { auth: { token: string } }).auth.token;
        return await checkAccessGrant(env, token) ? Response.json(context.props) : Response.json({ error: "invalid_token" }, { status: 401 });
      }
    } };
    if (new URL(request.url).pathname !== "/token") return new OAuthProvider(providerOptions).fetch(request, f.env, ctx);
    return executeTokenRequest(request, f.env, capture => new OAuthProvider({ ...providerOptions, tokenExchangeCallback: async options => {
      const result = await tokenExchangeCallback(options);
      capture({ clientId: options.clientId, userId: options.userId, grantId: options.grantId });
      return result;
    } }).fetch(request, f.env, ctx));
  };
  return { ...f, fetch: fetchRequest };
}

export async function syntheticCode(f: Awaited<ReturnType<typeof fixture>>) {
  const request = await f.env.OAUTH_PROVIDER.parseAuthRequest(new Request(f.authorize));
  const { redirectTo } = await f.env.OAUTH_PROVIDER.completeAuthorization({ request, userId: "synthetic-subject", metadata: {}, scope: request.scope, props: {
    instanceId: "alpha", instanceOrigin: instances[0].origin, userId: "same-user", displayName: "Synthetic Viewer", sessionToken: "synthetic-native-session-secret", sessionExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(), scopes: ["moodarr:read", "moodarr:requests"]
  } });
  return { code: new URL(redirectTo).searchParams.get("code")!, fields: { grant_type: "authorization_code", client_id: f.client.clientId, redirect_uri: request.redirectUri, code: new URL(redirectTo).searchParams.get("code")!, code_verifier: verifier, resource: `${brokerOrigin}/mcp` } };
}
export function tokenRequest(fields: Record<string, string>) {
  return new Request(`${brokerOrigin}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
}

export function hidden(html: string, name: string) {
  const match = html.match(new RegExp(`name="${name}" value="([^"]*)"`));
  if (!match) throw new Error(`Missing form field ${name}`);
  return match[1].replace(/&amp;/g, "&");
}

export function cookie(response: Response) { return response.headers.get("set-cookie")!.split(";")[0]; }
export function post(path: string, body: Record<string, string>, browserCookie: string, origin = brokerOrigin) {
  return new Request(`${brokerOrigin}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: browserCookie }, body: new URLSearchParams(body) });
}

export function upstream(completion: Record<string, unknown> = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  let pending = true;
  return {
    calls, approve: () => { pending = false; }, reset: () => { pending = true; },
    fetch: async (url: string | URL | Request, init?: RequestInit) => {
      const address = String(url); calls.push({ url: address, init });
      const origin = new URL(address).origin;
      if (address.endsWith("/api/auth/plex/start")) return Response.json({ ok: true, pinId: "pin-123", code: "plex-pin-secret", authUrl: `https://app.plex.tv/auth#?code=plex-pin-secret&forwardUrl=${encodeURIComponent(origin)}`, expiresAt: new Date(Date.now() + 240_000).toISOString() }, { headers: { "set-cookie": "moodarr_plex_auth_state=challenge-secret; Path=/api/auth/plex; HttpOnly; SameSite=Strict; Max-Age=240; Secure" } });
      if (address.endsWith("/api/auth/plex/complete")) {
        if (pending) return Response.json({ authenticated: false, pending: true }, { status: 202 });
        return Response.json({ authenticated: true, user: { id: "same-user", provider: "plex", enabled: true, displayName: "Synthetic Viewer" }, sessionToken: `session-secret-${new URL(origin).hostname}`, sessionExpiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(), ...completion });
      }
      throw new Error("Unexpected synthetic request");
    }
  };
}

export async function openConsent(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await f.fetch(new Request(f.authorize));
  const html = await response.text();
  return { response, html, csrf: hidden(html, "csrf"), intent: hidden(html, "intent"), browserCookie: cookie(response) };
}

export async function startPairing(f: Awaited<ReturnType<typeof fixture>>, instance = "alpha") {
  const consent = await openConsent(f);
  const response = await f.fetch(post("/authorize/start", { intent: consent.intent, csrf: consent.csrf, instance }, consent.browserCookie));
  const html = await response.text();
  return { ...consent, response, html, transaction: hidden(html, "transaction") };
}
