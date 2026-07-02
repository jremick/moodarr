# MoodRank Agent Review Packet

Status: detailed implementation context for external AI review.
Last updated: 2026-07-02.
Audience: GPT 5.5 Pro, Claude Fable 5, or another reviewer asked to recommend algorithm and process improvements.

## Review Goal

Review Moodarr's current MoodRank and search process for effectiveness against this product goal:

> Help a user choose what to watch from Plex and Seerr/Jellyseerr by describing mood, context, constraints, and feedback in natural language, while keeping availability/requestability facts exact and learning personal mood language gradually.

The target is not generic media search. The target is a local-first watch-choice companion that can turn fuzzy language like "cozy but not too cute, something short for us tonight" into a small, useful set of watch candidates.

For agreed target improvements and phased implementation decisions, see [MoodRank Improvement Decisions And Target Plan](MOODRANK_IMPROVEMENT_PLAN.md). This packet distinguishes current implementation from target improvements; do not assume the target trace/fingerprint objects already exist unless the current-state sections say so.

## Non-Negotiable Boundaries

- Plex and Seerr/Jellyseerr remain the source of truth for availability, requestability, request status, posters, and request creation.
- Hard filters are enforced outside AI.
- AI may parse soft signals, rerank known candidates, write explanations, and suggest refinements.
- AI must not invent candidate IDs, availability, request status, private URLs, or personal preferences.
- Search works without AI.
- Telemetry and diagnostics should avoid raw prompts by default and must not include secrets.
- Request creation remains preview plus explicit confirmation.

## Primary Source Files

- API route and schemas: `src/server/app.ts`
- Search facade: `src/server/search/searchService.ts`
- Main pipeline: `src/server/recommendation/engine.ts`
- Intent parsing: `src/server/recommendation/intent.ts`
- Brief construction: `src/server/recommendation/brief.ts`
- Retrieval: `src/server/recommendation/retrieval.ts`
- Rank index: `src/server/recommendation/rankIndex.ts`
- Deterministic scoring and diversity: `src/server/recommendation/scoring.ts`
- Preference profile definitions: `src/server/recommendation/preferences.ts`
- Feel Profile scoring: `src/server/recommendation/feelProfile.ts`
- Feature generation: `src/server/recommendation/features.ts`
- Mood feature index: `src/server/recommendation/moodFeatureIndex.ts`
- Persistence and learning: `src/server/db/mediaRepository.ts`
- AI brief parser: `src/server/ai/briefParser.ts`
- AI query optimizer: `src/server/ai/queryOptimizer.ts`
- AI reranker: `src/server/ai/ranker.ts`
- AI taste scout: `src/server/ai/tasteScout.ts`
- Client refinement/query composition: `src/client/chatCriteria.ts`, `src/client/App.tsx`
- Shared request/response types: `src/shared/types.ts`
- Evals: `src/server/recommendation/evaluation.ts`, `src/server/recommendation/rankIndexEvaluation.ts`, `src/server/recommendation/profileJourneyEvaluation.ts`

## Current Search API Contract

`POST /api/search` accepts:

- `query`: required string, 1 to 2000 chars.
- `useAi`: optional boolean.
- `resultLimit`: optional integer, 1 to 200.
- `watchContext`: optional `solo` or `group`.
- `filters`: optional hard filters for media type, runtime, year, genres, excluded genres, content rating, availability, and request status.
- `feedbackContext`: optional item ID groups for `preferredExampleItemIds`, `moreLikeItemIds`, `maybeItemIds`, `lessLikeItemIds`, `hiddenItemIds`, and `showRatedItems`.

The route applies the configured default result limit if none is sent, then calls `SearchService.search()`, which delegates to `RecommendationEngine.recommend()`.

The response returns:

- ordered `results`;
- `groups` by availability group;
- `summary`;
- `refinementOptions`;
- `resolvedFilters`;
- `watchContext`;
- `resultLimit`;
- optional `diagnostics`.

## Terminology

- Library item: any known media row.
- Catalog-only item: imported provenance/indexing record not yet verified by Plex or Seerr.
- Retrieval source candidate: an ID surfaced by one retrieval channel.
- Selected candidate window: deduped candidates inflated and capped at 1,000 to 3,000 items.
- Eligible scored candidate: selected candidate that passes recommendation eligibility, hard filters, and hidden-item gates.
- Rerank shortlist: up to 100 top deterministic candidates selected for the AI ranker boundary.
- Serialized rerank payload: currently up to 60 rerank candidates sent to the OpenAI ranker.

