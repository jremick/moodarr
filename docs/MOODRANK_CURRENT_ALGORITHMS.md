# MoodRank Current Algorithms

Status: living reference for the current recommendation pipeline.
Last updated: 2026-06-30.

## Purpose

This file is the short source of truth for how Moodarr's recommendation algorithms currently work together. Update it whenever a recommendation PR materially changes a stage, score bucket, feedback signal, eval metric, or source of truth.

Detailed rationale belongs in [MoodRank V3 Algorithm And Benchmark](MOODRANK_V3_ALGORITHM.md). Product direction belongs in [Mood/Feel Profile Research And Goal](MOOD_FEEL_PROFILE_RESEARCH_GOAL.md).

## Pipeline Summary

MoodRank is a multi-stage recommendation pipeline, not one model.

```text
Plex/Seerr catalog truth
  -> media feature documents
  -> mood feature index + FTS + embeddings
  -> conversational brief
  -> optional feel profile translation
  -> hybrid retrieval
  -> full-library rank index
  -> deterministic scoring
  -> diversity pass
  -> optional constrained AI reranking
  -> feel/session feedback
  -> durable profile weights
  -> profile stress evals and diagnostics
```

## Current Stages

### 1. Catalog Truth

Source files: `src/server/integrations/*`, `src/server/db/mediaRepository.ts`

Plex and Seerr/Jellyseerr are the sources of truth for availability, request status, IDs, posters, and requestability. The recommendation engine may interpret mood, but it does not invent catalog facts.

The open catalog backbone adds source-provenance and weak rank-signal tables for records imported from sources such as Wikidata. These records can generate local feature documents and retrieval signals, but catalog-only records are not eligible for normal recommendations until Plex or Seerr verifies availability/requestability. The first alpha path is a bounded Wikidata harvest/import: `npm run harvest:wikidata-catalog` followed by `npm run import:wikidata-catalog -- --file /path/to/wikidata-catalog.jsonl --version wikidata-YYYY-MM-DD`. See [Wikidata Catalog Backbone Goal](WIKIDATA_CATALOG_BACKBONE_GOAL.md).

### 2. Media Feature Documents

Source files: `src/server/recommendation/features.ts`, `src/server/db/mediaRepository.ts`

Every known media item gets a deterministic feature document from title, summary, genres, people, runtime, content rating, ratings, and availability state. Person names remain searchable, but credit-boilerplate names are not used as mood cue evidence, so records like `film by Lance Comfort` do not become false comfort matches.

Stored outputs:

- `feature_text`
- `mood_terms_json`
- `tone_terms_json`
- `watchability_terms_json`
- local semantic `vector_json`
- `feature_version`

### 3. Mood Feature Index

Source files: `src/server/recommendation/moodFeatureIndex.ts`, `src/server/recommendation/movieLensTagGenome.ts`, `scripts/import-mood-seeds.ts`, `scripts/import-movielens-tag-genome.ts`, `scripts/validate-movielens-tag-genome.ts`

`media_mood_feature_scores` stores normalized feature scores such as `mood:cozy`, `tone:whimsical`, and `watch:low-commitment`. Deterministic rows are generated locally; external seed rows can be imported offline.

This makes mood matching a queryable index instead of only a full feature scan.

### 4. Conversational Brief

Source files: `src/server/recommendation/intent.ts`, `src/server/recommendation/brief.ts`, `src/server/ai/briefParser.ts`

The brief translates the user request into:

- hard filters such as media type, runtime, availability, year, and exclusions;
- soft signals such as mood, tone, pacing, genre hints, reference titles, and watch context;
- requestability intent;
- result count and profile scope.

Deterministic parsing owns obvious constraints. Optional AI parsing can enrich soft signals but cannot loosen hard filters silently.

Current deterministic mood language includes recurring terms such as `cozy`, `light`, `weird`, `dark`, `tense`, `intense`, `suspenseful`, `low-commitment`, `easy`, and `background`.

The parser now treats common negated genres and phrases such as `not horror`, `less horror`, `not too dark`, `not animated`, and `not comedy` as hard exclusions when the phrasing is explicit. Availability phrasing distinguishes Plex-only, requestable-only, and available-first-with-requestable-fallback prompts.

### 5. Hybrid Retrieval

Source file: `src/server/recommendation/retrieval.ts`

Retrieval gathers a broad candidate pool before ranking. Current channels include:

- full local catalog candidates;
- SQLite FTS;
- local semantic vectors;
- optional provider embeddings;
- catalog rank signals from open catalog imports;
- indexed mood feature scores;
- reference-title neighborhoods;
- session feedback expansion;
- quality and availability buckets;
- Seerr augmentation when local recall is weak or requestable content is requested.

