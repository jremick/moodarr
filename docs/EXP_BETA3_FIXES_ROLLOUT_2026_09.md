# EXP beta.3 fixes rollout

Recorded 21 September 2026. EXP now includes the IMDb/Trailer click fix, the requested result-card positioning swap, and full-snapshot catalog import batching. This update activated no new feature or provider setting. It follows the [maintenance rollout](EXP_MAINTENANCE_ROLLOUT_2026_09.md), whose dated evidence remains unchanged.

## Release and deployed identity

The immutable [beta.3 prerelease](https://github.com/jremick/moodarr/releases/tag/v0.1.0-beta.3) was published at `06:10:18 UTC` after the [approved fixes profile](BETA_RELEASE_CRITERIA.md#approved-beta3-fixes-release-profile) passed its mandatory gates. Its official OCI index is `sha256:515a08bd074ba54eaca53c0a70d8bf23af051fa600d32fee6ddec2aacc6e7e38`; official AI and TMDB policies remain disabled.

EXP uses a separate custom image with both policies configurable:

- Version: `0.1.0-beta.3+exp.fixes.20260921`.
- Source/runtime revision: `85170c8b6359c006754516de347777ea44932c64`.
- Image: `sha256:a42417df134fbe692527e69274d8c948f7ff563d323af9a0408849cf9f494b48`.
- Prior version/revision: `0.1.0-beta.2+exp.maintenance.20260920` / `21ef83f7aaec486b35685f17291b7514fc55ec4b`.
- Retained prior image: `sha256:cb5ae86be3e8ecaa8341881c282d0e61d162a92485fc9f3ee059c48fe1e0bd91`, in stopped container `moodarr-pre-exp-beta3-fixes-20260921`.

EXP stopped at `07:36:11 UTC` and reported ready at `07:37:25 UTC`: 74 seconds including the cold backup and startup. Final health was healthy and ready, with zero restarts and no OOM.

## Preservation and verification

| Check | Result |
| --- | --- |
| Operational configuration | Exact environment, public configuration, mounts, entrypoint, healthcheck, resource limits, and security controls preserved. Only image-owned version/revision values and labels changed. |
| Database and configuration | SQLite `quick_check` returned `ok`. Schema version 34, all 35 migration IDs, 17 table counts, 12 retained-table hashes, schema hash, and configuration hash matched. |
| Source compatibility | `src/server/db/database.ts`, `src/server/config.ts`, and `src/server/app.ts` matched the prior EXP revision. Catalog import and repository code changed. No schema migration or configuration conversion was introduced. |
| Runtime and dependencies | Node 24.19.0 and the production dependency files/package inventory were preserved. |
| Deployed artifacts | All 19 application artifacts matched the manifest. All five served client files matched the tested beta.3 release. |
| Runtime smoke | Exact version/revision, ready idle workers, preserved public configuration, and native callback page/script passed. The verifier used unauthenticated GETs and received no cookies. |
| Rendered Finder | 1280 × 720 desktop and 390 × 844 narrow layouts had no horizontal overflow. Chat opened on the right at desktop width; prompt focus survived resizing. No captured browser warnings or errors. |
| Deployment helper regression checks | All 37 inherited checks and two frozen-target mismatch checks passed. Only null/false `OomKillDisable` values are equivalent; other control drift remains a failure. |

The fresh cold backup passed compression testing, archive listing, and checksum verification. Its SHA-256 is `4818e5f4cbc4f25b954a2c11746267dc6447e7a68a1b892fefda8b084c06d9f7`. The backup, sensitive runtime snapshots, and detailed operator receipts remain in the protected host rollout directory. No independent restore test was performed for this backup.

## Rollback and limits

The prior container and older rollback assets remain retained. No rollback was needed during this update. On a deployment failure, the helper stops and retains the candidate, checks schema/configuration compatibility against the cold baseline, and restarts the prior container only if that gate passes. It then verifies the prior version/revision and readiness. If compatibility cannot be established, both containers remain stopped for recovery review. The helper never restores a database backup automatically.

Verification initiated no provider inference or real Plex/Seerr request. The live browser smoke did not submit a search; result-link activation evidence comes from prior beta.3 validation plus exact served-file equality. Native callback smoke does not establish a real Plex approval-and-return journey, and archive checks do not establish restore success.

This EXP update did not complete the deferred manual checks. A later [exact-image catalog browser check](POST_BETA3_VALIDATION_2026_09.md) passed rendered movie and TV request-attempt disclosure with preview/cancel and no created requests. The [roadmap](ROADMAP.md) retains native Plex launch/fallback, dedicated watchlist and Seerr write/cleanup, the full browser/Unraid matrix, native responsiveness, and independent ranking evidence. The unfinished ranking and native-app experiments remain inactive.
