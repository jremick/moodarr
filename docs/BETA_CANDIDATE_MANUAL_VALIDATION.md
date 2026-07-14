# Beta Candidate Manual Validation

This runbook defines the fail-closed manual evidence required for a Moodarr web/server beta candidate. It covers the release gates that cannot be established by fixture mode or a source build alone: an exact-digest Unraid installation, the exact beta catalog and its stopped networkless import and request-attempt boundary, real Plex and Seerr/Jellyseerr behavior, native Linux responsiveness, and the supported desktop browser and accessibility matrix.

The machine-readable contract in [`scripts/validate-beta-manual-evidence.ts`](../scripts/validate-beta-manual-evidence.ts) is authoritative for evidence shape and acceptance. Start from the structurally valid [`beta-manual-evidence-all-false.example.json`](beta-manual-evidence-all-false.example.json). The example is intentionally failing evidence, not a completed release artifact. Never change a `false` value to `true` until the exact candidate has passed that check and any required cleanup.

This evidence supplements the automated candidate workflow and the procedures in [Release](RELEASE.md). It does not replace clean-install, upgrade/rollback, supply-chain, vulnerability, or attestation evidence. Fixture, local-image, emulated-architecture, source, and EXP runs cannot close this manual gate.

The completed matrix and validator summary are a structured operator attestation that still requires maintainer review. The validator checks the closed schema, candidate bindings, report bytes, and canonical responsiveness-harness blob; it does not independently observe the manual actions, authenticate who performed them, or turn self-reported browser, Unraid, and integration checks into automated proof.

## Operating Rules

- Use one evidence file for one candidate version, full 40-character revision, and immutable OCI index digest.
- Run from a clean checkout of that exact revision. Pull and launch only `ghcr.io/jremick/moodarr@sha256:...`; a mutable tag or local image is not eligible.
- Verify the candidate revision is reachable from `origin/main` and verify the digest attestation using the policy in [Release](RELEASE.md) before beginning manual checks. OCI labels are supporting evidence, not the source binding by themselves.
- Use dedicated validation accounts, controlled media, disposable Moodarr data, and a test-safe Seerr request target. Do not run write tests against an uncontrolled household or production queue.
- Keep Plex library content and Seerr request state quiescent while collecting integration and responsiveness evidence. If upstream state changes unexpectedly, discard the affected observation and repeat it from a fresh baseline.
- Record exact versions observed from the running products and browsers, not versions copied from documentation or download pages.
- Use only catalog version `wikidata-20260622-min5-v1` at compressed SHA-256 `dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a`; a regenerated, renamed-with-different-bytes, or newer asset is another candidate input.
- Record only direct observations. If a check is skipped, ambiguous, inherited from another candidate, or performed against a different digest, leave it `false`.
- Finish upstream and Unraid cleanup before setting either cleanup field to `true`. Cleanup is part of acceptance, not post-release housekeeping.

## Prepare The Evidence File

Keep the working copy outside the checkout and readable only by the operator:

```bash
set -euo pipefail
umask 077
evidence_file="$(mktemp "${TMPDIR:-/tmp}/moodarr-beta-manual-evidence.XXXXXX")"
summary_file="$(mktemp "${TMPDIR:-/tmp}/moodarr-beta-manual-summary.XXXXXX")"
expected_revision="<verified-full-lowercase-40-hex-revision>"
expected_digest="sha256:<verified-lowercase-64-hex-index-digest>"
responsiveness_report="/absolute/private/path/moodarr-beta-responsiveness.json"
cp docs/beta-manual-evidence-all-false.example.json "$evidence_file"
chmod 600 "$evidence_file"
```

