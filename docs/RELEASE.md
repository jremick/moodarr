# Release Readiness

Moodarr is public alpha software. Immutable prerelease tags, GitHub prereleases, and GHCR images are published from exact verified commits.

## Local Release Gate

```bash
npm audit --omit=dev
npm run verify:release
```

The release gate runs the tracked-content credential scan, lint, typecheck, server/web tests, production builds, generated-client secret-leak scan, recommendation evals, MoodRank release-readiness eval, packaging checks, and a Docker smoke test.

Native iOS verification remains a separate local gate and is not yet in GitHub CI. If the release changes `apps/ios` or a shared API response, run the Swift tests and unsigned simulator build from `apps/ios/README.md`; record that evidence in the release notes. Adding a macOS CI job remains open work.

## Automated Publish Gate

`.github/workflows/publish-image.yml` calls `.github/workflows/release-verify.yml` before publishing. The reusable workflow checks out the requested ref, runs `npm audit --omit=dev` and `npm run verify:release`, and returns the full verified commit SHA. The publish job checks out the same ref and refuses to continue unless its full SHA exactly matches the verified SHA.

Accepted publish inputs:

- A semver tag such as `v0.1.0-alpha.21` publishes both that version tag and `sha-<12-character-sha>`.
- A full 40-character commit SHA publishes only `sha-<12-character-sha>`; it never invents a semver tag.
- Branch names, abbreviated SHAs, and non-semver tags are rejected.

Every published image includes maximum BuildKit provenance, an SBOM, and a registry attestation. The image receives `MOODARR_VERSION` from `package.json` and `MOODARR_BUILD_REVISION` from the verified full commit so health/support output can identify its source.

## Pre-Publish Checklist

- Confirm `.env`, `.data`, `/data`, screenshots, restored backups, and support bundles are not tracked.
- Confirm the tracked-content scan and generated-client leak scan both pass.
- Confirm `SECURITY.md`, `DATA_AND_PRIVACY.md`, and `BACKUP_AND_RECOVERY.md` still describe the shipped behavior.
- Confirm GitHub private vulnerability reporting remains available.
- Confirm the public repository/remote is `jremick/moodarr`.
- Confirm README, Compose, Unraid, package version, and changelog point at the intended immutable release tag.
- Take and restore-test a data backup before schema-affecting deployment work.
- Keep the previous known-good image/tag available for rollback.
- Create or update the GitHub prerelease only after the exact image digest and verification result are known.

## Current Alpha Release State

- Repository visibility: public.
- License: Apache-2.0.
- Security reporting: GitHub private vulnerability reporting.
- Current release image: `ghcr.io/jremick/moodarr:v0.1.0-alpha.21`.
- Current GitHub prerelease: `v0.1.0-alpha.21`.
- Future changes stay under `Unreleased` until a new immutable tag and prerelease are intentionally created.

## Supply-Chain Posture

- npm dependencies are locked by `package-lock.json`; CI uses `npm ci` and production dependency audit.
- GitHub Actions are pinned to full commit SHAs, with Dependabot retaining weekly update coverage.
- Docker base images are pinned by digest, with Docker Dependabot retaining update coverage.
- The runtime image is non-root and contains pruned production dependencies only.
- Published version and SHA tags point to the same attested digest.

## Unraid Preflight

- Set a long random `MOODARR_ADMIN_TOKEN`.
- Keep `MOODARR_REQUIRE_ADMIN_TOKEN=true`.
- Keep `MOODARR_ADMIN_AUTO_SESSION=false` unless every LAN visitor is intentionally an administrator.
- Mount `/data` to private appdata storage and verify a backup restore.
- Confirm the container can reach Plex and Seerr through their LAN/container URLs.
- Keep the Web UI LAN/VPN-only unless TLS and an external authentication layer protect it.
