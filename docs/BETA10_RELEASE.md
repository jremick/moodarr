# Beta.10 security release

Beta.10 filters credentials reflected in configurable OpenAI output and Seerr descriptive metadata. The Seerr client retains confirmed request status when it drops a description. The Linux `amd64` image includes Node 24.22.3 and ICU 79. The preview MCP source includes the Hono updates and requires browser approval for media requests. Hosted MCP deployment and real-client acceptance are separate operations. The official image uses schema 34 with the AI-provider and TMDB-content policies set to `none`.

## Release verification

- Verify the locked dependencies, release build, MCP journeys, secret checks and CodeQL against the release source.
- Run the native release checks and produce the signed candidate from the approved commit on `main`. Check anonymous access, source and digest binding, provenance, SBOM, revocations and the image scan.
- Test the exact candidate with Docker and Compose. Run the upgrade, restart and cold-backup rollback checks for alpha.21 and beta.1 through beta.9. The beta.9 baseline is commit `9d2ca6c40808b0b2c642d035e6020e20691233fd` and OCI index `sha256:096d366f43c225231fe85f5c4028984bf2153890dbfc076ce97a5ce74eb0ba23`.
- Verify the [offline catalog import](BETA_CATALOG_IMPORT_VALIDATION.md) and the asset checksums. Promote the validated candidate digest, then verify the protected tag, immutable prerelease and public assets.

[GitHub Releases](https://github.com/jremick/moodarr/releases) records publication and the checks completed on the release. The [existing beta limitations](BETA9_RELEASE.md#existing-beta-limitations) still apply.
