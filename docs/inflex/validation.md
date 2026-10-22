# Inflex validation

This is an implemented runtime with verified local workflows, not a completed native release qualification. The primary target is Apple Silicon macOS 14+. The checks below were performed on Linux with Node 24.19.0 on 2026-10-22.

## Verified

| Check                | Evidence                                                                                                                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production build     | Core CJS/ESM libraries, SDK, assistant runtime, UI, frontend, and server/CLI build successfully                                                                                                           |
| Core runtime         | 57 suites: 538 passed, one existing skipped test                                                                                                                                                          |
| Server               | 85 suites, 713 tests passed; covers policy wiring, OAuth catalog admission, approvals, memory, subprocesses and media                                                                                     |
| Assistant runtime    | 24 files, 254 tests passed                                                                                                                                                                                |
| UI                   | 227 files, 1,803 tests passed; package consumer checks also pass                                                                                                                                          |
| Frontend             | 18 tests passed                                                                                                                                                                                           |
| Media worker         | Composition and real Sharp image-processing tests pass without a GPU                                                                                                                                      |
| Browser              | Real Playwright MCP subprocess and Chromium navigate, inspect a DOM and click a control; the production Inflex sign-in page renders                                                                       |
| Documents            | Real MarkItDown extracts a generated PDF; Tesseract recognizes a generated document image through native tools                                                                                            |
| Video/audio evidence | Real FFmpeg fixtures verify frame decoding, nonzero source PTS, long GOP sampling, cached analysis, channel metadata, levels and spectrum output                                                          |
| OAuth protocol       | Offline signed callback/JWKS fixtures verify PKCE, state, nonce, issued client identity, grant scope, refresh and logout races; Responses fixtures cover completion gating and encrypted reasoning replay |
| Isolation            | Dirty parent work and index survive snapshots; overlapping charters fail; worktrees survive resolver recreation; integration detects parent conflicts                                                     |

No live account was authenticated. Tests using protocol fixtures do not establish account entitlement or production endpoint availability.

## SwiftUI migration verification

The desktop webview shell has been replaced with SwiftUI source, SwiftPM/Xcode targets and native packaging. On Linux, Swift 6.1.3 passed **14 client tests**, including a real loopback HTTP/SSE fixture checked against the runtime's canonical TypeScript schemas. Tests cover Unicode/framing, replay, new-turn cursors, child tools, approvals, edits/attachment preservation, all 15 goal/thinking combinations, artifacts and HTTP failures. Swift source syntax parsing also passed; this is not macOS SDK type checking.

The GUI-relevant compatibility suites were rerun: frontend **18**, shared assistant runtime **254**, and browser UI **1,803** tests pass, with UI package consumer checks. The Mac verification command correctly reports this Linux host as unsupported and writes a failed/pending report rather than a native success.

**Not yet verified:** macOS SwiftUI compilation, Xcode UI execution, screenshot comparison, release .app/.dmg launch and native resource measurements. The remote Mac was not accessible during this work. Six Xcode UI test workflows and macOS CI wiring are provided for those checks; they have not been represented as passing.

On the Mac, run `pnpm inflex:desktop:verify`. It writes `dist/desktop-validation/latest.md` and `latest.json`, per-step logs and Xcode screenshot/metric bundles. Follow [desktop/AGENTS.md](../../desktop/AGENTS.md) to fix any native failures and complete appearance, behavior and efficiency comparisons. No GUI speedup or memory saving has been measured yet.

## Efficiency observations

`pnpm inflex:benchmark` starts the production runtime with a fresh temporary profile and runs a two-second, four-sample video fixture. One observed run produced:

| Measurement                | Observed value |
| -------------------------- | -------------- |
| Startup to health response | 1,747 ms       |
| Idle RSS after one second  | 237 MiB        |
| First video analysis       | 765 ms         |
| Cached analysis            | 1 ms           |

These are machine-specific observations, not budgets or performance guarantees. The idle snapshot had the HTTP server and ordinary pipe/socket handles, with no controller timers, media workers, browser processes or managed memory process. Scheduling is disabled by default. Hindsight, browser control, desktop control and media engines initialize when needed. Stable media hashes, cache hits that avoid FFprobe and frame-decoder launches, owner-cached credentials, and session-scoped MCP reuse reduce repeated work.

## Reproduce

Install the source dependencies and build as described in the root README. Then run:

```sh
pnpm inflex:test
pnpm typecheck
pnpm inflex:benchmark
pnpm inflex:browser:test
pnpm inflex:documents:test
```

The browser probe needs Chrome/Chromium; `INFLEX_BROWSER_EXECUTABLE` selects an explicit executable. With a built server running, `pnpm inflex:browser:test --gui http://127.0.0.1:8790` also checks the sign-in interface. Document checks require the pinned MarkItDown installation, Tesseract with English data, and FFmpeg with its drawtext filter.

## Target-device release checks

The following checks remain necessary before calling the entire plan release-ready:

- Build and launch the SwiftUI app and Swift Keychain helper on Apple Silicon macOS. Check desktop/Terminal session sharing, shutdown ownership, shell confinement and native permissions.
- Complete real local OAuth sign-in, load the entitled model catalog, execute a tool-using turn, refresh credentials, and sign out. Verify Standard, Enhanced and Advanced tasks through both clients, including Ultra delegation.
- Start managed Hindsight/pg0 with its local embedding/reranking models. Verify retention and recall across sessions, service restart, outage recovery, forgetting, and a real transfer export/restore.
- Run `pnpm inflex:media:smoke` on a WebGPU/Metal-capable device. It must render and probe an actual trimmed MP4 with captions and moving labels. The Linux run failed explicitly with “WebGPU not available”; it was not counted as passing. Also validate detection/tracking against annotated footage and person masks against visible subjects.
- Install configured whisper.cpp, Piper and stable-diffusion.cpp models. Check intelligible STT/TTS, timestamp alignment, narration export and image generation with real models.
- Exercise open-computer-use with the operating system permissions granted and test the user's connected CAD MCP server against a disposable document.

The current Linux host lacks the sandbox runtime's `socat` dependency and a WebGPU driver. Shell execution fails closed when the sandbox is unavailable. Native Mac packaging, live services, desktop actions, model-dependent engines and CAD interactions are not represented as end-to-end verified here.
