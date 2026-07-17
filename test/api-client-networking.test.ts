import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Task #45 regression guard — packaged-app UI→bridge networking.
 *
 * src/api.ts used to call `fetch("/api/...")` (origin-relative) and build its WebSocket URL from
 * `location.host`. That only resolves correctly behind Vite's dev proxy (vite.config.ts forwards
 * /api and /ws to :8787) — true for plain browser dev and `tauri dev` (same Vite devUrl), but NOT
 * in the packaged app: there the frontend loads from Tauri's own asset origin (no dev server, no
 * proxy), so the relative fetch never reached the bridge ("Not connected" everywhere), and
 * `location.host` under that origin produced a malformed WS URL — confirmed as the exact WKWebView
 * DOMException ("The string did not match the expected pattern") seen in the real packaged build's
 * Simulators/Flows/Flakiness panels.
 *
 * This repo doesn't unit-test src/ (no jsdom/frontend test harness — see every other test/* file,
 * all bridge/backend-focused); the real fix was verified by an actual `tauri build` + relaunch
 * (see the task #45 completion report) where the WKWebView's network process showed real
 * established TCP connections to the bridge on :8787. This test is a lightweight static guard —
 * grep the real source, same "inspect the actual shape" style as test/tauri-config.test.ts — so a
 * future revert of the fix is caught by `npm test` without needing a frontend test harness.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const apiTs = readFileSync(join(ROOT, "src", "api.ts"), "utf8");

describe("src/api.ts — packaged-app networking fix (task #45)", () => {
  it("never calls fetch() with an origin-relative path (the old broken pattern)", () => {
    // A doc comment is allowed to QUOTE the old broken call for institutional memory (this
    // repo's own established comment style); what must be gone is the real call shape.
    expect(apiTs).not.toMatch(/fetch\(\s*path\s*,/);
  });

  it("never builds the WebSocket URL from location.host (malformed under the packaged app's origin)", () => {
    expect(apiTs).not.toMatch(/new WebSocket\(\s*`[^`]*location\.host/);
  });

  it("uses a fixed, absolute bridge origin for both REST and WebSocket", () => {
    expect(apiTs).toMatch(/const BRIDGE_HTTP_ORIGIN\s*=\s*["']http:\/\/localhost:8787["']/);
    expect(apiTs).toMatch(/const BRIDGE_WS_URL\s*=\s*["']ws:\/\/localhost:8787\/ws["']/);
    expect(apiTs).toMatch(/fetch\(\s*`\$\{BRIDGE_HTTP_ORIGIN\}/);
    expect(apiTs).toMatch(/new WebSocket\(BRIDGE_WS_URL\)/);
  });

  it("artifactUrl() (used directly as <img src> in several components) is also absolute, not just request()", () => {
    const fn = apiTs.match(/export function artifactUrl\([\s\S]*?\n}/)?.[0];
    expect(fn, "artifactUrl not found").toBeTruthy();
    expect(fn).toMatch(/\$\{BRIDGE_HTTP_ORIGIN\}/);
  });
});
