import type { MoodarrConnection, MoodarrScope } from "./types.js";

const maximumResponseBytes = 1024 * 1024;
const encoder = new TextEncoder();

export class MoodarrFault extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus?: number, readonly uncertain = false) {
    super(message);
  }
}

export function immutableConnection(input: MoodarrConnection): Readonly<MoodarrConnection> {
  const origin = new URL(input.instanceOrigin);
  const host = origin.hostname.toLowerCase();
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
    || !host.includes(".") || host.includes(":") || /^\d+(\.\d+){3}$/.test(host)
    || /(?:^|\.)(?:localhost|local|internal|home|home\.arpa)$/.test(host)) {
    throw new Error("Moodarr requires a registered public HTTPS origin without a path or credentials.");
  }
  if (!input.sessionToken || /\s/.test(input.sessionToken) || input.sessionToken.length > 4096 || !input.userId || !input.instanceId) {
    throw new Error("Moodarr connection credentials are invalid.");
  }
  const copy = { ...input, instanceOrigin: origin.origin, scopes: [...input.scopes] };
  Object.freeze(copy.scopes);
  return Object.freeze(copy);
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(new DOMException("Moodarr request timed out.", "AbortError"));
    if (signal.aborted) return aborted();
    signal.addEventListener("abort", aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", aborted));
  });
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number(declaredLength) > maximumResponseBytes) {
    await response.body?.cancel();
    throw new MoodarrFault("invalid_response", "Moodarr returned an oversized response.");
  }
  if (!/^application\/(?:[a-z0-9.-]+\+)?json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
    await response.body?.cancel();
    throw new MoodarrFault("invalid_response", "Moodarr did not return JSON. Check the instance access boundary.");
  }
  if (!response.body) throw new MoodarrFault("invalid_response", "Moodarr returned an empty response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await abortable(reader.read(), signal);
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maximumResponseBytes) throw new MoodarrFault("invalid_response", "Moodarr returned an oversized response.");
      chunks.push(part.value);
    }
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new MoodarrFault("invalid_response", "Moodarr returned invalid JSON."); }
}

/** Fixed-origin, bounded native-user-session client. It never retries a request. */
export class MoodarrClient {
  readonly connection: Readonly<MoodarrConnection>;
  private readonly fetcher: typeof fetch;
  private readonly sessionDigest: Promise<string>;

  constructor(connection: MoodarrConnection, fetcher: typeof fetch = fetch) {
    this.connection = immutableConnection(connection);
    this.fetcher = fetcher;
    this.sessionDigest = digest(this.connection.sessionToken);
  }

  async authorize(scope: MoodarrScope) {
    if (!this.connection.scopes.includes(scope)) throw new MoodarrFault("insufficient_scope", "This connection does not allow this action.", 403);
    const expiry = Date.parse(this.connection.sessionExpiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new MoodarrFault("reconnect_required", "Reconnect Moodarr because its user session has expired.", 401);
    const response = await this.request("/api/auth/session");
    const data = response.data as { authenticated?: unknown; user?: { id?: unknown; enabled?: unknown } } | null;
    if (!data || data.authenticated !== true || data.user?.id !== this.connection.userId || data.user.enabled !== true) {
      throw new MoodarrFault("reconnect_required", "The connected Moodarr user is no longer authenticated. Reconnect this instance.", 401);
    }
  }

  async namespace(clientId: string) {
    return digest(`${this.connection.instanceId}\n${this.connection.instanceOrigin}\n${this.connection.userId}\n${await this.sessionDigest}\n${clientId}`);
  }

  async connectionDigest() { return this.sessionDigest; }

  async request(path: string, options: { body?: unknown; idempotencyKey?: string; allowConflict?: boolean; mutation?: boolean } = {}) {
    if (!/^\/api\/(?:auth\/session|search|library\/stats|feel-feedback|requests\/(?:preview|create)|plex\/watchlist|items\/[A-Za-z0-9%:_-]+)$/.test(path)) {
      throw new MoodarrFault("invalid_request", "Moodarr API path is invalid.");
    }
    const signal = AbortSignal.timeout(path === "/api/search" ? 60_000 : 30_000);
    const headers = new Headers({ Accept: "application/json", Authorization: `Bearer ${this.connection.sessionToken}` });
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    if (options.idempotencyKey) headers.set("Idempotency-Key", options.idempotencyKey);
    let response: Response;
    try {
      const fetcher = this.fetcher;
      response = await abortable(fetcher(`${this.connection.instanceOrigin}${path}`, {
        method: options.body === undefined ? "GET" : "POST", headers, redirect: "manual", signal,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) })
      }), signal);
    } catch {
      throw new MoodarrFault("connection_failed", options.mutation
        ? "Moodarr did not confirm this write. Verify its outcome before retrying; no automatic retry was sent."
        : "Moodarr could not be reached within the request deadline.", undefined, options.mutation);
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      void response.body?.cancel();
      throw new MoodarrFault("redirect_rejected", "Moodarr redirected the request. Check the registered instance origin.", response.status, options.mutation);
    }
    let data: unknown;
    try { data = await boundedJson(response, signal); }
    catch (error) {
      throw new MoodarrFault("invalid_response", error instanceof MoodarrFault ? error.message : "Moodarr did not return a complete response.", response.status, options.mutation);
    }
    if (!response.ok && !(options.allowConflict && response.status === 409)) {
      const code = response.status === 401 ? "reconnect_required" : response.status === 403 ? "permission_denied" : response.status === 429 ? "rate_limited" : "upstream_error";
      const message = response.status === 401 ? "Reconnect the Moodarr user session." : response.status === 403 ? "Moodarr denied this action for the connected user."
        : response.status === 429 ? "Moodarr's rate limit was reached. Wait before trying again." : "Moodarr could not complete this action.";
      throw new MoodarrFault(code, message, response.status, Boolean(options.mutation && response.status >= 500));
    }
    return { status: response.status, data };
  }

  redact<T>(value: T): T {
    const scrub = (item: unknown): unknown => {
      if (typeof item === "string") return item.split(this.connection.sessionToken).join("[redacted]");
      if (Array.isArray(item)) return item.map(scrub);
      if (item && typeof item === "object") return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, scrub(entry)]));
      return item;
    };
    return scrub(value) as T;
  }
}

export async function digest(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function encodeBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64Url(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
