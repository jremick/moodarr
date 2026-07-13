# Release Readiness

Moodarr is preparing its first early public beta release. Protected Git tags, immutable GitHub prereleases, and workflow-append-only GHCR version tags are published from exact verified commits and bound to recorded immutable image digests.

## Local Release Gate

```bash
npm audit
npm run verify:release
```

The release gate runs the tracked-content credential scan, lint, typecheck, server/web tests, production builds, generated-client secret-leak scan, recommendation evals, MoodRank release-readiness eval, packaging checks, and a Docker smoke test.

Native iOS verification remains a separate local gate and is not yet in GitHub CI. If the release changes `apps/ios` or a shared API response, run the Swift tests and unsigned simulator build from `apps/ios/README.md`; record that evidence in the release notes. Adding a macOS CI job remains open work.

## Automated Publish Gate

`.github/workflows/publish-image.yml` is a manual two-stage workflow that must be dispatched from its definition on `main`; version-tag pushes do not run privileged package publication code. Both stages call `.github/workflows/release-verify.yml` first. The reusable workflow checks out the requested ref, runs the full lockfile audit with `npm audit`, runs `npm run verify:release`, builds and scans the exact candidate source with Trivy, and returns the full verified commit SHA. The privileged job checks out the same ref and refuses to continue unless its full SHA exactly matches the verified SHA.

Accepted publish inputs:

- A full 40-character commit SHA builds and publishes only `sha-<full-40-character-sha>`. It never invents a semver tag and must equal the current `main` workflow-dispatch commit, not merely an older ancestor, so the attestation's source digest identifies the candidate source.
- A semver tag such as `v0.1.0-beta.1` does not build an image. It requires the already-published `sha-<full-40-character-sha>` candidate for the tagged commit plus the exact validated `candidate_digest`, verifies that candidate's attestation, and adds the version tag to those same manifest bytes.
- Branch names, abbreviated SHAs, and non-semver tags are rejected.
- Every accepted input must resolve to a commit reachable from `main`; a semantic input must also already exist as an exact Git tag and resolve to the verified commit.
- The workflow refuses candidate or version tags that already exist. A failed candidate requires a new commit and therefore a new full-SHA candidate tag.
- Semantic promotion fails unless the version tag is unused, the exact-commit candidate tag already exists, its registry digest matches the operator-supplied validated digest, and its GitHub artifact attestation verifies against this repository.
- Any candidate marker in the README, Unraid guidance, release state, or changelog blocks both SHA candidate publication and semantic promotion. Public copy must therefore be accurate before candidate publication and remain accurate after promotion; do not plan a source edit between the two stages.

Every candidate image includes maximum BuildKit provenance, an SPDX SBOM, and a GitHub artifact attestation. The image receives `MOODARR_VERSION` from `package.json`, `MOODARR_BUILD_REVISION` from the verified full commit, and a non-overridable `none` AI-provider policy baked into the server bundle and OCI labels so health/support output can identify its source and supported processing boundary. Promotion verifies the attestation's source digest, copies the candidate manifest bytes to the version tag through the registry API, and then reads them back; it does not rebuild or create a second attestation for the same digest. The immutable OCI index digest is the canonical image identity. Moodarr does not claim that an independent rebuild will be byte-for-byte reproducible; it avoids that weaker comparison by building the candidate once and promoting those exact manifest bytes.

GHCR's manifest-tag API does not provide this workflow with a guaranteed atomic create-only write. The workflow checks tag absence through the package API and again through the registry immediately before promotion, while repository package-write permission must remain restricted. Those controls make ordinary reruns and workflow races fail closed, but a separate privileged package writer racing the final registry request remains a residual administrative risk. Restrict package writers and review the final digest read-back.

## Two-Stage Beta Promotion

1. Freeze the release-ready source commit as the current `main` HEAD. Package version, changelog, README, Compose, Unraid template, and support/security copy must already be valid release copy, while GitHub Releases remains the source of truth for whether the version is publicly available.
2. Complete the pre-candidate evidence rows, then manually dispatch `publish-image.yml` from `main` with that HEAD's full 40-character commit SHA and an empty `candidate_digest`. If `main` advances before dispatch, review and freeze the new HEAD and publish a new candidate from it; do not move `main` backward solely for publication. Record the resulting `sha-<full-sha>` image and `sha256:...` digest.
3. Pull that candidate by digest and validate clean Docker, Compose, and Unraid installs plus upgrades, rollback, core integrations, browser behavior, performance, the published-digest vulnerability policy, SBOM/provenance content, and `gh attestation verify`. Put the exact digest and evidence links in the release ledger.
4. If any gate fails, do not reuse or overwrite the candidate tag. Fix the source, merge a new commit, and restart at step 2.
5. After all candidate-validation gates pass, create the protected `v0.1.0-beta.1` Git tag at the exact candidate commit. Manually dispatch the workflow with that tag and the validated `candidate_digest`.
6. Confirm the workflow reports the version tag and full-SHA candidate tag at the same digest. Re-run the raw-manifest digest and GitHub attestation read-back against the version tag. Because the semantic tag resolves to the already-scanned candidate index bytes, its attached BuildKit SBOM/provenance and candidate vulnerability report remain bound to that same digest. Only then create the immutable GitHub prerelease and announce it.

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

