<h1 align="center">Moodarr</h1>

<p align="center">
  <strong>A local-first Plex + Seerr companion for finding what to watch.</strong>
  <br/>
  Moodarr reads your Plex library and Seerr/Jellyseerr request state, ranks natural-language matches, and only creates requests after explicit confirmation.
  <br/>
  <br/>
  MoodRank turns fuzzy mood and feel language into an indexed recommendation layer for the arr stack: hybrid retrieval, deterministic scoring, and feedback learning over your Plex library and local catalog.
</p>

<p align="center">
  <a href="https://github.com/jremick/moodarr/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/jremick/moodarr/actions/workflows/ci.yml/badge.svg"/></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache_2.0-blue.svg"/></a>
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D24-brightgreen.svg"/>
  <a href="docs/README.md"><img alt="Docs" src="https://img.shields.io/badge/docs-available-orange.svg"/></a>
  <img alt="Status" src="https://img.shields.io/badge/status-early_beta-blue.svg"/>
</p>

> **Early public beta:** Moodarr's supported product surface is the web/server container for external self-hosted testing, not a stable v1 release. Install only versions listed on the GitHub Releases page; a version mentioned in source may not yet be published. Configuration, internal APIs, packaging, recommendation behavior, and admin flows may change between beta prereleases, with operator actions called out in release notes.

## What Moodarr Does

- React + Vite client.
- Fastify TypeScript API.
- Local SQLite cache.
- Persistent server-side config for container installs.
- Admin screen for connection settings, sync controls, and runtime status.
- Optional Plex sign-in for non-admin Finder access and local user visibility.
- Fixture mode for contributors without Plex or Seerr.
- Plex library/catalog reads plus an explicit signed-in-user Watchlist write.
- Seerr/Jellyseerr operational request-state reads plus explicit confirmed request creation.
- Optional missing-title discovery from a separately downloaded, checksum-pinned Wikidata CC0 catalog asset.
- Provisional server-side OpenAI brief parsing, embeddings, reranking, explanations, and refinement options for source/EXP development only; the official beta.1 image excludes provider endpoints and cannot enable this path.

## Current Status

The first beta version is `v0.1.0-beta.1`. The supported beta surface is the web/server container on Linux `amd64`, including Plex/local-catalog discovery, Seerr request-state sync, admin settings, request preview, explicit request creation, Docker Compose, and Unraid packaging. GitHub Releases is authoritative for whether that version is available.

Known limitations:

- Setup and configuration may still change between beta prereleases.
- The project is designed for LAN/VPN or trusted container-network deployment, not direct public internet exposure.
- Plex app deep links use Plex metadata keys and may still need compatibility checks across Plex clients.
- Protected beta Git tags, immutable GitHub prereleases, and workflow-append-only GHCR version tags with recorded image digests are the supported release channel.
- Plex-authenticated users receive user-scoped solo profiles; group context intentionally uses a shared instance profile. Admin can separately control each user's request capability.
- The official beta.1 image bakes in a non-overridable local-ranking policy, ignores provider environment/config values, and contains no OpenAI endpoint. Provisional provider code remains source/EXP-only for future evaluation.
- The official beta.1 image does not ingest Seerr/TMDB descriptive catalog content, call TMDB, or serve TMDB artwork. Seerr is an operational request integration; locally supplied TMDB IDs are used only as interoperability identifiers.
- Plex-only discovery works without the separate catalog asset. Missing-title discovery requires the pinned `wikidata-20260622-min5-v1` asset and its stopped, networkless full-snapshot import described in [Catalog Bootstrap](docs/CATALOG_BOOTSTRAP.md).
- Catalog-only request attempts remain `unavailable` with **Availability not checked**. Generic search and verified-requestable-only filters exclude them; an explicit request-attempt search may show them after verified requestable results, and Seerr may reject a confirmed attempt.
- The iOS client is experimental, has no supported public distribution, and does not block the web/server beta.

