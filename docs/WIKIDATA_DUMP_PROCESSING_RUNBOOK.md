# Wikidata Dump Processing Runbook

Status: contributor processing runbook.
Last updated: 2026-07-14.

## Purpose

Use the full Wikidata entity dump to build a Moodarr-normalized catalog without copying or expanding the dump onto the local development laptop.

This is optional contributor/maintainer catalog-generation tooling, not a required beta installation or first-run step. External self-hosters may use an operator-approved catalog file through the documented importer, but the release does not require them to process the upstream Wikidata dump themselves.

The examples use a Windows 11 workstation with enough working storage and CPU headroom to process the dump without expanding it on a development laptop.

## Reference Processing Host

- SSH alias used below: `wikidata-worker`
- Work volume: `F:`
- Work directory: `F:\moodarr-wikidata`
- Dump: `F:\moodarr-wikidata\latest-all.json.bz2`
- Verified dump size: `101,881,782,812` bytes
- Verified SHA-256: `3566f9974747ba3a2bdcd602cdfc48785497a2bd2347afb78b85472d98e97a6c`

Configure the alias for the operator-controlled processing host and substitute local paths where needed. Do not commit personal hostnames, account names, or private network details to this runbook.

Do not decompress `latest-all.json.bz2` to disk.

## Repo Tooling

- Normalizer: `scripts/normalize-wikidata-dump.py`
- Fast normalizer: `scripts/normalize-wikidata-dump-fast.py`
- Validator: `scripts/validate-wikidata-catalog.py`
- Foreground Windows runner: `scripts/run-wikidata-normalizer.ps1`
- Detached Windows launcher: `scripts/start-wikidata-normalizer-detached.ps1`
- Fast foreground Windows runner: `scripts/run-wikidata-normalizer-fast.ps1`
- Fast detached Windows launcher: `scripts/start-wikidata-normalizer-fast-detached.ps1`
- Fast WSL foreground runner: `scripts/run-wikidata-normalizer-fast-wsl.sh`
- Fast WSL detached launcher: `scripts/start-wikidata-normalizer-fast-wsl-detached.ps1`
- Importer: `npm run import:wikidata-catalog`

The importer supports `.jsonl.gz`, batch inserts, `--limit`, `--dry-run`, and explicit update modes:

- `--mode incremental`: default. Use for daily/lightweight RecentChanges-derived changed-QID files. Missing source IDs are ignored because the file is not a complete source snapshot. Incremental mode rejects `--expected-file-sha256` because it does not provide whole-snapshot replacement semantics.
- `--mode full-snapshot`: use only for a complete dump-derived snapshot and pass both `--expected-source-records <count>` from `counts.outputRecords` and `--expected-file-sha256 <sha256>` from `asset.sha256` in its manifest after the catalog validator passes. Moodarr must observe that exact number of unique importable source IDs and the exact lowercase compressed-file hash.

Full-snapshot imports should run against a staging DB or isolated staging data dir first, then pass readiness gates before promotion. Full-snapshot dry runs require the same expected hash and count as writes.
For a non-dry full snapshot, Moodarr opens one regular non-symlink file handle, verifies its hash and count before opening the database, keeps every catalog/derived/inactive/sync write in one transaction, then re-hashes and revalidates the same file identity before commit. Any parse, count, write, or changed-file failure rolls the complete snapshot back. Keep the input file stable for every pass; do not replace or edit it while the importer is running.

## Normalizer Shape

The normalizer performs four streaming steps:

1. Build subclass closure for Wikidata film and television-series classes.
2. Extract matching media candidates.
3. Resolve labels for referenced genre, cast, director, country, language, and franchise QIDs.
4. Write Moodarr-compatible JSONL/JSONL.gz plus a manifest.

Output records are accepted by `scripts/import-wikidata-catalog.ts` and preserve the existing catalog trust boundary:

- Wikidata is provenance and discovery metadata.
- Plex remains local availability truth.
- Seerr remains requestability truth.

## Pilot Run

Command run on Windows:

```powershell
python F:/moodarr-wikidata/normalize-wikidata-dump.py `
  --dump F:/moodarr-wikidata/latest-all.json.bz2 `
  --work-dir F:/moodarr-wikidata/work/pilot-1k `
  --output F:/moodarr-wikidata/out/moodarr-wikidata-pilot-1k.jsonl.gz `
  --manifest F:/moodarr-wikidata/out/moodarr-wikidata-pilot-1k.manifest.json `
  --source-version wikidata-dump-2026-06-30-pilot `
  --max-entities 250000 `
  --limit-media 1000 `
  --min-sitelinks 20 `
  --progress-interval 50000
