# Moodarr Recommendation Engine

Status: historical implementation/target plan for MoodRank v0.4 with AI-assisted extension points. For current behavior, limits, and terminology, check [MoodRank Current Algorithms](MOODRANK_CURRENT_ALGORITHMS.md) first.

For the original algorithm rationale and benchmark contract, see [MoodRank V3 Algorithm And Benchmark](MOODRANK_V3_ALGORITHM.md). For the short living map of current algorithm stages, see [MoodRank Current Algorithms](MOODRANK_CURRENT_ALGORITHMS.md). For the current improvement plan, see [MoodRank Improvement Decisions And Target Plan](MOODRANK_IMPROVEMENT_PLAN.md). For the product/research thesis behind personalized mood language, see [Mood/Feel Profile Research And Goal](MOOD_FEEL_PROFILE_RESEARCH_GOAL.md), for the delivery plan see [Mood/Feel Profile Delivery Goal](MOOD_FEEL_DELIVERY_GOAL.md), and for the next robustness push see [Mood/Feel Robustness V1 Goal](MOOD_FEEL_ROBUSTNESS_V1_GOAL.md). For the local benchmark snapshot, see [MoodRank v0.4 Benchmark Results](MOODRANK_V0_4_BENCHMARK_RESULTS.md).

## Current Implementation

Engine version: `moodrank-v0.4`.

Beta data boundary: the official beta uses Plex and local/catalog imports for descriptive discovery. Seerr contributes operational request state and accepts explicitly confirmed requests; it is not queried for descriptive search/details, and Moodarr has no direct TMDB content or artwork path.

Implemented now:
- `gpt-5.5` is the default configurable reranking model.
- `media_features` stores deterministic feature documents, mood/tone/watchability terms, and local semantic vectors.
- `media_content_fingerprints` stores deterministic `ContentFingerprintV1` JSON with evidence, confidence, source quality, and safety/friction dimensions. The current deterministic rules include richer themes, setting, era, pacing, intensity, style, watchability, catalog-rank, country/language, and franchise facts from stored metadata. It is persisted beside current search artifacts and can be rebuilt with `npm run rebuild:content-fingerprints` or bulk-refreshed with `npm run backfill:content-fingerprints:bulk`.
- `media_mood_feature_scores` stores normalized, source-versioned mood/tone/watchability and fingerprint-derived dimension scores for indexed mood retrieval.
- `media_feature_fts` provides SQLite FTS5 lexical retrieval.
- `catalog_search_index_fts` stores richer catalog lexical text, including safe Wikidata aliases/countries/languages/franchises and coarse rank labels.
- Existing databases backfill small batches of feature rows when `MediaRepository` starts. Large catalogs use explicit bulk refreshes: `npm run backfill:features:bulk` refreshes `media_features`, `media_feature_fts`, deterministic mood rows, and fingerprints in one pass.
- Search builds a structured `RecommendationBrief` from the deterministic parser.
- Query optimization compacts reusable conversational searches before parsing.
- Retrieval blends FTS, local semantic vector similarity, indexed mood-feature scoring, reference-title matches, feedback expansion, quality buckets, availability buckets, and broad fallback candidates.
- v0.4 builds a per-search rank index across the selected candidate window. The current implementation targets 1,000 to 3,000 selected IDs for large catalogs rather than scoring an unlimited full catalog on every query.
- Deterministic scoring now includes `query`, `semantic`, `mood`, `reference`, `taste`, `feedback`, `availability`, `quality`, `friction`, `novelty`, `rankIndex`, and `diversity` buckets.
- Deterministic diversity reranking protects high-precision top slots on targeted prompts and diversifies the rest of the candidate list.
- `/api/search` accepts optional `feedbackContext` while preserving existing request compatibility.
- Search stores privacy-preserving `recommendation_sessions`, `recommendation_results`, and `recommendation_feedback` telemetry with query hashes only.
- In direct source or explicitly configurable EXP development, optional OpenAI embeddings can be cached in `media_embeddings` and blended with the local semantic fallback. The official beta.1 server bundle excludes that provider endpoint.
- Optional `gpt-5.5` structured brief parsing adds hard constraints and soft taste signals before retrieval while deterministic parsing remains the fallback.
- Feedback updates separate durable solo and together preference weights in `preference_feature_weights`.
- Admin recommendation diagnostics expose engine counts, fingerprint depth/currentness/projection coverage, embedding coverage, recent runs, and learned preference signals without secrets.
- The eval runner reports pre-rerank recall, MRR, `NDCG@3`, top-3 hit rate, top-10 recall, constraint accuracy, availability accuracy, and failure taxonomy counts.
- `npm run import:mood-seeds` can import external source-versioned mood scores into the local index.
- `npm run import:movielens-tag-genome` can import local MovieLens Tag Genome mappings into the same source-versioned mood index.

