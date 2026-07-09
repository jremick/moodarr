# Moodarr iOS Alpha

Status: alpha v1 runnable app target.
Last updated: 2026-07-10.

This folder contains the native SwiftUI app target for Moodarr iOS plus a dependency-free Swift package for the app core. The app uses SwiftUI, Foundation networking, and Security/Keychain only.

## Scope

- Connect to a trusted LAN/VPN Moodarr server.
- Read `/api/health` and `/api/config/status`.
- Complete Plex PIN auth with `nativeSession: true`.
- Store the returned Moodarr user session token in Keychain.
- Search `/api/search`.
- Attach swipe/pairwise feedback to the returned recommendation `sessionId`.
- Send a unique `clientEventId` with each local feedback action so retries are idempotent.
- Persist failed feedback by Moodarr server and signed-in user, with bounded exponential retry backoff across launches.
- Load protected posters through Moodarr's poster proxy.
- Preview every unavailable-title Seerr action, then require a separate confirmation step and the server-provided phrase before create.
- Present an adaptive result grid with a safe-area detail/action shelf that keeps availability and match reasoning visible.

Admin setup stays in the web app for alpha v1. iOS does not accept Plex, Seerr, OpenAI, or admin tokens.

## Local Verification

```bash
cd apps/ios
swift test
xcodebuild -project Moodarr.xcodeproj -scheme Moodarr -destination 'platform=iOS Simulator,name=iPhone 17,OS=26.5' CODE_SIGNING_ALLOWED=NO build
```

## Generate Or Refresh The Xcode Project

The checked-in `Moodarr.xcodeproj` is generated from `project.yml` with XcodeGen.

```bash
cd apps/ios
./scripts/generate-xcode-project.sh
```

## Run On An iPhone

1. Start the Moodarr API where the iPhone can reach it:

```bash
MOODARR_API_HOST=0.0.0.0 npm run dev:api
```

2. Find the Mac LAN IP:

```bash
ipconfig getifaddr en0
```

Use `en1` if your active network is not Wi-Fi.

3. Open `apps/ios/Moodarr.xcodeproj` in Xcode.
4. Select the `Moodarr` scheme and your connected iPhone.
5. In target Signing & Capabilities, choose your Apple development team. Keep automatic signing enabled. If `ai.jarel.moodarr` is unavailable for your team, change the bundle id to a private reverse-DNS id for local testing.
6. Build and run from Xcode.
7. In the app, enter `http://<mac-lan-ip>:4401`.

The app currently allows local HTTP transport for alpha LAN/VPN testing. Tighten ATS before TestFlight or any broader distribution.

## Simulator Run

For simulator-only testing, start the API normally and use `http://127.0.0.1:4401` in the app. The simulator can reach the Mac loopback address; a physical iPhone cannot.

## Xcode Structure

- `Moodarr.xcodeproj`: generated runnable iOS app project.
- `project.yml`: source of truth for the generated project.
- `App/`: minimal `@main` app wrapper and iOS plist.
- `Sources/MoodarrIOS/`: reusable SwiftUI/API/client package code.
- `Tests/MoodarrIOSTests/`: model and feedback mapping tests.

## Manual Alpha Walkthrough

1. Run Moodarr on a trusted LAN/VPN URL.
2. Open the app and enter the server URL, for example `http://127.0.0.1:4401` in simulator or `http://<mac-lan-ip>:4401` on iPhone.
3. Tap the health check action.
4. Start Plex sign-in, open the returned Plex URL, and poll/complete until authenticated.
5. Search for a mood query.
6. Swipe right/left/skip or use right/wrong mood actions.
7. Choose Request for an unavailable result and verify the preview opens without creating anything.
8. Confirm with the exact phrase in the separate confirmation sheet before create.
9. Check web admin diagnostics for `source: "ios"` feedback events.