## Container Quick Start

Once `v0.1.0-beta.1` is listed on GitHub Releases, install its versioned image below and record the resolved immutable digest. Do not infer availability from this source reference alone.

```bash
bash <<'MOODARR_ENV_SETUP'
set -euo pipefail
umask 077
moodarr_env_dir="${XDG_CONFIG_HOME:-$HOME/.config}/moodarr"
moodarr_env="$moodarr_env_dir/container.env"
mkdir -p "$moodarr_env_dir"
chmod 700 "$moodarr_env_dir"
while :; do
  printf 'Moodarr admin token (32+ base64url-style characters): ' >/dev/tty
  IFS= read -r -s moodarr_admin_token </dev/tty
  printf '\n' >/dev/tty
  [[ "$moodarr_admin_token" =~ ^[A-Za-z0-9_-]{32,}$ ]] && break
  printf 'Use at least 32 random letters, numbers, underscores, or hyphens.\n' >/dev/tty
done
{
  printf '%s=%s\n' MOODARR_ADMIN_TOKEN "$moodarr_admin_token"
  printf '%s\n' MOODARR_ADMIN_AUTO_SESSION=false MOODARR_WEB_ORIGIN=http://127.0.0.1:4401
} > "$moodarr_env"
unset moodarr_admin_token
chmod 600 "$moodarr_env"
printf 'Private environment written to %s\n' "$moodarr_env"
MOODARR_ENV_SETUP

moodarr_env="${XDG_CONFIG_HOME:-$HOME/.config}/moodarr/container.env"
docker pull ghcr.io/jremick/moodarr:v0.1.0-beta.1
docker run --rm --init --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777 \
  --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=128 --memory=2g --memory-swap=2g --cpus=2 \
  -p 127.0.0.1:4401:4401 \
  -v moodarr-data:/data \
  --env-file "$moodarr_env" \
  ghcr.io/jremick/moodarr:v0.1.0-beta.1
```

The silent prompt is not recorded in shell history, and the token does not appear in the `docker run` arguments. Keep the generated environment file private, never commit or share it, and retain mode `0600`; Docker administrators can still inspect a running container's environment. Rotate the token if that file or Docker access is exposed.

Open `http://127.0.0.1:4401`, authenticate in the Admin Access control with the admin token, then configure Plex and Seerr. API clients can send the token with `X-Moodarr-Admin-Token` or `Authorization: Bearer`. See [docs/UNRAID.md](docs/UNRAID.md) for Unraid notes and the template in [unraid/moodarr.xml](unraid/moodarr.xml). A fresh Unraid install must complete the documented UID/GID `999:999` Appdata preparation before selecting **Apply**; letting Docker Manager create that path causes the non-root container to fail closed.

The command above is intentionally reachable only from the Docker host. For trusted-LAN access, publish `4401:4401` and recreate the private environment file with `MOODARR_WEB_ORIGIN` set to the exact origin those browsers use, such as `http://192.0.2.10:4401`. Keep that value aligned with the browser address; do not leave the loopback origin while accessing Moodarr through a LAN hostname or address. Moodarr is not intended for direct public-internet exposure.

`MOODARR_ADMIN_AUTO_SESSION=true` is an explicit trusted-LAN convenience mode: any visitor who can load the bundled UI can receive admin access. It is not compatible with meaningful Plex-user/admin separation and must stay off when untrusted LAN clients or non-admin Plex users can reach Moodarr.

Moodarr is intended to run as a container where it can reach your Plex and Seerr/Jellyseerr services. For most home media setups, that means running it on the same LAN, VPN, or trusted container network rather than exposing media-server APIs to a public host.

### Optional missing-title catalog

