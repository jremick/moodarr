# Security Policy

Moodarr is designed for a trusted LAN or VPN boundary. Do not expose it directly to the public internet unless you add external authentication and rate limiting in front of it.

## Supported Boundary

- Plex, Seerr/Jellyseerr, OpenAI, and admin tokens stay server-side.
- Poster images are proxied by the backend so Plex tokens are not placed in browser URLs.
- Plex access is read-only.
- Optional Plex sign-in stores local user identity and a hashed Moodarr session token; it does not store Plex user access tokens.
- Native clients may opt into receiving a Moodarr user session token for platform secure storage. It is a Finder user credential, not an admin credential, and it maps to the same hashed server-side session store.
- Seerr request creation requires explicit confirmation.
- Containers default to admin authentication when `NODE_ENV=production`.
- When admin auth is enabled, private catalog reads, search, posters, request previews, and request creation require either the admin token/session or a Plex user session when Plex sign-in is enabled. Admin writes, diagnostics, sync controls, and user management require the admin token/session. `/api/health`, public config status, and Plex sign-in start/complete routes remain unauthenticated for setup and login flow.

## Deployment Requirements

- Set `MOODARR_REQUIRE_ADMIN_TOKEN=true` and a long random `MOODARR_ADMIN_TOKEN` for any container install.
- Keep `/data` private. It contains SQLite data and may contain saved Plex, Seerr, and OpenAI credentials in `config.json`.
- Put the app behind a VPN, reverse proxy auth, or LAN-only firewall.
- Do not commit `.env`, `/data`, `.data`, screenshots with tokens, or support bundles.

## Reporting Issues

Report vulnerabilities through GitHub private vulnerability reporting for this repository. Do not open a public issue for security reports, and do not include Plex, Seerr, OpenAI, admin tokens, private hostnames, screenshots with secrets, or support bundles in public threads.
