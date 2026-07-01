# MoodRank v0.4 Benchmark Results

Generated: 2026-06-29.
Engine: `moodrank-v0.4`.
Command: `npm run eval:recommendations`.

## Summary

MoodRank v0.4 keeps the staged v0.3 architecture but changes the ranking boundary: retrieval still builds source signals, then v0.4 creates a full-library rank index and deterministically scores every eligible item. The AI reranker remains bounded and catalog-safe.

## v0.3 Comparison

| Metric | v0.3 | v0.4 | Delta |
| --- | ---: | ---: | ---: |
| Golden cases | 16 | 16 | 0 |
| Pre-rerank recall | 1.0000 | 1.0000 | 0.0000 |
| Top-3 hit rate | 1.0000 | 1.0000 | 0.0000 |
| Top-10 recall | 1.0000 | 1.0000 | 0.0000 |
| MRR | 0.9375 | 0.9688 | +0.0313 |
| NDCG@3 | 0.8327 | 0.8565 | +0.0238 |
| Constraint accuracy | 1.0000 | 1.0000 | 0.0000 |
| Availability accuracy | 1.0000 | 1.0000 | 0.0000 |

v0.4 reported no golden-suite failures. v0.3 reported one score miss on the expanded fixture suite: `warm-oddball-adventure-comedy` expected `Paddington 2` in the top 3.

## Profile And Adversarial Checks

- Profile eval: 15 cases, 12 wins, 0 losses, 3 ties, `PersonalizationLift@3 = 1.0000`.
- Profile NDCG@3: generic `0.5651`, personalized `0.9188`.
- Adversarial eval: 40/40 pass, P0 gate 7/7, no failure-class regressions.

## Added Regression Coverage

The v0.4 test suite now includes 4 large synthetic rank-index coverage cases. Each case has 541 library items, a 500-item v0.3 retrieval candidate cap, and a valid late-library target that v0.3 misses. v0.4 surfaces all 4 targets by scoring the full eligible library after building the rank index.

Covered v0.4-only cases:

- runtime cap: valid under-two-hour title behind overlong funny-fantasy decoys;
- animation negation: valid live-action title behind animated fantasy-comedy decoys;
- availability plus runtime: valid requestable under-two-hour title behind overlong requestable decoys;
- excluded genre: valid non-horror title behind high-signal cozy-horror decoys.
