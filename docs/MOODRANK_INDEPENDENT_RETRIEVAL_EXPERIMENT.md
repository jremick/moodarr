# Independent local semantic discovery experiment

Status: implementation for controlled offline evaluation; **disabled by default** and not a supported product activation or quality claim.

## Problem and experimental boundary

The default retrieval path chooses at most 3,000 IDs before local token-vector and optional provider-embedding scoring. Within-pool scoring cannot discover an excluded ID. This experiment adds query-to-corpus and positive-example-to-corpus discovery before the final candidate cap. It does not silently replace the local token-frequency vector or call it a dense embedding.

A separate, optional ninth `RecommendationEngine` constructor argument injects `IndependentRetrievalExperiment`. `RetrievalOptions.independentRetrieval` exposes the same seam for stage-level evaluations. No HTTP request field, persisted setting, default model, environment flag or production wiring enables it. Existing callers and official compiled provider restrictions remain unchanged.

The source-only constructor seam is deliberately not a claim of a deployable semantic model. No approved model asset or real embedding corpus was supplied. The repository adds neither model weights, a downloader, a hosted service nor an implementation that transmits queries externally. A real evaluator must explicitly supply an approved offline `LocalQueryEncoder` and a matching prepared index. Mechanical tests use labelled **synthetic vectors**, which prove wiring, not semantic understanding.

## Model and index lifecycle

`ExactLocalSemanticIndex` is a correctness-reference exact search over explicitly supplied `LocalSemanticSnapshot` data. Its identity declares model, immutable model revision, text-preprocessing version, feature version and dimensionality. Entries contain only a catalogue item ID, the SHA-256 of the current feature text, and a finite nonzero vector.

Construction/whole-snapshot replacement validates the complete next snapshot before swapping. Duplicated IDs, invalid hashes, incompatible shapes, non-finite or zero vectors, and resource-limit violations fail. Input and exported arrays are copied. Searches pin one immutable snapshot across cooperative yields, so concurrent replacement cannot mix models. Deletion is represented by leaving the removed document out of the explicit replacement; there is no request-time backfill or automatic corpus discovery. Operator-supplied JSON can be loaded outside the request path and passed to the validating constructor; no new database schema or automatic filesystem path is introduced.

The reference implementation admits at most 50,000 records, 4,096 dimensions, and 4,000,000 stored scalar values. Those are engineering containment limits, not supported-scale or memory benchmarks; object overhead is additional. Exact scans yield every 256 records and observe cancellation. Choosing an ANN index or real model/runtime requires separate measured licensing, platform, offline-operation, CPU/memory and latency evidence.

## Retrieval and eligibility

The experiment keeps query and positive-example hit lists separate. Directly negated/reduced soft facets, excluded genre names and reference-title identity tokens do not become its positive query text. Negative examples never supply an attracting example vector. This projection is bounded and conservative; it is **not a complete shared intent parser** and does not fix the default lexical/vector/scorer interpretations.

References resolve independently of result eligibility, allowing an unavailable example to find available neighbours. Both model identity and each reference's current feature/input hash must match. The result channels scan the independent corpus, not the existing selected IDs. Query and example lists each retain at most 512 hits. Candidate admission rechecks actual catalogue existence, current feature version and input hash, hidden IDs, negative-reference IDs, and the same operational/hard-filter eligibility predicate used by deterministic scoring. Downstream semantic guardrails remain active after admission and can still reject a candidate.

Up to 128 admitted independent IDs are fused using deterministic round-robin ranks with deduplication and reusable unused capacity. They receive protected space after the existing lexical prefix but before catalogue/popularity filling. The overall existing 1,000–3,000 candidate cap is unchanged. The experiment uses the maximum compatible query/example cosine in the existing semantic utility bucket and light rank prior; it does not add unlike raw scores or claim this calibration is optimal.

Over-retrieval is bounded. A restrictive filter or stale index can consume the 512-hit windows; the diagnostic `truncated` flag makes that limit visible but does not estimate unknown true recall. There is no automatic hard-filter relaxation. A selective ANN/filter-aware implementation and adaptive expansion remain separate experiments.

## Failure, privacy and reproducibility

The default experimental stage budget is 1,000 ms, explicitly configurable only from 1 to 5,000 ms. A deadline race handles an asynchronously uncooperative encoder; synchronous native inference cannot be preempted by a JavaScript timer and still requires an approved bounded runtime. Encoder/index failure, timeout, incompatible identity, absent encoder and empty positive intent have explicit status codes and preserve the default deterministic path. Caller cancellation propagates rather than becoming a silent fallback. Late completions cannot persist embeddings because this path has no writes.

Diagnostics include counts/status only, not raw prompts, model paths, vectors, unsafe exception text or reference names. The response and persisted session/trace engine identity adds `+local-semantic-discovery-v1`. Opt-in candidate provenance distinguishes `semantic_independent_local` from token-vector similarity and provider embeddings. Tracing remains optional and off by default; this experiment does not enable raw-query persistence. Existing explicit privacy and user/session ownership policies still apply.

## Required evaluation and promotion

The tests import real production modules and include a real 3,005-record disposable catalogue whose target is outside the legacy 3,000-ID window but admitted by independent discovery. Other tests cover final engine ordering, hidden results, hard filters, stale/missing rows, negative examples, an ineligible reference, finite-vector validation, deletion/replacement, snapshot pinning, cancellation, timeout, capacity and trace privacy.

These are developer regressions. Real semantic effectiveness, broader catalogue recall, resource budgets, final NDCG and user satisfaction are **unmeasured**. Do not use these exposed prompts or synthetic vectors as blind evidence. Keep this arm disabled until approved local model resources and the existing frozen independent evaluation protocol are available, including at least 100 complete cases for broad retrieval changes and predeclared quality/latency gates. Compare the repaired default, independent discovery alone, and any later scorer/reranker changes as separate arms.

The experiment adds no dependencies and changes no feature/schema/profile versions. Existing PR #72 feature-refresh requirements still apply to the underlying repaired baseline. Removing the injected experiment restores default retrieval; no experiment-owned data migration or rollback is needed. It does not solve current-feeling versus desired-experience modelling, full signed-intent propagation, profile-budget calibration, experience-based diversity or fully grounded explanations.
