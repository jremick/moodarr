# Wikidata Mood Enrichment Pass Design

Status: deterministic alpha slice implemented; selective LLM/TMDb enrichment remains future work.
Last updated: 2026-07-01.

## Purpose

The full Wikidata catalog pass gives Moodarr a broad mainstream candidate universe, but Wikidata does not provide curated mood or vibe tags. The next enrichment pass should make imported catalog rows mood-addressable for search tests while preserving the existing trust boundary:

- Wikidata is catalog provenance and structured metadata.
- Moodarr-derived mood labels are local derived ranking signals.
- Plex remains local availability truth.
- Seerr remains requestability truth.

The alpha goal is not to make catalog-only records directly recommendable. The goal is to improve which catalog-only records enter the bounded Seerr verification queue for prompts like `warm fantasy adventure I can request`, `dark but not scary`, `weird but group-friendly`, and `low-commitment comfort watch`.

## Implemented Alpha Result

The first deterministic slice was implemented as:

- `src/server/recommendation/catalogMoodEnrichment.ts`
- `npm run enrich:catalog-mood`
- `npm run eval:catalog-mood`

Run against the isolated full-catalog DB on 2026-07-01:

- Catalog source version: `wikidata-dump-2026-06-30-fast-lbzip2-min5`.
- Distinct catalog-linked media items: `86,040`.
- Enriched items: `76,216`.
- Derived feature rows: `301,216`.
- Coverage: `0.8858`.
- Text/compound evidence coverage: `0.1184`.
- Post-enrichment ranked-search-ready catalog items: `76,950`.

The deterministic pass clears the alpha coverage goal and makes the catalog ranked-ready for search tests. It does not clear the stronger 60% non-genre/specificity target; that remains the justification for the later selective LLM or opt-in keyword enrichment pass.

## Recommendation

Use a hybrid strategy, sequenced narrowly:

1. Run a deterministic Moodarr-owned enrichment pass across the full imported catalog.
2. Add a readiness eval and spot-check suite for mood coverage and search behavior.
3. Use selective LLM classification only for high-mainstream rows that remain ambiguous, low-confidence, or fail eval spot checks.
4. Treat TMDb keywords as a later opt-in enrichment source, not the alpha-critical mood source.
5. Keep MovieLens Tag Genome as local research/eval/reference only.

This keeps the first enrichment pass reproducible, cheap, license-safe, and easy to rerun. A full-catalog LLM pass is deferred because it introduces cost, model drift, and validation burden before the deterministic taxonomy has proven where it is weak.

## Controlled Feature Space

Start with a small owned taxonomy that matches current MoodRank language:

- `mood:*`: `warm`, `cozy`, `funny`, `weird`, `romantic`, `intense`, `emotional`, `magical`, `adventurous`, `feel-good`.
- `tone:*`: `light`, `offbeat`, `clever`, `grounded`, `suspenseful`, `whimsical`, `bleak`, `sincere`, `dry`.
- `watch:*`: `group-friendly`, `shared-screen`, `low-commitment`, `background-friendly`, `late-night`, `high-friction`, `attention-heavy`.
- `microgenre:*`: only a few controlled compounds when they materially help search, such as `dark comedy`, `gentle sci-fi`, and `cozy mystery`.

Avoid open-ended free-text tags in the alpha pass. They make evaluation and reruns harder, and they invite duplicates such as `feel good`, `feel-good`, and `uplifting comfort` competing as separate features.

## Data Model

The first slice can write into the existing `media_mood_feature_scores` table:

- `source`: `moodarr-wikidata-rules`
- `source_version`: `wikidata-dump-2026-06-30-fast-lbzip2-min5+moodrules-v2`
- `feature`: controlled key such as `mood:cozy`
- `score`: intensity from `0` to `100`
- `confidence`: evidence confidence from `0` to `1`

For a durable enrichment workflow, add an enrichment ledger in a later slice:

- `mood_enrichment_runs`: run id, input source version, taxonomy version, ruleset or model version, prompt version when applicable, started/finished timestamps, status, and counts.
- `mood_enrichment_items`: run id, media item id, input payload hash, input hash, status, feature count, and error.

Do not write derived mood labels into `catalog_source_records.metadata_json` as if Wikidata asserted them. Do not mutate `plex_items` or `seerr_items` during enrichment.

## Scoring Rules

Treat `score` as feature intensity and `confidence` as provenance/evidence reliability.

Recommended ranges:

- Direct title or description cue: score `70-95`, confidence `0.60-0.80`.
- Genre-only inference: score `55-80`, confidence `0.40-0.60`.
- Multiple independent cues agreeing: score `75-95`, confidence `0.70-0.85`.
- Controlled LLM classifier output later: score `60-95`, confidence `0.65-0.88`.
- Ambiguous or conflicting cues: cap confidence at `0.55`.

Safety and friction features should be conservative but high impact when present. For example, `watch:high-friction` should require stronger evidence than a broad drama genre, but it should matter when a user asks for something light, group-friendly, or emotionally easy.

Before relying on hybrid deterministic plus LLM sources, update mood aggregation to avoid unbounded double-counting of the same feature from multiple sources. Use max-per-feature or a capped weighted merge for each `media_item_id + feature`.

