# Moodarr ChatGPT UI

An MCP Apps component for Moodarr. It renders the structured results of the Moodarr MCP tools and sends explicit actions through the host. The production component contains no fixture results, credentials, direct API connection, or OAuth flow.

This package is separate from the main web client. Its visual system is `docs/design/opus-design-system.html`, and its approved component layout is `docs/design/chatgpt-app/`. Search preserves the prototype's three-column poster grid and compact poster cards on mobile. Title details preserve the poster, synopsis, and “Why it fits” hierarchy.

## Build and verify

Use Node 24 or later and npm:

```sh
cd apps/chatgpt-ui
npm ci --ignore-scripts
```

The browser suite uses locally installed Google Chrome. Its test host and synthetic data live only in `tests/`. The production bundle excludes them. See `tests/FAILURE_CASES.md` for the failure cases and evidence boundary.

Visual comparisons also need the approved mockup on loopback port 4178. Start it in another terminal if it is not already running, from this package directory:

```sh
python3 -m http.server 4178 --bind 127.0.0.1 --directory ../../docs/design/chatgpt-app
```

Keep port 4188 free for the browser runner. The visual fixtures download the three pinned review posters to a temporary cache and use macOS `sips` to create bounded images. Set `MOODARR_UI_POSTER_CACHE_DIR` to reuse a prepared cache, including its `*.fixture.jpg` files. No poster binary enters the production bundle or source repository.

Then run `npm run verify`.

Set `MOODARR_UI_EVIDENCE_DIR` to an absolute directory outside this repository to keep the JSON report, HTML report, sanitized host-call traces, and screenshots. Without an override, the suite uses `moodarr-chatgpt-ui-e2e` inside the system temporary directory. The report includes the tested bundle's SHA-256.

After the visual suite prepares the fixtures, `npm run dev` serves the component and test host on loopback port 4188. Open `/tests/host.html?scenario=review-search` for the three-poster comparison view, or `?scenario=review-detail` for the title card. Both are clearly marked as synthetic previews. Opening `/` outside an MCP Apps host displays the unavailable state.

The poster browser journey can consume an actual backend integration result through `MOODARR_UI_CONTRACT_RESULT`, pointing to a saved `{ tool, args, result }` JSON artifact with synthetic data. Without that override, it uses the packaged poster helper with local SDK fixtures. The evidence receipt identifies which boundary was tested.

The build produces:

- `dist/index.html`: all component JavaScript and CSS in one HTML resource.
- `dist/manifest.json`: SHA-256, byte size, versioned resource URI, resource policy, and tool metadata.
- `dist/resource.mjs` and `dist/resource.d.mts`: the resource and a registration helper for the MCP server.
- `dist/poster-enrichment.mjs` and its declarations: an optional server helper that adds authenticated poster bytes to component-only tool metadata.

Build output is ignored by Git. Build it in the server's packaging step and deploy the resource and tool metadata together. A changed bundle receives a new resource URI.

## Server integration

The MCP adapter in `../mcp-cloudflare` registers the built resource and associates the three primary tools with it. Its build includes this package. Building the component does not deploy the adapter.

```ts
import { registerMoodarrUiResource, moodarrUiToolMeta } from '../chatgpt-ui/dist/resource.mjs';

const server = new McpServer({ name: 'moodarr', version: '0.1.0' });
registerMoodarrUiResource(server);

// Merge into each existing registerTool configuration. Keep the existing
// schemas, OAuth securitySchemes, annotations, and handler unchanged.
server.registerTool(name, {
  ...existingConfig,
  _meta: {
    ...existingConfig._meta,
    ...moodarrUiToolMeta[name],
  },
}, existingHandler);
```

The relative import depends on the server entry point. The helper uses the server's standard `registerResource` method and needs no filesystem or Node APIs at runtime. Preserve any existing nested `ui` metadata when merging if the server gains additional UI settings.

