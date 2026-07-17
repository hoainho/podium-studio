// Gate for the Stop/cancel feature: a run must stop between steps when /api/cancel is
// called, marking the remaining steps skipped instead of running them all. Self-contained.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8792;
const BASE = `http://localhost:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (u, o) => (await fetch(BASE + u, o)).json();
const post = (u, b) => j(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b ?? {}) });

let bridge;
const kill = () => { if (bridge && !bridge.killed) bridge.kill("SIGKILL"); };

try {
  bridge = spawn("npx", ["tsx", "bridge/server.ts"], { cwd: ROOT, env: { ...process.env, BRIDGE_PORT: String(PORT) }, stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 40; i++) { try { if ((await j("/api/health")).ok) { up = true; break; } } catch {} await wait(1000); }
  if (!up) throw new Error("bridge not healthy");
  const { ios } = await j("/api/devices");
  const udid = (ios.find((d) => d.name === "iPhone 16 Pro") ?? ios[0]).udid;
  await post("/api/boot", { udid });

  // 5 steps with several 3s waits; total ≈ 9s+ if it runs to completion.
  const flow = {
    schemaVersion: 1, name: "Cancel Proof", app: { bundleId: "com.apple.Preferences", platform: "ios-sim" },
    steps: [
      { id: "c1", action: "screenshot" },
      { id: "c2", action: "waitMs", ms: 3000 },
      { id: "c3", action: "waitMs", ms: 3000 },
      { id: "c4", action: "waitMs", ms: 3000 },
      { id: "c5", action: "screenshot" },
    ],
  };

  const t0 = Date.now();
  const runP = post("/api/run", { udid, flow });   // fire; don't await yet
  await wait(1200);                                  // let it get into the waits
  await post("/api/cancel");                          // Stop
  const summary = await runP;
  const dur = Date.now() - t0;

  const skipped = summary.results.filter((r) => r.status === "skipped").length;
  console.log(`[verify-cancel] passed=${summary.passed} skipped=${skipped}/${summary.total} duration=${dur}ms`);
  if (summary.passed !== false) throw new Error("a cancelled run must not report passed");
  if (skipped < 1) throw new Error("expected remaining steps to be skipped");
  if (dur > 8000) throw new Error(`run did not stop early (took ${dur}ms; full run would be ~9s+)`);

  console.log("PASS: run stops on /api/cancel; remaining steps skipped");
  kill(); process.exit(0);
} catch (err) {
  console.error("FAIL:", err?.message ?? err);
  kill(); process.exit(1);
}
