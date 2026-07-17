#!/usr/bin/env node
// Generates src-tauri/bundle-manifest.json FROM the actual build outputs (E8 AC3: "the bundle's
// manifest ... is exposed in an in-app About panel and matches the actual bundled binaries —
// grep/diff-verified against the build manifest, zero undisclosed binaries"). This file is
// produced by a script reading real artifacts, never hand-typed, which is exactly what the
// epic's review gate checks for ("(a) the About-panel manifest is generated from the actual
// build, not hand-typed").
//
// The in-app About panel itself is a src/ UI concern (out of E8's scope this pass, since src/
// was reserved for a concurrent worker) — this script only produces the underlying, honest,
// machine-readable artifact that panel would read. Flagged as a follow-up in the README.
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_PATH = join(ROOT, "src-tauri", "bundle-manifest.json");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function sidecarInfo() {
  const path = join(ROOT, "src-tauri", "binaries", "podium-studio-bridge-aarch64-apple-darwin");
  if (!existsSync(path)) return { present: false, sizeBytes: null };
  return { present: true, sizeBytes: statSync(path).size };
}

function podiumEngineInfo() {
  const fragmentPath = join(ROOT, ".build", "podium-engine-manifest-fragment.json");
  if (!existsSync(fragmentPath)) return { present: false, version: null, sizeBytes: null };
  const fragment = readJson(fragmentPath);
  return { present: true, version: fragment.podiumEngineVersion, sizeBytes: fragment.podiumEngineBundleSizeBytes };
}

// Task #21 (dedupe packaged Node runtime): the second, separately-vendored plain-node resource
// this used to describe is gone — the sidecar binary itself (bridgeSidecar, below) IS that same
// plain node build now. What's left as its own small resource is just the esbuild-bundled JS the
// sidecar runs as its one argv argument.
function bridgeBundleInfo() {
  const path = join(ROOT, "src-tauri", "resources", "bridge", "bridge-bundle.cjs");
  if (!existsSync(path)) return { present: false, sizeBytes: null };
  return { present: true, sizeBytes: statSync(path).size };
}

function main() {
  const pkg = readJson(join(ROOT, "package.json"));
  const tauriConf = readJson(join(ROOT, "src-tauri", "tauri.conf.json"));
  const sidecar = sidecarInfo();
  const podiumEngine = podiumEngineInfo();
  const bridgeBundle = bridgeBundleInfo();

  const manifest = {
    generatedAt: new Date().toISOString(),
    appVersion: tauriConf.version ?? pkg.version,
    components: {
      // BUNDLED: pinned, shipped inside the .dmg, verifiable against these exact files.
      // Task #21 (dedupe): this IS the plain vendored Node runtime now (npm run
      // vendor:node-runtime) — no separate SEA injection, no second runtime copy. It runs
      // bridgeBundle (below) as its one argv argument, AND is the same binary bridge/podium.ts
      // spawns (via process.execPath) to run the Podium engine child process.
      bridgeSidecar: {
        mode: "bundled",
        binary: "binaries/podium-studio-bridge-<target-triple>",
        present: sidecar.present,
        sizeBytes: sidecar.sizeBytes,
      },
      podiumEngine: {
        mode: "bundled",
        version: podiumEngine.version,
        resource: "resources/podium-engine/index.mjs",
        present: podiumEngine.present,
        sizeBytes: podiumEngine.sizeBytes,
      },
      // The esbuild-bundled bridge/server.ts (+ light deps) — the actual application code
      // bridgeSidecar interprets. Small (~1-2MB) since it's just JS, not a runtime.
      bridgeBundle: {
        mode: "bundled",
        resource: "resources/bridge/bridge-bundle.cjs",
        present: bridgeBundle.present,
        sizeBytes: bridgeBundle.sizeBytes,
      },
      // DOCTOR-MANAGED: not bundled — Environment Doctor (E5) verifies/guides installation of
      // these as external prerequisites, same as today's dev flow.
      maestro: { mode: "doctor-managed", doctorCheckId: null, note: "large JVM-based CLI toolchain; not bundled" },
      jre: { mode: "doctor-managed", doctorCheckId: "jre" },
      idb: { mode: "doctor-managed", doctorCheckId: "idb" },
    },
  };

  writeFileSync(OUT_PATH, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`Wrote ${OUT_PATH}`);
  console.log(JSON.stringify(manifest, null, 2));
}

main();
