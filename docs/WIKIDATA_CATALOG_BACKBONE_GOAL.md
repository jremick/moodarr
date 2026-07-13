# Wikidata Catalog Backbone Goal

Status: historical alpha implementation goal; the local Wikidata import/indexing spine remains active, while live Seerr verification described below is excluded from the official beta.
Last updated: 2026-07-13.

> Public beta boundary: catalog records may use trusted locally supplied TMDB IDs for confirmed Seerr request attempts, but the official `v0.1.0-beta.1` image does not run Seerr descriptive search/details or a requestability preflight. References below to bounded Seerr verification document the earlier alpha/source path, not the supported beta runtime contract.

## Goal

Build a Wikidata-first open catalog backbone that broadens Moodarr's local candidate universe without weakening the existing availability contract.

Moodarr should be able to ingest open structured catalog facts, generate the existing feature/FTS/mood indexes for those records, and keep source provenance visible. Catalog-only records must not appear as normal recommendations until Plex verifies local availability or Seerr verifies requestability.

## Source Contract

- Wikidata is the preferred backbone for bundled or locally imported structured facts because its structured data is CC0.
- Wikipedia-derived prose can be optional enrichment later, but it needs attribution/share-alike handling before raw text or derived text is redistributed.
- Seerr remains the only source of requestability.
- Plex remains the only source of local availability.
- TMDb can stay optional for richer metadata, but it is not required for the first open-catalog spine.

## Implemented Backend Shape

The alpha is intentionally a bounded local harvest/import, indexing, and readiness path, not a full Wikidata crawler.

- Schema: `catalog_source_records`, `catalog_rank_signals`, and `catalog_sync_runs`.
- Repository API: `upsertCatalogRecords`, `catalogSourceSummaries`, `catalogDiagnostics`, `catalogRankScoreMap`, and `catalogVerificationCandidates`.
- Importer: `src/server/catalog/wikidataCatalogImporter.ts`.
- Harvester: `npm run harvest:wikidata-catalog -- --output .data/wikidata-mainstream-alpha.jsonl --movie-limit 1000 --tv-limit 500 --page-size 250 --min-sitelinks 20`.
- CLI: `npm run import:wikidata-catalog -- --file /path/to/wikidata-catalog.jsonl --version wikidata-YYYY-MM-DD`.
- Readiness CLI: `npm run eval:catalog-readiness -- --min-ready 1`.
- Recommendation gate: catalog-only rows can be retrieved and rank-indexed, but deterministic recommendation eligibility excludes them until Plex or Seerr attaches.
- Ranking path: catalog rank signals are a bounded retrieval source and a small additive rank-index signal. Existing non-catalog searches keep their current MoodRank weighting.
- Verification loop: when Seerr augmentation is already warranted, the engine checks a bounded set of high-ranking catalog-only candidates by exact title/media-type/year match before normal broad Seerr searches run.
- Verification ordering: catalog verification candidates respect resolved hard filters, including media type and excluded genres, and apply prompt-aware guardrails for comfort, not-scary, group-friendly, and weird/offbeat prompts before Seerr lookups.
- Diagnostics: admin recommendation diagnostics include catalog source summaries, catalog-only/verified/stale counts, rank/feature/mood readiness counts, and top catalog-only candidates worth requestability checking.
- Metadata boundary: catalog imports can add provenance and fill empty fields, but they do not erase existing non-catalog summaries, genres, cast, or directors when a catalog row attaches to a Plex/Seerr item.

## Merge-Ready Alpha Goal

Alpha success means the new open catalog is ranked-ready for search tests:

- A normalized Wikidata JSON/JSONL import creates media rows, feature rows, mood feature rows, catalog provenance, sync ledger rows, and catalog rank signals.
- Search retrieval treats catalog rank as a bounded source, so high-signal mainstream catalog rows can enter the candidate pool even when a large imported catalog would otherwise push them past fallback limits.
- MoodRank v0.4 can rank-index those rows without recommending catalog-only items as watchable/requestable until Plex or Seerr verifies them.
- The bounded Seerr verification loop can promote an exact catalog match to `not_in_plex_requestable` and rerun retrieval/scoring.
- `npm run eval:catalog-readiness -- --min-ready <n>` can be used as a local gate before running search tests against an imported catalog.
- No bundled Wikidata dump or non-CC0/non-redistributable derived data is committed.

## Alpha Architecture

