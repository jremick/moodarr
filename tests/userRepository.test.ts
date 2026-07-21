import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UserRepository } from "../src/server/auth/userRepository";
import { createDatabase } from "../src/server/db/database";

describe("UserRepository credential lifecycle", () => {
  it("revokes sessions and the stored Plex credential when a user is disabled", () => {
    const db = createDatabase(":memory:");
    const repository = new UserRepository(db);
    const user = repository.upsertPlexUser({ providerUserId: "plex-user", username: "viewer" }, true, "plex-user-token");
    const session = repository.createSession(user.id);

    repository.updateUser(user.id, { enabled: false });

    expect(repository.findPlexTokenForUser(user.id)).toBeUndefined();
    expect(repository.findSessionUser(session.token)).toBeUndefined();
    expect(repository.listUsers()[0]).toMatchObject({ enabled: false });
    expect(() => repository.upsertPlexUser({ providerUserId: "plex-user", username: "viewer" }, true, "replacement-token")).toThrow(/disabled/i);
    expect((db.prepare("SELECT plex_token FROM app_users WHERE id = ?").get(user.id) as { plex_token: string | null }).plex_token).toBeNull();
  });

  it("bounds user identity and credential fields at the persistence boundary", () => {
    const db = createDatabase(":memory:");
    const repository = new UserRepository(db);
    const plexToken = "repository-user-token-secret";

    const user = repository.upsertPlexUser(
      {
        providerUserId: "bounded-user",
        username: "x".repeat(121),
        displayName: `Reflected ${plexToken}`,
        email: "not-an-email",
        avatarUrl: "javascript:alert(1)"
      },
      true,
      plexToken
    );

    expect(user).toMatchObject({ providerUserId: "bounded-user" });
    expect(user.username).toBeUndefined();
    expect(user.displayName).toBeUndefined();
    expect(user.email).toBeUndefined();
    expect(user.avatarUrl).toBeUndefined();
    expect(JSON.stringify(user)).not.toContain(plexToken);
    expect(repository.findPlexTokenForUser(user.id)).toBe(plexToken);
    expect(() => repository.upsertPlexUser({ providerUserId: "x".repeat(201) }, true)).toThrow(/safe account id/i);
    expect(() => repository.upsertPlexUser({ providerUserId: "another-user" }, true, "x".repeat(4_097))).toThrow(/credential was invalid/i);
  });

  it("keeps valid and invalid session lookups read-only while another connection holds the writer lock", () => {
    const directory = mkdtempSync(join(tmpdir(), "moodarr-user-session-contention-"));
    const dbPath = join(directory, "moodarr.sqlite");
    const db = createDatabase(dbPath);
    const repository = new UserRepository(db);
    const validUser = repository.upsertPlexUser({ providerUserId: "valid-user", username: "valid" }, true);
    const expiredUser = repository.upsertPlexUser({ providerUserId: "expired-user", username: "expired" }, true);
    const validSession = repository.createSession(validUser.id);
    const expiredSession = repository.createSession(expiredUser.id);
    const unchangedLastSeenAt = "2000-01-01T00:00:00.000Z";
    db.prepare("UPDATE user_sessions SET last_seen_at = ? WHERE user_id = ?").run(unchangedLastSeenAt, validUser.id);
    db.prepare("UPDATE user_sessions SET expires_at = ? WHERE user_id = ?").run("2000-01-01T00:00:00.000Z", expiredUser.id);
    const writerDb = createDatabase(dbPath);

    writerDb.exec("BEGIN IMMEDIATE");
    const startedAt = Date.now();
    try {
      expect(repository.findSessionUser(validSession.token)).toMatchObject({ id: validUser.id });
      expect(repository.findSessionUser("invalid-session-token")).toBeUndefined();
      expect(repository.findSessionUser(expiredSession.token)).toBeUndefined();
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect((db.prepare("SELECT last_seen_at FROM user_sessions WHERE user_id = ?").get(validUser.id) as { last_seen_at: string }).last_seen_at).toBe(
        unchangedLastSeenAt
      );
    } finally {
      writerDb.exec("ROLLBACK");
      writerDb.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
