// PSTUDIO-14 gate: the extended action vocabulary must actually execute on a device.
// Native actions route through run_steps; rich actions (doubleTap/longPress/scroll/
// tapIfVisible/back/hideKeyboard/raw) route through a per-step Maestro flow. We assert the
// routing returns ok. STATE-INDEPENDENT by design: no assumption about on-screen text
// (iOS Settings restores its last sub-page) — tap-like rich actions target COORDINATES,
// which Maestro's *On:point executes regardless of content.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8794;
const BASE = `http://localhost:${PORT}`;
const BUNDLE = "com.apple.Preferences";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (u, o) => (await fetch(BASE + u, o)).json();
const post = (u, b) => j(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

let bridge;
const kill = () => { if (bridge && !bridge.killed) bridge.kill("SIGKILL"); };
let udid;
async function act(step, expectOk = true) {
  const r = await post("/api/act", { udid, step: { id: "x", ...step }, bundleId: BUNDLE });
  const tag = step.action + (step.text ? ` "${step.text}"` : step.direction ? ` ${step.direction}` : step.x !== undefined ? ` (${step.x},${step.y})` : "");
  const pass = r.ok === expectOk;
  console.log(`  ${pass ? "ok " : "BAD"} ${tag} -> ok=${r.ok}${r.error ? " | " + String(r.error).slice(0, 60) : ""}`);
  if (!pass) throw new Error(`action ${tag} expected ok=${expectOk}, got ok=${r.ok} (${r.error ?? ""})`);
}

try {
  bridge = spawn("npx", ["tsx", "bridge/server.ts"], { cwd: ROOT, env: { ...process.env, BRIDGE_PORT: String(PORT) }, stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 40; i++) { try { if ((await j("/api/health")).ok) { up = true; break; } } catch {} await wait(1000); }
  if (!up) throw new Error("bridge not healthy");

  const { ios } = await j("/api/devices");
  udid = (ios.find((d) => d.name === "iPhone 16 Pro") ?? ios[0]).udid;
  await post("/api/boot", { udid });
  await post("/api/launch", { udid, bundleId: BUNDLE });
  await wait(2000);

  console.log("[verify-actions] native path (run_steps):");
  await act({ action: "screenshot" });                          // guaranteed-pass native step

  console.log("[verify-actions] rich path (Maestro):");
  await act({ action: "scroll", direction: "down" });
  await act({ action: "scroll", direction: "up" });
  await act({ action: "tapIfVisible", text: "ZZZ_NONEXISTENT_QWERTY", timeoutMs: 2000 }); // absent → still ok (optional)
  await act({ action: "longPress", x: 200, y: 400 });           // coordinate → content-independent
  await act({ action: "doubleTap", x: 200, y: 420 });
  await act({ action: "hideKeyboard" });
  await act({ action: "raw", maestro: `- swipe:\n    direction: DOWN` });
  await act({ action: "back" });

  console.log("PASS: native + rich (Maestro) action routing verified end-to-end");
  kill(); process.exit(0);
} catch (err) {
  console.error("FAIL:", err?.message ?? err);
  kill(); process.exit(1);
}
