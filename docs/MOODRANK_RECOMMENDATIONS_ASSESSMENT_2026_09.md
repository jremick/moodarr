# MoodRank recommendations: implementation assessment

## Release reconciliation, 28 September 2026

The measurements below retain the original 27 September candidate, including its
failures. The later release reconciliation moves fractional ordering behind the
disabled `fractionalUtility` switch. It does not change fixture expectations or
thresholds. A red/green regression checks that default ties retain their previous
ordering while explicit opt-in uses fractional utility.

With that switch off, `npm run verify` passes all 1,834 tests across 99 files,
lint, typecheck, documentation, leakage, builds and secret checks. The unchanged
recommendation evaluation passes all 17 golden, 40 adversarial and six rank-index
cases; NDCG@3 returns to 0.889355. Readiness passes all 99 cases and coverage gates.
The locked dependency audit reports zero vulnerabilities. These local checks used
Node 26.8.2; exact-source CI and container release checks remain separate.

This cumulative candidate still contains #106's multi-example change and remains
draft pending its frozen independent relevance evaluation. GPT Pro's larger
scorer remains disabled. Neither the corrected synthetic gates nor the original
ablation results authorize activation. The separately validated #104 and #105
mechanical corrections can proceed through their protected merge checks.

## Original evaluation snapshot

Date: 2026-09-27. Engine candidate: `moodrank-v0.5.4`.
Base: `daeab3b848791da1b31915b23a4349228368d8e6`, the existing #104 → #105 → #106
correction stack. This local assessment covers the supplied GPT Pro handoff and
Opus brief. It does not approve publication, experiment activation or deployment.

## Decision

Keep the four default correctness fixes as a reviewable candidate. Keep GPT Pro's
larger ranking implementation disabled. Do not weaken the current release gates:
two existing evaluations now fail, and the combined experiment loses blocking
adversarial cases. Source integration is distinct from recommendation quality.

## Recommendation disposition

| Recommendation | Work completed | Disposition |
|---|---|---|
| Opus 1: invariants | Real final-engine evaluation over five synthetic catalogues; separate hard-filter checks, signed-feedback checks and ranking diagnostics | Additive evidence. Existing exit conditions, thresholds, fixture expectations, debt and allowlists stay unchanged |
| Opus 1: automatic overlap | Automatic two/three-word phrases and long tokens; expanded fixture sources; exclude fixture files from production findings | Discovery only. Review provenance before turning a match into debt or deleting code |
| Opus 2: four correctness fixes | Negated/modal reference parsing; exact-first/prefix title resolution; feedback-title masking; server-selected card-feedback term; fractional sorting/protected-head/MMR utility | Implemented with failures reproduced before repair. Scores remain integers; native clients need a separate additive-field adoption |
| Opus 3: fixture-derived rules | Located the named rules and collected phrase-level findings | Defer deletion until rule ownership and policy/taste impacts are reviewed; no generic vocabulary deletion or golden compensation |
| Opus 4: default shared intent | Ran the intent arm and independent invariants | Not promoted. Negation failures remain; visible golden success alone would be insufficient |
| Opus 5: Plex recall | 2,000 Plex / 90,000 catalogue stress measurement with exhaustive Plex scoring | Gap confirmed in this synthetic setting. Reservation-policy changes remain a separate decision |
| Opus 6: watch history | [Design note](MOODRANK_WATCH_HISTORY_DESIGN.md), current code inspection and official Plex documentation | Proposal only; no collection, schema or credential changes |
| GPT Pro: original corrections | Reused the existing cumulative correction stack | No duplicate stack or changes to open PRs |
| GPT Pro: follow-on engine | Imported and integrated all supplied source, training/evaluation helpers and component tests | Source-only experiments; no fitted model, encoder installation or provider calls |
| GPT Pro: integration | Fixed eight TypeScript contract errors, format-exclusion bypasses, semantic pre-top-k eligibility/freshness, replacement race checks, final-presentation trace accounting | Actual engine journeys cover adult/group vs explicit family filters, user isolation, shared group learning, deduplication, request fallback and post-rerank presentation |
| GPT Pro: independent quality | Preserved judgment completeness, group holdout separation and explicit model injection contracts | No independent judgments collected. Broad-change minimum and predeclared quality/runtime gates remain prerequisites |
| GPT Pro: #109 helper | Reviewed fingerprint-grounded evidence projection | Keep separate. It consumes fingerprint provenance; this candidate extracts description aspects. Combining their confidence scales needs an explicit contract and evidence, not parallel score additions |

