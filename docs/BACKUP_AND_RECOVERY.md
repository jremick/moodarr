# Backup And Recovery

Moodarr keeps durable state and credentials in one data directory. A backup is only useful when it includes the entire directory and has been restore-tested.

## What To Back Up

Back up the complete path mounted at `/data`, including:

- `moodarr.sqlite`;
- `moodarr.sqlite-wal` and `moodarr.sqlite-shm` if present;
- `config.json`;
- any future files added under `/data`.

Backups contain Plex, Seerr, OpenAI, and signed-in-user Plex credentials. Encrypt them, restrict access, and never attach them to public issues or support requests.

## Consistent Cold Backup

The safest portable alpha procedure is a cold backup:

1. Record the running Moodarr image tag or digest.
2. Stop the Moodarr container cleanly.
3. Copy or snapshot the complete host appdata directory as one unit.
4. Start the container and confirm `/api/health`, Admin status, search, and poster loading.

Example for the default Unraid path, run on the host after stopping Moodarr:

```bash
mkdir -p /mnt/user/backups/moodarr
tar -C /mnt/user/appdata -czf /mnt/user/backups/moodarr/moodarr-$(date +%Y%m%d-%H%M%S).tar.gz moodarr
```

Do not copy only `moodarr.sqlite` while the app is running; WAL data may not yet be checkpointed into that file. Storage-native atomic snapshots are also acceptable when they capture the database, WAL, shared-memory file, and config together.

## Restore Test

Test restores on an isolated path and port:

1. Stop the isolated test container.
2. Restore the complete backup into an empty appdata directory.
3. Apply ownership and permissions appropriate for the container runtime.
4. Start the same Moodarr image tag or digest used when the backup was taken.
5. Confirm health, configured integrations, library counts, a deterministic search, poster proxying, and admin diagnostics.
6. If `sqlite3` is available on the host, run `sqlite3 /path/to/moodarr.sqlite 'PRAGMA integrity_check;'` and require `ok`.

Only call a backup verified after this restore succeeds. Keep the previous known-good image and backup until the upgraded instance has passed its checks.

## Recovery And Rollback

- For an application-only regression with no incompatible data change, stop the container and run the previous immutable image tag against the existing data.
- For a schema or data regression, stop the container, preserve the failed data directory for diagnosis, restore the last verified backup into a new directory, and start the matching prior image.
- Never run two Moodarr containers against the same SQLite directory.
- After restoring an older backup, rotate credentials if the backup's access controls or custody are uncertain.

## Suggested Cadence

For active instances, take an encrypted daily or weekly backup according to acceptable feedback/request-history loss, plus a manual snapshot before upgrades, imports, or schema-affecting work. Retain at least one previous known-good application image and one independently restore-tested backup.
