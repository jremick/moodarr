# MoodRank And Search: Human Review Guide

Status: simplified explanation of the current implementation, with target improvements called out separately.
Last updated: 2026-07-02.

## Purpose

This guide explains Moodarr search in plain language: how MoodRank scores items, how it finds nearby mood candidates, how a search/refinement works, and how feedback can gradually change future ranking.

For a deeper implementation packet to give another AI reviewer, see [MoodRank Agent Review Packet](MOODRANK_AGENT_REVIEW_PACKET.md). For the shorter engineering reference, see [MoodRank Current Algorithms](MOODRANK_CURRENT_ALGORITHMS.md). For agreed next improvements, see [MoodRank Improvement Decisions And Target Plan](MOODRANK_IMPROVEMENT_PLAN.md).

## The Short Version

MoodRank is not one model and not just keyword search. It is a staged recommendation process:

1. Keep Plex and Seerr/Jellyseerr as the sources of truth for availability and requestability.
2. Convert every known title into searchable feature text, mood terms, tone terms, watchability terms, and vectors.
3. Translate the user's request into hard filters and soft mood signals.
4. Gather a broad candidate window from text search, mood indexes, semantic similarity, reference titles, feedback, catalog rank, quality, and availability.
5. Score each eligible candidate with independent buckets like query fit, mood fit, semantic fit, availability, quality, friction, feedback, and learned preference.
6. Apply diversity so the list does not become a cluster of near-duplicates.
7. Optionally ask the configured AI model to rerank a bounded shortlist and write better explanations/refinement options.

The model can improve interpretation and explanation, but catalog facts and hard filters stay in deterministic code.

## A Concrete Example: Midnight in Paris

In the 2026-07-02 local review snapshot, `Midnight in Paris` was present as a live Plex movie row. The exact rank can change after catalog syncs, feature rebuilds, preference learning, or AI reranking, but the example shows how the current deterministic no-AI path explains a candidate.

The useful non-secret metadata looked like this:

- title/year/type: `Midnight in Paris`, 2011 movie;
- runtime and rating: 94 minutes, `PG-13`;
- availability: available in Plex;
- genres: `Comedy`, `Fantasy`;
- ratings: critic `7.6`, audience `7.5`;
- summary: a nostalgic screenwriter in Paris mysteriously goes back to the 1920s at midnight;
- people: Kathy Bates, Owen Wilson, Rachel McAdams, Woody Allen;
- generated feature terms: mood `funny`, `magical`; tone `clever`; watchability `low-commitment`, `background-friendly`, `group-friendly`, `shared-screen`, `in-plex`.

For a query like:

```text
clever magical low-commitment comedy already in Plex for a group
```

the no-AI search path ranked `Midnight in Paris` 4th out of the returned results, with a score of `70`. Its score buckets were:

```text
query 64
semantic 43
mood 100
taste 72
preference 50
feedback 50
availability 100
quality 76
friction 100
novelty 80
rankIndex 62
diversity 88
```

That is the practical meaning of "candidate probability" in MoodRank. The code does not produce a calibrated probability such as "73% likely to be chosen." It builds evidence that makes the movie more or less likely to enter the candidate window and rank near the top.

For `Midnight in Paris`, the strong signals are:

- it is already in Plex, so the availability bucket is very high;
- it is short enough for low-commitment viewing, so friction is very high;
- the stored features match `magical`, `funny`, `clever`, and group-friendly language;
- its `Comedy` and `Fantasy` genres match the prompt;
- its ratings provide a decent quality signal.

The weaker signal is semantic similarity. The summary talks about Paris nostalgia and 1920s time travel, not literally "low-commitment comedy for a group." That means it can rank well for this mood, but another item with more direct wording or stronger semantic overlap could outrank it.