Plex-only operation is fully supported and needs no catalog download. To discover titles absent from Plex, use the separate beta.1 release asset `moodarr-wikidata-20260622-min5-v1.jsonl.gz`. Its required SHA-256 is `dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a`; it contains 90,397 importable Wikidata records, of which 82,865 can support an explicitly disclosed Seerr request attempt. The eligible split is 70,841 movies and 12,024 TV series. Thirty-six groups share a strong importer identifier across 72 source records, including 59 that otherwise meet attempt requirements—10 movies and 49 TV series. Their ambiguous catalog materializations remain imported and indexed for provenance and diagnostics but cannot independently surface in Finder or authorize request preview or creation. An independently identified available Plex item remains visible if later linked to one of those records, but the catalog ambiguity still blocks every request action. The asset is CC0 structured data and contains no poster artwork.

Do not import it while Moodarr is running. Reserve a 30–60 minute maintenance window and at least 4 GiB free on the appdata filesystem beyond backup capacity. [Catalog Bootstrap](docs/CATALOG_BOOTSTRAP.md) provides checksum verification, the stopped `--network none` full-snapshot command, measured resource context, rollback guidance, and the post-import search-isolation checks.

## Contributor Quick Start

Prerequisites: Node.js 24 or newer.

```bash
node --version # requires Node 24+
npm ci
cp .env.example .env
npm run dev
```

Open the Vite URL printed by the dev server. Fixture mode is enabled by default, so the app works without private media servers.

## Configuration

Set these values in `.env` for real integrations:

- `MOODARR_ADMIN_TOKEN`
- `MOODARR_ADMIN_AUTO_SESSION=false` for explicit admin authentication; enable only on a fully trusted network where every visitor is an administrator.
- `MOODARR_WEB_ORIGIN` set to the exact origin browsers use, such as `http://192.0.2.10:4401` on a LAN or the public `https://` origin behind a reverse proxy. The example Compose file requires this value so Plex callback validation and cookie security do not silently use the wrong host.
- `PLEX_BASE_URL`
- `PLEX_TOKEN`
- `SEERR_BASE_URL`
- `SEERR_API_KEY`
- `MOODARR_PLEX_AUTH_ENABLED=true` to let Plex users access Finder routes without the admin token.
- `MOODARR_PLEX_AUTH_ALLOW_NEW_USERS=true` to create pending local users on first Plex sign-in when the account has access to the configured server. New users can browse deterministically, but request and Watchlist-write capabilities stay off until an admin enables them.

The OpenAI settings below exist only for direct source/EXP development and a possible future release-cleared provider path. The official beta.1 image ignores them and its Admin UI cannot enable a provider.

- `AI_PROVIDER=openai`
- `OPENAI_API_KEY`
- `OPENAI_MODEL` defaults to `gpt-5.5`
- `OPENAI_EMBEDDING_MODEL` defaults to `text-embedding-3-large`
- `OPENAI_REASONING_EFFORT` defaults to `low` for `gpt-5.5`

Integration and admin tokens are read by the backend only. They are not returned by API routes, embedded in the client bundle, placed in poster URLs, or logged without redaction. Native clients can explicitly request a separate non-admin Moodarr session token as described below.

Optional Plex Watchlist actions store the signed-in user's Plex access token server-side so Moodarr can call Plex Discover on that user's behalf. That token stays in the private SQLite database and is not returned to clients.

Container installs can also save integration settings through the Admin screen. They are written to `MOODARR_CONFIG_PATH`, which defaults to `/data/config.json` in the Docker image. Environment variables still take precedence on restart.

When admin auth is enabled, private catalog reads, search, poster proxying, request previews, and request creation require either the admin token/session or a Plex user session when Plex sign-in is enabled. Admin writes, diagnostics, sync controls, and user management still require the admin token/session. Keep Moodarr LAN/VPN-only unless another authentication layer protects it.

Native clients can request a user-session token during Plex auth completion by sending `nativeSession: true` to `POST /api/auth/plex/complete`. The response includes a non-admin `sessionToken` and `sessionExpiresAt`; native clients should store that token in the platform secure store and send it as `Authorization: Bearer <sessionToken>` for Finder routes. That token does not grant admin access.

