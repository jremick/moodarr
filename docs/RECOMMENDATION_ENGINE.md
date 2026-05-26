# Feelerr Recommendation Engine

Status: initial production-oriented architecture, implemented as a measurable MVP foundation.

## Goal

Feelerr should recommend from the full synced Plex library first, then augment with Seerr/Jellyseerr catalog results when local matches are weak, unavailable, or the prompt asks about requestability. The model provider should improve ranking and explanations, not decide availability or create requests.

## Pipeline

1. Parse intent.
   The parser separates hard constraints from soft taste signals. Media type and runtime caps are hard. Genre, mood, reference titles, and "better than" language are ranking signals.

2. Retrieve broadly.
   The deterministic layer scores the full SQLite media cache instead of only a tiny prefiltered slice. Plex availability remains the local source of truth; Seerr contributes requestability and external catalog candidates.

3. Augment with Seerr when useful.
   Seerr search is called when local retrieval is sparse, all high candidates are already in Plex, or the prompt asks for unavailable/requestable options.

4. Score by feature buckets.
   Every candidate receives query, taste, availability, and quality scores. The UI can expose these without exposing implementation internals.

5. Apply watch context.
   `solo` and `group` use separate static profiles now. `group` prefers lower-friction, broadly watchable options; `solo` can weight specificity higher. Future feedback should be stored separately by context.

6. Rerank with the provider when configured.
   The model receives a balanced candidate set, not only the deterministic top few. Payloads include candidate metadata and deterministic score buckets only. Tokens, URLs, local paths, and request actions are excluded.

7. Enforce safety after reranking.
   The backend maps model output back to known candidate IDs, ignores unknown IDs, clamps scores, preserves deterministic availability, and keeps request creation behind preview plus explicit confirmation.

## Current Limits

- Preference learning is not implemented yet; `solo` and `group` are separate profile weights, not learned taste models.
- Retrieval is still metadata and lexical-signal based. Embeddings should come later, after golden-prompt evals prove recall misses.
- Live quality telemetry is still minimal. Search events are privacy-preserving, but they do not yet store ranking impressions or feedback outcomes.
- Provider reranking has latency and cost. It is default when configured, with deterministic fallback on failure.

## Measurement Plan

Offline fixture evaluation:
- Golden prompts cover funny fantasy, Stardust-like, feel-good comedy, short TV, and "The Do-Over but better".
- Metrics: top-3 hit rate, top-10 recall, hard-filter correctness, availability correctness, requestability correctness, and candidate coverage before reranking.
- Command: `npm run eval:recommendations`.

Live local telemetry to add next:
- `recommendation_sessions`: query hash, intent, watch context, filters, pipeline version, model, candidate count, latency, Seerr augmentation status.
- `recommendation_results`: session ID, media item ID, rank, score buckets, availability at ranking time.
- `recommendation_feedback`: selected, opened Plex, opened Seerr, request preview, request created, thumbs up/down, dismissed, not-this-vibe.
- `preference_profiles`: separate profile state for `solo`, `group`, and later named partner/group profiles.

Quality gates:
- Expected titles must enter the candidate set before provider reranking.
- Hard filters must be enforced before and after provider reranking.
- Explanations must only cite metadata present on the selected candidate.
- Availability shown in the UI must come from Plex/Seerr records, never provider text.
- Request creation must never be triggered from ranking output.
