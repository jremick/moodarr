# MoodRank engineering follow-through — September 2026

Status: implementation candidate; not a release, default activation, or independent quality approval.
Base: PR #74 at `f4b6ce5eaee6b2f441444348664607fe2a9e5963`.
The prerequisite order remains #71, #72, #73, #74, then this follow-through.

## Decisions and implemented repairs

The earlier ranking experiments were not all improvements. This candidate corrects the actual intent regressions and **does not promote the harmful fixed-eight-point personalisation limit**. `reviewCandidateRankingExperiments` enables shared intent, normalised example aggregation, experiential diversity, contribution explanations, and a new **audit-only** personalisation measurement. The fixed-eight experiment remains an explicit negative control for reproducibility; it is not in the review candidate.

Shared intent v2 preserves affirmative wording and context instead of replacing the user's surface terms with canonical aliases. Aliases resolve polarity; they do not silently replace “comedy” with “funny” in scoring or discard contextual terms. Explicit negative and degree facets are projected consistently into positive lexical/vector/mood inputs, including the no-index-hit mood fallback. Negated desired-effect phrases do not reintroduce the outcome as an attracting keyword. First-person denied feelings are stored only in the request-local intent representation, not interpreted as content exclusions or invented coping goals.

A directly prohibited quality with affirmative **description** evidence is rejected rather than outvoted by unrelated score contributions. This also corrects the default final-response surreal-exclusion failure. Reduced preferences, absent descriptions, title words, and correlated genre priors are not treated as that proof. Content cues distinguish `non-` and `-free` morphology and bounded comparative noun phrases, so “non-exhausting” and “instead of supernatural horror” are not positive evidence of exhausting or horror content. Rejection remains observable in transient/opt-in score traces.

The shared arm distinguishes parser-inferred “less horror” / “not too scary” preferences from strict genre exclusions. It removes an inferred genre prohibition only when all matching original parser evidence is degree language; explicit UI exclusions and separately stated strict exclusions remain. Original runtime/year/availability constraints stay authoritative. Degree clauses are masked before legacy strict guardrails, while their original forms remain available for soft penalties. The ordinary parser is not globally changed by this experiment.

The personalisation audit recomputes the same candidate without learned profile/preferences when learned weights exist (and avoids the redundant second pass when both learned inputs are empty) and records the total score delta, including indirect effects. Audit mode changes neither score nor rank. It records the proposed and applied delta and a policy identifier; the trace validator reconstructs its arithmetic and rejects tampering. The fixed-eight cap is still separately testable, including non-vacuous positive/negative cases. Audit counters are not independent verification of the neutral model, nor are they a calibrated optimal budget.

## Current implementation coverage

| Original concern | Disposition |
|---|---|
| F1 true-crime subject/intensity contradiction | Repaired in #72, regression coverage retained. |
| F2 signed retrieval/scoring interpretation | #71 mood-index repair plus revised shared projections and direct description prohibition. Degree handling and fallback coverage added here. No universal natural-language interpretation claim. |
| F3 unsafe content cue inference | #72 derived-evidence repair extended with morphology/comparative controls here; stored representations versioned. Broad genre priors remain heuristic, not proven content facts. |
| F4 invented TV series commitment | #72 removes unscoped-runtime inferences throughout the affected consumers; no invented episode/series facts. |
| F5 quiet/attention conflict | #72 direct fix retained; shared input surface preservation removes the new canonicalisation regressions. |
| F6 semantic discovery cannot add candidates | #73 independent discovery plus actual local-runtime adapter and cold-snapshot preparation here. Same-model snapshot replacement during encoding now fails safely. Real model and scale effectiveness require external resources and evidence. |
| F7 aggregation and correlated learned influence | Normalised example arm retained; total influence audit implemented. Fixed-eight proposal rejected for the review candidate because it regressed measured profile quality. No weight grid-search against these visible cases. |
| F8 diversity and explanations | Existing independent arms retained in the review candidate. Human explanation usefulness is not established by mechanical tests. |
| I1 current feeling versus desired experience | Shared v2 distinguishes explicit positive/denied states, desired effects and content qualities; no automatic coping goal. |

Finite grammar and remaining statistical priors are limitations of the implemented model, not a promise of arbitrary-language certainty. Further statistical tuning, unseen-language quality and human explanation acceptance require evidence rather than more exceptions for these exposed examples.

## Operationally usable local index preparation

