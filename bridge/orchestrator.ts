import { mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { cpus } from "node:os";
import { join } from "node:path";
import { createRunContext, type RunContext } from "./runner.ts";
import { workspaceRoot } from "./workspace.ts";

/**
 * E15 — Run orchestrator (janus-specs/R3-reuse-browser/E15-orchestrator.md).
 *
 * Turns suite wall-clock from "sum of every flow's duration" into "the slowest single flow's
 * duration" by sharding a suite across N parallel workers, each with its own isolated
 * (port, profileDir, artifactsDir) — the exact model PILLAR-BROWSER-E2E.md §2 describes for the
 * future browser driver (E16), written here to be 100% driver-agnostic: this file never imports
 * bridge/podium.ts, bridge/driver.ts, or anything mobile/browser-specific. A `SuiteJob` is just a
 * `run(ctx, slot)` callback — the CALLER (bridge/server.ts today; E16's browser wiring
 * tomorrow) decides what that callback actually does with the slot's port/profileDir.
 */

// ── Port pool (AC4: unique port per worker for its lifetime; released ports are reusable) ────

export interface PortPool {
  acquire(): number;
  release(port: number): void;
  readonly size: number;
}

/** Matches PILLAR-BROWSER-E2E.md §2's "remote-debug port : 9223 + i" convention. */
export const DEFAULT_BASE_PORT = 9223;

export function createPortPool(size = 16, basePort = DEFAULT_BASE_PORT): PortPool {
  const available: number[] = [];
  for (let i = size - 1; i >= 0; i--) available.push(basePort + i); // pop() yields basePort first
  const inUse = new Set<number>();
  return {
    size,
    acquire(): number {
      const port = available.pop();
      if (port === undefined) throw new Error(`Port pool exhausted (size ${size}, base ${basePort})`);
      inUse.add(port);
      return port;
    },
    release(port: number): void {
      if (!inUse.delete(port)) return; // already released, or not from this pool — a no-op, not an error
      available.push(port);
    },
  };
}

// ── Profile pool (AC5: isolated profile/artifacts dir per worker) ────────────────────────────

export interface WorkerSlot {
  workerId: number;
  port: number;
  profileDir: string;
  artifactsDir: string;
}

export interface ProfilePool {
  acquire(workerId: number): Promise<WorkerSlot>;
  release(slot: WorkerSlot): Promise<void>;
}

export const DEFAULT_RUNTIME_DIR = join(workspaceRoot(), ".runtime");

/**
 * Mirrors PILLAR-BROWSER-E2E.md §2's `<workspace>/.runtime/profiles/worker-i` +
 * `<run>/w<i>/` layout. Each `acquire()` creates a FRESH, EMPTY profile dir — deleting any
 * leftover first, in case a prior crash left one behind without going through `release()` —
 * since "always start from a clean profile" is the determinism guarantee (Pillar §5.1). Each
 * worker keeps its slot for its ENTIRE shard (one process/profile per worker, reused across that
 * worker's jobs, not per job) and `release()` returns the port to the pool + deletes the profile
 * dir; the artifacts dir is left in place since a report links to it as evidence.
 */
export function createProfilePool(portPool: PortPool, runId: string, rootDir: string = DEFAULT_RUNTIME_DIR): ProfilePool {
  return {
    async acquire(workerId: number): Promise<WorkerSlot> {
      const port = portPool.acquire();
      const profileDir = join(rootDir, "profiles", `worker-${workerId}`);
      const artifactsDir = join(rootDir, "runs", runId, `w${workerId}`);
      await rm(profileDir, { recursive: true, force: true });
      await mkdir(profileDir, { recursive: true });
      await mkdir(artifactsDir, { recursive: true });
      return { workerId, port, profileDir, artifactsDir };
    },
    async release(slot: WorkerSlot): Promise<void> {
      portPool.release(slot.port);
      // Best-effort: a worker's profile dir being already gone or corrupted (AC5's exact
      // scenario) must never throw here, and must never touch any OTHER worker's slot.
      try {
        await rm(slot.profileDir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    },
  };
}

// ── Concurrency cap (AC2: default min(CPU-2, N), user-tunable) ───────────────────────────────

export function computeConcurrency(requested: number, cpuCount: number = cpus().length): number {
  const cpuCap = Math.max(1, cpuCount - 2);
  return Math.max(1, Math.min(requested, cpuCap));
}

// ── Run registry — the per-run-context home that replaces bridge/runner.ts's OLD module-level
//    cancel flag / run counter. This Map is a keyed LOOKUP TABLE, not the kind of ambiguous
//    shared mutable flag being removed: cancelling one runId only ever mutates THAT run's own
//    RunContext object (AC3) — it can never affect any other run, unlike the old single boolean
//    that meant "cancel" was unambiguous only because at most one run ever existed at a time. ──

const activeRuns = new Map<string, RunContext>();

export function registerRun(ctx: RunContext): void {
  activeRuns.set(ctx.runId, ctx);
}

export function unregisterRun(runId: string): void {
  activeRuns.delete(runId);
}

/** Returns true if a run with this id was found (and is now marked cancelled); false for an
 * unknown/already-finished id — mirrors the old `requestCancel()`'s cooperative, best-effort
 * semantics, just scoped to one run instead of "the" run. */
export function cancelRun(runId: string): boolean {
  const ctx = activeRuns.get(runId);
  if (!ctx) return false;
  ctx.cancelled = true;
  return true;
}

export function isRunActive(runId: string): boolean {
  return activeRuns.has(runId);
}

export function activeRunCount(): number {
  return activeRuns.size;
}

// ── Suite sharding + orchestrated parallel execution ──────────────────────────────────────────

export interface SuiteJob<TResult = unknown> {
  /** Optional grouping label, used by `shard: "by-tag"` and for report readability. */
  tag?: string;
  /**
   * Task #44 — optional, human-readable label (e.g. `${udid}:${flowName}`) folded into the
   * DETERMINISTIC per-job id `runSuite` computes for this job (see `computeJobId` below). Purely
   * cosmetic: `runSuite` always prefixes it with the suite id + this job's own array index, so
   * omitting it (or two jobs supplying the same label) can never cause a collision — the index
   * alone already guarantees uniqueness within one `runSuite()` call.
   */
  jobId?: string;
  /** Executes this one job. Receives its own, already-registered RunContext (do NOT
   * register/unregister it yourself — runSuite owns that) — `ctx.jobId` is this job's stable,
   * deterministic attribution id (task #44) — and the WorkerSlot its shard is running under. */
  run: (ctx: RunContext, slot: WorkerSlot) => Promise<TResult>;
}

/**
 * Task #44 — the deterministic id assigned to job `index` of a suite run identified by
 * `suiteId`. Exported for direct unit testing, same rationale as `shardJobs`. Deliberately built
 * from ONLY `suiteId` (the one randomUUID this whole suite ever generates — already permitted by
 * the "no Math.random()/Date.now() for a job id" rule, since it's the top-level run id) plus the
 * job's own position in the CALLER-SUPPLIED, pre-shard `jobs` array (a plain, deterministic
 * integer — never re-derived from shard/worker assignment, which can vary run to run). An
 * optional caller-supplied `label` (typically `${udid}:${flowName}`) is appended purely for
 * human readability; it never affects uniqueness, which the `suiteId:index` prefix alone already
 * guarantees.
 */
export function computeJobId(suiteId: string, index: number, label?: string): string {
  return label ? `${suiteId}:${index}:${label}` : `${suiteId}:${index}`;
}

export interface WorkerReport<TResult = unknown> {
  workerId: number;
  port: number;
  profileDir: string;
  artifactsDir: string;
  results: TResult[];
}

export interface SuiteReport<TResult = unknown> {
  suiteId: string;
  startedAt: number;
  durationMs: number;
  concurrency: number;
  workers: WorkerReport<TResult>[];
  /** Every worker's results flattened, in submission order — the "one merged report" AC1 asks for. */
  results: TResult[];
}

export interface RunSuiteOptions {
  /** Desired parallelism; the actual concurrency used is `computeConcurrency(requested)`
   * (AC2) — defaults to the job count (as parallel as possible, capped by CPU). */
  concurrency?: number;
  shard?: "round-robin" | "by-tag";
  /** Override the port pool (tests only; production callers should omit this). */
  portPool?: PortPool;
  runtimeDir?: string;
}

/** Exported for direct unit testing of the sharding rule itself, independent of job execution. */
export function shardJobs<T extends { tag?: string }>(jobs: T[], n: number, mode: "round-robin" | "by-tag"): T[][] {
  const shards: T[][] = Array.from({ length: Math.max(n, 1) }, () => []);
  if (mode === "by-tag") {
    const byTag = new Map<string, T[]>();
    for (const job of jobs) {
      // Untagged jobs each get their own bucket key so they still spread round-robin across
      // shards rather than all piling onto shard 0 together.
      const key = job.tag ?? `__untagged_${byTag.size}__`;
      if (!byTag.has(key)) byTag.set(key, []);
      byTag.get(key)!.push(job);
    }
    let shardIndex = 0;
    for (const group of byTag.values()) {
      for (const job of group) shards[shardIndex % shards.length].push(job);
      shardIndex += 1; // advance PER GROUP so same-tag jobs land together on one shard
    }
  } else {
    jobs.forEach((job, i) => shards[i % shards.length].push(job));
  }
  return shards;
}

/**
 * Run a suite of jobs across N parallel workers, merging every worker's results into ONE
 * report (AC1/AC6). Each worker acquires ONE (port, profileDir, artifactsDir) slot for its
 * entire shard and releases it (port back to the pool, profile dir deleted) once its shard
 * finishes, success or failure — so a crash partway through one worker's shard never leaks
 * that worker's port or leaves other workers waiting on it.
 */
export async function runSuite<TResult = unknown>(
  jobs: SuiteJob<TResult>[],
  options: RunSuiteOptions = {},
): Promise<SuiteReport<TResult>> {
  const suiteId = randomUUID();
  const startedAt = Date.now();

  if (jobs.length === 0) {
    return { suiteId, startedAt, durationMs: 0, concurrency: 0, workers: [], results: [] };
  }

  const concurrency = computeConcurrency(options.concurrency ?? jobs.length);
  const portPool = options.portPool ?? createPortPool(Math.max(concurrency, 1));
  const profilePool = createProfilePool(portPool, suiteId, options.runtimeDir);

  // Task #44: assign every job its stable, deterministic jobId BEFORE sharding — `shardJobs`
  // below may reorder/redistribute jobs across workers, but each job's id is fixed by its
  // position in THIS original array, so sharding can never change which id a job ends up with.
  const jobsWithIds = jobs.map((job, index) => ({ ...job, jobId: computeJobId(suiteId, index, job.jobId) }));
  const shards = shardJobs(jobsWithIds, concurrency, options.shard ?? "round-robin");

  const workers = await Promise.all(
    shards.map(async (shardJobs, workerId): Promise<WorkerReport<TResult> | null> => {
      if (shardJobs.length === 0) return null; // fewer jobs than concurrency slots — nothing to run here
      const slot = await profilePool.acquire(workerId);
      const results: TResult[] = [];
      try {
        for (const job of shardJobs) {
          // runId stays a fresh randomUUID (unchanged — still the live cancel/WS-correlation
          // key); jobId is the DETERMINISTIC id computed above, threaded through so every
          // artifact/trace/report entry this job produces is attributed to it (task #44).
          const ctx = createRunContext(undefined, job.jobId);
          registerRun(ctx);
          try {
            results.push(await job.run(ctx, slot));
          } finally {
            unregisterRun(ctx.runId);
          }
        }
      } finally {
        await profilePool.release(slot);
      }
      return { workerId, port: slot.port, profileDir: slot.profileDir, artifactsDir: slot.artifactsDir, results };
    }),
  );

  const activeWorkers = workers.filter((w): w is WorkerReport<TResult> => w !== null);
  return {
    suiteId,
    startedAt,
    durationMs: Date.now() - startedAt,
    concurrency,
    workers: activeWorkers,
    results: activeWorkers.flatMap((w) => w.results),
  };
}
