// Vendors the CloakBrowser JS package into the app bundle so the PACKAGED sidecar can run web
// tests (Pillar 1). The packaged bridge is `resources/bridge/bridge-bundle.cjs` run by a vendored
// node; `bridge/browser-driver.ts` does a runtime `import("cloakbrowser")`, which Node resolves
// from a `node_modules` next to the bundle. That dir isn't shipped by default, so a packaged web
// run fails with "No browser runtime found". This drops cloakbrowser (+ its runtime deps) into
// `src-tauri/resources/bridge/node_modules/` (already a bundled resource per tauri.conf.json).
//
// The ~355MB Chromium binary is NOT bundled — CloakBrowser stores it in a SHARED, per-user
// `~/.cloakbrowser` (downloaded once on first use), so only the ~1MB JS package ships in the .app.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEST = join(ROOT, "src-tauri", "resources", "bridge");
const SRC_PKG = join(ROOT, "node_modules", "cloakbrowser", "package.json");

if (!existsSync(SRC_PKG)) {
  console.warn("[vendor-browser-engine] cloakbrowser not in node_modules — run `npm install` first; skipping (web tests won't work in the packaged app).");
  process.exit(0);
}
const version = JSON.parse(readFileSync(SRC_PKG, "utf8")).version;

// Clean any stale vendored copy so we ship exactly the pinned version's dependency closure.
const vendoredModules = join(DEST, "node_modules");
if (existsSync(vendoredModules)) rmSync(vendoredModules, { recursive: true, force: true });
mkdirSync(DEST, { recursive: true });

// cloakbrowser declares these as PEER deps (not auto-installed into a bare prefix) but needs them
// at runtime — a fresh `npm install cloakbrowser` alone leaves the packaged sidecar throwing
// "Cannot find package 'playwright-core'". Install them alongside. All are JS-only drivers
// (playwright-core / puppeteer-core do NOT download browser binaries — only the shared
// ~/.cloakbrowser Chromium is used), so this stays a few MB, not hundreds.
const PEERS = ["playwright-core", "mmdb-lib", "puppeteer-core", "socks-proxy-agent"];
console.log(`[vendor-browser-engine] installing cloakbrowser@${version} + peers into resources/bridge/node_modules …`);
execFileSync(
  "npm",
  ["install", `cloakbrowser@${version}`, ...PEERS, "--prefix", DEST, "--omit=dev", "--no-audit", "--no-fund", "--save=false"],
  { stdio: "inherit", cwd: ROOT, env: { ...process.env, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1", PUPPETEER_SKIP_DOWNLOAD: "1" } },
);
console.log("[vendor-browser-engine] done — cloakbrowser JS vendored (Chromium stays the shared ~/.cloakbrowser).");
