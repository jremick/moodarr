# Beta Candidate Manual Validation

This runbook defines the fail-closed manual evidence required for a Moodarr web/server beta candidate. It covers the release gates that cannot be established by fixture mode or a source build alone: an exact-digest Unraid installation, real Plex and Seerr/Jellyseerr behavior, native Linux responsiveness, and the supported desktop browser and accessibility matrix.

The machine-readable contract in [`scripts/validate-beta-manual-evidence.ts`](../scripts/validate-beta-manual-evidence.ts) is authoritative for evidence shape and acceptance. Start from the structurally valid [`beta-manual-evidence-all-false.example.json`](beta-manual-evidence-all-false.example.json). The example is intentionally failing evidence, not a completed release artifact. Never change a `false` value to `true` until the exact candidate has passed that check and any required cleanup.

This evidence supplements the automated candidate workflow and the procedures in [Release](RELEASE.md). It does not replace clean-install, upgrade/rollback, supply-chain, vulnerability, or attestation evidence. Fixture, local-image, emulated-architecture, source, and EXP runs cannot close this manual gate.

## Operating Rules

- Use one evidence file for one candidate version, full 40-character revision, and immutable OCI index digest.
- Run from a clean checkout of that exact revision. Pull and launch only `ghcr.io/jremick/moodarr@sha256:...`; a mutable tag or local image is not eligible.
- Verify the candidate revision is reachable from `origin/main` and verify the digest attestation using the policy in [Release](RELEASE.md) before beginning manual checks. OCI labels are supporting evidence, not the source binding by themselves.
- Use dedicated validation accounts, controlled media, disposable Moodarr data, and a test-safe Seerr request target. Do not run write tests against an uncontrolled household or production queue.
- Keep Plex library content and Seerr request state quiescent while collecting integration and responsiveness evidence. If upstream state changes unexpectedly, discard the affected observation and repeat it from a fresh baseline.
- Record exact versions observed from the running products and browsers, not versions copied from documentation or download pages.
- Record only direct observations. If a check is skipped, ambiguous, inherited from another candidate, or performed against a different digest, leave it `false`.
- Finish upstream and Unraid cleanup before setting either cleanup field to `true`. Cleanup is part of acceptance, not post-release housekeeping.

## Prepare The Evidence File

Keep the working copy outside the checkout and readable only by the operator:

```bash
set -euo pipefail
umask 077
evidence_file="$(mktemp "${TMPDIR:-/tmp}/moodarr-beta-manual-evidence.XXXXXX")"
summary_file="$(mktemp "${TMPDIR:-/tmp}/moodarr-beta-manual-summary.XXXXXX")"
cp docs/beta-manual-evidence-all-false.example.json "$evidence_file"
chmod 600 "$evidence_file"
```

Replace every placeholder identity and version. Use a UTC `recordedAt` timestamp only after all checks and cleanup are complete. `operatorRole` must be either `maintainer` or `release-delegate`.

The validator accepts only a regular, non-symlink JSON file no larger than 64 KiB. It emits a compact allowlisted summary and uses these exit codes:

| Exit | Meaning | Release action |
| --- | --- | --- |
| `0` | Schema valid and every acceptance check passed | Eligible to link from the release ledger after privacy review |
| `1` | Schema valid but one or more checks failed | Stop; do not approve or promote the candidate |
| `2` | Input missing, unsafe, malformed, oversized, or schema-invalid | Stop; repair the evidence process before retesting |

Validate the tracked all-false example once to prove the local command works. Exit `1` is expected:

```bash
example_summary="$(mktemp "${TMPDIR:-/tmp}/moodarr-beta-manual-example.XXXXXX")"
set +e
npm run --silent validate:beta-manual-evidence -- \
  --input docs/beta-manual-evidence-all-false.example.json \
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
  > "$summary_file"
```

Any edit to the raw file changes the summary's `evidenceSha256`. Re-run validation after every edit and freeze the accepted pair together.

## Bind The Candidate Identity

Populate `candidate.version`, `candidate.revision`, and `candidate.digest` from the verified candidate. The Unraid runtime must repeat the same identity in `unraid.imageVersion`, `unraid.imageRevision`, and `unraid.imageDigest`.

Before any behavioral check:

1. Resolve the candidate by immutable digest and confirm it is a single supported `linux/amd64` image.
2. Confirm its version and revision labels match the expected beta version and full revision.
3. Confirm the running Unraid container uses that digest, not merely an image with matching labels.
4. Copy the exact identity into both JSON locations and compare them byte for byte.