The goal is high pre-rerank recall. The reranker cannot fix a title it never sees.

When Seerr augmentation is already warranted, the engine first checks a bounded set of high-ranking catalog-only candidates against Seerr by exact title/media-type/year match. Candidate ordering includes catalog rank signals, lexical/semantic/mood fit, quality, feedback, resolved hard filters, and prompt-aware catalog guardrails for comfort, not-scary, group-friendly, and weird/offbeat searches. Matches are upserted through the normal Seerr path and then retrieval/scoring reruns. Failed lookups do not block normal local recommendations.

Repository startup backfills missing or stale generic feature rows only for small batches. Catalog-sized feature-version rebuilds are intentionally explicit work, so a large Wikidata import cannot make normal search startup block on tens of thousands of feature rewrites. Catalog readiness is measured from actual rank, feature, and mood-index coverage.

The repository full-list path bulk-loads genres, people, external IDs, Plex rows, Seerr rows, and catalog-source counts. This keeps full-catalog retrieval practical after importing the Wikidata dump-scale catalog instead of issuing per-item relationship queries.

### 6. Full-Library Rank Index

Source file: `src/server/recommendation/rankIndex.ts`

MoodRank v0.4 builds a per-search rank index across every local library item. The index combines source scores and source ranks from lexical search, local semantic vectors, provider embeddings, catalog rank signals, indexed mood features, session feedback, quality buckets, and availability. It records:

- full library item count;
- retrieval source-candidate count;
- indexed item count;
- source-rank prior per item.

The rank index is intentionally a light prior, not a replacement for scoring. It lets the deterministic scoring pass evaluate the full eligible library while still preserving broad retrieval diagnostics and keeping AI reranking bounded.

### 7. Deterministic Scoring

Source files: `src/server/recommendation/scoring.ts`, `src/server/recommendation/feelProfile.ts`

Each candidate receives independent score buckets:

- query;
- semantic;
- mood;
- reference;
- taste;
- preference;
- profile;
- feedback;
- availability;
- quality;
- friction;
- novelty;
- rank index;
- diversity.

Hard filters are gates. Genres and mood words are soft unless the user explicitly makes them strict.

When a Feel Profile is supplied and the query contains a calibrated term, MoodRank builds a term-specific feature adjustment and scores each candidate against that adjustment. The profile bucket is centered as a bounded score delta, so high-confidence personal meanings can move close candidates while unprofiled searches keep the generic baseline.

Learned profiles are stored in `feel_profile_terms` by `solo`/`group` context. Each term stores bounded feature weights, raw evidence counts, reliability-weighted positive/negative evidence, effective evidence, conflict score, confidence, and a profile version. The live engine loads the learned profile for the active watch context before deterministic scoring.

Profile influence is evidence-conditioned. Cold-start terms remain close to the generic baseline, medium-reliability actions train less strongly than explicit right/wrong mood labels, and mixed positive/negative evidence shrinks effective confidence before the profile score can move ranking.

### 8. Diversity Pass

Source file: `src/server/recommendation/scoring.ts`

MoodRank applies deterministic diversity pressure so broad prompts do not collapse into near-duplicate choices. Diversity pressure is lower for narrow reference-title prompts and higher for ambiguous mood prompts.

Explicit negation, comparison, availability, and runtime prompts protect more of the score-ranked head before diversity pressure runs. This prevents diversity from pushing out the best hard-intent matches on narrow prompts such as `dark but not scary`.

### 9. Optional Constrained AI Reranking

Source files: `src/server/ai/ranker.ts`, `src/server/recommendation/engine.ts`

When enabled and useful, the AI reranker receives the resolved brief, safe metadata for up to 100 deterministic candidates, and score buckets. It can rank known candidates, explain tradeoffs, and suggest refinements.

It cannot:

- return unknown IDs;
- override availability;
- create requests;
- leak private URLs or tokens.

### 10. Feedback And Feel Signals

Source files: `src/server/recommendation/engine.ts`, `src/server/db/mediaRepository.ts`

Existing search feedback supports more-like, less-like, and hidden items for the next search. Durable preference weights are updated separately for `solo` and `group`.

`feel_feedback_events` adds a more general signal layer for web and future iOS clients. Current actions include:

- `swipe_right`, `swipe_left`, `swipe_skip`;
- `more_like`, `less_like`, `right_mood`, `wrong_mood`;
- `pairwise_pick`;
- `open`, `expand`, `save`, `hide`;
- `request_preview`, `request_create`.

Every feel feedback event stores an action reliability class:

- `high`: `right_mood`, `wrong_mood`, `pairwise_pick`;
- `medium`: `swipe_right`, `swipe_left`, `save`, `hide`, `more_like`, `less_like`;
- `weak`: `request_create`;
- `diagnostic`: `open`, `expand`, `swipe_skip`, `request_preview`.

Only medium/high reliability actions can train Feel Profile terms. Weak and diagnostic actions are stored for diagnostics and future replay but cannot update term-profile weights. `request_create` can still update broad preference as a weak intent signal, but it does not directly teach mood-term meaning.

Each recommendation session records the active `profile_id` and `profile_version` at the time results were produced. Each feel feedback event records the resulting `profile_version` plus whether that event actually applied a profile update. Term-profile updates are capped to three applied updates for the same recommendation session and mood term, which limits damage from repeated same-slate taps or swipes.

Profile learning uses action reliability weights: high reliability counts as `1.0`, medium as `0.55`, weak as `0.2`, and diagnostic as `0`. Pairwise picks count as positive evidence with contrastive negative feature deltas rather than as contradictory term sentiment.

Every tenth eligible medium/high reliability mood-term signal is marked as a local profile holdout. Holdout events are still stored and can update broad preference, but they do not update term-profile weights. This creates a small replay set for measuring whether profile learning would have helped.

Reason chips are normalized and stored with feedback events. Current negative reason chips include `too_scary`, `too_bleak`, `too_slow`, `too_silly`, `too_cute`, `too_sentimental`, `wrong_kind_of_weird`, and `not_available_enough`. For medium/high reliability mood feedback, known reason chips add targeted bounded feature deltas, such as moving a term away from `genre:horror` and `watch:high friction` for `too_scary`.

The web Finder result-card thumbs now submit background `more_like` and `less_like` feel feedback. They reuse the existing UI controls and extract only a narrow recurring mood term from the latest query, not the raw prompt. iOS swipe collection remains future work.

### 11. Evals, Drift, And Diagnostics

Source files: `src/server/recommendation/evaluation.ts`, `src/server/recommendation/rankIndexEvaluation.ts`, `src/server/recommendation/profileJourneyEvaluation.ts`, `scripts/evaluate-recommendations.ts`, `scripts/evaluate-profile-journeys.ts`, `scripts/evaluate-profile-replay.ts`

Current evals report:

- pre-rerank recall;
- top-10 recall;
- top-3 hit rate;
- MRR;
- `NDCG@3`;
- hard constraint accuracy;
- availability accuracy;
- failure taxonomy counts.
- synthetic profile `PersonalizationLift@3`;
- generic vs personalized profile `NDCG@3`.
- profile term breakdowns for recurring ambiguous words.
- adversarial pass rate by priority and failure class.
- held-out profile replay wins/losses/ties.
- synthetic journey replay wins/losses/ties.
- stable journey replay losses.
- profile drift alert counts.
- v0.3-vs-v0.4 golden-suite comparison.
- v0.3-vs-v0.4 rank-index coverage cases for capped-candidate misses.

Admin diagnostics report recommendation runs, recommendation profile snapshot versions, feature coverage, catalog source summaries, catalog rank/feature/mood readiness counts, catalog verification candidates, embedding coverage, preference weights, learned Feel Profile terms, reliability-weighted evidence, conflict scores, drift alerts, recent checkpoint timeline entries, replay storage counts, retention policy, action reliability counts, recent feel-signal events, applied profile-update flags, holdout flags, and feel-signal counts without secrets.

Admin diagnostics also include a derived `usageReadiness` summary for controlled local usage. It classifies the real signal loop as `cold_start`, `collecting`, `replay_ready`, or `review_needed` from real feel-signal totals, applied profile updates, holdouts, replay comparisons, drift alerts, profile versions, and recent activity. The first readiness target is intentionally conservative: at least 10 applied profile updates, at least 1 holdout, at least 1 replay comparison, and no active drift alerts.

Recommendation result rows store displayed candidate IDs, rank, score, score buckets, availability group, and feature version. Applied profile updates also write term checkpoints keyed by profile version. The admin Feel Profile export returns profile terms, preference weights, feedback summary, and recent replay slates without raw prompts, secrets, or private Plex/Seerr URLs.

Profile drift alerts are derived from learned terms with enough evidence and high conflict between positive and negative reliability-weighted feedback. The alert is a review signal, not an automatic reset. Admin rollback restores a single term/context from an earlier checkpoint as a new profile version and appends a new checkpoint, preserving old feedback events and checkpoint history.

Replay storage is compacted by bounded defaults: 180 days, 1,000 recommendation sessions, 5,000 feel feedback events, and 120 checkpoints per term. Compaction preserves current learned profile terms while pruning replay/session/event/checkpoint history.

