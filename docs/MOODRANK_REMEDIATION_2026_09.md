# MoodRank correctness remediation — September 2026

Status: staged implementation; not a release or general-quality claim.
Updated: 2026-09-08.
Baseline: `a494b90b44e5c02bddf8c6bafc8e0f9ae27e8107` (ranking code unchanged from the original `c345f1800baa0efc67b06a0c9ec3a1d9ad6fcb4d` review).
Engine: `moodrank-v0.5` -> `moodrank-v0.5.1`.

## Implemented slice

F2, bounded query-to-mood-index polarity repair:

- Positive retrieval checks operate on individual cue occurrences rather than unrestricted regex presence.
- Common negation/reduction phrases suppress positive attraction; this does not turn `less` into a new hard filter.
- Negation does not cross punctuation or contrast boundaries. Short `and`/`or`/`nor` lists share their negator. Commas end clauses, matching the existing conservative feel-profile convention; arbitrary natural-language list syntax is not claimed to be understood.
- `not only`, `not just`, and `not merely` remain affirmative. A later affirmative occurrence is not globally cancelled by an earlier negative occurrence.
- A marked follow-up replaces only a cue it explicitly mentions; unrelated refinements inherit earlier cue polarity. Existing hard-filter parsing and clear semantics are unchanged.
- Directly negated soft terms are not expanded. Directly avoided output features cannot be reintroduced through another term's expansion. Unmentioned soft enrichment is retained.
- Time-travel/romance composite retrieval requires positive evidence for both components.

Changed production paths: `moodFeatureIndex.ts`, new `queryCuePolarity.ts`, and engine version. No scorer weights, availability gates, request actions, provider policy, model defaults, profile learning, or database writes are changed.

## Evidence

The original review's manually transcribed probes are not implementation tests. Initial supplemental checks imported complete retrieved production modules after TypeScript transpilation. Original copies of `moodFeatureIndex.ts`, `intent.ts`, `runtime.ts`, and `requestAttemptIntent.ts` were checked against their Git blob hashes before the patch.

| Initial supplemental evidence (Node v22.16.0, unsupported) | Baseline | Patched |
|---|---:|---:|
| 27 production mood-index scenarios | 12 pass / 15 fail | 27 pass / 0 fail |
| 30 occurrence-matcher checks | Helper did not exist | 30 pass / 0 fail |

Two repository Vitest suites contain the corresponding 57 cases and import production code: `tests/queryCuePolarity.test.ts` and `tests/moodFeaturePolarity.test.ts`.

### Supported-runtime follow-through

CI run `34165104076` executed on Node 24.20.0: all 57 new cases passed; lint, typecheck, documentation contracts, tracked-secret scan and evaluation-leakage guard passed. Full Vitest reported 1,166 passes and four failures, each solely an obsolete exact engine-version expectation. The release-verification chain stopped at that point; later chained steps were not claimed as passed.

Repair commit `b845a3eb8910514f42a173d4e380296603ed456b` changes only those four version assertions in `tests/app.test.ts` and `tests/recommendation.test.ts`, from v0.5 to v0.5.1. It does not change ranking expectations or weaken an assertion. A temporary branch-restricted Actions job (`34167608807`) verified exact original blob hashes, applied the replacements, passed all four affected suites on Node 24, committed the repair without force-pushing, and removed its own workflow. No temporary write-enabled workflow remains in the branch. Repository-level permissions and all pre-existing workflows are unchanged.

A complete CI run on the repaired head is still required; final observations belong on the PR. No live catalogue, private blind corpus, production database, private configuration or provider was accessed.

After `npm ci` on a supported disposable checkout, run:

```sh
npm test -- tests/queryCuePolarity.test.ts tests/moodFeaturePolarity.test.ts
npm run verify
npm run eval:recommendations
npm run eval:moodrank-release-readiness
npm run eval:profile-journeys
```

Profile replay and trace checks require explicitly supplied suitable evidence; a successful command with no events or traces is not quality validation. Apply the existing independent evaluation protocol before a release decision. These visible regression prompts must not be reused as blind evidence.

## Data compatibility, rollback and operational boundary

No schema or stored-feature semantics change in this slice, so **do not run a feature backfill or data migration for this patch**. Existing mood rows, fingerprints, embeddings and profile checkpoints remain readable and unchanged. Reverting the production-code change restores the old query expansion without a database rollback. The branch and PR do not merge, publish, deploy, invoke requests or change the live installation.

## Outstanding work

| Finding | Status after this slice | Next requirement |
|---|---|---|
| F1: positive true-crime documentary rejection | Not changed | Reproduce through the production scorer; separate desired subject from explicit avoidance and intensity; remove the tautological branch. |
| F2: negative preferences attracting results | Query-to-mood-index slice implemented | Unify remaining lexical/vector/scoring interpretation under the structured brief; verify candidate and final-response effects. |
| F3: content cue substring/negation inference | Not changed | Correct evidence extraction, version derived features, and validate source-preserving refresh. |
| F4: episode duration mistaken for series commitment | Not changed | Correct feature, fingerprint, profile, friction, diversity and explanation consumers together; handle historical weights explicitly. |
| F5: explicit mood combinations contradicted by defaults | Not changed | Test scorer contributions for quiet/meditative and other explicit-prior conflicts. |
| F6: independent semantic/example retrieval | Not implemented | Approved local resources, bounded retrieval/index design, recall and latency evidence; experimental until independent gates pass. |
| F7: correlated scoring/profile influence | Not changed | Trace-based ablations and an effective influence budget, not unmeasured weight tuning. |
| F8: experiential diversity/explanations | Not changed | Grounded contributions, relevance protection and final-response validation. |
| I1: current feeling versus desired experience | Not implemented | Extend the existing brief, preserve hard constraints and represent uncertainty; do not infer a coping goal by default. |

Known scope limits of the bounded matcher include indirect/idiomatic negation, semantic aliases, quoted reference-title roles and arbitrary clause syntax. It is not a general parser or a complete F2 closure. Do not claim an accuracy percentage, satisfaction gain or overall ranking improvement from these developer checks.
