import { describe, it, expect, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeRunCount,
  cancelRun,
  computeConcurrency,
  computeJobId,
  createPortPool,
  createProfilePool,
  isRunActive,
  registerRun,
  runSuite,
  shardJobs,
  unregisterRun,
  type SuiteJob,
  type WorkerSlot,
} from "../bridge/orchestrator.ts";
import { createRunContext } from "../bridge/runner.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let tmpDirs: string[] = [];
function makeTmpDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

// ── Port pool (E15 AC4) ───────────────────────────────────────────────────────────────────────

describe("createPortPool — unique ports, release + reuse (E15 AC4)", () => {
  it("acquire() returns unique ports across N concurrent workers", () => {
    const pool = createPortPool(5, 9000);
    const ports = new Set(Array.from({ length: 5 }, () => pool.acquire()));
    expect(ports.size).toBe(5);
    for (const p of ports) expect(p).toBeGreaterThanOrEqual(9000);
  });

  it("throws once the pool is exhausted, rather than silently handing out a duplicate", () => {
    const pool = createPortPool(2, 9000);
    pool.acquire();
    pool.acquire();
    expect(() => pool.acquire()).toThrow(/exhausted/);
  });

  it("a released port is reusable by a subsequent acquire()", () => {
    const pool = createPortPool(1, 9000);
    const first = pool.acquire();
    expect(() => pool.acquire()).toThrow(); // pool of size 1 is now empty
    pool.release(first);
    const second = pool.acquire();
    expect(second).toBe(first);
  });

  it("releasing an unknown/already-released port is a silent no-op, not an error", () => {
    const pool = createPortPool(1, 9000);
    expect(() => pool.release(12345)).not.toThrow();
    const port = pool.acquire();
    pool.release(port);
    expect(() => pool.release(port)).not.toThrow(); // double-release is also a no-op
  });
});

// ── Profile pool (E15 AC5) ────────────────────────────────────────────────────────────────────

describe("createProfilePool — isolated profile/artifacts dirs per worker (E15 AC5)", () => {
  it("acquire() creates a real, empty profile dir and artifacts dir for that worker", async () => {
    const rootDir = makeTmpDir("podium-studio-orch-profiles-");
    const pool = createProfilePool(createPortPool(4), "run-1", rootDir);
    const slot = await pool.acquire(0);

    expect(existsSync(slot.profileDir)).toBe(true);
    expect(existsSync(slot.artifactsDir)).toBe(true);
    expect(slot.profileDir).toContain("worker-0");
    expect(slot.artifactsDir).toContain("w0");
  });

  it("release() deletes the profile dir and returns the port to the pool", async () => {
    const rootDir = makeTmpDir("podium-studio-orch-profiles-");
    const portPool = createPortPool(4);
    const pool = createProfilePool(portPool, "run-1", rootDir);
    const slot = await pool.acquire(0);
    expect(existsSync(slot.profileDir)).toBe(true);

    await pool.release(slot);
    expect(existsSync(slot.profileDir)).toBe(false);
    // the port is usable again
    const reacquired = portPool.acquire();
    expect(reacquired).toBe(slot.port);
  });

  it("corrupting/deleting one worker's profile dir mid-run never affects another worker's slot", async () => {
    const rootDir = makeTmpDir("podium-studio-orch-profiles-");
    const pool = createProfilePool(createPortPool(4), "run-1", rootDir);
    const slot1 = await pool.acquire(1);
    const slot2 = await pool.acquire(2);
    const slot3 = await pool.acquire(3);

    writeFileSync(join(slot1.profileDir, "sentinel.txt"), "worker-1-data");
    writeFileSync(join(slot2.profileDir, "sentinel.txt"), "worker-2-data");
    writeFileSync(join(slot3.profileDir, "sentinel.txt"), "worker-3-data");

    // Simulate worker-2's profile getting corrupted/deleted mid-run.
    rmSync(slot2.profileDir, { recursive: true, force: true });

    // Workers 1 and 3 are completely unaffected — their own dirs and ports are untouched.
    expect(existsSync(join(slot1.profileDir, "sentinel.txt"))).toBe(true);
    expect(existsSync(join(slot3.profileDir, "sentinel.txt"))).toBe(true);
    expect(slot1.port).not.toBe(slot2.port);
    expect(slot1.port).not.toBe(slot3.port);

    // Releasing the already-gone profile dir is still safe (best-effort, no throw).
    await expect(pool.release(slot2)).resolves.toBeUndefined();
    await expect(pool.release(slot1)).resolves.toBeUndefined();
    expect(existsSync(join(slot3.profileDir, "sentinel.txt"))).toBe(true); // still fine
  });

  it("acquire() always starts from a clean slate, even if a prior run left the dir behind", async () => {
    const rootDir = makeTmpDir("podium-studio-orch-profiles-");
    const portPool = createPortPool(4);
    const pool = createProfilePool(portPool, "run-1", rootDir);
    const slot = await pool.acquire(0);
    writeFileSync(join(slot.profileDir, "leftover.txt"), "stale from a crashed prior run");
    // NOT released — simulating a crash that skipped cleanup.

    const reacquired = await pool.acquire(0);
    expect(existsSync(join(reacquired.profileDir, "leftover.txt"))).toBe(false);
  });
});

