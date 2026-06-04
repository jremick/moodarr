import crypto from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";
import type { AppConfig } from "../config";

export function requireAdmin(config: AppConfig, request: FastifyRequest, reply: FastifyReply) {
  if (!config.requireAdminToken) return true;
  if (!config.adminToken) {
    reply.code(503).send({ error: "Admin token is required but MOODARR_ADMIN_TOKEN is not configured." });
    return false;
  }

  const auth = request.headers.authorization;
  const moodarrHeader = typeof request.headers["x-moodarr-admin-token"] === "string" ? request.headers["x-moodarr-admin-token"] : undefined;
  const legacyHeader = typeof request.headers["x-feelerr-admin-token"] === "string" ? request.headers["x-feelerr-admin-token"] : undefined;
  const bearerToken = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : undefined;
  if (tokenMatches(config.adminToken, moodarrHeader) || tokenMatches(config.adminToken, legacyHeader) || tokenMatches(config.adminToken, bearerToken)) return true;

  reply.code(401).send({ error: "Admin authentication required." });
  return false;
}

function tokenMatches(expected: string, candidate: string | undefined) {
  if (!candidate) return false;
  const expectedBuffer = Buffer.from(expected);
  const candidateBuffer = Buffer.from(candidate);
  return expectedBuffer.length === candidateBuffer.length && crypto.timingSafeEqual(expectedBuffer, candidateBuffer);
}
