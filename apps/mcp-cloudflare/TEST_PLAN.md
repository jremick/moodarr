# MCP acceptance and failure cases

Record these cases before implementation. Exercise the HTTP/OAuth/MCP boundaries
with synthetic users and instances; never send a real media request as a test.

1. Two users connect to two registered HTTPS instances with the same upstream
   user ID. Searches, preferences, preview tokens and requests remain separate.
   Tool arguments cannot supply a destination or a credential.
2. OAuth discovery, dynamic registration and S256 authorization-code exchange
   produce a token bound to this resource and the selected scopes. Wrong resource,
   missing/wrong PKCE, reused code, stale transaction, cross-browser CSRF and
   unregistered redirects fail before a Moodarr call. Concurrent exchanges cannot
   mint two credentials from one code. A refresh racing with completed revocation
   cannot restore access, even when KV returns an older grant or token record.
3. Sign-in preserves Moodarr's server-issued challenge cookie and uses its native
   non-admin session. No administrator, Plex or service credential is requested.
   Denial, pending Plex approval, expiry and disabled users do not become success.
4. Search returns structured results and session identifiers. Explicit feedback
   retains clientEventId and the recommendation session. Search does not silently
   replay feedback. Invalid schemas and missing scopes make no upstream call.
5. A TV request with selected seasons must preserve the exact preview identity,
   phrase and token. Blocked previews and unknown write outcomes stay distinct.
   No automatic retry may duplicate a media request or Watchlist action.
6. Requests to unknown origins, private/IP addresses, traversal paths, redirect
   destinations, overlarge bodies and stalled responses fail safely. Errors and
   results never leak upstream tokens, cookies or raw diagnostic objects.
7. Worker runtime tests verify real discovery, OAuth, MCP initialize/list/call,
   refresh and revocation. Portable domain journeys separately exercise their
   adapter boundary, including malformed upstream JSON and HTTP error bodies.
8. Save a repeatable machine-readable test receipt. A local receipt or deployment
   dry run does not prove a live Cloudflare deployment or ChatGPT acceptance.

The root application already covers its native authentication and media request
contracts. New tests cover the MCP authorization/transport and cross-instance
boundaries those tests cannot exercise. No test-only public authentication bypass
or production flag is permitted.
