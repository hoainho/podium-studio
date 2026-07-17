import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Flow } from "../shared/ir.ts";
import type { RunEvent } from "../shared/protocol.ts";

// Mock the exact specifier runner.ts imports ("./podium.ts" relative to bridge/),
// which resolves to the same module as "../bridge/podium.ts" from here.
vi.mock("../bridge/podium.ts", () => ({
  engine: {
    runSteps: vi.fn(),
    screenshot: vi.fn(),
    appState: vi.fn(),
    launchApp: vi.fn(),
    terminateApp: vi.fn(),
    setLocation: vi.fn(),
    openUrl: vi.fn(),
    inspectScreen: vi.fn(),
  },
}));

import { engine } from "../bridge/podium.ts";
import { createRunContext, runFlow, waitForAppReady, pickNavBackButtonCenter, type AiRecoveryHooks } from "../bridge/runner.ts";
import type { AiProvider } from "../shared/ai-types.ts";

const mockRunSteps = engine.runSteps as unknown as ReturnType<typeof vi.fn>;
const mockScreenshot = engine.screenshot as unknown as ReturnType<typeof vi.fn>;
const mockAppState = engine.appState as unknown as ReturnType<typeof vi.fn>;
const mockLaunch = engine.launchApp as unknown as ReturnType<typeof vi.fn>;
const mockInspect = engine.inspectScreen as unknown as ReturnType<typeof vi.fn>;

function makeFlow(): Flow {
  return {
    schemaVersion: 1,
    name: "Two Step Flow",
    app: { bundleId: "com.example.app", platform: "ios-sim" },
    steps: [
      { id: "s1", action: "screenshot" },
      { id: "s2", action: "screenshot" },
    ],
  };
}

