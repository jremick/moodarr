# Mood/Feel Profile Research And Goal

Status: north star research and product goal.
Last updated: 2026-06-17.

## Research Question

How should Moodarr represent and learn the difference between general English mood language and one user's personal meaning of that language, then use that learned "feel profile" to recommend what to watch from a known Plex/Seerr catalog?

## Core Thesis

Moodarr's durable value is not generic movie search, generic personalization, or an LLM chat box. The durable value is a translation layer between:

- what a user says they are in the mood for,
- what that wording generally means in English,
- what that wording specifically means to this user,
- what titles are actually available or requestable now.

The product should build a user-specific Feel Profile: a local, inspectable, resettable model of how the user maps words like "cozy", "dark", "weird", "light", "funny", "low commitment", or "something like X but less Y" onto media features, emotional affordances, friction tolerance, and watch context.

Current implementation note: authenticated `solo` profiles are now scoped per Plex user, while `group` intentionally selects the shared instance profile. Named companion/group profiles remain future work. Current behavior is recorded in [MoodRank Current Algorithms](MOODRANK_CURRENT_ALGORITHMS.md) and [Data And Privacy](DATA_AND_PRIVACY.md).

For the living implementation plan, see [Mood/Feel Profile Delivery Goal](MOOD_FEEL_DELIVERY_GOAL.md). For the current algorithm map, see [MoodRank Current Algorithms](MOODRANK_CURRENT_ALGORITHMS.md). For the next robustness push, see [Mood/Feel Robustness V1 Goal](MOOD_FEEL_ROBUSTNESS_V1_GOAL.md). Saved external review material lives in [Moodarr Research Records](research/README.md).

## Source Summary

Streaming services already personalize home rows and recommendations, but their public user-facing controls mostly rely on watch history, ratings, profiles, and thumbs-style feedback. Netflix says it uses viewing history, ratings, similar members, title metadata, time of day, language, devices, and watch duration to personalize recommendations: <https://help.netflix.com/en/node/100639>. Prime Video exposes thumbs up/down per profile: <https://www.primevideo.com/help?nodeId=Tgonhtd9758pRyTOIh>. Disney+ profile help describes recommendations from watch history: <https://help.disneyplus.com/article/disneyplus-profiles>.

Spotify is a useful adjacent reference because its Taste Profile beta explicitly shows users how Spotify understands taste and lets them describe adjustments: <https://support.spotify.com/us/article/your-taste-profile/>. This is closer to the control surface Moodarr should eventually provide, though Moodarr's harder problem is translating fuzzy watch-mood language against a bounded video catalog.

Modern recommender architecture supports the current MoodRank direction: candidate generation, scoring, and reranking. Google's recommender overview describes this three-stage pattern: <https://developers.google.com/machine-learning/recommendation/overview/types>. The YouTube recommender paper uses a two-stage candidate generation plus ranking architecture at scale: <https://research.google.com/pubs/archive/45530.pdf>. Netflix's foundation-model personalization work treats embeddings as reusable profile/item representations and warns about embedding freshness and session adaptiveness: <https://netflixtechblog.com/foundation-model-for-personalized-recommendation-1a0bd8e02d39> and <https://netflixtechblog.medium.com/integrating-netflixs-foundation-model-into-personalization-applications-cf176b5860eb>.

Affective modeling gives Moodarr a better baseline than free-floating tags. The NRC VAD Lexicon provides human ratings for valence, arousal, and dominance across English words, and explicitly notes demographic differences in shared affective understanding: <https://aclanthology.org/P18-1017/>. That supports the product thesis: words have broadly shared affective structure, but individual interpretation still matters.

Personalized semantic representation is a known search problem. Microsoft's PEPS paper argues that ambiguous words should have different semantic representations for different users and trains personal word embeddings from user data: <https://www.microsoft.com/en-us/research/publication/employing-personal-word-embeddings-for-personalized-search/>. Moodarr can apply the same idea to affect words and media candidates.

Movie item representation has useful precedent. MovieLens Tag Genome datasets provide tag/movie relevance scores at scale, including 15 million relevance scores across 1,129 tags in MovieLens 25M: <https://grouplens.org/datasets/movielens/>. Movie Genome research argues that text metadata alone misses audio/visual/style signals and that richer content descriptors help cold-start movie recommendation: <https://link.springer.com/article/10.1007/s11257-019-09221-y>.

Affective video recommender research is directionally aligned but often limited by small datasets, shallow emotion buckets, and non-personalized mood clustering. A 2022 survey notes hybrid systems combining collaborative, content-based, and emotion detection, but also highlights weak personalization and limited diverse datasets: <https://www.frontiersin.org/journals/neuroscience/articles/10.3389/fnins.2022.984404/full>.

LLMs are useful for interpretation, feature enrichment, explanation, and reranking, but they are not enough by themselves. A survey of LLMs for recommendation frames LLMs as feature extractors, token generators, or direct recommenders, with value in text representations and contextual understanding: <https://arxiv.org/html/2305.19860v5>. A user study on LLM conversational movie recommenders evaluated enjoyment, satisfaction, personalization, diversity, novelty, serendipity, and trust, reinforcing that conversational polish does not automatically solve personalization: <https://arxiv.org/html/2404.19093v1>.

