# Mood/Feel Profile Delivery Goal

Status: product goal and first delivery plan.
Last updated: 2026-06-17.

## Summary

The north star is an English-only, local-first Mood/Feel Translation Engine that learns how a specific user means mood and feel words, then uses that learned profile to return a small set of available or requestable titles that the user recognizes as "what I meant."

The implementation should start with better representation, measurement, and low-friction feedback collection, not a global model-training effort.

## Problem

Generic recommenders can learn broad taste. Search boxes can match words. LLMs can explain plausible options. None of those alone solves the central product problem:

> A user's private meaning of "cozy", "dark", "weird", "light", "comfort", "low commitment", or "like this but less bleak" is not identical to the generic English meaning.

Moodarr should learn those private meanings gradually while keeping hard facts exact.

## Goals

1. Represent every query and title in a shared baseline Feel Space.
2. Learn user-specific deltas on top of that baseline.
3. Collect feedback naturally from normal watch-selection behavior.
4. Prove personalization lift with profile-aware evals before claiming quality gains.
5. Keep all profile learning local, inspectable, resettable, and separated by context.

## Non-Goals

- Do not infer emotion from camera, microphone, biometrics, or sensors.
- Do not train a global recommender before local representation and evals are solid.
- Do not let AI invent titles, availability, requestability, or request actions.
- Do not store raw prompts in durable telemetry unless an explicit local debug setting enables it.
- Do not force a long onboarding quiz before the product becomes useful.

## Target User Journey

1. The user asks for something in natural language: "dark but not miserable", "cozy but not childish", "something weird and fun".
2. Moodarr returns a small ranked set with useful variety.
3. The user interacts normally: opens a result, hides a bad fit, asks for more like one item, previews a request, or swipes cards in the mobile app.
4. Moodarr turns clear interactions into session feedback immediately and durable profile changes gradually.
5. On later searches, the same mood word shifts toward the user's learned meaning.
6. The user can inspect or reset learned signals if the profile drifts.

## Frictionless Input Strategy

### Web Finder

Collect signals from actions the user already takes:

- open detail: weak interest signal, diagnostic only at first;
- hide result: negative fit signal;
- "more like this": positive contrastive signal;
- "less like this": negative contrastive signal;
- "right mood": strong positive mood signal;
- "wrong mood": strong negative mood signal;
- request preview/create: positive watch-intent signal;
- short optional reason chips after a hide or wrong-mood tap, such as "too dark", "too childish", "too long", "wrong energy".

Do not interrupt the result flow with mandatory rating prompts. Prompt for extra detail only after the user already gave a clear action.

### iOS Swipe Interface

The mobile app can become the strongest calibration surface because swiping is fast and naturally pairwise/contrastive.

Suggested gesture mapping:

- swipe right: "more like this for this mood";
- swipe left: "less like this for this mood";
- tap/open: interest without durable learning yet;
- long press or overflow: "not this mood", "too dark", "too long", "already seen";
- pairwise card: "which better matches cozy tonight?";
- end-of-stack microcheck: "Was this the mood?" with yes/no.

The iOS app should send the same `POST /api/feel-feedback` events as the web app. Mobile should not need a separate learning model.

### Calibration Without Setup Work

Use calibration opportunistically:

- after a user repeats a mood word several times;
- when the engine has low confidence;
- when the user hides multiple results for the same prompt;
- when two candidates are close in score but different in mood axes;
- as an optional "Tune this mood" flow from a result set.

Keep calibration to one or two choices at a time. The product should feel like watch selection, not data labeling.

## First Delivery Slices

### Slice 1: Feel Profile Model And Eval Spine

Status: first backend/eval slice implemented.

Deliver:

- profile term calibration shape for user-specific word meanings;
- synthetic profile fixtures with different meanings for recurring words;
- profile adjustment builder from query terms to feature weights;
- profile score bucket inside MoodRank scoring;
- persistent `feel_profile_terms` storage for learned term weights;
- live recommendation scoring that loads the learned profile by watch context;
- profile-aware tests that prove the same prompt can move different candidates under different profile definitions;
- first `PersonalizationLift@3` benchmark shape.

Acceptance:

- unprofiled searches keep the generic baseline behavior;
- a high-confidence matched profile term can move close candidates;
- profile scoring is visible in score breakdowns and diagnostics;
- learned profile terms are inspectable and resettable through admin APIs;
- hard filters and availability remain deterministic gates;
- profile fixtures are small, explicit, and easy to update as the algorithm advances.

### Slice 2: Feel Signal Spine

Status: implemented as supporting infrastructure.

Deliver:

- `feel_feedback_events` table;
- shared `FeelFeedbackRequest` and `FeelFeedbackResponse` types;
- `POST /api/feel-feedback`;
- diagnostics counts;
- conservative mapping from clear feel actions to existing preference weights;
- conservative mapping from explicit `moodTerm` feedback to Feel Profile term weights;
- tests for iOS-style pairwise/swipe input and metadata sanitization.

Acceptance:

- web and iOS clients can submit the same structured event shape;
- raw prompt text is not stored through metadata;
- solo/group preference boundaries remain separate;
- diagnostics expose counts without secrets.

### Slice 3: Natural Web Controls

Status: started with existing result-card thumbs wired to structured feedback.

Deliver:

- compact icon controls on result cards for more-like, less-like, hide, right mood, wrong mood;
- optional reason chips only after a negative mood action;
- session feedback applied on the next search/refinement;
- no layout regression against the Screening Desk design system.

