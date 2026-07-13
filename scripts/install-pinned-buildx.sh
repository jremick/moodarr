#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN is required to download the pinned Buildx release asset}"

readonly buildx_version="v0.34.1"
readonly buildx_asset_id="424359377"
readonly buildx_sha256="f1332ddb9010bd0b72628266c3a906d9a6979848033df4c8d9bd2cd113bae12b"
readonly docker_config="${DOCKER_CONFIG:-$HOME/.docker}"
readonly plugin_dir="$docker_config/cli-plugins"
readonly plugin_path="$plugin_dir/docker-buildx"

download_path="$(mktemp "${RUNNER_TEMP:-/tmp}/moodarr-buildx.XXXXXX")"
trap 'rm -f "$download_path"' EXIT

curl --location --fail-with-body --silent --show-error \
  --header "Accept: application/octet-stream" \
  --header "Authorization: Bearer $GH_TOKEN" \
  --header "X-GitHub-Api-Version: 2022-11-28" \
  --header "User-Agent: moodarr-release-workflow" \
  --output "$download_path" \
  "https://api.github.com/repos/docker/buildx/releases/assets/$buildx_asset_id"

printf '%s  %s\n' "$buildx_sha256" "$download_path" | sha256sum --check --strict
install -d -m 0755 "$plugin_dir"
install -m 0755 "$download_path" "$plugin_path"
printf '%s  %s\n' "$buildx_sha256" "$plugin_path" | sha256sum --check --strict

installed_version="$(docker buildx version | awk '{ print $2; exit }')"
if [[ "$installed_version" != "$buildx_version"* ]]; then
  echo "Installed Buildx version $installed_version does not match $buildx_version." >&2
  exit 1
fi
