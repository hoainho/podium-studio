// Podium Studio — desktop entrypoint. Kept minimal: all real setup lives in lib.rs's `run()`
// (standard Tauri v2 split — lib.rs is also what a future mobile target would call directly,
// since mobile builds don't go through main.rs at all).

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    podium_studio_lib::run();
}
