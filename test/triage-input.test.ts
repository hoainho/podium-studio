import { describe, it, expect } from "vitest";
import type { RunSummary, StepResult } from "../shared/protocol.ts";
import { deriveTriageInput, failedSteps, stepPassedElsewhere } from "../src/triage-input.ts";

/** E22 — the heuristic layer mapping a real StepResult/RunSummary into shared/triage.ts's clean
 * TriageInput shape. Deliberately tested separately from the classifier itself (test/triage.test.ts). */

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-1",
    flowName: "Test",
    udid: "udid-1",
    bundleId: "com.example.app",
    passed: false,
    status: "failed",
    total: 1,
    passedCount: 0,
    failedCount: 1,
    softFailedCount: 0,
    durationMs: 100,
    startedAt: Date.now(),
    results: [],
    ...over,
  };
}

function step(over: Partial<StepResult> = {}): StepResult {
  return { index: 0, stepId: "s1", action: "tapText", status: "failed", ok: false, ...over };
}

describe("stepPassedElsewhere — cross-run flake signal", () => {
  it("finds a passing occurrence of the same stepId in a DIFFERENT run", () => {
    const other = summary({ runId: "run-2", results: [step({ stepId: "s1", ok: true, status: "passed" })] });
    expect(stepPassedElsewhere("s1", "run-1", [other])).toBe(true);
  });

  it("returns false when no other run has this step passing", () => {
    const other = summary({ runId: "run-2", results: [step({ stepId: "s1", ok: false, status: "failed" })] });
    expect(stepPassedElsewhere("s1", "run-1", [other])).toBe(false);
  });

  it("ignores the SAME run (never compares a run against itself)", () => {
    const self = summary({ runId: "run-1", results: [step({ stepId: "s1", ok: true, status: "passed" })] });
    expect(stepPassedElsewhere("s1", "run-1", [self])).toBe(false);
  });

  it("returns false with no other summaries at all (single-run case, honest default)", () => {
    expect(stepPassedElsewhere("s1", "run-1", [])).toBe(false);
  });
});

describe("deriveTriageInput — text-heuristic signal extraction", () => {
  it("extracts a 'no match' signal (selectorMatchCount 0) from a not-found-style message", () => {
    const s = summary({ results: [step({ error: "Không tìm thấy phần tử nào khớp." })] });
    const input = deriveTriageInput(s.results[0], s);
    expect(input.selectorMatchCount).toBe(0);
  });

  it("extracts an explicit ambiguous match count when the message states one", () => {
    const s = summary({ results: [step({ error: "Khớp 3 phần tử với bộ chọn này." })] });
    const input = deriveTriageInput(s.results[0], s);
    expect(input.selectorMatchCount).toBe(3);
  });

  it("extracts a generic ambiguous signal when no explicit count is present", () => {
    const s = summary({ results: [step({ error: "Ambiguous selector match." })] });
    const input = deriveTriageInput(s.results[0], s);
    expect(input.selectorMatchCount).toBeGreaterThan(1);
  });

  it("detects an assertion value mismatch phrase", () => {
    const s = summary({ results: [step({ action: "assertVisible", error: "Expected 120 but found 100" })] });
    const input = deriveTriageInput(s.results[0], s);
    expect(input.assertionValueMismatch).toBe(true);
  });

  it("detects a screen-structure-changed phrase", () => {
    const s = summary({ results: [step({ error: "Screen structure has changed since last run." })] });
    const input = deriveTriageInput(s.results[0], s);
    expect(input.screenStructureChanged).toBe(true);
  });

  it("finds no confident signal for an unrelated error message (undefined, not a guess)", () => {
    const s = summary({ results: [step({ action: "waitMs", error: "Connection reset by peer" })] });
    const input = deriveTriageInput(s.results[0], s);
    expect(input.selectorMatchCount).toBeUndefined();
    expect(input.assertionValueMismatch).toBe(false);
    expect(input.screenStructureChanged).toBe(false);
  });

  it("carries the step's own attempts/action through unchanged", () => {
    const s = summary({ results: [step({ action: "assertVisible", attempts: 3 })] });
    const input = deriveTriageInput(s.results[0], s);
    expect(input.action).toBe("assertVisible");
    expect(input.attempts).toBe(3);
  });

  it("sets passedOnRetry from cross-run history when provided", () => {
    const s = summary({ runId: "run-1", results: [step({ stepId: "s1" })] });
    const other = summary({ runId: "run-2", results: [step({ stepId: "s1", ok: true, status: "passed" })] });
    const input = deriveTriageInput(s.results[0], s, { otherSummaries: [other] });
    expect(input.passedOnRetry).toBe(true);
  });
});

describe("failedSteps", () => {
  it("includes both 'failed' and 'failed-soft' statuses", () => {
    const s = summary({
      results: [
        step({ stepId: "a", status: "failed" }),
        step({ stepId: "b", status: "failed-soft" }),
        step({ stepId: "c", status: "passed", ok: true }),
      ],
    });
    expect(failedSteps(s).map((r) => r.stepId)).toEqual(["a", "b"]);
  });

  it("returns an empty array for an all-passed run", () => {
    const s = summary({ results: [step({ status: "passed", ok: true })] });
    expect(failedSteps(s)).toEqual([]);
  });
});
