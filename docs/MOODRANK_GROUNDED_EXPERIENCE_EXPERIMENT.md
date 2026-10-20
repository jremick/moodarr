# Grounded experience comparison experiment

Prepared: 2026-09-27.
Baseline: `e923d72a52c3f0827fca6ea8a4b9805555bd362c`.
Status: source/evaluation-only building block; not integrated into production ranking.

## Scope

`src/server/recommendation/groundedExperience.ts` adds a compact projection and comparison API over the structural evidence fields of `ContentFingerprintV1`. It supplies an evidence-aware diversity candidate and an explicitly selected reference-aspect comparison. It does not change existing features, stored fingerprints, scoring, query parsing, retrieval, presentation, provider configuration, or production defaults.

The earlier lexical-ordering, rank-index midrank, and normalized-example-feedback patch series is separate. None of those patches is included here.

## Evidence and comparison contract

- Summary-backed terms retain the lesser of their declared term/source confidence. Genre-only terms have an experimental confidence cap of 0.25. Animation alone supports only a weak style/format prior, not gentleness or viewing suitability.
- Title, ratings, runtime, people, availability, and derived `catalogFact` terms are not accepted as emotional-experience evidence. Operational watchability tags are excluded. Existing terms with only such provenance therefore become unknown in this projection.
- Duplicate evidence IDs and term keys cannot add repeated weight. Conflicting duplicate evidence identities are discarded independent of input order. Numeric scores and confidences must be finite and in range.
- Similarity compares requested dimensions observed on both sides. Missing evidence returns `similarity: null` rather than a fabricated zero. Coverage and confidence are reported separately.
- Each dimension receives an equal budget. Shared keys use the weaker term confidence on both sides; unmatched keys use their own confidence. Confidence-weighted intersection/union gives weak extra tags less influence without making identical tags appear different solely because their confidence differs.
- Dimension confidence is reliable union mass divided by unweighted union mass. A single strong tag cannot upgrade unrelated weak tags. Comparisons are symmetric and input ordering is deterministic.
- Diversity blending is bounded by `0.7 * confidence * coverage` and preserves the supplied structural fallback when experience evidence is unknown. Both 0.7 and the genre cap are uncalibrated experimental parameters, not measured optimal values.
- Reference-aspect comparison accepts explicit dimensions, for example `pacing`; unrelated matching moods cannot compensate for a pacing mismatch. Natural-language aspect extraction and production reference resolution are not implemented here.

## Trust and safety boundaries

The module consumes typed, already-decoded inputs and trusts declared provenance; it is not an arbitrary-JSON validator or a semantic-entailment verifier. It does not prove that a summary actually supports a declared term, check fingerprint freshness, infer safety from missing cues, or resolve semantic opposites beyond key overlap. Callers must preserve the existing fingerprint freshness, eligibility, explicit exclusion, and operational truth checks. Negative cues are omitted from positive similarity, not from the application's safety constraints.

## Validation actually performed

The two added Vitest-format test files contain 52 expanded test cases. Their unchanged test bodies passed in an isolated synchronous Node assertion adapter against the exact source bytes. One test includes 100 deterministic generated cases for bounds and symmetry; those iterations are not counted as 100 additional tests.

The source module also passed a standalone semantic typecheck:

```sh
tsc --strict --target ES2022 --lib ES2023 --module commonjs --noEmit src/server/recommendation/groundedExperience.ts
```

Runtime: Node 22.16.0; TypeScript 5.8.3. This was **not a Vitest run**, not the supported Node 24 release runtime, and not a locked-dependency project-wide typecheck. The test adapter substitutes only the test API; the source module has no runtime imports to mock. No full repository suite, release verification, catalogue benchmark, or independent relevance evaluation was run locally.

Validated Git blob identities:

| File | Blob SHA-1 |
| --- | --- |
| `src/server/recommendation/groundedExperience.ts` | `c83c0ce7cc8fae8c6877c2d0c6df527d0b105f4d` |
| `tests/groundedExperience.test.ts` | `ab3df827c9abd72667fc7d3ec8a7f15a58ff7b2d` |
| `tests/groundedExperienceConfidence.test.ts` | `89302842a9ab169dcd657874187cc7e0be684a7b` |

## Remaining implementation and activation gates

1. Run the real focused Vitest files, project typecheck/lint, `npm run verify:release`, and `npm run eval:profile-journeys` on the supported Node 24 runtime with locked dependencies. Do not weaken existing tests or evaluation thresholds.
2. Add integration tests using production-built fingerprints, including sparse metadata, negated summary cues, derived-only provenance, mature animation, and stale feature versions. Check the current producer's evidence quality before relying on these projections.
3. Wire precomputed projections into an explicit source-only ablation path. Preserve the relevance floor and precision-protected head; avoid rebuilding full fingerprints inside pairwise hot loops. Keep experience similarity distinct from operational availability diversity.
4. Integrate explicit reference resolution and requested-aspect parsing with the authoritative shared intent. Preserve hard filters and missing-evidence behavior. This helper does not independently retrieve reference neighbors.
5. Evaluate retrieval recall, final relevance, diversity, latency, and explanation faithfulness separately against a frozen baseline and independently judged cases. Broad/default promotion must satisfy the repository's evaluation protocol. Keep production defaults unchanged until those gates pass.

Independent full-catalogue semantic discovery, learned ranking calibration, shared-intent/default promotion, and production explanation changes remain separate unfinished work. This experiment makes no measured recommendation-quality improvement claim.
