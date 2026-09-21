# Release Readiness

Moodarr's early-public-beta release process uses protected Git tags, immutable GitHub prereleases, and workflow-append-only GHCR version tags published from exact verified commits and bound to recorded immutable image digests.

## Current Release Truth

`v0.1.0-beta.1` was published from source commit `08447e87df2e1705aa9a79193a52a65fb00724c3` under an intentionally narrower early-beta gate. [GitHub issue #32](https://github.com/jremick/moodarr/issues/32) is the authoritative actual evidence and follow-up ledger. Extra fresh Unraid/update, stopped networkless catalog, dedicated real Plex and Seerr/Jellyseerr writes, production native `linux/amd64` 2 CPU/2 GiB responsiveness, current Chrome/Edge/Firefox/Safari, and comprehensive privacy-reviewed manual evidence remain open; do not infer completion from the published tag.

The [approved beta.2 early-release profile](BETA_RELEASE_CRITERIA.md#approved-beta2-early-release-profile) governs `v0.1.0-beta.2`; the comprehensive procedure below remains the completion contract for deferred hardening. The profile does not rewrite immutable beta.1 history or claim missing evidence passed. GitHub Releases remains authoritative for publication. The validators bind the chosen beta version to exact source and image identities. Beta.2 adds a direct beta.1 upgrade and cold-backup rollback check (`npm run validate:beta1-upgrade`) alongside the alpha.21 path. Passing source rehearsals does not replace published-digest evidence or complete a deferred manual row.

Beta.3 includes the Finder link/layout and catalog-import fixes and adds direct beta.2 upgrade, restart and cold-backup rollback validation (`npm run validate:beta2-upgrade`). The separate [approved beta.3 fixes profile](BETA_RELEASE_CRITERIA.md#approved-beta3-fixes-release-profile) governs its mandatory exact-image checks and named deferrals. GitHub Releases determines whether beta.3 is published.

## Local Release Gate

```bash
npm audit
npm run verify:release
```

The release gate runs the tracked-content credential scan, lint, typecheck, server/web tests, production builds, generated-client secret-leak scan, recommendation evals, MoodRank release-readiness eval, packaging checks, and a Docker smoke test.

Native iOS verification remains a separate local gate and is not yet in GitHub CI. If the release changes `apps/ios` or a shared API response, run the Swift tests and unsigned simulator build from `apps/ios/README.md`; record that evidence in the release notes. Adding a macOS CI job remains open work.

## Automated Publish Gate

`.github/workflows/publish-image.yml` is a manual two-stage workflow that must be dispatched from its definition on `main`; Git-tag pushes do not run privileged package publication code. Every dispatch supplies a closed `candidate` or `promotion` mode plus the exact full lowercase candidate commit SHA. Before candidate source is checked out or a protected environment is entered, the authorization job reads the dispatch commit's `.github/release-revocations.json` policy and rejects a matching source revision or digest. Both modes then call `.github/workflows/release-verify.yml`. The reusable workflow checks out that SHA, runs the full lockfile audit with `npm audit`, runs `npm run verify:release`, builds and scans the exact candidate source with Trivy, and returns the full verified commit SHA. The privileged job checks out the same SHA and refuses to continue unless its full SHA exactly matches the verified SHA. After protected-environment approval and immediately before either candidate push or semantic promotion, the privileged job fetches the latest protected `main`, requires it to descend from the dispatch commit, validates exactly one nonempty revocation-policy document, and rejects either matching identity again. This closes approval-wait races without executing policy code from the later commit.

The privileged job selects its GitHub environment from the validated closed mode. Full-SHA candidate publication uses the protected-branch-only `candidate-publication` environment without a reviewer wait so candidate evidence can be produced. Semantic promotion uses `beta-release`, whose required maintainer review is the Tier 3 approval boundary. The semantic Git tag must not exist before or during that approved image promotion. Do not remove or bypass the environment review to publish the GHCR version tag; candidate validation must finish before the reviewer approves semantic promotion. Create the protected Git tag manually only after the approved image-promotion job succeeds.

Accepted publish inputs:

- `release_mode=candidate` plus a full 40-character lowercase commit SHA builds and publishes only `sha-<full-40-character-sha>`. It never invents a semantic tag and must equal the current `main` workflow-dispatch commit, not merely an older ancestor, so the attestation's source digest identifies the candidate source.
- Before the push, candidate mode requires the semantic Git tag to be absent. After the candidate push and attestation, it obtains an anonymous public pull token and reads the raw OCI index by both the emitted digest and the full-SHA candidate tag. It succeeds only when both reads use the OCI-index media type, their registry and recomputed digests equal the emitted digest, their manifest JSON declares the OCI-index media type, their raw bytes are identical, and the semantic GHCR version tag returns `404`.
- `release_mode=promotion` takes that same candidate commit SHA plus the exact validated `candidate_digest`. After the `beta-release` approval, it requires the semantic Git tag to remain absent, verifies the already-published candidate and attestation, and adds `v<package-version>` to those same OCI manifest bytes without rebuilding. If a prior approved run wrote that version tag but failed during final read-back, a new approved dispatch may adopt it only after proving its registry digest, recomputed digest, media type, and raw bytes already equal the approved candidate.
- Branch names, tags, abbreviated SHAs, uppercase SHAs, unknown modes, and mode/digest mismatches are rejected.
- A revision or digest recorded in `.github/release-revocations.json` is rejected independently at dispatch and against the latest protected `main` immediately before registry mutation. A revoked candidate cannot be republished or promoted even if its old full-SHA tag, manifest, and attestation still exist. Cancel any publication run dispatched from a workflow definition that predates this two-point revocation gate.
- Every accepted SHA must resolve to a commit reachable from `main`.
- This workflow accepts beta prerelease package versions only. A stable version requires the separate stable-release gate; changing `package.json` alone cannot route a stable release through the beta environment.
- The workflow refuses candidate tags that already exist. A dispatch that fails before the full-SHA tag appears may be repeated only after independently proving that tag is still absent and rechecking the frozen `main` SHA and workflow definition. A publication failure after the full-SHA tag appears requires a new commit and candidate tag; candidate publication is never rerun for that tag. An existing semantic version tag is never overwritten: promotion accepts it only as an approval-gated resume when it is already the exact approved candidate manifest, and rejects every mismatch.
- Semantic promotion fails unless the semantic Git tag is absent, the exact-commit candidate tag already exists, its registry digest matches the operator-supplied validated digest, and its GitHub artifact attestation verifies against this repository. It creates an absent GHCR version tag or adopts an exact existing copy, then re-reads both GHCR tags and requires their media types, manifest bytes, and digests to match.
- Any candidate marker in the README, Unraid guidance, release state, or changelog blocks both SHA candidate publication and semantic promotion. Public copy must therefore be accurate before candidate publication and remain accurate after promotion; do not plan a source edit between the two stages.

Every candidate image includes maximum BuildKit provenance, an SPDX SBOM, and a GitHub artifact attestation. The image receives `MOODARR_VERSION` from `package.json`, `MOODARR_BUILD_REVISION` from the verified full commit, and non-overridable AI-provider and TMDB-content policies baked into the server bundle and OCI labels. The release gate requires `io.moodarr.ai-provider-policy=none` and `io.moodarr.tmdb-content-policy=none`, and health/support output reports the same processing boundary. Candidate publication first requires semantic Git-tag absence and finishes with the anonymous tag-and-digest raw-manifest self-readback plus semantic GHCR version-tag absence check described above. The Git remote preflight and registry `404` are point-in-time observations; they do not replace promotion's repeated Git-tag checks and version-tag probe. Promotion verifies the attestation's source digest, copies the candidate manifest bytes to an absent version tag through the registry API or verifies that an existing version tag is already the exact same manifest, and then reads both refs back; it does not rebuild or create a second attestation for the same digest. The immutable OCI index digest is the canonical image identity. Moodarr does not claim that an independent rebuild will be byte-for-byte reproducible; it avoids that weaker comparison by building the candidate once and promoting those exact manifest bytes.

GHCR's manifest-tag API does not provide this workflow with a guaranteed atomic create-only write. Candidate mode checks that its full-SHA tag is absent before pushing and then performs the anonymous raw-manifest self-readback, but a separately authorized package writer can still race either observation. Any candidate run that fails after the full-SHA tag appears is abandoned: do not delete, overwrite, or reuse that tag; merge and approve a new source commit instead. Promotion reads the version tag immediately before writing: a `404` permits one manifest PUT, a `200` permits no write and is accepted only when the existing registry digest, recomputed digest, media type, and raw bytes exactly match the approved candidate, and every other result fails. Registry token and manifest reads use bounded timeouts and retry-safe retries. Every token response is captured in a mode-`0600` temporary file and must contain exactly one bounded, safe-shape token before masking or use; retry-contaminated, multiline, or malformed responses fail closed without entering an authorization header. The manifest PUT is bounded but deliberately not retried automatically: an uncertain write is recovered only through a new Tier 3-approved promotion dispatch, which can adopt the exact existing bytes without rewriting them. Promotion re-reads both candidate and version manifests afterward and requires the protected semantic Git tag to stay absent through the approved job. If a PUT succeeds but a later network or read-back step fails, start a new `release_mode=promotion` dispatch with the same SHA and digest and obtain the `beta-release` approval again; the workflow will adopt the exact existing tag without rewriting it and repeat all final checks. Repository package-write permission must remain restricted. A separate privileged package writer can still race the final registry request because GHCR offers no atomic create-only condition; any mismatched pre-existing or final content fails closed. Restrict package writers and review the final digest read-back.

## Original Comprehensive Two-Stage Beta Promotion

The historical beta.2 [approved profile](BETA_RELEASE_CRITERIA.md#approved-beta2-early-release-profile) selected its required evidence. For beta.3, use its separate [fixes profile](BETA_RELEASE_CRITERIA.md#approved-beta3-fixes-release-profile); named deferrals never waive automated checks, mandatory catalog/runtime checks or known P0/P1 defects. Preserve the source-freeze, candidate validation, protected promotion, and final readback sequence below.

1. Freeze the release-ready source commit as the current `main` HEAD. Package version, changelog, README, Compose, Unraid template, and support/security copy must already be valid release copy, while GitHub Releases remains the source of truth for whether the version is publicly available.
2. Complete the pre-candidate evidence rows, then manually dispatch `publish-image.yml` from `main` with `release_mode=candidate`, that HEAD's full 40-character commit SHA, and an empty `candidate_digest`. If `main` advances before dispatch, review and freeze the new HEAD and publish a new candidate from it; do not move `main` backward solely for publication. Require the candidate job's pre-push semantic Git-tag absence check, anonymous full-SHA-tag/digest raw-manifest self-readback, and semantic GHCR version-tag `404` to pass, then record the full-SHA image, emitted digest, and successful workflow run.
3. Pull that candidate by digest and validate clean Docker, Compose, and Unraid installs plus upgrades, rollback, core integrations, browser behavior, performance, anonymous external digest availability, the published-digest vulnerability policy, SBOM/provenance content, and `gh attestation verify`. Validate the separately staged beta catalog bytes, perform the stopped networkless full-snapshot import, and prove request-attempt search isolation against the same candidate. Put the exact digest and evidence links in the release ledger.
4. If a gate confirms a mismatch in the independently resolved published OCI bytes, labels, platform, or attestation; a candidate, safety, or harness defect; or any fix changes source, do not reuse or overwrite the candidate tag. Fix the source, merge a new commit, and restart at step 2. If only the observation was invalid because evidence expired, an external/tooling condition changed before a result, the operator collection process failed, a pre-execution SHA/digest was mistyped, or an auxiliary catalog copy was staged incorrectly, discard that evidence and repeat the affected gate against the same unchanged digest only after recording the cause and re-verifying identity, attestation, cleanup, and safety. Correcting the tracked catalog/source contract is a source change and requires a new candidate. An unexpected, duplicated, or still-unresolved Moodarr-triggered external write after the required reconciliation and cleanup checks is not a retryable observation and abandons the candidate. Do not rerun candidate publication for an existing full-SHA tag.
5. After all candidate-validation gates pass, confirm `v0.1.0-beta.3` does not exist as a Git tag. Manually dispatch the workflow with `release_mode=promotion`, the validated candidate's full SHA, and its exact `candidate_digest`. Grant the required Tier 3 maintainer approval on `beta-release` only after reviewing the complete ledger. The approved job must add the GHCR version tag to the exact candidate bytes, or adopt it without a write when an earlier approved attempt already created that exact manifest, then re-read both GHCR refs at one media type and digest and finish while the semantic Git tag remains absent. If a post-write verification step fails, do not create the Git tag; use a new approval-gated dispatch with the same frozen inputs to resume.
6. Only after that approved workflow succeeds, manually create the protected `v0.1.0-beta.3` Git tag at the exact candidate commit. Read back its peeled commit, re-run the raw-manifest digest and GitHub attestation checks against the GHCR version tag, and require the version and full-SHA candidate tags to remain at the validated digest. Because the semantic image tag resolves to the already-scanned candidate index bytes, its attached BuildKit SBOM/provenance and candidate vulnerability report remain bound to that same digest. Only then prepare the GitHub prerelease as a draft with `gh release create --verify-tag`, attach the exact catalog asset and user-facing release notes, verify every draft asset's bytes and identity, publish the immutable prerelease, and announce it. Never omit `--verify-tag`: without it, GitHub CLI may create a missing semantic tag before this post-promotion boundary.

Use a remote tag read-back and fail-closed release creation command:

```bash
release_tag="v0.1.0-beta.3"
candidate_commit="<validated-full-40-character-sha>"
release_notes="<privacy-reviewed-release-notes.md>"
catalog_asset="<path>/moodarr-wikidata-20260622-min5-v1.jsonl.gz"

remote_tag_commit="$(
  git ls-remote origin "refs/tags/$release_tag" "refs/tags/$release_tag^{}" \
    | awk -v direct="refs/tags/$release_tag" -v peeled="refs/tags/$release_tag^{}" '
        $2 == direct { direct_sha = $1 }
        $2 == peeled { peeled_sha = $1 }
        END {
          if (peeled_sha != "") print peeled_sha
          else if (direct_sha != "") print direct_sha
        }
      '
)"
test "$remote_tag_commit" = "$candidate_commit"
gh release create "$release_tag" \
  --repo jremick/moodarr \
  --verify-tag \
  --target "$candidate_commit" \
  --draft \
  --prerelease \
  --title "Moodarr $release_tag" \
  --notes-file "$release_notes" \
  "$catalog_asset"
```

Use the digest, not only the candidate tag, throughout validation:

```bash
candidate_commit="<full-40-character-sha>"
candidate="ghcr.io/jremick/moodarr@sha256:<validated-digest>"
docker pull "$candidate"
MOODARR_IMAGE="$candidate" docker compose -f docker-compose.example.yml config
gh attestation verify "oci://$candidate" \
  --repo jremick/moodarr \
  --signer-workflow jremick/moodarr/.github/workflows/publish-image.yml \
  --signer-digest "$candidate_commit" \
  --source-digest "$candidate_commit" \
  --source-ref refs/heads/main \
  --deny-self-hosted-runners
```

Run the documented Docker and Compose flows with that reference. For Unraid candidate validation, temporarily put the same digest-qualified reference in the Repository field; restore the checked-in semantic tag only after the workflow promotes it to that digest.

### Candidate Supply-Chain Evidence

The read-only `Published digest supply-chain evidence` job in `.github/workflows/validate-beta-candidate.yml` closes the mechanical part of the supply-chain row against the actual published digest rather than a local rebuild. The publish job's immediate self-readback is a fail-closed publication guard; this independent job must still pass. It:

- requests a GHCR pull token without a GitHub credential, downloads the exact candidate digest before registry login, recomputes the public manifest digest, and records a compact anonymous-pull proof;
- downloads the raw OCI index and recomputes its SHA-256 digest;
- verifies the single supported `linux/amd64` image and its version, revision, source, and license labels;
- reads the registry-attached BuildKit SLSA provenance, matches its client-supplied local-context VCS metadata to the expected source and revision, validates its build type, and validates the shape of its GitHub-run builder and content-addressed dependency records;
- reads and validates a non-empty SPDX 2.3 SBOM attached to that index;
- verifies the separate GitHub artifact attestation with the exact repository, publish workflow, source/signer commit, `refs/heads/main`, and hosted-runner policy; and
- scans the digest-qualified published image with the pinned Trivy version and tracked OpenVEX document, records every high/critical result, and fails on any unsuppressed fixable high/critical result.

The anonymous probe runs before the job installs Buildx or authenticates Docker. It uses only the registry's public bearer-token exchange and never receives `github.token`, so it proves the digest is available through the same public package boundary external self-hosters need. Its token and manifest reads use the same bounded retry/timeout policy as candidate publication. The local-context VCS fields are metadata hints, not an independently authenticated source claim. The separate GitHub artifact attestation supplies the repository, default-branch workflow, source/signer commit, ref, and hosted-runner binding. The job uploads `beta-supply-chain-<full-sha>` from an explicit evidence allowlist: the anonymous-pull proof, manifest, image configuration, SPDX SBOM, scanner JSON/version, and compact `moodarr-beta-supply-chain-v1` summary. Buildx is configured not to add broad GitHub event/identity fields to BuildKit provenance, and the raw maximum-provenance copy is deleted to prevent duplicate workflow-artifact exposure; the registry-attached provenance remains publicly retrievable with the image. A green job is necessary but not sufficient for release: the package-writer ACL review, real install/integration/browser/performance evidence, maintainer decisions, semantic-tag digest read-back, and maintainer semantic-promotion and public-announcement approvals remain separate gates.

Candidate workflow artifacts are a 30-day transport window, not the sole durable ledger. Before they expire, record each Actions run and artifact ID, the service-reported artifact digest, the privacy-reviewed compact result, and the relevant report hash in the release PR or issue. Retain the downloaded allowlisted reports privately until `v0.1.0-beta.1` leaves the supported release window and any related release, upgrade, or security investigation is closed, and carry the final compact facts and hashes into the immutable prerelease notes. Do not publish raw logs or private manual evidence merely to extend retention.

### Candidate Catalog Asset Evidence

Missing-title discovery is supplied by a separate CC0 catalog release asset, not by the container image, repository, Plex, or Seerr descriptive APIs. Plex-only operation remains supported without it. Beta.1 has one accepted catalog identity:

- public filename: `moodarr-wikidata-20260622-min5-v1.jsonl.gz`;
- catalog version: `wikidata-20260622-min5-v1`;
- compressed SHA-256: `dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a`;
- 90,397 unique importable records;
- 82,865 ambiguity-safe request-attempt eligible records: 70,841 movies and 12,024 TV series; and
- source: the [Wikidata 2026-06-22 entity dump](https://dumps.wikimedia.org/wikidatawiki/entities/20260622/wikidata-20260622-all.json.bz2), with structured data covered by [Wikidata's CC0 licensing policy](https://www.wikidata.org/wiki/Wikidata:Licensing).

Thirty-six groups share a strong importer identifier across 72 importable source records. Fifty-nine of those records—10 movies and 49 TV series—otherwise meet request-attempt requirements. Their ambiguous catalog materializations remain imported and indexed for provenance and diagnostics but cannot independently surface in Finder or authorize request preview or creation; the release gate must not resolve the ambiguity by choosing an arbitrary record. An independently identified available Plex item may remain Finder-visible if linked later, but catalog ambiguity must still block every request action.

The tracked manifest [`catalog/moodarr-wikidata-20260622-min5-v1.manifest.json`](../catalog/moodarr-wikidata-20260622-min5-v1.manifest.json) is the public provenance and count contract. Stage the locally normalized bytes under the public filename without recompression or other transformation, then run the whole-file validator from the frozen candidate checkout:

```bash
catalog_asset="/absolute/private/path/moodarr-wikidata-20260622-min5-v1.jsonl.gz"
catalog_summary="/absolute/private/path/moodarr-beta-catalog-validation.json"

npm run --silent validate:beta-catalog-asset -- \
  --file "$catalog_asset" \
  > "$catalog_summary"
```

The command must exit `0` and report `status: "passed"`, catalog version `wikidata-20260622-min5-v1`, the exact compressed hash, all manifest sizes and counts, zero skipped records, and the pinned dump and normalizer provenance. Retain the privacy-safe summary in the candidate ledger. A hash, schema, duplicate-ID, decompression, record, count, provenance, or changed-during-read failure abandons the asset; do not repair the manifest to match unexpected bytes.

Use [Catalog Bootstrap](CATALOG_BOOTSTRAP.md) for the operator import contract and [Beta Catalog Import Validation](BETA_CATALOG_IMPORT_VALIDATION.md) for the reproducible exact-digest release procedure, cold integrity/content checker, API isolation checks, restart comparison, evidence fields and ownership-checked cleanup. Run the exact candidate image's packaged importer against disposable stopped candidate data with `--network none --mode full-snapshot --expected-source-records 90397 --expected-file-sha256 dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a`. Candidate evidence must prove matching `expectedFileSha256`/`fileSha256` output, atomic success, restart survival, ordinary generic-search isolation, verified-requestable-only isolation, and that explicit request-attempt search can surface an eligible row only as `unavailable`. The UI must say **Seerr request attempt** plus **Availability not checked** before **Try Request** and **Confirm Request Attempt**. This is request-attempt eligibility, not verified Seerr availability; API evidence does not establish the separately deferred rendered disclosure check.

Do not attach the asset to the full-SHA candidate image or advertise it as published during candidate validation. After Tier 3 semantic promotion and protected Git-tag creation, create the GitHub prerelease as a draft with `gh release create --verify-tag`, upload these exact catalog bytes, download or read the draft asset back, and re-run the SHA-256, size, and full validator checks. Publish only after the asset and release notes pass read-back; release immutability means a published asset cannot be corrected in place.

### Candidate Install, Upgrade, And Rollback Evidence

Four candidate-only validators turn the repeatable container mechanics into public-safe JSON evidence:

```bash
candidate_commit="<full-40-character-main-sha>"
candidate="ghcr.io/jremick/moodarr@sha256:<validated-candidate-digest>"

npm run --silent validate:beta-install -- \
  --candidate-image "$candidate" \
  --expected-version 0.1.0-beta.3 \
  --expected-revision "$candidate_commit" \
  > /tmp/moodarr-beta-clean-install.json

npm run --silent validate:beta-upgrade -- \
  --candidate-image "$candidate" \
  --expected-version 0.1.0-beta.3 \
  --expected-revision "$candidate_commit" \
  > /tmp/moodarr-beta-upgrade-rollback.json

npm run --silent validate:beta1-upgrade -- \
  --candidate-image "$candidate" \
  --expected-version 0.1.0-beta.3 \
  --expected-revision "$candidate_commit" \
  > /tmp/moodarr-beta1-upgrade-rollback.json

npm run --silent validate:beta2-upgrade -- \
  --candidate-image "$candidate" \
  --expected-version 0.1.0-beta.3 \
  --expected-revision "$candidate_commit" \
  > /tmp/moodarr-beta2-upgrade-rollback.json
```

Run them from a clean checkout of the exact candidate commit on a local Unix-socket Docker daemon that is natively `linux/amd64`. The install validator independently follows the raw-Docker and clean-directory Compose paths with new labeled resources, a generated credential set, and a private deterministic Plex/Seerr protocol stub. It requires Admin setup, production-adapter connection tests, an owned asynchronous sync, zero Seerr descriptive-detail calls, exact Plex poster bytes rather than an SVG fallback, an honest request-attempt preview, explicit confirmation, one ordinary upstream request POST with durable idempotency across restart/recreate, support-output redaction, runtime hardening, mode-`0600` configuration, SQLite integrity and foreign-key checks, canonical Plex/Seerr relationship persistence, bounded operations, and owned cleanup. A separate controlled create is accepted by the stub before its response is dropped; the validator requires Moodarr to persist an uncertain operation and failed audit, reconcile the same request and idempotency identity from Seerr state without a second upstream POST, return a stable reconciled response, and finish with exactly one durable request, one created reconciliation audit, and no remaining uncertain operation. It also injects hostile AI-provider and TMDB-content-policy environment values, rejects an authenticated provider-setting update and embedding warmup, requests AI during search, and proves that both baked policies, public/admin status, and response remain within the official local/operational boundary through every lifecycle.

The protocol stub proves Moodarr's packaged production adapter and persistence wiring without using real credentials. It does **not** replace the separate Plex, Seerr/Jellyseerr, Unraid, browser, or real-host compatibility rows in the release ledger.

The upgrade validator pins alpha.21 to OCI index `sha256:b7b5c254448a5ca28cac15c7970ee401a814357ac7b8707b0eda4d97b38936d6`, verifies its `linux/amd64` platform manifest and OCI labels, creates representative functional state through the published alpha API, takes a cold mode-`0600` archive, and migrates only a dedicated copy to schema 32. The schema-29 boundary step proves ambiguous live catalog-plus-Seerr and Plex-plus-Seerr rows are sanitized and excluded from both search indexes, with the catalog relationship marked `materialization_stale=1`; schema 30 then installs the bounded retrieval indexes used by the beta candidate; schema 31 adds durable per-item integration-identity quarantine; and schema 32 atomically rebuilds the derived catalog search projections from explicit allowlisted metadata without rewriting catalog source records. An upstream record whose multiple strong identifiers resolve to different Moodarr items is skipped without rebinding stored IDs, safe sibling records continue, and request actions for the quarantined item remain blocked. This integration quarantine is separate from catalog importer ambiguity. The running candidate performs a production-adapter, Plex-only full sync against the hardened protocol stub, restores the exact trusted Plex row and search result, and clears only the Plex refresh count while the catalog count remains pending. With the candidate stopped, the validator invokes that image's packaged networkless `dist/server/importWikidataCatalog.js --rehydrate-required` entry twice: first with `/data` mounted read-only for discovery, then with `/data` read-write for a write bound to the exact asset SHA, full source count, refresh source count, type-repair count, recovery count, and canonical plan SHA. Its three-record asset includes a latent alpha.21 movie/TV collision sharing one numeric TMDB ID and a unique existing correctly typed catalog target. The validator proves the wrong QID moves to that target, the TV companion remains bound to the old item, both typed TMDB identities survive, source and last-seen versions plus payload/content hashes are exact, both media and search types/titles are authoritatively rematerialized, stale poster/provider-embedding sentinels are absent, all repair and derived-state closure counts reach zero, and the entire write is atomic. It then restarts, requires the exact requestable catalog result and all four refresh-required diagnostics at zero, and restores the untouched archive into a fresh volume before starting the exact alpha image. It never starts alpha against migrated data.

The upgrade validator requires a fixed catalog floor of at least 80,000 representative items; successful synthetic-user capability, self-authored poster-blob preservation, and strict third-party-content sanitation; preserved safe poster routing; preserved canonical profiles, request audits, media external IDs, user sessions, catalog provenance, and explicitly allowlisted operational history; unchanged semantic and raw-byte configuration hashes; and passing SQLite integrity and foreign-key checks before migration, after candidate restart, and after cold rollback. It must also prove that unique legacy Seerr/TMDB descriptive sentinels are absent from materialized fields, artwork caches, features, indexes, fingerprints, embeddings, traces, and review snapshots while IDs, users, requests, and operational state remain. Catalog recovery must use the packaged importer, not direct fixture SQL; the recovered search result must be exact and requestable; and no refresh-required marker may remain. The checked-in validator's `knownCheckCodes` allowlist and transition assessment are authoritative; release review must at minimum confirm these release-critical groups:

- depth: `representative_catalog_80000`, `synthetic_user_capability_migrated`, `synthetic_poster_blob_migrated`, and `synthetic_poster_route_preserved`;
- release policy: `candidate_ai_policy_enforced`, proving a retained provider/key configuration, hostile environment values, authenticated Admin update, embedding warmup, requested-AI search, and repeated restarts cannot widen the official image's baked policy;
- trusted refresh: `trusted_refresh_legacy_seeded`, `trusted_refresh_candidate_sanitized`, `plex_refresh_full_sync_rehydrated`, `production_plex_full_sync`, `plex_refresh_required_cleared`, `plex_recovery_search_restored`, `packaged_trusted_catalog_refresh`, `trusted_refresh_catalog_rehydrated`, `trusted_catalog_requestable_search_restored`, `trusted_refresh_required_cleared`, `canonical_media_descriptions_sanitized`, `canonical_trusted_descriptions_rehydrated`, and `trusted_refresh_rollback_restored`;
- canonical and profile-migration state: `recommendation_profile_sessions_migrated`, `canonical_profiles_preserved`, `canonical_checkpoints_preserved`, `canonical_feedback_preserved`, `canonical_request_audits_preserved`, `canonical_media_external_ids_preserved`, `canonical_catalog_relationships_preserved`, `canonical_recommendations_preserved`, `canonical_user_sessions_preserved`, `canonical_poster_preserved`, `config_hash_preserved`, and `config_raw_hash_preserved`; and
- database safety: `before_database_integrity`, `candidate_database_integrity`, `rollback_database_integrity`, `before_foreign_keys`, `candidate_foreign_keys`, and `rollback_foreign_keys`.

The direct beta.1 and beta.2 validators use immutable published baselines and the same populated-state lifecycle. Beta.1 upgrades schema 31 to 34 and preserves its historical reconciled request-ID behavior. Beta.2 starts and finishes at schema 34, preserves the existing service-tier setting and reconciled request IDs, and requires unchanged configuration plus user, session, profile, feedback, request and operation data. Both restore the cold backup into a separate volume before running the exact previous image. Their reports must include all seven baseline-specific checks and all 25 lifecycle checks.

Every required check must pass; a smaller functional rehearsal cannot close the upgrade or rollback rows.

All four validators bind their source to the candidate checkout, accept an official candidate only by immutable GHCR digest, inspect the two-CPU/2-GiB/no-extra-swap runtime envelope, publish only allowlisted aggregate evidence, and remove only resources carrying their random ownership labels. They continue to request a 2 GiB memory-plus-swap ceiling. If Docker preserves that exact effective value, the enforced container ceiling passes normally regardless of host swap capacity. If a Docker host without swap-limit support normalizes the request to the observed `MemorySwap=-1` sentinel, the validators accept it only when a bounded, fail-closed read of `/proc/meminfo` contains exactly one valid `SwapTotal` field and that value is zero. That fallback rejects `MemorySwap=0`, every other effective value, missing or malformed host evidence, and positive host swap. OCI version and revision labels are necessary identity checks, but labels alone do not establish release eligibility. Before any official validator runs, the exact expected revision must be fetched and proven reachable from the current `origin/main`, and the candidate digest's GitHub artifact attestation must pass the repository, signer workflow, signer/source digest, `refs/heads/main`, and hosted-runner policy shown above. Clean local-image rehearsals require only explicit `--allow-local-image`. The `--allow-dirty` flag is limited to an explicit dirty or source-unbound developer escape hatch and always remains release-ineligible; architecture emulation separately requires `--allow-emulation`. All local rehearsals remain `releaseEligible: false` and exit nonzero even when their behavioral checks pass.

For a successful native local rehearsal, the clean-install report must have `passed: true`, both Docker modes passing, no mode failures, and an empty top-level `incomplete` array. An emulated clean-install rehearsal additionally carries the expected platform limitation. The alpha.21 upgrade report must have `status: "incomplete"`, an empty `failures` array, and only `local_rehearsal` plus, when applicable, `amd64_emulation` in `incomplete`. A direct beta.1 or beta.2 native rehearsal instead requires `passed: true`, `releaseEligible: false`, `lifecycle.passed: true`, empty lifecycle failures/incomplete arrays, and top-level `incomplete: ["local_image_rehearsal"]`; an emulated rehearsal additionally carries `amd64_emulation`. Any behavioral failure is a regression even though no local run can close a release-ledger row. Keep rehearsal JSON outside the checkout and replace it with the official native-Linux artifacts for candidate approval.

Default-branch CI includes a source-built native Linux validation matrix on GitHub-hosted Ubuntu 24.04 `linux/amd64`. Each isolated leg builds the exact checked-out source with the package version, event revision, and both baked provider policies set to `none`, then runs clean Docker/Compose installation, alpha.21 migration and cold rollback, or direct beta.1/beta.2 migration and cold rollback with only `--allow-local-image`. The expected exit code `1` is accepted only after the complete local-rehearsal contract passes: exactly 25 required checks per install mode, 107 required upgrade checks for alpha.21, or seven direct beta.1/beta.2 checks plus the 25 lifecycle checks, the exact native local report state, and no remaining owned containers, volumes, or networks. Each leg retains only its sanitized report and compact image identity for 30 days. This release-ineligible matrix is pre-candidate regression evidence; it cannot close the official published-digest clean-install, upgrade, or rollback rows.

After the full-SHA candidate exists, the read-only manual workflow `.github/workflows/validate-beta-candidate.yml` runs the four behavioral validators and the published-digest supply-chain verifier on separate GitHub-hosted Ubuntu 24.04 `linux/amd64` jobs and uploads their JSON evidence. Dispatch it from that workflow's definition on `refs/heads/main` with the candidate's exact `sha256:...` digest and full commit; an authorization job rejects branch or stale workflow definitions before any candidate job starts. Each candidate job fetches `origin/main`, proves the expected revision is its ancestor, and verifies the digest's GitHub attestation with the exact policy above. The supply-chain job first proves anonymous public access to the exact digest without passing a GitHub credential to that probe, then authenticates for the richer SBOM/provenance inspection. The attestation command must succeed and produce a result, but its raw output is deleted rather than uploaded. The workflow has only `attestations: read`, `contents: read`, and `packages: read`; it cannot publish or promote an image. A failed workflow-definition, anonymous-pull probe, provenance, ancestry, behavioral validator, published-digest scan, or evidence-completeness check blocks the corresponding ledger row.

### Exact-Digest Runtime and Desktop Smoke

This procedure records the exact-digest runtime and Finder smoke at desktop and narrow widths. Beta.2 used the beta.2 contract; the commands and beta.3 contract below target beta.3. Both schema identifiers retain their `v1` schema version. Run it after the same published digest passes the native candidate workflow. Use a disposable local instance, a fresh empty volume, fixture data, no integration credentials, and disabled scheduling. Automated application probes use GET. The browser may exchange the generated disposable admin credential for a local session, run fixture searches, change the Finder view, and activate the fixture titles' public IMDb/Trailer links. Do not sync, change integration settings, start Plex authentication, submit a media request, or use household data. The credential and session cookie must never appear in evidence.

This smoke may use Docker Desktop's `linux/amd64` emulation for the UI observation. Record that limitation. It proves only the fixture Finder interactions below; it cannot replace native automated install/upgrade/rollback, production responsiveness, the comprehensive browser matrix, or real integration evidence.

Use one Bash session with Docker, Node 24, `jq`, `curl`, and OpenSSL available. Set the final reviewed source SHA and verified OCI index digest below. Choose a local Unix-socket Docker context; do not use a remote daemon, existing deployment, live data, or wildcard port binding. Keep the private state directory until cleanup finishes.

~~~bash
set -euo pipefail
: "${CANDIDATE_REVISION:?Set the final reviewed 40-character SHA}"
: "${CANDIDATE_DIGEST:?Set the verified published sha256 digest}"
[[ "$CANDIDATE_REVISION" =~ ^[a-f0-9]{40}$ ]]
[[ "$CANDIDATE_DIGEST" =~ ^sha256:[a-f0-9]{64}$ ]]
SMOKE_CONTEXT="$(docker context show)"
docker_smoke() { docker --context "$SMOKE_CONTEXT" "$@"; }
[[ "$(docker context inspect "$SMOKE_CONTEXT" --format '{{(index .Endpoints "docker").Host}}')" == unix://* ]]
test "$(docker_smoke info --format '{{.OSType}}')" = linux
SMOKE_HOST_ARCH="$(docker_smoke info --format '{{.Architecture}}')"
case "$SMOKE_HOST_ARCH" in amd64|x86_64) SMOKE_EMULATED=false;; arm64|aarch64) SMOKE_EMULATED=true;; *) exit 1;; esac
umask 077
SMOKE_OWNER="$(openssl rand -hex 12)"
SMOKE_CONTAINER="moodarr-beta3-ui-$SMOKE_OWNER"
SMOKE_VOLUME="$SMOKE_CONTAINER-data"
SMOKE_NETWORK="$SMOKE_CONTAINER-net"
SMOKE_LABEL=io.moodarr.release-ui-smoke.owner
SMOKE_DIR="${TMPDIR:-/tmp}/moodarr-beta3-smoke-$SMOKE_OWNER"
mkdir -m 700 "$SMOKE_DIR"
SMOKE_PORT="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{const p=s.address().port;s.close(()=>console.log(p))})')"
SMOKE_IMAGE="ghcr.io/jremick/moodarr@$CANDIDATE_DIGEST"
for resource in container volume network; do
  case "$resource" in container) name="$SMOKE_CONTAINER";; volume) name="$SMOKE_VOLUME";; network) name="$SMOKE_NETWORK";; esac
  if docker_smoke "$resource" inspect "$name" >/dev/null 2>&1; then exit 1; fi
done
docker_smoke pull --platform linux/amd64 "$SMOKE_IMAGE"
docker_smoke image inspect "$SMOKE_IMAGE" | jq -e --arg image "$SMOKE_IMAGE" --arg revision "$CANDIDATE_REVISION" '
  .[0] | .Os == "linux" and .Architecture == "amd64" and any(.RepoDigests[]; . == $image)
  and .Config.Labels["org.opencontainers.image.revision"] == $revision
  and .Config.Labels["org.opencontainers.image.version"] == "0.1.0-beta.3"
  and .Config.Labels["io.moodarr.ai-provider-policy"] == "none"
  and .Config.Labels["io.moodarr.tmdb-content-policy"] == "none"
  and .Config.User == "999:999"' >/dev/null
SMOKE_IMAGE_ID="$(docker_smoke image inspect "$SMOKE_IMAGE" --format '{{.Id}}')"
jq -n --arg owner "$SMOKE_OWNER" --arg context "$SMOKE_CONTEXT" --arg revision "$CANDIDATE_REVISION" \
  --arg digest "$CANDIDATE_DIGEST" --arg imageId "$SMOKE_IMAGE_ID" --arg hostArchitecture "$SMOKE_HOST_ARCH" \
  --argjson emulated "$SMOKE_EMULATED" --argjson port "$SMOKE_PORT" \
  '{owner:$owner,context:$context,revision:$revision,digest:$digest,imageId:$imageId,
    hostArchitecture:$hostArchitecture,emulated:$emulated,port:$port}' > "$SMOKE_DIR/state.json"
{
  printf 'MOODARR_ADMIN_TOKEN=%s\n' "$(openssl rand -hex 32)"
  printf 'MOODARR_WEB_ORIGIN=http://127.0.0.1:%s\n' "$SMOKE_PORT"
  printf '%s\n' MOODARR_REQUIRE_ADMIN_TOKEN=true MOODARR_ADMIN_AUTO_SESSION=false \
    MOODARR_FIXTURE_MODE=true MOODARR_PLEX_AUTH_ENABLED=false MOODARR_SYNC_INTERVAL_MINUTES=0 \
    MOODARR_SYNC_SEERR=false 'PLEX_BASE_URL=' 'PLEX_TOKEN=' 'SEERR_BASE_URL=' 'SEERR_API_KEY=' \
    'OPENAI_API_KEY=' AI_PROVIDER=none MOODARR_TMDB_CONTENT_POLICY=none
} > "$SMOKE_DIR/app.env"
docker_smoke volume create --label "$SMOKE_LABEL=$SMOKE_OWNER" "$SMOKE_VOLUME" >/dev/null
docker_smoke network create --driver bridge --label "$SMOKE_LABEL=$SMOKE_OWNER" "$SMOKE_NETWORK" >/dev/null
docker_smoke run --detach --pull never --platform linux/amd64 --name "$SMOKE_CONTAINER" \
  --label "$SMOKE_LABEL=$SMOKE_OWNER" --network "$SMOKE_NETWORK" --env-file "$SMOKE_DIR/app.env" \
  --read-only --init --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 128 --memory 2g --memory-swap 2g --cpus 2 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777 --restart no --stop-timeout 30 \
  --publish "127.0.0.1:$SMOKE_PORT:4401" --mount "type=volume,src=$SMOKE_VOLUME,dst=/data" \
  "$SMOKE_IMAGE" >/dev/null