```

Pilot result:

- Output records: `908`
- Films: `824`
- TV series: `84`
- IMDb IDs: `908`
- TMDb IDs: `908`
- TVDB IDs: `85`
- Descriptions: `908`
- Genre labels: `175`
- Cast labels: `610`
- Director labels: `87`
- Duplicate QIDs: `0`

The pilot's label coverage is intentionally lower than a full pass because the pilot capped label resolution at the first `250,000` entities.

Pilot import checks:

```bash
MOODARR_REQUIRE_ADMIN_TOKEN=true npm run import:wikidata-catalog -- \
  --file .data/moodarr-wikidata-pilot-1k.jsonl.gz \
  --version wikidata-dump-2026-06-30-pilot \
  --mode full-snapshot \
  --expected-source-records 908 \
  --expected-file-sha256 "<asset.sha256 from the validated pilot manifest>" \
  --dry-run \
  --batch-size 200
```

Dry-run result: `908` records, `908` importable, `0` skipped.

Isolated temp DB import result: `908` records imported, `0` skipped.

Readiness against the isolated temp DB:

- Distinct catalog media items: `906`
- Rank-signal items: `906`
- Feature-indexed items: `906`
- Mood-indexed / ranked-search-ready items: `94`

The `906` distinct media count from `908` source records is expected: two pairs of Wikidata records shared external IDs and were merged by Moodarr's existing identity logic.

## Full Pass Command

Recommended first full pass keeps a practical mainstream floor without reintroducing a tiny top-N cap:

```powershell
python F:/moodarr-wikidata/normalize-wikidata-dump.py `
  --dump F:/moodarr-wikidata/latest-all.json.bz2 `
  --work-dir F:/moodarr-wikidata/work/full-min5 `
  --output F:/moodarr-wikidata/out/moodarr-wikidata-catalog-full-min5.jsonl.gz `
  --manifest F:/moodarr-wikidata/out/moodarr-wikidata-catalog-full-min5.manifest.json `
  --source-version wikidata-dump-2026-06-30-full-min5 `
  --min-sitelinks 5 `
  --progress-interval 1000000
```

Rationale for `--min-sitelinks 5`:

- avoids the long tail of barely described or duplicate catalog debris;
- keeps mainstream/requestable coverage much broader than the public-WDQS alpha slice;
- still allows records without IMDb/TMDb/TVDB IDs when they have enough Wikidata/Wikipedia footprint.

Use `--require-external-id` only for a stricter ID-backed subset.

## Fast Pass Command

The optimized v2 runner preserves the same candidate semantics but avoids the completed class-index scan, parallelizes candidate JSON parsing, and performs label resolution with a raw-line entity-id prefilter.

Primary optimizations:

- Reuses `F:\moodarr-wikidata\work\full-min5\wikidata-class-index.json`.
- Uses independent `fast-min5` work, log, output, and manifest paths.
- Uses `orjson` when installed in `C:\Python313`.
- Splits candidate parsing across worker processes.
- Writes intermediate raw candidate shards uncompressed to avoid wasting CPU on temporary gzip.
- Writes final gzip with compression level `1` for throughput.
- During label resolution, parses only entities whose top-level QID is in the reference set.

Fast detached command:

```bash
ssh wikidata-worker powershell -NoProfile -ExecutionPolicy Bypass -File F:\\moodarr-wikidata\\start-wikidata-normalizer-fast-detached.ps1 \
  -RunName fast-min5 \
  -SourceVersion wikidata-dump-2026-06-30-fast-min5 \
  -MinSitelinks 5 \
  -ProgressInterval 1000000 \
  -Workers 8 \
  -BatchSize 250 \
  -QueueBatches 8 \
  -OutputGzipLevel 1 \
  -Decompressor auto
```

Use a new run name, or pass `-Force`, when restarting v2. Do not reuse `full-min5` paths for v2.

## Fast WSL lbzip2 Pass

WSL was prepared on `2026-07-01` using root via `wsl.exe -u root`:

```bash
apt-get install -y lbzip2 pbzip2 python3-pip
python3 -m pip install --break-system-packages orjson
```

The WSL path is faster because `lbzip2` can parallelize bzip2 decompression. The Windows-based fast runner is still useful as a fallback, but the WSL runner is the preferred optimized path while the dump remains `.bz2`.

Fast WSL detached command:

```bash
ssh wikidata-worker powershell -NoProfile -ExecutionPolicy Bypass -File F:\\moodarr-wikidata\\start-wikidata-normalizer-fast-wsl-detached.ps1 \
  -RunName fast-lbzip2-min5 \
  -SourceVersion wikidata-dump-2026-06-30-fast-lbzip2-min5 \
  -MinSitelinks 5 \
  -ProgressInterval 1000000 \
  -Workers 12 \
  -BatchSize 500 \
  -QueueBatches 16 \
  -OutputGzipLevel 1 \
  -Decompressor lbzip2 \
  -DecompressorWorkers 16 \
  -Force
```

Implementation notes:

- The launcher uses `Win32_Process.Create` to start a persistent `wsl.exe` process from SSH.
- Do not use shell backgrounding inside `wsl.exe`; those jobs can die when the launching WSL session exits.
- Capped WSL smoke runs validated the output shape before starting the full run.

Completed `fast-lbzip2-min5` result:

- Started: `2026-06-30T20:29:01Z`.
- Finished: `2026-06-30T22:29:11Z`.
- Entities scanned: `120,710,465`.
- Output records: `90,397`.
- Films: `75,608`.
- TV series: `14,789`.
- IMDb-backed records: `89,104`.
- TMDb-backed records: `87,310`.
- TVDB-backed records: `8,646`.
- Records with descriptions: `90,372`.
- Records with genre labels: `85,588`.
- Records with cast labels: `74,001`.
- Records with director labels: `78,050`.
- Local output copied to `.data/moodarr-wikidata-catalog-fast-lbzip2-min5.jsonl.gz`.
- Isolated local import result: `90,397` records read, `90,397` imported, `0` skipped.
- Isolated local DB after import and deterministic catalog mood enrichment: `86,040` distinct catalog items and `76,950` ranked-search-ready catalog items.

## Update Workflow

Moodarr's Wikidata catalog update model is hybrid:

1. Periodic full snapshot:
   - Normalize a full Wikidata dump into Moodarr JSONL/JSONL.gz.
   - Run the catalog validator, then record `counts.outputRecords` and `asset.sha256` from the generated manifest as the expected unique importable source-record count and compressed-file identity.
   - Import into an isolated staging DB first with `--mode full-snapshot --expected-source-records <validated count> --expected-file-sha256 <validated asset.sha256>`.
   - Run readiness gates:
     - `npm run eval:catalog-readiness -- --min-ready <expected floor>`
     - `npm run enrich:catalog-mood -- --catalog-version <version>` when deterministic mood coverage needs refreshing.
     - `npm run eval:catalog-mood -- --catalog-version <version> --require-stored --min-ready <expected floor>`
   - Promote only after active count, inactive count, changed/unchanged rows, and ranked-search-ready count look sane.
2. Daily/lightweight changed-QID refresh:
   - Build a JSONL containing only changed Wikidata media QIDs.
   - Import with `--mode incremental`.
   - Confirm `changedSourceRecords` and `unchangedSourceRecords` in the import summary and diagnostics.
   - Do not expect `inactiveSourceRecords`; incremental files are not complete snapshots.

The importer compares `content_hash` first:

- unchanged rows update `source_version`, `last_seen_source_version`, run metadata, and rank-signal source version without rerunning media/feature/mood writes;
- changed rows increment `content_version` and rerun catalog media, provenance, rank, feature, and mood indexing paths;
- rows missing from a full snapshot become inactive tombstones and stop contributing to catalog rank/readiness/verification candidates.

Current diagnostic checks:

- `repository.recommendationDiagnostics().features.catalog.activeCatalogItems`
- `inactiveCatalogItems`
- `rankedSearchReadyItems`
- `latestRun.status`
- `latestRun.updateMode`
- `latestRun.changedSourceRecords`
- `latestRun.unchangedSourceRecords`
- `latestRun.inactiveSourceRecords`

Keep full-catalog interactive retrieval latency work separate from this update workflow. This runbook owns freshness/correctness/readiness; candidate-first query performance belongs in the catalog performance thread.

## Original Full Pass

Started from this branch on `2026-06-30 13:09 AEST`:

```bash
ssh wikidata-worker powershell -NoProfile -ExecutionPolicy Bypass -File F:\\moodarr-wikidata\\start-wikidata-normalizer-detached.ps1
```

Detached launcher result:

- Run name: `full-min5`
- Runner PID: `268116`
- Observed Python child PID: `269052`
- Logs:
  - `F:\moodarr-wikidata\logs\full-min5.err.log`
  - `F:\moodarr-wikidata\logs\full-min5.out.log`
- Output:
  - `F:\moodarr-wikidata\out\moodarr-wikidata-catalog-full-min5.jsonl.gz`
  - `F:\moodarr-wikidata\out\moodarr-wikidata-catalog-full-min5.manifest.json`

