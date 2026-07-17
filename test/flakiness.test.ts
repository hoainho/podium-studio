import { describe, it, expect } from "vitest";
import {
  computeFlakinessReport,
  computeGateResult,
  effectiveQuarantineState,
  QUARANTINE_THRESHOLD,
  TREND_WINDOW,
  type RunOutcome,
} from "../shared/flakiness.ts";

/** E23 — flakiness trend + quarantine. AC3: 3/10 (30%) failures -> rising trend AND
 * auto-quarantine (the spec's own worked example uses the SAME number for both). AC4: manual
 * override always wins, in both directions, and gate recomputation genuinely excludes a
 * quarantined item's failure from blocking. */

function outcome(runId: string, passed: boolean, startedAt: number): RunOutcome {
  return { runId, passed, startedAt };
}

function history(pattern: boolean[]): RunOutcome[] {
  // oldest first, passed = pattern[i]
  return pattern.map((passed, i) => outcome(`run-${i}`, passed, i * 1000));
}

describe("computeFlakinessReport — AC3: 3-of-10 (30%) is the shared trend/quarantine threshold", () => {
  it("3 failures out of 10 runs: flakyScore is exactly 0.3 and the item IS quarantined", () => {
    // 7 pass, 3 fail, in whatever order — total 10.
    const h = history([true, true, false, true, true, false, true, true, false, true]);
    const report = computeFlakinessReport("flow-a", h);
    expect(report.totalRuns).toBe(10);
    expect(report.failedRuns).toBe(3);
    expect(report.flakyScore).toBeCloseTo(0.3);
    expect(report.quarantined).toBe(true);
  });

  it("2 failures out of 10 (20%, below threshold): NOT quarantined", () => {
    const h = history([true, true, false, true, true, true, true, false, true, true]);
    const report = computeFlakinessReport("flow-b", h);
    expect(report.flakyScore).toBeCloseTo(0.2);
    expect(report.quarantined).toBe(false);
  });

  it("only considers the last TREND_WINDOW (10) runs — older runs age out", () => {
    // 15 runs: the OLDEST 5 are all failures, the NEWEST 10 are all passes.
    const h = [
      ...history([false, false, false, false, false]).map((o, i) => ({ ...o, startedAt: i })),
      ...history([true, true, true, true, true, true, true, true, true, true]).map((o, i) => ({ ...o, startedAt: 1000 + i })),
    ];
    const report = computeFlakinessReport("flow-c", h);
    expect(report.totalRuns).toBe(10);
    expect(report.failedRuns).toBe(0); // the failing runs aged out of the window
    expect(report.quarantined).toBe(false);
  });

  it("a single failed run (out of 1 total) is NOT quarantined — one data point isn't a chronic pattern", () => {
    const report = computeFlakinessReport("flow-d", history([false]));
    expect(report.flakyScore).toBe(1); // 100% of its (tiny) history failed
    expect(report.quarantined).toBe(false); // but not enough runs to call it chronic
  });

  it("an empty history yields a flakyScore of 0, never NaN, and is not quarantined", () => {
    const report = computeFlakinessReport("flow-e", []);
    expect(report.flakyScore).toBe(0);
    expect(Number.isNaN(report.flakyScore)).toBe(false);
    expect(report.quarantined).toBe(false);
  });

  it("all-passing history has a flat, zero trend and is never quarantined", () => {
    const report = computeFlakinessReport("flow-f", history(Array(10).fill(true)));
    expect(report.quarantined).toBe(false);
    expect(report.trend.every((t) => t.flakyScore === 0)).toBe(true);
  });

  it("the trend RISES monotonically as failures accumulate (oldest to newest)", () => {
    const h = history([true, false, true, false, false, true, true, true, true, true]);
    const report = computeFlakinessReport("flow-g", h);
    // After run 0 (pass): 0/1 = 0. After run 1 (fail): 1/2 = 0.5. After run 4 (3 fails/5): 0.6.
    expect(report.trend[0].flakyScore).toBeCloseTo(0);
    expect(report.trend[1].flakyScore).toBeCloseTo(0.5);
    expect(report.trend[4].flakyScore).toBeCloseTo(0.6);
  });

  it("never mutates the input history array", () => {
    const h = history([true, false, true]);
    const before = JSON.stringify(h);
    computeFlakinessReport("flow-h", h);
    expect(JSON.stringify(h)).toBe(before);
  });

  it("QUARANTINE_THRESHOLD is exactly 0.3 and TREND_WINDOW is exactly 10 (matches the spec verbatim)", () => {
    expect(QUARANTINE_THRESHOLD).toBe(0.3);
    expect(TREND_WINDOW).toBe(10);
  });
});

describe("effectiveQuarantineState — AC4: manual override wins in both directions", () => {
  it("no override: falls back to the auto-computed threshold result", () => {
    const report = computeFlakinessReport("x", history([false, false, false, true, true, true, true, true, true, true]));
    expect(effectiveQuarantineState(report, undefined)).toBe(report.quarantined);
  });

  it("override 'active' un-quarantines an item the threshold WOULD flag", () => {
    const report = computeFlakinessReport("x", history([false, false, false, true, true, true, true, true, true, true]));
    expect(report.quarantined).toBe(true); // sanity: threshold alone says quarantined
    expect(effectiveQuarantineState(report, "active")).toBe(false);
  });

  it("override 'quarantined' quarantines an item the threshold would NOT flag", () => {
    const report = computeFlakinessReport("x", history(Array(10).fill(true)));
    expect(report.quarantined).toBe(false); // sanity
    expect(effectiveQuarantineState(report, "quarantined")).toBe(true);
  });
});

describe("computeGateResult — AC3/AC4: quarantined failures never block the gate, still reported", () => {
  it("a quarantined item's failure does not make the gate fail, but IS still listed", () => {
    const items = [
      { key: "flow-a", passed: false },
      { key: "flow-b", passed: true },
    ];
    const result = computeGateResult(items, new Set(["flow-a"]));
    expect(result.passed).toBe(true); // gate passes — the only failure is quarantined
    expect(result.quarantinedFailures).toEqual([{ key: "flow-a", passed: false }]);
    expect(result.blockingFailures).toEqual([]);
  });

  it("a NON-quarantined failure still blocks the gate", () => {
    const items = [{ key: "flow-a", passed: false }];
    const result = computeGateResult(items, new Set());
    expect(result.passed).toBe(false);
    expect(result.blockingFailures).toEqual([{ key: "flow-a", passed: false }]);
  });

  it("un-quarantining (AC4) takes effect immediately on the NEXT computeGateResult call", () => {
    const items = [{ key: "flow-a", passed: false }];
    const beforeUnquarantine = computeGateResult(items, new Set(["flow-a"]));
    expect(beforeUnquarantine.passed).toBe(true);
    const afterUnquarantine = computeGateResult(items, new Set()); // "flow-a" removed from the quarantine set
    expect(afterUnquarantine.passed).toBe(false);
    expect(afterUnquarantine.blockingFailures).toEqual([{ key: "flow-a", passed: false }]);
  });

  it("an all-passing run always passes the gate regardless of quarantine set", () => {
    const items = [{ key: "flow-a", passed: true }];
    expect(computeGateResult(items, new Set(["flow-a"])).passed).toBe(true);
  });
});