Plex sign-in challenges are stored in the private SQLite database until their short expiry, so an in-progress sign-in can survive a Moodarr process restart. Successful completion consumes the challenge once in the same database transaction that stores the user and session.

Search responses include `sessionId` when recommendation-run logging succeeds. Native clients should include that id on `POST /api/feel-feedback` so swipes and pairwise choices attach to the displayed slate. Mobile retry queues should also send a unique `clientEventId`; duplicate retries return the original feedback event instead of applying learning twice.

### Local-first and provisional AI

Moodarr stores its database, configuration, telemetry, and profiles locally. The official beta.1 image performs recommendation processing locally, cannot contact OpenAI, and has no direct TMDB network path. Direct source/EXP development can build the provisional OpenAI provider path, which sends the bounded inputs documented in [Data And Privacy](docs/DATA_AND_PRIVACY.md); that path is outside the beta.1 product and support contract.

## API

- `GET /api/health`
- `GET /api/config/status`
- `GET /api/admin/session`
- `POST /api/admin/session`
- `DELETE /api/admin/session`
- `GET /api/auth/session`
- `POST /api/auth/plex/start`
- `POST /api/auth/plex/complete`
- `POST /api/auth/logout`
- `POST /api/plex/test`
- `POST /api/plex/watchlist`
- `POST /api/seerr/test`
- `POST /api/library/sync`
- `POST /api/seerr/sync`
- `GET /api/library/stats`
- `GET /api/admin/catalog/evidence`
- `POST /api/search`
- `GET /api/review-queue`
- `PUT /api/review-queue/:id`
- `POST /api/feel-feedback`
- `GET /api/items/:id`
- `GET /api/items/:id/poster`
- `POST /api/requests/preview`
- `POST /api/requests/create`
- `GET /api/admin/settings`
- `PUT /api/admin/settings`
- `GET /api/admin/users`
- `PATCH /api/admin/users/:id`
- `GET /api/admin/sync/status`
- `POST /api/admin/sync/run`
- `POST /api/admin/embeddings/warmup`
- `GET /api/admin/recommendations/diagnostics`
- `GET /api/admin/feel-profiles`
- `GET /api/admin/feel-profiles/export`
- `DELETE /api/admin/feel-profiles`
- `POST /api/admin/feel-profiles/rollback`
- `GET /api/admin/support-bundle`

Sync POST routes accept work asynchronously. A successful request returns `202 Accepted`; poll `GET /api/admin/sync/status` until `running` is false and inspect `lastResult`. A concurrent request returns `409` and is not queued, so scripts must not start the Seerr phase until an earlier library-only phase has completed.

Admin Feel Profile operations accept an optional `authUserId` for a named user's `solo` profile: use `GET /api/admin/feel-profiles?watchContext=solo&authUserId=<id>`, `GET /api/admin/feel-profiles/export?authUserId=<id>`, or include `authUserId` with `watchContext: "solo"` in reset and rollback bodies. Group profiles remain shared and reject user scoping. User ids and non-secret display labels come from `GET /api/admin/users`.

Request creation is persisted as an idempotent operation. Pending or uncertain operations serialize the shared Seerr side effect globally for that media item, even when different Moodarr users submit it. If Moodarr restarts or loses the response after a possible Seerr acceptance, the same confirmed attempt first refreshes Seerr request state. A confirmed upstream request is recovered locally; an unconfirmed outcome becomes `uncertain` and returns an explicit conflict instead of silently resending the external request. If Seerr later reports the request as declined, a fresh preview receives a new confirmation generation and can create one new operation without replaying the prior success.

## Verification

```bash
npm run verify
```

The verification suite runs a tracked-content credential scan, linting, typechecking, server/web unit and API tests, a production client build, and a configured-secret leak scan against generated client assets.

For release packaging work, run:

```bash
npm run verify:release
```

That adds recommendation evals, Compose/Unraid packaging checks, and a Docker smoke test.

