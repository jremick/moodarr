# Poster transport failure inventory

Written before implementation. These checks apply to the optional server enrichment and the UI decoder.

- Preserve the successful tool body when a poster is absent, an SVG fallback, unsupported MIME, malformed or truncated raster, oversized, or outside the pixel limits.
- Fetch only the first three exact known item IDs from a successful search, or the one exact detail/preview item. Never consume an item URL or accept another item in metadata.
- Use the existing native user session for fixed registered-origin poster routes. Reject invalid/expired connections, redirects, redirected responses, and response URLs outside that exact route and origin.
- Keep native/provider credentials, image bytes, and image URLs out of model-visible text and structured content. Enrichment changes only the component-only metadata key.
- Enforce 256 KiB per raster, three images and 768 KiB raw total, including streamed responses with missing, false or oversized Content-Length.
- Use one three-second deadline for the complete enrichment, including header fetch and body reads. A hanging fetch or stream must settle to artwork absence. Never retry, cache, or follow a redirect.
- Accept only JPEG, PNG and WebP with matching magic bytes, valid bounded structure and dimensions of 1–4096 per axis and no more than 12 million pixels. Reject SVG, animated containers, malformed base64 and MIME mismatches.
- In the UI, malformed metadata, unknown/duplicate item IDs, extra poster fields, oversized data, or decode failure must preserve the 2:3 ticket fallback and the truthful title/actions.
- Component metadata may contain only version, exact item ID, MIME and canonical base64 bytes. Never decode or derive authentication from metadata.
- The real MCP integration check must run the patched backend snapshot with synthetic authenticated API responses and prove unchanged model-visible body, correct metadata association and safe failure behavior. Browser fixtures prove rendering only.

Live backend integration, deployment and real poster availability remain separate evidence layers.
