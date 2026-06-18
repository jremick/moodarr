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
  enabled: number;
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
    return (this.db.prepare("SELECT * FROM app_users ORDER BY last_login_at DESC, created_at DESC").all() as unknown as UserRow[]).map(inflateUser);
  }

  upsertPlexUser(identity: PlexUserIdentity, allowNewUsers: boolean) {
    const existing = this.findByProvider("plex", identity.providerUserId);
    if (!existing && !allowNewUsers) {
      throw Object.assign(new Error("This Plex account has access to the server, but new Plex sign-ins are disabled."), { statusCode: 403 });
    }

    const now = new Date().toISOString();
    const id = existing?.id ?? randomUUID();
    this.db
      .prepare(
        `INSERT INTO app_users (
          id, provider, provider_user_id, username, display_name, email, avatar_url, enabled, created_at, updated_at, last_login_at
        ) VALUES (?, 'plex', ?, ?, ?, ?, ?, 1, ?, ?, ?)
        ON CONFLICT(provider, provider_user_id) DO UPDATE SET
          username = excluded.username,
          display_name = excluded.display_name,
          email = excluded.email,
          avatar_url = excluded.avatar_url,
          updated_at = excluded.updated_at,
          last_login_at = excluded.last_login_at`
      )
      .run(
        id,
        identity.providerUserId,
        identity.username ?? null,
        identity.displayName ?? identity.username ?? null,
        identity.email ?? null,
        identity.avatarUrl ?? null,
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

  updateUser(id: string, update: { enabled?: boolean }) {
    const current = this.findById(id);
    if (!current) return undefined;
    if (update.enabled !== undefined) {
      this.db.prepare("UPDATE app_users SET enabled = ?, updated_at = ? WHERE id = ?").run(update.enabled ? 1 : 0, new Date().toISOString(), id);
      if (!update.enabled) this.db.prepare("DELETE FROM user_sessions WHERE user_id = ?").run(id);
    }
    return this.findById(id);
  }

  createSession(userId: string) {
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
    this.purgeExpiredSessions();
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
    if (!row) return undefined;
    this.db.prepare("UPDATE user_sessions SET last_seen_at = ? WHERE token_hash = ?").run(new Date().toISOString(), tokenHash(token));
    return inflateUser(row);
  }

  revokeSession(token: string | undefined) {
    if (!token) return;
    this.db.prepare("DELETE FROM user_sessions WHERE token_hash = ?").run(tokenHash(token));
  }

  private findById(id: string) {
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at ?? undefined
  };
}

function tokenHash(token: string) {
  return crypto.createHash("sha256").update(token).digest("base64url");
}
