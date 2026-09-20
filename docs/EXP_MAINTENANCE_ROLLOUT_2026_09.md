# EXP maintenance rollout

Recorded 20 September 2026. Dependency maintenance, completed source reconciliation, and desktop fixes are merged and deployed to EXP. This is a custom EXP image; no public beta release or release tag was created.

## Delivered source

| Batch | Delivery |
| --- | --- |
| Dependencies and build tooling | [PR 84](https://github.com/jremick/moodarr/pull/84), then security and patch updates in [PR 85](https://github.com/jremick/moodarr/pull/85). |
| Completed EXP source | [PR 86](https://github.com/jremick/moodarr/pull/86): shared-feedback disclosure, right-side chat, stale-warning handling, trusted origins, native callback, and bounded rerank diagnostics. |
| Desktop correctness | [PR 87](https://github.com/jremick/moodarr/pull/87): explicit TV seasons and preview invalidation, cancellation/deadline handling, and strict per-response usage accounting with historical cost eligibility. |

All required GitHub checks passed before each merge. The tested image source is `21ef83f7aaec486b35685f17291b7514fc55ec4b`; merged main `4a3d1273c2ec9d9cdfb2fe177da26be3f52e135e` has the same Git tree `1a93689ad5fe3e9cbaa262af89c5c6588da33bc8`.

## Running identity

- Version: `0.1.0-beta.2+exp.maintenance.20260920`.
- Runtime revision: `21ef83f7aaec486b35685f17291b7514fc55ec4b`.
- Image: `sha256:cb5ae86be3e8ecaa8341881c282d0e61d162a92485fc9f3ee059c48fe1e0bd91`.
- Container: `910a8d9342303d96c5e413a80ac165acd5c24d12a0cf040d6bcaa0076397abee`.
- Prior image: `sha256:d50d50e657cded2ac64c65407bb3103a33e09ad1040e571b31d2abf775c995d0`, retained in `moodarr-pre-exp-maintenance-20260920-attempt2`.

The successful attempt stopped the prior service at `09:29:50 UTC` and reported ready at `09:31:17 UTC`: 87 seconds between recorded timestamps, including cold backup and startup. Final health was healthy and ready, with zero restarts and no OOM. AI and TMDB policies remain configurable on EXP; official-image defaults are unchanged.

## Preservation and recovery

The rollout compared the exact operational environment, public configuration, mounts, entrypoint, healthcheck, and resource/security controls. Image-owned version/revision values and labels changed to identify the candidate. Secrets and runtime snapshots remained in the protected host evidence directory.

A fresh cold appdata backup passed compression testing, archive listing, and checksum verification. Its SHA-256 is `6f60043b1f06c3cdcd58a27609637f158f3214ceb48e38af59b94296f8ed3bef`. This establishes archive integrity; it is not an independent restore test.

Before and after deployment, SQLite `quick_check` returned `ok`; schema version 34 and all 35 migration IDs matched. All 17 recorded table counts, 12 retained-table hashes, and the configuration hash matched exactly. The specific source files `src/server/db/database.ts` and `src/server/config.ts` matched the prior EXP source. No database backup was restored.

The first attempt passed readiness, data preservation, and runtime smoke checks, then the final verifier rejected Docker's `OomKillDisable` representation changing from `false` to `null`. The guard stopped and retained that candidate, restored the prior container, and verified health plus exact retained data. The retry used the same application image. Its verifier treats only null/false as equivalent and rejects true, invalid types, and all other control/configuration changes. All 37 helper checks passed, including 17 regressions for this comparison.

The prior container, older rollback containers, failed first candidate, and both cold backups remain retained. Image rollback was exercised successfully during the first attempt. Future rollback must recheck schema/configuration compatibility and readiness; it must not overwrite newer application data with a backup automatically.

## Verification

| Check | Result |
| --- | --- |
| Full release verification | Passed: 86 suites / 1,507 tests, lint, types, docs, leakage and secret checks, builds, ranking evaluations, packaging, and container smoke. Node 24.20.0; Vitest 5.0.1. |
| Dependency installation | Main checkout installation completed; npm audit reported zero vulnerabilities. |
| Fixture browser workflows | Four fresh scenarios passed: confirmed movie, uncertain movie retry, explicit TV seasons, and uncertain TV retry. Each produced exactly one fixture write. Exact counters and revision provenance are in [the TV validation record](PLEX_AND_TV_REQUEST_VALIDATION_2026_09.md). |
| Deployed artifacts | All 19 image artifacts and the package lock matched the manifest; all five served client assets matched. |
| Runtime smoke | Correct version/revision, ready workers, preserved public configuration, and fixed token-free native callback page/script passed. The verifier used only unauthenticated GETs and received no cookies. |
| Rendered desktop | Codex browser at 1280 × 720 showed the shared-profile disclosure and right-side chat. Opening chat focused its prompt. No horizontal overflow or captured console errors; loaded JS/CSS filenames matched the manifest. |

The live browser check did not submit a search, authenticate through Plex, or create a Seerr request. Native callback page checks do not establish the real Plex approval-and-return journey. Fixture writes do not establish real Seerr write behavior.

## Remaining work

The [roadmap](ROADMAP.md) retains native Plex launch/fallback checks, controlled real integration validation, catalog import performance, and public beta.2 candidate gates. Unfinished model-matrix, calibration, council, and iOS work remains preserved in the original worktrees. This cleanup did not activate ranking experiments, rerun paid provider evaluations, or integrate those unfinished features.
