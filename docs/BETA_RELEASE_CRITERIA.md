# Public Beta Release Criteria

This is the release gate for `v0.1.0-beta.1`. It is a planning and evidence document; its presence does not mean the beta gate has passed.

The target is **Stage 3 - Public Beta**: external self-hosters can install, operate, upgrade, and report problems with clear expectations. It is not the stable `v1.0.0` contract. Stable API, longer deprecation, wider platform, and mature native-client commitments remain later work.

## Beta Product Contract

Beta.1 includes:

- the Moodarr web client and server as one self-hosted container;
- Linux `amd64` Docker, Docker Compose v2, and Unraid deployment paths;
- Plex library sync, Plex-user sign-in, poster proxying, links, and documented Watchlist actions;
- Seerr/Jellyseerr request-state sync, request preview, and explicitly confirmed request creation;
- deterministic local MoodRank search with `AI_PROVIDER=none` as the default;
- optional server-side OpenAI processing with bounded failure fallback;
- admin authentication, user capabilities, support diagnostics, migration, backup, and rollback guidance; and
- private LAN/VPN use or an exact-origin HTTPS reverse proxy.

The beta compatibility surfaces are defined in [Compatibility](COMPATIBILITY.md). Except for the documented health semantics, the HTTP API is internal and does not become a stable third-party API in beta.

## Release Blockers

Every row must pass or have an explicit, public, maintainer-approved exception in the release notes. An undocumented exception is a failed gate.

| Gate | Required evidence |
| --- | --- |
| Source and release identity | The tag points to a commit reachable from the default branch. Package version, changelog, installation docs, Compose/Unraid references, image labels, image digest, SBOM, provenance, and attestation identify the same release. |
| Default-branch quality | `npm run verify:release` passes from a clean checkout. Default-branch CI and CodeQL are green. No P0/P1 application defect remains open. |
| Clean Docker install | A new Linux `amd64` host or VM pulls the official image, starts with a new `/data`, completes Admin setup, connects integrations, syncs, searches, loads posters, and restarts without losing state. |
| Clean Compose install | `docker-compose.example.yml` is followed from a clean directory with only documented substitutions. Health, persistence, hardening, and core flows pass. |
| Unraid install | The checked-in Unraid template or a faithful clean template install passes on an exact recorded Unraid version. Appdata persistence, origin handling, resource limits, and updates are verified. |
| Supported upgrades | Direct upgrades from alpha.21 and alpha.22, when published, pass against representative backed-up data. Schema migration, counts, configuration, users, request audits, profiles, deterministic search, posters, and `PRAGMA integrity_check` are verified. |
| Rollback | The pre-upgrade backup restores into an empty path and the prior immutable image starts against it. No older image is tested against the migrated database. |
| Core integration behavior | Exact Plex and Seerr/Jellyseerr versions are recorded. Sync, Plex authentication, user capability defaults, Watchlist action, request preview, one controlled confirmed request, idempotent retry, and uncertain-outcome handling pass. |
| AI-off baseline | All primary search and request flows work with `AI_PROVIDER=none`; no OpenAI credential is required for install, sync, search, or request creation. |
| Optional AI boundary | Tests cover timeouts, malformed responses, rate limits, and fallback. One controlled OpenAI smoke test is recorded when credentials are available, without making CI depend on a live provider. Privacy documentation matches the actual fields sent. |
| Responsiveness | On the documented two-CPU/2-GiB container budget and a recorded production-sized catalog, health p99 stays at or below 250 ms during full sync, embedding maintenance, and diagnostics. Deterministic search p95 stays at or below 5 seconds. There are no search 5xx, `SQLITE_BUSY` failures, health-check failures, restarts, or OOM events. |
| Browser and accessibility smoke | The exact Chrome/Edge, Firefox, and Safari versions in the supported matrix complete sign-in, search, result actions, request confirmation, Admin access, keyboard navigation, focus, and responsive mobile-width checks without console errors. |
| Security boundary | Admin auto-session is off by default in release packaging. Authentication, authorization, CSRF, SSRF/redirect, input-bound, session invalidation, secret-redaction, and request-confirmation tests pass. A tracked/generated secret scan passes. |
| Supply chain | The lockfile audit and built-image scan have no untriaged fixable high/critical finding. Actions and base images are immutable where supported, workflow permissions are least-privilege, and the published artifact can be verified by digest and attestation. |
| Data safety | Fresh, upgrade, interrupted-start, and restart tests preserve `/data`. Backup/restore instructions are followed successfully. No migration or sync failure silently marks incomplete data unavailable. |
| Public contract | [Support](../SUPPORT.md), [Security](../SECURITY.md), [Compatibility](COMPATIBILITY.md), [Upgrading](UPGRADING.md), [Backup And Recovery](BACKUP_AND_RECOVERY.md), [Data And Privacy](DATA_AND_PRIVACY.md), [Contributing](../CONTRIBUTING.md), [Changelog](../CHANGELOG.md), and [Release](RELEASE.md) are current and linked from the public entry points. |