Stopped on `2026-07-01` after the WSL `lbzip2` fast path overtook it.

Final observed checkpoint before stop:

- Pass: `2/4`
- Entities scanned: `50,000,000`
- Candidates: `43,505`

The partial original output was not used as the catalog source of truth.

## Current Fast Passes

The Windows Python `fast-min5` comparison run was stopped after confirming the v2 logic because decompression remained the bottleneck.

- Run name: `fast-lbzip2-min5`
- WSL launcher PID: `274840` (completed)
- Workers: `12`
- Decompressor: `lbzip2`
- Decompressor workers: `16`
- Logs:
  - `F:\moodarr-wikidata\logs\fast-lbzip2-min5.err.log`
  - `F:\moodarr-wikidata\logs\fast-lbzip2-min5.out.log`
- Output:
  - `F:\moodarr-wikidata\out\moodarr-wikidata-catalog-fast-lbzip2-min5.jsonl.gz`
  - `F:\moodarr-wikidata\out\moodarr-wikidata-catalog-fast-lbzip2-min5.manifest.json`

Final result:

- Started: `2026-06-30T20:29:01Z`
- Finished: `2026-06-30T22:29:11Z`
- Entities scanned: `120,710,465`
- Output records: `90,397`
- Films: `75,608`
- TV series: `14,789`
- IMDb-backed records: `89,104`
- TMDb-backed records: `87,310`
- TVDB-backed records: `8,646`
- Records with genre labels: `85,588`
- Records with cast labels: `74,001`
- Records with director labels: `78,050`
- Referenced labels resolved: `142,231` of `144,425`
- Output gzip: `F:\moodarr-wikidata\out\moodarr-wikidata-catalog-fast-lbzip2-min5.jsonl.gz`
- Manifest: `F:\moodarr-wikidata\out\moodarr-wikidata-catalog-fast-lbzip2-min5.manifest.json`

Validation passed with `--min-records 90000` and expected-title checks for `12 Angry Men`, `Game of Thrones`, `The Godfather`, `The Simpsons`, `Red Dwarf`, and `Titanic`.

Early candidate counts matched the original run, which confirms the optimized path preserved candidate semantics.

The original `full-min5` process was stopped after the WSL fast path completed candidate extraction and entered label resolution.

## Monitoring

If running interactively:

```bash
ssh wikidata-worker
```

If running detached from this Mac, redirect stdout/stderr to:

```text
F:\moodarr-wikidata\logs\full-min5.out.log
F:\moodarr-wikidata\logs\full-min5.err.log
```

Check progress:

```bash
ssh wikidata-worker 'powershell -NoProfile -Command "Get-Content F:\moodarr-wikidata\logs\full-min5.err.log -Tail 40"'
```

Check fast progress:

```bash
ssh wikidata-worker 'powershell -NoProfile -Command "Get-Content F:\moodarr-wikidata\logs\fast-min5.err.log -Tail 40"'
```

Check WSL lbzip2 fast progress:

```bash
ssh wikidata-worker 'powershell -NoProfile -Command "Get-Content F:\moodarr-wikidata\logs\fast-lbzip2-min5.err.log -Tail 40"'
```

Check process:

```bash
ssh wikidata-worker 'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"name = ''python.exe''\" | Select-Object ProcessId,CommandLine"'
```

Compare active progress:

```bash
ssh wikidata-worker 'powershell -NoProfile -Command "Write-Host full-min5; Get-Content F:\moodarr-wikidata\logs\full-min5.err.log -Tail 8; Write-Host fast-min5; Get-Content F:\moodarr-wikidata\logs\fast-min5.err.log -Tail 8"'
```

Compare original and WSL fast progress:

```bash
ssh wikidata-worker 'powershell -NoProfile -Command "Write-Host full-min5; Get-Content F:\moodarr-wikidata\logs\full-min5.err.log -Tail 8; Write-Host fast-lbzip2-min5; Get-Content F:\moodarr-wikidata\logs\fast-lbzip2-min5.err.log -Tail 8"'
```

## Validation

Validate output on Windows:

```bash
ssh wikidata-worker 'python F:/moodarr-wikidata/validate-wikidata-catalog.py --file F:/moodarr-wikidata/out/moodarr-wikidata-catalog-full-min5.jsonl.gz --min-records 10000 --examples 10'
```

Then copy only the compressed normalized output or import from a machine with enough DB space.

Do not import the full catalog into the local laptop DB unless free disk space has been checked first.
