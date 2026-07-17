import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../bridge/podium.ts", () => ({
  engine: {
    runSteps: vi.fn(),
    health: vi.fn(),
  },
}));

import { engine } from "../bridge/podium.ts";
import { mobileDriver } from "../bridge/runner.ts";

const mockRunSteps = engine.runSteps as unknown as ReturnType<typeof vi.fn>;
const mockHealth = engine.health as unknown as ReturnType<typeof vi.fn>;

describe("mobileDriver — Driver interface conformance (E7)", () => {
  beforeEach(() => {
    mockRunSteps.mockReset();
    mockHealth.mockReset();
  });

  it("has the shape of a Driver (platform, name, isAvailable, executeStep)", () => {
    expect(mobileDriver.platform).toBe("mobile");
    expect(typeof mobileDriver.name).toBe("string");
    expect(typeof mobileDriver.isAvailable).toBe("function");
    expect(typeof mobileDriver.executeStep).toBe("function");
  });

  it("isAvailable() reports ok:true when the Podium engine health check passes", async () => {
    mockHealth.mockResolvedValue({ ok: true });
    const result = await mobileDriver.isAvailable();
    expect(result.ok).toBe(true);
  });

  it("isAvailable() reports ok:false with a reason when the health check fails", async () => {
    mockHealth.mockResolvedValue({ ok: false, error: "podium not found" });
    const result = await mobileDriver.isAvailable();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/podium not found/);
  });

  it("isAvailable() reports ok:false without throwing when engine.health() rejects", async () => {
    mockHealth.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await mobileDriver.isAvailable();
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/ECONNREFUSED/);
  });

  it("executeStep() requires ctx.udid rather than silently no-opping", async () => {
    const result = await mobileDriver.executeStep({ id: "s1", action: "screenshot" } as any, {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/udid/);
    expect(mockRunSteps).not.toHaveBeenCalled();
  });

  it("executeStep() delegates to the same native-dispatch path executeStep() uses", async () => {
    mockRunSteps.mockResolvedValue({ ok: true, results: [{ i: 0, action: "screenshot", ok: true }] });
    const result = await mobileDriver.executeStep(
      { id: "s1", action: "screenshot" } as any,
      { udid: "udid-1", bundleId: "com.example.app" },
    );
    expect(result.ok).toBe(true);
    expect(mockRunSteps).toHaveBeenCalledTimes(1);
    expect(mockRunSteps.mock.calls[0][0]).toBe("udid-1");
  });
});
