# MoodRank Improvement Decisions And Target Plan

Status: target architecture and phased implementation plan. Phase 0, deterministic Phase 1 fingerprints, deterministic Phase 2 fingerprint-to-index projection, and the follow-on non-AI enrichment pass are implemented.
Last updated: 2026-07-02.

## Purpose

This document records the decisions from the MoodRank/search review and the intended target state for richer content understanding, more durable ranking traces, safer learning, and better AI-agent review.

The short version:

- deterministic search must keep working without AI;
- Plex and Seerr/Jellyseerr remain the only availability/requestability truth;
- the original feature terms were useful but too thin to be the long-term content representation;
- MoodRank needs a richer content fingerprint plus durable traces for intent, candidate provenance, scoring, feedback, and reranking;
- AI fingerprint enrichment is desirable, but it should be a later offline/batch pass that writes into the same schema rather than a hot-path dependency.

## Decisions

### 1. Build A Robust Content Fingerprint

The `media_features` row is a compact retrieval document. It stores feature text, mood terms, tone terms, watchability terms, and a local vector. That is good for a first-stage engine, but it is too shallow for reliable mood matching, agent review, or future enrichment.

Implemented slices: `media_content_fingerprints` now stores a deterministic `ContentFingerprintV1` JSON object per title. It represents what the item feels like, why that evidence exists, and how confident the engine should be in each signal. Positive, sufficiently confident fingerprint dimensions are projected into `media_mood_feature_scores` as a separate `content-fingerprint` source so richer evidence can affect candidate retrieval and rank-index scoring without reading fingerprint JSON during search.

### 2. Deterministic First, AI Later

The first implementation generates fingerprints deterministically from existing local metadata: title, summary, genres, runtime, content rating, ratings, people, availability state, existing deterministic feature terms, and safe catalog metadata summaries. The follow-on non-AI enrichment pass adds richer rules for theme, setting, era, pacing, intensity, attention demand, country/language/franchise facts, ratings, award/mainstream signals, query expansion, MovieLens Tag Genome mapping, catalog lexical indexing, and fingerprint-depth diagnostics. It does not store Plex/Seerr URLs or poster paths.

AI fingerprint enrichment should be a separate later pass. It should be offline or batch-oriented, source-versioned, confidence-scored, and auditable. It should not run in the user search hot path.

TMDB/Seerr keyword and collection enrichment also remains a later persistence/import pass. Current `seerr_items` rows store IDs, availability/request status, requestability, and URL only; there is no stored keyword or TMDB collection field for deterministic ranking to consume yet.

### 3. Preserve Feature Namespace Semantics

Mood feature keys use namespaces such as `mood:*`, `tone:*`, `watch:*`, and `microgenre:*`. Namespaces are syntax, not search words.

In this pass, `normalizeMoodFeatureKey()` was fixed so stopword filtering cannot strip the `watch:` namespace. The deterministic feature version moved to `moodrank-v0.4-features-v3` so small databases regenerate deterministic rows automatically.

Verification queries after regeneration:

```sql
SELECT COUNT(*) AS malformed
FROM media_mood_feature_scores
WHERE feature LIKE ':%';

SELECT COUNT(*) AS watch_rows
FROM media_mood_feature_scores
WHERE feature LIKE 'watch:%';
```

Expected result: `malformed = 0` and `watch_rows > 0` for any catalog with watchability terms.

### 4. Make Key Normalization Dialects Explicit

The current system has two related but different key styles:

- mood-index keys preserve namespaced/hyphenated terms such as `watch:low-commitment`;
- preference/profile keys often normalize punctuation to spaces such as `watch:low commitment`.

That split is workable today, but the fingerprint phase should add explicit mapping helpers between these dialects. Future fingerprint-derived features should not assume one normalized key format can be written safely into every store.

### 5. Make The Search Brief Durable

The parsed search brief should become a first-class stored/replayable object, not only runtime helper state. It should separate:

- hard filters;
- soft preferences;
- negative preferences;
- reference titles;
- comparison deltas;
- watch context;
- availability/requestability intent;
- ambiguity and confidence notes.

This makes reviews and evals clearer because the ranking trace can show whether a failure came from understanding the request, retrieving candidates, scoring, reranking, or feedback learning.

### 6. Store Candidate Provenance

Every scored candidate should know why it entered the candidate window.

Target provenance examples:

- `lexical_fts`, with matched query terms and source rank;
- `mood_feature_index`, with matched `mood:*`, `tone:*`, or `watch:*` keys;
- `semantic_local_vector`, with similarity score;
- `provider_embedding`, with model/version and similarity score;
- `reference_title_neighborhood`, with reference title ID;
- `feedback_similarity`, with positive/negative example IDs;
- `catalog_rank`, with source rank signal;
- `availability_bucket`, with Plex/Seerr group;
- `fallback_fill`, when added only to reach candidate-window size.

