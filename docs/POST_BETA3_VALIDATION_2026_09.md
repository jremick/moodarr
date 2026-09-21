# Post-beta.3 validation

Recorded 21 September 2026. **The scoped rendered catalog check, final data readback, and owned runtime cleanup passed.** This record tracks the exact-image browser check and the prerequisites for remaining validation before feature work. The [beta.3 release](https://github.com/jremick/moodarr/releases/tag/v0.1.0-beta.3) is published; this supplemental evidence does not complete the remaining manual checks.

## Exact-image catalog browser check

- Official version: `0.1.0-beta.3`.
- Source revision: `85170c8b6359c006754516de347777ea44932c64`.
- OCI index: `sha256:515a08bd074ba54eaca53c0a70d8bf23af051fa600d32fee6ddec2aacc6e7e38`.
- Linux amd64 manifest: `sha256:fc2a9b67f4c2b4eea64e13da92105b5be7cd172a683329f2054ff661ffac1137`.
- Public catalog: `moodarr-wikidata-20260622-min5-v1.jsonl.gz`, 90,397 source records, SHA-256 `dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a`.

The run uses fresh disposable data, fixture mode disabled, and the official `none`/`none` AI/TMDB policies. It contains only the public catalog and no live integration credentials. The scope is rendered request-attempt disclosure for a controlled movie and a TV series with season 1 selected, followed by preview and cancellation. No confirm/create control was activated.

| Observation | Status |
| --- | --- |
| Exact running identity, policies, non-fixture mode, and imported catalog | Passed: native Linux amd64 import, integrity, readiness, and API checks; all 90,397 public source records imported under the recorded official identity and policies. |
| Movie request-attempt disclosure and preview/cancel | Passed at 1280 × 720. The selected catalog result showed the Seerr request-attempt action and unchecked availability. Preview required separate confirmation and stated that the resulting title must be confirmed in Seerr. Cancel removed the preview and restored focus to the same Try Request control. |
| TV season 1 request-attempt disclosure and preview/cancel | Passed at 390 × 844. The action was disabled without a season and enabled for season 1. Preview named season 1 and retained unchecked-availability disclosure and separate confirmation. Cancel removed the preview and restored focus. |
| No created request or external write; disposable cleanup | Passed: exactly two allowed preview audits, zero requests/creation operations, and no external request IDs. All three owned containers, the volume, internal network, and generated secret were removed. The shared public image and private evidence staging were retained. |

Codex In-app Browser on macOS was used; its actual engine version was unavailable through the tool. Both viewports had no horizontal overflow, and captured browser console output contained zero warnings or errors. Each preview received keyboard focus. No external links, feedback, sync, or settings controls were used.

Final SQL integrity and foreign-key checks passed. All 90,397 source records were active and current. Media items, features, feature FTS, catalog index, and catalog-index FTS each contained 90,361 rows. The two audits were one movie preview and one TV preview with seasons `[1]`; both were allowed and had no external request ID or Plex user. No blocked TV preview reached the server. Requests, creation operations, Plex items, Seerr items, application users, user sessions, poster cache, and embeddings each remained zero.

The local automatic Admin session provided access for this isolated check. It does not establish explicit sign-in or Plex-user authentication, and this observation does not fill the four supported-browser rows. This browser run makes no native responsiveness or ranking-quality claim.

## Cosmetic follow-up

Normal catalog fallback posters were incorrectly labelled as test data while fixture mode was disabled. The current source omits that subtitle from [the poster helper](../src/server/fixtures/media.ts), preserving the no-TMDB-fetch policy. The published beta.3 image still contains the earlier wording; a later release is required to distribute the fix.

## Remaining validation

| Remaining check | Required input or access |
| --- | --- |
| Native Plex desktop/mobile launch, approval/return, missing-client and fallback behavior | Actual desktop/mobile clients and a signed-in test account. |
| Real Plex watchlist and Seerr preview, confirmed write, uncertain outcome, and cleanup | A dedicated Plex validation user, controlled media, and a test-safe Seerr target with an agreed cleanup path. Household queues are outside this validation setup. |
| Supported browser matrix | Current stable Chrome, Edge, Firefox, and macOS Safari in clean sessions, with actual observed versions. Embedded-browser evidence does not fill these four rows. |
| Exact-image Unraid template and update checks | An authenticated Unraid Docker Manager session and fresh dedicated test storage. |
| Native responsiveness | The exact official image on native Linux amd64 under the documented resource envelope, with Plex and Seerr state quiescent across baseline and measured runs. |
| Independent ranking evaluation | At least 100 frozen, independently human-judged cases and the matching offline catalog, versions, and thresholds. Existing evidence contains 12 prompts; the count of 109 refers to graded candidate items, not independent cases, and does not establish human independence. |

Use the [comprehensive manual runbook](BETA_CANDIDATE_MANUAL_VALIDATION.md) and [independent evaluation protocol](MOODRANK_EVALUATION_PROTOCOL.md) for acceptance. Keep raw judgments and private integration evidence outside public documentation. Complete each prerequisite and its cleanup before claiming that row passed; the [roadmap](ROADMAP.md) remains the source of delivery order.
