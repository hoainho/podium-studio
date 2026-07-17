// PSTUDIO-12 gate: if the Podium engine child dies mid-session, the bridge must transparently
// reconnect on the next call instead of staying "Not connected" forever. Self-contained.
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8795;
const BASE = `http://localhost:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (u) => (await fetch(BASE + u)).json();

let bridge;
const kill = () => { if (bridge && !bridge.killed) bridge.kill("SIGKILL"); };

try {
  bridge = spawn("npx", ["tsx", "bridge/server.ts"], { cwd: ROOT, env: { ...process.env, BRIDGE_PORT: String(PORT) }, stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 40; i++) { try { if ((await j("/api/health")).ok) { up = true; break; } } catch {} await wait(1000); }
  if (!up) throw new Error("bridge not healthy");

  const before = await j("/api/devices");
  if (!before.ios?.length) throw new Error("no devices before kill");
  console.log(`[verify-reconnect] healthy, ${before.ios.length} devices before kill`);

  // Kill ONLY this bridge's Podium engine child (spawned as `node .../podium/dist/index.js`),
  // simulating a crash. The bridge's own tsx process stays alive.
  try {
    execSync(`pkill -f "podium/dist/index.js"`, { stdio: "ignore" });
  } catch { /* pkill returns non-zero if nothing matched; fine */ }
  console.log("[verify-reconnect] killed Podium engine child; waiting for close to propagate...");
  await wait(2500);

  // Next call must transparently re-spawn + reconnect the engine.
  let recovered = null;
  for (let i = 0; i < 15; i++) {
    try {
      const after = await j("/api/devices");
      if (after.ios?.length) { recovered = after; break; }
    } catch {}
    await wait(1000);
  }
  if (!recovered) throw new Error("engine did NOT reconnect after the child was killed");
  console.log(`[verify-reconnect] reconnected: ${recovered.ios.length} devices after kill`);

  const health = await j("/api/health");
  if (!health.ok) throw new Error("health not ok after reconnect");

  console.log("PASS: engine auto-reconnects after the Podium child dies");
  kill(); process.exit(0);
} catch (err) {
  console.error("FAIL:", err?.message ?? err);
  kill(); process.exit(1);
}