This is not just diagnostics. It helps decide whether to improve retrieval, scoring, or reranking when a good title is missing or ranked poorly.

### 7. Store Score Traces, Not Only Bucket Scores

The current score buckets are readable, but they do not preserve enough evidence to review why a bucket got its value.

Target score trace per candidate:

- raw evidence;
- raw score;
- normalized bucket score;
- weight;
- final contribution;
- evidence IDs from the fingerprint or search brief;
- adjustment reason for profile, feedback, rank index, or guardrail deltas.

Bucket scores stay useful for UI and AI rerank input. Score traces are for review, regression debugging, and future improvement recommendations.

### 8. Make Eligibility And Rejection Reasons Explicit

Hard filters should leave durable rejection reasons. Examples:

- `wrong_media_type`;
- `runtime_too_long`;
- `year_out_of_range`;
- `excluded_genre`;
- `content_rating_excluded`;
- `hidden_by_feedback`;
- `availability_not_allowed`;
- `catalog_only_unverified`.

This helps distinguish "the engine disliked this" from "the item was never eligible."

### 9. Separate Feedback Meanings

Feedback actions should not all mean "more preference." A durable feedback event should preserve:

- action;
- reason;
- reliability;
- whether it trains broad preference;
- whether it trains mood-term profile learning;
- whether it is only diagnostic;
- whether it applies to current-session feedback similarity;
- watch context;
- optional contrast item for pairwise feedback.

This keeps learned preference safer. For example, opening a detail panel is not the same as saying the item matched the mood.

### 10. Strengthen The AI Rerank Contract

The AI reranker should remain constrained to known candidate IDs, but its output should become more reviewable.

Target additions:

- rerank confidence;
- rationale category, such as `best_mood_fit`, `constraint_tradeoff`, `availability_tradeoff`, or `diversity_pick`;
- explicit disagreement with deterministic rank when it moves an item materially;
- optional bucket-level override hints that are advisory only;
- no availability or request-status authority.

The backend should continue to ignore unknown IDs, dedupe IDs, clamp scores, preserve backend facts, append deterministic leftovers, and fall back deterministically on AI failure.

### 11. Expand Evals Beyond Expected Titles

Existing evals are useful, but richer fingerprints and traces need richer test cases.

Target eval assertions:

- expected candidate families, not only exact titles;
- expected retrieved-but-not-selected candidates;
- expected rejection reasons;
- expected fingerprint dimensions for known titles;
- expected provenance sources for specific prompts;
- score-trace sanity checks;
- AI-rerank disagreement bounds;
- profile-learning holdout wins/losses/ties;
- candidate recall above and below the candidate-window cap.

## Target Content Fingerprint

The fingerprint should be structured enough for deterministic scoring and external AI review, but not so detailed that every source needs to populate every field.

Recommended shape:

```ts
interface ContentFingerprintV1 {
  schemaVersion: "content-fingerprint-v1";
  fingerprintVersion: string;
  source: "deterministic" | "moodarr-wikidata-rules" | "ai-enrichment";
  sourceVersion: string;
  inputHash: string;
  generatedAt: string;
  mediaItemId: string;
  title: string;
  mediaType: "movie" | "tv";
  year?: number;
  summary: {
    premise?: string;
    contentShape?: string;
    experience?: string;
    confidence: number;
  };
  dimensions: {
    mood: FingerprintTerm[];
    tone: FingerprintTerm[];
    themes: FingerprintTerm[];
    setting: FingerprintTerm[];
    era: FingerprintTerm[];
    style: FingerprintTerm[];
    pacing: FingerprintTerm[];
    intensity: FingerprintTerm[];
    humor: FingerprintTerm[];
    romance: FingerprintTerm[];
    watchability: FingerprintTerm[];
    microgenres: FingerprintTerm[];
    negativeCues: FingerprintTerm[];
  };
  safetyAndFriction: {
    runtimeCommitment?: FingerprintTerm;
    contentRatingFriction?: FingerprintTerm;
    groupFit?: FingerprintTerm;
    attentionDemand?: FingerprintTerm;
    scariness?: FingerprintTerm;
    emotionalWeight?: FingerprintTerm;
  };
  evidence: FingerprintEvidence[];
  sourceQuality: {
    summary: "missing" | "thin" | "usable" | "rich";
    genres: "missing" | "thin" | "usable" | "rich";
    people: "missing" | "thin" | "usable" | "rich";
    ratings: "missing" | "usable";
    warnings: string[];
  };
}

interface FingerprintTerm {
  key: string;
  label: string;
  score: number;
  confidence: number;
  specificity: "broad" | "medium" | "specific";
  polarity?: "positive" | "negative";
  evidenceIds: string[];
}

interface FingerprintEvidence {
  id: string;
  sourceField: "title" | "summary" | "genre" | "runtime" | "contentRating" | "rating" | "person" | "catalogFact" | "availability";
  value: string;
  confidence: number;
}
```