The new `OllamaLocalEncoder` implements both query and document embedding against an **explicit, separately installed local runtime**. It never pulls models, selects a default model, downloads assets, creates a cloud client or reads credentials. It accepts a literal loopback origin, an explicit model tag, a pinned SHA-256 model digest, dimensionality and an operator confirmation that the runtime is offline. It checks installed model identity before and after inference; rejects remote-model metadata, incompatible capabilities/format, redirects, malformed shapes, non-finite/zero vectors, oversized input/output and cancellations. It uses `/api/tags`, `/api/show`, and `/api/embed` with `truncate: false`.

The confirmation is an operator attestation, **not a technical proof that another process cannot access the internet**. Configure Ollama's documented local-only mode (`OLLAMA_NO_CLOUD=1`, restart and verify), disable outbound egress for that process where isolation is required, and review the model licence/platform contract. A model tag/digest must refer to the approved already-installed artifact; model switching during a request is rejected when detected, not cryptographically prevented. Keep the runtime stable during preparation/search. The adapter does not change the official application's compiled provider policy, and no ordinary app caller imports or activates it.

Official API references used for the implementation: [embedding endpoint](https://docs.ollama.com/api/embed), [installed-model endpoint](https://docs.ollama.com/api/tags), [model details](https://docs.ollama.com/api-reference/show-model-details), and [local-only configuration](https://docs.ollama.com/faq). These specify transport/configuration, not endorsement of a particular model's MoodRank quality.

Create a private encoder configuration **outside the repository**, filling in the approved model values rather than using an example's fabricated digest:

```json
{
  "baseUrl": "http://127.0.0.1:11434",
  "model": "APPROVED_MODEL:EXPLICIT_TAG",
  "digest": "THE_64_HEX_SHA256_OF_THE_INSTALLED_MODEL",
  "dimensions": 768,
  "offlineRuntimeConfirmed": true
}
```

Dimensionality must be that supported/approved for the chosen model; 768 is illustrative, not a default or recommendation. On an authorised **cold, current-feature catalogue copy**, prepare a complete index without changing the database:

```sh
node --import tsx scripts/prepare-local-semantic-index.ts \
  --catalog /private/catalog-copy.sqlite \
  --config /private/local-encoder.json \
  --output /private/prepared-index.json
```

The command rejects live WAL/SHM/journal state, stale or incomplete features, invalid configurations and repository-local output paths. It opens SQLite read-only/immutable/query-only, checks the input hash before/after, and publishes one complete mode-0600 file atomically without overwriting an existing output. SIGINT/SIGTERM cancel preparation. A failure publishes no partial snapshot. `--previous /private/older-index.json` reuses only identity/hash-compatible document vectors; changed input is re-encoded and deleted input disappears. A feature/model identity change requires a fresh preparation rather than reusing the old snapshot. Imported mood data and profiles are not modified.

The result wraps `snapshot` and `catalogSha256`. Construct `ExactLocalSemanticIndex` from its `snapshot` and supply the matching encoder to the existing **explicit evaluation/source injection** seam; no application default/configuration activates it. Both snapshot replacement and asynchronous query encoding are checked for generation drift, including replacement with the same model identity. Engineering containment remains 50,000 records, 4,000,000 vector scalars, 4,096 dimensions, and additionally 64 MiB of preparation text. These are validation limits, not production-scale performance claims. Incremental index persistence is operator-controlled; there is no request-time catalogue backfill.

No real model runtime, weights or permitted embedding corpus was supplied to this implementation session. Adapter/preparation tests use a mocked local HTTP runtime and synthetic vectors. They prove protocol, lifecycle, read-only handling and cancellation, **not semantic understanding or real inference latency**.

## Independent review without source edits

The existing read-only independent evaluator now accepts:

```sh
npm run eval:moodrank-independent -- \
  --cases /private/frozen-cases.json \
  --judgments /private/frozen-judgments.json \
  --catalog /private/frozen-catalog.sqlite \
  --ranking-arm review-candidate \
  --output /private/candidate-report.json
```

Compare with `--ranking-arm repaired-default` on the identical frozen files. The arm changes the engine identifier and evaluation-input digest. Unsupported or duplicate selectors fail. The evaluator keeps the **original full query's hard filters** authoritative even when query optimisation changes the scoring text. It does not call the local runtime, any model or the network; it does not instantiate network clients, migrate data or write recommendation sessions. Its declared measurement stage remains `deterministic_rank_index_slate`, **not full product-response parity**. Without an explicit precomputed bundle this selector measures only the ranking candidate. The following optional path also evaluates local semantic discovery while keeping the evaluation process entirely offline.

### Frozen semantic evaluation without runtime inference

The independent data holder can precompute query vectors **separately**, without giving the model any judgment document:

```sh
node --import tsx scripts/prepare-local-semantic-index.ts \
  --catalog /private/frozen-catalog.sqlite \
  --config /private/local-encoder.json \
  --cases /private/frozen-cases.json \
  --ranking-arm review-candidate \
  --output /private/prepared-evaluation-index.json

npm run eval:moodrank-independent -- \
  --cases /private/frozen-cases.json \
  --judgments /private/frozen-judgments.json \
  --catalog /private/frozen-catalog.sqlite \
  --ranking-arm review-candidate \
  --semantic-index /private/prepared-evaluation-index.json \
  --output /private/semantic-candidate-report.json
```

Preparation must be an explicitly approved, offline, data-holder operation, not something the implementer automatically runs over private cases. It accepts case text but no judgment argument, validates the case/catalogue binding, and hashes the exact shared query projection. Freeze the resulting index file hash before the evaluator run as an additional input artifact. Existing case/judgment/catalogue freezes and role separation are unchanged.

With `--semantic-index`, the evaluator uses a **pure precomputed-vector lookup**, never Ollama or any other model/runtime. The bundle is strictly bound to the case hash, catalogue hash, engine/query-projection version and selected arm; unknown `pass` fields, missing query coverage, mismatched identity, incomplete/stale catalogue embeddings and malformed vectors fail closed. The complete model/index-file hash is included in the evaluation-input digest. The configured 5,000 ms independent retrieval stage budget is explicitly recorded; it is a diagnostic budget, not the normal 1,000 ms realtime default. Query vectors are normalised and copied, and the source file is rehashed after evaluation. A failed semantic stage is an evaluation failure, not silently counted as a default-arm result.

The pure-lookup path can measure prepared corpus retrieval/ranking, not model inference latency. Benchmark the actual approved encoder separately on representative hardware. Prepared vectors and hashes remain private artifacts, not repository fixtures or generic proof that a model generated the declared vectors. The data holder must retain the trusted preparation/model provenance.

Only the independent data holder should run the frozen private evaluation. This implementation did not discover or inspect a blind corpus, generate replacement “blind” labels, expose private prompts, or weaken the separation of implementer/evaluator. The >=100-case broad-change gate remains. Model preparation is separate from the blind evaluator and must never be silently inserted into it. No private case preparation or blind evaluation was performed here; the integration tests use only explicitly synthetic contract cases.

## Versions, upgrade and rollback

The repaired default advances to `moodrank-v0.5.3`, features to `moodrank-v0.4-features-v5`, and fingerprint rules to `fingerprint-rules-v4`. The revised source-only ranking arm has the `+intent-ranking-v2-` mask; the review candidate is mask 59. Existing application callers still enable none of the ranking experiments, and do not inject local discovery.

Because cue morphology affects derived evidence, the #72 stopped-service **full feature/fingerprint refresh** applies again for v5/rules-v4. Follow [the correctness upgrade contract](MOODRANK_CORRECTNESS_UPGRADE.md); do not substitute the skip-fingerprint repair command. Preserve imported mood sources and historical profile/events/checkpoints. Old provider/local embeddings with a mismatched feature version or input hash are incompatible, not automatically regenerated. No schema change is introduced. Removing experimental injection restores the repaired default; rolling back the feature-rule upgrade requires the matching old derived-data snapshot or a verified regeneration under the matching code.

No deployment, merge, production backfill, model download, real inference, media request or paid-service activation is performed by this work. PR review is not permission to do any of these.

## Validation boundaries

Run `npm run verify`, `npm run eval:recommendations`, `npm run eval:moodrank-release-readiness`, `npm run eval:profile-journeys`, and `node --import tsx scripts/evaluate-ranking-ablations.ts` against the exact committed candidate. Existing golden expectations and limits remain unchanged except explicit engine/representation contract assertions. The fixed-eight negative control must continue to show its measured regression rather than being omitted to make the report look better.

`node --import tsx scripts/benchmark-ranking-candidate.ts` measures a fixed synthetic 750-record final-engine workload with alternating default/candidate runs and no model/learned profile. It is a local engineering diagnostic, not a real encoder benchmark, supported catalogue-size promise or production SLA. Exact executed results and final CI belong in the associated validation record.
