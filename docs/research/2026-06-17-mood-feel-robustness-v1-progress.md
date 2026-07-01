# Mood/Feel Robustness V1 Progress

Status: implementation progress log.
Last updated: 2026-06-17.

## Summary

Mood/Feel Robustness V1 has started with the failure visibility layer the GPT Pro review recommended: adversarial cases, failure classes, parser hardening, and targeted deterministic scoring fixes.

The current implementation gates P0 adversarial cases as release-blocking and reports P1/P2 cases as broader robustness coverage. The initial 30-case suite is now fully passing after parser/scoring hardening and after converting a few exact-title assertions into behavioral assertions that match their failure-class rationale.

## Implemented

- Added a 30-case adversarial recommendation suite with P0/P1/P2 priorities.
- Added adversarial failure classes for negation, comparative language, compound terms, sparse metadata, context bleed, title leakage, availability override, diversity masking, and constraints.
- Added synthetic adversarial fixtures for cozy-not-cute, dark-comedy-not-horror, long-tail sci-fi, sparse metadata, title leakage, and Seerr availability states.
- Added adversarial eval reporting to `npm run eval:recommendations`.
- Added P0 gating in tests: all P0 adversarial cases must pass; P1/P2 failures are reported for follow-up.
- Hardened deterministic parsing for broad negated genres, `less horror`, `not too dark`, requestable-only intent, Plex-only intent, and available-now-with-requestable-fallback phrasing.
- Hardened runtime constraints so explicit runtime filters reject unknown runtime rather than silently allowing it.
- Added deterministic phrase scoring for excluded feel terms, local negated metadata such as `no gore` and `instead of horror`, dark comedy, dark academia, low-friction/light requests, grounded-less-horror direction, no-jokes direction, romance, and unsentimental cozy prompts.
- Added deterministic phrase scoring for gentle/quiet sci-fi, sparse-but-compatible metadata, low-commitment/no-cliffhanger, group weird, visual darkness without horror, and non-nostalgic comfort prompts.
- Added a diversity guard so explicit negation/comparison/availability/runtime prompts preserve more of the score-ranked head before diversity pressure is applied.
- Tightened adversarial cases that were overfitted to one synthetic title so they assert the intended behavior instead of an arbitrary exact rank.
- Added feedback reliability classes: `high`, `medium`, `weak`, and `diagnostic`.
- Added database migration `008_feel_feedback_reliability` so every feel feedback event stores action reliability.
- Gated term-profile learning to medium/high reliability actions only.
- Kept weak and diagnostic actions such as `open`, `expand`, `swipe_skip`, `request_preview`, and `request_create` from training Feel Profile terms.
- Added reason-chip normalization and feature deltas for negative mood reasons such as `too_scary`, `too_bleak`, `too_slow`, `too_silly`, `too_cute`, `too_sentimental`, `wrong_kind_of_weird`, and `not_available_enough`.
- Added database migration `009_profile_replay_metadata` so recommendation sessions, feedback events, and learned profile terms carry profile-version metadata.
- Stamped recommendation sessions with the active `profile_id` and `profile_version` used to produce the slate.
- Stamped feedback events with the resulting `profile_version` and `profile_update_applied` flag.
- Added a three-update cap per recommendation session and mood term for term-profile learning.
- Added tests for profile-version stamping and the per-session term update cap.
- Added database migration `010_profile_confidence_evidence` so learned terms store reliability-weighted positive/negative evidence, effective evidence, and conflict score.
- Scaled profile learning deltas by action reliability so explicit right/wrong mood and pairwise picks train more strongly than medium-confidence gestures.
- Changed profile confidence to use effective evidence rather than raw event count.
- Scaled profile adjustment weights by confidence, effective evidence, and conflict score so cold-start or contradictory terms stay closer to the generic baseline.
- Added tests for cold-start vs high-evidence profile influence and conflict shrinkage.
- Added database migration `011_replay_logging_holdout` so displayed recommendation result rows store feature version and feedback events store profile holdout flags.
- Added deterministic local profile holdouts for every tenth eligible medium/high reliability mood-term signal.
- Added a Feel Profile export endpoint that returns profile terms, preference weights, feedback summary, and recent replay slates without raw prompts or private Plex/Seerr URLs.
- Expanded profile reset so it can reset one term/context, one context, one term across contexts, or all learned terms.
- Added tests for feature-version slate rows, export privacy shape, reset-all behavior, and holdout behavior.
- Added database migration `012_feel_profile_checkpoints` so applied profile updates write term checkpoints keyed by profile version.
- Added `npm run eval:profile-replay` to compare held-out feedback events against the next profile checkpoint without raw prompts.
- Added a replay comparison test covering held-out feedback, displayed slate rows, and the next checkpoint.
- Added admin diagnostics for recent profile checkpoint timeline entries and replay storage counts.
- Added replay retention/compaction rules for sessions, result rows, feedback events, and per-term checkpoints.
- Updated profile reset so matching checkpoints are deleted with learned profile terms.
- Added tests for checkpoint timeline diagnostics, reset checkpoint deletion, and replay compaction bounds.

## Current Eval Snapshot

Command:

```bash
npm run eval:recommendations
```

Result on 2026-06-17:

- Golden eval: 8 cases, 0 failures.
- Golden hard constraint accuracy: `1.0`.
- Golden availability accuracy: `1.0`.
- Profile eval: 15 cases, 12 wins, 0 losses, 3 ties.
- Profile personalization lift: `1.0`.
- Generic profile `NDCG@3`: `0.5651`.
- Personalized profile `NDCG@3`: `0.9188`.
- Adversarial eval: 30 cases.
- Adversarial P0 gate: 7/7 passing.
- Adversarial overall pass rate: `1.0`.
- Adversarial P1 pass rate: 15/15.
- Adversarial P2 pass rate: 8/8.
- Adversarial failure-class counts: all `0`.

## Resolved Failure Families In Current Suite

- Exact-rank overfitting in light and availability cases.
- Sparse metadata recovery for relevant titles with minimal summaries.
- Long-tail gentle/quiet sci-fi ranking against broader gentle/light titles.
- Low-commitment prompts with closed-ended/no-cliffhanger semantics.
- Context-sensitive weird/group prompts suppressing hostile art-house weird.
- Availability/light prompts preserving catalog constraints without forcing one soft-drama title.
- Comparative nuance such as `less horror and more grounded`.

## Rationale For P0-Only Gate

The P0 suite covers trust-critical behavior: hard constraints, availability/requestability, explicit negation, compound term survival, and group-safety suppression. These are release-blocking because failures would visibly violate user intent.

P1/P2 cases remain non-gating by policy even though the current suite passes. Future P1/P2 additions can be used to expose deeper semantic, sparse-data, or personalization weaknesses without blocking basic trust-critical behavior.

## Post-V1 Recommended Goal

Continue robustness hardening beyond V1 with:

1. Broaden synthetic user journeys and replay fixtures now that the replay command exists.
2. Import stronger external mood/tag seeds where license and provenance are acceptable.
3. Add profile drift diagnostics and rollback UX on top of the checkpoint timeline.
4. Add UI affordances for export/reset/timeline now that backend diagnostics are stable.
5. Add mobile/iOS signal collection after the web/backend feedback semantics have held up under local usage.

This should happen before collecting real usage data or building the mobile swipe surface.
