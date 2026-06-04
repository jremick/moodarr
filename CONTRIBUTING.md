# Contributing

Moodarr can be developed without Plex or Seerr by using fixture mode, which is the default when integration credentials are absent.

## Local Setup

```bash
npm install
cp .env.example .env
npm run dev
```

## Verification

Run the normal gate before opening a pull request:

```bash
npm run verify
npm run eval:recommendations
```

For release packaging changes, run:

```bash
npm run verify:release
```

`verify:release` builds and smoke-tests the Docker image, so it requires Docker.

## Security Rules

- Never commit Plex, Seerr, OpenAI, or admin tokens.
- Do not add personal hostnames, usernames, homelab paths, or private library data.
- Keep Plex integration read-only.
- Do not create Seerr requests automatically from AI output.
- Keep fixture data synthetic or public-catalog generic.
