#!/usr/bin/env bash
# Portable local CI and release-check entrypoint. See docs/LOCAL_CI.md.
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
if ! command -v node >/dev/null 2>&1; then
  echo "local-ci: node is required on PATH." >&2
  exit 2
fi
exec node "$root/scripts/local-ci/orchestrate.mjs" "$@"
