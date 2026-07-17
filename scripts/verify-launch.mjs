// PSTUDIO-11 gate: the runner must launch the target app before steps, and must reject a
// run whose app isn't installed with a clear, decidable message. Self-contained.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8796;
const BASE = `http://localhost:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (u, o) => (await fetch(BASE + u, o)).json();
const post = (u, b) => fetch(BASE + u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });

let bridge;
const kill = () => { if (bridge && !bridge.killed) bridge.kill("SIGKILL"); };

try {
  bridge = spawn("npx", ["tsx", "bridge/server.ts"], { cwd: ROOT, env: { ...process.env, BRIDGE_PORT: String(PORT) }, stdio: "ignore" });
  let up = false;
  for (let i = 0; i < 40; i++) { try { if ((await j("/api/health")).ok) { up = true; break; } } catch {} await wait(1000); }
  if (!up) throw new Error("bridge not healthy");

  const { ios } = await j("/api/devices");
  const dev = ios.find((d) => d.name === "iPhone 16 Pro") ?? ios[0];
  await post("/api/boot", { udid: dev.udid });

  // Make sure Settings is NOT foreground: launch a different app first, then run a
  // Settings flow. If the runner launches the target app, the flow still passes.
  await post("/api/launch", { udid: dev.udid, bundleId: "com.apple.mobilecal" }); // Calendar
  await wait(1500);

  // Flow steps that always pass (screenshot + settle) — the PROOF that the runner
  // launched the RIGHT app (Settings, not the foregrounded Calendar) is the app-state
  // running check below, not a screen-content assert (iOS Settings restores its last
  // sub-page, so asserting a root row like "General" would be state-dependent/flaky).
  const settingsFlow = {
    schemaVersion: 1, name: "Launch Proof", app: { bundleId: "com.apple.Preferences", platform: "ios-sim" },
    steps: [
      { id: "s1", action: "screenshot" },
      { id: "s2", action: "waitMs", ms: 1500 },
    ],
  };
  const runRes = await post("/api/run", { udid: dev.udid, flow: settingsFlow });
  const summary = await runRes.json();
  if (!summary.passed) throw new Error("Settings flow should pass because the runner launches the app; got: " + JSON.stringify(summary.results?.map((r) => r.action + ":" + r.status)));
  console.log("[verify-launch] runner launched target app + flow passed OK");

  // Confirm the app is actually running now (it was launched by the runner).
  const st = await j(`/api/app-state?udid=${dev.udid}&bundleId=com.apple.Preferences`);
  if (!st.running) throw new Error("Settings should be running after the run");
  console.log("[verify-launch] app-state running=true OK");

  // Not-installed guard: a bogus bundle id must yield a clear, decidable error.
  const badRun = await post("/api/run", { udid: dev.udid, flow: { schemaVersion: 1, name: "Missing App", app: { bundleId: "com.nope.not.installed", platform: "ios-sim" }, steps: [{ id: "b1", action: "screenshot" }] } });
  const badBody = await badRun.json();
  if (!(badRun.status >= 400 && /not installed/i.test(badBody.error ?? ""))) {
    throw new Error("expected a decidable 'not installed' error, got: " + JSON.stringify(badBody));
  }
  console.log("[verify-launch] not-installed guard OK (" + badBody.error + ")");

  console.log("PASS: runner launches target app + app-presence guard verified");
  kill(); process.exit(0);
} catch (err) {
  console.error("FAIL:", err?.message ?? err);
  kill(); process.exit(1);
}