### Midnight In Paris Target Example

For `Midnight in Paris`, the current generated terms are only:

- mood: `funny`, `magical`;
- tone: `clever`;
- watchability: `low-commitment`, `background-friendly`, `group-friendly`, `shared-screen`, `in-plex`.

A richer fingerprint should preserve those but add more durable meaning:

- mood: `nostalgic`, `romantic`, `whimsical`, `escapist`;
- tone: `witty`, `wistful`, `light`, `clever`;
- themes: `nostalgia`, `creative longing`, `romantic idealization`, `past versus present`;
- setting: `Paris`;
- era: `1920s`, plus present-day frame;
- style: `dialogue-driven`, `period fantasy`, `literary/art-world references`;
- pacing: `breezy`;
- intensity: `gentle`, `low-stakes`;
- humor: `witty`, `situational`;
- romance: `relationship tension`, `romantic comedy`;
- microgenres: `time-travel romance`, `literary fantasy comedy`, `Paris nostalgia comedy`;
- watchability: `low-commitment`, `shared-screen`, `group-friendly`.

This gives retrieval and reranking more ways to match queries such as:

- `romantic Paris time travel comedy`;
- `witty nostalgic fantasy that is easy to watch`;
- `light but not empty, something clever for a group`.

It also makes a bad match easier to explain. For `dark thriller not scary`, the same fingerprint should show why `Midnight in Paris` is not close: low intensity, romantic/whimsical tone, comedy/fantasy genre, and no thriller evidence.

## Target Search Trace

Every recommendation run should be explainable from durable objects:

```text
SearchBriefV2
  -> candidate provenance records
  -> eligibility/rejection records
  -> ContentFingerprintV1 evidence
  -> ScoreTraceV2
  -> deterministic ranking
  -> optional RerankTraceV2
  -> final result list
  -> feedback events and profile checkpoints
```

This trace should answer four questions:

1. Did the system understand the request?
2. Did it retrieve the right candidate set?
3. Did scoring use the right evidence and weights?
4. Did AI or learned preferences improve the list without violating deterministic truth?

## Phased Plan

### Phase 0: Fix Current Index Integrity

Implemented in this pass:

- preserve mood-feature namespaces in `normalizeMoodFeatureKey()`;
- bump deterministic feature version to `moodrank-v0.4-features-v3`;
- add tests for namespace normalization and stored `watch:*` index rows;
- add an explicit `npm run rebuild:content-fingerprints` command for deterministic fingerprint rebuilds.

Remaining:

- add an explicit large-catalog feature/mood-index regeneration command or admin job;
- run the malformed namespace SQL checks after regeneration on real local databases.

Acceptance:

- targeted recommendation tests pass;
- `feature LIKE ':%'` returns `0`;
- `watch:*` rows exist for catalogs with watchability terms;
- queries using watchability terms can retrieve indexed watchability candidates.

### Phase 1: Add Deterministic `ContentFingerprintV1`

Status: implemented for deterministic generation, storage, bounded startup backfill, explicit rebuilds, fingerprint-depth diagnostics, safe catalog metadata enrichment, and focused tests.

Deliverables:

- add a `media_content_fingerprints` table: done;
- add TypeScript types and parser/validator helpers: done;
- generate deterministic fingerprints from existing metadata: done;
- store `schemaVersion`, `fingerprintVersion`, `source`, `sourceVersion`, `inputHash`, evidence, confidence, and source-quality warnings: done;
- add richer deterministic source rules for themes, setting, era, pacing, intensity, attention demand, ratings, and safe catalog metadata: done;
- add large-catalog bulk backfill commands for production databases where the generic repository rebuild path is too slow: `npm run backfill:content-fingerprints:bulk` for fingerprint projection only, and `npm run backfill:features:bulk` when feature documents, FTS rows, deterministic mood rows, and fingerprints all need to move to the current ruleset: done;
- keep existing `media_features` and `media_mood_feature_scores` compatibility: done.

Acceptance:

- `Midnight in Paris` has a richer fingerprint than the original thin term arrays: covered by tests;
- missing or thin metadata produces lower confidence rather than false precision: implemented in source-quality fields;
- no private Plex/Seerr URLs, tokens, or poster paths appear in fingerprint JSON: covered by tests;
- deterministic search output remains compatible: fingerprints are persisted beside current search artifacts, and projected positive dimensions feed the existing mood feature index as a separate source.
- existing large catalogs can be backfilled without per-row catalog-search-index refreshes: covered by `scripts/backfill-content-fingerprints-bulk.ts`, including the `--refresh-features` path used by `npm run backfill:features:bulk`.