Resolve `expected_revision` and `expected_digest` independently from the approved candidate and attestation; never copy them out of the evidence JSON being tested. The exact revision and its `scripts/benchmark-beta-responsiveness.ts` blob must be available in the local Git object database. The CLI reads that blob with a bounded `git show <revision>:scripts/benchmark-beta-responsiveness.ts`, hashes the exact bytes, and fails closed if Git cannot provide it. Replace every placeholder identity and version. Use a UTC `recordedAt` timestamp only after all checks and cleanup are complete. `operatorRole` must be either `maintainer` or `release-delegate`.

The validator accepts only a regular, non-symlink JSON file no larger than 64 KiB. It also requires the exact responsiveness report as a regular, non-symlink file between 1 byte and 8 MiB. Both files are opened without following a final-path symlink and rejected if their size or timestamps change while read. It emits a compact allowlisted summary and uses these exit codes:

| Exit | Meaning | Release action |
| --- | --- | --- |
| `0` | Schema valid and every acceptance check passed | Eligible to link from the release ledger after privacy review |
| `1` | Schema valid but one or more checks failed | Stop; do not approve or promote the candidate |
| `2` | An argument or input is missing, unsafe, malformed, oversized, or schema-invalid | Stop; repair the evidence process before retesting |

After producing a qualifying v4 responsiveness report for the expected candidate, validate the tracked all-false example once to prove that placeholders cannot pass even when a real report is supplied. Exit `1` is expected:

```bash
example_summary="$(mktemp "${TMPDIR:-/tmp}/moodarr-beta-manual-example.XXXXXX")"
set +e
npm run --silent validate:beta-manual-evidence -- \
  --input docs/beta-manual-evidence-all-false.example.json \
  --expected-revision "$expected_revision" \
  --expected-digest "$expected_digest" \
  --responsiveness-report "$responsiveness_report" \
  > "$example_summary"
example_status=$?
set -e
test "$example_status" -eq 1
rm -f "$example_summary"
```

Validate the completed working copy and retain the exact raw file plus its summary without reformatting either afterward:

```bash
npm run --silent validate:beta-manual-evidence -- \
  --input "$evidence_file" \
  --expected-revision "$expected_revision" \
  --expected-digest "$expected_digest" \
  --responsiveness-report "$responsiveness_report" \
  > "$summary_file"
```

All four options are mandatory, may appear in any order, and may appear only once. Revisions must be full lowercase 40-hex values and digests must use `sha256:` plus 64 lowercase hex characters; all-zero values are rejected. Any edit to the evidence changes the summary's `evidenceSha256`, and any byte change to the responsiveness report breaks `responsiveness.reportSha256`. Re-run validation after every edit and freeze the accepted files and summary together.

## Bind The Candidate Identity

Populate `candidate.version`, `candidate.revision`, and `candidate.digest` from the verified candidate. The Unraid runtime must repeat the same identity in `unraid.imageVersion`, `unraid.imageRevision`, and `unraid.imageDigest`.

Before any behavioral check:

1. Resolve the candidate by immutable digest and confirm it is a single supported `linux/amd64` image.
2. Confirm its version and revision labels match the expected beta version and full revision.
3. Confirm the running Unraid container uses that digest, not merely an image with matching labels.
4. Copy the exact identity into both JSON locations and compare them byte for byte.
5. Pass the independently resolved values through `--expected-revision` and `--expected-digest`; the validator compares both the evidence and responsiveness report to those external values.

Stop and discard all evidence if the candidate is rebuilt, the digest changes, the expected revision changes, a platform manifest differs, or any Unraid identity value differs. Evidence never transfers between candidate digests.

`recordedAt` is an expiring completion assertion, not a historical note. At validation time it must not be in the future and must be no more than 14 complete days (336 hours) old. Exactly 14 days is accepted; any greater age is rejected. It must also be at or after the responsiveness report's `finishedAt`. If the matrix expires before approval, repeat the affected current-state checks, record a new completion time, and validate again; do not merely advance the timestamp.

## Pinned Catalog Asset And Request-Attempt Validation

