#!/usr/bin/env python3
"""Normalize a Wikidata entity dump into Moodarr catalog JSONL.

This is intentionally streaming and dependency-free. It reads Wikidata's
latest-all.json.bz2 without expanding it to disk, builds a film/TV class index,
extracts candidate media rows, resolves labels for referenced entities, and
emits records accepted by scripts/import-wikidata-catalog.ts.
"""

from __future__ import annotations

import argparse
import bz2
import gzip
import json
import os
import sys
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Any, Iterable


MOVIE_ROOT = "Q11424"
TV_ROOT = "Q5398426"
REFERENCE_FIELDS = {
    "genres": "genreLabels",
    "cast": "castLabels",
    "directors": "directorLabels",
    "countries": "countryLabels",
    "languages": "languageLabels",
    "franchises": "franchiseLabels",
}


def main() -> int:
    args = parse_args()
    started_at = now_iso()
    work_dir = Path(args.work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)

    raw_candidates_path = work_dir / "wikidata-media-candidates.raw.jsonl.gz"
    class_index_path = work_dir / "wikidata-class-index.json"
    reference_ids_path = work_dir / "wikidata-reference-ids.txt"
    reference_labels_path = work_dir / "wikidata-reference-labels.json"
    manifest_path = Path(args.manifest) if args.manifest else output.with_suffix(output.suffix + ".manifest.json")

    log(f"pass 1/4: building class index from {args.dump}")
    class_index = build_class_index(args.dump, args.max_entities, args.progress_interval)
    write_json(class_index_path, class_index)
    movie_classes = set(class_index["movieClasses"])
    tv_classes = set(class_index["tvClasses"])
    log(f"class index: {len(movie_classes)} movie classes, {len(tv_classes)} tv classes")

    log("pass 2/4: extracting media candidates")
    extraction = extract_media_candidates(
        args.dump,
        raw_candidates_path,
        reference_ids_path,
        movie_classes,
        tv_classes,
        limit_media=args.limit_media,
        max_entities=args.max_entities,
        min_sitelinks=args.min_sitelinks,
        require_external_id=args.require_external_id,
        progress_interval=args.progress_interval,
    )
    log(f"extracted {extraction['candidateRecords']} candidate record(s); referenced {extraction['referenceIds']} label id(s)")

    log("pass 3/4: resolving referenced labels")
    labels = resolve_reference_labels(args.dump, reference_ids_path, args.max_entities, args.progress_interval)
    write_json(reference_labels_path, labels)
    log(f"resolved {len(labels)} referenced label(s)")

    log(f"pass 4/4: writing normalized output to {output}")
    output_summary = write_normalized_output(raw_candidates_path, output, labels)

    finished_at = now_iso()
    manifest = {
        "schemaVersion": "moodarr-wikidata-dump-normalizer-v1",
        "startedAt": started_at,
        "finishedAt": finished_at,
        "dumpPath": str(Path(args.dump)),
        "sourceVersion": args.source_version,
        "outputPath": str(output),
        "workDir": str(work_dir),
        "limits": {
            "limitMedia": args.limit_media,
            "maxEntities": args.max_entities,
            "minSitelinks": args.min_sitelinks,
            "requireExternalId": args.require_external_id,
        },
        "classIndex": {
            "movieRoot": MOVIE_ROOT,
            "tvRoot": TV_ROOT,
            "movieClasses": len(movie_classes),
            "tvClasses": len(tv_classes),
            "path": str(class_index_path),
        },
        "counts": {
            **extraction,
            **output_summary,
        },
        "intermediateFiles": {
            "rawCandidates": str(raw_candidates_path),
            "referenceIds": str(reference_ids_path),
            "referenceLabels": str(reference_labels_path),
        },
    }
    write_json(manifest_path, manifest)
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Normalize a Wikidata latest-all JSON dump for Moodarr catalog import.")
    parser.add_argument("--dump", required=True, help="Path to latest-all.json.bz2")
    parser.add_argument("--output", required=True, help="Output .jsonl or .jsonl.gz path")
    parser.add_argument("--work-dir", required=True, help="Directory for intermediate files")
    parser.add_argument("--source-version", required=True, help="Source version string for manifest/provenance")
    parser.add_argument("--manifest", help="Optional manifest output path")
    parser.add_argument("--limit-media", type=int, help="Stop after N matched media records")
    parser.add_argument("--max-entities", type=int, help="Stop each dump pass after N entities; useful for smoke tests")
    parser.add_argument("--min-sitelinks", type=int, default=0, help="Minimum total sitelinks required for output")
    parser.add_argument("--require-external-id", action="store_true", help="Require at least one IMDb/TMDb/TVDB ID")
    parser.add_argument("--progress-interval", type=int, default=250_000, help="Entities between progress logs")
    return parser.parse_args()


