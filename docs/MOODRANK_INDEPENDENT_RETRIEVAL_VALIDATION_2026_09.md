# Independent retrieval experiment: validation record

Date: 2026-09-08. Status: tested source-only experiment, disabled by default. Not a release or a semantic-quality claim.

## Source and dependency

PR #73 depends on #72, which depends on #71. The base is `336cede22e60fb8adc40e002771e9de7d33d3930`. The verified implementation is `03e52a038c2145458a1051695f4f711e0d1cc425`.

The default engine remains `moodrank-v0.5.2`. Only explicit source/evaluation injection selects the `+local-semantic-discovery-v1` engine arm. No ordinary application setting, environment flag or HTTP request activates it. No model weights or real encoder implementation are supplied, downloaded or enabled.

## Execution and evidence

The patch was developed against the real repository with its locked dependencies and Node 24.20.0. The uploaded patch was validated against SHA-256 `aa1679f86d5e4b2dae22119b1695c949641d8b0f524f36a0199d95df0ac41a16`, applied with `git apply --check`, committed locally with a clean working tree for provenance validation, and published only after the existing checks passed.

Successful GitHub Actions workspace: run `34171138012`, job `101891503982`, Ubuntu 24.04, Node 24.20.0. Evidence artifact: `10035770082`; archive SHA-256 `a5bc1b8d52498348b6427344c2e3dbcab730ba2d474a2f58c787242800cabee5`. The artifact contains source identity and the four verification logs, not a catalogue, private judgments, vectors, configuration or secrets.

| Check | Actual result |
|---|---|
| `tests/localSemanticIndex.test.ts` | 21 passed |
| `tests/independentRetrieval.test.ts` | 20 passed |
| Full Vitest | 79 files, 1,261 tests passed |
| `npm run verify` | Passed, including lint, typecheck, documentation contracts, leakage guard, tests, client/server build and secret scans |
| Evaluation leakage guard | Clean; zero new findings and zero active known debt |
| `npm run eval:recommendations` | Passed |
| `npm run eval:moodrank-release-readiness` | Passed; 99 visible cases, including all 28 P0 and 44 P1 cases |
| `npm run eval:profile-journeys` | Passed; no consistent-journey replay losses, with the existing intentionally conflicting journey retained |

The 99-case release-readiness result evaluates the default arm and existing visible fixtures. It is not independent semantic-model evidence, and it does not validate the injected experiment's ranking quality.

The normal PR CI must also run against the published final head. Packaging/container smoke and native image/upgrade checks are separate from this workspace's developer verification. Final-head CI observations are recorded in the PR discussion rather than pre-claimed in this document.

## Mechanical discovery result

The production-import integration test constructs a disposable SQLite catalogue with 3,005 records. A target is absent from the default 3,000-ID selected window. Injected query-to-corpus discovery introduces that target while the total selected window remains 3,000. This demonstrates that the new channel can discover an ID missed by existing candidate selection, rather than merely reorder the same set.

The other integration cases cover actual final engine responses, hard filters, hidden candidates, input-hash and feature-version staleness, nonexistent rows, an unavailable reference that discovers available neighbours, negative examples, empty or unavailable encoders, malformed vectors, identity changes during inference, cancellation, timeouts, bounded channel allocation, and trace privacy/provenance. Index cases validate immutable snapshots, replacement/deletion, rejected malformed data, deterministic ties, resource limits and cooperative cancellation.

**All embedding vectors in these tests are synthetic.** This is no evidence that a real model understands emotional intent or improves NDCG, satisfaction, catalogue-wide recall or production latency. The 41 new cases are visible developer regressions, not a blind corpus.

## Local environment limitations retained in the record

A root-run full check initially failed the existing permission-denial test, which passed when run as the normal user. A subsequent normal-user full run hit the existing five-second timeout in three catalogue tests under local load. Those assertions and timeouts were not changed. The standard GitHub Node 24 runner passed the full 1,261-test suite with the original limits. These earlier local runs remain failures in the evidence history, not silently counted as successful runs.

## Safety, lifecycle and promotion

The implementation introduces no new dependency, schema migration, provider call, model asset, default activation or request-time catalogue backfill. Index/model identity, feature-version and input hashes must match; each admitted candidate is checked against the same operational and hard-filter predicate as the default scorer. Prepared snapshots are explicitly replaced off the request path and are immutable during each search.

Count-only diagnostics and an explicit experiment engine identity distinguish failure/fallback from default retrieval. Late asynchronous inference cannot persist anything through this path. A JavaScript deadline cannot preempt synchronous native model work; any approved encoder still needs a bounded runtime and measured CPU/memory/latency behaviour.

Both the temporary workflow and all four compressed patch fragments are absent from the final tree. Existing workflows and repository-wide permissions are unchanged. The workflow token was exposed only for the final guarded, non-force push to the experiment branch. No merge, release, deployment, live data migration, external media request or paid-service activation was performed.

The underlying #72 feature/fingerprint upgrade still requires an authorised stopped-service full refresh. This experiment owns no additional persistent data or migration; removing its explicit injection restores default retrieval.

Before activation: select an approved offline encoder/model with a compatible licence/platform contract, prepare a versioned permitted-catalogue index, measure representative cold/warm resource and final-response latency, and obtain the existing independent broad-change evidence with at least 100 complete cases and predeclared gates. Keep the experiment disabled until that review succeeds.

## Work still outside these PRs

Current emotional state versus desired experience, full shared signed-intent propagation across lexical/vector/scoring paths, total profile-influence calibration, example aggregation experiments, experiential diversity and contribution-grounded explanations remain unimplemented. The new index is an executable experimental discovery foundation, not completion of the entire recommendation improvement programme. See [experiment contract](MOODRANK_INDEPENDENT_RETRIEVAL_EXPERIMENT.md) and the remediation ledger for scope.
