# Watch-history proposal

Status: design for review, 2026-09-27. No collection, schema migration, credential
change or ranking activation is implemented by this proposal.

## Evidence and current boundary

The current Plex importer reads `userRating` into shared item ratings. The legacy
quality signal averages that value with available critic/audience ratings. It does
not import per-user play counts, progress or history. One integration account's
rating can therefore affect other viewers' quality prior.

The [Plex Media Server API](https://developer.plex.tv/pms/) documents `viewCount`,
`lastViewedAt`, `viewOffset`, `userRating`, and the read-only
`GET /status/sessions/history/all` endpoint with an `accountID` restriction.
These are candidate inputs, not proof that the installed server or each user's
existing token permits every read. Before implementation, verify permissions,
pagination, timestamps, rating units and user attribution against a disposable
test account. Do not assume an account filter grants access.

[Plex watch-state syncing](https://support.plex.tv/articles/sync-watch-state-and-ratings/)
is an optional account feature that can copy watch state and ratings to Plex.
This proposal neither requires nor enables it. Moodarr's own imported records
would stay local; that does not describe Plex's independent storage policy.

## Identity and minimal storage

Use the existing profile scopes. Verified user activity belongs only to
`solo:user:<id>`. `solo:default` must not silently inherit the integration owner's
history. `group:shared` receives no individual history by default. A group session
does not identify its participants; a participant-aware aggregation needs a
separate product decision.

Proposed tables, subject to schema review:

| Record | Minimum fields | Purpose |
|---|---|---|
| `user_watch_state` | user ID, media ID, source identity, view count, last viewed time, progress ms, personal rating, observed time | One current state per user/item; missing values stay unknown |
| `user_play_event` | user ID, source event identity, media ID, played time, observed time | Deduplicated recent events for attribution; unique user/source event key |
| `user_watch_sync` | user ID, cursor, last success, fixed error code | Bounded, resumable reads without persisting upstream responses |

Reuse an existing authorized user credential only after proving its identity and
access. Never infer a user from a display name. Foreign keys and every read/write
must enforce user scope. Deleted or disabled users stop collection; disabling
alone is not permission to retain history forever. Export/reset/deletion behavior
must be designed together, including backup retention.

## Proposed uses

- Novelty: a verified completed viewing can lower unseen-content priority. An
  explicit rewatch or comfort-watch request bypasses that penalty. A missing play
  record does not prove an item is unwatched; offsets alone do not prove completion.
- Taste seeding: explicit high/low ratings are stronger evidence than completion.
  Propose positives at four or five stars and negatives at two stars or below,
  only after confirming source units and converting once. Completion and rewatches
  are weaker positive evidence; abandonment is not automatically negative.
  Bound imported evidence so repeated synchronization cannot overpower explicit
  Moodarr feedback or count the same event twice.
- Quality: remove personal ratings from the public quality prior when the migration
  separates them. Keep per-user preference evidence in the personal scoring path.
  The current `novelty` bucket also carries guardrail penalties; add an explicit
  watched-state input instead of assuming the existing bucket measures viewing.
- Watch-start measurement: join a verified user's first qualifying play within a
  predeclared N-hour window to that user's earlier `server_returned` exposure for
  the same item. Exclude prior/in-progress plays; assign a play to one session.
  Returned results do not prove the card was seen or caused playback. Report
  attribution coverage and denominator alongside the rate.

## Privacy and acceptance decisions

Propose opt-in import, 90-day raw play-event retention, and retention of current
state only while the user remains opted in. These are proposals, not defaults.
The admin export must identify its scope and contain no tokens, raw upstream
responses, device addresses or other users' records. Personal history should not
enter public support artifacts or provider prompts.

Before implementation, approve the opt-in experience, retention/deletion policy,
administrator access, default-user behavior, completion criterion, rating scale,
evidence budget and N-hour attribution window. Update `DATA_AND_PRIVACY.md` only
when the corresponding behavior exists, explicitly documenting collection,
purposes, export, reset, deletion and backups.

Acceptance must cover two users with conflicting ratings, a shared group search,
disabled users, missing permissions, replayed sync pages, timestamp skew, partial
plays, changed ratings, item identity repair, export isolation and retention.
Use synthetic records first and separately authorize any live Plex validation.
