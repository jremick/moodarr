# Contributing

Moodarr can be developed without Plex or Seerr. Fixture mode is the default when live integration credentials are absent.

## Prerequisites And Setup

- Node.js 24 or newer
- npm and the checked-in `package-lock.json`
- Docker only for container/release checks
- Xcode/Swift only when changing the native app or shared API contract

```bash
npm ci
cp .env.example .env
npm run dev
```

Use synthetic fixture data. Never place personal library exports, hostnames, credentials, screenshots, support bundles, or production databases in the repository.

## Repository Map

- `src/client`: React web client and same-origin API adapter.
- `src/server`: Fastify API, integrations, SQLite repositories, security utilities, and recommendation pipeline.
- `src/shared/types.ts`: web/server TypeScript contracts.
- `tests`: server, web utility, integration, security, and recommendation tests.
- `scripts`: deterministic evaluation, import, verification, and packaging tools.
- `apps/ios`: native SwiftUI client with separately duplicated API models.
- `docs/design/opus-design-system.html`: UI design-system source of truth.
- `docs/design/opus-admin-mockup.html`: approved Admin redesign direction.

When a server response contract changes, inspect the web adapter and duplicated Swift models before calling the change complete.

## Verification

Run the normal pull-request gate:

```bash
npm run verify
npm run eval:recommendations
```

`npm run verify` scans tracked content for credential patterns, lints, typechecks, runs tests, builds client/server bundles, and checks generated client assets for configured-secret leaks.

For release, packaging, Dockerfile, Compose, Unraid, or deployment changes:

```bash
npm audit --omit=dev
npm run verify:release
```

`verify:release` builds and smoke-tests the Docker image, so Docker is required.

Native iOS verification is intentionally not part of GitHub CI yet. This is a visible release gap, not evidence that iOS compatibility is guaranteed. Changes under `apps/ios` or to shared API behavior must run the local Swift tests and an unsigned simulator build documented in `apps/ios/README.md` before review.

## Security And Privacy Rules

- Never commit Plex, Seerr, OpenAI, admin, user-session, or signed-in-user Plex tokens.
- Keep Plex library/catalog operations read-only; Watchlist is a separate explicit Plex write.
- Do not create Seerr requests automatically from model output. Preview and explicit user confirmation remain mandatory.
- Keep fixture data synthetic or public-catalog generic.
- Do not weaken the default `MOODARR_ADMIN_AUTO_SESSION=false`. Auto-session makes every visitor who can load the bundled UI an administrator and is only for fully trusted LANs.
- When OpenAI is enabled, minimize and document every outbound query, preference, candidate-metadata, or embedding field. See `docs/DATA_AND_PRIVACY.md`.
- Preserve bounded upstream response reads, URL-origin credential isolation, log redaction, and private data-file permissions.

The tracked-content scanner intentionally reports file, line, and pattern kind without printing the possible secret. If a safe synthetic fixture triggers it, narrow the fixture or add a tightly scoped scanner exception; do not weaken the pattern globally without a regression test.

## Change Discipline

- Add tests for behavior and failure boundaries, not only happy-path implementation details.
- Keep API request validation bounded and explicit.
- Update current behavior docs when routes, configuration, privacy boundaries, packaging, or release workflows change.
- For recommendation changes, follow the reporting standard in `docs/MOODRANK_CURRENT_ALGORITHMS.md` and run the relevant evals.
- Do not publish images or create releases from a contributor workstation. The publish workflow verifies the exact ref before pushing an image.
