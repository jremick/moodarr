import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config";

export const adminSessionCookieName = "moodarr_admin_session";
export const adminLockCookieName = "moodarr_admin_locked";
const adminSessionTtlSeconds = 8 * 60 * 60;
const adminLockTtlSeconds = 365 * 24 * 60 * 60;

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
  const cookieToken = parseCookie(request.headers.cookie)[adminSessionCookieName];
  return tokenMatches(config.adminToken, moodarrHeader) || tokenMatches(config.adminToken, bearerToken) || adminSessionIsValid(config, cookieToken);
}

export function attachAdminSessionCookie(config: AppConfig, reply: FastifyReply, request?: FastifyRequest) {
  if (!config.adminAutoSession || !config.adminToken) return;
  if (adminSessionIsLocked(request)) return;
  attachExplicitAdminSessionCookie(config, reply);
}

export function attachExplicitAdminSessionCookie(config: AppConfig, reply: FastifyReply) {
  if (!config.adminToken) return;
  const expiresAt = Math.floor(Date.now() / 1000) + adminSessionTtlSeconds;
  const secure = new URL(config.webOrigin).protocol === "https:" ? "; Secure" : "";
  reply.header(
    "Set-Cookie",
    [
      `${adminSessionCookieName}=${encodeURIComponent(adminSessionToken(config, expiresAt))}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${adminSessionTtlSeconds}${secure}`,
      `${adminLockCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`
    ]
  );
}

export function clearAdminSessionCookie(config: AppConfig, reply: FastifyReply) {
  const secure = new URL(config.webOrigin).protocol === "https:" ? "; Secure" : "";
  reply.header("Set-Cookie", [
    `${adminSessionCookieName}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
    `${adminLockCookieName}=1; Path=/; HttpOnly; SameSite=Strict; Max-Age=${adminLockTtlSeconds}${secure}`
  ]);
}

export function adminSessionIsLocked(request: FastifyRequest | undefined) {
  return parseCookie(request?.headers.cookie)[adminLockCookieName] === "1";
}

export function adminTokenIsValid(config: AppConfig, token: string | undefined) {
  return Boolean(config.adminToken && tokenMatches(config.adminToken, token));
}

function tokenMatches(expected: string, candidate: string | undefined) {
  if (!candidate) return false;
  const expectedBuffer = Buffer.from(expected);
  const candidateBuffer = Buffer.from(candidate);
  return expectedBuffer.length === candidateBuffer.length && crypto.timingSafeEqual(expectedBuffer, candidateBuffer);
}

function adminSessionToken(config: AppConfig, expiresAt: number) {
  const signature = crypto.createHmac("sha256", config.adminToken ?? "").update(`moodarr-admin-session-v2:${expiresAt}`).digest("base64url");
  return `${expiresAt}.${signature}`;
}

function adminSessionIsValid(config: AppConfig, candidate: string | undefined) {
  if (!candidate) return false;
  const separator = candidate.indexOf(".");
  if (separator < 1) return false;
  const expiresAt = Number(candidate.slice(0, separator));
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false;
  return tokenMatches(adminSessionToken(config, expiresAt), candidate);
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
        try {
          return [[part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))]];
        } catch {
          return [];
        }
      })
  );
}
