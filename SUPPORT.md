# Support

Moodarr is maintained as open-source self-hosted software. Published public betas are intended for real external use, but support is best effort and does not include a response-time or resolution-time guarantee. The GitHub Releases page is authoritative for which beta, if any, is currently supported.

## Where To Ask

- Search [existing issues](https://github.com/jremick/moodarr/issues) before opening a new report.
- Use the [bug report](https://github.com/jremick/moodarr/issues/new?template=bug_report.yml) for reproducible Moodarr defects and installation failures.
- Use the [feature request](https://github.com/jremick/moodarr/issues/new?template=feature_request.yml) for product proposals.
- Follow [CONTRIBUTING.md](CONTRIBUTING.md) for code and documentation changes.
- Report vulnerabilities through the private route in [SECURITY.md](SECURITY.md). Never report a vulnerability in a public issue.

GitHub Issues is the maintained public support surface. There is no separate chat, forum, or guaranteed private troubleshooting service.

## Supported Beta Scope

Support for the beta line covers the newest published beta release and its documented web/server deployment paths:

- the official Linux `amd64` container image;
- Docker, Docker Compose v2, and the checked-in Unraid template;
- the documented Plex and Seerr/Jellyseerr integration flows;
- deterministic local recommendation processing with AI disabled;
- direct upgrades and rollback procedures listed in [Upgrading](docs/UPGRADING.md); and
- current supported browsers and deployment boundaries listed in [Compatibility](docs/COMPATIBILITY.md).

Security fixes may require upgrading to the newest beta. Superseded prereleases receive no separate maintenance promise.

The supported alpha.21-to-beta.1 path requires a complete cold backup and, for instances that imported catalog data, an operator-approved catalog file for the recorded source. Beta.1's packaged `--rehydrate-required` importer, expected-count preflight, and zero-pending diagnostic gate in [Upgrading](docs/UPGRADING.md) are part of that path. Manual database reconstruction, Seerr/TMDB descriptive re-ingestion, and recovery without an authoritative catalog input are outside the supported upgrade contract.

## Best-Effort Or Unsupported Areas

The following do not block a web/server beta release and may receive only best-effort guidance:

- the experimental iOS app;
- architectures other than Linux `amd64`;
- native host installs, custom images, forks, and modified database schemas;
- Docker Compose v1, Kubernetes, multiple replicas, and network filesystems for SQLite;
- reverse-proxy-specific configuration beyond Moodarr's documented origin and cookie requirements;
- direct public-internet exposure without an appropriate HTTPS and authentication boundary;
- the provisional OpenAI path in source/EXP development builds; the official beta.1 image cannot enable a provider;
- third-party service outages, API policy changes, or model-output quality;
- recovery when no complete pre-upgrade backup exists; and
- releases older than the newest beta.

An unsupported environment can still reveal a Moodarr defect. Reports are welcome when they include a minimal reproduction against a supported configuration.

## A Useful Report

Include:

- the exact Moodarr version and image digest;
- host architecture, Docker/Compose or Unraid version, and browser version;
- whether the report uses the official provider-locked image or a custom/source/EXP build;
- relevant Plex and Seerr/Jellyseerr versions;
- concise reproduction steps, expected behavior, and actual behavior;
- redacted logs or the smallest relevant section of an inspected support bundle; and
- whether the problem also occurs in fixture mode or after a clean restart.

Do not attach `.env` files, database files, complete support bundles, access tokens, private URLs, library screenshots, or user data. Support bundles can contain sensitive operational information even after credential redaction.

Maintainers may ask for a clean reproduction, close reports that cannot be acted on, or redirect requests that fall outside the documented beta scope.
