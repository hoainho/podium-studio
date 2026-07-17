import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Flow } from "../shared/ir.ts";
import type { RunEvent, RunSummary } from "../shared/protocol.ts";

vi.mock("../bridge/podium.ts", () => ({
  engine: {
    runSteps: vi.fn(),
    runFlowYaml: vi.fn(),
    screenshot: vi.fn(),
    appState: vi.fn(),
    launchApp: vi.fn(),
    terminateApp: vi.fn(),
    setLocation: vi.fn(),
    openUrl: vi.fn(),
    // C6: runFlow waits for the app to render (inspectScreen) before step 1 — resolve "rendered"
    // by default so these tests don't hit the readiness poll timeout.
    inspectScreen: vi.fn().mockResolvedValue({ count: 1 }),
  },
}));

import { engine } from "../bridge/podium.ts";
import {
  bucketRunSet,
  classifyRunOutcome,
  createRunContext,
  isTransientError,
  runFlow,
  type RunContext,
} from "../bridge/runner.ts";

const mockRunSteps = engine.runSteps as unknown as ReturnType<typeof vi.fn>;
const mockRunFlowYaml = engine.runFlowYaml as unknown as ReturnType<typeof vi.fn>;
const mockScreenshot = engine.screenshot as unknown as ReturnType<typeof vi.fn>;
const mockAppState = engine.appState as unknown as ReturnType<typeof vi.fn>;
const mockLaunch = engine.launchApp as unknown as ReturnType<typeof vi.fn>;

function baseFlow(steps: Flow["steps"]): Flow {
  return {
    schemaVersion: 1,
    name: "Robust Execution Flow",
    app: { bundleId: "com.example.app", platform: "ios-sim" },
    steps,
  };
}

async function run(flow: Flow, fixtures: Record<string, unknown> = {}, ctx?: RunContext) {
  const events: RunEvent[] = [];
  const summary = await runFlow("udid-1", flow, fixtures, (e) => events.push(e), ctx);
  return { summary, events };
}

describe("isTransientError", () => {
  it("recognizes common transient failure messages", () => {
    expect(isTransientError("Request timed out after 5000ms")).toBe(true);
    expect(isTransientError("ECONNRESET")).toBe(true);
    expect(isTransientError("socket hang up")).toBe(true);
    expect(isTransientError(undefined)).toBe(false);
  });

  it("does not treat a genuine assertion mismatch as transient", () => {
    expect(isTransientError('assertVisible: text "Welcome" not found')).toBe(false);
  });
});

describe("runFlow — per-action retry gated by idempotency (E2 AC3)", () => {
  beforeEach(() => {
    mockRunSteps.mockReset();
    mockRunFlowYaml.mockReset();
    mockScreenshot.mockReset();
    mockScreenshot.mockResolvedValue(undefined);
    mockAppState.mockReset();
    mockAppState.mockResolvedValue({ installed: true, running: false });
    mockLaunch.mockReset();
    mockLaunch.mockResolvedValue(undefined);
  });

  it("retries a transient failure on an idempotent (default) action and recovers", async () => {
    // waitFor is idempotent by default. Fail once with a transient error, then succeed.
    let calls = 0;
    mockRunSteps.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return { ok: false, results: [{ i: 0, action: "waitFor", ok: false, error: "timed out talking to the sim" }] };
      return { ok: true, results: [{ i: 0, action: "waitFor", ok: true, detail: "done" }] };
    });

    const { summary } = await run(baseFlow([{ id: "s1", action: "waitFor", text: "Home", timeoutMs: 5000 }]));

    expect(mockRunSteps).toHaveBeenCalledTimes(2); // exactly one retry — the side effect (call count) is bounded, not unbounded
    expect(summary.passed).toBe(true);
    expect(summary.results[0].attempts).toBe(2);
  });

  it("never retries a non-idempotent action (tap) even on a transient-looking failure — no double side-effect risk", async () => {
    let calls = 0;
    mockRunSteps.mockImplementation(async () => {
      calls += 1;
      return { ok: false, results: [{ i: 0, action: "tap", ok: false, error: "timed out talking to the sim" }] };
    });

    const { summary } = await run(baseFlow([{ id: "s1", action: "tap", x: 1, y: 2 }]));

    expect(mockRunSteps).toHaveBeenCalledTimes(1); // exactly one attempt — never blindly re-fired
    expect(summary.results[0].attempts).toBe(1);
    expect(summary.passed).toBe(false);
  });

  it("does not retry an idempotent action's genuine (non-transient) failure", async () => {
    mockRunSteps.mockResolvedValue({
      ok: false,
      results: [{ i: 0, action: "assertVisible", ok: false, error: 'text "Welcome" not found' }],
    });

    const { summary } = await run(baseFlow([{ id: "s1", action: "assertVisible", text: "Welcome" }]));

    expect(mockRunSteps).toHaveBeenCalledTimes(1);
    expect(summary.results[0].attempts).toBe(1);
    expect(summary.passed).toBe(false);
  });

  it("an explicit idempotent:true override allows retrying an otherwise non-idempotent action", async () => {
    let calls = 0;
    mockRunSteps.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return { ok: false, results: [{ i: 0, action: "tap", ok: false, error: "network hiccup" }] };
      return { ok: true, results: [{ i: 0, action: "tap", ok: true }] };
    });

    const { summary } = await run(baseFlow([{ id: "s1", action: "tap", x: 1, y: 2, idempotent: true }]));

    expect(mockRunSteps).toHaveBeenCalledTimes(2);
    expect(summary.passed).toBe(true);
  });
});