If the query changed to `dark thriller not scary`, the same metadata would work against it: `Comedy`, `Fantasy`, `funny`, `magical`, and low-friction watchability would not match the requested mood. If the query changed to `romantic Paris time travel comedy`, the title, summary, genre, and semantic signals would become more helpful.

Trace summary:

- Candidate provenance: surfaced through mood/watchability terms, genre/title text, availability, and catalog/rank signals.
- Eligibility: included because it is a live Plex movie row, has usable metadata, is not hidden, and matches the query's availability/runtime context.
- Weakness: semantic similarity is only moderate because the summary does not literally say "low-commitment group comedy."
- Rerank implication: with AI enabled, this candidate could move up or down; the model can judge fit among provided candidates but cannot add a missing candidate or change availability.

## 1. How MoodRank Works

MoodRank turns a fuzzy request such as "cozy, funny, low-commitment fantasy for us tonight" into a ranked watch list.

The important stages are:

- Catalog truth: Plex says what is available locally. Seerr/Jellyseerr says what can be requested or is already requested. MoodRank does not invent those facts.
- Feature documents: each item gets a safe local profile built from title, summary, genres, people, runtime, content rating, ratings, and availability. This produces searchable text plus mood/tone/watchability tags.
- Brief parsing: the request is split into hard filters and soft signals. "Movie under two hours" is a hard filter. "Cozy" or "weird" is usually a soft mood signal unless the user makes it strict.
- Candidate retrieval: the engine gathers a candidate window from several sources instead of trusting one search method.
- Rank index: the engine builds a light per-search prior from the retrieval sources. This helps items that appear near the top of multiple channels without letting that prior dominate.
- Deterministic scoring: each candidate gets 0-100 score buckets for query, semantic similarity, mood, reference title fit, taste, learned preference, direct feedback, availability, quality, friction, novelty, rank-index prior, and diversity.
- Reranking: when AI is enabled and useful, the model receives only known candidates and safe metadata. It can reorder and explain candidates, but it cannot add new titles or override availability.

The final score is mostly a weighted blend of deterministic buckets. Solo and group searches use different weights. Group mode gives more weight to broad watchability, availability, and lower friction.

## 2. How MoodRank Finds Close Mood Candidates

"Close mood" does not mean one exact tag match. MoodRank looks for overlap across several signals:

- Mood feature index: indexed labels like `mood:cozy`, `tone:clever`, `watch:low-commitment`, and similar tags.
- Semantic vectors: local vectors and optional provider embeddings compare the request to each item's feature text.
- Lexical search: direct title, genre, person, and summary matches still matter.
- Mood lexicon expansion: words such as cozy, warm, low-commitment, weird, tense, romantic, and dark expand into nearby terms.
- Reference titles: "like Stardust" tries to find titles near the reference by genre, people, summary overlap, and feature similarity.
- Feedback examples: "more like this" and "less like this" compare candidates against item feature vectors from current or prior feedback.
- Availability and friction: the engine prefers choices that are actually usable for the user's context, especially in group mode.

The current code does not score an unlimited huge catalog on every search. It builds a selected rank-index candidate window with a target between 1,000 and 3,000 items depending on library size, then scores that window. Catalog-only titles from sources such as Wikidata are normally not eligible until Plex or Seerr verifies them, but high-ranking catalog-only candidates can be checked against Seerr in a bounded verification pass.

## 3. What Happens When A User Searches

At a high level:

1. The client sends `/api/search` with the query, filters, result limit, watch context, and optional feedback context.
2. The backend optionally rewrites long conversational input into a cleaner reusable search query.
3. The backend parses the request into hard filters and soft signals.
4. Retrieval gathers candidate IDs from several channels: text search, catalog search, hard-filter candidates, provider embeddings, mood index hits, reference IDs, catalog rank, and availability buckets.
5. Candidate metadata and feature rows are loaded.
6. Candidates are scored and diversified.
7. If local results are weak, requestable content is requested, or availability coverage is too narrow, the engine may run bounded Seerr augmentation and then rerun retrieval/scoring.
8. If AI reranking is enabled and warranted, the top deterministic candidates go through the model.
9. The response returns one ordered `results` list plus availability group views: available in Plex, requestable, already requested, partially available, and unavailable.

