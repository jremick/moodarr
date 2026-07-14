# Backup And Recovery

Moodarr keeps durable state and credentials in one data directory. A backup is only useful when it includes the entire directory and has been restore-tested.

## What To Back Up

Back up the complete path mounted at `/data`, including:

- `moodarr.sqlite`;
- `moodarr.sqlite-wal` and `moodarr.sqlite-shm` if present;
- `config.json`;
- any future files added under `/data`.

Backups contain Plex, Seerr, and signed-in-user Plex credentials. They can also contain an inert OpenAI key when the volume was previously used by a source/EXP build. Encrypt them, restrict access, and never attach them to public issues or support requests. File mode `600` is useful defense in depth, but it is not encryption and does not protect a copied disk, exported share, or misplaced archive.

## Encryption And Key Custody

Use storage-native encryption or encrypt each archive before it leaves the private appdata boundary. For unattended backups, prefer public-key encryption: the host may keep the public recipient, while the private recovery identity stays off-host in a password manager or another protected recovery location. Do not store the only decryption key beside the backup, and keep a separately verified recovery copy.

`age` is one portable option when it is installed from a trusted package source. The recipient is public information; the corresponding private identity is not:

```bash
set -euo pipefail
umask 077
install -d -m 700 /mnt/user/backups/moodarr
encrypted_dir="/mnt/user/backups/moodarr"
encrypted_name="moodarr-$(date -u +%Y%m%d-%H%M%S).tar.zst.age"
encrypted_archive="$encrypted_dir/$encrypted_name"
tar -C /mnt/user/appdata -cf - moodarr \
  | zstd -T0 \
  | age -r "$MOODARR_BACKUP_AGE_RECIPIENT" \
      -o "$encrypted_archive"
chmod 600 "$encrypted_archive"
(cd "$encrypted_dir" && sha256sum -- "$encrypted_name") > "$encrypted_archive.sha256"
chmod 600 "$encrypted_archive.sha256"
```

Do not place an `AGE-SECRET-KEY` value in shell history, the repository, the Moodarr data directory, or the backup directory. If `age` is unavailable, use an equivalently authenticated encryption mechanism rather than keeping a long-lived plaintext archive. Keep the mode-`0600` SHA-256 sidecar with the archive and verify it before decryption or extraction. The checksum detects accidental corruption; the authenticated encryption and protected key custody provide authenticity and confidentiality.

## Consistent Cold Backup

The safest portable beta procedure is a cold backup:

1. Resolve and record the running Moodarr image as an exact immutable `ghcr.io/jremick/moodarr@sha256:<64-hex-digest>` reference. A human-readable tag may be recorded alongside it, but a tag alone is not a rollback identity.
2. Stop the Moodarr container cleanly.
3. Copy or snapshot the complete host appdata directory as one unit.
4. Start the container and confirm `/api/health`, Admin status, search, and poster loading.

The encrypted example above is suitable for the default Unraid paths when run after stopping Moodarr. Record the archive name, exact image digest, optional tag, schema version, encryption recipient fingerprint, SHA-256 sidecar, and restore-test result without recording secret values. If the running container was started from a tag, inspect the container's image ID and that image's repository digests before stopping it; do not assume the tag still resolves to the bytes that are running.

Do not copy only `moodarr.sqlite` while the app is running; WAL data may not yet be checkpointed into that file. Storage-native atomic snapshots are also acceptable when they capture the database, WAL, shared-memory file, and config together.

### Docker Compose named volume

The example Compose file uses the named volume `moodarr-data` by default. To create a cold plaintext staging archive, use the digest-pinned Debian archive helper already pinned by Moodarr's build, stop the service, and mount the volume read-only. The helper has no network access and streams the archive to a host-created mode-`0600` file so rootful Docker does not leave an unusable root-owned backup:

