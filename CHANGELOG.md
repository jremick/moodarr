# Changelog

## Unreleased

## 0.1.0-alpha.2 - 2026-06-16

- Fixed bundled-container admin access by issuing an HTTP-only same-origin admin session from the container-side `MOODARR_ADMIN_TOKEN`.
- Added configurable OpenAI reasoning effort through env, Admin settings, and server-side persisted config.
- Defaulted GPT 5.5 reasoning effort to `low` and documented the new container knobs.

## 0.1.0-alpha.1 - 2026-06-16

- Initial local-first Plex + Seerr companion app MVP.
- Natural-language recommendation flow with deterministic retrieval, optional OpenAI parsing/reranking, feedback signals, and fixture-mode evaluation.
- Admin settings, sync controls, support diagnostics, and token redaction.
- Docker, Compose, and Unraid packaging scaffolding.
- Request preview/create confirmation, audit logging, and local request-state updates.
- Poster proxying with backend cache and secret-safe URL handling.