printf 'Private state: %s/state.json\nBrowser: http://127.0.0.1:%s/\n' "$SMOKE_DIR" "$SMOKE_PORT"
~~~

A port race must fail the launch; do not change to a wildcard bind. On failure after any resource is created, use the cleanup block below. The state file is recovery input, not a public artifact. Do not dump container inspection, environment, database, or raw application logs into the ledger.

Wait at most three minutes, then check identity, isolation, readiness, protected access, and served bytes. The envelope readback is repeated after the browser observation.

~~~bash
ready=false
for attempt in $(seq 1 90); do
  state="$(docker_smoke inspect "$SMOKE_CONTAINER" --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}')"
  if test "$state" = "running healthy"; then ready=true; break; fi
  case "$state" in exited*|dead*|*unhealthy*) break;; esac
  sleep 2
done
test "$ready" = true
smoke_envelope() {
  docker_smoke inspect "$SMOKE_CONTAINER" | jq -e --arg owner "$SMOKE_OWNER" --arg label "$SMOKE_LABEL" \
    --arg imageId "$SMOKE_IMAGE_ID" --arg volume "$SMOKE_VOLUME" --arg network "$SMOKE_NETWORK" --arg port "$SMOKE_PORT" '
    .[0] | if (.Config.Labels[$label] == $owner and .Image == $imageId
      and .State.Running and .State.Health.Status == "healthy" and .RestartCount == 0 and .State.OOMKilled == false
      and .HostConfig.PortBindings == {"4401/tcp":[{"HostIp":"127.0.0.1","HostPort":$port}]}
      and (.NetworkSettings.Networks | keys) == [$network]
      and (.Mounts | length) == 1 and .Mounts[0].Type == "volume" and .Mounts[0].Name == $volume
      and .Mounts[0].Destination == "/data" and .Mounts[0].RW)
    then {imageId:.Image,healthy:true,restarts:.RestartCount,oomKilled:.State.OOMKilled,envelopePassed:true}
    else error("Smoke runtime envelope failed.") end'
}
smoke_envelope > "$SMOKE_DIR/envelope-before.json"
docker_smoke exec -i "$SMOKE_CONTAINER" /nodejs/bin/node --input-type=module - \
  "$CANDIDATE_REVISION" "$CANDIDATE_DIGEST" "$SMOKE_IMAGE_ID" > "$SMOKE_DIR/runtime-readback.json" <<'NODE'
