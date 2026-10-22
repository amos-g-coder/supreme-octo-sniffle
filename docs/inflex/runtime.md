# Inflex runtime

## Shared execution

TrueForge owns session persistence, event replay, streaming, tool mapping, approvals, cancellation, compaction, and child lifecycle. Inflex adds capabilities to that engine through its resolver. CLI and GUI use the same HTTP session/turn contracts; SwiftUI renders the native desktop GUI. There is no second agent dispatcher.

Native tools implement the existing ToolSource contract and are wrapped by ToolSet. Filesystem writes, terminal mutation, image/speech generation, rendering, publication, memory retention, and integration use its approval pipeline. Read-only children receive a narrower tool set. Unannotated connected tools require write approval through the same selector policy as native tools. Stdio MCP connections are lazy and reused within each agent across approval pauses. Connections default to parent-only. Set `delegation: "agent"` only for servers that support independent agent instances; the browser example also uses Playwright’s `--isolated` contexts. Desktop and CAD remain parent-controlled by default. Connections they close after two idle minutes or cancellation. Each shell command gets a private temporary directory that is removed afterwards; shared sandbox default write paths are denied using the existing TrueForge policy. Shell commands fail when a working sandbox is unavailable; there is no host-shell fallback. Commands have bounded captured output, cancellation, and a process-tree deadline. Command environments exclude the OAuth owner's environment.

The global inference queue has five slots, including Hindsight requests. Memory inference has lower queue priority. One local runtime owner protects credential rotation and managed service ownership. The account's real model catalog supplies model availability and supported reasoning efforts.

## Goal and thinking policy

| Goal mode        | Parent                                                             | Children                                                                             |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Standard / unset | Ordinary harness                                                   | Ordinary harness; no goal boards                                                     |
| Enhanced         | Ordinary harness                                                   | Ordinary workers plus scoped goal-board explorers for explicitly unresolved subgoals |
| Advanced         | Cairn-derived bootstrap/reason/explore protocol and evidence board | Same protocol, with a separate task board                                            |

| Thinking  | Concurrent child target | Delegation | Requested provider effort, if supported |
| --------- | ----------------------- | ---------- | --------------------------------------- |
| Light     | 1                       | Dynamic    | low                                     |
| Balanced  | 2                       | Dynamic    | medium                                  |
| Deep      | 3                       | Dynamic    | high                                    |
| Intensive | 4                       | Dynamic    | xhigh                                   |
| Ultra     | 4                       | Required   | xhigh                                   |

Ultra takes precedence over dynamic delegation in Standard. A final response without a contribution causes the runtime to schedule a narrow independent verification task. It does not duplicate the full assignment. Advanced agents must complete their board with acceptance evidence or explicitly pause it before finishing.

Every child requires an objective, owned paths, acceptance criteria, and read-only flag. Enhanced goal explorers additionally state what lacks a clear solution. Children inherit the selected model, base instructions, and permission ceiling. They receive their charter rather than the parent's conversation and return distilled findings. Children cannot recursively spawn more children.

Writing children use detached Git worktrees based on a private snapshot of tracked and non-ignored dirty files. The user's index and worktree are not stashed or reset. Overlapping charters are rejected. Parent integration checks the patch against current parent changes and preserves conflicting worktrees. Changes outside the charter cannot be integrated. For non-Git design work or an unborn repository, children use explicitly disjoint paths in the assigned workspace; filesystem and shell writes remain bounded to the charter. No agent file-lock system or worker claim leases are used.

Soft reasoning targets reduce speculative fanout and encourage integration; passing a target does not ask for more tokens or stop execution. Normal harness cancellation, explicit tool deadlines, context capacity and provider limits still apply.

## Authentication and memory

The OAuth implementation follows the public dynamic local-agent registration flow, using PKCE, state, nonce, an issued client identity, verified ID tokens, and the explicit ChatGPT-plan scope. The inference route is the public Responses API with `store:false` and streaming. Encrypted reasoning items are preserved for replay. Unsupported sampling/output-limit overrides are omitted. A truncated or failed stream cannot supply executable tool calls.

