#!/usr/bin/env bash
# Subjob implementations for scripts/local-ci.sh. Each subjob reproduces the GitHub Actions steps named in
# docs/LOCAL_CI.md; keep both in step until those workflows are retired. The orchestrator supplies LCI_*
# variables, runs one subjob per process group and treats any non-zero exit as a failure.
# Compatible with Bash 3.2 so contributors can run the fixture tests on macOS.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
cd "$root"
umask 077

readonly trivy_version="0.70.0"
readonly codeql_version="2.27.1"
readonly codeql_suite="codeql/javascript-queries:codeql-suites/javascript-code-scanning.qls"
readonly codeql_category="/language:javascript-typescript"
readonly buildx_version="v0.34.1"
readonly buildx_sha256="f1332ddb9010bd0b72628266c3a906d9a6979848033df4c8d9bd2cd113bae12b"
readonly buildkit_image="moby/buildkit:v0.30.0@sha256:0168606be2315b7c807a03b3d8aa79beefdb31c98740cebdffdfeebf31190c9f"
readonly image_path="jremick/moodarr"
readonly public_source_url="https://github.com/jremick/moodarr"
readonly image_repository="ghcr.io/jremick/moodarr"
readonly publish_signer_workflow="jremick/moodarr/.github/workflows/publish-image.yml"
readonly validator_owner_labels="io.moodarr.beta-install.owner dev.moodarr.beta-upgrade-owner"
readonly manifest_accept="application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json"
readonly trust_policy_path=".github/release-trust.json"
readonly cosign_version="v3.1.3"
readonly sbom_generator="docker/buildkit-syft-scanner:stable-1@sha256:79e7b013cbec16bbb436f312819a49a4a57752b2270c1a9332ae1a10fcc82a68"
readonly validations="clean-install alpha21-upgrade-rollback beta1-upgrade-rollback beta2-upgrade-rollback beta3-upgrade-rollback beta4-upgrade-rollback beta5-upgrade-rollback beta6-upgrade-rollback"

fail() {
  echo "local-ci: $*" >&2
  exit 1
}

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "required tool '$1' is not on PATH"
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{ print $1 }'
  else
    shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

subjob_dir() {
  : "${LCI_SUBJOB_DIR:?LCI_SUBJOB_DIR is required}"
  mkdir -p "$LCI_SUBJOB_DIR"
  printf '%s' "$LCI_SUBJOB_DIR"
}

work_dir() {
  local base="${LCI_WORK_DIR:-${TMPDIR:-/tmp}}"
  mktemp -d "$base/moodarr-lci.XXXXXX"
}

run_id() {
  local value="${LCI_RUN_ID:-}"
  [[ "$value" =~ ^[a-z0-9][a-z0-9-]{6,46}[a-z0-9]$ ]] || fail "LCI_RUN_ID must be 8-48 lowercase letters, digits or hyphens"
  printf '%s' "$value"
}

source_sha() {
  local value="${LCI_SOURCE_SHA:-}"
  [[ "$value" =~ ^[0-9a-f]{40}$ ]] || fail "Event source must be a full lowercase commit SHA."
  printf '%s' "$value"
}

require_head() {
  local expected="$1" resolved
  resolved="$(git rev-parse HEAD)"
  [[ "$resolved" == "$expected" ]] || fail "Checked-out source $resolved does not match $expected."
}

require_clean_tree() {
  [[ -z "$(git status --porcelain)" ]] || fail "The source tree must be clean."
}

main_sha() {
  local value="${LCI_MAIN_SHA:-}"
  [[ "$value" =~ ^[0-9a-f]{40}$ ]] || fail "LCI_MAIN_SHA must be the full lowercase main commit SHA."
  printf '%s' "$value"
}

candidate_digest() {
  local value="${LCI_CANDIDATE_DIGEST:-}"
  [[ "$value" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "candidate_digest must be sha256:<64 lowercase hex>."
  printf '%s' "$value"
}

package_version() {
  node -p "require('./package.json').version"
}

sha256_base64() {
  node -e 'process.stdout.write(require("crypto").createHash("sha256").update(require("fs").readFileSync(process.argv[1])).digest("base64"))' "$1"
}

scan_tag() { printf 'moodarr-local-ci:%s-scan' "$(run_id)"; }
native_tag() { printf 'moodarr-local-ci:%s-native' "$(run_id)"; }
builder_name() { printf 'moodarr-lci-%s' "$(run_id)"; }

require_trivy() {
  require_tool trivy
  local output version
  output="$(trivy --version)"
  version="$(awk 'NR == 1 && $1 == "Version:" { print $2 }' <<<"$output")"
  [[ "$version" == "$trivy_version" ]] || fail "Trivy $trivy_version is required; found ${version:-an unknown version}."
}

require_main_ancestry() {
  local source="$1" main="$2"
  git cat-file -e "$main^{commit}" 2>/dev/null || fail "Main commit $main is not present in this checkout; fetch main history first."
  git merge-base --is-ancestor "$source" "$main" || fail "Source $source is not reachable from main $main."
}

expected_codes() {
  # Same export reads as the workflow steps.
  local module="$1" name="$2"
  ./node_modules/.bin/tsx --eval "import { $name } from \"./scripts/$module.ts\"; process.stdout.write(JSON.stringify([...$name].sort()));"
}

validator_script() {
  case "$1" in
    clean-install) echo "validate:beta-install" ;;
    alpha21-upgrade-rollback) echo "validate:beta-upgrade" ;;
    beta[1-6]-upgrade-rollback) echo "validate:${1%%-*}-upgrade" ;;
    *) fail "Unknown validation $1." ;;
  esac
}

load_expected_checks() {
  case "$1" in
    clean-install) LCI_EXPECTED_CHECKS="$(expected_codes validate-beta-install requiredInstallModeCheckCodes)" ;;
    alpha21-upgrade-rollback) LCI_EXPECTED_CHECKS="$(expected_codes validate-beta-upgrade requiredUpgradeCheckCodes)" ;;
    beta[1-6]-upgrade-rollback) LCI_EXPECTED_CHECKS="$(expected_codes validate-beta-install "${1%%-*}UpgradeCheckCodes")" ;;
    *) fail "Unknown validation $1." ;;
  esac
  LCI_EXPECTED_LIFECYCLE_CHECKS="$(expected_codes validate-beta-install requiredInstallModeCheckCodes)"
  export LCI_EXPECTED_CHECKS LCI_EXPECTED_LIFECYCLE_CHECKS
}

# check-report <validation> <rehearsal|official> <report> <validator-exit>
# A rehearsal must exit 1 (behaviourally successful, release-ineligible); official proof must exit 0.
# The exit code alone is never accepted: the complete report contract must also hold.
check_report() {
  local validation="$1" mode="$2" report="$3" validator_exit="$4" expected_count required_exit program
  case "$validation" in
    clean-install) expected_count=25 ;;
    alpha21-upgrade-rollback) expected_count=107 ;;
    beta[1-6]-upgrade-rollback) expected_count=7 ;;
    *) fail "Unknown validation $validation." ;;
  esac
  case "$mode" in
    rehearsal) required_exit=1 ;;
    official) required_exit=0 ;;
    *) fail "Unknown report mode $mode." ;;
  esac
  [[ "$validator_exit" =~ ^[0-9]+$ ]] || fail "Validator exit status is not numeric."
  if [[ "$validator_exit" -ne "$required_exit" ]]; then
    if [[ "$mode" == rehearsal ]]; then
      fail "Local rehearsal must finish behaviorally successful but release-ineligible with exit 1; got $validator_exit."
    fi
    fail "Official candidate validation must exit 0; got $validator_exit."
  fi
  [[ -s "$report" ]] || fail "The $validation validator produced no report."
  : "${LCI_EXPECTED_CHECKS:?LCI_EXPECTED_CHECKS is required}"
  [[ "$(jq 'length' <<<"$LCI_EXPECTED_CHECKS")" -eq "$expected_count" ]] || fail "Expected $expected_count $validation check codes."
  program="$root/scripts/local-ci/contracts/$mode-$validation.jq"
  [[ -f "$program" ]] || fail "No $mode contract exists for $validation."
  jq -e \
    --arg version "${LCI_EXPECTED_VERSION:-}" \
    --arg revision "${LCI_EXPECTED_REVISION:-}" \
    --arg image "${LCI_EXPECTED_IMAGE:-}" \
    --arg digest "${LCI_EXPECTED_DIGEST:-}" \
    --argjson expectedChecks "$LCI_EXPECTED_CHECKS" \
    --argjson expectedLifecycleChecks "${LCI_EXPECTED_LIFECYCLE_CHECKS:-[]}" \
    -f "$program" "$report" >/dev/null \
    || fail "The $validation report does not satisfy the $mode contract."
}

# Mirrors ci.yml "Prove validator-owned resources are absent", but reports every kind and treats an
# unreadable Docker listing as a failure instead of as an empty list.
prove_validator_resources_absent() {
  local owner_label listing status=0
  for owner_label in $validator_owner_labels; do
    listing="$(docker ps -a --filter "label=$owner_label" --format '{{.ID}}')" || { echo "Cannot list validator-owned containers." >&2; status=1; listing=""; }
    if [[ -n "$listing" ]]; then echo "Validator-owned container cleanup is incomplete." >&2; status=1; fi
    listing="$(docker volume ls --filter "label=$owner_label" --format '{{.Name}}')" || { echo "Cannot list validator-owned volumes." >&2; status=1; listing=""; }
    if [[ -n "$listing" ]]; then echo "Validator-owned volume cleanup is incomplete." >&2; status=1; fi
    listing="$(docker network ls --filter "label=$owner_label" --format '{{.ID}}')" || { echo "Cannot list validator-owned networks." >&2; status=1; listing=""; }
    if [[ -n "$listing" ]]; then echo "Validator-owned network cleanup is incomplete." >&2; status=1; fi
  done
  return "$status"
}

inspect_label() {
  docker image inspect --format "{{ index .Config.Labels \"$2\" }}" "$1"
}

# --- verify -----------------------------------------------------------------------------------------

job_install() {
  require_tool npm
  echo "node $(node --version); npm $(npm --version)"
  npm ci
}