describe("runFlow", () => {
  beforeEach(() => {
    mockRunSteps.mockReset();
    mockScreenshot.mockReset();
    mockScreenshot.mockResolvedValue(undefined);
    mockAppState.mockReset();
    mockAppState.mockResolvedValue({ installed: true, running: false });
    mockLaunch.mockReset();
    mockLaunch.mockResolvedValue(undefined);
    // C6: runFlow now waits for the app to render before step 1 — default to "already rendered"
    // so these runFlow tests don't hit the readiness poll timeout.
    mockInspect.mockReset();
    mockInspect.mockResolvedValue({ count: 3 });
  });

  it("emits run:start, per-step start/result, and run:end with passed=true when all steps pass", async () => {
    mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => ({
      ok: true,
      results: [{ i: 0, action: steps[0].action, ok: true, detail: "done" }],
    }));

    const events: RunEvent[] = [];
    const summary = await runFlow("udid-1", makeFlow(), {}, (e) => events.push(e));

    expect(summary.passed).toBe(true);
    expect(summary.failedCount).toBe(0);
    expect(summary.passedCount).toBe(2);
    expect(summary.total).toBe(2);

    const types = events.map((e) => e.type);
    expect(types[0]).toBe("run:start");
    expect(types).toContain("step:start");
    expect(types).toContain("step:result");
    expect(types[types.length - 1]).toBe("run:end");

    const stepStarts = events.filter((e) => e.type === "step:start");
    expect(stepStarts).toHaveLength(2);

    const stepResults = events.filter((e) => e.type === "step:result");
    expect(stepResults).toHaveLength(2);
    for (const e of stepResults as Extract<RunEvent, { type: "step:result" }>[]) {
      expect(e.result.status).toBe("passed");
      expect(e.result.ok).toBe(true);
    }

    const runEnd = events.find((e) => e.type === "run:end") as Extract<RunEvent, { type: "run:end" }>;
    expect(runEnd.summary.passed).toBe(true);
  });

  // Task #44 — stable per-job attribution id, threaded from RunContext.jobId into RunSummary
  // and into the screenshot path each step's evidence is written under.
  it("jobId defaults to runId for a plain single-flow run (unchanged /api/run behavior)", async () => {
    mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => ({
      ok: true,
      results: [{ i: 0, action: steps[0].action, ok: true, detail: "done" }],
    }));

    const ctx = createRunContext();
    const summary = await runFlow("udid-1", makeFlow(), {}, () => {}, ctx);

    expect(ctx.jobId).toBe(ctx.runId);
    expect(summary.jobId).toBe(summary.runId);
  });

  it("a caller-supplied jobId (e.g. a runSuite job) is used for the screenshot path and copied onto the summary, distinct from runId", async () => {
    mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => ({
      ok: true,
      results: [{ i: 0, action: steps[0].action, ok: true, detail: "done" }],
    }));

    const ctx = createRunContext(undefined, "suite-123:0:udid-1:Two Step Flow");
    const summary = await runFlow("udid-1", makeFlow(), {}, () => {}, ctx);

    expect(summary.jobId).toBe("suite-123:0:udid-1:Two Step Flow");
    expect(summary.jobId).not.toBe(summary.runId); // jobId is deterministic; runId is still the fresh random one
    expect(summary.results[0].screenshot).toContain("suite-123:0:udid-1:Two Step Flow");
  });

  it("stops after the first failing step: remaining steps are skipped and the run fails", async () => {
    mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => ({
      ok: false,
      results: [{ i: 0, action: steps[0].action, ok: false, detail: "boom" }],
    }));

    const events: RunEvent[] = [];
    const summary = await runFlow("udid-1", makeFlow(), {}, (e) => events.push(e));

    expect(summary.passed).toBe(false);
    expect(summary.failedCount).toBe(1);
    expect(summary.passedCount).toBe(0);

    // engine.runSteps should only have been invoked once — the run stops, it doesn't
    // continue calling the engine for skipped steps.
    expect(mockRunSteps).toHaveBeenCalledTimes(1);

    const stepResults = (events.filter((e) => e.type === "step:result") as Extract<
      RunEvent,
      { type: "step:result" }
    >[]).map((e) => e.result);
    expect(stepResults).toHaveLength(2);
    expect(stepResults[0].status).toBe("failed");
    expect(stepResults[0].ok).toBe(false);
    expect(stepResults[1].status).toBe("skipped");
    expect(stepResults[1].ok).toBe(false);
    expect(stepResults[1].stepId).toBe("s2");

    const runEnd = events.find((e) => e.type === "run:end") as Extract<RunEvent, { type: "run:end" }>;
    expect(runEnd.summary.passed).toBe(false);
    expect(runEnd.summary.failedCount).toBe(1);
  });

  describe("secrets redaction (R2 review fix — security BLOCKER)", () => {
    const SECRET_ENV_VAR = "PODIUM_SECRET_RUNNER_TEST_PASSWORD";
    const SECRET_VALUE = "hunter2-runner-blocker-fix";

    beforeEach(() => {
      process.env[SECRET_ENV_VAR] = SECRET_VALUE;
    });

    afterEach(() => {
      delete process.env[SECRET_ENV_VAR];
    });

    function makeSecretFlow(): Flow {
      return {
        schemaVersion: 1,
        name: "Secret Flow",
        app: { bundleId: "com.example.app", platform: "ios-sim" },
        steps: [{ id: "s1", action: "type", text: "${secret:runner-test-password}" } as any],
      };
    }

    it("the RETURNED summary (not just the emitted WS event) has the resolved secret redacted", async () => {
      // Simulate a real Maestro/Podium failure message that echoes back whatever was typed —
      // this is exactly how a secret could leak: the step's own error/detail field, not just a
      // log line. The mock only sees what stepToPodium() resolved `text` to, so if the returned
      // `steps[0].text` is `hunter2-...` (not the literal token), the secrets seam DID resolve
      // it — that's the leak surface this test proves gets redacted before it ever leaves runFlow.
      mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => ({
        ok: false,
        results: [{ i: 0, action: steps[0].action, ok: false, error: `assertion failed on "${steps[0].text}"` }],
      }));

      const events: RunEvent[] = [];
      const summary = await runFlow("udid-1", makeSecretFlow(), {}, (e) => events.push(e));

      // Prove the secret really was resolved and used (not left as a literal, unresolved token).
      expect(mockRunSteps).toHaveBeenCalled();
      const dispatchedText = (mockRunSteps.mock.calls[0][1] as any[])[0].text;
      expect(dispatchedText).toBe(SECRET_VALUE);

      // The BLOCKER: the raw resolved value must never appear in the summary this function
      // RETURNS — that's what bridge/server.ts both persists (primaryStore.insertRun) and sends
      // back as the HTTP response, a completely separate path from the WS `emit()` events.
      expect(summary.results[0].error).not.toContain(SECRET_VALUE);
      expect(summary.results[0].error).toContain("[secret redacted]");

      // The WS event path must be redacted too (this part already worked before the fix).
      const runEnd = events.find((e) => e.type === "run:end") as Extract<RunEvent, { type: "run:end" }>;
      expect(runEnd.summary.results[0].error).not.toContain(SECRET_VALUE);

      // Both paths must agree — they're now built from the SAME redacted object.
      expect(summary).toEqual(runEnd.summary);
    });

    it("a step:result event emitted mid-run is also redacted (unchanged behavior, still covered)", async () => {
      mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => ({
        ok: true,
        results: [{ i: 0, action: steps[0].action, ok: true, detail: `typed ${steps[0].text}` }],
      }));

      const events: RunEvent[] = [];
      await runFlow("udid-1", makeSecretFlow(), {}, (e) => events.push(e));

      const stepResult = events.find((e) => e.type === "step:result") as Extract<RunEvent, { type: "step:result" }>;
      expect(stepResult.result.detail).not.toContain(SECRET_VALUE);
    });
  });

  describe("self-heal (E19) — fully opt-in, wired via runFlow's optional 6th parameter", () => {
    function makeLocatorFlow(): Flow {
      return {
        schemaVersion: 1,
        name: "Login Flow",
        app: { bundleId: "com.example.app", platform: "ios-sim" },
        steps: [{ id: "s1", action: "tapText", text: "Log In (old)" } as any],
      };
    }

    function noopHooks(overrides: Partial<Parameters<typeof runFlow>[5]> = {}) {
      return {
        getScreenElements: vi.fn().mockResolvedValue([]),
        getSelectorCandidates: vi.fn().mockReturnValue([]),
        getInterstitial: vi.fn().mockReturnValue(undefined),
        getPinnedLessons: vi.fn().mockReturnValue([]),
        getBestOutcome: vi.fn().mockReturnValue(undefined),
        ...overrides,
      };
    }

    it("omitting selfHeal entirely behaves EXACTLY like before this epic — a hard failure just fails, no healedRung", async () => {
      mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => ({
        ok: false,
        results: [{ i: 0, action: steps[0].action, ok: false, error: "element not found" }],
      }));
      const summary = await runFlow("udid-1", makeLocatorFlow(), {}, () => {});
      expect(summary.passed).toBe(false);
      expect(summary.results[0].healedRung).toBeUndefined();
    });

    it("rung 1 heals a locator failure: retries with the re-resolved text, step ends passed with healedRung=1", async () => {
      let call = 0;
      mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => {
        call += 1;
        if (call === 1) return { ok: false, results: [{ i: 0, action: steps[0].action, ok: false, error: "element not found" }] };
        // The healed retry: prove the LOCATOR was actually swapped, not just re-sent identically.
        expect(steps[0].text).toBe("Log In");
        return { ok: true, results: [{ i: 0, action: steps[0].action, ok: true, detail: "tapped" }] };
      });

      const onHealAttempt = vi.fn();
      const summary = await runFlow(
        "udid-1", makeLocatorFlow(), {}, () => {}, undefined,
        noopHooks({
          getScreenElements: vi.fn().mockResolvedValue([{ text: "Log In" }]),
          getSelectorCandidates: vi.fn().mockReturnValue([
            { id: "m1", screenFingerprint: "fp", elementKey: "Log In (old)", locatorKind: "text", locatorValue: "Log In", timesResolved: 3 },
          ]),
          onHealAttempt,
        }),
      );

      expect(summary.passed).toBe(true);
      expect(summary.results[0].status).toBe("passed");
      expect(summary.results[0].healedRung).toBe(1);
      expect(summary.results[0].attempts).toBe(2); // rung 0's one attempt + the healed retry
      expect(onHealAttempt).toHaveBeenCalledTimes(1);
      expect(onHealAttempt.mock.calls[0][0].attempt.healed).toBe(true);
      // MAJOR (R4 code-review gate) — onHealAttempt must see the REAL, verified retry result.
      expect(onHealAttempt.mock.calls[0][0].succeeded).toBe(true);
      // E19 gap-fix — the "save this fix?" patch itself must land on the StepResult, not just
      // the bare rung number, or the approval UI has nothing to show/pin.
      expect(summary.results[0].pendingHeal).toMatchObject({ healType: "locator", rung: 1 });
    });

    it("MAJOR (R4 code-review gate) — a candidate is found but the healed retry ITSELF fails: onHealAttempt fires with succeeded=false, and the step stays failed (no healedRung)", async () => {
      mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => ({
        ok: false,
        results: [{ i: 0, action: steps[0].action, ok: false, error: "element not found" }],
      }));

      const onHealAttempt = vi.fn();
      const summary = await runFlow(
        "udid-1", makeLocatorFlow(), {}, () => {}, undefined,
        noopHooks({
          getScreenElements: vi.fn().mockResolvedValue([{ text: "Log In" }]),
          getSelectorCandidates: vi.fn().mockReturnValue([
            { id: "m1", screenFingerprint: "fp", elementKey: "Log In (old)", locatorKind: "text", locatorValue: "Log In", timesResolved: 3 },
          ]),
          onHealAttempt,
        }),
      );

      // Both the rung-0 attempt AND the healed retry hit engine.runSteps, and BOTH failed.
      expect(mockRunSteps).toHaveBeenCalledTimes(2);
      expect(summary.passed).toBe(false);
      expect(summary.results[0].healedRung).toBeUndefined();
      expect(summary.results[0].pendingHeal).toBeUndefined();
      expect(onHealAttempt).toHaveBeenCalledTimes(1);
      // The core MAJOR-finding assertion: succeeded reflects the retry's REAL outcome, not just
      // "a candidate/known recovery was found" (attempt.healed is true here, succeeded is not).
      expect(onHealAttempt.mock.calls[0][0].attempt.healed).toBe(true);
      expect(onHealAttempt.mock.calls[0][0].succeeded).toBe(false);
    });

    it("MINOR (R4 code-review gate) — a rung-1 'position' recovery maps to the step's x/y fields, not text", async () => {
      let call = 0;
      mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => {
        call += 1;
        if (call === 1) return { ok: false, results: [{ i: 0, action: steps[0].action, ok: false, error: "element not found" }] };
        expect(steps[0].x).toBe(120);
        expect(steps[0].y).toBe(340);
        expect(steps[0].text).toBeUndefined();
        return { ok: true, results: [{ i: 0, action: steps[0].action, ok: true, detail: "tapped" }] };
      });

      const summary = await runFlow(
        "udid-1", makeLocatorFlow(), {}, () => {}, undefined,
        noopHooks({
          getScreenElements: vi.fn().mockResolvedValue([{ text: "Log In" }]),
          getSelectorCandidates: vi.fn().mockReturnValue([
            { id: "m1", screenFingerprint: "fp", elementKey: "Log In (old)", locatorKind: "position", locatorValue: "120,340", timesResolved: 3 },
          ]),
        }),
      );

      expect(summary.passed).toBe(true);
      expect(summary.results[0].healedRung).toBe(1);
    });

    it("MINOR (R4 code-review gate) — a rung-1 'role'/'nearbyLabel' recovery is NEVER silently coerced into text: the IR has no field for either, so the retry is reported as unresolvable rather than guessed", async () => {
      mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => ({
        ok: false,
        results: [{ i: 0, action: steps[0].action, ok: false, error: "element not found" }],
      }));

      const summary = await runFlow(
        "udid-1", makeLocatorFlow(), {}, () => {}, undefined,
        noopHooks({
          getScreenElements: vi.fn().mockResolvedValue([{ text: "Log In" }]),
          getSelectorCandidates: vi.fn().mockReturnValue([
            { id: "m1", screenFingerprint: "fp", elementKey: "Log In (old)", locatorKind: "role", locatorValue: "button", timesResolved: 3 },
          ]),
        }),
      );

      // Only rung 0's original attempt ever reaches engine.runSteps — applyRecoveryAndRetry
      // refuses to fabricate a step for a locator kind the IR can't express, rather than
      // silently (and wrongly) searching for an element whose literal text is "button".
      expect(mockRunSteps).toHaveBeenCalledTimes(1);
      expect(summary.passed).toBe(false);
      expect(summary.results[0].healedRung).toBeUndefined();
    });

    it("E19 gap-fix — a brand-new lesson's id (returned by onHealAttempt) is correlated onto StepResult.pendingHeal.lessonId", async () => {
      let call = 0;
      mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => {
        call += 1;
        if (call === 1) return { ok: false, results: [{ i: 0, action: steps[0].action, ok: false, error: "element not found" }] };
        return { ok: true, results: [{ i: 0, action: steps[0].action, ok: true, detail: "tapped" }] };
      });

      // Models createLiveSelfHealHooks' real contract: awaited, resolves to the freshly-inserted
      // lesson's id — proving the run loop actually reads and uses this return value.
      const onHealAttempt = vi.fn().mockResolvedValue("fresh-lesson-id");
      const summary = await runFlow(
        "udid-1", makeLocatorFlow(), {}, () => {}, undefined,
        noopHooks({
          getScreenElements: vi.fn().mockResolvedValue([{ text: "Log In" }]),
          getSelectorCandidates: vi.fn().mockReturnValue([
            { id: "m1", screenFingerprint: "fp", elementKey: "Log In (old)", locatorKind: "text", locatorValue: "Log In", timesResolved: 3 },
          ]),
          onHealAttempt,
        }),
      );

      expect(summary.results[0].pendingHeal?.lessonId).toBe("fresh-lesson-id");
    });

    it("E19 gap-fix — a rung-3 replay of an already-pinned lesson keeps ITS OWN lessonId, never overwritten by onHealAttempt's return", async () => {
      let call = 0;
      mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => {
        call += 1;
        if (call === 1) return { ok: false, results: [{ i: 0, action: steps[0].action, ok: false, error: "element not found" }] };
        return { ok: true, results: [{ i: 0, action: steps[0].action, ok: true, detail: "tapped" }] };
      });

      const summary = await runFlow(
        "udid-1", makeLocatorFlow(), {}, () => {}, undefined,
        noopHooks({
          getScreenElements: vi.fn().mockResolvedValue([{ text: "Log In" }]),
          getPinnedLessons: vi.fn().mockReturnValue([
            {
              id: "existing-lesson-1", screenFingerprint: "fp", errorClass: "element_not_found",
              stepIntent: "tapText Log In", healType: "locator", rung: 1,
              recovery: { kind: "text", value: "Log In" }, topLabels: [], pinned: true, createdAt: 1,
            },
          ]),
          // A rung-3 replay must never even need to insert a new lesson — proves the "keep the
          // patch's own lessonId" branch, not "onHealAttempt happened to return nothing".
          onHealAttempt: vi.fn().mockResolvedValue("should-never-be-used"),
        }),
      );

      expect(summary.results[0].healedRung).toBe(3);
      expect(summary.results[0].pendingHeal?.lessonId).toBe("existing-lesson-1");
    });

    it("a failed heal never masks the ORIGINAL error — the healed retry failing too still reports the real failure", async () => {
      mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => ({
        ok: false,
        results: [{ i: 0, action: steps[0].action, ok: false, error: "element not found: still broken" }],
      }));
      const summary = await runFlow(
        "udid-1", makeLocatorFlow(), {}, () => {}, undefined,
        noopHooks({
          getScreenElements: vi.fn().mockResolvedValue([{ text: "Log In" }]),
          getSelectorCandidates: vi.fn().mockReturnValue([
            { id: "m1", screenFingerprint: "fp", elementKey: "Log In (old)", locatorKind: "text", locatorValue: "Log In", timesResolved: 3 },
          ]),
        }),
      );
      expect(summary.passed).toBe(false);
      expect(summary.results[0].error).toContain("still broken");
      expect(summary.results[0].healedRung).toBeUndefined();
    });

    it("AC5 — an assertion-action failure is NEVER healed, even with candidates available and selfHeal enabled", async () => {
      const assertionFlow: Flow = {
        schemaVersion: 1,
        name: "Assertion Flow",
        app: { bundleId: "com.example.app", platform: "ios-sim" },
        steps: [{ id: "s1", action: "assertVisible", text: "Balance" } as any],
      };
      mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => ({
        ok: false,
        results: [{ i: 0, action: steps[0].action, ok: false, error: "not visible" }],
      }));
      const summary = await runFlow(
        "udid-1", assertionFlow, {}, () => {}, undefined,
        noopHooks({
          getScreenElements: vi.fn().mockResolvedValue([{ text: "Balance" }]),
          getSelectorCandidates: vi.fn().mockReturnValue([
            { id: "m1", screenFingerprint: "fp", elementKey: "Balance", locatorKind: "text", locatorValue: "Balance", timesResolved: 10 },
          ]),
        }),
      );
      expect(summary.passed).toBe(false);
      expect(summary.results[0].healedRung).toBeUndefined();
      expect(mockRunSteps).toHaveBeenCalledTimes(1); // never even attempted a healed retry
    });

    describe("AI rung 4 (E24) — fully opt-in via runFlow's optional 8th parameter, only reached after rungs 1-3 fail", () => {
      function aiHooks(overrides: Partial<AiRecoveryHooks> = {}): AiRecoveryHooks {
        return { getRecoveryProviders: () => ({ chain: [], providers: new Map() }), ...overrides };
      }
      function fakeProvider(complete: AiProvider["complete"]): ReadonlyMap<string, AiProvider> {
        return new Map([["local", { id: "local", complete }]]);
      }

      it("omitting aiRecovery entirely means rung 4 never runs, even when selfHeal is enabled and rungs 1-3 fail", async () => {
        mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => ({
          ok: false, results: [{ i: 0, action: steps[0].action, ok: false, error: "element not found" }],
        }));
        const summary = await runFlow("udid-1", makeLocatorFlow(), {}, () => {}, undefined, noopHooks());
        expect(summary.results[0].healedRung).toBeUndefined();
        expect(mockRunSteps).toHaveBeenCalledTimes(1); // rung 0 only — no rung 1-3 candidate, rung 4 never even consulted
      });

      it("rung 4 heals when rungs 1-3 find nothing but the AI provider returns a legal candidate", async () => {
        let call = 0;
        mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => {
          call += 1;
          if (call === 1) return { ok: false, results: [{ i: 0, action: steps[0].action, ok: false, error: "element not found" }] };
          expect(steps[0].text).toBe("Log In"); // the AI candidate, executed directly
          return { ok: true, results: [{ i: 0, action: steps[0].action, ok: true, detail: "tapped" }] };
        });
        const onAiAttempt = vi.fn();
        const complete = vi.fn().mockResolvedValue({ text: JSON.stringify({ action: "tapText", text: "Log In" }) });
        const summary = await runFlow(
          "udid-1", makeLocatorFlow(), {}, () => {}, undefined,
          noopHooks(),
          aiHooks({ getRecoveryProviders: () => ({ chain: ["local"], providers: fakeProvider(complete) }), onAiAttempt }),
        );
        expect(summary.passed).toBe(true);
        expect(summary.results[0].healedRung).toBe(4);
        expect(summary.results[0].pendingHeal).toMatchObject({ rung: 4, healType: "other" });
        expect(onAiAttempt).toHaveBeenCalledTimes(1);
        expect(onAiAttempt.mock.calls[0][0].succeeded).toBe(true);
        expect(complete.mock.calls[0][1]).toMatchObject({ temperature: 0 }); // spec: "temp 0"
      });

      it("rung 4 is never even consulted when rungs 1-3 already succeeded", async () => {
        let call = 0;
        mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => {
          call += 1;
          if (call === 1) return { ok: false, results: [{ i: 0, action: steps[0].action, ok: false, error: "element not found" }] };
          return { ok: true, results: [{ i: 0, action: steps[0].action, ok: true, detail: "tapped" }] };
        });
        const complete = vi.fn();
        const summary = await runFlow(
          "udid-1", makeLocatorFlow(), {}, () => {}, undefined,
          noopHooks({
            getScreenElements: vi.fn().mockResolvedValue([{ text: "Log In" }]),
            getSelectorCandidates: vi.fn().mockReturnValue([
              { id: "m1", screenFingerprint: "fp", elementKey: "Log In (old)", locatorKind: "text", locatorValue: "Log In", timesResolved: 3 },
            ]),
          }),
          aiHooks({ getRecoveryProviders: () => ({ chain: ["local"], providers: fakeProvider(complete) }) }),
        );
        expect(summary.results[0].healedRung).toBe(1); // rung 1 already healed it
        expect(complete).not.toHaveBeenCalled(); // rung 4 never even consulted
      });

      it("AC2 — an illegal/out-of-bounds AI candidate is discarded: step stays failed, no healedRung, never executed — but still logged (AC3)", async () => {
        mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => ({
          ok: false, results: [{ i: 0, action: steps[0].action, ok: false, error: "element not found" }],
        }));
        const onAiAttempt = vi.fn();
        const complete = vi.fn().mockResolvedValue({ text: JSON.stringify({ action: "raw", maestro: "rm -rf /" }) });
        const summary = await runFlow(
          "udid-1", makeLocatorFlow(), {}, () => {}, undefined,
          noopHooks(),
          aiHooks({ getRecoveryProviders: () => ({ chain: ["local"], providers: fakeProvider(complete) }), onAiAttempt }),
        );
        expect(summary.passed).toBe(false);
        expect(summary.results[0].healedRung).toBeUndefined();
        expect(mockRunSteps).toHaveBeenCalledTimes(1); // the illegal candidate was NEVER executed
        expect(onAiAttempt).toHaveBeenCalledTimes(1); // still logged, healed or not
        expect(onAiAttempt.mock.calls[0][0].succeeded).toBe(false);
      });

      it("AC9 guardrail — best-effort: this run's own resolved secrets are redacted out of the rung-4 call log before onAiAttempt ever sees it", async () => {
        const SECRET_ENV_VAR = "PODIUM_SECRET_RUNG4_TEST_SECRET";
        const SECRET_VALUE = "hunter2-rung4-secret";
        process.env[SECRET_ENV_VAR] = SECRET_VALUE;
        try {
          const secretFlow: Flow = {
            schemaVersion: 1, name: "Secret Flow", app: { bundleId: "com.example.app", platform: "ios-sim" },
            steps: [{ id: "s1", action: "type", text: "${secret:rung4-test-secret}" } as any],
          };
          mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => ({
            ok: false, results: [{ i: 0, action: steps[0].action, ok: false, error: "failed" }],
          }));
          const onAiAttempt = vi.fn();
          // Simulates a real leak surface (AC9): the model's response happens to echo back the
          // resolved secret value (e.g. reflecting on-screen content it was fed).
          const complete = vi.fn().mockResolvedValue({ text: `no legal action found, saw text "${SECRET_VALUE}" on screen` });
          await runFlow(
            "udid-1", secretFlow, {}, () => {}, undefined,
            noopHooks(),
            aiHooks({ getRecoveryProviders: () => ({ chain: ["local"], providers: fakeProvider(complete) }), onAiAttempt }),
          );
          expect(onAiAttempt).toHaveBeenCalledTimes(1);
          const loggedResponse = onAiAttempt.mock.calls[0][0].attempt.logEntry.response;
          expect(loggedResponse).not.toContain(SECRET_VALUE);
          expect(loggedResponse).toContain("[secret redacted]");
        } finally {
          delete process.env[SECRET_ENV_VAR];
        }
      });

      it("AC4/heal-type safety — an assertion-action failure is never even sent to the AI provider, even with aiRecovery enabled", async () => {
        const assertionFlow: Flow = {
          schemaVersion: 1, name: "Assertion Flow", app: { bundleId: "com.example.app", platform: "ios-sim" },
          steps: [{ id: "s1", action: "assertVisible", text: "Balance" } as any],
        };
        mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => ({
          ok: false, results: [{ i: 0, action: steps[0].action, ok: false, error: "not visible" }],
        }));
        const complete = vi.fn();
        const summary = await runFlow(
          "udid-1", assertionFlow, {}, () => {}, undefined,
          noopHooks({ getScreenElements: vi.fn().mockResolvedValue([{ text: "Balance" }]) }),
          aiHooks({ getRecoveryProviders: () => ({ chain: ["local"], providers: fakeProvider(complete) }) }),
        );
        expect(summary.results[0].healedRung).toBeUndefined();
        expect(complete).not.toHaveBeenCalled();
      });

      it("a failed AI-proposed retry never masks the ORIGINAL rung-0 error", async () => {
        mockRunSteps.mockImplementation(async (_udid: string, steps: any[]) => ({
          ok: false, results: [{ i: 0, action: steps[0].action, ok: false, error: "element not found: still broken" }],
        }));
        const complete = vi.fn().mockResolvedValue({ text: JSON.stringify({ action: "tapText", text: "Log In" }) });
        const summary = await runFlow(
          "udid-1", makeLocatorFlow(), {}, () => {}, undefined,
          noopHooks(),
          aiHooks({ getRecoveryProviders: () => ({ chain: ["local"], providers: fakeProvider(complete) }) }),
        );
        expect(summary.passed).toBe(false);
        expect(summary.results[0].error).toContain("still broken");
        expect(summary.results[0].healedRung).toBeUndefined();
      });
    });
  });
});

