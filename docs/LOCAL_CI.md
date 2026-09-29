# Local CI And Release Checks

`scripts/local-ci.sh` runs Moodarr's CI, release, candidate and scheduled security checks on a Linux host that you control. It reproduces the GitHub Actions workflows in `.github/workflows/`. Those workflows stay in place until the maintainers finish the cutover; until then both paths run the same checks.

The entrypoint never publishes, signs or promotes anything, and it never needs a registry, GitHub or signing credential.

## Requirements

- Linux on x86_64. The native validators refuse emulation and remote Docker endpoints.
- Docker Engine with Compose v2 on the default Docker context, using a local `unix://` socket and a `linux`/`x86_64` daemon. `DOCKER_HOST` and `DOCKER_CONTEXT` are not passed to checks, so every check uses the same daemon as the validators.
- Exclusive use of that daemon during a run. `npm run verify:release` builds the fixed tag `moodarr:smoke`, and the validator cleanup proof fails if any validator-owned container, volume or network exists.
- Node.js 24 with npm, Git, jq, curl, tar and Bash.
- Trivy 0.70.0 for image scans and CodeQL CLI 2.27.1 for `codeql`.
- For `candidate-check` and `release-build`: `gh`, cosign v3.1.3, and Docker Buildx v0.34.1 installed as `$DOCKER_CONFIG/cli-plugins/docker-buildx` with SHA-256 `f1332ddb9010bd0b72628266c3a906d9a6979848033df4c8d9bd2cd113bae12b`.
- Network access to the npm registry, the pinned base and helper images, the Trivy database, anonymous GHCR reads and Sigstore.

The entrypoint checks tool versions and fails if one is missing or different. It does not install tools.

## Run A Check

```bash
export LOCAL_CI_RUN_ID="dev-$(date -u +%Y%m%d%H%M%S)"
export LOCAL_CI_EVIDENCE_DIR="$HOME/moodarr-ci-evidence/$LOCAL_CI_RUN_ID"
export LOCAL_CI_SOURCE_SHA="$(git rev-parse HEAD)"
scripts/local-ci.sh verify
```

`scripts/local-ci.sh list` prints every mode and subjob. Add subjob names after the mode to run a subset, for example `scripts/local-ci.sh verify audit container-scan`. A subset is never gating.

| Mode | Replaces | Subjobs, in order |
|---|---|---|
| `verify` | `ci.yml` and the `codeql.yml` analysis | `audit`, `verify-release`, `container-scan`, the seven `native-*` rehearsals, `codeql` |
| `release-check` | `release-verify.yml` and the credential-free `publish-image.yml` gates | gates `release-source` and `release-policy`, then every `verify` subjob |
| `release-build` | the `publish-image.yml` candidate build | gates `release-source` and `release-policy`, then `release-image` |
| `candidate-check` | `validate-beta-candidate.yml` | gates `candidate-source`, `anonymous-pull` and `attestation`, then the seven `official-*` validations and `supply-chain` |
| `scheduled-security` | `security-scheduled.yml` | `dependency-audit`, `container-scan` |
| `codeql` | the weekly `codeql.yml` schedule | `codeql` only; needs no Docker |
| `cleanup` | none | removes this run ID's resources after a lost or killed run |

`npm ci` runs first as the `install` step when a selected subjob needs `node_modules`. `native-image` builds the rehearsal image once before the first `native-*` subjob. A failed gate skips everything after it. A failed `install` or `native-image` skips the subjobs that depend on it. Other subjobs keep running, as the Actions matrix does.

### Inputs