job_audit() {
  require_tool npm
  npm audit
}

job_dependency_audit() {
  require_tool npm
  npm audit --audit-level=high
}

job_verify_release() {
  require_tool npm
  MOODARR_SECRETS_REQUIRE_BUILD=true npm run verify:release
}

# ci.yml "Scan exact event source image" (also release-verify.yml and security-scheduled.yml container scans).
job_container_scan() {
  require_tool docker
  require_tool jq
  require_trivy
  local SOURCE_SHA evidence_dir tag package_version image_id image_revision ai_policy tmdb_policy
  SOURCE_SHA="$(source_sha)"
  require_head "$SOURCE_SHA"
  evidence_dir="$(subjob_dir)"
  tag="$(scan_tag)"

  package_version="$(package_version)"
  docker build \
    --build-arg "MOODARR_VERSION=$package_version" \
    --build-arg "MOODARR_BUILD_REVISION=$SOURCE_SHA" \
    --build-arg "MOODARR_BUILD_AI_PROVIDER_POLICY=none" \
    --build-arg "MOODARR_BUILD_TMDB_CONTENT_POLICY=none" \
    --tag "$tag" \
    .

  image_id="$(docker image inspect --format '{{.Id}}' "$tag")"
  image_revision="$(inspect_label "$tag" org.opencontainers.image.revision)"
  ai_policy="$(inspect_label "$tag" io.moodarr.ai-provider-policy)"
  tmdb_policy="$(inspect_label "$tag" io.moodarr.tmdb-content-policy)"
  [[ "$image_revision" == "$SOURCE_SHA" ]] || fail "Image revision label $image_revision does not match $SOURCE_SHA."
  [[ "$ai_policy" == "none" ]] || fail "Image AI provider policy must be none."
  [[ "$tmdb_policy" == "none" ]] || fail "Image TMDB content policy must be none."
  jq -n \
    --arg schemaVersion moodarr-container-scan-v2 \
    --arg sourceRevision "$SOURCE_SHA" \
    --arg packageVersion "$package_version" \
    --arg imageId "$image_id" \
    --arg aiProviderPolicy "$ai_policy" \
    --arg tmdbContentPolicy "$tmdb_policy" \
    '{schemaVersion: $schemaVersion, sourceRevision: $sourceRevision, packageVersion: $packageVersion, imageId: $imageId, policies: {aiProvider: $aiProviderPolicy, tmdbContent: $tmdbContentPolicy}}' \
    > "$evidence_dir/image-identity.json"

  trivy --version > "$evidence_dir/trivy-version.txt"
  trivy image \
    --scanners vuln \
    --severity HIGH,CRITICAL \
    --format json \
    --output "$evidence_dir/trivy-high-critical.json" \
    --exit-code 0 \
    --vex .vex/moodarr.openvex.json \
    "$tag"
  jq -r '
    [.Results[]?.Vulnerabilities[]?]
    | unique_by([.VulnerabilityID, .PkgName])
    | if length == 0 then
        "No unsuppressed high or critical runtime findings."
      else
        .[] | "\(.Severity) \(.VulnerabilityID) package=\(.PkgName) status=\(.Status // "unknown") fixed=\(.FixedVersion // "unavailable")"
      end
  ' "$evidence_dir/trivy-high-critical.json"
  trivy image \
    --scanners vuln \
    --severity HIGH,CRITICAL \
    --ignore-unfixed \
    --format json \
    --output "$evidence_dir/trivy-actionable.json" \
    --exit-code 1 \
    --vex .vex/moodarr.openvex.json \
    "$tag" \
    || fail "Fixable high or critical runtime findings remain."
}

