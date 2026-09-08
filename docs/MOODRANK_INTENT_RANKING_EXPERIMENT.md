# Shared viewing intent and ranking ablations

Status: **source-only experiments, disabled by default**. This is not release approval or a claim of improved recommendation quality.

## Scope and activation

The optional tenth `RecommendationEngine` constructor argument accepts `RankingExperiments`. The ninth argument remains the separate local semantic discovery experiment from PR #73. Existing callers pass neither. No HTTP field, environment flag, persisted setting, UI change, model replacement, dependency or automatic activation is added.

The five independent Boolean switches are `sharedIntent`, `normalizedFeedback`, `boundedPersonalization`, `experientialDiversity`, and `groundedExplanations`. The engine validates and snapshots them at request entry, rejecting unknown keys and non-Boolean values. Absent and all-false options preserve the default engine and results. Enabled bits, in this order, identify the engine as `moodrank-v0.5.2+intent-ranking-v1-<mask>`; the all-enabled mask is 31. This suffix composes with the independent semantic-discovery suffix rather than disguising one arm as another. Engine/session identity and count-only diagnostics identify the experiment.

Do not activate all switches together merely because the implementation passes unit tests. The visible-fixture ablation found regressions in shared intent and bounded personalisation; no arm is approved for promotion.

## Shared intent: state is not a viewing goal

`ViewingIntent` extends the existing brief with request-local current feelings, desired query, signed facets, explicit requested effect and ambiguity. A bounded first-person grammar recognises statements such as "I'm sad" or "we are feeling exhausted" without deciding how the user should cope. Desired uplift, calm or catharsis is inferred only from the explicitly supported request constructions. For example, "I'm sad, cheer me up" and "I'm sad, let me cry" produce different desired facets. A state alone leaves the desired experience unresolved.

Facet polarity distinguishes positive, avoided, reduced and conflicting evidence. A small explicit alias vocabulary prevents directly avoided romance/music/slow-burn qualities from returning through matching aliases or expanded vector tokens. Marked refinements use the existing occurrence matcher. Recognised reference-title roles are kept in the original reference metadata rather than becoming emotional cues. After state or title-role removal, ungrounded inherited enrichment is not treated as a new coping goal.

When enabled, the same positive projection feeds lexical retrieval, mood-index key filtering, token-vector input/filtering, independent local discovery, query/mood expansions and calibrated mood-term matching. An empty positive projection does not fall back to encoding the rejected raw query. The full original resolved hard filters remain authoritative. Existing negative guardrails receive the desired request with current-state spans removed, not the positive-only projection. UI overrides, availability/request truth, cancellation, user/session ownership and provider policies remain intact.

**Limits:** This is a deterministic bounded language implementation, not general natural-language understanding. The initial alias set, first-person grammar, reference-role masking, effect phrases and mixed/conflicting expressions are incomplete. Provenance is a source class, not a complete evidence-span model. Legacy hard-filter inference is intentionally not relaxed: for example, an existing genre exclusion inferred from "less horror" remains an exclusion even though the new soft facet records reduction. Numerous raw scorer/compound contextual rules and optional AI interpretation remain legacy paths. This is progress toward F2/I1, not universal signed-intent closure. Positive canonicalisation itself changes ranking and has observable regressions. Further changes must be independently evaluated, not prompt-specific production exceptions.

## Example feedback

`normalizedFeedback` deduplicates examples within and across positive classes, prefers the explicit preferred-example class over ordinary positive feedback, excludes contradictory positive/negative IDs from both sides, ignores references without stored feature evidence, and averages contributions within each class. Existing per-class similarity/type/self coefficients are retained. Repetition or more equally weak examples cannot, by count alone, saturate the score. Negative examples remain negative, not attracting neighbours.

This controls aggregation scale; it does not infer why an example was liked, learn new coefficients, repair all reference retrieval, or establish that mean aggregation is optimal. The existing visible quality case sets do not exercise multi-example aggregation, so unchanged ablation metrics are not effectiveness evidence for this switch.

