# MoodRank Next Improvement Release Plan

Status: release-management plan for the next major MoodRank improvement release.
Last updated: 2026-07-03.

## Purpose

The next major MoodRank release should make the recommendation system easier to assess and improve before it tries to feel dramatically smarter.

The practical goal is trace-first improvement: when a result is good, bad, missing, over-personalized, or strangely reranked, a reviewer should be able to tell which stage caused it:

- the request was parsed incorrectly;
- the right title was never retrieved;
- the title was retrieved but rejected by a hard rule;
- the score used weak or wrong evidence;
- AI reranking moved it for a reviewable reason;
- feedback or Feel Profile learning changed the ranking;
- a catalog-only record was not yet present in Plex and needed a trusted local interoperability ID before a Seerr request attempt.

This plan sits between the algorithm reference docs and the normal release checklist:

- Current behavior: [MoodRank Current Algorithms](MOODRANK_CURRENT_ALGORITHMS.md)
- Target architecture: [MoodRank Improvement Decisions And Target Plan](MOODRANK_IMPROVEMENT_PLAN.md)
- External-review packet: [MoodRank Agent Review Packet](MOODRANK_AGENT_REVIEW_PACKET.md)
- Repo release gate: [Release Readiness](RELEASE.md)

## Plain-Language Summary

This release is not mainly about adding one magic ranking model. It is about giving MoodRank a better dashboard for its own decisions.

The release should:

- show why a title was considered;
- show why a title was rejected;
- show how score buckets became the final rank;
- test more than exact title matches;
- compare new guardrails and retrieval strategies in shadow mode before they affect users;
- keep AI bounded to known candidates and reviewable reasons;
- record feedback in a way that distinguishes "I saw this", "I opened this", "more like this", "wrong mood", and "do not show this";
- leave later AI or affect enrichment as an offline/batch step, not a search-time dependency.

## What Changes

### Trace-first instrumentation

Recommendation runs should become reviewable by stage. A future debug trace should connect:

```text
SearchBrief
  -> candidate provenance
  -> eligibility and rejection reasons
  -> score trace
  -> deterministic ranking
  -> optional AI rerank trace
  -> final result list
  -> exposed slate and feedback events
```

For a non-specialist, this means MoodRank should be able to answer: "Did it misunderstand me, miss the title, filter it out, score it badly, or let AI move it?"

### Richer evals

Evals should move beyond "did a specific title appear?" They should also check:

- candidate families, such as "a good Paris time-travel romance should appear";
- titles that should be retrieved even if they are not top-ranked;
- titles rejected for the right reason;
- trace completeness;
- hard-filter accuracy;
- AI-on versus AI-off differences;
- latency and candidate-window size;
- feedback semantics, including which actions train and which actions are diagnostic only.

### Guardrail shadow and parity

Guardrails are deterministic rules that protect user intent, such as "not horror", "short", "not too scary", "available in Plex", or "requestable only".

The next release should test new or reorganized guardrails in two steps:

1. Shadow mode: compute what the new guardrail would do, but do not change results.
2. Parity mode: prove the new path matches current behavior where it should, and improves only the intended cases.

Only after that should a guardrail change become active behavior.

### Adaptive retrieval shadow mode

Current retrieval chooses a selected candidate window, usually 1,000 to 3,000 IDs depending on catalog size. That is practical, but a very large imported catalog can still hide a strong match outside the selected window.

Adaptive retrieval shadow mode should calculate what a smarter candidate window would have selected, without changing the displayed results at first. The trace should show when shadow retrieval found a likely better candidate outside the current window, and what the cost would have been.

### Rerank v2 planning

AI reranking should stay constrained to known candidate IDs. The next step is a clearer contract, not more authority.

Rerank v2 planning should define:

- rerank confidence;
- rationale category;
- deterministic-rank disagreement;
- invalid or duplicate ID handling;
- fallback reason;
- model, schema, and prompt version;
- shortlist stratification reason;
- whether a taste-scout signal and rerank signal overlapped.

The acceptance target is reviewability. The AI still cannot invent availability, request status, or titles outside the backend shortlist.

### Exposure-aware feedback logging

Feedback should know what the user actually saw. A future feedback event should be able to say:

- which recommendation session produced the slate;
- which rank and availability group the item appeared in;
- whether the item was merely displayed, opened, hidden, liked, disliked, requested, or marked as the wrong mood;
- whether the action is allowed to train broad preference, mood-term learning, both, or neither;
- whether the event was deduped;
- what profile version existed before and after the event.

