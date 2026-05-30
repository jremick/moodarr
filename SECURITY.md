# Security Policy

Feelarr is designed for a trusted LAN or VPN boundary. Do not expose it directly to the public internet unless you add external authentication and rate limiting in front of it.

## Supported Boundary

- Plex, Seerr/Jellyseerr, OpenAI, and admin tokens stay server-side.
- Poster images are proxied by the backend so Plex tokens are not placed in browser URLs.
- Plex access is read-only.
- Seerr request creation requires explicit confirmation.
- Containers default to admin authentication when `NODE_ENV=production`.
- When admin auth is enabled, private catalog reads, search, posters, request previews, admin writes, and request creation require the admin token. `/api/health` and public config status remain unauthenticated for setup/health checks.

## Deployment Requirements

- Set `FEELERR_REQUIRE_ADMIN_TOKEN=true` and a long random `FEELERR_ADMIN_TOKEN` for any container install.
- Keep `/data` private. It contains SQLite data and may contain saved Plex, Seerr, and OpenAI credentials in `config.json`.
- Put the app behind a VPN, reverse proxy auth, or LAN-only firewall.
- Do not commit `.env`, `/data`, `.data`, screenshots with tokens, or support bundles.

## Reporting Issues

Before the repository is public, report security issues privately to the repository owner. After publication, use GitHub private vulnerability reporting if enabled.
