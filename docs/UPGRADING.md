# Upgrading

Moodarr applies forward-only SQLite migrations during startup. Treat every version change as a data change: use an immutable image, take a complete backup first, and keep the previous image available until validation succeeds.

## Beta Upgrade Contract

The `v0.1.0-beta.1` release gate requires direct, tested upgrades from:

- `v0.1.0-alpha.21`; and
- `v0.1.0-alpha.22`, if that prerelease is published before beta.1.

The beta must not be published until both applicable paths are recorded in [Beta Release Criteria](BETA_RELEASE_CRITERIA.md). Releases older than alpha.21 have no supported direct upgrade path to beta.1. A staged upgrade through alpha.21 may work, but it is best effort and requires a fresh backup and validation at each step.

Future beta release notes will state their supported starting versions. Do not assume that skipping arbitrary prereleases is supported.

## Before Every Upgrade

1. Read the target release notes and [Compatibility](COMPATIBILITY.md).
2. Record the running image tag, immutable digest, Moodarr revision from `/api/health`, and current container settings.
3. Stop Moodarr cleanly and take a cold backup of the complete `/data` directory. Include the SQLite database, WAL/SHM files when present, and `config.json`.
4. Verify the backup checksum and, ideally, restore it into an isolated directory before proceeding.
5. Keep the previous image digest and its matching backup.
6. Confirm `/data` and the container's 512 MiB `/tmp` have enough free space for migration work.

Follow [Backup And Recovery](BACKUP_AND_RECOVERY.md) for the complete procedure. Never run two Moodarr containers against the same data directory.

## Docker

1. Pull the target immutable version tag:

   ```bash
   docker pull ghcr.io/jremick/moodarr:<target-version>
   ```

2. Record its digest with `docker image inspect` or `docker image ls --digests`.
3. Stop and remove the existing container without deleting its `/data` volume.
4. Recreate it with the same data mount, origin, credentials, and hardened runtime options, changing only the image reference and intentionally documented settings.
5. Wait for the health check before using Admin or running a sync.

Avoid mutable tags in automation. A version tag is the readable release identity; the resolved digest is the exact rollback and audit identity.

## Docker Compose

Update the service's `image` value to the target immutable release, then run:

```bash
docker compose pull moodarr
docker compose up -d --no-deps moodarr
docker compose ps moodarr
docker compose logs --tail=100 moodarr
```

Preserve the existing `/data` mount and environment values. Do not use `down -v`, which deletes named volumes.

## Unraid

1. Back up the complete Moodarr appdata directory while the container is stopped.
2. Change the template's Repository field to the target immutable version tag.
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
- one deterministic AI-off search returns expected catalog results;
- poster proxying works without exposing a Plex token;
- Plex and Seerr/Jellyseerr connection tests succeed;
- request preview produces the expected target without creating a request;
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