def build_class_index(dump_path: str, max_entities: int | None, progress_interval: int) -> dict[str, Any]:
    parent_to_children: dict[str, set[str]] = defaultdict(set)
    entities_seen = 0
    subclass_edges = 0
    for entity in iter_entities(dump_path):
        entities_seen += 1
        entity_id = entity.get("id")
        if entity_id:
            for parent_id in entity_id_claims(entity, "P279"):
                parent_to_children[parent_id].add(entity_id)
                subclass_edges += 1
        if progress_due(entities_seen, progress_interval):
            log(f"class pass: {entities_seen:,} entities, {subclass_edges:,} subclass edges")
        if max_entities and entities_seen >= max_entities:
            break

    movie_classes = closure(MOVIE_ROOT, parent_to_children)
    tv_classes = closure(TV_ROOT, parent_to_children)
    return {
        "entitiesSeen": entities_seen,
        "subclassEdges": subclass_edges,
        "movieClasses": sorted(movie_classes),
        "tvClasses": sorted(tv_classes),
    }


def extract_media_candidates(
    dump_path: str,
    raw_candidates_path: Path,
    reference_ids_path: Path,
    movie_classes: set[str],
    tv_classes: set[str],
    *,
    limit_media: int | None,
    max_entities: int | None,
    min_sitelinks: int,
    require_external_id: bool,
    progress_interval: int,
) -> dict[str, int]:
    counts = {
        "entitiesScanned": 0,
        "candidateRecords": 0,
        "movieRecords": 0,
        "tvRecords": 0,
        "skippedNoEnglishLabel": 0,
        "skippedLowSitelinks": 0,
        "skippedNoExternalId": 0,
    }
    reference_ids: set[str] = set()

    with gzip.open(raw_candidates_path, "wt", encoding="utf-8", newline="\n") as out:
        for entity in iter_entities(dump_path):
            counts["entitiesScanned"] += 1
            record = candidate_from_entity(entity, movie_classes, tv_classes)
            if record is not None:
                sitelink_count = int(record.get("sitelinkCount") or 0)
                if not record.get("label"):
                    counts["skippedNoEnglishLabel"] += 1
                elif sitelink_count < min_sitelinks:
                    counts["skippedLowSitelinks"] += 1
                elif require_external_id and not has_external_id(record):
                    counts["skippedNoExternalId"] += 1
                else:
                    out.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
                    counts["candidateRecords"] += 1
                    if record["mediaType"] == "film":
                        counts["movieRecords"] += 1
                    else:
                        counts["tvRecords"] += 1
                    for field in REFERENCE_FIELDS:
                        reference_ids.update(record.pop(field, []))
                    if limit_media and counts["candidateRecords"] >= limit_media:
                        break

            if progress_due(counts["entitiesScanned"], progress_interval):
                log(f"extract pass: {counts['entitiesScanned']:,} entities, {counts['candidateRecords']:,} candidates")
            if max_entities and counts["entitiesScanned"] >= max_entities:
                break

    reference_ids_path.write_text("\n".join(sorted(reference_ids)) + ("\n" if reference_ids else ""), encoding="utf-8")
    counts["referenceIds"] = len(reference_ids)
    return counts