```bash
set -euo pipefail
umask 077
archive_helper="node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5"
backup_image="${MOODARR_BACKUP_IMAGE:?Set MOODARR_BACKUP_IMAGE to the exact running image digest}"
if [[ ! "$backup_image" =~ ^ghcr\.io/jremick/moodarr@sha256:[0-9a-f]{64}$ ]]; then
  echo "MOODARR_BACKUP_IMAGE must be a ghcr.io/jremick/moodarr@sha256:<64-hex-digest> reference." >&2
  exit 1
fi
command -v sha256sum >/dev/null
backup_container="$(docker compose ps -q moodarr)"
if [[ -z "$backup_container" ]]; then
  echo "Moodarr must be running so its exact image can be verified before backup." >&2
  exit 1
fi
running_image_ref="$(docker inspect --format '{{.Config.Image}}' "$backup_container")"
running_image_id="$(docker inspect --format '{{.Image}}' "$backup_container")"
backup_image_matches=false
if [[ "$running_image_ref" = "$backup_image" ]]; then
  backup_image_matches=true
else
  while IFS= read -r repository_digest; do
    if [[ "$repository_digest" = "$backup_image" ]]; then
      backup_image_matches=true
    fi
  done < <(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$running_image_id")
fi
if [[ "$backup_image_matches" != true ]]; then
  echo "MOODARR_BACKUP_IMAGE does not identify the image bytes used by the running container." >&2
  exit 1
fi
install -d -m 700 backups
backup_name="moodarr-data-$(date -u +%Y%m%d-%H%M%S).tgz"
if [[ ! "$backup_name" =~ ^moodarr-data-[0-9]{8}-[0-9]{6}\.tgz$ ]]; then
  echo "Unsafe backup filename." >&2
  exit 1
fi
backup_archive="$PWD/backups/$backup_name"
backup_checksum="$backup_archive.sha256"
if [[ -e "$backup_archive" || -e "$backup_checksum" ]]; then
  echo "Refusing to overwrite an existing archive or checksum sidecar." >&2
  exit 1
fi
docker pull "$archive_helper"
docker compose stop moodarr
restart_required=true
backup_complete=false
trap 'if test "$restart_required" = true; then docker compose start moodarr; fi; if test "$backup_complete" = false; then rm -f "$backup_archive" "$backup_checksum"; fi' EXIT
docker run --rm --network none --user 0:0 --read-only \
  --cap-drop ALL --cap-add DAC_READ_SEARCH --security-opt no-new-privileges:true \
  --entrypoint /bin/tar \
  -v moodarr-data:/source:ro \
  "$archive_helper" \
  -C /source -czf - . > "$backup_archive"
chmod 600 "$backup_archive"
(cd "$(dirname "$backup_archive")" && sha256sum -- "$backup_name") > "$backup_checksum"
chmod 600 "$backup_checksum"
backup_complete=true
docker compose start moodarr
restart_required=false
trap - EXIT
printf 'Backup image: %s\nRunning image reference (optional tag): %s\nArchive: %s\nChecksum: %s\n' \
  "$backup_image" "$running_image_ref" "$backup_archive" "$backup_checksum"
```

Set `MOODARR_BACKUP_IMAGE` from the exact immutable digest resolved for the running container before stopping it. Record an optional tag only as a convenience label. Encrypt the archive before moving it off-host and delete the plaintext staging archive and its plaintext checksum after the encrypted copy, encrypted-file checksum, and restore test are verified. If `MOODARR_DATA_VOLUME` overrides the default, substitute that exact volume name. Users upgrading from the alpha `./data:/data` bind mount must back up and preserve that host directory; changing to the named volume does not migrate data automatically.

To restore-test into a new volume without touching the live volume, first choose the exact archive, recorded image digest, and a unique restore run ID:

```bash
export MOODARR_RESTORE_ARCHIVE="$PWD/backups/moodarr-data-YYYYMMDD-HHMMSS.tgz"
export MOODARR_RESTORE_IMAGE="ghcr.io/jremick/moodarr@sha256:<recorded-64-hex-digest>"
export MOODARR_RESTORE_RUN_ID="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(8).toString("hex"))')"
```

Then run the isolated restore. It verifies the sidecar and archive format before creating the fresh volume, labels the volume with the random run ID, and removes only matching owned resources if a later step fails:

```bash
set -euo pipefail
archive_helper="node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5"
restore_run_id="${MOODARR_RESTORE_RUN_ID:?Set a unique restore run ID}"
restore_archive="${MOODARR_RESTORE_ARCHIVE:?Set the exact archive path}"
restore_image="${MOODARR_RESTORE_IMAGE:?Set MOODARR_RESTORE_IMAGE to the exact image digest used with this backup}"
: "${MOODARR_ADMIN_TOKEN:?Set MOODARR_ADMIN_TOKEN to the existing admin token without printing it}"
if [[ ! "$restore_run_id" =~ ^[0-9a-f]{16}$ ]]; then
  echo "MOODARR_RESTORE_RUN_ID must be 16 lowercase hexadecimal characters." >&2
  exit 1
fi
if [[ ! "$restore_image" =~ ^ghcr\.io/jremick/moodarr@sha256:[0-9a-f]{64}$ ]]; then
  echo "MOODARR_RESTORE_IMAGE must be a ghcr.io/jremick/moodarr@sha256:<64-hex-digest> reference." >&2
  exit 1
fi
restore_project="moodarr-restore-$restore_run_id"
restore_volume="moodarr-data-restore-$restore_run_id"
restore_owner_label="io.moodarr.restore.run"
archive_name="$(basename -- "$restore_archive")"
archive_dir="$(cd -- "$(dirname -- "$restore_archive")" && pwd -P)"
checksum_name="$archive_name.sha256"
restore_archive="$archive_dir/$archive_name"
restore_checksum="$archive_dir/$checksum_name"
if [[ ! "$archive_name" =~ ^moodarr-data-[0-9]{8}-[0-9]{6}\.tgz$ ]]; then
  echo "Restore archive must use the generated moodarr-data-YYYYMMDD-HHMMSS.tgz filename." >&2
  exit 1
fi
if [[ ! -f "$restore_archive" || -L "$restore_archive" || ! -f "$restore_checksum" || -L "$restore_checksum" ]]; then
  echo "Restore archive or checksum sidecar is missing, not regular, or a symbolic link." >&2
  exit 1
fi
checksum_line="$(<"$restore_checksum")"
checksum_pattern="^[0-9a-f]{64}  ${archive_name//./\\.}$"
if [[ ! "$checksum_line" =~ $checksum_pattern ]]; then
  echo "Checksum sidecar must contain one lowercase SHA-256 entry for the exact safe archive filename." >&2
  exit 1
fi
(cd "$archive_dir" && sha256sum --check --strict -- "$checksum_name")
if docker volume inspect "$restore_volume" >/dev/null 2>&1; then
  echo "Refusing to reuse volume $restore_volume." >&2
  exit 1
fi
if [[ -n "$(docker ps --all --quiet --filter "label=com.docker.compose.project=$restore_project")" ]]; then
  echo "Refusing to reuse Compose project $restore_project." >&2
  exit 1
fi
if docker network inspect "${restore_project}_default" >/dev/null 2>&1; then
  echo "Refusing to reuse network ${restore_project}_default." >&2
  exit 1
fi
archive_listing="$(mktemp)"
restore_volume_created=false
restore_project_armed=true
restore_ready=false
cleanup_failed_restore() {
  status=$?
  trap - EXIT
  rm -f "$archive_listing"
  if [[ "$restore_ready" != true ]]; then
    project_safe=true
    while IFS= read -r container_id; do
      [[ -z "$container_id" ]] && continue
      container_image="$(docker inspect --format '{{.Config.Image}}' "$container_id" 2>/dev/null || true)"
      container_volume="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$container_id" 2>/dev/null || true)"
      if [[ "$container_image" != "$restore_image" || "$container_volume" != "$restore_volume" ]]; then
        project_safe=false
      fi
    done < <(docker ps --all --quiet --filter "label=com.docker.compose.project=$restore_project")
    if [[ "$restore_project_armed" = true && "$project_safe" = true ]]; then
      MOODARR_IMAGE="$restore_image" MOODARR_ADMIN_TOKEN="$MOODARR_ADMIN_TOKEN" \
      MOODARR_DATA_VOLUME="$restore_volume" MOODARR_PORT=127.0.0.1:4492 \
      MOODARR_WEB_ORIGIN=http://127.0.0.1:4492 \
        docker compose --project-name "$restore_project" down >/dev/null 2>&1 || true
    fi
    if [[ "$restore_volume_created" = true ]] \
      && [[ "$(docker volume inspect --format '{{index .Labels "io.moodarr.restore.run"}}' "$restore_volume" 2>/dev/null || true)" = "$restore_run_id" ]] \
      && [[ -z "$(docker ps --all --quiet --filter "volume=$restore_volume")" ]]; then
      docker volume rm "$restore_volume" >/dev/null 2>&1 || true
    fi
  fi
  exit "$status"
}
trap cleanup_failed_restore EXIT
docker pull "$archive_helper"
docker run --rm --network none --user 0:0 --read-only \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --entrypoint /bin/tar \
  --mount "type=bind,src=$restore_archive,dst=/tmp/moodarr-data.tgz,readonly" \
  "$archive_helper" -tzf /tmp/moodarr-data.tgz > "$archive_listing"
while IFS= read -r member; do
  if [[ "$member" != "." && "$member" != "./" && ! "$member" =~ ^\./[A-Za-z0-9._/-]+$ ]] \
    || [[ "$member" == *"/../"* || "$member" == ../* || "$member" == /* ]]; then
    echo "Archive contains an unsafe member name." >&2
    exit 1
  fi
done < "$archive_listing"
docker pull "$restore_image"
docker volume create --label "$restore_owner_label=$restore_run_id" "$restore_volume"
restore_volume_created=true
docker run --rm --network none --user 0:0 --read-only \
  --cap-drop ALL --cap-add DAC_OVERRIDE --security-opt no-new-privileges:true \
  --entrypoint /bin/tar \
  --mount "type=volume,src=$restore_volume,dst=/data" \
  --mount "type=bind,src=$restore_archive,dst=/tmp/moodarr-data.tgz,readonly" \
  "$archive_helper" \
  --no-same-owner -C /data -xzf /tmp/moodarr-data.tgz
docker run --rm --network none --user 0:0 --read-only \
  --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges:true \
  --entrypoint /bin/chown \
  --mount "type=volume,src=$restore_volume,dst=/data" \
  "$archive_helper" \
  -R 999:999 /data
MOODARR_IMAGE="$restore_image" \
MOODARR_ADMIN_TOKEN="$MOODARR_ADMIN_TOKEN" \
MOODARR_DATA_VOLUME="$restore_volume" \
MOODARR_PORT=127.0.0.1:4492 \
MOODARR_WEB_ORIGIN=http://127.0.0.1:4492 \
  docker compose --project-name "$restore_project" up -d --no-build moodarr
restore_container_id="$(docker ps --all -q \
  --filter "label=com.docker.compose.project=$restore_project" \
  --filter label=com.docker.compose.service=moodarr)"
if [[ -z "$restore_container_id" ]]; then
  echo "The isolated restore container did not start." >&2
  exit 1
fi
running_image_ref="$(docker inspect --format '{{.Config.Image}}' "$restore_container_id")"
running_image_id="$(docker inspect --format '{{.Image}}' "$restore_container_id")"
if [[ "$running_image_ref" != "$restore_image" ]]; then
  echo "Restore image mismatch: expected $restore_image, running $running_image_ref" >&2
  exit 1
fi
printf 'Restore image reference: %s\nRestore image ID: %s\n' "$running_image_ref" "$running_image_id"
printf 'Restore project: %s\nRestore volume: %s\n' "$restore_project" "$restore_volume"
restore_ready=true
rm -f "$archive_listing"
trap - EXIT
```

