# Data And Privacy

Moodarr is local-first: its database, configuration, recommendation history, and profiles live on the Moodarr host. Local-first does not mean zero external network traffic. Plex and Seerr integrations contact only the operator-configured services. The official beta.1 image performs recommendation processing locally, cannot contact OpenAI, does not call TMDB, and does not serve TMDB artwork; the provisional source/EXP-only OpenAI provider path is documented separately below.

## Local Data Inventory

The `/data` volume can contain:

- `config.json`: saved Plex and Seerr credentials plus runtime settings; a volume previously used with a source/EXP build can also retain an inert OpenAI key until an administrator clears it;
- `moodarr.sqlite`: catalog metadata, poster cache, request audit and idempotency rows, short-lived Plex sign-in challenges, Plex user identity, signed-in users' Plex access tokens, hashed Moodarr session tokens, recommendation sessions, feedback, profiles, and diagnostics;
- SQLite `-wal` and `-shm` files while the database is open.

Keep the whole volume private. Moodarr applies restrictive POSIX permissions when the mounted filesystem supports them, but storage encryption and host access control remain deployment responsibilities. Backups contain the same secrets and personal data as the live volume and must be encrypted with recovery keys held separately from the archive.

Plex poster-cache blobs and local catalog metadata can be third-party content. They are operational instance data, not Moodarr project assets, and are not licensed for redistribution by Moodarr's Apache License 2.0. Do not publish populated databases, backups, support artifacts, or sample fixtures containing real poster images.

Signed-in users' Plex tokens are stored in plaintext inside SQLite because Moodarr needs them for Watchlist actions. Directory permissions protect against unprivileged host users, but they do not protect against host administrators, a compromised Moodarr process, an unencrypted disk copy, or a decrypted backup. Disable a user to clear that user's token, and rotate affected Plex credentials after suspected data-volume or backup exposure.

The experimental iOS alpha is outside the supported web/server beta contract. It stores its non-admin Moodarr user-session token in Keychain and the configured server URL in app preferences, but its current retry queue is process-memory only and is lost when the app terminates. The alpha does not yet make the stronger Keychain-accessibility, persisted-queue, transport-isolation, or server-change cleanup guarantees required for supported native distribution. Treat it as local testing software and review `apps/ios/README.md` before use.

## External Network Flows

| Destination | Trigger | Data sent | Local retention and disable path |
| --- | --- | --- | --- |
| Operator-configured Plex | Library sync, Plex sign-in, Watchlist actions, and Plex-poster cache misses | Plex API requests and the credential needed for the selected action | Catalog, identity, session, and poster-cache data can remain in `/data`. Remove/rotate the Plex credential and disable Plex sign-in to stop these flows. |
| Operator-configured Seerr/Jellyseerr | Operational request-state sync and an explicitly confirmed request attempt | Seerr API requests, API key, selected interoperability identifier, media type, and confirmed seasons | Operational request state and request-audit data can remain in `/data`. Disable Seerr sync and remove/rotate the API key to stop these flows. Moodarr discards descriptive fields returned alongside operational responses. |
| OpenAI | Source/EXP development builds only, after an administrator selects OpenAI, configures a key, and an AI-enabled operation runs. The official beta.1 image has no provider endpoint and ignores hostile environment or persisted provider settings. | The bounded inputs below plus OpenAI authentication | Provider-derived embeddings and structured recommendation records can remain in `/data`. Stop the source/EXP build and clear the key to stop these flows. This path is outside the beta.1 release and support contract. |

The official beta.1 build policy keeps recommendation computation local and limits network traffic to the configured Plex/Seerr flows above. It has no direct TMDB destination.

## Provisional OpenAI Data Flow

Direct source/EXP runs are configurable. With `AI_PROVIDER=openai` and a configured API key, that unsupported development path can send:

- the user's search wording, filters, watch context, and current refinement summary for query optimization and brief parsing;
- bounded candidate metadata for reranking and taste scouting, including titles, summaries, genres, year, runtime, ratings, content rating, availability/request state, deterministic scores, and liked/disliked example titles;
- query text and local media feature text for provider embeddings.

