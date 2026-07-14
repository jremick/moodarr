# Changelog

## 0.1.0-beta.1

- Advances Moodarr's target from public alpha to an early public beta for external self-hosters, with the Linux `amd64` web/server container as the supported product surface and the iOS client explicitly experimental.
- Hardened admin and Plex-user authentication, session and origin handling, external-write confirmation, integration URL validation, bounded provider calls, secret redaction, container isolation, and supply-chain verification.
- Moved expensive recommendation search and diagnostics off the request thread, and isolated full Plex/Seerr synchronization so health and Finder traffic remain responsive during maintenance; required worker roles now have bounded startup retries, generation-bound failure and deadline resets, clean queued-work rejection, degraded readiness through `/api/health`, and container health-check participation.
- Hardened the provisional source/EXP embedding path so model, dimensions, vector shape, feature version, exact input hash, and feature freshness must all match before a cached vector can be retrieved; incompatible rows are detected and gradually replaced without loading the entire catalog into memory. The official beta.1 image remains provider-locked.
- Added a copy-safe named-volume Compose path, non-root container smoke coverage, digest-bound release identity checks, CodeQL and image scanning, SBOM/provenance attestations, and a default-branch ancestry gate for semantic release tags.
- Added public beta support, compatibility, upgrade, rollback, backup, privacy, and measurable release-criteria contracts; added a curated documentation entry point and privacy-safe setup-question form, removed vendor-shaped action glyphs in favor of text labels, and corrected support-bundle privacy wording and stale public metadata.
- Refactored the web client into focused Finder, Admin, review, and diagnostics modules while retaining the Screening Desk design system; decorative icons are hidden from assistive technology and fast visual search progress now announces only meaningful phase changes.
- Added an explicit protected-instance Finder unlock path, preserved request confirmation after uncertain failures, updated successful request cards immediately, serialized interactive mutations against search/navigation races, and tightened request-action contrast and disclosure semantics.
- Bound OCI version/revision labels to the verified package version and full commit, and aligned the Unraid template and documentation with the shellless UID/GID `999:999` distroless runtime.
- Added a digest-bound black-box beta responsiveness harness with disposable-data confirmation, exact container/resource checks, full-sync proof, concurrent health/search/diagnostics sampling, safe public JSON evidence, and deterministic threshold/ownership tests; provider-work checks remain available only for source/EXP and future-release analysis.
- Corrected responsiveness reconciliation to distinguish raw Plex editions from distinct Plex media and consolidated Seerr snapshot records from distinct persisted media, while allowing deliberately retained conservative Seerr history; versioned the live baseline semantics, bound each measured search response to its submitted query, reject any total catalog loss or active catalog-source count or identity/mapping drift, and retain a five-percent reconciliation window only for operational Plex and Seerr snapshots.
- Replaced archive commands that could not run in the distroless release image with the digest-pinned, networkless build helper, protected host-created backup output, fresh restore-volume guards, and explicit runtime ownership repair.
- Documented the required alpha.21-to-beta.1 origin, persistent-mount, admin-session, UID/GID, and container-hardening changes instead of treating that upgrade as an image-only replacement.
- Required restore and rollback tests to run the exact recorded image digest with a running-container image read-back, and made the local Docker quick start loopback-only with separate trusted-LAN origin guidance.
- Closed the container memory envelope by setting memory-plus-swap equal to the 2 GiB memory limit in Docker, Compose, and Unraid examples.
- Added candidate-only clean Docker/Compose validation with private deterministic Plex/Seerr protocol stubs, exact poster proof, persisted restart/recreate checks, runtime-envelope inspection, and safe aggregate evidence; a controlled accepted-upstream/dropped-response path now proves uncertain Seerr creation reconciles without a duplicate POST and remains durable through recreation and the final sync.
- Added an immutable alpha.21-to-beta migration and cold-rollback validator with 80k representative-catalog, user-capability, self-authored poster-blob/route, feedback-linked recommendation-graph, canonical-state, semantic/raw configuration-hash, database-integrity, and foreign-key checks, plus a read-only native-Linux candidate workflow. This closes the validator's required depth as a harness capability; it does not claim that an official candidate has passed.
- Bound every candidate-validation job to a revision reachable from current `origin/main` before checked-out repository code can run and to the exact GitHub artifact-attestation policy, pinned attestation actions to peeled commit objects, and added credential-free anonymous exact-digest pull proof, published-index digest recomputation, exact-byte-verified Buildx installation, pinned BuildKit/SBOM tooling, attached SPDX/provenance validation, and an exact-digest Trivy evidence artifact.
- Added mode-`0600` SHA-256 sidecars, checksum-before-restore and archive-name checks, exact backup-time image-digest recording, and ownership-guarded failure cleanup to the backup/restore procedure.
- Replaced the provisional TMDB attribution/artwork path with a strict public-beta data boundary: the official image performs no Seerr descriptive search/detail ingestion, makes no direct TMDB request, serves no TMDB artwork, and retains locally supplied TMDB IDs only for interoperability with confirmed Seerr request attempts.
- Added fail-closed schema 29 sanitation for ambiguous Seerr-linked descriptions, artwork/cache rows, features, indexes, fingerprints, embeddings, and review snapshots while retaining factual IDs, user/profile/request state, and safe local relationships. A visible Admin readiness warning, explicit stale-materialization markers, and the packaged networkless trusted-catalog importer make required alpha recovery measurable; operational-only Seerr rows remain excluded from discovery.
- Made request preview explicitly describe an honest Seerr request attempt rather than an availability preflight, allowed trusted Plex/local-catalog TMDB IDs without a pre-existing Seerr row, and retained explicit confirmation, idempotency, uncertain-outcome reconciliation, and local request-state updates.
- Reduced confirmed-request responses to an explicit Seerr operational allowlist (`id` and normalized status), preventing nested upstream user, token, descriptive, or unknown fields from reaching the API or idempotency store. A live `2xx` without a positive numeric request ID is now an uncertain outcome rather than a false success, and schema 29 rebuilds legacy stored responses into the safe shape while clearing malformed or non-created response bodies.
- Made Seerr request-state snapshots fail closed on malformed movie/TV rows, bounded pagination and response bodies, rejected overlapping pages, ignored only explicit unsupported media types, and conservatively merged historical requests so an active or uncertain row cannot be made requestable by response order.
- Made Plex library snapshots require safe, unique upstream rating keys and reject repeated or overlapping pages before ingestion, with a second sync-runner identity guard preventing an unproven snapshot from marking omitted items unavailable.
- Finalized Plex availability by rating key rather than merged Moodarr item ID, so removing one edition no longer leaves its row falsely available; projected links now prefer an available, most-recent edition and library statistics count distinct Moodarr items.
- Baked non-overridable AI-provider and TMDB-content policies into the official beta.1 server bundle and OCI identity, rejected hostile runtime attempts to widen them, exposed both policies in health/config evidence, and excluded OpenAI plus descriptive Seerr/TMDB implementation markers from the release artifact.
- Added startup repair and benchmark health reporting for a materialized catalog index whose FTS projection is missing or incomplete, restoring exact indexed rows without changing ranking semantics and substantially reducing large-catalog retrieval latency.
- Added schema 30 retrieval indexes, exact hard-filter seeding, single-pass catalog-rank retrieval, and semantics-preserving scoring-loop caches; controlled 86k-item A/B runs retained identical top results while materially reducing deterministic search latency.
- Added schema 31 durable per-item integration-identity quarantine: an upstream record whose multiple strong identifiers resolve to different Moodarr items is skipped without rebinding stored IDs, safe sibling records continue, and request actions for the quarantined item remain blocked. This is separate from catalog importer ambiguity.
- Made the local catalog benchmark membership-aware, multi-pass, strict-argument parsed, directly contract-tested, and explicit about invalid evidence versus cache-sensitive advisory latency targets.
- Fixed startup feature repair so a stray feature row on an operational placeholder cannot hide a missing or stale feature document on an eligible catalog item.
- Bound pull-request and main CI to the exact event-source commit, added a read-only exact-source container scan and native Linux clean-install/alpha.21-upgrade matrix with 30-day allowlisted evidence, and kept package publication permissions out of the CI path.
- Required an explicit closed candidate-versus-promotion mode with the same full-SHA source input, limited the workflow to beta prerelease package versions, required the semantic Git tag to remain absent until the Tier 3-approved GHCR promotion succeeds, and disabled administrator bypass on both GitHub publication environments.
- Made semantic image promotion safely resumable after a successful GHCR write followed by a transient verification failure: a new Tier 3-approved run adopts only an existing manifest whose media type, registry and recomputed digests, and exact bytes match the validated candidate, while every mismatch remains non-overwritable and fail-closed.
- Made candidate publication require semantic Git-tag absence before push and fail closed after attestation unless anonymous raw OCI-index reads by the full-SHA tag and emitted digest have the same declared and response media type, registry and recomputed digest, and exact bytes, and the semantic GHCR version tag remains absent at final registry read-back.
- Added bounded retries and timeouts to candidate-validation and promotion registry reads while keeping the semantic manifest write bounded and deliberately non-retrying; captured token responses in private temporary files and rejected multiple, multiline, malformed, or unsafe token bodies before masking; clarified that invalid, expired, or incorrectly staged observations may be repeated against the same unchanged digest, while publication failures, confirmed published-identity mismatches, safety failures, or source/harness defects abandon the candidate, and made exact-digest validation and promotion rows explicitly non-waivable.
- Added a strict privacy-safe manual evidence contract and fail-closed runbook for exact-digest Unraid, real Plex/Seerr, native responsiveness, and current-stable Chrome, Edge, Firefox, and macOS Safari validation without publishing private host, account, media, request, or log data.
- Bound the retained responsiveness report's harness SHA-256 to the canonical benchmark-script blob at the expected Git revision, while documenting the broader manual matrix honestly as a structured operator attestation that still requires maintainer review.
- Replaced public Docker and Unraid shell examples that invited inline admin-token values with silent-prompt, mode-`0600` environment-file setup and `--env-file` usage; the Unraid Apps template retains its masked token field.
- Required full catalog snapshots to bind a regular non-symlink input, match both the validated manifest count and exact compressed SHA-256 before writes, re-hash the same file before commit, and roll back every catalog, derived-index, inactive-marking, and sync-evidence write on any failure.
- Added the separate `wikidata-20260622-min5-v1` CC0 beta catalog asset contract: 90,397 importable rows at pinned SHA-256 `dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a`, whole-file provenance/count validation, and a stopped networkless full-snapshot bootstrap path. Plex-only operation remains supported without the asset.
- Added narrowly scoped catalog request attempts for 82,865 ambiguity-safe records—70,841 movies and 12,024 TV series—while keeping their availability `unavailable` and visibly **not checked** in Seerr. Thirty-six groups share a strong importer identifier across 72 importable source records, including 59 otherwise eligible records—10 movies and 49 TV series; their ambiguous catalog materializations remain indexed for provenance and diagnostics but cannot independently surface in Finder or authorize request actions. Independently identified available Plex items remain discoverable, while catalog ambiguity still blocks preview and creation. Generic and verified-requestable-only searches exclude attempt rows, explicit request intent labels them separately, and preview remains non-writing until confirmation.
- Bound request creation to the previewed media type, TMDB interoperability ID, seasons, phrase, and confirmation token so stale identity changes fail closed; unresolved operations now serialize the shared Seerr write globally per item across users. A fresh preview after a prior successful request is declined advances a durable confirmation generation instead of replaying the cached success, and successful generation markers are not removed by failed-operation cleanup. Request previews also gain an explicit Cancel action without overlapping card controls, and full catalog snapshots no longer perform startup-repair writes outside their atomic transaction.
- Recorded version-pinned npm install-script approvals for the required `esbuild` binary setup and optional macOS `fsevents` binding, keeping clean installs explicit and warning-free under npm's install-script review policy.

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