### Phase 2: Derive Index Rows From Fingerprints

Status: implemented for deterministic projection into the existing mood feature index, query expansion, local MovieLens Tag Genome mapping, and fingerprint-depth diagnostics.

Deliverables:

- map fingerprint dimensions into `media_mood_feature_scores`: done for deterministic `ContentFingerprintV1` rows;
- keep source/version provenance for deterministic versus catalog-rule versus future AI rows: done for the `content-fingerprint` source;
- update feature coverage diagnostics to include fingerprint depth: done;
- thread safe Wikidata aliases/countries/languages/franchises/rank facts into catalog lexical search and fingerprints: done;
- expand query and MovieLens mapping to the richer fingerprint vocabulary: done;
- add malformed namespace checks to readiness/eval tooling.

Acceptance:

- mood/tone/watchability/theme/setting/era/style/pacing/intensity/humor/romance/microgenre rows preserve namespaces: covered by tests;
- sparse metadata items do not get overconfident mood rows: projection skips negative terms and low-confidence terms;
- target eval titles improve candidate recall before AI reranking: covered by the no-AI `Midnight in Paris` retrieval test;
- index rebuilds are explicit and bounded for large catalogs.

### Phase 3: Store Search Brief, Provenance, Eligibility, And Score Trace

Deliverables:

- persist or export `SearchBriefV2`;
- record candidate provenance per selected candidate;
- record hard-filter rejection reasons for sampled or requested debug runs;
- add `ScoreTraceV2` alongside existing score buckets;
- include trace IDs in diagnostics without storing raw prompts by default.

Acceptance:

- for a failed query, a reviewer can identify whether the problem was intent, retrieval, eligibility, scoring, rerank, or feedback;
- hard filters remain enforced outside AI;
- traces avoid secrets and private URLs.

### Phase 4: Make Feedback Semantics More Durable

Deliverables:

- normalize reason taxonomy for positive and negative feedback;
- separate broad preference training, mood-term profile training, current-session similarity, and diagnostics;
- add optional contrast candidates for pairwise feedback;
- expand replay reports to show which feedback classes trained which model state.

Acceptance:

- weak/diagnostic actions cannot accidentally train mood-term profiles;
- solo and group profile isolation remains enforced;
- conflict raises review signals instead of silently swinging preferences.

### Phase 5: Strengthen AI Rerank Trace

Deliverables:

- extend rerank schema with confidence, rationale category, and deterministic-disagreement notes;
- stratify rerank candidates so the AI sees a balanced shortlist, not only the highest deterministic head;
- report AI omissions, invalid IDs, score clamps, and fallback reasons;
- preserve backend availability and request status exactly.

Acceptance:

- AI cannot add unknown titles or change availability;
- deterministic leftovers remain available when AI omits candidates;
- rerank disagreement is reviewable and bounded;
- deterministic fallback remains useful.

### Phase 6: Expand Evals

Deliverables:

- add fingerprint fixture assertions for known titles;
- add provenance and rejection-reason assertions;
- add candidate-window recall tests for titles outside the first retrieval pool;
- add score-trace sanity tests;
- add real-query-inspired golden cases as local, privacy-safe fixtures.

Acceptance:

- improvements are measured before and after AI reranking;
- latency, recall, hard-filter accuracy, and availability correctness are reported together;
- regressions are tied to a stage, not just a final rank.

### Phase 7: Add AI Fingerprint Enrichment

Deferred until deterministic fingerprints and traces are stable.

Deliverables:

- offline/batch AI enrichment that writes `ContentFingerprintV1`;
- source/version/input hash/evidence/confidence fields populated;
- no search hot-path dependency;
- review UI or admin export for enriched fingerprint diffs;
- fallback to deterministic fingerprint on missing or failed enrichment.

Acceptance:

- AI enrichment improves sparse or thin items in evals;
- enriched terms are evidence-backed and confidence-scored;
- hallucinated facts can be rejected or downgraded;
- cost, latency, and privacy impact stay outside normal search.

## What Reviewers Should Optimize For

Recommendations from external AI reviewers should preserve these constraints:

- improve candidate recall before reranking;
- make mood representation deeper without hallucinating facts;
- keep hard filters deterministic;
- keep availability/requestability exact;
- make learned preferences gradual, scoped, inspectable, and reversible;
- make AI useful for judgment and explanation, not catalog truth;
- improve evals before relying on subjective impressions.
