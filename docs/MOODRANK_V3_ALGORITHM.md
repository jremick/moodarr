# MoodRank V3 Algorithm And Benchmark

Status: deterministic MoodRank V3 implementation complete for the current benchmark slice.
Benchmark date: 2026-06-15.

## Goal

MoodRank V3 should materially improve Moodarr's ability to answer the real user question: "What should I watch for this mood, context, and constraint set?"

The target is not a more complicated search box. The target is a recommendation system that can translate a fuzzy, conversational request into a small ranked set of genuinely watchable options while keeping Plex and Seerr facts exact.

Success means:

- The top 3 usually contain at least one option the user would plausibly watch now.
- Hard constraints and availability are always enforced by deterministic code.
- The AI assistant improves interpretation, judgment, explanation, and refinement without becoming the source of catalog truth.
- Every algorithm change has benchmark evidence against the current golden mood suite.

## Current Implementation

Current engine: `moodrank-v3`.

Current local eval command:

```bash
npm run eval:recommendations
```

Current result on 2026-06-15:

```json
{
  "engineVersion": "moodrank-v3",
  "result": {
    "cases": 8,
    "top3HitRate": 1,
    "top10Recall": 1,
    "preRerankRecall": 1,
    "meanReciprocalRank": 0.9375,
    "ndcgAt3": 0.7600661914223799,
    "top3AnyHitRate": 1,
    "constraintAccuracy": 1,
    "availabilityAccuracy": 1,
    "failureBreakdown": {
      "brief_parse": 0,
      "feature_gap": 0,
      "retrieval_miss": 0,
      "score_miss": 0,
      "diversity_miss": 0,
      "personalization_miss": 0,
      "availability_miss": 0,
      "constraint_miss": 0,
      "explanation_miss": 0
    },
    "failures": []
  }
}
```

This is a passing deterministic benchmark, not the end state. The fixture set is still small, so it should be expanded into a larger failure-driven suite before treating the result as strong product proof.

Detailed benchmark evidence is recorded in [MoodRank V3 Benchmark Results](MOODRANK_V3_BENCHMARK_RESULTS.md).

## Evidence Base

MoodRank V3 follows the architecture used by high-performing recommendation systems rather than relying on a single model.

- Google's recommendation guidance describes a three-stage architecture: candidate generation, scoring, and reranking.
- The YouTube DNN recommender paper uses a production-scale two-stage system: broad candidate generation followed by a richer ranking model.
- Netflix's foundation-model personalization work emphasizes reusable user and item embeddings, embedding freshness, and integrating large models into downstream recommenders rather than replacing the whole ranking stack.
- LLM recommender surveys support LLMs for semantic representation, contextual interpretation, explanations, cold-start help, and reranking.
- A conversational movie recommender user study found LLMs provide strong explanations but are weaker on personalization, diversity, and trust without strong personal context.
- LightGCN, SASRec, HSTU, and other collaborative/sequential models are powerful when interaction volume is large, but Moodarr's local-first product needs strong cold-start content understanding before those models become cost-effective.
- MMR/xQuAD-style diversity reranking remains a strong, interpretable baseline. Recent LLM diversity-reranking work found traditional greedy diversification methods can outperform zero-shot LLM reranking on several diversity metrics.
- Contextual bandits are a good later-stage learning layer for exploration and feedback adaptation, but only after baseline relevance and safety are reliable.

References:

- Google recommendation systems overview: https://developers.google.com/machine-learning/recommendation/overview/types
- YouTube DNN recommendations: https://research.google/pubs/deep-neural-networks-for-youtube-recommendations/
- Netflix foundation model integration: https://netflixtechblog.medium.com/integrating-netflixs-foundation-model-into-personalization-applications-cf176b5860eb
- LLMs for recommendation survey: https://arxiv.org/html/2305.19860v5
- LLM-enhanced reranking: https://arxiv.org/html/2406.12433v2
- LLMs as conversational movie recommenders: https://arxiv.org/html/2404.19093v1
- LightGCN: https://arxiv.org/abs/2002.02126
- SASRec: https://arxiv.org/abs/1808.09781
- HSTU generative recommenders: https://arxiv.org/abs/2402.17152
- Contextual bandits: https://arxiv.org/abs/1003.0146
- MMR diversity reranking: https://www.cs.cmu.edu/~jgc/publication/The_Use_MMR_Diversity_Based_LTMIR_1998.pdf

## Design Principles

### 1. The Assistant Interprets, It Does Not Invent

The AI assistant can parse mood, infer soft taste signals, compare tradeoffs, rerank known candidates, write explanations, and propose refinements.

It must not:

- Invent titles outside the candidate set.
- Invent Plex availability or Seerr request status.
- Override hard filters.
- Create requests.
- Use private URLs or tokens.

### 2. Candidate Recall Comes Before Ranking Taste

The reranker cannot fix missing candidates. MoodRank V3 must first retrieve a broad and diverse candidate pool, then score and compress it.

Primary diagnostic:

- If expected titles are missing before reranking, retrieval or feature representation failed.
- If expected titles are present but low-ranked, scoring or reranking failed.
- If plausible titles still feel wrong, personalization or mood modeling failed.

### 3. Mood Is A First-Class Feature Space

Mood is not just text in the prompt. It should be represented in explicit feature dimensions and embeddings.

MoodRank V3 should model:

- mood: cozy, bleak, tense, playful, warm, weird, intense, cathartic, clever, romantic.
- tone: dry, sincere, chaotic, whimsical, grounded, suspenseful, breezy.
- pacing: slow burn, propulsive, episodic, low-commitment, attention-heavy.
- occasion: solo, together, family, late-night, background, date night, short session.
- friction: runtime, content rating, violence intensity, subtitle burden, unfinished-series commitment.
- reference deltas: "like X but shorter", "like X but less dark", "Y but better".

### 4. Use Collaborative And Sequential Models Only When Data Supports Them

Graph and sequence recommenders are not the first implementation slice. They need enough interaction data to beat content-based cold-start methods.

The implementation should first capture the interaction data needed to train or approximate them later:

- impressions and ranks,
- opens,
- detail expansions,
- thumbs up/down,
- hidden items,
- request previews,
- request creates,
- refinements after result exposure,
- watch context.

### 5. Optimize For Useful Choice, Not One Perfect Answer

Movie and TV selection often involves uncertainty and negotiation. A good top 5 should include adjacent but meaningfully different options.

MoodRank V3 should balance:

- best direct match,
- safer group choice,
- higher-quality alternative,
- shorter/lower-friction option,
- requestable discovery option when requested.

## Algorithm Architecture

### Stage 1: Conversational Mood Brief

Input:

- latest user query,
- chat refinement history,
- explicit filters,
- watch context,
- session feedback,
- durable profile scope.

Output:

- `hardFilters`: media type, runtime, availability, content rating, year, excluded genres.
- `softSignals`: mood, tone, pacing, genres, era, people, style, reference titles.
- `watchability`: low commitment, group safe, family safe, intense, background friendly, attention heavy.
- `referenceDeltas`: title plus comparative modifiers.
- `profileScope`: solo, group, later named profiles.
- `requestabilityIntent`: whether Seerr options should be included.
- `ambiguity`: whether the prompt needs diverse exploration.

Implementation:

- Deterministic parser extracts obvious filters first.
- AI parser fills soft signals through a strict schema.
- Deterministic hard filters win on conflict.
- Resolved brief is returned in diagnostics and stored for evals.

### Stage 2: Mood-Enriched Item Feature Store

Each item gets a stable feature document generated from safe metadata:

- title, year, media type,
- summary,
- genres,
- cast and directors,
- runtime,
- content rating,
- ratings,
- availability group,
- request status.

Derived fields:

- `mood_terms`,
- `tone_terms`,
- `watchability_terms`,
- `friction_flags`,
- `microgenres`,
- `similarity_text`,
- `mood_vector`,
- `quality_vector`,
- `safety_vector`.

The implementation also maintains a normalized `media_mood_feature_scores` index so mood/tone/watchability lookup can be served by indexed SQL before richer scoring.

AI enrichment:

- Optional and cached.
- Uses only safe metadata.
- Produces bounded labels from a controlled taxonomy plus a few free-text microgenres.
- Never writes Plex URLs, Seerr URLs, poster paths, tokens, or private hostnames.
- Includes model name, feature version, input hash, and timestamp for reproducibility.

### Stage 3: Multi-Channel Retrieval

Retrieve 300-500 candidates before compression.

Candidate sources:

- lexical FTS over feature text,
- provider embeddings over similarity text,
- local semantic fallback vectors,
- mood-vector similarity,
- reference-title neighborhoods,
- "more like" and "less like" feedback expansion,
- durable solo/group profile vectors,
- quality and popularity buckets,
- availability/requestability buckets,
- Seerr augmentation when local recall is weak or requestable content is requested.

Retrieval should keep source attribution per candidate so evals can explain what failed.

### Stage 4: Feature-Aware Scoring

Score every retrieved candidate with independent buckets:

- `constraint`: hard filter satisfaction and confidence.
- `mood`: match to requested mood/tone/watchability.
- `semantic`: embedding similarity.
- `lexical`: direct term/title/person/genre fit.
- `reference`: similarity to reference titles plus requested deltas.
- `taste`: solo/group/named-profile preference fit.
- `profile`: matched user-specific meaning for calibrated mood/feel words.
- `feedback`: session more-like and less-like signals.
- `availability`: Plex and Seerr state.
- `quality`: normalized critic/audience/user ratings.
- `friction`: runtime, intensity, commitment, content rating.
- `novelty`: avoid repeated or hidden items.
- `diversity`: contribution to a varied final set.

The final score should be explainable as a weighted blend. Weights should vary by watch context and request type, but hard filters remain binary gates.

### Stage 5: Deterministic Diversity Pass

Apply MMR or xQuAD-style reranking before the assistant receives candidates.

Inputs:

- relevance score,
- mood vector,
- genre/microgenre aspects,
- availability group,
- media type,
- runtime/commitment bucket.

Behavior:

- Keep the strongest direct match.
- Penalize near-duplicates in the shortlist.
- Preserve requested availability buckets.
- Increase diversity when query ambiguity is high.
- Reduce diversity pressure when the user asks for a narrow target.

### Stage 6: Constrained AI Reranking

The assistant receives:

- resolved mood brief,
- 20-40 candidates,
- score buckets,
- safe candidate metadata,
- session feedback examples,
- diversity intent.

The assistant returns:

- ranked candidate IDs,
- fit scores,
- one-sentence explanations,
- follow-up refinement options,
- optional tradeoff tags such as "best direct fit", "safer group pick", or "shorter option".

Post-processing:

- Drop unknown IDs.
- Clamp scores.
- Reapply hard filters.
- Preserve backend availability.
- Merge deterministic leftovers.
- Run a final light diversity pass if the assistant collapses the list.

### Stage 7: Feedback And Online Improvement

Feedback is separated into session and durable layers.

Session feedback:

- immediately shapes the next query/refinement,
- hides disliked items,
- boosts more-like neighborhoods,
- does not mutate durable profile too aggressively.

Durable profile:

- updates solo/group/named profile vectors gradually,
- stores explainable feature weights,
- supports reset and inspection,
- never stores raw prompts unless a local admin debug toggle is enabled.

Later contextual-bandit layer:

- reserves one exploratory slot only when confidence is low or query is broad,
- uses conservative exploration so the main ranked list stays useful,
- learns from opens, likes, hides, request previews, and request creates.

## Benchmark And Evaluation Design

### Eval Tiers

#### Tier 0: Safety And Regression

Runs in normal verification.

Required:

- hard filter accuracy: `1.0`,
- availability accuracy: `1.0`,
- no unknown IDs from AI output,
- no token/private URL leakage in feature docs, prompts, telemetry, or client assets,
- deterministic fallback works with AI disabled.

#### Tier 1: Golden Mood Evals

Target: 75-150 curated cases in the first serious benchmark, then 200+.

Case categories:

- fuzzy mood: "something cozy but not childish";
- emotional state: "tired, low commitment, still funny";
- reference title: "like Stardust but shorter";
- reference delta: "like The Do-Over but actually good";
- negative constraints: "not animated", "nothing too dark";
- group context: "for us tonight";
- requestability: "show requestable options if Plex is weak";
- TV commitment: "short series we can start";
- ambiguity: "something weird and fun";
- sparse metadata and bad catalog rows.

Metrics:

- `preRerankRecall@100`,
- `Recall@10`,
- `NDCG@3`,
- `MRR`,
- `Top3AnyHit`,
- hard constraint accuracy,
- availability accuracy,
- excluded item violation count,
- source coverage by retrieval channel.

Initial acceptance thresholds:

- `preRerankRecall@100 >= 0.95`,
- `Recall@10 >= 0.90`,
- `NDCG@3 >= 0.75`,
- `MRR >= 0.75`,
- hard constraint accuracy `= 1.0`,
- availability accuracy `= 1.0`.

#### Tier 2: Pairwise Taste Evals

Use blind pairwise judgments to compare `hybrid-v2` and MoodRank V3.

For each prompt:

- sample top candidates from both engines,
- create candidate pairs,
- ask which better fits the mood and constraints,
- record wins, losses, ties, and reason categories.

Judges:

- human labels for canonical set,
- optional AI judge for fast regression only,
- disagreement routed to human review.

Acceptance target:

- MoodRank V3 wins at least `65-70%` of non-tie pairwise judgments against `hybrid-v2`,
- zero hard-filter or availability regressions.

#### Tier 3: Live Local Feedback

Privacy-preserving telemetry should measure:

- top 1/top 3/top 5 open rate,
- detail expansion rate,
- thumbs up/down rate,
- hide/dismiss rate,
- request preview rate,
- request creation rate,
- refinement-after-results rate,
- repeated-query rate,
- latency by stage,
- AI fallback rate.

Session success proxy:

- user opens, likes, previews, requests, or meaningfully engages with a top-5 result without immediately refining away from the result set.

## Failure Taxonomy

Each failed eval should be tagged with one primary failure type:

- `brief_parse`: query intent or hard/soft signal parsed incorrectly.
- `feature_gap`: item metadata lacks needed mood/watchability representation.
- `retrieval_miss`: expected title absent before reranking.
- `score_miss`: expected title present but scored too low.
- `diversity_miss`: top list collapses into near-duplicates.
- `personalization_miss`: objectively plausible but wrong for the profile/context.
- `availability_miss`: Plex/Seerr state wrong.
- `constraint_miss`: hard filter violated.
- `explanation_miss`: explanation cites unsupported facts or repeats low-value metadata.

The benchmark should report failures by taxonomy so implementation work stays directed.

## Implementation Status

MoodRank V3 has been implemented in measurable deterministic slices. Future changes should still be driven by failing eval cases or clearly labeled benchmark coverage gaps.

### Slice 1: Benchmark Harness Expansion

Status: implemented.

Delivered:

- add richer golden case schema with graded relevance,
- add NDCG@k and source-coverage metrics,
- add failure taxonomy fields,
- add pre-rerank candidate recall tracking,
- add documented eval report output.

Verification:

- current 8 cases pass,
- benchmark report includes ranking metrics and failure taxonomy,
- no AI key required for deterministic evals.

### Slice 2: Mood Taxonomy And Feature Enrichment

Status: implemented for deterministic feature generation; optional AI enrichment remains future work.

Delivered:

- define controlled mood/tone/watchability/friction taxonomy,
- cache deterministic features with feature version,
- populate indexed mood/tone/watchability scores from deterministic features,
- add source-versioned JSON/JSONL seed import support,
- add no-secret/no-private-URL tests,
- backfill features safely.

Verification:

- feature rows include mood/tone/watchability coverage,
- deterministic fallback remains available,
- evals show improved pre-rerank recall on mood cases.

### Slice 3: Mood And Friction Scoring

Status: implemented.

Delivered:

- add explicit `mood`, `reference`, and `friction` score buckets,
- separate quality from "better than reference" logic,
- make weights context-aware for solo/group/requestable/low-commitment searches,
- expose score breakdown in diagnostics.

Verification:

- pairwise taste evals improve over baseline,
- hard constraints and availability remain perfect.

### Slice 4: Diversity Reranking

Status: implemented.

Delivered:

- implement deterministic MMR or xQuAD-style reranker,
- use query ambiguity to tune relevance-vs-diversity pressure,
- protect high-precision top slots on targeted mood/reference prompts,
- expose diversity score contribution.

Verification:

- lower intra-list similarity without reducing Recall@10 below threshold,
- top 5 includes distinct useful choices on broad mood prompts.

### Slice 5: Constrained AI Reranker Upgrade

Status: future work.

Deliverables:

- pass resolved brief and score buckets to AI reranker,
- use listwise ranking plus optional pairwise checks for close candidates,
- return tradeoff tags,
- add position-bias mitigation by shuffling or stable candidate framing in eval mode.

Verification:

- no unknown IDs,
- no hallucinated availability,
- pairwise win rate beats deterministic V3 and `hybrid-v2`.

### Slice 6: Feel Profile And Feedback Learning

Status: partially implemented for synthetic Feel Profile scoring, persisted solo/group term weights, live profile scoring, structured feel feedback events, admin diagnostics/reset API, and synthetic personalization evals. Named profiles, richer profile UI, human-labeled evals, and bandits remain future work.

Deliverables:

- add profile-aware benchmark cases and `PersonalizationLift@3`,
- expand preference vectors from feedback,
- capture structured feel signals from web and future iOS clients,
- add named companion/group profiles,
- add profile inspection/reset controls,
- add conservative exploratory slot for broad/low-confidence prompts.

Verification:

- same prompt can rank differently under different profile definitions,
- feedback affects the next run,
- feel signals are stored without raw prompt text by default,
- solo/group/named profiles do not bleed into each other,
- live feedback report shows improvement over time.

## Reporting Standard

Every recommendation algorithm PR should include:

- engine version,
- changed stages,
- eval command,
- baseline result,
- new result,
- failures added or resolved,
- latency impact,
- fallback behavior,
- privacy/security notes.

Do not claim the engine is better from anecdotes alone. Anecdotes become new eval cases; eval cases drive changes.