Mood/Feel algorithm work also has focused evals:

```bash
npm run eval:recommendations
npm run eval:profile-replay
npm run eval:profile-journeys
```

Optional local-only external seed validation, when you have an ignored MovieLens dataset directory:

```bash
npm run validate:movielens-tag-genome -- --dir /path/to/ml-25m --threshold 0.7
```

## Documentation

- [Beta release criteria](docs/BETA_RELEASE_CRITERIA.md) - measurable blockers and evidence required before publishing.
- [Release readiness](docs/RELEASE.md) - local and CI gates for beta packaging.
- [Compatibility](docs/COMPATIBILITY.md) - supported deployment, browser, integration, storage, and API boundaries.
- [Upgrading](docs/UPGRADING.md) - supported upgrade origins, validation, and backup-based rollback.
- [Unraid deployment](docs/UNRAID.md) - container defaults and Unraid template notes.
- [Catalog bootstrap](docs/CATALOG_BOOTSTRAP.md) - optional pinned Wikidata asset, networkless import, and request-attempt boundaries.
- [Production plan](docs/PRODUCTION_PLAN.md) - production architecture, security rules, and longer-term hardening backlog.
- [Data and privacy](docs/DATA_AND_PRIVACY.md) - local storage, beta.1's provider exclusion, provisional source/EXP processing, retention, and multi-user boundaries.
- [Backup and recovery](docs/BACKUP_AND_RECOVERY.md) - consistent data-volume backup, restore testing, and rollback.
- [Recommendation engine](docs/RECOMMENDATION_ENGINE.md) - ranking and retrieval behavior.
- [MoodRank current algorithms](docs/MOODRANK_CURRENT_ALGORITHMS.md) - living map of stages, feedback, and eval metrics.
- [Mood/Feel profile goal](docs/MOOD_FEEL_PROFILE_RESEARCH_GOAL.md) - public research-backed product direction.
- [Mood/Feel robustness V2](docs/MOOD_FEEL_ROBUSTNESS_V2_GOAL.md) - synthetic journey, drift, rollback, and external seed hardening.
- [Mood/Feel controlled usage](docs/MOOD_FEEL_CONTROLLED_USAGE_GOAL.md) - first real-signal readiness loop before mobile collection.
- [Mood feature index](docs/MOOD_FEATURE_INDEX.md) - local mood taxonomy and feature mapping.
- [Seerr auth alignment](docs/research/2026-06-18-seerr-auth-alignment.md) - Plex user-management alignment notes.

## Community and Support

- [Issues](https://github.com/jremick/moodarr/issues) - bugs and concrete feature requests.
- [Support](SUPPORT.md) - supported beta scope, useful bug reports, and best-effort boundaries.
- [Contributing](CONTRIBUTING.md) - local development, verification, and safety expectations.
- [Security policy](SECURITY.md) - private vulnerability reporting and deployment boundaries.

## Request Safety

`POST /api/requests/preview` returns the exact media type, locally supplied TMDB interoperability ID, local title, TV seasons, and confirmation token that would be used for a Seerr request attempt. The non-secret token also binds the preview to the latest successful operation for that item, so a fresh preview after a declined request cannot replay an older cached success. Preview does not fetch TMDB/Seerr descriptive metadata or guarantee that Seerr will accept the request. `POST /api/requests/create` requires `confirmed: true`, the previewed media type and TMDB ID, and the preview confirmation phrase and token; a stale preview fails closed if that identity changes. Search and AI output cannot create a request directly.

## Fixture Mode

Fixture mode seeds a small project-owned synthetic catalog with Plex and Seerr request-state examples. It is intended for local development and CI without private server access and does not expand the official beta's external-content boundary.

## License

Moodarr is licensed under the [Apache License 2.0](LICENSE). See [Third-Party Notices](THIRD_PARTY_NOTICES.md) for interoperability marks and the exclusion of third-party artwork from the project license.
