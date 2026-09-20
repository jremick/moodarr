# Plex and TV request validation

Recorded 20 September 2026. Scope: roadmap R2 validation and R3 implementation.

## Delivery state

Shared-feedback and source fixes are merged in [PR 86](https://github.com/jremick/moodarr/pull/86). Multi-season TV requests and desktop correctness fixes are merged in [PR 87](https://github.com/jremick/moodarr/pull/87), on the dependency-maintenance baseline from PRs 84 and 85. The verification below is dated source evidence; release identity and publication are recorded in [GitHub Releases](https://github.com/jremick/moodarr/releases).

## Multi-season behavior

The Finder accepts explicit comma-separated TV seasons, such as `1, 2, 3`. It uses the existing API bounds: each season is an integer from 1 to 1000, with at most 100 submitted entries. Repeated entries are deduplicated and sorted before preview. Empty entries, ranges, fractional values, and invalid numbers cannot start a preview.

Editing seasons clears the item's existing preview and tells the user to preview again. The confirmation handler also checks that the current selection matches the preview. Season controls are disabled while an action is pending. The confirmation displays the exact seasons that will be sent.

The server remains the authority for input validation, confirmation binding, capability checks, and idempotency. The TV input change reuses the existing API, database schema, upstream integration, dependencies, ranking policy, and authentication settings. The UI remains within Screening Desk. Season metadata lookup, ranges, and an automatic “all seasons” option are outside this slice.

## Source-reconciliation checks

On Node 24.20.0 and Vitest 5.0.1, the combined desktop changes passed full release verification: 86 suites and 1,507 tests, lint, type checking, documentation, leakage and secret checks, builds, ranking evaluations, packaging, and container smoke. Four fresh fixture-browser scenarios repeated the exact counters in the table below. The browser harness now waits for persisted preferences after reload before checking their value. Desktop and narrow-screen checks found no horizontal or season-field overflow; keyboard Tab moved from the season field to its preview button, and the captured console error log was empty.

Full release verification ran at `21ef83f7aaec486b35685f17291b7514fc55ec4b`; merged main `4a3d1273c2ec9d9cdfb2fe177da26be3f52e135e` has the identical Git tree `1a93689ad5fe3e9cbaa262af89c5c6588da33bc8`. The browser artifacts identify `6adacf0781380c3527c4246b37e9f1fcd635db2a`; `src/client`, `src/shared`, and `tests/browser` are unchanged between that revision and the final candidate.

The cleanup also separates caller cancellation from provider failure and validates token usage per response before assigning evaluation cost. Explicit cancellation creates no recommendation or provider-failure count; caller deadlines keep deterministic timeout fallback. Historical `moodrank-product-eval-strict-v1` reports cannot establish complete usage and are now cost-ineligible. They were preserved, not relabeled or rerun.

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

Use [Release](RELEASE.md) for the selected candidate's install, upgrade, restore, catalog, integration, browser, and responsiveness gates. Keep independent recommendation evaluation separate, and do not mark historical release evidence rows passed from these results. The R3 UI changes add no database migration.