```text
normalized Wikidata JSON/JSONL
  -> import:wikidata-catalog
  -> media_items(source='catalog') + external_ids
  -> media_features + media_mood_feature_scores
  -> catalog_source_records + catalog_rank_signals + catalog_sync_runs
  -> retrieval catalogRankScores
  -> MoodRank v0.4 rank index
  -> catalog-only eligibility gate
  -> bounded Seerr verification
  -> verified requestable/live recommendation result
```

Trust boundaries:

- Wikidata/catalog rank signals are metadata and discovery signals only.
- Plex remains the only local availability truth.
- Seerr remains the only requestability truth.
- Catalog rank never creates a request, never marks availability, and never bypasses exact-match verification.

## Build Plan

### Slice 1: Local Catalog Spine

Status: implemented in this branch.

- Add a `catalog` media source for open catalog rows.
- Add source provenance tables for catalog records.
- Add weak rank-signal storage for mainstream/metadata confidence signals.
- Keep catalog-only records out of normal recommendations until Plex or Seerr attaches.
- Expose catalog source summaries through recommendation diagnostics.
- Add regression coverage for the catalog-only eligibility boundary.

### Slice 2: Wikidata Import Adapter

Status: implemented in this branch.

- Added a local JSON/JSONL importer that accepts normalized Wikidata records.
- Maps Wikidata IDs, IMDb/TMDb/TVDB IDs, labels, aliases, year, media type, genre, cast, director, country, language, franchise, and optional sitelink/award counts.
- Records `licensePolicy: wikidata-cc0`, source version, source item ID, source URL, payload hash, fetched timestamp, and sanitized metadata.
- Does not store raw Wikipedia prose in this slice.

### Slice 3: Feature And Eval Expansion

Status: implemented in this branch.

- Added regression fixtures for catalog-only, Seerr-verified, and live-upgraded catalog records.
- Catalog records generate the normal feature, FTS, semantic, and mood-index rows through the existing repository path.
- Added diagnostics for catalog-only count, Plex-verified count, Seerr-verified count, requestable-verified count, stale source records, and top missing requestability checks.

### Slice 4: Requestability Verification Loop

Status: implemented in this branch.

- Added a bounded Seerr verification loop for high-ranking catalog candidates.
- Promotes records to requestable only when Seerr resolves an exact title/media-type/year match and reports it as requestable.
- Keeps normal search usable without live Seerr or Wikidata calls; failed Seerr lookups are swallowed and normal results continue.

### Slice 5: Ranked Search-Readiness

Status: implemented in this branch.

- Added catalog rank scores as a bounded retrieval source.
- Added catalog rank as a small additive MoodRank v0.4 rank-index signal.
- Added diagnostics for rank-signal, feature-index, mood-index, and ranked-search-ready catalog counts.
- Added `npm run eval:catalog-readiness -- --min-ready <n>` for local alpha gating.
- Added large-catalog regression coverage showing a high-rank catalog item can enter the candidate pool even when it falls outside the first 500 title-sorted fallback items.

### Slice 6: Local Mainstream Alpha Catalog

Status: implemented and imported locally on 2026-06-30.

- Harvested `.data/wikidata-mainstream-alpha.jsonl` from public Wikidata Query Service: 1,000 film rows and 500 television-series rows, all with at least 20 sitelinks.
- Imported into the configured local DB at `.data/moodarr.sqlite` with source version `wikidata-mainstream-alpha-2026-06-30`.
- Import result: 1,500 records read, 1,500 imported, 0 skipped.
- Catalog state after import: 1,500 source records, 1,464 distinct catalog-linked media items, 1,464 rank-signal rows, 1,464 feature-indexed items, 798 mood-indexed/ranked-search-ready items.
- Availability split after import: 821 catalog-only items, 606 Plex-verified catalog-linked items, 436 Seerr-verified catalog-linked items, and 23 requestable-verified catalog-linked items.
- Search-smoke retrieval confirmed catalog-only rows enter the 500-candidate pool for search tests while normal recommendations still exclude unverified catalog-only rows.

## Non-Goals For This Branch

- No bundled Wikidata dump or derived mainstream catalog data is committed.
- No full Wikidata dump import is attempted through public WDQS. The harvester is bounded and suitable for alpha search tests; true full-catalog coverage should use Wikidata dumps, a local WDQS endpoint, or another bulk-approved source path.
- No genre/person-rich public-WDQS harvest is used for the alpha catalog; even small genre SPARQL pages timed out. Richer mood coverage should come from a dump/local endpoint or a separate batch enrichment path.
- No poster, content-rating, watch-provider, popularity/trending, or TMDb enrichment path is added.
- No admin UI surface is added beyond existing diagnostics JSON.
- No live Seerr writes are made by the readiness CLI.

