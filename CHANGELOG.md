# Changelog

## 0.1.0-beta.1

- Advances Moodarr's target from public alpha to an early public beta for external self-hosters, with the Linux `amd64` web/server container as the supported product surface and the iOS client explicitly experimental.
- Hardened admin and Plex-user authentication, session and origin handling, external-write confirmation, integration URL validation, bounded provider calls, secret redaction, container isolation, and supply-chain verification.
- Moved expensive recommendation search and diagnostics off the request thread, and isolated full Plex/Seerr synchronization so health and Finder traffic remain responsive during maintenance.
- Fixed OpenAI embedding-dimension migrations so incompatible cached vectors are detected, excluded from retrieval, and gradually replaced without loading the entire catalog into memory.
- Added a copy-safe named-volume Compose path, non-root container smoke coverage, digest-bound release identity checks, CodeQL and image scanning, SBOM/provenance attestations, and a default-branch ancestry gate for semantic release tags.
- Added public beta support, compatibility, upgrade, rollback, backup, privacy, and measurable release-criteria contracts; corrected support-bundle privacy wording and stale public metadata.
- Refactored the web client into focused Finder, Admin, review, and diagnostics modules while retaining the Screening Desk design system and accessibility behavior.
- Added an explicit protected-instance Finder unlock path, preserved request confirmation after uncertain failures, updated successful request cards immediately, serialized interactive mutations against search/navigation races, and tightened request-action contrast and disclosure semantics.
- Bound OCI version/revision labels to the verified package version and full commit, and aligned the Unraid template and documentation with the shellless UID/GID `999:999` distroless runtime.
- Added a digest-bound black-box beta responsiveness harness with disposable-data confirmation, exact container/resource checks, full-sync and nonzero embedding-work proof, concurrent health/search/diagnostics sampling, safe public JSON evidence, and deterministic threshold/ownership tests.
- Replaced archive commands that could not run in the distroless release image with the digest-pinned, networkless build helper, protected host-created backup output, fresh restore-volume guards, and explicit runtime ownership repair.
- Documented the required alpha.21-to-beta.1 origin, persistent-mount, admin-session, UID/GID, and container-hardening changes instead of treating that upgrade as an image-only replacement.
- Required restore and rollback tests to run the exact recorded image digest with a running-container image read-back, and made the local Docker quick start loopback-only with separate trusted-LAN origin guidance.
- Closed the container memory envelope by setting memory-plus-swap equal to the 2 GiB memory limit in Docker, Compose, and Unraid examples.
- Added candidate-only clean Docker/Compose validation with private deterministic Plex/Seerr protocol stubs, exact poster proof, persisted restart/recreate checks, runtime-envelope inspection, and safe aggregate evidence.
- Added an immutable alpha.21-to-beta migration and cold-rollback validator with 80k representative-catalog, user-capability, self-authored poster-blob/route, feedback-linked recommendation-graph, canonical-state, semantic/raw configuration-hash, database-integrity, and foreign-key checks, plus a read-only native-Linux candidate workflow. This closes the validator's required depth as a harness capability; it does not claim that an official candidate has passed.
- Bound both candidate-validation jobs to a revision reachable from current `origin/main` and to the exact GitHub artifact-attestation policy before either validator can run.
- Added mode-`0600` SHA-256 sidecars, checksum-before-restore and archive-name checks, exact backup-time image-digest recording, and ownership-guarded failure cleanup to the backup/restore procedure.
- Added an accessible in-app About & Credits surface with the required TMDB notice and approved logo, plus deterministic source/hash contracts for the attributed asset.
- Restricted TMDB poster retrieval to fixed-host, fixed-size, safe raster paths with redirects disabled, client `no-store`, and fail-closed source-agnostic cache retention capped at 180 days; documented the external-network, content-rights, and OpenAI release boundaries.
- Made the mandatory production-sized responsiveness gate explicitly dual-mode: the AI-off baseline proves full sync, deterministic search, diagnostics, and container health without AI-provider processing, while authorized OpenAI runs retain the additional nonzero embedding and overlap gates.

## 0.1.0-alpha.21 - 2026-07-05

