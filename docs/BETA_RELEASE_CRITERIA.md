# Public Beta Release Criteria

This document records the approved beta.5 fixes profile, retains the dated beta.2, beta.3 and beta.4 decisions, and preserves the original comprehensive gate designed for `v0.1.0-beta.1`. Neither approval nor an unchecked evidence row establishes that validation passed.

## Historical Beta.1 Status

`v0.1.0-beta.1` was published from source commit `08447e87df2e1705aa9a79193a52a65fb00724c3` under an intentionally narrower early-beta gate. The authoritative record of actual evidence and follow-up is [GitHub issue #32](https://github.com/jremick/moodarr/issues/32). The original comprehensive gate below did not pass as a whole and must not be read as passed.

Six broad hardening rows were left open at beta.1 publication:

- extra fresh Unraid install/update evidence;
- a stopped networkless catalog evidence package;
- a dedicated real Plex and Seerr/Jellyseerr write matrix;
- production native `linux/amd64` 2 CPU/2 GiB responsiveness evidence;
- a current Chrome/Edge/Firefox/Safari matrix; and
- a comprehensive privacy-reviewed manual artifact.

Do not backfill this document to make those rows appear completed. Retirement does not change the original beta.1 evidence; close or refine follow-up in issue #32 and apply the comprehensive gate to future hardening or a later candidate.

The later [beta.4 release](https://github.com/jremick/moodarr/releases/tag/v0.1.0-beta.4) completed its exact-digest full pinned-catalog procedure. That result belongs to beta.4 and does not retroactively close the beta.1 evidence row. The beta.4 release notes record its other passed gates and remaining validation; its named deferrals apply only to that version.

The target is **Stage 3 - Public Beta**: external self-hosters can install, operate, upgrade, and report problems with clear expectations. It is not the stable `v1.0.0` contract. Stable API, longer deprecation, wider platform, and mature native-client commitments remain later work.

## Approved Beta.5 Fixes Release Profile

On **2026-09-22**, maintainer **Jarel** approved this profile for **`v0.1.0-beta.5` only**, including the named pending evidence and the normal candidate preparation and protected promotion path. This is a separate decision from beta.4. Approval does not establish publication or turn a future check into passing evidence. GitHub Releases remains authoritative; beta.4 stays immutable.

### Product change

Beta.5 releases [PR 97](https://github.com/jremick/moodarr/pull/97): Plex stored-link validation and the configured home-fallback repair. Valid legacy title links, including safely encoded server identifiers, must keep working. Missing or invalid title metadata must not override the configured Plex-home fallback. Only directly demonstrated regressions from validation and the minimum release documentation/harness changes are in scope.

No database-schema, dependency, ranking, provider or new feature change is planned. Official AI-provider and TMDB-content policies remain `none`. Native-app development remains outside the web/server release.

### Mandatory beta.5 evidence

1. Clean final source passes independent diff review, locked dependency audit, `npm run verify:release`, secret checks, required exact-source CI, zero-result commit-bound CodeQL analysis and the existing dependency/image vulnerability policy. Source rehearsal covers clean install and alpha.21/beta.1/beta.2/beta.3/beta.4 upgrade, restart and cold rollback.
2. A fresh full-SHA image candidate passes the existing protected candidate workflow, anonymous tag/index byte readback, revocation checks, provenance, SBOM and artifact-attestation checks. Its semantic Git and registry version tags remain absent. No published tag is reused for different bytes.
3. That exact digest passes native Linux `amd64` Docker/Compose installation and all five prior-release upgrade/restart/cold-backup rollback paths. Direct beta.4 uses version `0.1.0-beta.4`, source `b0d746260cbe89478e85f1225f109403512336d8`, OCI index `sha256:aa1f8a1b72344769f2ca649fa9ff44d6f1894237012781135f48ddf7cc618e51` and schema 34. Older baseline identities remain unchanged.
4. The same digest passes the [full pinned 90,397-record catalog procedure](BETA_CATALOG_IMPORT_VALIDATION.md) on native Linux `amd64` with two CPUs/two GiB: stopped networkless import, final asset hash, SQLite/FK/FTS integrity, index content/membership, startup/restart parity, request-attempt isolation and owned cleanup.
5. The same digest passes readiness, official policies, protected access and served-asset checks, then the [six Finder view/viewport observations and 24 pointer/Enter IMDb/Trailer activations](RELEASE.md#exact-digest-runtime-and-desktop-smoke). Year/runtime remains below the poster and above Trailer/IMDb. Capture actual browser, viewport, architecture/emulation, focus, console and cleanup results.
6. PR 97 has [packaged-image evidence](RELEASE.md#plex-link-and-request-flow-regressions) for valid canonical and safely encoded legacy title URLs, invalid/missing metadata using the home fallback, and rejection of credential-bearing or malformed links. Use controlled data and destinations. Record exactly what was activated and keep synthetic web destinations distinct from real Plex/native behavior.
7. Four fresh rendered movie/TV confirmation and uncertain-retry regressions pass with disposable integrations: preview/cancel produces no write; each confirmed operation produces one write; retry reconciles without resend; TV seasons remain exactly `[1, 2]`. Include persisted Admin preferences/lock/unlock, displayed-slate feedback, refinement, invalid inputs and stale-preview invalidation. Bind the tests to the final source; if run against a source build, keep that limitation explicit and retain the exact-image protocol checks separately.
8. The release ledger binds this decision and every required result to the final source and immutable digest. Required checks are passed, cleanup is complete and known limits are in the release notes before protected `beta-release` approval. Promotion copies identical manifest bytes. The protected Git tag, anonymous image readback and exact catalog upload/download checks precede immutable GitHub prerelease publication.

The table specifies required evidence and starts each row at `Pending`; it is not a completed release ledger. Record final source and digest only after they are frozen and verified. Every mandatory row must be `Passed` before promotion.

| Evidence | Phase | Status | Required reference |
| --- | --- | --- | --- |
| Final source, independent review and release verification | Source freeze | Pending | Final full SHA; reviewed diff; locked audit, `verify:release`, secrets, exact-source CI, CodeQL and image-policy results |
| Candidate publication and supply chain | Candidate validation | Pending | Exact full-SHA tag and OCI index; anonymous byte readback, revocation, provenance, SBOM and attestation checks |
| Native install and all five upgrade/restart/cold-rollback paths | Candidate validation | Pending | Exact-digest clean Docker/Compose and alpha.21/beta.1/beta.2/beta.3 reports; `moodarr-beta4-upgrade-v1` with `passed: true`, `releaseEligible: true`, seven checks and all 25 lifecycle checks |
| Full pinned-catalog import and search isolation | Candidate validation | Pending | `moodarr-beta5-catalog-validation-v1`; final asset hash, native resource controls, integrity/content parity, isolation and cleanup |
| Exact-digest runtime and desktop/narrow Finder smoke | Candidate validation | Pending | `moodarr-beta5-runtime-smoke-v1`; six observations, 24 activations, source/digest/image ID, browser/viewports, artifact hashes and cleanup |
| Packaged Plex-link and home-fallback regressions | Candidate validation | Pending | Exact image/source binding, controlled cases and destinations, activation outcomes, outbound/write counts and cleanup |
| Rendered movie/TV confirmation and uncertain retry | Candidate validation | Pending | Four fresh scenarios bound to final source; zero preview/cancel writes, one confirmed write each, no resend, exact TV seasons and cleanup; explicit source-build limitation where applicable |

### Deferred beta.5 evidence

Keep the following rows `Pending` with this approved disposition, never `Passed` or `Not applicable`:

- At least 100 independently judged frozen cases for the shipped default MoodRank. No general ranking-quality improvement is claimed.
- Genuine current-stable Chrome, Edge, Firefox and macOS Safari coverage, plus additional fresh/install/update Unraid Docker Manager coverage. Embedded Chromium does not fill those rows.
- Dedicated-account Plex Watchlist and Seerr/Jellyseerr write, uncertain-outcome reconciliation and cleanup checks. Disposable fixtures do not establish real upstream compatibility.
- Production-sized native Linux `amd64` two-CPU/two-GiB responsiveness. Catalog import timing is not that report.
- The comprehensive privacy-reviewed manual artifact. Its schema, thresholds and completion rules remain unchanged.
- Native Plex launch and missing-client checks. The maintainer will test the installed client separately; available web/fallback checks do not establish native launch behavior.

This disposition applies to beta.5 only. It does not weaken a failed mandatory check, authorize feature/provider/model activation, or roll forward beta.4's decision by implication. The alternative remains completion of the comprehensive gate before a later release. The catalog manifest's original beta.1 target, normalizer revision, checksum and counts remain unchanged; beta.5 uses the same pinned asset bytes.

### Beta.5 stop conditions

Stop for any unresolved P0/P1, failed required security/source/identity/install/upgrade/rollback/catalog/runtime check, unexpected integration write, missing baseline image, incomplete owned cleanup, source/digest drift or unavailable protected promotion approval. Preserve the matching prior image and cold backup. Never run an old image against migrated data or overwrite an existing release identity.

## Approved Beta.4 Replacement Release Profile

On **2026-09-22**, maintainer **Jarel** approved retiring `v0.1.0-alpha.21`, `v0.1.0-beta.1`, `v0.1.0-beta.2` and `v0.1.0-beta.3`, removing affected public history, and preparing **`v0.1.0-beta.4`** as their replacement. This authority supersedes the earlier decisions to retain historical screenshots. Approval does not establish completed retirement or publication; GitHub Releases and the reviewed release ledger record those outcomes. Retired version numbers remain reserved and must never identify replacement bytes.

Beta.4 retains the shipped web/server behavior plus the merged neutral fallback-poster wording and native-app repository separation. It adds direct beta.3 upgrade/rollback evidence. It introduces no database schema, ranking, provider, dependency or new feature change. Both official baked provider policies remain `none`.

### Mandatory beta.4 evidence

- The final rewritten source passes independent release-diff review, locked dependency audit, `npm run verify:release`, secret checks, required exact-source CI, zero-result commit-bound CodeQL analysis and the existing dependency/image vulnerability policy. The native source matrix covers clean install and alpha.21/beta.1/beta.2/beta.3 upgrade, restart and cold rollback. Checks against an earlier ancestry do not establish the rewritten commit's status.
- Fresh exact-source candidate publication, anonymous index/tag readback, SBOM, provenance, attestation, revocation checks and restricted package-writer access pass through the existing protected workflows. No previous full-SHA candidate tag or old attestation is reassigned to rewritten source.
- The exact published digest passes native Linux `amd64` clean Docker/Compose installation and all four baseline upgrade/restart/cold-backup rollback paths, plus the published-digest supply-chain checks. The original baseline image digests, versions and revision labels remain unchanged. Preserve their privately archived recovery evidence before retirement; if a required image is unavailable, stop rather than substitute a new source identity or skip its validator.
- The same digest passes the [full pinned-catalog procedure](BETA_CATALOG_IMPORT_VALIDATION.md): stopped, networkless import of all 90,397 records on native Linux `amd64` with two CPUs/two GiB; final file hash, SQLite/FK/FTS integrity, index membership/content, startup/restart parity, API request-attempt isolation and ownership-checked cleanup.
- The same digest passes [runtime and desktop/narrow Finder smoke](RELEASE.md#exact-digest-runtime-and-desktop-smoke): readiness, official policies, protected access, served assets, six view/viewport observations and 24 pointer/Enter IMDb/Trailer activations. Record actual browser, architecture/emulation, artifacts and cleanup. No household data or external integration writes are permitted.
- The reviewed ledger binds this decision and all new evidence to the final source SHA and immutable digest. Protected `beta-release` approval precedes promotion of identical manifest bytes. Candidate/version readback, the protected Git tag and exact catalog-asset upload/download validation precede GitHub prerelease publication.

The required beta.4 ledger rows below must be `Passed` before promotion. This table defines acceptance and does not report a completed run.

| Evidence | Phase | Status | Required reference |
| --- | --- | --- | --- |
| Direct beta.3 upgrade, restart and cold rollback | Candidate validation | Pending | Native exact-digest `moodarr-beta3-upgrade-v1` report; `passed: true`, `releaseEligible: true`, seven checks and all 25 lifecycle checks |
| Full pinned-catalog import and search isolation | Candidate validation | Pending | `moodarr-beta4-catalog-validation-v1`; final asset hash, native resource controls, integrity/content parity, isolation and cleanup |
| Exact-digest runtime and desktop/narrow Finder smoke | Candidate validation | Pending | `moodarr-beta4-runtime-smoke-v1`; six observations, 24 activations, source/digest/image ID, browser/viewports, artifact hashes and cleanup |

Stop for any known P0/P1 defect, failed required security/identity/install/upgrade/rollback/catalog/runtime check, unexpected external write, missing historical baseline image or unavailable protected promotion approval. Keep the existing backup and matching-image restore rules. No retirement exception changes a failed gate into passing evidence.

### Deferred beta.4 evidence and provenance

The existing limitations remain explicit `Pending` rows: at least 100 independently judged frozen cases for the shipped default MoodRank; the current Chrome/Edge/Firefox/Safari and Unraid Docker Manager matrix; dedicated-account Plex and Seerr/Jellyseerr write/reconciliation/cleanup tests; production-sized native two-CPU/two-GiB responsiveness; and the combined privacy-reviewed manual artifact. Prior exact-image observations remain historical supporting evidence, not a pass for beta.4. This version-specific decision does not change the comprehensive schema, thresholds, intentionally failing example or completion rules, and makes no new ranking-quality claim.

Private recovery records retain the original source/tag mappings, release metadata and assets, image manifests/digests and supporting attestations. Rewritten commit IDs identify only rewritten source. Never replace an old revision in a validator, manifest or historical evidence claim with its rewritten counterpart. The catalog manifest's beta.1 release target and normalizer revision remain original asset provenance; beta.4 uploads the same checksum-pinned bytes.

## Approved Beta.2 Early-Release Profile

On **2026-09-21**, maintainer **Jarel** approved the limited profile below for **`v0.1.0-beta.2` only**. This decision accepts the named evidence gaps, catalog performance limitation, and historical screenshot risk. It does not establish publication or apply to beta.3, stable releases, disabled ranking/discovery experiments, or provider activation. The official image retains baked AI-provider and TMDB-content policies of `none`.

### Mandatory release evidence

- Clean, reviewed source passes `npm audit`, `npm run verify:release`, required protected-PR checks, exact-main CI and zero-result CodeQL analysis, secret scans, and dependency/image vulnerability checks. Independent release-diff review and the existing native/shared-contract verification requirements remain in force.
- Exact-source candidate publication, anonymous registry readback, attestation, provenance, SBOM, revocation checks, and restricted package-writer access pass without changing workflows or protections.
- The published digest passes every automated candidate job on native Linux `amd64`: clean Docker/Compose install, alpha.21 upgrade and cold rollback, direct beta.1 upgrade and cold rollback, and supply-chain verification. Source rehearsals cannot replace this evidence.
- A disposable instance of that exact digest passes the beta.2 runtime and desktop smoke procedure retained in the private historical archive: non-writing readiness, official-policy, protected-access, served-asset, and desktop-rendering checks, followed by ownership-checked cleanup. This check does not replace comprehensive integration or browser evidence and must not write to household request queues or replace an existing deployment.
- Protected `beta-release` review precedes promotion of the same manifest bytes. Candidate/version digest readback, the protected Git tag at the exact source, and catalog-asset upload/download checksum verification precede immutable GitHub prerelease publication.

Keep full feature/fingerprint refresh and matching-code/data cold-backup rollback requirements from [Upgrading](UPGRADING.md). Stop for any known P0/P1 defect, failed required security/identity/install/upgrade/rollback check, unexpected external write, or unavailable protected promotion approval. No exception converts one of these failures into passing evidence.

Include this additional required row in the beta.2 external release ledger. It must be `Passed` before protected promotion; an incomplete, failed, or unreviewed smoke remains blocking.

| Evidence | Phase | Status | Reference and exact environment |
| --- | --- | --- | --- |
| Exact-digest disposable runtime and desktop smoke | Candidate validation | Pending | Historical procedure and artifact contract retained in the private archive; `moodarr-beta2-runtime-smoke-v1` summary, before/after readbacks, screenshot and cleanup hashes; exact source/digest/image ID, browser/viewport, host architecture and explicit emulation status |

### Deferred evidence

Record these rows as `Pending` in the beta.2 ledger, with a separate disposition linking this decision; do not call them `Passed` or `Not applicable`:

- At least 100 independently judged, frozen cases for the shipped default MoodRank v0.5.3 changes. Visible regression tests do not establish ranking quality or generalization; no general accuracy or satisfaction improvement is claimed.
- Comprehensive Unraid Docker Manager install/update and current Chrome/Edge/Firefox/macOS Safari coverage.
- Dedicated-account Plex Watchlist and Seerr/Jellyseerr write, reconciliation, and cleanup tests.
- Full stopped, networkless catalog-import evidence, request-attempt isolation/disclosure evidence, and production-sized native two-CPU/two-GiB responsiveness evidence.
- The combined privacy-reviewed manual-evidence artifact. Its schema, thresholds, exit codes, and all-false example remain unchanged.

The >=100-case evaluation gate and comprehensive manual gate remain unsatisfied. Their rules below and in the linked runbooks still define completion; this one-release decision defers completion rather than changing its meaning.

### Accepted limitations and historical content

**Catalog import performance (P2):** bounded profiling confirmed repeated full search-index scans that cause quadratic cumulative import work. A 1,000-record public subset completed with intact data; full-catalog completion and the sole cause of the earlier stopped run remain unproven. Use **Plex-only discovery without importing the optional catalog** until the scaling fix is verified. Do not treat the partial import as a full-catalog pass. Jarel owns this disposition; a reviewed batching fix with parity and rollback checks is required in the fixes work before new features.

**IMDb/Trailer pointer actions (P2):** use keyboard focus and Enter to open these links until the separate pointer fix ships. The pointer fix, positioning moves, and other outstanding fixes follow this release and precede new features; they are not included by this documentation decision.

**Historical screenshots:** Jarel explicitly accepted proceeding with beta.2 while the three retired poster-bearing screenshots remain reachable in old alpha history. They are absent from the current tree and official image. Retain the [third-party ownership notice](../THIRD_PARTY_NOTICES.md); this decision grants no artwork rights under Apache-2.0 and authorizes no new artwork use, history rewrite, or prior-release deletion.

The beta.2 external release ledger must bind this decision to the final source SHA and immutable digest, retain actual check/artifact references, name Jarel as disposition owner, and keep deferred work and known limitations visible in release notes. Documentation changes pass normal review before a new candidate is frozen; an existing full-SHA candidate tag is never reused for changed source.

## Approved Beta.3 Fixes Release Profile

This is the dated beta.3 decision. The original version-bound procedures and results are retained privately; active runbooks now target beta.5. Their current contents do not retroactively change beta.3 evidence.

On **2026-09-21**, maintainer **Jarel** approved this profile for **`v0.1.0-beta.3` only**. It is a separate decision from beta.2. It accepts the named incomplete evidence and existing historical screenshot risk while requiring fresh exact-image validation of the fixes. Approval does not establish publication or turn a pending check into passing evidence. The official image keeps AI-provider and TMDB-content policies at `none`.

Beta.3 includes the IMDb/Trailer click repair, the requested year/runtime and button row swap, full-snapshot catalog index batching, and direct immutable beta.2 upgrade/restart/cold-backup rollback validation. It introduces no product schema, ranking weight, provider, dependency or feature change.

### Mandatory beta.3 evidence

- Reviewed source passes the locked dependency audit, `npm run verify:release`, secret checks, required protected-PR checks, exact-main CI, zero-result commit-bound CodeQL analysis and dependency/image vulnerability policy. The source-built native install and alpha.21/beta.1/beta.2 upgrade matrix passes. Independent release-diff review remains required.
- Fresh exact-source candidate publication, anonymous digest readback, SBOM, provenance, attestation, revocation checks and restricted package-writer access pass through the existing workflows and protections.
- The exact published digest passes every automated native Linux `amd64` candidate job: clean Docker/Compose install, alpha.21/beta.1/beta.2 upgrades, restart, cold-backup rollback and supply-chain verification. Source builds cannot replace this evidence.
- The same digest completes the full pinned 90,397-record catalog import on native Linux `amd64` under two CPUs/two GiB with the application stopped and networking disabled. Require the final file hash, SQLite/FK/FTS integrity, index membership/content, restart parity, API request-attempt isolation and owned-resource cleanup. Prior source-built timing is supporting evidence only.
- A disposable instance of the same digest passes readiness, official-policy, protected-access, served-asset and rendered desktop/narrow Finder smoke, with no external integration writes. The [public procedure](RELEASE.md#exact-digest-runtime-and-desktop-smoke) requires fixture sign-in/search, the year/runtime row before Trailer/IMDb, and pointer/Enter activation in all three layouts at both widths. Record exact source/digest/image ID, actual browser/viewports, architecture/emulation and cleanup. Prior source-built click/layout observations remain supporting evidence only.
- The external ledger binds this decision and actual evidence to the final SHA and immutable digest. Protected `beta-release` approval precedes promotion of identical manifest bytes. Candidate/version readback, the protected Git tag and catalog-asset upload/download validation precede immutable GitHub prerelease publication.

These additional rows must be `Passed` in the beta.3 external ledger before promotion; the pending table below specifies the contract and is not a completed ledger:

| Evidence | Phase | Status | Required reference |
| --- | --- | --- | --- |
| Direct beta.2 upgrade, restart and cold rollback | Candidate validation | Pending | Native exact-digest `moodarr-beta2-upgrade-v1` report with `passed: true`, `releaseEligible: true`, all seven checks and all 25 lifecycle checks |
| Full pinned-catalog import and search isolation | Candidate validation | Pending | [Public procedure, checker and artifact contract](BETA_CATALOG_IMPORT_VALIDATION.md); native Linux amd64, two CPUs/two GiB, stopped networkless 90,397-record import; final file hash, integrity, index/content and restart parity; catalog request-attempt isolation and owned cleanup |
| Exact-digest disposable runtime and desktop/narrow Finder smoke | Candidate validation | Pending | [Public procedure and artifact contract](RELEASE.md#exact-digest-runtime-and-desktop-smoke); `moodarr-beta3-runtime-smoke-v1`, six view/viewport observations and 24 pointer/Enter activations, exact source/digest/image ID, browser/viewports, host architecture and emulation status, artifact hashes and owned cleanup |

Stop for any known P0/P1 defect, failed required security/identity/install/upgrade/rollback check, failed mandatory catalog/runtime check, unexpected external write or unavailable protected promotion approval. Keep the existing full feature/fingerprint refresh and matching-image/data cold-backup requirements in [Upgrading](UPGRADING.md). This decision does not waive those failures or change evidence schemas and thresholds.

### Deferred beta.3 evidence

Keep the following rows `Pending`, with Jarel as disposition owner and a link to this decision. Do not mark them `Passed` or `Not applicable`:

- At least 100 independently judged frozen cases for the previously shipped default MoodRank v0.5.3 changes. AI-generated judgments and developer regression cases do not satisfy that protocol. Broad ranking quality remains unvalidated; no general accuracy or satisfaction improvement is claimed.
- Comprehensive current Chrome/Edge/Firefox/macOS Safari and Unraid Docker Manager install/update coverage. Record available Codex/Comet observations by their actual browser and viewport.
- Native Plex desktop/mobile launch and missing-client/fallback compatibility; dedicated-account Plex Watchlist and Seerr/Jellyseerr write, reconciliation and cleanup coverage. Household services are not designated test queues.
- The combined comprehensive manual-evidence artifact, including rendered catalog request-attempt disclosure, and any production-scale responsiveness row not completed against this exact digest. The mandatory networkless import and API isolation above cannot be deferred with this row.

The original comprehensive gate and independent evaluation protocol still define completion. This release-specific decision does not approve beta.4 or later releases, stable releases, disabled experiments, provider activation, native-client installation or deployments.

### Historical content

Jarel accepts proceeding with beta.3 while the three retired poster-bearing screenshots remain reachable in old alpha history. They remain absent from the current tree and official image. Retain the [third-party ownership notice](../THIRD_PARTY_NOTICES.md). This decision grants no artwork rights and authorizes no new artwork use, history rewrite or prior-release deletion. Beta.2 remains immutable.

## Beta Product Contract

Beta.1 includes:

- the Moodarr web client and server as one self-hosted container;
- Linux `amd64` Docker, Docker Compose v2, and Unraid deployment paths;
- Plex library sync, Plex-user sign-in, poster proxying, links, and documented Watchlist actions;
- Seerr/Jellyseerr request-state sync, request preview, and explicitly confirmed request creation;
- Plex-only discovery without a catalog download, with optional missing-title discovery from the separately released, checksum-pinned Wikidata CC0 catalog asset;
- deterministic local MoodRank search under a non-overridable provider policy baked into the official beta.1 image;
- no supported OpenAI processing in beta.1; the provisional provider path remains available only to source development builds and may be reconsidered for a future release;
- admin authentication, user capabilities, support diagnostics, migration, backup, and rollback guidance; and
- private LAN/VPN use or an exact-origin HTTPS reverse proxy.

The beta compatibility surfaces are defined in [Compatibility](COMPATIBILITY.md). Except for the documented health semantics, the HTTP API is internal and does not become a stable third-party API in beta.

## Original Comprehensive Release Gate

Under the original plan, every row had to pass unless this document explicitly permitted a pre-candidate `Exception approved` decision. Applicable `Candidate validation`, `Pre-promotion`, and `Post-promotion` rows were non-waivable; a conditional row could be `Not applicable` only where its own criterion permitted that status and the ledger recorded the rationale. These rules remain the future-hardening target, not a description of the narrower gate used to publish beta.1. For beta.2 and beta.3, their separate [beta.2](#approved-beta2-early-release-profile) and [beta.3](#approved-beta3-fixes-release-profile) profiles define the limited deferrals; automated, security, identity, data-preservation, and protected-promotion requirements remain mandatory.

| Gate | Required evidence |
| --- | --- |
| Source and release identity | Candidate publication uses the current default-branch HEAD so its attestation source digest matches the built commit. The authorization job rejects any revision or digest in the dispatch commit's `.github/release-revocations.json` policy before candidate source or a protected environment is used, then the privileged job validates the latest protected `main` policy and rejects either identity again immediately before candidate push or semantic promotion. Semantic promotion takes the same full SHA and validated digest through the Tier 3 `beta-release` approval while the semantic Git tag is absent. Only after approved image promotion succeeds is the protected Git tag created manually at that commit. Package version, changelog, installation docs, Compose/Unraid references, image labels, image digest, SBOM, provenance, attestation, and final Git tag identify the same release. |
| Default-branch quality | `npm run verify:release` passes from a clean checkout. The protected PR passes the app-bound `verify`, `CodeQL`, and `Scan exact event source image` merge checks. On the exact merged default-branch commit, the CI and CodeQL push workflows pass, the commit-bound CodeQL analysis has zero results, and the exact-source image scan is green. The source-built native Linux validation matrix also passes both clean-install and alpha.21 upgrade/rollback legs. No P0/P1 application defect remains open. |
| Clean Docker install | A new Linux `amd64` host or VM pulls the official image, starts with a new `/data`, completes Admin setup, connects integrations, syncs, searches, loads posters, and restarts without losing state. |
| Clean Compose install | `docker-compose.example.yml` is followed from a clean directory with only documented substitutions. Health, persistence, hardening, and core flows pass. |
| Unraid install | The checked-in Unraid template or a faithful clean template install passes on an exact recorded Unraid version. Before first Apply, the fresh selected Appdata path is prepared exactly as documented as UID/GID `999:999` mode `0700`; no post-Apply ownership repair or permission relaxation is needed. Appdata persistence, origin handling, resource limits, and updates are verified. |
| Supported upgrades | Direct upgrades from alpha.21 and alpha.22, when published, pass against representative backed-up data. Schema migration, counts, configuration, users, request audits, profiles, posters, and `PRAGMA integrity_check` are verified. Ambiguous legacy catalog-plus-Seerr materializations fail closed. A latent alpha movie/TV source-binding collision with a shared numeric TMDB ID is repaired only by the packaged networkless importer while the application is stopped: a read-only pass discovers the full approved asset, refresh-source count, repair count, recovery closure, and canonical plan SHA; the atomic write binds those exact values and proves the QID, typed TMDB identities, companions, operational/history state, and derived indexes close correctly. Exact requestable deterministic search survives restart, and all four trusted-refresh-required diagnostics finish at zero. |
| Rollback | The pre-upgrade backup restores into an empty path and the prior recorded image digest starts against it. No older image is tested against the migrated database. |
| Core integration behavior | Exact Plex and Seerr/Jellyseerr versions are recorded. Sync, Plex authentication, user capability defaults, Watchlist action, request preview, one controlled confirmed request, idempotent retry, and uncertain-outcome handling pass. |
| Catalog bootstrap and request-attempt boundary | The separate `wikidata-20260622-min5-v1` asset passes its tracked whole-file manifest at SHA-256 `dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a`: 90,397 unique importable records and 82,865 ambiguity-safe request-attempt eligible records, split into 70,841 movies and 12,024 TV series. Its 36 groups share a strong importer identifier across 72 imported/indexed source records, including 59 otherwise eligible records—10 movies and 49 TV series. Their ambiguous catalog materializations remain available only for provenance and diagnostics and cannot independently surface in Finder or authorize preview or creation. An independently identified available Plex item may remain Finder-visible if linked later, but catalog ambiguity still blocks every request action. The exact candidate's packaged importer completes a stopped, `--network none`, full-snapshot import with `--expected-source-records 90397 --expected-file-sha256 dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a`, reports the matching post-pass file hash, commits atomically, and survives restart. Generic search and verified-requestable-only filters exclude attempt rows; explicit request-attempt intent may surface unambiguous eligible rows only as `unavailable` with Seerr availability not checked. Plex-only operation passes without the asset. |
| AI-off baseline | All primary search and request flows work without an OpenAI credential. The official image's compiled policy and OCI label both equal `none`; hostile `AI_PROVIDER=openai` and key environment values, retained provider settings and keys in `/data/config.json`, authenticated Admin updates, worker restarts, scheduler restarts, and embedding-warmup requests cannot enable a provider or cause an OpenAI request. Search with `useAi: true` still reports `usedAi: false`. The compiled server artifact contains no OpenAI endpoint string. |
| Responsiveness | On the documented two-CPU/2-GiB container budget and a recorded production-sized catalog, a qualifying beta.1-bound run would use `--ai-mode none` against the provider-locked official image while a full Plex plus Seerr operational-state sync, continuous health probes, deterministic search, and fresh diagnostics run concurrently. Health p99 would stay at or below 250 ms overall and during diagnostics, deterministic search p95 would stay at or below 5 seconds, and the full source-specific sync would complete without catalog loss. There would be no search 5xx, `SQLITE_BUSY` failures, health-check failures, restarts, or OOM events. Provider-embedding work is not part of the beta.1 candidate gate. |
| Browser and accessibility smoke | The exact current-stable Chrome, Edge, Firefox, and macOS Safari versions in the supported matrix complete sign-in, search, result actions, request confirmation, Admin access, keyboard navigation, visible-focus, responsive mobile-width, and reduced-motion checks without console errors. |
| Security boundary | Admin auto-session is off by default in release packaging. Authentication, authorization, CSRF, SSRF/redirect, input-bound, session invalidation, secret-redaction, upstream response-field allowlisting, and request-confirmation tests pass. A tracked/generated secret scan passes. |
| Supply chain | The lockfile audit and pre-publish built-image scan have no untriaged fixable high/critical finding. Actions and base images are immutable where supported, and workflow permissions are least-privilege. Candidate publication first requires the semantic Git tag to be absent, then fails closed unless anonymous raw-manifest reads by the full-SHA tag and emitted digest return the same OCI index with the registry-reported and recomputed digests both equal to the emitted digest, declare the expected media type, have exact bytes, and finish with the semantic GHCR version tag absent. Candidate validation then independently proves that the actual published candidate is anonymously pullable by exact digest before authenticated inspection and passes raw-manifest digest recomputation, image-label/platform checks, GitHub attestation policy, attached BuildKit SLSA provenance, non-empty SPDX 2.3 SBOM validation, and an exact-digest Trivy scan with no unsuppressed fixable high/critical finding. |
| Repository content rights | The release tree and distributed artifacts contain only project-owned or compatibly licensed content and every bundled third-party mark has provenance, required attribution, and a license exclusion. Third-party artwork reachable through pre-beta public refs, archives, or Git history has a documented rights basis, approved remediation, or an explicit maintainer legal-risk decision. |
| Third-party data usage | Current TMDB terms and the actual Seerr/TMDB data flow have been reviewed. The candidate enforces and tests TMDB content policy `none`: no Seerr descriptive search/details, no direct TMDB endpoint or artwork, legacy ambiguous Seerr-linked descriptive/derived state is sanitized, trusted descriptions are rematerialized only from Plex or an operator-approved catalog file for the recorded source, and only trusted local identifiers plus operational request state remain. The official server bundle also excludes the deferred OpenAI endpoint. Notices and privacy disclosures match runtime behavior. |
| Data safety | Fresh, upgrade, interrupted-start, and restart tests preserve `/data`. Backup/restore instructions are followed successfully. No migration or sync failure silently marks incomplete data unavailable. |
| Public contract | [Support](../SUPPORT.md), [Security](../SECURITY.md), [Compatibility](COMPATIBILITY.md), [Catalog Bootstrap](CATALOG_BOOTSTRAP.md), [Upgrading](UPGRADING.md), [Backup And Recovery](BACKUP_AND_RECOVERY.md), [Data And Privacy](DATA_AND_PRIVACY.md), [Contributing](../CONTRIBUTING.md), [Changelog](../CHANGELOG.md), [Release](RELEASE.md), and the [manual candidate runbook](BETA_CANDIDATE_MANUAL_VALIDATION.md) are current and internally consistent. |

Run the responsiveness row with the candidate-only `npm run bench:beta-responsiveness` harness documented in [Release](RELEASE.md). A passing beta.1-bound artifact would use `--ai-mode none` against the provider-locked candidate; it must identify the exact digest and commit, bind the harness to a clean checkout of that commit with its source hash, prove the two-CPU/2-GiB envelope and isolated disposable volume, exercise a full Plex and Seerr operational-state sync with concurrent health probes, deterministic search, and fresh diagnostics, continuously observe Docker health, meet the applicable latency and sample-count thresholds, prove no total-item loss plus a production-sized active catalog-source baseline whose count and identity/mapping fingerprint are preserved exactly while reconciling operational source counts within their documented tolerance, and contain no raw credentials, URLs, queries, titles, responses, logs, paths, or host/container identifiers. It neither requires nor accepts `--confirm-external-processing`. OpenAI-mode harness support is retained for source and future-release analysis, but it cannot be beta.1 candidate evidence. A rehearsal against a local tag or ancestor commit does not close the candidate-validation row.

Run the clean Docker/Compose mechanics with `npm run validate:beta-install` and the alpha.21 migration/cold-rollback mechanics with `npm run validate:beta-upgrade`, as documented in [Release](RELEASE.md). Passing artifacts must bind the committed harness inputs and exact candidate identity, run natively on Linux `amd64`, prove the expected runtime hardening and fresh owned resources, preserve canonical catalog relationships through restart or restore, pass SQLite integrity and foreign-key checks, clean up only owned resources, and contain only allowlisted aggregate evidence. The upgrade must additionally prove pre-refresh quarantine; run a production-adapter, Plex-only full sync that restores the exact trusted Plex result while leaving the catalog marker pending; invoke the importer packaged in that candidate image rather than mutate trusted descriptions directly; clear every refresh-required marker; restore an exact requestable catalog result through restart; and preserve the pristine alpha rollback state. OCI labels alone are not sufficient source binding: before any official candidate job runs, the expected revision must be proven reachable from the current `origin/main` and the candidate digest must pass the documented GitHub attestation policy for the exact repository, publish workflow, expected source/signer digest, `refs/heads/main`, and hosted runner. The separate `beta-supply-chain-<full-sha>` artifact must first prove that the exact OCI index is anonymously pullable without a GitHub credential, then prove its published digest, BuildKit provenance, SPDX SBOM, and exact-digest vulnerability policy. Protocol-stub installation evidence does not replace the real Plex/Seerr compatibility matrix. The upgrade artifact must pass every applicable check emitted by the checked-in validator; [Release](RELEASE.md) names the release-critical groups but is not a duplicate exhaustive allowlist. A smaller functional rehearsal cannot close the upgrade or rollback rows.

On every pull request and default-branch update, the source-built native Linux validation matrix builds the exact checked-out source on GitHub-hosted Ubuntu 24.04 `linux/amd64` and independently runs both validator paths. CI accepts their expected nonzero local-rehearsal result only after proving exactly 25 required checks per install mode, 107 required upgrade checks, native platform and source identity, and zero labeled resource residue. The retained allowlist is only the sanitized report plus compact image identity for 30 days. These runs are deliberately release-ineligible pre-candidate evidence: they catch packaging, install, migration, rollback, and cleanup regressions early but cannot replace native validation of the immutable published candidate digest.

For comprehensive-gate completion, complete the exact-digest Unraid, pinned catalog asset/networkless import, request-attempt isolation, real Plex/Seerr, native responsiveness, and supported-browser rows together through the [manual candidate runbook](BETA_CANDIDATE_MANUAL_VALIDATION.md). Start from its all-false example and require `npm run validate:beta-manual-evidence` to exit `0`; the frozen privacy-reviewed input, compact summary, responsiveness-report hash, and canonical responsiveness-harness blob hash must all identify the same candidate revision and digest. This is a structured operator attestation requiring maintainer review, not independent automated proof. Fixture, source-built, local-image, emulated, or prior-candidate observations cannot close this gate.

## Severity And Exception Rules

- **P0:** credential exposure, destructive data loss, unauthorized external write, or broadly exploitable remote compromise. Never release.
- **P1:** authentication/authorization bypass, incorrect request creation, migration/restore failure, unusable clean install, persistent crash/OOM, or a primary workflow failure without a safe fallback. Never release.
- **P2:** meaningful defect with a documented workaround or bounded unsupported configuration. Release only after an explicit maintainer decision and public known-limitation entry.
- Cosmetic and low-impact issues may be deferred when they do not undermine installation, safety, accessibility of primary flows, or the documented compatibility contract.

Under the comprehensive profile, release exceptions must name the affected configuration, user impact, workaround, owner, and intended follow-up. Security scanner exceptions require evidence and must remain visible; lack of an upstream fix is not sufficient by itself. An exception may record a bounded pre-candidate P2 or the explicit historical-artwork risk decision, but it cannot turn a failing applicable candidate-validation or promotion row into passed evidence. In particular, the exact-digest automated jobs and `validate:beta-manual-evidence` exit `0` are mandatory and not exception-eligible under that profile. The [approved beta.2 profile](#approved-beta2-early-release-profile) defers comprehensive manual completion only; its automated jobs and retained safety gates remain mandatory.

## Non-Goals For Beta.1

These do not block the web/server beta unless a change regresses an already documented behavior:

- stable or TestFlight-ready iOS support;
- Linux `arm64`, Windows containers, Kubernetes, or multi-replica operation;
- direct public-internet hosting, bundled TLS, or a bundled reverse proxy;
- automated off-site backup hosting or key custody;
- a stable third-party HTTP API or public SQLite schema;
- support for every Plex, Seerr-family, browser, or reverse-proxy version;
- per-user AI billing, token budgets, or supported provider access;
- OpenAI support in the official beta.1 image; provisional source provider code does not expand the release contract;
- vector-database infrastructure or distributed job queues; and
- perfect or universal recommendation quality.

The experimental iOS client remains visible but must be labeled non-blocking and outside the beta support contract. Deferred native implementation and UI work is not part of the beta.1 candidate; only server-side API compatibility needed by the existing alpha client remains in scope.

## Original Planned Evidence Ledger

This template records the original comprehensive plan and is not beta.1's actual completion ledger. For beta.1, use [issue #32](https://github.com/jremick/moodarr/issues/32). For a future candidate, create one ledger in its release PR or release issue and link durable CI runs, artifacts, logs, screenshots, benchmark summaries, and restore records rather than pasting secrets or private data. After a candidate is published, update its external ledger without changing the frozen source.

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
| Protected-PR app-bound merge checks; exact merged-main CI and CodeQL push runs, zero-result commit-bound CodeQL analysis, exact-source image scan, and source-built native Linux validation matrix | Pre-candidate | Pending | |
| Security regression suite and secret scans | Pre-candidate | Pending | |
| Dependency/image scan triage | Pre-candidate | Pending | |
| Public-document link and claim check | Pre-candidate | Pending | |
| Independent release-diff review | Pre-candidate | Pending | |
| GHCR package-writer access review | Pre-candidate | Pending | |
| `candidate-publication` and Tier 3 `beta-release` environment policy read-back | Pre-candidate | Pending | Both environments disallow administrator bypass. Semantic promotion requires the configured maintainer reviewer; candidate publication does not. |
| Dispatch and latest-`main` release-revocation policy gates validate exactly one nonempty policy and reject every abandoned revision or digest | Pre-candidate | Pending | `.github/release-revocations.json`, authorization, pre-mutation rechecks, and confirmation that no pre-gate publish run remains active; old tags and attestations do not restore eligibility |
| TMDB tested technical separation | Pre-candidate | Pending | `io.moodarr.tmdb-content-policy=none`, no endpoint/content/artwork markers, hostile-input tests, and legacy sanitation evidence |
| TMDB/Seerr notices, egress, and retained-state review | Pre-candidate | Pending | |
| Pinned catalog manifest, CC0 provenance, exact SHA-256, schema, and count validation | Pre-candidate | Pending | `wikidata-20260622-min5-v1`; 90,397 records; 82,865 ambiguity-safe request-attempt eligible; groups sharing a strong importer identifier remain attempt-ineligible |
| Historical artwork rights or remediation decision | Pre-candidate | Pending | |
| Docker clean install from candidate digest | Candidate validation | Pending | |
| Compose clean install from candidate digest | Candidate validation | Pending | |
| Unraid clean install from candidate digest | Candidate validation | Pending | |
| Alpha.21 direct upgrade using candidate digest | Candidate validation | Pending | |
| Alpha.22 direct upgrade or not-applicable rationale | Candidate validation | Not applicable | No alpha.22 was published before the beta candidate freeze. Reopen and validate this path if that changes before candidate publication. |
| Cold restore and rollback | Candidate validation | Pending | |
| Plex integration matrix | Candidate validation | Pending | |
| Seerr/Jellyseerr integration matrix | Candidate validation | Pending | |
| Integration identity-conflict containment and aggregate reporting | Candidate validation | Pending | Controlled automated collision proves safe sibling ingest, no identifier rebinding, request quarantine, and continued Plex finalization; the exact-digest real Plex and Seerr runs report zero conflicts, or any nonzero aggregate is investigated and resolved before promotion |
| AI-off end-to-end flow | Candidate validation | Pending | |
| Provider-enabled beta mode | Candidate validation | Pending | Mark `Not applicable` only after the baked AI-off artifact and hostile-configuration tests pass; beta.1 does not ship a configurable provider mode. |
| Production-sized responsiveness benchmark | Candidate validation | Pending | |
| Browser/accessibility matrix | Candidate validation | Pending | |
| Stopped networkless catalog full-snapshot import, restart, generic/verified-only isolation, and request-attempt disclosure | Candidate validation | Pending | Exact catalog asset and candidate digest; `exactAsset`, `networklessFullSnapshotImport`, `genericSearchIsolation`, and `requestAttemptDisclosure` all true |
| Privacy-safe manual candidate evidence summary | Candidate validation | Pending | `moodarr-beta-manual-evidence-v1` input and validator summary from the exact-digest runbook |
| Candidate publication pre-push semantic Git-tag absence plus anonymous full-SHA-tag/digest raw-manifest self-readback and semantic GHCR version-tag absence | Candidate validation | Pending | Successful candidate-mode publish workflow run; this immediate guard does not replace the independent supply-chain run below |
| Anonymous public candidate pull plus published digest, labels/platform, SBOM, provenance, GitHub attestation, and exact-digest image scan | Candidate validation | Pending | `beta-supply-chain-<full-sha>` artifact and workflow run |
| Semantic Git tag is absent before Tier 3-approved promotion | Pre-promotion | Pending | Reviewer read-back plus workflow enforcement |
| Tier 3-approved GHCR version tag equals the validated candidate digest; both image refs pass final byte/digest read-back | Post-promotion | Pending | `beta-release` deployment and publish workflow run |
| Protected semantic Git tag was created only after approved image promotion and resolves to the candidate commit | Post-promotion | Pending | |
| Draft GitHub prerelease catalog asset upload and exact-byte read-back pass before immutable publication | Post-promotion | Pending | `moodarr-wikidata-20260622-min5-v1.jsonl.gz` at the pinned SHA-256 |

For this original comprehensive ledger, allowed statuses are `Pending`, `Passed`, `Failed`, `Not applicable`, and `Exception approved`. `Exception approved` is valid only for an explicitly eligible `Pre-candidate` risk decision. `Not applicable` is valid only when the row itself is conditional. Both require a written rationale and maintainer sign-off.

For a release using the comprehensive profile, every `Pre-candidate` row must be `Passed` or explicitly eligible for `Exception approved` before the full-SHA candidate workflow is authorized. Every applicable `Candidate validation`, `Pre-promotion`, and `Post-promotion` row must be `Passed`, not exception-approved. Candidate validation and pre-promotion must pass before the `beta-release` environment is approved; post-promotion must pass before the GitHub prerelease is published or announced. A draft may exist only long enough to stage and read back its immutable-release inputs.

## Original Comprehensive Promotion Plan

The comprehensive profile has four explicit decisions so the source commit does not need to contain evidence that can exist only after candidate publication. Beta.2 uses the [approved profile](#approved-beta2-early-release-profile) for evidence applicability; the identity, immutable publication, and protected-promotion sequence remains the same:

1. **Approve candidate publication.** Complete every pre-candidate ledger row, resolve or approve every exception, confirm the full SHA is the reviewed current default-branch HEAD at dispatch, and manually dispatch `release_mode=candidate` with that SHA and an empty digest. Publish only its `sha-<full-sha>` candidate tag. No semantic Git or image tag is allowed at this stage. The candidate job first requires the semantic Git tag to be absent, then succeeds only after its anonymous full-SHA-tag and emitted-digest raw-manifest reads match exactly and the semantic GHCR version tag returns `404`.
2. **Validate the published candidate.** Independently pull the candidate by digest and complete every candidate-validation row, including clean Docker, Compose, and Unraid paths plus raw digest, image identity, SBOM, provenance, GitHub attestation, and exact-digest image-scan evidence. A publication failure after the full-SHA tag appears; a mismatch confirmed in the independently resolved published OCI bytes, labels, platform, or attestation; a safety failure; or a candidate/harness defect that requires source changes abandons the candidate and requires a new source commit. An observation invalidated only by expired evidence, transient external/tooling state, operator collection error, mistyped pre-execution identity input, or wrong/damaged auxiliary catalog staging may be discarded and repeated against the same unchanged digest after the cause is resolved and identity, attestation, and safety are re-established. Correcting the tracked catalog/source contract is a source change and requires a new candidate. A publication attempt that fails before the full-SHA tag appears may repeat only after independently proving the tag remains absent and rechecking the frozen `main` SHA and workflow definition; once the tag appears, candidate publication is never rerun for that SHA.
3. **Approve semantic image promotion.** Confirm the semantic Git tag is absent and the exact revision/digest is not in the current default-branch release-revocation policy, then dispatch `release_mode=promotion` with the validated candidate's full SHA and exact digest. Approve the `beta-release` environment only after reviewing the complete ledger. The approved job must add the GHCR version tag to the same manifest bytes without rebuilding, or adopt an existing tag only when its registry digest, recomputed digest, media type, and raw bytes already match that approved candidate. It must read back both image identities at the same media type and digest and finish while the semantic Git tag remains absent. If the registry write succeeded but a later check failed, leave the Git tag absent and use a new Tier 3-approved dispatch with the same frozen inputs to repeat verification without rewriting an exact tag.
4. **Create the protected Git tag and approve public announcement.** Only after the approved image-promotion workflow succeeds, manually create the protected semantic Git tag at the exact candidate commit. Verify the peeled Git commit, both image-tag digests, and the attestation once more. Prepare the GitHub prerelease as a draft using `gh release create --verify-tag` with the verified digest, beta support boundary, known limitations, and exact catalog asset; read the asset back and revalidate its bytes before publishing the immutable prerelease. Omitting `--verify-tag` is prohibited because GitHub CLI can otherwise create a missing semantic tag.

Failure at any stage stops the next decision. The failure classification above determines whether validation may repeat against the unchanged digest or the candidate must be abandoned. Do not advertise the SHA candidate as the beta release, and do not create the GitHub prerelease until post-promotion evidence passes.

GHCR tag creation is not an atomic create-only operation. Candidate publication's semantic Git-tag preflight, anonymous self-readback, and semantic GHCR version-tag `404` are point-in-time observations, not locks; any post-push failure abandons that full-SHA candidate. The workflow creates the version tag only after a registry `404`; an existing `200` response is read-only and accepted only for the exact approved manifest, so an interrupted post-write verification can be resumed safely through another `beta-release` approval. It then re-reads both candidate and version manifests. A separately authorized package writer could still race a registry request, so keep package-write access restricted, do not push GHCR release tags outside the workflow, and treat any unexpected media type, bytes, or digest as a failed publication or promotion requiring investigation. Candidate-mode checks do not replace promotion's registry probe or repeated semantic Git-tag checks. The protected Git tag is a manual post-promotion action and must never be created before the Tier 3-approved image workflow succeeds.

Promotion to `v1.0.0` requires a separate stable-release gate based on real beta feedback, repeatable maintenance/release cadence, declared stable compatibility and deprecation policy, and closure of the v1 product requirements. Passing this document alone is intentionally insufficient for v1.
