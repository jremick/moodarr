# Moodarr Documentation

This is the curated entry point for Moodarr's supported web/server documentation. Start with the deployment and operations guides below; planning and research files elsewhere in this directory are contributor references, not additional beta support promises.

## Install And Operate

- [Compatibility](COMPATIBILITY.md) - supported deployment, browser, integration, storage, and network boundaries.
- [Unraid deployment](UNRAID.md) - container defaults, Compose usage, and the Unraid template.
- [Optional catalog bootstrap](CATALOG_BOOTSTRAP.md) - checksum-pinned missing-title discovery and its stopped, networkless import process.
- [Upgrading](UPGRADING.md) - supported upgrade origins, post-upgrade checks, and rollback.
- [Backup and recovery](BACKUP_AND_RECOVERY.md) - cold backups, restore testing, and recovery.
- [Data and privacy](DATA_AND_PRIVACY.md) - local data, external flows, retention, and user scope.
- [Support](../SUPPORT.md) - supported beta scope and privacy-safe help routes.

## Understand Moodarr

- [Recommendation engine](RECOMMENDATION_ENGINE.md) - product rules and the ranking pipeline.
- [MoodRank current algorithms](MOODRANK_CURRENT_ALGORITHMS.md) - the living implementation map.
- [Mood feature index](MOOD_FEATURE_INDEX.md) - feature taxonomy, import format, and search use.

## Release And Maintainer Guides

- [Public beta release criteria](BETA_RELEASE_CRITERIA.md) - blocking requirements and the evidence ledger.
- [Beta candidate manual validation](BETA_CANDIDATE_MANUAL_VALIDATION.md) - exact-candidate operator validation.
- [Release readiness](RELEASE.md) - automated gates, packaging, and promotion.
- [Production plan](PRODUCTION_PLAN.md) - production architecture, security rules, and longer-term hardening.

## Design And Contribution

- [Contributing](../CONTRIBUTING.md) - local setup, tests, and pull-request expectations.
- [Screening Desk design system](design/opus-design-system.html) - the UI source of truth.
- [Admin redesign direction](design/opus-admin-mockup.html) - the approved admin layout direction.
- [Design system and UX review](DESIGN_SYSTEM_AND_UX_REVIEW.md) - supporting rationale and implementation phases.

The experimental iOS client and future-looking Mood/Feel goal documents remain outside the supported web/server beta surface.
