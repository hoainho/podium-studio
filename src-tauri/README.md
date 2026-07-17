# Podium Studio desktop wrapper — E8 packaging (real, built, measured)

Status update from **E8 — Tauri desktop packaging (honest bundle)**
(`janus-specs/R2-desktop-android/E8-desktop-packaging.md`), since updated by **task #21 (dedupe
packaged Node runtime, halve installer size)**. Everything below was **actually built and run** on
this machine (Xcode 16.4 CLT, Rust 1.96.0 via Homebrew, Tauri CLI 2.11.4) — `npx tauri build`
produced a real `.app` and `.dmg`, and the packaged binary was launched directly to observe real
runtime behavior. Sizes and behaviors below are **measured**, not estimated, except where
explicitly marked otherwise.

## How to build it

```sh
npm install                 # pulls in @tauri-apps/cli, esbuild (no more postject — task #21 dropped the SEA build)
npm run tauri:build         # sidecar:build -> vendor:podium -> vendor:node-runtime -> manifest:generate -> tauri build
```

Produces:
- `src-tauri/target/release/bundle/macos/Podium Studio.app`
- `src-tauri/target/release/bundle/dmg/Podium Studio_0.1.0_aarch64.dmg`

`npm run tauri:dev` runs the same three prep steps then `tauri dev` (frontend hot-reload via
Vite; the sidecar is a real spawned process even in dev mode, not the old
`npm run dev:bridge`/`tsx watch` path — that path still exists for pure-web development,
untouched).

## What's bundled vs. what Environment Doctor (E5) still manages

`npm run manifest:generate` writes `src-tauri/bundle-manifest.json` **from the actual build
inputs** (not hand-typed) — see `scripts/generate-bundle-manifest.mjs`. Today it declares:

| Component | Mode | Why |
|---|---|---|
| Bridge sidecar | **Bundled** — a plain vendored `node` binary, `src-tauri/binaries/podium-studio-bridge-<target-triple>` | Task #21 (dedupe): this used to be `bridge/server.ts` injected as a Node Single Executable Application (SEA). It's now just the vendored plain node runtime itself (`npm run vendor:node-runtime`) — the SAME binary that also spawns the Podium engine child process, so there is exactly one Node runtime copy in the whole bundle, not two. |
| Bridge bundle | **Bundled** — esbuild output, `src-tauri/resources/bridge/bridge-bundle.cjs` | `bridge/server.ts` + its light deps, bundled to plain CJS (`npm run sidecar:build`). This is what the sidecar binary above runs as its one argv argument — just JS, not a runtime, so it's small (~2MB). |
| Podium engine | **Bundled** — esbuild-tree-shaken into `src-tauri/resources/podium-engine/index.mjs` | The real Podium engine repo (`~/Documents/personal/podium`) carries **~500MB** of `node_modules`; esbuild trims that to **~1.2MB** by bundling only what's actually imported. Pinned version is read from the source repo's own `package.json` (`v0.5.0` at time of writing) and recorded in the manifest — grep/diff-verifiable, not asserted. |
| Maestro | Doctor-managed (unchanged from E5) | A JVM-based CLI toolchain; not realistically bundleable into a small installer. |
| JRE | Doctor-managed (E5 `jre` check, unchanged) | Same reasoning. |
| idb | Doctor-managed (E5 `idb` check, unchanged) | Same reasoning. |

The in-app **About panel** that would *display* this manifest is a `src/` UI concern and is
**out of scope for this pass** (E6/whoever owns `src/` next builds it) — this README + the
generated `bundle-manifest.json` are the honest, machine-verifiable artifact that panel would
read from. AC3's "grep/diff-verified against the build manifest" is satisfiable today by running
`npm run manifest:generate` and diffing against the actual files in `src-tauri/binaries/` /
`src-tauri/resources/` — there's just no UI surfacing it yet.

## Installer size — measured, not estimated (E8 AC4, re-measured after task #21's dedupe)

The plan's own framing ("the '<10MB' figure was the Tauri shell only") is **confirmed literally
true** by this build:

| Artifact | Size | What's in it |
|---|---|---|
| Tauri shell binary alone (`Contents/MacOS/podium-studio`) | **10 MB** | Just the Rust/Tauri/WKWebView host — this is exactly the historical "<10MB" figure, and it's real. |
| Bridge sidecar (`Contents/MacOS/podium-studio-bridge`) | **108 MB** | The plain vendored `node` binary — task #21's dedupe: no SEA injection, just the runtime itself. |
| Bridge bundle resource | **2.1 MB** | The esbuild-bundled `bridge/server.ts`, run by the sidecar above as its one argv argument. |
| Vendored Podium engine resource | **1.2 MB** | See above. |
| Frontend (`dist/`) | **0.40 MB** | React build output. |
| **Full `.app` bundle (uncompressed, on disk)** | **121 MB** | Shell + sidecar + both small resources + frontend, measured via `du -sh` on the real rebuilt `.app`. |
| **`.dmg` installer (compressed)** | **40 MB** | Measured via `du -h` on the real `.dmg` `tauri build` produced. |

