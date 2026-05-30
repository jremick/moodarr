# Unraid Deployment

Feelarr is designed to run as a single container on a LAN where it can reach user-provided Plex and Seerr/Jellyseerr URLs. Railway is not the right default for this use case because Plex and Seerr usually live on a private network; exposing those APIs to a cloud host adds avoidable network and secret-management risk.

## Container Defaults

- Web/API port: `4401`
- Persistent data path: `/data`
- SQLite database: `/data/feelerr.sqlite`
- Persistent app config: `/data/config.json`
- Runtime user: non-root `feelerr`
- Admin auth: enabled by default in the Docker image
- AI model default: `gpt-5.5` when OpenAI is enabled

## Build Locally

```bash
docker build -t feelarr:local .
docker run --rm -p 4401:4401 \
  -v feelarr-data:/data \
  -e FEELERR_ADMIN_TOKEN="replace-with-a-long-random-token" \
  feelarr:local
```

Open `http://<unraid-host>:4401`, store the admin token in the Admin screen, then configure Plex and Seerr.

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

The template at `unraid/feelerr.xml` targets `ghcr.io/jremick/feelerr-app:latest`. Until an image is published, either build and tag a local image as `feelarr:local` and adjust the template repository field, or publish a private GHCR package and authenticate Unraid to that registry.

Use bridge networking unless your Plex or Seerr URLs require another mode. The Plex and Seerr base URLs must be reachable from inside the Feelarr container.

Keep the appdata path private. Saved admin settings may include Plex, Seerr, and OpenAI credentials in `/data/config.json`; Feelarr writes that file with restrictive permissions when the host filesystem supports them.

## Poster Checks

Browser clients should only request posters from Feelarr paths like `/api/items/<id>/poster`. Plex tokens must never appear in image URLs or generated HTML. If posters do not load:

1. Confirm the backend can reach the Plex base URL from inside the container.
2. Confirm the Plex token is configured server-side.
3. Check `/api/items/<id>/poster` directly; it should return an image or a fixture SVG fallback.
4. Check logs for redacted errors only. Tokens should appear as `[REDACTED]` if an error includes them.