def resolve_reference_labels(
    dump_path: str,
    reference_ids_path: Path,
    max_entities: int | None,
    progress_interval: int,
) -> dict[str, str]:
    wanted = set(reference_ids_path.read_text(encoding="utf-8").splitlines()) if reference_ids_path.exists() else set()
    labels: dict[str, str] = {}
    if not wanted:
        return labels

    entities_seen = 0
    for entity in iter_entities(dump_path):
        entities_seen += 1
        entity_id = entity.get("id")
        if entity_id in wanted:
            label = english_label(entity)
            if label:
                labels[entity_id] = label
            if len(labels) >= len(wanted):
                break
        if progress_due(entities_seen, progress_interval):
            log(f"label pass: {entities_seen:,} entities, {len(labels):,}/{len(wanted):,} labels")
        if max_entities and entities_seen >= max_entities:
            break
    return labels


def write_normalized_output(raw_candidates_path: Path, output: Path, labels: dict[str, str]) -> dict[str, int]:
    opener = gzip.open if output.suffix == ".gz" else open
    counts = {
        "outputRecords": 0,
        "outputMovieRecords": 0,
        "outputTvRecords": 0,
        "recordsWithImdb": 0,
        "recordsWithTmdb": 0,
        "recordsWithTvdb": 0,
        "recordsWithDescription": 0,
        "recordsWithGenreLabels": 0,
        "recordsWithCastLabels": 0,
        "recordsWithDirectorLabels": 0,
    }
    with gzip.open(raw_candidates_path, "rt", encoding="utf-8") as raw, opener(output, "wt", encoding="utf-8", newline="\n") as out:
        for line in raw:
            record = json.loads(line)
            for raw_field, output_field in REFERENCE_FIELDS.items():
                values = label_values(record.pop(raw_field, []), labels)
                if values:
                    record[output_field] = values
            out.write(json.dumps(record, ensure_ascii=False, sort_keys=True) + "\n")
            counts["outputRecords"] += 1
            if record["mediaType"] == "film":
                counts["outputMovieRecords"] += 1
            else:
                counts["outputTvRecords"] += 1
            if record.get("imdbId"):
                counts["recordsWithImdb"] += 1
            if record.get("tmdbMovieId") or record.get("tmdbTvId"):
                counts["recordsWithTmdb"] += 1
            if record.get("tvdbId"):
                counts["recordsWithTvdb"] += 1
            if record.get("description"):
                counts["recordsWithDescription"] += 1
            if record.get("genreLabels"):
                counts["recordsWithGenreLabels"] += 1
            if record.get("castLabels"):
                counts["recordsWithCastLabels"] += 1
            if record.get("directorLabels"):
                counts["recordsWithDirectorLabels"] += 1
    return counts


def candidate_from_entity(entity: dict[str, Any], movie_classes: set[str], tv_classes: set[str]) -> dict[str, Any] | None:
    entity_id = entity.get("id")
    if not entity_id:
        return None
    instance_classes = set(entity_id_claims(entity, "P31"))
    is_movie = bool(instance_classes & movie_classes)
    is_tv = bool(instance_classes & tv_classes)
    if not is_movie and not is_tv:
        return None

    sitelinks = entity.get("sitelinks") or {}
    publication_dates = sorted(time_claims(entity, "P577"))
    record: dict[str, Any] = {
        "id": entity_id,
        "mediaType": "film" if is_movie and not is_tv else "television series",
        "label": english_label(entity),
        "description": english_description(entity),
        "aliases": english_aliases(entity),
        "publicationDate": publication_dates[0] if publication_dates else None,
        "genres": entity_id_claims(entity, "P136"),
        "cast": entity_id_claims(entity, "P161")[:24],
        "directors": entity_id_claims(entity, "P57")[:12],
        "countries": entity_id_claims(entity, "P495"),
        "languages": entity_id_claims(entity, "P364"),
        "franchises": entity_id_claims(entity, "P179"),
        "imdbId": first_string_claim(entity, "P345"),
        "tmdbMovieId": first_string_claim(entity, "P4947"),
        "tmdbTvId": first_string_claim(entity, "P4983"),
        "tvdbId": first_string_claim(entity, "P4835"),
        "sitelinkCount": len(sitelinks),
        "hasEnglishWikipedia": "enwiki" in sitelinks,
    }
    return {key: value for key, value in record.items() if value not in (None, "", [])}


