# Mood/Feel Robustness V2 Goal

Status: implemented through the V2 robustness follow-up. Real-usage calibration remains future work.
Last updated: 2026-06-17.

## Objective

Build Mood/Feel Robustness V2: pre-usage stress hardening that proves the Feel Profile can learn across synthetic user journeys, detect drift, roll back scoped profile terms, and expose replay/profile controls in admin before real usage data or mobile swipe signals become the main training source.

V2 builds on [Mood/Feel Robustness V1](MOOD_FEEL_ROBUSTNESS_V1_GOAL.md). V1 made individual feedback events safe. V2 makes sequences of feedback safer.

## Non-Goals

- No mobile iOS app work.
- No bundled external proprietary or non-commercial datasets.
- No raw-prompt logging.
- No collaborative filtering core.
- No paid metadata-provider dependency.
- No broad admin redesign outside the existing Screening Desk system.

## What Success Looks Like

Moodarr is ready for controlled local usage when:

- synthetic multi-event journeys cover stable learning, context isolation, replay holdouts, and intentional drift;
- `npm run eval:profile-journeys` runs without a live DB or raw prompts;
- stable synthetic journeys produce no replay losses;
- intentionally conflicting journeys produce drift review alerts rather than silently overwriting the profile;
- weak and diagnostic actions prove they do not train term-profile meaning;
- pairwise choices create contrastive holdouts and replay comparisons;
- solo and together profile contexts learn separate meanings for the same term;
- admin diagnostics show replay storage, holdouts, checkpoints, drift alerts, and recent checkpoint timeline;
- admins can export local Feel Profile data, reset solo/group learning, and roll a term back to an earlier checkpoint;
- external seed datasets are documented by license and only used where their terms allow.

## Delivery Slices

### Slice 1: Synthetic Journey Eval

Status: implemented and expanded in the V2 follow-up.

Deliver:

- deterministic synthetic personas for recurring mood words;
- real in-memory searches through `RecommendationEngine`;
- real `recordFeelFeedback` calls through `MediaRepository`;
- enough high-confidence events to create holdouts and later checkpoints;
- weak-action barrage, pairwise-pick, context-isolation, stable-learning, and conflicting-drift journeys;
- journey-level replay results and failure messages;
- CLI script `npm run eval:profile-journeys`.

Acceptance:

- at least seven journeys;
- profile-training journeys create holdouts and replay comparisons;
- weak/diagnostic-only journeys create no profile terms, checkpoints, holdouts, or replay comparisons;
- context-isolation journeys keep solo and together versions separate for the same term;
- stable journeys have zero replay losses;
- drift journey produces at least one drift alert;
- test coverage asserts the aggregate result.

### Slice 2: Drift Diagnostics And Rollback Foundation

Status: implemented for backend/API foundations.

Deliver:

- drift alerts derived from mixed positive/negative evidence and reduced effective evidence;
- admin diagnostics field for drift alerts;
- rollback method that restores a term from an older checkpoint as a new profile version;
- admin route `POST /api/admin/feel-profiles/rollback`;
- tests for drift alert, rollback, checkpoint preservation, and conflict clearing.

Acceptance:

- rollback preserves history by appending a new checkpoint;
- rollback never deletes feedback events or old checkpoints;
- diagnostics surface the alert before rollback and clear it after rollback when restored evidence is stable.

### Slice 3: Admin Visibility

Status: implemented as compact admin controls.

Deliver:

- replay sessions, holdouts, checkpoints, and drift alert counts in the recommendation diagnostics panel;
- recent checkpoint timeline;
- drift alert rows with rollback controls;
- Feel Profile export button;
- scoped reset buttons for solo and together profiles.

Acceptance:

- UI uses the existing Screening Desk visual system;
- export uses the existing secret-safe export endpoint;
- reset and rollback refresh admin state after completion.

### Slice 4: External Seed Policy

Status: documented and supported by a local-only validation script.

Decision:

- Treat MovieLens Tag Genome and NRC VAD as local-only research/eval references.
- Do not commit, bundle, redistribute, or ship derived score tables from non-commercial/no-redistribution sources.
- Treat Wikidata as the safest production metadata enrichment candidate because structured data is CC0.
- Treat TMDb as opt-in metadata/API enrichment with attribution and commercial-license review if needed.
- Avoid IMDb, Watchmode, and unverified mood datasets for bundled production mood semantics.

Local validation:

```bash
npm run validate:movielens-tag-genome -- --dir /path/to/ml-25m --threshold 0.7
```

This command reads ignored local `movies.csv`, `genome-tags.csv`, and `genome-scores.csv` files and prints aggregate mapping coverage. It does not write to the app DB, create derived files, or make the dataset part of the repo.

## V2 Metrics

New:

- synthetic journey count;
- synthetic journey steps;
- holdout events;
- replay compared;
- replay wins/losses/ties;
- stable journey replay losses;
- drift alert count.

Carry forward:

- golden `NDCG@3`;
- hard constraint accuracy;
- availability accuracy;
- adversarial pass rate by priority and failure class;
- profile personalization lift;
- local profile replay wins/losses/ties.

## Current Gate

Run:

```bash
npm run eval:profile-journeys
```

V2 follow-up snapshot on 2026-06-17:

- 7 journeys;
- 89 feedback steps;
- 7 holdouts;
- 7 replay comparisons;
- 5 wins, 1 tie, 1 expected drift-journey loss;
- 0 stable journey replay losses;
- 1 drift alert;
- 0 failures.

## Next After V2

1. Add richer rollback UX once local usage shows common drift patterns.
2. Add a broader synthetic persona library with more contradictory and sparse-metadata cases.
3. Run the local-only MovieLens Tag Genome validator against an ignored full dataset and record aggregate coverage only.
4. Add real local usage dashboards once enough non-synthetic holdouts exist.
5. Add mobile/iOS swipe signal collection after the web/backend journey semantics stay stable.