Set `MOODARR_RESTORE_IMAGE` to the digest recorded with the backup, for example `ghcr.io/jremick/moodarr@sha256:<64-hex-digest>`. A version tag is not sufficient. The command refuses another repository or a mutable reference, passes the digest into Compose, and verifies the running container's configured image reference before reporting its local image ID.

This uses a distinct Compose project, host port, browser origin, and labeled data volume, so it does not replace the live service. Choose another unused host port if `4492` is occupied. Never point two containers at the same volume. After validation, use the same `MOODARR_RESTORE_RUN_ID`, verify the project container and volume ownership, and remove only that restore project:

```bash
set -euo pipefail
restore_run_id="${MOODARR_RESTORE_RUN_ID:?Set the restore run ID used above}"
[[ "$restore_run_id" =~ ^[0-9a-f]{16}$ ]]
restore_project="moodarr-restore-$restore_run_id"
restore_volume="moodarr-data-restore-$restore_run_id"
restore_image="${MOODARR_RESTORE_IMAGE:?Set MOODARR_RESTORE_IMAGE to the exact recorded digest}"
restore_container_id="$(docker ps --all -q \
  --filter "label=com.docker.compose.project=$restore_project" \
  --filter label=com.docker.compose.service=moodarr)"
[[ -n "$restore_container_id" ]]
[[ "$(docker inspect --format '{{.Config.Image}}' "$restore_container_id")" = "$restore_image" ]]
[[ "$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}' "$restore_container_id")" = "$restore_volume" ]]
[[ "$(docker volume inspect --format '{{index .Labels "io.moodarr.restore.run"}}' "$restore_volume")" = "$restore_run_id" ]]
MOODARR_IMAGE="$restore_image" \
MOODARR_ADMIN_TOKEN="${MOODARR_ADMIN_TOKEN:?Set MOODARR_ADMIN_TOKEN to the existing admin token}" \
MOODARR_DATA_VOLUME="$restore_volume" \
MOODARR_PORT=127.0.0.1:4492 \
MOODARR_WEB_ORIGIN=http://127.0.0.1:4492 \
  docker compose --project-name "$restore_project" down
```