# ci.yml native-source-validation "Build and inspect exact local linux-amd64 image", built once per run.
job_native_image() {
  require_tool docker
  require_tool jq
  local SOURCE_SHA evidence_dir image_tag package_version image_id image_os image_arch image_version image_revision ai_policy tmdb_policy daemon
  SOURCE_SHA="$(source_sha)"
  require_head "$SOURCE_SHA"
  require_clean_tree
  evidence_dir="$(subjob_dir)"
  package_version="$(package_version)"
  image_tag="$(native_tag)"

  docker build \
    --platform linux/amd64 \
    --build-arg "MOODARR_VERSION=$package_version" \
    --build-arg "MOODARR_BUILD_REVISION=$SOURCE_SHA" \
    --build-arg "MOODARR_BUILD_AI_PROVIDER_POLICY=none" \
    --build-arg "MOODARR_BUILD_TMDB_CONTENT_POLICY=none" \
    --tag "$image_tag" \
    .

  image_id="$(docker image inspect --format '{{.Id}}' "$image_tag")"
  image_os="$(docker image inspect --format '{{.Os}}' "$image_tag")"
  image_arch="$(docker image inspect --format '{{.Architecture}}' "$image_tag")"
  image_version="$(inspect_label "$image_tag" org.opencontainers.image.version)"
  image_revision="$(inspect_label "$image_tag" org.opencontainers.image.revision)"
  ai_policy="$(inspect_label "$image_tag" io.moodarr.ai-provider-policy)"
  tmdb_policy="$(inspect_label "$image_tag" io.moodarr.tmdb-content-policy)"
  daemon="$(docker info --format '{{.OSType}}/{{.Architecture}}')"

  [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "Native image ID is not a sha256 digest."
  [[ "$image_os" == "linux" ]] || fail "Native image OS must be linux."
  [[ "$image_arch" == "amd64" ]] || fail "Native image architecture must be amd64."
  [[ "$image_version" == "$package_version" ]] || fail "Native image version label does not match package.json."
  [[ "$image_revision" == "$SOURCE_SHA" ]] || fail "Native image revision label does not match the source."
  [[ "$ai_policy" == "none" ]] || fail "Native image AI provider policy must be none."
  [[ "$tmdb_policy" == "none" ]] || fail "Native image TMDB content policy must be none."
  require_clean_tree

  jq -cn \
    --arg sourceRevision "$SOURCE_SHA" \
    --arg packageVersion "$package_version" \
    --arg imageId "$image_id" \
    --arg os "$image_os" \
    --arg architecture "$image_arch" \
    --arg daemon "$daemon" \
    '{schema: "moodarr-native-source-image-build-v1", sourceRevision: $sourceRevision, packageVersion: $packageVersion, imageId: $imageId, platform: {os: $os, architecture: $architecture}, daemon: $daemon}' \
    > "$evidence_dir/image-build.json"
}

# ci.yml native-source-validation "Run and validate release-ineligible native rehearsal" for one matrix value.
job_native() {
  local VALIDATION="$1"
  require_tool docker
  require_tool jq
  require_tool npm
  local SOURCE_SHA evidence_dir LOCAL_IMAGE PACKAGE_VERSION image_id built_id script report_path validator_exit status=0
  SOURCE_SHA="$(source_sha)"
  require_head "$SOURCE_SHA"
  require_clean_tree
  evidence_dir="$(subjob_dir)"
  LOCAL_IMAGE="$(native_tag)"
  PACKAGE_VERSION="$(package_version)"
  script="$(validator_script "$VALIDATION")"

  image_id="$(docker image inspect --format '{{.Id}}' "$LOCAL_IMAGE")"
  built_id="$(jq -r '.imageId' "${LCI_EVIDENCE_DIR:?}/native-image/image-build.json")"
  [[ "$image_id" == "$built_id" ]] || fail "Native image $LOCAL_IMAGE changed after it was built."
  jq -cn \
    --arg schema moodarr-native-source-image-v1 \
    --arg validation "$VALIDATION" \
    --arg sourceRevision "$SOURCE_SHA" \
    --arg packageVersion "$PACKAGE_VERSION" \
    --arg imageId "$image_id" \
    --arg os "$(docker image inspect --format '{{.Os}}' "$LOCAL_IMAGE")" \
    --arg architecture "$(docker image inspect --format '{{.Architecture}}' "$LOCAL_IMAGE")" \
    --arg aiProvider "$(inspect_label "$LOCAL_IMAGE" io.moodarr.ai-provider-policy)" \
    --arg tmdbContent "$(inspect_label "$LOCAL_IMAGE" io.moodarr.tmdb-content-policy)" \
    '{schema: $schema, validation: $validation, sourceRevision: $sourceRevision, packageVersion: $packageVersion, imageId: $imageId, platform: {os: $os, architecture: $architecture}, policies: {aiProvider: $aiProvider, tmdbContent: $tmdbContent}}' \
    > "$evidence_dir/image-identity.json"

  load_expected_checks "$VALIDATION"
  report_path="$evidence_dir/report.json"
  set +e
  npm run --silent "$script" -- \
    --candidate-image "$LOCAL_IMAGE" \
    --expected-version "$PACKAGE_VERSION" \
    --expected-revision "$SOURCE_SHA" \
    --allow-local-image \
    > "$report_path"
  validator_exit=$?
  set -e
  echo "Validator $script exited $validator_exit."

  # errexit is ignored inside a subshell on the left of ||, so capture the status explicitly.
  set +e
  (
    set -e
    LCI_EXPECTED_VERSION="$PACKAGE_VERSION" LCI_EXPECTED_REVISION="$SOURCE_SHA" LCI_EXPECTED_IMAGE="$LOCAL_IMAGE" LCI_EXPECTED_DIGEST="" \
      check_report "$VALIDATION" rehearsal "$report_path" "$validator_exit"
  )
  status=$?
  set -e
  prove_validator_resources_absent || status=1
  return "$status"
}

# codeql.yml "Analyze JavaScript and TypeScript" (build-mode none, default code-scanning suite).
job_codeql() {
  require_tool codeql
  require_tool jq
  local SOURCE_SHA evidence_dir scratch version raw sarif result_count
  SOURCE_SHA="$(git rev-parse HEAD)"
  evidence_dir="$(subjob_dir)"
  version="$(codeql version --format=json | jq -r '.version')"
  [[ "$version" == "$codeql_version" ]] || fail "CodeQL CLI $codeql_version is required; found ${version:-an unknown version}."
  scratch="$(work_dir)"
  raw="$scratch/results.sarif"
  sarif="$evidence_dir/results.sarif"
  codeql database create "$scratch/database" --language=javascript-typescript --build-mode=none --source-root="$root" --threads=0
  codeql database analyze "$scratch/database" "$codeql_suite" --format=sarifv2.1.0 --output="$raw" --sarif-category="$codeql_category" --threads=0
  jq -e '(.runs | type == "array" and length > 0) and all(.runs[]; .tool.driver.name == "CodeQL")' "$raw" >/dev/null \
    || fail "CodeQL did not produce a CodeQL SARIF run."
  # Drop absolute query-pack and checkout URIs so the SARIF can be uploaded without host paths.
  jq -c 'del(.runs[].tool.extensions[]?.locations, .runs[].originalUriBaseIds)' "$raw" > "$sarif"
  rm -rf "$scratch"
  if grep -q 'file://' "$sarif"; then fail "The upload SARIF still contains absolute file URIs."; fi
  result_count="$(jq '[.runs[].results[]?] | length' "$sarif")"
  jq -n \
    --arg sourceRevision "$SOURCE_SHA" \
    --arg codeqlVersion "$version" \
    --arg querySuite "$codeql_suite" \
    --arg category "$codeql_category" \
    --arg sarifSha256 "$(sha256_file "$sarif")" \
    --argjson resultCount "$result_count" \
    '{schemaVersion: "moodarr-local-codeql-v1", sourceRevision: $sourceRevision, codeqlVersion: $codeqlVersion, language: "javascript-typescript", buildMode: "none", querySuite: $querySuite, category: $category, sarifSha256: $sarifSha256, resultCount: $resultCount}' \
    > "$evidence_dir/codeql-summary.json"
  [[ "$result_count" == 0 ]] || fail "CodeQL reported $result_count result(s); the release criteria require a zero-result analysis."
}

# --- release-check gates ----------------------------------------------------------------------------

check_revocations() {
  local policy="$1" revision="$2" digest="$3" label="$4"
  jq -e -s '
    length == 1
      and (.[0] | type == "object")
      and (.[0] | keys == ["candidates", "schemaVersion"])
      and .[0].schemaVersion == "moodarr-release-revocations-v1"
      and (.[0].candidates | type == "array" and length > 0)
      and all(.[0].candidates[];
        type == "object"
          and keys == ["digest", "reason", "revision"]
          and (.revision | type == "string" and test("^[0-9a-f]{40}$"))
          and (.digest | type == "string" and test("^sha256:[0-9a-f]{64}$"))
          and (.reason | type == "string" and length > 0 and length <= 500)
      )
      and ([.[0].candidates[].revision] | length == (unique | length))
      and ([.[0].candidates[].digest] | length == (unique | length))
  ' "$policy" >/dev/null || fail "The $label release revocation policy is malformed."
  if jq -e -s \
      --arg revision "$revision" \
      --arg digest "$digest" '
        any(.[0].candidates[];
          .revision == $revision
            or ($digest != "" and .digest == $digest)
        )
      ' "$policy" >/dev/null; then
    fail "The supplied release revision or digest is revoked by the $label policy and cannot be published or promoted."
  fi
}

# release-verify.yml "Prove release source is reachable from current main".
job_release_source() {
  local SOURCE_SHA MAIN_SHA resolved_sha
  SOURCE_SHA="$(source_sha)"
  MAIN_SHA="$(main_sha)"
  resolved_sha="$(git rev-parse HEAD)"
  [[ "$resolved_sha" =~ ^[0-9a-f]{40}$ ]] || fail "Checkout did not resolve to a full lowercase commit SHA."
  [[ "$resolved_sha" == "$SOURCE_SHA" ]] || fail "Checked-out release source $resolved_sha does not match requested revision $SOURCE_SHA."
  require_main_ancestry "$resolved_sha" "$MAIN_SHA"
  jq -n --arg source "$resolved_sha" --arg main "$MAIN_SHA" \
    '{schemaVersion: "moodarr-local-release-source-v1", sourceRevision: $source, mainRevision: $main, reachableFromMain: true, sourceIsMainHead: ($source == $main)}' \
    > "$(subjob_dir)/release-source.json"
}

# publish-image.yml authorization gates that do not need registry or repository credentials:
# strict beta SemVer, release-copy readiness and two-point revocation (source and current main).
job_release_policy() {
  require_tool jq
  local SOURCE_SHA MAIN_SHA digest package_version release_tag scratch trust_policy
  SOURCE_SHA="$(source_sha)"
  MAIN_SHA="$(main_sha)"
  require_head "$SOURCE_SHA"
  digest="${LCI_CANDIDATE_DIGEST:-}"
  if [[ -n "$digest" && ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]]; then
    fail "Semantic promotion requires the exact validated candidate_digest."
  fi

  package_version="$(package_version)"
  node - "$package_version" <<'NODE'
const version = process.argv[2];
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?$/;
const parsed = semver.exec(version);
if (!parsed) {
  console.error(`package.json version is not a strict SemVer version: ${version}`);
  process.exit(1);
}
if (!/^beta\.(0|[1-9]\d*)$/.test(parsed[4] ?? "")) {
  console.error(`This workflow publishes beta prereleases only; package.json version is ${version}`);
  process.exit(1);
}
NODE
  release_tag="v$package_version"
  if grep -Fq "## $package_version - Unreleased" CHANGELOG.md \
      || grep -Fq "Moodarr is targeting \`$release_tag\`" README.md \
      || grep -Fq "Early public beta candidate" README.md \
      || grep -Fq "does not exist until the prerelease gate passes" README.md \
      || grep -Fq "beta.1 tag below is a promotion target" docs/UNRAID.md \
      || grep -Fq "The target is not published" docs/RELEASE.md \
      || grep -Fq "Until the first beta is published" docs/COMPATIBILITY.md \
      || grep -Fq "No public beta has been published yet" SECURITY.md \
      || grep -Fq "No public beta has been published yet" SUPPORT.md; then
    fail "Release copy still marks $release_tag as an unpublished candidate; fix it before publishing a versioned SHA candidate."
  fi

  check_revocations .github/release-revocations.json "$SOURCE_SHA" "$digest" "source"
  scratch="$(work_dir)"
  git show "$MAIN_SHA:.github/release-revocations.json" > "$scratch/main-revocations.json" \
    || fail "Cannot read the release revocation policy at main $MAIN_SHA."
  check_revocations "$scratch/main-revocations.json" "$SOURCE_SHA" "$digest" "current main"
  load_trust_policy "$SOURCE_SHA" "$scratch/source-trust.json"
  load_trust_policy "$MAIN_SHA" "$scratch/main-trust.json"
  trust_policy="$(resolve_trust_policy "$scratch/main-trust.json" "$(beta_number "$package_version")")"
  rm -rf "$scratch"

  jq -n \
    --arg packageVersion "$package_version" \
    --arg releaseTag "$release_tag" \
    --arg candidateTag "sha-$SOURCE_SHA" \
    --arg candidateDigest "$digest" \
    --arg trustPolicy "$trust_policy" \
    '{schemaVersion: "moodarr-local-release-policy-v1", packageVersion: $packageVersion, releaseTag: $releaseTag, candidateTag: $candidateTag, candidateDigest: (if $candidateDigest == "" then null else $candidateDigest end), revocationPolicies: ["source", "main"], releaseCopyReady: true, trustPolicy: $trustPolicy}' \
    > "$(subjob_dir)/release-policy.json"
}

# --- candidate-check --------------------------------------------------------------------------------

# validate-beta-candidate.yml "Validate immutable candidate input" and "Prove candidate source is reachable
# from current main".
job_candidate_source() {
  local EXPECTED_REVISION CANDIDATE_DIGEST MAIN_SHA resolved_revision
  CANDIDATE_DIGEST="$(candidate_digest)"
  EXPECTED_REVISION="$(source_sha)"
  MAIN_SHA="$(main_sha)"
  resolved_revision="$(git rev-parse HEAD)"
  [[ "$resolved_revision" == "$EXPECTED_REVISION" ]] || fail "Checked-out candidate $resolved_revision does not match requested revision $EXPECTED_REVISION."
  require_main_ancestry "$EXPECTED_REVISION" "$MAIN_SHA"
  jq -n --arg revision "$EXPECTED_REVISION" --arg main "$MAIN_SHA" --arg image "$image_repository@$CANDIDATE_DIGEST" \
    '{schemaVersion: "moodarr-local-candidate-source-v1", expectedRevision: $revision, mainRevision: $main, candidateImage: $image, reachableFromMain: true}' \
    > "$(subjob_dir)/candidate-source.json"
}

parse_ghcr_token() {
  jq -er -s '
    if length != 1 or (.[0] | type) != "object" then
      error("GHCR token response must contain exactly one JSON object")
    else
      .[0].token
      | if type != "string" then
          error("GHCR token response token must be a string")
        elif length == 0 or length > 16384 then
          error("GHCR token response token length is invalid")
        elif contains("\r") or contains("\n") then
          error("GHCR token response token shape is invalid")
        elif (test("^[A-Za-z0-9._~+/-]+={0,2}$") | not) then
          error("GHCR token response token shape is invalid")
        else
          .
        end
    end
  ' "$1"
}

header_value() {
  awk -F ': ' -v name="$2" 'tolower($1) == name { sub(/\r$/, "", $2); print $2 }' "$1" | tail -1
}

# validate-beta-candidate.yml "Verify anonymous public candidate pull". The anonymous token is never printed.
job_anonymous_pull() {
  require_tool curl
  require_tool jq
  local CANDIDATE_DIGEST CANDIDATE_IMAGE evidence_dir temporary_dir manifest headers token_response anonymous_token media_type registry_digest computed_digest
  CANDIDATE_DIGEST="$(candidate_digest)"
  CANDIDATE_IMAGE="$image_repository@$CANDIDATE_DIGEST"
  evidence_dir="$(subjob_dir)"
  temporary_dir="$(work_dir)"
  trap 'rm -rf "$temporary_dir"' RETURN
  manifest="$temporary_dir/manifest.json"
  headers="$temporary_dir/headers.txt"
  token_response="$temporary_dir/token.json"
  local curl_retry=(--connect-timeout 10 --max-time 30 --retry 3 --retry-delay 1 --retry-max-time 60 --retry-all-errors)

  curl "${curl_retry[@]}" --fail-with-body --silent --show-error --get \
    --data-urlencode "service=ghcr.io" \
    --data-urlencode "scope=repository:${image_path}:pull" \
    --output "$token_response" \
    https://ghcr.io/token
  anonymous_token="$(parse_ghcr_token "$token_response")"
  curl "${curl_retry[@]}" --fail-with-body --silent --show-error \
    --header "Authorization: Bearer $anonymous_token" \
    --header "Accept: $manifest_accept" \
    --dump-header "$headers" \
    --output "$manifest" \
    "https://ghcr.io/v2/${image_path}/manifests/${CANDIDATE_DIGEST}"

  media_type="$(header_value "$headers" content-type)"
  registry_digest="$(header_value "$headers" docker-content-digest)"
  computed_digest="sha256:$(sha256_file "$manifest")"
  if [[ "$media_type" != "application/vnd.oci.image.index.v1+json" ]] \
      || [[ "$registry_digest" != "$CANDIDATE_DIGEST" ]] \
      || [[ "$computed_digest" != "$CANDIDATE_DIGEST" ]]; then
    fail "Anonymous GHCR pull did not return the exact public candidate OCI index."
  fi

  jq -n \
    --arg candidateImage "$CANDIDATE_IMAGE" \
    --arg candidateDigest "$CANDIDATE_DIGEST" \
    --arg registryDigest "$registry_digest" \
    --arg manifestMediaType "$media_type" \
    '{
      schemaVersion: "moodarr-anonymous-candidate-pull-v1",
      candidateImage: $candidateImage,
      candidateDigest: $candidateDigest,
      registryDigest: $registryDigest,
      manifestMediaType: $manifestMediaType,
      anonymousPullVerified: true
    }' > "$evidence_dir/anonymous-pull.json"
}