Still to build:
- Optional AI-generated media feature enrichment for richer tone/mood tags.
- Any future third-party descriptive-content import, including TMDB/Seerr keywords or collections, only after written authority and complete provenance/expiry enforcement.
- Named companion/group profiles beyond the current solo/together split.
- More detailed stage latency telemetry and fallback reasons.

## Model Selection

Use `gpt-5.5` as the default provider model for recommendation brief parsing, final reranking, explanations, and follow-up refinement options. It is the right default for quality-focused local iteration because the recommendation task depends on taste judgment, constraint handling, conversational continuity, and concise explanation quality.

Keep the model configurable from Admin and `OPENAI_MODEL`. For lower-cost deployments later, support a profile such as `gpt-5.4-mini` for reranking, but do not make the cheaper path the quality baseline.

Embeddings are separate from the chat/rerank model. Default to `text-embedding-3-large` for semantic retrieval quality. A cheaper embedding model can be configured later if evals show similar recall.

## Product Goal

Moodarr should feel like a watch-choice companion, not a keyword search box. A user should describe a mood, keep refining the request conversationally, and get a ranked list that blends:

- the full synced Plex library,
- local catalog records plus Seerr operational request state,
- hard constraints from the prompt,
- soft taste, mood, style, and reference-title similarity,
- separate solo vs together preference signals,
- explicit feedback from the current session and long-term profile history.

AI improves interpretation, semantic ranking, explanation, and refinement. It never decides availability, never invents requestability, and never creates requests.

## Non-Negotiable Rules

- Plex and Seerr tokens stay server-side.
- Hard filters are enforced outside the model before and after reranking.
- Plex availability and Seerr request status come from those operational records; request-attempt eligibility additionally requires a trusted local interoperability ID.
- Model output can only reference known candidate IDs.
- Request creation remains preview plus explicit confirmation.
- The app works without AI using deterministic and semantic local retrieval.
- Search telemetry is local and privacy-preserving by default.
- Local-first does not mean zero egress because configured Plex and Seerr operational flows remain. The official beta has no direct TMDB route. Source/EXP OpenAI testing can additionally send the bounded inputs documented in `DATA_AND_PRIVACY.md`; the official beta.1 image cannot.

## Target Pipeline

### 1. Conversational Brief Builder

Convert the current chat state into a structured `RecommendationBrief`.

Fields:
- `query`: latest user wording plus relevant refinements.
- `hardFilters`: media type, runtime range, availability scope, result count, content rating, year range.
- `softSignals`: mood, tone, pacing, genre hints, era feel, style, occasion, reference titles, "better than" cues.
- `watchContext`: `solo` or `group`.
- `feedbackContext`: liked, disliked, hidden, and already-reviewed titles for the session.
- `profileScope`: `solo`, `group`, and later named companion/group profiles.
- `requestabilityIntent`: whether Seerr request options are useful.

Implementation:
- Keep deterministic extraction for obvious filters.
- Add optional `gpt-5.5` brief parsing behind a schema.
- Merge AI-parsed soft signals with deterministic filters, but never let AI loosen hard filters silently.
- Store the resolved brief on the search response for debugging and evals.

### 2. Media Feature Documents

Create a stable recommendation document per media item.

Inputs:
- title, year, media type,
- summary,
- genres,
- cast and directors,
- runtime,
- content rating,
- Plex availability, trusted local request IDs, and Seerr operational request state,
- critic/audience/user ratings,
- external IDs,
- request status.

Derived fields:
- `mood_terms`: cozy, funny, tense, weird, warm, dark, clever, gentle, etc.
- `tone_terms`: light, sincere, chaotic, dry, whimsical, adventurous, romantic, suspenseful.
- `watchability_terms`: low commitment, group friendly, background-friendly, intense, family friendly.
- `similarity_text`: normalized text optimized for retrieval.
- `safety_flags`: content-rating derived friction for group mode.

Implementation status:
- `media_features` is implemented.
- Deterministic feature generation runs at sync/search ingestion time and backfills existing databases.
- Optional AI enrichment for tone/mood tags remains future work.
- Feature text intentionally excludes poster paths, Plex URLs, Seerr URLs, and secrets.

### 3. Hybrid Retrieval And Rank Index

Retrieve broadly before rank-indexed scoring and AI reranking.

Candidate sources:
- bounded full-catalog fallback and catalog-rank candidates selected into the rank-index window.
- SQLite FTS lexical search over title, summary, genres, people, tags.
- Embedding/vector search over `similarity_text`.
- Reference-title neighborhood retrieval.
- Session feedback expansion: more like liked items, less like disliked items.
- local catalog-rank candidates carrying trusted interoperability IDs, with Seerr request status applied when known.

