#!/usr/bin/env node
// PSTUDIO-04 — Verify the bridge boots, reports health, and can list devices.
//
// Self-contained: spawns bridge/server.ts itself (does not assume a bridge is
// already running), polls /api/health until it responds, asserts the Podium
// engine is connected with tools loaded, then asserts /api/devices returns at
// least one iOS device. Always kills the child process before exiting.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = 8799;
const BASE_URL = `http://localhost:${PORT}`;
const HEALTH_TIMEOUT_MS = 40_000;
const POLL_INTERVAL_MS = 500;

function log(msg) {
  console.log(`[verify-bridge] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killChild(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    try {
      // `npx` often runs the real binary (tsx) as a subprocess rather than
      // exec-replacing itself, so SIGKILL to child.pid alone can leave the
      // bridge running. Kill the whole process group instead (requires
      // detached:true at spawn time, which makes child.pid the group leader).
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // process may have already exited
      }
    }
    // Safety net in case the process ignores SIGKILL somehow (it shouldn't).
    setTimeout(resolve, 3_000);
  });
}

async function pollHealth(deadline) {
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/api/health`);
      if (res.ok) {
        const body = await res.json();
        return body;
      }
    } catch (err) {
      lastErr = err;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(
    `Bridge did not become healthy within ${HEALTH_TIMEOUT_MS}ms: ${lastErr?.message ?? "no response"}`,
  );
}

async function main() {
  log(`Spawning bridge on port ${PORT}...`);
  const child = spawn("npx", ["tsx", "bridge/server.ts"], {
    cwd: ROOT,
    env: { ...process.env, BRIDGE_PORT: String(PORT) },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  child.stdout.on("data", (d) => process.stdout.write(`[bridge] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[bridge] ${d}`));

  let exitedEarly = false;
  child.once("exit", (code) => {
    exitedEarly = true;
    if (code !== 0 && code !== null) {
      log(`WARNING: bridge process exited early with code ${code}`);
    }
  });

  try {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    log("Polling /api/health...");
    const health = await pollHealth(deadline);

    if (health.ok !== true) {
      throw new Error(`Expected health.ok===true, got ${JSON.stringify(health)}`);
    }
    if (!health.podium || !(health.podium.toolCount > 0)) {
      throw new Error(
        `Expected health.podium.toolCount>0, got ${JSON.stringify(health.podium)}`,
      );
    }
    log(`Health OK. podium.toolCount=${health.podium.toolCount}`);

    log("Fetching /api/devices...");
    const devicesRes = await fetch(`${BASE_URL}/api/devices`);
    if (!devicesRes.ok) {
      throw new Error(`GET /api/devices returned HTTP ${devicesRes.status}`);
    }
    const devices = await devicesRes.json();
    if (!Array.isArray(devices.ios) || devices.ios.length === 0) {
      throw new Error(`Expected devices.ios.length>0, got ${JSON.stringify(devices)}`);
    }
    log(`Found ${devices.ios.length} iOS device(s).`);

    console.log("PASS: bridge health + devices verified");
    process.exitCode = 0;
  } catch (err) {
    console.error(`FAIL: ${err?.message ?? err}`);
    process.exitCode = 1;
  } finally {
    if (!exitedEarly) {
      log("Killing bridge child process...");
      await killChild(child);
    }
  }
}

main();