import assert from "node:assert/strict";
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
const [revision, digest, imageId] = process.argv.slice(2);
const check = (ok, message) => assert.ok(ok, message);
const token = process.env.MOODARR_ADMIN_TOKEN;
check(/^[a-f0-9]{64}$/.test(token ?? ""), "Invalid disposable credential.");
for (const key of ["PLEX_BASE_URL", "PLEX_TOKEN", "SEERR_BASE_URL", "SEERR_API_KEY", "OPENAI_API_KEY"])
  check(!process.env[key], "Unexpected integration setting.");
async function get(path, status = 200, authenticated = false) {
  const response = await fetch("http://127.0.0.1:4401" + path, {
    method: "GET", redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { Cookie: "moodarr_admin_locked=1", ...(authenticated ? { "X-Moodarr-Admin-Token": token } : {}) }
  });
  check(response.status === status && !response.headers.has("set-cookie"), "Unexpected response or cookie.");
  if (path.startsWith("/api/")) check(response.headers.get("cache-control") === "no-store", "API cache policy failed.");
  return response;
}
const health = await (await get("/api/health")).json();
check(health.ok && health.ready && health.database === "ok" && health.revision === revision
  && health.version === "0.1.0-beta.3" && health.fixtureMode === true, "Readiness identity failed.");
