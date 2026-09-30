import type { Env } from "./env.js";
import { handleLifecycleRequest } from "./oauth-lifecycle.js";

export type AuthPhase = "starting" | "pairing" | "checking" | "consent" | "finishing" | "complete";
interface StoredTransaction {
  ciphertext: string;
  browserHash: string;
  csrfHash: string;
  expiresAt: number;
  phase: AuthPhase;
}

/** One Durable Object per random transaction. Claims precede all upstream writes. */
export class AuthTransactionStore {
  constructor(private readonly state: DurableObjectState, env: Env) { void env; }

  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/lifecycle/")) return handleLifecycleRequest(request, this.state.storage);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const input = await request.json() as StoredTransaction & { expectedPhase?: AuthPhase; nextPhase?: AuthPhase };
    const path = new URL(request.url).pathname;
    const result = await this.state.storage.transaction(async (storage) => {
      const current = await storage.get<StoredTransaction>("transaction");
      if (path === "/create") {
        if (current || !validRecord(input) || input.phase !== "starting") return null;
        await storage.put("transaction", input);
        return input;
      }
      if (!current || current.expiresAt <= Date.now() || current.phase === "complete"
        || current.browserHash !== input.browserHash || current.csrfHash !== input.csrfHash
        || current.phase !== input.expectedPhase) return null;
      if (path === "/claim" && input.nextPhase) {
        await storage.put("transaction", { ...current, phase: input.nextPhase });
        return current;
      }
      if (path === "/save" && input.ciphertext && input.phase) {
        const saved = { ...current, ciphertext: input.ciphertext, phase: input.phase };
        await storage.put("transaction", saved);
        return saved;
      }
      if (path === "/consume") {
        await storage.put("transaction", { ...current, ciphertext: "", phase: "complete" });
        return current;
      }
      return null;
    });
    if (!result) return Response.json({ error: "invalid_transaction" }, { status: 400 });
    if (path === "/create") await this.state.storage.setAlarm(result.expiresAt);
    return Response.json({ ciphertext: result.ciphertext });
  }

  async alarm(): Promise<void> { await this.state.storage.deleteAll(); }
}

function validRecord(value: StoredTransaction): boolean {
  return typeof value.ciphertext === "string" && value.ciphertext.length > 0 && value.ciphertext.length <= 32_768
    && /^[A-Za-z0-9_-]{43}$/.test(value.browserHash) && /^[A-Za-z0-9_-]{43}$/.test(value.csrfHash)
    && Number.isFinite(value.expiresAt) && value.expiresAt > Date.now() && value.expiresAt <= Date.now() + 300_000;
}

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function decode(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 32_768) throw new Error("Invalid protected state.");
  return Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), character => character.charCodeAt(0));
}
export function randomSecret(): string { return encode(crypto.getRandomValues(new Uint8Array(32))); }
export async function hash(value: string): Promise<string> {
  return encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}
async function stateKey(secret: string): Promise<CryptoKey> {
  if (typeof secret !== "string" || secret.length < 32) throw new Error("Authorization is not configured.");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}
export async function protect(value: unknown, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode("moodarr-auth-v1") }, await stateKey(secret), new TextEncoder().encode(JSON.stringify(value)));
  return `${encode(iv)}.${encode(new Uint8Array(encrypted))}`;
}
export async function unprotect<T>(value: string, secret: string): Promise<T> {
  const parts = value.split(".");
  if (parts.length !== 2) throw new Error("Invalid protected state.");
  const iv = decode(parts[0]);
  if (iv.byteLength !== 12) throw new Error("Invalid protected state.");
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: new TextEncoder().encode("moodarr-auth-v1") }, await stateKey(secret), decode(parts[1]));
  return JSON.parse(new TextDecoder().decode(plain)) as T;
}
