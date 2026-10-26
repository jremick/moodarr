# Beta.8 release scope and gates

`v0.1.0-beta.8` is a security maintenance release for the web/server container and preview MCP source. It updates vulnerable dependencies, refreshes the pinned runtime certificate bundle, and rejects oversized MCP tool inputs before schema validation. GitHub Releases determines availability.

Schema 34, ranking behavior and the official AI-provider and TMDB-content policies (`none`) stay unchanged. Ranking experiments in PRs #106, #109 and #111 remain outside this release. The MCP service requires separate deployment, independent OAuth review and real ChatGPT acceptance; this release does not enable it publicly.

## Required fresh evidence

Bind every result to the final source commit and, where applicable, the published immutable OCI index. An earlier release or development image is supporting evidence only.

1. Pass the locked dependency audits in all three packages without an audit exception; complete `verify:release`, MCP verification and actual-API journeys, secret checks and zero-result CodeQL analysis for the final commit.
2. Complete native Linux amd64 `release-check` and `release-build` through the existing local controller. Verify the pinned runtime inventory and retain the complete vulnerability report; High or Critical image findings block release. Do not add scanner exclusions.
3. Publish the full-SHA candidate through the controller using the pinned local signer. Verify anonymous manifest bytes, signed source/digest binding, transparency proof, SBOM, provenance and revocation policy.
4. Pass the exact-digest `candidate-check`: clean Docker/Compose installation plus alpha.21 and beta.1 through beta.7 upgrade, restart and cold-backup rollback. The beta.7 baseline is source `5bf5ff0588e8e2b577ae867aafcaec9fb3357115`, OCI index `sha256:bb11fe60eec6f24ee2243b6bb3b09b0a489c04ee5d971d6d072a8233912248c9`, schema 34. Preserve all historical identities and verify cleanup of owned resources.
5. Repeat the pinned 90,397-record networkless catalog import, integrity/index checks, restart parity and request-attempt isolation. Verify exact-image protected access, served assets, Finder and Plex links, and final-source movie/TV confirmation and uncertain-retry scenarios with disposable providers.
6. Promote the validated candidate's exact manifest bytes through the guarded controller, then create the protected Git tag at that source and publish the immutable prerelease. Read back every public identity and all uploaded catalog and signed-statement bytes.

Use [Local CI](LOCAL_CI.md), the [catalog procedure](BETA_CATALOG_IMPORT_VALIDATION.md), and the [runtime procedures](RELEASE.md#exact-digest-runtime-and-desktop-smoke). A failed required check blocks publication. A source change requires a new candidate; do not overwrite published candidate bytes.

## Existing beta limitations

The approved maintenance scope repairs security and dependency issues within the existing beta surface. It does not establish the following comprehensive acceptance evidence, which remains open:

- At least 100 independently judged frozen cases for default MoodRank.
- The full current Chrome, Edge, Firefox and Safari matrix and additional Unraid Docker Manager install/update coverage.
- Dedicated-account Plex Watchlist and Seerr/Jellyseerr writes with uncertain-outcome reconciliation and cleanup.
- Production-sized native amd64 two-CPU/two-GiB responsiveness.
- The comprehensive privacy-reviewed manual evidence artifact.
- Native Plex launch and missing-client behavior with installed clients.

Retain these limitations in release notes. Passing scoped automated and exact-image checks does not close them or the separate MCP launch gates. Historical evidence and dispositions remain attached to their original releases.