`moodarr_search`, `moodarr_get_item`, and `moodarr_preview_request` attach the HTML resource. Feedback, request creation, Watchlist, and statistics remain callable through the app with the same server authorization. Resource metadata declares no external connections, assets, or nested frames. Images and fonts are not fetched from third parties.

Use a publicly reachable HTTPS MCP endpoint with its existing OAuth configuration. This UI does not depend on a hosting provider. ChatGPT owns connection and approval; the UI never asks for an instance credential or token.

## Poster integration

The MCP adapter already constructs `createPosterEnricher(client.connection, options.fetch)` once per server and calls it after the existing authorization and tool handler. `server/integration.patch` and `server/integration-baseline.json` retain the original integration handoff for reference; do not reapply the patch. Preserve the authorization order when changing the integration.

The helper enriches successful search, item, and request-preview results. It requests only the known catalog IDs at the registered Moodarr origin's `/api/items/:id/poster` route, using the existing native user session. It does not use an item's `posterUrl`, introduce public image URLs, or change the model-visible tool body. Images are carried in `_meta['moodarr/posters']`:

```ts
{ version: 1, items: [{ itemId, mimeType, data /* canonical base64 */ }] }
```

Delivery is limited to the first three search items or the one detail/preview item, 256 KiB per image, 768 KiB total, and one three-second deadline. The helper accepts bounded JPEG, PNG, and WebP images. SVG fallbacks, redirects, malformed images, failed reads, and oversized bodies omit artwork. It never retries or caches a fetch. The component validates the metadata again and attaches artwork only to matching returned item IDs.

The native poster route currently returns a fallback for some catalog sources. Those items retain a visible poster placeholder. The widget makes no direct network request for images, and its resource policy needs no external image domains. The local host checks inline images under a representative MCP sandbox policy; real ChatGPT rendering remains an activation check.

## Interaction contract

Search shows poster cards. View-title and preview actions send a user message through the host to request a separate tool card. They keep the originating card in place. Hosts without message support receive a visible manual follow-up instruction.

Feedback uses the returned recommendation session and explicit watch context. Search cards retain subordinate feedback controls because the separate item tool does not return that session. The component does not provide unsupported undo or replacement. A Watchlist acknowledgment requires a valid matching tool result. Request confirmation displays the exact title and seasons from a fresh preview, then submits the opaque preview handle once. Missing artwork retains a poster frame with a clear fallback. No season inventory or artwork is invented when the server omits it.

Tool input and result data pass through the schemas in `src/contracts.ts`. Malformed data, unsupported payloads, mismatched targets, stale actions, and uncertain writes cannot produce a success acknowledgment. The request idempotency key is derived from the opaque preview handle; the handle is never decoded, rendered, stored, or added to model context by this UI. Uncertain outcomes require manual verification because the current backend provides no request-status lookup tool.

The bridge uses the official `@modelcontextprotocol/ext-apps` SDK. It waits for host initialization and delayed tool input, including approval-gated tools. Optional host capabilities are checked before use. The implementation does not clone ChatGPT headers, composers, account controls, or modal chrome.

## Acceptance boundary

Local browser checks prove the bundled component can initialize and interact with an SDK host using synthetic tool results. They do not establish a real ChatGPT connection, OAuth approval, deployment, or media request.

Activation requires the backend owner to consume the generated resource and metadata, then verify `resources/list`, `resources/read`, and `tools/list` on the deployed MCP server. A final ChatGPT developer-mode check must confirm the real host's initialization, rendering, approvals, and tool-card navigation with an authorized account. Keep deployment details and runtime receipts outside this repository.

The poster enrichment helper must be integrated with the MCP backend before live tool results include artwork. The current backend still provides no Plex playback links, available TV-season inventory, profile management tool, or request-status recovery. Those are separate backend capabilities, not simulated UI features.

## References

- [OpenAI: Build your ChatGPT UI](https://developers.openai.com/plugins/build/chatgpt-ui)
- [OpenAI: UI guidelines](https://developers.openai.com/plugins/concepts/ui-guidelines)
- [MCP Apps SDK](https://apps.extensions.modelcontextprotocol.io/)