The current profile stress suite uses a separate synthetic catalog in `src/server/recommendation/profileEvalFixtures.ts`. It covers 15 profile cases across four ambiguous terms: `cozy`, `dark`, `weird`, and `light`. The latest local run reported 12 wins, 0 losses, and 3 ties against the generic baseline, with profile `NDCG@3` moving from `0.5651` generic to `0.9188` personalized.

The current adversarial suite uses the same synthetic catalog plus adversarial-only fixtures. It covers 40 cases across negation, compound terms, comparative language, sparse metadata, context bleed, title leakage, availability override, diversity masking, and constraints. The latest local run reported a 7/7 P0 gate, overall adversarial pass rate `1.0`, P1 pass rate 20/20, and P2 pass rate 13/13. P0 cases are blocking; P1/P2 cases remain visible non-gating coverage for future robustness expansion.

The rank-index coverage suite uses large synthetic catalogs to compare MoodRank v0.3's capped retrieved-candidate scoring against MoodRank v0.4's full-library rank-indexed scoring. The latest local run covered 4 cases: runtime cap, animation negation, requestable-plus-runtime, and excluded-horror group-safety. In each case the expected target was outside the 500-item v0.3 candidate pool; v0.3 hit 0/4 and v0.4 hit 4/4.

The local profile replay command is `npm run eval:profile-replay`. It reads held-out feedback events, displayed slates, and profile checkpoints from the local DB, then compares the profile score at the held-out event's profile version against the next checkpoint for that term. It does not require raw prompts.

The synthetic profile journey command is `npm run eval:profile-journeys`. It creates in-memory recommendation sessions, applies structured feedback through the same repository path as real usage, forces replay holdouts, and checks that stable journeys have zero replay losses while intentionally conflicting journeys raise drift alerts. The current V2 follow-up suite covers 7 journeys, 89 feedback steps, 7 holdouts, and 7 replay comparisons. It includes stable profile learning, a weak-action barrage that must not create term-profile learning, pairwise-pick contrast learning, solo/group context isolation for the same term, and one intentional conflicting-drift journey.

External mood/tag sources are treated as optional local eval or metadata references, not production truth. MovieLens Tag Genome and NRC VAD are local-only research/eval references due to non-commercial/no-redistribution terms. Wikidata is the safest production enrichment candidate for structured facts because its structured data is CC0. The optional `npm run validate:movielens-tag-genome -- --dir /path/to/ml-25m --threshold 0.7` command reads ignored local MovieLens CSV files and emits aggregate mapping coverage without writing to the app DB or creating derived committed data. See [2026-06-17 External Mood Seed Assessment](research/2026-06-17-external-mood-seed-assessment.md).

Current implementation note: `catalog_source_records`, `catalog_rank_signals`, and `catalog_sync_runs` provide the first local spine for Wikidata-first catalog ingestion. `src/server/catalog/wikidataCatalogImporter.ts` maps normalized Wikidata JSON/JSONL into those tables. `npm run eval:catalog-readiness -- --min-ready <n>` reports whether an imported local catalog has enough rank/feature/mood-indexed rows for search testing. Catalog tables are provenance and indexing support tables, not a new source of availability truth.

For a simplified visual explanation of the complete system, see [Mood/Feel Profile System Map](MOOD_FEEL_SYSTEM_VISUAL.html). For the saved GPT Pro review and incorporation assessment, see [Moodarr Research Records](research/README.md). For the current implementation goal, see [Mood/Feel Controlled Usage Goal](MOOD_FEEL_CONTROLLED_USAGE_GOAL.md).

## Update Contract

When changing recommendation behavior, update this file if any of these change:

- a pipeline stage is added, removed, or reordered;
- a score bucket changes meaning;
- a feedback signal starts or stops affecting ranking;
- a new table becomes part of recommendation state;
- eval metrics or acceptance thresholds change;
- AI becomes responsible for a new decision boundary.

Every algorithm PR should still include the reporting standard from [MoodRank V3 Algorithm And Benchmark](MOODRANK_V3_ALGORITHM.md): engine version, changed stages, eval command, baseline result, new result, failures added/resolved, latency impact, fallback behavior, and privacy/security notes.

## Research Anchors

- Google recommendation systems overview: <https://developers.google.com/machine-learning/recommendation/overview/types>
- YouTube DNN recommendations: <https://research.google.com/pubs/archive/45530.pdf>
- Netflix foundation model for personalization: <https://netflixtechblog.com/foundation-model-for-personalized-recommendation-1a0bd8e02d39>
- MovieLens Tag Genome: <https://grouplens.org/datasets/movielens/tag-genome/>
- Collaborative filtering for implicit feedback datasets: <https://yifanhu.net/PUB/cf.pdf>
