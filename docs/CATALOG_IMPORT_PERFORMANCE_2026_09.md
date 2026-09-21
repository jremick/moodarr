# Full-snapshot catalog import fix

This source fix follows the immutable `v0.1.0-beta.2` release. It is not included in that release image. The beta.2 advice to use Plex-only discovery remains applicable to that image until a fixed release is published.

## Change

Each imported title previously deleted its rows from two FTS tables using an unindexed media ID. These repeated scans caused quadratic work as the catalog grew. Each title also prepared the complete catalog projection statement again.

The full-snapshot CLI now defers those search writes and rebuilds both indexes once after source retirement marking. Source records, features, fingerprints and mood scores still update inside the same transaction. The final bound-file hash check runs after rebuilding and before commit. Missing or failed finalization, import failure and final hash failure roll back the snapshot.

Incremental imports and trusted recovery retain immediate indexing. No schema, tokenizer, ranking weight, dependency, provider policy or feature flag changes are included. The change does not claim to improve ordinary incremental import scaling or recommendation quality.

## Correctness checks

- Focused catalog, atomicity, recovery, readiness and recommendation checks: 229 tests passed.
- Full `npm run verify`: 86 suites and 1,513 tests passed, with lint, typecheck, documentation, leakage, builds and secret checks.
- Failure tests cover both index rebuilds, omitted finalization, a caught rebuild error, final hash failure and an automatically aborted transaction. Ordinary writes work after success and rollback.
- Parity tests cover inserted, changed and unchanged records; multiple batches; source retirement; shared-source and Plex-retained titles; operational exclusion; stale, missing and duplicate FTS rows; genre/person order; and search result order.
- Operation counts prove zero per-item search-index writes during deferral, followed by one bulk delete and insert for each index table. Later writes resume immediate indexing.

## Public subset comparison

Baseline: release source `4522fa3feb2af393dcf15893b94b961f212752d6`. Fixed production source: `0c8e1f229dcded6a4808bc02db79d5a75a57b060`.

The same first 1,000, 2,000 and 4,000 records from the pinned public asset were imported through the real full-snapshot CLI with batches of 250. Each run used a fresh database, exact input hash, Node 24.20.0 and a 60-second timeout on macOS.

| Source records | Baseline elapsed | Fixed elapsed |
| ---: | ---: | ---: |
| 1,000 | 2.246 s | 0.981 s |
| 2,000 | 4.307 s | 1.456 s |
| 4,000 | 10.306 s | 2.924 s |

Both FTS table content hashes and the catalog projection content hash matched the baseline exactly at every size. All six table counts matched. Integrity checks returned `ok`; foreign-key errors, missing index members, orphan members and duplicate members were zero. Timing is supporting evidence from single local runs, not a cross-platform latency guarantee.

## Full pinned catalog

Native validation passed on Linux amd64 with Docker 27.5.1. The unpublished test image was built from the fixed source above; its Docker image ID was `sha256:816c6b5b4d5b835a729806eb999f4c0083de5ca2bdf62a405be24e3167687c56`. This is not the beta.2 release image. Later documentation changes do not change the measured application code or lockfile.

The run used the exact public 90,397-record asset, SHA-256 `dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a`, in fresh disposable storage. Containers ran as user 999 with two CPUs, two GiB memory, no network or published ports, a read-only root filesystem and a 900-second workload limit. The host had no swap.

- The full-snapshot CLI imported all 90,397 source records with zero skips in 217.858 seconds. Both the expected and final file hashes matched. All refresh/repair requirements finished at zero.
- The import materialized 90,361 media items. Each feature and catalog index had 90,361 rows, with zero missing, orphan or duplicate IDs. SQLite, foreign-key and both FTS integrity checks passed before application startup and after restart. Representative FTS `MATCH` queries returned results.
- Runtime checks passed before and after restart: exact revision and processing policies, two search workers and one idle sync worker ready, no configured integrations, and anonymous Admin access rejected. The application became healthy and exited cleanly, with no OOM or automatic restarts.
- All 13 other table content hashes and all 13 non-timestamp catalog projection columns were unchanged after startup and restart. Existing startup maintenance refreshed only `catalog_search_index.updated_at` for 49 items whose deterministic mood term sets are empty. The raw projection hashes and exact timestamp-change count were retained; those empty sets legitimately have no deterministic mood-score rows.
- The complete import, cold checks, startup and restart sequence took 266 seconds. Disposable workload containers and the volume were removed. The existing EXP container/image, controls, start time, health and restart/OOM readbacks matched before and after the run.

Two earlier validation attempts stopped on errors in the benchmark helper: it first assumed every title needed a mood-score row, then referenced a nonexistent diagnostics field. Both imports completed, but neither attempt counts as a complete native pass. The helper was corrected against the source contracts and checked with positive and negative fixtures before the successful run. Application code did not change between these attempts.

## Limits

The earlier stopped long import is not a measured baseline for this comparison. These checks do not establish that the two removed scan paths caused its entire duration. A later release still needs its own release evidence and approval; this source fix does not complete the deferred independent ranking evaluation or real Plex/Seerr manual matrix.
