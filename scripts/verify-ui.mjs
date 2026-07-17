#!/usr/bin/env node
// PSTUDIO-06 — Verify the Vite dev server serves the React app shell.
//
// Spawns `vite --port 5199`, polls `/` until it responds 200 with a body
// containing `id="root"` (the mount point in index.html), then tears the
// server down. Always kills the child process before exiting.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = 5199;
const BASE_URL = `http://localhost:${PORT}/`;
const TIMEOUT_MS = 40_000;
const POLL_INTERVAL_MS = 500;

function log(msg) {
  console.log(`[verify-ui] ${msg}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function killChild(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  await new Promise((resolve) => {
    child.once("exit", resolve);
    try {
      // `npx` often runs the real binary (vite) as a subprocess rather than
      // exec-replacing itself, so SIGKILL to child.pid alone can leave vite
      // running. Kill the whole process group instead (requires detached:true
      // at spawn time, which makes child.pid the process group leader).
      process.kill(-child.pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // process may have already exited
      }
    }
    setTimeout(resolve, 3_000);
  });
}

async function pollForRoot(deadline) {
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(BASE_URL);
      if (res.status === 200) {
        const body = await res.text();
        if (body.includes('id="root"')) {
          return body;
        }
        lastErr = new Error(`Got HTTP 200 but body missing id="root"`);
      } else {
        lastErr = new Error(`Got HTTP ${res.status}`);
      }
    } catch (err) {
      lastErr = err;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`Vite dev server did not serve a valid page within ${TIMEOUT_MS}ms: ${lastErr?.message}`);
}

async function main() {
  log(`Spawning vite on port ${PORT}...`);
  const child = spawn("npx", ["vite", "--port", String(PORT)], {
    cwd: ROOT,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  child.stdout.on("data", (d) => process.stdout.write(`[vite] ${d}`));
  child.stderr.on("data", (d) => process.stderr.write(`[vite] ${d}`));

  let exitedEarly = false;
  child.once("exit", (code) => {
    exitedEarly = true;
    if (code !== 0 && code !== null) {
      log(`WARNING: vite process exited early with code ${code}`);
    }
  });

  try {
    const deadline = Date.now() + TIMEOUT_MS;
    log(`Polling ${BASE_URL}...`);
    await pollForRoot(deadline);
    log('Got HTTP 200 with id="root" present.');

    console.log("PASS: vite dev server serving app shell");
    process.exitCode = 0;
  } catch (err) {
    console.error(`FAIL: ${err?.message ?? err}`);
    process.exitCode = 1;
  } finally {
    if (!exitedEarly) {
      log("Killing vite child process...");
      await killChild(child);
    }
  }
}

main();
