# Support

Moodarr is maintained as open-source self-hosted software. Published public betas are intended for real external use, but support is best effort and does not include a response-time or resolution-time guarantee. The GitHub Releases page is authoritative for which beta, if any, is currently supported.

Support policy and release evidence are separate. `v0.1.0-beta.1` was published from `08447e87df2e1705aa9a79193a52a65fb00724c3` under a narrower early-beta gate; [issue #32](https://github.com/jremick/moodarr/issues/32) remains the authoritative ledger for its open Unraid/update, stopped catalog, real integration-write, native responsiveness, current-browser, and privacy-reviewed manual-evidence work. A supported path is eligible for support and bug reports; it does not mean beta.1 completed every planned compatibility matrix.

## Where To Ask

- Search [existing issues](https://github.com/jremick/moodarr/issues) before opening a new report.
- Use the [setup or support question](https://github.com/jremick/moodarr/issues/new?template=setup_support.yml) for general installation, configuration, or troubleshooting help that is not yet a confirmed defect.
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
- Plex-only discovery without an external catalog, plus the optional pinned beta.1 catalog and stopped networkless full-snapshot process in [Catalog Bootstrap](docs/CATALOG_BOOTSTRAP.md);
- deterministic local recommendation processing with AI disabled;
- direct upgrades and rollback procedures listed in [Upgrading](docs/UPGRADING.md); and
- current supported browsers and deployment boundaries listed in [Compatibility](docs/COMPATIBILITY.md).

Security fixes may require upgrading to the newest beta. Superseded prereleases receive no separate maintenance promise.

The supported alpha.21-to-beta.1 path requires a complete cold backup and, for instances that imported catalog data, the approved Wikidata catalog file for the recorded `wikidata` source. Beta.1's packaged `--rehydrate-required` importer is intentionally Wikidata-only and uses a read-only discovery pass followed by an exact expected-count, asset-SHA, and canonical recovery-plan-SHA write; its whole-operation rollback and zero-pending diagnostic gate in [Upgrading](docs/UPGRADING.md) are part of that path. Manual database reconstruction, another catalog source, Seerr/TMDB descriptive re-ingestion, and recovery without the authoritative input are outside the supported upgrade contract.

## Identity Conflict Recovery

If Moodarr quarantines an item because one integration record resolves to conflicting stored identities, correct the identity mapping in the upstream Plex and Seerr/Jellyseerr systems first. In Admin, enable **Sync Seerr**, choose **Sync now**, and wait for that one run to complete both the Plex and Seerr phases successfully.

Only quarantine rows last seen before that full run began are cleared, and Moodarr rebuilds the affected catalog search entries in the same database transaction. A conflict reproduced by either source during the run remains quarantined and request-blocked. A Plex-only run, Seerr-only run, cancelled run, or failed phase never clears quarantine. Admin sync status and support bundles expose only the aggregate number cleared, not affected media titles or identifiers.

There is no force-clear control. Do not edit the live SQLite database to bypass quarantine; if a corrected full sync reproduces the conflict, re-check the upstream identifiers instead.

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
- custom catalogs, regenerated normalizations, Wikidata dumps other than `wikidata-20260622-min5-v1`, or a catalog asset whose SHA-256 differs from `dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a`;
- recovery when no complete pre-upgrade backup exists; and
- releases older than the newest beta.

An unsupported environment can still reveal a Moodarr defect. Reports are welcome when they include a minimal reproduction against a supported configuration.

## A Useful Report

Include:

- the exact Moodarr version and image digest;
- host architecture, Docker/Compose or Unraid version, and browser version;
- whether the report uses the official provider-locked image or a custom/source/EXP build;
- relevant Plex and Seerr/Jellyseerr versions;
- whether the optional catalog is installed and, if so, its version, compressed SHA-256, importer exit status, and aggregate imported/skipped counts;
- concise reproduction steps, expected behavior, and actual behavior;
- redacted logs or the smallest relevant section of an inspected support bundle; and
- whether the problem also occurs in fixture mode or after a clean restart.

Do not attach `.env` files, database files, catalog rows, complete support bundles, access tokens, private URLs, library screenshots, or user data. Support bundles can contain sensitive operational information even after credential redaction. Report only aggregate catalog counts and public asset identity; do not include local asset or appdata paths.

Maintainers may ask for a clean reproduction, close reports that cannot be acted on, or redirect requests that fall outside the documented beta scope.
