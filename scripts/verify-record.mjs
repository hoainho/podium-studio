// PSTUDIO-10 gate: prove the record-mode backend end-to-end against a real simulator.
// /api/screen (live mirror + scale) and /api/act (single live step + fresh frame),
// including fail-closed behavior on a bogus assert. Designed to be STATE-INDEPENDENT:
// iOS Settings restores its last sub-page, so we never assume specific on-screen text —
// the required checks use content-free actions; a positive assertVisible is best-effort.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8797;
const BASE = `http://localhost:${PORT}`;
const BUNDLE = "com.apple.Preferences";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (u, o) => (await fetch(BASE + u, o)).json();
const post = (u, b) => j(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

let bridge;
const kill = () => { if (bridge && !bridge.killed) bridge.kill("SIGKILL"); };
let udid;
const act = (step) => post("/api/act", { udid, step: { id: "x", ...step }, bundleId: BUNDLE });

try {
  bridge = spawn("npx", ["tsx", "bridge/server.ts"], { cwd: ROOT, env: { ...process.env, BRIDGE_PORT: String(PORT) }, stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 40; i++) { try { if ((await j("/api/health")).ok) { up = true; break; } } catch {} await wait(1000); }
  if (!up) throw new Error("bridge did not become healthy");

  const { ios } = await j("/api/devices");
  if (!ios?.length) throw new Error("no iOS simulators");
  udid = (ios.find((d) => d.name === "iPhone 16 Pro") ?? ios[0]).udid;
  await post("/api/boot", { udid });
  await post("/api/launch", { udid, bundleId: BUNDLE });
  await wait(2000);

  // 1) live mirror
  const frame = await j(`/api/screen?udid=${udid}`);
  if (!(frame.path && existsSync(frame.path) && frame.scale >= 2)) throw new Error("screen capture failed");
  console.log(`[verify-record] /api/screen OK (scale=${frame.scale})`);

  // 2) a PASSING live single-step (content-free) that returns a fresh frame
  const shot = await act({ action: "screenshot" });
  if (!shot.ok || !existsSync(shot.screen)) throw new Error("act screenshot did not pass / return a frame");
  console.log("[verify-record] /api/act (screenshot) + fresh frame OK");

  // 3) REQUIRED: fail-closed on a bogus assertion
  const bogus = await act({ action: "assertVisible", text: "ZZZ_NONEXISTENT_QWERTY", timeoutMs: 2000 });
  if (bogus.ok !== false) throw new Error("bogus assert should have failed but did not");
  console.log("[verify-record] /api/act fail-closed OK (" + bogus.error + ")");

  console.log("PASS: record-mode backend (mirror + live single-step + fail-closed) verified");
  kill(); process.exit(0);
} catch (err) {
  console.error("FAIL:", err?.message ?? err);
  kill(); process.exit(1);
}
