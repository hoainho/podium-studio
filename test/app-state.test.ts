import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Flow } from "../shared/ir.ts";

vi.mock("../bridge/podium.ts", () => ({
  engine: {
    runSteps: vi.fn(),
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
import { runFlow } from "../bridge/runner.ts";

const m = {
  runSteps: engine.runSteps as unknown as ReturnType<typeof vi.fn>,
  screenshot: engine.screenshot as unknown as ReturnType<typeof vi.fn>,
  appState: engine.appState as unknown as ReturnType<typeof vi.fn>,
  launchApp: engine.launchApp as unknown as ReturnType<typeof vi.fn>,
  terminateApp: engine.terminateApp as unknown as ReturnType<typeof vi.fn>,
  setLocation: engine.setLocation as unknown as ReturnType<typeof vi.fn>,
};

function flow(extra: Partial<Flow> = {}): Flow {
  return {
    schemaVersion: 1,
    name: "Guard Flow",
    app: { bundleId: "com.example.app", platform: "ios-sim" },
    steps: [{ id: "s1", action: "screenshot" }],
    ...extra,
  };
}

describe("runner preflight (app launch + presence guard)", () => {
  beforeEach(() => {
    for (const fn of Object.values(m)) fn.mockReset();
    m.screenshot.mockResolvedValue(undefined);
    m.launchApp.mockResolvedValue(undefined);
    m.terminateApp.mockResolvedValue(undefined);
    m.setLocation.mockResolvedValue(undefined);
    m.runSteps.mockResolvedValue({ ok: true, results: [{ i: 0, action: "screenshot", ok: true }] });
  });

  it("launches the target app BEFORE running any step (RC1)", async () => {
    m.appState.mockResolvedValue({ installed: true, running: false });
    const order: string[] = [];
    m.launchApp.mockImplementation(async () => { order.push("launch"); });
    m.runSteps.mockImplementation(async () => { order.push("step"); return { ok: true, results: [{ i: 0, action: "screenshot", ok: true }] }; });

    const summary = await runFlow("udid-1", flow(), {}, () => {});
    expect(m.launchApp).toHaveBeenCalledWith("udid-1", "com.example.app");
    expect(order[0]).toBe("launch"); // launch happens before the first step
    expect(summary.passed).toBe(true);
  });

  it("rejects a run when the app is not installed, with a clear message (RC4)", async () => {
    m.appState.mockResolvedValue({ installed: false, running: false });
    await expect(runFlow("udid-1", flow(), {}, () => {})).rejects.toThrow(/not installed/i);
    expect(m.runSteps).not.toHaveBeenCalled(); // never runs steps against the wrong app
    expect(m.launchApp).not.toHaveBeenCalled();
  });

  it("resetState terminates the app before launching", async () => {
    m.appState.mockResolvedValue({ installed: true, running: true });
    await runFlow("udid-1", flow({ requires: { resetState: true } }), {}, () => {});
    expect(m.terminateApp).toHaveBeenCalledWith("udid-1", "com.example.app");
    expect(m.launchApp).toHaveBeenCalledWith("udid-1", "com.example.app");
  });

  it("sets location when the flow requires it", async () => {
    m.appState.mockResolvedValue({ installed: true, running: false });
    await runFlow("udid-1", flow({ requires: { location: { latitude: 30.2, longitude: -97.7 } } }), {}, () => {});
    expect(m.setLocation).toHaveBeenCalledWith("udid-1", 30.2, -97.7);
  });
});
