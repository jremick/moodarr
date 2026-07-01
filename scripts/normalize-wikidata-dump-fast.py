#!/usr/bin/env python3
"""Fast Wikidata dump normalizer for Moodarr catalog runs.

This preserves the v1 candidate semantics while optimizing the expensive path:

- reuse an existing class index when available;
- prefilter raw dump lines before JSON parsing;
- parse candidate extraction across worker processes;
- resolve referenced labels with an entity-id prefilter so most lines are not
  JSON parsed during the label pass.

It is designed to run side-by-side with the original normalizer by using a
separate work directory, run name, and output paths.
"""

from __future__ import annotations

import argparse
import bz2
import gzip
import json
import os
import shutil
import subprocess
import sys
import time
import traceback
from collections import Counter, defaultdict, deque
from multiprocessing import get_context
from pathlib import Path
from typing import Any, Iterable, Iterator

try:
    import orjson  # type: ignore
except ImportError:  # pragma: no cover - optional acceleration
    orjson = None


MOVIE_ROOT = "Q11424"
TV_ROOT = "Q5398426"
ENTITY_ID_MARKER = b'"id":"'
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
    manifest_path = Path(args.manifest) if args.manifest else output.with_suffix(output.suffix + ".manifest.json")

    if not args.force:
        for path in (output, manifest_path):
            if path.exists():
                raise SystemExit(f"{path} already exists; pass --force to overwrite")

    raw_shards_dir = work_dir / "candidate-shards"
    raw_shards_dir.mkdir(parents=True, exist_ok=True)
    reference_parts_dir = work_dir / "reference-parts"
    reference_parts_dir.mkdir(parents=True, exist_ok=True)
    class_index_path = work_dir / "wikidata-class-index.json"
    reference_ids_path = work_dir / "wikidata-reference-ids.txt"
    reference_labels_path = work_dir / "wikidata-reference-labels.json"

    log(f"fast normalizer starting with json backend: {'orjson' if orjson else 'json'}")

    if args.class_index:
        source_class_index_path = Path(args.class_index)
        log(f"loading class index from {source_class_index_path}")
        class_index = read_json(source_class_index_path)
        write_json(class_index_path, class_index)
    else:
        log(f"pass 1/4: building class index from {args.dump}")
        class_index = build_class_index_fast(
            args.dump,
            args.max_entities,
            args.progress_interval,
            args.decompressor,
            args.decompressor_workers,
        )
        write_json(class_index_path, class_index)

    movie_classes = set(class_index["movieClasses"])
    tv_classes = set(class_index["tvClasses"])
    log(f"class index: {len(movie_classes)} movie classes, {len(tv_classes)} tv classes")

    log(f"pass 2/4: extracting media candidates with {args.workers} worker(s)")
    extraction = extract_media_candidates_parallel(
        args.dump,
        raw_shards_dir,
        reference_parts_dir,
        reference_ids_path,
        movie_classes,
        tv_classes,
        workers=args.workers,
        batch_size=args.batch_size,
        queue_batches=args.queue_batches,
        limit_media=args.limit_media,
        max_entities=args.max_entities,
        min_sitelinks=args.min_sitelinks,
        require_external_id=args.require_external_id,
        progress_interval=args.progress_interval,
        decompressor=args.decompressor,
        decompressor_workers=args.decompressor_workers,
    )
    log(f"extracted {extraction['candidateRecords']} candidate record(s); referenced {extraction['referenceIds']} label id(s)")

    log("pass 3/4: resolving referenced labels with fast id prefilter")
    labels = resolve_reference_labels_fast(
        args.dump,
        reference_ids_path,
        args.max_entities,
        args.progress_interval,
        args.decompressor,
        args.decompressor_workers,
    )
    write_json(reference_labels_path, labels)
    log(f"resolved {len(labels)} referenced label(s)")

    log(f"pass 4/4: writing normalized output to {output}")
    output_summary = write_normalized_output_fast(
        [Path(path) for path in extraction["rawCandidateShards"]],
        output,
        labels,
        gzip_level=args.output_gzip_level,
    )

    finished_at = now_iso()
    manifest = {
        "schemaVersion": "moodarr-wikidata-dump-fast-normalizer-v1",
        "startedAt": started_at,
        "finishedAt": finished_at,
        "dumpPath": str(Path(args.dump)),
        "sourceVersion": args.source_version,
        "outputPath": str(output),
        "workDir": str(work_dir),
        "jsonBackend": "orjson" if orjson else "json",
        "limits": {
            "limitMedia": args.limit_media,
            "maxEntities": args.max_entities,
            "minSitelinks": args.min_sitelinks,
            "requireExternalId": args.require_external_id,
        },
        "performance": {
            "workers": args.workers,
            "batchSize": args.batch_size,
            "queueBatches": args.queue_batches,
            "decompressor": args.decompressor,
            "decompressorWorkers": args.decompressor_workers,
            "outputGzipLevel": args.output_gzip_level,
        },
        "classIndex": {
            "movieRoot": MOVIE_ROOT,
            "tvRoot": TV_ROOT,
            "movieClasses": len(movie_classes),
            "tvClasses": len(tv_classes),
            "path": str(class_index_path),
            "sourcePath": args.class_index,
        },
        "counts": {
            **{key: value for key, value in extraction.items() if key != "rawCandidateShards"},
            **output_summary,
        },
        "intermediateFiles": {
            "rawCandidateShards": extraction["rawCandidateShards"],
            "referenceIds": str(reference_ids_path),
            "referenceLabels": str(reference_labels_path),
        },
    }
    write_json(manifest_path, manifest)
    print(json.dumps(manifest, indent=2, sort_keys=True))
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Fast-normalize a Wikidata latest-all JSON dump for Moodarr catalog import.")
    parser.add_argument("--dump", required=True, help="Path to latest-all.json.bz2")
    parser.add_argument("--output", required=True, help="Output .jsonl or .jsonl.gz path")
    parser.add_argument("--work-dir", required=True, help="Directory for intermediate files")
    parser.add_argument("--source-version", required=True, help="Source version string for manifest/provenance")
    parser.add_argument("--manifest", help="Optional manifest output path")
    parser.add_argument("--class-index", help="Existing v1/v2 class-index JSON to reuse")
    parser.add_argument("--limit-media", type=int, help="Stop after N matched media records")
    parser.add_argument("--max-entities", type=int, help="Stop each dump pass after N entities; useful for smoke tests")
    parser.add_argument("--min-sitelinks", type=int, default=0, help="Minimum total sitelinks required for output")
    parser.add_argument("--require-external-id", action="store_true", help="Require at least one IMDb/TMDb/TVDB ID")
    parser.add_argument("--progress-interval", type=int, default=250_000, help="Entities between progress logs")
    parser.add_argument("--workers", type=int, default=default_workers(), help="Candidate parser worker processes")
    parser.add_argument("--batch-size", type=int, default=250, help="Raw entity lines per worker queue batch")
    parser.add_argument("--queue-batches", type=int, default=8, help="Max queued batches per worker")
    parser.add_argument("--output-gzip-level", type=int, default=1, choices=range(1, 10), help="Final gzip compression level")
    parser.add_argument("--decompressor", choices=("auto", "python", "lbzip2", "pbzip2", "bzip2"), default="auto")
    parser.add_argument("--decompressor-workers", type=int, default=0, help="Worker threads for lbzip2/pbzip2 when supported")
    parser.add_argument("--force", action="store_true", help="Overwrite existing output/manifest paths")
    return parser.parse_args()


