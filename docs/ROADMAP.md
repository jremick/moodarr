# Moodarr roadmap

Planning baseline: GitHub main `974a308da44c4bc032787fabb2fdd77f058ad11e`, reviewed 20 September 2026.
Priority: stabilize the existing EXP experience, then prepare beta.2.

## Approved first slice

Reconcile the roadmap with source and EXP, reproduce core workflow failures, add browser regression coverage, clarify shared group feedback, and validate the changes on EXP with rollback available. Keep changes within Screening Desk. Preserve EXP's native Plex callback, right-side chat, rerank diagnostics, and trusted-origin handling.

The initial EXP readback was healthy with zero restarts and no OOM. Its server revision was `690d634+origins.046baa2ca8`; its image was `sha256:078268b82f397536a0a3890db7079af485c917bdcdde7f91cee9c5f104c83c84`. This is a dated deployment baseline, not the identity of GitHub main or a public release.

The R1/R4 first slice is implemented and verified on EXP. Local implementation and deployment evidence is recorded in [EXP stabilization verification](EXP_STABILIZATION_2026_09.md). A code change, deployed EXP image, published candidate, and public release are distinct states.

Source reconciliation, 20 September 2026: the completed shared-feedback changes, right-side chat, stale-warning fix, trusted origins, native callback, and bounded rerank diagnostics are integrated on the dependency-maintenance baseline. Full release verification passed with 1,441 tests. Fresh fixture-browser runs passed the confirmed and uncertain request workflows; the Admin fallback counts render correctly. Security review found no blockers. GitHub checks and merge remain delivery gates. This reconciliation does not deploy an image or change the dated EXP evidence above.

The earlier R2/R3 slice has [Plex web-link and multi-season verification](PLEX_AND_TV_REQUEST_VALIDATION_2026_09.md). R3 is now integrated locally and awaits combined verification and CI; it is not deployed by this work. R2 has dated Plex Web destination evidence, with native-client checks still open.

## Work packages

| ID | Item and current position | Smallest next change | Dependencies and acceptance |
| --- | --- | --- | --- |
| R1 | Core browser workflows: server/component tests exist; browser scenarios added in the first slice. | Maintain the fixture-browser checks for Admin setup/lock, search refinement, feedback scope, preview/cancel, confirmation, and uncertain retry. | The real application and disposable integrations must show no preview write, one confirmed write, and no resend after an uncertain outcome. Capture rendered desktop/mobile evidence. |
| R2 | Real movie and series URLs resolve to the correct titles in Plex Web. Native-client behavior remains unverified. | Complete desktop/mobile Plex launch, missing-client, and fallback checks; fix reproduced failures only. | Record client versions, correct target title, missing-client/metadata behavior, and secret-free URLs. Requires actual clients and a signed-in test account. |
| R3 | Explicit multi-season input and preview invalidation are integrated locally with the reconciled client source. | Complete combined verification, browser checks, and CI before delivery. | Existing request contracts are unchanged. Verify exact seasons, invalid/duplicate values, stale preview, cancellation, concurrent confirmation, and uncertain retry on this integrated revision. No metadata provider was added. |
| R4 | Solo learning is user-scoped; Together is intentionally shared. | First slice: disclose shared learning and identify feedback scope from the displayed slate, independent of pending criteria. | Switching next-search context must not relabel or redirect feedback on existing results. Named groups remain outside this slice. |
| R5 | Creator attribution and Admin request counts exist; fuller history and quotas remain. | Add paginated user-scoped history, then configurable quotas enforced atomically at request creation. | Define the limit window and TV counting policy before implementation. Concurrent requests cannot exceed limits; retries count once; uncertain writes keep their reservation until resolved. |
| R6 | Disabling users revokes sessions/tokens; full deletion and audit retention remain. | Define per-record retention, then add an Admin preview and deletion/anonymization workflow. | Depends on R5's request semantics. Preserve duplicate-request prevention markers, other users' records, and defined shared-learning behavior. Verify migration, integrity, and backup recovery. |
| R7 | Conservative Seerr reconciliation and basic Plex user controls exist. | Verify supported upstream request/status/season contracts; extend fixtures only for confirmed gaps. | Partial snapshots or the wrong title/season/type cannot resolve an uncertain operation. Never resend automatically. Seerr user mapping/attribution needs its own requirement and contract review. |
| R8 | Admin already displays Plex and Seerr sync history. | Inventory missing visibility for actual background jobs; extend existing history only where a gap is demonstrated. | Bounded history distinguishes running, succeeded, failed, and interrupted work and excludes secrets. Do not build a generic job framework. |
| R9 | MoodRank correctness fixes and experimental components are merged; broader experiments remain disabled. | Follow the staged evaluation work below. | Engineering tests do not establish independent recommendation quality or authorize activation. |
| R10 | Swift tests and an iOS target exist; macOS CI remains open. | Add Swift tests, unsigned simulator build, and shared API fixtures to CI. | Auth/search/feedback/request contract drift fails checks. Real-device Plex approval and return remain manual evidence. iOS remains outside supported web/server beta scope. |
| R11 | Cold encrypted backup and restore procedures exist; automation remains open. | Choose storage, key custody, schedule, retention, and acceptable downtime, then automate the existing consistency model. | Restore into isolation. Failed backups must not prune the last good copy. Verify permissions, encryption, integrity, cleanup, and recovery. |
| R12 | Internet-facing access is outside the current deployment scope. | When requested, select a reverse proxy and define trusted headers, cookie/origin handling, and admin/user boundaries. | No direct-backend bypass or spoofed identity. Verify sign-in, sign-out, and Plex callbacks through the chosen proxy before exposure. |

