# Moodarr MCP on Cloudflare

This package hosts Moodarr's provider-independent MCP tools on Cloudflare Workers.
It connects to registered public HTTPS Moodarr APIs hosted by any provider.
See [the protocol and permission contract](../../docs/MCP.md).

## Local verification

Use Node 24 or later and npm. No container or cloud account is needed for local
verification.

```sh
npm ci --ignore-scripts
npm ci --ignore-scripts --prefix ../chatgpt-ui
npm run verify
npm audit
```

Verification builds the ChatGPT resource, typechecks the package, bundles the Worker without deploying it,
and runs the synthetic domain and Worker HTTP journeys. Runtime tests intercept
outbound fetches to fixture instances; they never call real Plex or Seerr.
Results do not prove live ChatGPT acceptance.

Deterministic lifecycle tests first reproduce the pinned OAuth library's unsafe
KV interleavings, then verify the adapter's atomic admission and revocation guard.
Those dependency controls explain why the additional guard remains necessary.

To also exercise the adapter against this checkout's actual Moodarr API and
SQLite repositories, install the root dependencies and run the compatibility
journey. It uses Moodarr's fixture mode for its external providers:

```sh
npm ci --ignore-scripts --prefix ../..
npm run test:api
```

The root Moodarr container excludes `apps/`; installing this adapter does not
change the web/server image. Its dependency lock is separate from the root lock.

## Configuration

| Setting or binding | Purpose |
| --- | --- |
| `PUBLIC_ORIGIN` | Exact canonical public HTTPS origin of this MCP service. Local development permits an explicit loopback HTTP origin. |
| `INSTANCE_REGISTRY` | JSON array of approved `{id, name, origin}` records. Use stable IDs and canonical public HTTPS origins. |
| `AUTH_SECRET` | At least 32 characters of cryptographically random secret material for browser state and request preview protection. Set as a Worker secret. |
| `OAUTH_KV` | Private KV namespace for the OAuth library's encrypted grant records. |
| `AUTH_TRANSACTIONS` | Durable Object binding for expiring browser authorization, atomic grant admission and revocation records. |
| `REQUEST_LIMITER` | Per-location request rate limit binding; use an unused namespace ID in your Cloudflare account. |

The committed configuration contains placeholders and fails closed for a public
deployment. Keep your actual account IDs, instance registry, domains, secrets
and operational receipts outside the repository. Use an ignored local Wrangler
configuration beside the sample when applying deployment-specific values.

Example registry using reserved documentation names:

```json
[
  {"id":"family","name":"Family Moodarr","origin":"https://moodarr.example"}
]
```

Each instance must enable Plex sign-in and administrator authentication. Ensure
its public origin returns the Moodarr API rather than a proxy login page. Review
its existing [network security guidance](../../SECURITY.md). Never register a
destination merely because an unauthenticated visitor supplied its URL.

For a local interactive run, use `.dev.vars` (ignored) to supply `AUTH_SECRET`
and the local configuration, then `npm run dev`. Do not put actual secrets in
shell arguments, command history, source files or test receipts.

## Deployment

1. Confirm the intended personal Cloudflare account with `npx wrangler whoami`.
   If the existing CLI login has expired, restore it with `npx wrangler login`.
2. Create a dedicated KV namespace for `OAUTH_KV`. Configure its ID, the exact
   public service origin, the instance registry and an unused rate limit
   namespace ID in your ignored deployment configuration.
3. Set `AUTH_SECRET` using Wrangler's interactive secret input. Keep the secret
   in your approved credential store; it is required across restarts.
4. Run the complete local verification against the candidate source. Inspect
   the dry-run output and intended account/name before deployment.
5. Deploy the dedicated Worker using your explicit configuration. Record the
   returned Worker version privately, then read back that exact deployment.
6. Verify `/health`, both OAuth discovery documents and an unauthenticated
   `/mcp` challenge. Health proves the Worker is configured, not that it can
   reach an instance or that ChatGPT can authenticate.

Do not reuse a homelab broker, its secrets, or its OAuth storage. Do not enable
Worker request logging that records authentication URLs, headers, cookies or
tool arguments. The sample disables observability; add sanitized telemetry
deliberately if needed.

The native rate limiter is approximate and local to each Cloudflare location.
It is not a global quota or a spending cap. Its per-address limits also mean
many users behind the same MCP client egress can share capacity.

## ChatGPT acceptance

Use the deployed public `/mcp` URL and OAuth with dynamic client registration.
Verify current ChatGPT connection instructions before setup. Complete consent,
Plex approval and the final identity confirmation. Start with a read grant.

Record evidence for a filtered search and title retrieval, two independent users,
reconnection after expiry/revocation, and denial of a write outside its scope.
Test real media writes only with explicit authority for the exact target.
Connecting a server, listing tools, a passing local test or a dry-run bundle
alone does not establish end-to-end ChatGPT acceptance.

## Official references

- [Cloudflare MCP handlers](https://developers.cloudflare.com/agents/model-context-protocol/apis/handler-api/)
- [Workers OAuth provider](https://github.com/cloudflare/workers-oauth-provider)
- [ChatGPT MCP authentication](https://developers.openai.com/plugins/build/auth)
- [MCP security guidance](https://modelcontextprotocol.io/docs/tutorials/security/security_best_practices)

Versions are pinned to the compatible SDK pair documented by Cloudflare:
Agents 0.24.0 with MCP server/client 2.0.0. Recheck the peer contract before
upgrading. MCP SDK 1.30.0 is retained to satisfy Agents' legacy compatibility
peer dependency; the server code uses SDK v2.
