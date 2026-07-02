# Release Readiness

This repository is public and early alpha container images are published to GHCR. These checks prepare a commit for alpha tags, prerelease notes, and container image publishing.

## Local Release Gate

```bash
npm run verify:release
```

This runs lint, typecheck, tests, production build, client secret scan, recommendation evals, packaging checks, and a Docker smoke test.

## Pre-Publish Checklist

- Confirm `.env`, `.data`, `/data`, screenshots, and support bundles are not committed.
- Run `npm audit --omit=dev`.
- Run `npm run verify:release`.
- Review `SECURITY.md` and confirm GitHub private vulnerability reporting is available.
- Confirm the public GitHub repository/remote is `jremick/moodarr`.
- Confirm the Unraid template points at the intended image/tag.
- Confirm `OPENAI_MODEL`, Compose defaults, Unraid defaults, and README defaults match.
- Tag a release or create a GitHub prerelease only after CI passes on the exact commit.

## Public Repository Checklist

- Confirm the repository is still free of private hostnames, usernames, screenshots, tokens, and local support bundles.
- Confirm issue templates and the pull request template are present.
- Confirm `CONTRIBUTING.md`, `SECURITY.md`, `CHANGELOG.md`, `LICENSE`, and this release checklist are current.
- Confirm GitHub URLs in docs and the Unraid template point to `jremick/moodarr`.
- Keep package `"private": true` unless Moodarr is intentionally published to npm.
- Keep the GitHub release decision explicit. Alpha tags and GHCR images may exist before a GitHub prerelease is created.

## Current Alpha Release State

- Repository visibility: public.
- License: Apache-2.0.
- Security reporting: GitHub private vulnerability reporting.
- Current release candidate tag: `ghcr.io/jremick/moodarr:v0.1.0-alpha.12`.
- Next local candidate: keep future changes under `Unreleased` until a new tag or GitHub prerelease is intentionally created.

## Image Publishing

Container images are published to GHCR by `.github/workflows/publish-image.yml`. The workflow runs for pushed `v*` tags and can also be dispatched manually for an existing tag or SHA.

Do not push `latest` from ordinary branch builds. Publish immutable semver and Git SHA tags, then update the Unraid template after the image exists.

## Unraid Preflight

- Set `MOODARR_ADMIN_TOKEN`.
- Keep `MOODARR_REQUIRE_ADMIN_TOKEN=true`.
- Mount `/data` to private appdata storage.
- Confirm the container can reach Plex and Seerr by their LAN/container URLs.
- Keep the Web UI LAN/VPN-only unless another auth layer protects it.
