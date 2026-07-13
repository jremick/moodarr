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
});