check(health.policies?.aiProvider === "none" && health.policies?.tmdbContent === "none", "Runtime policy failed.");
const config = await (await get("/api/config/status")).json();
check(config.fixtureMode === true && config.ai?.providerPolicy === "none" && config.ai.provider === "none"
  && config.ai.configured === false && config.seerr?.tmdbContentPolicy === "none", "Configuration policy failed.");
check(config.plex?.configured === false && config.seerr?.configured === false
  && config.auth?.plexAuthEnabled === false && config.runtime?.syncIntervalMinutes === 0
  && config.runtime.syncSeerr === false, "Integration or scheduler state failed.");
check(config.admin?.authRequired === true && config.admin.configured === true && config.admin.autoSession === false, "Admin boundary failed.");
await get("/api/admin/settings", 401);
await get("/api/library/stats", 401);
const session = await (await get("/api/admin/session")).json();
check(session.ok === false && session.autoSession === false, "Unexpected admin session.");
const settings = await (await get("/api/admin/settings", 200, true)).json();
check(settings.ai?.providerPolicy === "none" && settings.ai.provider === "none"
  && settings.seerr?.tmdbContentPolicy === "none", "Authenticated policy failed.");
const root = "/app/dist/client";
const inventory = readdirSync(root, { recursive: true }).filter(path => {
  const entry = lstatSync(root + "/" + path);
  check(!entry.isSymbolicLink() && /^[A-Za-z0-9_./-]+$/.test(path), "Invalid client artifact.");
  return entry.isFile();
}).sort(), assets = [];
check(inventory.length > 0 && inventory.length <= 1000, "Invalid client inventory.");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
for (const path of inventory) {
  const bytes = Buffer.from(await (await get(path === "index.html" ? "/" : "/" + path)).arrayBuffer());
  check(bytes.length <= 10000000 && sha256(bytes) === sha256(readFileSync(root + "/" + path)), "Served asset mismatch.");
  assets.push({ path, sha256: sha256(bytes) });
}
console.log(JSON.stringify({ revision, digest, imageId, version: "0.1.0-beta.3", ready: true,
  policies: health.policies, fixtureMode: true, integrationsConfigured: false, scheduledSyncEnabled: false,
  anonymousProtectedAccessRejected: true, disposableAdminReadAccepted: true, cookiesIssued: false,
  httpMethods: ["GET"], assets, nativeReleaseEvidence: false }));
