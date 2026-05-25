# Feelerr Design System And UX Review

Status: proposal for review, not implemented in the React app yet.

## Product Direction

Feelerr should feel like a private screening desk for a Plex library, not a generic dashboard. The user is trying to answer one question quickly: "What should we watch, and can we get it if we do not have it?" The interface should optimize comparison, trust, and explicit request safety.

## Current UI Diagnosis

- The Finder screen has useful controls, but visual hierarchy is flat. Search, filters, prompt chips, result cards, and the detail poster all compete at similar weight.
- The large right poster makes the selected item feel important, but it consumes too much decision space before the app has proven why the item is good.
- Result cards are readable but repetitive. A user scanning 20 options needs denser comparison: score, availability, runtime, reason, and action should line up predictably.
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
- Result count is a stepper/number input with default 20 and max 50.
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

1. Approve visual direction through `public/ux-proposal.html`.
2. Extract design tokens into `src/client/styles.css` variables.
3. Refactor Finder layout into CommandPanel, ResultList, ResultRow, and DetailPanel components.
4. Convert result cards to dense ranked rows with larger posters, explanation, and description.
5. Rebuild detail panel around availability evidence and actions.
6. Add browser checks for desktop/mobile no-overlap, result count, admin-only health, poster rendering, and request safety.

## Recommendation Engine

### Current MVP Flow

The current implementation is a hybrid retrieval and reranking system:

1. Query parsing infers simple filters from the natural-language prompt.
   Examples: "movie" narrows to movies, "series" narrows to TV, and "under two hours" sets a runtime cap.

2. Deterministic retrieval searches the local SQLite catalog first.
   It scores title, summary, genres, cast, director, content rating, runtime, ratings, media type, Plex availability, and Seerr requestability. This guarantees the app works without a model provider.

3. Seerr catalog search augments weak local results.
   When local results are sparse or everything is already available in Plex, the backend searches Seerr/Jellyseerr and caches requestable/request-status records.

4. The recommendation provider reranks the candidate set.
   The backend sends only candidate metadata to the model: title, media type, year, runtime, genres, summary, ratings, content rating, availability group, Seerr status, and request status. It never sends Plex tokens, Seerr keys, OpenAI keys, or admin tokens.

5. The model must return structured JSON.
   Each candidate receives an ID, 0-100 relevance score, and a concise explanation. The backend matches IDs back to known candidates and displays only those known candidates.

6. Request creation is separate.
   Model output can explain and rank, but it cannot create requests. Requests still require backend preview plus explicit user confirmation.

### Current Weaknesses

- Retrieval is lexical and metadata-dependent. If Plex metadata is thin, the candidate set can miss good results before the model sees them.
- Candidate count is limited before reranking, so a great item outside the top deterministic set may never be considered.
- There is no offline quality benchmark yet. We have functional tests, but not taste/relevance tests.
- Explanations are model-generated and should be checked for faithfulness against candidate metadata.

### How We Know It Works

Right now we know it works mechanically, not yet editorially:

- Tests verify search, request safety, token redaction, poster proxying, and ranker response parsing.
- Live checks verify Plex/Seerr/OpenAI connectivity and that model reranking returns structured results.
- Browser checks verify the UI can display real poster-backed recommendations.

That is not enough to claim recommendation quality. It proves the system runs safely and produces plausible output.

### Quality Plan

Add an evaluation harness before treating the algorithm as production-grade:

1. Golden prompt set.
   Store representative prompts such as "funny fantasy movie under two hours", "something like Stardust", "feel-good comedy for tonight", "short TV series we can start", and "movie like The Do-Over but better".

2. Expected candidate bands.
   For each prompt, define must-include, nice-to-have, and should-not-rank-high titles from the real library or a sanitized fixture catalog.

3. Ranking metrics.
   Track top-3 hit rate, top-10 recall, availability correctness, runtime-filter correctness, and explanation faithfulness.

4. Regression snapshots.
   Save anonymized recommendation outputs with IDs/titles/scores/explanations and compare them when ranking code, prompts, or model settings change.

5. Human rating loop.
   Add local thumbs up/down or "not this vibe" feedback later. Keep it privacy-preserving and local by default.

6. Candidate-retrieval improvements.
   Add embeddings or richer semantic retrieval only after the deterministic baseline has measurable misses. The model cannot rescue titles it never receives.
