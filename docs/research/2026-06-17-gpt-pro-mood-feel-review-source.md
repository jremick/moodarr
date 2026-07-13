[2026-06-17]

## Scope note

I have not inspected the actual `feelerr-app` repository. This is a design, algorithm, evaluation, and product-signal review based on your system description, file map, eval snapshot, and current external research.

# 1. Executive verdict

## Is the core algorithm direction sound?

**Yes, but only if MoodRank V3 is treated as a calibrated interpretation system, not a normal recommender.** The staged architecture is directionally right: candidate generation, scoring, and re-ranking are consistent with mainstream recommender architecture, including Google’s recommendation overview and YouTube’s two-stage candidate/ranking system. ([Google for Developers][1])

The product’s differentiator is stronger than “recommend good films.” It is: **learn the user’s private semantic mapping from mood language to media features**. That is a credible niche because personalized search research explicitly shows that words can have user-specific semantic representations, especially ambiguous words. ([Microsoft][2])

## Strongest part

The strongest part is the **bounded, local-first, catalog-grounded pipeline**:

* Plex/Seerr remain the source of truth.
* AI cannot invent titles or availability.
* Retrieval is broad and hybrid.
* Scoring is inspectable by bucket.
* Profile learning is separated from broad preference learning.
* Term-specific personalization is bounded rather than allowed to dominate all facts.

That is the right architecture for a privacy-sensitive, single-user product.

## Most fragile part

The most fragile part is **not the profile bucket itself**. It is the combination of:

1. **A deterministic baseline Feel Space that may encode weak or wrong mood labels.**
2. **Synthetic evals that are too aligned with the implementation.**
3. **Ambiguous product feedback that can corrupt term meaning.**
4. **Sparse metadata and noisy summaries that may make “feel” look more precise than it is.**

The current eval numbers are encouraging as a machinery test, but they do not yet prove real mood satisfaction. YouTube’s paper is especially relevant here: large recommender systems can overfit surrogate objectives, and even choosing the right surrogate problem is described as partly empirical and fragile.

## What I would change before real users generate data

Before collecting real usage, I would add:

1. **Confidence-aware profile learning**
   Profile deltas should grow only with evidence quality, evidence count, and cross-session consistency.

2. **Adversarial evals with failure taxonomy**
   The eval should show failures by type: negation, comparative language, sparse metadata, availability, ambiguity, group context, drift, and over-personalization.

3. **Pairwise and reason-chip feedback**
   “This is closer to what I mean by cozy” is far more useful than “opened result card.”

4. **Holdout and replay infrastructure**
   Store displayed slates, score buckets, profile versions, and action classes locally so you can evaluate whether profile changes would have improved later decisions.

5. **Profile rollback/export/reset and per-term confidence UI**
   Users should be able to see and edit what Moodarr thinks “dark” or “cozy” means for them.

# 2. Research synthesis

## Staged recommender systems

Google’s recommendation overview describes a common three-stage structure: candidate generation, scoring, and re-ranking. Candidate generation narrows a large corpus, scoring ranks the smaller set, and re-ranking can account for diversity, freshness, and business or product constraints. ([Google for Developers][1])

YouTube’s DNN recommender follows a similar two-stage architecture: candidate generation retrieves a small set from a huge corpus, then a ranking model scores those candidates. The YouTube paper also highlights practical issues that matter for Moodarr: freshness, noisy implicit feedback, context features, and the danger of optimizing the wrong proxy.

**Fit for Moodarr:** high. MoodRank V3’s staged pipeline is the right skeleton.

**Premature for Moodarr:** large-scale DNN candidate generation, massive user embeddings, and industrial-scale sequence modelling. Moodarr is a local-first, single-user system; the data regime is the opposite of YouTube.

## Foundation models for recommendation

Netflix has described foundation-model work for personalized recommendation as a way to centralize preference learning from rich member histories and content data. A companion Netflix TechBlog article discusses production integration options such as using embeddings, subgraph integration, and fine-tuning, while noting issues such as embedding refresh and staleness. ([Netflix Tech Blog][3])

**Fit for Moodarr:** the conceptual lesson is useful: keep a reusable preference representation and track representation staleness.

**Premature for Moodarr:** training or fine-tuning a large recommender foundation model. The local-first, single-user data regime does not justify it yet.

## Tag genome systems

The MovieLens Tag Genome is highly relevant. The 2021 Tag Genome dataset contains computed tag-movie relevance scores across thousands of movies and over a thousand tags. ([GroupLens][4]) The README describes the core idea: representing movies by how strongly they exhibit properties such as “quirky,” “visually appealing,” or “cerebral,” with relevance values between 0 and 1. It also warns that obscure movies have fewer raw tags, so their tag relevance may be less accurate. ([GroupLens Files][5])

**Fit for Moodarr:** very high. Moodarr’s baseline Feel Space is essentially a local, deterministic, English-only Tag Genome analogue.

**Main warning:** do not confuse **item tag relevance** with **user term meaning**. “This film is 0.8 dark” and “Jarel means grounded noir when he says dark” are different layers.

## Implicit feedback

Hu, Koren, and Volinsky’s classic implicit-feedback paper is directly relevant. It stresses that implicit signals are noisy, lack direct negative feedback, and often indicate confidence rather than preference. For example, a user not watching something does not prove dislike, and a high interaction count may reflect exposure or habit rather than preference. ([Chris Volinsky][6])

**Fit for Moodarr:** high. Moodarr should use implicit events, but with reliability weights.

**Critical implication:** `open`, `expand`, `save`, and `request_preview` should not directly update mood meaning unless paired with stronger evidence.

## Personalized search and personal word meaning

Microsoft’s personal word embeddings research argues that personalized search often requires user-specific semantic representations of words; the paper uses ambiguous terms such as “Apple” as an example of why a single generic embedding is insufficient. ([Microsoft][2])

**Fit for Moodarr:** extremely high. This supports the core hypothesis that “cozy,” “dark,” “weird,” and “light” should become user-specific terms.