The read-only `Published digest supply-chain evidence` job in `.github/workflows/validate-beta-candidate.yml` closes the mechanical part of the supply-chain row against the actual published digest rather than a local rebuild. It:

- downloads the raw OCI index and recomputes its SHA-256 digest;
- verifies the single supported `linux/amd64` image and its version, revision, source, and license labels;
- reads the registry-attached BuildKit SLSA provenance, matches its client-supplied local-context VCS metadata to the expected source and revision, validates its build type, and validates the shape of its GitHub-run builder and content-addressed dependency records;
- reads and validates a non-empty SPDX 2.3 SBOM attached to that index;
- verifies the separate GitHub artifact attestation with the exact repository, publish workflow, source/signer commit, `refs/heads/main`, and hosted-runner policy; and
- scans the digest-qualified published image with the pinned Trivy version and tracked OpenVEX document, records every high/critical result, and fails on any unsuppressed fixable high/critical result.

The local-context VCS fields are metadata hints, not an independently authenticated source claim. The separate GitHub artifact attestation supplies the repository, default-branch workflow, source/signer commit, ref, and hosted-runner binding. The job uploads `beta-supply-chain-<full-sha>` from an explicit evidence allowlist: the manifest, image configuration, SPDX SBOM, scanner JSON/version, and compact `moodarr-beta-supply-chain-v1` summary. Buildx is configured not to add broad GitHub event/identity fields to BuildKit provenance, and the raw maximum-provenance copy is deleted to prevent duplicate workflow-artifact exposure; the registry-attached provenance remains publicly retrievable with the image. A green job is necessary but not sufficient for release: the package-writer ACL review, real install/integration/browser/performance evidence, maintainer decisions, semantic-tag digest read-back, and maintainer semantic-promotion and public-announcement approvals remain separate gates.

### Candidate Install, Upgrade, And Rollback Evidence

Two candidate-only validators turn the repeatable container mechanics into public-safe JSON evidence:

```bash
candidate_commit="<full-40-character-main-sha>"
candidate="ghcr.io/jremick/moodarr@sha256:<validated-candidate-digest>"

npm run --silent validate:beta-install -- \
  --candidate-image "$candidate" \
  --expected-version 0.1.0-beta.1 \
  --expected-revision "$candidate_commit" \
  > /tmp/moodarr-beta-clean-install.json

npm run --silent validate:beta-upgrade -- \
  --candidate-image "$candidate" \
  --expected-version 0.1.0-beta.1 \
  --expected-revision "$candidate_commit" \
  > /tmp/moodarr-beta-upgrade-rollback.json
```

Run them from a clean checkout of the exact candidate commit on a local Unix-socket Docker daemon that is natively `linux/amd64`. The install validator independently follows the raw-Docker and clean-directory Compose paths with new labeled resources, a generated credential set, and a private deterministic Plex/Seerr protocol stub. It requires Admin setup, production-adapter connection tests, an owned asynchronous sync, exact upstream poster bytes rather than an SVG fallback, support-output redaction, runtime hardening, restart and destroy/recreate persistence, mode-`0600` configuration, SQLite integrity and foreign-key checks, canonical Plex/Seerr relationship persistence, bounded operations, and owned cleanup. It also injects hostile provider environment values, rejects an authenticated provider-setting update and embedding warmup, requests AI during search, and proves that the baked policy, public/admin status, and response all remain local-only through every lifecycle.

The protocol stub proves Moodarr's packaged production adapter and persistence wiring without using real credentials. It does **not** replace the separate Plex, Seerr/Jellyseerr, Unraid, browser, or real-host compatibility rows in the release ledger.