# --- release trust ----------------------------------------------------------------------------------
# .github/release-trust.json maps each beta version to exactly one signer policy. It is always read from the
# supplied main commit, never from the candidate source, so a source change cannot downgrade its own trust.

beta_number() {
  [[ "$1" =~ ^0\.1\.0-beta\.([1-9][0-9]*)$ ]] || fail "Release trust is defined only for 0.1.0-beta.N versions; got $1."
  printf '%s' "${BASH_REMATCH[1]}"
}

load_trust_policy() {
  local commit="$1" destination="$2"
  git show "$commit:$trust_policy_path" > "$destination" 2>/dev/null || fail "Cannot read $trust_policy_path at $commit."
  jq -e -s '
    length == 1
    and (.[0] | type == "object")
    and (.[0] | keys == ["localSigner", "rules", "schemaVersion"])
    and .[0].schemaVersion == "moodarr-release-trust-v1"
    and (.[0].rules | type == "array" and length > 0)
    and all(.[0].rules[];
      type == "object"
      and keys == ["fromBeta", "policy", "throughBeta"]
      and (.fromBeta | type == "number" and . >= 1 and . == floor)
      and (.throughBeta == null or ((.throughBeta | type == "number") and .throughBeta == (.throughBeta | floor) and .throughBeta >= .fromBeta))
      and (.policy == "github-hosted" or .policy == "local-signer")
    )
    and ((.[0].rules | sort_by(.fromBeta)) as $rules
      | [range(1; $rules | length) | $rules[. - 1].throughBeta != null and $rules[.].fromBeta > $rules[. - 1].throughBeta] | all)
    and (.[0].localSigner | type == "object" and keys == ["buildType", "builderId", "keys", "sourceUri"])
    and (.[0].localSigner.builderId | type == "string" and test("^https://[^[:space:]]+$"))
    and (.[0].localSigner.buildType | type == "string" and test("^https://[^[:space:]]+$"))
    and .[0].localSigner.sourceUri == "git+https://github.com/jremick/moodarr@refs/heads/main"
    and (.[0].localSigner.keys | type == "array")
    and all(.[0].localSigner.keys[];
      type == "object"
      and keys == ["id", "publicKey", "publicKeyPemSha256", "status"]
      and (.id | type == "string" and test("^[a-z0-9][a-z0-9.-]{0,62}$"))
      and (.publicKey | type == "string" and test("^\\.github/release-signers/[a-z0-9][a-z0-9.-]{0,62}\\.pub$"))
      and (.publicKeyPemSha256 | type == "string" and test("^[0-9a-f]{64}$"))
      and (.status == "active" or .status == "revoked")
    )
    and ([.[0].localSigner.keys[].id] | length == (unique | length))
  ' "$destination" >/dev/null || fail "The release trust policy at $commit is malformed."
}

resolve_trust_policy() {
  jq -er --argjson beta "$2" '
    [.rules[] | select(.fromBeta <= $beta and (.throughBeta == null or $beta <= .throughBeta))]
    | if length == 1 then .[0].policy else error("no single trust rule") end
  ' "$1" 2>/dev/null || fail "The release trust policy does not assign exactly one signer policy to beta.$2."
}

# Writes the active pinned keys from main into <directory>/key-<n>.pub after checking every pin first.
materialize_pinned_keys() {
  local trust_file="$1" main="$2" directory="$3" count index=0 path pin id
  count="$(jq '[.localSigner.keys[] | select(.status == "active")] | length' "$trust_file")"
  [[ "$count" -gt 0 ]] || fail "The release trust policy at main has no active signer key."
  while [[ "$index" -lt "$count" ]]; do
    id="$(jq -r --argjson i "$index" '[.localSigner.keys[] | select(.status == "active")][$i].id' "$trust_file")"
    path="$(jq -r --argjson i "$index" '[.localSigner.keys[] | select(.status == "active")][$i].publicKey' "$trust_file")"
    pin="$(jq -r --argjson i "$index" '[.localSigner.keys[] | select(.status == "active")][$i].publicKeyPemSha256' "$trust_file")"
    git show "$main:$path" > "$directory/key-$index.pub" 2>/dev/null || fail "Signer key $id is missing at main."
    [[ "$(sha256_file "$directory/key-$index.pub")" == "$pin" ]] || fail "Signer key $id at main does not match its pinned SHA-256."
    index=$((index + 1))
  done
  printf '%s' "$count"
}

require_cosign() {
  require_tool cosign
  local found
  found="$(cosign version --json 2>/dev/null | jq -r '.gitVersion // empty' 2>/dev/null || true)"
  [[ "$found" == "$cosign_version" ]] || fail "cosign $cosign_version is required; found ${found:-an unknown version}."
}

# Verifies a statement signed by an active pinned key, logged in the transparency log and bound to the
# candidate digest, main-branch source revision, package version, candidate tag, build type and builder.
verify_local_signer() {
  local trust_file="$1" main="$2" statement="$3" bundle="$4" digest="$5" revision="$6" version="$7" evidence_dir="$8"
  local scratch count index=0 verified_index="" key_id key_pin log_index
  [[ -n "$statement" && -f "$statement" && -n "$bundle" && -f "$bundle" ]] \
    || fail "Version $version is pinned to the local release signer; supply the signed statement and its Sigstore bundle."
  require_cosign
  scratch="$(work_dir)"
  jq -e --arg digest "$(sha256_base64 "$statement")" '
    (.mediaType | type == "string" and startswith("application/vnd.dev.sigstore.bundle"))
    and (.verificationMaterial.tlogEntries | type == "array" and length > 0)
    and all(.verificationMaterial.tlogEntries[]; .inclusionProof != null and .logIndex != null)
    and .messageSignature.messageDigest.algorithm == "SHA2_256"
    and .messageSignature.messageDigest.digest == $digest
  ' "$bundle" >/dev/null || { rm -rf "$scratch"; fail "The Sigstore bundle is not a transparency-logged signature over this statement."; }
  count="$(materialize_pinned_keys "$trust_file" "$main" "$scratch")" || { rm -rf "$scratch"; exit 1; }
  while [[ "$index" -lt "$count" ]]; do
    if env -u COSIGN_PASSWORD -u LOCAL_RELEASE_GHCR_TOKEN cosign verify-blob --key "$scratch/key-$index.pub" --bundle "$bundle" "$statement" >/dev/null 2>"$scratch/cosign-$index.err"; then
      verified_index="$index"
      break
    fi
    index=$((index + 1))
  done
  rm -rf "$scratch"
  [[ -n "$verified_index" ]] || fail "The release statement is not signed by an active pinned key."
  jq -e \
    --arg digest "${digest#sha256:}" \
    --arg revision "$revision" \
    --arg version "$version" \
    --arg builderId "$(jq -r '.localSigner.builderId' "$trust_file")" \
    --arg buildType "$(jq -r '.localSigner.buildType' "$trust_file")" \
    --arg sourceUri "$(jq -r '.localSigner.sourceUri' "$trust_file")" '
      ._type == "https://in-toto.io/Statement/v1"
      and .predicateType == "https://slsa.dev/provenance/v1"
      and .subject == [{name: "ghcr.io/jremick/moodarr", digest: {sha256: $digest}}]
      and .predicate.buildDefinition.buildType == $buildType
      and .predicate.buildDefinition.externalParameters.source == {uri: $sourceUri, digest: {gitCommit: $revision}}
      and .predicate.buildDefinition.externalParameters.releaseMode == "candidate"
      and .predicate.buildDefinition.externalParameters.packageVersion == $version
      and .predicate.buildDefinition.externalParameters.candidateTag == ("sha-" + $revision)
      and .predicate.runDetails.builder.id == $builderId
    ' "$statement" >/dev/null || fail "The signed release statement does not bind this digest, source, ref, version and builder."
  key_id="$(jq -r --argjson i "$verified_index" '[.localSigner.keys[] | select(.status == "active")][$i].id' "$trust_file")"
  key_pin="$(jq -r --argjson i "$verified_index" '[.localSigner.keys[] | select(.status == "active")][$i].publicKeyPemSha256' "$trust_file")"
  log_index="$(jq -r '.verificationMaterial.tlogEntries[0].logIndex | tostring' "$bundle")"
  cp "$statement" "$evidence_dir/statement.json"
  cp "$bundle" "$evidence_dir/statement.sigstore.json"
  jq -n \
    --arg candidateImage "$image_repository@$digest" \
    --arg expectedRevision "$revision" \
    --arg packageVersion "$version" \
    --arg keyId "$key_id" \
    --arg publicKeyPemSha256 "$key_pin" \
    --arg builderId "$(jq -r '.localSigner.builderId' "$trust_file")" \
    --arg statementSha256 "$(sha256_file "$statement")" \
    --arg bundleSha256 "$(sha256_file "$bundle")" \
    --arg transparencyLogIndex "$log_index" \
    '{schemaVersion: "moodarr-local-attestation-v1", policy: "local-signer", candidateImage: $candidateImage, expectedRevision: $expectedRevision, sourceRef: "refs/heads/main", packageVersion: $packageVersion, keyId: $keyId, publicKeyPemSha256: $publicKeyPemSha256, builderId: $builderId, statementSha256: $statementSha256, bundleSha256: $bundleSha256, transparencyLogIndex: $transparencyLogIndex}' \
    > "$evidence_dir/attestation.json"
}