**Practical translation:** Moodarr should learn **residual meaning**: how the user’s usage of a term deviates from generic English and from the app’s baseline Feel Space.

## Affective lexicons

The NRC Valence, Arousal, and Dominance lexicon provides VAD ratings for more than 20,000 English words and treats valence, arousal, and dominance as primary affective dimensions. The paper also reports demographic differences in affect ratings. ([ACL Anthology][7])

**Fit for Moodarr:** useful as weak prior features for terms and descriptions.

**Insufficient alone:** VAD can distinguish “calm” from “intense,” but it will not learn that one user’s “dark” means psychological mystery while another’s means supernatural horror.

## Conversational recommenders

Conversational recommender research frames natural-language interaction as a way to elicit explicit preferences over multiple turns. Surveys identify preference elicitation, dialogue understanding, exploration-exploitation, and evaluation as central challenges. ([Xiangnan He's Homepage][8]) Evaluation remains difficult because conversation-level success is not independent item ranking; human assessment, online evaluation, and user simulation are often needed. ([Xiangnan He's Homepage][8])

**Fit for Moodarr:** high, but Moodarr should stay lightweight. It does not need a full chat recommender. It needs targeted clarification and pairwise mood calibration.

**Premature:** open-ended dialogue agents that ask many questions. That would violate the product constraint that users should not complete a long onboarding quiz.

## Contextual bandits

Contextual bandits are useful when a system must balance exploration and exploitation from partial feedback. Li et al.’s Yahoo! news work showed contextual bandits adapting recommendations from clicks at large scale. ([Microsoft][9]) Offline evaluation is hard because logs only contain feedback for displayed items; unbiased replay depends on randomized logging or known propensities. ([arXiv][10])

**Fit for Moodarr:** medium, later. A bandit-lite approach can help choose uncertain calibration cards.

**Premature:** treating all user interactions as bandit rewards before logging propensities, slate context, and reward definitions.

## User controls for taste profiles

Spotify’s Taste Profile controls are a relevant product precedent: Spotify exposes how it understands taste and gives users controls to adjust recommendations, while noting the controls are not absolute “always show” or “never show” commands. ([Spotify][11])

**Fit for Moodarr:** high. Moodarr should expose “what the app thinks you mean by this term” and let users correct it.

# 3. Algorithm critique

## Baseline Feel Space representation

### What is good

The deterministic feature document and mood feature index are practical and inspectable. They allow Moodarr to:

* Work locally.
* Avoid opaque third-party inference.
* Rebuild features deterministically by `feature_version`.
* Explain why a candidate matched.
* Keep AI reranking constrained to known candidates.

This is the right foundation.

### Main risks

| Risk                         | Why it matters                                                                                         | Fix                                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| **False precision**          | A deterministic label like `mood:cozy = 0.82` may look objective even if extracted from weak metadata. | Store feature provenance and confidence.                  |
| **Sparse metadata collapse** | Long-tail or obscure titles may get weak mood vectors, causing popularity or metadata richness bias.   | Add sparse-feature confidence and fallback neighborhoods. |
| **Genre shortcutting**       | “Dark” may become horror/thriller; “light” may become comedy; “weird” may become arthouse.             | Add adversarial evals that decouple mood from genre.      |
| **Summary contamination**    | Marketing copy can misrepresent feel.                                                                  | Use multiple fields and confidence, not summary alone.    |
| **Term conflation**          | `dark comedy`, `dark`, `not too dark`, and `dark visually` are different meanings.                     | Improve intent parsing and compositional handling.        |

The baseline Feel Space should be treated as **a prior, not truth**.

## User-specific term profile approach

The term-specific Feel Profile is the most strategically important idea in the system. It directly addresses the product’s North Star.

The right mental model is:

> Generic Feel Space estimates what a title is like.
> Feel Profile estimates what the user means when using a word.
> Ranking uses the interaction between the two.

The current synthetic profiles are good seed tests because they prove same-term/different-meaning machinery. But the profile needs stronger treatment of:

* **Confidence:** how much evidence supports this term shape?
* **Context:** solo and group should be distinct, but not totally isolated.
* **Composition:** “dark but cozy,” “weird but not alienating,” “like this but less bleak.”
* **Drift:** user meanings change by season, stress level, household context, or recent viewing.
* **Negative evidence:** “wrong mood” is more informative than many implicit positives.

## Bounded profile-score delta

The bounded delta is directionally correct. It prevents personalization from overriding hard facts.

However, I would change the bound from a static product rule into an **evidence-conditioned bound**:

| Profile state                         | Recommended behaviour                                                 |
| ------------------------------------- | --------------------------------------------------------------------- |
| No evidence                           | No profile delta or tiny prior-only delta.                            |
| 1–2 clear signals                     | Small delta; explain low confidence.                                  |
| 3–5 consistent signals                | Moderate delta; can reorder close candidates.                         |
| 6+ consistent signals across sessions | Larger delta; can defeat generic mood scoring but never hard filters. |
| Conflicting recent signals            | Shrink delta and ask calibration question.                            |
| Context mismatch                      | Apply only weak transfer from solo to group or group to solo.         |

The profile bucket should not always be “centered at 50 with bounded delta” in the same way. It should be **centered, bounded, and uncertainty-aware**.

## Feedback-to-profile learning rule

Current behaviour is appropriately conservative: clear positive, negative, hidden, or pairwise actions update durable preferences; weak actions remain diagnostic.

That said, the current action list mixes very different semantic meanings:

| Action                       | Likely interpretation                    | Training use                                   |
| ---------------------------- | ---------------------------------------- | ---------------------------------------------- |
| `right_mood`                 | Direct mood fit                          | High-confidence term-profile update            |
| `wrong_mood`                 | Direct mood miss                         | High-confidence negative term-profile update   |
| `pairwise_pick`              | Relative mood/taste preference           | High-confidence pairwise update                |
| `more_like` / `less_like`    | Directional similarity                   | Medium/high if tied to current prompt          |
| `hide`                       | Strong negative, but reason-dependent    | High if reason captured                        |
| `save`                       | Interest, not necessarily mood fit       | Medium only with context                       |
| `request_create`             | Strong intent, but availability-mediated | Medium; separate availability from mood        |
| `open` / `expand`            | Curiosity or inspection                  | Diagnostic only                                |
| `swipe_right` / `swipe_left` | Fast preference, noisy                   | Medium unless paired with reason/undo handling |
| `swipe_skip`                 | Ambiguous                                | Diagnostic or weak negative only               |

