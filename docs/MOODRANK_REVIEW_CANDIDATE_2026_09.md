# Follow-on MoodRank review candidate (2026-09-27)

This source-only candidate adds explicit `reviewArms` in
`src/server/recommendation/review/candidateEngine.ts`. Ordinary `SearchService`
construction is unchanged. This is not a production activation or an independent
quality approval.

## Components

The evidence arm runs after existing eligibility, hard filters and hidden-ID
checks. It replaces the legacy score-rule body with confidence-weighted explicit
facets, optional direct reference aspects, semantic rank evidence, once-applied
preferences, example feedback, availability, ratings and requested effort. It
preserves uncertainty rather than rejecting missing aesthetic descriptions.
Description matches are lexical rules, not proof of objective mood; classification
and genre remain distinct from direct experiential evidence. The vocabulary and
fixed confidences are intentionally limited and require evaluation.

The retrieval arm uses reciprocal ranks across channel lists. References needed
for comparison can be retained as evidence without being forced into displayed
candidates. Upstream lexical/mood per-channel limits remain; independent semantic
retrieval is a separately supplied channel, not an inference that ordinary
provider embeddings discover unseen items.

`PackedLocalSemanticIndex` stores normalized float32 vectors in immutable blocks,
uses bounded heaps for exact top-k search and requires explicit document/vector
budgets. Streamed preparation accepts an explicitly approved document encoder;
private shard storage writes its manifest last and verifies identity, counts and
SHA-256 hashes when loading. Input hashes use the original raw feature-text
convention. Index memory budgets cover vector bytes, not total process memory.
No default model, download, cloud fallback, or production index is supplied.

The presentation arm diversifies the actual post-rerank order rather than stale
pre-AI scores. Its precision/displacement protections apply within that stage;
operational request-attempt ordering remains authoritative afterward. The
explanation path names actual scoring contributions and uncertainty, not a
calibrated probability or causal improvement.

The linear learner is a regularized, group-balanced pairwise experiment. Model
weights are nonnegative and sum to one; models include feature version and
training-group/dataset identities. Scores are ranking utilities. Training is
explicit and private; no fitted production model is included.

## Evaluation and promotion

`evaluateFinalResponses` calls the supplied engine's real `recommend` method,
requires every displayed result to have judgments independently of the metric
cutoff, rejects train/evaluation group overlap and reports NDCG at 3 and 10 from
the same response. Display counts and exclusion checks cover the whole response;
`k` still selects the primary NDCG and judged-pool recall cutoff. Paired comparisons
require the same request/group/judgment hash, with catalogue and source identities
recorded separately in the run receipt. `candidateRecall` is null because the
final API response cannot establish pre-ranking recall. The paired bootstrap uses
intent-group units. Neither passing tests nor a positive point estimate constitutes
promotion approval.

Keep independent judgments and catalogue data outside the repository. Evaluate
with independently frozen groups and predeclared gates, plus actual supported
Node 24 release checks, representative runtime/model benchmarks, and human
explanation review. Do not replace these with visible developer fixtures, weaken
existing goldens, or change provider/privacy/release controls.

The companion implementation bundle records 137 passing isolated core checks,
14 installer-fixture checks and a strict core-only typecheck on Node 22/TypeScript
5.8.3. Repository integration tests were supplied but not run in that environment.
A 90k × 768 synthetic-vector capacity diagnostic is not a real-encoder or product
performance/quality result. Those receipts are bundle-local rather than private
operational records committed here.

## September 28 reconciliation

The `evidence` and `combined` arms now request fractional ordering explicitly.
`evidenceInteger` uses the same evidence scorer with integer ordering. The scorer
no longer implicitly enables fractional ordering merely because evidence scoring
is enabled. Extraction and composition remain coupled; this control does not
establish an extraction-only or composition-only comparison.