## MoodRank sequence

1. Reconcile the July [next-release plan](MOODRANK_NEXT_RELEASE_PLAN.md) with the September [completion record](MOODRANK_COMPLETION_2026_09.md). Existing traces, score contributions, independent evaluation, and server-returned impressions are implemented. Trace mode declarations alone do not prove executable shadow comparisons or client-visible exposure capture.
2. Complete only demonstrated instrumentation gaps: observation-only guardrail/retrieval comparisons and client-visible exposure semantics. Shadow work must not change the returned slate. Merely opening or seeing a result must not train a positive preference.
3. Freeze cases, judgments, catalog, versions, and thresholds under the [independent evaluation protocol](MOODRANK_EVALUATION_PROTOCOL.md). Compare the repaired default with the existing review candidate. Broad activation requires at least 100 independent cases, no new hard-filter/availability regression, human explanation assessment, and representative resource checks.
4. Evaluate semantic discovery separately, after approval of an installed local runtime/model and permitted corpus. Measure real inference time, memory, retrieval quality, cancellation, and model/index mismatch behavior. Synthetic vectors establish contracts only.
5. Keep further rerank-v2 contract changes and offline affect enrichment separate and later. Preserve official-image processing policies and deterministic fallback. Do not enable experimental arms as part of EXP UI stabilization.

## Delivery order and gates

- Completed first slice: R1/R4 browser coverage and shared-feedback disclosure, verified on EXP. Keep these checks as regression gates for later changes.
- Follow-up: R3 is integrated locally; combined verification and CI are pending. The earlier implementation recorded 1,424 passing tests and four browser scenarios; those historical results do not verify this integrated revision. R2 web destinations passed in that earlier check; native launch and missing-client checks remain open. Review [the evidence and remaining gates](PLEX_AND_TV_REQUEST_VALIDATION_2026_09.md) before delivery or beta.2 work.
- Beta.2: complete the selected candidate's required [release evidence](RELEASE.md), including installation, upgrades/rollback, catalog import, integrations, supported browsers, native responsiveness, and the recorded historical-artwork decision. Check each retained report against the chosen source/digest. The latest published release at this planning baseline is beta.1.
- Later or independently: R5/R6 multi-user controls; remaining R7/R8 gaps; evidence-gated R9 experiments; R10 native CI. R11/R12 depend on explicit deployment decisions.

For each implementation, read affected contracts/callers, add meaningful regression checks, run `npm run verify`, and record browser/runtime evidence for user-facing claims. Add ranking evaluations for ranking changes and migration/restore checks for persistent-data changes. Keep independent blind judgments outside implementation work.

The first slice adds no dependency, schema change, ranking activation, external media request, public publication, or internet exposure. Stop a deployment on identity/configuration mismatch, failed required checks, a missing rollback image, or lost readiness. Roll back a client-only image with the preserved prior container. Data-affecting work needs its own backup/restore plan.