# validate-beta-candidate.yml "Bind candidate provenance and main ancestry" (ancestry is candidate-source).
# gh runs with an empty configuration directory and without caller tokens, so verification relies only on
# public attestation data and the Sigstore trust root.
verify_github_hosted() {
  local CANDIDATE_IMAGE="$1" EXPECTED_REVISION="$2" version="$3" evidence_dir="$4" scratch report bundle_source count
  local bundle_args=()
  require_tool gh
  scratch="$(work_dir)"
  mkdir -p "$scratch/gh-config"
  if [[ -n "${LCI_ATTESTATION_BUNDLE:-}" ]]; then
    [[ -f "$LCI_ATTESTATION_BUNDLE" ]] || fail "The attestation bundle does not exist."
    bundle_args=(--bundle "$LCI_ATTESTATION_BUNDLE")
    bundle_source="file"
  else
    bundle_args=(--bundle-from-oci)
    bundle_source="oci"
  fi
  report="$scratch/attestation.json"
  if ! env -u GH_TOKEN -u GITHUB_TOKEN -u GH_ENTERPRISE_TOKEN -u GITHUB_ENTERPRISE_TOKEN GH_CONFIG_DIR="$scratch/gh-config" GH_PROMPT_DISABLED=1 \
    gh attestation verify "oci://$CANDIDATE_IMAGE" \
      --repo "$image_path" \
      --signer-workflow "$publish_signer_workflow" \
      --signer-digest "$EXPECTED_REVISION" \
      --source-digest "$EXPECTED_REVISION" \
      --source-ref refs/heads/main \
      --deny-self-hosted-runners \
      "${bundle_args[@]}" \
      --format json \
      > "$report"; then
    rm -rf "$scratch"
    fail "GitHub artifact attestation verification failed for $CANDIDATE_IMAGE."
  fi
  if ! jq -e 'type == "array" and length > 0' "$report" >/dev/null 2>&1; then
    rm -rf "$scratch"
    fail "GitHub artifact attestation verification returned no verified attestation."
  fi
  count="$(jq 'length' "$report")"
  rm -rf "$scratch"
  jq -n \
    --arg candidateImage "$CANDIDATE_IMAGE" \
    --arg expectedRevision "$EXPECTED_REVISION" \
    --arg packageVersion "$version" \
    --arg signerWorkflow "$publish_signer_workflow" \
    --arg bundleSource "$bundle_source" \
    --argjson count "$count" \
    '{schemaVersion: "moodarr-local-attestation-v1", policy: "github-hosted", candidateImage: $candidateImage, expectedRevision: $expectedRevision, packageVersion: $packageVersion, signerWorkflow: $signerWorkflow, sourceRef: "refs/heads/main", denySelfHostedRunners: true, bundleSource: $bundleSource, verifiedAttestationCount: $count}' \
    > "$evidence_dir/attestation.json"
}

# Prints the main-anchored trust resolution for this checkout's package version, with active pinned keys.
# The private controller reads this before building or signing.
trust_resolve() {
  local MAIN_SHA version beta scratch policy
  MAIN_SHA="$(main_sha)"
  version="$(package_version)"
  beta="$(beta_number "$version")"
  scratch="$(work_dir)"
  load_trust_policy "$MAIN_SHA" "$scratch/trust.json"
  policy="$(resolve_trust_policy "$scratch/trust.json" "$beta")"
  jq -c --arg policy "$policy" --arg version "$version" --arg main "$MAIN_SHA" '
    {schemaVersion: "moodarr-release-trust-resolution-v1", packageVersion: $version, mainRevision: $main, policy: $policy,
     builderId: .localSigner.builderId, buildType: .localSigner.buildType, sourceUri: .localSigner.sourceUri,
     keys: [.localSigner.keys[] | select(.status == "active")]}
  ' "$scratch/trust.json"
  rm -rf "$scratch"
}

# The candidate-check local-signer verification on its own, for the controller to verify what it signed.
local_signer_verify() {
  local CANDIDATE_DIGEST EXPECTED_REVISION MAIN_SHA version beta scratch policy
  CANDIDATE_DIGEST="$(candidate_digest)"
  EXPECTED_REVISION="$(source_sha)"
  MAIN_SHA="$(main_sha)"
  version="$(package_version)"
  beta="$(beta_number "$version")"
  scratch="$(work_dir)"
  load_trust_policy "$MAIN_SHA" "$scratch/trust.json"
  policy="$(resolve_trust_policy "$scratch/trust.json" "$beta")"
  [[ "$policy" == "local-signer" ]] || fail "Version $version is not pinned to the local release signer."
  verify_local_signer "$scratch/trust.json" "$MAIN_SHA" "${LCI_SIGNED_STATEMENT:-}" "${LCI_SIGNATURE_BUNDLE:-}" "$CANDIDATE_DIGEST" "$EXPECTED_REVISION" "$version" "$(subjob_dir)"
  rm -rf "$scratch"
}

job_attestation() {
  require_tool jq
  local CANDIDATE_DIGEST EXPECTED_REVISION MAIN_SHA version beta evidence_dir scratch trust_file policy
  CANDIDATE_DIGEST="$(candidate_digest)"
  EXPECTED_REVISION="$(source_sha)"
  MAIN_SHA="$(main_sha)"
  evidence_dir="$(subjob_dir)"
  version="$(package_version)"
  beta="$(beta_number "$version")"
  scratch="$(work_dir)"
  trust_file="$scratch/trust.json"
  load_trust_policy "$MAIN_SHA" "$trust_file"
  policy="$(resolve_trust_policy "$trust_file" "$beta")"
  echo "Release trust policy for $version at main $MAIN_SHA: $policy"
  case "$policy" in
    github-hosted) verify_github_hosted "$image_repository@$CANDIDATE_DIGEST" "$EXPECTED_REVISION" "$version" "$evidence_dir" ;;
    local-signer) verify_local_signer "$trust_file" "$MAIN_SHA" "${LCI_SIGNED_STATEMENT:-}" "${LCI_SIGNATURE_BUNDLE:-}" "$CANDIDATE_DIGEST" "$EXPECTED_REVISION" "$version" "$evidence_dir" ;;
  esac
  rm -rf "$scratch"
}

# validate-beta-candidate.yml clean-install and upgrade-rollback jobs, one validator per subjob.
job_official() {
  local VALIDATION="$1"
  require_tool docker
  require_tool jq
  require_tool npm
  local EXPECTED_REVISION CANDIDATE_DIGEST CANDIDATE_IMAGE evidence_dir script report_path validator_exit expected_version status=0
  CANDIDATE_DIGEST="$(candidate_digest)"
  EXPECTED_REVISION="$(source_sha)"
  require_head "$EXPECTED_REVISION"
  require_clean_tree
  CANDIDATE_IMAGE="$image_repository@$CANDIDATE_DIGEST"
  evidence_dir="$(subjob_dir)"
  script="$(validator_script "$VALIDATION")"
  expected_version="$(package_version)"
  load_expected_checks "$VALIDATION"
  report_path="$evidence_dir/report.json"
  set +e
  npm run --silent "$script" -- \
    --candidate-image "$CANDIDATE_IMAGE" \
    --expected-version "$expected_version" \
    --expected-revision "$EXPECTED_REVISION" \
    > "$report_path"
  validator_exit=$?
  set -e
  echo "Validator $script exited $validator_exit."
  set +e
  (
    set -e
    LCI_EXPECTED_VERSION="$expected_version" LCI_EXPECTED_REVISION="$EXPECTED_REVISION" LCI_EXPECTED_IMAGE="$CANDIDATE_IMAGE" LCI_EXPECTED_DIGEST="$CANDIDATE_DIGEST" \
      check_report "$VALIDATION" official "$report_path" "$validator_exit"
  )
  status=$?
  set -e
  prove_validator_resources_absent || status=1
  return "$status"
}

check_index_manifest() {
  jq -e '
    .mediaType == "application/vnd.oci.image.index.v1+json"
    and ([.manifests[]? | select(.platform.os == "linux" and .platform.architecture == "amd64")] | length == 1)
    and ([.manifests[]? | select(.annotations["vnd.docker.reference.type"] != "attestation-manifest")] | length == 1)
    and ([.manifests[]? | select(.annotations["vnd.docker.reference.type"] == "attestation-manifest")] | length == 1)
    and all(.manifests[]?; (.digest | type) == "string" and (.digest | test("^sha256:[0-9a-f]{64}$")))
    and (
      [.manifests[]? | select(.annotations["vnd.docker.reference.type"] == "attestation-manifest")][0].annotations["vnd.docker.reference.digest"]
      == [.manifests[]? | select(.annotations["vnd.docker.reference.type"] != "attestation-manifest")][0].digest
    )
  ' "$1" >/dev/null || fail "The image index is not the single linux/amd64 image plus its attestation manifest."
}

check_image_config() {
  jq -e --arg expected_version "$2" --arg expected_revision "$3" '
    .os == "linux"
    and .architecture == "amd64"
    and .config.Labels["org.opencontainers.image.version"] == $expected_version
    and .config.Labels["org.opencontainers.image.revision"] == $expected_revision
    and .config.Labels["org.opencontainers.image.source"] == "https://github.com/jremick/moodarr"
    and .config.Labels["org.opencontainers.image.licenses"] == "Apache-2.0"
    and .config.Labels["io.moodarr.ai-provider-policy"] == "none"
    and .config.Labels["io.moodarr.tmdb-content-policy"] == "none"
  ' "$1" >/dev/null || fail "The image configuration does not match the candidate identity."
}