**Before/after task #21 (real measurements, not estimates):**

| | Pre-dedupe (E8-fix) | Post-dedupe (task #21) | Saved |
|---|---|---|---|
| `.dmg` | 80 MB | **40 MB** | 40 MB (**exactly halved**) |
| `.app` (uncompressed) | 228 MB | **121 MB** | 107 MB |

The saving is almost exactly one Node runtime copy (~108MB), as predicted when this dedupe was
originally flagged as a follow-up in E8-fix's write-up: the sidecar's SEA-embedded runtime and the
separately-vendored plain runtime were the same underlying binary shipped twice. Shipping the
plain vendored node binary itself AS the sidecar — with the bridge as a small script argument
instead of an injected SEA blob — removes the duplication entirely with no functional loss (see
the relaunch verification below).

## What's genuinely verified vs. what still needs a build machine

**Verified on this machine, for real:**
- `cargo check` and a full `cargo build --release` compile cleanly.
- `npx tauri build` produces a real, openable `.app` and a real `.dmg`.
- The vendored-node sidecar, launched directly with the bridge bundle as its plain argv script
  (`BRIDGE_PORT=<port> ./podium-studio-bridge-... ./bridge-bundle.cjs`), boots its HTTP server,
  opens the E9 SQLite stores, and connects to the Podium engine — no `node`/`tsx` on PATH
  required, and no separate runtime copy needed.
- Launching the actual packaged Tauri binary (`Contents/MacOS/podium-studio`) spawns the sidecar
  via `tauri-plugin-shell` with the bridge bundle resource path as its arg, and the Rust-side
  stdout/stderr forwarding (see `src/lib.rs`) prints the sidecar's own logs — confirmed by
  observing `[bridge] ...` lines from a real relaunch (below).
- `scripts/build-bridge-sidecar.mjs`, `scripts/vendor-podium-engine.mjs`,
  `scripts/vendor-node-runtime.mjs`, and `scripts/generate-bundle-manifest.mjs` were each run
  standalone and inside the full `tauri:build` pipeline; all four succeed and produce the
  artifacts described above.
- **Task #21's dedupe is verified end-to-end**, including a real API call through the whole
  rebuilt stack, with no regression versus the old SEA-based packaging.

### Task #21: deduped the packaged Node runtime (supersedes E8-fix's two-copy fix)

E8's first packaged build hit a real gap: `bridge/podium.ts`'s `connect()` spawns the Podium MCP
engine as a child process via `command: process.execPath`. In dev use, `process.execPath` is the
system's plain `node`. **Inside the original SEA-packaged sidecar, `process.execPath` was the
sidecar's own single-file executable** — a SEA can only ever run its own embedded script — so that
spawn call re-invoked the sidecar itself instead of the vendored Podium engine
(`EADDRINUSE`/self-respawn, documented in earlier revisions of this file). The original fix
(E8-fix) closed the gap by bundling a SECOND, separately-vendored plain node binary purely so
`bridge/podium.ts` had a real interpreter to spawn the engine with — at the cost of shipping the
same ~108MB Node runtime twice.

**Task #21 removes the duplication instead of paying for it.** The sidecar itself is no longer a
SEA — it's the plain vendored node binary (`scripts/vendor-node-runtime.mjs`), named per Tauri's
`externalBin` convention (`podium-studio-bridge-<target-triple>`) so it's spawned exactly as
before, just running a small esbuild-bundled JS resource
(`scripts/build-bridge-sidecar.mjs` -> `resources/bridge/bridge-bundle.cjs`) as its one argv
argument (wired in `src-tauri/src/lib.rs` via `.args([...])`) instead of having that code injected
into it as a SEA blob. Since the sidecar is now a genuine interpreter, `bridge/podium.ts`'s
`resolvePodiumNodeCommand()` collapses to unconditionally `return process.execPath;` — no
`node:sea` detection, no `PODIUM_STUDIO_NODE_RUNTIME` env var, no second binary.

**Verified end-to-end after the dedupe**, by rebuilding the full `.app`/`.dmg` and relaunching the
actual packaged binary (not `cargo check` — the real thing):
```
[bridge] [podium-studio] bridge listening on http://localhost:8787
[bridge] [podium-studio] SQLite stores ready (schema v3)
[bridge] [podium-studio] connected to Podium engine
```
No `EADDRINUSE`, no self-respawn. And, with the packaged app still running, a plain HTTP request
to its real `/api/health` endpoint returned the actual Podium engine's own response (not a stub):
```json
{"ok":true,"podium":{"name":"podium-mcp","version":"0.5.0","toolCount":60,
 "platforms":["ios-sim","ios-real","android"],
 "toolchain":{"xcrun":true,"maestro":true,"adb":false,"idb":true,"mobilecli":false},
 "gestureBackend":"maestro (fallback)"}}
```
AC1's "runs one flow end-to-end" remains genuinely unblocked at the bridge/engine layer, now at
roughly half the installer size — the remaining unverified piece is still a real end-to-end flow
author+run through the UI, which is `src/` territory outside this pass's scope.

**Two pre-existing scaffold bugs found and fixed while wiring this** (both blocked `cargo
build` outright, independent of anything sidecar-related):
1. `Cargo.toml` declared a `[lib] name = "podium_studio_lib"` target with no `src/lib.rs` —
   `cargo add`/`cargo build` failed with *"can't find library `podium_studio_lib`"*. Fixed by
   adding `src/lib.rs` following Tauri v2's standard lib/main split (also required so mobile
   targets, which skip `main.rs` entirely, would work later).