## End-To-End Pipeline

### 1. Client Query And Refinement

The client derives filters from natural language and current UI state in `deriveChatCriteria()`.

For follow-up refinements, `buildConversationQuery(prompt, previousQuery)` appends:

```text
Follow-up refinement: <new prompt>
```

up to the 2000 character request limit. The backend does not hold hidden conversational state for search refinement. Durable state only comes from stored recommendation sessions, recommendation feedback, feel feedback, preference weights, and Feel Profile terms.

### 2. Query Optimization

The engine always runs `DeterministicQueryOptimizer` first. It removes repeated "Follow-up refinement" scaffolding, dedupes repeated parts, and adds `for a group` when group context is active but absent from the text.

Optional AI query optimization only runs when:

- `useAi !== false`;
- the raw query length suggests cleanup is useful (`query.trim().length > 600`);
- an OpenAI provider is configured.

AI query optimization has a 4 second timeout and returns one reusable query under 600 characters. On failure, deterministic output is used.

### 3. Brief And Intent

Deterministic parsing extracts:

- media type words;
- runtime ranges;
- excluded genres from explicit negation;
- availability scope;
- reference title from `like X`;
- `wantsBetter`;
- `wantsRequestOptions`;
- soft genre and mood terms.

Optional AI brief parsing can add soft signals and hard filters through a strict schema, but `mergeParsedSignals()` preserves deterministic hard constraints and prevents AI from silently loosening them.

The `RecommendationBrief` includes:

- query;
- hard filters;
- watch context;
- result limit;
- soft terms, genres, moods, reference title, better-than intent, requestability intent;
- feedback titles from query text and current feedback context.

### Current Feature Documents And Fingerprint Depth

Current deterministic feature generation produces:

- `media_features.feature_text`;
- `mood_terms_json`;
- `tone_terms_json`;
- `watchability_terms_json`;
- local semantic `vector_json`;
- `media_mood_feature_scores` rows such as `mood:funny`, `tone:clever`, and `watch:low-commitment`.
- `media_content_fingerprints` rows containing deterministic `ContentFingerprintV1` JSON.

The fingerprint row stores schema/version/source fields, an input hash, field-level evidence, confidence-scored dimensions, safety/friction fields, source-quality warnings, and generated/updated timestamps. It is generated on ingest, bounded startup backfill, and explicit rebuild with `npm run rebuild:content-fingerprints`.

Current boundary: deterministic search still uses `media_features`, `media_mood_feature_scores`, FTS, vectors, and score buckets. `ContentFingerprintV1` JSON is not read directly in the search hot path; positive, sufficiently confident fingerprint dimensions are projected into `media_mood_feature_scores` as a separate `content-fingerprint` source so they can influence retrieval and rank-index scoring. AI fingerprint enrichment is explicitly deferred to a later offline/batch pass.

### 4. Retrieval

Retrieval is in `retrieveRecommendationCandidates()`.

Current candidate target:

```text
targetCandidateCount = min(3000, max(1000, repository.count()))
```

That means the current code scores a selected rank-index candidate window, not an unlimited 80k+ catalog on every search. Older docs describe the v0.4 design as full-library scoring; for large catalogs, the current implementation is bounded at 3,000 selected IDs.

Retrieval sources and approximate limits:

- lexical FTS over feature text: `searchFeatureIds(retrievalQuery, 180)`, top 140 added;
- catalog FTS when hard filters exist: `catalogSearchCandidateIds(..., 220)`;
- hard-filter candidate IDs: `filteredCandidateIds(..., 180)`;
- provider embedding cosine scores: top 120 added;
- indexed mood feature hits: `searchMoodFeatureScores(..., 180)`, top 140 added;
- reference-title IDs from exact/partial title lookup;
- catalog rank IDs: `catalogRankCandidateIds(..., 180)`;
- availability bucket IDs: `availabilityCandidateIds(..., 96)`;
- fallback catalog rank IDs up to the target count if selected IDs are still below target.

IDs are deduped in source order and inflated through `inflateByIds()`, which also caps at 3,000.

Retrieval context then computes:

- feature map for selected IDs;
- local semantic cosine score from deterministic feature vectors;
- provider embedding scores if configured;
- mood scores from indexed mood hits, otherwise local feature-term fit;
- feedback similarity scores;
- quality scores from critic/audience/user ratings;
- catalog rank scores;
- source count diagnostics.

Catalog-only records are useful for retrieval and bounded Seerr verification, but normal scoring excludes unverified catalog-only records until Plex or Seerr attaches availability/requestability state.

### 5. Rank Index

`buildLibraryRankIndex()` creates a per-search prior over the selected candidate window.

Formula:

```text
rankIndex =
  lexicalScore * 0.12
  + max(localSemantic, providerEmbedding) * 0.22
  + moodScore * 0.20
  + feedbackScore * 0.12
  + qualityScore * 0.10
  + availabilityIndexScore * 0.08
  + catalogRankScore * 0.04
  + lexicalRankPercentile * 0.07
  + semanticRankPercentile * 0.04
  + providerEmbeddingRankPercentile * 0.02
  + catalogRankPercentile * 0.02 when catalogRankScore > 0
  + moodRankPercentile * 0.03
```

Defaults:

- missing lexical score defaults to 44;
- neutral mood, feedback, and quality are usually around 50;
- score is clamped and rounded to 0-100.

The rank index is intentionally a light prior. Final deterministic scoring still applies hard filters and richer scoring buckets.

### 6. Deterministic Scoring

`scoreLibraryCandidates()` filters and scores eligible candidates.

Hard gates include:

- recommendation eligibility;
- media type;
- runtime;
- year;
- genre and excluded genre filters;
- content rating;
- availability;
- request status;
- hidden IDs.

`isRecommendationEligible()` currently allows Plex-available rows, Seerr rows with enough detail, and non-catalog live rows. Catalog-only rows without Seerr are excluded from normal results.

Scoring buckets:

- `query`: direct title, genre, people, summary, lexicon-expanded matches.
- `semantic`: local/provider vector similarity.
- `mood`: mood terms, mood lexicon expansion, feature-term match.
- `reference`: similarity to a reference title.
- `taste`: watch-context defaults for runtime, group friendliness, and maturity.
- `preference`: learned broad preference and Feel Profile blend.
- `profile`: term-specific Feel Profile fit when the query uses a calibrated term.
- `feedback`: current-session more-like/less-like feature similarity.
- `availability`: Plex/requestability/request status.
- `quality`: rating average.
- `friction`: runtime, content rating, intensity, commitment.
- `novelty`: hidden/repeated-item pressure.
- `rankIndex`: light prior from retrieval sources.
- `diversity`: recorded after MMR-style diversification.

The scorer also contains prompt-specific guardrails for phrases such as:

- not scary / not horror;
- dark but not scary;
- dark academia;
- low commitment;
- quiet but not slow burn;
- visually dark;
- weird group/conversation-starter;
- romance but not cute/sentimental;
- gentle sci-fi;
- no jokes / bleak.

### 7. Weighted Score

Solo weights:

```text
query 0.20
semantic 0.15
mood 0.13
reference 0.08
taste 0.09
preference 0.07
feedback 0.09
availability 0.06
quality 0.06
friction 0.04
novelty 0.02
diversity 0.01
```

Group weights:

```text
query 0.16
semantic 0.13
mood 0.14
reference 0.05
taste 0.11
preference 0.05
feedback 0.08
availability 0.11
quality 0.05
friction 0.07
novelty 0.03
diversity 0.02
```

Final deterministic score:

```text
baseline = weighted bucket sum
profileDelta = profile exists ? (profile - 50) * 0.16 : 0
rankIndexDelta = rankIndex exists ? (rankIndex - 50) * 0.03 : 0
final = round(baseline + profileDelta + rankIndexDelta)
```

### 8. Diversity

`diversifyRankedCandidates()` applies an MMR-style reorder over the top 120 candidates.

It protects a small high-precision head for narrow prompts. The protected count increases for explicit constraints, reference titles, low-commitment prompts, availability filters, and group mode.

`lambda` ranges roughly from 0.76 to 0.90:

- stricter prompts lean toward relevance;
- broad exploratory prompts allow more diversity;
- group mode allows more diversity than narrow solo searches.

Important detail: diversity changes ordering and records a diversity bucket, but it does not recompute the numeric `score`.

### 9. Seerr And Catalog Augmentation

