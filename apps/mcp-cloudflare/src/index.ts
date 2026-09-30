import OAuthProvider, { type OAuthResourceContext } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";
import { authHandler, tokenExchangeCallback } from "./auth.js";
import { configuredInstances, configuredOrigin, validateConnection } from "./config.js";
import type { Env } from "./env.js";
import { checkAccessGrant, executeTokenRequest, type TrustedGrant } from "./oauth-lifecycle.js";
import { createMoodarrServer } from "./tools.js";
import { moodarrScopes } from "./types.js";
import type { MoodarrConnection } from "./types.js";

export { AuthTransactionStore } from "./auth-state.js";

const maxRequestBytes = 64 * 1024;
const allowedClientOrigins = new Set(["https://chatgpt.com", "https://chat.openai.com"]);

function reconnect(origin: string): Response {
  return Response.json({ error: "invalid_token", error_description: "Reconnect your Moodarr instance." }, {
    status: 401,
    headers: { "WWW-Authenticate": `Bearer error="invalid_token", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }
  });
}

function provider(origin: string, captureGrant?: (grant: TrustedGrant) => void): OAuthProvider<Env> {
  return new OAuthProvider<Env>({
    apiRoute: `${origin}/mcp`,
    apiHandler: {
      async fetch(request, serviceEnv, ctx) {
        let connection: MoodarrConnection;
        const auth = (ctx as OAuthResourceContext<unknown>).auth;
        try {
          connection = validateConnection(serviceEnv, ctx.props);
          if (!auth || !auth.clientId || !auth.token || auth.audience !== `${origin}/mcp` || !Array.isArray(auth.scope)
            || !auth.scope.every((scope) => typeof scope === "string")) throw new Error("Invalid OAuth context.");
          // The pinned provider exposes verified scopes on ctx.auth. Agents'
          // newer implicit context bridge is not provided by this release.
          connection.scopes = connection.scopes.filter((scope) => auth.scope.includes(scope));
        } catch {
          return reconnect(origin);
        }
        if (!await checkAccessGrant(serviceEnv, auth.token)) return reconnect(origin);
        return createMcpHandler(() => createMoodarrServer(connection, { previewSecret: serviceEnv.AUTH_SECRET }), {
          route: "/mcp",
          allowedHostnames: [new URL(origin).hostname],
          allowedOriginHostnames: [new URL(origin).hostname, "chatgpt.com", "chat.openai.com"],
          corsOptions: false
        }).fetch(request, { authInfo: {
          token: auth.token, clientId: auth.clientId!, scopes: [...auth.scope],
          resource: new URL(auth.audience), expiresAt: auth.expiresAt
        } });
      }
    },
    defaultHandler: authHandler,
    authorizeEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/token`,
    clientRegistrationEndpoint: `${origin}/register`,
    accessTokenTTL: 15 * 60,
    refreshTokenTTL: 30 * 24 * 60 * 60,
    clientRegistrationTTL: 30 * 24 * 60 * 60,
    scopesSupported: [...moodarrScopes],
    requiredScopes: ["moodarr:read"],
    resourceMetadata: {
      resource: `${origin}/mcp`,
      authorization_servers: [origin],
      resource_name: "Moodarr"
    },
    clientIdMetadataDocumentEnabled: false,
    allowTokenExchangeGrant: false,
    tokenExchangeCallback: async (options) => {
      const result = await tokenExchangeCallback(options);
      captureGrant?.({ clientId: options.clientId, userId: options.userId, grantId: options.grantId });
      return result;
    },
    onError: (error) => Response.json({ error: error.code, error_description: "OAuth request could not be completed." }, {
      status: error.status, headers: error.headers
    })
  });
}

async function boundedRequest(request: Request): Promise<Request> {
  if (!request.body) return request;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxRequestBytes) {
        await reader.cancel();
        throw new Error("request_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return new Request(request, { body });
}

function responseHeaders(response: Response, requestOrigin: string | null): Response {
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "no-referrer");
  if (requestOrigin) {
    headers.set("Access-Control-Allow-Origin", requestOrigin);
    headers.append("Vary", "Origin");
    headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id");
    headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    headers.set("Access-Control-Expose-Headers", "WWW-Authenticate, MCP-Protocol-Version, MCP-Session-Id");
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    let origin: string;
    try {
      origin = configuredOrigin(env);
      configuredInstances(env);
      if (!env.AUTH_SECRET || env.AUTH_SECRET.length < 32 || !env.REQUEST_LIMITER) throw new Error("configuration");
    } catch {
      return responseHeaders(Response.json({ error: "Service configuration is incomplete." }, { status: 503 }), null);
    }
    const url = new URL(request.url);
    if (url.origin !== origin) return responseHeaders(Response.json({ error: "Unexpected service origin." }, { status: 421 }), null);
    const browserOrigin = request.headers.get("Origin");
    if (browserOrigin && browserOrigin !== origin && !allowedClientOrigins.has(browserOrigin)) {
      return responseHeaders(Response.json({ error: "Origin is not allowed." }, { status: 403 }), null);
    }
    try {
      const bucket = url.pathname === "/mcp" ? "mcp" : "auth";
      const address = request.headers.get("CF-Connecting-IP") ?? "unknown";
      if (!(await env.REQUEST_LIMITER.limit({ key: `${origin}:${bucket}:${address}` })).success) {
        return responseHeaders(Response.json({ error: "Too many requests. Try again shortly." }, { status: 429, headers: { "Retry-After": "60" } }), browserOrigin);
      }
      if (request.method === "OPTIONS") return responseHeaders(new Response(null, { status: 204 }), browserOrigin);
      if (request.method === "GET" && url.pathname === "/health") {
        return responseHeaders(Response.json({ ok: true, service: "moodarr-mcp", version: "0.1.0" }), browserOrigin);
      }
      if (request.method === "GET" && url.pathname === "/") {
        return responseHeaders(Response.json({
          name: "Moodarr MCP", endpoint: `${origin}/mcp`, authentication: "OAuth 2.1 with Plex sign-in",
          instanceRequirement: "A registered, publicly reachable HTTPS Moodarr API, hosted by any provider."
        }), browserOrigin);
      }
      let bounded: Request;
      try { bounded = await boundedRequest(request); }
      catch { return responseHeaders(Response.json({ error: "Request body exceeds the allowed limit." }, { status: 413 }), browserOrigin); }
      const response = url.pathname === "/token" && request.method === "POST"
        ? await executeTokenRequest(bounded, env, (capture) => provider(origin, capture).fetch(bounded, env, ctx))
        : await provider(origin).fetch(bounded, env, ctx);
      return responseHeaders(response, browserOrigin);
    } catch {
      return responseHeaders(Response.json({ error: "Request could not be completed. Please try again." }, { status: 503 }), browserOrigin);
    }
  }
} satisfies ExportedHandler<Env>;