describe("waitForAppReady (C6 — launch-readiness gate)", () => {
  beforeEach(() => {
    mockInspect.mockReset();
  });

  it("returns true immediately once the screen reports elements", async () => {
    mockInspect.mockResolvedValue({ count: 5 });
    const t0 = Date.now();
    expect(await waitForAppReady("udid", 1000, 10)).toBe(true);
    expect(Date.now() - t0).toBeLessThan(300); // resolved on the first poll, not after a wait
    expect(mockInspect).toHaveBeenCalledTimes(1);
  });

  it("counts elements[] when no numeric count is present", async () => {
    mockInspect.mockResolvedValue({ elements: [{}, {}] });
    expect(await waitForAppReady("udid", 1000, 10)).toBe(true);
  });

  it("keeps polling until the screen renders, then returns true", async () => {
    mockInspect
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValue({ count: 2 });
    expect(await waitForAppReady("udid", 1000, 5)).toBe(true);
    expect(mockInspect.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("tolerates transient inspect errors (keeps polling)", async () => {
    mockInspect
      .mockRejectedValueOnce(new Error("app still launching"))
      .mockResolvedValue({ count: 1 });
    expect(await waitForAppReady("udid", 1000, 5)).toBe(true);
  });

  it("returns false (does not hang) when the screen never renders within the timeout", async () => {
    mockInspect.mockResolvedValue({ count: 0 });
    const t0 = Date.now();
    expect(await waitForAppReady("udid", 60, 10)).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55);
  });
});

describe("pickNavBackButtonCenter (C7 — iOS nav Back button)", () => {
  // Mirrors a real Settings > General dump: leftmost nav Button is the Back control.
  const general = [
    { label: "Settings", type: "Button", frame: { x: 0, y: 56, width: 93, height: 30 } },
    { label: "21:47", type: "StaticText", frame: { x: 52, y: 22, width: 44, height: 20 } },
    { label: "General", type: "StaticText", frame: { x: 170, y: 66, width: 62, height: 22 } },
    { label: "About", type: "Cell", frame: { x: 20, y: 213, width: 360, height: 44 } },
  ];

  it("returns the centre of the left-most nav-bar Button", () => {
    expect(pickNavBackButtonCenter(general)).toEqual({ x: 47, y: 71 });
  });

  it("returns null on a root screen with no nav Back button", () => {
    const root = [
      { label: "Settings", type: "StaticText", frame: { x: 16, y: 56, width: 120, height: 34 } },
      { label: "General", type: "Cell", frame: { x: 20, y: 337, width: 360, height: 44 } },
    ];
    expect(pickNavBackButtonCenter(root)).toBeNull();
  });

  it("ignores buttons outside the top-left nav region (lower down or on the right)", () => {
    const els = [
      { label: "Edit", type: "Button", frame: { x: 320, y: 56, width: 60, height: 30 } }, // right side
      { label: "Save", type: "Button", frame: { x: 10, y: 400, width: 80, height: 40 } },  // too low
    ];
    expect(pickNavBackButtonCenter(els)).toBeNull();
  });

  it("skips elements with no frame", () => {
    const els = [{ label: "Back", type: "Button" }, ...general];
    expect(pickNavBackButtonCenter(els)).toEqual({ x: 47, y: 71 });
  });
});