The upgrade validator pins alpha.21 to OCI index `sha256:b7b5c254448a5ca28cac15c7970ee401a814357ac7b8707b0eda4d97b38936d6`, verifies its `linux/amd64` platform manifest and OCI labels, creates representative functional state through the published alpha API, takes a cold mode-`0600` archive, migrates only a dedicated copy to schema 28, verifies profile and audit preservation through restart, and restores the untouched archive into a fresh volume before starting the exact alpha image. It never starts alpha against migrated data.

The upgrade validator requires a fixed catalog floor of at least 80,000 representative items; successful synthetic-user capability and self-authored poster-blob migrations; preserved poster routing; preserved canonical profiles, checkpoints, feedback, request audits, media external IDs, the feedback-linked recommendation session and its result/trace graph, user sessions, and posters; unchanged semantic and raw-byte configuration hashes; and passing SQLite integrity and foreign-key checks before migration, after candidate restart, and after cold rollback. The self-authored poster is timestamped when the alpha fixture is created so this test exercises migration and preservation inside the current 180-day retention window; separate repository and API tests cover expired-cache eviction. Its public report must contain every applicable required check code:

- depth: `representative_catalog_80000`, `synthetic_user_capability_migrated`, `synthetic_poster_blob_migrated`, and `synthetic_poster_route_preserved`;
- release policy: `candidate_ai_policy_enforced`, proving a retained provider/key configuration, hostile environment values, authenticated Admin update, embedding warmup, requested-AI search, and repeated restarts cannot widen the official image's baked policy;
- canonical and profile-migration state: `recommendation_profile_sessions_migrated`, `canonical_profiles_preserved`, `canonical_checkpoints_preserved`, `canonical_feedback_preserved`, `canonical_request_audits_preserved`, `canonical_media_external_ids_preserved`, `canonical_catalog_relationships_preserved`, `canonical_recommendations_preserved`, `canonical_user_sessions_preserved`, `canonical_poster_preserved`, `config_hash_preserved`, and `config_raw_hash_preserved`; and
- database safety: `before_database_integrity`, `candidate_database_integrity`, `rollback_database_integrity`, `before_foreign_keys`, `candidate_foreign_keys`, and `rollback_foreign_keys`.

Every required check must pass; a smaller functional rehearsal cannot close the upgrade or rollback rows.

Both validators bind their source to the candidate checkout, accept an official candidate only by immutable GHCR digest, inspect the two-CPU/2-GiB/no-extra-swap runtime envelope, publish only allowlisted aggregate evidence, and remove only resources carrying their random ownership labels. OCI version and revision labels are necessary identity checks, but labels alone do not establish release eligibility. Before either official validator runs, the exact expected revision must be fetched and proven reachable from the current `origin/main`, and the candidate digest's GitHub artifact attestation must pass the repository, signer workflow, signer/source digest, `refs/heads/main`, and hosted-runner policy shown above. Local-image runs require explicit `--allow-local-image --allow-dirty`; architecture emulation additionally requires `--allow-emulation`. These rehearsals remain `releaseEligible: false` and exit nonzero even when their behavioral checks pass.

For a successful local rehearsal, the clean-install report must have `passed: true`, both Docker modes passing, no mode failures, and only the expected platform limitation at the top level. The upgrade report must have `status: "incomplete"`, an empty `failures` array, and only `local_rehearsal` plus, when applicable, `amd64_emulation` in `incomplete`. Any behavioral failure is a regression even though no local run can close a release-ledger row. Keep rehearsal JSON outside the checkout and replace it with the official native-Linux artifacts for candidate approval.

After the full-SHA candidate exists, the read-only manual workflow `.github/workflows/validate-beta-candidate.yml` runs the two behavioral validators and the published-digest supply-chain verifier on separate GitHub-hosted Ubuntu 24.04 `linux/amd64` jobs and uploads their JSON evidence. Dispatch it from that workflow's definition on `refs/heads/main` with the candidate's exact `sha256:...` digest and full commit; an authorization job rejects branch or stale workflow definitions before any candidate job starts. Each candidate job fetches `origin/main`, proves the expected revision is its ancestor, and verifies the digest's GitHub attestation with the exact policy above. The attestation command must succeed and produce a result, but its raw output is deleted rather than uploaded. The workflow has only `attestations: read`, `contents: read`, and `packages: read`; it cannot publish or promote an image. A failed workflow-definition, provenance, ancestry, behavioral validator, published-digest scan, or evidence-completeness check blocks the corresponding ledger row.

### Candidate Responsiveness Evidence