The highest-risk mistake would be training “cozy” from opens, saves, or request previews. Implicit-feedback research is clear that interaction strength often reflects confidence or exposure, not preference. ([Chris Volinsky][6])

## Separation of broad preference weights vs term-specific profile weights

This separation is correct and should be preserved.

Example:

* Broad preference: “user generally likes mystery.”
* Term profile: “when user says dark, they mean grounded mystery, not supernatural horror.”

If these are merged, the system will start recommending mystery for every mood prompt and will lose the semantic calibration layer.

I would add **hierarchical regularization**:

* Global/default term prior.
* User-level broad preference.
* User-context term profile: `user + solo + dark`.
* User-context-session residual for recent drift.

This prevents one noisy term from contaminating the whole profile.

## Likely overfitting and calibration failures

Most likely failures:

1. **Synthetic eval overfit**
   Hand-authored synthetic titles may encode exactly the feature labels the scorer expects.

2. **Positive-only term drift**
   If the user repeatedly selects “dark” horror because it was the best available option, the system may learn that “dark” means horror even if the user wanted noir.

3. **Availability confounding**
   Requestable titles may be selected because they are novel, not because they match the mood.

4. **Genre leakage**
   Mood terms become proxies for genre.

5. **Prompt parser brittleness**
   “Not too dark,” “dark comedy,” “visually dark,” and “dark but cozy” may collapse to the same signal.

6. **Context bleed**
   Solo “weird” contaminates group “weird.”

7. **Cold-start false confidence**
   A few early interactions produce a term profile that looks learned but is actually accidental.

8. **Diversity masking**
   A diversity pass can make the set look better while hiding that the top-scoring model is poorly calibrated.

# 4. Stress-test plan

## Priority categories

| Priority | Category                  | Exact test prompt                                                                               | Synthetic titles                                                                             | Expected outcome                                                                        | Failure classification       |
| -------: | ------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ---------------------------- |
|       P0 | Negation                  | “Something cozy but **not cute or sentimental**.”                                               | `Sugar Quilt`, `Dry Harbor`, `Soft Rain Sunday`                                              | `Dry Harbor` should outrank `Sugar Quilt`; warm but unsentimental should win.           | Negation-as-positive         |
|       P0 | Compound term ambiguity   | “A **dark comedy**, not horror.”                                                                | `Deadpan Exit`, `Midnight Chainsaw Club`, `The Basement Signal`                              | `Deadpan Exit` wins; horror is suppressed despite “dark.”                               | Genre shortcut               |
|       P0 | Comparative language      | “Like `The Basement Signal` but **less bleak and more grounded**.”                              | `Dial Tone Road`, `Static Cathedral`, `Midnight Chainsaw Club`                               | `Dial Tone Road` wins; “less bleak” should reduce alienating/nihilistic titles.         | Comparative failure          |
|       P0 | Contradictory constraints | “A 2.5-hour low-commitment movie under 90 minutes.”                                             | `Laundry Day`, `Moonlit Quest`, `Candle Street Caper`                                        | Hard runtime filter wins; system should flag conflict or ignore impossible soft phrase. | Hard/soft conflict           |
|       P0 | Availability              | “Available now, but request it if it’s perfect.”                                                | `Soft Rain Sunday` available, `Moonlit Quest` requestable, `Candle Street Caper` unavailable | Available-now candidates rank first unless requestable match is clearly labelled.       | Availability override        |
|       P0 | Wrong-mood feedback       | User says “dark”; picks `The Basement Signal`; marks `Midnight Chainsaw Club` as wrong mood.    | Same                                                                                         | Future `dark` should move toward grounded thriller and away from horror.                | Negative evidence ignored    |
|       P0 | Context bleed             | Group prompt: “Cozy for me and my partner, nothing intense.” Solo profile likes bleak arthouse. | `Soft Rain Sunday`, `Static Cathedral`, `Odd Jobs Department`                                | Group context should not inherit solo arthouse profile strongly.                        | Context contamination        |
|       P1 | Repeated term intensity   | “Dark dark. Actually bleak. No jokes.”                                                          | `Static Cathedral`, `Deadpan Exit`, `The Basement Signal`                                    | Repetition/intensifier should boost bleakness and suppress comedy.                      | Repetition ignored           |
|       P1 | Ambiguous “light”         | “Light, but not comedy. Just emotionally easy.”                                                 | `Soft Rain Sunday`, `Laundry Day`, `Odd Jobs Department`                                     | Gentle/low-arousal titles win over silly comedy.                                        | Mood-to-genre collapse       |
|       P1 | Sparse metadata           | “Gentle weird.”                                                                                 | `Page 47` sparse metadata, `Odd Jobs Department`, `Static Cathedral`                         | Sparse title should receive lower confidence, not automatic exclusion.                  | Sparse metadata penalty      |
|       P1 | Long-tail content         | “Obscure quiet sci-fi, emotionally gentle.”                                                     | `Small Moon Relay`, `Star War Carnival`, `Soft Rain Sunday`                                  | Long-tail relevant title should not be drowned by ratings/popularity.                   | Popularity bias              |
|       P1 | Exclusion                 | “Weird but not surreal, not exhausting.”                                                        | `Odd Jobs Department`, `Static Cathedral`, `Laundry Day`                                     | Playful weird wins; alienating arthouse suppressed.                                     | Exclusion failure            |
|       P1 | Request status            | “Something I can request, not already available.”                                               | `Moonlit Quest` requestable, `Soft Rain Sunday` available, `Candle Street Caper` pending     | Requestable title wins; available title should be excluded or demoted.                  | Requestability confusion     |
|       P1 | Drift                     | Last month “dark” meant horror; recent feedback says horror is wrong mood, noir is right mood.  | `Midnight Chainsaw Club`, `The Basement Signal`, `Noir Bus Stop`                             | Newer consistent evidence should shrink old horror profile and surface noir.            | Stale profile lock-in        |
|       P2 | Social pressure noise     | User opens several posters but selects none; later picks one title.                             | Mixed slate                                                                                  | Opens should not train; final deliberate choice may train.                              | Accidental implicit learning |
|       P2 | Diversity                 | “Cozy tonight.”                                                                                 | 10 similar warm comedies plus 3 warm adventures/dramas                                       | Top set should include variety while maintaining mood fit.                              | Near-duplicate collapse      |
|       P2 | Parser conflict           | “Not dark, but with dark academia vibes.”                                                       | `Library Fog`, `The Basement Signal`, `Soft Rain Sunday`                                     | “Dark academia” aesthetic should not become horror/thriller darkness.                   | Phrase-level ambiguity       |
|       P2 | Title leakage             | “Something light.” Title named `Lightless Room` is bleak horror.                                | `Lightless Room`, `Laundry Day`, `Soft Rain Sunday`                                          | Title token should not dominate mood interpretation.                                    | Lexical leakage              |

