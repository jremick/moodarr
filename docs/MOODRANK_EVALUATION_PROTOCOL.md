# MoodRank Evaluation Protocol

Status: governance contract for recommendation changes. This protocol does not change ranking behavior.

Last updated: 2026-08-27.

## Purpose

Moodarr uses three evaluation tiers. Each tier answers a different question. A perfect developer-regression result is not evidence that MoodRank generalizes to unseen prompts.

1. **Developer regression** protects implemented behavior. The existing golden, adversarial, rank-index, release-readiness, profile, journey, and trace suites stay visible to implementers and remain normal code-review gates.
2. **Frozen blind evaluation** measures an already-frozen candidate against judgments that were unavailable during implementation. It is the evidence source for user-facing ranking changes.
3. **Rolling challenge** holds newly observed failures until after the current release decision. A challenge case must not become a same-cycle tuning target.

## Non-Negotiable Boundaries

- Keep the actual blind cases, judgments, detailed outputs, and catalog snapshot outside the repository and continuous integration.
- Pass explicit file paths. The evaluator must not auto-discover a private bundle.
- Freeze the case set, judgment set, and catalog snapshot by SHA-256 before ranking work begins.
- Keep implementer and evaluator roles separate. The evaluator who holds the judgment set must not reveal case-level judgments during implementation.
- Run the deterministic no-AI path. The independent evaluator must not call a model, provider, or network service.
- Open the catalog snapshot read-only. Do not migrate, repair, backfill, or write recommendation sessions into it.
- Derive validity and metrics from content. A supplied `ok`, `pass`, or release-decision field is invalid input.
- Preserve `unknown` when catalog metadata cannot prove a constraint. Do not turn missing metadata into a pass or a failure without an explicit policy.

## Privacy And Data Handling

Blind inputs can contain realistic public examples or manually sanitized real-query-inspired prompts. Do not ingest the live review queue automatically.

Before a query enters the blind set:

- remove names, household details, URLs, network identifiers, credentials, free-text notes, and other identifying context;
- replace inventory-specific detail when it is not necessary to the behavior under review;
- record only `synthetic` or `sanitized-real` as source kind, not a user or session identifier;
- complete a manual privacy review;
- keep the raw bundle and detailed output in a private local location with restrictive file permissions.

Query hashes are not prompts and are not suitable blind cases. Raw-query capture in the app remains opt-in. Do not commit raw prompts, catalog inventory, title-level private output, review notes, absolute local paths, or database contents.

## External Data Contract

The runner accepts two independent JSON documents. The strict runtime schemas in `scripts/moodrank-independent-eval-contract.ts` are authoritative.

### Case set

The case set contains the requests that MoodRank may execute. It does not contain relevance answers.

Required envelope fields:

- schema version;
- corpus ID and frozen timestamp;
- catalog snapshot ID;
- cases with a unique ID, query, watch context, result limit, optional filters, source kind, privacy-review status, and bounded query-family tags.

### Judgment set

The judgment set remains with the independent evaluator until the candidate is frozen. It can contain:

- graded item relevance;
- acceptable-result families, where any member can satisfy the family;
- pairwise preferences or ties;
- explicit constraint judgments with `pass`, `fail`, or `unknown`;
- reviewer count and adjudication status.

Every judgment must resolve to a case and catalog item in the frozen inputs. Duplicate case IDs, unresolved item references, invalid grades, incomplete case coverage, unknown fields, or corpus mismatches invalidate the run.

An item registry entry uses a stable local `ref` plus an `externalId` object. For the schema-31 pilot snapshot, copy `external_ids.source` and `external_ids.value` exactly. Available sources are `imdb`, `plex`, `tmdb`, `tvdb`, and `wikidata`. Keep numeric provider IDs as JSON strings. Include `mediaType` (`movie` or `tv`) as a verification field. The runner also supports `source: "moodarr"` with a `media_items.id`, but that identifier is snapshot-local and should be a fallback only. Optional `title` and `year` fields are assertions: a mismatch invalidates the run.

Small synthetic examples under `tests/fixtures/moodrank-independent-eval/` demonstrate the file shape only. They are not the blind corpus and must not be cited as independent evidence.

## Freeze Procedure

Before implementation:

1. Prepare an offline, checkpointed catalog database snapshot. Do not point the evaluator at an active Moodarr database or an incomplete SQLite main file without its committed WAL content.
2. Prepare and validate the case set.
3. Complete judgments and adjudication outside the implementation context.
4. Record SHA-256 for the case set, judgment set, and catalog snapshot.
5. Record the baseline commit, MoodRank engine version, Node version, platform, command, and duration.
6. Store the full baseline report outside the repository, for example `<private-directory-outside-checkout>/<commit>-baseline.full.json`.
7. Commit only a privacy-safe aggregate summary when evidence must be retained in the repository.

The aggregate summary can contain hashes, counts, confidence intervals, environment versions, commands, and explicit evidence states. It must not contain prompts or item-level output.