Build the native Keychain helper with `pnpm inflex:native:build`. It accepts requests on stdin and writes secrets only to its owning runtime. Credential paths and that executable are outside the untrusted shell's readable surface. The owner caches its Keychain grant in memory and serializes refresh rotation, avoiding a helper subprocess on every inference call.

macOS defaults to managed memory; other hosts enable it with `INFLEX_MEMORY=managed`. `INFLEX_MEMORY=off` disables managed startup. The managed profile lazily starts `hindsight-embed==1.1.0` through `@vectorize-io/hindsight-all@1.1.0`. Hindsight's Postgres/pg0 database is separate from session SQLite. Its loopback Responses proxy shares the account owner and inference queue; Hindsight never receives the owner's OAuth grant. Optional `INFLEX_HINDSIGHT_URL` connects an already configured service.

Recall occurs when the overarching agent starts work, and curated durable preferences or verified milestones are retained through the memory tool. Recall results are reference data, not privileged instructions. Retention is stored in a local outbox before delivery. Repeated delivery uses a stable Hindsight document ID. Failures preserve the outbox and do not silently report retained memory. The parent can inspect source documents, forget a document and its derived memories, or start an export/restore through native memory tools. Backups use Hindsight’s own transfer ZIP format; imports merge with duplicate document IDs skipped and report an operation ID. Download only completed operations. External Hindsight services must enable their document import/export APIs for backup controls. No full transcript capture or periodic autonomous model polling is added. Legacy scheduling/environment controller loops stay disabled unless `INFLEX_ENABLE_SCHEDULES=true` is explicitly set.

## Media workflow

1. Place footage in the workspace, then ask Inflex to analyze it. `video_analyze` records its hash, stream metadata, original presentation timestamps, rotation and sampled frames. Coverage is explicit. Optional detection/tracking runs Framefields only when requested.
2. The selected model can inspect sampled frames with `inspect_image`, correlate them with `audio_analyze` transcripts, and answer questions about scenes, actions, text, chronology and object locations. Sparse sampling cannot prove the absence of short events.
3. `video_project` writes an editable versioned JSON composition. It validates the source hash, time ranges and increasing motion keyframes. Positions are normalized display-oriented source coordinates; the renderer maps them through a centered cover crop. Convert a source PTS to an edit time with `source_pts - source_start_pts - trim_start`.
4. Captions, narration, tracked labels and optional person-matte compositing are lowered to Framefields Composition and Layer operations. Keyframes keep observed/interpolated/VLM-estimated provenance. Track positions across gaps are estimates. No calibrated 3D geometry is inferred.
5. `video_render` creates an MP4 and publishes it to the Media panel. Playable exports provide a GUI preview without requiring browser WebGPU. JSON compositions and source evidence remain available for review and subsequent edits.

Analysis caches use source identity and parameters; stable source hashes are memoized in a bounded in-process cache. Sources changed during analysis or before export require reanalysis. Media dependencies and ONNX models remain outside the ordinary startup path. Auxiliary workers exit after a job. Published files use copy-on-write filesystem copies where supported.

`audio_analyze` preserves source channel metadata, measures level/energy/silence/clipping and produces a spectrum image through FFmpeg. It creates a mono analysis copy for timestamped whisper.cpp transcription. `speak` invokes Piper to produce a WAV for dictation output or narration. Preserve the original audio for mastering. Voice models and input recordings are user supplied.

## Configuration

