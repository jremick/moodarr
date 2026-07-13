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
| Source and release identity | Candidate publication uses the current default-branch HEAD so its attestation source digest matches the built commit; the later protected tag points to that same commit. Package version, changelog, installation docs, Compose/Unraid references, image labels, image digest, SBOM, provenance, and attestation identify the same release. |
| Default-branch quality | `npm run verify:release` passes from a clean checkout. Default-branch CI and CodeQL are green. No P0/P1 application defect remains open. |
| Clean Docker install | A new Linux `amd64` host or VM pulls the official image, starts with a new `/data`, completes Admin setup, connects integrations, syncs, searches, loads posters, and restarts without losing state. |
| Clean Compose install | `docker-compose.example.yml` is followed from a clean directory with only documented substitutions. Health, persistence, hardening, and core flows pass. |
| Unraid install | The checked-in Unraid template or a faithful clean template install passes on an exact recorded Unraid version. Appdata persistence, origin handling, resource limits, and updates are verified. |
| Supported upgrades | Direct upgrades from alpha.21 and alpha.22, when published, pass against representative backed-up data. Schema migration, counts, configuration, users, request audits, profiles, deterministic search, posters, and `PRAGMA integrity_check` are verified. |
| Rollback | The pre-upgrade backup restores into an empty path and the prior recorded image digest starts against it. No older image is tested against the migrated database. |
| Core integration behavior | Exact Plex and Seerr/Jellyseerr versions are recorded. Sync, Plex authentication, user capability defaults, Watchlist action, request preview, one controlled confirmed request, idempotent retry, and uncertain-outcome handling pass. |
| AI-off baseline | All primary search and request flows work with `AI_PROVIDER=none`; no OpenAI credential is required for install, sync, search, or request creation. |
| Optional AI boundary | Tests cover timeouts, malformed responses, rate limits, and fallback. One controlled OpenAI smoke test is recorded when credentials are available, without making CI depend on a live provider. Privacy documentation matches the actual fields sent. |
| Responsiveness | On the documented two-CPU/2-GiB container budget and a recorded production-sized catalog, health p99 stays at or below 250 ms during full sync, embedding maintenance, and diagnostics. Deterministic search p95 stays at or below 5 seconds. There are no search 5xx, `SQLITE_BUSY` failures, health-check failures, restarts, or OOM events. |
| Browser and accessibility smoke | The exact Chrome/Edge, Firefox, and Safari versions in the supported matrix complete sign-in, search, result actions, request confirmation, Admin access, keyboard navigation, focus, and responsive mobile-width checks without console errors. |
| Security boundary | Admin auto-session is off by default in release packaging. Authentication, authorization, CSRF, SSRF/redirect, input-bound, session invalidation, secret-redaction, and request-confirmation tests pass. A tracked/generated secret scan passes. |
| Supply chain | The lockfile audit and built-image scan have no untriaged fixable high/critical finding. Actions and base images are immutable where supported, workflow permissions are least-privilege, and the published artifact can be verified by digest and attestation. |
| Repository content rights | The release tree and distributed artifacts contain only project-owned or compatibly licensed content. Third-party artwork reachable through historical public tags or Git history has a documented rights basis, approved remediation, or an explicit maintainer legal-risk decision. |
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

Create one ledger per release candidate in the release PR or release issue. Link durable CI runs, artifacts, logs, screenshots, benchmark summaries, and restore records rather than pasting secrets or private data. After the candidate is published, update that ledger without committing changes to the frozen candidate source; a source edit would require a new SHA candidate.

| Candidate metadata | Value |
| --- | --- |
| Candidate | `v0.1.0-beta.1` |
| Commit | `________________` |
| Full-SHA candidate | `ghcr.io/jremick/moodarr:sha-________________________________________` |
| Validated image digest | `sha256:________________________________________________________________` |
| Validation date | `________________` |
| Release owner | `________________` |

