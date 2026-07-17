# Unraid Deployment

Moodarr is designed to run as a single container where it can reach user-provided Plex and Seerr/Jellyseerr URLs. For most home media setups, keep it on the same LAN, VPN, or trusted container network as those services; exposing media-server APIs to a public host adds avoidable network and secret-management risk.

## Container Defaults

- Web/API port: `4401`
- Persistent data path: `/data`
- SQLite database: `/data/moodarr.sqlite`
- Persistent app config: `/data/config.json`
- Runtime user: non-root UID/GID `999:999` (preserved for alpha data-volume compatibility)
- Interactive container shell: unavailable by design in the distroless runtime; use Unraid logs, Moodarr diagnostics, and the redacted support bundle instead of the container console
- Admin auth: enabled by default in the Docker image
- Admin Web UI session: explicit token exchange by default; `MOODARR_ADMIN_AUTO_SESSION=false`
- Recommendation processing: local-only in the official beta.1 image; provider settings are not exposed by the template
- Missing-title catalog: optional separate beta.1 release asset; Plex-only discovery works without it

## Private Environment File For Shell Examples

The Docker and Compose shell examples below read secrets from a mode-`0600` environment file. This setup is only for shell-based installs. If you use the Unraid Apps template, skip this section and enter the token in its masked **Admin Token** field and the browser origin in **Web Origin**.

Run the block once on the Docker host. The here-document is parsed before the inner Bash process starts, so the silent prompt waits for fresh input instead of consuming another pasted command. Neither the token entry nor its value appears in shell history or the later Docker command arguments.

```bash
bash <<'MOODARR_ENV_SETUP'
set -euo pipefail
umask 077
moodarr_env_dir="${XDG_CONFIG_HOME:-$HOME/.config}/moodarr"
moodarr_env="$moodarr_env_dir/container.env"
mkdir -p "$moodarr_env_dir"
chmod 700 "$moodarr_env_dir"
while :; do
  printf 'Moodarr admin token (32+ base64url-style characters): ' >/dev/tty
  IFS= read -r -s moodarr_admin_token </dev/tty
  printf '\n' >/dev/tty
  [[ "$moodarr_admin_token" =~ ^[A-Za-z0-9_-]{32,}$ ]] && break
  printf 'Use at least 32 random letters, numbers, underscores, or hyphens.\n' >/dev/tty
done
printf 'Moodarr browser origin (for example http://192.0.2.10:4401): ' >/dev/tty
IFS= read -r moodarr_web_origin </dev/tty
case "$moodarr_web_origin" in
  http://*|https://*) ;;
  *) printf 'Origin must start with http:// or https://.\n' >/dev/tty; exit 1 ;;
esac
{
  printf '%s=%s\n' MOODARR_ADMIN_TOKEN "$moodarr_admin_token"
  printf '%s\n' MOODARR_ADMIN_AUTO_SESSION=false
  printf '%s=%s\n' MOODARR_WEB_ORIGIN "$moodarr_web_origin"
} > "$moodarr_env"
unset moodarr_admin_token moodarr_web_origin
chmod 600 "$moodarr_env"
printf 'Private environment written to %s\n' "$moodarr_env"
MOODARR_ENV_SETUP
```

Keep that file private, outside the repository, and at mode `0600`; Docker administrators can still inspect container environment values. On Unraid, a shell file under `/root` may not survive reboot, so use a deliberately chosen private persistent location for long-lived Compose installs or use the Apps template. Rotate the admin token if the file or Docker access is exposed.

## Build Locally

```bash
moodarr_env="${XDG_CONFIG_HOME:-$HOME/.config}/moodarr/container.env"
docker build -t moodarr:local .
docker run --rm -p 4401:4401 \
  -v moodarr-data:/data \
  --env-file "$moodarr_env" \
  moodarr:local
```

Open `http://<unraid-host>:4401`, enter the admin token in the Admin Access control, then configure Plex and Seerr. The browser exchanges the token with `POST /api/admin/session` for an HTTP-only, SameSite=Strict cookie; direct API clients can still send the token with `X-Moodarr-Admin-Token` or `Authorization: Bearer`. The Admin Lock action calls `DELETE /api/admin/session`, clears that cookie, and sets a local lock marker so automatic LAN admin sessions do not immediately reopen the screen; entering the token again clears the marker.

If a reverse proxy provides HTTPS, set `MOODARR_WEB_ORIGIN` to the exact public `https://` origin. Moodarr uses that setting for callback validation and to add the `Secure` attribute to session cookies.
Plex sign-in will not start in production without an explicit origin. Cookie-authenticated writes also require that exact origin, so changing the hostname or reverse-proxy origin requires updating this setting before testing sign-in or admin actions.

