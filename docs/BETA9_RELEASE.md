# Beta.9 release scope and gates

`v0.1.0-beta.9` prepares a feedback-persistence and dependency maintenance release for the web/server container. Saved Like, preferred-example and Maybe selections survive searches and reloads. Edits, clears and Undo replace acknowledged revisions across searches without duplicate learning. Only editable history is restored: reset, rollback, invalidated replay dependencies and the 500-event boundary cannot restore controls that repeatedly fail to edit. Feedback remains scoped to the requesting user and viewing context.

Fastify static serving uses its compatible glob dependency update; scoped lint-tool overrides remove vulnerable matching versions. Schema 34, experimental ranking defaults and official AI-provider and TMDB-content policies (`none`) stay unchanged. Ranking experiments in PRs #106, #109 and #111 remain excluded. The MCP service still requires separate deployment, independent OAuth review and real ChatGPT acceptance.

## Publication status

Version preparation is not publication. [GitHub Releases](https://github.com/jremick/moodarr/releases) determines availability and records the final source commit, immutable OCI index and completed evidence. The predecessor is [beta.8](BETA8_RELEASE.md), source `458475414db4fc61631d0339cf049b2d2d9cfd6f`, OCI index `sha256:32a3855a22c2e69d7808f5d8416c98657ca56f8f968056c87ba32e1247f5363b`. Publication does not establish the state of any deployed instance.

## Required fresh evidence

Bind every result to the final source commit and, where applicable, the published immutable OCI index. An earlier release or development image is supporting evidence only.

1. Pass the locked dependency audits in all three packages without an audit exception; complete `verify:release`, MCP verification and actual-API journeys, secret checks and zero-result CodeQL analysis for the final commit.
2. Complete native Linux amd64 `release-check` and `release-build` through the existing local controller. Verify the pinned runtime inventory and retain the complete vulnerability report; High or Critical image findings block release. Do not add scanner exclusions.
3. Publish the full-SHA candidate through the controller using the pinned local signer. Verify anonymous manifest bytes, signed source/digest binding, transparency proof, SBOM, provenance and revocation policy.
4. Pass the exact-digest `candidate-check`: clean Docker/Compose installation plus alpha.21 and beta.1 through beta.8 upgrade, restart and cold-backup rollback. The beta.8 baseline is source `458475414db4fc61631d0339cf049b2d2d9cfd6f`, OCI index `sha256:32a3855a22c2e69d7808f5d8416c98657ca56f8f968056c87ba32e1247f5363b`, schema 34. Preserve all historical identities and verify cleanup of owned resources.
5. Verify final-source browser feedback restoration, reload, replacement, clear, Undo and reset recovery. Repeat the pinned 90,397-record networkless catalog import, integrity/index checks, restart parity and request-attempt isolation. Verify exact-image protected access, served assets, Finder and Plex links, and final-source movie/TV confirmation and uncertain-retry scenarios with disposable providers.
6. Promote the validated candidate's exact manifest bytes through the guarded controller, then create the protected Git tag at that source and publish the immutable prerelease. Read back every public identity and all uploaded catalog and signed-statement bytes.

Use [Local CI](LOCAL_CI.md), the [catalog procedure](BETA_CATALOG_IMPORT_VALIDATION.md), and the [runtime procedures](RELEASE.md#exact-digest-runtime-and-desktop-smoke). A failed required check blocks publication. A source change requires a new candidate; do not overwrite published candidate bytes.

## Existing beta limitations

The maintenance scope repairs feedback persistence and dependency issues within the existing beta surface. It does not establish the following comprehensive acceptance evidence, which remains open:

- At least 100 independently judged frozen cases for default MoodRank.
- The full current Chrome, Edge, Firefox and Safari matrix and additional Unraid Docker Manager install/update coverage.
- Dedicated-account Plex Watchlist and Seerr/Jellyseerr writes with uncertain-outcome reconciliation and cleanup.
- Production-sized native amd64 two-CPU/two-GiB responsiveness.
- The comprehensive privacy-reviewed manual evidence artifact.
- Native Plex launch and missing-client behavior with installed clients.

Retain these limitations in release notes. Passing scoped automated and exact-image checks does not close them or the separate MCP launch gates. Historical evidence and dispositions remain attached to their original releases.