| Evidence | Phase | Status | Reference and exact environment |
| --- | --- | --- | --- |
| Clean-checkout `verify:release` | Pre-candidate | Pending | |
| Default-branch CI and CodeQL | Pre-candidate | Pending | |
| Security regression suite and secret scans | Pre-candidate | Pending | |
| Dependency/image scan triage | Pre-candidate | Pending | |
| Public-document link and claim check | Pre-candidate | Pending | |
| Independent release-diff review | Pre-candidate | Pending | |
| GHCR package-writer access review | Pre-candidate | Pending | |
| Historical artwork rights or remediation decision | Pre-candidate | Pending | |
| Docker clean install from candidate digest | Candidate validation | Pending | |
| Compose clean install from candidate digest | Candidate validation | Pending | |
| Unraid clean install from candidate digest | Candidate validation | Pending | |
| Alpha.21 direct upgrade using candidate digest | Candidate validation | Pending | |
| Alpha.22 direct upgrade or not-applicable rationale | Candidate validation | Not applicable | No alpha.22 was published before the beta candidate freeze. Reopen and validate this path if that changes before candidate publication. |
| Cold restore and rollback | Candidate validation | Pending | |
| Plex integration matrix | Candidate validation | Pending | |
| Seerr/Jellyseerr integration matrix | Candidate validation | Pending | |
| AI-off end-to-end flow | Candidate validation | Pending | |
| Optional AI failure and smoke evidence | Candidate validation | Pending | |
| Production-sized responsiveness benchmark | Candidate validation | Pending | |
| Browser/accessibility matrix | Candidate validation | Pending | |
| Candidate digest, SBOM, provenance, and attestation read-back | Candidate validation | Pending | |
| Protected semantic Git tag resolves to candidate commit | Pre-promotion | Pending | |
| Version tag equals validated candidate digest, with attestation read-back | Post-promotion | Pending | |

Allowed statuses are `Pending`, `Passed`, `Failed`, `Not applicable`, and `Exception approved`. `Not applicable` and `Exception approved` require a written rationale and maintainer sign-off.

Every `Pre-candidate` row must pass before the full-SHA candidate workflow is authorized. Every `Candidate validation` and `Pre-promotion` row must pass against the published candidate digest before semantic promotion is authorized. `Post-promotion` must pass before the GitHub prerelease is created or announced.

## Promotion Decision

Promotion has four explicit decisions so the source commit does not need to contain evidence that can exist only after candidate publication:

1. **Approve candidate publication.** Complete every pre-candidate ledger row, resolve or approve every exception, confirm the full SHA is the reviewed current default-branch HEAD at dispatch, and manually publish only its `sha-<full-sha>` candidate tag. No semantic Git or image tag is required at this stage.
2. **Validate the published candidate.** Pull the candidate by digest and complete every candidate-validation row, including clean Docker, Compose, and Unraid paths plus digest, SBOM, provenance, and attestation read-back. A failed candidate is abandoned; the workflow refuses to overwrite its tag and requires a new source commit.
3. **Approve semantic promotion.** Create the protected semantic Git tag at the exact validated commit, then dispatch the workflow with that tag and the ledger's exact candidate digest. The workflow must add the version tag to the same manifest bytes without rebuilding and read back both identities at the same digest.
4. **Approve public announcement.** Verify the version tag's digest and attestation once more, then create the immutable GitHub prerelease with the verified digest, beta support boundary, and known limitations in user-facing language.

Failure at any stage stops the next decision. Do not advertise the SHA candidate as the beta release, and do not create the GitHub prerelease until post-promotion evidence passes.

GHCR tag creation is not an atomic create-only operation. The workflow checks that the version tag is absent immediately before promotion and then verifies the final digest, but a separately authorized package writer could still race that request. Keep package-write access restricted, do not push release tags outside the workflow, and treat any unexpected final digest as a failed promotion requiring investigation.

Promotion to `v1.0.0` requires a separate stable-release gate based on real beta feedback, repeatable maintenance/release cadence, declared stable compatibility and deprecation policy, and closure of the v1 product requirements. Passing this document alone is intentionally insufficient for v1.