describe("runFlow — soft assertions (E2 AC5)", () => {
  beforeEach(() => {
    mockRunSteps.mockReset();
    mockScreenshot.mockReset();
    mockScreenshot.mockResolvedValue(undefined);
    mockAppState.mockReset();
    mockAppState.mockResolvedValue({ installed: true, running: false });
    mockLaunch.mockReset();
    mockLaunch.mockResolvedValue(undefined);
  });

  it("a soft-assert failure is recorded as failed-soft and does not halt the run", async () => {
    mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => {
      const s0 = steps[0];
      if (s0.action === "assertVisible") return { ok: false, results: [{ i: 0, action: s0.action, ok: false, error: "not found" }] };
      return { ok: true, results: [{ i: 0, action: s0.action, ok: true }] };
    });

    const flow = baseFlow([
      { id: "s1", action: "assertVisible", text: "Promo banner", soft: true },
      { id: "s2", action: "screenshot" },
    ]);
    const { summary } = await run(flow);

    expect(summary.results).toHaveLength(2);
    expect(summary.results[0].status).toBe("failed-soft");
    expect(summary.results[0].ok).toBe(false);
    // the hard step after the soft failure still executed (was not skipped)
    expect(summary.results[1].status).toBe("passed");
    expect(summary.softFailedCount).toBe(1);
  });

  it("a hard failure recorded distinctly from a soft failure — a hard failure still halts the run", async () => {
    mockRunSteps.mockResolvedValue({ ok: false, results: [{ i: 0, action: "assertVisible", ok: false, error: "not found" }] });

    const flow = baseFlow([
      { id: "s1", action: "assertVisible", text: "Required label" }, // hard (no soft flag)
      { id: "s2", action: "screenshot" },
    ]);
    const { summary } = await run(flow);

    expect(summary.results[0].status).toBe("failed");
    expect(summary.results[1].status).toBe("skipped"); // halted, unlike the soft case above
    expect(summary.softFailedCount).toBe(0);
    expect(summary.passed).toBe(false);
  });
});

describe("runFlow — cancel reports a distinct status (E2 AC6)", () => {
  beforeEach(() => {
    mockRunSteps.mockReset();
    mockScreenshot.mockReset();
    mockScreenshot.mockResolvedValue(undefined);
    mockAppState.mockReset();
    mockAppState.mockResolvedValue({ installed: true, running: false });
    mockLaunch.mockReset();
    mockLaunch.mockResolvedValue(undefined);
  });

  it("cancelling mid-run sets status:'cancelled', distinct from passed/failed", async () => {
    // E15: cancellation is now expressed via THIS run's own RunContext (bridge/orchestrator.ts's
    // cancelRun() is the id-keyed way a caller normally flips this; a test can just mutate the
    // context it already holds directly) — no more module-level requestCancel().
    const ctx = createRunContext();
    let calls = 0;
    mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => {
      calls += 1;
      if (calls === 1) ctx.cancelled = true; // simulate the user hitting Stop after step 1 starts
      return { ok: true, results: [{ i: 0, action: steps[0].action, ok: true }] };
    });

    const flow = baseFlow([
      { id: "s1", action: "screenshot" },
      { id: "s2", action: "screenshot" },
      { id: "s3", action: "screenshot" },
    ]);
    const { summary } = await run(flow, {}, ctx);

    expect(summary.status).toBe("cancelled");
    expect(summary.status).not.toBe("passed");
    expect(summary.status).not.toBe("failed");
    expect(summary.passed).toBe(false);
    expect(summary.results.filter((r) => r.status === "skipped").length).toBeGreaterThan(0);
  });

  it("two concurrent runs with separate RunContexts don't cross-talk: cancelling A never affects B (E15 AC3)", async () => {
    const ctxA = createRunContext();
    const ctxB = createRunContext();
    expect(ctxA.runId).not.toBe(ctxB.runId);

    mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => ({
      ok: true,
      results: [{ i: 0, action: steps[0].action, ok: true }],
    }));

    const flowA = baseFlow([{ id: "a1", action: "screenshot" }, { id: "a2", action: "screenshot" }]);
    const flowB = baseFlow([{ id: "b1", action: "screenshot" }, { id: "b2", action: "screenshot" }]);

    ctxA.cancelled = true; // Run A is cancelled before it even starts stepping — B is untouched
    const [resultA, resultB] = await Promise.all([run(flowA, {}, ctxA), run(flowB, {}, ctxB)]);

    expect(resultA.summary.status).toBe("cancelled");
    expect(resultB.summary.status).toBe("passed");
    expect(resultB.summary.results.every((r) => r.status !== "skipped")).toBe(true);
    // Cancelling A never flipped B's own context.
    expect(ctxB.cancelled).toBe(false);
  });
});