def default_workers() -> int:
    cpu_count = os.cpu_count() or 2
    return max(2, min(12, cpu_count // 2))


def build_class_index_fast(
    dump_path: str,
    max_entities: int | None,
    progress_interval: int,
    decompressor: str,
    decompressor_workers: int,
) -> dict[str, Any]:
    parent_to_children: dict[str, set[str]] = defaultdict(set)
    entities_seen = 0
    p279_lines_parsed = 0
    subclass_edges = 0
    for line in iter_raw_entity_lines(dump_path, decompressor, decompressor_workers):
        entities_seen += 1
        if b'"P279"' in line:
            p279_lines_parsed += 1
            entity = json_loads_line(line)
            entity_id = entity.get("id")
            if entity_id:
                for parent_id in entity_id_claims(entity, "P279"):
                    parent_to_children[parent_id].add(entity_id)
                    subclass_edges += 1
        if progress_due(entities_seen, progress_interval):
            log(f"class pass: {entities_seen:,} entities, {p279_lines_parsed:,} P279 lines parsed, {subclass_edges:,} subclass edges")
        if max_entities and entities_seen >= max_entities:
            break

    movie_classes = closure(MOVIE_ROOT, parent_to_children)
    tv_classes = closure(TV_ROOT, parent_to_children)
    return {
        "entitiesSeen": entities_seen,
        "p279LinesParsed": p279_lines_parsed,
        "subclassEdges": subclass_edges,
        "movieClasses": sorted(movie_classes),
        "tvClasses": sorted(tv_classes),
    }


def extract_media_candidates_parallel(
    dump_path: str,
    raw_shards_dir: Path,
    reference_parts_dir: Path,
    reference_ids_path: Path,
    movie_classes: set[str],
    tv_classes: set[str],
    *,
    workers: int,
    batch_size: int,
    queue_batches: int,
    limit_media: int | None,
    max_entities: int | None,
    min_sitelinks: int,
    require_external_id: bool,
    progress_interval: int,
    decompressor: str,
    decompressor_workers: int,
) -> dict[str, Any]:
    ctx = get_context("spawn")
    queues = [ctx.Queue(maxsize=queue_batches) for _ in range(workers)]
    result_queue = ctx.Queue()
    accepted_counter = ctx.Value("i", 0)
    processes = []
    raw_shards: list[Path] = []
    reference_parts: list[Path] = []

    for worker_id in range(workers):
        raw_path = raw_shards_dir / f"wikidata-media-candidates.part-{worker_id:02d}.jsonl"
        refs_path = reference_parts_dir / f"wikidata-reference-ids.part-{worker_id:02d}.txt"
        raw_shards.append(raw_path)
        reference_parts.append(refs_path)
        process = ctx.Process(
            target=candidate_worker,
            args=(
                worker_id,
                queues[worker_id],
                result_queue,
                accepted_counter,
                movie_classes,
                tv_classes,
                str(raw_path),
                str(refs_path),
                min_sitelinks,
                require_external_id,
            ),
        )
        process.start()
        processes.append(process)

    entities_scanned = 0
    p31_lines_queued = 0
    batches = [[] for _ in range(workers)]
    next_worker = 0

    try:
        for line in iter_raw_entity_lines(dump_path, decompressor, decompressor_workers):
            entities_scanned += 1
            if b'"P31"' in line:
                batches[next_worker].append(line)
                p31_lines_queued += 1
                if len(batches[next_worker]) >= batch_size:
                    queues[next_worker].put(batches[next_worker])
                    batches[next_worker] = []
                    next_worker = (next_worker + 1) % workers
            if progress_due(entities_scanned, progress_interval):
                log(
                    "fast extract scan: "
                    f"{entities_scanned:,} entities, "
                    f"{p31_lines_queued:,} P31 lines queued, "
                    f"{accepted_counter.value:,} candidates accepted"
                )
            if limit_media and accepted_counter.value >= limit_media:
                log(f"fast extract stopping after reaching limit-media target: {accepted_counter.value:,}")
                break
            if max_entities and entities_scanned >= max_entities:
                break
    finally:
        for worker_id, batch in enumerate(batches):
            if batch:
                queues[worker_id].put(batch)
        for queue in queues:
            queue.put(None)

    counts = Counter({
        "entitiesScanned": entities_scanned,
        "p31LinesQueued": p31_lines_queued,
        "candidateRecords": 0,
        "movieRecords": 0,
        "tvRecords": 0,
        "skippedNoEnglishLabel": 0,
        "skippedLowSitelinks": 0,
        "skippedNoExternalId": 0,
        "jsonErrors": 0,
    })
    errors: list[str] = []
    completed_workers = 0
    while completed_workers < workers:
        message = result_queue.get()
        if message.get("type") == "done":
            counts.update(message["counts"])
            completed_workers += 1
        elif message.get("type") == "error":
            errors.append(f"worker {message.get('workerId')}: {message.get('traceback')}")
            completed_workers += 1

    for process in processes:
        process.join()
        if process.exitcode != 0:
            errors.append(f"worker process {process.pid} exited with {process.exitcode}")

    if errors:
        raise RuntimeError("\n".join(errors))

    reference_ids = merge_reference_parts(reference_parts, reference_ids_path)
    counts["referenceIds"] = len(reference_ids)
    return {
        **dict(counts),
        "workers": workers,
        "rawCandidateShards": [str(path) for path in raw_shards],
    }


def candidate_worker(
    worker_id: int,
    in_queue: Any,
    result_queue: Any,
    accepted_counter: Any,
    movie_classes: set[str],
    tv_classes: set[str],
    raw_path: str,
    refs_path: str,
    min_sitelinks: int,
    require_external_id: bool,
) -> None:
    counts = Counter()
    reference_ids: set[str] = set()
    try:
        with open(raw_path, "wb", buffering=1024 * 1024) as out:
            while True:
                batch = in_queue.get()
                if batch is None:
                    break
                counts["p31LinesParsed"] += len(batch)
                for line in batch:
                    entity = json_loads_line(line)
                    record = candidate_from_entity(entity, movie_classes, tv_classes)
                    if record is None:
                        continue
                    sitelink_count = int(record.get("sitelinkCount") or 0)
                    if not record.get("label"):
                        counts["skippedNoEnglishLabel"] += 1
                    elif sitelink_count < min_sitelinks:
                        counts["skippedLowSitelinks"] += 1
                    elif require_external_id and not has_external_id(record):
                        counts["skippedNoExternalId"] += 1
                    else:
                        out.write(json_dumps_line(record))
                        counts["candidateRecords"] += 1
                        if record["mediaType"] == "film":
                            counts["movieRecords"] += 1
                        else:
                            counts["tvRecords"] += 1
                        for field in REFERENCE_FIELDS:
                            reference_ids.update(record.get(field, []))
                        with accepted_counter.get_lock():
                            accepted_counter.value += 1
        Path(refs_path).write_text("\n".join(sorted(reference_ids)) + ("\n" if reference_ids else ""), encoding="utf-8")
        result_queue.put({"type": "done", "workerId": worker_id, "counts": dict(counts)})
    except Exception:
        result_queue.put({"type": "error", "workerId": worker_id, "traceback": traceback.format_exc()})
        raise


def merge_reference_parts(reference_parts: list[Path], output_path: Path) -> set[str]:
    reference_ids: set[str] = set()
    for part in reference_parts:
        if not part.exists():
            continue
        reference_ids.update(line for line in part.read_text(encoding="utf-8").splitlines() if line)
    output_path.write_text("\n".join(sorted(reference_ids)) + ("\n" if reference_ids else ""), encoding="utf-8")
    return reference_ids


def resolve_reference_labels_fast(
    dump_path: str,
    reference_ids_path: Path,
    max_entities: int | None,
    progress_interval: int,
    decompressor: str,
    decompressor_workers: int,
) -> dict[str, str]:
    wanted = set(reference_ids_path.read_text(encoding="utf-8").splitlines()) if reference_ids_path.exists() else set()
    wanted_bytes = {value.encode("utf-8") for value in wanted}
    labels: dict[str, str] = {}
    if not wanted:
        return labels

    entities_seen = 0
    id_prefilter_hits = 0
    for line in iter_raw_entity_lines(dump_path, decompressor, decompressor_workers):
        entities_seen += 1
        entity_id_bytes = fast_entity_id_bytes(line)
        if entity_id_bytes in wanted_bytes:
            id_prefilter_hits += 1
            entity = json_loads_line(line)
            entity_id = entity.get("id")
            if isinstance(entity_id, str):
                label = english_label(entity)
                if label:
                    labels[entity_id] = label
                if len(labels) >= len(wanted):
                    break
        if progress_due(entities_seen, progress_interval):
            log(
                "fast label pass: "
                f"{entities_seen:,} entities, "
                f"{id_prefilter_hits:,} id hits, "
                f"{len(labels):,}/{len(wanted):,} labels"
            )
        if max_entities and entities_seen >= max_entities:
            break
    return labels


def write_normalized_output_fast(
    raw_candidate_shards: list[Path],
    output: Path,
    labels: dict[str, str],
    *,
    gzip_level: int,
) -> dict[str, int]:
    counts = Counter({
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
    })
    opener = (
        lambda path: gzip.open(path, "wb", compresslevel=gzip_level)
        if output.suffix == ".gz"
        else open(path, "wb", buffering=1024 * 1024)
    )
    with opener(output) as out:
        for shard in raw_candidate_shards:
            with open(shard, "rb", buffering=1024 * 1024) as raw:
                for line in raw:
                    record = json_loads_line(line)
                    for raw_field, output_field in REFERENCE_FIELDS.items():
                        values = label_values(record.pop(raw_field, []), labels)
                        if values:
                            record[output_field] = values
                    out.write(json_dumps_line(record))
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
    return dict(counts)


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


def iter_raw_entity_lines(path: str, decompressor: str, decompressor_workers: int = 0) -> Iterator[bytes]:
    stream = raw_dump_line_stream(path, decompressor, decompressor_workers)
    for line in stream:
        line = line.strip()
        if not line or line in (b"[", b"]"):
            continue
        if line.endswith(b","):
            line = line[:-1]
        if line:
            yield line


def raw_dump_line_stream(path: str, decompressor: str, decompressor_workers: int) -> Iterator[bytes]:
    command = resolve_decompressor_command(path, decompressor, decompressor_workers)
    if command is None:
        with bz2.open(path, "rb") as dump:
            yield from dump
        return

    log(f"using external decompressor: {' '.join(command)}")
    process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    assert process.stdout is not None
    assert process.stderr is not None
    try:
        yield from process.stdout
    finally:
        process.stdout.close()
        stderr = process.stderr.read().decode("utf-8", errors="replace")
        return_code = process.wait()
        if return_code not in (0, -13, 141):
            raise RuntimeError(f"decompressor exited with {return_code}: {stderr.strip()}")


def resolve_decompressor_command(path: str, decompressor: str, decompressor_workers: int) -> list[str] | None:
    if decompressor == "python":
        return None
    candidates = ["lbzip2", "pbzip2", "bzip2"] if decompressor == "auto" else [decompressor]
    for candidate in candidates:
        executable = shutil.which(candidate)
        if executable:
            if candidate == "lbzip2" and decompressor_workers > 0:
                return [executable, "-n", str(decompressor_workers), "-dc", path]
            if candidate == "pbzip2" and decompressor_workers > 0:
                return [executable, "-p", str(decompressor_workers), "-dc", path]
            return [executable, "-dc", path]
    if decompressor != "auto":
        raise RuntimeError(f"decompressor '{decompressor}' was requested but is not available on PATH")
    return None


def fast_entity_id_bytes(line: bytes) -> bytes | None:
    marker_index = line.find(ENTITY_ID_MARKER)
    if marker_index < 0:
        return None
    start = marker_index + len(ENTITY_ID_MARKER)
    end = line.find(b'"', start)
    if end < 0:
        return None
    return line[start:end]


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


def json_loads_line(line: bytes) -> dict[str, Any]:
    if orjson:
        return orjson.loads(line)
    return json.loads(line)


def json_dumps_line(value: dict[str, Any]) -> bytes:
    if orjson:
        return orjson.dumps(value) + b"\n"
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def progress_due(count: int, interval: int) -> bool:
    return interval > 0 and count > 0 and count % interval == 0


def log(message: str) -> None:
    print(f"[wikidata-fast-normalizer] {message}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
