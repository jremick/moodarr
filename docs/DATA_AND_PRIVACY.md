# Data And Privacy

Moodarr is local-first: its database, configuration, recommendation history, and profiles live on the Moodarr host. Local-first does not mean every optional computation stays local. When OpenAI is enabled, the backend sends selected inputs to OpenAI as described below.

## Local Data Inventory

The `/data` volume can contain:

- `config.json`: saved Plex, Seerr, and OpenAI credentials plus runtime settings;
- `moodarr.sqlite`: catalog metadata, poster cache, request audit and idempotency rows, short-lived Plex sign-in challenges, Plex user identity, signed-in users' Plex access tokens, hashed Moodarr session tokens, recommendation sessions, feedback, profiles, and diagnostics;
- SQLite `-wal` and `-shm` files while the database is open.

Keep the whole volume private. Moodarr applies restrictive POSIX permissions when the mounted filesystem supports them, but storage encryption and host access control remain deployment responsibilities. Backups contain the same secrets and personal data as the live volume and must be encrypted with recovery keys held separately from the archive.

Signed-in users' Plex tokens are stored in plaintext inside SQLite because Moodarr needs them for Watchlist actions. Directory permissions protect against unprivileged host users, but they do not protect against host administrators, a compromised Moodarr process, an unencrypted disk copy, or a decrypted backup. Disable a user to clear that user's token, and rotate affected Plex credentials after suspected data-volume or backup exposure.

The native iOS app stores its non-admin Moodarr user-session token in Keychain using `WhenUnlockedThisDeviceOnly`. Its dedicated transport does not accept or send browser cookies, so Keychain remains the only native authentication store. Failed feedback is stored separately in an app-support file with private POSIX permissions and iOS Data Protection, partitioned by server and user, capped at 500 events, and removed after 30 days. The relevant queue scope is removed on local sign-out, and all queued scopes for the previous server are removed after a verified server change. Native bearer credentials are never attached to cross-origin resource URLs.

## Optional OpenAI Data Flow

`AI_PROVIDER=none` is the local-only default. With `AI_PROVIDER=openai` and a configured API key, Moodarr can send:

- the user's search wording, filters, watch context, and current refinement summary for query optimization and brief parsing;
- bounded candidate metadata for reranking and taste scouting, including titles, summaries, genres, year, runtime, ratings, content rating, availability/request state, deterministic scores, and liked/disliked example titles;
- query text and local media feature text for provider embeddings.

Moodarr does not intentionally send Plex, Seerr, OpenAI, or admin credentials, private integration base URLs, poster URLs, or raw database rows to OpenAI. Availability and requestability remain server-enforced Plex/Seerr facts, and model output cannot create a request.

Administrators should treat enabling OpenAI as an instance-wide third-party-processing choice and tell other Plex users before enabling it. Users who require local-only processing should keep `AI_PROVIDER=none`.

## Retention And User Scope

- Raw search prompts are not retained by default. Query review raw capture is an explicit admin opt-in; recommendation sessions otherwise retain hashes and structured result/feedback records.
- Recommendation replay data and profile checkpoints use bounded compaction policies exposed in admin diagnostics.
- Request audit history and user identity rows do not currently have a complete self-service retention/deletion policy. Treat this as an alpha limitation.
- Authenticated Plex users receive user-scoped `solo` sessions, feedback, and profiles. `group` is an intentionally shared instance profile, so group-context feedback can affect later group results for other users. Admin-authenticated/no-user activity uses the local default solo profile.
- Poster cache data is operational rather than personal, but it contributes materially to database and backup size and is subject to a bounded cache policy.

Disabling a user invalidates their Moodarr sessions and clears their stored Plex token. A dedicated user-delete/anonymize workflow and documented audit-retention control remain required before broader multi-user use.

Instance operators should document who can administer retention, how long request audits and user rows are needed, and when disabled-user records are anonymized or deleted. Until the app exposes complete controls, perform any manual database retention work only against a stopped, backed-up instance and verify integrity after the change. Do not improvise live SQL cleanup against the production database.

## Export, Reset, And Decommissioning

Admin profile export/reset/rollback controls can target a named user's `solo` recommendation profile; `group` remains shared. These controls do not cover every user, request, or credential record. Before sharing a support bundle or profile export, inspect it and keep it out of public issues.

To decommission an instance:

1. Stop the container.
2. Revoke or rotate Plex, Seerr, OpenAI, and admin credentials used by the instance.
3. Delete the live `/data` volume and every backup according to the storage system's secure-delete capabilities.

See [Backup And Recovery](BACKUP_AND_RECOVERY.md) for consistent backup and restore procedures.