The engine can rerun retrieval/scoring after bounded external augmentation.

Augmentation paths:

- if excluding animation, validate a bounded set of top Plex candidates against Seerr to backfill missing genre metadata;
- if local results are weak or requestable content is requested, verify high-ranking catalog-only candidates against Seerr by exact media type, normalized title, and near year;
- if still weak, run up to three Seerr search queries derived from the intent.

When matches are found, records are upserted and retrieval/scoring reruns. Failed lookups do not block local recommendations.

### 10. AI Reranking And Taste Scout

`selectRerankCandidates()` selects up to 100 deterministic candidates.

AI reranking is used when:

- `useAi === true`; or
- `useAi !== false` and feedback/reference/vibe complexity suggests reranking is useful.

The OpenAI ranker currently serializes up to 60 candidates even though the deterministic shortlist can contain 100. It returns a structured summary, refinement options, and candidate rankings. Unknown IDs are ignored. Availability and request status remain backend facts.

When AI reranking is used, `results[].score` may be the AI-calibrated relevance score, while `scoreBreakdown` remains the deterministic input evidence. That means score buckets explain why the candidate was shortlisted, but they may not mathematically reproduce the final displayed score after rerank or taste-scout boosts.

The taste scout is a parallel optional AI signal used when the request or feedback includes examples such as more-like, less-like, similar-to, vibe-of, taste, or surprise-me. It inspects up to 90 candidates and returns score/reason signals. Scout scores are applied as:

```text
boost = round((scoutScore - 50) * 0.24)
```

The engine applies scout boosts to deterministic results and AI-ranked results, then merges AI-ranked results first with deterministic leftovers, slicing to `resultLimit`.

### 11. Refinement Options

Refinement options come from either the AI ranker or deterministic fallback logic.

Deterministic options are chosen from:

- warmer/sharper comedy;
- more magical/more adventure;
- stranger/more grounded;
- more tension/less intense;
- more heartfelt/less heavy;
- more like the top title;
- use my picks;
- crowd pleasers / bolder group pick;
- more personal / easier tonight;
- lean into strongest genre;
- only in Plex / include requests;
- shorter picks / deeper cut;
- surprise me.

The number of options is 3 to 5, determined by a stable hash of the query/context/top IDs.

### 12. Feedback And Learning

There are two related endpoints/mechanisms:

- `/api/search` with `feedbackContext` for next-search ranking.
- `/api/feel-feedback` for structured feedback events and durable profile learning.

#### Search Feedback

When a recommendation run is recorded, `recordFeedbackRows()` stores provided feedback and updates broad preference weights.

Preference weight deltas:

```text
moreLikeItemIds: +0.22
preferredExampleItemIds: +0.38
lessLikeItemIds: -0.26
hiddenItemIds: -0.12
```

`maybeItemIds` are accepted and stored as recommendation feedback, but today they are not treated as a positive/negative ranking signal in the same way as preferred, more-like, less-like, or hidden items.

Weights are stored by `solo:default` or `group:default`, keyed by item features:

- media type;
- genre;
- mood term;
- tone term;
- watchability term;
- runtime bucket;
- content rating bucket.

Weights are clamped from -6 to 6. At scoring time, learned preference score is:

```text
50 + sum(matching feature weights) * 7
```

#### Feel Feedback Reliability

`recordFeelFeedback()` validates item/session IDs, dedupes by `(source, clientEventId)`, stores the event, applies broad preference where appropriate, and optionally applies Feel Profile learning.

Reliability classes:

- high: `right_mood`, `wrong_mood`, `pairwise_pick`;
- medium: `swipe_right`, `swipe_left`, `save`, `hide`, `more_like`, `less_like`;
- weak: `request_create`;
- diagnostic: `open`, `expand`, `swipe_skip`, `request_preview`.

Reliability weights:

```text
high: 1.0
medium: 0.55
weak: 0.2
diagnostic: 0
```

Only medium/high actions can update Feel Profile terms. Weak and diagnostic actions can be stored for diagnostics and replay, but do not directly change mood-term profile weights.

Every tenth eligible medium/high mood-term event is held out from profile learning for replay evaluation.

#### Feel Profile Learning

Feel Profile learning updates a term such as `cozy`, `dark`, `weird`, or `light` for a watch context.

Requirements:

