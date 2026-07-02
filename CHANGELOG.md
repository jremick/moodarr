# Changelog

## 0.1.0-alpha.14 - 2026-07-02

- Added deterministic `ContentFingerprintV1` storage with evidence, confidence, source-quality, and safety/friction dimensions for richer content understanding.
- Projected positive fingerprint dimensions into the mood feature index as a separate source, improving no-AI retrieval for searches such as nostalgic time travel in Paris.
- Fixed mood feature namespace preservation, added fingerprint rebuild tooling, and refreshed the MoodRank human/agent review docs and improvement plan.

## 0.1.0-alpha.13 - 2026-07-02

- Supersedes alpha.12 with the same preferred-example, ranking, Plex-link, and iOS alpha scaffold changes after tightening the rank-index coverage eval timeout for GitHub CI.

## 0.1.0-alpha.12 - 2026-07-02

- Added preferred mood examples with heart controls in comfortable, list, and compact result views, giving users a stronger representative-example signal than thumbs-up.
- Kept thumbs-up feedback from immediately reordering the visible result list while preserving explicit heart-driven ranking steering.
- Expanded candidate coverage and diagnostics for larger catalogs, kept AI reranking bounded to the top deterministic slice, and tightened Plex TV metadata links.
- Added the native SwiftUI iOS alpha scaffold and goal docs with Plex-first user auth, server URL persistence, search, feedback, poster proxy, and request preview/create flows.

## 0.1.0-alpha.11 - 2026-07-01

- Added a Screening Desk-style search processing overlay with progress, catalog-count, and result-target indicators for first searches and refinements.
- Added safe IMDb title links to result cards when valid stored IMDb IDs are available.
- Tightened recommendation explanation wording to avoid repetitive process language and repeated lead genres.

## 0.1.0-alpha.10 - 2026-07-01

- Fixed result-card Plex actions to open the reliable Plex web URL before falling back to custom app links.
- Restyled Seerr open/request actions as bottom card tabs with Seerr-colored treatment to match the Plex action pattern.
- Kept follow-up refinements on a fresh eligible-catalog search pass under the current availability filter.

## 0.1.0-alpha.9 - 2026-07-01

- Refined follow-up option generation so refinement turns avoid repeating already-requested directions and produce more decisive next-step choices.
- Added deterministic variation to recommendation explanations so repeated result cards do not all read with the same stock phrasing.
- Moved signed-in Plex user logout from the compact account chip into Admin access controls.

## 0.1.0-alpha.8 - 2026-07-01

- Calibrated visible match percentages so refined result lists no longer collapse many broad matches to `100%`.
- Kept internal ranking scores separate from display percentages, preserving refinement ordering while making visible confidence more granular.
- Moved repeated genre-feedback boosts off the `100%` ceiling so users can compare close recommendations more easily.

## 0.1.0-alpha.7 - 2026-07-01

- Added Wikidata-backed catalog import, normalization, readiness, and deterministic mood-enrichment tooling for the larger ranked catalog.
- Added candidate-first catalog search and scoped bulk inflation so local retrieval no longer scans the full catalog per query.
- Added a materialized catalog search index and benchmark harness for full-catalog latency regression checks.
- Preserved Plex and bounded Seerr gating so catalog-only items stay out of final recommendations unless they are attached or verified requestable.

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
