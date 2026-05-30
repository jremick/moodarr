# Production Plan

Feelarr should behave like a focused Seerr companion rather than a general media dashboard. The production target is a single Unraid-friendly container that reads Plex, reads Seerr/Jellyseerr, ranks watch candidates, and creates requests only after a user-confirmed action.

## Current Production Baseline

- Single Fastify server can serve the built React client when `FEELERR_SERVE_CLIENT=true`.
- Persistent SQLite and JSON config live under `FEELERR_DATA_DIR`.
- Plex, Seerr, OpenAI, and admin tokens remain server-side.
- Admin routes require `FEELERR_ADMIN_TOKEN` when `FEELERR_REQUIRE_ADMIN_TOKEN=true`.
- Scheduled sync runs from the server and can be disabled with `FEELERR_SYNC_INTERVAL_MINUTES=0`.
- Fixture mode still works without Plex or Seerr.
- Request preview/create activity is recorded in a local audit table and summarized in the support bundle.
- Successful poster fetches are cached locally and served through the backend proxy.
- Docker runs the compiled server bundle with Node instead of running TypeScript through `tsx`.

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
- Inspect recent sync history.
- Generate a support bundle that masks secrets and includes recommendation/request diagnostics.

## Security Rules

- Do not expose Plex, Seerr, OpenAI, or admin tokens in API responses, logs, poster URLs, HTML, or client JS.
- Proxy posters through the backend.
- Keep Plex read-only.
- Treat Seerr request creation as the only mutating external action and require explicit confirmation.
- Prefer LAN/VPN/reverse-proxy deployment over public cloud for private Plex and Seerr instances.

## Remaining Hardening

- Add first-run admin token setup guidance without weakening server-side auth.
- Add background job history to the Admin screen.
- Add granular TV season selection in the detail panel.
- Add stale Plex/Seerr reconciliation so deleted items and changed request states cannot remain cached forever.
- Add rate limiting before any internet-facing deployment.
- Add browser E2E coverage for admin setup, search refinement, and request confirmation.
- Publish a private or public GHCR image after repo visibility and release policy are decided.
