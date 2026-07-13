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
- optional server-side OpenAI processing with bounded failure fallback only if the third-party-content usage gate is closed; otherwise beta.1 ships with `AI_PROVIDER=none` enforced and OpenAI is deferred;
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
| AI-off baseline | All primary search and request flows work with `AI_PROVIDER=none`; no OpenAI credential is required for install, sync, search, request creation, or the mandatory `--ai-mode none` candidate responsiveness run. |
| Optional AI boundary | If included, tests cover timeouts, malformed responses, rate limits, fallback, and field-level provenance proving that no content lacking provider-use authority reaches an AI request, embedding, trace, preference example, or cached provider artifact. One controlled `--ai-mode openai --confirm-external-processing` run is recorded only after third-party-content processing authority is closed, without making CI depend on a live provider. Otherwise the published beta enforces `AI_PROVIDER=none` and documents OpenAI as deferred. |
| Responsiveness | On the documented two-CPU/2-GiB container budget and a recorded production-sized catalog, the mandatory AI-off run uses `--ai-mode none` with `AI_PROVIDER=none` while a full Plex/Seerr sync, continuous health probes, deterministic search, and fresh diagnostics run concurrently. Health p99 stays at or below 250 ms overall and during diagnostics, deterministic search p95 stays at or below 5 seconds, and the full source-specific sync completes without catalog loss. An authorized `--ai-mode openai` run additionally requires the provider-embedding stage, a fully stored nonzero embedding batch, embedding-overlap health evidence, and embedding p99 at or below 250 ms. There are no search 5xx, `SQLITE_BUSY` failures, health-check failures, restarts, or OOM events in either mode. |
| Browser and accessibility smoke | The exact Chrome/Edge, Firefox, and Safari versions in the supported matrix complete sign-in, search, result actions, request confirmation, Admin access, keyboard navigation, focus, and responsive mobile-width checks without console errors. |
| Security boundary | Admin auto-session is off by default in release packaging. Authentication, authorization, CSRF, SSRF/redirect, input-bound, session invalidation, secret-redaction, and request-confirmation tests pass. A tracked/generated secret scan passes. |
| Supply chain | The lockfile audit and built-image scan have no untriaged fixable high/critical finding. Actions and base images are immutable where supported, workflow permissions are least-privilege, and the published artifact can be verified by digest and attestation. |
| Repository content rights | The release tree and distributed artifacts contain only project-owned or compatibly licensed content and every bundled third-party mark has provenance, required attribution, and a license exclusion. Third-party artwork reachable through pre-beta public refs, archives, or Git history has a documented rights basis, approved remediation, or an explicit maintainer legal-risk decision. |
| Third-party data usage | Current TMDB terms and the actual Seerr/TMDB/OpenAI data flow have been reviewed. The candidate has written usage authority covering its exact architecture or a tested technical boundary that removes unauthorized content/use. TMDB-derived poster and metadata retention cannot exceed the authorized limit; unknown-age or expired data fails closed. Attribution and privacy disclosures match runtime behavior. |
| Data safety | Fresh, upgrade, interrupted-start, and restart tests preserve `/data`. Backup/restore instructions are followed successfully. No migration or sync failure silently marks incomplete data unavailable. |
| Public contract | [Support](../SUPPORT.md), [Security](../SECURITY.md), [Compatibility](COMPATIBILITY.md), [Upgrading](UPGRADING.md), [Backup And Recovery](BACKUP_AND_RECOVERY.md), [Data And Privacy](DATA_AND_PRIVACY.md), [Contributing](../CONTRIBUTING.md), [Changelog](../CHANGELOG.md), and [Release](RELEASE.md) are current and linked from the public entry points. |

Run the responsiveness row with the candidate-only `npm run bench:beta-responsiveness` harness documented in [Release](RELEASE.md). The mandatory passing artifact uses `--ai-mode none` against a candidate configured with `AI_PROVIDER=none`; it must identify the exact digest and commit, bind the harness to a clean checkout of that commit with its source hash, prove the two-CPU/2-GiB envelope and isolated disposable volume, exercise a full Plex/Seerr sync with concurrent health probes, deterministic search, and fresh diagnostics, continuously observe Docker health, meet the applicable latency and sample-count thresholds, preserve source-specific catalog counts, and contain no raw credentials, URLs, queries, titles, responses, logs, paths, or host/container identifiers. Provider-embedding stage coverage, a fully stored nonzero embedding batch, embedding-overlap samples, and embedding p99 apply only to an authorized `--ai-mode openai --confirm-external-processing` artifact. AI-off mode neither requires nor accepts `--confirm-external-processing`. A rehearsal against a local tag or ancestor commit does not close the candidate-validation row.

Run the clean Docker/Compose mechanics with `npm run validate:beta-install` and the alpha.21 migration/cold-rollback mechanics with `npm run validate:beta-upgrade`, as documented in [Release](RELEASE.md). Passing artifacts must bind the committed harness inputs and exact candidate identity, run natively on Linux `amd64`, prove the expected runtime hardening and fresh owned resources, preserve canonical catalog relationships through restart or restore, pass SQLite integrity and foreign-key checks, clean up only owned resources, and contain only allowlisted aggregate evidence. OCI labels alone are not sufficient source binding: before either official validator runs, the expected revision must be proven reachable from the current `origin/main` and the candidate digest must pass the documented GitHub attestation policy for the exact repository, publish workflow, expected source/signer digest, `refs/heads/main`, and hosted runner. Protocol-stub installation evidence does not replace the real Plex/Seerr compatibility matrix. The upgrade artifact must pass every depth, canonical-state, configuration-hash, database-integrity, and foreign-key check code enumerated in [Release](RELEASE.md); a smaller functional rehearsal cannot close the upgrade or rollback rows.

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
- optional OpenAI support when third-party usage authority cannot be closed in time; deferring it does not block the AI-off beta core;
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
| TMDB usage authority or tested technical separation | Pre-candidate | Pending | |
| TMDB attribution, egress disclosure, and retention review | Pre-candidate | Pending | |
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
