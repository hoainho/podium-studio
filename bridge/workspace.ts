import { homedir } from "node:os";
import { join } from "node:path";

/**
 * The single writable root that every bridge-side directory derives from
 * (flows, the SQLite data dir, run artifacts, browser runtime profiles).
 *
 * Why this exists: in dev the bridge runs from the repo checkout, so `process.cwd()` is the
 * project root and flows live in `./qa/flows` exactly as before. But the PACKAGED desktop app's
 * bridge sidecar is launched by macOS/Finder/launchd with `cwd = "/"` — which is read-only — so
 * anything built from `process.cwd()` becomes `/qa`, `/data`, … and the first `mkdir` throws
 * `ENOENT/EACCES: mkdir '/qa'`. The Tauri shell (src-tauri/src/lib.rs) therefore passes an
 * explicit writable per-user location via `PODIUM_STUDIO_WORKSPACE`; we prefer that, and only
 * fall back to a stable user dir if it is somehow absent AND cwd is the unwritable root.
 */
export function workspaceRoot(): string {
  const explicit = process.env.PODIUM_STUDIO_WORKSPACE?.trim();
  if (explicit) return explicit;
  const cwd = process.cwd();
  if (cwd === "/" || cwd === "") {
    // Mirror the Rust shell's app-data location so the fallback and the normal path agree.
    return join(homedir(), "Library", "Application Support", "Podium Studio");
  }
  return cwd;
}