Candidate pool target:
- Keep retrieval diagnostics for each source before rank-indexed candidate-window scoring.
- Blend top candidates from lexical, semantic, reference-neighbor, quality, availability, and diversity buckets.
- Keep request-eligible local items and known Seerr request-state items in separate availability buckets so they are not crowded out by Plex-only availability.

MoodRank v0.4 adds a rank index over the selected candidate window for each search. The current implementation targets 1,000 to 3,000 selected IDs depending on library size, records source ranks and normalized source scores for those IDs, and applies hard filters plus normal score buckets to eligible selected candidates. This keeps expensive AI reranking bounded to the top 100 deterministic candidates while leaving true indexed full-catalog scoring as a target improvement, not current behavior.

Implementation status:
- Local deterministic semantic vectors are stored in `media_features.vector_json`.
- FTS5 retrieval is implemented as `media_feature_fts`.
- Provider-backed vectors are cached in `media_embeddings` with provider, model, feature version, input hash, and dimensions.
- Retrieval backfills a bounded batch of missing provider embeddings per search and keeps using local semantic vectors for selected candidates while coverage grows.
- Add optional sqlite-vec or a vector extension later only if profiling says brute-force similarity is too slow.

### 4. Deterministic Scoring

Score every eligible library item before AI.

Score buckets:
- `constraint`: hard filter satisfaction, runtime fit, media type, availability scope.
- `semantic`: embedding similarity to brief and reference titles.
- `lexical`: title, people, genre, and summary term matches.
- `taste`: solo/together profile fit.
- `profile`: user-specific meaning for calibrated mood/feel words.
- `feedback`: more-like and less-like feature similarity.
- `availability`: Plex available, requestable, partial, already requested, unavailable.
- `quality`: normalized critic/audience/user ratings.
- `novelty`: avoid near-duplicates and repeated disliked results.
- `rankIndex`: light selected-window prior from retrieval source ranks.
- `diversity`: prevent the top set from being one narrow genre cluster.

Design rule:
- Genre should usually be a soft feature, not a hard filter, unless the user explicitly sets the genre filter or says "only horror", "strictly comedy", etc.

### 5. AI Reranking And Explanation

Use `gpt-5.5` for final judgment over a compact, balanced shortlist.

Input:
- structured `RecommendationBrief`,
- bounded candidates, sized by requested result count,
- deterministic score buckets,
- safe metadata only.

Output schema:
- conversational summary,
- ranked candidate IDs,
- 0-100 fit scores,
- one concise reason per item,
- follow-up refinement options.

Post-processing:
- ignore unknown IDs,
- clamp scores,
- preserve availability from backend records,
- enforce hard filters again,
- merge deterministic leftovers if AI omits useful candidates,
- dedupe and diversity-pass the final list.

Reasoning effort:
- default `OPENAI_REASONING_EFFORT` to `low` for `gpt-5.5`.
- keep effort configurable from Admin and container env for latency/cost tuning.
- keep timeout and deterministic fallback.

### 6. Feel Profile And Preference Learning

Separate profile translation, session feedback, and durable preferences.

Feel Profile signals:
- map recurring mood/feel words to personal feature weights;
- stay scoped by watch context;
- affect ranking only when the query uses a calibrated term;
- remain inspectable and resettable before aggressive durable learning.

Session signals:
- thumbs up/down,
- "more like" and "less like" chat refinements,
- opened Plex,
- opened trailer,
- expanded description,
- request preview,
- request created,
- dismissed/hidden.

Profile scopes:
- `solo`: personal taste.
- `group`: general shared-watch taste.
- later: named profiles such as "with partner", "family", "friends".

Storage:
- `recommendation_sessions`
- `recommendation_results`
- `recommendation_feedback`
- `preference_profiles`
- `preference_feature_weights`
- `feel_feedback_events`
- `feel_profile_terms`

Behavior:
- Disliked items are hidden for the current session.
- Liked items can be hidden or shown depending on the "show rated" toggle.
- Feedback should not instantly reorder the current result set; it should shape the next submitted refinement.
- Durable profile updates should be gradual, bounded, explainable, and resettable by context/term.

### 7. Measurement And Evals

The engine is only good if we can prove recall and ranking are improving.

Offline evals:
- golden prompts from real product flows,
- expected constraints,
- expected candidate titles or title families,
- excluded candidates,
- top-k recall,
- NDCG/MRR,
- candidate recall before AI,
- hard-filter pass rate,
- availability correctness,
- explanation factuality checks.

Live local telemetry:
- model used,
- engine version,
- brief hash,
- candidate counts by stage,
- retrieval latency,
- AI latency,
- external-augmentation status (always off in the official beta),
- feedback events,
- request previews/creates.