## Severity And Exception Rules

- **P0:** credential exposure, destructive data loss, unauthorized external write, or broadly exploitable remote compromise. Never release.
- **P1:** authentication/authorization bypass, incorrect request creation, migration/restore failure, unusable clean install, persistent crash/OOM, or a primary workflow failure without a safe fallback. Never release.
- **P2:** meaningful defect with a documented workaround or bounded unsupported configuration. Release only after an explicit maintainer decision and public known-limitation entry.
- Cosmetic and low-impact issues may be deferred when they do not undermine installation, safety, accessibility of primary flows, or the documented compatibility contract.

Release exceptions must name the affected configuration, user impact, workaround, owner, and intended follow-up. Security scanner exceptions require evidence and must remain visible; lack of an upstream fix is not sufficient by itself.

## Non-Goals For Beta.1

These do not block the web/server beta unless a change regresses an already documented behavior:

- stable or TestFlight-ready iOS support;
- Linux `arm64`, Windows containers, Kubernetes, or multi-replica operation;
- direct public-internet hosting, bundled TLS, or a bundled reverse proxy;
- automated off-site backup hosting or key custody;
- a stable third-party HTTP API or public SQLite schema;
- support for every Plex, Seerr-family, browser, or reverse-proxy version;
- per-user AI billing or token budgets beyond bounded access and safe fallback;
- vector-database infrastructure or distributed job queues; and
- perfect or universal recommendation quality.

The experimental iOS client remains visible but must be labeled non-blocking and outside the beta support contract.

## Release Evidence Ledger

Create one ledger per release candidate in the release PR or a dated copy of this table. Link durable CI runs, artifacts, logs, screenshots, benchmark summaries, and restore records rather than pasting secrets or private data.

| Candidate metadata | Value |
| --- | --- |
| Candidate | `v0.1.0-beta.1` |
| Commit | `________________` |
| Image digest | `Post-publication: sha256:________________` |
| Validation date | `________________` |
| Release owner | `________________` |

| Evidence | Phase | Status | Reference and exact environment |
| --- | --- | --- | --- |
| Clean-checkout `verify:release` | Pre-publish | Pending | |
| Default-branch CI and CodeQL | Pre-publish | Pending | |
| Docker clean install | Pre-publish | Pending | |
| Compose clean install | Pre-publish | Pending | |
| Unraid clean install | Pre-publish | Pending | |
| Alpha.21 direct upgrade | Pre-publish | Pending | |
| Alpha.22 direct upgrade or not-applicable rationale | Pre-publish | Pending | |
| Cold restore and rollback | Pre-publish | Pending | |
| Plex integration matrix | Pre-publish | Pending | |
| Seerr/Jellyseerr integration matrix | Pre-publish | Pending | |
| AI-off end-to-end flow | Pre-publish | Pending | |
| Optional AI failure and smoke evidence | Pre-publish | Pending | |
| Production-sized responsiveness benchmark | Pre-publish | Pending | |
| Browser/accessibility matrix | Pre-publish | Pending | |
| Security regression suite and secret scans | Pre-publish | Pending | |
| Dependency/image scan triage | Pre-publish | Pending | |
| Public-document link and claim check | Pre-publish | Pending | |
| Independent release-diff review | Pre-publish | Pending | |
| Published digest, SBOM, provenance, and attestation read-back | Post-publish | Pending | |

Allowed statuses are `Pending`, `Passed`, `Failed`, `Not applicable`, and `Exception approved`. `Not applicable` and `Exception approved` require a written rationale and maintainer sign-off.

Every `Pre-publish` row must pass before the protected artifact workflow is authorized. The `Post-publish` row can exist only after that workflow completes and must pass before the GitHub prerelease is promoted or announced.

## Promotion Decision

Promotion has two explicit decisions so the source commit does not need to contain evidence that can exist only after publication:

1. **Approve artifact publication.** Complete every pre-publication ledger row, resolve or approve every exception, confirm the release tag points at the reviewed default-branch commit, and manually authorize the protected publish workflow.
2. **Approve public beta promotion.** After the workflow publishes the immutable GHCR artifact, read back and verify its digest, SBOM, provenance, and attestation. Only then create or update the GitHub prerelease with the verified digest, beta support boundary, and known limitations in user-facing language.

Failure of the post-publication verification step stops the GitHub prerelease promotion. Do not advertise the artifact as the beta release until that evidence passes.

Promotion to `v1.0.0` requires a separate stable-release gate based on real beta feedback, repeatable maintenance/release cadence, declared stable compatibility and deprecation policy, and closure of the v1 product requirements. Passing this document alone is intentionally insufficient for v1.
