# Backup And Recovery

Moodarr keeps durable state and credentials in one data directory. A backup is only useful when it includes the entire directory and has been restore-tested.

## What To Back Up

Back up the complete path mounted at `/data`, including:

- `moodarr.sqlite`;
- `moodarr.sqlite-wal` and `moodarr.sqlite-shm` if present;
- `config.json`;
- any future files added under `/data`.

Backups contain Plex, Seerr, OpenAI, and signed-in-user Plex credentials. Encrypt them, restrict access, and never attach them to public issues or support requests. File mode `600` is useful defense in depth, but it is not encryption and does not protect a copied disk, exported share, or misplaced archive.

## Encryption And Key Custody

Use storage-native encryption or encrypt each archive before it leaves the private appdata boundary. For unattended backups, prefer public-key encryption: the host may keep the public recipient, while the private recovery identity stays off-host in a password manager or another protected recovery location. Do not store the only decryption key beside the backup, and keep a separately verified recovery copy.

`age` is one portable option when it is installed from a trusted package source. The recipient is public information; the corresponding private identity is not:

```bash
install -d -m 700 /mnt/user/backups/moodarr
tar -C /mnt/user/appdata -cf - moodarr \
  | zstd -T0 \
  | age -r "$MOODARR_BACKUP_AGE_RECIPIENT" \
      -o "/mnt/user/backups/moodarr/moodarr-$(date +%Y%m%d-%H%M%S).tar.zst.age"
chmod 600 /mnt/user/backups/moodarr/*.tar.zst.age
```

Do not place an `AGE-SECRET-KEY` value in shell history, the repository, the Moodarr data directory, or the backup directory. If `age` is unavailable, use an equivalently authenticated encryption mechanism rather than keeping a long-lived plaintext archive.

## Consistent Cold Backup

The safest portable beta procedure is a cold backup:

1. Record the running Moodarr image tag or digest.
2. Stop the Moodarr container cleanly.
3. Copy or snapshot the complete host appdata directory as one unit.
4. Start the container and confirm `/api/health`, Admin status, search, and poster loading.

The encrypted example above is suitable for the default Unraid paths when run after stopping Moodarr. Record the archive name, image digest, schema version, encryption recipient fingerprint, and restore-test result without recording secret values.

Do not copy only `moodarr.sqlite` while the app is running; WAL data may not yet be checkpointed into that file. Storage-native atomic snapshots are also acceptable when they capture the database, WAL, shared-memory file, and config together.

### Docker Compose named volume

The example Compose file uses the named volume `moodarr-data` by default. To create a cold plaintext staging archive with the same immutable Moodarr image, stop the service and mount the volume read-only:

```bash
install -d -m 700 backups
docker compose stop moodarr
docker run --rm --user 0 --read-only \
  --entrypoint tar \
  -v moodarr-data:/source:ro \
  -v "$PWD/backups:/backup" \
  ghcr.io/jremick/moodarr:v0.1.0-beta.1 \
  -C /source -czf /backup/moodarr-data.tgz .
docker compose start moodarr
chmod 600 backups/moodarr-data.tgz
```

Encrypt the archive before moving it off-host and delete the plaintext staging file after the encrypted copy and restore test are verified. If `MOODARR_DATA_VOLUME` overrides the default, substitute that exact volume name. Users upgrading from the alpha `./data:/data` bind mount must back up and preserve that host directory; changing to the named volume does not migrate data automatically.

To restore-test into a new volume without touching the live volume:

```bash
docker volume create moodarr-data-restore
docker run --rm --user 0 --read-only \
  --entrypoint tar \
  -v moodarr-data-restore:/target \
  -v "$PWD/backups:/backup:ro" \
  ghcr.io/jremick/moodarr:v0.1.0-beta.1 \
  -C /target -xzf /backup/moodarr-data.tgz
MOODARR_DATA_VOLUME=moodarr-data-restore \
MOODARR_PORT=4492 \
MOODARR_WEB_ORIGIN=http://127.0.0.1:4492 \
  docker compose --project-name moodarr-restore up -d --no-build moodarr
```

This uses a distinct Compose project, host port, browser origin, and data volume, so it does not replace the live service. Choose another unused host port if `4492` is occupied. Never point two containers at the same volume. After validation, remove only the restore project with the same overrides:

```bash
MOODARR_DATA_VOLUME=moodarr-data-restore \
MOODARR_PORT=4492 \
MOODARR_WEB_ORIGIN=http://127.0.0.1:4492 \
  docker compose --project-name moodarr-restore down
```

Do not pass `--volumes` until you have deliberately decided whether to retain or delete the restored test volume.

## Restore Test

Test restores on an isolated path and port:

1. Stop the isolated test container.
2. Restore the complete backup into an empty appdata directory.
3. Apply ownership and permissions appropriate for the container runtime.
4. Decrypt the archive using the separately held recovery identity and extract it only into the isolated restore path.
5. Start the same Moodarr image digest used when the backup was taken.
6. Confirm health, configured integrations, library counts, a deterministic search, poster proxying, and admin diagnostics.
7. If `sqlite3` is available on the host, run `sqlite3 /path/to/moodarr.sqlite 'PRAGMA integrity_check;'` and require `ok`.

Only call a backup verified after this restore succeeds. Keep the previous known-good image and backup until the upgraded instance has passed its checks.

## Recovery And Rollback

- Treat forward migrations as incompatible with older images by default. Stop the upgraded container, preserve its data directory for diagnosis, restore the verified pre-upgrade backup into a new volume or directory, and start the matching prior immutable image against that restored copy.
- Reusing upgraded data with an older image is supported only when the release notes explicitly state that the exact version pair allows an in-place application rollback.
- Never run two Moodarr containers against the same SQLite directory.
- After restoring an older backup, rotate credentials if the backup's access controls or custody are uncertain.

## Suggested Cadence

For active instances, take an encrypted daily or weekly backup according to acceptable feedback/request-history loss, plus a manual snapshot before upgrades, imports, or schema-affecting work. Retain at least one previous known-good application image and one independently restore-tested backup.

Define a finite retention policy and test its deletion path. A reasonable starting point for a personal active instance is seven daily archives, four weekly archives, and two known-good pre-upgrade archives. Adjust this to the desired recovery window and storage budget. Expiry must remove plaintext staging files, failed partial archives, old environment-file copies, and superseded database snapshots as well as the final encrypted archive.

At least quarterly, restore a recent archive on an isolated path, prove the recovery identity is available, and record the result. A backup that has never been decrypted and restored is not a verified backup.
