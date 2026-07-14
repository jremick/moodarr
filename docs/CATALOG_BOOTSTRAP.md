# Optional Catalog Bootstrap

Moodarr works with Plex alone. A Plex sync provides discovery for media already in the configured library. Seerr/Jellyseerr sync contributes operational request state for requests that already exist, but it is never used for descriptive discovery in the `v0.1.0-beta.1` product boundary.

Import the separate beta catalog asset only when you want Finder to discover titles absent from Plex. The asset is not built into the Moodarr image, source tree, or data volume. GitHub Releases is authoritative for whether the beta and its catalog asset have been published.

## Beta.1 Asset Contract

| Property | Required value |
| --- | --- |
| Release asset | `moodarr-wikidata-20260622-min5-v1.jsonl.gz` |
| Catalog version | `wikidata-20260622-min5-v1` |
| Compressed SHA-256 | `dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a` |
| Importable records | 90,397 |
| Request-attempt eligible records | 82,865: 70,841 movies and 12,024 TV series |
| Source | [Wikidata 2026-06-22 entity dump](https://dumps.wikimedia.org/wikidatawiki/entities/20260622/wikidata-20260622-all.json.bz2) |
| Data license | [CC0 1.0 for Wikidata structured data](https://www.wikidata.org/wiki/Wikidata:Licensing) |

The tracked manifest at [`catalog/moodarr-wikidata-20260622-min5-v1.manifest.json`](../catalog/moodarr-wikidata-20260622-min5-v1.manifest.json) records the source dump hashes, deterministic normalizer identity, compressed and uncompressed sizes, schema version, and coverage counts. The normalized asset contains structured text and identifiers, not poster artwork.

The asset also contains 36 groups that share a strong importer identifier across 72 source records. Fifty-nine of those records—10 movies and 49 TV series—otherwise meet request-attempt requirements. Their ambiguous catalog materializations remain imported and indexed for provenance and diagnostics, but cannot independently surface in Finder or authorize request preview or creation. If an independently identified available Plex item later links to one of those records, that Plex item remains visible as already available; the catalog ambiguity still blocks every request action and never grants request-attempt eligibility.

## What Request Attempt Means

An eligible imported title has enough approved local metadata and a media-type-specific TMDB interoperability identifier to prepare a Seerr request attempt. Moodarr has **not** checked that title's availability in Seerr.

- Its availability remains `unavailable`, not verified requestable.
- An ordinary generic Finder search excludes it.
- A requestable-only search or explicit `not_in_plex_requestable` filter also excludes it; those surfaces are reserved for titles Moodarr has verified as requestable from local operational state.
- A narrowly explicit request-intent search, such as “I want to request a warm fantasy movie,” may include it after verified requestable results.
- The card says **Seerr request attempt** and **Availability not checked**. The actions say **Try Request** and **Confirm Request Attempt**.
- Preview is local and does not create an upstream request. Seerr may still reject the explicitly confirmed attempt.

This distinction is part of the beta safety contract. Do not describe catalog coverage as Seerr availability coverage.

## Download And Verify

After `v0.1.0-beta.1` is listed on GitHub Releases, download the catalog asset attached to that same prerelease. Keep it outside `/data`; the importer only needs a read-only mount for the duration of the import.

```bash
set -euo pipefail
asset="/absolute/path/moodarr-wikidata-20260622-min5-v1.jsonl.gz"
expected_sha256="dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a"

test -f "$asset"
test "$(sha256sum -- "$asset" | awk '{print $1}')" = "$expected_sha256"
gzip -t -- "$asset"
```

On macOS, use `shasum -a 256 "$asset"` in place of `sha256sum`. A source checkout with Node.js dependencies installed can additionally validate every record and all manifest counts:

```bash
npm run --silent validate:beta-catalog-asset -- --file "$asset"
```

Do not import an asset with a different hash, record count, version, or filename presented as beta.1. A newer Wikidata dump is a different dataset and is outside this release contract until it receives its own reviewed manifest and version.

## Stopped, Networkless Full-Snapshot Import

Back up and restore-test the complete data volume first. The Moodarr server and every other process using the database must remain stopped for the entire import. Substitute the exact digest from the published beta.1 release notes, the real container name, and the real `/data` mount source. `moodarr-data` is the default Compose named volume; the default Unraid bind path is `/mnt/user/appdata/moodarr`.

Plan a 30–60 minute maintenance window and require at least 4 GiB free on the `/data` filesystem in addition to separately stored backup capacity. The final full-snapshot source validation completed in about 41 minutes with about 299 MiB peak importer RSS, a 1.12 GB final SQLite file, and about 1.13 GB peak pre-commit WAL; CPU, storage, filesystem, and existing data can change those figures. The 4 GiB floor leaves room for the atomic WAL-to-database checkpoint and normal SQLite overhead rather than treating the measured minimum as a safe operating limit.

```bash
set -euo pipefail
asset="/absolute/path/moodarr-wikidata-20260622-min5-v1.jsonl.gz"
moodarr_image="ghcr.io/jremick/moodarr@sha256:<digest-from-beta.1-release>"
moodarr_container="moodarr"
moodarr_data="moodarr-data"

test "$(sha256sum -- "$asset" | awk '{print $1}')" = \
  "dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a"
docker stop "$moodarr_container"

docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777 \
  --user 999:999 --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=128 --memory=2g --memory-swap=2g --cpus=2 \
  -e NODE_ENV=production \
  -e MOODARR_REQUIRE_ADMIN_TOKEN=true \
  -e MOODARR_FIXTURE_MODE=false \
  -e MOODARR_DATA_DIR=/data \
  -e MOODARR_CONFIG_PATH=/data/config.json \
  -e MOODARR_DB_PATH=/data/moodarr.sqlite \
  -v "$moodarr_data:/data" \
  -v "$asset:/catalog/moodarr-wikidata-20260622-min5-v1.jsonl.gz:ro" \
  "$moodarr_image" \
  dist/server/importWikidataCatalog.js \
  --file /catalog/moodarr-wikidata-20260622-min5-v1.jsonl.gz \
  --version wikidata-20260622-min5-v1 \
  --source wikidata \
  --mode full-snapshot \
  --expected-source-records 90397 \
  --expected-file-sha256 dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a \
  --batch-size 1000

docker start "$moodarr_container"
```

`--network none` proves that import does not call Wikidata, TMDB, Seerr, or any other service. Full-snapshot mode binds one regular non-symlink file handle, verifies the exact compressed SHA-256 before preflight, requires exactly 90,397 unique importable records, and re-hashes the same bytes before committing. All catalog rows, derived indexes, inactive marking, and sync evidence are one transaction: a parse, count, write, or changed-file failure rolls everything back. A successful summary must report both `expectedFileSha256` and `fileSha256` as the pinned hash above. Do not add `--limit`, change either expected value, replace or edit the file during import, run a second Moodarr container against the same `/data`, or make the appdata directory world-writable to work around an error.

If the import exits nonzero, keep Moodarr stopped, retain only privacy-safe diagnostic output, and restore the verified cold backup before retrying. Do not treat a partial or repaired database as a successful bootstrap.

## Post-Import Checks

After restarting the exact beta image:

1. Confirm `GET /api/health` is healthy and Admin diagnostics reports no catalog refresh-required state.
2. Confirm Plex-only discovery and existing verified requestable results still behave as before.
3. Run a generic mood search and a verified-requestable-only search; neither may contain catalog request-attempt rows.
4. Run an explicit request-intent search. An eligible catalog-only row may appear as `unavailable` with **Seerr request attempt** and **Availability not checked**.
5. Before attaching any Plex source, search for a controlled catalog-only record from a group sharing a strong importer identifier using generic, verified-requestable-only, and explicit request-intent queries. It must be absent from every Finder result, and direct preview or create attempts must fail without an upstream write. If an independently identified available Plex item is deliberately attached for a separate check, that Plex item may remain visible, but preview and creation must still fail.
6. Open **Try Request** on an unambiguous eligible record and confirm the preview does not write upstream. For TV, select a season before preview. Only use **Confirm Request Attempt** against a controlled Seerr target you are prepared to clean up.
7. Stop and restart Moodarr once, then repeat the health and isolation checks.

The catalog asset may be removed from the host after a successful import and backup; normalized catalog state lives in `/data/moodarr.sqlite`. Keep the version and SHA-256 in operating notes so future upgrades and support reports can identify the source exactly.

For alpha recovery of rows intentionally quarantined by the beta migration, follow the narrower `--rehydrate-required` procedure in [Upgrading](UPGRADING.md). Do not substitute that incremental recovery mode for this fresh full-snapshot bootstrap.
