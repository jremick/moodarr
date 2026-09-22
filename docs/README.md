# Moodarr Documentation

This is the curated entry point for Moodarr's supported web/server documentation. Start with the deployment and operations guides below; planning and research files elsewhere in this directory are contributor references, not additional beta support promises.

`v0.1.0-beta.1` was published from source commit `08447e87df2e1705aa9a79193a52a65fb00724c3`. [GitHub issue #32](https://github.com/jremick/moodarr/issues/32) is the authoritative evidence and follow-up ledger. Compatibility describes current support policy; it is not a claim that every beta.1 Unraid, integration, browser, responsiveness, catalog, or manual-evidence matrix was completed.

The [beta.4 replacement decision](BETA_RELEASE_CRITERIA.md#approved-beta4-replacement-release-profile) authorizes retirement of alpha.21 and beta.1/beta.2/beta.3. Their version numbers remain reserved, and historical source identities and evidence are not reassigned. Use GitHub Releases to check replacement availability; a source version bump is not publication.

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
- [MoodRank independent evaluation protocol](MOODRANK_EVALUATION_PROTOCOL.md) - frozen local evaluation, evidence, and leakage controls.
- [Mood feature index](MOOD_FEATURE_INDEX.md) - feature taxonomy, import format, and search use.

## Release And Maintainer Guides

- [Public beta release criteria](BETA_RELEASE_CRITERIA.md) - current beta.4 replacement profile and preserved comprehensive hardening contract.
- [Beta candidate manual validation](BETA_CANDIDATE_MANUAL_VALIDATION.md) - version-bound comprehensive operator runbook; pending rows are not completed evidence.
- [Release readiness](RELEASE.md) - current release truth plus the preserved comprehensive release process.
- [Production plan](PRODUCTION_PLAN.md) - production architecture, security rules, and longer-term hardening.
- [Roadmap](ROADMAP.md) - outstanding fixes, validation, dependencies, and acceptance checks.

## Design And Contribution

- [Contributing](../CONTRIBUTING.md) - local setup, tests, and pull-request expectations.
- [Screening Desk design system](design/opus-design-system.html) - the UI source of truth.
- [Admin redesign direction](design/opus-admin-mockup.html) - the approved admin layout direction.
- [Design system and UX review](DESIGN_SYSTEM_AND_UX_REVIEW.md) - supporting rationale and implementation phases.

Native applications are maintained in separate repositories. Future-looking Mood/Feel goal documents remain outside the supported web/server beta surface.
