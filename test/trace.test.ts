import { describe, it, expect } from "vitest";
import type { Flow, FlowStep } from "../shared/ir.ts";
import type { RunSummary, StepResult } from "../shared/protocol.ts";
import { buildTrace, traceToJson } from "../src/trace.ts";

/**
 * E18 (Tags/suites + trace/time-travel viewer). Covers `buildTrace` (spec AC2: step-by-step
 * timeline with per-step status/duration/captured-variables, and the before/after screenshot
 * chaining that makes step N's "before" identically equal step N-1's real "after" — never
 * reconstructed/approximated, exactly the review gate's own wording).
 */

function makeFlow(steps: FlowStep[]): Flow {
  return {
    schemaVersion: 1,
    name: "Trace test flow",
    app: { bundleId: "com.example.app", platform: "ios-sim" },
    steps,
  };
}

function makeResult(over: Partial<StepResult> & { index: number; stepId: string }): StepResult {
  return { action: "tap", status: "passed", ok: true, ...over };
}

function makeSummary(results: StepResult[], over: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: "run-1",
    flowName: "Trace test flow",
    udid: "udid-1",
    bundleId: "com.example.app",
    passed: true,
    status: "passed",
    total: results.length,
    passedCount: results.filter((r) => r.status === "passed").length,
    failedCount: results.filter((r) => r.status === "failed").length,
    softFailedCount: 0,
    durationMs: 1000,
    startedAt: 5000,
    results,
    ...over,
  };
}