def iter_entities(path: str) -> Iterable[dict[str, Any]]:
    with bz2.open(path, "rt", encoding="utf-8") as dump:
        for line in dump:
            line = line.strip()
            if not line or line in ("[", "]"):
                continue
            if line.endswith(","):
                line = line[:-1]
            if not line:
                continue
            yield json.loads(line)


def entity_id_claims(entity: dict[str, Any], property_id: str) -> list[str]:
    values: list[str] = []
    for value in claim_values(entity, property_id):
        if isinstance(value, dict):
            entity_id = value.get("id")
            if isinstance(entity_id, str):
                values.append(entity_id)
    return unique(values)


def time_claims(entity: dict[str, Any], property_id: str) -> list[str]:
    values: list[str] = []
    for value in claim_values(entity, property_id):
        if isinstance(value, dict) and isinstance(value.get("time"), str):
            values.append(normalize_wikidata_time(value["time"]))
    return unique([value for value in values if value])


def first_string_claim(entity: dict[str, Any], property_id: str) -> str | None:
    for value in claim_values(entity, property_id):
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def claim_values(entity: dict[str, Any], property_id: str) -> Iterable[Any]:
    claims = entity.get("claims") or {}
    for claim in claims.get(property_id, []):
        mainsnak = claim.get("mainsnak") or {}
        if mainsnak.get("snaktype") != "value":
            continue
        datavalue = mainsnak.get("datavalue") or {}
        if "value" in datavalue:
            yield datavalue["value"]


def english_label(entity: dict[str, Any]) -> str | None:
    value = ((entity.get("labels") or {}).get("en") or {}).get("value")
    return clean_text(value)


def english_description(entity: dict[str, Any]) -> str | None:
    value = ((entity.get("descriptions") or {}).get("en") or {}).get("value")
    return clean_text(value)


def english_aliases(entity: dict[str, Any]) -> list[str]:
    aliases = (entity.get("aliases") or {}).get("en") or []
    return unique([clean_text(alias.get("value")) for alias in aliases if isinstance(alias, dict)])


def normalize_wikidata_time(value: str) -> str:
    cleaned = value.strip().lstrip("+")
    if cleaned.startswith("-"):
        return ""
    return cleaned.replace("T00:00:00Z", "")


def label_values(ids: list[str], labels: dict[str, str]) -> list[str]:
    return unique([labels.get(entity_id) for entity_id in ids if labels.get(entity_id)])


def has_external_id(record: dict[str, Any]) -> bool:
    return bool(record.get("imdbId") or record.get("tmdbMovieId") or record.get("tmdbTvId") or record.get("tvdbId"))


def closure(root: str, parent_to_children: dict[str, set[str]]) -> set[str]:
    seen = {root}
    queue: deque[str] = deque([root])
    while queue:
        current = queue.popleft()
        for child in parent_to_children.get(current, set()):
            if child not in seen:
                seen.add(child)
                queue.append(child)
    return seen


def clean_text(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = " ".join(value.split()).strip()
    return cleaned or None


def unique(values: Iterable[str | None]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for value in values:
        if not value or value in seen:
            continue
        seen.add(value)
        output.append(value)
    return output


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def progress_due(count: int, interval: int) -> bool:
    return interval > 0 and count > 0 and count % interval == 0


def log(message: str) -> None:
    print(f"[wikidata-normalizer] {message}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