## Acceptance Gates

- `npm run typecheck`: passed locally on 2026-06-30.
- `npm test`: passed locally on 2026-06-30 with 140 tests after the operational import pass.
- `npm test -- tests/recommendation.test.ts`: passed locally on 2026-06-30 with 57 tests after adding the catalog-metadata preservation regression.
- `npm run lint`: passed locally on 2026-06-30.
- `npm run build`: passed locally on 2026-06-30.
- `npm run eval:recommendations`: passed locally on 2026-06-30 with no candidate failures.
- `npm run import:wikidata-catalog -- --file <temp-jsonl> --version alpha-smoke-2026-06-30`: passed locally against an isolated temp DB on 2026-06-30.
- `npm run eval:catalog-readiness -- --min-ready 1`: passed locally against the same isolated imported test DB on 2026-06-30.
- `npm run harvest:wikidata-catalog -- --output .data/wikidata-mainstream-alpha.jsonl --movie-limit 1000 --tv-limit 500 --page-size 250 --min-sitelinks 20 --sleep-ms 1200 --timeout-ms 90000 --retries 3`: passed locally on 2026-06-30 with 1,500 records.
- `MOODARR_REQUIRE_ADMIN_TOKEN=true npm run import:wikidata-catalog -- --file .data/wikidata-mainstream-alpha.jsonl --version wikidata-mainstream-alpha-2026-06-30`: passed locally on 2026-06-30 against `.data/moodarr.sqlite`.
- `MOODARR_REQUIRE_ADMIN_TOKEN=true npm run eval:catalog-readiness -- --min-ready 750`: passed locally on 2026-06-30 with 798 ranked-search-ready catalog items.
- Catalog-only rows do not appear in normal recommendation results: covered by `tests/recommendation.test.ts`.
- Seerr-verified catalog rows can appear as `not_in_plex_requestable`: covered by `tests/recommendation.test.ts`.
- Plex/live-upgraded catalog rows can appear as normal live records while retaining catalog provenance: covered by `tests/recommendation.test.ts`.
- Catalog imports do not erase existing live summaries, genres, cast, or directors when a Wikidata row attaches to a live row: covered by `tests/recommendation.test.ts`.
- Source records preserve source, source version, source item ID, license policy, fetched timestamp, payload hash, and sanitized metadata: covered by `tests/recommendation.test.ts`.
- High-rank catalog rows are retrievable for search-test verification in large imported catalogs: covered by `tests/recommendation.test.ts`.
- Local search smoke on `.data/moodarr.sqlite`: `funny animated shows for a group` indexed 4,470 items and selected 500 candidates with 1,464 catalog-rank signals available; normal result catalog-only leak count was 0.
- Local retrieval smoke on `.data/moodarr.sqlite`: `requestable popular shows not in plex`, `something funny animated`, and `warm fantasy adventure` selected 78, 125, and 103 catalog-only candidates respectively into the 500-candidate pool for Seerr/requestability search tests.

### Slice 7: Full Dump Catalog And Deterministic Mood Enrichment

Status: implemented and validated against an isolated local DB on 2026-07-01.