Search refinements are not hidden server-side conversation state. The web client appends a follow-up line to the prior query, applies any filter changes it can detect, and submits a new `/api/search` request. The backend treats that as a new search, plus any provided feedback context.

The refinement buttons returned by the server are just ready-to-send prompts such as "Only in Plex", "Less intense", "More like [top title]", or "Shorter picks".

## 4. How The AI Rerank Works

AI reranking happens after deterministic retrieval and scoring. It is not the first search step.

The deterministic engine first finds and scores candidates. Then `selectRerankCandidates()` takes up to 100 of the strongest deterministic candidates. The current OpenAI reranker serializes up to 60 of those into the model request.

For each candidate, the model sees safe fields such as:

- ID;
- title;
- media type;
- year;
- runtime;
- genres;
- summary;
- content rating;
- critic/audience/user ratings;
- availability group and explanation;
- deterministic score;
- deterministic score breakdown;
- deterministic explanation;
- Seerr status and request status.

It also sees the user query, resolved filters, watch context, preferred examples, liked examples, and disliked examples.

The model must return structured JSON:

- a short summary;
- 3 to 5 refinement options;
- rankings made only of provided candidate IDs;
- a 0-100 score for each ranked candidate;
- a three-sentence explanation for each ranked candidate.

The backend then checks the response:

- unknown IDs are ignored;
- duplicate IDs are ignored;
- scores are clamped to 0-100;
- the item keeps backend availability and request status;
- candidates the model omitted are appended as deterministic leftovers;
- the combined list is sorted by score and sliced to the requested result limit.

The implications:

- AI can improve taste judgment among candidates it receives.
- AI can write more natural explanations and refinements than the deterministic fallback.
- AI cannot rescue a good movie that retrieval never placed in the deterministic shortlist.
- AI currently sees up to 60 serialized candidates, even though the deterministic rerank shortlist can contain 100.
- AI can change ordering and scores, so deterministic bucket scores become inputs rather than final authority.
- When AI reranking is used, the displayed `score` may be the AI-calibrated relevance score while the score breakdown remains the deterministic evidence that got the candidate shortlisted.
- AI cannot make a missing movie requestable, mark something as in Plex, or create a request.
- If the model call fails, times out, or AI is disabled, the deterministic ranking is returned.
- Because the model receives summaries and genre/rating metadata, weak or misleading metadata can still affect its judgment.

## 5. How Learned Preferences Work

Moodarr currently has three related feedback layers.

### Immediate Search Feedback

When a user marks items as more-like, less-like, preferred examples, or hidden, those IDs can be sent in the next `/api/search` request. That changes the next result set immediately:

- hidden items are excluded;
- more-like and preferred examples boost similar items;
- less-like examples push similar items down.

`maybe` items can be accepted and stored as recommendation feedback, but today they are not treated as a positive or negative ranking signal in the same way as preferred, more-like, less-like, or hidden items.

### Durable Preference Weights

The app also stores broad preference weights separately for `solo` and `group`. These are feature weights such as:

- media type;
- genre;
- mood term;
- tone term;
- watchability term;
- runtime bucket;
- content rating bucket.

Positive actions nudge those weights up. Negative or hidden actions nudge them down. The weights are bounded so one action cannot dominate future searches.

### Feel Profile Learning

Feel Profile learning is term-specific. It tries to learn what a recurring word means to this user in a context. For example, "cozy" might learn toward "witty, warm, low-stakes comedy" for one person and "magical adventure comfort" for another.

This only applies when:

- feedback includes a mood term, such as `cozy`, `dark`, `weird`, or `light`;
- the action is reliable enough;
- the query later contains that calibrated term;
- the active context matches, such as `solo` versus `group`.

