# Moodarr MCP

Moodarr's MCP adapter exposes its user workflows to ChatGPT and other MCP clients.
The initial hosting adapter runs on Cloudflare Workers. The connection and tool
contracts use HTTPS, OAuth and MCP; a Moodarr instance can run with any provider.

This is an unreleased implementation. Local checks, a successful deployment and
acceptance inside ChatGPT are separate verification steps. The adapter packages
the interactive component from `apps/chatgpt-ui` for search, title details and
request previews. Its resource and tool metadata are deployed together.

## Connection boundary

The path is: MCP client → OAuth-protected MCP service → the user's public HTTPS
Moodarr API → the instance's existing Plex and Seerr integrations.

The MCP service does not connect directly to Plex Media Server or Seerr. The
instance needs Plex sign-in enabled and configured administrator authentication.
Users authenticate through Plex, and Moodarr verifies their server access. The
adapter obtains a separate non-admin Moodarr session for each connection.
Administrator tokens, Plex tokens and Seerr keys are never requested from users.

The current broker accepts **operator-registered instance origins**. A user can
select a registered instance or supply its matching public origin. Arbitrary URL
enrollment is not supported: URL syntax validation alone cannot prevent server
side request forgery through DNS aliases or rebinding. Register an origin only
after verifying its operator, destination and HTTPS access boundary. Registration
does not grant access to its catalog; the user must still authenticate.

The public origin can use any host, reverse proxy or tunnel provider. A private
LAN address, localhost, a Cloudflare Access login page or another interactive
proxy login is not an API endpoint the broker can use. Reachability and
authentication errors must be shown as failures, never as an empty library.

Other hosting implementations can use the portable modules under
`apps/mcp-cloudflare/src/{types,schemas,moodarr,tools}.ts` with an OAuth provider
that produces the same verified connection context. These modules do not require
a Cloudflare account. The provided authentication/storage adapter itself uses
Cloudflare bindings; a second hosting adapter is not included.

## Authentication and permissions

The client uses `/mcp`, OAuth protected-resource discovery, dynamic client
registration, and authorization-code flow with S256 PKCE. The service pins its
issuer and protected resource to `PUBLIC_ORIGIN`. Client ID Metadata Documents
are disabled in this first implementation; use dynamic registration.

Consent identifies the client, callback destination, instance and requested
permissions. Plex opens in a separate tab. The user returns to the consent page
and chooses Continue after approving Plex access. Moodarr's existing callback
policy does not allow a broker callback, so the adapter does not promise an
automatic return from Plex.

| Scope | Permission |
| --- | --- |
| `moodarr:read` | Search, title details and library statistics |
| `moodarr:feedback` | Record explicit recommendation feedback |
| `moodarr:requests` | Preview a request and submit it after explicit confirmation |
| `moodarr:watchlist` | Add an eligible title to the signed-in user's Plex Watchlist |

Scopes are checked by the MCP adapter. Moodarr also applies the user's current
permissions on every request. The existing downstream native session is broader
than these MCP scopes; keep the broker credential store private. This adapter does
not add app scopes to Moodarr's native session API.

Broker access tokens last 15 minutes. Refresh grants have a fixed maximum of 30
days and cannot extend the Moodarr session's expiry. Moodarr currently provides
no native session refresh endpoint. An expired, revoked or disabled user session
requires sign-in again. Removing an instance from the registry invalidates its
broker access. Revoking a refresh token invalidates its broker grant; revoking an
access token invalidates that token. Neither action revokes other Moodarr sessions.

The Cloudflare adapter uses atomic grant admission and durable revocation records
alongside the OAuth library. These records contain token hashes and client IDs,
not token values. They prevent concurrent code reuse and prevent a refresh from
restoring a revoked grant. Competing refresh or revocation requests receive `429`
with `Retry-After`; uncertain token-storage failures require a new connection.

## Tool contract

Tools accept domain arguments. They never accept a destination URL, user ID or
credential. Every call uses the connection selected during OAuth. Tool responses
contain structured domain data for an interactive plugin; untrusted title and
description text remains data, not instructions to the model.

The component receives bounded authenticated poster bytes in tool-result `_meta`.
They are not included in model-visible content, and the component makes no direct
request to the Moodarr API or a third-party image host. Missing, unsupported or
oversized artwork retains a placeholder. See the [component contract](../apps/chatgpt-ui/README.md).

| Tool | Behavior |
| --- | --- |
| `moodarr_search` | Search with mood, filters and viewing context. Returns the actual ranking state and recommendation session. |
| `moodarr_get_item` | Fetch one title from the connected catalog. |
| `moodarr_library_stats` | Read library statistics. |
| `moodarr_record_feedback` | Record an explicit preference with its displayed recommendation session and retry identifier. |
| `moodarr_preview_request` | Return eligibility, the exact title and seasons, and a signed preview handle. |
| `moodarr_create_request` | Submit an explicitly confirmed preview with a stable idempotency key. |
| `moodarr_add_to_watchlist` | Perform the user's explicit Watchlist action. |

Search omits feedback context so a refinement cannot learn the same preference
twice. Search and preview can still write recommendation/audit records upstream;
they do not submit media requests. The current Moodarr feedback API classifies
this adapter under its existing `web` channel; `metadata.surface` identifies it as
`moodarr-mcp`. This preserves compatibility without a database migration or a
false claim that the server has a native `mcp` source type.

Preview handles bind the target, seasons, confirmation data and expiration to
the connected instance and session. A handle is not permission to download
anything: the create tool still requires explicit user confirmation and Moodarr
rechecks permissions and current catalog identity. A preview is an attempt,
not verified Seerr availability. Uncertain write outcomes preserve their status
and retry identity; the adapter never automatically resubmits a write.

## Develop and deploy

See [the Worker package](../apps/mcp-cloudflare/README.md) for reproducible checks,
configuration, deployment and ChatGPT acceptance steps.
