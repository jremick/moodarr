# Changelog

## 0.1.0-alpha.6 - 2026-06-29

- Added MoodRank v0.4 rank-indexed full-library deterministic scoring so later refinement passes are not bounded by the first-stage retrieval candidate cap.
- Added v0.3-vs-v0.4 recommendation eval reporting and a regression case proving v0.4 can surface a valid match that v0.3's capped retrieval path misses.
- Expanded MoodRank eval coverage to 16 golden cases, 40 adversarial cases, and a 4-case v0.4-only rank-index stress suite.
- Raised AI reranking input to the top 100 deterministic candidates.
- Added signed-in Plex Watchlist support for available Plex items.
- Improved Plex sign-in return handling and item/refinement copy for the web app.

## 0.1.0-alpha.5 - 2026-06-18

- Added native-client user session support for Plex auth without granting admin access.
- Added recommendation `sessionId` responses and idempotent feel feedback retries for mobile clients.
- Published the alpha.5 container image for the EXP redeploy.

## 0.1.0-alpha.4 - 2026-06-18

- Added request-audit attribution fields for signed-in Plex users.
- Published the alpha.4 container image for the EXP redeploy.

## 0.1.0-alpha.3 - 2026-06-17

- Added Feel Profile scoring for user-specific mood language, including persisted profile terms, structured feel feedback events, and admin diagnostics/reset APIs.
- Added synthetic profile personalization evals with `PersonalizationLift@3` and term-level win/loss/tie reporting.
- Added synthetic profile journey evals, drift diagnostics, checkpoint rollback, and admin profile export/reset/rollback controls.
- Wired web result-card feedback into structured feel signals without storing raw prompts by default.
- Changed the default Finder result count from 20 to 50 and added an Admin setting for the default result count.
- Refreshed the public README, security reporting, release checklist, and Mood/Feel recommendation docs for public alpha.

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
