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

1. Take a cold backup of the alpha.21 data mount and record the exact alpha.21 image digest. The alpha.21 Compose example used the `./data` bind mount beside the Compose file, while its Docker quick start used the `moodarr-data` named volume.
2. Keep that same bind path or named volume mounted at `/data`. If adopting the beta Compose file after using the alpha Compose example, replace its `moodarr-data:/data` mapping with the existing `./data:/data` bind mount for this upgrade. Switching mounts does not copy the alpha data.
3. Set `MOODARR_WEB_ORIGIN` to the one exact origin browsers use, including scheme and port, such as `http://192.0.2.10:4401`. This is required before production startup when Plex sign-in is enabled and is also the origin used for cookie-authenticated write protection.
4. Keep a long random `MOODARR_ADMIN_TOKEN` and set `MOODARR_ADMIN_AUTO_SESSION=false`. Retain `true` only as an explicit trusted-LAN exception where every visitor is an administrator; it is incompatible with meaningful Plex-user/admin separation.
5. Apply the current container controls: `init: true`, a read-only root filesystem, a 512 MiB `/tmp` tmpfs, all capabilities dropped, `no-new-privileges`, PID/CPU/memory limits, and a stop grace period. The beta image runs as UID/GID `999:999`, so confirm the existing `/data` path remains writable by that identity before starting it.
6. For Unraid, use the current template fields and Extra Parameters while preserving the existing Appdata path. Add the exact Web Origin value, change Admin Container Session to `false` unless accepting the trusted-LAN exception above, and retain the beta template's resource and security options.

Use the candidate's recorded immutable digest as the beta image reference during validation. After the migration passes, keep the alpha.21 backup and digest until beta.1 has completed normal sync and search activity.

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
