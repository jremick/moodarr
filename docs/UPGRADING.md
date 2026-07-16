# Upgrading

Moodarr applies forward-only SQLite migrations during startup. Treat every version change as a data change: use a digest-qualified image or record the version tag's immutable digest, take a complete backup first, and keep the previous digest available until validation succeeds.

## Beta Upgrade Contract

The `v0.1.0-beta.1` release gate requires direct, tested upgrades from:

- `v0.1.0-alpha.21`; and
- `v0.1.0-alpha.22`, if that prerelease is published before beta.1.

The beta must not be published until both applicable paths are recorded in [Beta Release Criteria](BETA_RELEASE_CRITERIA.md). Releases older than alpha.21 have no supported direct upgrade path to beta.1. A staged upgrade through alpha.21 may work, but it is best effort and requires a fresh backup and validation at each step.

Future beta release notes will state their supported starting versions. Do not assume that skipping arbitrary prereleases is supported.

## Alpha.21 To Beta.1 Required Changes

The published alpha.21 Compose file and Unraid template did not define `MOODARR_WEB_ORIGIN`, enabled `MOODARR_ADMIN_AUTO_SESSION` by default, and did not include the beta container hardening settings. Do not upgrade alpha.21 by changing only its image reference.

The recorded alpha.21 rollback baseline for beta validation is the OCI index `ghcr.io/jremick/moodarr@sha256:b7b5c254448a5ca28cac15c7970ee401a814357ac7b8707b0eda4d97b38936d6`, with version label `v0.1.0-alpha.21` and revision label `4ac3b7672cfa4402ef0105243fc67b341c789e59`. Use that immutable reference and verify its labels; do not resolve the mutable alpha tag again when deciding what to restore.

Before the first beta.1 start:

1. Before stopping alpha.21, record one deterministic AI-off requestable search query and the expected catalog-backed item it returns. This is the post-refresh discovery baseline; do not record private titles in public evidence.
2. Take a cold backup of the alpha.21 data mount and record the exact alpha.21 image digest. The alpha.21 Compose example used the `./data` bind mount beside the Compose file, while its Docker quick start used the `moodarr-data` named volume.
3. Keep that same bind path or named volume mounted at `/data`. If adopting the beta Compose file after using the alpha Compose example, replace its `moodarr-data:/data` mapping with the existing `./data:/data` bind mount for this upgrade. Switching mounts does not copy the alpha data.
4. Set `MOODARR_WEB_ORIGIN` to the one exact origin browsers use, including scheme and port, such as `http://192.0.2.10:4401`. This is required before production startup when Plex sign-in is enabled and is also the origin used for cookie-authenticated write protection.
5. Keep a long random `MOODARR_ADMIN_TOKEN` and set `MOODARR_ADMIN_AUTO_SESSION=false`. Retain `true` only as an explicit trusted-LAN exception where every visitor is an administrator; it is incompatible with meaningful Plex-user/admin separation.
6. Apply the current container controls: `init: true`, a read-only root filesystem, a 512 MiB `/tmp` tmpfs, all capabilities dropped, `no-new-privileges`, PID/CPU/memory limits, and a stop grace period. The beta image runs as UID/GID `999:999`, so confirm the existing `/data` path remains writable by that identity before starting it.
7. For Unraid, use the current template fields and Extra Parameters while preserving the existing Appdata path. Add the exact Web Origin value, change Admin Container Session to `false` unless accepting the trusted-LAN exception above, and retain the beta template's resource and security options.
8. If alpha.21 imported catalog data, retain the original file or obtain an operator-approved authoritative snapshot from the same catalog pipeline. Record its source, version, provenance, and applicable license. The schema-29 boundary step within beta.1's final schema 31 never reconstructs trusted descriptions from Seerr/TMDB responses.

Use the candidate's recorded immutable digest as the beta image reference during validation. After the migration passes, keep the alpha.21 backup and digest until beta.1 has completed normal sync and search activity.

### Complete The Trusted Metadata Refresh

