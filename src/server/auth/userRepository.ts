import crypto, { randomUUID } from "node:crypto";
import type { AuthUser } from "../../shared/types";
import type { SqliteDatabase } from "../db/database";

export const userSessionCookieName = "moodarr_user_session";
const sessionTtlMs = 30 * 24 * 60 * 60 * 1000;

interface UserRow {
  id: string;
  provider: "plex";
  provider_user_id: string;
  username?: string | null;
  display_name?: string | null;
  email?: string | null;
  avatar_url?: string | null;
  plex_token?: string | null;
  enabled: number;
  can_request: number;
  can_use_ai: number;
  request_count?: number;
  created_at: string;
  updated_at: string;
  last_login_at?: string | null;
}

export interface PlexUserIdentity {
  providerUserId: string;
  username?: string;
  displayName?: string;
  email?: string;
  avatarUrl?: string;
}

export class UserRepository {
  constructor(private readonly db: SqliteDatabase) {}

  listUsers(): AuthUser[] {
    return (
      this.db
        .prepare(
          `SELECT app_users.*, COALESCE(request_counts.request_count, 0) AS request_count
           FROM app_users
           LEFT JOIN (
             SELECT auth_user_id, COUNT(*) AS request_count
             FROM request_audit
             WHERE action = 'create'
               AND status = 'created'
               AND auth_user_id IS NOT NULL
             GROUP BY auth_user_id
           ) AS request_counts ON request_counts.auth_user_id = app_users.id
           ORDER BY app_users.last_login_at DESC, app_users.created_at DESC`
        )
        .all() as unknown as UserRow[]
    ).map(inflateUser);
  }