| Variable                                                                 | Purpose                                                                            |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `INFLEX_WORKSPACE`                                                       | Allowed workspace root; defaults to current directory in Terminal                  |
| `INFLEX_DATA_DIR`                                                        | Session/runtime state and artifacts; defaults to the OS application data directory |
| `INFLEX_CONNECTIONS_FILE`                                                | Trusted local stdio MCP configuration                                              |
| `INFLEX_KEYCHAIN_HELPER`                                                 | Built native Keychain helper                                                       |
| `INFLEX_MEDIA_WORKER`                                                    | Framefields worker entry                                                           |
| `INFLEX_FFMPEG`, `INFLEX_FFPROBE`                                        | FFmpeg executables                                                                 |
| `INFLEX_WHISPER`, `INFLEX_WHISPER_MODEL`                                 | whisper.cpp executable and GGML/GGUF model                                         |
| `INFLEX_PIPER`, `INFLEX_PIPER_MODEL`                                     | Piper executable and ONNX voice model                                              |
| `INFLEX_DIFFUSION`, `INFLEX_DIFFUSION_MODEL`                             | stable-diffusion.cpp executable and monolithic model                               |
| `INFLEX_IMAGE_ARGS`                                                      | JSON argv array for split image models, such as diffusion/LLM/VAE files            |
| `INFLEX_MEMORY`                                                          | Set to `managed` to enable lazy local Hindsight                                    |
| `INFLEX_MEMORY_MODEL`                                                    | Optional entitled catalog model for memory                                         |
| `INFLEX_HINDSIGHT_URL`, `INFLEX_HINDSIGHT_PORT`, `INFLEX_HINDSIGHT_BANK` | Existing service, managed port, and personal bank                                  |

`pnpm inflex:documents:install` installs pinned MarkItDown PDF/Office extraction through uv. Install Tesseract for `document_ocr`, or configure `INFLEX_TESSERACT`. `image_process` uses Sharp for oriented crops, rotation, resizing and PNG/JPEG/WebP conversion, and publishes its output for preview. Install the desired whisper.cpp, Piper and stable-diffusion.cpp releases and configure their model files. Models are not downloaded implicitly by opening Inflex. Framefields may download its verified vision model when detection or masking is explicitly invoked.

## Desktop packaging

On Apple Silicon macOS 14+, install Xcode 16+ with Swift 6, then run `pnpm inflex:desktop:prepare` and `pnpm inflex:desktop:build`. Packaging includes the Node executable, deployed server/frontend, native helper, and the separately installed media runtime. Signing/notarization credentials are deployment-specific and are not stored in this repository. The native release gate must pass before distributing a build.

The SwiftUI app attaches to port 8790 or starts the runtime there, then uses the existing HTTP/SSE APIs. Native views render the chat, settings, agent configuration, approvals and media; no desktop webview or Rust toolchain is required. MarkdownUI supplies GitHub-style Markdown; AVKit and PDFKit supply media/document previews. A runtime it starts is stopped on exit; a separately started Terminal runtime remains running. The desktop default workspace is the user's home directory, with credential locations excluded; use the workspace setting or `INFLEX_WORKSPACE` to narrow it to a project.

`pnpm inflex:desktop:verify` runs the Mac preflight, schema-checked client tests, Xcode UI tests with screenshots and metrics, media dependency installation, and release packaging. The report and logs are under `dist/desktop-validation/`; Xcode result bundles are `dist/desktop-ui-*.xcresult`. The fixture needs no live OAuth account. [The desktop handoff](../../desktop/AGENTS.md) gives Codex the exact follow-up checks on the remote Mac, including appearance comparisons and runtime shutdown ownership. Packaging ad-hoc signs locally; distribution signing and notarization remain a release step.

Swift client state uses stable message identities, deduplicated SSE replay and per-turn cursors. Text deltas are coalesced at about 30 updates per second only while events arrive. The bounded network event buffer fails explicitly on overflow instead of silently dropping transcript events. There is no GUI idle polling. Recent sessions/history paginate; messages and artifact views are lazy, and preview files/players are released when dismissed. These are architectural changes intended to reduce overhead; actual GUI launch, CPU and memory improvements remain unmeasured until compared with the previous app on the same Mac.
