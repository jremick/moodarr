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

The example container budget is two CPUs, 2 GiB memory, 128 processes, and a 512 MiB `/tmp` tmpfs. Those values are supported defaults, not a guaranteed minimum for every catalog size. Record material resource changes when reporting a problem.

## Browser Matrix

The beta web app supports the current stable and immediately previous major releases of:

- Chrome and Chromium-based Edge;
- Firefox; and
- Safari on macOS and iOS.

The release candidate must complete its browser smoke matrix against exact recorded versions. Older browsers and embedded webviews are best effort.

## Integration Matrix

| Integration | Beta status | Contract |
| --- | --- | --- |
| Plex Media Server | Supported | Library sync, Plex sign-in, poster proxying, Plex links, and signed-in-user Watchlist actions are tested against the current stable Plex release used by the release candidate. Record that exact version. |
| Seerr or Jellyseerr | Supported | Catalog/request-state sync, request preview, and explicitly confirmed request creation are tested against the current stable release used by the release candidate. Record the product and exact version. |
| Other Seerr-compatible servers | Best effort | API-compatible deployments may work, but untested variants do not expand the beta support contract. |
| No AI provider | Supported default | `AI_PROVIDER=none` keeps recommendation processing local and is the required baseline release path. |
| OpenAI | Optional, supported | The documented server-side OpenAI path is supported when configured with an available documented model. Service availability, billing, and model-output variation remain external concerns. |
| Other AI providers or OpenAI-compatible endpoints | Unsupported | No compatibility promise is made unless a provider is explicitly documented. |
| Fixture mode | Supported for evaluation | Fixture mode is part of development, CI, and first-look testing. It is not evidence that a real Plex/Seerr deployment has been validated. |

Third-party services do not publish perfectly synchronized compatibility contracts. Each Moodarr release therefore records the exact Plex and Seerr/Jellyseerr versions used for its integration evidence instead of implying support for every historical version.

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
- the `GET /api/health` path and its success/failure semantics; and
- migration from the versions explicitly listed in [Upgrading](UPGRADING.md).

The JSON fields returned by health may grow additively. All other `/api` routes are an internal web/native-client contract unless a document explicitly says otherwise. They may change between beta releases. The SQLite schema, generated support-bundle shape, and recommendation-scoring details are not public APIs.

Breaking beta changes remain possible, but they must be called out in the changelog and release notes with any required operator action. The newest beta is the only maintained beta unless a security notice says otherwise. Stable v1 compatibility and deprecation promises will be defined separately before `v1.0.0`.

See [Support](../SUPPORT.md) for the maintained support boundary.