This reduces accidental learning. Opening a card should not mean "more like this." A request preview should not mean "this matched the mood." A clear right/wrong mood action should carry more weight.

### Later offline affect enrichment

Offline affect enrichment means adding richer mood, tone, and emotional-shape labels from an offline or batch process. This may use AI later, but it should write evidence-backed, versioned `ContentFingerprintV1` data and stay out of the normal search hot path.

This is deliberately later than trace/eval work. Enrichment is only useful if MoodRank can prove whether the added labels improved retrieval and ranking.

## What Does Not Change

- Plex and Seerr/Jellyseerr remain the source of truth for availability, requestability, request status, posters, and request creation.
- Request creation remains preview plus explicit confirmation.
- Hard filters stay deterministic and outside AI.
- Search must still work when AI is disabled.
- AI may parse soft intent, rerank known candidates, summarize, and suggest refinements, but it cannot invent catalog truth.
- Catalog-only imported records remain ineligible for normal results until Plex or Seerr verifies availability/requestability.
- Diagnostics must avoid secrets, private URLs, poster paths, and raw prompts by default.
- Existing user-facing ranking should not change during shadow-only stages except for intentional, separately reviewed feature flags.

## Staged Plan

### Stage 0: Baseline And Release Harness

Purpose: make the current state measurable before changing behavior.

Work:

- Record the current release tag or image from [Release Readiness](RELEASE.md).
- Record the current algorithm version and relevant notes from [MoodRank Current Algorithms](MOODRANK_CURRENT_ALGORITHMS.md).
- Pick a stable live double-test query set before implementation starts.
- Capture baseline local command output for the release gate and MoodRank eval commands.
- Capture a short baseline from the live app: a few representative searches, AI off and AI on, including at least one feedback/refinement loop.

Acceptance:

- baseline commands are recorded with date, commit, and database context;
- live baseline notes include exact queries, filters, watch context, AI setting, and top results;
- no source-of-truth assumptions are left implicit.

### Stage 1: Trace Foundation

Purpose: make recommendation runs explainable without changing rank behavior.

Work:

- Keep trace writes disabled by default for normal production use. Enable with `MOODRANK_TRACE_WRITE=on` for local evals, live double-testing, or debug sessions.
- Add or expose a durable search brief shape.
- Record candidate provenance for selected candidates.
- Record eligibility and rejection reasons for debug or sampled runs.
- Record score traces alongside existing score buckets.
- Include trace status in diagnostics.
- Store brief summaries, counts, and hashes rather than raw prompts, arbitrary query tokens, reference title text, secrets, private URLs, or poster paths.

Acceptance:

- a failed or surprising search can be classified as intent, retrieval, eligibility, scoring, rerank, or feedback;
- trace output does not change the displayed ranking by itself;
- trace payloads remain bounded and safe for local diagnostics/support export;
- a reviewer can compare score buckets to score trace contributions without reverse-engineering the code;
- `MOODRANK_TRACE_WRITE=off` writes no trace JSON or normalized trace rows;
- `MOODRANK_TRACE_WRITE=on` can be enabled for targeted assessment and release testing.

### Stage 2: Richer Evals

Purpose: make improvements measurable before they reach live usage.

Work:

- Add eval cases for candidate families, not only exact title hits.
- Add retrieved-but-not-selected expectations.
- Add rejection-reason expectations.
- Add provenance and score-trace sanity checks.
- Add AI-on versus AI-off disagreement checks.
- Add latency/candidate-window reporting for no-AI, AI-rerank, taste-scout, and Seerr-augmented paths.
- Add feedback semantics checks for preferred, more-like, maybe, less-like, hidden, reason chips, and pairwise choices.

Acceptance:

- eval failures identify the failing stage, not only the final rank;
- hard-filter and availability failures remain blocking;
- quality metrics and latency metrics are reported together;
- new evals can be run locally without private prompts or external data that cannot be committed.

### Stage 3: Guardrail Shadow And Parity

Purpose: improve deterministic guardrails without accidentally changing good current behavior.

Work:

- Run proposed guardrail logic in shadow mode.
- Compare old and new guardrail outcomes for explicit constraints such as runtime, media type, excluded genres, not-scary, not-horror, availability, and request status.
- Classify differences as intended improvement, harmless difference, or regression.
- Keep AI unable to loosen hard filters.

Acceptance:

- current passing hard-filter evals still pass;
- shadow differences are reviewable in diagnostics or eval output;
- intended improvements have named test cases;
- no known good query loses its best eligible match without an explained rejection reason.