| Variable | Required for | Rule |
|---|---|---|
| `LOCAL_CI_RUN_ID` | every mode | 8–48 lowercase letters, digits or hyphens, starting and ending with a letter or digit |
| `LOCAL_CI_EVIDENCE_DIR` | every mode | absolute; outside the checkout after resolving symbolic links; absent or empty |
| `LOCAL_CI_SOURCE_SHA` | `release-check`, `release-build`, `candidate-check`; optional otherwise | full lowercase SHA equal to `HEAD`; the tree must then be clean |
| `LOCAL_CI_MAIN_SHA` | `release-check`, `release-build`, `candidate-check` | the current `main` commit, read by the caller from GitHub; the checkout must contain it and the history back to the source. `release-check` and `candidate-check` accept a source that is an ancestor of it; `release-build` requires the source to equal it |
| `LOCAL_CI_CANDIDATE_DIGEST` | `candidate-check`; optional for `release-check` | `sha256:<64 lowercase hex>` of the published OCI index |
| `LOCAL_CI_ATTESTATION_BUNDLE` | optional, GitHub-hosted versions | absolute path to a bundle from `gh attestation download`; without it `gh` reads the bundle from the registry |
| `LOCAL_CI_SIGNED_STATEMENT`, `LOCAL_CI_SIGNATURE_BUNDLE` | `candidate-check` for local-signer versions | absolute paths to the signed release statement and its Sigstore bundle |
| `LOCAL_CI_SUBJOB_TIMEOUT_SECONDS` | optional | 1–14400; replaces every subjob deadline |

The entrypoint does not fetch. For `release-build` the checkout's `origin` must be `https://github.com/jremick/moodarr`, with or without `.git`, so that BuildKit records the public source. Credential-bearing or other URLs are refused and not printed.

Checks receive only an allowlist of environment variables: `PATH`, `HOME`, locale and time zone, `TMPDIR`, `DOCKER_CONFIG`, proxy settings, npm and Trivy caches and CA bundle paths. Tokens in the caller's environment do not reach them. `gh` runs with an empty configuration directory.

## Results And Evidence

`$LOCAL_CI_EVIDENCE_DIR/result.json` is written last and atomically. It is the source of truth; the exit code alone is not.

| Exit code | Meaning |
|---|---|
| `0` | every selected subjob, cleanup and the evidence scan passed |
| `1` | a check, contract, cleanup or evidence-scan failure |
| `2` | refused input; no check ran |
| `129`, `130`, `143` | cancelled by `SIGHUP`, `SIGINT` or `SIGTERM` |

`result.json` records `status`, `complete`, `gating`, `gatingBlockers`, the source identity, each subjob's status, reason, exit code and log, the cleanup result, the evidence scan and the SHA-256 of `evidence-manifest.json`. A run can gate only when it passed, ran the complete subjob set, was given `LOCAL_CI_SOURCE_SHA` for a clean tree, and ran on Node.js 24. `evidence-manifest.json` lists every evidence file with its size and SHA-256.

Each subjob writes `logs/<subjob>.log` and its artefacts under `<subjob>/`, for example the image identity and Trivy reports under `container-scan/`, `report.json` and `image-identity.json` under each `native-*` subjob, and `results.sarif` plus `codeql-summary.json` under `codeql/`. The SARIF file has absolute tool and checkout URIs removed so it can be uploaded without host paths. Evidence records never contain the checkout or evidence path.

Before the result is written, every evidence file is scanned with the tracked-content secret patterns. A match fails the run and replaces that file with a redaction notice; the result lists the file, line and kind only.

On `SIGTERM`, `SIGINT` or `SIGHUP` the active subjob's process group receives `SIGTERM`, then `SIGKILL` after 30 seconds. Remaining subjobs are marked cancelled and cleanup still runs. Send `SIGTERM` and wait; if the process is killed, run `scripts/local-ci.sh cleanup` with the same run ID.

Cleanup removes only `moodarr-local-ci:<run-id>-scan`, `moodarr-local-ci:<run-id>-native` and the Buildx builder `moodarr-lci-<run-id>`. Validator resources carry random owner labels that the entrypoint cannot attribute to a run, so it reports them in `cleanup/validator-leftovers.json` and fails, but never removes them.

## Exit Codes Of The Native Validators

