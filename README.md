# Moodarr

Moodarr is an open-source Plex + Seerr companion app for finding what to watch. It reads a user-provided Plex server, reads a Seerr/Jellyseerr-compatible request system, ranks natural-language matches, and only creates requests after an explicit confirmation.

![Moodarr finder screen with live Plex recommendations](docs/assets/moodarr-finder.png)

## MVP

- React + Vite client.
- Fastify TypeScript API.
- Local SQLite cache.
- Persistent server-side config for container installs.
- Admin screen for connection settings, sync controls, and runtime status.
- Fixture mode for contributors without Plex or Seerr.
- Plex read APIs only.
- Seerr/Jellyseerr read APIs plus explicit confirmed request creation.
- Optional server-side OpenAI brief parsing, embeddings, reranking, explanations, and refinement options when `OPENAI_API_KEY` exists.

## Quick Start

```bash
node --version # requires Node 24+
npm install
cp .env.example .env
npm run dev
```

Open the Vite URL printed by the dev server. Fixture mode is enabled by default, so the app works without private media servers.

## Container Quick Start

```bash
docker build -t moodarr:local .
docker run --rm -p 4401:4401 \
  -v moodarr-data:/data \
  -e MOODARR_ADMIN_TOKEN="replace-with-a-long-random-token" \
  moodarr:local
```

Open `http://127.0.0.1:4401`, store the admin token in the Admin screen, then configure Plex and Seerr. See [docs/UNRAID.md](docs/UNRAID.md) for Unraid notes and the template in [unraid/moodarr.xml](unraid/moodarr.xml).

Moodarr is intended to run as a container where it can reach your Plex and Seerr/Jellyseerr services. For most home media setups, that means running it on the same LAN, VPN, or trusted container network rather than exposing media-server APIs to a public host.

## Configuration

Set these values in `.env` for real integrations:

- `MOODARR_ADMIN_TOKEN`
- `PLEX_BASE_URL`
- `PLEX_TOKEN`
- `SEERR_BASE_URL`
- `SEERR_API_KEY`
- `AI_PROVIDER=openai`
- `OPENAI_API_KEY`
- `OPENAI_MODEL` defaults to `gpt-5.5`
- `OPENAI_EMBEDDING_MODEL` defaults to `text-embedding-3-large`

Tokens are read by the backend only. They are not returned by API routes, embedded in the client bundle, placed in poster URLs, or logged without redaction.

Container installs can also save integration settings through the Admin screen. They are written to `MOODARR_CONFIG_PATH`, which defaults to `/data/config.json` in the Docker image. Environment variables still take precedence on restart.

When admin auth is enabled, private catalog reads, search, poster proxying, request previews, admin writes, and request creation require the admin token. Keep Moodarr LAN/VPN-only unless another authentication layer protects it.

## API

- `GET /api/health`
- `GET /api/config/status`
- `POST /api/plex/test`
- `POST /api/seerr/test`
- `POST /api/library/sync`
- `POST /api/seerr/sync`
- `GET /api/library/stats`
- `POST /api/search`
- `GET /api/items/:id`
- `GET /api/items/:id/poster`
- `POST /api/requests/preview`
- `POST /api/requests/create`
- `GET /api/admin/settings`
- `PUT /api/admin/settings`
- `GET /api/admin/sync/status`
- `POST /api/admin/sync/run`
- `GET /api/admin/recommendations/diagnostics`
- `GET /api/admin/support-bundle`

## Verification

```bash
npm run verify
```

The verification suite runs linting, typechecking, API tests, a production client build, and a secret scan against generated client assets.

For release packaging work, run:

```bash
npm run verify:release
```

That adds recommendation evals, Compose/Unraid packaging checks, and a Docker smoke test.

## Request Safety

`POST /api/requests/preview` returns the exact media type, TMDB media ID, title, and TV seasons that would be requested. `POST /api/requests/create` requires both `confirmed: true` and the preview confirmation phrase. Search and AI output cannot create a request directly.

## Fixture Mode

Fixture mode seeds a small mixed Plex and Seerr catalog with available, requestable, already requested, and partially available examples. It is intended for local development and CI without private server access.

## License

Moodarr is licensed under the [Apache License 2.0](LICENSE).
