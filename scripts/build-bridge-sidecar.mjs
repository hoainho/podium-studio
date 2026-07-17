#!/usr/bin/env node
// Bundles bridge/server.ts for the Tauri-packaged app (E8 — janus-specs/R2-desktop-android/
// E8-desktop-packaging.md). The packaged app must run a flow end-to-end with NO external Node
// install and NO external repo checked out on disk (AC1) — so the bridge itself has to become a
// genuine standalone artifact, not a script that assumes `node`/`tsx` is on the user's PATH.
//
// Approach (rewritten for task #21 — dedupe packaged Node runtime): esbuild-bundle bridge/
// server.ts (and its light deps — express/cors/ws/zod/the MCP SDK) into one CJS file and ship it
// as a plain bundled RESOURCE (src-tauri/resources/bridge/bridge-bundle.cjs). It is run by the
// vendored plain `node` binary (scripts/vendor-node-runtime.mjs) that Tauri declares as
// `bundle.externalBin` — i.e. `<vendored-node> bridge-bundle.cjs`, wired up in
// src-tauri/src/lib.rs's `.args([...])` on the sidecar command.
//
// Previously this script ALSO turned the bundle into a Node Single Executable Application (SEA)
// via `--experimental-sea-config` + `postject`, requiring a second, separately-vendored plain
// node binary just so bridge/podium.ts could spawn the Podium engine child process (the SEA blob
// can only ever run its own embedded script, so it couldn't double as a generic interpreter for
// that). That meant shipping the SAME ~108MB Node runtime TWICE. Since the vendored node binary
// is now the sidecar itself (a real interpreter, not a SEA), there is only ever one copy — see
// src-tauri/README.md's "packaged Node runtime, deduped" section for the measured before/after.
import { existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = join(ROOT, "src-tauri", "resources", "bridge");
const OUT_PATH = join(OUT_DIR, "bridge-bundle.cjs");

function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  console.log("Bundling bridge/server.ts (esbuild, CJS, node:* left external)...");
  execFileSync(join(ROOT, "node_modules", ".bin", "esbuild"), [
    join(ROOT, "bridge", "server.ts"),
    "--bundle",
    "--platform=node",
    "--format=cjs",
    `--outfile=${OUT_PATH}`,
    "--external:node:*",
  ], { stdio: "inherit" });

  if (!existsSync(OUT_PATH)) {
    console.error(`[build-bridge-sidecar] esbuild reported success but ${OUT_PATH} is missing.`);
    process.exitCode = 1;
    return;
  }
  console.log(`Bridge bundle written: ${OUT_PATH}`);
  console.log(
    "This is run by the vendored plain node binary (npm run vendor:node-runtime), which Tauri\n" +
      "spawns as the 'podium-studio-bridge' sidecar with this file's resource path as its one argv\n" +
      "argument — see src-tauri/src/lib.rs.",
  );
}

main();
