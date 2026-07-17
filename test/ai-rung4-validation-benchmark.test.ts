import { describe, it, expect } from "vitest";
import { generateRung4ValidationCases, runRung4ValidationBenchmark } from "../bridge/ai-rung4-validation-benchmark.ts";

describe("ai-rung4 validation benchmark — E24 AC2 (N=20 seeded rung-4 scenarios)", () => {
  it("generates exactly N=20 cases, split legal/illegal", () => {
    const cases = generateRung4ValidationCases();
    expect(cases).toHaveLength(20);
    expect(cases.filter((c) => c.expectLegal)).toHaveLength(10);
    expect(cases.filter((c) => !c.expectLegal)).toHaveLength(10);
  });

  it("is fully deterministic — re-generating produces the IDENTICAL case set", () => {
    expect(generateRung4ValidationCases()).toEqual(generateRung4ValidationCases());
  });

  it("AC2 — 100% of illegal/out-of-bounds outputs are discarded, 0 executed", async () => {
    const result = await runRung4ValidationBenchmark(generateRung4ValidationCases());
    expect(result.total).toBe(20);
    expect(result.illegalTotal).toBe(10);
    expect(result.illegalDiscardedCount).toBe(10);
    expect(result.allIllegalDiscarded).toBe(true);
  });

  it("every legal, in-allowlist candidate IS executed — the validator isn't over-conservative either", async () => {
    const result = await runRung4ValidationBenchmark(generateRung4ValidationCases());
    expect(result.legalTotal).toBe(10);
    expect(result.legalExecutedCount).toBe(10);
    expect(result.allLegalExecuted).toBe(true);
  });

  it("every single case's actual verdict matches its seeded expectation (the validator log itself, not just the aggregate counts)", async () => {
    const result = await runRung4ValidationBenchmark(generateRung4ValidationCases());
    const mismatches = result.rows.filter((r) => !r.matchesExpectation);
    expect(mismatches, JSON.stringify(mismatches, null, 2)).toEqual([]);
  });

  it("handles a zero-scenario run without dividing by zero", async () => {
    const result = await runRung4ValidationBenchmark([]);
    expect(result).toMatchObject({ total: 0, illegalDiscardedCount: 0, illegalTotal: 0, legalExecutedCount: 0, legalTotal: 0, allIllegalDiscarded: true, allLegalExecuted: true });
  });
});
