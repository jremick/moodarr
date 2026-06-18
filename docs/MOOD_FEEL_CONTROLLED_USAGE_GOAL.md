# Mood/Feel Controlled Usage Goal

Status: started.
Last updated: 2026-06-17.

## Objective

Make Moodarr safe and legible enough for controlled local web/backend usage before mobile signal collection begins. The app should show whether real Feel Profile learning has enough signal, whether held-out replay evidence exists, whether drift needs review, and what the next safe action is.

This goal follows [Mood/Feel Robustness V2](MOOD_FEEL_ROBUSTNESS_V2_GOAL.md). V2 hardened synthetic behavior. Controlled usage hardens the first real feedback loop.

## Non-Goals

- No mobile iOS app work.
- No collaborative filtering.
- No automatic profile reset or rollback.
- No raw prompt logging.
- No bundled external datasets.

## What Success Looks Like

Controlled local usage is ready when:

- admin diagnostics show a derived usage-readiness state;
- cold start, collecting, replay-ready, and drift-review states are distinguishable;
- readiness is derived from real feel signals, applied profile updates, holdouts, replay comparisons, drift alerts, and profile versions;
- the UI gives one next action rather than leaving the user to infer it from raw metrics;
- existing raw diagnostics remain visible for audit;
- tests cover cold start, collecting signal, and replay-ready states.

## Current Implementation

The recommendation diagnostics API now includes `usageReadiness`:

- `status`: `cold_start`, `collecting`, `replay_ready`, or `review_needed`;
- `ready`: whether controlled usage has at least one replay comparison and no drift alerts;
- `signalProgress`: real totals for feel signals, applied profile updates, holdouts, and replay comparisons;
- `profileVersions`: solo/together max versions and learned-term count;
- `review`: drift alert count and whether rollback is recommended;
- `recentActivity`: last signal and run timestamps.

The admin recommendation panel renders the readiness state above the raw replay, profile, drift, and timeline details.

## Current Thresholds

The first controlled-usage readiness target is deliberately small:

- at least 10 applied profile updates;
- at least 1 held-out profile event;
- at least 1 replay comparison;
- 0 active drift alerts.

These thresholds are not product claims. They are a practical first local loop that proves the evidence path works before broader usage.

## Next Slices

1. Run controlled local usage and inspect `usageReadiness` after each short batch.
2. Add a compact real-usage history view if recent events become hard to audit from the current chips.
3. Tune readiness thresholds after several real holdout/replay cycles.
4. Improve rollback UX only after real drift patterns appear.
5. Revisit mobile/iOS swipe capture once web/backend signal semantics stay stable.