`npm run eval:moodrank-review` reports explicit switches, ordering, Node version
and a fixture/case hash under `ranking-ablations-v2`. Existing assertions and
thresholds are unchanged. The refreshed final-engine baseline has one P2
`diversity-cozy-tonight` assertion failure; the separate normal adversarial gate
uses scorer-stage output and passes. Do not merge these different stage claims.
The historical fractional evidence/combined arms retain their previous failures.

Fingerprint rules v5 correct evidence attribution for the witty and situational
humour terms without changing their score/confidence values. An unrelated or
negated synopsis no longer supplies summary provenance to a Comedy-only
inference. The existing lexical inference remains heuristic, including its
screenwriter cue. This does not implement a calibrated shared claim schema,
repair all provenance paths, or combine the separate fingerprint comparison PR.
See the [refresh and rollback notes](MOODRANK_CORRECTNESS_UPGRADE.md#subsequent-fingerprint-provenance-revision).

## Completed source revision for fresh review

Historical arms remain available. The adjacent matched controls are:

| Comparison | Changed behavior |
|---|---|
| `evidenceInteger` → `evidenceScoped` | Scoped comparative clauses and emotional-effort compounds |
| `evidenceScoped` → `claimExtraction` | Shared claim extraction, with the original score formula |
| `claimExtraction` → `claimComposition` | Independent desired, reduction and reference-transformation contributions |
| `claimComposition` → `claimFractional` | Fractional ordering only |
| `claimReferenceExtraction` → `claimReferenceComposition` | Composition with reference aspects held enabled in both arms |
| `combined` → `revisedCombined` | All revised interpretation/evidence/composition behavior in the combined experiment |

`scopedComparatives` makes “less bleak and more grounded” reduce bleak and
prefer grounded. Bare coordinated reductions and direct “not more” clauses
remain negative. Emotional-effort phrases stay one facet; they do not imply
Comedy. These changes are explicit source-only switches, not production defaults.

Claims separate aspect presence, optional explicitly worded degree, scope,
polarity, heuristic reliability, source spans/hashes, extractor versions, and
derivation lineage. Current description claims take precedence over genre priors.
Conflicts remain mixed; subject feelings and stale/missing evidence cannot supply
viewing-experience support. Synonyms and repeated derivations do not add support.
The fingerprint adapter requires current input identity and rechecks declared
source support. It does not merge or activate the separate fingerprint experiment.
No confidence value is a calibrated probability.

Composition uses independent fixed 25-point desired and reduction budgets inside
the mood feature. Strongest support per direction avoids dilution by unknown
facets and repeated wording. This conservative max-support choice is an explicit
hypothesis, not an optimized weight. Reference transformation has a separate
25-point feature budget and requires explicit degrees on the same ordinal scale;
binary matches supply no relative intensity. Existing secondary feature weights
are unchanged. Claim-backed reference aspects exclude mixed and subject-scoped
claims, while general narrative overlap remains separately labelled. Models
fitted to the old evidence feature semantics cannot be used with the new contract.
Hard exclusions still precede utility and cannot be compensated by preferences.

Semantic retrieval now maintains a repository/index-generation projection of
fresh source hashes and filterable fields. A lazy connection-local change journal
invalidates modified records; external-connection changes conservatively rebuild
the projection. Expiration also invalidates cached entries. Fresh/type/availability
sets narrow requests before vector top-k, followed by authoritative validation.
Requests pin source/index/policy identity, accept at most 128 candidates, validate
at most 2,048 unique IDs including reserved reference capacity, and perform at most
two refills within the existing timeout. Caller cancellation propagates; recoverable
semantic failures discard the contribution and preserve ordinary retrieval.
Cached-field filtering and exact vector search can still be O(N). Cold refresh,
memory, encoder inference, and production concurrency remain separate benchmarks.
No persistent schema, default encoder, provider, or private index is introduced.

The Plex comparison runs baseline, 512, 1,024 and all-eligible reservations through
the same final engine with the same 3,000-candidate cap. It reports gained/lost
Plex and catalogue candidates against frozen scorer-oracle pools. Those pools
measure agreement with the existing scorer, not independent relevance. Undefined
denominators and independently judged NDCG/recall remain null. Synthetic verified
catalogue records make catalogue displacement observable; the original unverified
mode is retained and has no eligible catalogue relevance denominator.

The historical audit traced all eight named overlap targets to the alpha.19
introduction commit `baf00c66724bc6a2c900b8702d0fbb9360866707`, with cochanged
fixtures and expectations. No verified preceding failure or independent need for
the exact phrase bonuses was established. The audit records provisional removal
candidates and scope/identity debt; it does not establish intentional contamination.
No audited rule, expected title, threshold or leakage allowlist was changed.

Fresh reports must retain every synthetic failure. No independent judgment corpus,
real-model benchmark, production activation, or new release approval follows from
these source changes. The default and historical controls remain separate from
the revised experiments.

## Fresh review corrections after `4041648`

The ordinary recommendation path now separates current or denied feelings from
explicit desired experience when applying the emotional-safety guard. An anxious
viewer can still request intense horror or cathartic sadness. Explicit calming,
coping and content exclusions remain authoritative. This narrow fix does not
enable the experimental intent/scoring bundle.

Musical-format exclusions use affirmative format evidence. Incidental words such
as “final stage”, “recording of an interrogation” or “band of police officers” do
not establish that format. Music subjects and concert documentaries are distinct
from musicals; explicit music or performed-song exclusions remain separate.
The legacy Music-plus-song-performance inference remains a bounded heuristic.
Returned built-in and AI-supplied refinement suggestions are screened against the
active request and resolved filters before compatible alternatives fill the set.

The experimental claim extractor distinguishes explicit absence from reduction.
Contractions, nonviolent/violence-free wording and neither/nor can assert absence;
less violent and not very violent do not. Attributive descriptions use their head
noun to distinguish a warm movie from a warm character. Original source spans,
hashes, lineage, freshness checks and conservative reliability caps remain.
These are bounded lexical rules, not general natural-language understanding.

Explicit content constraints have a separate description-evidence channel. A
bounded literal phrase outside the affect vocabulary can identify prohibited
content without becoming positive mood evidence. Affirmative depicted violence
is content even when a character performs it. Mixed presence/absence for depicted
content still contains affirmative prohibited content; mixed viewing tone stays
uncertain. Titles, credits and missing descriptions cannot assert content.

Claim-backed experiments now use the same evidence contract for final-slate
vectors after AI ordering. Protected positions and displacement bounds remain.
Their explanations name requested facets whose descriptive support is unknown or
contradicted, even when another facet is supported. Inferred enrichment is not
presented as a requested requirement. Legacy scoring and vector implementations
remain available as controls.

The composition controls form this source-only matrix:

| Arm | Positive support | Desired support/contradiction budget | Reduction / reference budget |
|---|---|---:|---:|
| `claimComposition` | Maximum | 25 | 25 / 25 |
| `claimCompositionEqualAmplitude` | Maximum | 50 | 25 / 25 |
| `claimCompositionCoverage` | Mean over distinct requested prefer facets | 25 | 25 / 25 |
| `claimCompositionCoverageEqualAmplitude` | Mean over distinct requested prefer facets | 50 | 25 / 25 |

The 50-point desired budget matches the earlier single-positive-facet amplitude.
Coverage counts explicit and requested-effect facets, excluding inferred
enrichment. Unknown positive facets contribute zero support; canonical synonyms
count once. Contradiction and reduction keep independent maximum penalties, so
adding unknown wording cannot dilute them. Reference transformation remains
separate. Feature weights are unchanged. Combined penalties can saturate the
bounded mood feature at zero; amplitude differences are not always linear after
clipping. No budget was selected by optimizing expected fixture titles.

All 16 existing arm definitions remain, plus the three matrix controls. Shared
ordinary-path and claim correctness repairs can change their measured results.
Use the immutable `4041648` source for the historical snapshot, and compare the
current default with the actual main source as well as same-source experimental
arms. Preserve every failed diagnostic and all existing expected titles,
thresholds and leakage controls. Neither a regression pass nor a favorable
visible-fixture metric establishes independent relevance or promotion readiness.

## Follow-up corrections after `8b2b113`

Ordinary safety scoring and experimental viewing intent share requested/denied
effect interpretation. Complete effect phrases are masked from residual trait
cues, so a denied calming goal cannot reappear as a calm preference. An explicit
new subject and goal after coordination starts a separate effect scope.

Description claims and music boundaries share bounded active/passive predicate
polarity. Denied absence such as “never without” and “cannot avoid” establishes
presence; uncertain absence remains unknown. Separate affirmative predicates
cannot disappear behind an earlier negation within the supported predicate grammar.
Claim extractor and fingerprint adapter identities were version 3 at `26c652e`
and version 4 at `4fd1ed9`. The coordinated-assertion corrections below use
version 5. Source spans, hashes and
lineage remain required.
Depicted themes, settings and events have explicit evidence-admissibility roles:
character grief can establish a grief theme without establishing sad viewing tone.
Unknown plus absence does not establish affirmative prohibited content.

Refinement labels and prompts are checked independently for canonical content
forms, exact rating promises and supported runtime quantities. Coordinated rating
choices must all fit the active exact-rating filter. This does not introduce an
age-rating ceiling or change the runtime filter's inclusive-bound semantics.
Compound “twenty five” quantities are interpreted as 25, not a 20-to-5 range.

Experiential facets and explanations exclude spans consumed by explicit runtime,
year and availability filters. The original request still drives those filters.
Genuine unsupported desired traits remain in requested coverage; no new weights,
arm definitions or promotion criteria are introduced.

Review comparisons must state their captured fields. Result IDs, titles, scores
and explanations alone do not establish equality of refinement options or
resolved filters. The follow-up comparison captures the full response except
session IDs and diagnostic timing fields. Synthetic final-engine checks and
passing repository tests remain distinct from independent relevance evidence.

## Predicate and request-role corrections after `26c652e`

The follow-up review reproduced an introduced music-exclusion regression and
additional gaps in previously repaired language families. Passing the original
examples did not establish complete linguistic coverage. These corrections keep
the parser bounded and preserve the separate default and experimental paths.

Description assertions attach governing negation to a supported predicate and
its objects. An unrelated negated noun phrase cannot suppress a later affirmative
predicate. Object lists, shared auxiliary negation, new predicates, passive
auxiliaries and negative objects have separate scope. Verb and object mentions
of the same song performance use the same assertion. Genuine uncertainty remains
unknown; it does not become affirmative presence or established absence. Extractor
and adapter version 4 prevent reuse of prior derived assertion semantics.

Viewing effects distinguish requested, denied and unresolved goals. An embedded
effect in another person's report or an uncertain question does not by itself
authorize a calming goal. Explicit user goals and marked corrections retain
authority. Operational spans include their adjacent year, availability or runtime
syntax; unrelated and unsupported desired traits remain in experiential coverage.

Generated refinement labels and prompts distinguish absent, resolved and unresolved
operational declarations internally. When the corresponding filter is active,
an unresolved declaration is not treated as a compatible empty extraction. Runtime
ownership separates a movie's duration from durations inside its story. Existing
public refinement types, exact-rating equality and filter authority are unchanged.

The inherited runtime comparison defect is a separate correction. A governing
denial and comparison are parsed together, including supported contractions and
duration verbs. Negated comparisons invert the bound under the existing inclusive
boundary convention. Multiple bounds still intersect, including impossible
intersections. Explicit filter clears and marked corrections retain their existing
semantics. The same consumed span is masked during experiential interpretation.

Verification includes both supplied harnesses, the earlier supplied tests, native
final-engine cases authored before their corresponding repairs, additional frozen
semantic controls, complete stable response comparisons and the unchanged ranking
diagnostics. These are synthetic correctness checks. They do not establish general
language understanding, independent recommendation quality or promotion readiness.

## Coordinated assertions and compound constraints after `4fd1ed9`

The supported request grammar preserves `really` and `just` before a desire
predicate, `really` after a denial, and `please` in a polite recommendation
request. Negators remain separate from these modifier positions. Reports and
uncertain questions do not gain user authority through an embedded effect.
This bounded grammar does not claim to resolve arbitrary modifiers or ambiguity.

Description assertions distinguish a quantified subject from a negative
attribute inside a subject. A bounded `no` subject can coordinate nominal
members with `and` or `or`; a `neither` subject uses `nor`. Predicate-level
`neither/nor` has separate polarity and can cover inflected predicate heads.
Renewed assertions, shared auxiliary predicates and avoidance complements
remain distinct. Unsupported quantified subjects stay uncertain. Original
source spans and lineage remain; extractor and adapter version 5 identify
the changed derived semantics.

Refinement screening retains both positive and excluded exact rating/runtime
values internally. An exclusion that removes the active exact rating or the
only duration in a singleton interval is contradictory. Excluding one duration
from a wider interval is compatible. Labels and prompts retain independent
screening, and narrative quantities do not become operational declarations.
Unknown detected declarations retain their unresolved policy. This screens
returned suggestions; it does not add a new public refinement action or prove
that clicking a suggestion implements an arbitrary set complement.

Runtime quantities can add an hour amount and a minute amount, with or without
`and`, before a comparison is applied. Explicit `between`/`from` ranges retain
endpoint semantics, including compound endpoints. Bounds, intersections and
negated comparisons retain the existing inclusive convention. Parsing and
experiential masking consume the same complete constraint spans at original
offsets. Exact runtime promises use the same amount conversion.

Finite grammar matrices were declared before these repairs. They vary modifier
positions, subject quantification, coordinators, predicate forms, promise polarity
and duration spelling without using the implementation as an expectation oracle.
Additional controls were frozen independently of delegated implementation.
These controls supplement the retained earlier tests and unchanged ranking
fixtures; they are not independent relevance or promotion evidence.

## Effect ownership and coordinated declarations after `e4fb93a`

A recognized desire head does not grant viewer-goal authority to every later
effect phrase. Supported viewing-purpose complements retain that authority,
including quoted viewer goals. Character dialogue has a separate content role;
unsupported complements remain unresolved. A genuine viewer goal and a later
dialogue occurrence can coexist. Modal denial within a supported purpose, such
as “a movie that won't help me relax”, denies that outcome. Existing modifiers,
polite forms, explicit filters and fallback eligibility remain authoritative.

Description assertions retain the governing avoidance relation through shared
gerund complements. A new subject, finite predicate or explicit auxiliary ends
that relation. Supported `nor` clauses with inverted `do`/`does`/`did` have their
own negative polarity. This does not make ordinary `and` clauses negative.
Both description consumers retain raw source spans, hashes, lineage and freshness
checks. Extractor and adapter version 6 identify these changed derived semantics.

Signed rating declarations retain every supported coordinated value, including
`neither/nor` lists and repeated rating predicates. List order cannot hide an
excluded active exact rating. An unsupported certificate continuation remains
unresolved under the existing active-filter policy. Labels and prompts are still
screened independently. The compound-runtime correction and inclusive bounds are
unchanged.

### Interpreting profile diagnostics

The profile evaluator reports both missing expected titles and missing numeric
`scoreBreakdown.profile` fields as `personalization_miss`. In the retained
revised-combined result, 15 of the 17 assertions concern the missing output field;
two concern `Laundry Day` missing from the expected top three. Report these
categories separately. Keep the existing assertions and raw failure lists.
Resolving the experimental output contract requires an explicit subsequent
decision about the field's semantics or a versioned contract change.

The revised arm's 10 wins, zero losses and five ties compare its personalized
results with its own generic results. They do not establish an improvement over
the default arm. Its synthetic personalized NDCG@3 remains lower than default
(0.895263 versus 0.965015). These scorer-stage diagnostics, finite correctness
matrices and stable-response comparisons do not establish independently judged
final relevance or candidate recall. Ranking promotion remains blocked.
