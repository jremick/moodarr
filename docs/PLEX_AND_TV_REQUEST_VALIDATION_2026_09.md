# Plex and TV request validation

Recorded 20 September 2026. Scope: roadmap R2 validation and R3 implementation.

## Delivery state

- The original stabilization source was committed as `d74f5c6`.
- Stabilization and retained client fixes are now reconciled locally in `bec8641` on `codex/source-ui-cleanup-20260920`. The TV changes from the original `codex/tv-multiseason-20260920` work are ported onto that source and the verified dependency-maintenance baseline.
- This integrated revision is awaiting combined verification, browser checks, and CI. This source reconciliation has not pushed or published these changes, and no public candidate was selected or validated.

## Multi-season behavior

The Finder accepts explicit comma-separated TV seasons, such as `1, 2, 3`. It uses the existing API bounds: each season is an integer from 1 to 1000, with at most 100 submitted entries. Repeated entries are deduplicated and sorted before preview. Empty entries, ranges, fractional values, and invalid numbers cannot start a preview.

Editing seasons clears the item's existing preview and tells the user to preview again. The confirmation handler also checks that the current selection matches the preview. Season controls are disabled while an action is pending. The confirmation displays the exact seasons that will be sent.

The server remains the authority for input validation, confirmation binding, capability checks, and idempotency. No API contract, database schema, upstream integration, dependency, ranking policy, or authentication setting changed. The UI remains within Screening Desk. Season metadata lookup, ranges, and an automatic “all seasons” option are outside this slice.

## Source-reconciliation checks

On Node 24.20.0 and Vitest 5.0.0, the integrated client changes passed eight focused test files with 124 tests, type checking, lint, documentation contracts for 37 API routes, and the client build. The focused cases cover season parsing, mismatched previews, pending controls, request idempotency, feedback scope, and the retained sidebar and fallback warning. Combined full verification, operator-run browser scenarios, and CI remain pending for the final integrated revision.

## Historical verification of the original TV implementation

The results in this section were recorded before source reconciliation. They apply to the original TV worktree and do not establish that the current integrated revision passed.

`npm run verify` passed on Node 24: lint, type checking, all 85 suites / 1,424 tests, documentation checks, MoodRank evaluation leakage checks, builds, and tracked/generated-client secret checks. A new API integration test rejects changed seasons with an old confirmation token before any upstream call, then proves concurrent requests for the same canonical season set produce one upstream write and one request record. Documentation contracts and `git diff --check` also passed after this record was added.

All four operator-run browser scenarios passed against the real built client and Fastify routes with disposable fixture integrations:

| Scenario | Preview calls | Confirmation calls | Fixture writes | Written seasons |
| --- | ---: | ---: | ---: | --- |
| TV multi-season, repeated confirmation | 3 | 1 | 1 | 1, 2 |
| TV multi-season, uncertain result and retry | 3 | 2 | 1 | 1, 2 |
| Existing movie workflow | 2 | 1 | 1 | Not applicable |
| Existing movie uncertain retry | 2 | 2 | 1 | Not applicable |

TV previews were exactly `[1, 2]`, `[2]`, and `[1, 2]`. Cancellation after the second preview left the write count at zero. Invalid values sent no preview. Changing the season input removed confirmation; the uncertain retry did not resend. The fixture disables server-side outbound fetches and uses no real Seerr account or provider credential. These are fixture writes only.

Rendered checks covered a 390 × 844 mobile viewport and 1440 × 1000 desktop layouts in Compact, List, and Comfort modes. No horizontal page or season-field overflow was observed. The season help and confirmation remained readable. Keyboard Tab moved from the season field to the corresponding preview button. The final test-tab error-log read returned no entries.

The repeatable procedure is in [the browser suite README](../tests/browser/README.md). Raw run artifacts are retained outside the repository.

## Plex behavior and remaining checks

The Finder currently prefers the title-specific web URL, then the native `plex://` URL if no web URL exists, then Plex home if neither title link exists. Existing automated tests cover link construction, metadata normalization, and component fallback. These tests do not establish native-client launch or end-to-end behavior on each supported client.

Desktop/mobile native launch, missing-native-client behavior, and actual native fallback remain unverified. Complete those checks with dedicated clients and test accounts before claiming compatibility.

## Release evidence

This source verification does not replace exact-image release validation. The [manual candidate gate](BETA_CANDIDATE_MANUAL_VALIDATION.md) requires a clean exact source revision and the published candidate's immutable digest. Fixture and source-built observations cannot close that gate.

This slice does not establish beta.2 release readiness. The [manual candidate gate](BETA_CANDIDATE_MANUAL_VALIDATION.md) requires a clean exact source revision and the published candidate's immutable digest. Local fixtures and custom images cannot close that gate.

Next, complete combined verification and CI for the integrated R3 changes, then complete the native Plex checks on an available signed-in client.

Before a public beta.2 decision, use [Release](RELEASE.md) to select and validate the exact candidate, including fresh install/upgrade/restore, catalog import, controlled real integrations, supported browsers, native Linux responsiveness, and privacy-reviewed evidence. The roadmap's independent recommendation evaluation and historical-artwork decision also remain separate requirements; this slice did not complete them. Do not mark historical beta.1 evidence rows passed from these results.

The current local R3 changes can be removed without a data migration. Since they are not deployed, they need no production rollback. A later deployment requires its own verified image identity and rollback record.
