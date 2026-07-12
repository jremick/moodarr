# Security Policy

Moodarr is designed for a trusted LAN or VPN boundary. Do not expose it directly to the public internet unless an external authentication layer, TLS, and rate limiting protect it.

## Supported Versions

The GitHub Releases page is authoritative for the currently published beta. Security fixes are delivered through new protected Git tags, immutable GitHub prereleases, and workflow-append-only GHCR version tags; only the newest published beta is supported, and older images are treated as superseded. Source references to a future version do not activate its support promise before its GitHub prerelease exists.

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

Direct HTTP means anyone able to observe the LAN or VPN path can observe session-bearing traffic. Treat every device and network segment that can reach port 4401 as trusted, or terminate TLS in front of Moodarr. Binding `4401:4401` publishes the service on every host interface by default; use a host firewall, VLAN policy, VPN ACL, or an explicit host-IP port binding to enforce the intended boundary.

The example Compose service runs with a read-only root filesystem, a writable `/data` volume, a bounded 512 MiB `/tmp` tmpfs, no Linux capabilities, `no-new-privileges`, an init process, and PID/CPU/memory limits. The temporary-space ceiling is intentionally large enough for SQLite migrations against production-size databases; shrinking it can make SQLite report `database or disk is full` even when `/data` has free space. Preserve equivalent controls when translating the example to another container manager. `/data` must remain writable for SQLite and saved settings.

## Optional OpenAI Processing

`AI_PROVIDER=none` keeps recommendation processing local. When OpenAI is enabled, Moodarr sends bounded search wording, filters, watch context, candidate metadata, preference examples, query text, and media feature text to OpenAI for parsing, reranking, taste scouting, and embeddings. It does not intentionally send integration credentials or private integration URLs.

Enabling OpenAI is an instance-wide third-party-processing decision. Review [Data And Privacy](docs/DATA_AND_PRIVACY.md) and inform other users before enabling it.

## Data And Deployment Requirements

- Keep `/data` private. It contains SQLite data and can contain saved integration credentials, signed-in-user Plex tokens, user identity, request audits, and feedback/profile history.
- Encrypt and access-control backups; verify restores using [Backup And Recovery](docs/BACKUP_AND_RECOVERY.md).
- Keep the app behind a VPN, external reverse-proxy authentication, or a LAN-only firewall.
- Do not commit `.env`, `/data`, `.data`, screenshots with tokens, or support bundles.
- Disabling a user invalidates their Moodarr sessions and clears their stored Plex token. User deletion/anonymization and configurable audit retention remain separate beta limitations.
- Generated support bundles and profile exports are sensitive even when known credentials are redacted. Inspect them before sharing.

## Supply Chain And Scanner Exceptions

CI runs CodeQL for JavaScript/TypeScript. A separate weekly check audits the lockfile and scans the built runtime image for high and critical findings. The scan reports every unsuppressed finding and fails on high or critical findings for which the scanner identifies an available fix; unpatched base-image findings remain visible for base-refresh or image-minimization review. Release images are built by the pinned, default-branch-owned manual promotion workflow with an SBOM, provenance, and a GitHub artifact attestation bound to the candidate source commit. Version tags are protected by a `v*` ruleset, published GitHub releases are immutable, and the workflow refuses existing GHCR tags and verifies promotion read-back. Because GHCR tag creation is not atomic against a separate privileged writer, package-write access must remain restricted and deployments should record and prefer the immutable image digest.

The checked-in [OpenVEX document](.vex/moodarr.openvex.json) covers only version-specific findings whose vulnerable code is present in the base image but not in Moodarr's execution path. Each statement records the package, vulnerability, justification, and impact evidence. It must be reviewed whenever the base image, Node.js, npm, entrypoint, or server process model changes. Do not add an exception merely because no upstream fix exists, and do not use VEX to suppress an uninvestigated finding.

The OpenVEX statement list is currently empty because the pinned distroless candidate has no Trivy-reported high or critical findings to suppress. The runtime does not include npm, Corepack, Yarn, a shell, or general-purpose package-management tools; the server starts directly with Node.js. Keep any future VEX statement narrow, version-specific, and backed by execution-path evidence.

## Reporting Issues

Report vulnerabilities through GitHub private vulnerability reporting for this repository. Do not open a public issue for security reports, and do not include credentials, private hostnames, library screenshots, user data, or support bundles in public threads.