- a `moodTerm` is present;
- action is in the profile-learning action set;
- reliability is not weak or diagnostic;
- session+term has fewer than 3 applied profile updates;
- relevant item features exist.

Feature learning rates:

```text
mood:* or tone:*: 0.22
watch:*: 0.18
genre:*: 0.16
everything else: 0.08
```

Strength scale:

```text
0.7 + strength * 0.08
```

Feature weights are clamped from -6 to 6 and trimmed to the top 48 by absolute value.

Known reason chips add targeted deltas. For example, `too_scary` affects `genre:horror`, `mood:intense`, `tone:suspenseful`, `watch:high friction`, and `rating:r` in the negative direction for negative feedback.

Term state includes:

- feature weights;
- confidence;
- evidence count;
- positive and negative counts;
- positive and negative reliability-weighted evidence;
- effective evidence;
- conflict score;
- version;
- checkpoints.

Conflict reduces effective evidence and influence.

#### Applying The Feel Profile

At search time, the repository loads the active Feel Profile for `solo` or `group`.

`buildFeelProfileAdjustment()` only activates terms that appear in the query. Term influence is:

```text
confidence
* (1 - exp(-effectiveEvidence / 4))
* (1 - conflictScore * 0.65)
```

For each candidate:

```text
profileScore = clamp(50 + sum(matching adjusted feature weights) * 5)
```

If a profile score exists:

```text
preferenceScore = learnedPreferenceScore * 0.45 + profileScore * 0.55
```

The profile also contributes the separate `profileDelta` in final scoring:

```text
(profileScore - 50) * 0.16
```

This design makes learned mood meanings meaningful but bounded.

## Diagnostics And Evaluation

Search diagnostics include:

- engine version;
- model and embedding model;
- library count;
- scored item count;
- rank-index candidate count;
- retrieval candidate count;
- rerank candidate count;
- provider embedding count;
- mood candidate count;
- feedback candidate count;
- hidden feedback count;
- catalog verification count;
- catalog rank candidate count;
- AI brief parsed flag;
- taste scout flag;
- query optimized flag;
- Seerr augmentation flag;
- total and per-stage latency.

Admin diagnostics include recommendation sessions, recent runs, feature coverage, catalog readiness, preference weights, Feel Profile terms, drift alerts, feedback signal counts, holdouts, replay storage, and usage readiness.

Relevant commands:

```bash
npm run eval:recommendations
npm run eval:profile-journeys
npm run eval:profile-replay
npm run eval:catalog-readiness
npm run bench:catalog-search
```

Target eval additions:

- candidate recall by retrieval source and selected-window depth;
- rejected-but-expected cases with explicit rejection reasons;
- deterministic-vs-AI final-score trace checks;
- fingerprint coverage and provenance completeness;
- feedback semantics tests for preferred, more-like, maybe, less-like, hidden, reason chips, and pairwise choices;
- latency/quality gates for no-AI, AI-rerank, taste-scout, and Seerr-augmented paths.

## Current Gaps And Agreed Target Improvements

These are target improvements, not current behavior unless explicitly stated above. Review recommendations should preserve the existing source-of-truth boundary while making the pipeline more inspectable.

### Robust Fingerprint JSON

Current `media_features` are shallow text/term/vector rows, and deterministic `ContentFingerprintV1` now exists beside them. Fingerprint dimensions are projected into indexed `content-fingerprint` mood rows for retrieval; the next target is richer provenance/score traces and later offline AI enrichment into the same schema.

### Candidate Provenance

Current diagnostics count retrieval sources but do not persist a full per-candidate provenance trace. Target candidate records should show which channels surfaced the candidate, source ranks, matched terms/features, reference-title links, feedback similarity, catalog-rank signals, and fallback-fill status.

### Score Trace

Current `scoreBreakdown` exposes bucket scores. Target `ScoreTraceV2` should preserve raw evidence, raw score, normalized bucket score, weight, final contribution, evidence IDs, and adjustment reasons for profile, feedback, rank-index, guardrail, or scout changes.

### Eligibility And Rejection Reasons

Hard filters currently gate candidates during scoring. Target traces should record durable rejection reasons such as `wrong_media_type`, `runtime_too_long`, `excluded_genre`, `content_rating_excluded`, `hidden_by_feedback`, `availability_not_allowed`, and `catalog_only_unverified`.

### Richer Feedback Semantics

