# Moodarr roadmap

Current release: [beta.3](https://github.com/jremick/moodarr/releases/tag/v0.1.0-beta.3), published 21 September 2026 from source `85170c8b6359c006754516de347777ea44932c64`.
Priority: complete outstanding fixes and validation before new features.

## Completed fixes

Dependency maintenance is merged in [PR 84](https://github.com/jremick/moodarr/pull/84) and [PR 85](https://github.com/jremick/moodarr/pull/85). Source reconciliation is merged in [PR 86](https://github.com/jremick/moodarr/pull/86), and desktop fixes are merged in [PR 87](https://github.com/jremick/moodarr/pull/87). These preserve shared-feedback disclosure, right-side chat, trusted origins, native authentication callbacks, and bounded rerank diagnostics within Screening Desk.

Beta.3 includes the IMDb/Trailer click fix, the positioning swap that places year/runtime directly below each poster followed by Trailer/IMDb, and the [full-snapshot catalog import fix](CATALOG_IMPORT_PERFORMANCE_2026_09.md). The exact published image passed the mandatory gates in its [approved fixes profile](BETA_RELEASE_CRITERIA.md#approved-beta3-fixes-release-profile). Official beta.3 retains AI/TMDB-disabled policies.

The R1/R4 first slice is implemented. Public release readiness requires separate exact-candidate evidence.

Source reconciliation is merged: shared-feedback disclosure, right-side chat, the stale-warning fix, trusted origins, the native callback, and bounded rerank diagnostics are preserved on the dependency-maintenance baseline. Final release verification passed with 86 suites and 1,507 tests. All four fresh fixture-browser workflows passed; Admin fallback counts rendered correctly, and security review found no blockers. Required GitHub checks and merges are complete.

The R2/R3 slice has [Plex web-link and multi-season verification](PLEX_AND_TV_REQUEST_VALIDATION_2026_09.md). R3 implementation, full release verification, all four fixture-browser workflows, source merge are complete. Public release requires separate candidate evidence. R2 has dated Plex Web destination evidence, with native-client checks still open.

Dependency maintenance is merged in [PR 84](https://github.com/jremick/moodarr/pull/84) and [PR 85](https://github.com/jremick/moodarr/pull/85). Completed source reconciliation is merged in [PR 86](https://github.com/jremick/moodarr/pull/86), and the desktop fixes are merged in [PR 87](https://github.com/jremick/moodarr/pull/87). Model-matrix, calibration, and council experiments are not integrated features.

The immutable [beta.2 prerelease](https://github.com/jremick/moodarr/releases/tag/v0.1.0-beta.2) remains the earlier release. Its follow-up IMDb/Trailer click fix is merged in [PR 90](https://github.com/jremick/moodarr/pull/90), and the full-snapshot catalog fix is recorded in [catalog import performance](CATALOG_IMPORT_PERFORMANCE_2026_09.md). The requested positioning swap places year/runtime directly below each poster, then Trailer/IMDb; desktop/narrow fixture checks passed in Comfort, Compact and List.

These fixes are included in the immutable [beta.3 prerelease](https://github.com/jremick/moodarr/releases/tag/v0.1.0-beta.3), published 21 September 2026 after all mandatory gates in its [approved fixes profile](BETA_RELEASE_CRITERIA.md#approved-beta3-fixes-release-profile) passed. The exact published image passed clean-install, upgrade/rollback, full-catalog import/isolation, runtime smoke, and protected promotion checks. Official beta.3 retains AI/TMDB-disabled policies.

The beta.3 profile still defers native Plex launch/fallback, dedicated Plex watchlist and Seerr write/cleanup checks, rendered catalog request-attempt disclosure, and the independent ranking evidence. Publication does not complete those checks or activate experimental features.

## Work packages

| ID | Item and current position | Smallest next change | Dependencies and acceptance |
| --- | --- | --- | --- |
| R1 | Core browser workflows: server/component tests exist; browser scenarios added in the first slice. | Maintain the fixture-browser checks for Admin setup/lock, search refinement, feedback scope, preview/cancel, confirmation, and uncertain retry. | The real application and disposable integrations must show no preview write, one confirmed write, and no resend after an uncertain outcome. Capture rendered desktop/mobile evidence. |
| R2 | Real movie and series URLs resolve to the correct titles in Plex Web. Native-client behavior remains unverified. | Complete desktop/mobile Plex launch, missing-client, and fallback checks; fix reproduced failures only. | Record client versions, correct target title, missing-client/metadata behavior, and secret-free URLs. Requires actual clients and a signed-in test account. |
| R3 | TV multi-season input and preview invalidation are implemented and verified. | Preserve these behaviors through the browser regression gates during delivery and later changes. | Exact selected seasons, invalid/duplicate values, stale preview, cancellation, and one-write retries are covered. No metadata provider is added. |
| R4 | Solo learning is user-scoped; Together is intentionally shared. | First slice: disclose shared learning and identify feedback scope from the displayed slate, independent of pending criteria. | Switching next-search context must not relabel or redirect feedback on existing results. Named groups remain outside this slice. |
| R5 | Creator attribution and Admin request counts exist; fuller history and quotas remain. | Add paginated user-scoped history, then configurable quotas enforced atomically at request creation. | Define the limit window and TV counting policy before implementation. Concurrent requests cannot exceed limits; retries count once; uncertain writes keep their reservation until resolved. |
| R6 | Disabling users revokes sessions/tokens; full deletion and audit retention remain. | Define per-record retention, then add an Admin preview and deletion/anonymization workflow. | Depends on R5's request semantics. Preserve duplicate-request prevention markers, other users' records, and defined shared-learning behavior. Verify migration, integrity, and backup recovery. |
| R7 | Conservative Seerr reconciliation and basic Plex user controls exist. | Verify supported upstream request/status/season contracts; extend fixtures only for confirmed gaps. | Partial snapshots or the wrong title/season/type cannot resolve an uncertain operation. Never resend automatically. Seerr user mapping/attribution needs its own requirement and contract review. |
| R8 | Admin already displays Plex and Seerr sync history. | Inventory missing visibility for actual background jobs; extend existing history only where a gap is demonstrated. | Bounded history distinguishes running, succeeded, failed, and interrupted work and excludes secrets. Do not build a generic job framework. |
| R9 | MoodRank correctness fixes and experimental components are merged; broader experiments remain disabled. | Follow the staged evaluation work below. | Engineering tests do not establish independent recommendation quality or authorize activation. |
| R10 | Native app development is maintained separately. This repository owns the server API. | Coordinate API contract changes with external clients. | Preserve auth/search/feedback/request compatibility. Native app builds and distribution are outside this repository. |
| R11 | Cold encrypted backup and restore procedures exist; automation remains open. | Choose storage, key custody, schedule, retention, and acceptable downtime, then automate the existing consistency model. | Restore into isolation. Failed backups must not prune the last good copy. Verify permissions, encryption, integrity, cleanup, and recovery. |
| R12 | Internet-facing access is outside the current deployment scope. | When requested, select a reverse proxy and define trusted headers, cookie/origin handling, and admin/user boundaries. | No direct-backend bypass or spoofed identity. Verify sign-in, sign-out, and Plex callbacks through the chosen proxy before exposure. |

## MoodRank sequence

1. Reconcile the July [next-release plan](MOODRANK_NEXT_RELEASE_PLAN.md) with the September [completion record](MOODRANK_COMPLETION_2026_09.md). Existing traces, score contributions, independent evaluation, and server-returned impressions are implemented. Trace mode declarations alone do not prove executable shadow comparisons or client-visible exposure capture.
2. Complete only demonstrated instrumentation gaps: observation-only guardrail/retrieval comparisons and client-visible exposure semantics. Shadow work must not change the returned slate. Merely opening or seeing a result must not train a positive preference.
3. Freeze cases, judgments, catalog, versions, and thresholds under the [independent evaluation protocol](MOODRANK_EVALUATION_PROTOCOL.md). Compare the repaired default with the existing review candidate. Broad activation requires at least 100 independent cases, no new hard-filter/availability regression, human explanation assessment, and representative resource checks.
4. Evaluate semantic discovery separately, after approval of an installed local runtime/model and permitted corpus. Measure real inference time, memory, retrieval quality, cancellation, and model/index mismatch behavior. Synthetic vectors establish contracts only.
5. Keep further rerank-v2 contract changes and offline affect enrichment separate and later. Preserve official-image processing policies and deterministic fallback. Do not enable experimental arms as part of UI fixes.

## Delivery order and gates

- Completed first slice: R1/R4 browser coverage and shared-feedback disclosure. Keep these checks as regression gates for later changes.
- Completed maintenance delivery: R3 and the related desktop correctness fixes are merged and verified with 86 suites, 1,507 tests, and four fresh fixture-browser workflows. Preserve these regression gates. R2 native launch and missing-client checks remain open; see [the evidence and remaining gates](PLEX_AND_TV_REQUEST_VALIDATION_2026_09.md).
- Completed beta.3 delivery: the click, positioning, and catalog fixes are published under the approved fixes profile. Preserve the exact-image release evidence.
- Next: close R2 native-client behavior and the deferred dedicated integration/browser checks with the required clients and test resources. Independent ranking evaluation remains a separate evidence task. Beta.3 deferrals apply to that release only; match each later release report to its selected source, digest, and approved profile.
- Later or independently: R5/R6 multi-user controls; remaining R7/R8 gaps; evidence-gated R9 experiments; R10 native CI. R11/R12 depend on explicit deployment decisions.

For each implementation, read affected contracts/callers, add meaningful regression checks, run `npm run verify`, and record browser/runtime evidence for user-facing claims. Add ranking evaluations for ranking changes and migration/restore checks for persistent-data changes. Keep independent blind judgments outside implementation work.

For each implementation, read affected contracts and callers, add meaningful regression checks, run `npm run verify`, and record browser/runtime evidence for user-facing claims. Add ranking evaluations for ranking changes and migration/restore checks for persistent-data changes. Keep independent blind judgments outside implementation work. Keep private deployment records and raw operational evidence outside the repository and GitHub discussions.
