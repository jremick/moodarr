# GPT Pro Mood/Feel Review Assessment

Status: incorporated into planning.
Source: [2026-06-17 GPT Pro Mood/Feel Review Source](2026-06-17-gpt-pro-mood-feel-review-source.md)
Last updated: 2026-06-17.

## Decision Summary

The GPT Pro review validates the core direction: Moodarr should remain a local-first, catalog-grounded mood-language calibration system, not a generic LLM recommender or large collaborative recommender.

The most important change is priority. The next major goal should be robustness before usage: adversarial evals, action reliability, feature confidence/provenance, replay/holdout logging, and confidence-aware profile deltas.

We should not move first into mobile swipe UI, full contextual bandits, collaborative filtering, foundation-model training, or broad product polish. Those depend on better evidence capture and stronger evals.

## Assessment Matrix

| GPT Pro point | Disposition | Rationale | Moodarr action |
| --- | --- | --- | --- |
| Treat MoodRank as a calibrated interpretation system, not a normal recommender. | Accept | This matches the north star and is more precise than "recommend good films." | Keep "Mood/Feel Translation Engine" framing in all planning docs. |
| Keep staged candidate generation, scoring, reranking architecture. | Accept | This is already the correct skeleton and aligns with current implementation. | Preserve staged architecture and benchmark each stage separately. |
| Baseline Feel Space is a prior, not truth. | Accept | Current deterministic features can look more precise than they are. | Add feature provenance, sparse-metadata confidence, and confidence-aware scoring. |
| Synthetic evals are too aligned with implementation. | Accept | Current profile cases prove machinery, not real mood satisfaction. | Expand adversarial evals, add parser cases, sparse metadata cases, pairwise cases, and failure classes. |
| Add confidence-aware profile learning. | Accept | Current profile confidence is evidence-count based but the scoring delta is not sufficiently reliability-conditioned. | Make profile effect scale by evidence quality, evidence count, conflict, and context match. |
| Use evidence-conditioned profile bounds. | Accept | One static bound is safer than an unbounded profile, but still too blunt. | Replace fixed profile delta with an evidence/reliability-conditioned cap. |
| Add action reliability classes. | Accept | Current code is conservative, but reliability is implicit rather than first-class. | Add explicit reliability classification for feedback actions and tests proving weak actions do not train term profiles. |
| No term-profile training from `open` or `expand`. | Accept, already aligned | Current implementation stores weak actions for diagnostics but does not use them for profile updates. | Keep this invariant and encode it in tests/docs. |
| Be careful with `save`, `request_preview`, and `request_create`. | Adapt | Current action list treats request actions as positive in diagnostics; durable learning should distinguish watch intent from mood fit. | Keep request actions diagnostic or broad-preference only unless paired with right-mood/selection evidence. |
| Add reason chips for semantic negative feedback. | Accept | "Wrong mood" is useful; "too scary" or "too bleak" is far more actionable. | Add reason taxonomy and map chips to feature deltas conservatively. |
| Add pairwise feedback and pairwise evals. | Accept | Pairwise choices directly reveal boundaries between adjacent meanings. | Add pairwise eval harness before local pairwise learner. |
| Add a pairwise term-conditioned learner. | Defer | Valuable, but it depends on pairwise events, replay logging, and eval coverage. | Plan after adversarial evals and reliability logging exist. |
| Add bandit-lite active calibration. | Defer | Useful for low-confidence terms, but exploration without logging/replay can harm UX and eval validity. | Add after slate logging and confidence-aware profile deltas. |
| Add full contextual bandits. | Reject for now | Premature and not justified by a local single-user cold-start data regime. | Do not implement until enough local interaction data and propensity logging exist. |
| Use term embeddings as expansion, not core ranking. | Defer | Sensible for cold start, but can blur distinct private meanings. | Consider after term-specific residuals and confidence are stable. |
| Add feature provenance and confidence. | Accept | Needed to avoid false precision and sparse metadata bias. | Store feature source/confidence by mood/tone/watchability feature and include sparse-feature handling in evals. |
| Add sparse metadata stress tests. | Accept | Long-tail titles can be penalized because the system has less text, not because they are worse. | Add synthetic sparse titles and separate sparse-feature failure classification. |
| Add parser hardening for negation, comparative phrases, and compound terms. | Accept | "Dark comedy, not horror" and "not too dark" are high-risk prompt classes. | Add parser tests and new failure types before more learning logic. |
| Add contradiction handling for hard/soft conflicts. | Accept | Hard constraints must win and impossible requests should be surfaced clearly. | Add evals for runtime/availability contradictions and update parser behavior as needed. |
| Add availability/requestability invariants. | Accept | Product trust depends on this, and AI must never override catalog state. | Add adversarial availability cases and preserve existing deterministic gates. |
| Add slate/rank/score bucket/profile version logging. | Accept | Required for replay, rank-bias analysis, and action interpretation. | Extend recommendation session/feedback records with displayed slate and profile version. |
| Add shadow holdout and replay infrastructure. | Accept | Needed to know whether learning would have improved later choices. | Add local holdout flag for high-confidence feedback and replay profile checkpoints. |
| Store raw prompts only opt-in and time-limited. | Accept with stricter default | GPT Pro suggests optional 7-14 day debug retention. We should keep raw prompts off by default and require explicit local debug opt-in. | Keep durable storage on normalized intent, terms, filters, slate, and profile version. Add opt-in debug only later. |
| Add profile export/reset/timeline. | Accept | Reset already exists; export/timeline/checkpoints are missing. | Add profile export, scoped reset, and checkpoint history after logging schema is in place. |
| Add per-term confidence UI. | Accept later | Useful, but backend confidence/replay must be reliable first. | Add admin diagnostics first, then a user-facing profile view. |
| Add drift detection. | Defer | Important after real or simulated longitudinal data exists. | Add simulated drift evals now; implement detector after profile checkpointing exists. |
| Add richer personas. | Accept | Current synthetic profiles are too narrow. | Expand personas into eval fixtures with noisy behaviors and held-out sessions. |
| Add at least 50 adversarial cases. | Accept as direction | The exact number is less important than coverage and failure labels. | Target 50+ cases across negation, comparison, sparse metadata, context, availability, and drift. |
| Use MovieLens Tag Genome style item relevance. | Accept with provenance caution | Useful as a baseline seed, but item tag relevance is not user term meaning. | Keep import path optional, source-versioned, and separate from user profile deltas. |
| Use NRC VAD as weak prior. | Defer | Useful but not required before parser/eval/reliability hardening. | Consider as a feature seed after provenance/confidence storage exists. |
| Use Spotify Taste Profile as product precedent. | Accept | User-visible interpretation and reset controls are aligned with the product. | Use as inspiration for profile inspection, not as an absolute control model. |
| Treat iOS swipes as useful but dangerous. | Accept | The user already scoped mobile as secondary. Swipes are noisy unless undo/reason/pairwise context exists. | Keep mobile out of the next major goal; design shared event semantics so mobile can reuse them later. |
| Do not pivot to generic LLM recommender, collaborative filtering core, foundation model, or onboarding quiz. | Accept | These are either contrary to the product thesis or premature for available data. | Keep local deterministic/profile architecture as the core. |

