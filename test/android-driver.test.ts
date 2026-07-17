import { describe, it, expect, vi } from "vitest";
import type { FlowStep } from "../shared/ir.ts";
import {
  androidDriver,
  detectAndroidRuntime,
  isAdbFastAction,
  mapStepToAndroidAction,
  runAndroidStepWithRetry,
  type AndroidExecFn,
} from "../bridge/android-driver.ts";

/**
 * E10 (Android driver). No real Android emulator is available in this environment (per the
 * epic's own scope note) — every test here mocks the `adb`/`maestro` subprocess boundary
 * (`AndroidExecFn`) and exercises the REAL mapping/dispatch/retry logic around it, mirroring
 * test/browser-driver.test.ts's split for the browser driver. AC1 (20-run pass rate on a real
 * emulator), AC2's real-transient-failure recovery, and AC5's real Doctor run all need a human
 * with real hardware — see the completion report for that split.
 */

const s = (over: Partial<FlowStep> & { action: FlowStep["action"] }): FlowStep =>
  ({ id: "s1", ...over } as FlowStep);

describe("androidDriver — Driver interface conformance", () => {
  it("has the shape of a Driver (platform, name, isAvailable, executeStep)", () => {
    expect(androidDriver.platform).toBe("mobile");
    expect(typeof androidDriver.name).toBe("string");
    expect(typeof androidDriver.isAvailable).toBe("function");
    expect(typeof androidDriver.executeStep).toBe("function");
  });

  it("executeStep() requires ctx.udid rather than silently no-opping", async () => {
    const result = await androidDriver.executeStep(s({ action: "screenshot" }), {});
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/udid/);
  });
});

describe("detectAndroidRuntime — never fakes a green result", () => {
  it("reports ok:false with a clear reason when adb is missing", async () => {
    const exec: AndroidExecFn = vi.fn(async (cmd) => {
      if (cmd === "adb") throw new Error("spawn adb ENOENT");
      return { stdout: "", stderr: "" };
    });
    const result = await detectAndroidRuntime(exec);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/adb not found/);
  });

  it("reports ok:false with a clear reason when adb is present but maestro is missing", async () => {
    const exec: AndroidExecFn = vi.fn(async (cmd) => {
      if (cmd === "adb") return { stdout: "Android Debug Bridge version 1.0.41", stderr: "" };
      throw new Error("spawn maestro ENOENT");
    });
    const result = await detectAndroidRuntime(exec);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/maestro CLI not found/);
  });

  it("reports ok:true when both adb and maestro are reachable", async () => {
    const exec: AndroidExecFn = vi.fn(async () => ({ stdout: "ok", stderr: "" }));
    const result = await detectAndroidRuntime(exec);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});

describe("isAdbFastAction — the Android equivalent of Podium's fast run_steps path", () => {
  it("classifies the no-a11y-needed actions as adb-fast", () => {
    for (const action of ["tap", "key", "waitMs", "screenshot"] as const) {
      expect(isAdbFastAction(action)).toBe(true);
    }
  });

  it("classifies everything else as needing Maestro (a11y resolution)", () => {
    for (const action of ["tapText", "type", "assertVisible", "waitFor", "doubleTap", "scroll", "if", "repeat"] as const) {
      expect(isAdbFastAction(action)).toBe(false);
    }
  });
});