The system stores positive and negative evidence, confidence, conflict score, profile version, and checkpoints. Mixed evidence reduces confidence instead of letting the profile swing wildly. Every tenth eligible profile signal is held out from learning so replay evaluation can check whether learning would have helped.

In scoring, the learned profile influences the normal preference bucket and also adds a small bounded profile delta to the final score. It is meant to move close candidates, not replace the user's actual query.

## What This Means For Human Review

The system is strongest when:

- the catalog metadata is rich enough to describe mood and watchability;
- candidate retrieval does not miss plausible options;
- hard filters are correct;
- explanations make the tradeoffs clear;
- feedback improves the next search without overreacting.

The biggest review questions are:

- Are the selected candidate windows broad enough for the current catalog size?
- Do the mood/tone/watchability features reflect how people actually describe what they want to watch?
- Are the score weights too hand-tuned, or are they still the right transparent baseline?
- Does feedback make future searches better without creating weird personal-profile drift?
- Do evals prove improvement on real mood-search behavior, not only synthetic cases?

## What We Decided To Improve Next

The current feature terms are useful, but they are thin. `Midnight in Paris` proves the point: `funny`, `magical`, `clever`, and `low-commitment` help, but they do not fully capture nostalgia, Paris, 1920s time travel, literary fantasy, wistful romance, or breezy group watchability.

The first implementation steps are now in place: Moodarr stores a deterministic `ContentFingerprintV1` JSON record beside the older feature document, then projects positive, confident fingerprint dimensions into the existing mood feature index. That gives us evidence-backed dimensions for review and lets searches like `nostalgic time travel in Paris 1920s` retrieve candidates through `theme:nostalgia`, `theme:time-travel`, `setting:paris`, and `era:1920s` without needing AI rerank.

The deterministic fingerprint is now deeper than the first slice. It can recognize more durable content shape from existing metadata: themes like grief, family, found family, investigation, revenge, survival, politics, war, music, sports, holiday, and road trip; settings like Paris, New York, London, Los Angeles, space, small town, ocean, wilderness, school, workplace, rural, and urban; era clues like 1920s, 1980s, future, medieval, Victorian, and release decade; and viewing texture like slow-burn, propulsive, breezy, easy-watch, attention-heavy, scary, violent, gentle, well-liked, group-friendly, and mainstream-friendly.

It also uses safe imported catalog facts when they exist. For example, a Wikidata record can add country, language, franchise, award count, sitelink count, and metadata confidence as low-confidence context. Those facts can help candidate probability for searches like `French-language award-recognized fantasy` or `familiar franchise world`, but they do not change Plex/Seerr availability truth.

What is still not included: TMDB/Seerr keywords and TMDB collection metadata. The current Seerr table only stores IDs, status, requestability, and URL, so keyword/collection enrichment needs a later persistence/import pass before ranking can use it.

The broader agreed target is to add:

- a richer content fingerprint JSON with mood, tone, theme, setting, era, style, pacing, intensity, humor, romance, microgenre, watchability, evidence, confidence, and source-quality fields: implemented for the deterministic non-AI pass;
- candidate provenance so we know why an item entered the search window;
- score traces so bucket scores can be reviewed from raw evidence through final contribution;
- explicit eligibility and rejection reasons for hard-filter failures;
- more precise feedback semantics so actions like opening, maybe, liking, hiding, wrong mood, and pairwise picking do not all train the system the same way;
- a stronger AI rerank contract with confidence, rationale category, and visible disagreement with deterministic ranking;
- richer evals that check fingerprints, provenance, rejection reasons, selected-window recall, scoring traces, and deterministic-vs-AI behavior.

AI fingerprint enrichment is intentionally deferred. First we should build the deterministic fingerprint and trace structure, then let AI fill the same schema in a later offline/batch pass.