Privacy:
- Store query hashes by default.
- Store raw prompts only behind a local admin debug toggle.
- Never include secrets or private URLs in telemetry.

## Build Plan

### Phase 0: Model Upgrade

Deliverables:
- Default `OPENAI_MODEL` to `gpt-5.5`.
- Default `OPENAI_REASONING_EFFORT` to `low` for `gpt-5.5`.
- Update Admin placeholder and tests.
- Update local saved config.

Verification:
- In an explicitly configurable source/EXP run, config status shows OpenAI enabled; the official beta.1 build instead reports provider policy `none`.
- No API key is printed or exposed.
- Existing ranker tests pass.

### Phase 1: Engine Contracts

Deliverables:
- Add `RecommendationBrief`, `RecommendationCandidate`, `ScoreBreakdownV2`, and `RecommendationRun` types.
- Split current scoring into pipeline modules:
  - `brief`
  - `retrieval`
  - `features`
  - `scoring`
  - `reranking`
  - `feedback`
  - `evaluation`
- Preserve current `/api/search` response compatibility.

Verification:
- Existing UI works unchanged.
- Unit tests prove hard filters survive every stage.

Status: partially complete. `RecommendationBrief`, expanded score buckets, diagnostics, and run telemetry exist. A separate `RecommendationCandidate` DTO can still be added if the reranker payload needs more isolation.

### Phase 2: Feature Store And FTS

Deliverables:
- Add `media_features` and FTS tables.
- Generate feature documents on Plex and local-catalog sync; Seerr operational sync must not write descriptive features.
- Add migrations that backfill features for existing libraries.
- Add tests for no token/path leakage in feature text.

Verification:
- Sync creates one feature row per media item.
- FTS retrieval returns sensible candidates for mood and title-reference prompts.

Status: complete for deterministic feature documents and FTS.

### Phase 3: Semantic Retrieval

Deliverables:
- Add embedding provider interface.
- Add `media_embeddings` cache with model/version metadata.
- Generate embeddings lazily on search and eagerly after sync.
- Add query embedding and cosine similarity retrieval.
- Blend lexical, semantic, reference, and availability candidate pools.

Verification:
- Golden eval candidate recall improves before AI reranking.
- Runtime remains acceptable on local library size.
- Search works when embedding provider is disabled.

Status: complete for local semantic retrieval. Optional OpenAI embedding cache/backfill exists for explicitly configurable source/EXP runs only; local vectors are the official beta.1 path.

### Phase 4: GPT-5.5 Brief Parser And Reranker

Deliverables:
- Add schema-based brief parser.
- Upgrade reranker prompt to consume `RecommendationBrief` and `ScoreBreakdownV2`.
- Return structured refinement options tied to inferred mood/style directions.
- Add model/latency/fallback diagnostics in Admin support bundle without secrets.

Verification:
- Bad model output cannot create unknown candidates.
- Fallback deterministic output remains usable.
- Explanations do not repeat obvious metadata or cite unavailable facts.

Status: complete for schema-based AI brief parsing and reranking. Both are optional and fall back to deterministic behavior.

### Phase 5: Feedback And Profiles

Deliverables:
- Persist session feedback.
- Add per-context preference weights.
- Add feature-space "more like / less like" scoring.
- Hide disliked session items by default.
- Add profile reset controls in Admin.

Verification:
- Feedback changes the next run, not the current displayed order.
- Solo and group feedback do not bleed into each other.
- Evals cover feedback-refinement prompts.

Status: session feedback is passed to `/api/search`, persisted locally, hidden items are excluded from the next run, scoring includes a feedback bucket, and durable solo/together preference weights are updated gradually from feedback.

### Phase 6: Quality Dashboard

Deliverables:
- Admin-only engine diagnostics:
  - model,
  - embedding model and cache coverage,
  - engine version,
  - candidate counts,
  - latency,
  - external-augmentation status,
  - learned solo/together signals.
- Local eval runner with reports.
- Regression thresholds for CI.

Verification:
- `npm run eval:recommendations` reports top-k metrics and hard-filter pass rate.
- Current golden coverage includes reference-title matching, feel-good comedy, short TV, "better than" quality steering, negative animation constraints, Plex-only availability, and request-eligible local-catalog items.
- Failing evals block engine changes before UI polish hides quality regressions.

## First Implementation Slice

Start with Phase 1 and Phase 2 together:

1. Add the new pipeline contracts.
2. Add `media_features` plus FTS.
3. Generate deterministic feature documents on sync.
4. Replace current full-list lexical scoring input with hybrid FTS plus broad fallback.
5. Expand golden evals to measure candidate recall before AI.

This gives the engine a better retrieval foundation before spending more model tokens. The AI reranker cannot fix recommendations it never sees.
