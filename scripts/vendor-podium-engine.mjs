#!/usr/bin/env node
// Vendors a PINNED copy of the Podium engine into the app bundle (E8 AC1/AC3). Bundling this one
// component — rather than declaring it "doctor-managed" like Maestro/JRE/idb — is what actually
// removes the "external repo checked out on disk" dependency AC1 requires: the current dev flow
// (bridge/podium.ts's resolvePodiumEntry()) expects a locally git-cloned Podium checkout at a
// fixed path, which is exactly the opposite of AC1's bar.
//
// The real Podium engine repo carries ~500MB of node_modules (confirmed on this machine) — far
// too much to ship verbatim. esbuild can tree-shake it down to what's actually imported; this
// script does that and drops the result into src-tauri/resources/podium-engine/, which
// tauri.conf.json declares as a bundled resource.
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = join(ROOT, "src-tauri", "resources", "podium-engine");
const OUT_FILE = join(OUT_DIR, "index.mjs");
const MANIFEST_FRAGMENT_PATH = join(ROOT, ".build", "podium-engine-manifest-fragment.json");

// Mirrors bridge/podium.ts's resolvePodiumEntry() candidate order exactly, so vendoring pins
// whichever engine the dev bridge would actually talk to today.
function resolvePodiumEntry() {
  if (process.env.PODIUM_ENTRY && existsSync(process.env.PODIUM_ENTRY)) return process.env.PODIUM_ENTRY;
  const candidates = [
    join(homedir(), "Documents/personal/podium/dist/index.js"),
  ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

function podiumVersion(entryPath) {
  // dist/index.js lives at <repo>/dist/index.js; the repo's package.json is two levels up.
  const pkgPath = join(dirname(entryPath), "..", "package.json");
  try {
    return JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// C1 (E2E dogfood): esbuild can't inline a native binary, and the engine's resolveMobilecli()
// can't `require.resolve("mobilecli")` from the bundled context — so the packaged app had NO
// native gesture backend and every action fell back to slow per-step Maestro (12–42s/flow).
// Vendor the BUILD-HOST platform's mobilecli binary next to the engine; src-tauri/src/lib.rs then
// points the engine at it via PODIUM_MOBILECLI. Best-effort: a missing binary only means the
// packaged app keeps degrading to Maestro (no crash), so warn rather than fail the build.
function vendorMobilecli(entry) {
  const repoRoot = join(dirname(entry), "..");
  const plat =
    process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : process.platform === "win32" ? "windows" : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : null;
  if (!plat || !arch) {
    console.warn(`[vendor-podium-engine] mobilecli: unsupported build host ${process.platform}/${process.arch} — skipping native backend`);
    return;
  }
  const binName = `mobilecli-${plat}-${arch}${plat === "windows" ? ".exe" : ""}`;
  const src = join(repoRoot, "node_modules", "mobilecli", "bin", binName);
  if (!existsSync(src)) {
    console.warn(
      `[vendor-podium-engine] mobilecli binary not found at ${src} — the packaged app will fall ` +
        `back to the slow Maestro gesture path. \`npm install\` in the Podium engine repo to fix.`,
    );
    return;
  }
  const binDir = join(OUT_DIR, "bin");
  mkdirSync(binDir, { recursive: true });
  const dest = join(binDir, `mobilecli${plat === "windows" ? ".exe" : ""}`);
  copyFileSync(src, dest);
  chmodSync(dest, 0o755);
  console.log(`[vendor-podium-engine] mobilecli: ${binName} -> ${dest} (${(statSync(dest).size / 1024 / 1024).toFixed(1)} MB)`);
}

function main() {
  const entry = resolvePodiumEntry();
  if (!entry) {
    console.error(
      "\n[vendor-podium-engine] No Podium engine checkout found (checked $PODIUM_ENTRY, " +
        "~/Documents/personal/podium/dist/index.js).\n" +
        "Set PODIUM_ENTRY to a built dist/index.js and re-run.\n",
    );
    process.exitCode = 1;
    return;
  }

  const version = podiumVersion(entry);
  console.log(`[1/2] Bundling Podium engine v${version} from ${entry} ...`);
  mkdirSync(OUT_DIR, { recursive: true });
  execFileSync(
    join(ROOT, "node_modules", ".bin", "esbuild"),
    [entry, "--bundle", "--platform=node", "--format=esm", `--outfile=${OUT_FILE}`, "--external:node:*"],
    { stdio: "inherit" },
  );

  const sizeMb = (statSync(OUT_FILE).size / 1024 / 1024).toFixed(2);
  console.log(`[2/2] Vendored to ${OUT_FILE} (${sizeMb} MB, down from the source repo's ~500MB node_modules)`);

  mkdirSync(dirname(MANIFEST_FRAGMENT_PATH), { recursive: true });
  writeFileSync(
    MANIFEST_FRAGMENT_PATH,
    JSON.stringify({ podiumEngineVersion: version, podiumEngineBundleSizeBytes: statSync(OUT_FILE).size }, null, 2),
  );

  vendorMobilecli(entry);

  console.log(
    "\nbridge/podium.ts spawns this vendored engine via process.execPath — inside the packaged " +
      "app that's the same plain vendored node binary that IS the sidecar (npm run " +
      "vendor:node-runtime; task #21 deduped this to one copy) — see src-tauri/README.md.",
  );
}

main();