## Enrichment Inputs

Use fields already present in the normalized Wikidata catalog:

- title and aliases;
- description;
- media type;
- year;
- genre labels;
- cast and director labels as weak signals only;
- country, language, and franchise labels as optional weak context;
- runtime/content rating only when later verified from Plex or Seerr/TMDb, not from Wikidata unless a trusted mapped field exists.

The deterministic pass should prioritize description phrases and genre labels. Cast/director/franchise should not create strong mood labels by themselves because they are noisy proxies and can overfit major franchises.

Current implementation note: safe Wikidata aliases, countries, languages, franchises, award counts, sitelink counts, mainstream score, and metadata confidence are now inflated into item metadata and used as low-confidence fingerprint/catalog-search context. They are not treated as availability truth, and they do not replace stronger summary or genre evidence.

## Batch And Rerun Design

Run enrichment offline after catalog import.

- Deterministic pass: batch `1,000-5,000` items per transaction.
- LLM pass later: batch `25-100` items, strict JSON schema, retry transient failures, quarantine invalid outputs.
- Cache key: `media_item_id + source_payload_hash + taxonomy_version + classifier_or_rules_version`.
- Skip unchanged hashes on rerun.
- Record per-row failures; a few failures should not block the whole catalog.
- Search should never call TMDb or an LLM at request time.

Rollback should be simple: delete rows for the enrichment `source` or rerun the prior `source_version`.

## Search Interaction

Mood enrichment should improve retrieval and catalog verification ordering:

```text
catalog_source_records + media_items
  -> offline mood enrichment
  -> media_mood_feature_scores(source='moodarr-wikidata-rules')
  -> retrieval mood hits + semantic/FTS/catalog rank
  -> MoodRank v0.4 rank index
  -> catalog-only eligibility gate
  -> bounded exact-match Seerr verification
  -> requestable result only after Seerr truth exists
```

It must not:

- bypass hard filters;
- make catalog-only rows recommendation-eligible;
- create or imply Plex availability;
- create or imply Seerr requestability;
- perform live API enrichment during search.

## Alpha Acceptance Gates

Add a separate catalog mood readiness eval before making this a merge-ready alpha slice.

Deterministic alpha gates:

- At least `85%` of full-catalog records get two or more controlled mood/tone/watch features.
- At least `10%` of records get one text/compound-evidence feature from Wikidata descriptions or controlled compounds.
- Existing catalog readiness still passes for the full imported catalog.
- Catalog-only records do not leak into normal recommendation results.
- Exact Seerr title/media-type/year match remains the only requestability promotion path.
- Re-running the deterministic pass with the same input and versions produces the same row counts and feature hashes.
- Retrieval/scoring uses no external enrichment calls during search.

The later hybrid enrichment gate should raise text/compound or non-genre specificity toward `60%` once selective LLM classification or opt-in keyword sources exist.

Search smoke prompts:

- `warm fantasy adventure I can request`
- `funny animated shows for a group`
- `cozy group movie, not horror`
- `dark but not scary`
- `gentle quiet sci-fi that is emotionally easy`
- `weird but group-friendly conversation starter`
- `low-commitment comfort watch`
- `grounded mystery less bleak`
- `witty fantasy romance under 100 minutes`
- `requestable popular shows not in Plex`

Spot-check title sets:

- Warm/group: `Paddington 2`, `The Princess Bride`, `My Neighbor Totoro`, `Hunt for the Wilderpeople`.
- Weird/offbeat: `Everything Everywhere All at Once`, `Twin Peaks`, `The Lobster`, `Being John Malkovich`.
- Dark-not-horror: `Knives Out`, `Zodiac`, `The Prestige`, `Severance`.
- Low-commitment/comfort: `The Good Place`, `Detectorists`, `Fawlty Towers`, `Brooklyn Nine-Nine`.
- High-friction/intense: `Hereditary`, `Se7en`, `Chernobyl`, `The Exorcist`.

## Risks

- Wikidata descriptions are sparse, so broad genre rules can over-tag records.
- Duplicate feature sources can inflate mood retrieval unless aggregation is capped.
- LLM outputs can drift across reruns unless prompt/model/taxonomy versions and input hashes are stored.
- TMDb keyword enrichment may be useful but adds API terms, attribution, cache, and opt-in constraints.
- Better catalog retrieval can increase Seerr lookup pressure; verification must stay bounded and exact-match.
- Derived mood labels can be mistaken for source truth unless source naming and diagnostics are explicit.

## Lean MVP Build Sequence

1. Freeze the controlled taxonomy in code.
2. Add an offline deterministic enrichment script that reads imported catalog rows and writes `media_mood_feature_scores` under `moodarr-wikidata-rules`.
3. Add a catalog mood readiness eval with coverage, specificity, determinism, and leak checks.
4. Run the eval against the full imported catalog isolated DB.
5. Add capped feature aggregation before mixing deterministic and LLM rows.
6. Add selective LLM enrichment only for high-mainstream weak/ambiguous records and failed spot-check cases.
7. Revisit TMDb keyword enrichment after the deterministic taxonomy proves useful in search tests.
