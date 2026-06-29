# Unraid Deployment

Moodarr is designed to run as a single container where it can reach user-provided Plex and Seerr/Jellyseerr URLs. For most home media setups, keep it on the same LAN, VPN, or trusted container network as those services; exposing media-server APIs to a public host adds avoidable network and secret-management risk.

## Container Defaults

- Web/API port: `4401`
- Persistent data path: `/data`
- SQLite database: `/data/moodarr.sqlite`
- Persistent app config: `/data/config.json`
- Runtime user: non-root `moodarr`
- Admin auth: enabled by default in the Docker image
- Admin Web UI session: container-issued HTTP-only session by default when `MOODARR_ADMIN_TOKEN` and `MOODARR_ADMIN_AUTO_SESSION=true` are set
- AI model default: `gpt-5.5` when OpenAI is enabled
- OpenAI reasoning effort default: `low` for `gpt-5.5`

## Build Locally

```bash
docker build -t moodarr:local .
docker run --rm -p 4401:4401 \
  -v moodarr-data:/data \
  -e MOODARR_ADMIN_TOKEN="replace-with-a-long-random-token" \
  -e MOODARR_ADMIN_AUTO_SESSION=true \
  moodarr:local
```

Open `http://<unraid-host>:4401`, then configure Plex and Seerr. The bundled Web UI receives an HTTP-only admin session from the container-side admin token; direct API clients can still send the token with `X-Moodarr-Admin-Token` or `Authorization: Bearer`.

## Pull Alpha Image

```bash
docker pull ghcr.io/jremick/moodarr:v0.1.0-alpha.6
docker run --rm -p 4401:4401 \
  -v moodarr-data:/data \
  -e MOODARR_ADMIN_TOKEN="replace-with-a-long-random-token" \
  -e MOODARR_ADMIN_AUTO_SESSION=true \
  ghcr.io/jremick/moodarr:v0.1.0-alpha.6
```

## Compose

```bash
cp docker-compose.example.yml docker-compose.yml
```

Edit the copied file with local secrets, then run:

```bash
docker compose up -d --build
```

Do not commit the copied compose file if it contains tokens.

## Unraid Template

The template at `unraid/moodarr.xml` targets the immutable alpha image tag `ghcr.io/jremick/moodarr:v0.1.0-alpha.6`. For local-only testing, build and tag a local image as `moodarr:local` and adjust the template repository field.

Use bridge networking unless your Plex or Seerr URLs require another mode. The Plex and Seerr base URLs must be reachable from inside the Moodarr container.

Keep the appdata path private. Saved admin settings may include Plex, Seerr, and OpenAI credentials in `/data/config.json`; Moodarr writes that file with restrictive permissions when the host filesystem supports them.

## Poster Checks

Browser clients should only request posters from Moodarr paths like `/api/items/<id>/poster`. Plex tokens must never appear in image URLs or generated HTML. If posters do not load:

1. Confirm the backend can reach the Plex base URL from inside the container.
2. Confirm the Plex token is configured server-side.
3. Check `/api/items/<id>/poster` directly; it should return an image or a fixture SVG fallback.
4. Check logs for redacted errors only. Tokens should appear as `[REDACTED]` if an error includes them.