## Plan Changes Required

### Add To Current Approach

1. Reliability class for every feedback action.
2. Feature provenance and confidence for baseline Feel Space features.
3. Adversarial eval corpus with failure classes.
4. Parser hardening for negation, compound phrases, comparative language, and hard/soft conflicts.
5. Slate/rank/score/profile-version logging for replay and rank-bias analysis.
6. Local holdout strategy for high-confidence feedback.
7. Evidence-conditioned profile delta instead of a fixed profile effect.
8. Profile checkpoint/export/timeline design.
9. Richer synthetic personas with noisy interaction patterns and held-out sessions.

### Keep As Is

1. Catalog facts remain deterministic from Plex/Seerr.
2. AI remains constrained to known candidates and cannot create catalog truth.
3. Broad preferences and term-specific profiles remain separate.
4. Weak actions remain diagnostic by default.
5. Solo and group contexts remain separate profile scopes.
6. Raw prompt storage remains off by default.

### Defer

1. Pairwise local learner until pairwise eval/logging exists.
2. Bandit-lite active calibration until confidence/replay logging exists.
3. Term-neighbor embeddings until term residuals are stable.
4. Drift detector until profile checkpointing and simulated drift evals exist.
5. User-facing confidence UI until backend confidence is reliable.
6. iOS swipe UX until shared feedback semantics and evals are stronger.

### Reject For Now

1. Full contextual bandits as an immediate implementation.
2. Collaborative filtering as the core system.
3. Foundation-model training/fine-tuning.
4. Broad raw-prompt telemetry.
5. Long onboarding quizzes.

## Specific Corrections To GPT Pro Recommendations

### "Watched-and-matched" as high-confidence signal

This is directionally useful, but Moodarr does not yet have reliable watch-completion or playback-outcome data. We should not include it as a high-confidence training signal until the source is available and distinguishable from background playback or household viewing.

Moodarr action: keep as future optional signal; do not plan it in the next major goal.

### Request actions as positive training evidence

Request creation is a strong intent signal, but it is confounded by novelty and availability. It should not directly teach term meaning unless paired with `right_mood`, pairwise selection, or later successful watch feedback.

Moodarr action: keep request actions as diagnostics or broad preference signals by default.

### Full Bayesian model wording

The recommendation is correct in spirit, but a full probabilistic model may be heavier than necessary. The immediate implementation can be an evidence-conditioned residual model with explicit reliability weights, effective evidence, conflict score, and confidence caps.

Moodarr action: implement confidence-aware residuals first; revisit Bayesian variance once evals show the need.

### 50 adversarial cases as a hard requirement

The target is useful, but quality and coverage matter more than the exact count. A smaller high-signal suite is better than 50 shallow fixtures.

Moodarr action: target 50+ eventually; next goal should land the schema, failure taxonomy, and first broad batch.

## Revised Priority Order

1. Make failures visible: adversarial evals and parser/availability failure classes.
2. Make feedback safe: explicit reliability classes and reason chips.
3. Make learning measurable: slate/profile-version logging and local holdout/replay.
4. Make profile effects confidence-aware: evidence/reliability-conditioned deltas.
5. Make profile state user-controllable: export, reset, timeline, and later UI.
6. Add smarter learning only after the above: pairwise learner, drift detector, bandit-lite calibration.

## Next Major Goal

The next major goal should be:

> Build Mood/Feel Robustness V1: adversarial evaluation, feedback reliability, profile confidence, and replay-ready learning logs, so Moodarr can safely learn from early usage without overfitting weak or ambiguous signals.

This goal supersedes a UI-first or mobile-first next step.