## Default evaluation results

The same synthetic source base passed `eval:recommendations` and the 99-case
release-readiness gate before these changes. New golden results: one failure
(`do-over-but-better`, expected Paddington 2 in the top three), with NDCG@3 moving
from 0.8894 to 0.8738. Retrieval recall, top-ten recall, hard-constraint accuracy
and availability accuracy remain 1.0. All 40 adversarial cases pass, including
7/7 P0 cases. Profile calibration reports 12 wins, zero losses and three ties.

Release readiness is **failed**: 98/99 persona cases pass; all 28 P0 and 44 P1
cases pass. The P2 `subtitles-ok-international-gentle` case no longer puts Quiet
Village Letters in its top five. Its coverage-tag requirement also fails, so the
unchanged release gate correctly blocks it. Do not treat the P2 label as a waiver.
No expected title or threshold was edited. In a direct before/after final-response
comparison, Paddington 2 moves from rank three to four and Dungeons & Dragons:
Honor Among Thieves moves from four to three; both still display score 46.

The seven profile journeys pass with zero stable-journey replay losses and the
expected alert on the intentionally conflicting journey. One replay loss belongs
to that conflict case; it is not hidden by the aggregate result.

The invariant run covers 3,265 checks and 1,138 searches across structural, golden,
adversarial, profile and persona catalogues. It reports zero INV-HARD failures,
400 INV-NEG failures and two direct INV-LESS failures. Eight less-like sibling and
three more-like sibling movements remain diagnostic: relative sibling rank is
not guaranteed merely by a penalty. The direct less-like failures are
`profile:q0:reference` and `persona:q4:reference`.

On the structural catalogue, direct less-like failures fall from four to zero.
Negation failures remain 127. Equal displayed scores occur in 175/228 top-five
slates versus 177/228 before; integer display ties are expected even when internal
utilities differ. Structural p50/p95 is 7.13/12.54 ms versus 7.84/12.58 ms before.
These small in-memory timings do not establish a production improvement.

## GPT Pro ablations

Golden/adversarial rows use the actual final engine. Profile rows use scorer-stage
synthetic profiles. Counts below are failed assertions, not necessarily distinct
cases. All arms use visible developer fixtures and unfitted priors. The semantic
arm has no real encoder or populated independent index.

| Arm | Golden failures | Adversarial failures | P0 passed | Profile failures |
|---|---:|---:|---:|---:|
| baseline | 1 | 0 | 7/7 | 0 |
| intent | 1 | 0 | 7/7 | 0 |
| evidence | 7 | 23 | 5/7 | 16 |
| reference | 0 | 1 | 7/7 | 0 |
| retrieval | 1 | 0 | 7/7 | 0 |
| semantic | 1 | 4 | 7/7 | 0 |
| presentation | 1 | 1 | 7/7 | 0 |
| combined | 6 | 24 | 5/7 | 16 |

The combined arm fails `negation-light-not-comedy` and
`comparative-like-basement-less-bleak` among P0 cases. Its six golden failures and
24 adversarial failures prohibit a quality-success claim. No tuning was performed
to recover named fixture titles. The reference arm's better golden result also
is not promotion evidence: it loses an adversarial assertion.

## Plex-window measurement

Six repeated catalogue archetypes are replicated from repository-created rows
in a disposable in-memory database. Plex popularity is deliberately low. This
avoids measuring catalogue ingestion and does not model real-library diversity.
The oracle scores all 2,000 eligible Plex items; it is not an independent relevance
judge. Each final-engine query has one warm-up and five measured searches.

| Query | Eligible Plex retained | Share | Oracle top ten retained |
|---|---:|---:|---:|
| something funny | 219/2000 | 10.95% | 2/10 |
| a comedy for tonight | 219/2000 | 10.95% | 2/10 |
| cozy mystery | 220/2000 | 11.00% | 6/10 |
| something light | 224/2000 | 11.20% | 0/10 |
| an adventure movie | 284/2000 | 14.20% | 8/10 |
| a thriller | 219/2000 | 10.95% | 2/10 |

