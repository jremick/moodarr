import type { Env } from "./env.js";
import { digest } from "./moodarr.js";
import type { MoodarrConnection, RequestConfirmationBinding, RequestConfirmationStore, RequestConfirmationTarget } from "./types.js";

const maximumLifetimeMs = 10 * 60_000;
const transactionPattern = /^[A-Za-z0-9_-]{43}$/;
const cookiePrefix = "__Host-moodarr-confirm-";
const encoder = new TextEncoder();

type ConfirmationState = "pending" | "approved" | "claimed";
interface StoredConfirmation {
  version: 1;
  binding: RequestConfirmationBinding;
  request: RequestConfirmationTarget;
  expiresAt: number;
  state: ConfirmationState;
  csrfHash?: string;
  idempotencyKey?: string;
}
interface ConfirmationPrincipal extends RequestConfirmationBinding {
  version: 1;
  expiresAt: number;
}

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 8192) throw new Error("Invalid confirmation state.");
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), character => character.charCodeAt(0));
}
function randomSecret(): string { return encode(crypto.getRandomValues(new Uint8Array(32))); }
async function hash(value: string): Promise<string> {
  return encode(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value))));
}
async function principalKey(secret: string): Promise<CryptoKey> {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("Request confirmation is not configured.");
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(`moodarr-request-confirmation\n${secret}`));
  return crypto.subtle.importKey("raw", material, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function protectPrincipal(value: ConfirmationPrincipal, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv,
    additionalData: encoder.encode("moodarr-request-confirmation-principal-v1") }, await principalKey(secret), encoder.encode(JSON.stringify(value)));
  return `${encode(iv)}.${encode(new Uint8Array(encrypted))}`;
}
async function unprotectPrincipal(value: string, secret: string): Promise<ConfirmationPrincipal> {
  const parts = value.split(".");
  if (parts.length !== 2) throw new Error("Invalid confirmation principal.");
  const iv = decode(parts[0]!);
  if (iv.byteLength !== 12) throw new Error("Invalid confirmation principal.");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv,
    additionalData: encoder.encode("moodarr-request-confirmation-principal-v1") }, await principalKey(secret), decode(parts[1]!));
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)) as ConfirmationPrincipal;
}

function cookieName(sessionDigest: string): string { return `${cookiePrefix}${sessionDigest.slice(0, 24)}`; }
function cookieValue(request: Request, name: string): string {
  const prefix = `${name}=`;
  return (request.headers.get("cookie") ?? "").split(";").map(value => value.trim()).find(value => value.startsWith(prefix))?.slice(prefix.length) ?? "";
}
function sameBinding(first: RequestConfirmationBinding, second: RequestConfirmationBinding): boolean {
  return first.instanceId === second.instanceId && first.instanceOrigin === second.instanceOrigin
    && first.userId === second.userId && first.sessionDigest === second.sessionDigest;
}
function sameRequest(first: Omit<RequestConfirmationTarget, "title" | "confirmationPhrase" | "confirmationToken">,
  second: RequestConfirmationTarget): boolean {
  const seasons = (values?: number[]) => [...new Set(values ?? [])].sort((a, b) => a - b).join(",");
  return first.itemId === second.itemId && first.mediaType === second.mediaType && first.tmdbId === second.tmdbId
    && seasons(first.seasons) === seasons(second.seasons);
}
function validBinding(value: unknown): value is RequestConfirmationBinding {
  if (!value || typeof value !== "object") return false;
  const binding = value as Record<string, unknown>;
  return typeof binding.instanceId === "string" && binding.instanceId.length > 0 && binding.instanceId.length <= 200
    && typeof binding.instanceOrigin === "string" && binding.instanceOrigin.length > 0 && binding.instanceOrigin.length <= 2000
    && typeof binding.userId === "string" && binding.userId.length > 0 && binding.userId.length <= 240
    && typeof binding.sessionDigest === "string" && /^[0-9a-f]{64}$/.test(binding.sessionDigest);
}
function validRequest(value: unknown): value is RequestConfirmationTarget {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  const seasons = request.seasons;
  return typeof request.itemId === "string" && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,239}$/.test(request.itemId)
    && (request.mediaType === "movie" || request.mediaType === "tv")
    && typeof request.tmdbId === "number" && Number.isInteger(request.tmdbId) && request.tmdbId > 0
    && (seasons === undefined || (Array.isArray(seasons) && seasons.length > 0 && seasons.length <= 100
      && seasons.every(season => typeof season === "number" && Number.isInteger(season) && season >= 1 && season <= 1000)))
    && typeof request.title === "string" && request.title.length > 0 && request.title.length <= 300
    && typeof request.confirmationPhrase === "string" && request.confirmationPhrase.length > 0 && request.confirmationPhrase.length <= 500
    && typeof request.confirmationToken === "string" && /^[0-9a-f]{64}$/.test(request.confirmationToken);
}
function validRequestClaim(value: unknown): value is Omit<RequestConfirmationTarget, "title" | "confirmationPhrase" | "confirmationToken"> {
  if (!value || typeof value !== "object") return false;
  const request = value as Record<string, unknown>;
  const seasons = request.seasons;
  return typeof request.itemId === "string" && /^[A-Za-z0-9][A-Za-z0-9:_-]{0,239}$/.test(request.itemId)
    && (request.mediaType === "movie" || request.mediaType === "tv")
    && typeof request.tmdbId === "number" && Number.isInteger(request.tmdbId) && request.tmdbId > 0
    && (seasons === undefined || (Array.isArray(seasons) && seasons.length > 0 && seasons.length <= 100
      && seasons.every(season => typeof season === "number" && Number.isInteger(season) && season >= 1 && season <= 1000)));
}
function validStored(value: unknown): value is StoredConfirmation {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<StoredConfirmation>;
  return record.version === 1 && validBinding(record.binding) && validRequest(record.request)
    && typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt)
    && (record.state === "pending" || record.state === "approved" || record.state === "claimed")
    && (record.csrfHash === undefined || /^[A-Za-z0-9_-]{43}$/.test(record.csrfHash))
    && (record.idempotencyKey === undefined || /^[0-9a-f]{64}$/.test(record.idempotencyKey))
    && (record.state === "claimed" ? record.idempotencyKey !== undefined : record.idempotencyKey === undefined);
}