- Supersedes alpha.20 by treating plain `already available` wording as a Plex-available hard filter, not only phrases that explicitly say `in Plex`.
- Added regression coverage from the live broad-persona pass so already-available TV prompts cannot leak requestable or pending catalog rows into the ranked window.

## 0.1.0-alpha.20 - 2026-07-05

- Supersedes alpha.19 by enforcing explicit `PG or lower` and `PG-13 or lower` rating boundaries against unknown-rating catalog candidates.
- Added regression coverage so shared-screen/kids rating ceilings reject unknown-rating decoys instead of treating missing metadata as safe.

## 0.1.0-alpha.19 - 2026-07-05

- Added opt-in MoodRank trace persistence with redacted review-queue prompts, result provenance, rejection reasons, impression rows, and live trace diagnostics.
- Expanded MoodRank release-readiness coverage across persona, availability, hard-filter, language/subtitle, seasonal, franchise, documentary, animation, and feedback/profile cases.
- Hardened MoodRank scoring and intent handling for negation, adult/family boundaries, availability constraints, requestable-only prompts, documentary/mockumentary drift, and AI rerank parity.

## 0.1.0-alpha.18 - 2026-07-02

- Added `npm run backfill:features:repair` for large live catalogs that already have current fingerprints but need feature documents, FTS rows, deterministic mood rows, and malformed mood keys repaired quickly.
- Added staged bulk-backfill flags for skipping fingerprint rewrites, deferring FTS into one rebuild, and cleaning malformed mood feature keys.

## 0.1.0-alpha.17 - 2026-07-02

- Optimized bulk feature refreshes by skipping unchanged content-fingerprint mood projection rewrites while still refreshing feature documents, FTS rows, deterministic mood rows, and fingerprint JSON.

## 0.1.0-alpha.16 - 2026-07-02

- Added `npm run backfill:features:bulk` for large-catalog refreshes of `media_features`, `media_feature_fts`, deterministic mood rows, and content-fingerprint projections in one pass.
- Documented the feature-vector refresh requirement for large catalogs and the post-backfill malformed mood-key verification guardrail.

## 0.1.0-alpha.15 - 2026-07-02

- Expanded deterministic content fingerprints with richer theme, setting, era, pacing, intensity, watchability, rating, and safe catalog metadata signals.
- Threaded Wikidata catalog countries, languages, franchises, aliases, awards, and rank signals into fingerprints and catalog lexical search without changing Plex/Seerr availability truth.
- Added fingerprint-depth diagnostics, broader query and MovieLens Tag Genome mappings, and regression coverage for catalog metadata, catalog FTS rebuilds, and non-AI retrieval.

## 0.1.0-alpha.14 - 2026-07-02

- Added deterministic `ContentFingerprintV1` storage with evidence, confidence, source-quality, and safety/friction dimensions for richer content understanding.
- Projected positive fingerprint dimensions into the mood feature index as a separate source, improving no-AI retrieval for searches such as nostalgic time travel in Paris.
- Fixed mood feature namespace preservation, added fingerprint rebuild tooling, and refreshed the MoodRank human/agent review docs and improvement plan.

## 0.1.0-alpha.13 - 2026-07-02

- Supersedes alpha.12 with the same preferred-example, ranking, Plex-link, and iOS alpha scaffold changes after tightening the rank-index coverage eval timeout for GitHub CI.

## 0.1.0-alpha.12 - 2026-07-02

- Added preferred mood examples with heart controls in comfortable, list, and compact result views, giving users a stronger representative-example signal than thumbs-up.
- Kept thumbs-up feedback from immediately reordering the visible result list while preserving explicit heart-driven ranking steering.
- Expanded candidate coverage and diagnostics for larger catalogs, kept AI reranking bounded to the top deterministic slice, and tightened Plex TV metadata links.
- Added the native SwiftUI iOS alpha scaffold and goal docs with Plex-first user auth, server URL persistence, search, feedback, poster proxy, and request preview/create flows.

## 0.1.0-alpha.11 - 2026-07-01

- Added a Screening Desk-style search processing overlay with progress, catalog-count, and result-target indicators for first searches and refinements.
- Added safe IMDb title links to result cards when valid stored IMDb IDs are available.
- Tightened recommendation explanation wording to avoid repetitive process language and repeated lead genres.

