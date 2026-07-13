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

## Build Locally

```bash
docker build -t moodarr:local .
docker run --rm -p 4401:4401 \
  -v moodarr-data:/data \
  -e MOODARR_ADMIN_TOKEN="replace-with-a-long-random-token" \
  -e MOODARR_ADMIN_AUTO_SESSION=false \
  -e MOODARR_WEB_ORIGIN="http://<unraid-host>:4401" \
  moodarr:local
```

Open `http://<unraid-host>:4401`, enter the admin token in the Admin Access control, then configure Plex and Seerr. The browser exchanges the token with `POST /api/admin/session` for an HTTP-only, SameSite=Strict cookie; direct API clients can still send the token with `X-Moodarr-Admin-Token` or `Authorization: Bearer`. The Admin Lock action calls `DELETE /api/admin/session`, clears that cookie, and sets a local lock marker so automatic LAN admin sessions do not immediately reopen the screen; entering the token again clears the marker.

If a reverse proxy provides HTTPS, set `MOODARR_WEB_ORIGIN` to the exact public `https://` origin. Moodarr uses that setting for callback validation and to add the `Secure` attribute to session cookies.
Plex sign-in will not start in production without an explicit origin. Cookie-authenticated writes also require that exact origin, so changing the hostname or reverse-proxy origin requires updating this setting before testing sign-in or admin actions.

Do not enable `MOODARR_ADMIN_AUTO_SESSION` merely to skip the sign-in step. When true, any visitor able to load the bundled UI can receive admin access, so Plex-user/admin separation exists only when it is false or an external authentication layer supplies the boundary.

## Pull Beta Image

Use the beta.1 tag below only after it appears on the GitHub Releases page, which is authoritative for release availability. Record the resolved GHCR digest after pulling it.

```bash
docker pull ghcr.io/jremick/moodarr:v0.1.0-beta.1
docker run --rm --init --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777 \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=128 --memory=2g --memory-swap=2g --cpus=2 \
  -p 4401:4401 \
  -v moodarr-data:/data \
  -e MOODARR_ADMIN_TOKEN="replace-with-a-long-random-token" \
  -e MOODARR_ADMIN_AUTO_SESSION=false \
  -e MOODARR_WEB_ORIGIN="http://<unraid-host>:4401" \
  ghcr.io/jremick/moodarr:v0.1.0-beta.1
```

## Compose

```bash
cp docker-compose.example.yml docker-compose.yml
```

Set the required admin token and the exact origin browsers use to open Moodarr, then run:

```bash
export MOODARR_ADMIN_TOKEN="replace-with-a-long-random-token"
export MOODARR_WEB_ORIGIN="http://<unraid-host>:4401"
docker compose up -d --no-build
```

Use the reverse proxy's public `https://` origin instead when TLS terminates in front of Moodarr. Do not use `127.0.0.1` unless every browser actually opens Moodarr on that origin.

Do not commit the copied compose file if it contains tokens.

The example Compose file deliberately supplies operational defaults such as sync interval and result limit as environment variables. Environment values override Admin-saved values after recreation. To manage one of those settings only through Admin, remove that key from your local Compose copy instead of setting it to an empty value.

## Unraid Template

The template at `unraid/moodarr.xml` targets the versioned beta image tag `ghcr.io/jremick/moodarr:v0.1.0-beta.1`. After pulling, record its immutable digest; for stricter pinning, Unraid's Repository field can use the digest-qualified reference. For local-only testing, build and tag a local image as `moodarr:local` and adjust the template repository field.

Use bridge networking unless your Plex or Seerr URLs require another mode. The Plex and Seerr base URLs must be reachable from inside the Moodarr container.

The template requires `MOODARR_WEB_ORIGIN` and preserves the same runtime hardening as the Compose example: a read-only root filesystem, writable appdata, a 512 MiB `/tmp` tmpfs, all Linux capabilities dropped, no-new-privileges, init handling, and bounded PID/CPU/memory use. The memory-plus-swap ceiling equals the 2 GiB memory limit, so the default does not add swap beyond that budget. The `/tmp` ceiling is sized for SQLite migrations against production-size databases; reducing it can surface a misleading `database or disk is full` error. Keep the Appdata mapping writable; Moodarr stores SQLite and saved settings there. If the instance legitimately needs more than two CPUs, 2 GiB RAM, or 128 processes, adjust only the corresponding Extra Parameters limit and re-test health, sync, search, and posters.

Keep the appdata path private. Saved admin settings include Plex and Seerr credentials in `/data/config.json`; a volume previously used by a source/EXP build can also retain an inert OpenAI key until it is cleared in Admin. Moodarr writes that file with restrictive permissions when the host filesystem supports them.
The appdata directory must be writable by UID/GID `999:999`. If startup reports a permission error after moving or restoring appdata, correct that directory's ownership through the Unraid host rather than making it world-writable.

Values present in the Unraid template remain environment overrides on every restart. This includes the advanced sync interval, Seerr-sync, and result-limit fields. Change or remove the corresponding template variable if you want an Admin-saved value to take precedence; secret and origin fields should normally remain explicit template settings.

The SQLite database can also contain signed-in-user Plex tokens, identity, request audits, feedback, and profiles. Back up the complete appdata directory only while the container is stopped or through an atomic storage snapshot, encrypt the backup, and test a restore. See [Backup And Recovery](BACKUP_AND_RECOVERY.md) and [Data And Privacy](DATA_AND_PRIVACY.md).

## Beta.1 Provider Boundary

The official beta.1 image bakes in provider policy `none`, excludes the OpenAI network endpoint from the server bundle, and rejects environment, retained config, and Admin attempts to enable it. The Unraid template intentionally exposes no provider or key fields. Provisional provider testing requires a separate, explicitly configurable source/EXP build and is outside this deployment and support contract.

## Poster Checks

Browser clients should only request posters from Moodarr paths like `/api/items/<id>/poster`. Plex tokens must never appear in image URLs or generated HTML. If posters do not load:

1. Confirm the backend can reach the Plex base URL from inside the container.
2. Confirm the Plex token is configured server-side.
3. Check `/api/items/<id>/poster` directly; it should return an image or a fixture SVG fallback.
4. Check logs for redacted errors only. Tokens should appear as `[REDACTED]` if an error includes them.