describe("runFlow — captured variables cross the native<->Maestro boundary (E2 AC4)", () => {
  beforeEach(() => {
    mockRunSteps.mockReset();
    mockRunFlowYaml.mockReset();
    mockRunFlowYaml.mockResolvedValue({ ok: true });
    mockScreenshot.mockReset();
    mockScreenshot.mockResolvedValue(undefined);
    mockAppState.mockReset();
    mockAppState.mockResolvedValue({ installed: true, running: false });
    mockLaunch.mockReset();
    mockLaunch.mockResolvedValue(undefined);
  });

  it("a value captured in a native run_steps step is readable in the following compiled Maestro step", async () => {
    mockRunSteps.mockResolvedValue({
      ok: true,
      results: [{ i: 0, action: "waitFor", ok: true, detail: "482913" }],
    });

    const flow = baseFlow([
      { id: "s1", action: "waitFor", text: "OTP code", captureAs: "otp_code" }, // native
      { id: "s2", action: "assertVisible", text: "{{otp_code}}" as string } as any, // will run as native too, but this
      // exercises the SAME capture -> fixtures channel that also feeds compiled Maestro
      // segments' env: block. See the doubleTap case below for the Maestro-side proof.
    ]);
    const { summary } = await run(flow);

    // the interpolated text sent to the second run_steps call must contain the captured value
    const secondCallSteps = mockRunSteps.mock.calls[1][1];
    expect(secondCallSteps[0].text).toBe("482913");
    expect(summary.passed).toBe(true);
  });

  it("a captured value is injected into a compiled Maestro segment's env: block", async () => {
    mockRunSteps.mockResolvedValue({
      ok: true,
      results: [{ i: 0, action: "waitFor", ok: true, detail: "482913" }],
    });

    const flow = baseFlow([
      { id: "s1", action: "waitFor", text: "OTP code", captureAs: "otp_code" }, // native, captures
      { id: "s2", action: "doubleTap", text: "Confirm" }, // extended -> compiled Maestro run_flow
    ]);
    await run(flow);

    expect(mockRunFlowYaml).toHaveBeenCalledTimes(1);
    const yaml = mockRunFlowYaml.mock.calls[0][1] as string;
    expect(yaml).toContain("env:");
    expect(yaml).toContain("otp_code");
    expect(yaml).toContain("482913");
  });
});

describe("classifyRunOutcome / bucketRunSet (E2 AC2 — flaky bucketing)", () => {
  function summary(over: Partial<RunSummary>): RunSummary {
    return {
      runId: "r",
      flowName: "f",
      udid: "u",
      bundleId: "b",
      passed: true,
      status: "passed",
      total: 1,
      passedCount: 1,
      failedCount: 0,
      softFailedCount: 0,
      durationMs: 1,
      startedAt: 0,
      results: [],
      ...over,
    };
  }

  it("a clean pass (no retries) buckets as 'pass'", () => {
    const s = summary({ results: [{ index: 0, stepId: "s1", action: "tap", status: "passed", ok: true, attempts: 1 }] });
    expect(classifyRunOutcome(s)).toBe("pass");
  });

  it("a run that passed only after a step needed a retry buckets as 'flaky'", () => {
    const s = summary({ results: [{ index: 0, stepId: "s1", action: "waitFor", status: "passed", ok: true, attempts: 2 }] });
    expect(classifyRunOutcome(s)).toBe("flaky");
  });

  it("a hard failure buckets as 'fail'", () => {
    const s = summary({ passed: false, status: "failed", failedCount: 1 });
    expect(classifyRunOutcome(s)).toBe("fail");
  });

  it("a cancelled run buckets as 'fail'", () => {
    const s = summary({ passed: false, status: "cancelled" });
    expect(classifyRunOutcome(s)).toBe("fail");
  });

  it("bucketRunSet sums a 20-run set into pass/flaky/fail counts totalling 20", () => {
    const summaries: RunSummary[] = [
      ...Array.from({ length: 17 }, () => summary({ results: [{ index: 0, stepId: "s1", action: "tap", status: "passed", ok: true, attempts: 1 }] })),
      ...Array.from({ length: 2 }, () => summary({ results: [{ index: 0, stepId: "s1", action: "waitFor", status: "passed", ok: true, attempts: 2 }] })),
      summary({ passed: false, status: "failed", failedCount: 1 }),
    ];
    const buckets = bucketRunSet(summaries);
    expect(buckets).toEqual({ pass: 17, flaky: 2, fail: 1, total: 20 });
  });
});
