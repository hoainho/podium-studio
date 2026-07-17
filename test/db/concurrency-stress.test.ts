import { describe, it, expect, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * E9 AC5: "N≥4 parallel run workers + 1 headless CLI process + the app writing concurrently
 * over a stress run of ≥500 writes produce zero SQLITE_BUSY errors (WAL + single
 * write-serializer verified in logs)."
 *
 * Each "writer" below is a genuinely separate `node` OS process (spawned via child_process,
 * not an in-process async call) opening its OWN connection to the SAME primary-store file —
 * this is real cross-process contention, the actual thing that can produce SQLITE_BUSY. The
 * E15 run-orchestrator that will eventually spawn real parallel run-workers doesn't exist yet
 * (out of scope for E9, per the epic's own "Out" list) — this test proves the STORAGE LAYER's
 * concurrency guarantee (WAL + busy-timeout + the in-process serializer) independently of that
 * future orchestrator, using directly-spawned writer processes as a faithful stand-in for
 * "N workers + 1 CLI + the app".
 */

const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

interface WorkerOutcome {
  label: string;
  attempted: number;
  succeeded: number;
  errors: string[];
  stderr: string;
}

function runWorker(dbPath: string, backupsDir: string, label: string, writeCount: number): Promise<WorkerOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(fixturesDir, "concurrency-worker.ts"), dbPath, backupsDir, label, String(writeCount)]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", () => {
      const lastLine = stdout.trim().split("\n").filter(Boolean).pop();
      if (!lastLine) {
        reject(new Error(`worker "${label}" produced no output. stderr: ${stderr}`));
        return;
      }
      try {
        resolve({ ...JSON.parse(lastLine), stderr });
      } catch {
        reject(new Error(`worker "${label}" output was not valid JSON: ${lastLine}\nstderr: ${stderr}`));
      }
    });
  });
}

function countRuns(dbPath: string, backupsDir: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(fixturesDir, "count-runs.ts"), dbPath, backupsDir]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", () => {
      try {
        resolve(JSON.parse(stdout.trim().split("\n").filter(Boolean).pop() ?? "").count);
      } catch {
        reject(new Error(`count-runs produced no parseable output. stderr: ${stderr}`));
      }
    });
  });
}

let tmpDir: string;
afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

describe("Primary store — real multi-process write concurrency (E9 AC5)", () => {
  it(
    "4 parallel run-worker processes + 1 headless-CLI process + 1 app process, 520 total writes, zero SQLITE_BUSY, zero lost writes",
    async () => {
      tmpDir = mkdtempSync(join(tmpdir(), "podium-studio-stress-"));
      const dbPath = join(tmpDir, "primary.sqlite");
      const backupsDir = join(tmpDir, "backups");

      // Prime the store once, single-process, BEFORE any concurrent writer attaches — exactly
      // how the real system works (bridge/server.ts's openStores() creates + migrates the file
      // once at startup; concurrent /api/run writers only ever attach to an already-initialized
      // file). This test is about steady-state write concurrency, not the disjoint concern of
      // N processes racing to *create* a brand-new file for the very first time simultaneously.
      expect(await countRuns(dbPath, backupsDir)).toBe(0);

      // N=4 "run workers" (100 writes each) + 1 "headless CLI" (60) + 1 "the app" (60) = 520,
      // clearing AC5's ">=500 writes" bar across exactly the three writer classes it names.
      const jobs: Array<[string, number]> = [
        ["worker-0", 100], ["worker-1", 100], ["worker-2", 100], ["worker-3", 100],
        ["cli", 60],
        ["app", 60],
      ];
      const totalAttempted = jobs.reduce((sum, [, n]) => sum + n, 0);
      expect(totalAttempted).toBeGreaterThanOrEqual(500);

      const outcomes = await Promise.all(jobs.map(([label, n]) => runWorker(dbPath, backupsDir, label, n)));

      const allErrors = outcomes.flatMap((o) => o.errors);
      const allStderr = outcomes.map((o) => o.stderr).join("\n");
      const busyHits = [...allErrors, allStderr].join("\n").match(/SQLITE_BUSY/gi) ?? [];

      expect(busyHits).toHaveLength(0); // the literal grep-for-SQLITE_BUSY AC5 asks for
      expect(allErrors).toEqual([]); // no writer failed for ANY reason, not just busy-related ones
      for (const o of outcomes) expect(o.succeeded, `${o.label}: ${o.errors.join("; ")}`).toBe(o.attempted);

      const finalCount = await countRuns(dbPath, backupsDir);
      expect(finalCount).toBe(totalAttempted); // zero writes silently lost across all 6 processes
    },
    30_000, // 6 real child processes x up to 100 sync sqlite writes each — generous but bounded
  );
});