On its first beta.1 start, the schema-29 boundary step within the final schema 31 fails closed for legacy non-fixture rows whose shared descriptive fields may have been overwritten by Seerr-derived content. It preserves factual Plex, Seerr, request, external-ID, and catalog-provenance relationships, but temporarily removes those rows from discovery and marks affected trusted catalog records for rematerialization. Schema 30 adds the candidate's retrieval indexes. Schema 31 separately quarantines an upstream integration record when its multiple strong identifiers resolve to different Moodarr items: the conflicting record is skipped without rebinding stored IDs, safe sibling records continue, and requests for the quarantined item remain blocked. This integration quarantine is distinct from catalog importer ambiguity. **Admin > MoodRank > Catalog readiness** shows the exact pending catalog/Plex counts; **Admin > Overview** mirrors the notice only when those visible trusted-refresh counts require action. A latent movie/TV source-binding collision can still require importer work when the visible count is zero, so the stopped dry-run in step 4 remains mandatory.

Before treating the upgrade as complete:

1. Let the first beta.1 start and migration finish, then inspect **Admin > MoodRank > Catalog readiness**. Record the **Catalog reimport** count for the `wikidata` source; beta.1 supports that catalog source.
2. Run a full Plex library sync. This rematerializes affected Plex-backed rows from the operator-configured Plex server.
3. Stop Moodarr cleanly. Never run the one-shot importer while the server is using the same database.
4. If alpha.21 imported Wikidata catalog data, run the importer packaged in the exact candidate image against the same `/data` mount even when **Catalog reimport** is zero. The trusted preflight also detects active legacy movie/TV identity collisions that are not marked stale. The operator is responsible for validating the input file's provenance and license. This named-volume example first refuses an unknown volume or a volume still attached to a running container, then runs networkless with the catalog file on a separate read-only mount. The first invocation is read-only discovery; inspect and record its exact counts and canonical plan SHA before authorizing the second invocation:

   ```bash
   set -eu

   candidate="ghcr.io/jremick/moodarr@sha256:<validated-candidate-digest>"
   data_volume="moodarr-data"
   catalog_file="/absolute/path/moodarr-wikidata-20260622-min5-v1.jsonl.gz"
   catalog_source="wikidata"
   catalog_version="wikidata-20260622-min5-v1"
   expected_refresh_required="42" # replace with the Catalog reimport count from Admin
   expected_source_records="90397"
   expected_file_sha256="dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a"

   docker volume inspect "$data_volume" >/dev/null
   test -f "$catalog_file"
   running_container="$(docker ps --quiet --filter volume="$data_volume")"
   if [ -n "$running_container" ]; then
     echo "Stop the Moodarr container using $data_volume before recovery." >&2
     false
   fi

   run_recovery() {
     recovery_data_mount="$1"
     shift
     docker run --rm --network none --read-only \
       --cap-drop=ALL --security-opt=no-new-privileges \
       --pids-limit=128 --memory=2g --memory-swap=2g --cpus=2 \
       --user=999:999 \
       --tmpfs /tmp:rw,nosuid,nodev,noexec,size=64m,mode=1777 \
       --mount "$recovery_data_mount" \
       --mount type=bind,src="$catalog_file",dst=/recovery/catalog.jsonl.gz,readonly \
       "$candidate" dist/server/importWikidataCatalog.js \
         --file /recovery/catalog.jsonl.gz \
         --source "$catalog_source" \
         --version "$catalog_version" \
         --mode incremental \
         --rehydrate-required \
         --expected-refresh-required "$expected_refresh_required" \
         --expected-source-records "$expected_source_records" \
         --expected-file-sha256 "$expected_file_sha256" \
         "$@"
   }

   run_recovery "type=volume,src=$data_volume,dst=/data,readonly" --dry-run

   # Copy these four exact values from that dry-run JSON after reviewing it.
   expected_refresh_source_records="<refreshRequiredSourceRecordsBefore>"
   expected_type_repairs="<typeRepairSourceRecordsBefore>"
   expected_recovery_source_records="<recoverySourceRecordsPlanned>"
   expected_recovery_plan_sha256="<recoveryPlanSha256>"

   # If refreshRequiredBefore, typeRepairSourceRecordsBefore, and
   # recoverySourceRecordsPlanned are all zero, skip this write and continue
   # with the restart/readiness validation in step 6.
   run_recovery "type=volume,src=$data_volume,dst=/data" \
     --expected-refresh-source-records "$expected_refresh_source_records" \
     --expected-type-repairs "$expected_type_repairs" \
     --expected-recovery-source-records "$expected_recovery_source_records" \
     --expected-recovery-plan-sha256 "$expected_recovery_plan_sha256"
   ```

   Replace the named-volume mount with the existing absolute `/data` bind mount when that is how the instance is deployed, and independently verify that exact stopped path contains the migrated `moodarr.sqlite`. Keep the mounted destination's `.gz` suffix only for a compressed input. Do not use `--limit` or `full-snapshot` for recovery: the importer must preflight the complete approved asset and intentionally refuses either partial-recovery shape.