Run the leakage ratchet directly during development:

```text
npx tsx scripts/verify-moodrank-eval-leakage.ts
```

Run a frozen blind evaluation only after the candidate source is clean and frozen:

```text
npx tsx scripts/evaluate-moodrank-independent.ts \
  --cases <private-cases.json> \
  --judgments <private-judgments.json> \
  --catalog <cold-catalog.sqlite> \
  --output <private-full-report.json>
```

Standard output contains aggregate evidence only. `--output` is optional and writes case-level detail to a new mode-`0600` file outside the repository; it refuses to replace an existing file. A dirty or unknown source remains usable for exploratory metrics, but its report is `incomplete` with `insufficient` evidence. The runner reads source state again after evaluation and rejects the run if the commit, dirty state, or source-tree hash changed.

### Controlled product-response pilot

The independent evaluator above remains the no-network blind baseline. A separate controlled runner can measure the final `SearchService` response with OpenAI reranking after the candidate source is committed and clean:

```text
npm run eval:moodrank-product -- \
  --cases <private-cases.json> \
  --judgments <private-judgments.json> \
  --catalog <cold-catalog.sqlite> \
  --config <mode-0600-config.json> \
  --work-db <private-retained-work.sqlite> \
  --output <private-full-report.json> \
  --confirm-external-processing
```

The runner prints the exact planned request count before the first provider call and permits at most 100 calls by default. A larger run needs an explicit `--max-external-requests` value. It sends the private case queries and bounded candidate metadata to the configured OpenAI model. Keep the inputs, full report, and retained database private and outside the repository.

This is a controlled final-response pilot, not deployed-runtime parity. It disables Plex, Seerr, provider embeddings, AI brief parsing, AI query optimization, Taste Scout, and personalization. It clears imported auth, request, profile, review, and telemetry state from the disposable database, requires strict trace persistence, preserves the source snapshot, and retains only the private evaluation copy.

The evaluation contract is fail-loud. A provider failure, non-AI response, partial serialized ranking, duplicate ID, missing ID, unknown ID, uncovered final response item, or service-tier mismatch stops the run before metrics or retained evidence are written. A deterministic fallback is valid production continuity behavior, but it is not AI evaluation evidence. Simulated rankers are labeled as simulations and cannot produce provider evidence. The runner uses a seeded, balanced arm order so half of the cases run the AI arm first and half run the deterministic arm first. A timeout override remains diagnostic and provider-evidence-ineligible. Confidence intervals are case-bootstrap intervals conditional on one provider run per case.

The product-response runner defines no release threshold. Do not use its result to widen the current build-time AI-provider policy or claim a general quality improvement.

## Production And Evaluation Response Contracts

Production and evaluation share the same provider response shape but have different failure behavior.

The production response contract requires:

- every serialized candidate exactly once in a compact ordered `id` plus `score` ranking;
- no duplicate, missing, or unknown candidate IDs;
- explanations only for the displayed top window, in the same order as the ranking;
- deterministic results when the provider request or response fails validation;
- a per-search `applied`, `fallback`, or `not_requested` rerank status;
- a persistent Finder warning for the current fallback slate and safe 24-hour aggregate plus recent failure-category diagnostics for admins.

The evaluation response contract adds these requirements:

- no fallback or partial-credit path;
- complete coverage of the configured provider window, which is 60 candidates when at least 60 are offered;
- complete AI coverage of every evaluated final-response item;
- verified service-tier readback for external provider evidence;
- a clean failure before quality metrics or retained output when any requirement is not met.

The evaluator hashes the rendered per-case prompt and JSON response schema, including the actual candidate and explanation counts, into case-set contract identities. It also hashes the strict evaluation contract. Reports with different prompt, response, or evaluation contracts are not comparable.

## Model Selection And Reference Benchmark

NDCG@10 has a mathematical ideal of `1.0`. Use that value as the absolute ceiling for the adjudicated judgments. Do not describe a model result as the theoretical maximum.

Use `gpt-5.6-sol` at `xhigh` reasoning on Standard service as the empirical high-capability reference. It is a reference point, not ground truth, and a challenger can beat it. Reference and challenger reports must use the same frozen cases, judgments, catalog, source tree, engine, prompt contract, evaluation contract, seed, bootstrap policy, candidate window, output budget, and timing policy.

The model-selection harness consumes private strict product-evaluation reports through a mode-`0600` manifest:

```text
npm run eval:moodrank-model-selection -- \
  --manifest <private-mode-0600-manifest.json> \
  --output <private-mode-0600-result.json>
```