Do not pass `--volumes` until you have deliberately decided whether to retain or delete the restored test volume.

## Restore Test

Test restores on an isolated path and port:

1. Stop the isolated test container.
2. Restore the complete backup into an empty appdata directory.
3. Apply ownership and permissions appropriate for the container runtime.
4. Decrypt the archive using the separately held recovery identity and extract it only into the isolated restore path.
5. Start the exact Moodarr image digest recorded when the backup was taken, pass it explicitly to the container or Compose file, and verify the running container reports that same digest-qualified reference.
6. Confirm health, configured integrations, library counts, a deterministic search, poster proxying, and admin diagnostics.
7. If `sqlite3` is available on the host, run `sqlite3 /path/to/moodarr.sqlite 'PRAGMA integrity_check;'` and require `ok`.

Only call a backup verified after this restore succeeds. Keep the previous known-good image and backup until the upgraded instance has passed its checks.

## Recovery And Rollback

- Treat forward migrations as incompatible with older images by default. Stop the upgraded container, preserve its data directory for diagnosis, restore the verified pre-upgrade backup into a new volume or directory, and start the matching prior image digest against that restored copy.
- Reusing upgraded data with an older image is supported only when the release notes explicitly state that the exact version pair allows an in-place application rollback.
- Never run two Moodarr containers against the same SQLite directory.
- After restoring an older backup, rotate credentials if the backup's access controls or custody are uncertain.

## Suggested Cadence

For active instances, take an encrypted daily or weekly backup according to acceptable feedback/request-history loss, plus a manual snapshot before upgrades, imports, or schema-affecting work. Retain at least one previous known-good application image and one independently restore-tested backup.

Define a finite retention policy and test its deletion path. A reasonable starting point for a personal active instance is seven daily archives, four weekly archives, and two known-good pre-upgrade archives. Adjust this to the desired recovery window and storage budget. Expiry must remove plaintext staging files, failed partial archives, old environment-file copies, and superseded database snapshots as well as the final encrypted archive.

At least quarterly, restore a recent archive on an isolated path, prove the recovery identity is available, and record the result. A backup that has never been decrypted and restored is not a verified backup.