5. If the read-only summary reports a nonzero `recoverySourceRecordsPlanned`, require the writing summary's `expectedRefreshRequired` and item-based `refreshRequiredBefore` to equal the recorded **Catalog reimport** count. Require `expectedRefreshSourceRecords` to equal `refreshRequiredSourceRecordsBefore`, `expectedTypeRepairs` to equal `typeRepairSourceRecordsBefore`, `expectedRecoverySourceRecords` to equal both `recoverySourceRecordsPlanned` and `recoverySourceRecordsImported`, and `expectedRecoveryPlanSha256` to equal the recomputed `recoveryPlanSha256`. Require `typeRepairExternalIdsRemoved` to equal `typeRepairExternalIdsPlanned`. Require `uniqueImportableSourceRecords` to equal the approved asset's complete manifest count and `fileSha256` to equal its expected SHA-256. Finally require `refreshRequiredRemaining`, `refreshRequiredSourceRecordsRemaining`, `typeRepairSourceRecordsRemaining`, `typeRepairAffectedBindingsRemaining`, `typeRepairDerivedItemsRemaining`, the exact media-ID/type/source, typed-QID-owner, source/last-seen-version and independent payload/content-hash `recoverySourceRecordsRemaining`, and the all-recovery `recoveryDerivedItemsRemaining` all to equal zero.

   If the read-only summary reports `recoverySourceRecordsPlanned: 0`, do not run the writing command. Instead require that same read-only summary's `refreshRequiredBefore`, `refreshRequiredSourceRecordsBefore`, `refreshRequiredRemaining`, `refreshRequiredSourceRecordsRemaining`, `typeRepairSourceRecordsBefore`, `typeRepairSourceRecordsRebound`, `typeRepairSourceRecordsRemaining`, `typeRepairAffectedMediaItemsBefore`, `typeRepairAffectedSourceRecordsBefore`, `typeRepairAffectedBindingsRemaining`, `typeRepairExternalIdsPlanned`, `typeRepairExternalIdsRemoved`, `typeRepairDerivedItemsRemaining`, `recoveryDerivedItemsRemaining`, `recoverySourceRecordsPlanned`, `recoverySourceRecordsSelected`, `recoverySourceRecordsImported`, and `recoverySourceRecordsRemaining` all equal zero. Also require `uniqueImportableSourceRecords` to equal the approved asset's complete manifest count and `fileSha256` to equal its expected SHA-256, then continue directly to the restart validation in step 6.

   This beta.1 recovery mode supports only the recorded `wikidata` source. Every refresh-required source record and every type-repair companion is reprocessed from the approved file; catalog- or operational-owned scalar/list metadata and resettable derived state are authoritatively replaced, while live/Plex-owned metadata remains preserved. Final binding/hash and derived-state closure covers the complete recovery union, not only repaired bindings. The plan SHA binds the exact stopped database's sorted pre-write source bindings, source versions and hashes; each repair target's live/catalog/operational source and exact typed external-ID owners; the requested source version; external-ID cleanup; affected companion mappings; and recovery source IDs to the exact asset bytes. Unsupported external-ID sources cannot select a repair target. The writing preflight recomputes the plan inside one `BEGIN IMMEDIATE` transaction, and the write repeats the old-binding and target-state comparisons before any rebind; any count, binding, version, hash, target, cleanup, file, or final-closure mismatch rolls back the whole recovery. It preserves every non-QID identity corroborated by factual Plex, Seerr, request, or request-operation state, together with user, recommendation-history, review, and trace rows. Do not substitute Seerr/TMDB descriptive responses or hand-edited SQL.
6. Restart the candidate and refresh **Catalog readiness**. Require **Unique affected**, **Catalog reimport**, **Plex resync**, and **Requestable affected** all to equal zero and the heading to say **Trusted metadata recovery complete**. Re-run the recorded pre-upgrade deterministic AI-off requestable query, require the expected item, then repeat that search after another restart.

`operationalOnlyItems` can remain nonzero after successful recovery. These are Seerr request-state rows with no available Plex item or active trusted catalog source; they intentionally remain generic, non-discoverable placeholders until a trusted source supplies metadata.

If no operator-approved catalog file is available for the recorded source, the importer leaves required records pending, any refresh-required diagnostic remains nonzero, or deterministic search does not recover, the supported upgrade has not completed. Stop the candidate and follow the backup-based rollback procedure below.

