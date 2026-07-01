#!/usr/bin/env bash
set -euo pipefail

ROOT="/mnt/f/moodarr-wikidata"
RUN_NAME="fast-lbzip2-min5"

args=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --root)
      ROOT="$2"
      args+=("$1" "$2")
      shift 2
      ;;
    --run-name)
      RUN_NAME="$2"
      args+=("$1" "$2")
      shift 2
      ;;
    *)
      args+=("$1")
      if [[ $# -gt 1 && "$2" != --* ]]; then
        args+=("$2")
        shift 2
      else
        shift
      fi
      ;;
  esac
done

runner="$ROOT/run-wikidata-normalizer-fast-wsl.sh"
logs_dir="$ROOT/logs"
launch_log="$logs_dir/$RUN_NAME.launch.log"
pid_file="$logs_dir/$RUN_NAME.pid"

mkdir -p "$logs_dir"
chmod +x "$runner"

nohup bash "$runner" "${args[@]}" > "$launch_log" 2>&1 < /dev/null &
pid="$!"

printf '%s\n' "$pid" > "$pid_file"
printf '{"processId":%s,"runName":"%s","pidFile":"%s","launchLog":"%s"}\n' "$pid" "$RUN_NAME" "$pid_file" "$launch_log"
