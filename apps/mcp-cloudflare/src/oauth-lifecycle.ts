import type { Env } from "./env.js";
import { hash, randomSecret } from "./auth-state.js";

export interface TrustedGrant { clientId: string; userId: string; grantId: string }
type OperationKind = "code" | "refresh" | "revoke";
interface Operation extends TrustedGrant { kind: OperationKind; tokenHash: string }
interface Receipt { clientId: string; kind: "access" | "refresh"; expiresAt: number; revoked?: boolean }
interface Family {
  expiresAt: number;
  issued: boolean;
  codeUsed?: boolean;
  revoked?: boolean;
  uncertain?: boolean;
  identity?: TrustedGrant;
  active?: { nonce: string; operation: Operation };
}
const maximumFamilyMs = 31 * 86_400_000;
const rejected = () => Response.json({ error: "invalid_grant", error_description: "Reconnect this Moodarr instance." }, { status: 400, headers: { "cache-control": "no-store" } });
const unavailable = () => Response.json({ error: "temporarily_unavailable", error_description: "Reconnect this Moodarr instance or try again later." }, { status: 503, headers: { "cache-control": "no-store" } });

function identity(token: string): Pick<TrustedGrant, "userId" | "grantId"> | null {
  const parts = token.split(":");
  if (parts.length !== 3 || !parts[0] || parts[0].length > 240 || !/^[A-Za-z0-9_-]{16}$/.test(parts[1]) || !/^[A-Za-z0-9_-]{32}$/.test(parts[2])) return null;
  return { userId: parts[0], grantId: parts[1] };
}
async function actor(env: Env, grant: Pick<TrustedGrant, "userId" | "grantId">): Promise<DurableObjectStub> {
  return env.AUTH_TRANSACTIONS.get(env.AUTH_TRANSACTIONS.idFromName(`oauth:${await hash(JSON.stringify([grant.userId, grant.grantId]))}`));
}
function sameGrant(first: Pick<TrustedGrant, "userId" | "grantId">, second: Pick<TrustedGrant, "userId" | "grantId">): boolean {
  return first.userId === second.userId && first.grantId === second.grantId;
}
async function command(stub: DurableObjectStub, action: string, input: unknown): Promise<Response> {
  return stub.fetch(new Request(`https://transaction.internal/lifecycle/${action}`, { method: "POST", body: JSON.stringify(input) }));
}