# 5. Better synthetic personas and use cases

Each persona below should be implemented as a repeatable synthetic profile with prompt history, noisy interactions, and held-out eval sessions.

| Persona                            | Private meanings for recurring mood/feel words                                                                                                                     | Likely feedback/noise/failure risks                                     | Example prompt and expected profile shift                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **1. Witty Comfort Rewatcher**     | `cozy` = witty low-stakes ensemble; `dark` = dry cynicism without gore; `weird` = quirky banter; `light` = short/familiar; `comfort` = rewatch energy              | Opens many cards; saves nostalgic titles; may reject sentimental warmth | Prompt: “Cozy but clever.” Shift `cozy` toward wit, ensemble, low stakes; away from cute/saccharine          |
| **2. Mythic Comfort Adventurer**   | `cozy` = magical quest; `dark` = moonlit stakes; `weird` = creatures/worldbuilding; `light` = PG adventure; `comfort` = hopeful group journey                      | May pick longer runtimes if world feels safe; genre looks fantasy-heavy | Prompt: “Cozy adventure, not sitcom cozy.” Shift `cozy` toward fantasy/adventure, warmth, wonder             |
| **3. Psychological Noir Seeker**   | `dark` = grounded mystery; `intense` = slow pressure; `weird` = plausible ambiguity; `light` = rarely wanted; `bleak` = controlled melancholy                      | Rejects supernatural horror; may like low availability noir             | Prompt: “Dark but not scary.” Shift `dark` toward grounded thriller/noir; away from gore/supernatural        |
| **4. Horror Intensity Maximalist** | `dark` = horror; `intense` = high fear; `weird` = body horror/surreal dread; `light` = fast popcorn horror; `comfort` = familiar horror franchise                  | Requests unavailable horror often; group context dangerous              | Prompt: “Dark and weird, no restraint.” Shift `dark` and `weird` toward horror intensity and high arousal    |
| **5. Low-Stimulus Decompressor**   | `cozy` = quiet texture; `dark` = nighttime visuals, not threat; `weird` = soft magical realism; `light` = low arousal; `comfort` = predictable/gentle              | May abandon titles due to fatigue; open/save signals weak               | Prompt: “Something light but beautiful.” Shift `light` toward low arousal, gentle pacing, visual calm        |
| **6. Background Multitasker**      | `low commitment` = episodic/simple; `light` = under 45 min; `cozy` = familiar; `weird` = not confusing; `dark` = allowed if plot-simple                            | Opens while distracted; swipes quickly; completion matters less         | Prompt: “Background-friendly and light.” Shift `light` toward short runtime, simple plot, low cognitive load |
| **7. Social Host**                 | `cozy` = broadly agreeable; `dark` = mild suspense only; `weird` = conversation starter; `light` = group-safe; `comfort` = nostalgic                               | Selection driven by others; solo profile should not bleed into group    | Prompt: “Cozy for a group, not romance.” Shift group `cozy` toward broad appeal and lower intensity          |
| **8. Arthouse Alienation Seeker**  | `weird` = surreal/demanding; `dark` = existential; `light` = visually spare, not easy; `cozy` = ritualistic/quiet; `comfort` = auteur voice                        | Rejects mainstream “quirky”; may tolerate low ratings                   | Prompt: “Weird, quiet, and a bit hostile.” Shift `weird` toward surreal, slow, alienating                    |
| **9. Romantic Warmth Finder**      | `cozy` = affection/chemistry; `dark` = emotional stakes; `light` = heartwarming romance; `weird` = offbeat love story; `comfort` = happy ending                    | May save romance because of cast, not mood; rejects cynical endings     | Prompt: “Light but emotionally sincere.” Shift `light` toward warmth, romance, happy resolution              |
| **10. Parent Time-Boxed Selector** | `light` = under 90 min; `cozy` = family-safe but not childish; `dark` = only after kids asleep; `weird` = animated/offbeat okay; `low commitment` = no cliffhanger | Hard constraints change by time/context; content rating critical        | Prompt: “Cozy, short, safe if the kids wander in.” Shift `cozy` toward content-safe, short, low intensity    |
| **11. Franchise Pragmatist**       | `comfort` = known universe; `cozy` = competent heroes; `dark` = stylized action; `weird` = lore expansion; `light` = pacey franchise entry                         | Popularity/franchise can swamp mood; novelty pass may annoy             | Prompt: “Comfort watch, but not slow.” Shift `comfort` toward familiar IP, pace, competence                  |
| **12. Completionist Critic**       | `dark` = high craft; `weird` = critic-coded; `light` = minor auteur work; `cozy` = period detail; `low commitment` = not over 120 min                              | Ratings/cast/director may dominate mood; can reject populist matches    | Prompt: “Weird but actually good.” Shift `weird` toward craft/ratings/directorial signal but cap snob bias   |
| **13. Anxiety-Sensitive Viewer**   | `dark` = emotionally unsafe; `intense` = panic-inducing; `cozy` = low conflict; `weird` = whimsical only; `light` = no dread                                       | Negative feedback is more informative than positive; privacy-sensitive  | Prompt: “Cozy, zero dread.” Shift `cozy` toward low threat; strongly suppress suspense cues                  |
| **14. Mood Contrarian**            | `cozy` = bleak familiarity; `dark` = calming; `light` = intellectually light, not cheerful; `weird` = deadpan; `comfort` = melancholy                              | Generic English priors are actively wrong; high risk of cold-start miss | Prompt: “Dark comfort watch.” Shift `comfort` and `dark` toward melancholy/low arousal, not horror           |

