# Mood/Feel Robustness V1 Goal

Status: implemented for Robustness V1.
Last updated: 2026-06-17.

## Objective

Build Mood/Feel Robustness V1: adversarial evaluation, feedback reliability, profile confidence, and replay-ready learning logs, so Moodarr can safely learn from early usage without overfitting weak or ambiguous signals.

This goal incorporates the GPT Pro review saved in [2026-06-17 GPT Pro Mood/Feel Review Source](research/2026-06-17-gpt-pro-mood-feel-review-source.md) and assessed in [2026-06-17 GPT Pro Mood/Feel Review Assessment](research/2026-06-17-gpt-pro-mood-feel-review-assessment.md).

Current implementation progress is tracked in [2026-06-17 Mood/Feel Robustness V1 Progress](research/2026-06-17-mood-feel-robustness-v1-progress.md).

## Why This Is Next

The current Mood/Feel Profile system proves the core machinery:

- profile terms can shift the same prompt toward different personal meanings;
- feedback events can update persistent term weights;
- profile scoring is bounded and visible;
- synthetic profile evals show personalization lift without breaking the golden baseline.

The next risk is not whether the profile layer can move ranks. It is whether it can learn safely from real, noisy, ambiguous interactions. Before usage grows, Moodarr needs stronger evals and safer learning gates.

## Non-Goals

- No mobile iOS app work.
- No full contextual bandit.
- No collaborative filtering core.
- No foundation-model training or fine-tuning.
- No long onboarding quiz.
- No durable raw-prompt logging by default.
- No broad UI redesign beyond small controls needed to capture reliable feedback.

## What Success Looks Like

Moodarr is ready for early local usage when:

- adversarial evals expose failures by category, not only aggregate `NDCG@3`;
- hard constraints and availability/requestability stay invariant under adversarial prompts;
- weak actions such as `open`, `expand`, impressions, and skips cannot train term profiles;
- every profile update records action reliability, evidence, and profile version;
- profile effects scale with evidence quality and confidence;
- sparse metadata lowers certainty without automatically excluding relevant long-tail titles;
- profile changes can be replayed against prior slates and held-out feedback;
- the user can export and reset profile learning by term/context/all;
- raw prompt logging remains opt-in, local, and time-limited if it is added later.

## Delivery Slices

### Slice 1: Adversarial Eval Corpus And Failure Taxonomy

Status: implemented as the initial 30-case suite; current suite passes.

Build the eval harness needed to see fragility before changing more learning logic.

Deliver:

- adversarial cases for negation, compound terms, comparative language, contradictory hard/soft constraints, availability, requestability, context bleed, sparse metadata, title leakage, and diversity masking;
- synthetic sparse and long-tail titles in the profile eval catalog;
- new failure classes such as `negation_miss`, `comparative_miss`, `compound_term_miss`, `sparse_feature_miss`, `context_profile_miss`, `profile_overfit`, and `availability_override`;
- eval output grouped by failure class and term;
- parser-focused tests for high-risk language.

Acceptance:

- at least 30 high-signal adversarial cases initially, with a path to 50+; current: 30;
- hard-filter and availability accuracy remain `1.0`; current: `1.0` on the golden suite and 30/30 adversarial cases;
- eval output identifies failure category, query, expected behavior, and top offending titles;
- no existing golden recommendation or profile stress test regresses.

Current gate: P0 adversarial cases are release-blocking. P1/P2 cases report broader robustness coverage and currently pass, but future P1/P2 additions remain non-gating by policy.

Likely files:

- `src/server/recommendation/evaluation.ts`
- `src/server/recommendation/profileEvalFixtures.ts`
- `scripts/evaluate-recommendations.ts`
- `tests/recommendation.test.ts`
- `docs/MOODRANK_CURRENT_ALGORITHMS.md`

### Slice 2: Parser And Constraint Hardening

Fix the highest-risk language classes surfaced by Slice 1.

Status: implemented for the initial 30-case adversarial suite.

Deliver:

- deterministic handling for "dark comedy, not horror";
- phrase handling for "not too dark", "not cute", "not sentimental", "not surreal", "less bleak", and "more grounded";
- hard/soft conflict handling for impossible runtime or availability requests;
- separation between aesthetic phrases such as "dark academia" and threat/intensity mood terms where feasible.