async function objectRequest(env: Env, id: string, action: string, input: unknown = {}): Promise<Response> {
  if (!transactionPattern.test(id)) return Response.json({ error: "invalid_confirmation" }, { status: 400 });
  const stub = env.AUTH_TRANSACTIONS.get(env.AUTH_TRANSACTIONS.idFromName(`request-confirmation:${id}`));
  return stub.fetch(new Request(`https://transaction.internal/confirmation/${action}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input)
  }));
}

export function createRequestConfirmationStore(env: Env, publicOrigin: string): RequestConfirmationStore {
  return {
    async prepare(input) {
      const confirmationId = randomSecret();
      const response = await objectRequest(env, confirmationId, "create", input);
      if (!response.ok) throw new Error("Request confirmation could not be prepared.");
      return { confirmationId, confirmationUrl: `${publicOrigin}/confirm?transaction=${encodeURIComponent(confirmationId)}` };
    },
    async consume(input) {
      const response = await objectRequest(env, input.confirmationId, "consume", input);
      const data = await response.json() as Record<string, unknown>;
      if (response.status === 409 && data.error === "confirmation_required") return { status: "pending" };
      if (!response.ok) return { status: "invalid" };
      if (data.status !== "approved" || typeof data.confirmationPhrase !== "string"
        || typeof data.confirmationToken !== "string" || !/^[0-9a-f]{64}$/.test(data.confirmationToken)) {
        throw new Error("Request confirmation returned invalid authority.");
      }
      return { status: "approved", confirmationPhrase: data.confirmationPhrase, confirmationToken: data.confirmationToken };
    }
  };
}

export async function requestConfirmationCookie(connection: MoodarrConnection, secret: string): Promise<string> {
  const sessionDigest = await digest(connection.sessionToken);
  const expiresAt = Date.parse(connection.sessionExpiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) throw new Error("The confirmation principal is expired.");
  const principal: ConfirmationPrincipal = { version: 1, instanceId: connection.instanceId,
    instanceOrigin: connection.instanceOrigin, userId: connection.userId, sessionDigest, expiresAt };
  const protectedValue = await protectPrincipal(principal, secret);
  const maxAge = Math.max(1, Math.floor((expiresAt - Date.now()) / 1000));
  // Lax permits the cross-site top-level link from an MCP host; POST still requires the page's CSRF challenge and exact Origin.
  return `${cookieName(sessionDigest)}=${protectedValue}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

async function verifiedPrincipal(request: Request, binding: RequestConfirmationBinding, secret: string): Promise<boolean> {
  try {
    const principal = await unprotectPrincipal(cookieValue(request, cookieName(binding.sessionDigest)), secret);
    return principal.version === 1 && principal.expiresAt > Date.now() && sameBinding(principal, binding);
  } catch { return false; }
}

const escape = (value: string) => value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
function page(title: string, content: string, status = 200): Response {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Moodarr</title><style>:root{color-scheme:light;--bg:#fbf6ee;--panel:#fffdf8;--ink:#2f3d3a;--muted:#576862;--line:#eadfd1;--accent:#4a7d75;font-family:"Avenir Next",system-ui,sans-serif;color:var(--ink);background:var(--bg)}*{box-sizing:border-box}body{margin:0;padding:36px 16px}main{max-width:640px;margin:auto;background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:28px;box-shadow:0 18px 46px #5b4b3714}h1{font-size:26px;margin-top:12px}p,dt,dd{line-height:1.55}small{color:var(--muted)}dl{padding:14px;border:1px solid var(--line);border-radius:10px;background:#f4eee6}dl div{display:grid;grid-template-columns:130px 1fr;gap:12px}dt{color:var(--muted)}dd{margin:0;font-weight:650;overflow-wrap:anywhere}button{padding:12px 16px;background:var(--accent);color:white;border:0;border-radius:8px;font:inherit;font-weight:650;cursor:pointer;margin-top:12px}button:focus-visible{outline:3px solid #bf7f70;outline-offset:3px}</style></head><body><main><small>MOODARR · SCREENING DESK</small><h1>${escape(title)}</h1>${content}</main></body></html>`, {
    status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "strict-origin",
      "x-content-type-options": "nosniff", "x-frame-options": "DENY",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" }
  });
}

async function description(env: Env, id: string): Promise<(Pick<StoredConfirmation, "binding" | "expiresAt" | "state"> & {
  request: Pick<RequestConfirmationTarget, "title" | "mediaType" | "seasons">;
}) | null> {
  const response = await objectRequest(env, id, "describe");
  if (!response.ok) return null;
  const value = await response.json() as StoredConfirmation;
  if (!validBinding(value.binding) || typeof value.expiresAt !== "number" || value.expiresAt <= Date.now()
    || !["pending", "approved", "claimed"].includes(value.state) || !value.request || typeof value.request.title !== "string"
    || (value.request.mediaType !== "movie" && value.request.mediaType !== "tv")) return null;
  return value;
}

/** Trusted browser channel. Tool callers know the URL but cannot mint its HttpOnly principal or CSRF challenge. */
export async function handleRequestConfirmation(request: Request, env: Env, publicOrigin: string): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/confirm") return null;
  if (request.method === "GET") {
    if ([...url.searchParams.keys()].some(key => key !== "transaction" || url.searchParams.getAll(key).length !== 1)) {
      return page("Confirmation unavailable", "<p>This request confirmation link is invalid. Ask for a fresh preview.</p>", 400);
    }
    const id = url.searchParams.get("transaction") ?? "";
    const record = await description(env, id);
    if (!record) return page("Confirmation unavailable", "<p>This request confirmation has expired or is invalid. Ask for a fresh preview.</p>", 404);
    if (!await verifiedPrincipal(request, record.binding, env.AUTH_SECRET)) {
      return page("Sign-in required", "<p>Open this link in the browser used to connect Moodarr, or reconnect and request a fresh preview.</p>", 403);
    }
    if (record.state !== "pending") {
      return page(record.state === "approved" ? "Request already approved" : "Request confirmation already used",
        `<p>${record.state === "approved" ? "Return to the Moodarr card to submit this approved request." : "This confirmation has already been submitted. Do not send another request."}</p>`);
    }
    const challenge = await objectRequest(env, id, "challenge");
    if (!challenge.ok) return page("Confirmation unavailable", "<p>This request can no longer be approved. Ask for a fresh preview.</p>", 409);
    const { csrf } = await challenge.json() as { csrf?: unknown };
    if (typeof csrf !== "string" || !transactionPattern.test(csrf)) return page("Confirmation unavailable", "<p>Request confirmation is temporarily unavailable.</p>", 503);
    const selection = record.request.mediaType === "tv" ? (record.request.seasons?.join(", ") ?? "No seasons selected") : "Movie";
    return page("Approve this media request", `<p>Confirm the exact target below. Approval is valid only for this connected Moodarr session and expires shortly.</p><dl><div><dt>Title</dt><dd>${escape(record.request.title)}</dd></div><div><dt>Type</dt><dd>${record.request.mediaType === "tv" ? "TV series" : "Movie"}</dd></div>${record.request.mediaType === "tv" ? `<div><dt>Selected seasons</dt><dd>${escape(selection)}</dd></div>` : ""}</dl><form method="post" action="/confirm"><input type="hidden" name="transaction" value="${escape(id)}"><input type="hidden" name="csrf" value="${escape(csrf)}"><button name="decision" value="approve">Approve this request</button></form><p><small>Closing this page without approving leaves the request blocked.</small></p>`);
  }
  if (request.method !== "POST" || request.headers.get("origin") !== publicOrigin
    || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") {
    return page("Confirmation unavailable", "<p>This request confirmation could not be verified.</p>", 400);
  }
  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await request.text());
    if ([...form.keys()].some(key => !["transaction", "csrf", "decision"].includes(key) || form.getAll(key).length !== 1)) throw new Error();
  } catch { return page("Confirmation unavailable", "<p>This request confirmation could not be verified.</p>", 400); }
  const id = form.get("transaction") ?? "";
  const record = await description(env, id);
  if (!record || !await verifiedPrincipal(request, record.binding, env.AUTH_SECRET) || form.get("decision") !== "approve") {
    return page("Confirmation unavailable", "<p>This request confirmation is invalid, expired, or belongs to another session.</p>", 403);
  }
  const approved = await objectRequest(env, id, "approve", { csrf: form.get("csrf") ?? "" });
  if (!approved.ok) return page("Confirmation unavailable", "<p>This request could not be approved. Ask for a fresh preview.</p>", 409);
  return page("Request approved", "<p>Return to the Moodarr card and choose <strong>Confirm request</strong>. Only this exact title and season selection can be submitted, once.</p>");
}