# BuildKit provenance: GitHub-hosted candidates must come from a Moodarr Actions run; local-signer candidates
# must carry the builder ID pinned in the release trust policy.
check_buildkit_provenance() {
  local file="$1" revision="$2" policy="$3" builder_id="$4"
  case "$policy" in
    github-hosted) ;;
    local-signer) [[ -n "$builder_id" ]] || fail "The local-signer policy requires a pinned builder ID." ;;
    *) fail "Unknown release trust policy $policy." ;;
  esac
  jq -e --arg expected_revision "$revision" --arg policy "$policy" --arg builder_id "$builder_id" '
    .SLSA.buildDefinition.buildType == "https://github.com/moby/buildkit/blob/master/docs/attestations/slsa-definitions.md"
    and .SLSA.runDetails.metadata.buildkit_metadata.vcs.source == "https://github.com/jremick/moodarr"
    and .SLSA.runDetails.metadata.buildkit_metadata.vcs.revision == $expected_revision
    and ((.SLSA.buildDefinition.resolvedDependencies | type) == "array")
    and ((.SLSA.buildDefinition.resolvedDependencies | length) > 0)
    and all(.SLSA.buildDefinition.resolvedDependencies[];
      (.uri | type) == "string"
      and (.uri | length) > 0
      and (.digest | type) == "object"
      and (.digest | length) > 0
      and all(.digest | to_entries[];
        (.key | type) == "string"
        and (.key | length) > 0
        and (.value | type) == "string"
        and (.value | test("^([0-9a-f]{40}|[0-9a-f]{64}|[0-9a-f]{128})$"))
      )
    )
    and ((.SLSA.runDetails.builder.id | type) == "string")
    and (if $policy == "local-signer"
      then .SLSA.runDetails.builder.id == $builder_id
      else (.SLSA.runDetails.builder.id | test("^https://github[.]com/jremick/moodarr/actions/runs/[0-9]+/attempts/[0-9]+$"))
      end)
    and (((.SLSA.buildDefinition.internalParameters // {}) | keys | map(startswith("github_")) | any) | not)
  ' "$file" >/dev/null || fail "BuildKit provenance does not match the candidate source and builder policy."
}

check_sbom() {
  jq -e '
    .SPDX.spdxVersion == "SPDX-2.3"
    and .SPDX.SPDXID == "SPDXRef-DOCUMENT"
    and ((.SPDX.packages | type) == "array")
    and ((.SPDX.packages | length) > 0)
  ' "$1" >/dev/null || fail "The SBOM is not a non-empty SPDX 2.3 document."
}

# validate-beta-candidate.yml "Verify published digest, image identity, SBOM, and provenance".
supply_chain_verify_evidence() {
  local CANDIDATE_DIGEST CANDIDATE_IMAGE EXPECTED_REVISION EXPECTED_VERSION EVIDENCE_DIR manifest image_config provenance sbom computed_digest
  CANDIDATE_DIGEST="$(candidate_digest)"
  CANDIDATE_IMAGE="$image_repository@$CANDIDATE_DIGEST"
  EXPECTED_REVISION="$(source_sha)"
  EXPECTED_VERSION="$(package_version)"
  [[ "$EXPECTED_VERSION" =~ ^0\.1\.0-beta\.[1-9][0-9]*$ ]] || fail "Package version must be a supported beta version."
  EVIDENCE_DIR="$(subjob_dir)"
  manifest="$EVIDENCE_DIR/manifest.json"
  image_config="$EVIDENCE_DIR/image-config.json"
  provenance="$EVIDENCE_DIR/provenance.json"
  sbom="$EVIDENCE_DIR/sbom.spdx.json"

  docker buildx imagetools inspect "$CANDIDATE_IMAGE" --raw > "$manifest"
  computed_digest="sha256:$(sha256_file "$manifest")"
  if [[ "$computed_digest" != "$CANDIDATE_DIGEST" ]]; then
    fail "Published manifest digest $computed_digest does not match $CANDIDATE_DIGEST."
  fi

  docker buildx imagetools inspect "$CANDIDATE_IMAGE" --format '{{json .Image}}' > "$image_config"
  docker buildx imagetools inspect "$CANDIDATE_IMAGE" --format '{{json .Provenance}}' > "$provenance"
  docker buildx imagetools inspect "$CANDIDATE_IMAGE" --format '{{json .SBOM}}' > "$sbom"

  check_index_manifest "$manifest"
  check_image_config "$image_config" "$EXPECTED_VERSION" "$EXPECTED_REVISION"
  check_buildkit_provenance "$provenance" "$EXPECTED_REVISION" "${LCI_TRUST_POLICY:-github-hosted}" "${LCI_TRUST_BUILDER_ID:-}"
  check_sbom "$sbom"
}

# validate-beta-candidate.yml "Record compact supply-chain evidence and enforce policy". The report replaces
# the Actions run URL with the local run ID and uses its own schema version.
supply_chain_record_policy() {
  local CANDIDATE_DIGEST CANDIDATE_IMAGE EXPECTED_REVISION EXPECTED_VERSION EVIDENCE_DIR RUN_ID
  CANDIDATE_DIGEST="$(candidate_digest)"
  CANDIDATE_IMAGE="$image_repository@$CANDIDATE_DIGEST"
  EXPECTED_REVISION="$(source_sha)"
  RUN_ID="$(run_id)"
  EXPECTED_VERSION="$(package_version)"
  [[ "$EXPECTED_VERSION" =~ ^0\.1\.0-beta\.[1-9][0-9]*$ ]] || fail "Package version must be a supported beta version."
  EVIDENCE_DIR="$(subjob_dir)"
  local manifest="$EVIDENCE_DIR/manifest.json"
  local image_config="$EVIDENCE_DIR/image-config.json"
  local provenance="$EVIDENCE_DIR/provenance.json"
  local sbom="$EVIDENCE_DIR/sbom.spdx.json"
  local anonymous_pull="$EVIDENCE_DIR/anonymous-pull.json"
  local high_critical="$EVIDENCE_DIR/trivy-high-critical.json"
  local actionable="$EVIDENCE_DIR/trivy-actionable.json"
  local report="$EVIDENCE_DIR/supply-chain-report.json"
  local scan high_critical_count actionable_count sbom_package_count dependency_count vex_digest trivy_version_output scanner_version buildx_plugin_sha256

  for scan in "$high_critical" "$actionable"; do
    jq -e '
      type == "object"
      and .SchemaVersion == 2
      and ((.Results | type) == "array")
      and ((.Results | length) > 0)
      and all(.Results[];
        type == "object"
        and ((.Target | type) == "string")
        and ((.Target | length) > 0)
        and ((has("Vulnerabilities") | not) or .Vulnerabilities == null or (.Vulnerabilities | type) == "array")
      )
    ' "$scan" >/dev/null || fail "Trivy scan output $(basename "$scan") is missing or malformed."
  done
  jq -e --arg candidate_image "$CANDIDATE_IMAGE" --arg candidate_digest "$CANDIDATE_DIGEST" '
    .schemaVersion == "moodarr-anonymous-candidate-pull-v1"
    and .candidateImage == $candidate_image
    and .candidateDigest == $candidate_digest
    and .registryDigest == $candidate_digest
    and .manifestMediaType == "application/vnd.oci.image.index.v1+json"
    and .anonymousPullVerified == true
  ' "$anonymous_pull" >/dev/null || fail "Anonymous public-pull evidence is missing or does not match the candidate."

  high_critical_count="$(jq '[.Results[]?.Vulnerabilities[]?] | unique_by([.VulnerabilityID, .PkgName]) | length' "$high_critical")"
  actionable_count="$(jq '[.Results[]?.Vulnerabilities[]?] | unique_by([.VulnerabilityID, .PkgName]) | length' "$actionable")"
  sbom_package_count="$(jq '.SPDX.packages | length' "$sbom")"
  dependency_count="$(jq '.SLSA.buildDefinition.resolvedDependencies | length' "$provenance")"
  vex_digest="sha256:$(sha256_file .vex/moodarr.openvex.json)"
  trivy_version_output="$(trivy --version)"
  scanner_version="$(awk 'NR == 1 && $1 == "Version:" { print $2 }' <<<"$trivy_version_output")"
  buildx_plugin_sha256="$(sha256_file "${DOCKER_CONFIG:-$HOME/.docker}/cli-plugins/docker-buildx")"

  jq -n \
    --arg candidateImage "$CANDIDATE_IMAGE" \
    --arg candidateDigest "$CANDIDATE_DIGEST" \
    --arg expectedRevision "$EXPECTED_REVISION" \
    --arg expectedVersion "$EXPECTED_VERSION" \
    --arg manifestMediaType "$(jq -r '.mediaType' "$manifest")" \
    --arg imageOs "$(jq -r '.os' "$image_config")" \
    --arg imageArchitecture "$(jq -r '.architecture' "$image_config")" \
    --arg buildType "$(jq -r '.SLSA.buildDefinition.buildType' "$provenance")" \
    --arg builderId "$(jq -r '.SLSA.runDetails.builder.id' "$provenance")" \
    --arg sbomFormat "$(jq -r '.SPDX.spdxVersion' "$sbom")" \
    --arg scannerVersion "$scanner_version" \
    --arg buildxSha256 "$buildx_plugin_sha256" \
    --arg vexDigest "$vex_digest" \
    --arg runId "$RUN_ID" \
    --arg signerPolicy "${LCI_TRUST_POLICY:-github-hosted}" \
    --argjson sbomPackageCount "$sbom_package_count" \
    --argjson resolvedDependencyCount "$dependency_count" \
    --argjson highCriticalCount "$high_critical_count" \
    --argjson actionableHighCriticalCount "$actionable_count" \
    '{
      schemaVersion: "moodarr-beta-supply-chain-local-v1",
      scope: "candidate-supply-chain-only",
      candidate: {
        image: $candidateImage,
        digest: $candidateDigest,
        expectedRevision: $expectedRevision,
        expectedVersion: $expectedVersion,
        manifestMediaType: $manifestMediaType,
        os: $imageOs,
        architecture: $imageArchitecture,
        anonymousPullVerified: true
      },
      provenance: {
        buildType: $buildType,
        builderId: $builderId,
        resolvedDependencyCount: $resolvedDependencyCount,
        vcsSourceMatched: true,
        sourceRevisionMatched: true,
        builderRecordValidated: true,
        resolvedDependenciesValidated: true,
        signerPolicy: $signerPolicy,
        githubArtifactAttestationVerified: ($signerPolicy == "github-hosted"),
        localSignerStatementVerified: ($signerPolicy == "local-signer")
      },
      sbom: {
        format: $sbomFormat,
        packageCount: $sbomPackageCount,
        attachedToCandidateIndex: true
      },
      vulnerabilityPolicy: {
        scanner: "Trivy",
        scannerVersion: $scannerVersion,
        vexDigest: $vexDigest,
        highCriticalCount: $highCriticalCount,
        actionableHighCriticalCount: $actionableHighCriticalCount,
        rejectsFixableHighCritical: true
      },
      toolchain: {
        buildx: ("v0.34.1@sha256:" + $buildxSha256),
        buildkit: "v0.30.0@sha256:0168606be2315b7c807a03b3d8aa79beefdb31c98740cebdffdfeebf31190c9f",
        sbomGenerator: "docker/buildkit-syft-scanner@sha256:79e7b013cbec16bbb436f312819a49a4a57752b2270c1a9332ae1a10fcc82a68",
        trivyDatabaseMetadata: "trivy-version.txt"
      },
      localRun: {runId: $runId}
    }' > "$report"

  {
    echo "### Published candidate supply-chain evidence"
    echo "- Candidate: \`$CANDIDATE_IMAGE\`"
    echo "- SPDX packages: $sbom_package_count"
    echo "- High/critical findings: $high_critical_count total; $actionable_count fixable"
  } > "$EVIDENCE_DIR/summary.md"

  if [[ "$actionable_count" != "0" ]]; then
    fail "Published candidate has $actionable_count fixable high/critical runtime finding(s)."
  fi
}

# validate-beta-candidate.yml "Verify evidence toolchain identity" for the named, run-owned builder.
verify_buildx_plugin() {
  local buildx_version_output installed_version buildx_path
  buildx_version_output="$(docker buildx version)"
  installed_version="$(awk 'NR == 1 { print $2 }' <<<"$buildx_version_output")"
  [[ "$installed_version" == "$buildx_version"* ]] || fail "Docker Buildx $buildx_version is required; found ${installed_version:-none}."
  buildx_path="${DOCKER_CONFIG:-$HOME/.docker}/cli-plugins/docker-buildx"
  [[ -f "$buildx_path" ]] || fail "The pinned Buildx plugin is not installed at the Docker CLI plugin path."
  [[ "$(sha256_file "$buildx_path")" == "$buildx_sha256" ]] || fail "The installed Buildx plugin does not match the pinned SHA-256."
}

verify_supply_chain_toolchain() {
  local builder="$1" buildkit_inspect buildkit_version
  verify_buildx_plugin
  buildkit_inspect="$(docker buildx inspect "$builder" --bootstrap)"
  buildkit_version="$(awk '$1 == "BuildKit" && $2 == "version:" { print $3 }' <<<"$buildkit_inspect")"
  [[ "$buildkit_version" == "v0.30.0" ]] || fail "BuildKit v0.30.0 is required; found ${buildkit_version:-none}."
  require_trivy
}

# validate-beta-candidate.yml "Create pinned BuildKit builder" without switching the host's current builder.
create_pinned_builder() {
  local builder_name="$1" inspect_output="" buildkit_version="" attempt
  shift
  docker buildx create \
    --name "$builder_name" \
    --driver docker-container \
    --driver-opt "image=$buildkit_image" \
    "$@" \
    >/dev/null
  for attempt in 1 2 3; do
    if inspect_output="$(docker buildx inspect "$builder_name" --bootstrap 2>&1)"; then
      buildkit_version="$(awk '$1 == "BuildKit" && $2 == "version:" { print $3 }' <<<"$inspect_output")"
      if [[ "$buildkit_version" == "v0.30.0" ]]; then
        return 0
      fi
    fi
    if [[ "$attempt" == "3" ]]; then
      printf '%s\n' "$inspect_output" >&2
      docker buildx rm -f "$builder_name" >/dev/null 2>&1 || true
      fail "Pinned BuildKit builder did not become ready after three attempts."
    fi
    sleep "$attempt"
  done
}

# validate-beta-candidate.yml supply-chain job after the anonymous pull and attestation gates.
job_supply_chain() {
  require_tool docker
  require_tool jq
  local CANDIDATE_DIGEST CANDIDATE_IMAGE EVIDENCE_DIR builder status=0
  CANDIDATE_DIGEST="$(candidate_digest)"
  CANDIDATE_IMAGE="$image_repository@$CANDIDATE_DIGEST"
  EVIDENCE_DIR="$(subjob_dir)"
  cp "${LCI_EVIDENCE_DIR:?}/anonymous-pull/anonymous-pull.json" "$EVIDENCE_DIR/anonymous-pull.json" \
    || fail "Anonymous public-pull evidence from the anonymous-pull subjob is missing."
  builder="$(builder_name)"
  create_pinned_builder "$builder"
  set +e
  (
    set -e
    LCI_TRUST_POLICY="$(jq -r '.policy' "$LCI_EVIDENCE_DIR/attestation/attestation.json")"
    LCI_TRUST_BUILDER_ID="$(jq -r '.builderId // ""' "$LCI_EVIDENCE_DIR/attestation/attestation.json")"
    export LCI_TRUST_POLICY LCI_TRUST_BUILDER_ID
    verify_supply_chain_toolchain "$builder"
    supply_chain_verify_evidence
    trivy image \
      --scanners vuln \
      --severity HIGH,CRITICAL \
      --format json \
      --output "$EVIDENCE_DIR/trivy-high-critical.json" \
      --exit-code 0 \
      --vex .vex/moodarr.openvex.json \
      "$CANDIDATE_IMAGE"
    trivy image \
      --scanners vuln \
      --severity HIGH,CRITICAL \
      --ignore-unfixed \
      --format json \
      --output "$EVIDENCE_DIR/trivy-actionable.json" \
      --exit-code 0 \
      --vex .vex/moodarr.openvex.json \
      "$CANDIDATE_IMAGE"
    trivy --version > "$EVIDENCE_DIR/trivy-version.txt"
    supply_chain_record_policy
  )
  status=$?
  set -e
  # The raw maximum provenance stays attached to the published image; do not duplicate it in evidence.
  rm -f "$EVIDENCE_DIR/provenance.json"
  docker buildx rm "$builder" || status=1
  return "$status"
}


# --- release-build ----------------------------------------------------------------------------------

oci_blob() {
  local layout="$1" digest="$2" path
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "Invalid OCI blob digest $digest."
  path="$layout/blobs/sha256/${digest#sha256:}"
  [[ -f "$path" ]] || fail "OCI blob $digest is missing from the layout."
  [[ "sha256:$(sha256_file "$path")" == "$digest" ]] || fail "OCI blob $digest does not match its digest."
  printf '%s' "$path"
}

oci_manifest_blobs_present() {
  local layout="$1" manifest="$2" digest
  for digest in $(jq -r '[.config.digest] + [.layers[]?.digest] | .[]' "$manifest"); do
    oci_blob "$layout" "$digest" >/dev/null
  done
}

# Verifies a BuildKit OCI layout before it is signed or pushed: exactly the approved image index, one
# linux/amd64 image bound to its attestation manifest, the candidate labels, BuildKit provenance from the
# pinned local builder, an SPDX SBOM, and no host paths in anything that becomes public provenance.
release_artifact_verify() {
  local layout="${LCI_ARTIFACT_LAYOUT:?LCI_ARTIFACT_LAYOUT is required}" expected_digest revision version builder_id
  local index image_digest attestation_digest image_manifest config attestation_manifest provenance_statement sbom_statement statement predicate_type scratch
  expected_digest="$(candidate_digest)"
  revision="$(source_sha)"
  version="$(package_version)"
  builder_id="${LCI_TRUST_BUILDER_ID:?LCI_TRUST_BUILDER_ID is required}"
  jq -e '.imageLayoutVersion == "1.0.0"' "$layout/oci-layout" >/dev/null 2>&1 || fail "The artifact is not an OCI image layout."
  jq -e --arg digest "$expected_digest" '
    (.manifests | length) == 1
    and .manifests[0].mediaType == "application/vnd.oci.image.index.v1+json"
    and .manifests[0].digest == $digest
  ' "$layout/index.json" >/dev/null 2>&1 || fail "The OCI layout does not contain exactly the approved image index $expected_digest."
  index="$(oci_blob "$layout" "$expected_digest")"
  check_index_manifest "$index"
  image_digest="$(jq -r '[.manifests[] | select(.annotations["vnd.docker.reference.type"] != "attestation-manifest")][0].digest' "$index")"
  attestation_digest="$(jq -r '[.manifests[] | select(.annotations["vnd.docker.reference.type"] == "attestation-manifest")][0].digest' "$index")"
  image_manifest="$(oci_blob "$layout" "$image_digest")"
  attestation_manifest="$(oci_blob "$layout" "$attestation_digest")"
  oci_manifest_blobs_present "$layout" "$image_manifest"
  oci_manifest_blobs_present "$layout" "$attestation_manifest"
  config="$(oci_blob "$layout" "$(jq -r '.config.digest' "$image_manifest")")"
  check_image_config "$config" "$version" "$revision"
  provenance_statement="$(oci_blob "$layout" "$(jq -r '[.layers[] | select(.annotations["in-toto.io/predicate-type"] == "https://slsa.dev/provenance/v1")] | if length == 1 then .[0].digest else "missing" end' "$attestation_manifest")")"
  sbom_statement="$(oci_blob "$layout" "$(jq -r '[.layers[] | select(.annotations["in-toto.io/predicate-type"] == "https://spdx.dev/Document")] | if length == 1 then .[0].digest else "missing" end' "$attestation_manifest")")"
  for statement in "$provenance_statement" "$sbom_statement"; do
    predicate_type="https://spdx.dev/Document"
    [[ "$statement" != "$provenance_statement" ]] || predicate_type="https://slsa.dev/provenance/v1"
    # BuildKit v0.30.0 emits v0.1 envelopes; the controller signature remains v1-only.
    jq -e --arg digest "${image_digest#sha256:}" --arg predicate_type "$predicate_type" '
      (._type == "https://in-toto.io/Statement/v0.1" or ._type == "https://in-toto.io/Statement/v1")
      and .predicateType == $predicate_type
      and (.subject | type == "array" and length > 0)
      and all(.subject[]; .digest.sha256 == $digest)
    ' "$statement" >/dev/null || fail "An attestation does not describe the candidate image manifest."
  done
  scratch="$(work_dir)"
  jq '{SLSA: .predicate}' "$provenance_statement" > "$scratch/provenance.json"
  jq '{SPDX: .predicate}' "$sbom_statement" > "$scratch/sbom.json"
  check_buildkit_provenance "$scratch/provenance.json" "$revision" local-signer "$builder_id"
  check_sbom "$scratch/sbom.json"
  rm -rf "$scratch"
  jq -e -s '
    [.[] | .. | strings | select(test("file://|(^|[^A-Za-z0-9._-])/(home|Users|root|mnt|private|var/folders)/|^[A-Za-z]:\\\\"))] | length == 0
  ' "$provenance_statement" "$config" >/dev/null || fail "Provenance or image configuration contains a host path."
}

# publish-image.yml candidate build, producing an OCI archive instead of pushing. The worker never holds
# registry or signing credentials; the private local-ci controller verifies, pushes and signs.
job_release_image() {
  require_tool docker
  require_tool jq
  require_tool tar
  local SOURCE_SHA MAIN_SHA version beta evidence_dir scratch trust_file policy builder_id origin builder created digest status
  SOURCE_SHA="$(source_sha)"
  MAIN_SHA="$(main_sha)"
  require_head "$SOURCE_SHA"
  require_clean_tree
  # publish-image.yml: a candidate is the current main dispatch commit, not merely an older ancestor.
  # release-source (shared with release-check) proves ancestry only.
  [[ "$SOURCE_SHA" == "$MAIN_SHA" ]] || fail "Release-build source $SOURCE_SHA must equal the current main commit $MAIN_SHA; an older main ancestor cannot become a candidate."
  evidence_dir="$(subjob_dir)"
  version="$(package_version)"
  beta="$(beta_number "$version")"
  scratch="$(work_dir)"
  trust_file="$scratch/trust.json"
  load_trust_policy "$MAIN_SHA" "$trust_file"
  policy="$(resolve_trust_policy "$trust_file" "$beta")"
  [[ "$policy" == "local-signer" ]] || fail "Version $version is pinned to the $policy publisher; a locally signed artifact cannot be built for it."
  builder_id="$(jq -r '.localSigner.builderId' "$trust_file")"
  origin="$(git config --get remote.origin.url 2>/dev/null || true)"
  case "$origin" in
    "$public_source_url"|"$public_source_url.git") ;;
    *) fail "The checkout's origin must be the public $public_source_url (optionally with .git) so BuildKit records the public source; the configured value is not shown." ;;
  esac
  verify_buildx_plugin
  builder="$(builder_name)"
  create_pinned_builder "$builder" --driver-opt "provenance-add-gha=false"
  created="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  set +e
  (
    set -e
    # Buildx reads `git remote get-url origin`; rewrite the .git form so provenance carries the canonical URL.
    export GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="url.$public_source_url.insteadOf" GIT_CONFIG_VALUE_0="$public_source_url.git"
    docker buildx build \
      --builder "$builder" \
      --platform linux/amd64 \
      --file ./Dockerfile \
      --build-arg "MOODARR_VERSION=$version" \
      --build-arg "MOODARR_BUILD_REVISION=$SOURCE_SHA" \
      --build-arg "MOODARR_BUILD_AI_PROVIDER_POLICY=none" \
      --build-arg "MOODARR_BUILD_TMDB_CONTENT_POLICY=none" \
      --label "org.opencontainers.image.created=$created" \
      --label "org.opencontainers.image.description=Moodarr Plex and Seerr companion app" \
      --label "org.opencontainers.image.licenses=Apache-2.0" \
      --label "org.opencontainers.image.revision=$SOURCE_SHA" \
      --label "org.opencontainers.image.source=https://github.com/jremick/moodarr" \
      --label "org.opencontainers.image.title=moodarr" \
      --label "org.opencontainers.image.url=https://github.com/jremick/moodarr" \
      --label "org.opencontainers.image.version=$version" \
      --attest "type=provenance,mode=max,builder-id=$builder_id" \
      --attest "type=sbom,generator=$sbom_generator" \
      --metadata-file "$scratch/build-metadata.json" \
      --output "type=oci,dest=$evidence_dir/moodarr-oci.tar,name=$image_repository:sha-$SOURCE_SHA" \
      .
    digest="$(jq -r '."containerimage.digest"' "$scratch/build-metadata.json")"
    [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "Buildx did not report the image index digest."
    mkdir "$scratch/layout"
    tar -xf "$evidence_dir/moodarr-oci.tar" -C "$scratch/layout"
    LCI_ARTIFACT_LAYOUT="$scratch/layout" LCI_CANDIDATE_DIGEST="$digest" LCI_TRUST_BUILDER_ID="$builder_id" release_artifact_verify
    jq -n \
      --arg sourceRevision "$SOURCE_SHA" \
      --arg mainRevision "$MAIN_SHA" \
      --arg packageVersion "$version" \
      --arg candidateTag "sha-$SOURCE_SHA" \
      --arg indexDigest "$digest" \
      --arg archiveSha256 "$(sha256_file "$evidence_dir/moodarr-oci.tar")" \
      --arg builderId "$builder_id" \
      '{schemaVersion: "moodarr-local-release-build-v1", sourceRevision: $sourceRevision, mainRevision: $mainRevision, packageVersion: $packageVersion, candidateTag: $candidateTag, indexDigest: $indexDigest, archiveSha256: $archiveSha256, builderId: $builderId}' \
      > "$evidence_dir/release-build.json"
  )
  status=$?
  set -e
  rm -rf "$scratch"
  docker buildx rm "$builder" || status=1
  return "$status"
}

