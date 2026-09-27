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
requires all top-k results to have judgments, rejects train/evaluation group
overlap and reports final-response metrics. `candidateRecall` is null because the
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
