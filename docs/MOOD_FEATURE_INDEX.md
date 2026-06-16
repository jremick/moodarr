# Mood Feature Index

Status: implemented local SQLite index with deterministic source rows and external seed import support.

## Purpose

The mood feature index makes mood retrieval an indexed SQL lookup instead of a full feature-row scan. It is the local foundation for importing external sources such as MovieLens Tag Genome or later TMDB-derived keyword/tag signals.

## Schema

`media_mood_feature_scores` stores normalized feature scores:

- `media_item_id`
- `source`, for example `deterministic`, `movielens-tag-genome`, or `ai-enrichment`
- `source_version`
- `feature`, for example `mood:feel good`, `tone:whimsical`, `watch:group friendly`
- `score` from `0` to `100`
- `confidence` from `0` to `1`
- `updated_at`

The table is indexed by `feature`, `media_item_id`, and `source/source_version`.

## Search Path

Recommendation retrieval converts the structured brief into normalized mood feature keys, then uses `searchMoodFeatureScores()` to retrieve top mood matches. If the index is empty, the engine falls back to the feature-map scan.

This keeps the current deterministic behavior while giving larger catalogs a faster mood lookup path.

## Import Format

Use JSON or JSONL records:

```json
{
  "title": "Hunt for the Wilderpeople",
  "year": 2016,
  "mediaType": "movie",
  "externalIds": { "tmdb": 371645, "imdb": "tt4698684" },
  "features": {
    "mood:feel-good": 0.98,
    "tone:offbeat": 0.92
  },
  "confidence": 0.85
}
```

Scores can be `0-1` or `0-100`. The importer normalizes them to `0-100`.

Run:

```bash
npm run import:mood-seeds -- --file seeds.jsonl --source movielens-tag-genome --version 2021
```

For MovieLens Tag Genome datasets, point the importer at the extracted dataset directory containing `movies.csv`, `genome-tags.csv`, and `genome-scores.csv`:

```bash
npm run import:movielens-tag-genome -- --dir /path/to/ml-25m --version ml-25m --threshold 0.7
```

The MovieLens importer matches local movies by `movielens` external ID when present, then by normalized title/year. It streams `genome-scores.csv` and imports only mapped mood/tone/watchability tags above the relevance threshold.

## Source Strategy

Recommended order:

1. Deterministic labels from local metadata.
2. MovieLens Tag Genome where local movies can be matched.
3. TMDB keyword/genre-derived seed scores.
4. Optional AI enrichment for titles with weak or conflicting mood coverage.

Search should never depend on external API calls. External sources are imported offline into the local feature index.