Stop and discard all evidence if the candidate is rebuilt, the digest changes, the expected revision changes, a platform manifest differs, or any Unraid identity value differs. Evidence never transfers between candidate digests.

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
| `plexLibrarySync` | A full sync against the recorded Plex version completes, expected controlled media appears once, and catalog/source counts are credible. |
| `plexSignIn` | The dedicated user completes Plex sign-in, receives only user access, and sign-out/session invalidation behaves as documented. |
| `plexCapabilityDefaults` | The new Plex user begins with request and other elevated capabilities at their documented safe defaults; only the intended test capability is deliberately enabled by Admin. |
| `plexPosterAndLink` | A controlled result serves its poster through Moodarr without a token-bearing URL and opens the correct Plex item link. |
| `plexWatchlistAction` | The signed-in test user explicitly adds the controlled item to their Plex Watchlist, the upstream change appears once, and the item is removed again during cleanup. |
| `seerrStateSync` | Operational request state sync against the recorded Seerr/Jellyseerr version completes and represents the controlled existing state without importing descriptive catalog content. |
| `requestPreview` | Preview reports the exact controlled media type, local interoperability identifier, title, and seasons where applicable; no upstream request exists before confirmation. |
| `controlledRequestCreatedOnce` | One explicitly confirmed request creates exactly one upstream Seerr/Jellyseerr request for the controlled item. |
| `idempotentRetry` | Retrying the same confirmed payload, user scope, and idempotency key returns the existing outcome and does not produce a second upstream request. |
| `uncertainOutcomeReconciledWithoutResend` | In an isolated test path, a one-shot fault forwards the request upstream but withholds the response; Moodarr reconciles the resulting upstream state and retry does not send a second request. |
| `upstreamCleanupComplete` | The test Watchlist entry is removed, the controlled Seerr/Jellyseerr request is removed or cancelled through the supported upstream workflow, temporary capability changes are reverted, and no duplicate or pending test operation remains. |

The uncertain-outcome check is destructive fault injection. Use only a dedicated test target and a controlled one-shot proxy or equivalent mechanism whose forwarding behavior can be counted. Never simulate uncertainty by interrupting a shared Seerr server or household network. If the accepted-upstream/no-response condition cannot be created and observed safely, leave `uncertainOutcomeReconciledWithoutResend` false and stop the release gate.

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
| `requestConfirmation` | A requestable result reaches the explicit preview/confirmation state and no upstream write occurs before confirmation. Do not create four additional upstream requests. |
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
- the full responsiveness report and disposable data clone; and
- operator notes containing controlled titles, accounts, request IDs, or cleanup details.

The accepted public artifact should be the validator's compact summary plus, when desired, the schema-valid raw evidence JSON after a second privacy review. The responsiveness report is bound by `reportSha256`; its contents do not belong in the manual evidence JSON. Never publish an artifact merely because the validator parsed it—the operator must still review the two files for accidental metadata introduced outside the schema.

## Stop Rules

Stop immediately, leave affected checks false, preserve only privacy-safe diagnostic notes, and clean up owned resources when any of these occurs:

- candidate version, revision, digest, platform, or attestation does not match;
- a mutable tag, local image, or source/EXP build enters any evidence path, or responsiveness uses a remote Docker daemon or architecture emulation;
- validation would require existing user appdata, a shared request queue, uncontrolled media, or a capability/permission relaxation;
- an unexpected Plex Watchlist or Seerr/Jellyseerr write occurs, a request may have duplicated, or upstream cleanup cannot be proven;
- a credential, cookie, private origin, identity, title, request ID, or raw environment/log value enters a proposed public artifact;
- Plex, Seerr/Jellyseerr, or the test library changes during a baseline comparison;
- the responsiveness harness is nonzero, incomplete, non-native, outside the fixed limits, or its retained report no longer matches `reportSha256`;
- a required browser is not current stable, Safari is not on macOS, a browser row has any console error, or a required accessibility flow is incomplete;
- Unraid needs undocumented repairs, starts unhealthy, loses persistent state, weakens hardening, or cannot complete owned cleanup; or
- the evidence validator exits `1` or `2`, reports any failure, or does not reproduce the stored summary hash.

Do not convert a stop into a waiver inside the JSON. Fix the candidate or harness, publish a new immutable candidate when needed, and rerun every affected gate.

## Acceptance Checklist

A candidate passes this manual gate only when all of the following are true:

- candidate and Unraid version, full revision, and immutable digest are identical;
- every Unraid check is `true`, including `priorVersionUpdate` and `cleanupComplete`;
- exact Plex and Seerr/Jellyseerr versions are recorded and every integration check is `true`, including uncertain-outcome behavior and `upstreamCleanupComplete`;
- the retained responsiveness report passed natively on Linux `amd64` at 2 CPUs and 2048 MiB and still matches `responsiveness.reportSha256`;
- exactly one current-stable Chrome, Edge, Firefox, and macOS Safari row is present, every browser check is `true`, and every `consoleErrorCount` is `0`;
- `recordedAt` is the final UTC completion time after cleanup;
- the completed evidence file and summary pass a manual privacy review; and
- `npm run --silent validate:beta-manual-evidence -- --input "$evidence_file"` exits `0`, with summary `status: "passed"` and an empty `failures` array.

Link the frozen summary and its reviewed evidence artifact from the candidate release ledger. This closes only the manual validation gate; final promotion still requires every other beta criterion and maintainer approval.
