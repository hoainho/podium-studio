#!/usr/bin/env node
// Vendors a plain Node runtime binary AS the Tauri sidecar itself (task #21 — dedupe packaged
// Node runtime, halve installer size). Rewritten from the E8-fix version of this script, which
// vendored a SECOND copy of node purely so the SEA-packaged sidecar (bridge/server.ts injected as
// a Node Single Executable Application) had a real interpreter to spawn the Podium engine child
// process with — a SEA blob can only ever run its own embedded script, so it couldn't double as
// a generic `node <script>` interpreter for that.
//
// The dedupe: stop SEA-injecting the bridge entirely. Ship this plain vendored node binary AS the
// `podium-studio-bridge` sidecar (Tauri's `bundle.externalBin`, named
// `podium-studio-bridge-<target-triple>` per its naming convention) and run the esbuild-bundled
// bridge/server.ts (scripts/build-bridge-sidecar.mjs -> resources/bridge/bridge-bundle.cjs) as
// its one argv argument: `<this-binary> bridge-bundle.cjs`. A plain node binary IS a generic
// interpreter, so it can ALSO spawn the Podium engine child process directly via
// `process.execPath` (see bridge/podium.ts) — no second copy, no SEA-detection machinery needed.
//
// Still prefers a self-contained (statically-linked) official nodejs.org build over e.g.
// Homebrew's shared-library build: this binary ships inside the .app and gets launched on a
// user's machine that may not have Homebrew (or the matching `libnode.*.dylib`) installed at all
// — a build with no external shared-library dependency is the only one safe to redistribute this
// way, independent of the SEA-specific reasoning that used to apply here.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { currentTargetTriple } from "./lib/target-triple.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = join(ROOT, "src-tauri", "binaries");

function looksLikeStaticBuild(nodePath) {
  try {
    return statSync(nodePath).size > 40 * 1024 * 1024;
  } catch {
    return false;
  }
}

function findNode() {
  if (process.env.SEA_BASE_NODE && looksLikeStaticBuild(process.env.SEA_BASE_NODE)) return process.env.SEA_BASE_NODE;
  if (looksLikeStaticBuild(process.execPath)) return process.execPath;
  const nvmDir = join(os.homedir(), ".nvm", "versions", "node");
  if (existsSync(nvmDir)) {
    for (const v of readdirSync(nvmDir).sort().reverse()) {
      const candidate = join(nvmDir, v, "bin", "node");
      if (looksLikeStaticBuild(candidate)) return candidate;
    }
  }
  return null;
}

function main() {
  const node = findNode();
  if (!node) {
    console.error(
      "\n[vendor-node-runtime] No self-contained Node build found to vendor as the packaged\n" +
        "sidecar. Install one (e.g. `nvm install 22`) and re-run, or set SEA_BASE_NODE=/path/to/node.\n",
    );
    process.exitCode = 1;
    return;
  }
  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, `podium-studio-bridge-${currentTargetTriple()}`);
  copyFileSync(node, outPath);
  chmodSync(outPath, 0o755);
  const sizeMb = (statSync(outPath).size / 1024 / 1024).toFixed(1);
  console.log(`Vendored Node runtime from ${node} -> ${outPath} (${sizeMb} MB)`);
  console.log(
    "This is the ONLY copy of the Node runtime in the bundle now (task #21 dedupe) — it is both\n" +
      "the 'podium-studio-bridge' sidecar Tauri spawns (running resources/bridge/bridge-bundle.cjs)\n" +
      "AND the interpreter bridge/podium.ts uses (via process.execPath) to spawn the Podium engine\n" +
      "child process. See src-tauri/README.md's packaged-Node-runtime section for the measured size.",
  );
}

main();
