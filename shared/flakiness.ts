/**
 * flakiness.ts — cross-run flakiness trend + quarantine (E23,
 * janus-specs/R4-selfheal-collab/E23-telemetry-flake.md, AC3/AC4).
 *
 * Deterministic threshold/trend calculation — NO AI dependency (explicit epic boundary). Pure
 * and isomorphic: operates on a plain `RunOutcome[]` (one bool + timestamp per past run of the
 * SAME item), not on any bridge/db-specific shape — so it works identically whether that history
 * comes from src/api.ts's `getRunHistory()` (real, flow-level, via E9's existing `/api/db/runs`
 * read path) or a future step-level source (bridge/db's `run_results` table has no read path
 * exposed yet — a disclosed gap, not something this module needs to know about).
 */

export const TREND_WINDOW = 10;
/** >=30% of the last 10 runs failed (AC3's own worked example: "fails 3 of the last 10" is
 * exactly 3/10 = 30% — the trend-rising case and the quarantine-threshold case in the spec are
 * literally the same worked example, not two different numbers). */
export const QUARANTINE_THRESHOLD = 0.3;

export interface RunOutcome {
  runId: string;
  passed: boolean;
  startedAt: number;
}

export interface FlakinessTrendPoint {
  runId: string;
  passed: boolean;
  startedAt: number;
  /** The rolling flaky score (failed / seen-so-far) AFTER including this run, oldest-first — the
   * "rising flaky score" the trend view plots (AC3). */
  flakyScore: number;
}

export interface FlakinessReport {
  /** A flow name, or (once a step-level history source exists) a step id — this module is
   * agnostic to which. */
  key: string;
  /** How many of the last `TREND_WINDOW` runs were actually available (may be < 10 for a
   * brand-new flow/step with little history yet). */
  totalRuns: number;
  failedRuns: number;
  /** failedRuns / totalRuns over the trend window, 0 when there's no history at all (never
   * NaN/Infinity). */
  flakyScore: number;
  /** True once `flakyScore >= QUARANTINE_THRESHOLD` AND there's enough history to judge (a
   * single failed run out of 1 total is 100% but isn't "chronically flaky" yet — see
   * `minRunsForQuarantine` below). */
  quarantined: boolean;
  trend: FlakinessTrendPoint[];
}

/** Below this many total runs, a high flakyScore is just noise (e.g. 1 failed run out of 1 is
 * 100% flaky-score but tells you nothing about a CHRONIC pattern) — AC3's own framing is
 * specifically "3 of the LAST 10," implying a meaningful sample, not a single data point. */
const MIN_RUNS_FOR_QUARANTINE = 3;

/**
 * Compute the flakiness report for one item (flow or step) from its full run history. Only the
 * last `TREND_WINDOW` runs (by `startedAt`) are considered — older runs age out, matching the
 * spec's own "last 10" framing exactly. Never mutates `history`.
 */
export function computeFlakinessReport(key: string, history: RunOutcome[]): FlakinessReport {
  const sorted = [...history].sort((a, b) => a.startedAt - b.startedAt);
  const windowed = sorted.slice(-TREND_WINDOW);

  const trend: FlakinessTrendPoint[] = [];
  let runningFailed = 0;
  for (let i = 0; i < windowed.length; i++) {
    if (!windowed[i].passed) runningFailed++;
    trend.push({ ...windowed[i], flakyScore: runningFailed / (i + 1) });
  }

  const totalRuns = windowed.length;
  const failedRuns = windowed.filter((r) => !r.passed).length;
  const flakyScore = totalRuns > 0 ? failedRuns / totalRuns : 0;
  const quarantined = totalRuns >= MIN_RUNS_FOR_QUARANTINE && flakyScore >= QUARANTINE_THRESHOLD;

  return { key, totalRuns, failedRuns, flakyScore, quarantined, trend };
}

// ─── Manual quarantine override (AC4) ───────────────────────────────────────

export type QuarantineOverride = "quarantined" | "active";

/**
 * The EFFECTIVE quarantine state for gating purposes (AC4): a manual override always wins over
 * the auto-computed threshold — a QA can un-quarantine a flow the threshold would otherwise
 * flag (or, symmetrically, manually quarantine one the threshold hasn't caught yet). With no
 * override recorded, falls back to the auto-computed `report.quarantined`.
 */
export function effectiveQuarantineState(report: FlakinessReport, override: QuarantineOverride | undefined): boolean {
  if (override === "active") return false;
  if (override === "quarantined") return true;
  return report.quarantined;
}

export interface GateItem {
  /** The flow/step identity this outcome belongs to — matched against the quarantine set. */
  key: string;
  passed: boolean;
}

export interface GateResult {
  /** Whether the run should be treated as BLOCKING for gating purposes — true unless every
   * failure belongs to a quarantined item (AC3: "excluded from blocking the pass/fail gate, but
   * still executed and reported" — nothing here removes a failed item from `items` itself). */
  passed: boolean;
  /** The subset of `items` that failed and are NOT quarantined — these are what actually make
   * `passed` false, if any. */
  blockingFailures: GateItem[];
  /** The subset of `items` that failed but ARE quarantined — still reported, just excluded from
   * the gate decision. */
  quarantinedFailures: GateItem[];
}

/**
 * Recompute a run's gating result with quarantine taken into account (AC3/AC4). This is a
 * CLIENT-SIDE re-derivation for the dashboard's own display — the real blocking decision a CI
 * pipeline enforces would need bridge/runner.ts itself to be quarantine-aware (out of scope this
 * round, bridge/ is off-limits) — disclosed, not hidden.
 */
export function computeGateResult(items: GateItem[], quarantinedKeys: ReadonlySet<string>): GateResult {
  const failures = items.filter((i) => !i.passed);
  const blockingFailures = failures.filter((i) => !quarantinedKeys.has(i.key));
  const quarantinedFailures = failures.filter((i) => quarantinedKeys.has(i.key));
  return { passed: blockingFailures.length === 0, blockingFailures, quarantinedFailures };
}