/** Derive only the presented client identity; the provider still authenticates it. */
function presentedClient(request: Request, form: URLSearchParams): string | null {
  const header = request.headers.get("authorization");
  if (!header) return form.get("client_id");
  const end = header.search(/[ \t]/);
  if ((end === -1 ? header : header.slice(0, end)).toLowerCase() !== "basic") return form.get("client_id");
  if (end === -1 || form.has("client_id") || form.has("client_secret")) return null;
  const encoded = header.slice(end).trim();
  if (!encoded || /[ \t]/.test(encoded)) return null;
  try {
    const credentials = atob(encoded), separator = credentials.indexOf(":");
    if (separator === -1) return null;
    // The provider rejects invalid encoding in either credential component.
    decodeURIComponent(credentials.slice(separator + 1).replace(/\+/g, " "));
    return decodeURIComponent(credentials.slice(0, separator).replace(/\+/g, " "));
  } catch { return null; }
}
async function describeOperation(request: Request): Promise<Operation | null> {
  if (request.method !== "POST" || request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") return null;
  const text = await request.clone().text();
  if (new TextEncoder().encode(text).length > 65_536) throw new Error("Token request limit exceeded.");
  const form = new URLSearchParams(text);
  if ([...form.keys()].some(key => key !== "resource" && form.getAll(key).length !== 1)) return null;
  const clientId = presentedClient(request, form);
  if (!clientId || clientId.length > 2048) return null;
  const grantType = form.get("grant_type");
  const kind: OperationKind | undefined = grantType === "authorization_code" ? "code" : grantType === "refresh_token" ? "refresh" : !grantType && form.has("token") ? "revoke" : undefined;
  if (!kind) return null;
  const token = form.get(kind === "code" ? "code" : kind === "refresh" ? "refresh_token" : "token") ?? "";
  const grant = identity(token);
  return grant ? { ...grant, clientId, kind, tokenHash: await hash(token) } : null;
}

/**
 * Keep grant mutation behind one atomic admission. No token leaves this method
 * until its digest is recorded. Ambiguous provider outcomes require reconnect.
 */
export async function executeTokenRequest(request: Request, env: Env, invoke: (captureGrant: (grant: TrustedGrant) => void) => Promise<Response>): Promise<Response> {
  const operation = await describeOperation(request);
  if (!operation) {
    // Invalid/unsupported requests remain provider-owned, but parser divergence
    // must never let an unexpected issuance bypass its receipt.
    try { return await invoke(() => { throw new Error("Token issuance has no lifecycle admission."); }); }
    catch { return unavailable(); }
  }
  const stub = await actor(env, operation);
  const begun = await command(stub, "begin", operation);
  if (!begun.ok) return begun;
  const { nonce } = await begun.json() as { nonce: string };
  let captured: TrustedGrant | undefined;
  let response: Response;
  try {
    response = await invoke(grant => {
      if (!sameGrant(grant, operation) || grant.clientId !== operation.clientId) throw new Error("Token grant identity mismatch.");
      captured = { clientId: grant.clientId, userId: grant.userId, grantId: grant.grantId };
    });
  } catch {
    await command(stub, "uncertain", { nonce });
    return unavailable();
  }
  if (response.status === 429 || response.status >= 500) {
    await command(stub, "uncertain", { nonce });
    return response;
  }
  if (response.status >= 400 && response.status < 500) {
    const finished = await command(stub, "release", { nonce });
    if (!finished.ok) throw new Error("OAuth admission could not be released.");
    return response;
  }
  if (response.status !== 200) {
    await command(stub, "uncertain", { nonce });
    return unavailable();
  }
  let finish: Record<string, unknown> = { nonce };
  try {
    if (operation.kind !== "revoke") {
      if (!captured) throw new Error("Token issuance was not verified.");
      const issued = await response.clone().json() as Record<string, unknown>;
      const access = typeof issued.access_token === "string" ? identity(issued.access_token) : null;
      const refresh = typeof issued.refresh_token === "string" ? identity(issued.refresh_token) : null;
      if (!access || !sameGrant(access, captured) || (issued.refresh_token !== undefined && (!refresh || !sameGrant(refresh, captured)))
        || typeof issued.expires_in !== "number" || !Number.isInteger(issued.expires_in) || issued.expires_in < 60 || issued.expires_in > 900) throw new Error("Invalid issued token response.");
      finish = { nonce, identity: captured, accessHash: await hash(issued.access_token as string), accessExpiresAt: Date.now() + issued.expires_in * 1000,
        ...(refresh ? { refreshHash: await hash(issued.refresh_token as string) } : {}) };
    }
    const finished = await command(stub, "finish", finish);
    if (!finished.ok) throw new Error("Token lifecycle outcome could not be recorded.");
    return response;
  } catch {
    await command(stub, "uncertain", { nonce });
    return unavailable();
  }
}

/** Call after the provider verified the token. Storage failures must remain 503. */
export async function checkAccessGrant(env: Env, token: string): Promise<boolean> {
  const grant = identity(token);
  if (!grant) return false;
  const response = await command(await actor(env, grant), "check", { tokenHash: await hash(token) });
  if (!response.ok) throw new Error("OAuth lifecycle state is unavailable.");
  return (await response.json() as { allowed: boolean }).allowed;
}

/** Private Durable Object protocol. No credential is stored or returned here. */
export async function handleLifecycleRequest(request: Request, storage: DurableObjectStorage): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  const path = new URL(request.url).pathname;
  const input = await request.json() as Operation & { nonce?: string; identity?: TrustedGrant; accessHash?: string; accessExpiresAt?: number; refreshHash?: string };
  let alarm: number | undefined;
  const response = await storage.transaction(async transaction => {
    const withAlarm = async (result: Response) => {
      if (alarm !== undefined) await transaction.setAlarm(alarm);
      return result;
    };
    let family = await transaction.get<Family>("family");
    if (path === "/lifecycle/check") {
      if (family?.uncertain) return unavailable();
      const receipt = await transaction.get<Receipt>(`receipt:${input.tokenHash}`);
      return Response.json({ allowed: !!family && family.expiresAt > Date.now() && !family.revoked && !!receipt && receipt.kind === "access" && !receipt.revoked && receipt.expiresAt > Date.now() });
    }
    if (path === "/lifecycle/begin") {
      if (!validOperation(input)) return rejected();
      if (family && family.expiresAt <= Date.now()) return rejected();
      if (family?.uncertain || family?.active) return input.kind === "code" ? rejected() : Response.json({ error: "temporarily_unavailable" }, { status: 429, headers: { "retry-after": "1", "cache-control": "no-store" } });
      if ((family?.revoked && input.kind !== "revoke") || (family?.codeUsed && input.kind === "code")) return rejected();
      const nonce = randomSecret();
      family ??= { issued: false, expiresAt: Date.now() + maximumFamilyMs };
      // Initial pending/uncertain writes cannot unlock after a short lease.
      if (!family.issued) { family.expiresAt = Date.now() + maximumFamilyMs; alarm = family.expiresAt; }
      await transaction.put("family", { ...family, active: { nonce, operation: input } });
      return withAlarm(Response.json({ nonce }));
    }
    if (!family?.active || family.active.nonce !== input.nonce) return rejected();
    if (path === "/lifecycle/uncertain") {
      await transaction.put("family", { ...family, uncertain: true });
      return Response.json({ ok: true });
    }
    if (path === "/lifecycle/release") {
      delete family.active;
      if (!family.issued) { family.expiresAt = Date.now() + 600_000; alarm = family.expiresAt; }
      await transaction.put("family", family);
      return withAlarm(Response.json({ ok: true }));
    }
    if (path !== "/lifecycle/finish") return rejected();
    const operation = family.active.operation;
    if (operation.kind === "revoke") {
      const receipt = await transaction.get<Receipt>(`receipt:${operation.tokenHash}`);
      // HTTP200 alone is not authority: provider no-ops unknown/wrong-client tokens.
      if (receipt && receipt.clientId === operation.clientId && receipt.expiresAt > Date.now()) {
        if (receipt.kind === "refresh") family.revoked = true;
        else await transaction.put(`receipt:${operation.tokenHash}`, { ...receipt, revoked: true });
      }
    } else {
      if (!input.identity || !sameGrant(input.identity, operation) || input.identity.clientId !== operation.clientId
        || (family.identity && (!sameGrant(input.identity, family.identity) || family.identity.clientId !== input.identity.clientId))
        || !digest(input.accessHash) || typeof input.accessExpiresAt !== "number" || !Number.isFinite(input.accessExpiresAt) || input.accessExpiresAt <= Date.now()
        || input.accessExpiresAt > Date.now() + 900_000 || (input.refreshHash !== undefined && !digest(input.refreshHash))) return rejected();
      if (!family.issued) { family.expiresAt = Date.now() + maximumFamilyMs; alarm = family.expiresAt; }
      family.issued = true;
      family.identity = input.identity;
      if (operation.kind === "code") family.codeUsed = true;
      await transaction.put(`receipt:${input.accessHash}`, { clientId: input.identity.clientId, kind: "access", expiresAt: input.accessExpiresAt } satisfies Receipt);
      if (input.refreshHash) await transaction.put(`receipt:${input.refreshHash}`, { clientId: input.identity.clientId, kind: "refresh", expiresAt: family.expiresAt } satisfies Receipt);
    }
    delete family.active;
    if (!family.issued) { family.expiresAt = Date.now() + 600_000; alarm = family.expiresAt; }
    await transaction.put("family", family);
    return withAlarm(Response.json({ ok: true }));
  });
  return response;
}
function digest(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value); }
function validOperation(value: Operation): boolean {
  return ["code", "refresh", "revoke"].includes(value.kind) && digest(value.tokenHash) && typeof value.userId === "string" && value.userId.length > 0 && value.userId.length <= 240
    && typeof value.grantId === "string" && /^[A-Za-z0-9_-]{16}$/.test(value.grantId) && typeof value.clientId === "string" && value.clientId.length > 0 && value.clientId.length <= 2048;
}
