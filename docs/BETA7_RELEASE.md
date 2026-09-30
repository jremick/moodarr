# Beta.7 release scope and gates

`v0.1.0-beta.7` contains the container runtime security repair, exact-peer proxy
trust, dependency patches, and a preview MCP adapter with its ChatGPT component.
The MCP service requires separate deployment and client acceptance. This release
does not expose an existing instance publicly. Official AI-provider and
TMDB-content policies remain `none`; ranking and the database schema are unchanged.
GitHub Releases determines availability.

## Required evidence

Bind results to the final source commit and published OCI index. Development
images and earlier releases provide supporting evidence only.

1. Merge through the current protected checks. Require a clean source tree,
   locked dependency audits, `verify:release`, the MCP verification and actual-API
   journey, secret checks, and a zero-result CodeQL analysis for the final commit.
2. Run the complete native Linux amd64 `release-check` and `release-build` through
   the existing local controller. Preserve the pinned runtime package inventory
   and verify the final image has no High or Critical finding. Retain lower
   severity findings without hiding packages or adding scanner exclusions.
3. Publish the full-SHA candidate through the controller, using the pinned
   local-signer policy. Verify anonymous manifest bytes, signed source/digest
   binding, transparency-log proof, SBOM, provenance and revocation policy.
4. Run the full exact-digest `candidate-check`: clean Docker/Compose installation
   and alpha.21 plus beta.1 through beta.6 upgrade, restart and cold-backup rollback.
   The beta.6 baseline is source `b3bd90ddd47eac1f56700063cf98829696d35e75`,
   OCI index `sha256:04ebff94f39ce82f2ac9159d1d0349a61eb2c07b70eebf92dde6c8d60afb1455`
   and schema 34. Preserve all historical baseline identities and require
   owned-resource cleanup.
5. Repeat the pinned 90,397-record networkless catalog import, integrity/index
   checks, restart parity and request-attempt isolation. Repeat exact-image
   protected-access, served-asset, Finder and Plex-link checks, plus final-source
   movie/TV confirmation and uncertain-retry scenarios with disposable providers.
6. Record incomplete comprehensive evidence below honestly. Complete it or obtain
   a separate maintainer disposition before semantic promotion. The earlier
   beta.6 disposition does not apply to this version.
7. Promote the validated candidate's exact manifest bytes through the guarded
   controller. Only then create the protected Git tag at that source commit and
   publish the immutable GitHub prerelease, with the checksum-pinned catalog asset
   and signed statement/bundle. Verify all public identities and uploaded bytes.

Follow [Local CI](LOCAL_CI.md) for the signed release protocol and the existing
[catalog procedure](BETA_CATALOG_IMPORT_VALIDATION.md) and
[runtime procedures](RELEASE.md#exact-digest-runtime-and-desktop-smoke) for the
workflow checks. Version-bound evidence must name beta.7 and its actual source
and digest; the beta.6 examples are historical, not reusable results.

## Incomplete comprehensive evidence

These groups remain pending until new evidence or a separate disposition is
recorded. They must not be described as passed:

- At least 100 independently judged frozen cases for the default MoodRank.
- Current Chrome, Edge, Firefox and macOS Safari coverage, plus additional
  Unraid Docker Manager installation and update coverage.
- Dedicated-account Plex Watchlist and Seerr/Jellyseerr writes, uncertain-outcome
  reconciliation and cleanup.
- Production-sized native amd64 two-CPU/two-GiB responsiveness.
- The comprehensive privacy-reviewed manual evidence artifact.
- Native Plex launch and missing-client checks with installed clients.

The preview MCP adapter additionally lacks final independent OAuth review and
acceptance in a real ChatGPT host. Its passing synthetic and actual-API tests do
not close those gaps. Keep the public service disabled until its launch gates
are separately satisfied.
