# Release Readiness

Moodarr is early public beta software. Protected Git tags, immutable GitHub prereleases, and workflow-append-only GHCR version tags are published from exact verified commits and bound to recorded immutable image digests.

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

Every candidate image includes maximum BuildKit provenance, an SBOM, and a registry attestation. The image receives `MOODARR_VERSION` from `package.json` and `MOODARR_BUILD_REVISION` from the verified full commit so health/support output can identify its source. Promotion verifies the attestation's source digest, copies the candidate manifest bytes to the version tag through the registry API, and then reads them back; it does not rebuild or create a second attestation for the same digest.

GHCR's manifest-tag API does not provide this workflow with a guaranteed atomic create-only write. The workflow checks tag absence through the package API and again through the registry immediately before promotion, while repository package-write permission must remain restricted. Those controls make ordinary reruns and workflow races fail closed, but a separate privileged package writer racing the final registry request remains a residual administrative risk. Restrict package writers and review the final digest read-back.

## Two-Stage Beta Promotion

1. Freeze the release-ready source commit as the current `main` HEAD. Package version, changelog, README, Compose, Unraid template, and support/security copy must already be valid release copy, while GitHub Releases remains the source of truth for whether the version is publicly available.
2. Complete the pre-candidate evidence rows, then manually dispatch `publish-image.yml` from `main` with that HEAD's full 40-character commit SHA and an empty `candidate_digest`. If `main` advances before dispatch, review and freeze the new HEAD and publish a new candidate from it; do not move `main` backward solely for publication. Record the resulting `sha-<full-sha>` image and `sha256:...` digest.
3. Pull that candidate by digest and validate clean Docker, Compose, and Unraid installs plus upgrades, rollback, core integrations, browser behavior, performance, SBOM/provenance availability, and `gh attestation verify`. Put the exact digest and evidence links in the release ledger.
4. If any gate fails, do not reuse or overwrite the candidate tag. Fix the source, merge a new commit, and restart at step 2.
5. After all candidate-validation gates pass, create the protected `v0.1.0-beta.1` Git tag at the exact candidate commit. Manually dispatch the workflow with that tag and the validated `candidate_digest`.
6. Confirm the workflow reports the version tag and full-SHA candidate tag at the same digest. Re-run digest and attestation read-back against the version tag, then create the immutable GitHub prerelease and announce it.

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

Run the documented Docker and Compose flows with that reference. For Unraid candidate validation, temporarily put the same digest-qualified reference in the Repository field; restore the checked-in semantic tag only after the workflow promotes it to that digest. Inspect the registry's image index/referrers or GitHub package UI to confirm BuildKit provenance and SBOM artifacts are attached to the candidate digest.

## Pre-Release Checklist

- Confirm `.env`, `.data`, `/data`, screenshots, restored backups, and support bundles are not tracked.
- Confirm the tracked-content scan and generated-client leak scan both pass.
- Confirm `SECURITY.md`, `DATA_AND_PRIVACY.md`, and `BACKUP_AND_RECOVERY.md` still describe the shipped behavior.
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
- The runtime image is non-root and contains pruned production dependencies only.
- Published version and full-SHA candidate tags point to the same attested digest; the semantic stage never rebuilds the image.
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