Do not enable `MOODARR_ADMIN_AUTO_SESSION` merely to skip the sign-in step. When true, any visitor able to load the bundled UI can receive admin access, so Plex-user/admin separation exists only when it is false or an external authentication layer supplies the boundary.

## Pull Beta Image

Use the beta.1 tag below only after it appears on the GitHub Releases page, which is authoritative for release availability. Record the resolved GHCR digest after pulling it.

```bash
moodarr_env="${XDG_CONFIG_HOME:-$HOME/.config}/moodarr/container.env"
docker pull ghcr.io/jremick/moodarr:v0.1.0-beta.1
docker run --rm --init --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777 \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=128 --memory=2g --memory-swap=2g --cpus=2 \
  -p 4401:4401 \
  -v moodarr-data:/data \
  --env-file "$moodarr_env" \
  ghcr.io/jremick/moodarr:v0.1.0-beta.1
```

## Compose

```bash
cp docker-compose.example.yml docker-compose.yml
```

Create the private environment file above with the required admin token and exact browser origin, then run:

```bash
moodarr_env="${XDG_CONFIG_HOME:-$HOME/.config}/moodarr/container.env"
docker compose --env-file "$moodarr_env" up -d --no-build
```

Use the reverse proxy's public `https://` origin instead when TLS terminates in front of Moodarr. Do not use `127.0.0.1` unless every browser actually opens Moodarr on that origin.

Do not commit the private environment file or copy its values into Compose. Keep any local Compose overrides token-free.

The example Compose file deliberately supplies operational defaults such as sync interval and result limit as environment variables. Environment values override Admin-saved values after recreation. To manage one of those settings only through Admin, remove that key from your local Compose copy instead of setting it to an empty value.

## Unraid Template

### Choose one browser origin before Apply

Unraid's **WebUI** action expands `[IP]` to the raw host IP and mapped Web UI port. For direct Unraid access, enter that exact IP origin in **Web Origin** and always use the same URL. If you configure a DNS hostname or an HTTPS reverse proxy instead, enter that canonical origin and open it directly rather than using the IP shortcut. Hostname and IP aliases are different origins even when they reach the same server.

Mixing those addresses can let safe pages load and the Admin token exchange appear to succeed, but later cookie-authenticated `POST`, `PUT`, `PATCH`, and `DELETE` requests—including Finder search—are rejected. Reopen Moodarr at the configured origin and unlock Admin again because browser sessions are host-scoped. Do not enable automatic admin sessions or weaken origin protection to work around a mismatch.

### Prepare appdata before first Apply

Unraid Docker Manager creates a missing bind-mount source as host UID/GID `99:100`. Moodarr intentionally runs as non-root UID/GID `999:999`, with all capabilities dropped, so it cannot and should not repair host ownership during startup. Before selecting **Apply** for a fresh install, open the Unraid Terminal and create the exact path you will enter in the template's **Appdata** field:

```bash
(
  set -eu
  appdata=/mnt/user/appdata/moodarr
  if test -e "$appdata" || test -L "$appdata"; then
    printf '%s\n' "Refusing fresh-install setup: $appdata already exists; inspect it as existing data." >&2
    exit 1
  fi
  install -d -m 0700 -o 999 -g 999 "$appdata"
  actual=$(stat -c '%u:%g %a' "$appdata")
  test "$actual" = "999:999 700"
  printf 'Prepared %s as %s\n' "$appdata" "$actual"
)
```

Change only the `appdata=` value if you choose a different host path, then use that exact value in the template. This block deliberately refuses existing paths and symlinks; do not replace it with `chmod 777`, and do not recursively change ownership on existing appdata. For an upgrade, restore, or previous failed install, stop and follow the ownership and backup guidance below instead of treating the path as new.

The template at `unraid/moodarr.xml` targets the versioned beta image tag `ghcr.io/jremick/moodarr:v0.1.0-beta.1`. After pulling, record its immutable digest; for stricter pinning, Unraid's Repository field can use the digest-qualified reference. For local-only testing, build and tag a local image as `moodarr:local` and adjust the template repository field.

Template users should enter the long random token directly into the masked **Admin Token** field and the exact browser origin into **Web Origin**. The shell environment file above is not imported by the Apps UI. Keep Unraid's flash/app template configuration and Docker access private even though the form masks secret fields on screen.

Use bridge networking unless your Plex or Seerr URLs require another mode. The Plex and Seerr base URLs must be reachable from inside the Moodarr container.