## 0.1.0-alpha.10 - 2026-07-01

- Fixed result-card Plex actions to open the reliable Plex web URL before falling back to custom app links.
- Restyled Seerr open/request actions as bottom card tabs with Seerr-colored treatment to match the Plex action pattern.
- Kept follow-up refinements on a fresh eligible-catalog search pass under the current availability filter.

## 0.1.0-alpha.9 - 2026-07-01

- Refined follow-up option generation so refinement turns avoid repeating already-requested directions and produce more decisive next-step choices.
- Added deterministic variation to recommendation explanations so repeated result cards do not all read with the same stock phrasing.
- Moved signed-in Plex user logout from the compact account chip into Admin access controls.

## 0.1.0-alpha.8 - 2026-07-01

- Calibrated visible match percentages so refined result lists no longer collapse many broad matches to `100%`.
- Kept internal ranking scores separate from display percentages, preserving refinement ordering while making visible confidence more granular.
- Moved repeated genre-feedback boosts off the `100%` ceiling so users can compare close recommendations more easily.

## 0.1.0-alpha.7 - 2026-07-01

- Added Wikidata-backed catalog import, normalization, readiness, and deterministic mood-enrichment tooling for the larger ranked catalog.
- Added candidate-first catalog search and scoped bulk inflation so local retrieval no longer scans the full catalog per query.
- Added a materialized catalog search index and benchmark harness for full-catalog latency regression checks.
- Preserved Plex and bounded Seerr gating so catalog-only items stay out of final recommendations unless they are attached or verified requestable.

## 0.1.0-alpha.6 - 2026-06-29

- Added MoodRank v0.4 rank-indexed full-library deterministic scoring so later refinement passes are not bounded by the first-stage retrieval candidate cap.
- Added v0.3-vs-v0.4 recommendation eval reporting and a regression case proving v0.4 can surface a valid match that v0.3's capped retrieval path misses.
- Expanded MoodRank eval coverage to 16 golden cases, 40 adversarial cases, and a 4-case v0.4-only rank-index stress suite.
- Raised AI reranking input to the top 100 deterministic candidates.
- Added signed-in Plex Watchlist support for available Plex items.
- Improved Plex sign-in return handling and item/refinement copy for the web app.

## 0.1.0-alpha.5 - 2026-06-18

- Added native-client user session support for Plex auth without granting admin access.
- Added recommendation `sessionId` responses and idempotent feel feedback retries for mobile clients.
- Published the alpha.5 container image for the EXP redeploy.

## 0.1.0-alpha.4 - 2026-06-18

- Added request-audit attribution fields for signed-in Plex users.
- Published the alpha.4 container image for the EXP redeploy.

## 0.1.0-alpha.3 - 2026-06-17

- Added Feel Profile scoring for user-specific mood language, including persisted profile terms, structured feel feedback events, and admin diagnostics/reset APIs.
- Added synthetic profile personalization evals with `PersonalizationLift@3` and term-level win/loss/tie reporting.
- Added synthetic profile journey evals, drift diagnostics, checkpoint rollback, and admin profile export/reset/rollback controls.
- Wired web result-card feedback into structured feel signals without storing raw prompts by default.
- Changed the default Finder result count from 20 to 50 and added an Admin setting for the default result count.
- Refreshed the public README, security reporting, release checklist, and Mood/Feel recommendation docs for public alpha.

## 0.1.0-alpha.2 - 2026-06-16

- Fixed bundled-container admin access by issuing an HTTP-only same-origin admin session from the container-side `MOODARR_ADMIN_TOKEN`.
- Added configurable OpenAI reasoning effort through env, Admin settings, and server-side persisted config.
- Defaulted GPT 5.5 reasoning effort to `low` and documented the new container knobs.

## 0.1.0-alpha.1 - 2026-06-16

- Initial local-first Plex + Seerr companion app MVP.
- Natural-language recommendation flow with deterministic retrieval, optional OpenAI parsing/reranking, feedback signals, and fixture-mode evaluation.
- Admin settings, sync controls, support diagnostics, and token redaction.
- Docker, Compose, and Unraid packaging scaffolding.
- Request preview/create confirmation, audit logging, and local request-state updates.
- Poster proxying with backend cache and secret-safe URL handling.
