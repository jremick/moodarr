# Production Plan

Moodarr should behave like a focused Seerr companion rather than a general media dashboard. The production target is a single Unraid-friendly container that reads Plex, reads Seerr/Jellyseerr, ranks watch candidates, and creates requests only after a user-confirmed action.

## Current Production Baseline

- Single Fastify server can serve the built React client when `MOODARR_SERVE_CLIENT=true`.
- Persistent SQLite and JSON config live under `MOODARR_DATA_DIR`.
- Plex, Seerr, admin, and any legacy/source provider tokens remain server-side.
- Admin routes require `MOODARR_ADMIN_TOKEN` when `MOODARR_REQUIRE_ADMIN_TOKEN=true`.
- Packaged installs default `MOODARR_ADMIN_AUTO_SESSION=false`; browser administrators exchange the token for an HTTP-only session instead of receiving admin access merely by loading the UI.
- Optional Plex sign-in creates local user rows and HTTP-only Moodarr user sessions for Finder and request routes without granting admin access.
- Scheduled sync runs from the server and can be disabled with `MOODARR_SYNC_INTERVAL_MINUTES=0`.
- Fixture mode still works without Plex or Seerr.
- Request preview/create activity is recorded in a local audit table and summarized in the support bundle.
- Successful poster fetches are cached locally and served through the backend proxy.
- Docker runs the compiled server bundle with Node instead of running TypeScript through `tsx`.
- Successful Plex syncs mark items unavailable when Plex no longer reports them.
- Costly routes have bounded request shapes and lightweight per-IP rate limits.
- Published images report their package version and verified commit revision through runtime health/support metadata.

## UI/UX Direction

- Finder is the default screen and stays task-focused: prompt, filters, ranked results, detail panel.
- Results must clearly label source disagreement, especially when Plex and Seerr disagree about availability.
- Admin is an operational surface: connection health, runtime paths, sync controls, integration config, and support bundle.
- Request creation remains a deliberate flow: preview first, then explicit confirmation.
- No client route or generated asset may contain a token.

## Admin Controls

- Configure Plex base URL, Plex Web URL, and Plex token.
- Configure Seerr/Jellyseerr base URL and API key.
- Show the official beta provider lock and allow deletion of an inert key retained from a source/EXP build; configurable provider controls remain development-only.
- Keep signed-in user Plex tokens server-side for user-scoped Watchlist actions only; disabling or revoking a user should clear the stored token as well as their sessions.
- Toggle fixture mode, Seerr sync, and sync interval.
- Run sync manually and inspect scheduler state.
- Inspect recent sync history.
- Generate a support bundle that masks secrets and includes recommendation/request diagnostics.

## Security Rules

- Do not expose Plex, Seerr, admin, signed-in user Plex, or any legacy/source provider tokens in API responses, logs, poster URLs, HTML, client JS, or support bundles.
- Proxy posters through the backend.
- Keep Plex library/catalog integration read-only. Treat Watchlist as a separate explicit signed-in-user Plex write.
- Treat Seerr request creation as a mutating external action and require explicit preview plus user confirmation.
- Prefer LAN/VPN/reverse-proxy deployment over public cloud for private Plex and Seerr instances.
- Keep the official beta server bundle and packaging provider-locked; any future provider release needs a separate privacy, authority, artifact, and support gate.
- Keep explicit admin authentication separate from Plex-user access. Auto-session is only acceptable when every visitor on the network is intentionally an administrator.

## Remaining Hardening

- Verify Plex app deep links against the actual desktop and mobile Plex clients after the new `plex://play` links are deployed.
- Add request quotas, fuller per-user history, and deletion/retention controls before broader multi-user use. Request capability controls exist, and disabling a user revokes sessions plus the stored Plex token.
- Keep authenticated `solo` recommendation sessions, feedback, and profiles user-scoped. Group context is intentionally shared and should be labeled accordingly before named group profiles exist.
- Keep Moodarr aligned with [seerr-team/seerr](https://github.com/seerr-team/seerr) on Plex user import, first-login behavior, and permissions where those concepts map cleanly to Moodarr.
- Add first-run admin token setup guidance without weakening server-side auth.
- Add background job history to the Admin screen.
- Add granular TV season selection in the detail panel.
- Keep Seerr reconciliation conservative: stale or uncertain create attempts refresh upstream request state, recover only a confirmed request, and otherwise remain explicitly uncertain without an automatic resend. Expand status mapping only when the exact Seerr request-list semantics are verified.
- Ship the next major MoodRank assessability release around trace-first instrumentation, richer evals, guardrail shadow/parity, adaptive retrieval shadow mode, rerank v2 planning, exposure-aware feedback logging, and later offline affect enrichment. Acceptance: [MoodRank Next Improvement Release Plan](MOODRANK_NEXT_RELEASE_PLAN.md) gates pass, local release and MoodRank eval output is recorded, live double-testing shows no availability or hard-filter regression, and rollback to the previous image/tag is ready before deployment.
- Design the larger-catalog recommendation indexing/scoring path so refined-search signals, hard filters, availability filters, and feedback context can rank the full eligible catalog when it exceeds the current bounded local candidate window. Acceptance: synthetic evals above the candidate cap prove strong deterministic matches are not hidden before AI reranking, diagnostics clearly show library/retrieval/scored/rerank counts, and the AI reranker remains bounded to a safe top slice.
- Add external reverse-proxy authentication before any internet-facing deployment.
- Add browser E2E coverage for admin setup, search refinement, and request confirmation.
- Add macOS CI for Swift tests, an iOS app build, and cross-language API contract fixtures; native verification remains local in the current release gate.
- Add an automated encrypted backup job only after the storage target and retention policy are deployment-configurable; until then use and restore-test the cold-backup runbook.
- Treat GHCR prerelease tags as workflow-append-only, record their immutable image digests, and publish new tags only after the release gate passes on the exact commit.
