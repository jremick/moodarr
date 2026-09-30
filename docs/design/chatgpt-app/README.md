# Moodarr ChatGPT app — interactive design review

Status: fixture-backed UX proposal. No MCP integration or live authentication.

## Approved local scope

Create a reviewable interactive prototype before production UI implementation. Keep the current web client, server, auth, shared contracts, and package manifests unchanged. The main checkout contains unrelated work; this proposal lives in an isolated managed worktree.

The user clarified that the connection requires a publicly accessible authenticated Moodarr API or MCP endpoint. The external contract is provider-neutral: users do not need a Cloudflare account or a specific tunnel provider. Cloudflare is a possible initial backend host, not a user-facing dependency. Hosting adapters, connection reachability, OAuth, MCP tools, and resource delivery belong to the backend workstream.

## Design

The audience is someone deciding what to watch, with their own library and permissions. A compact shortlist leads to a title, a clear availability state, and one useful action. Conversation remains in ChatGPT; the app does not add a chat composer.

The visual direction adapts Screening Desk: the ticket mark, restrained teal actions, concise catalog metadata, and warm surfaces on the external connection page. The embedded surface uses host typography and neutral host surfaces, as OpenAI requires. Reference sources are `../opus-design-system.html` and `../opus-admin-mockup.html`.

Tokens retained: ink `#2f3d3a`, muted `#576862`, background `#fbf6ee`, paper `#f7dfbd`, accent `#4a7d75`, line `#eadfd1`. The inline surface maps structural colors and typography to MCP host CSS variables with neutral fallbacks. Eight-pixel controls, compact metadata, and a small ticket mark identify the app. Motion is limited to a short entrance and progress indicator; reduced-motion preferences remove it.

The review toolbar is outside the proposed product. It switches fixture scenarios and light/dark host previews. The title dialog represents an expanded host surface. Production should use host display-mode capabilities or a separate title tool card; it must not nest a deep app inside the inline card.

## Current API evidence

Inspected baseline: `c3d5ab4`.

| Flow | Existing contract | UI consequence |
| --- | --- | --- |
| Recommendations | `POST /api/search`, `SearchRequest`, `SearchResponse` | Keep user intent, availability, reasons, and refinement context; do not invent match percentages. |
| Title | `GET /api/items/:id` | Fetch current details before offering actions. |
| Feedback | `POST /api/feel-feedback`, `clientEventId`, `replacesClientEventId` | Acknowledged feedback only; do not promise a specific ranking improvement or unsupported undo. |
| Request preview | `POST /api/requests/preview`, `RequestPreview` | `requiresConfirmation: true`, `requestMode: attempt`, `seerrAvailabilityChecked: false`. Show the exact title/selection and explain the attempt. |
| Request create | `POST /api/requests/create`, `CreateRequestBody` | Preserve preview-bound media identity, seasons, phrase, token, user identity, and operation identity; explicit user confirmation. |
| Uncertain request | Existing operation reconciliation in `/api/requests/create` | Never generate a new operation and blindly resend. A read-only status action needs an agreed MCP contract. |
| Watchlist | `POST /api/plex/watchlist` | Requires signed-in Plex user, `canRequest`, and available Plex item. Distinguish it from a Seerr request. |

The mockup has no API adapter and never calls these routes. All accounts, connection results, availability, feedback acknowledgements, request receipts, and status recovery are fictional session fixtures. Reloading resets them. Poster images are public external review assets and have local visual fallbacks.

## Current OpenAI sources

Checked 2026-09-30. The Apps SDK pages now lead to Plugins documentation.

- [Add UI to your MCP server](https://developers.openai.com/plugins/build/chatgpt-ui): standard MCP Apps bridge, `ui/notifications/tool-result`, `tools/call`, resource URI and MIME type; optional ChatGPT extensions. Keep data tools useful without UI.
- [UI guidelines](https://developers.openai.com/plugins/concepts/ui-guidelines): small inline result sets, limited actions, host fonts/colors, no duplicate composer, expanded surfaces for deeper interaction.
- [Authentication](https://developers.openai.com/plugins/build/auth): MCP OAuth 2.1 flow and server-side token verification. Authentication is external to this prototype.
- [Reference](https://developers.openai.com/plugins/reference): missing approval-gated initial input is expected; render a waiting state until host input arrives.

## Backend decisions required before integration

1. Versioned tool names and input/output/error schemas, plus UI resource registration and host capabilities.
2. OAuth authorization URL, account/instance identity, consent scopes, reconnect/revoke behavior, and permission readback. No admin/provider token fields in UI or model data.
3. Supported public HTTPS API/MCP endpoint detection and authentication discovery. Ordinary LAN-only URLs are not reachable by a public hosted service. The prototype asks for an authenticated public endpoint without prescribing a hosting or tunnel provider.
4. A poster delivery route compatible with UI CSP and user authorization, without provider credentials in URLs. Do not ship third-party review image URLs as the integration solution.
5. Exact preview expiry, immutable confirmation identity, safe operation reuse, uncertain-outcome reconciliation, and request-status readback.
6. Feedback source mapping (`web`, `ios`, `admin` are the current values), idempotency, replacement/undo semantics, and acknowledgment shape.
7. Host-supported external links, display modes, theme variables, and request confirmation gates.

Proposed UI states are not promises that the backend already supports them. The MVP should keep request creation disabled until confirmation and reconciliation contracts are proven.

## Acceptance and failure cases

- Desktop and 390px mobile: all title/availability metadata readable; no horizontal page overflow; posters load or retain a usable fallback.
- Keyboard: visible focus; native dialog focus containment; Escape closes and restores focus.
- Feedback: a pending interaction cannot double-submit; acknowledge only after the fixture completes.
- Requests: cancel has no effect; a fresh explicit confirmation is required; rapid clicks produce one attempt; uncertain outcomes cannot offer another create action; checking status reads the same operation.
- Session/permissions: expired connection and read-only states block writes with a clear next action.
- Connection: never claim LAN connectivity, actual sign-in, or consent from URL validation. A distinct simulated consent step follows the fixture reachability result.
- No fetch, XHR, credentials, storage of tokens, server requests, or real media actions. A CSP blocks network connections and form submissions; external image loads are the only non-local requests.

## Preview and repeatable verification

From this worktree root:

```sh
python3 -m http.server 4178 --bind 127.0.0.1 --directory docs/design/chatgpt-app
```

Open `http://127.0.0.1:4178/`. `verify.mjs` exports a Playwright walkthrough accepting an existing page and an absolute output directory. It checks user-visible behavior, collects desktop/mobile/dark screenshots, and returns a JSON result. It uses no new project dependency. Evidence should be saved outside the repository.

Verification layers remain separate: local browser walkthrough; MCP protocol integration; real Moodarr auth/actions; live ChatGPT rendering. Only the first is in scope for this proposal. Stop after the mockup and local checks; do not deploy, publish, submit, install dependencies, or change backend contracts.

## Review image references

Images are embedded remotely for this local review only; no redistribution rights are claimed.

- [Chef poster](https://quinlan.it/2014/07/30/chef-ricetta-perfetta/)
- [Hunt for the Wilderpeople poster](https://www.grandmasbriefs.com/blog/saturday-movie-review-hunt-for-the-wilderpeople.html)
- [Paddington 2 poster](https://www.impawards.com/intl/uk/2017/paddington_two_ver31_xlg.html)
