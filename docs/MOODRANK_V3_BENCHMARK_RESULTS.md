# MoodRank V3 Benchmark Results

Date: 2026-06-15
Engine: `moodrank-v3`
Command: `npm run eval:recommendations`

## Result

```json
{
  "cases": 8,
  "top3HitRate": 1,
  "top10Recall": 1,
  "preRerankRecall": 1,
  "meanReciprocalRank": 0.9375,
  "ndcgAt3": 0.7600661914223799,
  "top3AnyHitRate": 1,
  "constraintAccuracy": 1,
  "availabilityAccuracy": 1,
  "failureBreakdown": {
    "brief_parse": 0,
    "feature_gap": 0,
    "retrieval_miss": 0,
    "score_miss": 0,
    "diversity_miss": 0,
    "personalization_miss": 0,
    "availability_miss": 0,
    "constraint_miss": 0,
    "explanation_miss": 0
  },
  "failures": []
}
```

## What This Proves

- The deterministic engine retrieves every expected golden candidate before reranking.
- Hard filters and availability constraints are enforced across the current fixture suite.
- Top-3 ranking now clears the `NDCG@3 >= 0.75` acceptance target.
- The current golden suite has no tagged failures after the MoodRank V3 implementation.

## Known Limits

- The fixture suite has only 8 cases, so it is a regression gate, not a full taste-quality proof.
- The benchmark currently runs with AI disabled; it validates deterministic parsing, retrieval, scoring, diversity, and fallback behavior.
- The next meaningful evidence step is 75-150 real prompts with pairwise comparisons against the previous engine behavior.
