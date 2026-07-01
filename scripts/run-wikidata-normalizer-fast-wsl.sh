#!/usr/bin/env bash
set -euo pipefail

ROOT="/mnt/f/moodarr-wikidata"
SOURCE_VERSION="wikidata-dump-2026-06-30-fast-lbzip2-min5"
MIN_SITELINKS=5
PROGRESS_INTERVAL=1000000
RUN_NAME="fast-lbzip2-min5"
CLASS_INDEX=""
WORKERS=12
BATCH_SIZE=500
QUEUE_BATCHES=16
OUTPUT_GZIP_LEVEL=1
DECOMPRESSOR="lbzip2"
DECOMPRESSOR_WORKERS=16
MAX_ENTITIES=0
LIMIT_MEDIA=0
FORCE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --source-version) SOURCE_VERSION="$2"; shift 2 ;;
    --min-sitelinks) MIN_SITELINKS="$2"; shift 2 ;;
    --progress-interval) PROGRESS_INTERVAL="$2"; shift 2 ;;
    --run-name) RUN_NAME="$2"; shift 2 ;;
    --class-index) CLASS_INDEX="$2"; shift 2 ;;
    --workers) WORKERS="$2"; shift 2 ;;
    --batch-size) BATCH_SIZE="$2"; shift 2 ;;
    --queue-batches) QUEUE_BATCHES="$2"; shift 2 ;;
    --output-gzip-level) OUTPUT_GZIP_LEVEL="$2"; shift 2 ;;
    --decompressor) DECOMPRESSOR="$2"; shift 2 ;;
    --decompressor-workers) DECOMPRESSOR_WORKERS="$2"; shift 2 ;;
    --max-entities) MAX_ENTITIES="$2"; shift 2 ;;
    --limit-media) LIMIT_MEDIA="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

DUMP="$ROOT/latest-all.json.bz2"
NORMALIZER="$ROOT/normalize-wikidata-dump-fast.py"
WORK_DIR="$ROOT/work/$RUN_NAME"
OUT_DIR="$ROOT/out"
LOGS_DIR="$ROOT/logs"
OUTPUT="$OUT_DIR/moodarr-wikidata-catalog-$RUN_NAME.jsonl.gz"
MANIFEST="$OUT_DIR/moodarr-wikidata-catalog-$RUN_NAME.manifest.json"
OUT_LOG="$LOGS_DIR/$RUN_NAME.out.log"
ERR_LOG="$LOGS_DIR/$RUN_NAME.err.log"

if [[ -z "$CLASS_INDEX" && -f "$ROOT/work/full-min5/wikidata-class-index.json" ]]; then
  CLASS_INDEX="$ROOT/work/full-min5/wikidata-class-index.json"
fi

mkdir -p "$WORK_DIR" "$OUT_DIR" "$LOGS_DIR"

args=(
  "$NORMALIZER"
  --dump "$DUMP"
  --work-dir "$WORK_DIR"
  --output "$OUTPUT"
  --manifest "$MANIFEST"
  --source-version "$SOURCE_VERSION"
  --min-sitelinks "$MIN_SITELINKS"
  --progress-interval "$PROGRESS_INTERVAL"
  --workers "$WORKERS"
  --batch-size "$BATCH_SIZE"
  --queue-batches "$QUEUE_BATCHES"
  --output-gzip-level "$OUTPUT_GZIP_LEVEL"
  --decompressor "$DECOMPRESSOR"
  --decompressor-workers "$DECOMPRESSOR_WORKERS"
)

if [[ -n "$CLASS_INDEX" ]]; then
  args+=(--class-index "$CLASS_INDEX")
fi
if [[ "$MAX_ENTITIES" -gt 0 ]]; then
  args+=(--max-entities "$MAX_ENTITIES")
fi
if [[ "$LIMIT_MEDIA" -gt 0 ]]; then
  args+=(--limit-media "$LIMIT_MEDIA")
fi
if [[ "$FORCE" -eq 1 ]]; then
  args+=(--force)
fi

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] starting $RUN_NAME" > "$OUT_LOG"
{
  echo "root=$ROOT"
  echo "run_name=$RUN_NAME"
  echo "workers=$WORKERS"
  echo "decompressor=$DECOMPRESSOR"
  echo "decompressor_workers=$DECOMPRESSOR_WORKERS"
  echo "class_index=$CLASS_INDEX"
} >> "$OUT_LOG"

exec python3 "${args[@]}" >> "$OUT_LOG" 2> "$ERR_LOG"
