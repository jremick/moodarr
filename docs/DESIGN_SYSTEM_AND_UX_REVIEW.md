# Moodarr Design System And UX Review

Status: historical review and rationale. The current UI source of truth is `docs/design/opus-design-system.html`; `docs/design/opus-admin-mockup.html` is the approved Admin direction. Treat diagnoses and proposed phases below as review context, not a statement that the current React UI is unimplemented.

## Product Direction

Moodarr should feel like a private screening desk for a Plex library, not a generic dashboard. The user is trying to answer one question quickly: "What should we watch, and can we get it if we do not have it?" The interface should optimize comparison, trust, and explicit request safety.

## Current UI Diagnosis

- The Finder screen has useful controls, but visual hierarchy is flat. Search, filters, prompt chips, result cards, and the detail poster all compete at similar weight.
- The large right poster makes the selected item feel important, but it consumes too much decision space before the app has proven why the item is good.
- Result cards are readable but repetitive. A user scanning a large result set needs denser comparison: score, availability, runtime, reason, and action should line up predictably.
- The search controls need clearer grouping. Prompt input, result count, and filters are different kinds of control, but they currently read as one loose form.
- The app has a coherent brand mark, but the surrounding UI still looks like a soft admin panel rather than a media-finding product.
- Status and setup information belong in Admin. Finder should show only the state required to make a watch decision.

## Design Principles

1. Finder is a command surface.
   The first interactive object should be the natural-language prompt, with result count and filters attached as command settings.

2. Results are a ranked comparison table, not a gallery.
   Posters help recognition, but the ranking explanation and availability state are the primary decision data.

3. Detail is evidence plus action.
   The selected item panel should confirm availability, explain the match, show metadata, and expose "Open in Plex", "Open in Seerr", or "Request" only when safe.

4. Availability must be impossible to miss.
   Plex and Seerr can disagree. The UI needs explicit source labels instead of a single vague status.

5. Admin is operational.
   Health, sync, tokens, support bundle, fixture mode, and diagnostics live in Admin, not Finder.

## Visual Direction

Name: Screening Desk

Tone: calm, precise, media-aware, slightly tactile. Avoid streaming-service darkness and avoid generic SaaS cards. The app should feel like a careful catalog console with enough poster texture to stay tied to movies and TV.

## Tokens

### Color

| Token | Value | Use |
| --- | --- | --- |
| `--ink` | `#172126` | primary text and primary controls |
| `--paper` | `#f6efe3` | app background warmth and logo field |
| `--surface` | `#fffdf8` | main panels |
| `--surface-muted` | `#eef5f2` | controls and inactive chips |
| `--line` | `#d7e3de` | panel borders |
| `--line-strong` | `#9fb7af` | selected and structural separators |
| `--plex` | `#d49b28` | Plex source indicator |
| `--seerr` | `#236f68` | Seerr source indicator |
| `--request` | `#b86145` | request/action warning |
| `--muted` | `#657477` | secondary text |
| `--success` | `#16766b` | confirmed available/healthy |

Rules:
- One primary accent at a time: Seerr green for selection/action, rust only for request or caution.
- Poster art provides color; the chrome should stay quiet.
- Avoid purple/blue AI gradients.

### Typography

- Display and headings: `Satoshi`, `Avenir Next`, `Helvetica Neue`, sans-serif.
- Numbers and short metadata: tabular numeric settings on the same sans stack.
- No serif in the app UI.
- Finder card title: 15-16px, 760 weight.
- Body/reason text: 13-14px, 1.4 line height.
- Detail title: 24-28px desktop, 20-22px mobile.

### Spacing

- Base unit: 4px.
- Control height: 36px compact, 44px command input.
- Panel padding: 14-18px, not 28px.
- Result row gap: 10-12px.
- Detail gap: 12-16px.

### Radius And Borders

- App panels: 10px.
- Inputs/buttons/cards: 7-8px.
- Pills/chips: 999px only for short metadata and status.
- Prefer 1px borders and shallow tinted shadows. Heavy floating cards should be rare.

## Layout System

### Finder Desktop

Grid:
- Main content: `minmax(680px, 1fr)`.
- Detail rail: `360px-420px`.
- No Health sidebar.