NODE
curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:$SMOKE_PORT/api/health" |
  jq -e --arg revision "$CANDIDATE_REVISION" '.ready == true and .revision == $revision' >/dev/null
~~~

Open the printed loopback URL in a desktop browser at **1280 × 720**. Record its name/version, viewport and UTC time. Confirm that the Moodarr shell and protected Finder render. Select **Unlock Admin** to open the administrator sign-in boundary and check that Tab/Shift+Tab show visible focus. Enter the existing disposable token from the private env file directly into the masked **Admin token** field without printing, recording, or saving it in the browser, then submit **Unlock Admin**. From Admin, select **Open finder**, open **Finder chat**, and submit `science fiction` to search the fixture library.

At **1280 × 720** and again at **390 × 844**, inspect each Finder view: **Comfort**, **Compact**, and **List**. For each of the six combinations:

1. Capture a page-content screenshot without credentials or browser chrome. Check visible result cards: year/runtime must appear immediately below the poster, followed by the Trailer/IMDb controls. The two rows must not overlap. Record their DOM rectangles and assert this vertical order; the page must have no horizontal overflow or overlay blocking the controls.
2. On a fixture movie with both links, activate **Trailer** and **IMDb** once by pointer and once with **Enter** (24 activations in total). Verify a new tab/navigation targets the selected anchor's actual public IMDb or YouTube URL, then close that owned destination tab. Do not count inspecting `href` or programmatically invoking an anchor as activation evidence. Use normal browser input without forcing clicks, changing DOM/CSS, substituting assets, or mounting a different client bundle. Check visible keyboard focus and retain only the selected fixture title, method, expected URL and observed navigation result. A third-party consent or access page does not fail the application check if navigation to the correct destination is observed; no third-party interaction is required.
3. Record zero application console errors and zero unexpected failed same-origin requests. The deliberate protected-route `401` probes above are expected. Keep external site failures separate from application errors.

