// Podium Studio — Tauri v2 app entrypoint (library form).
//
// Split into lib.rs (this file) + main.rs following Tauri v2's standard scaffold convention —
// `run()` lives here so it's reachable from both the desktop `main.rs` and (eventually) mobile
// targets, which don't use `main.rs`. This split ALSO fixes a pre-existing bug: Cargo.toml
// already declared a `[lib] name = "podium_studio_lib"` target, but no `src/lib.rs` existed —
// `cargo add`/`cargo build` failed outright with "can't find library `podium_studio_lib`" until
// this file was added (found while wiring E8's sidecar — see src-tauri/README.md).
//
// E8 (desktop packaging, honest bundle): `run()` spawns the bundled bridge sidecar before the
// window's frontend ever talks to it. This is what makes AC1 hold ("no external repo checked out
// on disk"): the dev flow's `npm run dev:bridge` assumed a `tsx`+repo checkout; the packaged app
// instead runs one self-contained bundled binary.
//
// Task #21 (dedupe packaged Node runtime, halve installer size): the sidecar used to be
// bridge/server.ts injected as a Node Single Executable Application (SEA) via `npm run
// sidecar:build`, PLUS a second, separately-vendored plain node binary bundled purely so
// bridge/podium.ts could spawn the Podium engine as a child process (a SEA blob can only ever run
// its own embedded script — it can't double as a generic interpreter). That shipped the same
// ~108MB Node runtime twice. Now the sidecar IS a plain vendored node binary
// (scripts/vendor-node-runtime.mjs), and it's told which script to run via `.args([...])`: the
// esbuild-bundled bridge/server.ts (scripts/build-bridge-sidecar.mjs -> resources/bridge/
// bridge-bundle.cjs). A plain node binary is a real interpreter, so bridge/podium.ts can spawn the
// Podium engine directly via `process.execPath` — no second copy, no SEA-detection machinery, no
// PODIUM_STUDIO_NODE_RUNTIME env var needed.

use tauri::Manager;
use tauri_plugin_shell::ShellExt;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            let handle = app.handle().clone();

            // The vendored Podium engine (scripts/vendor-podium-engine.mjs) ships as a bundled
            // resource, not an external repo checkout (E8 AC1). Point the sidecar at it via env
            // var — bridge/podium.ts's resolvePodiumEntry() already checks $PODIUM_ENTRY first,
            // so this requires zero changes to bridge/* to take effect.
            let podium_entry = app
                .path()
                .resolve("resources/podium-engine/index.mjs", tauri::path::BaseDirectory::Resource)
                .ok();

            // The esbuild-bundled bridge/server.ts (scripts/build-bridge-sidecar.mjs), run by the
            // sidecar binary (a plain vendored node — see the module comment above) as its one
            // argv argument.
            let bridge_bundle = app
                .path()
                .resolve("resources/bridge/bridge-bundle.cjs", tauri::path::BaseDirectory::Resource)
                .expect("resources/bridge/bridge-bundle.cjs not found — run `npm run sidecar:build` first");

            let mut sidecar_command = handle
                .shell()
                .sidecar("podium-studio-bridge")
                .expect("podium-studio-bridge sidecar not declared in tauri.conf.json's bundle.externalBin")
                .args([bridge_bundle.to_string_lossy().to_string()]);

            if let Some(entry) = &podium_entry {
                sidecar_command = sidecar_command.env("PODIUM_ENTRY", entry.to_string_lossy().to_string());
            }

            // Writable per-user workspace root for the bridge. macOS launches the packaged app with
            // `cwd = "/"` (read-only), so any bridge dir built from `process.cwd()` — qa/flows, the
            // SQLite data dir, run artifacts, browser runtime profiles — would resolve under `/` and
            // fail its first `mkdir` with `ENOENT: mkdir '/qa'`. Anchor them at the app-data dir
            // instead (bridge/workspace.ts reads PODIUM_STUDIO_WORKSPACE), and create it up front so
            // that first write succeeds. app_data_dir() never triggers a macOS TCC prompt.
            if let Ok(workspace) = app.path().app_data_dir() {
                let _ = std::fs::create_dir_all(&workspace);
                sidecar_command =
                    sidecar_command.env("PODIUM_STUDIO_WORKSPACE", workspace.to_string_lossy().to_string());
            }

            // C1 (E2E dogfood): the vendored native gesture backend. Without it the engine's
            // resolveMobilecli() finds nothing (the bundled engine has no node_modules) and every
            // action falls back to slow per-step Maestro (12–42s/flow). The engine checks
            // PODIUM_MOBILECLI first, so point it at the vendored binary. We COPY it into the
            // writable app-data dir with +x first: a resource inside the (possibly read-only,
            // exec-bit-stripped) .app bundle may not satisfy the engine's access(X_OK) check.
            if let (Ok(src), Ok(data_dir)) = (
                app.path()
                    .resolve("resources/podium-engine/bin/mobilecli", tauri::path::BaseDirectory::Resource),
                app.path().app_data_dir(),
            ) {
                if src.exists() {
                    let bin_dir = data_dir.join("bin");
                    let _ = std::fs::create_dir_all(&bin_dir);
                    let dest = bin_dir.join("mobilecli");
                    // Re-copy when absent, a different size, OR the bundled copy is newer than ours
                    // — an app update ships a fresh binary that may happen to be the same size, so
                    // size alone is insufficient; mtime catches the update.
                    let stale = match (std::fs::metadata(&src), std::fs::metadata(&dest)) {
                        (Ok(s), Ok(d)) => {
                            s.len() != d.len()
                                || match (s.modified(), d.modified()) {
                                    (Ok(sm), Ok(dm)) => sm > dm,
                                    _ => true,
                                }
                        }
                        _ => true,
                    };
                    if stale {
                        let _ = std::fs::copy(&src, &dest);
                    }
                    #[cfg(unix)]
                    {
                        use std::os::unix::fs::PermissionsExt;
                        let _ = std::fs::set_permissions(&dest, std::fs::Permissions::from_mode(0o755));
                    }
                    // Only advertise the backend if the binary is actually in place; a dangling
                    // PODIUM_MOBILECLI would just make the engine's access(X_OK) check fail (it then
                    // correctly falls back to Maestro), but pointing at a missing file is misleading.
                    if dest.exists() {
                        sidecar_command =
                            sidecar_command.env("PODIUM_MOBILECLI", dest.to_string_lossy().to_string());
                    }
                }
            }

            let (mut rx, _child) = sidecar_command.spawn().expect("failed to spawn the bridge sidecar");

            // Forward the sidecar's stdout/stderr into the app's own log output so a crashed or
            // misbehaving bridge is visible without opening a separate terminal — the desktop app
            // is meant to be usable by a non-technical QA (Pillar H), not someone who knows to go
            // hunting for a hidden child process's logs.
            tauri::async_runtime::spawn(async move {
                use tauri_plugin_shell::process::CommandEvent;
                while let Some(event) = rx.recv().await {
                    match event {
                        CommandEvent::Stdout(line) => {
                            print!("[bridge] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Stderr(line) => {
                            eprint!("[bridge] {}", String::from_utf8_lossy(&line));
                        }
                        CommandEvent::Error(err) => {
                            eprintln!("[bridge] sidecar error: {err}");
                        }
                        CommandEvent::Terminated(payload) => {
                            eprintln!("[bridge] sidecar exited: {:?}", payload.code);
                        }
                        _ => {}
                    }
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running Podium Studio");
}