`npm run bench:beta-responsiveness` is the black-box candidate-only responsiveness gate. For beta.1 it drives the real HTTP API in `--ai-mode none` while a full Plex and Seerr sync, continuous health probes, deterministic search, and fresh recommendation diagnostics run concurrently. The official image is compiled with provider policy `none`; the run requires no OpenAI credential or external-processing confirmation. The harness does not run in CI or `verify:release` because it requires the official digest, a disposable production-sized data clone, and deliberate real-integration access.

Before running it:

- create a unique named Docker volume with `docker volume create --label io.moodarr.benchmark.disposable=true moodarr-beta-benchmark-data`, restore the stopped backup or atomic snapshot into that volume, and never bind-mount or reuse the live Moodarr data path;
- ensure no other running or stopped container references that benchmark volume; the harness requires the candidate to be its sole consumer;
- use a local Unix-socket Docker daemon and launch the exact digest-qualified candidate natively on Linux `amd64`, not through a remote Docker context or architecture emulation;
- bind the candidate only to loopback and add the container label `io.moodarr.benchmark.disposable=true`;
- retain the release limits: exactly two CPUs, 2 GiB memory with no additional swap (`--memory-swap 2g`), 128 PIDs, UID/GID `999:999`, read-only root, exactly `--cap-drop ALL`, no added capabilities, exactly `--security-opt no-new-privileges:true`, the named volume as the only `/data` mount, and exactly `--tmpfs /tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777`;
- set `MOODARR_SYNC_INTERVAL_MINUTES=0`, `MOODARR_SYNC_SEERR=true`, `MOODARR_REQUIRE_ADMIN_TOKEN=true`, and `MOODARR_ADMIN_AUTO_SESSION=false`;
- configure release-test Plex and Seerr/Jellyseerr against the disposable clone, keep provider credentials out of the env file, and verify the image label `io.moodarr.ai-provider-policy=none`; and
- understand that the run updates the disposable database. It does not send recommendation data to an AI provider and never calls request creation, Watchlist, settings mutation, user/profile mutation, feedback, Plex authentication, or connection-test routes.

Run the harness from a clean checkout of the candidate commit. Set `MOODARR_BENCH_ADMIN_TOKEN` securely in the current shell without putting it in command arguments. For the primary AI-off recipe, put the matching container admin token plus the release-test Plex and Seerr credentials in a mode-`0600` env file outside the checkout; do not put an OpenAI credential in that file. The following recipe restores a cold named-volume archive, launches the exact candidate envelope with `AI_PROVIDER=none`, and writes the artifact outside the checkout so the source-integrity preflight remains clean:

```bash
set -euo pipefail
umask 077
candidate_commit="<full-40-character-main-sha>"
candidate_digest="sha256:<validated-candidate-digest>"
candidate="ghcr.io/jremick/moodarr@$candidate_digest"
archive_helper="node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5"
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

npm run --silent bench:beta-responsiveness -- \
  --base-url http://127.0.0.1:4401 \
  --container "$benchmark_container" \
  --data-volume "$benchmark_volume" \
  --candidate-digest "$candidate_digest" \
  --expected-revision "$candidate_commit" \
  --expected-version 0.1.0-beta.1 \
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

The harness rejects non-numeric loopback targets, CLI token arguments, a remote Docker daemon, wrong image identity or provider-policy label, a non-Linux or non-native architecture, missing container or volume disposal labels, a shared benchmark volume, an unexpected port binding or data mount, altered resource or hardening limits, unsafe auth/scheduling state, an already-running sync, and catalogs below the fixed 80,000-item beta floor. It rejects a runtime mode that does not match the candidate and rejects `--confirm-external-processing` in beta.1's `none` mode. Authenticated requests reject redirects. Search is paced below its 40-request-per-minute limit. Every request and the overall 30-minute run are bounded.

The JSON report uses nearest-rank percentiles and contains only the selected AI mode, allowlisted candidate identity, the clean harness revision and source hash, a hash of the operator's catalog label, aggregate catalog counts, resource limits, mode-applicable stage coverage, relative timing samples, status/error categories, and log-marker counts. It excludes the admin token, URLs, raw catalog labels, host/container names, mount paths, raw queries, media titles, response bodies, provider errors, and raw logs. Store the file as a candidate-validation artifact and link it from the release ledger; do not paste raw container logs, configuration, databases, or support bundles into the PR.

Exit status is `0` only when the beta.1 evidence passes: at least 100 health, 20 deterministic-search, and 5 diagnostics samples; at least 20 health samples during fresh-diagnostics overlap; health p99 at or below 250 ms overall and during diagnostics overlap; search p95 at or below 5 seconds; successful full Plex and Seerr sync; total, Plex-available, and Seerr catalog counts preserved and reconciled within five percent; a nonempty observable log stream; and no bad HTTP response, SQLite lock marker, server 5xx marker, restart, OOM, fatal log marker, unhealthy Docker state, or failed health check observed by the continuous deduplicating watcher. Provider-embedding checks do not apply. Exit `1` means a measured gate failed. Exit `2` means invocation, environment, or evidence was incomplete. Any nonzero result abandons the candidate until the cause is resolved and a new source candidate is produced when code changes are required.

## Pre-Release Checklist

- Confirm `.env`, `.data`, `/data`, screenshots, restored backups, and support bundles are not tracked.
- Confirm the tracked-content scan and generated-client leak scan both pass.
- Confirm `SECURITY.md`, `DATA_AND_PRIVACY.md`, and `BACKUP_AND_RECOVERY.md` still describe the shipped behavior.
- Confirm the in-app About & Credits surface, `THIRD_PARTY_NOTICES.md`, TMDB logo provenance/hash, external-network disclosure, cache-retention tests, and exact candidate packaging agree.
- Verify the official server bundle, OCI label, runtime status, hostile-config tests, and candidate validators all enforce provider policy `none`; separately retain the TMDB poster/metadata authority and attribution evidence for the actual beta architecture.
- Confirm GitHub private vulnerability reporting remains available.
- Confirm the public repository/remote is `jremick/moodarr`.
- Confirm README, Compose, Unraid, package version, and changelog point at the intended versioned release tag and record its immutable digest.
- Verify GHCR package access grants write permission only to the Moodarr repository workflow and the minimum required maintainer accounts.
- Take and restore-test a data backup before schema-affecting deployment work.
- Keep the previous known-good image/tag available for rollback.
- Create or update the GitHub prerelease only after the version tag has been promoted to the validated candidate digest and the final read-back passes.

## Beta Release Identity

- Repository visibility: public.
- License: Apache-2.0.
- Security reporting: GitHub private vulnerability reporting.
- Target release image: `ghcr.io/jremick/moodarr:v0.1.0-beta.1`.
- Target GitHub prerelease: `v0.1.0-beta.1`.
- GitHub Releases is authoritative for whether this target is available; source references alone do not mean it has been published.
- Future changes stay under `Unreleased` until a new protected Git tag, workflow-append-only GHCR version tag, and immutable GitHub prerelease are intentionally created.

## Supply-Chain Posture

- npm dependencies are locked by `package-lock.json`; CI uses `npm ci` and production dependency audit.
- GitHub Actions are pinned to full commit SHAs, with Dependabot retaining weekly update coverage.
- Docker base images are pinned by digest, with Docker Dependabot retaining update coverage.
- Candidate publication and supply-chain read-back install the Linux `amd64` Buildx `v0.34.1` release asset only after verifying SHA-256 `f1332ddb9010bd0b72628266c3a906d9a6979848033df4c8d9bd2cd113bae12b`, before registry authentication. BuildKit `v0.30.0` and the BuildKit Syft scanner are pinned by OCI index digest, and the workflow verifies the running BuildKit version before publication or read-back so these release tools cannot silently drift during the beta gate.
- The runtime image is non-root and contains pruned production dependencies only.
- Published version and full-SHA candidate tags point to the same attested digest; the semantic stage never rebuilds the image.
- Candidate validation recomputes the published OCI index digest, validates the attached BuildKit SLSA provenance and SPDX 2.3 SBOM, and scans the exact digest-qualified image. This proves the identity and evidence attached to the published candidate; it is not a claim of byte-for-byte reproducibility from a later rebuild.
- The sole repository owner retains emergency administrator bypass for `main`. A commit created or merged through that bypass is never release-eligible until the required `verify` and `CodeQL` checks both pass at that exact commit.
- The live repository has an active [`v*` tag ruleset](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets) restricting version-tag creation, update, and deletion to the repository owner.
- [GitHub release immutability](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases) is enabled, so a published release locks its tag and assets against later mutation.

## Unraid Preflight

- Set a long random `MOODARR_ADMIN_TOKEN`.
- Keep `MOODARR_REQUIRE_ADMIN_TOKEN=true`.
- Keep `MOODARR_ADMIN_AUTO_SESSION=false` unless every LAN visitor is intentionally an administrator.
- Mount `/data` to private appdata storage and verify a backup restore.
- Confirm the container can reach Plex and Seerr through their LAN/container URLs.
- Keep the Web UI LAN/VPN-only unless TLS and an external authentication layer protect it.
