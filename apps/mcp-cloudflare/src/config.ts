import { z } from "zod";
import { moodarrScopes, type MoodarrConnection, type MoodarrInstance } from "./types.js";

const instanceSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  name: z.string().trim().min(1).max(100),
  origin: z.string().min(1).max(2048)
}).strict();

const connectionSchema = z.object({
  instanceId: z.string().min(1).max(64),
  instanceOrigin: z.string().max(2048),
  userId: z.string().min(1).max(240),
  displayName: z.string().min(1).max(240),
  sessionToken: z.string().min(20).max(4096),
  sessionExpiresAt: z.string().max(80),
  scopes: z.array(z.enum(moodarrScopes)).min(1).max(moodarrScopes.length)
}).strict();

function canonicalOrigin(value: string, allowLoopback = false): string {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Use the origin only, without credentials, a path, query or fragment.");
  }
  const host = url.hostname.toLowerCase();
  if (allowLoopback && url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(host)) {
    return url.origin;
  }
  if (url.protocol !== "https:" || !host.includes(".") || host.endsWith(".")
    || /^[\d.]+$/.test(host) || host.includes(":")
    || /(?:^|\.)(?:localhost|local|internal|lan|home\.arpa)$/.test(host)) {
    throw new Error("Use a registered public HTTPS hostname.");
  }
  return url.origin;
}

export function configuredOrigin(env: { PUBLIC_ORIGIN: string }): string {
  return canonicalOrigin(env.PUBLIC_ORIGIN, true);
}

/** Registration is a trust decision. Syntax checks alone do not prevent DNS rebinding. */
export function configuredInstances(env: { INSTANCE_REGISTRY: string }): MoodarrInstance[] {
  if (typeof env.INSTANCE_REGISTRY !== "string" || env.INSTANCE_REGISTRY.length > 64 * 1024) {
    throw new Error("The instance registry is not configured.");
  }
  const entries = z.array(instanceSchema).min(1).max(100).parse(JSON.parse(env.INSTANCE_REGISTRY));
  const ids = new Set<string>();
  const origins = new Set<string>();
  return entries.map((entry) => {
    const origin = canonicalOrigin(entry.origin);
    if (ids.has(entry.id) || origins.has(origin)) throw new Error("Instance identities must be unique.");
    ids.add(entry.id);
    origins.add(origin);
    return { ...entry, origin };
  });
}

export function resolveInstance(env: { INSTANCE_REGISTRY: string }, idOrOrigin: string): MoodarrInstance {
  const candidates = configuredInstances(env);
  const idMatch = candidates.find((instance) => instance.id === idOrOrigin);
  if (idMatch) return idMatch;
  const origin = canonicalOrigin(idOrOrigin);
  const match = candidates.find((instance) => instance.origin === origin);
  if (!match) throw new Error("This instance is not registered with this MCP service.");
  return match;
}

/** Recheck stored grants against current operator policy on every authenticated request. */
export function validateConnection(env: { INSTANCE_REGISTRY: string }, props: unknown): MoodarrConnection {
  const connection = connectionSchema.parse(props);
  const instance = resolveInstance(env, connection.instanceId);
  const expiry = Date.parse(connection.sessionExpiresAt);
  if (instance.origin !== connection.instanceOrigin || !Number.isFinite(expiry) || expiry <= Date.now()
    || !connection.scopes.includes("moodarr:read")) {
    throw new Error("Reconnect this Moodarr instance to continue.");
  }
  return connection;
}