Acceptance:

- parser tests pass for all P0 adversarial prompts;
- hard constraints always win over soft mood words;
- impossible or contradictory constraints are either resolved deterministically or reported as conflicts;
- parser changes do not make generic golden prompts worse.

Current eval snapshot: P0 adversarial gate `1.0`; overall adversarial pass rate `1.0`; P1 pass rate 15/15; P2 pass rate 8/8.

Likely files:

- `src/server/recommendation/intent.ts`
- `src/server/recommendation/brief.ts`
- `src/server/recommendation/scoring.ts`
- `tests/recommendation.test.ts`

### Slice 3: Feedback Reliability And Reason Chips

Make learning depend on event quality rather than action names alone.

Status: implemented for the initial reliability and reason-chip layer.

Deliver:

- explicit reliability class for each feedback action: high, medium, weak, diagnostic-only;
- no term-profile updates from weak or diagnostic-only actions;
- per-session update caps for term profiles;
- negative reason chips such as `too_scary`, `too_bleak`, `too_slow`, `too_silly`, `too_cute`, `too_sentimental`, `wrong_kind_of_weird`, and `not_available_enough`;
- tests that simulated opens/expands/impressions do not move term weights;
- tests that high-confidence right/wrong mood and pairwise events move expected feature dimensions.

Acceptance:

- every stored feel feedback event has action reliability;
- profile update code uses reliability and reason, not only action name;
- request actions do not directly teach mood term meaning unless paired with stronger mood evidence;
- raw prompt text is not stored.

Current state:

- `feel_feedback_events` stores `reliability`;
- `feel_feedback_events` stores `profile_version` and `profile_update_applied`;
- `recommendation_sessions` stores the active `profile_id` and `profile_version`;
- `feel_profile_terms` stores the current term version;
- `open`, `expand`, `swipe_skip`, and `request_preview` are diagnostic-only;
- `request_create` is weak and can update broad preference but not term-profile learning;
- medium/high reliability actions can train term profiles;
- `too_scary` and related reason chips add targeted feature deltas;
- term-profile updates are capped at three applied updates per recommendation session and mood term;
- tests cover weak/diagnostic no-profile-learning, high-reliability reason-chip learning, and the per-session term update cap.

Likely files:

- `src/shared/types.ts`
- `src/server/db/database.ts`
- `src/server/db/mediaRepository.ts`
- `src/server/recommendation/feelProfile.ts`
- `src/server/app.ts`
- `src/client/App.tsx`
- `tests/app.test.ts`

### Slice 4: Profile Confidence And Evidence-Conditioned Delta

Make profile influence grow only when the evidence deserves it.

Status: implemented for the initial confidence and conflict-scaling layer.

Deliver:

- effective evidence count per term/context;
- reliability-weighted positive and negative evidence;
- conflict score for mixed recent feedback;
- evidence-conditioned profile score cap;
- low-confidence terms stay close to the generic baseline;
- consistent high-reliability feedback can move close candidates more strongly;
- confidence shown in diagnostics.

Acceptance:

- cold-start profile deltas are small;
- 3-5 consistent high-reliability events increase profile effect;
- conflicting feedback shrinks effective confidence or caps the delta;
- profile score remains bounded and cannot override hard filters or availability gates;
- synthetic cold-start and conflict tests pass.

Current state:

- `feel_profile_terms` stores reliability-weighted positive and negative evidence.
- `feel_profile_terms` stores effective evidence and conflict score.
- profile confidence is derived from effective evidence rather than raw event count.
- profile adjustment weights are scaled by confidence, effective evidence, and conflict.
- high-reliability actions train more strongly than medium-reliability actions.
- pairwise picks count as positive evidence with contrastive feature deltas rather than contradictory sentiment.
- tests cover cold-start vs high-evidence scaling and conflict shrinkage.

Likely files:

- `src/server/recommendation/feelProfile.ts`
- `src/server/recommendation/scoring.ts`
- `src/server/db/database.ts`
- `src/server/db/mediaRepository.ts`
- `src/shared/types.ts`
- `tests/recommendation.test.ts`
- `tests/app.test.ts`

