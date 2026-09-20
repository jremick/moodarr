# EXP stabilization verification

Date: 20 September 2026. Scope: the approved first slice in [the roadmap](ROADMAP.md).

## Change and boundaries

Finder now explains that Together feedback affects the instance's shared profile. The result-level disclosure uses the immutable displayed feedback session, so changing pending criteria does not mislabel existing results. Existing solo/group feedback routing is unchanged. There is no server, schema, ranking, authentication, dependency, or media-request behavior change.

The browser fixture and [repeatable scenarios](../tests/browser/README.md) exercise the real client/server against disposable local data. Only the standalone fixture process instruments the bundled Seerr client. It rejects outbound fetches and receives an explicit configuration without inherited integration credentials. Test endpoints are absent from the production application.

EXP has a separate source baseline from GitHub main. Its native Plex callback, chat/sidebar arrangement, rerank diagnostics, and trusted-origin changes must remain intact. The deployment candidate overlays only rebuilt client assets on the exact existing EXP image. A new image label and client manifest identify this UI change; the server health version/revision remain unchanged because the server bundle is unchanged.

## Evidence

| Check | Result |
| --- | --- |
| Initial EXP health/readiness | Passed; zero restarts, no OOM. Baseline identity recorded in the roadmap. |
| Source comparison | Six differing source files plus EXP-only `security/webOrigins.ts` identified; preserve all existing differences. |
| Focused tests | 198 tests passed across Finder accessibility, displayed feedback sessions, request preview, request lifecycle, and application routes. |
| Browser: Admin preferences, lock/unlock, group feedback, movie refinement, preview/cancel, confirmation | Passed on fresh, independent main-based and EXP-based fixtures in Codex browser. Two previews, one confirmation, one fixture write; feedback context `group`; search contexts `group`, then `solo`. |
| Browser: uncertain write and retry | Passed on fresh, independent main-based and EXP-based fixtures. Two previews, two confirmation attempts, one fixture write. The second attempt reported uncertainty and did not resend. |
| Full repository verification | Passed: 84 suites and 1,399 tests; lint, typecheck, builds, documentation, leakage, and secret checks. Lint/typecheck passed again after the final fixture-harness correction. |
| EXP-derived client build and browser verification | Passed: client build, 203 focused tests, both browser scenarios, 1440 × 1000 desktop and 390 × 844 mobile layout without horizontal overflow, chat focus, keyboard Tab, and zero captured console errors. |
| EXP update, preservation, assets, and rollback | Passed: exact runtime configuration and environment; cold backup verified; schema, 14 table counts, nine retained-table hashes, and configuration hash unchanged; all 19 image artifacts and five served client artifacts matched. Healthy, zero restarts, no OOM. Prior container retained. |

No live provider inference, external media request, public commit/push/release, or broader roadmap activation is part of this slice. Real Plex desktop/mobile launch behavior and real Seerr write validation remain separate roadmap evidence.

## Deployed result

The update completed on 20 September 2026. EXP stopped at `05:33:16 UTC` and reported ready at `05:34:12 UTC` (56 seconds between recorded timestamps, including backup and startup).

- Image: `sha256:d50d50e657cded2ac64c65407bb3103a33e09ad1040e571b31d2abf775c995d0`.
- Client patch label: `io.moodarr.stabilization-ui-patch=f4153826591a15d0e9816577a0c5184ddcb56629ef07bf926a140a98d0ae16b5`.
- Retained rollback container: `moodarr-pre-exp-stabilization-20260920`; its image matches the initial baseline.
- Private rollout and cold backup on EXP: `/mnt/user/appdata/.moodarr-rollouts/exp-stabilization-20260920/`. Sensitive runtime snapshots remain there with restrictive permissions.

Live browser readback showed the shared-profile disclosure, correct chat focus, the new JavaScript asset, no captured console errors, and no horizontal overflow at 390 and 1440 CSS pixels. Both trusted origins passed cookie-authenticated local searches with AI disabled; three untrusted origins were rejected. The existing native Plex callback remained intact. These checks do not establish a real Plex app launch or an external Seerr write.

The roadmap, source changes, and regression suite are retained together in the local stabilization commit. No GitHub publication or beta release occurred.

## Recovery and fixture integrity

The Codex crash preserved the worktree and completed verification logs. Local fixture servers were restarted from clean in-memory databases. The fixture assigns SQLite memory mode directly after configuration loading because environment database paths are resolved to filesystem paths. All four final browser scenarios passed after this correction. The uncertain scenario uses two separate clicks so the first response is observed before reconciliation; the successful scenario still checks double confirmation.

The first deployment package contained macOS metadata sidecars. Exact artifact-count validation rejected it before a candidate container was created or EXP was stopped. A clean package generated without those sidecars passed all 19 artifact hashes, including the 14 unchanged server assets.

## Deployment checks

Require exact pre-update image/configuration identity and an idle, healthy service before stopping. Preserve the current container, create and verify a fresh cold backup, and retain all older rollback assets. The candidate must use identical runtime settings, secrets, mounts, resource limits, security controls, and server bytes. Verify database/configuration preservation, readiness, zero restart/OOM, served asset hashes, rendered shared-context disclosure, chat focus, and viewport layout after starting it.

On any deployment gate failure, stop and retain the candidate, restore the prior container's name, and start it. This client-only update needs no data migration or database restoration for image rollback. A backup checksum is not an independent restore test.