Acceptance:

- a user can correct a bad mood fit without typing;
- visible controls do not dominate the Finder screen;
- feedback state is reflected in the next submitted search;
- clear recurring mood terms from the latest query can calibrate the profile without storing the raw prompt.

### Slice 4: Profile-Aware Eval Harness

Status: expanded synthetic benchmark implemented.

Deliver:

- synthetic profile fixtures with different meanings for recurring words;
- separate synthetic profile eval catalog for ambiguous mood terms;
- pairwise baseline-vs-personalized eval cases;
- `PersonalizationLift@3`;
- term-level win/loss/tie breakdowns;
- failure taxonomy additions for lexical calibration and overfit.

Acceptance:

- the same prompt can be evaluated under different profile definitions;
- benchmark output separates generic retrieval failures from personalization failures;
- `cozy`, `dark`, `weird`, and `light` have at least two private interpretations represented in synthetic evals;
- no hard-filter or availability regression is tolerated.

### Slice 5: Feel Profile Inspection

Status: started with admin diagnostics and reset API; richer controls pending.

Deliver:

- local admin/profile view of learned positive and negative features by context;
- recurring mood terms with confidence;
- reset controls by context and term;
- exportable diagnostics without raw prompt text.

Acceptance:

- profile behavior is explainable enough to debug drift;
- reset is safe and scoped;
- support bundles remain secret-safe.

### Slice 6: iOS Swipe Calibration

Status: secondary training surface after the profile model and eval path exist.

Deliver:

- mobile card stack backed by search results or curated calibration pairs;
- shared `feel_feedback_events` submission;
- local queue/retry if offline;
- pairwise and swipe signals visible in diagnostics.

Acceptance:

- iOS swipes improve held-out personalized ranking in the profile-aware eval;
- swipe skip remains neutral;
- low-confidence profile terms stay close to the generic baseline.

## Success Metrics

Baseline quality:

- `preRerankRecall@100 >= 0.95`
- `Recall@10 >= 0.90`
- `NDCG@3 >= 0.75`
- hard constraint accuracy `= 1.0`
- availability accuracy `= 1.0`

Personalization quality:

- `PersonalizationLift@3 >= 0.65` after enough calibration data;
- `PersonalizationLift@3 >= 0.70` after 15-25 high-signal calibration interactions for recurring terms;
- held-out pairwise accuracy `>= 0.70` for target mood words after about 20 calibration judgments.

Live product signal:

- median refinements before meaningful top-5 engagement drops by at least 25% after profile calibration;
- wrong-mood hide rate decreases for repeated terms;
- top-5 engagement increases without increasing hard-filter violations.

## First Implementation Decision

Begin with the Feel Profile model, profile-aware scoring, and profile-aware evals. The shared feel-feedback spine is useful support infrastructure, but app input surfaces are secondary until the profile algorithm has a measurable way to improve rankings.

## Revised Next Major Goal

After the GPT Pro review, the next major goal is [Mood/Feel Robustness V1](MOOD_FEEL_ROBUSTNESS_V1_GOAL.md).

The priority is not more AI reranking, mobile swipe UI, or broad product polish. The priority is making learning safe before usage grows:

1. adversarial eval corpus and failure taxonomy;
2. parser and hard/soft constraint hardening;
3. explicit feedback reliability classes and negative reason chips;
4. evidence-conditioned profile deltas;
5. replay-ready slate/profile logging, local holdout, export, and reset.

This changes the implementation order. Mobile swipe calibration remains useful, but it should wait until shared feedback semantics, action reliability, and replay evaluation are solid.

## GPT Pro Review Incorporation

Saved source: [2026-06-17 GPT Pro Mood/Feel Review Source](research/2026-06-17-gpt-pro-mood-feel-review-source.md).

Assessment log: [2026-06-17 GPT Pro Mood/Feel Review Assessment](research/2026-06-17-gpt-pro-mood-feel-review-assessment.md).

Accepted changes:

- treat the baseline Feel Space as a prior with provenance/confidence;
- add adversarial evals for negation, compound terms, comparative language, sparse metadata, context bleed, availability, drift, and title leakage;
- make feedback reliability explicit;
- avoid term-profile training from weak interactions;
- add reason chips for semantic negative feedback;
- add slate/profile-version logging for replay and holdout;
- make profile deltas evidence-conditioned.

Deferred or rejected:

- full contextual bandits are premature;
- pairwise local learner waits until pairwise eval/logging exists;
- term-neighbor embeddings wait until term residuals are stable;
- collaborative filtering and foundation-model training are not the core path;
- iOS swipes wait until backend semantics are safe.

## Research Anchors

- Spotify Taste Profile shows the value of user-visible taste adjustment: <https://support.spotify.com/us/article/your-taste-profile/>
- Personal word embeddings support user-specific meanings for ambiguous words: <https://www.microsoft.com/en-us/research/publication/employing-personal-word-embeddings-for-personalized-search/>
- NRC VAD gives a baseline affect space for English words: <https://aclanthology.org/P18-1017/>
- Implicit feedback literature treats behavior signals as preference evidence with varying confidence: <https://yifanhu.net/PUB/cf.pdf>
- Google recommends candidate generation, scoring, and reranking as separate stages: <https://developers.google.com/machine-learning/recommendation/overview/types>