// ── Concurrency cap (E15 AC2) ─────────────────────────────────────────────────────────────────

describe("computeConcurrency — default min(CPU-2, N), user-tunable (E15 AC2)", () => {
  it("caps at CPU count - 2 when requested exceeds it", () => {
    expect(computeConcurrency(10, 8)).toBe(6);
  });

  it("uses the requested value when it's under the CPU cap", () => {
    expect(computeConcurrency(3, 8)).toBe(3);
  });

  it("never returns less than 1, even on a very low-core machine", () => {
    expect(computeConcurrency(10, 2)).toBe(1);
    expect(computeConcurrency(1, 1)).toBe(1);
  });
});

// ── Run registry — per-run context replaces the old module-level cancel flag (E15 AC3) ───────

describe("run registry — cancelRun targets ONE run id, never cross-talking (E15 AC3)", () => {
  it("cancelRun sets cancelled on the targeted context only", () => {
    const ctxA = createRunContext();
    const ctxB = createRunContext();
    registerRun(ctxA);
    registerRun(ctxB);

    const found = cancelRun(ctxA.runId);

    expect(found).toBe(true);
    expect(ctxA.cancelled).toBe(true);
    expect(ctxB.cancelled).toBe(false); // completely unaffected

    unregisterRun(ctxA.runId);
    unregisterRun(ctxB.runId);
  });

  it("cancelRun on an unknown/already-finished id returns false and throws nothing", () => {
    expect(cancelRun("no-such-run-id")).toBe(false);
  });

  it("isRunActive / activeRunCount reflect register/unregister accurately", () => {
    const before = activeRunCount();
    const ctx = createRunContext();
    registerRun(ctx);
    expect(isRunActive(ctx.runId)).toBe(true);
    expect(activeRunCount()).toBe(before + 1);
    unregisterRun(ctx.runId);
    expect(isRunActive(ctx.runId)).toBe(false);
    expect(activeRunCount()).toBe(before);
  });
});

// ── Sharding ───────────────────────────────────────────────────────────────────────────────────