## Total personalisation budget

`boundedPersonalization` computes a neutral counterfactual for each otherwise eligible candidate with learned broad preferences and feel-profile adjustments removed, but the same request, candidate evidence, default context prior and constraints. The complete deterministic learned effect is bounded to eight score points in either direction, including indirect query/mood/friction paths. It does not merely cap one nominal profile bucket, and never restores a disqualified candidate.

The trace retains original bucket contributions and adds `personalization_budget` with the neutral score and the exact correction. The trace evaluator independently checks the rounding/budget calculation, duplicate adjustments and reconstructed sum. Trace computation can be transient; it does not enable persistence.

Eight points is a predeclared experimental value, **not a calibrated optimum**. Visible synthetic profile evaluation drops at this budget; retain the existing default until a justified alternative passes the required evidence. The counterfactual requires an additional scoring pass and can materially increase CPU/latency. There is no production-scale resource claim. Context priors and session-example feedback are not reclassified as learned long-term profiles; the budget is not a bound on rank movement or provider reranking.

## Experiential diversity and explanations

`experientialDiversity` blends mood/tone/watchability overlap with existing structural similarity (0.7/0.3). Availability/shared-screen metadata does not masquerade as a different experience. Missing experiential data falls back to structural similarity rather than being rewarded as novelty. Existing protected prefixes and the 120-item diversity pool remain, and each promoted candidate must stay within eight score points of the best remaining candidate. No candidate or hard-filter relaxation is introduced. These blend values and the relevance guard are experimental engineering choices, not learned quality guarantees.

`groundedExplanations` selects the largest actual weighted eligible score contributions instead of the first generated reasons. It labels them as scoring signals, not causal effects or match probabilities, and uses truthful availability wording. Missing summaries produce an explicit uncertainty statement. It works with persistence off. It explains scoring components rather than claiming scene-level experiential evidence; the underlying feature/genre priors can still be wrong. Optional AI explanations remain controlled by the existing provider contract.

## Verification and visible ablations

New production-import tests exercise shared projections, original filters, actual final responses, trace privacy, budget reconstruction and tamper detection, non-vacuous uncapped-versus-capped profiles, feedback duplication/contradiction, empty-positive lexical input, and diversity relevance/prefix protection.

Run the diagnostic comparison explicitly on locked Node 24 dependencies:

```sh
node --import tsx scripts/evaluate-ranking-ablations.ts
```

The runner uses seven arms (default, each switch alone, combined), fresh in-memory fixture databases, no `loadConfig`, no disk catalogue, no encoder and no external service. It compares 17 existing golden and 40 adversarial prompts through actual final engine responses, plus 15 existing synthetic profile cases at the scorer stage. No golden judgments, thresholds, existing timeouts or leakage baselines are changed. It reports failed expectations; successful script completion means the diagnostic ran, **not that an arm passed promotion**. The same exposed cases cannot become blind evidence later.

The ablation baseline is repaired v0.5.2, not the historical v0.3 reference in `eval:recommendations`. The new final-engine adversarial measurement is different from the existing scorer-stage release gate. In particular, baseline final responses already miss two of those 40 expectations. Keep these measurement stages separate.

## Operational and release boundary

This PR changes no stored feature, fingerprint, schema, model or learned-profile version. The underlying PR #72 full feature/fingerprint refresh requirement still applies to that upgrade. No live refresh, deployment, request creation or merge is performed here. Remove source-level experiment injection to restore the repaired default; no experiment-specific database rollback is needed.

Before any activation: resolve observed regressions, test richer compositional/refinement/identity and profile-conflict cases, establish representative resource limits, and obtain the repository's independent broad-change evaluation (at least 100 complete frozen blind cases with predeclared gates). A real approved offline encoder and prepared corpus are still required for PR #73. Nothing in this PR supplies or approves them. Broader genre/certification inference, arbitrary natural-language semantics and calibrated ranking remain open engineering work.