The beta.1 image and source tree do not contain the missing-title catalog. Use the separately staged release asset `moodarr-wikidata-20260622-min5-v1.jsonl.gz` with the tracked manifest in [`catalog/moodarr-wikidata-20260622-min5-v1.manifest.json`](../catalog/moodarr-wikidata-20260622-min5-v1.manifest.json). The contract is:

- catalog version `wikidata-20260622-min5-v1`;
- compressed SHA-256 `dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a`;
- 90,397 unique importable records;
- 82,865 ambiguity-safe request-attempt eligible records, consisting of 70,841 movies and 12,024 TV series;
- 36 groups sharing a strong importer identifier across 72 imported/indexed source records, including 59 otherwise eligible records—10 movies and 49 TV series—whose ambiguous catalog materializations cannot independently surface in Finder or authorize request actions; and
- normalized structured data from the [Wikidata 2026-06-22 entity dump](https://dumps.wikimedia.org/wikidatawiki/entities/20260622/wikidata-20260622-all.json.bz2), under [Wikidata's CC0 licensing policy](https://www.wikidata.org/wiki/Wikidata:Licensing).

Populate the four non-boolean catalog fields exactly:

| Evidence field | Required value |
| --- | --- |
| `catalog.version` | `wikidata-20260622-min5-v1` |
| `catalog.assetSha256` | `dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a` |
| `catalog.records` | `90397` |
| `catalog.requestAttemptEligibleRecords` | `82865` |

From the clean checkout of the candidate revision, run the whole-file validator before mounting the asset into any container:

```bash
catalog_asset="/absolute/private/path/moodarr-wikidata-20260622-min5-v1.jsonl.gz"
catalog_validation="$(mktemp "${TMPDIR:-/tmp}/moodarr-beta-catalog-validation.XXXXXX")"

npm run --silent validate:beta-catalog-asset -- \
  --file "$catalog_asset" \
  > "$catalog_validation"
```

The validator must exit `0`, report `status: "passed"`, and reproduce the exact version, hash, sizes, record schema, counts, source dump, CC0 policy, and normalizer identity in the tracked manifest. Set `exactAsset` to `true` only after reviewing that compact output. Keep the path and raw catalog private; the validation summary is safe to retain with the candidate ledger after a final review.

Use fresh disposable candidate data or the dedicated Unraid-test appdata. Take a cold backup, ensure the exact-digest Moodarr container is stopped, and confirm no other process has the SQLite database open. Substitute the actual private mount source and stopped container name; do not copy either value into the evidence JSON.

```bash
candidate="ghcr.io/jremick/moodarr@sha256:<validated-candidate-digest>"
catalog_data="<dedicated-test-/data-mount-source>"
catalog_container="<stopped-dedicated-moodarr-container>"

docker stop "$catalog_container"
docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,noexec,size=512m,mode=1777 \
  --user 999:999 --cap-drop=ALL --security-opt=no-new-privileges \
  --pids-limit=128 --memory=2g --memory-swap=2g --cpus=2 \
  -e NODE_ENV=production \
  -e MOODARR_REQUIRE_ADMIN_TOKEN=true \
  -e MOODARR_FIXTURE_MODE=false \
  -e MOODARR_DATA_DIR=/data \
  -e MOODARR_CONFIG_PATH=/data/config.json \
  -e MOODARR_DB_PATH=/data/moodarr.sqlite \
  -v "$catalog_data:/data" \
  -v "$catalog_asset:/catalog/moodarr-wikidata-20260622-min5-v1.jsonl.gz:ro" \
  "$candidate" \
  dist/server/importWikidataCatalog.js \
  --file /catalog/moodarr-wikidata-20260622-min5-v1.jsonl.gz \
  --version wikidata-20260622-min5-v1 \
  --source wikidata \
  --mode full-snapshot \
  --expected-source-records 90397 \
  --expected-file-sha256 dd25ba6602e1bdb8e6999b0442bc40165e6d4faadd02e91e74e1a24e2b55e85a \
  --batch-size 1000
docker start "$catalog_container"
```

Set the catalog checks only after these direct observations:

| Evidence field | Set `true` only after this observation |
| --- | --- |
| `exactAsset` | The whole-file validator exits `0` against the exact staged gzip and matches every tracked manifest identity and count, including 36 ambiguous identity groups, 72 ambiguous source records, and 59 otherwise eligible records split into 10 movies and 49 TV series. |
| `networklessFullSnapshotImport` | The packaged importer from `candidate.digest` exits `0` with Docker networking disabled, reports exactly 90,397 records, 90,397 imported records, zero skipped records, 90,397 unique importable source records, and matching `expectedFileSha256`/`fileSha256` values equal to the pinned asset hash; candidate health and catalog state survive restart without a refresh-required marker. |
| `genericSearchIsolation` | Against the imported catalog, a controlled ordinary generic query excludes request-attempt rows, and a verified-requestable-only query or explicit `not_in_plex_requestable` filter also excludes them. The same controlled unambiguous eligible row can be observed only through explicit request-attempt intent. Before attaching any Plex source, a controlled ambiguous catalog-only record is absent from ordinary, verified-only, and explicit request-intent Finder results. |
| `requestAttemptDisclosure` | An explicit request-intent query such as “I want to request a warm fantasy movie” can surface an unambiguous eligible catalog-only result after verified requestable results, but its availability remains `unavailable`; the card says **Seerr request attempt** and **Availability not checked**, its action says **Try Request**, and preview says **Confirm Request Attempt** without an upstream write. Direct preview and create attempts for the controlled ambiguous record are rejected without an upstream write. |

Use a privately recorded controlled title and identifier to distinguish the three searches, but do not add them to evidence. The `requestAttemptDisclosure` check does not require confirming a request. A separately controlled confirmation belongs to the real-integration checks below. For TV, verify that a season is required before preview becomes available.

Plex-only operation must still work when no catalog asset is imported. The 82,865 eligible-record count is not a Seerr availability count, and neither `exactAsset` nor successful import permits calling these rows requestable. Confirm that the whole-file validator reports all 72 source records in the 36 groups sharing a strong importer identifier as attempt-ineligible, including the 59 records—10 movies and 49 TV series—that otherwise meet attempt requirements. Before attaching any Plex source, use a controlled ambiguous catalog-only representative to verify that import retains provenance and diagnostic indexing while Finder omits it and both preview and create fail without an upstream write. If an independently identified available Plex item is deliberately linked for a separate check, it may remain visible as a Plex result, but both request endpoints must still reject it. Follow the broader operator procedure in [Catalog Bootstrap](CATALOG_BOOTSTRAP.md).

## Unraid Exact-Digest Validation

Use the checked-in `unraid/moodarr.xml` through Unraid Docker Manager on the exact recorded Unraid and Docker versions. Create a distinct test container, port, and fresh private appdata directory. Temporarily replace the template Repository value with the digest-qualified candidate. Do not point the test container at existing source, EXP, or household Moodarr data.

Record `unraid.version`, `unraid.dockerVersion`, and `unraid.architecture`. Beta evidence requires native `amd64`.

| Evidence field | Set `true` only after this observation |
| --- | --- |
| `cleanTemplateImport` | Docker Manager imports the checked-in template into a fresh container without undocumented repair, and the web app reaches its first-use state. |
| `exactDigest` | The pulled image and running container resolve to `candidate.digest`, with matching version/revision labels and native `linux/amd64`. |
| `nonRootUser` | The effective container process user is UID/GID `999:999`; no root fallback is present. |
| `readOnlyRoot` | The root filesystem is read-only while `/data` and the bounded `/tmp` tmpfs remain the only intended writable runtime locations. |
| `noNewPrivileges` | Effective runtime configuration has `no-new-privileges` enabled. |
| `capabilitiesDropped` | All Linux capabilities are dropped and none are added. |
| `resourceLimits` | Runtime limits are exactly 2 CPUs, 2 GiB memory with no extra swap, 128 PIDs, and a 512 MiB `/tmp` tmpfs using `rw,nosuid,nodev,noexec,mode=1777`. |
| `healthy` | Docker health and `GET /api/health` remain healthy through startup, configuration, sync, and restart, with no restart, OOM, or fatal marker. |
| `exactOriginSession` | `MOODARR_WEB_ORIGIN` exactly matches the browser-visible origin, Admin token exchange creates the expected session there, a cookie-authenticated write succeeds from that origin, and a mismatched-origin write is rejected. |
| `restartPersistence` | A stop/start and container recreation preserve the private `/data` configuration, synced state, and expected user-facing behavior without relaxing permissions. |
| `priorVersionUpdate` | The documented predecessor is installed on separate test data, backed up, and updated through Docker Manager to the exact candidate digest; expected state survives and the candidate is healthy. |
| `cleanupComplete` | The dedicated test container, template changes, port, appdata, temporary backup, and operator-only files are removed or returned to their documented retained location without touching shared resources. |

Use narrowly scoped inspection to decide each boolean. Do not publish raw `docker inspect`, container environment, appdata listings, logs, support bundles, or screenshots; those can expose credentials, private origins, and media-server details.

If import or update requires an undocumented permission relaxation, world-writable appdata, root execution, extra capability, disabled origin protection, or higher resource envelope, leave the relevant checks `false` and stop. A locally convenient workaround is not beta evidence.

## Real Plex And Seerr/Jellyseerr Validation

Use the exact-digest candidate with real, current release-test services. Record the version displayed by Plex Media Server in `integrations.plex.version`, and record both the actual product (`Seerr` or `Jellyseerr`) and its displayed version under `integrations.seerr`.

Prepare before testing:

- a dedicated Plex test user with only the controlled library access needed for the run;
- a small controlled title that is available in Plex for sync, poster, link, and Watchlist checks;
- one controlled, previously unrequested title that the test Seerr instance can request and later remove or cancel;
- an Admin session for configuration and a Plex-user session for user-scoped behavior;
- a unique idempotency key stored only in the private operator notes; and
- a cleanup plan confirmed before any Watchlist or Seerr write.

Do not include account names, server addresses, library names, titles, ratings keys, TMDB IDs, request IDs, or the idempotency key in the JSON evidence.

| Evidence field | Set `true` only after this observation |
| --- | --- |
| `plexLibrarySync` | A full sync against the recorded Plex version completes, expected controlled media appears once, catalog/source counts are credible, and the completed sync reports zero contained Plex identity conflicts. |
| `plexSignIn` | The dedicated user completes Plex sign-in, receives only user access, and sign-out/session invalidation behaves as documented. |
| `plexCapabilityDefaults` | The new Plex user begins with request and other elevated capabilities at their documented safe defaults; only the intended test capability is deliberately enabled by Admin. |
| `plexPosterAndLink` | A controlled result serves its poster through Moodarr without a token-bearing URL and opens the correct Plex item link. |
| `plexWatchlistAction` | The signed-in test user explicitly adds the controlled item to their Plex Watchlist, the upstream change appears once, and the item is removed again during cleanup. |
| `seerrStateSync` | Operational request state sync against the recorded Seerr/Jellyseerr version completes, represents the controlled existing state without importing descriptive catalog content, and reports zero contained Seerr identity conflicts. |
| `requestPreview` | Preview reports the exact controlled media type, local interoperability identifier, title, and seasons where applicable; no upstream request exists before confirmation. |
| `controlledRequestCreatedOnce` | One explicitly confirmed request creates exactly one upstream Seerr/Jellyseerr request for the controlled item. |
| `idempotentRetry` | Retrying the same confirmed payload, user scope, and idempotency key returns the existing outcome and does not produce a second upstream request. |
| `uncertainOutcomeReconciledWithoutResend` | In an isolated test path, a one-shot fault forwards the request upstream but withholds the response; Moodarr reconciles the resulting upstream state and retry does not send a second request. |
| `upstreamCleanupComplete` | The test Watchlist entry is removed, the controlled Seerr/Jellyseerr request is removed or cancelled through the supported upstream workflow, temporary capability changes are reverted, and no duplicate or pending test operation remains. |

The uncertain-outcome check is destructive fault injection. Use only a dedicated test target and a controlled one-shot proxy or equivalent mechanism whose forwarding behavior can be counted. Never simulate uncertainty by interrupting a shared Seerr server or household network. If the accepted-upstream/no-response condition cannot be created and observed safely, leave `uncertainOutcomeReconciledWithoutResend` false and stop the release gate.

Integration identity-conflict containment is exercised by the automated candidate suite with purpose-built synthetic records. Do not inject inconsistent identifiers into real Plex or Seerr data for the manual run. Any nonzero aggregate conflict count from the real integrations blocks the candidate until it is investigated; public evidence records only the count, never titles or upstream identifiers.

After cleanup, re-sync operational state and confirm Moodarr and the upstream services agree. Cleanup failure blocks the candidate even when request creation itself succeeded.

## Native Responsiveness Evidence

Run the candidate responsiveness procedure in [Release](RELEASE.md#candidate-responsiveness-evidence) against the same candidate digest and recorded real integrations. The qualifying report must be produced:

- on native Linux `amd64`, without architecture emulation or a remote Docker daemon;
- with exactly 2 CPUs and 2048 MiB memory under the documented hardening envelope;
- against a disposable production-sized data clone owned only by the benchmark container;
- with the official beta provider mode and no external AI processing; and
- while the Plex library and Seerr request state remain quiescent between the required baseline and measured run.

The harness must exit `0` and its final report must say it passed. Set `responsiveness.status` to `passed` and `responsiveness.native` to `true` only then. The fixed fields must remain `operatingSystem: "linux"`, `architecture: "amd64"`, `cpuLimit: 2`, and `memoryMiB: 2048`.

Hash the final byte-for-byte report on the native Linux host after the process exits:

```bash
responsiveness_report="/absolute/private/path/moodarr-beta-responsiveness.json"
test -s "$responsiveness_report"
report_sha256="$(sha256sum -- "$responsiveness_report" | awk '{print $1}')"
test "${#report_sha256}" -eq 64
```

Copy only the lowercase 64-character value into `responsiveness.reportSha256`. Retain the report in the approved restricted evidence location and verify the hash again before approval. Do not hash terminal output, a reformatted copy, an archive containing the report, or a report from another digest.

The manual validator hashes the exact supplied bytes again and parses the binding-critical subset of the actual `moodarr-beta-responsiveness-v4` contract. Acceptance requires all of the following from the report itself:

- top-level `status: "passed"`, an empty `failures` array, an empty `incompleteReasons` array, and every reported check marked `passed`;
- official beta provider policy (`aiMode`, `aiProviderPolicy`, and `tmdbContentPolicy` all `none`);
- native local Docker on Linux `amd64`, 2 CPUs, 2048 MiB, and `imageDigestMatched: true`;
- `candidate.digest` equal to `--expected-digest`;
- `candidate.expectedRevision`, `candidate.healthRevision`, and `candidate.harnessRevision` all equal to `--expected-revision`;
- `candidate.harnessSha256` equal to the SHA-256 of `scripts/benchmark-beta-responsiveness.ts` read directly from that expected Git revision; and
- `candidate.expectedVersion` and `candidate.healthVersion` both equal to `0.1.0-beta.1`.

The validator deliberately accepts additional v4 report fields because the benchmark contains metrics, samples, and observability data, but it does not infer identity or pass status from those unbound extras. A new responsiveness schema version requires an explicit validator and runbook update; it cannot silently satisfy this gate.

Stop if the report is incomplete, non-native, run with different resource limits, contains an identity mismatch, records upstream activity during the comparison window, or changes after hashing. Set `status` to `failed` or `incomplete` as appropriate and leave `native` false unless the report directly proves it.

## Desktop Browser And Accessibility Matrix

Test exactly one current-stable desktop release of each required family and record its complete visible version plus operating-system version:

| Family | Eligible platform |
| --- | --- |
| `chrome` | Current stable Chrome on Linux, macOS, or Windows |
| `edge` | Current stable Microsoft Edge on Linux, macOS, or Windows |
| `firefox` | Current stable Firefox on Linux, macOS, or Windows |
| `safari` | Current stable Safari on macOS only |

Use genuine release browsers in clean profiles without extensions that inject console output. Playwright Chromium is not Microsoft Edge, and a WebKit engine build is not Safari evidence. Previous browser majors, iOS browsers, other mobile browsers, and embedded webviews are best effort and do not fill these four rows.

Run the same exact-digest candidate flow in each browser. Record `consoleErrorCount` as the number of application console errors observed during the complete flow; acceptance requires `0`.

| Evidence field | Set `true` in each browser row only after this observation |
| --- | --- |
| `signIn` | The dedicated Plex user completes sign-in, returns to Moodarr, and the authenticated state survives a normal refresh. |
| `search` | A deterministic controlled query completes and renders the expected non-empty result state without an error overlay. |
| `resultActions` | Description, feedback/preference, Plex link, poster, and other applicable result controls respond with the correct visible state. |
| `requestConfirmation` | A verified requestable result reaches the established preview/confirmation state, and a catalog attempt—when present—keeps the separate **Availability not checked** and **Confirm Request Attempt** wording. No upstream write occurs before either confirmation. Do not create four additional upstream requests. |
| `adminAccess` | Admin token exchange unlocks Admin, protected data loads, and Admin Lock removes access without exposing the token in the URL or page. |
| `keyboardNavigation` | Keyboard-only navigation reaches the skip link, primary navigation, Finder composer, filters, results, confirmation, and Admin controls in a logical order without a trap. |
| `visibleFocus` | Every keyboard-reached interactive control has a visible, non-obscured focus indicator, including icon-only controls and the request-confirmation transition. |
| `mobileWidthLayout` | At a representative phone-width desktop viewport such as 390 by 844 CSS pixels, primary flows remain usable without overlap, clipped actions, or a horizontal scroll trap. This is responsive-layout evidence, not iOS-browser support. |
| `reducedMotion` | With `prefers-reduced-motion: reduce`, progress, card, spinner, and panel motion is removed or reduced without hiding state or blocking interaction. |

Automated accessibility tools may supplement this matrix but do not replace keyboard, focus, responsive-layout, reduced-motion, and console observations in every supported browser. If a browser updates during the matrix, record the new version and repeat that row; do not report a version that was not actually tested.

## Privacy-Safe Evidence Boundary

The strict JSON schema is an allowlist. Do not add notes, URLs, attachment paths, hostnames, IP addresses, origins, usernames, email addresses, library names, media titles, poster URLs, Plex rating keys, TMDB IDs, Seerr request IDs, idempotency keys, tokens, cookies, environment values, appdata paths, container IDs, or raw log text. Extra fields make the evidence schema-invalid.

Keep these materials private and outside the repository unless a separate reviewed process explicitly approves them:

- browser screenshots or recordings that show private libraries or identities;
- raw browser console exports;
- `docker inspect`, container environment, and Unraid diagnostics;
- Plex, Seerr/Jellyseerr, or Moodarr logs and support bundles;
- the catalog gzip, decompressed catalog rows, local asset path, importer terminal transcript, or controlled catalog titles and identifiers;
- the full responsiveness report and disposable data clone; and
- operator notes containing controlled titles, accounts, request IDs, or cleanup details.

The accepted public artifact should be the validator's compact summary plus, when desired, the schema-valid raw evidence JSON after a second privacy review. The responsiveness report is bound by `reportSha256` and its harness hash is bound to the expected Git blob; its contents do not belong in the manual evidence JSON. This remains a structured operator attestation, not independent automated proof. Never publish an artifact merely because the validator parsed it—the maintainer must still review the observations and both files for unsupported claims or accidental metadata introduced outside the schema.

## Stop Rules

Stop immediately, leave affected checks false, preserve only privacy-safe diagnostic notes, and clean up owned resources when any of these occurs:

- candidate version, revision, digest, platform, or attestation does not match;
- the catalog version, SHA-256, schema, provenance, or any manifest count differs; whole-file validation or the stopped networkless import is nonzero; or a catalog request-attempt row leaks into generic or verified-requestable-only results;
- a mutable tag, local image, or source/EXP build enters any evidence path, or responsiveness uses a remote Docker daemon or architecture emulation;
- validation would require existing user appdata, a shared request queue, uncontrolled media, or a capability/permission relaxation;
- an unexpected Plex Watchlist or Seerr/Jellyseerr write occurs, a request may have duplicated, or upstream cleanup cannot be proven;
- a credential, cookie, private origin, identity, title, request ID, or raw environment/log value enters a proposed public artifact;
- Plex, Seerr/Jellyseerr, or the test library changes during a baseline comparison;
- the responsiveness harness is nonzero, incomplete, non-native, outside the fixed limits, its v4 identity/status/check contract disagrees with the external expected values, its `harnessSha256` does not match the canonical script blob at the expected revision, Git cannot provide that blob, or its retained report no longer matches `reportSha256`;
- a required browser is not current stable, Safari is not on macOS, a browser row has any console error, or a required accessibility flow is incomplete;
- Unraid needs undocumented repairs, starts unhealthy, loses persistent state, weakens hardening, or cannot complete owned cleanup; or
- the evidence validator exits `1` or `2`, reports any failure, or does not reproduce the stored summary hash.

Do not convert a stop into a waiver inside the JSON. Fix the candidate or harness, publish a new immutable candidate when needed, and rerun every affected gate.

## Acceptance Checklist

A candidate passes this manual gate only when all of the following are true:

- candidate and Unraid version, full revision, and immutable digest are identical;
- catalog version, asset SHA-256, total records, and request-attempt eligible records match the pinned contract, and `exactAsset`, `networklessFullSnapshotImport`, `genericSearchIsolation`, and `requestAttemptDisclosure` are all `true`;
- every Unraid check is `true`, including `priorVersionUpdate` and `cleanupComplete`;
- exact Plex and Seerr/Jellyseerr versions are recorded and every integration check is `true`, including uncertain-outcome behavior and `upstreamCleanupComplete`;
- the retained responsiveness report passed natively on Linux `amd64` at 2 CPUs and 2048 MiB, still matches `responsiveness.reportSha256`, and carries the canonical responsiveness-harness SHA-256 from the expected Git revision;
- exactly one current-stable Chrome, Edge, Firefox, and macOS Safari row is present, every browser check is `true`, and every `consoleErrorCount` is `0`;
- `recordedAt` is the final UTC completion time after cleanup, is not in the future, is at or after the responsiveness report, and is no more than 14 days old when validated;
- the completed evidence file and summary pass a manual privacy review; and
- the command below exits `0`, with summary `status: "passed"` and an empty `failures` array:

  ```bash
  npm run --silent validate:beta-manual-evidence -- \
    --input "$evidence_file" \
    --expected-revision "$expected_revision" \
    --expected-digest "$expected_digest" \
    --responsiveness-report "$responsiveness_report"
  ```

Link the frozen summary and its reviewed evidence artifact from the candidate release ledger. This closes only the manual validation gate; final promotion still requires every other beta criterion and maintainer approval.
