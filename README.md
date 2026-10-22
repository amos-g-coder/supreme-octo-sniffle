# Inflex

Inflex is a local engineering agent runtime built on TrueForge. The terminal, browser GUI, and native SwiftUI desktop app use the same session engine, tool permissions, approvals, and event history.

- **Goal modes:** Standard, Enhanced, and Advanced. Enhanced can assign unresolved subgoals to Cairn-derived explorers while other children use ordinary execution. Advanced uses a persistent fact/intent/hint board throughout the task.
- **Thinking:** Light, Balanced, Deep, Intensive, and Ultra. Ultra requires a bounded subagent contribution in every mode. Other levels delegate dynamically. Reasoning targets are advisory.
- **Execution:** workspace files, sandboxed shell commands, Git worktrees, development and tests, connected MCP tools, documents, images, audio, and video.
- **Memory:** local Hindsight with a durable retention outbox, personal/project banks, inspect/forget/backup/restore tools, and the same OAuth inference owner.
- **Media:** timestamped FFmpeg evidence, Framefields detection/tracking and editable compositions, captions, tracked labels, person masks, narration, and exports. Whisper.cpp and Piper provide local transcription and speech.
- **Inference:** local ChatGPT-plan OAuth sign-in. Credentials stay in macOS Keychain. Inflex does not copy another application's Codex token files.

The primary native target is Apple Silicon macOS 14+. Core runtime and FFmpeg tests also run on Linux. Native desktop, GPU export, desktop permissions, and live OAuth must be verified on the target device; see [validation](docs/inflex/validation.md).

## Run from source

Install Node 24+, pnpm 11, Git, ripgrep, FFmpeg, and the platform requirements of Anthropic Sandbox Runtime. On macOS, install Xcode command line tools for the Keychain helper.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm inflex:native:build
pnpm inflex:doctor
INFLEX_WORKSPACE="$PWD" pnpm inflex serve
```

Open `http://127.0.0.1:8790` or use a second terminal:

```sh
pnpm inflex login
pnpm inflex run --goal enhanced --thinking deep "Inspect this project and implement the requested change"
pnpm inflex run --goal standard --thinking ultra "Verify the implementation"
```

`--model chatgpt/<catalog-model>` selects an entitled model. `--session <id>` resumes a session with its saved settings. Approvals remain explicit in both clients. The desktop shell attaches to the local runtime or starts one; it uses the same session database.

## Native desktop and Mac verification

The macOS app renders native SwiftUI controls and MarkdownUI content, with AVKit/PDFKit previews. It uses the same runtime as Terminal. Build on Apple Silicon with full Xcode 16+, Swift 6 and Node 24+:

```sh
pnpm inflex:desktop:verify
```

This runs client and Xcode GUI tests, collects screenshots and launch/CPU/memory metrics, then builds the app and DMG. Reports go to `dist/desktop-validation/`; the app is `dist/desktop/Inflex.app`. Codex's remote-Mac handoff is [desktop/AGENTS.md](desktop/AGENTS.md). Visual parity and resource savings require measurements on the Mac; Linux checks do not establish them.

## Enable capabilities

```sh
pnpm inflex:media:install
pnpm inflex:capabilities:install
pnpm inflex:documents:install
```

Copy [the MCP connection example](docs/inflex/connections.example.json) to the path reported by diagnostics or set `INFLEX_CONNECTIONS_FILE`. Replace its executable paths. Browser-specific automation uses Playwright MCP; desktop automation uses the upstream open-computer-use implementation. CAD is exclusively a connected MCP capability. Existing HTTP MCP connections remain available through the server settings.

On macOS, local Hindsight starts on first memory access. On other platforms, set `INFLEX_MEMORY=managed` before serving. Set `INFLEX_MEMORY=off` to disable it. It requires `uv` and downloads its pinned Python runtime and local embedding/reranking models when first enabled. `INFLEX_MEMORY_MODEL` can select an entitled model; otherwise Inflex chooses a small model from the account catalog. No idle inference polling runs.

Install Tesseract and its language data for document-image OCR. Sharp image transforms are included in the media worker.

Local audio/image engines and model files are installed separately to avoid mandatory multi-gigabyte downloads. Configure `INFLEX_WHISPER_MODEL`, `INFLEX_PIPER_MODEL`, and `INFLEX_DIFFUSION_MODEL` or `INFLEX_IMAGE_ARGS`. [Setup and architecture](docs/inflex/runtime.md) covers engine commands, media workflows, native packaging, and diagnostics.

## Verify

```sh
pnpm inflex:test
pnpm inflex:media:test
pnpm inflex:media:smoke # requires WebGPU/Metal
pnpm --filter @truefoundry/trueforge typecheck
pnpm --filter frontend typecheck
```

The upstream library package names remain for source compatibility. Inflex's modifications are AGPL-3.0-only; original licenses and provenance are preserved under [third_party](third_party/README.md).
