# MoodRank completion candidate: validation and disposition

Date: 2026-09-08. PR #75, stacked on #74, #73, #72 and #71.
Status: implemented and verified engineering candidate; not a merge, deployment, default activation or independent quality approval.

## Exact source and executed evidence

- Base: `f4b6ce5eaee6b2f441444348664607fe2a9e5963`.
- Verified implementation: `f79c04ddbdb005e274de2949cc94a58f1de40431`.
- Implementation tree: `59b1920709c9df2791ff7353c40c66785354cb47`; exactly matches the locally tested/staged tree.
- Applied patch SHA-256: `8841445fbd85528dc099e1b7cdbf7c67624d7cc8009dab818e82c9900f3256a4`.
- Supported-runtime workspace: [34201060314](https://github.com/jremick/moodarr/actions/runs/34201060314), job `101979695827`, completed successfully on Node 24.20.0 / Ubuntu 24.04 with locked dependencies.
- Evidence artifact: `moodrank-completion-evidence-34201060314`, ID `10045883653`, ZIP SHA-256 `4937dd80c1d378b2fd4d990706431ec1e558f67aeacbb005a03394ecdd1c58d3`.
- The downloaded archive and every file in its SHA256SUMS were checked. The eight-arm JSON exactly matches the local diagnostic. Evidence includes source/tree IDs, verification logs, ablations and a synthetic latency diagnostic, not private judgments or a catalogue snapshot.

The workspace verified the entire unchanged base, removed its temporary workflow/payloads, committed a clean candidate for provenance checks and published only after verification. The original source-export workflow is also absent from the final tree. Existing workflows and repository-level permissions are unchanged. The job used contents write only for its final guarded non-force push to the named branch.

Normal repository CI must run on this final documentation commit as well. Its observed result is recorded in the PR discussion/body rather than pre-claimed in a document that triggers that run.

## Verification results

| Check on the exact implementation | Observed result |
|---|---|
| Full Vitest | **83 files, 1,385 tests passed**, zero failed tests |
| Net new production-import tests versus #74 | **67**: 26 completion cases, 37 local preparation cases, three independent-evaluator cases and one independent-retrieval race case |
| `npm run verify` | Passed: tracked secrets, documentation contracts, leakage guard, lint, TypeScript, tests, client/server builds and generated-asset secret scan |
| `npm run eval:recommendations` | Passed |
| `npm run eval:moodrank-release-readiness` | **99/99** existing persona cases, including all 28 P0 and 44 P1 cases |
| `npm run eval:profile-journeys` | Passed; zero consistent-journey replay losses; the intentional conflicting journey still raises its expected drift alert |
| Eight-arm final-response ablation | Completed, including the rejected fixed-cap negative controls |
| Synthetic final-response latency diagnostic | Completed; overhead remains and is reported below |

The earlier local full run passed 1,384 tests. A subsequent small HTTP-body cancellation repair passed the 37-test focused preparation suite and added one case; the later supported-runner full run verifies the exact 1,385-test version. Earlier development failures were repaired, not counted as passing runs. No legacy ranking golden expectations, timeout limits, release thresholds or evaluation-leakage allowances were weakened. Explicit engine/version and revised projection-contract assertions were maintained.

## Repairs and decisions

The shared-intent regression was caused in part by replacing affirmative user wording and context with canonical labels. The revised implementation uses aliases to resolve polarity while preserving scoring surfaces and context. It also handles explicitly denied current feelings, negated desired effects, signed fallback when the mood index returns no hits, directly prohibited descriptive cues and strict-versus-degree genre evidence while preserving explicit UI exclusions and original operational constraints.

The fixed eight-point personalisation limit was **rejected for the review candidate**, not tuned until exposed fixtures passed. Its regressions remain reproducible in separately labelled controls. The candidate instead measures total learned influence without changing scores/ranks. It avoids a redundant counterfactual pass when both learned-weight maps are empty; nonempty learned inputs still get the actual neutral comparison. The named source-only candidate combines shared intent, normalised feedback, experiential diversity, contribution explanations and this audit mode: `reviewCandidateRankingExperiments`, engine suffix `+intent-ranking-v2-59`.

The formerly missing semantic preparation components are now executable: an explicit pinned-model loopback Ollama adapter, validated document preparation, cold read-only SQLite CLI, private atomic output, compatible-vector reuse and identity/generation/cancellation checks. Separate case-query vector preparation and strictly bound precomputed bundles let the independent evaluator measure local discovery by pure lookup without calling a runtime/model/network during evaluation. It accepts `--ranking-arm repaired-default|review-candidate` and optional `--semantic-index` without source edits. The existing independent evaluator's declared stage remains `deterministic_rank_index_slate`, not final product-response parity.

See [implementation and operational contract](MOODRANK_COMPLETION_2026_09.md) for the per-finding disposition, commands, safety limits and rollback. These repairs do not imply universal natural-language interpretation or prove broad genre priors to be facts.

## Eight-arm visible-fixture results

Golden and adversarial measurements use actual final engine responses on fresh disposable fixtures without Seerr augmentation. The 15 profile cases are scorer-stage synthetic calibrations, with shared-intent projection applied for the relevant arms. No real encoder or private blind corpus is involved. These are visible developer regressions, not independent or statistical generalisation evidence.

| Arm | Golden NDCG@3, 17 queries | Final adversarial passing /40 | Personalised profile NDCG@3, 15 cases |
|---|---:|---:|---:|
| Repaired v0.5.3 default | 0.889355 | 39 | 0.965015 |
| Shared intent only | 0.889355 | 39 | 0.965015 |
| Normalised feedback only | 0.889355 | 39 | 0.965015 |
| Fixed-eight personalisation control | 0.889355 | 39 | **0.876504** |
| Experiential diversity only | 0.889355 | 40 | 0.965015 |
| Contribution explanations only | 0.889355 | 39 | 0.965015 |
| **Review candidate: audit, not cap** | **0.889355** | **40** | **0.965015** |
| Original five combined, including fixed cap | 0.889355 | 40 | **0.876504** |

Golden expectation failures are zero for every arm; measured golden constraint and availability accuracy remain 1. The old shared-intent golden/adversarial regressions and default direct-surreal-exclusion failure no longer occur. The default's remaining visible miss is the established diversity expectation; the review candidate resolves it. The fixed-cap controls still miss the prior personalised top-three expectation and are excluded from the candidate.

The older #74 repaired-default final response was 38/40. The new repaired default is 39/40 and the candidate 40/40 on the same visible adversarial set. This is not a real-user accuracy estimate. The passing 99-case existing persona gate is a different case set and measurement stage, not a substitute for this result. The old query sets also do not establish multi-example feedback effectiveness or human explanation quality. `promotionApproved` remains false in the diagnostic output.

## Measured performance cost

The diagnostic uses 750 synthetic catalogue records, six queries, four repeats and alternating arm order, after limited warmup. Each arm has 24 measured final-engine calls, no AI and no learned profile. It does not include real local-encoder inference or validate a production catalogue size/SLA.

| Environment / arm | p50 | p95 | Maximum |
|---|---:|---:|---:|
| Local repaired default | 120.99 ms | 155.70 ms | 180.62 ms |
| Local review candidate after optimisation | 169.39 ms | 265.37 ms | 276.93 ms |
| GitHub Node 24 repaired default | 97.60 ms | 131.83 ms | 135.72 ms |
| GitHub Node 24 review candidate | 147.73 ms | 224.62 ms | 234.74 ms |

Before avoiding the empty-profile counterfactual pass, the local candidate diagnostic measured p95 486 ms. That redundant work was removed; the final candidate still has measurable overhead. Peak combined-process RSS was 360,636,416 bytes locally and 400,527,360 bytes on GitHub; these are not per-arm incremental memory costs. Cross-environment timing differences are not attributable solely to code. Larger catalogues, nonempty learned profiles and real embedding inference still require representative resource checks.

## Completion boundary and release requirements

The actionable component implementation and identified regression follow-through are supplied in this PR. The rejected fixed cap is a completed design decision, not a missing implementation. Remaining statistical tuning and universal-language coverage are not silently claimed as solved.

All broader ranking/discovery switches remain disabled in ordinary application callers. The repaired default is `moodrank-v0.5.3`, generated features `moodrank-v0.4-features-v5`, fingerprint rules `fingerprint-rules-v4`. An authorised stopped-service **full** feature/fingerprint refresh is required for existing data; the skip-fingerprint repair path is not sufficient. No live refresh or historical-profile rewrite was performed. Old incompatible embedding hashes/versions are rejected, not automatically regenerated.

No real local model/runtime/weights or private frozen judgments were supplied or used. Mocked transport and synthetic vectors validate interfaces, lifecycle and safety, not emotional understanding, inference latency, offline process isolation or a model licence. The operator must independently approve/install and isolate a real runtime/model; the adapter does not pull models or activate a cloud service. The blind data holder must run the existing independent frozen >=100-case broad-change evaluation with role separation and predeclared gates, plus human explanation assessment and representative resource checks, before activation. No implementer-authored exposed cases can be relabelled as blind evidence.

No merge, release, deployment, live database/configuration access, real model inference/download, external media request, production backfill or paid-service activation occurred. Code review readiness and green CI do not authorize those actions.