describe("shardJobs", () => {
  it("round-robin spreads jobs as evenly as possible across shards", () => {
    const jobs = Array.from({ length: 7 }, (_, i) => ({ id: i }));
    const shards = shardJobs(jobs, 3, "round-robin");
    expect(shards.map((s) => s.length)).toEqual([3, 2, 2]);
    expect(shards.flat().map((j) => j.id).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("by-tag keeps same-tagged jobs together on one shard", () => {
    const jobs = [
      { id: 1, tag: "smoke" }, { id: 2, tag: "smoke" }, { id: 3, tag: "smoke" },
      { id: 4, tag: "regression" }, { id: 5, tag: "regression" },
    ];
    const shards = shardJobs(jobs, 2, "by-tag");
    const smokeShardIndex = shards.findIndex((s) => s.some((j) => j.tag === "smoke"));
    expect(shards[smokeShardIndex].every((j) => j.tag === "smoke")).toBe(true);
  });

  it("handles more shards than jobs (some shards end up empty)", () => {
    const jobs = [{ id: 1 }, { id: 2 }];
    const shards = shardJobs(jobs, 5, "round-robin");
    expect(shards).toHaveLength(5);
    expect(shards.filter((s) => s.length === 0)).toHaveLength(3);
  });
});

// ── runSuite — the full orchestrated parallel run (E15 AC1, AC2, AC4, AC5, AC6) ──────────────

describe("runSuite — merged report across N parallel workers", () => {
  it("merges every worker's results into ONE report (AC1/AC6)", async () => {
    const rootDir = makeTmpDir("podium-studio-orch-suite-");
    const jobs: SuiteJob<{ id: number }>[] = Array.from({ length: 6 }, (_, i) => ({
      run: async (ctx) => ({ id: i, cancelled: ctx.cancelled }),
    }));

    const report = await runSuite(jobs, { concurrency: 3, runtimeDir: rootDir });

    expect(report.results).toHaveLength(6);
    expect(report.results.map((r) => r.id).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(report.workers.reduce((sum, w) => sum + w.results.length, 0)).toBe(6);
    expect(report.suiteId).toBeTruthy();
    expect(typeof report.durationMs).toBe("number");
  });

  it("returns an empty, zero-duration report for an empty job list without touching any pool", async () => {
    const report = await runSuite([]);
    expect(report.workers).toEqual([]);
    expect(report.results).toEqual([]);
    expect(report.concurrency).toBe(0);
  });

  it("never exceeds the computed concurrency cap, verified by tracking overlapping job execution (AC2)", async () => {
    const rootDir = makeTmpDir("podium-studio-orch-suite-");
    let concurrent = 0;
    let maxConcurrent = 0;
    const CAP = 3;

    const jobs: SuiteJob<number>[] = Array.from({ length: 10 }, () => ({
      run: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(20);
        concurrent--;
        return 1;
      },
    }));

    // computeConcurrency(10, realCpuCount) could exceed 3 on a beefy machine, so pass a
    // pre-computed cap directly via `concurrency` and a matching portPool sized to it — the
    // point under test is "the actual number of simultaneously-running jobs never exceeds
    // whatever concurrency runSuite settled on", which we read back off the report itself.
    const report = await runSuite(jobs, { concurrency: CAP, runtimeDir: rootDir });

    expect(maxConcurrent).toBeLessThanOrEqual(report.concurrency);
    expect(report.concurrency).toBeLessThanOrEqual(CAP);
    expect(report.results).toHaveLength(10);
  });

  it("wall-clock is close to the slowest single job, not the sum of all jobs (AC1)", async () => {
    const rootDir = makeTmpDir("podium-studio-orch-suite-");
    const JOB_MS = 60;
    const jobs: SuiteJob<number>[] = Array.from({ length: 4 }, () => ({
      run: async () => {
        await sleep(JOB_MS);
        return 1;
      },
    }));

    const start = Date.now();
    const report = await runSuite(jobs, { concurrency: 4, runtimeDir: rootDir });
    const wallClock = Date.now() - start;

    // A truly serial run would take ~4*JOB_MS; parallel should land close to 1*JOB_MS. Generous
    // bound (2.5x the single-job duration) to stay non-flaky under CI scheduling jitter, while
    // still clearly failing if execution were actually serialized (~240ms).
    expect(wallClock).toBeLessThan(JOB_MS * 2.5);
    expect(report.results).toHaveLength(4);
  });

  it("assigns a unique port per worker across N concurrent workers (AC4)", async () => {
    const rootDir = makeTmpDir("podium-studio-orch-suite-");
    const seenPorts: number[] = [];
    const jobs: SuiteJob<number>[] = Array.from({ length: 5 }, () => ({
      run: async (_ctx, slot: WorkerSlot) => {
        seenPorts.push(slot.port);
        return 1;
      },
    }));

    const report = await runSuite(jobs, { concurrency: 5, runtimeDir: rootDir });

    const workerPorts = report.workers.map((w) => w.port);
    expect(new Set(workerPorts).size).toBe(workerPorts.length); // every worker got a distinct port
  });

  it("each worker gets its own isolated profileDir/artifactsDir (AC5)", async () => {
    const rootDir = makeTmpDir("podium-studio-orch-suite-");
    const jobs: SuiteJob<string>[] = Array.from({ length: 3 }, () => ({
      run: async (_ctx, slot: WorkerSlot) => slot.profileDir,
    }));

    const report = await runSuite(jobs, { concurrency: 3, runtimeDir: rootDir });

    const dirs = report.workers.map((w) => w.profileDir);
    expect(new Set(dirs).size).toBe(dirs.length);
    // Profile dirs are cleaned up after the suite finishes (release() runs per worker).
    for (const dir of dirs) expect(existsSync(dir)).toBe(false);
  });

  it("cancelling one run mid-suite (via cancelRun) never affects a concurrently running suite (E15 AC3, orchestrator-level)", async () => {
    const rootDirA = makeTmpDir("podium-studio-orch-suite-a-");
    const rootDirB = makeTmpDir("podium-studio-orch-suite-b-");
    let capturedRunIdA: string | undefined;

    const jobsA: SuiteJob<string>[] = [
      {
        run: async (ctx) => {
          capturedRunIdA = ctx.runId;
          // Stay running long enough for the test to observe the runId and land a cancel,
          // regardless of scheduler pressure (was 15ms — too tight under full-suite parallel load).
          await sleep(200);
          return ctx.cancelled ? "cancelled" : "ok";
        },
      },
    ];
    const jobsB: SuiteJob<string>[] = Array.from({ length: 3 }, () => ({
      run: async (ctx) => {
        await sleep(200);
        return ctx.cancelled ? "cancelled" : "ok";
      },
    }));

    const suiteAPromise = runSuite(jobsA, { concurrency: 1, runtimeDir: rootDirA });
    const suiteBPromise = runSuite(jobsB, { concurrency: 3, runtimeDir: rootDirB });

    // Poll (bounded) until suite A's job has actually started and exposed its runId,
    // instead of assuming a fixed delay — deterministic, no flake under heavy parallel load.
    for (let i = 0; i < 400 && !capturedRunIdA; i++) await sleep(5);
    expect(capturedRunIdA).toBeTruthy();
    const wasCancelled = cancelRun(capturedRunIdA!);
    expect(wasCancelled).toBe(true);

    const [reportA, reportB] = await Promise.all([suiteAPromise, suiteBPromise]);

    expect(reportA.results).toEqual(["cancelled"]);
    expect(reportB.results.every((r) => r === "ok")).toBe(true); // B never saw A's cancel
  });
});

// ── Task #44 — stable per-job jobId, threaded through runSuite for unambiguous trace/artifact
//    attribution (parallel jobs must never collide or cross-attribute) ─────────────────────────

describe("computeJobId — deterministic, non-random job attribution id", () => {
  it("same suiteId + index + label always produces the same id (stability)", () => {
    expect(computeJobId("suite-abc", 3, "udid-1:My Flow")).toBe(computeJobId("suite-abc", 3, "udid-1:My Flow"));
  });

  it("differs across job index within the same suite (no collision between sibling jobs)", () => {
    expect(computeJobId("suite-abc", 0)).not.toBe(computeJobId("suite-abc", 1));
  });

  it("differs across suiteId for the same index (no collision across separate suite runs)", () => {
    expect(computeJobId("suite-abc", 0)).not.toBe(computeJobId("suite-xyz", 0));
  });

  it("folds in the optional label for readability without affecting the guaranteed-unique prefix", () => {
    const withLabel = computeJobId("suite-abc", 2, "udid-9:Checkout Flow");
    expect(withLabel).toBe("suite-abc:2:udid-9:Checkout Flow");
    expect(withLabel.startsWith("suite-abc:2")).toBe(true);
  });

  it("omitting the label still yields a valid, suite+index-scoped id", () => {
    expect(computeJobId("suite-abc", 5)).toBe("suite-abc:5");
  });
});

describe("runSuite — stable jobId attribution across parallel jobs (task #44)", () => {
  it("every job's ctx.jobId is distinct, even across jobs sharing the same caller-supplied label", async () => {
    const rootDir = makeTmpDir("podium-studio-orch-suite-");
    const seenJobIds: string[] = [];
    // Two jobs deliberately supply the IDENTICAL label (e.g. same udid+flowName run twice in a
    // stability run-set) — runSuite's own index prefix must still keep them distinct.
    const jobs: SuiteJob<string>[] = [
      { jobId: "udid-1:Login Flow", run: async (ctx) => { seenJobIds.push(ctx.jobId); return ctx.jobId; } },
      { jobId: "udid-1:Login Flow", run: async (ctx) => { seenJobIds.push(ctx.jobId); return ctx.jobId; } },
    ];

    const report = await runSuite(jobs, { concurrency: 2, runtimeDir: rootDir });

    expect(new Set(seenJobIds).size).toBe(2); // never cross-attributed despite the identical label
    expect(new Set(report.results).size).toBe(2);
    for (const jobId of report.results) expect(jobId.startsWith(report.suiteId)).toBe(true);
  });

  it("maps each merged-report result back to its own jobId unambiguously across parallel workers", async () => {
    const rootDir = makeTmpDir("podium-studio-orch-suite-");
    // Each job returns an object pairing its own jobId with a per-job payload — the "map each
    // result -> jobId -> artifacts" contract the merged suite report must satisfy.
    const jobs: SuiteJob<{ jobId: string; payload: number }>[] = Array.from({ length: 6 }, (_, i) => ({
      jobId: `job-${i}`,
      run: async (ctx) => {
        await sleep(5); // encourage interleaving across workers, not just sequential completion
        return { jobId: ctx.jobId, payload: i };
      },
    }));

    const report = await runSuite(jobs, { concurrency: 3, runtimeDir: rootDir });

    expect(report.results).toHaveLength(6);
    // Every result's jobId is unique and correctly correlates to ITS OWN payload (i) — proving no
    // cross-attribution occurred even though jobs were sharded round-robin across 3 workers.
    const jobIds = report.results.map((r) => r.jobId);
    expect(new Set(jobIds).size).toBe(6);
    for (const r of report.results) {
      expect(r.jobId.endsWith(`:job-${r.payload}`)).toBe(true);
    }
  });

  it("jobId is stable/deterministic given the same job list — recomputing independently matches what runSuite assigned", async () => {
    const rootDir = makeTmpDir("podium-studio-orch-suite-");
    const jobs: SuiteJob<string>[] = [
      { jobId: "udid-1:Flow A", run: async (ctx) => ctx.jobId },
      { jobId: "udid-2:Flow B", run: async (ctx) => ctx.jobId },
    ];

    const report = await runSuite(jobs, { concurrency: 2, runtimeDir: rootDir });

    // runSuite assigns id `computeJobId(suiteId, index, job.jobId)` for job at position `index`
    // in the ORIGINAL array — independently recomputing it (now that suiteId is known) must
    // match exactly, proving the derivation is deterministic, not randomUUID/Math.random-based.
    expect(report.results[0]).toBe(computeJobId(report.suiteId, 0, "udid-1:Flow A"));
    expect(report.results[1]).toBe(computeJobId(report.suiteId, 1, "udid-2:Flow B"));
  });
});