describe("buildTrace — step-by-step timeline (spec AC2)", () => {
  it("produces one TraceStep per StepResult, in the same order", () => {
    const flow = makeFlow([
      { id: "s1", action: "tap", x: 1, y: 1 },
      { id: "s2", action: "assertVisible", text: "ok" } as FlowStep,
    ]);
    const summary = makeSummary([
      makeResult({ index: 0, stepId: "s1" }),
      makeResult({ index: 1, stepId: "s2", action: "assertVisible" }),
    ]);
    const trace = buildTrace(flow, summary);
    expect(trace.steps).toHaveLength(2);
    expect(trace.steps.map((s) => s.stepId)).toEqual(["s1", "s2"]);
    expect(trace.runId).toBe("run-1");
    expect(trace.flowName).toBe("Trace test flow");
    expect(trace.passed).toBe(true);
  });

  it("chains before/after screenshots: step N's before === step N-1's after, never reconstructed", () => {
    const flow = makeFlow([
      { id: "s1", action: "tap", x: 1, y: 1 },
      { id: "s2", action: "tap", x: 2, y: 2 },
      { id: "s3", action: "tap", x: 3, y: 3 },
    ]);
    const summary = makeSummary([
      makeResult({ index: 0, stepId: "s1", screenshot: "shot-0.png" }),
      makeResult({ index: 1, stepId: "s2", screenshot: "shot-1.png" }),
      makeResult({ index: 2, stepId: "s3", screenshot: "shot-2.png" }),
    ]);
    const trace = buildTrace(flow, summary);
    expect(trace.steps[0].beforeScreenshot).toBeUndefined(); // nothing came before step 0
    expect(trace.steps[0].afterScreenshot).toBe("shot-0.png");
    expect(trace.steps[1].beforeScreenshot).toBe("shot-0.png"); // == step 0's real after
    expect(trace.steps[1].afterScreenshot).toBe("shot-1.png");
    expect(trace.steps[2].beforeScreenshot).toBe("shot-1.png"); // == step 1's real after
    expect(trace.steps[2].afterScreenshot).toBe("shot-2.png");
  });

  it("a step with no screenshot doesn't break the chain for the step after it", () => {
    const flow = makeFlow([
      { id: "s1", action: "waitMs", ms: 10 },
      { id: "s2", action: "tap", x: 1, y: 1 },
    ]);
    const summary = makeSummary([
      makeResult({ index: 0, stepId: "s1", action: "waitMs", screenshot: undefined }),
      makeResult({ index: 1, stepId: "s2", screenshot: "shot-1.png" }),
    ]);
    const trace = buildTrace(flow, summary);
    expect(trace.steps[0].afterScreenshot).toBeUndefined();
    expect(trace.steps[1].beforeScreenshot).toBeUndefined(); // still nothing to show before it
    expect(trace.steps[1].afterScreenshot).toBe("shot-1.png");
  });

  it("computes duration from startedAt/finishedAt, matching the real StepResult timing", () => {
    const flow = makeFlow([{ id: "s1", action: "tap", x: 1, y: 1 }]);
    const summary = makeSummary([makeResult({ index: 0, stepId: "s1", startedAt: 1000, finishedAt: 1250 })]);
    const trace = buildTrace(flow, summary);
    expect(trace.steps[0].durationMs).toBe(250);
  });

  it("omits duration when timing is missing rather than inventing a value", () => {
    const flow = makeFlow([{ id: "s1", action: "tap", x: 1, y: 1 }]);
    const summary = makeSummary([makeResult({ index: 0, stepId: "s1" })]);
    const trace = buildTrace(flow, summary);
    expect(trace.steps[0].durationMs).toBeUndefined();
  });

  it("surfaces a captureAs step's captured name + value (spec AC2 'captured variables')", () => {
    const flow = makeFlow([{ id: "s1", action: "copyText", text: "Balance", captureAs: "balance" } as FlowStep]);
    const summary = makeSummary([makeResult({ index: 0, stepId: "s1", action: "copyText", detail: "1,234" })]);
    const trace = buildTrace(flow, summary);
    expect(trace.steps[0].capturedName).toBe("balance");
    expect(trace.steps[0].capturedValue).toBe("1,234");
  });

  it("never reports a captured value for a step that failed, even if it declared captureAs", () => {
    const flow = makeFlow([{ id: "s1", action: "copyText", text: "Balance", captureAs: "balance" } as FlowStep]);
    const summary = makeSummary([makeResult({ index: 0, stepId: "s1", action: "copyText", status: "failed", ok: false, detail: "1,234" })]);
    const trace = buildTrace(flow, summary);
    expect(trace.steps[0].capturedName).toBe("balance"); // still shows what WOULD have been captured
    expect(trace.steps[0].capturedValue).toBeUndefined(); // but never a value from a failed step
  });

  it("falls back to the raw action name when a step's own flow definition can't be found", () => {
    const flow = makeFlow([{ id: "s1", action: "tap", x: 1, y: 1 }]);
    // A stepId with no matching flow step (e.g. a stale trace against an edited flow).
    const summary = makeSummary([makeResult({ index: 0, stepId: "unknown-id", action: "tapText" })]);
    const trace = buildTrace(flow, summary);
    expect(trace.steps[0].label).toBe("tapText");
  });

  it("recurses into if/repeat containers (E4) to resolve a child step's label", () => {
    const flow = makeFlow([
      {
        id: "s1", action: "if", when: { text: "Popup" },
        then: [{ id: "s1a", action: "tapText", text: "Đóng" } as FlowStep],
      } as FlowStep,
    ]);
    // Per bridge/runner.ts, only the CONTAINER itself gets a StepResult (its children are
    // compiled into one Maestro run_flow) — this proves buildTrace still resolves that
    // container's own label correctly even though it has nested children.
    const summary = makeSummary([makeResult({ index: 0, stepId: "s1", action: "if" })]);
    const trace = buildTrace(flow, summary);
    expect(trace.steps[0].label.length).toBeGreaterThan(0);
  });

  it("carries error/detail straight from the real StepResult, never altering it", () => {
    const flow = makeFlow([{ id: "s1", action: "assertVisible", text: "ok" } as FlowStep]);
    const summary = makeSummary([
      makeResult({ index: 0, stepId: "s1", action: "assertVisible", status: "failed", ok: false, error: "not visible" }),
    ]);
    const trace = buildTrace(flow, summary);
    expect(trace.steps[0].error).toBe("not visible");
    expect(trace.steps[0].status).toBe("failed");
  });
});

describe("traceToJson", () => {
  it("produces valid, parseable JSON that round-trips the trace", () => {
    const flow = makeFlow([{ id: "s1", action: "tap", x: 1, y: 1 }]);
    const summary = makeSummary([makeResult({ index: 0, stepId: "s1" })]);
    const trace = buildTrace(flow, summary);
    const json = traceToJson(trace);
    expect(JSON.parse(json)).toEqual(trace);
  });
});