# --- cleanup ----------------------------------------------------------------------------------------

# Removes only resources whose full names derive from this run ID, then reports validator-owned leftovers
# without removing them: their owners are random per validator run, so they cannot be proven ours.
job_cleanup() {
  local evidence_dir tag builder owner_label kind listing status=0 leftovers=""
  evidence_dir="$(subjob_dir)"
  if ! command -v docker >/dev/null 2>&1; then
    echo "Docker CLI is not on PATH; this run created no Docker resources."
    return 0
  fi
  for tag in "$(scan_tag)" "$(native_tag)"; do
    if docker image inspect --format '{{.Id}}' "$tag" >/dev/null 2>&1; then
      docker image rm "$tag" >/dev/null || { echo "Could not remove run image $tag." >&2; status=1; }
    fi
  done
  builder="$(builder_name)"
  if docker buildx inspect "$builder" >/dev/null 2>&1; then
    docker buildx rm "$builder" >/dev/null || { echo "Could not remove run builder $builder." >&2; status=1; }
  fi
  for owner_label in $validator_owner_labels; do
    for kind in container volume network; do
      case "$kind" in
        container) listing="$(docker ps -a --filter "label=$owner_label" --format '{{.ID}}')" || { status=1; listing=""; } ;;
        volume) listing="$(docker volume ls --filter "label=$owner_label" --format '{{.Name}}')" || { status=1; listing=""; } ;;
        network) listing="$(docker network ls --filter "label=$owner_label" --format '{{.ID}}')" || { status=1; listing=""; } ;;
      esac
      if [[ -n "$listing" ]]; then
        leftovers="$leftovers$(printf '%s\n' "$listing" | awk -v kind="$kind" -v label="$owner_label" 'NF { print kind "\t" label "\t" $1 }')"$'\n'
      fi
    done
  done
  if [[ -n "${leftovers//$'\n'/}" ]]; then
    printf '%s' "$leftovers" | jq -R -s 'split("\n") | map(select(length > 0) | split("\t") | {kind: .[0], ownerLabel: .[1], id: .[2]})' > "$evidence_dir/validator-leftovers.json"
    echo "Validator-owned resources remain on the Docker daemon; they were not removed. See validator-leftovers.json." >&2
    status=1
  fi
  return "$status"
}

