#!/usr/bin/env python3
"""Validate a normalized Moodarr Wikidata catalog JSONL/JSONL.gz file."""

from __future__ import annotations

import argparse
import gzip
import json
from collections import Counter
from pathlib import Path
from typing import Any


def main() -> int:
    args = parse_args()
    counts: Counter[str] = Counter()
    examples: list[dict[str, Any]] = []
    duplicate_qids: set[str] = set()
    seen_qids: set[str] = set()
    missing_required: list[dict[str, Any]] = []
    title_hits: dict[str, dict[str, Any]] = {}
    wanted_titles = {title.lower(): title for title in args.expect_title}

    for record in read_records(Path(args.file)):
        counts["records"] += 1
        media_type = record.get("mediaType")
        if media_type == "film":
            counts["films"] += 1
        elif media_type == "television series":
            counts["televisionSeries"] += 1
        else:
            counts["unsupportedMediaType"] += 1

        qid = record.get("id") or record.get("wikidataId") or record.get("qid")
        if qid in seen_qids:
            duplicate_qids.add(str(qid))
        if qid:
            seen_qids.add(str(qid))

        for key in ["id", "mediaType", "label"]:
            if not record.get(key):
                missing_required.append({"line": counts["records"], "key": key, "record": record})
                break

        if record.get("description"):
            counts["withDescription"] += 1
        if record.get("imdbId"):
            counts["withImdb"] += 1
        if record.get("tmdbMovieId") or record.get("tmdbTvId"):
            counts["withTmdb"] += 1
        if record.get("tvdbId"):
            counts["withTvdb"] += 1
        if record.get("genreLabels"):
            counts["withGenreLabels"] += 1
        if record.get("castLabels"):
            counts["withCastLabels"] += 1
        if record.get("directorLabels"):
            counts["withDirectorLabels"] += 1
        if record.get("hasEnglishWikipedia"):
            counts["withEnglishWikipedia"] += 1

        title = str(record.get("label", "")).lower()
        if title in wanted_titles and wanted_titles[title] not in title_hits:
            title_hits[wanted_titles[title]] = compact_record(record)
        if len(examples) < args.examples:
            examples.append(compact_record(record))

    ok = not missing_required and not duplicate_qids and counts["records"] >= args.min_records
    result = {
        "ok": ok,
        "file": str(args.file),
        "minRecords": args.min_records,
        "counts": dict(counts),
        "duplicateQids": sorted(duplicate_qids)[:20],
        "missingRequired": missing_required[:20],
        "titleHits": title_hits,
        "missingExpectedTitles": [title for title in args.expect_title if title not in title_hits],
        "examples": examples,
    }
    print(json.dumps(result, indent=2, sort_keys=True, ensure_ascii=False))
    return 0 if ok else 1


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Validate normalized Wikidata catalog JSONL.")
    parser.add_argument("--file", required=True)
    parser.add_argument("--min-records", type=int, default=1)
    parser.add_argument("--examples", type=int, default=5)
    parser.add_argument("--expect-title", action="append", default=[])
    return parser.parse_args()


def read_records(path: Path):
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8") as file:
        for line in file:
            line = line.strip()
            if line:
                yield json.loads(line)


def compact_record(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": record.get("id"),
        "mediaType": record.get("mediaType"),
        "label": record.get("label"),
        "publicationDate": record.get("publicationDate"),
        "imdbId": record.get("imdbId"),
        "tmdbMovieId": record.get("tmdbMovieId"),
        "tmdbTvId": record.get("tmdbTvId"),
        "tvdbId": record.get("tvdbId"),
        "genreLabels": record.get("genreLabels", [])[:5],
    }


if __name__ == "__main__":
    raise SystemExit(main())
