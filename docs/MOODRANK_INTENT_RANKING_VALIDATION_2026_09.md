# Shared-intent and ranking experiment validation

Date: 2026-09-08.
Status: implemented and mechanically verified; all five experiments remain disabled by default. No promotion, merge or deployment is approved by this report.
PR: [#74](https://github.com/jremick/moodarr/pull/74), stacked on #73, #72 and #71.

## Source and execution provenance

- Prerequisite base: `8dc1c756dad8761914197fa6163c97fe0b15b5b9` (the final documented #73 head).
- Verified implementation: `a55942da2fc44f1d9591738936498b21720f6d13`.
- Supported-runtime verification: [Actions run 34195040312](https://github.com/jremick/moodarr/actions/runs/34195040312), job `101960807333`, completed successfully on Node 24.20.0 / Ubuntu 24.04, using locked dependencies.
- Applied patch SHA-256: `c38322b10bd36fc88a8c07683c44d7cca3389e520919fa4c9f0208c0fbdb4a8c`. The workspace checked the complete unchanged source base before applying it and committed a clean candidate before provenance-sensitive tests.
- Diagnostic artifact: `moodrank-ranking-ablations-34195040312`, artifact ID `10043629415`, archive SHA-256 `1e5f45097dab6798a636d2e1aff592f58f040ea6dcfb58c0c373b1f2c46541c6`. The downloaded artifact was checksum-verified and its JSON exactly matched the local diagnostic output.
- The temporary source-export and patch-workspace workflows and all four encoded payload files are absent from the final source tree. Existing workflows and repository-level permissions are unchanged. Publication used a named-branch/head check and no force push.

The normal repository CI is also required on the final documented head. Its subsequently observed result is recorded on the PR; this report does not pre-claim a check triggered by its own commit.

## Implemented scope

The source-only Boolean switches are `sharedIntent`, `normalizedFeedback`, `boundedPersonalization`, `experientialDiversity` and `groundedExplanations`. Existing engine callers enable none of them. Each can be evaluated separately, and the enabled bit mask is reflected in engine/session identity. See [the experiment contract](MOODRANK_INTENT_RANKING_EXPERIMENT.md) for architecture, finite language coverage and rollback.

The shared brief distinguishes explicit current feelings from requested viewing qualities/effects and carries positive, avoided, reduced and conflicting facets. Positive projections are consumed across retrieval and several scoring/profile paths without replacing authoritative original hard filters. Other changes normalise repeated/contradictory example evidence, bound the total deterministic learned-personalisation effect against a neutral counterfactual, use experiential similarity in diversity, and select explanations from actual weighted contributions without enabling trace persistence.

These are working experimental implementations, not merely interfaces. They are not claims of complete arbitrary-language interpretation, universal F2/I1 closure, an optimally calibrated profile budget, or independently established recommendation-quality improvement.

## Executed verification

| Check on the clean implementation | Observed result |
|---|---|
| New production-import regressions | 57 passed: 33 viewing-intent and 24 ranking-experiment tests |
| Full Vitest run | 81 files, **1,318 tests passed**, no failed tests |
| Tracked credential scan | Passed |
| Documentation contracts | Passed: 37 API routes and the existing beta.2 contract |
| Evaluation-leakage guard | Clean: no new findings or changed allowlist/baseline |
| ESLint and TypeScript | Passed |
| Client/server builds and generated-asset secret scan | Passed |
| `npm run verify` | Passed |
| `npm run eval:recommendations` | Passed |
| `npm run eval:moodrank-release-readiness` | **99/99 existing persona cases passed**, including 28 P0 and 44 P1 |
| `npm run eval:profile-journeys` | Passed: seven journeys / 89 steps; zero consistent-journey replay losses; the intentional conflict journey retains one loss and one drift alert |
| Seven-arm final-response diagnostic | Completed; mixed results and failed expectations retained, `promotionApproved: false` |

Regression coverage includes current feeling versus desired experience, negated desired effects, original filters and hidden items in final responses, feedback duplication and contradictory IDs, non-vacuous uncapped-versus-capped profile comparisons, transient trace privacy/reconstruction and tamper rejection, and diversity prefix/relevance bounds.

Local evidence is not silently rewritten: the unchanged #73 baseline passed `npm run verify`. An initial local implementation run, before the final three negated-effect cases, passed 1,314 tests and hit the existing five-second profile-journey timeout. That unchanged test and all 57 final new tests passed on focused retry (58 executed, 164 unrelated cases skipped by the explicit name filter). The subsequent full supported-runner run passed all 1,318 tests without changing timeouts, fixture expectations, thresholds or leakage guards. The initial local run is not described as a successful full run.

## Visible quality ablations: retain the regressions

The diagnostic compares the repaired **v0.5.2 default**, not the historical v0.3 reference in `eval:recommendations`. Golden and adversarial results use actual final engine responses on fresh in-memory fixture databases with no Seerr augmentation. Profile results use existing synthetic scorer-stage calibrations. The default independent semantic-discovery experiment is not activated, and no real encoder is involved.

| Arm | Golden NDCG@3, 17 queries | Golden expectation failures | Final adversarial cases passing, out of 40 | Profile personalised NDCG@3, 15 cases |
|---|---:|---:|---:|---:|
| Repaired default | 0.889355 | 0 | 38 | 0.965015 |
| Shared intent only | 0.883263 | 1 | 37 | 0.965015 |
| Normalised feedback only | 0.889355 | 0 | 38 | 0.965015 |
| Bounded personalisation only | 0.889355 | 0 | 38 | 0.876504 |
| Experiential diversity only | 0.889355 | 0 | 39 | 0.965015 |
| Contribution explanations only | 0.889355 | 0 | 38 | 0.965015 |
| All five combined | 0.883263 | 1 | 39 | 0.876504 |

All seven arms retained the measured golden constraint and availability accuracy of 1. This is limited to those visible cases, not a guarantee for all queries.

Important observed failures:

- The default final-response measurement already fails `negation-weird-not-surreal`: The Glass Orchard remains in the top five. Every experimental arm still fails this case. This is an unresolved failure, not hidden by the positive-projection work.
- The default also fails `diversity-cozy-tonight`, which expects Soft Rain Sunday in the top ten. Experiential diversity resolves that visible expectation, including in the combined arm.
- Shared intent adds a `feel-good-comedy` golden failure: Hunt for the Wilderpeople is not in the top three. Its single-arm run also adds a `not-cute-family-safe` expectation failure. Positive canonicalisation is therefore not ready for default activation.
- The predeclared eight-point personalisation budget reduces profile NDCG and misses Soft Rain Sunday in the personalised top three for `light-emotionally-gentle`. Profile win/loss/tie counts change from 12/0/3 to 10/0/5 against the synthetic unpersonalised comparison. Those zero-loss counts do not mean there is no regression against the repaired personalised default.
- The old query sets do not exercise multi-example feedback aggregation. Unchanged metrics do not validate that arm's effectiveness. They also do not measure human explanation accuracy, usefulness or trust.

The 38/40 final-response default and the passing 99-case existing persona gate are different case sets and measurement stages. Neither result should be substituted for the other. A diagnostic process exiting successfully means its comparisons completed; it does not mean every arm passed a quality gate.

## Activation, operational boundary and outstanding evidence

All five switches remain disabled. Resolve the observed regressions and evaluate representative compositional/refinement/reference cases before any promotion. The eight-point profile budget, diversity blend and relevance guard are experimental choices, not trained optima. Profile budgeting needs an additional scorer pass; representative latency and resource evidence are still required.

No new provider/model/default/dependency, schema, stored-feature/fingerprint version, or learned-profile migration is introduced here. No live database/configuration, external media request, provider inference, model download, backfill, merge, release or deployment was performed. The prerequisite #72 full feature/fingerprint refresh requirement still applies to that separate upgrade; this PR does not waive it or run it.

Remaining work includes broader language and content-evidence coverage, legacy raw scorer/degree/genre priors, calibrated personalisation and aggregation, human explanation assessment, and an approved real local encoder/corpus with production-scale resource checks for #73. Broad activation also requires the repository's independent evaluation with at least 100 complete frozen blind cases and predeclared gates. These exposed developer cases must not be relabelled as blind evidence. No percentage improvement in real-user relevance or satisfaction is claimed.