A local rehearsal validator must exit `1`: it is behaviourally successful but not release-eligible, because the image is not a published digest. Exit `1` is accepted only together with the complete report contract in `scripts/local-ci/contracts/rehearsal-<validation>.jq`: schema, candidate identity, native Linux amd64 on a local Unix endpoint, all check codes, lifecycle counts, pinned baseline digests and revisions, and exactly the expected rehearsal marker in `incomplete`. Official candidate validation must exit `0` with `releaseEligible: true`, zero unresolved `incomplete` entries and the complete contract in `contracts/official-<validation>.jq`. The rehearsal contracts and the beta.4 and beta.5 official contracts are copied from the workflows; the tests prove that both implementations reach the same decisions.

## Mapping From GitHub Actions

| Workflow job or gate | Local equivalent | Notes |
|---|---|---|
| `ci.yml` `verify` (required check) | `verify`: `install`, `audit`, `verify-release` | `verify:release` always runs with `MOODARR_SECRETS_REQUIRE_BUILD=true` |
| `ci.yml` `Scan exact event source image` (required check) | `container-scan` | Same build arguments, label checks, Trivy 0.70.0 commands and OpenVEX file |
| `ci.yml` native-source validation matrix (7) | `native-image` and seven `native-*` subjobs | Image built once per run; its ID is rechecked before each validation |
| `codeql.yml` `Analyze JavaScript and TypeScript` (required check) | `codeql` subjob of `verify`; the `codeql` mode for the weekly schedule | `build-mode=none`, default code-scanning suite, category `/language:javascript-typescript`; fails on any result. `verify codeql` is a partial selection and never gating; the `codeql` mode is complete, so a passing run from a supplied clean source on Node.js 24 can gate a SARIF upload for that commit |
| `release-verify.yml` `verify` and `container-scan` | `release-check` | `release-source` proves the source is reachable from `LOCAL_CI_MAIN_SHA` |
| `publish-image.yml` `authorize` and tag resolution gates | `release-policy` | Strict beta SemVer, release-copy markers, revocations at source and main, trust policy |
| `publish-image.yml` candidate build | `release-build` | Builds the OCI archive only; see [Local release build v1](#local-release-build-v1) |
| `publish-image.yml` push, attestation, readback and promotion | private controller | The private controller owns signed publishing and guarded promotion; activation requires verified cutover |
| `validate-beta-candidate.yml` `authorize`, `anonymous-pull` | `candidate-source`, `anonymous-pull` | The anonymous token is never printed |
| `validate-beta-candidate.yml` provenance binding | `attestation` | Policy chosen by version from main; see [Release Trust](#release-trust) |
| `validate-beta-candidate.yml` `clean-install`, `upgrade-rollback` | seven `official-*` subjobs | Full report contract for every validation, not only beta.4 and beta.5 |
| `validate-beta-candidate.yml` `supply-chain` | `supply-chain` | Uses a run-owned pinned BuildKit builder without switching the host's current builder |
| `security-scheduled.yml` dependency audit and image scan | `scheduled-security` | The image scan uses the package version label instead of `security-scan` |

Triggers, schedules, concurrency, required-check reporting, SARIF upload and artefact retention belong to the runner that calls this entrypoint, not to the entrypoint itself.

## Release Trust

`.github/release-trust.json` assigns exactly one signer policy to each `0.1.0-beta.N` version. It is always read from `LOCAL_CI_MAIN_SHA`, not from the candidate source, so a source change cannot downgrade its own trust or swap its key. Changing it requires a reviewed change to `main`.

- `github-hosted` (beta.1 to beta.6): the published candidate must carry a GitHub artifact attestation from `jremick/moodarr/.github/workflows/publish-image.yml`, with signer and source digest equal to the candidate commit, source ref `refs/heads/main`, and `--deny-self-hosted-runners`. BuildKit provenance must name a Moodarr Actions run as its builder.
- `local-signer` (beta.7 onward): the candidate must carry a statement signed by an active key pinned under `.github/release-signers/`. Its PEM SHA-256 must match the pin, and the signature must be recorded in the Sigstore transparency log. BuildKit provenance must name the builder below.

The local-signer statement is an in-toto Statement v1 with predicate type `https://slsa.dev/provenance/v1`. It must have exactly one subject, `ghcr.io/jremick/moodarr` with the OCI index digest. `externalParameters.source` must be `git+https://github.com/jremick/moodarr@refs/heads/main` with `gitCommit` equal to the candidate commit. `releaseMode` must be `candidate`, `packageVersion` must match, and `candidateTag` must be `sha-<commit>`. The build type and builder ID must match the trust policy. Verification runs `cosign verify-blob --key <pinned key> --bundle <bundle> <statement>` without offline or transparency-log bypass flags, then checks every claim above.

A controller can use the same checks directly:

```bash
LCI_MAIN_SHA=<main> bash scripts/local-ci/jobs.sh trust-resolve
LCI_MAIN_SHA=<main> LCI_SOURCE_SHA=<commit> LCI_CANDIDATE_DIGEST=<digest> \
  LCI_SIGNED_STATEMENT=<statement.json> LCI_SIGNATURE_BUNDLE=<bundle.json> LCI_SUBJOB_DIR=<dir> \
  bash scripts/local-ci/jobs.sh local-signer-verify
```

`trust-resolve` prints `moodarr-release-trust-resolution-v1` JSON with the policy, builder ID, build type, source URI and active keys for the checkout's package version.

### Local Release Build v1

`release-build` produces the candidate artefact without credentials. As in `publish-image.yml`, a candidate is the current `main` commit, not merely an older ancestor: `release-image` refuses to build unless `LOCAL_CI_SOURCE_SHA` equals `LOCAL_CI_MAIN_SHA`. The `release-source` gate it shares with `release-check` still proves only ancestry. It also refuses versions whose policy is not `local-signer`, a non-public origin and an unpinned Buildx. It builds `linux/amd64` with the publish workflow's build arguments and labels, maximum BuildKit provenance and the pinned SBOM generator. The result is an OCI archive at `release-image/moodarr-oci.tar`. Before it records the build, it verifies the archive:

- exactly one image index, holding one `linux/amd64` image bound to its attestation manifest;
- every blob matches its digest;
- the candidate labels are present;
- provenance comes from the pinned builder;
- an SPDX 2.3 SBOM is present;
- there are no host paths or GitHub event fields in provenance.

`release-image/release-build.json` (`moodarr-local-release-build-v1`) records `sourceRevision`, `mainRevision`, `packageVersion`, `candidateTag`, `indexDigest`, `archiveSha256` and `builderId`.

### Local Release Builder v1

The builder ID `https://github.com/jremick/moodarr/blob/main/docs/LOCAL_CI.md#local-release-builder-v1` identifies a `release-build` run of this entrypoint on a maintainer-controlled Linux host, verified and published by the maintainers' private controller. The controller checks the complete gating `release-check` and `release-build` evidence for the same commit, and the maintainer-approved digest, before it pushes the archive unchanged and signs the statement. `release-build` does not query the remote, so the controller must also prove, immediately before the push, that the semantic Git tag `v<package version>` is absent, as `publish-image.yml` does; this is a mandatory controller gate, not an optional check. The signing key and registry credential never reach the build host. Release promotion is a separate maintainer decision.

## Runner Integration

- Automatic triggers, schedules, required-check reporting and CodeQL SARIF upload are runner responsibilities.
- The private controller implements candidate publishing and semantic promotion. Promotion stays disabled until a maintainer explicitly approves it. GitHub Actions remains active until the replacement passes the complete cutover checks.
- `scripts/test-packaging.ts` and `scripts/verify-doc-contracts.ts` still inspect the workflow files. Keep those files as parity references when disabling their execution.

## Updating an existing branch

A branch created before the local CI entrypoint was added must first merge or rebase onto current
`main`. The controller tests the branch's own source; it does not inject newer check scripts into an
older commit. A missing entrypoint therefore fails the check.

After updating a branch, wait for fresh `local-ci/verify`, `local-ci/scan-exact-event-source-image`
and `CodeQL` results on its current commit. A result from an earlier commit does not clear the gate.
Fork contributions require maintainer review before their code runs on a trusted worker.