### Stage 4: Adaptive Retrieval Shadow Mode

Purpose: find out whether the selected candidate window misses strong large-catalog matches before changing production ranking.

Work:

- Compute an adaptive retrieval candidate set beside the current selected window.
- Record when shadow retrieval finds strong candidates outside the current 1,000 to 3,000 item window.
- Compare candidate recall, latency, and memory cost.
- Preserve catalog-only eligibility rules.
- Keep AI reranking bounded to a safe top slice.

Acceptance:

- shadow mode does not change displayed results;
- diagnostics show library count, retrieval count, selected-window count, scored count, rerank count, and shadow-only candidates;
- evals prove at least one candidate-cap miss can be detected or corrected before AI reranking;
- latency stays within an agreed local target before active rollout.

### Stage 5: Exposure-Aware Feedback Logging

Purpose: make feedback safer and more useful for learning.

Work:

- Record exposed recommendation slate context.
- Attach feedback to session, item, rank, action, reliability, watch context, and profile version.
- Keep diagnostic actions from training mood-term profiles.
- Keep weak actions weak.
- Preserve dedupe behavior through client event IDs.
- Report which feedback classes trained broad preference or Feel Profile state.

Acceptance:

- `open`, `expand`, `swipe_skip`, and request preview style actions remain diagnostic unless intentionally changed later;
- medium/high feedback is the only class allowed to train Feel Profile terms;
- solo and group profile isolation remains enforced;
- replay reports can explain which events trained and which were held out;
- accidental repeated taps cannot swing a term profile beyond the existing safety caps.

### Stage 6: Rerank V2 Contract Planning

Purpose: make AI reranking easier to audit before broadening its use.

Work:

- Define the v2 rerank trace fields.
- Define shortlist stratification rules.
- Define deterministic-rank disagreement reporting.
- Define fallback behavior for model failure, schema failure, invalid IDs, duplicates, low confidence, and timeout.
- Decide whether taste scout should merge into rerank v2, remain separate, or become an explicit parallel trace.

Acceptance:

- the plan preserves backend availability and request status exactly;
- deterministic leftovers remain available when AI omits candidates;
- AI cannot add unknown candidates;
- disagreement is visible and bounded;
- AI-off quality remains strong enough for normal use.

### Stage 7: Active Release Slice

Purpose: ship only the pieces that have passed shadow and eval gates.

Work:

- Enable trace diagnostics and eval improvements first.
- Enable active guardrail or adaptive retrieval behavior only after shadow evidence is reviewed.
- Keep high-risk behavior behind a clear runtime/config switch until live double-test passes.
- Update [MoodRank Current Algorithms](MOODRANK_CURRENT_ALGORITHMS.md) only when actual behavior changes.
- Update [Release Readiness](RELEASE.md) if the release gate changes.

Acceptance:

- `npm run verify:release` passes on the exact commit intended for image publishing;
- MoodRank-specific evals and catalog checks are recorded;
- live double-test passes before the new image is treated as the working baseline;
- rollback path is known before deployment.

### Later Stage: Offline Affect Enrichment

Purpose: improve sparse or thin items after the trace and eval system can prove the benefit.

Work:

- Add offline or batch enrichment that writes versioned fingerprint fields.
- Keep enrichment evidence-backed and confidence-scored.
- Keep enrichment out of the search hot path.
- Provide review/export support for enriched fingerprint diffs.
- Preserve deterministic fallback when enrichment is missing or rejected.

Acceptance:

- enriched data improves sparse-item evals without violating catalog truth;
- hallucinated or unsupported facts can be rejected, downgraded, or ignored;
- cost, latency, and privacy impact stay outside normal user search;
- no AI-enriched term becomes availability/requestability truth.

## Release-Level Acceptance Gates

Do not treat this release as ready because the UI feels good once. Treat it as ready only when these gates pass.

### Gate A: Documentation Alignment

- New behavior is reflected in the relevant algorithm doc.
- Planned behavior remains in this release plan or the improvement plan.
- The production roadmap points to this release plan.
- Release notes clearly distinguish instrumentation, shadow behavior, active behavior, and deferred work.

### Gate B: Local Verification

Run the normal release gate:

```bash
npm run verify:release
```

Also run the MoodRank-focused commands that apply to the release slice:

```bash
npm run eval:recommendations
npm run eval:profile-journeys
npm run eval:profile-replay
npm run eval:catalog-readiness
npm run bench:catalog-search
```