Moodarr does not intentionally send Plex, Seerr, OpenAI, or admin credentials, private integration base URLs, poster URLs, or raw database rows to OpenAI. Plex availability, trusted local request identifiers, and Seerr operational state remain server-enforced facts, and model output cannot create a request.

Administrators testing a source/EXP provider build should treat enabling OpenAI as an instance-wide third-party-processing choice and tell other Plex users before enabling it. Users who require the supported local-processing boundary should use the official provider-locked image.

Seerr responses can contain titles, summaries, genres, and artwork paths derived from TMDB. The official beta ignores those descriptive fields and persists only operational request state plus factual interoperability identifiers. Its migration sanitizes legacy ambiguous Seerr-linked descriptions, artwork references/caches, and derived replicas before they can be served. Reintroducing third-party descriptive content requires written usage authority plus complete field and derivative retention enforcement.

Confirmed-request responses are also treated as untrusted upstream input. Moodarr returns and stores only an allowlisted Seerr request ID and normalized status alongside the local media type, media ID, and selected seasons. It discards nested upstream users, tokens, descriptive objects, and unknown fields. The schema-29 boundary step within beta.1's final schema 30 applies the same projection to every legacy created idempotency response and clears malformed or non-created response bodies.

For an alpha.21 upgrade, affected rows are converted to generic `operational` placeholders and excluded from discovery. A Plex-only materialization can be restored only by a new Plex sync, and an affected catalog record can be restored only from an operator-approved catalog file for its recorded source through the packaged networkless importer. Moodarr preserves the prior source identity and content hashes while the materialization is marked stale; a same-payload refresh retains that content version, while an authoritative changed payload records new hashes and a new content version. The importer checks the expected source-specific pending count before writing, and Admin diagnostics exposes aggregate pending counts. Seerr-only rows without a trusted descriptive source remain operational placeholders; request state and factual interoperability IDs remain available, but titles, summaries, artwork, features, embeddings, and search replicas are not reconstructed from Seerr/TMDB content.

## Retention And User Scope

- Raw search prompts are not retained by default. Query review raw capture is an explicit admin opt-in; recommendation sessions otherwise retain hashes and structured result/feedback records.
- Recommendation replay data and profile checkpoints use bounded compaction policies exposed in admin diagnostics.
- Request audit history and user identity rows do not currently have a complete self-service retention/deletion policy. Treat this as a beta limitation.
- Authenticated Plex users receive user-scoped `solo` sessions, feedback, and profiles. `group` is an intentionally shared instance profile, so group-context feedback can affect later group results for other users. Admin-authenticated/no-user activity uses the local default solo profile.
- Plex poster-cache data is operational rather than personal, but it contributes materially to database and backup size. Rows are bounded by count and bytes and are swept during runtime maintenance. The official beta rejects TMDB artwork references and does not populate TMDB poster-cache rows.

Moodarr's Apache License 2.0 permits commercial use of Moodarr code, but it does not grant rights to third-party content or marks. The official beta uses locally supplied TMDB IDs only as interoperability identifiers and makes no direct TMDB content or artwork request. Operators and downstream distributors remain responsible for the services and data sources they configure.

Disabling a user invalidates their Moodarr sessions and clears their stored Plex token. A dedicated user-delete/anonymize workflow and documented audit-retention control remain required before broader multi-user use.

Instance operators should document who can administer retention, how long request audits and user rows are needed, and when disabled-user records are anonymized or deleted. Until the app exposes complete controls, perform any manual database retention work only against a stopped, backed-up instance and verify integrity after the change. Do not improvise live SQL cleanup against the production database.

## Export, Reset, And Decommissioning

Admin profile export/reset/rollback controls can target a named user's `solo` recommendation profile; `group` remains shared. These controls do not cover every user, request, or credential record. Before sharing a support bundle or profile export, inspect it and keep it out of public issues.

To decommission an instance:

1. Stop the container.
2. Revoke or rotate Plex, Seerr, OpenAI, and admin credentials used by the instance.
3. Delete the live `/data` volume and every backup according to the storage system's secure-delete capabilities.

See [Backup And Recovery](BACKUP_AND_RECOVERY.md) for consistent backup and restore procedures.
