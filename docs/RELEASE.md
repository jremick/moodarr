# Release Readiness

This project is not published live yet. These checks prepare it for open-source publication and later container image publishing.

## Local Release Gate

```bash
npm run verify:release
```

This runs lint, typecheck, tests, production build, client secret scan, recommendation evals, packaging checks, and a Docker smoke test.

## Pre-Publish Checklist

- Confirm `.env`, `.data`, `/data`, screenshots, and support bundles are not committed.
- Run `npm audit --omit=dev`.
- Run `npm run verify:release`.
- Review `SECURITY.md` and make the repository security reporting path available.
- Confirm the Unraid template points at the intended image/tag.
- Confirm `OPENAI_MODEL`, Compose defaults, Unraid defaults, and README defaults match.
- Tag a release only after CI passes on the exact commit.

## Future Image Publishing

When ready to publish images, add a separate release workflow that pushes to GHCR on tags only. Do not push `latest` from ordinary branch builds. Prefer immutable semver and Git SHA tags, then update the Unraid template after the image exists.

## Unraid Preflight

- Set `FEELERR_ADMIN_TOKEN`.
- Keep `FEELERR_REQUIRE_ADMIN_TOKEN=true`.
- Mount `/data` to private appdata storage.
- Confirm the container can reach Plex and Seerr by their LAN/container URLs.
- Keep the Web UI LAN/VPN-only unless another auth layer protects it.