The manifest precommits the reference, incumbent, challengers, model settings, prices, latency and quality gates, evidence stage, and deterministic selection order. The result reports completeness, NDCG, family hits, complete product-response latency, provider-only latency, observed token cost, paired reference and incumbent confidence intervals, Pareto membership, and explicit rejection reasons. Screening evidence can narrow candidates but cannot select a production default. A production manifest is rejected unless it contains at least 100 unique cases plus precommitted lower-95% NDCG@10 gates against the empirical reference and, when present, the incumbent. A production recommendation also requires strict full-AI reports for the reference, incumbent, and challenger; clean and comparable provenance; complete usage; production timing; all other precommitted gates; and Pareto eligibility when required. An ineligible reference or incumbent invalidates the decision instead of supplying comparison metrics to an otherwise eligible challenger.

For the present 30-case corpus, report results as pilot evidence. Three repeat runs per case can measure provider variability, but repeats do not increase the independent case count. Use at least 100 unique blind cases before a gate-eligible default-model decision. Add explicit constraint judgments and pool candidates from the deterministic baseline, empirical reference, and challengers before freezing that larger corpus. Keep prompt tuning cases separate from the blind selection holdout.

## Metrics

The independent report keeps retrieval, ranking, constraints, and timing separate:

- judged-relevant pre-rerank recall;
- NDCG at 3 and 10;
- acceptable-family hit rate at 3 and 10;
- pairwise preference coverage and accuracy;
- explicit constraint pass, fail, and unknown counts and rates;
- retrieval and scoring latency at P50 and P95;
- evaluated case count, with missing, invalid, or unjudged cases rejected before evaluation.

In the first runner version, `pre-rerank` means the raw retrieval candidates. Ranked metrics use the complete deterministic rank-index order, sliced to the case result limit. They do not claim parity with the product response's later equivalent-title deduplication step. Keep this stage label explicit in stored evidence.

Aggregate by case before combining results. A case with many labels must not dominate the report.

Use a deterministic case-clustered bootstrap with a recorded seed. Report point estimates and 95% confidence intervals. Candidate-versus-baseline comparisons must use paired case deltas:

- interval entirely above zero: improvement;
- interval entirely below zero: regression;
- interval crossing zero: inconclusive.

Do not interpret `inconclusive` as proof of equivalence.

## Evidence States And Gates

- Fewer than 30 complete cases: `insufficient`.
- From 30 through 99 complete cases: `pilot`.
- At least 100 complete cases: `gate_eligible`.

A 30-case pilot is the minimum before the first bounded behavior change. Grow toward 50 to close observed coverage gaps. Require at least 100 before a broad scorer or retrieval rewrite.

Sample-size state does not weaken exact gates. Any schema failure, input mismatch, privacy failure, catalog mismatch, hard-constraint regression, or availability regression blocks the claimed result.

For a bounded ranking change at pilot size:

- all existing P0 and P1 developer regression gates remain passing;
- no new hard-constraint or availability violation is allowed;
- blind wins must be at least blind losses;
- report the interval and describe the result as pilot evidence, not statistical proof;
- do not tune against a failed blind case in the same release cycle.

Metric thresholds for a release must be committed before candidate work begins. Do not add a threshold after seeing candidate results.

## Developer Regression Commands

Record outputs separately so missing live evidence cannot be hidden by synthetic success:

```text
npm run verify
npm run eval:recommendations
npm run eval:moodrank-release-readiness
npm run eval:profile-journeys
npm run eval:profile-replay
npm run eval:moodrank-traces
```

`eval:profile-replay` with no real holdouts or comparisons is `insufficient`, even if the command exits successfully. `eval:moodrank-traces` validates trace persistence and privacy; it is not a recommendation-quality metric. A trace run with no eligible traced sessions is incomplete evidence.

## Fixture-Leakage Ratchet

The leakage verifier parses production recommendation TypeScript and compares its string and regular-expression literals with exact synthetic titles and a small reviewed set of distinctive fixture phrases.

- Generic ontology terms such as `cozy`, `deadpan`, or `science fiction` are not fixture leakage by themselves.
- Existing matches live in a checked-in known-debt baseline keyed by stable finding ID and occurrence count.
- Removing a known match passes. Adding a match, moving it to a new production file, or increasing its count fails until reviewed.
- An allowlist entry needs a general rationale and at least two independent non-fixture examples.
- The hard gate uses exact normalized matching only. It does not use fuzzy matching, embeddings, or an unrestricted n-gram scan.

The known-debt baseline is containment, not approval. Its findings must remain visible as debt until a later ranking-behavior change removes or generalizes them against the frozen blind baseline.

## Rolling Challenge Process

After a candidate decision:

1. retain failures without changing the just-completed evaluation;
2. sanitize and adjudicate suitable failures;
3. add them to the rolling challenge set;
4. use the challenge set as independent evidence for the next candidate;
5. promote a challenge into the visible developer regression suite only after it has served as blind evidence.

## Explicit Non-Goals

This protocol does not add:

- a review UI, service, or evaluation database;
- automatic review-queue ingestion;
- AI-generated judgments;
- a rule registry, constraint DSL, or scoring rewrite;
- embeddings, ANN, reciprocal-rank fusion, or retrieval quotas;
- score calibration or probability claims;
- public blind data publication;
- a replacement for existing developer regression tests.