describe("mapStepToAndroidAction — adb-fast dispatch (mocked exec, no real emulator)", () => {
  it("tap dispatches to `adb -s <serial> shell input tap x y`", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" })) as unknown as AndroidExecFn;
    const result = await mapStepToAndroidAction(s({ action: "tap", x: 120.4, y: 340.9 }), "emulator-5554", {}, exec);
    expect(result.ok).toBe(true);
    expect(result.backend).toBe("adb");
    expect(exec).toHaveBeenCalledWith("adb", ["-s", "emulator-5554", "shell", "input", "tap", "120", "341"]);
  });

  it("key maps IR key names to Android keyevent codes", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" })) as unknown as AndroidExecFn;
    const result = await mapStepToAndroidAction(s({ action: "key", key: "enter" }), "emulator-5554", {}, exec);
    expect(result.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith("adb", ["-s", "emulator-5554", "shell", "input", "keyevent", "66"]);
  });

  it("waitMs sleeps without any adb/maestro call", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" })) as unknown as AndroidExecFn;
    const start = Date.now();
    const result = await mapStepToAndroidAction(s({ action: "waitMs", ms: 5 }), "emulator-5554", {}, exec);
    expect(result.ok).toBe(true);
    expect(Date.now() - start).toBeGreaterThanOrEqual(4);
    expect(exec).not.toHaveBeenCalled();
  });

  it("screenshot requires ctx.screenshotPath rather than silently no-opping", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" })) as unknown as AndroidExecFn;
    const result = await mapStepToAndroidAction(s({ action: "screenshot" }), "emulator-5554", {}, exec);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/screenshotPath/);
  });

  it("screenshot pulls via a device-side temp file when a path is given", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" })) as unknown as AndroidExecFn;
    const result = await mapStepToAndroidAction(s({ action: "screenshot" }), "emulator-5554", { screenshotPath: "/tmp/out.png" }, exec);
    expect(result.ok).toBe(true);
    expect(exec).toHaveBeenCalledWith("adb", ["-s", "emulator-5554", "shell", "screencap", "-p", "/sdcard/podium-studio-shot.png"]);
    expect(exec).toHaveBeenCalledWith("adb", ["-s", "emulator-5554", "pull", "/sdcard/podium-studio-shot.png", "/tmp/out.png"]);
  });
});