- Normalized the full Wikidata dump on the Windows 11 workstation using the WSL `lbzip2` fast path.
- Source version: `wikidata-dump-2026-06-30-fast-lbzip2-min5`.
- Normalizer result: 120,710,465 entities scanned, 90,397 output records, 75,608 film records, 14,789 TV-series records, 0 JSON errors.
- Output artifact copied locally as `.data/moodarr-wikidata-catalog-fast-lbzip2-min5.jsonl.gz` without copying the 100GB source dump.
- Imported into isolated DB `.data/wikidata-full-import-test/moodarr.sqlite`.
- Import result: 90,397 records read, 90,397 imported, 0 skipped.
- Distinct catalog-linked media items after identity merging: 86,040.
- Baseline deterministic feature import produced 47,639 mood-indexed catalog items and 47,636 ranked-search-ready items.
- Added `moodarr-wikidata-rules` deterministic catalog mood enrichment.
- Enrichment result after `moodrules-v2`: 76,216 enriched catalog items, 301,216 derived mood/tone/watch rows, 9,824 skipped without enough signals, 0.8858 coverage.
- Post-enrichment catalog readiness: 86,040 rank-signal items, 86,040 feature-indexed items, 76,961 mood-indexed items, and 76,950 ranked-search-ready items.
- `MOODARR_DATA_DIR=.data/wikidata-full-import-test MOODARR_DB_PATH=.data/wikidata-full-import-test/moodarr.sqlite npm run eval:catalog-readiness -- --min-ready 50000`: passed with 76,950 ranked-search-ready items on 2026-07-01.
- `MOODARR_DATA_DIR=.data/wikidata-full-import-test MOODARR_DB_PATH=.data/wikidata-full-import-test/moodarr.sqlite npm run eval:catalog-mood -- --limit 5000 --require-stored --min-ready 50000`: passed on 2026-07-01 with 0.9336 stored/computed sample coverage and 76,950 ranked-search-ready items.
- Full-catalog retrieval performance risk was addressed by bulk-loading repository item relationships for `repository.list()`.
- Local full-catalog search smoke over 86,040 items now completes representative retrieval in about `2.2-2.8s` per query with scoring under `0.25s`.
- Five-query smoke prompts selected 500 catalog-only candidates each and produced `0` catalog-only recommendation leaks.
- Catalog verification quality smoke on 2026-07-01 confirmed `requestable popular shows not in Plex` stays TV-only, `dark but not scary` excludes horror-adjacent splatter/monster rows, and `low-commitment comfort watch` no longer ranks Lance/Ray Comfort credit artifacts above comfort-supported rows.
- Generic feature extraction now ignores person-credit boilerplate for mood cue inference. Large stale generic feature-version rebuilds are capped during repository startup so catalog-sized DBs do not block normal search; catalog readiness remains gated by actual feature/mood/rank coverage.
- No bundled non-CC0 or non-redistributable catalog-derived data is committed.

### Slice 8: Durable Catalog Updates

Status: implemented for repo-local import/update readiness on 2026-07-01.

- Update model: full Wikidata dump snapshots remain the canonical broad refresh; daily/lightweight changed-QID refreshes should run as incremental imports and must not tombstone records that are simply absent from the changed set.
- Metadata: `catalog_source_records` now tracks `active`, `last_seen_source_version`, `content_hash`, `content_version`, and `deleted_at` alongside existing payload/source fields.
- Import mode: `npm run import:wikidata-catalog -- --file <jsonl[.gz]> --version <version> --mode incremental` is the default for changed-QID refreshes; pass `--mode full-snapshot` only for complete snapshot files.
- Hash behavior: unchanged records update source-version/last-seen metadata without rerunning media/feature/rank upserts; changed or new records rerun normal catalog provenance, rank, feature, and mood indexing paths.
- Tombstones: rows missing from a full snapshot are marked inactive with `deleted_at` instead of hard-deleted. Inactive rows remain auditable but no longer contribute to catalog rank, readiness counts, verification candidates, or active catalog-only counts.
- Diagnostics: catalog diagnostics expose active/inactive counts, latest run status, update mode, changed/unchanged/inactive row counts, run age, readiness counts, and bounded verification candidates.
- Boundary: query latency and candidate-first retrieval improvements belong to the separate catalog performance lane. This slice only ensures inactive/unchanged/update metadata does not corrupt readiness or recommendation eligibility.

Implementation scope:

- `src/server/db/database.ts`: additive catalog update metadata and sync-ledger migration.
- `src/server/db/mediaRepository.ts`: hash-aware catalog upserts, full-snapshot inactive marking, active-only rank/readiness/verification diagnostics.
- `src/server/catalog/wikidataCatalogImporter.ts`: changed/unchanged import accounting for in-process imports.
- `scripts/import-wikidata-catalog.ts`: explicit incremental/full-snapshot modes and consolidated update summaries.
- `scripts/enrich-catalog-mood-features.ts` and `scripts/evaluate-catalog-mood-enrichment.ts`: active-only catalog source selection.
- `tests/recommendation.test.ts`: regression coverage for unchanged rows and full-snapshot inactive tombstones.

Update acceptance gates:

- Full snapshot import uses a staging DB or isolated staging data dir first, runs `eval:catalog-readiness` and catalog mood checks, then promotes the resulting DB or import mode intentionally.
- Incremental changed-QID import reports changed and unchanged source records and does not mark missing source IDs inactive.
- Full-snapshot import reports inactive source records and keeps inactive rows out of `catalogRankScoreMap()`, verification candidates, and ranked-search-ready counts.
- Normal recommendation results continue to exclude catalog-only rows unless Plex or exact Seerr verification attaches availability.
- Identity merging remains external-ID/title/year based and changed catalog rows must not erase live Plex/Seerr metadata.
