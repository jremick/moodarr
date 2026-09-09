# MoodRank v0.5.2 correctness upgrade and rollback

Status: candidate implementation, not approved for release or automatic deployment.

## Changed contracts

The candidate uses engine `moodrank-v0.5.2`, deterministic feature version `moodrank-v0.4-features-v4`, and fingerprint rules `fingerprint-rules-v3`. The fingerprint version includes the feature version. No database-schema or provider-output contract changes are required.

The fixes separate true-crime subject preference from nonfiction intensity, use complete affirmative cue occurrences for derived descriptive evidence, stop inferring whole-series commitment from unscoped TV runtime, and preserve explicitly requested meditative/slow-burn attention under a quiet request. Existing genre/certification priors and the remaining independent lexical/scoring interpreters are not a fully calibrated content model.

`runtimeMinutes` and existing API runtime-filter semantics are unchanged. A TV duration has no newly invented scope. The candidate does not manufacture episode counts, limited-series status, completion, or a verified whole-series total. Existing explicit single-episode requests still use the existing runtime filter. Descriptive evidence for limited-series or closed-ended format remains usable, but duration alone is not that evidence.

## Required derived-state refresh

Do not deploy the code over a large stale catalogue and assume a bounded startup backfill repairs every row. Stop the service and work on an operator-authorised offline copy first. Preserve the original database, WAL/SHM state using the deployment's supported consistent backup process, configuration, and existing provenance/checkpoint records.

Use the documented full feature refresh, with the offline copy selected by the normal Moodarr environment/configuration:

```sh
npm run backfill:features:bulk
```

For this change, **do not substitute `backfill:features:repair`**, which deliberately skips content-fingerprint repair. The full refresh must regenerate feature text, local vectors, feature FTS, deterministic mood rows, fingerprints and their mood projections from original metadata. Preserve independently imported mood-score sources; do not delete all mood rows or rewrite an old generated label into a new one.

The existing bulk command is bounded by batches and defaults to stale-only selection. An interrupted run can be repeated to select remaining stale rows. Completion is not established by exit code alone: inspect coverage/progress, confirm stale feature/fingerprint counts are zero, inspect generated source versions and verify relevant FTS projections on the disposable copy. Follow the existing stopped-service workflow for the eventual operator-authorised production refresh.

Provider embeddings are not regenerated externally by these changes. Existing compatibility checks reject mismatched feature versions/input hashes. Keep the official local-only build policy. Any subsequent provider warmup requires its existing authorisation and must not run automatically as part of this repair.

## Historical preferences and replay

Stored `runtime:short series`, `runtime:long series` and hyphenated equivalents may encode old episode-duration assumptions. Keep historical weights, events and checkpoints, but do not translate them into a new commitment or episode-duration meaning. New/active item profile keys and broad-preference training no longer emit those unsupported series-duration keys.

Other historical mood weights can have been trained on the previous feature rules. This candidate does not claim to reconstruct that evidence. Do not silently replay old events against newly derived features and describe the result as unbiased historical improvement. Preserve a version-compatible snapshot for comparisons, or explicitly mark the comparison not comparable.

## Rollback

A code rollback alone does not roll back derived state. Prefer restoring the consistent pre-upgrade snapshot with the matching previous code. Alternatively, regenerate the full derived catalogue under the previous code on an offline copy and verify compatibility before replacing the installation. The schema remains compatible, but regenerated features/profile semantics and old preference contributions can differ. Never reset user feedback or checkpoints merely to obtain a clean evaluation.

## Validation and promotion

Developer tests use disposable data, production imports and final engine responses. They are not an independent corpus. The new PR records exact supported-runtime results, unresolved failures and missing evidence. Preserve the existing evaluation-leakage, hard-constraint, availability, privacy, authentication, confirmation, packaging and rollback gates.

The feature/scoring changes can affect many queries. Broad default/release activation requires the independent evaluation protocol and its at-least-100-case broad-change threshold, not just passing visible regression cases. No accuracy or satisfaction percentage is inferred from this repair. No live backfill, merge, release, model download or deployment is performed by the implementation work.

## Subsequent v0.5.3 cue-rule revision

The follow-through candidate uses `moodrank-v0.4-features-v5` and `fingerprint-rules-v4`, including non-/free and comparative cue handling. The same full stopped-service refresh, imported-source preservation, embedding compatibility checks and matched-code/data rollback apply. This is not a query-only patch; prior v4/rules-v3 snapshots are stale for the new content rules. No live refresh has been executed by implementation work. See [completion contract](MOODRANK_COMPLETION_2026_09.md).
