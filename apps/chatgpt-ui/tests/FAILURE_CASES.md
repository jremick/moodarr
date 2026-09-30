# MCP Apps local browser verification

Written before the host and E2E implementation. The fixtures implement the inspected MCP adapter's public output shapes; they do not represent a real Moodarr connection or media action.

Primary boundary: a production app iframe connected to the official MCP Apps `AppBridge` through `PostMessageTransport`. The host captures `tools/call`, `ui/message`, and lifecycle messages. Tests interact with visible controls; no production test hook or test-only export is permitted.

| Observable invariant | Credible failure | Browser proof |
| --- | --- | --- |
| Await host input; no fixture content in production | UI assumes initial input or displays demo content before approval | Initialize without input/result; waiting state and zero calls |
| Search, item, preview, receipt remain single-purpose cards | Navigation replaces a shortlist in place or adds cloned chat chrome | View title / Preview request sends `ui/message`; origin card stays visible; no direct navigation tool call |
| Readable desktop, 390px mobile, dark theme and poster fallback | Overflow, low contrast, broken-image content | Visible titles/actions, document width, screenshots, intentional missing-poster fallback |
| Host data is validated and rendered as text | Malformed output renders a false receipt; data HTML executes | Invalid schema card, unsafe title text, no script execution or unsafe links/images |
| Action errors are explicit | Tool error produces success or enables a forbidden write | Scope/reconnect/invalid-preview fixtures, no acknowledgment or additional write |
| Exact title and TV seasons require fresh confirmation | Wrong seasons or expired preview is submitted | Preview text and exact `previewHandle`, `confirmed: true`, stable idempotency key |
| One user action produces one mutation | Rapid clicks issue duplicate requests or feedback | Held tool response and captured call count / arguments |
| Pending/uncertain request cannot be resent | Timeout or ambiguous receipt offers new create | Unknown outcome and manual verification; no second create or invented status tool. Preview expiry blocks new dispatch; an exact late receipt still confirms an already dispatched attempt |
| Stale responses cannot overwrite current content | Slow prior action acknowledges a new result | Hold response, deliver newer host data, release response; latest card unchanged |
| Feedback acknowledges only the matching recommendation session | UI fabricates success early or sends wrong session | Held feedback call, exact returned session ID and event identity, one acknowledgment; no unsupported undo |
| Lifecycle works with optional capabilities absent | UI depends on modal / host feature or leaks timers after teardown | Inline-only host, context notification and teardown/reload; fresh handshake, no automatic write |
| Credentials and unapproved endpoints never leave iframe | Arbitrary URLs/metadata appear in DOM, storage or network | Inject synthetic canaries/unsafe URLs; DOM/storage/captured calls/network check |

Existing repository tests exercise the main web application and server. They cannot detect this iframe SDK handshake, host capability handling, or same-card mutation behavior. This suite supplies that distinct boundary. It proves local MCP Apps/browser behavior only; it does not prove ChatGPT rendering, OAuth, provider deployment, live poster delivery, or real request execution.

Run from the repository root with the app's documented E2E command. Playwright writes a JSON report, per-test call trace attachments, and desktop/mobile/dark screenshots to a chosen absolute evidence directory outside the repository.

## Approved visual restoration

Written before the visual implementation and harness changes. The approved reference is `docs/design/chatgpt-app` with Chef, Hunt for the Wilderpeople, and Paddington 2. These are review fixtures, not the user's live catalog. Production artwork must use the agreed authenticated MCP projection; public review poster URLs must remain fixtures.

| Observable invariant | Credible failure | Browser proof |
| --- | --- | --- |
| Restore the approved poster grid at desktop width | Result remains a plain text list or images lose their intended proportions | Same three titles, metadata and reasons; three columns; 2:3 poster boxes; matching inner-width screenshots |
| Restore compact poster cards at 390px | Poster becomes full-width, clips metadata, or pushes actions off screen | Left poster width near 97px, readable text/actions, zero horizontal overflow; same-title screenshot |
| Restore richer title detail with source-supported content | Title detail omits artwork, synopsis, genres, director or match explanation | Chef fixture uses the approved source content; detail screenshot and visible independent content assertions |
| Artwork remains optional and bound to the returned item | Missing/broken image hides the title or arbitrary item's poster is shown | Intentional fallback; title/action remains usable; unrelated artwork rejected or omitted according to the agreed contract |
| Artwork is safe and bounded | URL credentials, unsafe schemes, oversized data or wrong MIME reaches image loading | Dangerous values never enter DOM/storage/calls; no unapproved network request; safe fallback or clear invalid-result state |
| Authenticated poster helper reaches UI through public tool result | Browser depends on direct origin credentials or a test-only production hook | Local helper/tool composition emits the final public artwork projection, SDK host delivers it, UI loads exact image and actions retain existing safety |
| Preserve action and lifecycle safety | Visual controls bypass confirmation, duplicate mutations, epoch checks or uncertainty locks | Retain the existing 44 functional cases; adapt selectors only when user-facing labels legitimately change |

Visual proof must identify exact title fixtures, host inner width, theme, bundle hash and image source. Compare the reference and bundle at the same widths. Keep screenshots, downloaded review assets if needed, and runtime receipts outside the repository. Local proof does not establish live ChatGPT rendering, real authentication, or poster delivery in a deployed provider.

The local handoff preview must also load the fixed review-search and review-detail fixture files without Playwright injecting a card. A missing generated file, arbitrary URL loading, a different catalog/artwork set, external browser request, or unsolicited tool call makes that handoff invalid.
