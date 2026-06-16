# Unraid Deployment

Moodarr is designed to run as a single container where it can reach user-provided Plex and Seerr/Jellyseerr URLs. For most home media setups, keep it on the same LAN, VPN, or trusted container network as those services; exposing media-server APIs to a public host adds avoidable network and secret-management risk.

## Container Defaults

- Web/API port: `4401`
- Persistent data path: `/data`
- SQLite database: `/data/moodarr.sqlite`
- Persistent app config: `/data/config.json`
- Runtime user: non-root `moodarr`
- Admin auth: enabled by default in the Docker image
- AI model default: `gpt-5.5` when OpenAI is enabled

## Build Locally

```bash
docker build -t moodarr:local .
docker run --rm -p 4401:4401 \
  -v moodarr-data:/data \
  -e MOODARR_ADMIN_TOKEN="replace-with-a-long-random-token" \
  moodarr:local
```

Open `http://<unraid-host>:4401`, store the admin token in the Admin screen, then configure Plex and Seerr.

## Pull Alpha Image

```bash
docker pull ghcr.io/jremick/moodarr:v0.1.0-alpha.1
docker run --rm -p 4401:4401 \
  -v moodarr-data:/data \
  -e MOODARR_ADMIN_TOKEN="replace-with-a-long-random-token" \
  ghcr.io/jremick/moodarr:v0.1.0-alpha.1
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

The template at `unraid/moodarr.xml` targets the immutable alpha image tag `ghcr.io/jremick/moodarr:v0.1.0-alpha.1`. For local-only testing, build and tag a local image as `moodarr:local` and adjust the template repository field.

Use bridge networking unless your Plex or Seerr URLs require another mode. The Plex and Seerr base URLs must be reachable from inside the Moodarr container.

Keep the appdata path private. Saved admin settings may include Plex, Seerr, and OpenAI credentials in `/data/config.json`; Moodarr writes that file with restrictive permissions when the host filesystem supports them.

## Poster Checks

Browser clients should only request posters from Moodarr paths like `/api/items/<id>/poster`. Plex tokens must never appear in image URLs or generated HTML. If posters do not load:

1. Confirm the backend can reach the Plex base URL from inside the container.
2. Confirm the Plex token is configured server-side.
3. Check `/api/items/<id>/poster` directly; it should return an image or a fixture SVG fallback.
4. Check logs for redacted errors only. Tokens should appear as `[REDACTED]` if an error includes them.
