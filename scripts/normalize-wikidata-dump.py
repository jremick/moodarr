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
import contextlib
import gzip
import hashlib
import io
import json
import re
import sys
from collections import defaultdict, deque
from pathlib import Path
from typing import Any, Iterable, Iterator


MOVIE_ROOT = "Q11424"
TV_ROOT = "Q5398426"
MAX_SAFE_INTEGER = 9_007_199_254_740_991
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

    manifest = {
        "schemaVersion": "moodarr-wikidata-dump-normalizer-v2",
        "sourceVersion": args.source_version,
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
        },
        "output": {
            "format": "gzip-jsonl" if output.suffix == ".gz" else "jsonl",
            "deterministicGzipHeader": output.suffix == ".gz",
            **file_integrity(output),
        },
        "counts": {
            **extraction,
            **output_summary,
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
    parser.add_argument("--source-version", required=True, type=public_identifier, help="Public-safe source version for manifest/provenance")
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
    counts = {
        "outputRecords": 0,
        "outputMovieRecords": 0,
        "outputTvRecords": 0,
        "recordsWithImdb": 0,
        "recordsWithTmdb": 0,
        "recordsWithTypeMatchedTmdb": 0,
        "wrongNamespaceOnlyRecords": 0,
        "invalidTypeMatchedTmdbRecords": 0,
        "recordsWithTvdb": 0,
        "recordsWithDescription": 0,
        "recordsWithGenreLabels": 0,
        "recordsWithCastLabels": 0,
        "recordsWithDirectorLabels": 0,
    }
    identity_graph = IdentityGraph()
    with gzip.open(raw_candidates_path, "rt", encoding="utf-8") as raw, open_normalized_text_output(output) as out:
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
            has_raw_tmdb = bool(record.get("tmdbMovieId") or record.get("tmdbTvId"))
            has_raw_type_matched_tmdb = bool(
                record.get("tmdbMovieId") if record.get("mediaType") == "film" else record.get("tmdbTvId")
            )
            canonical_tmdb_id = canonical_type_matched_tmdb_id(record)
            if has_raw_tmdb:
                counts["recordsWithTmdb"] += 1
            if canonical_tmdb_id:
                counts["recordsWithTypeMatchedTmdb"] += 1
            elif has_raw_type_matched_tmdb:
                counts["invalidTypeMatchedTmdbRecords"] += 1
            elif has_raw_tmdb:
                counts["wrongNamespaceOnlyRecords"] += 1
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
            identity_graph.add(
                record,
                request_attempt_pre_ambiguity_eligible(record, canonical_tmdb_id),
                canonical_tmdb_id,
            )
    finalize_request_attempt_counts(counts, identity_graph.components())
    return counts


class IdentityGraph:
    def __init__(self) -> None:
        self.parents: list[int] = []
        self.ranks: list[int] = []
        self.records: list[tuple[str, bool]] = []
        self.identity_owners: dict[str, int] = {}

    def add(self, record: dict[str, Any], pre_ambiguity_eligible: bool, canonical_tmdb_id: str | None) -> None:
        index = len(self.parents)
        self.parents.append(index)
        self.ranks.append(0)
        self.records.append((record["mediaType"], pre_ambiguity_eligible))
        for identity in strong_identity_keys(record, canonical_tmdb_id):
            owner = self.identity_owners.get(identity)
            if owner is None:
                self.identity_owners[identity] = index
            else:
                self.union(index, owner)

    def components(self) -> list[dict[str, Any]]:
        groups: dict[int, dict[str, Any]] = {}
        for index, (media_type, pre_ambiguity_eligible) in enumerate(self.records):
            root = self.find(index)
            group = groups.setdefault(root, {"mediaType": media_type, "records": 0, "preAmbiguityEligibleRecords": 0})
            if group["mediaType"] != media_type:
                raise RuntimeError("catalog strong-identity component crossed media types")
            group["records"] += 1
            if pre_ambiguity_eligible:
                group["preAmbiguityEligibleRecords"] += 1
        return list(groups.values())

    def find(self, index: int) -> int:
        if self.parents[index] != index:
            self.parents[index] = self.find(self.parents[index])
        return self.parents[index]

    def union(self, left: int, right: int) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root == right_root:
            return
        if self.ranks[left_root] < self.ranks[right_root]:
            left_root, right_root = right_root, left_root
        self.parents[right_root] = left_root
        if self.ranks[left_root] == self.ranks[right_root]:
            self.ranks[left_root] += 1


def finalize_request_attempt_counts(counts: dict[str, int], identity_groups: list[dict[str, Any]]) -> None:
    counts["recordsWithSummary"] = counts["recordsWithDescription"]
    counts["recordsWithGenres"] = counts["recordsWithGenreLabels"]
    for key in (
        "requestAttemptPreAmbiguityEligibleRecords",
        "ambiguousIdentityGroups",
        "ambiguousIdentityRecords",
        "ambiguousEligibleRecords",
        "ambiguousEligibleMovieRecords",
        "ambiguousEligibleTvRecords",
        "requestAttemptEligibleRecords",
        "eligibleMovieRecords",
        "eligibleTvRecords",
    ):
        counts[key] = 0
    for group in identity_groups:
        eligible = group["preAmbiguityEligibleRecords"]
        counts["requestAttemptPreAmbiguityEligibleRecords"] += eligible
        if group["records"] == 1:
            counts["requestAttemptEligibleRecords"] += eligible
            key = "eligibleMovieRecords" if group["mediaType"] == "film" else "eligibleTvRecords"
            counts[key] += eligible
            continue
        counts["ambiguousIdentityGroups"] += 1
        counts["ambiguousIdentityRecords"] += group["records"]
        counts["ambiguousEligibleRecords"] += eligible
        key = "ambiguousEligibleMovieRecords" if group["mediaType"] == "film" else "ambiguousEligibleTvRecords"
        counts[key] += eligible


def request_attempt_pre_ambiguity_eligible(record: dict[str, Any], canonical_tmdb_id: str | None) -> bool:
    return bool(record.get("description") and record.get("genreLabels") and canonical_tmdb_id)


def canonical_type_matched_tmdb_id(record: dict[str, Any]) -> str | None:
    value = record.get("tmdbMovieId") if record.get("mediaType") == "film" else record.get("tmdbTvId")
    cleaned = str(value).strip() if value is not None else ""
    if not re.fullmatch(r"[0-9]+", cleaned):
        return None
    parsed = int(cleaned)
    return str(parsed) if 0 < parsed <= MAX_SAFE_INTEGER else None


def strong_identity_keys(record: dict[str, Any], canonical_tmdb_id: str | None) -> list[str]:
    media_type = str(record["mediaType"])
    values = (
        ("wikidata", record.get("id")),
        ("imdb", record.get("imdbId")),
        ("tmdb", canonical_tmdb_id),
        ("tvdb", record.get("tvdbId")),
    )
    return [f"{media_type}:{source}:{value}" for source, value in values if isinstance(value, str) and value]


@contextlib.contextmanager
def open_normalized_text_output(path: Path) -> Iterator[Any]:
    if path.suffix != ".gz":
        with open(path, "wt", encoding="utf-8", newline="\n") as output:
            yield output
        return
    with open(path, "wb") as raw:
        with gzip.GzipFile(filename="", mode="wb", fileobj=raw, mtime=0) as compressed:
            with io.TextIOWrapper(compressed, encoding="utf-8", newline="\n") as output:
                yield output


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


def file_integrity(path: Path) -> dict[str, Any]:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"bytes": path.stat().st_size, "sha256": digest.hexdigest()}


def public_identifier(value: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,127}", value):
        raise argparse.ArgumentTypeError("must be a public-safe identifier using only letters, digits, dot, underscore, or hyphen")
    return value


def progress_due(count: int, interval: int) -> bool:
    return interval > 0 and count > 0 and count % interval == 0


def log(message: str) -> None:
    print(f"[wikidata-normalizer] {message}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