`bench:catalog-search` is a repeated local diagnostic, not the protected beta responsiveness gate. It exits nonzero when index membership or scored-result coverage makes the evidence invalid; its 250/750/1000 ms latency targets remain advisory because host cache and contention materially affect them. Use `npm run bench:catalog-search -- --enforce-advisory-targets` when deliberately optimizing against those local targets. The release decision still uses the native two-CPU/two-GiB black-box thresholds in [Beta release criteria](BETA_RELEASE_CRITERIA.md).

If a local database has a large imported catalog, also record whether feature and fingerprint backfills are current:

```bash
npm run backfill:features:repair
```

Use bulk rebuild commands only when the release intentionally changes feature/fingerprint rules or the database is known stale:

```bash
npm run backfill:features:bulk
npm run backfill:content-fingerprints:bulk
```

### Gate C: Trace Safety

- No token, private URL, raw support bundle, local hostname, poster path, or secret appears in diagnostics.
- Raw prompts are not stored by default.
- Raw query capture for the review queue is disabled unless explicitly enabled with `MOODARR_REVIEW_CAPTURE_RAW_QUERIES=true` or the matching admin setting.
- Trace payloads are bounded enough for normal local use.
- Support/export views mask private data.

### Gate D: Shadow Parity

- Shadow guardrails and shadow adaptive retrieval do not change displayed results until explicitly enabled.
- Differences are counted and classified.
- Intended differences have named eval cases.
- Regressions are either fixed or held out of the active release slice.

### Gate E: User-Visible Quality

- AI-off search still works.
- AI-on search improves explanation or ordering without violating deterministic truth.
- Availability labels and request previews match Plex/Seerr state.
- Hard filters remain strict.
- Feedback actions do not train the wrong state.
- Latency remains acceptable for normal live use.

### Gate F: Rollback Readiness

- Previous working image/tag is known.
- Database backup or snapshot exists before schema-affecting changes.
- New active behavior can be disabled or the previous image can be redeployed.
- If new trace/feedback tables are additive, old code can ignore them or the rollback note says otherwise.

## User Reminders

- This release is about making MoodRank assessable first. Some improvements may be invisible until enough traces and evals exist.
- Keep one stable query set for before/after comparisons. Changing the query set mid-test makes the result hard to interpret.
- Always test AI off and AI on. AI-on success does not prove deterministic MoodRank is healthy.
- Do not judge ranking quality only by the top result. Look at whether the right family of candidates appears, whether bad candidates are rejected for the right reason, and whether availability is exact.
- Treat live state and local state separately. A passing local eval does not prove the deployed container, live database, and live config are current.
- Do not let catalog-only records become user-visible availability truth.
- If a test result is surprising, classify the stage before changing weights.
- Do not publish a new image tag until the release gate passes on the exact commit.

## Release Checklist

### Before Implementation

- Confirm the intended release slice: trace only, trace plus evals, shadow guardrails, shadow retrieval, feedback logging, active behavior, or a mix.
- Record current commit, package version, image tag, and live deployment tag.
- Pick the live double-test query set.
- Note whether the local database is fixture, small real library, or large catalog import.
- Confirm whether OpenAI is configured for AI-on tests.

### Before Merge Or Tag

- Run `npm run verify:release`.
- Run MoodRank evals relevant to the slice.
- Record any changed eval baselines.
- Confirm docs distinguish current behavior from planned/deferred behavior.
- Confirm no docs or generated artifacts include secrets, local hostnames, screenshots, support bundles, or raw private prompts.
- Confirm the rollback plan still works if schema or persisted trace data changed.

### Before Live Deploy

- Back up or snapshot the live data directory if the release changes stored recommendation, trace, feedback, or profile data.
- Record the current live image/tag and admin diagnostics summary.
- Run the before-deploy half of the live double-test checklist.
- Confirm the Unraid template or Compose config points at the intended versioned image tag or immutable digest, not `latest`.
- Confirm any new runtime switches are set to their intended shadow or active mode.

### After Live Deploy

- Confirm the new image/tag is actually running.
- Run the after-deploy half of the live double-test checklist.
- Compare old and new top results, availability groups, request preview behavior, latency, and diagnostics.
- Test at least one feedback loop and confirm the diagnostic/training class is correct.
- Keep the previous image/tag available until the test passes.

## Live Double-Test Checklist

The live double-test means: test the same real app before deploy and after deploy, using the same queries, same user/profile context, same filters, and same AI setting.

### Prepare The Query Set

Use 8 to 12 queries that cover common and risky behavior:

- a cozy or easy-watch prompt;
- a dark-but-not-scary prompt;
- a short runtime prompt;
- a group/crowd-pleaser prompt;
- a reference-title prompt such as "like X";
- a requestable or include-requests prompt;
- an explicit exclusion such as not horror or not animated;
- a feedback refinement such as more like one result and less like another;
- a sparse or catalog-heavy prompt if a large imported catalog is present;
- one AI-off query and one AI-on query for the same text.

### Before Deploy

- Record live image/tag, commit if available, package version if visible, and date.
- For each query, record AI setting, watch context, filters, top 5 titles, availability labels, requestability labels, and any obvious misses.
- Open one result detail panel and verify availability/request preview facts.
- Submit one harmless feedback action such as more-like or less-like only if the test environment can tolerate training data.
- Export or inspect admin diagnostics if available, confirming secrets are masked.

### After Deploy

- Confirm the new live image/tag is running.
- Rerun the same queries in the same order.
- Record the same top 5 fields and compare against the before-deploy notes.
- Confirm active behavior changed only where intended.
- Confirm shadow-only behavior appears only in diagnostics and does not affect displayed results.
- Confirm hard filters, availability, and request preview behavior still match Plex/Seerr.
- Confirm no catalog-only unverified item appears as available or requestable.
- Confirm latency is not obviously worse for normal searches.
- Confirm feedback logging records the right action/reliability/training class.

### Pass Criteria

- No hard-filter regression.
- No availability or requestability regression.
- No AI-invented title, ID, poster, availability, or request status.
- No secret or private URL appears in diagnostics.
- Shadow features remain shadow-only until intentionally enabled.
- Ranking changes are explainable by trace, eval, or intentionally enabled behavior.
- The previous live behavior can be restored quickly if a blocker appears.

## What To Look For When Testing

### Good Signs

- The right kind of titles appear even when the exact best title is debatable.
- Missing or rejected candidates have a clear trace reason.
- Hard exclusions feel boringly reliable.
- AI-on results are better explained but do not violate backend facts.
- Feedback has a visible but bounded effect on the next search.
- Profile learning stays scoped to solo/group context.
- Diagnostics explain counts: library, retrieved, selected, scored, reranked, rejected, and shadow-only.

### Bad Signs

- A strong title is absent and there is no trace showing whether it was missed, rejected, or scored poorly.
- A hard exclusion is treated like a soft preference.
- A catalog-only item appears as Plex-available without Plex evidence, or request-eligible without a trusted local interoperability ID.
- AI-on search succeeds but AI-off search is poor for basic constraints.
- Opening cards or previewing requests appears to train mood preference.
- The same feedback event can be applied repeatedly.
- Shadow mode changes visible ranking.
- Latency grows without a clear candidate-recall improvement.
- Diagnostics include raw prompts, local URLs, tokens, poster paths, or other private details.

## Rollback Plan

Prefer rollback in this order:

1. Disable active new behavior and leave trace/shadow logging on only if it is safe.
2. Disable trace/shadow logging too if it causes latency, storage, or privacy issues.
3. Redeploy the previous known-good image/tag.
4. Restore the pre-deploy database backup only if persisted data changes are incompatible or harmful.

Rollback notes:

- Keep schema changes additive where possible so old code can ignore new trace tables.
- If a release requires non-additive schema changes, write a specific rollback note before deployment.
- Do not delete feedback or trace data by default. Export or snapshot first if it may be needed for diagnosis.
- If learned profile state is suspected to be harmed, prefer profile-term rollback/checkpoint tooling over deleting raw events.
- After rollback, rerun at least one before/after query from the live double-test set to confirm the old behavior is back.

## Stage Ownership At A Glance

| Stage | Main Value | User-Visible Change | Release Risk |
| --- | --- | --- | --- |
| Baseline | Known starting point | None | Low |
| Trace foundation | Explains failures | Diagnostics only | Low to medium |
| Richer evals | Safer changes | None | Low |
| Guardrail shadow/parity | Safer hard rules | Shadow only at first | Medium |
| Adaptive retrieval shadow | Finds candidate-window misses | Shadow only at first | Medium |
| Exposure-aware feedback | Safer learning | Minor diagnostics unless UI changes | Medium |
| Rerank v2 planning | Bounded AI reviewability | None until implemented | Low |
| Active release slice | Real ranking/behavior gains | Yes, only after gates | Highest |
| Offline affect enrichment | Better sparse-item understanding | Later, after proof | Medium to high |
