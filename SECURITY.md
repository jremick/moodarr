# Security Policy

Moodarr is designed for a trusted LAN or VPN boundary. Do not expose it directly to the public internet unless an external authentication layer, TLS, and rate limiting protect it.

## Supported Versions

Moodarr is public alpha software. Security fixes are delivered in new immutable prerelease tags; only the newest published alpha is supported. Older images should be treated as superseded.

## Supported Boundary

- Plex library/catalog access is read-only. The optional Plex Watchlist action is an explicit signed-in-user write to Plex Discover.
- Seerr/Jellyseerr request creation is an external write and requires a server preview plus explicit user confirmation.
- Plex, Seerr/Jellyseerr, OpenAI, and admin credentials stay server-side. Poster images are proxied so Plex tokens are not placed in browser URLs.
- Optional Plex sign-in stores local user identity, the user's Plex access token for Watchlist actions, and a hashed Moodarr session token.
- Native clients may opt into receiving a non-admin Moodarr user-session token for platform secure storage.
- Private catalog reads, search, posters, request previews, and request creation require admin authentication or an enabled Plex user session when Plex auth is enabled. Admin writes, diagnostics, sync controls, and user management require admin authentication.
- `/api/health`, public config status, and Plex sign-in start/complete remain unauthenticated for health, setup, and login flow.

Plex server access admits an enabled user to Finder. Admin can separately control each user's request and AI capabilities; review those defaults whenever new-user admission is enabled. Solo recommendation sessions, feedback, and profiles are scoped to the authenticated user, while group context intentionally uses a shared instance profile.

## Admin Authentication

Set `MOODARR_REQUIRE_ADMIN_TOKEN=true`, use a long random `MOODARR_ADMIN_TOKEN`, and keep `MOODARR_ADMIN_AUTO_SESSION=false` for container installs. Browser administrators authenticate through the Admin Access control, which exchanges `{ "token": "..." }` with `POST /api/admin/session` for an HTTP-only, SameSite=Strict admin cookie. Invalid tokens return `401` and no cookie. API clients can continue to send `X-Moodarr-Admin-Token` or `Authorization: Bearer`.

`MOODARR_ADMIN_AUTO_SESSION=true` is a deliberate trusted-LAN convenience mode, not a user login. When enabled, any visitor able to load the bundled UI can receive an admin session. This removes meaningful Plex-user/admin separation, so do not enable it on a network with untrusted clients or non-admin Plex users.

Moodarr's cookies are suitable for its documented LAN HTTP development boundary but do not replace HTTPS. For TLS/reverse-proxy deployments, set `MOODARR_WEB_ORIGIN` to the exact public `https://` origin so Moodarr emits `Secure` session cookies; also validate proxy trust and add external authentication before internet exposure.

## Optional OpenAI Processing

`AI_PROVIDER=none` keeps recommendation processing local. When OpenAI is enabled, Moodarr sends bounded search wording, filters, watch context, candidate metadata, preference examples, query text, and media feature text to OpenAI for parsing, reranking, taste scouting, and embeddings. It does not intentionally send integration credentials or private integration URLs.

Enabling OpenAI is an instance-wide third-party-processing decision. Review [Data And Privacy](docs/DATA_AND_PRIVACY.md) and inform other users before enabling it.

## Data And Deployment Requirements

- Keep `/data` private. It contains SQLite data and can contain saved integration credentials, signed-in-user Plex tokens, user identity, request audits, and feedback/profile history.
- Encrypt and access-control backups; verify restores using [Backup And Recovery](docs/BACKUP_AND_RECOVERY.md).
- Keep the app behind a VPN, external reverse-proxy authentication, or a LAN-only firewall.
- Do not commit `.env`, `/data`, `.data`, screenshots with tokens, or support bundles.
- Disabling a user invalidates their Moodarr sessions and clears their stored Plex token. User deletion/anonymization and configurable audit retention remain separate alpha limitations.
- Generated support bundles and profile exports are sensitive even when known credentials are redacted. Inspect them before sharing.

## Reporting Issues

Report vulnerabilities through GitHub private vulnerability reporting for this repository. Do not open a public issue for security reports, and do not include credentials, private hostnames, library screenshots, user data, or support bundles in public threads.