# --- dispatch ---------------------------------------------------------------------------------------

command="${1:-}"
case "$command" in
  install) job_install ;;
  audit) job_audit ;;
  dependency-audit) job_dependency_audit ;;
  verify-release) job_verify_release ;;
  container-scan) job_container_scan ;;
  native-image) job_native_image ;;
  codeql) job_codeql ;;
  release-source) job_release_source ;;
  release-policy) job_release_policy ;;
  candidate-source) job_candidate_source ;;
  anonymous-pull) job_anonymous_pull ;;
  attestation) job_attestation ;;
  supply-chain) job_supply_chain ;;
  release-image) job_release_image ;;
  cleanup) job_cleanup ;;
  native-*|official-*)
    validation="${command#*-}"
    case " $validations " in
      *" $validation "*) ;;
      *) fail "Unknown subjob $command." ;;
    esac
    if [[ "$command" == native-* ]]; then job_native "$validation"; else job_official "$validation"; fi
    ;;
  check-report)
    [[ $# -eq 5 ]] || fail "usage: jobs.sh check-report <validation> <rehearsal|official> <report> <validator-exit>"
    require_tool jq
    check_report "$2" "$3" "$4" "$5"
    ;;
  supply-chain-verify-evidence) require_tool jq; supply_chain_verify_evidence ;;
  supply-chain-record-policy) require_tool jq; supply_chain_record_policy ;;
  release-artifact-verify) require_tool jq; release_artifact_verify ;;
  trust-resolve) require_tool jq; trust_resolve ;;
  local-signer-verify) require_tool jq; local_signer_verify ;;
  *) fail "Unknown subjob ${command:-<none>}." ;;
esac