describe("mapStepToAndroidAction — Maestro dispatch, reusing shared/maestro.ts verbatim", () => {
  it("requires a bundle id for a Maestro-path action", async () => {
    const exec = vi.fn(async () => ({ stdout: "", stderr: "" })) as unknown as AndroidExecFn;
    const result = await mapStepToAndroidAction(s({ action: "tapText", text: "Login" }), "emulator-5554", {}, exec);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/bundle id/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("compiles the step to real Maestro YAML, writes it to a temp file, and runs `maestro test` targeting the emulator via ANDROID_SERIAL", async () => {
    let seenFlowPath: string | undefined;
    let seenEnv: Record<string, string> | undefined;
    const exec: AndroidExecFn = vi.fn(async (cmd, args, envOverrides) => {
      if (cmd === "maestro") {
        seenFlowPath = args[1];
        seenEnv = envOverrides;
        const { readFileSync } = await import("node:fs");
        const yaml = readFileSync(seenFlowPath!, "utf8");
        expect(yaml).toMatch(/appId: com\.example\.app/);
        expect(yaml).toMatch(/tapOn:/);
        expect(yaml).toMatch(/text: "Login"/);
        return { stdout: "Flow passed", stderr: "" };
      }
      throw new Error(`unexpected exec call: ${cmd}`);
    });

    const result = await mapStepToAndroidAction(
      s({ action: "tapText", text: "Login" }),
      "emulator-5554",
      { bundleId: "com.example.app" },
      exec,
    );

    expect(result.ok).toBe(true);
    expect(result.backend).toBe("maestro");
    expect(exec).toHaveBeenCalledWith("maestro", ["test", seenFlowPath], { ANDROID_SERIAL: "emulator-5554" });
    expect(seenEnv).toEqual({ ANDROID_SERIAL: "emulator-5554" });
  });

  it("threads a captured variable through as a Maestro env: block (E2 AC4 / spec AC3, native→Maestro handoff)", async () => {
    const exec: AndroidExecFn = vi.fn(async (cmd, args) => {
      if (cmd === "maestro") {
        const { readFileSync } = await import("node:fs");
        const yaml = readFileSync(args[1], "utf8");
        expect(yaml).toMatch(/env:/);
        expect(yaml).toMatch(/otp_code: "482913"/);
        return { stdout: "", stderr: "" };
      }
      throw new Error("unexpected");
    });
    const result = await mapStepToAndroidAction(
      s({ action: "assertVisible", text: "482913" }),
      "emulator-5554",
      { bundleId: "com.example.app", env: { otp_code: "482913" } },
      exec,
    );
    expect(result.ok).toBe(true);
  });

  it("reports failure with the Maestro CLI's own output when the flow fails, without throwing", async () => {
    const exec: AndroidExecFn = vi.fn(async (cmd) => {
      if (cmd === "maestro") {
        const err: any = new Error("Command failed");
        err.stdout = "";
        err.stderr = "Assertion failed: \"Login\" not visible";
        throw err;
      }
      throw new Error("unexpected");
    });
    const result = await mapStepToAndroidAction(
      s({ action: "assertVisible", text: "Login" }),
      "emulator-5554",
      { bundleId: "com.example.app" },
      exec,
    );
    expect(result.ok).toBe(false);
    expect(result.backend).toBe("maestro");
    expect(result.error).toMatch(/not visible/);
  });

  it("threads ctx.secrets into the compiled Maestro YAML, resolving a ${secret:...} field (E12 parity)", async () => {
    const exec: AndroidExecFn = vi.fn(async (cmd, args) => {
      if (cmd === "maestro") {
        const { readFileSync } = await import("node:fs");
        const yaml = readFileSync(args[1], "utf8");
        expect(yaml).toContain("hunter2");
        expect(yaml).not.toContain("${secret:password}");
        return { stdout: "", stderr: "" };
      }
      throw new Error("unexpected");
    });
    const result = await mapStepToAndroidAction(
      s({ action: "type", text: "${secret:password}" }),
      "emulator-5554",
      { bundleId: "com.example.app", secrets: { password: "hunter2" } },
      exec,
    );
    expect(result.ok).toBe(true);
  });
});

describe("runAndroidStepWithRetry — per-action retry with idempotency (spec AC2)", () => {
  it("retries an idempotent step exactly once after a transient failure, then succeeds", async () => {
    let calls = 0;
    const exec: AndroidExecFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("connection closed unexpectedly");
      return { stdout: "", stderr: "" };
    });
    const { outcome, attempts } = await runAndroidStepWithRetry(
      s({ action: "assertVisible", text: "Home" }), // idempotent by default
      "emulator-5554",
      { bundleId: "com.example.app" },
      exec,
    );
    expect(outcome.ok).toBe(true);
    expect(attempts).toBe(2);
  });

  it("never retries a non-idempotent step, even on a transient-looking failure (no double side-effect)", async () => {
    const exec: AndroidExecFn = vi.fn(async () => {
      throw new Error("connection closed unexpectedly");
    });
    const { outcome, attempts } = await runAndroidStepWithRetry(
      s({ action: "tapText", text: "Buy now" }), // NOT idempotent by default — a real purchase tap must never double-fire
      "emulator-5554",
      { bundleId: "com.example.app" },
      exec,
    );
    expect(outcome.ok).toBe(false);
    expect(attempts).toBe(1);
  });

  it("does not retry a genuine (non-transient) failure even on an idempotent step", async () => {
    const exec: AndroidExecFn = vi.fn(async () => {
      const err: any = new Error("Assertion failed: element not found");
      throw err;
    });
    const { outcome, attempts } = await runAndroidStepWithRetry(
      s({ action: "assertVisible", text: "Ghost" }),
      "emulator-5554",
      { bundleId: "com.example.app" },
      exec,
    );
    expect(outcome.ok).toBe(false);
    expect(attempts).toBe(1);
  });

  it("an explicit idempotent:true override allows retry even for a normally non-idempotent action", async () => {
    let calls = 0;
    const exec: AndroidExecFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("socket hang up");
      return { stdout: "", stderr: "" };
    });
    const { outcome, attempts } = await runAndroidStepWithRetry(
      s({ action: "tap", x: 1, y: 2, idempotent: true }),
      "emulator-5554",
      {},
      exec,
    );
    expect(outcome.ok).toBe(true);
    expect(attempts).toBe(2);
  });
});