Pass only after all six view/viewport combinations and all 24 activations succeed. Sign-in and fixture search may create disposable local session/search records; they do not authorize external integration writes. Reset any temporary viewport override after testing.

After the browser check, repeat health and envelope checks, then close the tab before cleanup:

~~~bash
curl --fail --silent --show-error --max-time 10 "http://127.0.0.1:$SMOKE_PORT/api/health" |
  jq -e --arg revision "$CANDIDATE_REVISION" '.ready == true and .revision == $revision' >/dev/null
smoke_envelope > "$SMOKE_DIR/envelope-after.json"
~~~

Run cleanup after success or failure. Set `SMOKE_STATE` to the printed private state file if the original shell ended. Missing resources are harmless; an ownership mismatch stops deletion. Preserve the image cache and sanitized evidence.

~~~bash
set -euo pipefail
SMOKE_STATE="${SMOKE_STATE:-$SMOKE_DIR/state.json}"
SMOKE_DIR="$(dirname "$SMOKE_STATE")"
SMOKE_OWNER="$(jq -er .owner "$SMOKE_STATE")"
[[ "$SMOKE_OWNER" =~ ^[a-f0-9]{24}$ ]]
test "$(basename "$SMOKE_DIR")" = "moodarr-beta3-smoke-$SMOKE_OWNER"
test "$SMOKE_STATE" = "$SMOKE_DIR/state.json"
SMOKE_CONTEXT="$(jq -er .context "$SMOKE_STATE")"
[[ "$(docker context inspect "$SMOKE_CONTEXT" --format '{{(index .Endpoints "docker").Host}}')" == unix://* ]]
docker_smoke() { docker --context "$SMOKE_CONTEXT" "$@"; }
SMOKE_CONTAINER="moodarr-beta3-ui-$SMOKE_OWNER"
SMOKE_VOLUME="$SMOKE_CONTAINER-data"
SMOKE_NETWORK="$SMOKE_CONTAINER-net"
SMOKE_LABEL=io.moodarr.release-ui-smoke.owner
for resource in container volume network; do
  case "$resource" in container) name="$SMOKE_CONTAINER";; volume) name="$SMOKE_VOLUME";; network) name="$SMOKE_NETWORK";; esac
  if docker_smoke "$resource" inspect "$name" >/dev/null 2>&1; then
    docker_smoke "$resource" inspect "$name" | jq -e --arg owner "$SMOKE_OWNER" --arg label "$SMOKE_LABEL" --arg resource "$resource" \
      '.[0] | (if $resource == "container" then .Config.Labels else .Labels end)[$label] == $owner' >/dev/null
    if test "$resource" = container; then
      docker_smoke stop --time 30 "$name" >/dev/null
      docker_smoke container rm "$name" >/dev/null
    else docker_smoke "$resource" rm "$name" >/dev/null; fi
  fi
done
for resource in container volume network; do
  if test "$resource" = container; then
    remaining="$(docker_smoke container ls --all --quiet --filter "label=$SMOKE_LABEL=$SMOKE_OWNER")"
  else remaining="$(docker_smoke "$resource" ls --quiet --filter "label=$SMOKE_LABEL=$SMOKE_OWNER")"; fi
  test -z "$remaining"
done
rm -f -- "$SMOKE_DIR/app.env"
printf '{"ownedResourcesRemoved":true,"credentialFileRemoved":true}\n' > "$SMOKE_DIR/cleanup.json"
~~~

Create a privacy-reviewed `smoke-summary.json` with the following required fields. This is an operator attestation, not a new automated validator. Use `Pending` until every runtime, browser, and cleanup check passes and a maintainer reviews it; record `Failed` for a failed check. Never publish `state.json`, `app.env`, local-instance URLs or paths, resource names, tokens, response bodies, or raw logs. Public fixture IMDb/YouTube destinations are permitted in the activation evidence. The GET-only methods and cookie assertions in `runtime-readback.json` describe the automated probes before browser sign-in, not the later browser requests.

| Field | Required content |
| --- | --- |
| `schema`, `status`, `observedAt` | `moodarr-beta3-runtime-smoke-v1`; `Pending`, `Passed`, or `Failed`; UTC ISO-8601 time |
| `candidate` | Object with `version` (`0.1.0-beta.3`), full `revision`, OCI index `digest`, and local runnable `imageId` |
| `environment` | Object with `hostArchitecture`, `containerArchitecture` (`amd64`), Boolean `emulated`, `dockerVersion`, `browserVersion`, and `viewports` (`1280 × 720` and `390 × 844`) |
| `checks` | Boolean `readyBeforeAndAfter`, `officialPoliciesNone`, `protectedAccess`, `servedAssetsMatchImage`, `desktopRendered`, `narrowRendered`, `fixtureFinderVerified`, `yearRuntimeBeforeLinks`, `pointerAndKeyboardLinks`, `keyboardBoundary`, `noUnexpectedConsoleOrNetworkErrors`, `noRestartOrOom`, `ownedCleanup`, and `credentialRemoved`; all must be true to pass |
| `finder` | Six view/viewport observations with fixture title, card rectangles/order and overflow result; 24 pointer/Enter activation records with expected and observed destination; application console and same-origin request error counts |
| `artifacts` | Relative filenames and SHA-256 hashes for `runtime-readback.json`, `envelope-before.json`, `envelope-after.json`, six Finder screenshots, browser observations, and `cleanup.json`; retain the runtime's public asset-path/hash inventory |
| `limitations`, `reviewedBy` | `nativeReleaseEvidence: false`, `authenticatedFinderVerified: true`, `fixtureDataOnly: true`, `comprehensiveManualEvidence: false`; reviewer name and review UTC time |

Hash files with SHA-256 after capture. Record the reviewed compact summary facts and artifact hashes in the required beta.3 ledger row under the retention rules above. Link retained artifacts where accessible; otherwise identify their retention owner and storage class without publishing local paths. Full privacy-reviewed artifacts may remain in the maintainer's private evidence archive; public screenshot hosting is not required. Source/digest/image ID must agree across runtime evidence, browser observation, and summary.

Wrong identity or policy, unexpected credentials or data mounts, loss of protected access, unhealthy/restarting/OOM state, asset mismatch, rendering/focus failure, or incomplete owned cleanup blocks this row and promotion. Apply the existing candidate failure rules; emulation does not excuse failure or turn this smoke into native release evidence.

### Candidate Responsiveness Evidence

`npm run bench:beta-responsiveness` is the black-box candidate-only responsiveness gate. For beta.1 it drives the real HTTP API in `--ai-mode none` while a full Plex and Seerr sync, continuous health probes, deterministic search, and fresh recommendation diagnostics run concurrently. The official image is compiled with provider policy `none`; the run requires no OpenAI credential or external-processing confirmation. The harness does not run in CI or `verify:release` because it requires the official digest, a disposable production-sized data clone, and deliberate real-integration access.

Before running it:

- create a unique named Docker volume with `docker volume create --label io.moodarr.benchmark.disposable=true moodarr-beta-benchmark-data`, restore the stopped backup or atomic snapshot into that volume, and never bind-mount or reuse the live Moodarr data path;
- ensure no other running or stopped container references that benchmark volume; the harness requires the candidate to be its sole consumer;
- use a local Unix-socket Docker daemon and launch the exact digest-qualified candidate natively on Linux `amd64`, not through a remote Docker context or architecture emulation;
- bind the candidate only to loopback and add the container label `io.moodarr.benchmark.disposable=true`;
- retain the release limits: exactly two CPUs, 2 GiB memory with no additional swap (`--memory-swap 2g`), 128 PIDs, UID/GID `999:999`, read-only root, exactly `--cap-drop ALL`, no added capabilities, exactly `--security-opt no-new-privileges:true`, the named volume as the only `/data` mount, and exactly `--tmpfs /tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777`;
- on a host where Docker normalizes that requested swap ceiling to `MemorySwap=-1`, keep host `SwapTotal` at zero for the entire run; the harness records the directly observed value before and after the benchmark, binds it into the container-envelope fingerprint, and rejects positive, missing, malformed, or changed swap evidence;
- set `MOODARR_SYNC_INTERVAL_MINUTES=0`, `MOODARR_SYNC_SEERR=true`, `MOODARR_REQUIRE_ADMIN_TOKEN=true`, and `MOODARR_ADMIN_AUTO_SESSION=false`;
- configure release-test Plex and Seerr/Jellyseerr against the disposable clone, keep provider credentials out of the env file, and verify the image labels `io.moodarr.ai-provider-policy=none` and `io.moodarr.tmdb-content-policy=none`; and
- understand that the run updates the disposable database. It does not send recommendation data to an AI provider and never calls request creation, Watchlist, settings mutation, user/profile mutation, feedback, Plex authentication, or connection-test routes.

