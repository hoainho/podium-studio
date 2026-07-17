import { describe, it, expect } from "vitest";
import { generateSeededScenarios, runBenchmark } from "../bridge/selfheal-benchmark.ts";

/**
 * E19 AC4 — the actual evidence artifact: a deterministic, re-runnable measurement (not "looks
 * stable") of the ladder's real hit-rate lift over a seeded, mixed-class N=50 run.
 */

describe("selfheal benchmark — E19 AC4 (N=50 seeded-failure heal hit-rate)", () => {
  it("generates exactly N scenarios, mixed roughly evenly across all 4 named failure classes", () => {
    const scenarios = generateSeededScenarios({ count: 50 });
    expect(scenarios).toHaveLength(50);
    const counts: Record<string, number> = {};
    for (const s of scenarios) counts[s.errorClass] = (counts[s.errorClass] ?? 0) + 1;
    for (const cls of ["transient", "element_not_found", "unexpected_screen", "ambiguous"]) {
      expect(counts[cls]).toBeGreaterThan(0);
      // "mixed classes" (spec) — no class dominates; each is within a reasonable band of 50/4.
      expect(counts[cls]).toBeGreaterThanOrEqual(10);
      expect(counts[cls]).toBeLessThanOrEqual(15);
    }
  });

  it("is fully deterministic — re-generating produces the IDENTICAL scenario set (no Math.random)", () => {
    const a = generateSeededScenarios({ count: 50 });
    const b = generateSeededScenarios({ count: 50 });
    expect(a).toEqual(b);
  });

  it("AC4 — baseline (rung 0 only) hit-rate is <=30%, matching the spec's own stated baseline", () => {
    const scenarios = generateSeededScenarios({ count: 50 });
    const result = runBenchmark(scenarios);
    expect(result.total).toBe(50);
    expect(result.baselineHitRate).toBeLessThanOrEqual(0.3);
    // The baseline heals ONLY transient scenarios — rung 0's entire recovery criterion.
    const transientCount = scenarios.filter((s) => s.errorClass === "transient").length;
    expect(result.baselineHealed).toBe(transientCount);
  });

  it("AC4 — enabled (rungs 1-3 + a pre-seeded pinned-lesson set) hit-rate rises to >=70%", () => {
    const scenarios = generateSeededScenarios({ count: 50, coverage: 0.8 });
    const result = runBenchmark(scenarios);
    expect(result.enabledHitRate).toBeGreaterThanOrEqual(0.7);
    // The core claim: enabling the ladder measurably outperforms rung-0-only, on the SAME
    // scenario set (not a different, cherry-picked one for each side of the comparison).
    expect(result.enabledHitRate).toBeGreaterThan(result.baselineHitRate);
  });

  it("a poorly-populated learning store (low coverage) still never heals WORSE than baseline", () => {
    const scenarios = generateSeededScenarios({ count: 50, coverage: 0 });
    const result = runBenchmark(scenarios);
    // Zero rung 1-3 coverage means only transient scenarios heal either way — enabled can never
    // be LESS than baseline (the ladder only ever adds recovery paths, never removes rung 0's).
    expect(result.enabledHitRate).toBeGreaterThanOrEqual(result.baselineHitRate);
  });

  it("a well-populated learning store (full coverage) approaches 100% enabled hit-rate", () => {
    const scenarios = generateSeededScenarios({ count: 50, coverage: 1 });
    const result = runBenchmark(scenarios);
    expect(result.enabledHitRate).toBeGreaterThanOrEqual(0.95);
  });

  it("handles a zero-scenario run without dividing by zero", () => {
    const result = runBenchmark([]);
    expect(result).toEqual({ total: 0, baselineHealed: 0, baselineHitRate: 0, enabledHealed: 0, enabledHitRate: 0 });
  });
});
