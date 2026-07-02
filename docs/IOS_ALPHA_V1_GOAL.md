# Moodarr iOS Alpha v1 Goal

Status: active build goal.
Last updated: 2026-07-02.

## Summary

Build a complete end-to-end native iOS alpha for Moodarr. Alpha v1 should let a trusted LAN/VPN user connect to a Moodarr server, authenticate with Plex when required, search the synced Plex/Seerr catalog, inspect results, send swipe and pairwise calibration feedback through the existing Feel Feedback spine, preview Seerr requests, and create requests only after explicit confirmation.

This is an alpha implementation goal, not a polished App Store release goal. The target is a coherent runnable client and backend contract with reviewable decisions, documented gaps, and practical verification.

## Project Harness

- Intent: make iOS a real Moodarr client for watch selection and calibration, not a separate recommender or a marketing prototype.
- Good means: the app can complete setup, auth/session check, search, poster display, feedback capture, request preview, and explicit request creation against fixture and LAN/VPN Moodarr instances.
- Evidence: backend tests cover the native contract, iOS unit/build checks pass where available, and admin diagnostics can show `source: "ios"` feel events after device/simulator use.
- Risks: mobile swipe signals can train noisy profiles; native auth can accidentally weaken the server-side secret boundary; local HTTP/LAN behavior can fail on iOS privacy/ATS rules; broad native scope can produce an attractive shell without a working contract.
- Work mode: plan then build, with one active integration lane and isolated sub-agent work only in disjoint file scopes.
- Harness: this doc is the source of truth for scope and decisions; `.codex/adhd-helper/session.md` keeps local restart state; backend `npm run verify` remains the release gate for shared API behavior; iOS verification uses the strongest available local Swift/Xcode checks.
- First path: document decisions, scaffold native iOS code under `apps/ios/`, add narrow backend support only if native session handling requires it, then verify with backend tests and iOS build/tests.

## Alpha v1 Scope

### Must Have

- Server URL entry and persisted local server configuration.
- Health/config check before login.
- Plex user auth flow using existing `/api/auth/plex/start` and `/api/auth/plex/complete`.
- Auth session readback through `/api/auth/session`.
- Search through `/api/search`, including query text, solo/group context, result limit, and basic filters where practical.
- Result list/card detail showing title, poster, year, runtime, genres, availability, match explanation, and source state.
- Poster loading only through Moodarr poster proxy routes.
- Feel feedback submission through `/api/feel-feedback` with `source: "ios"`.
- Swipe mapping for right, left, skip, open, save/hide, right mood, wrong mood, and pairwise pick.
- Request preview through `/api/requests/preview`.
- Request creation through `/api/requests/create` only after explicit confirmation phrase.
- Local retry queue for feel feedback when offline or temporarily unauthenticated.
- Secret-safe error handling and no raw prompt storage in mobile feedback metadata.

### Should Have

- Basic onboarding states for unreachable server, unauthenticated server, configured fixture server, and authenticated user.
- Keychain-backed session or token storage if native cookie persistence is not sufficient.
- A compact diagnostics/debug screen for server status and current user, without admin secrets.
- Unit tests for API model decoding and gesture-to-feedback mapping.
- Runbook for simulator/device verification.

### Non-Goals For Alpha v1

- App Store submission.
- Public internet deployment.
- Native admin settings for Plex, Seerr, OpenAI, sync controls, or support bundle.
- Global recommender, collaborative filtering, foundation-model training, or mobile-only learning model.
- Direct Plex or Seerr token entry in iOS.
- Broad visual redesign outside the existing Screening Desk design language.

## Decisions For Review

### D-20260618-001 - Build Alpha v1 As Native SwiftUI

- `Date`: 2026-06-18
- `Status`: Accepted for implementation
- `Owner`: Codex for initial alpha build; Jarel for review
- `Scope`: iOS app architecture
- `Decision`: Use native SwiftUI with Foundation networking and Security/Keychain support. Do not use React Native, Expo, or Capacitor for this alpha.
- `Why`: The target is iOS-only right now, gesture-heavy, local-network-sensitive, and auth/session-sensitive. Native SwiftUI reduces framework overhead and gives the most direct path to local network permissions, ATS configuration, Keychain storage, and native swipe interactions.
- `Alternatives`: React Native/Expo would reuse TypeScript mental models and help if Android becomes near-term; Capacitor would be fastest as a wrapper but risks shipping a web shell rather than proving the native calibration surface.
- `Follow-ups`: Revisit only if Android becomes an explicit alpha v2 requirement before the iOS contract is stable.
- `Accounted for`: This goal doc and initial scaffold.
- `Memory routing`: None.

