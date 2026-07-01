# External Mood Seed Assessment

Status: V2 research record.
Last updated: 2026-06-17.

## Summary

External mood/tag datasets are useful for local stress testing and reference design, but most direct sources are non-commercial, no-redistribution, or insufficiently provenanced. Moodarr should own its production Mood/Feel taxonomy and use external corpora only where the license and provenance match the use case.

## Recommended Policy

1. Build and maintain an owned Mood/Feel feature taxonomy in the repo.
2. Use MovieLens Tag Genome as an ignored local eval oracle, not bundled data.
3. Use NRC VAD as dimensional inspiration and local research only, not bundled word-score data.
4. Prefer Wikidata for production-safe structured enrichment when needed.
5. Use TMDb only as opt-in API enrichment with attribution and commercial-license review if Moodarr becomes revenue-bearing.
6. Avoid IMDb, Watchmode/JustWatch-style availability APIs, and unverified Kaggle-style mood datasets for bundled production mood semantics.

## Source Assessment

| Source | Fit | License/provenance assessment | Decision |
|---|---:|---|---|
| MovieLens 25M Tag Genome | High for eval | Includes `genome-scores.csv` and `genome-tags.csv`; user/tag data is anonymized, but license is research-only, no redistribution, and no commercial/revenue use without GroupLens permission. | Use local-only ignored eval/reference files. Do not commit derived tables. |
| MovieLens Tag Genome 2021 | High for research, higher risk | CC BY-NC 3.0. Includes raw IMDb reviews, MovieLens data, survey answers, and generated scores. Raw reviews create extra copyright/provenance risk. | If used, use final score files only for offline validation. Avoid raw text. |
| NRC VAD Lexicon | Medium for model shape | VAD dimensions are useful, but terms are non-commercial research/education, no redistribution, commercial license required. | Use dimensions as conceptual guidance; do not bundle scores. |
| Wikidata | Medium for metadata | Structured data in main/property/lexeme namespaces is CC0. Quality varies and it is not a mood taxonomy. | Best production candidate for structured facts and IDs. |
| TMDb | Medium for metadata | Free API for non-commercial purposes with attribution; commercial use requires licensing. | Opt-in metadata enrichment only; not mood truth. |
| IMDb non-commercial datasets | Low for Mood/Feel | Personal/non-commercial use only, local copies allowed under terms. | Avoid production enrichment. Private ID/title validation only if needed. |
| Watchmode / JustWatch-style APIs | Low for mood | Availability products, not mood datasets; cache/resale/license restrictions. | Ignore for Mood/Feel semantics. |
| Unverified movie-feelings/Kaggle-style datasets | Unknown | Provenance, annotation method, and license are not clear enough. | Blocked until verified. |

## Implementation Impact

- Keep `scripts/import-movielens-tag-genome.ts` as a local operator tool, not a production dependency.
- Keep downloaded MovieLens/NRC/IMDb data under ignored local paths.
- Add evals that assert hand-authored fixture behavior, not copied external scores.
- If adding Wikidata enrichment, keep it separate from Mood/Feel learning and record provenance/confidence per imported feature.
- Use deterministic `useAi:false` evals as the first validation pass so LLM reranking cannot mask weak semantic ranking.

## Sources

- [MovieLens 25M README](https://files.grouplens.org/datasets/movielens/ml-25m-README.html)
- [MovieLens Tag Genome 2021 README](https://files.grouplens.org/datasets/tag-genome-2021/genome_2021_readme.txt)
- [NRC Valence, Arousal, and Dominance Lexicon](https://saifmohammad.com/WebPages/nrc-vad.html)
- [Wikidata Licensing](https://www.wikidata.org/wiki/Wikidata:Licensing)
- [TMDb API FAQ](https://developer.themoviedb.org/docs/faq)
- [IMDb Non-Commercial Datasets](https://developer.imdb.com/non-commercial-datasets/)

## Rationale For Not Bundling External Scores

The product value is not access to a copied mood table. The product value is the local profile that learns a user's private meaning of English mood/feel language. External sources can help us stress-test and design the baseline taxonomy, but production learning should remain local, inspectable, resettable, and based on data we can legally use.
