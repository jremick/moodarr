# Moodarr Documentation

This is the curated entry point for Moodarr's supported web/server documentation. Start with the deployment and operations guides below; planning and research files elsewhere in this directory are contributor references, not additional beta support promises.

The current published baseline is [v0.1.0-beta.8](https://github.com/jremick/moodarr/releases/tag/v0.1.0-beta.8). Its release notes record completed checks; [beta.8 scope and gates](BETA8_RELEASE.md) retain the comprehensive validation gaps. [GitHub issue #32](https://github.com/jremick/moodarr/issues/32) tracks follow-ups and historical evidence. Compatibility describes support policy, not a claim that every supported browser, integration or deployment has completed its validation matrix.

Historical beta.1: `v0.1.0-beta.1` was published from source commit `08447e87df2e1705aa9a79193a52a65fb00724c3`. Compatibility describes current support policy; it is not a claim that every beta.1 Unraid, integration, browser, responsiveness, catalog, or manual-evidence matrix was completed.

The [beta.4 replacement decision](BETA_RELEASE_CRITERIA.md#approved-beta4-replacement-release-profile) retired alpha.21 and beta.1/beta.2/beta.3. Their version numbers remain reserved, and historical source identities and evidence are not reassigned. Earlier release profiles remain historical decisions; none passes or waives a later candidate's checks. Use GitHub Releases to check subsequent availability; a source version bump is not publication.

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

- [Beta.8 release scope and gates](BETA8_RELEASE.md) - the published maintenance baseline, its evidence requirements and remaining limitations.
- [Public beta release criteria](BETA_RELEASE_CRITERIA.md) - release profiles, historical decisions and the preserved comprehensive hardening contract.
- [Beta candidate manual validation](BETA_CANDIDATE_MANUAL_VALIDATION.md) - version-bound comprehensive operator runbook; pending rows are not completed evidence.
- [Release readiness](RELEASE.md) - current release truth plus the preserved comprehensive release process.
- [Local CI and release checks](LOCAL_CI.md) - the portable `scripts/local-ci.sh` entrypoint, its evidence contract, the GitHub Actions mapping and the release trust policy.
- [Production plan](PRODUCTION_PLAN.md) - production architecture, security rules, and longer-term hardening.
- [Roadmap](ROADMAP.md) - outstanding fixes, validation, dependencies, and acceptance checks.

## Design And Contribution

- [Contributing](../CONTRIBUTING.md) - local setup, tests, and pull-request expectations.
- [Screening Desk design system](design/opus-design-system.html) - the UI source of truth.
- [Admin redesign direction](design/opus-admin-mockup.html) - the approved admin layout direction.
- [Design system and UX review](DESIGN_SYSTEM_AND_UX_REVIEW.md) - supporting rationale and implementation phases.

Native applications are maintained in separate repositories. Future-looking Mood/Feel goal documents remain outside the supported web/server beta surface.