### Slice 5: Replay-Ready Logging, Holdout, Export, And Reset

Status: implemented for Robustness V1.

Add the data shape needed to measure whether learning helped.

Deliver:

- displayed slate logging with candidate IDs, ranks, score buckets, engine version, feature version, and profile version;
- profile version/checkpoint ID on feedback events;
- local holdout flag for a small share of high-confidence feedback;
- replay evaluation that can compare profile version `t` vs `t+1`;
- profile export JSON;
- reset all learning, reset context, and reset term behavior remains safe and tested;
- profile checkpoint timeline in admin diagnostics.

Acceptance:

- replay eval can run without raw prompts;
- profile export contains no secrets or private Plex/Seerr URLs;
- reset removes or invalidates relevant learned weights and checkpoints safely;
- storage growth is bounded by retention/compaction rules.

Current state:

- `recommendation_results` stores displayed candidate IDs, rank, score, score buckets, availability group, and feature version.
- recommendation sessions store engine version and profile version used for the slate.
- feedback events store profile version, applied-update flag, and holdout flag.
- applied profile updates write term checkpoints keyed by profile version.
- every tenth eligible medium/high reliability mood-term event is held out from term-profile training for future replay checks.
- `/api/admin/feel-profiles/export` returns local profile/export JSON without raw prompts or private Plex/Seerr URLs.
- `DELETE /api/admin/feel-profiles` can reset one term/context, one context, one term across contexts, or all learned profile terms and matching checkpoints.
- `npm run eval:profile-replay` compares held-out events against the next profile checkpoint without raw prompts.
- admin diagnostics expose recent checkpoint timeline entries and replay storage/retention counts.
- replay storage is compacted by age and count using bounded default retention policy.
- tests cover feature-version slate rows, export privacy shape, reset-all behavior, checkpoint deletion, holdout behavior, replay comparison, timeline diagnostics, and retention compaction.

Likely files:

- `src/server/db/database.ts`
- `src/server/db/mediaRepository.ts`
- `src/server/recommendation/evaluation.ts`
- `src/server/recommendation/engine.ts`
- `src/server/app.ts`
- `src/shared/types.ts`
- `tests/app.test.ts`

## Metrics

Keep current baseline metrics:

- `preRerankRecall`
- `top10Recall`
- `top3HitRate`
- `MRR`
- `NDCG@3`
- hard constraint accuracy
- availability accuracy
- `PersonalizationLift@3`
- generic vs personalized profile `NDCG@3`

Add Robustness V1 metrics:

- adversarial pass rate by failure class;
- parser confusion/failure count;
- term-specific lift;
- wrong-mood suppression;
- context isolation score;
- sparse-feature pass rate;
- action reliability update counts;
- held-out replay lift;
- profile confidence calibration buckets;
- profile delta effect size.

## Recommended Execution Order

1. Slice 1: adversarial eval corpus and failure taxonomy.
2. Slice 2: parser and constraint hardening for failures found in Slice 1.
3. Slice 3: feedback reliability and reason chips.
4. Slice 4: confidence-aware profile deltas.
5. Slice 5: replay-ready logging, holdout, export, and reset.

This order matters. Stronger learning before stronger evals risks making the system confidently wrong.

## Out-Of-Scope But Parked

| Lane | Resume Condition |
| --- | --- |
| Pairwise local learner | Pairwise eval harness and reliable pairwise event logging exist. |
| Bandit-lite calibration | Confidence-aware profile deltas and replay logging exist. |
| Drift detector | Profile checkpoint timeline and simulated drift evals exist. |
| Term-neighbor embeddings | Term-specific residuals are stable and cold-start eval shows a gap. |
| User-facing profile UI | Backend confidence, export, reset, and timeline are reliable. |
| iOS swipe UX | Shared feedback semantics and reliability classes are stable. |

## First Task To Start

Start with Slice 1.

Implement an adversarial eval corpus and failure taxonomy that can fail loudly before real usage. Do not change profile learning until the eval can show whether the learning change helps or harms.