## Before Every Upgrade

1. Read the target release notes and [Compatibility](COMPATIBILITY.md).
2. Record the running image tag, immutable digest, OCI version/revision labels, and current container settings. Also record the revision from `/api/health` when that release exposes it; alpha.21 does not, so its digest and OCI labels are the authoritative identity.
3. Stop Moodarr cleanly and take a cold backup of the complete `/data` directory. Include the SQLite database, WAL/SHM files when present, and `config.json`. Create a mode-`0600` SHA-256 sidecar for the exact archive filename.
4. If `config.json` exists, require it to parse as a JSON object before starting the new image. Beta releases fail closed on malformed persisted configuration instead of silently discarding it. Preserve a malformed file for diagnosis, then restore a known-good copy from the cold backup or deliberately recreate settings; do not replace it with an empty object and assume credentials were preserved.
5. Require the checksum sidecar to name only the exact safe archive filename, verify it before decryption or extraction, and, ideally, restore the archive into an isolated directory before proceeding.
6. Keep the previous image digest and its matching backup.
7. Confirm `/data` and the container's 512 MiB `/tmp` have enough free space for migration work.

Follow [Backup And Recovery](BACKUP_AND_RECOVERY.md) for the complete procedure. Never run two Moodarr containers against the same data directory.

## Docker

1. Pull the target versioned release tag:

   ```bash
   docker pull ghcr.io/jremick/moodarr:<target-version>
   ```

2. Record its digest with `docker image inspect` or `docker image ls --digests`.
3. Stop and remove the existing container without deleting its `/data` volume.
4. Recreate it with the same data mount, origin, credentials, and hardened runtime options, changing only the image reference and intentionally documented settings.
5. Wait for the health check before using Admin or running a sync.

Avoid mutable tags in automation. A version tag is the readable release identity; the resolved digest is the exact rollback and audit identity.

## Docker Compose

Update the service's `image` value to the target versioned release tag or its recorded immutable digest, then run:

```bash
docker compose pull moodarr
docker compose up -d --no-deps moodarr
docker compose ps moodarr
docker compose logs --tail=100 moodarr
```

Preserve the existing `/data` mount and environment values. Do not use `down -v`, which deletes named volumes.

## Unraid

1. Back up the complete Moodarr appdata directory while the container is stopped.
2. Change the template's Repository field to the target versioned release tag or its recorded immutable digest.
3. Preserve the `/data` appdata mapping, port, `MOODARR_WEB_ORIGIN`, admin settings, integration settings, and Extra Parameters.
4. Apply the update and inspect the first-start logs.
5. Record the image digest shown by Docker after the pull.

Do not replace the appdata mapping with an empty directory unless performing a deliberate restore or clean-install test.

## Post-Upgrade Validation

Require all of the following before deleting the old container or backup:

- `/api/health` returns success and reports the expected release/revision;
- the container remains healthy without restart or out-of-memory events;
- Admin authentication works and saved integration status is present;
- library and request-state counts are plausible;
- all four trusted-refresh-required diagnostic counts are zero; operational-only request-state placeholders are understood and intentionally excluded from discovery;
- one deterministic AI-off search returns expected catalog results;
- poster proxying works without exposing a Plex token;
- Plex and Seerr/Jellyseerr connection tests succeed;
- request preview produces the expected target without creating a request;
- any pre-beta request operation still recorded as pending or uncertain fails closed without another Seerr write; verify that title in Seerr and retain the backup/support evidence rather than deleting or retrying the operation blindly;
- a scheduled or manual sync completes without `SQLITE_BUSY` or migration errors; and
- SQLite `PRAGMA integrity_check` returns `ok` when run against a stopped, isolated copy or restore.

Keep the pre-upgrade backup until the new version has completed normal sync and search activity.

## Rollback

Database migrations are forward-only. Unless the target release notes explicitly say an application-only rollback is safe, do not start an older Moodarr image against a data directory already opened by a newer release.

For a safe rollback:

1. Stop the failed container.
2. Preserve its data directory separately for diagnosis; do not overwrite it.
3. Restore the complete pre-upgrade backup into an empty directory or volume.
4. Start the recorded previous image digest against only that restored directory.
5. Repeat health, authentication, integration, search, poster, and integrity checks.

If credentials or a backup may have been exposed during recovery, rotate the affected credentials after restoring service. Report application defects through [Support](../SUPPORT.md), but do not attach the database, environment file, or full support bundle.