Existing consumer solutions such as Taste and Likewise focus on taste ratings, community recommendations, AI search, or similar-user matching rather than a transparent, user-trained affect-language profile. Taste describes rating movies and shows to build a taste profile: <https://www.taste.io/about>. Likewise positions itself around personalized recommendations, AI assistance, and real-person recommendations: <https://apps.apple.com/us/app/likewise-movie-tv-book-recs/id1264195462>.

## Key Findings

1. "Mood" should be a representation problem, not just a prompt-parsing problem.
2. The baseline model should combine affect dimensions, controlled tags, semantic embeddings, reference-title neighborhoods, watchability/friction features, and availability facts.
3. The user profile should tune the meaning and weight of mood words, not only boost genres or titles.
4. Pairwise and contrastive feedback are more valuable than isolated thumbs because they reveal the user's boundary between adjacent meanings.
5. LLMs should parse, explain, enrich, and rerank inside deterministic catalog boundaries. They should not invent catalog truth, availability, or requests.
6. The profile must be gradual, inspectable, resettable, and confidence-aware so the system does not overfit one bad interaction.
7. The baseline Feel Space must be treated as a prior with provenance and confidence, not as objective truth.
8. Real robustness depends on adversarial evals, action reliability, replay/holdout logging, and evidence-conditioned profile deltas before broad user-data collection.

## Proposed Model

### 1. Baseline Feel Space

Create a shared English media-affect space that every title and query can be projected into.

Baseline dimensions should include:

- affect: valence, arousal, dominance/control;
- tone: sincere, dry, chaotic, whimsical, grounded, bleak, romantic, suspenseful;
- pacing: slow burn, propulsive, episodic, breezy, attention-heavy;
- social context: solo, together, family, date night, background, late-night;
- friction: runtime, series commitment, violence intensity, subtitle burden, content rating;
- style and texture: polished, indie, nostalgic, surreal, realistic, heightened;
- response affordance: comfort, catharsis, adrenaline, laugh, awe, melancholy, puzzle, escape.

The important design point is not that this taxonomy is perfect. It is that the same axes are used for item features, query interpretation, profile learning, diagnostics, and evals.

### 2. User Feel Profile

The Feel Profile should store user-specific deltas on top of the baseline:

- lexical deltas: how this user means "cozy", "dark", "weird", "light", "funny", "comfort", etc.;
- feature weights: which dimensions matter more for this user or context;
- friction thresholds: how much violence, runtime, subtitle burden, ambiguity, or commitment is acceptable;
- reference anchors: titles that define this user's personal meaning of recurring mood words;
- context scopes: solo, together, and later named profiles such as partner, family, or friends;
- confidence and recency: how much evidence supports each learned mapping.

This is closer to "personal word embeddings for mood language" than to a normal taste vector.

### 3. Query Translation

For each search, Moodarr should translate the query in layers:

1. Extract hard filters deterministically.
2. Map words and phrases into the baseline Feel Space.
3. Apply user-specific lexical and context deltas from the Feel Profile.
4. Retrieve candidates through lexical, semantic, mood-vector, reference-title, quality, availability, and feedback channels.
5. Score and diversify candidates with visible buckets.
6. Use the LLM only for constrained interpretation, tradeoff judgment, explanation, and refinement suggestions.

### 4. Learning Loop

The profile should update from small but meaningful feedback:

- pairwise choice: "which one better fits what you meant by cozy?";
- refinement: "more like this, less dark, shorter, not as silly";
- session feedback: open, expand, hide, thumbs, request preview, request create;
- watch outcomes where available;
- explicit profile edits later.

Single events should mostly affect session state. Durable profile updates should require repeated or high-confidence evidence.

## North-Star Goal

Build an English-only, local-first Mood/Feel Translation Engine that learns how a specific user means mood and feel words, then uses that learned profile to return a small set of available or requestable titles that the user recognizes as "what I meant".

## What Success Looks Like

For a fuzzy prompt such as "something cozy but not childish" or "dark but not miserable", the default engine should return plausible options. After calibration, the personalized engine should return options that better match this user's private meaning of "cozy" or "dark" than a generic English baseline.

A successful search session should usually end with the user opening, saving, previewing, requesting, or choosing a top-5 result without needing to rephrase the core mood. When the user does refine, the system should understand the correction as a reusable signal, not a one-off chat turn.

Hard constraints, availability, requestability, and privacy are non-negotiable. A mood win does not count if the item is unavailable when the user asked for Plex-only, violates a hard filter, leaks private data, or relies on an invented explanation.

## Success Measures

### Offline Baseline Quality

Use the existing MoodRank benchmark metrics and expand coverage.

- `preRerankRecall@100 >= 0.95`
- `Recall@10 >= 0.90`
- `NDCG@3 >= 0.75`
- `MRR >= 0.75`
- hard constraint accuracy `= 1.0`
- availability accuracy `= 1.0`
- explanation factuality violations `= 0`

