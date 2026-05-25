# Feelerr

Feelerr is an open-source Plex + Seerr companion app for finding what to watch. It reads a user-provided Plex server, reads a Seerr/Jellyseerr-compatible request system, ranks natural-language matches, and only creates requests after an explicit confirmation.

## MVP

- React + Vite client.
- Fastify TypeScript API.
- Local SQLite cache.
- Fixture mode for contributors without Plex or Seerr.
- Plex read APIs only.
- Seerr/Jellyseerr read APIs plus explicit confirmed request creation.
- Optional server-side OpenAI reranking when `OPENAI_API_KEY` exists.

## Quick Start

```bash
node --version # requires Node 24+
npm install
cp .env.example .env
npm run dev
```

Open the Vite URL printed by the dev server. Fixture mode is enabled by default, so the app works without private media servers.

## Configuration

Set these values in `.env` for real integrations:

- `PLEX_BASE_URL`
- `PLEX_TOKEN`
- `SEERR_BASE_URL`
- `SEERR_API_KEY`
- `AI_PROVIDER=openai`
- `OPENAI_API_KEY`

Tokens are read by the backend only. They are not returned by API routes, embedded in the client bundle, placed in poster URLs, or logged without redaction.

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

## Verification

```bash
npm run verify
```

The verification suite runs linting, typechecking, API tests, a production client build, and a secret scan against generated client assets.

## Request Safety

`POST /api/requests/preview` returns the exact media type, TMDB media ID, title, and TV seasons that would be requested. `POST /api/requests/create` requires both `confirmed: true` and the preview confirmation phrase. Search and AI output cannot create a request directly.

## Fixture Mode

Fixture mode seeds a small mixed Plex and Seerr catalog with available, requestable, already requested, and partially available examples. It is intended for local development and CI without private server access.

## License

MIT is recommended for this app because the project is intended as a contributor-friendly open-source companion tool. A placeholder MIT license is included for `Feelerr contributors`.