/** Private Durable Object protocol for one exact approval transaction. */
export async function handleRequestConfirmationStore(request: Request, storage: DurableObjectStorage): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const action = new URL(request.url).pathname.replace("/confirmation/", "");
  const input = await request.json() as Record<string, unknown>;
  let alarm: number | undefined;
  const response = await storage.transaction(async transaction => {
    const current = await transaction.get<StoredConfirmation>("confirmation");
    if (action === "create") {
      if (current || !validBinding(input.binding) || !validRequest(input.request)
        || typeof input.expiresAt !== "number" || !Number.isFinite(input.expiresAt)
        || input.expiresAt <= Date.now() || input.expiresAt > Date.now() + maximumLifetimeMs) {
        return Response.json({ error: "invalid_confirmation" }, { status: 400 });
      }
      const record: StoredConfirmation = { version: 1, binding: input.binding, request: input.request,
        expiresAt: input.expiresAt, state: "pending" };
      await transaction.put("confirmation", record);
      alarm = record.expiresAt;
      return Response.json({ ok: true });
    }
    if (!validStored(current) || current.expiresAt <= Date.now()) {
      return Response.json({ error: "invalid_confirmation" }, { status: 410 });
    }
    if (action === "describe") {
      return Response.json({ binding: current.binding, expiresAt: current.expiresAt, state: current.state,
        request: { title: current.request.title, mediaType: current.request.mediaType, seasons: current.request.seasons } });
    }
    if (action === "challenge") {
      if (current.state !== "pending") return Response.json({ error: "invalid_confirmation" }, { status: 409 });
      const csrf = randomSecret();
      await transaction.put("confirmation", { ...current, csrfHash: await hash(csrf) });
      return Response.json({ csrf });
    }
    if (action === "approve") {
      if (current.state !== "pending" || !current.csrfHash || typeof input.csrf !== "string"
        || current.csrfHash !== await hash(input.csrf)) return Response.json({ error: "invalid_confirmation" }, { status: 409 });
      const approved = { ...current, state: "approved" as const };
      delete approved.csrfHash;
      await transaction.put("confirmation", approved);
      return Response.json({ ok: true });
    }
    if (action !== "consume" || !validBinding(input.binding) || !validRequestClaim(input.request)
      || !sameBinding(current.binding, input.binding) || !sameRequest(input.request, current.request)
      || typeof input.idempotencyKey !== "string" || !/^[0-9a-f]{64}$/.test(input.idempotencyKey)) {
      return Response.json({ error: "invalid_confirmation" }, { status: 400 });
    }
    if (current.state === "pending") return Response.json({ error: "confirmation_required" }, { status: 409 });
    if (current.state === "claimed" && current.idempotencyKey !== input.idempotencyKey) {
      return Response.json({ error: "confirmation_already_used" }, { status: 409 });
    }
    if (current.state === "approved") {
      await transaction.put("confirmation", { ...current, state: "claimed", idempotencyKey: input.idempotencyKey });
    }
    return Response.json({ status: "approved", confirmationPhrase: current.request.confirmationPhrase,
      confirmationToken: current.request.confirmationToken });
  });
  if (alarm !== undefined) await storage.setAlarm(alarm);
  return response;
}
