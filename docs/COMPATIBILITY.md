# Compatibility

This document defines the compatibility contract for published Moodarr `v0.1.0-beta` releases. The GitHub Releases page is authoritative for whether a beta is available; source references to an unpublished version do not activate this contract.

`Supported` means release-blocking defects can be reported against that configuration. `Best effort` means it may work but is not part of the release gate. `Experimental` means behavior and compatibility may change without a migration promise.

## Deployment Matrix

| Surface | Beta status | Contract |
| --- | --- | --- |
| Official container image | Supported | Linux `amd64` image published from the tagged commit. Other architectures are not published for beta. |
| Docker Engine | Supported | A current stable Docker Engine on Linux `amd64`, using the documented single-container configuration. The exact version used for each release is recorded in its release evidence. |
| Docker Compose | Supported | Docker Compose v2 with `docker-compose.example.yml`. Compose v1 is not supported. |
| Unraid | Supported | Unraid Docker Manager using the checked-in template. The exact Unraid version used for release validation is recorded with the release. |
| Source development | Supported for contributors | Node.js 24 or newer and `npm ci`, as declared by `package.json`. Native source deployment is not a beta production target. |
| macOS or Windows host deployment | Best effort | Development and Docker Desktop may work, but the released server target is Linux `amd64`. Windows containers are not supported. |
| Moodarr iOS app | Experimental | Native-client work does not block the web/server beta and is not included in the beta compatibility promise. |

The example container budget is two CPUs, 2 GiB memory, no additional swap, 128 processes, and a 512 MiB `/tmp` tmpfs. The no-additional-swap boundary requires either working Docker/cgroup swap-limit enforcement or a host with zero usable swap. A host that exposes swap while Docker reports `No swap limit support` is outside the beta resource envelope. These values are supported defaults, not a guaranteed minimum for every catalog size. Record material resource changes when reporting a problem.

## Browser Matrix

The beta web app supports the current stable desktop releases of:

- Chrome;
- Microsoft Edge;
- Firefox; and
- Safari on macOS.

The release candidate must complete its browser and accessibility smoke matrix against the exact recorded current-stable versions. Immediately previous major releases are best effort rather than release-blocking. Browsers on iOS and other mobile platforms, embedded webviews, and older desktop releases are also best effort for beta. The native Moodarr iOS app remains experimental under the deployment matrix above and does not expand the web compatibility promise.

## Integration Matrix

| Integration | Beta status | Contract |
| --- | --- | --- |
| Plex Media Server | Supported | Library sync, Plex sign-in, poster proxying, Plex links, and signed-in-user Watchlist actions are tested against the current stable Plex release used by the release candidate. Record that exact version. |
| Seerr or Jellyseerr | Supported | Operational request-state sync and explicitly confirmed request creation are tested against the current stable release used by the release candidate. Moodarr does not use Seerr as a descriptive discovery catalog or claim an unverified catalog title is requestable. Record the product and exact version. |
| Other Seerr-compatible servers | Best effort | API-compatible deployments may work, but untested variants do not expand the beta support contract. |
| Beta.1 Wikidata catalog asset | Supported and optional | Plex-only operation works without the asset. Missing-title discovery uses only `wikidata-20260622-min5-v1`, SHA-256 `dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a`, imported through the stopped networkless full-snapshot procedure in [Catalog Bootstrap](CATALOG_BOOTSTRAP.md). Regenerated or newer datasets are best effort. |
| Local recommendation processing | Supported | The official beta.1 image bakes in non-overridable provider policy `none`; no provider credential or provider network access is part of the release path. |
| TMDB descriptive content and artwork | Excluded in beta.1 | The official image has no direct TMDB network path, rejects TMDB artwork, discards Seerr/TMDB descriptive fields, and retains locally supplied TMDB IDs only as interoperability identifiers for Seerr requests. |
| OpenAI | Unsupported in beta.1 | The official image excludes the provider endpoint and cannot enable it. Provisional direct-source and explicitly configurable EXP testing does not expand the beta compatibility contract. |
| Other AI providers or OpenAI-compatible endpoints | Unsupported | No compatibility promise is made unless a provider is explicitly documented. |
| Fixture mode | Supported for evaluation | Fixture mode is part of development, CI, and first-look testing. It is not evidence that a real Plex/Seerr deployment has been validated. |