### D-20260618-002 - Keep iOS Out Of Admin Secret Management

- `Date`: 2026-06-18
- `Status`: Accepted for implementation
- `Owner`: Codex for initial alpha build; Jarel for review
- `Scope`: Security and product scope
- `Decision`: Alpha v1 iOS will not configure Plex, Seerr, OpenAI, admin tokens, sync settings, or support bundles. It is a user client for Finder, calibration, and explicit request workflows.
- `Why`: Moodarr's supported boundary keeps integration tokens server-side. The web admin already owns setup and operational controls. Adding native admin controls would widen the auth surface and slow down the alpha without improving the primary mobile use case.
- `Alternatives`: Build a full native admin panel; add direct admin token entry; embed the existing web admin in a WebView.
- `Follow-ups`: Consider a read-only diagnostics screen only after the core user flow works.
- `Accounted for`: Alpha scope and backend contract.
- `Memory routing`: None.

### D-20260618-003 - Treat Mobile Feedback As The Existing Feel Feedback Contract

- `Date`: 2026-06-18
- `Status`: Accepted for implementation
- `Owner`: Codex for initial alpha build; Jarel for review
- `Scope`: API and learning semantics
- `Decision`: iOS sends `POST /api/feel-feedback` events with `source: "ios"` and does not introduce a separate mobile learning model or endpoint.
- `Why`: The server already has reliability classes, holdouts, profile-version logging, and tests for iOS-style pairwise feedback. A separate mobile path would create inconsistent learning semantics and make replay/diagnostics weaker.
- `Alternatives`: Add `/api/mobile/*` feedback endpoints; store mobile-only feedback locally until a later sync model exists.
- `Follow-ups`: Backend tests should prove mobile event mapping and metadata sanitization continue to hold.
- `Accounted for`: Existing shared type contract and alpha scope.
- `Memory routing`: None.

### D-20260618-004 - Advance Mobile Despite Earlier Gate, But Preserve The Gate In Behavior

- `Date`: 2026-06-18
- `Status`: Accepted for implementation
- `Owner`: Codex for initial alpha build; Jarel for review
- `Scope`: Roadmap sequencing
- `Decision`: Start the iOS alpha now because the user explicitly requested it, while keeping alpha behavior conservative: skip remains neutral, weak/diagnostic actions do not train term profiles, and profile learning stays governed by the existing backend reliability/holdout rules.
- `Why`: Earlier docs deferred mobile until controlled usage semantics stabilized. Since key backend semantics now exist, building alpha can expose real integration issues while avoiding a mobile-first learning pivot.
- `Alternatives`: Stop at docs until controlled usage is replay-ready; build only a clickable prototype with no backend feedback.
- `Follow-ups`: Review admin `usageReadiness` after real iOS feedback batches before claiming personalization quality.
- `Accounted for`: Alpha acceptance checks and non-goals.
- `Memory routing`: None.

### D-20260618-005 - Add Explicit Native User Session Support

- `Date`: 2026-06-18
- `Status`: Accepted for implementation
- `Owner`: Codex for initial alpha build; Jarel for review
- `Scope`: Auth/session contract
- `Decision`: Keep the existing cookie flow for web, and add explicit native user session support: `POST /api/auth/plex/complete` can return `sessionToken` and `sessionExpiresAt` only when `nativeSession: true` is sent. User routes accept that user session token as `Authorization: Bearer`, while admin routes still require admin auth.
- `Why`: Native iOS should not depend on browser-style cookie persistence for the alpha. Returning the user session only on explicit native opt-in keeps the web default HTTP-only cookie behavior intact and lets iOS store a non-admin user session in Keychain.
- `Alternatives`: Immediately expose the session token in JSON; require admin bearer token in iOS; add OAuth-like mobile bearer sessions.
- `Follow-ups`: Store only this user session token in iOS Keychain; never treat it as an admin credential.
- `Accounted for`: `src/server/app.ts`, `src/shared/types.ts`, and `tests/app.test.ts`.
- `Memory routing`: None.

### D-20260618-006 - Return Recommendation Session IDs To Clients