The immediate benchmark target remains 75-150 curated cases, then 200+ cases.

### Personalization Lift

Add a profile-aware benchmark where the same prompt is evaluated under different synthetic or human-labeled profiles.

Core metric:

- `PersonalizationLift@3`: blind pairwise win rate of personalized results against the generic baseline for the same prompt and catalog.

Initial threshold:

- `PersonalizationLift@3 >= 0.65` on non-tie judgments after enough calibration data is provided.

Stronger threshold:

- `PersonalizationLift@3 >= 0.70` after 15-25 calibration interactions for recurring mood terms.

### Lexical Calibration

Measure whether the engine learns what the user means by specific words.

Example:

- user A means "cozy" as warm, witty, low-stakes, visually gentle;
- user B means "cozy" as slow, nostalgic, emotionally sincere, low arousal;
- user C means "cozy" as familiar rewatch energy with very low novelty.

Metrics:

- held-out pairwise prediction accuracy for target mood words;
- top-3 fit for profile-specific prompts;
- wrong-mood hide rate;
- profile confidence coverage for top recurring terms.

Initial threshold:

- held-out pairwise accuracy `>= 0.70` after 20 calibration judgments for a target term.

### Session Outcome Signals

Live telemetry should stay privacy-preserving and local by default.

Track:

- top-1/top-3/top-5 open rate;
- detail expansion rate;
- save, request preview, request create, and play/open-external rates;
- hide/dismiss rate tagged by visible reason when possible;
- refinement-after-results rate;
- repeated-query rate;
- "that is what I meant" and "wrong mood" microfeedback;
- stage latency and fallback rate.

Product signal:

- median refinements before meaningful top-5 engagement drops by at least 25% after the profile has calibration data.

### Profile Safety

The profile should improve recommendations without becoming brittle.

Guardrails:

- no single feedback event can cause a large durable vector shift;
- low-confidence terms remain close to the generic baseline;
- users can inspect and reset learned terms;
- solo and together profiles do not silently contaminate each other;
- raw prompts are not stored unless a local admin debug setting is enabled.

## Benchmark Design

### Tier 1: Generic Mood Suite

Expand the current golden suite with fuzzy mood, reference deltas, negative constraints, low-commitment requests, group context, TV commitment, requestability, and sparse metadata cases.

### Tier 2: Profile Contrast Suite

Create 10-25 explicit synthetic profiles where recurring words intentionally mean different things. The same prompt should produce different ranked results under different profiles.

Example cases:

- "cozy": low-stakes comedy vs nostalgic drama vs familiar rewatch.
- "dark": psychological tension vs moral seriousness vs horror violence.
- "weird": playful surrealism vs alienating art-house vs genre-bending comedy.
- "light": short and low attention vs emotionally gentle vs joke-dense.

Each case should include:

- profile definition;
- prompt;
- acceptable title families;
- excluded title families;
- expected personalized movement versus baseline;
- primary failure tag.

### Tier 3: Pairwise Human Taste Evals

For each prompt/profile pair:

1. Generate baseline results and personalized results.
2. Present blind candidate pairs.
3. Ask which better matches the user's intended mood and constraints.
4. Record wins, losses, ties, and reason categories.

Human labels are the canonical signal. AI judges may be used only as fast regression smoke tests.

### Tier 4: Online Calibration Evals

Run short calibration flows:

- choose between two titles for a mood word;
- mark "more like this" and "less like this";
- answer one optional clarification about friction or tone.

Then measure whether the next held-out recommendation improves against the generic baseline.

## Failure Taxonomy Additions

Add these to the current MoodRank failure taxonomy:

- `lexical_calibration_miss`: the system used the generic meaning of a word after enough profile evidence existed.
- `profile_overfit`: one or a few interactions moved the durable profile too far.
- `context_profile_miss`: solo/together/named profile boundaries were applied incorrectly.
- `feedback_learning_miss`: session feedback was captured but did not influence the next relevant query.
- `mood_axis_gap`: the taxonomy lacks an axis needed to explain a repeated user distinction.

## Implementation Guidance

1. Do not start by training a global model. Start by making the local representation and eval loop sharper.
2. Keep the current multi-stage MoodRank architecture. Add personalization as profile deltas and feature weights, not as an opaque replacement ranker.
3. Use embeddings as a substrate, but keep explicit dimensions and score buckets for explainability and evals.
4. Prioritize pairwise/contrastive feedback over generic thumbs.
5. Build profile confidence, inspection, and reset controls before aggressive durable learning.
6. Avoid camera or inferred emotion detection. The product value is understanding the user's language, not guessing their face or mood from sensors.
7. Treat imported sources such as MovieLens Tag Genome, TMDB metadata, and optional AI enrichment as baseline seeds, then let user feedback personalize from there.

## Open Questions

- What is the minimum calibration flow that feels useful rather than like setup work?
- Should profile inspection be user-facing in Finder, admin-only, or both?
- Which 20-40 mood words should become the first controlled calibration vocabulary?
- How much should requestability and discovery novelty influence "what I meant" when the local Plex library is weak?
- Should the first personalized benchmark use synthetic profiles, one real user profile, or both?