# 6. Evaluation design

## Offline metrics beyond current `NDCG@3` and `PersonalizationLift@3`

Add metrics in five groups.

### A. Retrieval and constraint metrics

| Metric                               | Why it matters                                                   |
| ------------------------------------ | ---------------------------------------------------------------- |
| `CandidateRecall@K` before scoring   | Detects retrieval failures hidden by reranking.                  |
| Hard-filter accuracy                 | Runtime, media type, exclusions, availability must be invariant. |
| Availability/requestability accuracy | Prevents product trust failures.                                 |
| Reference-neighborhood recall        | Tests “like this” queries.                                       |
| Sparse-metadata recall               | Ensures long-tail titles are not lost.                           |

### B. Mood-fit ranking metrics

| Metric                   | Why it matters                                            |
| ------------------------ | --------------------------------------------------------- |
| `MoodNDCG@3/5/10`        | Graded mood relevance, not only title hit.                |
| `PairwiseAccuracy`       | Directly measures whether preferred item beats near miss. |
| `MRR` by failure class   | Finds parser/retrieval/ranking weak spots.                |
| `WrongMoodSuppression@K` | Measures whether known bad mood matches are kept out.     |
| `NearMissRate`           | Counts “good title, wrong feel” errors.                   |

### C. Personalization metrics

| Metric                             | Why it matters                                                        |
| ---------------------------------- | --------------------------------------------------------------------- |
| `PersonalizationLift@K` vs generic | Keep, but only with strong baseline.                                  |
| `TermSpecificLift`                 | Per-term improvement; prevents average hiding regressions.            |
| `ContextIsolationScore`            | Measures solo/group bleed.                                            |
| `ProfileDeltaEffectSize`           | Shows whether profile movement actually changes ranks.                |
| `ProfileRegret`                    | Compares current profile to previous checkpoint on held-out sessions. |

### D. Calibration metrics

| Metric                                           | Why it matters                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| Brier score for predicted right-mood probability | Tests confidence quality.                                                        |
| Expected Calibration Error                       | Finds overconfident terms.                                                       |
| Reliability curves by term                       | Shows whether “dark” confidence is meaningful.                                   |
| Confidence-weighted NDCG                         | Penalizes confident bad rankings.                                                |
| Abstention quality                               | Tests whether low-confidence terms trigger clarification instead of bad ranking. |

### E. Product outcome metrics

| Metric                              | Why it matters                                        |
| ----------------------------------- | ----------------------------------------------------- |
| Right-mood satisfaction rate        | Core North Star.                                      |
| Time-to-satisfactory-selection      | Measures usefulness without over-indexing engagement. |
| Query reformulation rate            | High reformulation may mean bad interpretation.       |
| Undo/hide-after-select rate         | Detects accidental interactions.                      |
| Session abandonment after top slate | Detects poor slates.                                  |