Third-party services do not publish perfectly synchronized compatibility contracts. Each Moodarr release therefore records the exact Plex and Seerr/Jellyseerr versions used for its integration evidence instead of implying support for every historical version. Third-party content and service terms remain separate from Moodarr's Apache License 2.0 and must be rechecked for each release.

The optional catalog asset contains 90,397 importable CC0 Wikidata records. Of those, 82,865 meet beta.1's ambiguity-safe local request-attempt prerequisites: 70,841 movies and 12,024 TV series. Thirty-six groups share a strong importer identifier across 72 source records. Fifty-nine of those records—10 movies and 49 TV series—otherwise meet attempt requirements; their ambiguous catalog materializations remain imported and indexed for provenance and diagnostics but cannot independently surface in Finder or authorize request preview or creation. An independently identified available Plex item remains Finder-visible if linked later, while ambiguity still blocks every request action. This is catalog coverage, not verified Seerr availability. Unambiguous eligible catalog-only rows remain `unavailable`; ordinary generic search and verified-requestable-only filters exclude them. A narrowly explicit request-attempt search may include an eligible row with **Availability not checked**, and Seerr may reject the confirmed attempt.

## Storage And Process Model

- `/data` is the durable application boundary and must be writable, private, and backed up as a complete unit.
- A local Docker volume or host-local POSIX filesystem is supported. NFS, SMB, other network filesystems, and storage with unreliable locking are not supported for the SQLite database.
- One Moodarr process may use a data directory at a time. Multiple replicas or two containers sharing `/data` are unsupported.
- SQLite schema and files under `/data` are internal implementation details. Do not modify them directly.
- Forward migrations run during startup. Follow [Upgrading](UPGRADING.md) and [Backup And Recovery](BACKUP_AND_RECOVERY.md) before changing versions.

## Network Boundary

Supported deployment shapes are:

- direct HTTP on a trusted LAN or VPN where every device able to observe traffic is trusted; or
- HTTPS through a same-origin reverse proxy, with `MOODARR_WEB_ORIGIN` set to the exact browser-visible origin.

Moodarr must be served at the origin root; subpath hosting is not part of the beta contract. Direct public-internet exposure without TLS, rate limiting, and an appropriate external access boundary is unsupported. Review [SECURITY.md](../SECURITY.md) before exposing the service beyond a private network.

## Compatibility Surfaces

The beta line treats these as user-facing compatibility surfaces:

- protected release Git tags, workflow-append-only GHCR version tags, and their immutable container digests;
- container port `4401`;
- the writable `/data` mount;
- documented environment-variable names and meanings;
- the `GET /api/health` path and its success/failure semantics;
- migration from the versions explicitly listed in [Upgrading](UPGRADING.md); and
- for installations that opt in to missing-title discovery, the beta catalog version, compressed SHA-256, full-snapshot expected count, and request-attempt disclosure semantics in [Catalog Bootstrap](CATALOG_BOOTSTRAP.md).

The JSON fields returned by health may grow additively. All other `/api` routes are an internal web/native-client contract unless a document explicitly says otherwise. They may change between beta releases. The SQLite schema, generated support-bundle shape, and recommendation-scoring details are not public APIs.

Health separates process liveness from service readiness. During the finite worker startup window it returns HTTP `200` with `ok: true`, `ready: false`, and `state: "starting"`. Once the database and every required worker role are available it returns HTTP `200` with `ok: true`, `ready: true`, and `state: "ready"`. A database failure, closed required role, or exhausted worker-start retry budget returns HTTP `503` with `ok: false`, `ready: false`, and `state: "degraded"`. The container health check requires both HTTP success and `ok: true` plus `ready: true`, so a live-but-starting process is not advertised as ready.

Breaking beta changes remain possible, but they must be called out in the changelog and release notes with any required operator action. The newest beta is the only maintained beta unless a security notice says otherwise. Stable v1 compatibility and deprecation promises will be defined separately before `v1.0.0`.

See [Support](../SUPPORT.md) for the maintained support boundary.