Run the harness from a clean checkout of the candidate commit. Set `MOODARR_BENCH_ADMIN_TOKEN` securely in the current shell without putting it in command arguments. For the primary AI-off recipe, put the matching container admin token plus the release-test Plex and Seerr credentials in a mode-`0600` env file outside the checkout; do not put an OpenAI credential in that file. The following recipe restores a cold named-volume archive, launches the exact candidate envelope with `AI_PROVIDER=none`, and writes the artifact outside the checkout so the source-integrity preflight remains clean:

```bash
set -euo pipefail
umask 077
candidate_commit="<full-40-character-main-sha>"
candidate_digest="sha256:<validated-candidate-digest>"
candidate="ghcr.io/jremick/moodarr@$candidate_digest"
archive_helper="node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553"
run_nonce="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(8).toString("hex"))')"
run_id="${candidate_commit:0:12}-$run_nonce"
benchmark_container="moodarr-beta-$run_id"
benchmark_volume="moodarr-beta-data-$run_id"
benchmark_env="/absolute/private/path/moodarr-beta-benchmark.env"
backup_archive="/absolute/private/path/moodarr-data.tgz"
benchmark_report="/tmp/moodarr-candidate-$run_id-responsiveness-ai-none.json"

: "${MOODARR_BENCH_ADMIN_TOKEN:?Set MOODARR_BENCH_ADMIN_TOKEN in the current shell}"
test "$(git rev-parse HEAD)" = "$candidate_commit"
test -z "$(git status --porcelain=v1 --untracked-files=all)"
test -f "$benchmark_env"
test -f "$backup_archive"
test "$benchmark_env" != "$backup_archive"
test "$(stat --format='%a' "$benchmark_env")" = 600
npm ci

if test -n "${DOCKER_HOST:-}"; then
  docker_endpoint="$DOCKER_HOST"
else
  docker_context="$(docker context show)"
  docker_endpoint="$(docker context inspect "$docker_context" --format '{{(index .Endpoints "docker").Host}}')"
fi
case "$docker_endpoint" in
  unix://*) ;;
  *)
    echo "Refusing non-local Docker endpoint: only a Unix socket is allowed." >&2
    exit 1
    ;;
esac

docker pull "$archive_helper"
docker pull "$candidate"

if docker container inspect "$benchmark_container" >/dev/null 2>&1; then
  echo "Refusing to reuse container $benchmark_container." >&2
  exit 1
fi
if docker volume inspect "$benchmark_volume" >/dev/null 2>&1; then
  echo "Refusing to reuse volume $benchmark_volume." >&2
  exit 1
fi
docker volume create \
  --label io.moodarr.benchmark.disposable=true \
  --label "io.moodarr.benchmark.run=$run_nonce" \
  "$benchmark_volume"
test "$(docker volume inspect --format '{{index .Labels "io.moodarr.benchmark.disposable"}}' "$benchmark_volume")" = true
test "$(docker volume inspect --format '{{index .Labels "io.moodarr.benchmark.run"}}' "$benchmark_volume")" = "$run_nonce"
test -z "$(docker ps --all --quiet --no-trunc --filter "volume=$benchmark_volume")"

docker run --rm \
  --network none \
  --user 0:0 \
  --read-only \
  --cap-drop ALL \
  --cap-add DAC_OVERRIDE \
  --security-opt no-new-privileges:true \
  --entrypoint /bin/tar \
  --mount "type=volume,src=$benchmark_volume,dst=/data" \
  --mount "type=bind,src=$backup_archive,dst=/tmp/moodarr-data.tgz,readonly" \
  "$archive_helper" \
  --no-same-owner -C /data -xzf /tmp/moodarr-data.tgz
docker run --rm \
  --network none \
  --user 0:0 \
  --read-only \
  --cap-drop ALL \
  --cap-add CHOWN \
  --security-opt no-new-privileges:true \
  --entrypoint /bin/chown \
  --mount "type=volume,src=$benchmark_volume,dst=/data" \
  "$archive_helper" \
  -R 999:999 /data

docker run --detach \
  --name "$benchmark_container" \
  --restart no \
  --init \
  --user 999:999 \
  --read-only \
  --cap-drop ALL \
  --security-opt no-new-privileges:true \
  --cpus 2 \
  --memory 2g \
  --memory-swap 2g \
  --pids-limit 128 \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777 \
  --publish 127.0.0.1:4401:4401 \
  --mount "type=volume,src=$benchmark_volume,dst=/data" \
  --label io.moodarr.benchmark.disposable=true \
  --label "io.moodarr.benchmark.run=$run_nonce" \
  --env-file "$benchmark_env" \
  --env NODE_ENV=production \
  --env MOODARR_API_HOST=0.0.0.0 \
  --env MOODARR_API_PORT=4401 \
  --env MOODARR_WEB_ORIGIN=http://127.0.0.1:4401 \
  --env MOODARR_SERVE_CLIENT=true \
  --env MOODARR_SYNC_INTERVAL_MINUTES=0 \
  --env MOODARR_SYNC_SEERR=true \
  --env MOODARR_REQUIRE_ADMIN_TOKEN=true \
  --env MOODARR_ADMIN_AUTO_SESSION=false \
  --env AI_PROVIDER=none \
  "$candidate"

for attempt in $(seq 1 60); do
  if test "$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$benchmark_container")" = healthy; then
    break
  fi
  if test "$attempt" -eq 60; then
    echo "Candidate did not become healthy." >&2
    exit 1
  fi
  sleep 2
done

# Establish the versioned same-candidate baseline outside the measured run.
# The token stays in this process environment and is never printed or passed
# as a command-line argument.
node --input-type=module <<'NODE'
const baseUrl = "http://127.0.0.1:4401";
const token = process.env.MOODARR_BENCH_ADMIN_TOKEN;
if (!token) throw new Error("MOODARR_BENCH_ADMIN_TOKEN is required.");
const headers = { "X-Moodarr-Admin-Token": token };
const request = async (path, init = {}) => {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
    redirect: "error",
    signal: AbortSignal.timeout(10_000)
  });
  if (!response.ok) throw new Error(`Baseline request ${path} returned HTTP ${response.status}.`);
  return response.json();
};
const before = await request("/api/admin/sync/status");
if (before.running) throw new Error("A sync is already running.");
const accepted = await request("/api/admin/sync/run", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: "{}"
});
const acceptedAt = Date.parse(accepted.startedAt ?? "");
if (!accepted.accepted || !Number.isFinite(acceptedAt)) throw new Error("Baseline sync was not accepted.");
const deadline = Date.now() + 30 * 60_000;
let observedRunning = false;
while (Date.now() < deadline) {
  const status = await request("/api/admin/sync/status");
  const progressAt = Date.parse(status.progress?.startedAt ?? "");
  if (status.running && Number.isFinite(progressAt) && progressAt >= acceptedAt) observedRunning = true;
  const result = status.lastResult;
  const resultAt = Date.parse(result?.startedAt ?? "");
  if (!status.running && Number.isFinite(resultAt) && resultAt >= acceptedAt && result?.finishedAt) {
    if (!observedRunning || result.ok !== true) throw new Error("Baseline sync ownership or completion was not proven.");
    if (!(result.plexItems > 0 && result.plexMediaItems > 0 && result.plexItems >= result.plexMediaItems)) {
      throw new Error("Baseline Plex counts were invalid.");
    }
    if (!(result.seerrItems > 0 && result.seerrMediaItems > 0 && result.seerrItems >= result.seerrMediaItems)) {
      throw new Error("Baseline Seerr counts were invalid.");
    }
    const recorded = status.history?.seerr?.some((run) =>
      run.source === "seerr_snapshot_v1" && run.status === "ok" && run.itemCount === result.seerrItems
    );
    if (!recorded) throw new Error("Versioned Seerr baseline history was not recorded.");
    process.stdout.write(`Prepared seerr_snapshot_v1 baseline for ${result.seerrItems} snapshot records.\n`);
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 2_000));
}
throw new Error("Baseline sync timed out.");
NODE

npm run --silent bench:beta-responsiveness -- \
  --base-url http://127.0.0.1:4401 \
  --container "$benchmark_container" \
  --data-volume "$benchmark_volume" \
  --candidate-digest "$candidate_digest" \
  --expected-revision "$candidate_commit" \
  --expected-version 0.1.0-beta.3 \
  --catalog-label production-clone-YYYY-MM \
  --min-catalog-items 80000 \
  --ai-mode none \
  --confirm-disposable-data \
  > "$benchmark_report"

node -e 'const fs=require("node:fs"); const value=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if(value.status!=="passed") process.exit(1)' "$benchmark_report"
```

Do not pass `--confirm-external-processing` in AI-off mode. The harness must observe `AI_PROVIDER=none`, and provider-embedding stage coverage, a nonzero embedding batch, embedding-overlap samples, and embedding p99 are not part of the AI-off result.

The harness retains an OpenAI mode for source/EXP development and future-release analysis. That mode is outside beta.1, cannot run against the official provider-locked image, and cannot satisfy or replace any beta.1 candidate row. Do not attach source/EXP provider evidence to the public beta.1 ledger.

Retain the private archive, env file, and benchmark volume until the evidence is reviewed. Then remove only the disposable resources named above:

```bash
docker rm --force "$benchmark_container"
docker volume rm "$benchmark_volume"
```

The harness rejects non-numeric loopback targets, CLI token arguments, a remote Docker daemon, wrong image identity or provider-policy label, a non-Linux or non-native architecture, missing container or volume disposal labels, a shared benchmark volume, an unexpected port binding or data mount, altered resource or hardening limits, unsafe auth/scheduling state, an already-running sync, and catalogs below the fixed 80,000-item beta floor. It rejects a runtime mode that does not match the candidate and rejects `--confirm-external-processing` in the beta's `none` mode. Authenticated requests reject redirects. Search is paced below its 40-request-per-minute limit. Every request and the overall 30-minute run are bounded.

