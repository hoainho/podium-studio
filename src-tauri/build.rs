// Standard Tauri v2 build script — generates the OUT_DIR-dependent context
// `tauri::generate_context!()` needs (window/bundle config, embedded icons, etc.) from
// tauri.conf.json. Cargo.toml already declared `tauri-build` as a build-dependency, but this
// file didn't exist yet — `cargo check` failed with "OUT_DIR env var is not set, do you have a
// build script?" until it was added (found while wiring E8's sidecar).
fn main() {
    tauri_build::build()
}