2. `Cargo.toml` declared `tauri-build` as a build-dependency but no `build.rs` existed —
   `tauri::generate_context!()` failed with *"OUT_DIR env var is not set, do you have a build
   script?"*. Fixed by adding the standard `build.rs`.
3. (Not a bug, but blocking): `bundle.icon` was `[]` — `generate_context!()` panics without at
   least one real icon file. Generated a full icon set via `npx tauri icon` from a **placeholder**
   solid-color source image (`src-tauri/icons/*`) — this is explicitly a placeholder, not a
   designed app icon; swap it via `npx tauri icon <real-source.png>` when real branding exists.

**Genuinely NOT exercised here (needs real hardware / longer session, per the epic's own
"Rust/Tauri build may be unavailable" framing — this turned out to be available, but these
specific ACs still need more than a build):**
- AC1's full "author a flow AND run it end-to-end" — the bridge/engine layer is now verified
  connected and functional (see the fix write-up above: a real `/api/health` call through the
  packaged app returned the real Podium engine's response). What's NOT exercised here is driving
  an actual mobile-automation flow (tap/type/assert against a real simulator) through the fully
  packaged app, and there's no `src/` UI entry point yet to author/trigger that from inside the
  app shell — that UI is out of this pass's scope.
- AC2 (persistence across relaunch) — plausible given E9's SQLite store already opens correctly
  inside the packaged sidecar, but not run twice back-to-back here.
- AC5–AC9 (responsive/motion/a11y/contrast/crash-telemetry) — these are `src/` UI concerns,
  explicitly out of this pass's scope (`src-tauri/`, `package.json`, and a config test only).

## Sidecar build mechanics (for whoever touches this next)

Since task #21, there is **no SEA (Single Executable Application) build anymore** — that
mechanism (and its `postject`/blob-injection requirements, previously documented in this section)
is gone entirely. The sidecar is just a plain vendored Node binary
(`scripts/vendor-node-runtime.mjs`) running a small esbuild-bundled JS file
(`scripts/build-bridge-sidecar.mjs` -> `resources/bridge/bridge-bundle.cjs`) as its one argv
argument — the same "any real interpreter works" story as running `node some-script.js` normally.

The one thing that still matters when picking WHICH `node` to vendor: it must be a
**self-contained (statically-linked)** build with no external shared-library dependency, since
this binary is redistributed inside the `.app` and launched on a user's machine that may not have
Homebrew (or the matching `libnode.*.dylib`) installed. Homebrew's `node` on macOS is a
shared-library build (~70KB executable, dynamically linked against `libnode.*.dylib`) and is NOT
safe to vendor this way for that reason — not because of any SEA-specific incompatibility anymore.
An official nodejs.org static build (confirmed via `nvm install`, ~108MB executable, no `libnode`
dependency) is what's vendored. `scripts/vendor-node-runtime.mjs` detects this by executable size
and searches `~/.nvm/versions/node/` automatically; set `SEA_BASE_NODE=/path/to/node` to point at
one explicitly (e.g. on a CI box without nvm) — the env var name is kept for continuity with the
old script, even though nothing SEA-related happens with it anymore.

## Prior content (kept for history — now superseded by the above)

<details>
<summary>Original "Phase 2, not built" note</summary>

This directory used to be configuration only, not built, run, or wired into this repo's dev/build
flow. The Node engine-bridge wasn't wired as a Tauri sidecar; `tauri.conf.json` had never been
validated against an installed Tauri CLI. Both are now done — see above.

</details>