Order:
1. Header.
2. Inline notice/status only when useful.
3. Command panel.
4. Results list.
5. Sticky detail rail.

### Finder Mobile

Order:
1. Header.
2. Search command.
3. Filters in collapsible groups.
4. Results list.
5. Detail as bottom sheet or stacked section after selected result.

## Component System

### Command Panel

Contains:
- Prompt input.
- Search action.
- Result count.
- Filters: media type, runtime, genre, availability.
- Prompt chips below filters.

Rules:
- Prompt is visually dominant.
- Filters use labels above controls.
- Result count is configurable; the current server default is 50 and the API maximum is 200.
- Recommendation ranking is always part of Finder when configured. Do not expose an AI toggle in the primary UI.

### Result Row

Contains:
- Larger poster thumb.
- Rank and score.
- Title, year, runtime, type.
- Availability source badges.
- Recommendation explanation.
- Media description immediately after the explanation.
- Inline primary action when obvious.

Rules:
- Selected row gets a left accent and stronger border.
- Poster thumb should be large enough to recognize artwork while still allowing fast scan, around 104-124px wide on desktop rows.
- Explanation should max at 2 lines, then the media description gets 2 lines. The detail panel can hold the full text later.
- Pills use inline-flex centering with vertical padding; no cramped single-line bubbles.

### Detail Panel

Contains:
- Compact poster/backdrop composition.
- Title/year/runtime/content rating.
- Availability stack: Plex source, Seerr source, request status.
- Match explanation and score reasoning.
- Actions.

Rules:
- Poster cannot consume more than half the first viewport on desktop.
- Actions are source-specific: `Open in Plex`, `Open in Seerr`, `Preview request`.
- Request create remains gated by preview and confirmation.

### Admin Health

Contains:
- Plex status.
- Seerr status.
- Recommendation provider status.
- Admin auth state.
- Library counts.
- Sync timestamps.
- Test/sync/support actions.

Rules:
- Admin can be denser than Finder.
- Health and runtime can sit side by side.
- Any errors must redact tokens.

## Interaction States

- Search loading: result rows skeleton matching the final row shape.
- Empty: prompt suggestions plus connection state.
- Recommendation provider unavailable: degrade to deterministic ranking and show status in Admin, not Finder.
- Live/fixture mode: top pill plus Admin detail. Finder should not explain fixture mode unless active.
- Request blocked: inline reason in detail panel; no disabled silent buttons.
- Poster failure: show local placeholder and surface safe diagnostic in Admin support bundle.

## Accessibility

- Every icon-only button needs an accessible label.
- Inputs keep visible labels.
- Result rows should be buttons or links with clear focus states.
- Color is never the only availability signal; use text labels.
- Motion should use transform/opacity and respect reduced motion.

## Proposed Implementation Phases

1. Use `docs/design/opus-design-system.html` as the approved visual direction and `docs/design/opus-admin-mockup.html` for Admin workflows.
2. Extract design tokens into `src/client/styles.css` variables.
3. Refactor Finder layout into CommandPanel, ResultList, ResultRow, and DetailPanel components.
4. Convert result cards to dense ranked rows with larger posters, explanation, and description.
5. Rebuild detail panel around availability evidence and actions.
6. Add browser checks for desktop/mobile no-overlap, result count, admin-only health, poster rendering, and request safety.

## Recommendation Engine References

The original engine snapshot previously embedded here became stale as indexed mood features, content fingerprints, rank-indexed retrieval, evaluation suites, structured feedback, replay/rollback, and optional provider embeddings shipped.

Use these current sources instead:

- `docs/MOODRANK_CURRENT_ALGORITHMS.md` for current stages, limits, telemetry, and eval status;
- `docs/RECOMMENDATION_ENGINE.md` for implementation and product boundaries;
- `docs/MOODRANK_IMPROVEMENT_PLAN.md` for accepted future work;
- `docs/DATA_AND_PRIVACY.md` for the beta.1 local-only boundary and the provisional source/EXP OpenAI boundary.

The design non-negotiables remain unchanged: availability and requestability come from Plex/Seerr, hard filters are deterministic, model output cannot create requests, and request creation requires preview plus explicit confirmation.
