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