Across 30 warm searches: p50 158.46 ms; p95 218.41 ms.
The 3,000-item cap is unchanged. Next decision: compare an eligible-Plex-first
reservation against a larger fixed quota, using these same measurements and a
representative private catalogue only with separate authority. Retaining all
eligible Plex items could displace useful catalogue candidates; measure both sides.

## Overlap review

The expanded scan finds 1506 overlaps across 116 fixture records and 94 production files.
Long tokens such as `availability` and phrases such as `content rating` demonstrate
why automatic overlap is not proof of contamination. No findings were silently
allowlisted or accepted as known debt. The existing blocking guard stays intact.

The warm-date-night regex in `scoring.ts` is a concrete review candidate:
`rooftop songs`, `bright friendship`, `soft rain`, `tender friendship`,
`quiet warmth`, and `restrained coastal humor` overlap Rooftop Encore, Soft Rain
Sunday or Dry Harbor. The rule adds query/mood boosts. `grown-up workplace`
overlaps Grown-Up Sketchbook in the adult-animation boundary. These deserve
source-history/provenance review before deciding whether to remove alternatives.
`coastal`, `harbor`, `library`, `velvet` and `fog` also have general meanings;
string overlap alone does not justify deleting them. `isKnownPixarTitle` is a
separate title-keyed policy shortcut that should move toward authoritative
franchise metadata, not another title list.

## Verification and remaining boundaries

Validation uses installed Node 26.8.2 (repository engine range is >=24). It does
not establish exact Node 24 behavior. Final command status is recorded below.

| Check | Result |
|---|---|
| `npm run verify` | **Failed:** 1,833/1,834 tests pass; only the unchanged Do-Over golden assertion fails. Lint, full typecheck, documentation contracts, tracked-secret scan and blocking leakage guard pass |
| `npm run build` | Passed separately after the test gate stopped `verify` |
| `npm run verify:secrets` | Passed against generated client assets |
| `npm run test:packaging` | Passed, including packaged refresh and Compose configuration checks |
| `eval:recommendations` | Failed on the one golden ranking regression; 40/40 adversarial and 6/6 rank-index cases pass |
| `eval:moodrank-release-readiness` | Failed on the persona case and its coverage requirement described above |
| `eval:profile-journeys` | Passed |
| `eval:moodrank-invariants` | Completed, zero blocking hard-filter failures; diagnostic failures retained |
| `eval:moodrank-review` | All eight arms evaluated; combined arm fails quality expectations |
| `eval:moodrank-overlap` | Completed; 1,506 candidates require review; no blocking-policy edits |
| `eval:moodrank-plex-recall` | Completed with all corpus/window assertions passing |
| `git diff --check` | Passed |

Container smoke and exact Node 24 release verification were not run. The source
quality gates already block release. Packaging success is not container-runtime
or deployment evidence. The full `verify:release` contract is not satisfied.

No dependencies, schema, stored feature version, provider defaults, workflow gates
or live service construction were changed. The only public API addition is
optional `feedbackMoodTerm`; trace additions describe the experimental presentation
stage. No model was downloaded or trained; no live catalogue or private judgments
were used. No commit, push, PR, merge or deployment was performed.

The semantic prefilter now scans index IDs in batches before top-k. It checks
current filters, hidden/negative IDs and feature hashes, then rechecks returned
hits. It can exceed the existing timeout on a large index; that path remains an
explicit, fail-soft experiment. Index replacement and caller cancellation still
invalidate the result. Synthetic index tests do not prove real-model latency.

To roll back local runtime behavior, return to the cited base revision. No data
migration needs reversal. Preserve the local candidate until review is complete.
Stop before publication or activation while existing gates or independent quality
requirements remain unsatisfied.

## Repeatable commands

```sh
npm run verify
npm run eval:recommendations
npm run eval:moodrank-release-readiness
npm run eval:profile-journeys
npm run eval:moodrank-invariants
npm run eval:moodrank-review
npm run eval:moodrank-overlap
npm run eval:moodrank-plex-recall
npm run test:packaging
```

Detailed synthetic JSON/log receipts are retained outside the repository. The
invariant command supports `--output=<path>`; other diagnostic commands emit JSON.
The overlap command exits successfully when discovery completes even if its JSON
contains review findings. It is not a replacement for the blocking leakage guard.
