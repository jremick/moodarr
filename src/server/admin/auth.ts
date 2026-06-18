import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config";

export const adminSessionCookieName = "moodarr_admin_session";

export function requireAdmin(config: AppConfig, request: FastifyRequest, reply: FastifyReply) {
  if (!config.requireAdminToken) return true;
  if (!config.adminToken) {
    reply.code(503).send({ error: "Admin token is required but MOODARR_ADMIN_TOKEN is not configured." });
    return false;
  }

  if (isAdminAuthenticated(config, request)) return true;

  reply.code(401).send({ error: "Admin authentication required." });
  return false;
}

export function isAdminAuthenticated(config: AppConfig, request: FastifyRequest) {
  if (!config.requireAdminToken) return true;
  if (!config.adminToken) return false;
  const auth = request.headers.authorization;
  const moodarrHeader = typeof request.headers["x-moodarr-admin-token"] === "string" ? request.headers["x-moodarr-admin-token"] : undefined;
  const bearerToken = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
  const cookieToken = config.adminAutoSession ? parseCookie(request.headers.cookie)[adminSessionCookieName] : undefined;
  return tokenMatches(config.adminToken, moodarrHeader) || tokenMatches(config.adminToken, bearerToken) || tokenMatches(adminSessionToken(config), cookieToken);
}

export function attachAdminSessionCookie(config: AppConfig, reply: FastifyReply) {
  if (!config.adminAutoSession || !config.adminToken) return;
  reply.header("Set-Cookie", `${adminSessionCookieName}=${adminSessionToken(config)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`);
}

function tokenMatches(expected: string, candidate: string | undefined) {
  if (!candidate) return false;
  const expectedBuffer = Buffer.from(expected);
  const candidateBuffer = Buffer.from(candidate);
  return expectedBuffer.length === candidateBuffer.length && crypto.timingSafeEqual(expectedBuffer, candidateBuffer);
}

function adminSessionToken(config: AppConfig) {
  return crypto.createHmac("sha256", config.adminToken ?? "").update("moodarr-admin-session-v1").digest("base64url");
}

export function parseCookie(header: string | undefined) {
  if (!header) return {} as Record<string, string>;
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .flatMap((part) => {
        const separator = part.indexOf("=");
        if (separator < 1) return [];
        return [[part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))]];
      })
  );
}