Current feedback is split between search feedback, `recommendation_feedback`, `feel_feedback_events`, profile terms, and preference weights. Target feedback should preserve action meaning, reason, reliability, training eligibility, session-similarity effect, profile update result, idempotency, and watch context in one reviewable vocabulary.

### Stronger Rerank Contract

Current AI rerank returns IDs, scores, explanations, summary, and refinements. Target `RerankTraceV1` should preserve deterministic score, model score, scout score, final display rank, rerank confidence, rationale category, deterministic-rank disagreement, invalid/duplicate ID handling, fallback reason, model/schema/prompt version, and shortlist stratification reason.

### Richer Evals

Current evals are useful but should expand beyond expected titles. Target evals should check candidate families, selected-window recall, retrieved-but-rejected cases, rejection reasons, fingerprint coverage, provenance completeness, score-trace reconciliation, feedback semantics, and deterministic-vs-AI disagreement bounds.

### Key Normalization Dialects

Current mood-index keys preserve namespaced hyphenated terms such as `watch:low-commitment`, while preference/profile feature keys often normalize punctuation to spaces such as `watch:low commitment`. That split is workable today, but future fingerprint-derived features should explicitly map between dialects instead of assuming one normalized key format works everywhere.

## Current Review Concerns

Use these as starting points for recommendations.

### Candidate Coverage

The current retrieval target is capped at 3,000 selected IDs. This may be a pragmatic latency boundary, but it means large imported catalogs are not truly full-catalog scored per query. Review whether to:

- restore true full-catalog scoring through cached rank summaries or candidate-first indexed reads;
- keep the 3,000 cap but make it adaptive;
- expose clearer diagnostics when likely matches are outside the selected window;
- improve catalog-first retrieval so the 3,000 window has better recall.

### Score Weights

The score weights are transparent and hand-tuned. Review whether:

- solo/group weights reflect real use;
- rank-index influence is too small or too large;
- profile and preference are double-counted;
- availability should be more contextual;
- quality should be more conservative for weak metadata.

### Mood Feature Quality

The system depends heavily on deterministic features and indexed mood labels. Review:

- whether the taxonomy covers real user language;
- whether negation and compound mood phrases are too special-cased;
- whether feature text overweights summaries/genres;
- how to improve sparse item handling without hallucinating mood.

### Feedback Safety

Review:

- whether profile update caps are high/low enough;
- whether every tenth holdout is sufficient;
- whether medium actions such as swipe/right-left should train term profiles by default;
- whether reason chips cover the important negative feedback dimensions;
- whether solo/group isolation is enough before named profiles exist.

### AI Usage

Review:

- whether AI reranking should see 60, 100, or a more balanced stratified shortlist;
- whether taste scout and reranker overlap too much;
- whether AI should return calibration diagnostics, not only user-facing text;
- whether AI query optimization should run on more than very long prompts;
- whether deterministic fallback quality is strong enough when AI is disabled.

### Evaluation

Review:

- whether synthetic tests cover enough real mood failures;
- whether held-out profile replay is meaningful at low usage volume;
- whether evals measure candidate recall above the 3,000 cap;
- whether real query review should feed a stable golden set;
- whether latency gates should be coupled to ranking-quality gates.

## Suggested External Reviewer Prompt

Paste this packet plus any relevant benchmark output into the reviewer model and ask:

```text
You are reviewing Moodarr's MoodRank recommendation pipeline. Focus on whether the algorithm will actually help a user choose what to watch from a local Plex plus Seerr catalog from fuzzy mood language. Preserve the non-negotiable boundaries: deterministic hard filters, exact catalog facts, no invented availability, local privacy, and bounded feedback learning.

Please provide:
1. The highest-impact algorithm weaknesses, ordered by likely product impact.
2. Concrete changes to retrieval, scoring, feedback learning, AI reranking, or evals.
3. Which changes should be tried first, with acceptance metrics.
4. Risks or regressions each change could introduce.
5. Any places where the current implementation and documentation appear misaligned.
```

## Output Standard For Recommendations

Good recommendations should specify:

- source file or pipeline stage;
- exact behavior to change;
- expected user-visible improvement;
- acceptance metric or eval case;
- latency/cost/privacy impact;
- fallback behavior when AI is unavailable;
- whether it changes catalog truth, hard filters, learned preference, or explanation only.
