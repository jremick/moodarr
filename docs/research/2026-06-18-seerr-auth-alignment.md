# Seerr Auth And User Management Alignment

Date: 2026-06-18
Status: Research refreshed against upstream Seerr docs, API spec, code, releases, and security advisories.

## Research Question

How closely should Moodarr follow [seerr-team/seerr](https://github.com/seerr-team/seerr) for Plex-integrated authentication and user management, and what upstream behavior should shape the next Moodarr auth roadmap?

## Source Summary

- [Seerr README](https://github.com/seerr-team/seerr): Seerr positions full Jellyfin, Emby, and Plex integration, including authentication, user import, and user management, as a core feature.
- [Adding Users](https://docs.seerr.dev/using-seerr/users/adding-users/): Seerr supports importing media-server users and allowing first-login account creation for Plex users with access to the configured server.
- [User Settings](https://docs.seerr.dev/using-seerr/settings/users/): Seerr exposes toggles for local sign-in, media-server sign-in, new media-server sign-ins, global request limits, and default permissions.
- [Editing Users](https://docs.seerr.dev/using-seerr/users/editing-users/): Seerr supports per-user request limit overrides and permission editing by users with Manage Users permission.
- [Plex Features Overview](https://docs.seerr.dev/using-seerr/plex/): Plex features require Plex login, access to the configured Plex server, and the right Seerr permissions.
- [Seerr API spec](https://github.com/seerr-team/seerr/blob/develop/seerr-api.yml): Seerr supports cookie auth from `/auth/plex` or `/auth/local`, plus `X-Api-Key` service auth.
- [Seerr auth route](https://github.com/seerr-team/seerr/blob/develop/server/routes/auth.ts): Plex login verifies Plex account access to the configured server before creating or updating a Seerr user.
- [Seerr auth middleware](https://github.com/seerr-team/seerr/blob/develop/server/middleware/auth.ts): API-key requests can act as the original admin user, or as another user when `X-API-User` is provided.
- [Seerr permissions](https://github.com/seerr-team/seerr/blob/develop/server/lib/permissions.ts): Seerr uses a bitmask permission model covering admin, user management, requests, auto-approval, issues, watchlists, and blocklists.
- [Seerr v3.1.0 release](https://github.com/seerr-team/seerr/releases/tag/v3.1.0): Fixed auth and authorization vulnerabilities affecting user creation and profile data exposure.
- [CVE-2026-27707 / GHSA-rc4w-7m3r-c2f7](https://github.com/seerr-team/seerr/security/advisories/GHSA-rc4w-7m3r-c2f7): A cross-provider auth guard flaw let attackers create accounts on Plex-configured deployments through the Jellyfin endpoint before v3.1.0.
- [CVE-2026-27793](https://nvd.nist.gov/vuln/detail/CVE-2026-27793): A user profile endpoint leaked sensitive third-party notification credentials to authenticated users before v3.1.0.
- [Seerr v3.3.0 release](https://github.com/seerr-team/seerr/releases/tag/v3.3.0): Latest observed release as of this research pass was v3.3.0 on 2026-06-02.
- [OIDC PR #2715](https://github.com/seerr-team/seerr/pull/2715): OpenID Connect support is active upstream work, but it is not yet a stable released baseline.

## Key Findings

Seerr's Plex auth model is the right reference shape for Moodarr's near-term auth:

- Plex is an identity provider, not just a link target.
- The signed-in Plex account must have access to the configured Plex server.
- First-login account creation is useful, but must be controlled by an admin setting.
- A local user row is still valuable even when identity comes from Plex, because admins need visibility, disable controls, and future policy hooks.

Seerr's full account model is broader than Moodarr needs right now:

- Seerr supports local users/passwords; Moodarr does not currently need local password auth.
- Seerr stores per-user permissions, request quotas, notification settings, and linked media-server identity fields; Moodarr's current user-facing scope is Finder, item reads, feedback, request preview, and request creation.
- Seerr stores Plex tokens on user records for deeper Plex features; Moodarr should continue avoiding storage of user Plex tokens unless a future feature needs per-user Plex operations such as watchlist sync.

Seerr's security history is directly relevant:

- Provider-specific auth endpoints must reject all requests when the configured provider does not match the endpoint.
- User responses should be explicit allowlists. Do not return full settings blobs or provider tokens to ordinary users.
- First-login account creation is convenient, but it expands the blast radius when an auth guard is wrong.
- Request creation has downstream effects in Radarr/Sonarr, so authenticated user access should be treated as meaningful capability, not a harmless read-only session.

Seerr's API model matters for request attribution:

- Moodarr currently uses Seerr service API-key access for sync/search/request creation.
- Seerr middleware supports `X-API-User`, which means a future Moodarr-Seerr integration could attribute requests to a matching Seerr user instead of the default admin/service user.
- To do that cleanly, Moodarr would need a reliable mapping from Moodarr Plex users to Seerr user IDs, probably by importing/listing Seerr users and matching on Plex identity or email. That should not be added until request attribution is a real user requirement.

OIDC is worth watching, not adopting yet:

- Upstream Seerr has active OIDC work in PR #2715, including provider login, account linking, and provider-level first-login creation.
- The PR is open and not part of the latest stable release observed in this pass, so Moodarr should not treat Seerr OIDC as a stable alignment target yet.
- If Moodarr becomes internet-facing, a reverse proxy or OIDC perimeter should be evaluated independently of Plex auth.

## Moodarr Alignment Decision

Moodarr should align with Seerr on the narrow Plex identity pattern, not the full Seerr account model:

- Keep Plex sign-in optional and disabled by default.
- Verify the Plex account through plex.tv.
- Verify the Plex account can access the configured Plex server before creating a Moodarr session.
- Store a local Moodarr user row for admin visibility and enable/disable control.
- Store only a hashed Moodarr session token. Do not store Plex user access tokens.
- Keep admin settings, diagnostics, sync controls, Seerr/Plex connection tests, review queues, and user management behind the existing admin boundary.
- Keep non-admin Plex sessions limited to user-facing actions until there is demand for roles, quotas, moderation, or attribution.

This matches the implemented Moodarr direction and intentionally stops short of copying Seerr's local users, password reset flow, permission bitmask, notification settings, or per-user request quotas.

## Recommended Roadmap

### Now

- Keep the current Moodarr Plex auth surface narrow: sign in, local user row, enabled flag, hashed session.
- Add regression tests that each auth provider path only works when that provider is configured. Moodarr currently has only Plex auth, but this protects future OIDC or reverse-proxy auth work.
- Keep user API responses allowlisted and continue testing that Plex tokens, Seerr keys, and admin secrets never appear in client responses or built assets.

### Soon

- Add a small admin affordance for "disable new Plex sign-ins after first setup" once the desired user list exists.
- Record request creator context locally when a signed-in Plex user creates a Moodarr request, even if Seerr still receives the service API key.
- Evaluate a Seerr user import/mapping path only if request attribution becomes important. The candidate design is: fetch Seerr users with the API key, match by Plex identity/email, store optional `seerrUserId`, and send `X-API-User` when creating requests.

### Later

- Consider a minimal Moodarr permission model only if concrete workflows require it. The first likely split is not Seerr's full bitmask; it is probably `canRequest`, `canUseAi`, and `disabled`.
- Revisit OIDC after Seerr merges and releases stable OIDC support, or earlier if Moodarr is exposed beyond a trusted home network.
- Revisit per-user quotas only if Moodarr itself becomes a shared request portal rather than a personal finder/request surface.

## Open Questions

- Should Moodarr default `allowNewPlexUsers` to true for homelab convenience, or should production/public templates override it to false?
- Should Moodarr store a local request creator user ID now, before Seerr user attribution exists?
- Is matching Moodarr users to Seerr users by email acceptable, or should mapping require a Seerr user record with a Plex-linked identity?
- Should the Unraid template expose Plex sign-in and "allow new users" as first-class config fields, or keep them admin-UI only for now?
