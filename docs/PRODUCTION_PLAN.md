# Production Plan

Moodarr should behave like a focused Seerr companion rather than a general media dashboard. The production target is a single Unraid-friendly container that reads Plex, reads Seerr/Jellyseerr, ranks watch candidates, and creates requests only after a user-confirmed action.

## Current Production Baseline

- Single Fastify server can serve the built React client when `MOODARR_SERVE_CLIENT=true`.
- Persistent SQLite and JSON config live under `MOODARR_DATA_DIR`.
- Plex, Seerr, OpenAI, and admin tokens remain server-side.
- Admin routes require `MOODARR_ADMIN_TOKEN` when `MOODARR_REQUIRE_ADMIN_TOKEN=true`.
- Optional Plex sign-in creates local user rows and HTTP-only Moodarr user sessions for Finder and request routes without granting admin access.
- Scheduled sync runs from the server and can be disabled with `MOODARR_SYNC_INTERVAL_MINUTES=0`.
- Fixture mode still works without Plex or Seerr.
- Request preview/create activity is recorded in a local audit table and summarized in the support bundle.
- Successful poster fetches are cached locally and served through the backend proxy.
- Docker runs the compiled server bundle with Node instead of running TypeScript through `tsx`.
- Successful Plex syncs mark items unavailable when Plex no longer reports them.
- Costly routes have bounded request shapes and lightweight per-IP rate limits.

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
- Keep signed-in user Plex tokens server-side for user-scoped Watchlist actions only.
- Toggle fixture mode, Seerr sync, and sync interval.
- Run sync manually and inspect scheduler state.
- Inspect recent sync history.
- Generate a support bundle that masks secrets and includes recommendation/request diagnostics.

## Security Rules

- Do not expose Plex, Seerr, OpenAI, admin, or signed-in user Plex tokens in API responses, logs, poster URLs, HTML, client JS, or support bundles.
- Proxy posters through the backend.
- Keep Plex read-only.
- Treat Seerr request creation as the only mutating external action and require explicit confirmation.
- Prefer LAN/VPN/reverse-proxy deployment over public cloud for private Plex and Seerr instances.

## Remaining Hardening

- Verify Plex app deep links against the actual desktop and mobile Plex clients after the new `plex://play` links are deployed.
- Expand Plex-integrated user management beyond enable/disable if request limits, roles, or per-user history become necessary.
- Keep Moodarr aligned with [seerr-team/seerr](https://github.com/seerr-team/seerr) on Plex user import, first-login behavior, and permissions where those concepts map cleanly to Moodarr.
- Add first-run admin token setup guidance without weakening server-side auth.
- Add background job history to the Admin screen.
- Add granular TV season selection in the detail panel.
- Add fuller Seerr stale-status reconciliation once the exact Jellyseerr/Overseerr request-list semantics are verified.
- Design the larger-catalog recommendation indexing/scoring path so refined-search signals, hard filters, availability filters, and feedback context can rank the full eligible catalog when it exceeds the current bounded local candidate window. Acceptance: synthetic evals above the candidate cap prove strong deterministic matches are not hidden before AI reranking, diagnostics clearly show library/retrieval/scored/rerank counts, and the AI reranker remains bounded to a safe top slice.
- Add external reverse-proxy authentication before any internet-facing deployment.
- Add browser E2E coverage for admin setup, search refinement, and request confirmation.
- Keep GHCR alpha images immutable and publish new tags only after the release gate passes on the exact commit.