describe("E20 — real-device dispatch is byte-identical to emulator dispatch (AC1: no per-device fork)", () => {
  /** A real, USB-connected Android device's serial NEVER starts with "emulator-" (that prefix
   * is reserved for the Android Emulator's own adb transport) — e.g. "R58N1234ABC". Nothing in
   * bridge/android-driver.ts ever inspects a serial's shape; it's threaded straight into `adb -s
   * <serial> ...` as an opaque string. This test proves that structurally: the exact same
   * mapping/dispatch call, given ONLY a different serial, produces an IDENTICAL command/args
   * shape (same flags, same order) for a real-device-shaped serial as for an emulator-shaped
   * one — the literal claim AC1's "diff of driver invocation path is identical... only the
   * target device id differs" needs, provable here without real hardware. */
  const REAL_SERIAL = "R58N1234ABC";
  const EMULATOR_SERIAL = "emulator-5554";

  async function captureAdbTapCalls(serial: string): Promise<unknown[][]> {
    const calls: unknown[][] = [];
    const exec: AndroidExecFn = vi.fn(async (cmd, args, envOverrides) => {
      calls.push([cmd, args, envOverrides]);
      return { stdout: "", stderr: "" };
    });
    await mapStepToAndroidAction(s({ action: "tap", x: 10, y: 20 }), serial, {}, exec);
    return calls;
  }

  it("an adb-fast action (tap) produces the identical adb invocation shape for a real serial vs an emulator serial", async () => {
    const realCalls = await captureAdbTapCalls(REAL_SERIAL);
    const emulatorCalls = await captureAdbTapCalls(EMULATOR_SERIAL);
    expect(realCalls).toHaveLength(1);
    expect(emulatorCalls).toHaveLength(1);
    // Same command, same flags, same argument ORDER — only the serial value itself differs.
    expect(realCalls[0][0]).toBe(emulatorCalls[0][0]); // "adb"
    const [realArgs] = realCalls[0].slice(1) as [string[]];
    const [emulatorArgs] = emulatorCalls[0].slice(1) as [string[]];
    expect(realArgs.map((a) => (a === REAL_SERIAL ? "<SERIAL>" : a))).toEqual(
      emulatorArgs.map((a) => (a === EMULATOR_SERIAL ? "<SERIAL>" : a)),
    );
  });

  it("a Maestro-routed action (tapText) also produces the identical dispatch shape for a real serial vs an emulator serial", async () => {
    async function captureMaestroCall(serial: string): Promise<{ cmd: string; args: string[]; env: Record<string, string> | undefined }> {
      let captured: { cmd: string; args: string[]; env: Record<string, string> | undefined } | undefined;
      const exec: AndroidExecFn = vi.fn(async (cmd, args, envOverrides) => {
        if (cmd === "maestro") captured = { cmd, args, env: envOverrides };
        return { stdout: "", stderr: "" };
      });
      await mapStepToAndroidAction(s({ action: "tapText", text: "Login" }), serial, { bundleId: "com.example.app" }, exec);
      return captured!;
    }
    const real = await captureMaestroCall(REAL_SERIAL);
    const emulator = await captureMaestroCall(EMULATOR_SERIAL);
    expect(real.cmd).toBe(emulator.cmd); // "maestro"
    expect(real.args[0]).toBe(emulator.args[0]); // "test" — same subcommand
    // ANDROID_SERIAL is adb's own device-targeting env var — the ONLY thing that differs.
    expect(real.env).toEqual({ ANDROID_SERIAL: REAL_SERIAL });
    expect(emulator.env).toEqual({ ANDROID_SERIAL: EMULATOR_SERIAL });
  });
});