- `Date`: 2026-06-18
- `Status`: Accepted for implementation
- `Owner`: Codex for initial alpha build; Jarel for review
- `Scope`: API contract and feedback quality
- `Decision`: `SearchResponse` includes an optional `sessionId` from the recorded recommendation session.
- `Why`: iOS feedback needs to attach swipes and pairwise choices to the displayed slate. Without the session id, replay evaluation and per-session learning caps are weaker.
- `Alternatives`: Have iOS omit `sessionId`; have iOS infer the latest session indirectly; add a separate mobile search endpoint.
- `Follow-ups`: Keep telemetry failure soft. If recommendation run recording fails, search still returns without `sessionId`.
- `Accounted for`: `src/shared/types.ts`, `src/server/recommendation/engine.ts`, and `tests/app.test.ts`.
- `Memory routing`: None.

### D-20260618-007 - Make Native Feedback Retries Idempotent

- `Date`: 2026-06-18
- `Status`: Accepted for implementation
- `Owner`: Codex for initial alpha build; Jarel for review
- `Scope`: Feedback integrity
- `Decision`: `FeelFeedbackRequest` accepts optional `clientEventId`; the database stores it and enforces uniqueness by source/client event id.
- `Why`: iOS alpha includes a local retry queue. If a response is lost after the server records feedback, retrying the same event must not double-train preferences or Feel Profile terms.
- `Alternatives`: Accept duplicate risk for alpha; keep `clientEventId` only in metadata; delay offline retry support.
- `Follow-ups`: Keep `clientEventId` secret-free and generated client-side per user action.
- `Accounted for`: `src/shared/types.ts`, `src/server/app.ts`, `src/server/db/database.ts`, `src/server/db/mediaRepository.ts`, `tests/app.test.ts`, and `apps/ios`.
- `Memory routing`: None.

### D-20260618-008 - Check In A Generated Xcode Project For Device Testing

- `Date`: 2026-06-18
- `Status`: Accepted for implementation
- `Owner`: Codex for initial alpha build; Jarel for review
- `Scope`: iOS build and test harness
- `Decision`: Add a real `Moodarr.xcodeproj` generated from `apps/ios/project.yml`, with a minimal app wrapper around the `MoodarrIOS` Swift package.
- `Why`: A Swift Package alone is useful for tests but not enough for fast physical-device testing. Checking in the generated project lets Xcode open the app directly, while `project.yml` keeps the project reproducible.
- `Alternatives`: Keep package-only instructions; hand-edit an Xcode project without a generator; wait for a future app workspace.
- `Follow-ups`: Regenerate the project with `apps/ios/scripts/generate-xcode-project.sh` after structural project changes.
- `Accounted for`: `apps/ios/project.yml`, `apps/ios/Moodarr.xcodeproj`, `apps/ios/App`, and `apps/ios/README.md`.
- `Memory routing`: None.

### D-20260618-009 - Allow Local HTTP For Alpha Device Runs

- `Date`: 2026-06-18
- `Status`: Accepted for implementation
- `Owner`: Codex for initial alpha build; Jarel for review
- `Scope`: iOS networking and alpha security posture
- `Decision`: Configure the iOS app plist to allow local HTTP networking for alpha LAN/VPN testing and declare the local-network privacy reason.
- `Why`: The Moodarr development server runs HTTP on a LAN-reachable port. A physical iPhone cannot reach the Mac's `127.0.0.1`, and ATS/local-network prompts would otherwise block the alpha walkthrough before the product contract can be tested.
- `Alternatives`: Require HTTPS certificates for local alpha; ship simulator-only; hard-code ATS exceptions for one hostname.
- `Follow-ups`: Tighten ATS before TestFlight or any broader distribution, ideally by supporting HTTPS or narrowly scoped host exceptions.
- `Accounted for`: `apps/ios/App/Info.plist` and `apps/ios/README.md`.
- `Memory routing`: None.

## Acceptance Checks

- `npm run verify` passes after any backend/type/test changes.
- `npm run eval:profile-replay` and `npm run eval:profile-journeys` are run if feedback learning behavior changes.
- iOS API models decode representative fixture responses.
- iOS gesture mapping tests prove skip is neutral, pairwise pick includes both item IDs, and mobile metadata excludes raw prompts.
- iOS build/test command is documented and run when Xcode/Swift tooling is available.
- Manual fixture-mode walkthrough is documented: server check, login/session, search, feedback, request preview, request create blocked until confirmation.

## Open Decisions

- Whether native cookie persistence is worth supporting in addition to the accepted native user session token path.
- Whether alpha should support Bonjour/discovery or only manual server URL entry.
- Whether to include an admin-token escape hatch for local-only owner testing.
- Whether to support iPad layout in alpha v1 or constrain to iPhone-first responsive SwiftUI.
- Whether local HTTP should remain available after alpha or move to HTTPS-only before TestFlight.