The template requires `MOODARR_WEB_ORIGIN` and preserves the same runtime hardening as the Compose example: a read-only root filesystem, writable appdata, a 512 MiB `/tmp` tmpfs, all Linux capabilities dropped, no-new-privileges, init handling, and bounded PID/CPU/memory use. It requests a memory-plus-swap ceiling equal to the 2 GiB memory limit, so a Docker host with swap-limit support permits no additional swap. Some Unraid kernels report `WARNING: No swap limit support` and ignore that ceiling. Such a host meets the beta resource envelope only while it has zero usable host swap; if swap is available without an enforced container limit, disable it or treat the configuration as unsupported for beta. The `/tmp` ceiling is sized for SQLite migrations against production-size databases; reducing it can surface a misleading `database or disk is full` error. Keep the Appdata mapping writable; Moodarr stores SQLite and saved settings there. If the instance legitimately needs more than two CPUs, 2 GiB RAM, or 128 processes, adjust only the corresponding Extra Parameters limit and re-test health, sync, search, and posters.

Keep the appdata path private. Saved admin settings include Plex and Seerr credentials in `/data/config.json`; a volume previously used by a source/EXP build can also retain an inert OpenAI key until it is cleared in Admin. Moodarr writes that file with restrictive permissions when the host filesystem supports them.
The appdata directory must remain writable by UID/GID `999:999`. If startup reports a permission error after moving or restoring appdata, stop the container, take or verify a cold backup, and inspect the exact path before correcting ownership through the Unraid host. Do not make it world-writable or recursively change an unverified path.

Values present in the Unraid template remain environment overrides on every restart. This includes the advanced sync interval, Seerr-sync, and result-limit fields. Change or remove the corresponding template variable if you want an Admin-saved value to take precedence; secret and origin fields should normally remain explicit template settings.

The SQLite database can also contain signed-in-user Plex tokens, identity, request audits, feedback, and profiles. Back up the complete appdata directory only while the container is stopped or through an atomic storage snapshot, encrypt the backup, and test a restore. See [Backup And Recovery](BACKUP_AND_RECOVERY.md) and [Data And Privacy](DATA_AND_PRIVACY.md).

## Optional Missing-Title Catalog

The container and Unraid template do not bundle a descriptive catalog. Plex-only discovery remains supported without one. To discover missing titles, download `moodarr-wikidata-20260622-min5-v1.jsonl.gz` from the same published beta.1 GitHub prerelease and require SHA-256 `dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a` before use. The asset contains 90,397 importable Wikidata rows; 82,865 have the unambiguous local metadata and interoperability identifier required for a disclosed request attempt, split into 70,841 movies and 12,024 TV series. Thirty-six groups share a strong importer identifier across 72 source records, 59 of which would otherwise be eligible—10 movies and 49 TV series. Their ambiguous catalog materializations remain imported and indexed for provenance and diagnostics but cannot independently surface in Finder or authorize a request action. An independently identified available Plex item remains visible if linked later, while ambiguity still blocks preview and creation.

Take and verify a cold appdata backup, require at least 4 GiB free on the appdata filesystem beyond separately stored backup capacity, and reserve a 30–60 minute maintenance window. Stop the Moodarr container, then run the exact beta image's packaged importer in a one-shot container with `--network none`. Mount `/mnt/user/appdata/moodarr` at `/data`, mount the asset read-only, and use `--mode full-snapshot --expected-source-records 90397 --expected-file-sha256 dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a`. The importer re-hashes the same file before commit and rolls the complete snapshot back on any file, count, parse, or write failure. Do not run the helper beside the app container, weaken UID/GID `999:999` ownership, or add network access to repair a failure. The complete command, measured resource context, and rollback procedure are in [Catalog Bootstrap](CATALOG_BOOTSTRAP.md).

After import, generic searches and verified-requestable-only filters must still exclude catalog request-attempt rows. Only explicit request-attempt intent may reveal an eligible catalog-only row, and the UI must keep it `unavailable` with **Availability not checked** until Seerr accepts a separately confirmed request.

## Beta.1 Provider Boundary

The official beta.1 image bakes in provider policy `none`, excludes the OpenAI network endpoint from the server bundle, and rejects environment, retained config, and Admin attempts to enable it. The Unraid template intentionally exposes no provider or key fields. Provisional provider testing requires a separate, explicitly configurable source/EXP build and is outside this deployment and support contract.

## Poster Checks

Browser clients should only request posters from Moodarr paths like `/api/items/<id>/poster`. Plex tokens must never appear in image URLs or generated HTML. If posters do not load:

1. Confirm the backend can reach the Plex base URL from inside the container.
2. Confirm the Plex token is configured server-side.
3. Check `/api/items/<id>/poster` directly; it should return an image or a fixture SVG fallback.
4. Check logs for redacted errors only. Tokens should appear as `[REDACTED]` if an error includes them.
