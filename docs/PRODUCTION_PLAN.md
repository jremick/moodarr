# Production Plan

Feelerr should behave like a focused Seerr companion rather than a general media dashboard. The production target is a single Unraid-friendly container that reads Plex, reads Seerr/Jellyseerr, ranks watch candidates, and creates requests only after a user-confirmed action.

## Current Production Baseline

- Single Fastify server can serve the built React client when `FEELERR_SERVE_CLIENT=true`.
- Persistent SQLite and JSON config live under `FEELERR_DATA_DIR`.
- Plex, Seerr, OpenAI, and admin tokens remain server-side.
- Admin routes require `FEELERR_ADMIN_TOKEN` when `FEELERR_REQUIRE_ADMIN_TOKEN=true`.
- Scheduled sync runs from the server and can be disabled with `FEELERR_SYNC_INTERVAL_MINUTES=0`.
- Fixture mode still works without Plex or Seerr.

## UI/UX Direction

- Finder is the default screen and stays task-focused: prompt, filters, ranked results, detail panel.
- Results must clearly label source disagreement, especially when Plex and Seerr disagree about availability.
- Admin is an operational surface: connection health, runtime paths, sync controls, integration config, and support bundle.
- Request creation remains a deliberate flow: preview first, then explicit confirmation.
- No client route or generated asset may contain a token.

## Admin Controls

- Configure Plex base URL, Plex Web URL, and Plex token.
- Configure Seerr/Jellyseerr base URL and API key.
- Configure optional AI provider/model/key.
- Toggle fixture mode, Seerr sync, and sync interval.
- Run sync manually and inspect scheduler state.
- Generate a support bundle that masks secrets.

## Security Rules

- Do not expose Plex, Seerr, OpenAI, or admin tokens in API responses, logs, poster URLs, HTML, or client JS.
- Proxy posters through the backend.
- Keep Plex read-only.
- Treat Seerr request creation as the only mutating external action and require explicit confirmation.
- Prefer LAN/VPN/reverse-proxy deployment over public cloud for private Plex and Seerr instances.

## Near-Term Hardening

- Add first-run admin token setup guidance without weakening server-side auth.
- Add per-request audit rows for previews and creates.
- Add background job history to the Admin screen.
- Add granular TV season selection in the detail panel.
- Add an image cache layer for successful poster fetches.
- Publish a private or public GHCR image after repo visibility and release policy are decided.
