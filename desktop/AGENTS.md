# Inflex on the remote Mac

This directory owns the native SwiftUI desktop app. Read the repository root `AGENTS.md` too. The user has authorized completing the SwiftUI migration and GUI testing. When asked to continue or verify on the Mac, run the checks below and fix failures without asking for another confirmation for ordinary builds, fixture tests, or reversible fixes.

## Start here

1. Work at the repository root. Confirm this checkout contains `desktop/Package.swift`, `desktop/Inflex.xcodeproj`, and `scripts/inflex-desktop-verify.mjs`. Preserve other work in this checkout.
2. The target is Apple Silicon macOS 14+. Use Node 24+, pnpm from root `packageManager`, and full Xcode 16+ with its command line tools selected. Swift must support the Swift 6 package manifest. `xcodebuild -version`, `swift --version`, `node --version`, and `pnpm --version` identify the tools.
3. Use the Mac's logged-in graphical desktop for Xcode UI automation. A headless SSH session by itself does not prove the UI works. If Xcode's first-launch setup, license, developer tools permission, or GUI automation access blocks a check, report the exact prerequisite and resume after it is satisfied. Do not label blocked tests as passed.
4. Run the single root command:

   ```sh
   pnpm inflex:desktop:verify
   ```

   It checks Xcode/Swift, installs locked workspace dependencies, runs Swift client/contract tests, runs real Xcode UI tests, installs the isolated media dependencies, builds the production runtime and Keychain helper, and packages `dist/desktop/Inflex.app` and `dist/desktop/Inflex.dmg`. It does not install multi-gigabyte AI models or require a real ChatGPT account for fixture tests.

5. Inspect `dist/desktop-validation/latest.md`, `latest.json`, the per-step logs, and `dist/desktop-ui-*.xcresult`. Fix the first failure and rerun the affected root script. Finish by rerunning the full command after relevant fixes. Record actual results in `docs/inflex/validation.md`.

If full Xcode or Node/pnpm is missing, name the missing tool and provide the exact setup step. Full Xcode installation and opening a logged-in Mac desktop may require the user's first-person access. Do not silently fall back to a browser UI or claim Linux checks validated SwiftUI rendering.

## Individual checks

- `pnpm test:desktop`: Swift unit and HTTP contract tests. The runner starts and stops a loopback fixture whose requests and events are validated by the actual TypeScript runtime schemas. Covers fragmented Unicode/CRLF SSE, replay, turn cursors, independent child tool results, approvals, settings preservation, artifacts and errors.
- `pnpm test:desktop:ui`: Xcode builds and launches the native app against that fixture. Covers chat, all goal modes and all five thinking tiers, saved sessions, approvals, media preview, configuration, settings, sign-in presentation, screenshots and launch/CPU/memory metrics. Run tests serially because they share a fixture. No live OAuth tokens are required.
- `pnpm inflex:desktop:check`: compile the native app with SwiftPM.
- `pnpm inflex:desktop:prepare` then `pnpm inflex:desktop:build`: production runtime, Swift Keychain helper, native release app and DMG. No Rust or Tauri is needed. Distribution signing/notarization is separate from the local ad-hoc signing check.
- `pnpm test:frontend`, `pnpm test:assistant-ui-runtime`, `pnpm test:trueforge-ui`: browser compatibility and shared interaction regressions. These do not substitute for native UI tests.

If ports 18790 (fixture) or 8790 (ordinary runtime) are occupied, identify their owners. Do not kill an unrelated or user-started runtime. Stop only a fixture/process started for this test run, or deliberately configure a separate test port and keep the runner and tests synchronized.

## Appearance and behavior acceptance

Inspect the screenshots in the Xcode result bundle and then the actual release app at 1200 × 800 in both Light and Dark. Match the existing Inflex brand and layout: purple/blue primary gradient, 80-point navigation rail, 256-point recent chats column, 768-point chat measure, title bar, messages, tool/approval cards and bottom composer. Native macOS controls may differ slightly; do not redesign the interface. Compare against the browser frontend on the same Mac and, if available, screenshots or the previous installed desktop build. Check smaller windows (minimum 960 × 640), resizing, keyboard navigation and readable focus/contrast.

Exercise these workflows; fix regressions rather than dropping controls:

- New chat, model, instructions and workspace; Standard/Enhanced/Advanced independent of Light/Balanced/Deep/Intensive/Ultra. Ultra delegates even in Standard; GUI does not duplicate backend policy.
- Streaming, stop, reconnect, session switching, earlier history, search, rename, delete, sharing, attachments and transcript export. Check reconnect/replay does not duplicate messages and switching sessions does not leak draft/results into another session.
- Parent/child tool cards, approval allow/deny/session policy, client tool responses and MCP OAuth continuation. The existing runtime owns permissions and execution.
- Saved agents, connectors including external CAD MCP, skills, provider/sandbox/web-search settings, schedules and environments. Confirm edits preserve fields the native UI does not explicitly expose.
- Media list/refresh, image/PDF preview, audio/video playback, save/open and cleanup on dismissal. Large media must stay lazy.
- ChatGPT sign-in/reload/sign-out, cancellation of startup, attach to an already running Terminal runtime, and graceful quit. Quitting must stop a runtime the app started and leave a separately started runtime alive.

Live account/device checks require the user's already configured account and actual macOS permissions. Use a disposable workspace and data profile for mutation tests. Do not copy Codex OAuth token files, print secrets, modify the user's projects, or request screen/microphone permissions just to pass fixture tests. Obtain the user's participation only for an actual login/OS prompt that automation cannot complete. Record those checks separately from fixture results.

## Efficiency acceptance

The SwiftUI app must render native controls and MarkdownUI content; do not embed React in WKWebView. Keep one session engine, no duplicate tool registry, event-driven updates, coalesced streaming deltas, lazy transcript/media views and on-demand heavy services.

Inspect the Xcode launch, CPU and memory metrics. Compare the previous desktop build and SwiftUI build on the **same Mac**, same release configuration, same backend/profile, same transcript, same window/theme, and repeated warm/cold launches. Include the old webview helper processes when comparing GUI RSS/CPU, and keep backend costs separate. Observe idle resource consumption, first-window latency and streaming responsiveness; do not compare a Debug fixture result with a Release production baseline. Report raw measurements and variance. If the old build is unavailable, record the new baseline and leave improvement unverified. Do not invent a percentage saving or call a metric a regression gate before establishing a baseline.

## Current handoff

The initial implementation was made in a Linux environment. Portable Swift tests and browser/shared interaction checks can run there, but that environment cannot compile SwiftUI against the macOS SDK, render the app, run Xcode UI tests, validate the .app/.dmg, or measure native performance. The Mac checks above are required before calling the GUI migration fully verified. See `docs/inflex/validation.md` for the most recent executed checks.
