# Data And Privacy

Moodarr is local-first: its database, configuration, recommendation history, and profiles live on the Moodarr host. Local-first does not mean zero external network traffic. Plex and Seerr integrations contact the operator-configured services, Seerr-supplied poster paths can cause a server-side TMDB image request, and optional OpenAI processing sends the selected inputs described below.

## Local Data Inventory

The `/data` volume can contain:

- `config.json`: saved Plex, Seerr, and OpenAI credentials plus runtime settings;
- `moodarr.sqlite`: catalog metadata, poster cache, request audit and idempotency rows, short-lived Plex sign-in challenges, Plex user identity, signed-in users' Plex access tokens, hashed Moodarr session tokens, recommendation sessions, feedback, profiles, and diagnostics;
- SQLite `-wal` and `-shm` files while the database is open.

Keep the whole volume private. Moodarr applies restrictive POSIX permissions when the mounted filesystem supports them, but storage encryption and host access control remain deployment responsibilities. Backups contain the same secrets and personal data as the live volume and must be encrypted with recovery keys held separately from the archive.

Poster-cache blobs and some catalog metadata can be third-party content. They are operational instance data, not Moodarr project assets, and are not licensed for redistribution by Moodarr's Apache License 2.0. Do not publish populated databases, backups, support artifacts, or sample fixtures containing real poster images.

Signed-in users' Plex tokens are stored in plaintext inside SQLite because Moodarr needs them for Watchlist actions. Directory permissions protect against unprivileged host users, but they do not protect against host administrators, a compromised Moodarr process, an unencrypted disk copy, or a decrypted backup. Disable a user to clear that user's token, and rotate affected Plex credentials after suspected data-volume or backup exposure.

The experimental iOS alpha is outside the supported web/server beta contract. It stores its non-admin Moodarr user-session token in Keychain and the configured server URL in app preferences, but its current retry queue is process-memory only and is lost when the app terminates. The alpha does not yet make the stronger Keychain-accessibility, persisted-queue, transport-isolation, or server-change cleanup guarantees required for supported native distribution. Treat it as local testing software and review `apps/ios/README.md` before use.

## External Network Flows

| Destination | Trigger | Data sent | Local retention and disable path |
| --- | --- | --- | --- |
| Operator-configured Plex | Library sync, Plex sign-in, Watchlist actions, and Plex-poster cache misses | Plex API requests and the credential needed for the selected action | Catalog, identity, session, and poster-cache data can remain in `/data`. Remove/rotate the Plex credential and disable Plex sign-in to stop these flows. |
| Operator-configured Seerr/Jellyseerr | Catalog/request-state sync, request preview support, and an explicitly confirmed request | Seerr API requests, API key, selected media identifier, media type, and confirmed seasons | Catalog and request-audit data can remain in `/data`. Disable Seerr sync and remove/rotate the API key to stop these flows. |
| `image.tmdb.org` | First authenticated request for a Seerr-supplied poster after a cache miss or expiry | The poster path, request timing, Moodarr product identifier, and the Moodarr host's egress IP; no Moodarr, Plex, Seerr, or OpenAI credential is sent | Moodarr proxies the response, marks the browser response `private, no-store`, and caps its server poster-cache age at 180 days. Do not request affected poster routes, or block `image.tmdb.org` at host/network egress, to stop this flow. Disabling Seerr sync alone does not remove already-persisted poster paths; beta does not yet expose a separate external-artwork switch. |
| OpenAI | Only when an administrator selects OpenAI, configures a key, and an AI-enabled operation runs | The bounded inputs below plus OpenAI authentication | Provider-derived embeddings and structured recommendation records can remain in `/data`. Set `AI_PROVIDER=none` and clear the key to stop these flows. This path is not beta-release-cleared until the third-party-content usage gate is closed. |

`AI_PROVIDER=none` keeps recommendation computation local; it does not prevent the configured Plex/Seerr traffic or a TMDB poster fetch described above.

## Provisional OpenAI Data Flow

`AI_PROVIDER=none` is the local recommendation-processing default. With `AI_PROVIDER=openai` and a configured API key, Moodarr can send:

- the user's search wording, filters, watch context, and current refinement summary for query optimization and brief parsing;
- bounded candidate metadata for reranking and taste scouting, including titles, summaries, genres, year, runtime, ratings, content rating, availability/request state, deterministic scores, and liked/disliked example titles;
- query text and local media feature text for provider embeddings.

Moodarr does not intentionally send Plex, Seerr, OpenAI, or admin credentials, private integration base URLs, poster URLs, or raw database rows to OpenAI. Availability and requestability remain server-enforced Plex/Seerr facts, and model output cannot create a request.

Administrators should treat enabling OpenAI as an instance-wide third-party-processing choice and tell other Plex users before enabling it. Users who require local recommendation processing should keep `AI_PROVIDER=none`.

Seerr responses can contain identifiers, titles, summaries, genres, and artwork paths derived from TMDB. Moodarr does not currently retain field-level upstream provenance, so it cannot prove that every provider payload excludes TMDB-derived content. The public beta release gate therefore requires either written usage authority or a tested technical separation before the OpenAI path can be included in the supported beta contract.

## Retention And User Scope

- Raw search prompts are not retained by default. Query review raw capture is an explicit admin opt-in; recommendation sessions otherwise retain hashes and structured result/feedback records.
- Recommendation replay data and profile checkpoints use bounded compaction policies exposed in admin diagnostics.
- Request audit history and user identity rows do not currently have a complete self-service retention/deletion policy. Treat this as a beta limitation.
- Authenticated Plex users receive user-scoped `solo` sessions, feedback, and profiles. `group` is an intentionally shared instance profile, so group-context feedback can affect later group results for other users. Admin-authenticated/no-user activity uses the local default solo profile.
- Poster cache data is operational rather than personal, but it contributes materially to database and backup size. Rows are bounded by count and bytes; invalid or future timestamps fail closed; valid rows expire at 180 days, are swept at startup and during runtime maintenance, and are re-fetched on a later cache miss. TMDB-backed browser responses use `private, no-store` so client caching cannot extend that server retention window.

TMDB's free developer terms distinguish non-commercial use from commercial use. Moodarr's Apache License 2.0 permits commercial use of Moodarr code, but it does not grant rights to TMDB content or marks. Operators and downstream distributors remain responsible for obtaining any separate authorization their use requires.

Disabling a user invalidates their Moodarr sessions and clears their stored Plex token. A dedicated user-delete/anonymize workflow and documented audit-retention control remain required before broader multi-user use.

Instance operators should document who can administer retention, how long request audits and user rows are needed, and when disabled-user records are anonymized or deleted. Until the app exposes complete controls, perform any manual database retention work only against a stopped, backed-up instance and verify integrity after the change. Do not improvise live SQL cleanup against the production database.

## Export, Reset, And Decommissioning

Admin profile export/reset/rollback controls can target a named user's `solo` recommendation profile; `group` remains shared. These controls do not cover every user, request, or credential record. Before sharing a support bundle or profile export, inspect it and keep it out of public issues.

To decommission an instance:

1. Stop the container.
2. Revoke or rotate Plex, Seerr, OpenAI, and admin credentials used by the instance.
3. Delete the live `/data` volume and every backup according to the storage system's secure-delete capabilities.

See [Backup And Recovery](BACKUP_AND_RECOVERY.md) for consistent backup and restore procedures.
