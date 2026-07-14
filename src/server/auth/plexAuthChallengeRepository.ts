import type { SqliteDatabase } from "../db/database";

export interface PlexAuthChallenge {
  code: string;
  stateHash: string;
  expiresAt: number;
}

interface PlexAuthChallengeRow {
  code: string;
  state_hash: string;
  expires_at: string;
}

export class PlexAuthChallengeRepository {
  constructor(private readonly db: SqliteDatabase) {}

  save(pinId: string, challenge: PlexAuthChallenge) {
    this.purgeExpired();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO plex_auth_challenges (pin_id, code, state_hash, expires_at, consumed_at, created_at)
         VALUES (?, ?, ?, ?, NULL, ?)
         ON CONFLICT(pin_id) DO UPDATE SET
           code = excluded.code,
           state_hash = excluded.state_hash,
           expires_at = excluded.expires_at,
           consumed_at = NULL,
           created_at = excluded.created_at`
      )
      .run(pinId, challenge.code, challenge.stateHash, new Date(challenge.expiresAt).toISOString(), now);
  }

  find(pinId: string): PlexAuthChallenge | undefined {
    this.purgeExpired();
    const row = this.db
      .prepare(
        `SELECT code, state_hash, expires_at
         FROM plex_auth_challenges
         WHERE pin_id = ?
           AND consumed_at IS NULL
           AND expires_at > ?
         LIMIT 1`
      )
      .get(pinId, new Date().toISOString()) as PlexAuthChallengeRow | undefined;
    if (!row) return undefined;
    return {
      code: row.code,
      stateHash: row.state_hash,
      expiresAt: Date.parse(row.expires_at)
    };
  }

  consume(pinId: string) {
    const result = this.db
      .prepare(
        `UPDATE plex_auth_challenges
         SET consumed_at = ?
         WHERE pin_id = ?
           AND consumed_at IS NULL
           AND expires_at > ?`
      )
      .run(new Date().toISOString(), pinId, new Date().toISOString());
    return Number(result.changes) === 1;
  }

  purgeExpired() {
    this.db.prepare("DELETE FROM plex_auth_challenges WHERE expires_at <= ?").run(new Date().toISOString());
  }
}