  upsertPlexUser(identity: PlexUserIdentity, allowNewUsers: boolean, plexToken?: string) {
    const normalizedToken = normalizePlexToken(plexToken);
    const normalizedIdentity = sanitizePlexUserIdentity(identity, normalizedToken ? [normalizedToken] : []);
    const existing = this.findByProvider("plex", normalizedIdentity.providerUserId);
    if (!existing && !allowNewUsers) {
      throw Object.assign(new Error("This Plex account has access to the server, but new Plex sign-ins are disabled."), { statusCode: 403 });
    }
    if (existing && !existing.enabled) {
      throw Object.assign(new Error("This Plex account is disabled in Moodarr."), { statusCode: 403 });
    }

    const now = new Date().toISOString();
    const id = existing?.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO app_users (
          id, provider, provider_user_id, username, display_name, email, avatar_url, plex_token,
          enabled, can_request, can_use_ai, created_at, updated_at, last_login_at
        ) VALUES (?, 'plex', ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?, ?)
        ON CONFLICT(provider, provider_user_id) DO UPDATE SET
          username = excluded.username,
          display_name = excluded.display_name,
          email = excluded.email,
          avatar_url = excluded.avatar_url,
          plex_token = COALESCE(excluded.plex_token, app_users.plex_token),
          updated_at = excluded.updated_at,
          last_login_at = excluded.last_login_at`
      )
      .run(
        id,
        normalizedIdentity.providerUserId,
        normalizedIdentity.username ?? null,
        normalizedIdentity.displayName ?? normalizedIdentity.username ?? null,
        normalizedIdentity.email ?? null,
        normalizedIdentity.avatarUrl ?? null,
        normalizedToken ?? null,
        now,
        now,
        now
      );

    const user = this.findById(id);
    if (!user) throw new Error("Plex user sign-in could not be stored.");
    if (!user.enabled) {
      throw Object.assign(new Error("This Plex account is disabled in Moodarr."), { statusCode: 403 });
    }
    return user;
  }

  updateUser(id: string, update: { enabled?: boolean; canRequest?: boolean; canUseAi?: boolean }) {
    const current = this.findById(id);
    if (!current) return undefined;
    if (update.enabled !== undefined) {
      this.db
        .prepare("UPDATE app_users SET enabled = ?, plex_token = CASE WHEN ? = 0 THEN NULL ELSE plex_token END, updated_at = ? WHERE id = ?")
        .run(update.enabled ? 1 : 0, update.enabled ? 1 : 0, new Date().toISOString(), id);
      if (!update.enabled) this.db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(id);
    }
    if (update.canRequest !== undefined) {
      this.db.prepare("UPDATE app_users SET can_request = ?, updated_at = ? WHERE id = ?").run(update.canRequest ? 1 : 0, new Date().toISOString(), id);
    }
    if (update.canUseAi !== undefined) {
      this.db.prepare("UPDATE app_users SET can_use_ai = ?, updated_at = ? WHERE id = ?").run(update.canUseAi ? 1 : 0, new Date().toISOString(), id);
    }
    return this.findById(id);
  }

  findPlexTokenForUser(id: string) {
    const row = this.db.prepare("SELECT plex_token FROM app_users WHERE id = ? AND provider = 'plex' AND enabled = 1 LIMIT 1").get(id) as
      | { plex_token?: string | null }
      | undefined;
    return row?.plex_token ?? undefined;
  }

  createSession(userId: string) {
    this.purgeExpiredSessions();
    const token = crypto.randomBytes(32).toString("base64url");
    const now = new Date();
    const expiresAt = new Date(now.getTime() + sessionTtlMs).toISOString();
    this.db
      .prepare("INSERT INTO user_sessions (id, user_id, token_hash, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), userId, tokenHash(token), now.toISOString(), expiresAt, now.toISOString());
    return { token, expiresAt };
  }

  findSessionUser(token: string | undefined) {
    if (!token) return undefined;
    const row = this.db
      .prepare(
        `SELECT app_users.*
         FROM user_sessions
         JOIN app_users ON app_users.id = user_sessions.user_id
         WHERE user_sessions.token_hash = ?
           AND user_sessions.expires_at > ?
           AND app_users.enabled = 1
         LIMIT 1`
      )
      .get(tokenHash(token), new Date().toISOString()) as UserRow | undefined;
    return row ? inflateUser(row) : undefined;
  }

  revokeSession(token: string | undefined) {
    if (!token) return;
    this.db.prepare("DELETE FROM user_sessions WHERE token_hash = ?").run(tokenHash(token));
  }

  findById(id: string) {
    const row = this.db.prepare("SELECT * FROM app_users WHERE id = ? LIMIT 1").get(id) as UserRow | undefined;
    return row ? inflateUser(row) : undefined;
  }

  private findByProvider(provider: "plex", providerUserId: string) {
    const row = this.db.prepare("SELECT * FROM app_users WHERE provider = ? AND provider_user_id = ? LIMIT 1").get(provider, providerUserId) as
      | UserRow
      | undefined;
    return row ? inflateUser(row) : undefined;
  }

  private purgeExpiredSessions() {
    this.db.prepare("DELETE FROM user_sessions WHERE expires_at <= ?").run(new Date().toISOString());
  }

}

function inflateUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    provider: row.provider,
    providerUserId: row.provider_user_id,
    username: row.username ?? undefined,
    displayName: row.display_name ?? undefined,
    email: row.email ?? undefined,
    avatarUrl: row.avatar_url ?? undefined,
    enabled: Boolean(row.enabled),
    canRequest: Boolean(row.can_request),
    canUseAi: Boolean(row.can_use_ai),
    requestCount: row.request_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at ?? undefined
  };
}

function tokenHash(token: string) {
  return crypto.createHash("sha256").update(token).digest("base64url");
}

export function sanitizePlexUserIdentity(identity: PlexUserIdentity, knownSecrets: string[] = []): PlexUserIdentity {
  const record = identity && typeof identity === "object" ? (identity as unknown as Record<string, unknown>) : undefined;
  const providerUserId = boundedIdentifier(record?.providerUserId, 200);
  if (!providerUserId || reflectsSecret(providerUserId, knownSecrets)) {
    throw new Error("Plex user identity did not contain a safe account id.");
  }

  const username = boundedText(record?.username, 120, knownSecrets);
  const displayName = boundedText(record?.displayName, 200, knownSecrets);
  const email = boundedEmail(record?.email, knownSecrets);
  const avatarUrl = boundedAvatarUrl(record?.avatarUrl, knownSecrets);
  return {
    providerUserId,
    ...(username ? { username } : {}),
    ...(displayName ? { displayName } : {}),
    ...(email ? { email } : {}),
    ...(avatarUrl ? { avatarUrl } : {})
  };
}

function normalizePlexToken(value: string | undefined) {
  if (value === undefined) return undefined;
  if (!value || value.length > 4_096 || /\s/u.test(value) || hasControlCharacters(value)) {
    throw new Error("Plex user credential was invalid.");
  }
  return value;
}

function boundedIdentifier(value: unknown, maximumLength: number) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || /\s/u.test(normalized) || hasControlCharacters(normalized)) return undefined;
  return normalized;
}

function boundedText(value: unknown, maximumLength: number, knownSecrets: string[]) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength || hasControlCharacters(normalized) || reflectsSecret(normalized, knownSecrets)) {
    return undefined;
  }
  return normalized;
}

function boundedEmail(value: unknown, knownSecrets: string[]) {
  const normalized = boundedText(value, 320, knownSecrets);
  if (!normalized || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(normalized)) return undefined;
  return normalized;
}

function boundedAvatarUrl(value: unknown, knownSecrets: string[]) {
  const normalized = boundedText(value, 2_000, knownSecrets);
  if (!normalized) return undefined;
  try {
    const url = new URL(normalized);
    return url.protocol === "http:" || url.protocol === "https:" ? normalized : undefined;
  } catch {
    return undefined;
  }
}

function reflectsSecret(value: string, knownSecrets: string[]) {
  return knownSecrets.some((secret) => Boolean(secret) && (value === secret || (secret.length >= 4 && value.includes(secret))));
}

function hasControlCharacters(value: string) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}
