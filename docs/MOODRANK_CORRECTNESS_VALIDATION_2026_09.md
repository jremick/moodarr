# September 2026 correctness implementation evidence

Date: 2026-09-08. Status: tested candidate; not merged, deployed or independently quality-validated.

## Source identity and prerequisite

PR #72 is stacked on PR #71, base `5ae85787229b87f6d35a9be56f7c8d8afd4969b9`. The implemented and verified source is `c6c7dcf2ecfb29e36bd6be51eec6bb52d536ec3b`. The engine is `moodrank-v0.5.2`, deterministic features are `moodrank-v0.4-features-v4`, and fingerprint rules are `fingerprint-rules-v3`. Database schema and provider contracts are unchanged.

PR #71's four obsolete engine-version assertions were corrected separately. Its full existing CI run `34167840414` and CodeQL run `34167840383` passed. The dependent correctness changes are not included in those prerequisite results.

## Actual execution

The successful isolated workspace run was `34169052567`, job `101885719794`, using Node 24.20.0 and locked dependencies on Ubuntu 24.04. It applied source-hash-checked edits, removed its temporary workflow/script, created a clean candidate commit, ran the checks below, and only then published that commit to the unchanged working branch without force-pushing.

| Check | Observed result |
|---|---|
| New baseline production regressions before the fixes | 38 cases: 12 passed, 26 failed |
| Same production regressions after the fixes | 38 passed |
| Additional nonfiction-policy/compatibility and full-refresh tests | 12 passed |
| Combined focused suites, including PR #71's 57 cases | 107 passed |
| Full Vitest suite | 77 files, 1,220 tests passed |
| `npm run verify` | Passed: tracked-secret scan, documentation contracts, leakage guard, ESLint, TypeScript, tests, client/server build, generated-asset secret scan |
| `npm run eval:recommendations` | Passed; visible golden/adversarial/profile/rank-index suites |
| `npm run eval:moodrank-release-readiness` | Passed; 99 visible persona cases, including 28 P0 and 44 P1 cases, with no reported failures |
| `npm run eval:profile-journeys` | Passed; seven journeys and 89 steps; zero consistent-journey replay losses; intentional conflicting journey retains its drift alert |

The release-readiness command's name does not establish release eligibility or independent recommendation quality. The profile journey has one replay loss in the deliberately conflicting journey; it is not accurate to call the entire replay set loss-free.

The standard PR CI must also run on the final published head. That separate run includes packaging/container smoke and native image validation; the workspace results above do not substitute for any final-head packaging check. Current final-head observations are recorded in the PR discussion.

## What is repaired

- **F1:** A positively requested true-crime subject no longer activates the old duplicated heavy-documentary rejection. Explicit subject/intensity boundaries remain distinct. Adult classification alone does not establish heavy nonfiction.
- **F3, bounded evidence slice:** Complete affirmative cue occurrences replace substring matching in derived feature labels and summary-derived fingerprint rules. Identity text stays searchable, but titles/credits do not establish those derived affect dimensions. Explicit negative evidence remains represented.
- **F4, runtime-derived inference slice:** Unscoped TV duration no longer creates whole-series commitment features, trains or activates series-runtime preference keys, biases generic duration friction/taste, creates series-length diversity buckets, or produces compact-arc explanations. Existing explicit runtime-filter and single-episode contracts remain unchanged; no metadata scope/count/completion fact is invented.
- **F5, quiet/attention slice:** Explicit meditative, slow-burn or complex intent is not penalised merely because quiet was requested. Loudness/conflict remains a separate dimension.

## Compatibility issues encountered and resolved

The first full run revealed a provenance test failure because the temporary workspace had uncommitted source edits. The workflow now verifies a clean local candidate commit; the provenance verifier was not weakened.

Removing every old nonfiction accessibility gate also broke existing uplifting and background-viewing regression expectations. The candidate retains those established compatibility gates but narrows them to contrary descriptive evidence. Uplifting versus unrelieved grim presentation, and background-friendly versus unrequested dense/disturbing presentation, can still be incompatible. Neither a crime subject nor an adult rating alone triggers those gates. Independent positive hopeful treatment and explicitly requested pacing are considered. A general replacement of these legacy gates with graded suitability/relevance thresholds remains separate, independently evaluated work.

No production rule contains a fixture title or a distinctive fixture-only exception. Existing ranking expectations, leakage baselines, evaluation thresholds and operational invariants were not changed. Four version assertions were maintained for the intentional engine identity change.

## Persistence and rollback evidence

The added disposable, file-backed SQLite test runs the actual full feature-refresh CLI with one-row batches. It verifies a limited first pass leaves two stale rows, a subsequent pass completes the refresh, obsolete generated mood/features are removed, operator-imported rows are preserved, feature FTS is refreshed, fingerprints reach the new version, and a repeat run leaves the generated state unchanged.

This is a small controlled migration test, not a production-scale benchmark or a rehearsal on the user's installation. Historical runtime weights/checkpoints are retained and no longer matched to unscoped TV-duration keys; historical mood evidence is not silently reconstructed. Full cross-version replay comparability is not established. Follow [upgrade and rollback notes](MOODRANK_CORRECTNESS_UPGRADE.md); a code-only rollback does not reverse regenerated data. No live refresh was executed.

## Remaining scope and promotion gates

The remaining lexical/vector/scorer interpretation paths are not yet consolidated into a shared emotional-intent model. Raw scoring text still has separate identity and cue logic; these changes do not claim to remove all title leakage or all negation errors throughout the application. Broad genre/certification priors, current feeling versus desired experience, independent semantic/example discovery, total profile influence, example aggregation, experiential diversity and contribution-grounded explanations require further bounded work and evaluation.

Visible tests and this implementation's exposed prompts are developer evidence, not blind cases. No production catalogue, private human judgments, live provider outputs, model assets or end-user satisfaction measurements were used. A broad independent evaluation satisfying the existing protocol, with at least 100 complete cases and predeclared operational/resource gates, remains necessary for broad activation/release. There is no supported accuracy or percentage-improvement claim.

The temporary write-enabled workspace workflow and patch script are absent from the final tree. Existing workflows and repository-wide permissions are unchanged. No merge, deployment, release, external media request, model download or paid-service activation was performed.