Conversational recommender evaluation literature is useful here because it distinguishes item-level ranking metrics from conversation/session-level outcomes. ([Xiangnan He's Homepage][8])

## Holdout strategy for profile learning

Use local, privacy-preserving holdout.

1. **Temporal session split**
   Train on earlier sessions; evaluate on later sessions.

2. **Per-term leave-one-session-out**
   For `dark`, train on all but one `dark` session and evaluate the held-out session.

3. **Shadow holdout of clear feedback**
   Randomly hold back 10–20% of high-confidence feedback from profile updates. Use it only for local evaluation.

4. **Profile checkpoint replay**
   Store profile version `t`, displayed slate, score buckets, and candidate IDs. Re-score later with profile `t+1` to estimate whether learning improved the same decision context.

5. **Context-specific holdout**
   Keep solo and group evaluation separate.

6. **No raw prompt requirement**
   Store normalized intent tokens, parsed terms, hard filters, candidate slate, and profile version. Do not require durable raw prompts.

## Pairwise evals

Pairwise data is especially valuable because it asks the system to distinguish close alternatives.

Recommended pair types:

| Pair type                       | Example                                                                      | Purpose                       |
| ------------------------------- | ---------------------------------------------------------------------------- | ----------------------------- |
| Generic top vs personalized top | Generic `Midnight Chainsaw Club` vs profile `The Basement Signal` for “dark” | Measures personalization lift |
| Same genre, different feel      | Two thrillers: bleak vs cozy mystery                                         | Tests mood precision          |
| Same mood, different friction   | Gentle 90 min vs gentle 160 min                                              | Tests watchability            |
| Reference-neighbor pair         | “Like X but less bleak” candidates                                           | Tests comparative language    |
| Availability pair               | Available okay match vs requestable perfect match                            | Tests product trade-off       |

Use a Bradley-Terry, Thurstone, or BPR-style objective for offline pairwise ranking. Bayesian Personalized Ranking was explicitly designed for ranking from implicit feedback and pairwise preferences. ([arXiv][12])

## Calibration curves

For each term/context pair, bin predictions by profile-fit score or predicted right-mood probability:

* 0.0–0.1
* 0.1–0.2
* …
* 0.9–1.0

Then measure observed:

* `right_mood` rate
* pairwise win rate
* hide/wrong_mood rate
* selection rate after exposure

A well-calibrated `dark` profile should not merely rank dark titles highly; its 0.8 confidence bucket should produce right-mood feedback roughly 80% of the time over enough samples.

## Cold-start measurement

Measure after:

* 0 explicit signals
* 1 explicit signal
* 3 explicit signals
* 5 explicit signals
* 10 explicit signals

Report:

* Lift over generic.
* Wrong-mood suppression.
* Confidence calibration.
* Number of clarification interactions required.
* Whether the model should abstain.

The target is not “personalize immediately.” The target is **avoid confident wrong personalization while learning quickly**.

## Drift measurement

Add:

* Rolling-window term-vector distance.
* Conflict score between old and recent feedback.
* Per-term regret against previous profile checkpoint.
* Sudden increase in `wrong_mood` after previously high-confidence matches.
* Context-shift detector: solo feedback should not automatically rewrite group profile.

## Misleading metrics to avoid

| Metric                                             | Why misleading                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------- |
| Top-3 hit rate on hand-authored synthetic cases    | Can validate fixtures, not real utility.                                        |
| Personalization lift against weak generic baseline | Easy to inflate.                                                                |
| Open/save/request rate                             | Confounded by curiosity, availability, posters, and social context.             |
| Sampled negative ranking metrics                   | Sampled metrics can be inconsistent with exact metrics. ([Google Research][13]) |
| Average NDCG only                                  | Hides per-term and per-persona regressions.                                     |
| Diversity alone                                    | A diverse bad slate still fails the mood.                                       |
| AI explanation quality                             | Plausible explanations can mask wrong ranking.                                  |

# 7. Learning algorithm improvements

## Upgrade 1: Confidence-aware Bayesian term profile

### Recommendation

Replace or augment the current bounded feature-delta profile with a small Bayesian residual model per:

```text
user_id + context + mood_term
```

Represent each term profile as:

```text
profile(term, context) =
  generic_term_prior
  + user_residual_vector
  + uncertainty
  + evidence_count
  + last_updated
```

Updates should be weighted by action reliability:

* `right_mood`: strong positive
* `wrong_mood`: strong negative
* `pairwise_pick`: strong pairwise
* `more_like` / `less_like`: medium
* `open` / `expand`: diagnostic only

### Why this matters

It solves the biggest current issue: **bounded deltas without evidence quality can still be confidently wrong**.

### Local-first suitability

High. This can be implemented with diagonal variance or simple confidence intervals. No external model required.

### Complexity

Medium.

### Expected value

Very high. This is the most important pre-user upgrade.

## Upgrade 2: Pairwise term-conditioned ranker

### Recommendation

Add a lightweight local pairwise learner for term/context ranking.

Input examples:

```text
For query term "dark" in solo context:
user preferred The Basement Signal over Midnight Chainsaw Club
```

Train a small logistic or BPR-style model over existing feature vectors:

```text
P(candidate_a preferred over candidate_b | term, context)
```

### Why this matters

Mood meaning is often comparative:

* “More like this.”
* “Less bleak.”
* “This one is closer.”
* “Not that kind of weird.”

Pairwise feedback is cleaner than absolute star ratings.

### Local-first suitability

High. Small local model, no collaborative data required.

### Complexity

Medium.

### Expected value

High.

## Upgrade 3: Bandit-lite active calibration

### Recommendation

Do not implement a full contextual bandit yet. Instead, add **uncertainty-aware slate construction**:

* When term confidence is low, show 2–3 meaning-separated candidates.
* Ask lightweight calibration only when needed:

  * “Which is closer to what you mean by cozy?”
  * “Too bleak / too scary / too slow / too silly?”
* Store displayed slate, rank, score buckets, action, and profile version.

After enough logged local data, introduce Thompson sampling or UCB over candidate clusters.

### Why this matters

Bandits are valuable only if the reward and logging are sound. Contextual-bandit literature emphasizes partial feedback and the need for proper logging or randomized exploration for valid offline evaluation. ([arXiv][10])

### Local-first suitability

Medium-high.

### Complexity

Medium now; high if expanded into a full bandit.

### Expected value

Medium-high after basic profile learning is robust.

## Additional upgrade: term embeddings as expansion, not core ranking

Use lightweight local term embeddings or term-neighbor maps to connect:

* `cozy`
* `comfort`
* `gentle`
* `warm`
* `safe`
* `low-stakes`

But keep the learned profile residual term-specific. Do not let embeddings collapse different words into one generic mood vector.

# 8. Product input signal design

## Web signals

| Confidence      | Signals                                                                                                       | Training use                                                        |
| --------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| High            | `right_mood`, `wrong_mood`, pairwise pick, “not what I mean by X,” hide with reason, watched-and-matched      | Update term profile and pairwise learner                            |
| Medium          | `more_like`, `less_like`, save from current prompt, request after preview, long dwell plus explicit selection | Update broad preference; term update only if parser confidence high |
| Weak            | open, expand, poster hover, scroll depth, request preview                                                     | Diagnostics, ranking bias analysis                                  |
| Diagnostic-only | impression, rank position, no click, skip, undo, latency                                                      | Evaluation and UI tuning only                                       |

## Future iOS swipe signals

Swipes are useful but dangerous.

| iOS action             | Interpretation              | Use                                                             |
| ---------------------- | --------------------------- | --------------------------------------------------------------- |
| Swipe right            | Interest                    | Medium unless followed by selection or reason                   |
| Swipe left             | Rejection                   | Medium/weak; reason needed                                      |
| Swipe up / save        | Stronger interest           | Medium                                                          |
| Pairwise card choice   | Cleaner relative preference | High                                                            |
| Long-press reason chip | Direct semantic correction  | High                                                            |
| Undo                   | Cancels previous training   | Must remove or downweight event                                 |
| “Picked for tonight”   | Strong selection            | High for session outcome; medium for term mood unless confirmed |

## How to avoid training on accidents

Implement these rules:

1. **No term-profile update from `open` or `expand`.**
2. **No profile update after immediate undo.**
3. **No term update unless the parsed mood term is high-confidence.**
4. **No training from impressions alone.**
5. **Cap per-session updates** so one browsing session does not dominate a term.
6. **Separate availability intent from mood intent.**
7. **Require reason chips for strong negative updates where possible.**
8. **Store slate position** to correct for rank bias.
9. **Downweight repeated actions on the same title.**
10. **Distinguish “not my taste” from “wrong mood.”**

# 9. Data and privacy strategy

## Store

Store locally:

* `media_id`
* external catalog IDs
* availability/requestability snapshot
* `feature_version`
* deterministic feature vectors
* normalized parsed intent:

  * mood terms
  * hard filters
  * exclusions
  * context
* action type
* reason chips
* timestamp
* displayed slate IDs
* rank position
* score buckets
* model/profile version
* term-profile weights
* term-profile confidence
* effective evidence count
* profile checkpoint history

## Do not store by default

Do not durably store:

* Raw prompts
* Raw AI reranker prompts/responses
* private Plex/Jellyseerr URLs
* tokens
* secrets
* household names typed into prompts
* camera, microphone, biometric, or sensor-derived emotion data
* broad debug logs
* unredacted stack traces containing private URLs

## Retention

Recommended defaults:

| Data                | Retention                                                           |
| ------------------- | ------------------------------------------------------------------- |
| Profile weights     | Until user resets/export-deletes                                    |
| Feedback events     | Rolling 90 days locally                                             |
| Aggregated counters | Until reset                                                         |
| Debug raw prompts   | Off by default; 7–14 days if explicitly enabled                     |
| Profile checkpoints | Keep recent timeline, compress older history                        |
| Deleted/reset terms | Remove learned weights and clear linked debug events where feasible |

## User controls

Moodarr should support:

* Export local profile JSON.
* Reset all learning.
* Reset one term, such as `dark`.
* Reset one context, such as group profile.
* Pause learning for private sessions.
* Show “what Moodarr thinks this word means for you.”
* Let users mark a learned association as wrong.
* Opt in/out of local debug logging.

Spotify’s Taste Profile controls are a useful precedent for exposing taste interpretation and correction without promising absolute deterministic control. ([Spotify][11])

## Privacy risks unique to mood language

Mood language can reveal more than media preference. It may expose:

* stress or anxiety state
* family and children’s routines
* relationship context
* sexual, violent, religious, or political content preferences
* loneliness or comfort-seeking patterns
* household composition
* social identity and subculture signals
* periods of emotional distress

The local-first design is therefore not just a product preference; it is a core safety and trust requirement.

# 10. Implementation backlog

## Do now before users

| Slice                                                            | Files likely touched                                                                   | Acceptance criteria                                                                                                                | Eval changes                                                    | Risk                                             |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ------------------------------------------------ |
| **1. Adversarial eval corpus and failure taxonomy**              | `evaluation.ts`, `profileEvalFixtures.ts`, `scripts/evaluate-recommendations.ts`, docs | At least 50 adversarial cases across negation, ambiguity, sparse metadata, requestability, context, drift, and comparative prompts | Add per-failure-class metrics and report regressions separately | Synthetic cases can still overfit implementation |
| **2. Parser hardening for negation/comparison/compound phrases** | `intent.ts`, `evaluation.ts`                                                           | Correctly parses “not horror,” “less bleak,” “dark comedy,” “visually dark,” “not too weird”                                       | Parser confusion matrix                                         | Regex/rule complexity may become brittle         |
| **3. Feedback reliability gating**                               | `database.ts`, `mediaRepository.ts`, `app.ts`, `App.tsx`, `feelProfile.ts`             | Every event has reliability class; weak actions never update term profiles                                                         | Simulated noisy-event tests                                     | Over-conservatism may slow learning              |
| **4. Reason chips for semantic negatives**                       | `App.tsx`, `app.ts`, `mediaRepository.ts`, `feelProfile.ts`                            | User can mark “too scary,” “too bleak,” “too slow,” “too silly,” “wrong kind of weird”                                             | Tests show reason chips move correct feature dimensions         | Poor chip design can bias users                  |
| **5. Feature provenance and confidence**                         | `features.ts`, `moodFeatureIndex.ts`, `scoring.ts`                                     | Mood features store source and confidence; sparse metadata reduces certainty, not relevance by default                             | Sparse metadata stress tests                                    | More complex score explanations                  |
| **6. Confidence-aware profile delta**                            | `feelProfile.ts`, `scoring.ts`, `database.ts`, `mediaRepository.ts`                    | Profile effect scales with evidence count, action reliability, and uncertainty                                                     | Cold-start curves; profile confidence calibration               | Parameter tuning required                        |
| **7. Availability/requestability invariants**                    | `retrieval.ts`, `scoring.ts`, `app.ts`, Seerr/Plex integration layer                   | AI rerank cannot alter title IDs, availability, or requestability; “available now” obeyed                                          | Invariant tests for availability buckets                        | Edge statuses may be messy                       |
| **8. Profile export/reset/timeline**                             | `database.ts`, `mediaRepository.ts`, `app.ts`, `App.tsx`                               | Export JSON; reset term/context/all; view profile version history                                                                  | Migration and reset tests                                       | Data-loss bugs                                   |
| **9. Shadow holdout and replay logging**                         | `database.ts`, `mediaRepository.ts`, `evaluation.ts`, `scoring.ts`                     | Store slate, score buckets, model/profile version, and held-out feedback flag                                                      | Replay eval comparing profile versions                          | Storage growth if not compacted                  |
| **10. Pairwise eval harness**                                    | `evaluation.ts`, `profileEvalFixtures.ts`, `scripts/evaluate-recommendations.ts`       | Reports pairwise accuracy by term/context/failure class                                                                            | Add near-miss and generic-vs-personalized pairs                 | Requires careful fixture design                  |

## Do after early data exists

| Slice                                                 | Files likely touched                                                  | Acceptance criteria                                                         | Eval changes                        | Risk                                   |
| ----------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------- | -------------------------------------- |
| **11. Pairwise local learner**                        | `feelProfile.ts`, `scoring.ts`, `mediaRepository.ts`, `evaluation.ts` | Pairwise picks train a small local term-conditioned model                   | Pairwise held-out lift              | Can overfit if pairs are too few       |
| **12. Drift detector**                                | `feelProfile.ts`, `evaluation.ts`, `mediaRepository.ts`, `App.tsx`    | Detects conflicting recent evidence and shrinks/branches term profile       | Drift simulation suite              | False alarms                           |
| **13. Confidence UI**                                 | `App.tsx`, `app.ts`, profile APIs                                     | User sees “Moodarr is still learning what you mean by dark”                 | User correction tracking            | UI may overexplain                     |
| **14. Bandit-lite active calibration**                | `scoring.ts`, `feelProfile.ts`, `App.tsx`, `evaluation.ts`            | Low-confidence terms trigger meaning-separated slates or pairwise questions | Exploration logging and replay eval | Bad exploration can hurt UX            |
| **15. Term-neighbor expansion**                       | `features.ts`, `moodFeatureIndex.ts`, `feelProfile.ts`                | Learned `cozy` can partially inform related terms without merging them      | Unseen-term cold-start eval         | Semantic bleed across terms            |
| **16. Collaborative or sequence model investigation** | New module, `evaluation.ts`, possibly optional opt-in data layer      | Only considered after sufficient local/opt-in data                          | Compare against profile model       | Likely premature and privacy-sensitive |

# 11. Final recommendation

## Keep, pivot, or modify?

**Keep the current direction, but modify it before real users.**

Do not pivot to:

* a generic LLM recommender,
* collaborative filtering as the core,
* a heavy foundation model,
* or a long onboarding quiz.

Moodarr’s best opportunity is a **local-first personal mood-language calibration engine** layered on top of deterministic catalog truth and hybrid retrieval.

The current design is promising, but its next milestone should not be “more AI reranking.” It should be **more reliable learning, better evals, and safer product signals**.

## 30-day robustness plan

### Week 1: Make failures visible

Deliver:

* Adversarial eval suite.
* Failure taxonomy.
* Parser tests for negation, comparative language, ambiguity, and hard/soft conflicts.
* Availability/requestability invariant tests.

Exit criteria:

* Hard constraints and availability remain at 100% on adversarial tests.
* Eval report shows per-failure-class results, not only aggregate NDCG.

### Week 2: Clean the feedback loop

Deliver:

* Feedback reliability classes.
* Reason chips for wrong mood.
* No term-profile learning from weak actions.
* Slate/rank/model-version logging.
* Local shadow holdout flag.

Exit criteria:

* Simulated accidental opens do not move profile weights.
* `right_mood`, `wrong_mood`, and `pairwise_pick` produce expected bounded updates.
* Raw prompts are not stored durably by default.

### Week 3: Add confidence-aware profiles

Deliver:

* Evidence count per term/context.
* Uncertainty or confidence per profile vector.
* Evidence-conditioned profile delta.
* Profile checkpoint timeline.
* Term/context reset and export.

Exit criteria:

* Cold-start profile does not over-personalize.
* Consistent feedback increases profile effect.
* Conflicting feedback shrinks confidence or triggers calibration.

### Week 4: Add pairwise learning and pilot gates

Deliver:

* Pairwise eval harness.
* First local pairwise learner or scoring overlay.
* Replay evaluation from held-out feedback.
* Pilot readiness dashboard.

Exit criteria:

* Personalized profile improves held-out pairwise/right-mood outcomes without degrading hard constraints.
* At least the top 10 failure categories are tested.
* Export/reset/debug controls work.
* AI reranking remains catalog-safe and availability-safe.

## Pilot readiness standard

Start real usage only when:

* Hard constraints and availability are invariant.
* Weak actions do not train term profiles.
* Every profile update has action provenance.
* Per-term confidence exists.
* User can reset/export profile data.
* Raw prompt logging is opt-in and time-limited.
* Eval reports failure classes, not just aggregate wins.
* The system can explain: “I ranked this because this is what I currently think you mean by `dark`, with low/medium/high confidence.”

That would turn MoodRank V3 from a promising deterministic recommender into a defensible local personalization system.

#Moodarr #MoodRankV3 #RecommenderSystems #Personalization #AffectiveComputing #LocalFirstAI #EvaluationDesign #PrivacyByDesign

[1]: https://developers.google.com/machine-learning/recommendation/overview/types "Recommendation systems overview  |  Machine Learning  |  Google for Developers"
[2]: https://www.microsoft.com/en-us/research/publication/employing-personal-word-embeddings-for-personalized-search/ "Employing Personal Word Embeddings for Personalized Search - Microsoft Research"
[3]: https://netflixtechblog.com/foundation-model-for-personalized-recommendation-1a0bd8e02d39?utm_source=chatgpt.com "Foundation Model for Personalized Recommendation"
[4]: https://grouplens.org/datasets/movielens/tag-genome-2021/ "MovieLens Tag Genome Dataset 2021 | GroupLens"
[5]: https://files.grouplens.org/datasets/tag-genome/README.html "Tag Genome Data Set README"
[6]: https://yifanhu.net/PUB/cf.pdf "Collaborative Filtering for Implicit Feedback Datasets"
[7]: https://aclanthology.org/P18-1017/ "Obtaining Reliable Human Ratings of Valence, Arousal, and Dominance for 20,000 English Words - ACL Anthology"
[8]: https://hexiangnan.github.io/papers/CRS-survey-2021.pdf "Advances and Challenges in Conversational Recommender Systems: A Survey"
[9]: https://www.microsoft.com/en-us/research/publication/a-contextual-bandit-approach-to-personalized-news-article-recommendation-3/?lang=zh-cn "A contextual-bandit approach to personalized news article recommendation - Microsoft Research"
[10]: https://arxiv.org/abs/1003.5956 "Unbiased Offline Evaluation of Contextual-bandit-based News Article Recommendation Algorithms"
[11]: https://support.spotify.com/us/article/your-taste-profile/ "Taste Profile - Spotify"
[12]: https://arxiv.org/abs/1205.2618?utm_source=chatgpt.com "BPR: Bayesian Personalized Ranking from Implicit Feedback"
[13]: https://research.google/pubs/on-sampled-metrics-for-item-recommendation/ "On Sampled Metrics for Item Recommendation"