The JSON report uses nearest-rank percentiles and contains only the selected AI mode, allowlisted candidate identity, the clean harness revision and source hash, a hash of the operator's catalog label, aggregate catalog counts, resource limits, mode-applicable stage coverage, relative timing samples, status/error categories, and log-marker counts. It excludes the admin token, URLs, raw catalog labels, host/container names, mount paths, raw queries, media titles, response bodies, provider errors, and raw logs. Store the file as a candidate-validation artifact and link it from the release ledger; do not paste raw container logs, configuration, databases, or support bundles into the PR.

Exit status is `0` only when the selected beta evidence passes: at least 100 health, 20 deterministic-search, and 5 diagnostics samples; at least 20 health samples during fresh-diagnostics overlap; health p99 at or below 250 ms overall and during diagnostics overlap; search p95 at or below 5 seconds; successful full Plex and Seerr operational-state sync; no decrease in the total media-item count; a production-sized active catalog-source baseline; exact preservation of both its row count and identity/mapping fingerprint; source-specific operational counts stable within five percent; distinct Plex-media counts preserved and reconciled within five percent; consolidated Seerr snapshot records reconciled within five percent of the distinct Moodarr media IDs persisted by that sync; the current Seerr snapshot staying within five percent of the most recent successful `seerr_snapshot_v1` baseline; and durable distinct requested-media state covering the current snapshot. The protected evidence endpoint computes SHA-256 over newline-delimited JSON arrays of `[source, source_item_id, media_item_id]`, sorted by those same fields. The retained public report exposes only the aggregate active count and the resulting pass/fail check, not that stable instance fingerprint. Run one successful same-candidate full sync on the otherwise unchanged disposable clone before the formal measured run so that the versioned baseline exists; unversioned alpha history is intentionally ineligible because it counted raw request rows before consolidation. Keep the Plex library and Seerr request state quiescent between that baseline sync and the measured run; upstream activity invalidates the comparison and requires a fresh baseline and measured run. New operational records may increase the total, but any item loss or active catalog-source drift fails the gate. Conservatively retained historical Seerr rows may make the durable count higher than the current snapshot and do not fail the gate. A passing run also requires a nonempty observable log stream and no bad HTTP response, SQLite lock marker, server 5xx marker, restart, OOM, fatal log marker, unhealthy Docker state, or failed health check observed by the continuous deduplicating watcher. The report records raw Plex rating-key/edition rows separately from distinct Plex media so multi-edition libraries do not distort reconciliation. Provider-embedding checks do not apply. Exit `1` means a measured gate failed. Exit `2` means invocation, environment, or evidence was incomplete. Any nonzero result abandons the candidate until the cause is resolved and a new source candidate is produced when code changes are required.

### Candidate Manual Evidence

Beta.2 and beta.3 defer this comprehensive matrix under their separate [beta.2](BETA_RELEASE_CRITERIA.md#approved-beta2-early-release-profile) and [beta.3](BETA_RELEASE_CRITERIA.md#approved-beta3-fixes-release-profile) profiles. Beta.3 still requires its exact-digest full catalog import, API request-attempt isolation and runtime smoke. The deferred rows remain incomplete; the validator is unchanged and no successful manual summary is implied.

Use [Beta Candidate Manual Validation](BETA_CANDIDATE_MANUAL_VALIDATION.md) as the original fail-closed procedure for evidence that fixture and source-built rehearsals cannot establish: exact-digest Unraid behavior, the exact catalog asset and stopped networkless full-snapshot import, request-attempt search/disclosure isolation, real Plex and Seerr/Jellyseerr writes and cleanup, the native responsiveness report hash, and the current-stable desktop browser/accessibility matrix. Start from its tracked all-false example and validate a completed privacy-reviewed file with `npm run validate:beta-manual-evidence`. The CLI binds the responsiveness harness hash to the canonical script blob at the expected Git revision, but the resulting matrix remains a structured operator attestation requiring maintainer review rather than independent automated proof. This comprehensive manual gate remains open for beta.1; validator exit `0` was the original completion rule, not a retroactive publication claim. Local images, source/EXP runs, emulation, and evidence inherited from another digest remain ineligible.

## Pre-Release Checklist

- Confirm `.env`, `.data`, `/data`, screenshots, restored backups, and support bundles are not tracked.
- Confirm the tracked-content scan and generated-client leak scan both pass.
- Confirm `SECURITY.md`, `DATA_AND_PRIVACY.md`, and `BACKUP_AND_RECOVERY.md` still describe the shipped behavior.
- Confirm the in-app About & Credits surface, `THIRD_PARTY_NOTICES.md`, external-network disclosure, absence of bundled third-party artwork/marks, and exact candidate packaging agree.
- Validate `moodarr-wikidata-20260622-min5-v1.jsonl.gz` against its tracked manifest, exact SHA-256 and counts, and stage those exact bytes for draft-prerelease read-back. Comprehensive completion also requires proof of the stopped networkless import and request-attempt isolation; beta.2 deferred that evidence and disclosed the catalog scaling limitation with its Plex-only workaround. Beta.3 requires this exact-digest import and API isolation evidence under its approved fixes profile.
- Verify the official server bundle, OCI labels, runtime status, hostile-config tests, migration sentinels, and candidate validators all enforce AI provider policy `none` and TMDB content policy `none`; the bundle must contain neither provider nor direct TMDB endpoints.
- Confirm GitHub private vulnerability reporting remains available.
- Confirm the public repository/remote is `jremick/moodarr`.
- Confirm README, Compose, Unraid, package version, and changelog point at the intended versioned release tag and record its immutable digest.
- Confirm the published candidate digest is anonymously pullable before any authenticated candidate inspection.
- Verify GHCR package access grants write permission only to the Moodarr repository workflow and the minimum required maintainer accounts.
- Take and restore-test a data backup before schema-affecting deployment work.
- Keep the previous known-good image/tag available for rollback.
- Create the GitHub prerelease draft only after the version tag has been promoted to the validated candidate digest. Upload and read back the exact catalog asset and release notes before publishing the immutable prerelease.

## Beta Release Identity

- Repository visibility: public.
- License: Apache-2.0.
- Security reporting: GitHub private vulnerability reporting.
- Published release image: `ghcr.io/jremick/moodarr:v0.1.0-beta.1`.
- Published GitHub prerelease: `v0.1.0-beta.1`, source commit `08447e87df2e1705aa9a79193a52a65fb00724c3`.
- Optional catalog release asset: `moodarr-wikidata-20260622-min5-v1.jsonl.gz`, catalog version `wikidata-20260622-min5-v1`, SHA-256 `dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a`.
- GitHub Releases is authoritative for release availability; [issue #32](https://github.com/jremick/moodarr/issues/32) is authoritative for beta.1 evidence and open follow-up.
- Future changes stay under `Unreleased` until a new protected Git tag, workflow-append-only GHCR version tag, and immutable GitHub prerelease are intentionally created.

## Supply-Chain Posture

- npm dependencies are locked by `package-lock.json`; CI uses `npm ci` and production dependency audit.
- GitHub Actions are pinned to full commit SHAs, with Dependabot retaining weekly update coverage.
- Docker base images are pinned by digest, with Docker Dependabot retaining update coverage.
- Candidate publication and supply-chain read-back install the Linux `amd64` Buildx `v0.34.1` release asset only after verifying SHA-256 `f1332ddb9010bd0b72628266c3a906d9a6979848033df4c8d9bd2cd113bae12b`, before registry authentication. BuildKit `v0.30.0` and the BuildKit Syft scanner are pinned by OCI index digest, and the workflow verifies the running BuildKit version before publication or read-back so these release tools cannot silently drift during the beta gate.
- The runtime image is non-root and contains pruned production dependencies only.
- Tier 3 approval precedes GHCR semantic promotion. The protected semantic Git tag is created manually only after that approved job succeeds; the version and full-SHA candidate image tags then point to the same attested digest, and the semantic stage never rebuilds the image.
- Candidate validation recomputes the published OCI index digest, validates the attached BuildKit SLSA provenance and SPDX 2.3 SBOM, and scans the exact digest-qualified image. This proves the identity and evidence attached to the published candidate; it is not a claim of byte-for-byte reproducibility from a later rebuild.
- `main` protection is strict and enforced for administrators. It app-binds `verify`, `CodeQL`, and `Scan exact event source image` as required PR merge checks, requires conversation resolution, and disallows force pushes and deletion. Before a candidate is authorized, the protected PR must have passed all three app-bound checks, and the exact merged default-branch commit must have successful CI and CodeQL workflow runs, a zero-result commit-bound CodeQL analysis, and a successful exact-source image scan.
- The live repository has an active [`v*` tag ruleset](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) restricting version-tag creation, update, and deletion to the repository owner.
- [GitHub release immutability](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases) is enabled, so a published release locks its tag and assets against later mutation.

## Unraid Preflight

- Set a long random `MOODARR_ADMIN_TOKEN`.
- Keep `MOODARR_REQUIRE_ADMIN_TOKEN=true`.
- Keep `MOODARR_ADMIN_AUTO_SESSION=false` unless every LAN visitor is intentionally an administrator.
- Mount `/data` to private appdata storage and verify a backup restore.
- Confirm the container can reach Plex and Seerr through their LAN/container URLs.
- If validating missing-title discovery, checksum the separate catalog asset, keep the app stopped, and use only the networkless full-snapshot procedure in [Catalog Bootstrap](CATALOG_BOOTSTRAP.md).
- Keep the Web UI LAN/VPN-only unless TLS and an external authentication layer protect it.
