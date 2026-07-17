import { describe, it, expect } from "vitest";
import { runDoctor, type DoctorDeps, type ExecFn } from "../bridge/doctor.ts";

/** Build a mock exec that dispatches on the command name, per-test override map. */
function mockExec(handlers: Record<string, (args: string[]) => Promise<{ stdout: string; stderr: string }>>): ExecFn {
  return async (cmd, args) => {
    const handler = handlers[cmd];
    if (!handler) throw new Error(`unexpected command in test: ${cmd} ${args.join(" ")}`);
    return handler(args);
  };
}

const ok = (stdout = "", stderr = "") => Promise.resolve({ stdout, stderr });
const fail = (message: string) => Promise.reject(new Error(message));

const bootedSimJson = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
      { name: "iPhone 16", udid: "ABC-123", state: "Booted" },
    ],
  },
});

const noBootedSimJson = JSON.stringify({
  devices: { "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [{ name: "iPhone 16", udid: "ABC-123", state: "Shutdown" }] },
});

const adbDevicesBooted = "List of devices attached\nemulator-5554\tdevice\n";
const adbDevicesNoneBooted = "List of devices attached\n";
// `adb devices -l` (E20's real-device check) — the "everything green" baseline includes one
// real, authorized device alongside the emulator, so the fully-green test stays fully green.
const adbDevicesLWithRealDevice = "List of devices attached\nemulator-5554\tdevice product:sdk_gphone64_arm64\nR58N1234ABC\tdevice product:coral model:Pixel_4 device:coral\n";
const adbDevicesLNoRealDevice = "List of devices attached\nemulator-5554\tdevice product:sdk_gphone64_arm64\n";
const adbDevicesLUnauthorized = "List of devices attached\nR58N1234ABC\tunauthorized usb:1-1\n";

/** A fully-green deps baseline (iOS + Android); individual tests override one handler/flag to force a red check. */
function greenDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  const exec = mockExec({
    "xcode-select": () => ok("/Applications/Xcode.app/Contents/Developer\n"),
    idb: () => ok("idb 1.1.7\n"),
    java: () => ok("", "openjdk version \"21.0.1\" 2023-10-17\n"),
    xcrun: () => ok(bootedSimJson),
    adb: (args) => {
      if (args[0] === "devices" && args.includes("-l")) return ok(adbDevicesLWithRealDevice);
      if (args[0] === "devices") return ok(adbDevicesBooted);
      if (args[0] === "-s") return ok("Pixel 4\n"); // getprop ro.product.model
      return ok("Android Debug Bridge version 1.0.41\n");
    },
  });
  return {
    exec,
    fileExists: () => true,
    podiumEntryPath: "/fake/podium/dist/index.js",
    androidHome: "/fake/android/sdk",
    ...overrides,
  };
}

describe("Environment Doctor (E5)", () => {
  it("AC1-AC5: reports all 9 checks green on a fully-configured machine (iOS + Android, E10 AC5 + E20)", async () => {
    const report = await runDoctor(greenDeps());
    expect(report.checks).toHaveLength(9);
    expect(report.checks.map((c) => c.id).sort()).toEqual(
      ["idb", "jre", "podiumEngine", "simulatorBoot", "xcodeClt", "androidSdk", "adb", "androidEmulatorBoot", "androidRealDevice"].sort(),
    );
    expect(report.ok).toBe(true);
    expect(report.platforms).toEqual({ ios: true, android: true });
    for (const c of report.checks) {
      expect(c.ok).toBe(true);
      expect(c.fixVi).toBeUndefined();
      expect(c.platform).toMatch(/^(shared|ios|android)$/);
      expect(c.optional).toBeUndefined();
    }
  });

  it("AC1, AC6: reports red + a Vietnamese fix when Xcode CLT is missing", async () => {
    const deps = greenDeps({
      exec: mockExec({
        "xcode-select": () => fail("xcode-select: error: unable to get active developer directory"),
        idb: () => ok("idb 1.1.7\n"),
        java: () => ok("", "openjdk version \"21.0.1\" 2023-10-17\n"),
        xcrun: () => ok(bootedSimJson),
      }),
    });
    const report = await runDoctor(deps);
    const check = report.checks.find((c) => c.id === "xcodeClt")!;
    expect(check.ok).toBe(false);
    expect(report.ok).toBe(false);
    expect(check.fixVi).toBeTruthy();
    expect(check.fixVi).toMatch(/[À-ỹ]/); // contains Vietnamese diacritics
  });

  it("AC2, AC6: reports red + a Vietnamese fix when idb is missing (and not on PATH)", async () => {
    const deps = greenDeps({
      exec: mockExec({
        "xcode-select": () => ok("/Applications/Xcode.app/Contents/Developer\n"),
        idb: () => fail("spawn idb ENOENT"),
        which: () => fail("idb not found"),
        java: () => ok("", "openjdk version \"21.0.1\" 2023-10-17\n"),
        xcrun: () => ok(bootedSimJson),
      }),
    });
    const report = await runDoctor(deps);
    const check = report.checks.find((c) => c.id === "idb")!;
    expect(check.ok).toBe(false);
    expect(check.fixVi).toBeTruthy();
  });

  it("idb still green when --version fails but the PATH fallback finds it", async () => {
    const deps = greenDeps({
      exec: mockExec({
        "xcode-select": () => ok("/Applications/Xcode.app/Contents/Developer\n"),
        idb: () => fail("idb: unrecognized option --version"),
        which: () => ok("/usr/local/bin/idb\n"),
        java: () => ok("", "openjdk version \"21.0.1\" 2023-10-17\n"),
        xcrun: () => ok(bootedSimJson),
      }),
    });
    const report = await runDoctor(deps);
    const check = report.checks.find((c) => c.id === "idb")!;
    expect(check.ok).toBe(true);
    expect(check.fixVi).toBeUndefined();
  });

  it("AC3, AC6: reports red + a Vietnamese fix when JRE is missing", async () => {
    const deps = greenDeps({
      exec: mockExec({
        "xcode-select": () => ok("/Applications/Xcode.app/Contents/Developer\n"),
        idb: () => ok("idb 1.1.7\n"),
        java: () => fail("spawn java ENOENT"),
        xcrun: () => ok(bootedSimJson),
      }),
    });
    const report = await runDoctor(deps);
    const check = report.checks.find((c) => c.id === "jre")!;
    expect(check.ok).toBe(false);
    expect(check.fixVi).toBeTruthy();
  });

  it("AC4, AC6: reports red + a Vietnamese fix when no simulator is booted", async () => {
    const deps = greenDeps({
      exec: mockExec({
        "xcode-select": () => ok("/Applications/Xcode.app/Contents/Developer\n"),
        idb: () => ok("idb 1.1.7\n"),
        java: () => ok("", "openjdk version \"21.0.1\" 2023-10-17\n"),
        xcrun: () => ok(noBootedSimJson),
      }),
    });
    const report = await runDoctor(deps);
    const check = report.checks.find((c) => c.id === "simulatorBoot")!;
    expect(check.ok).toBe(false);
    expect(check.fixVi).toBeTruthy();
  });

  it("AC5, AC6: reports red + a Vietnamese fix when the pinned Podium engine file is missing", async () => {
    const deps = greenDeps({ fileExists: () => false });
    const report = await runDoctor(deps);
    const check = report.checks.find((c) => c.id === "podiumEngine")!;
    expect(check.ok).toBe(false);
    expect(report.ok).toBe(false);
    expect(check.fixVi).toBeTruthy();
    expect(check.fixVi).toMatch(/PODIUM_ENTRY|npm run build/);
  });

  // ─── Android toolchain (E10 AC5) — same green/red shape as the iOS checks above ──────

  describe("androidSdk", () => {
    it("is green when ANDROID_HOME/ANDROID_SDK_ROOT is set and the directory exists", async () => {
      const report = await runDoctor(greenDeps());
      const check = report.checks.find((c) => c.id === "androidSdk")!;
      expect(check.ok).toBe(true);
      expect(check.fixVi).toBeUndefined();
      expect(check.detail).toMatch(/fake\/android\/sdk/);
    });

    it("is red with a Vietnamese fix when neither env var is set — but doesn't drag the overall report red when iOS is fully green (R2 platform-awareness)", async () => {
      const deps = greenDeps({ androidHome: undefined });
      const report = await runDoctor(deps);
      const check = report.checks.find((c) => c.id === "androidSdk")!;
      expect(check.ok).toBe(false);
      expect(check.fixVi).toBeTruthy();
      expect(check.fixVi).toMatch(/ANDROID_HOME/);
      // iOS is otherwise fully green in this deps set (only androidHome was overridden), so the
      // overall report is now "ok" (R2 platform-awareness) and this specific check is annotated
      // optional rather than reported as a blocking failure.
      expect(report.ok).toBe(true);
      expect(check.optional).toBe(true);
    });

    it("is red when the env var is set but the directory doesn't exist", async () => {
      const deps = greenDeps({ androidHome: "/fake/android/sdk", fileExists: (p) => p !== "/fake/android/sdk" });
      const report = await runDoctor(deps);
      const check = report.checks.find((c) => c.id === "androidSdk")!;
      expect(check.ok).toBe(false);
      expect(check.fixVi).toBeTruthy();
    });
  });

  describe("adb", () => {
    it("is green when `adb --version` succeeds", async () => {
      const report = await runDoctor(greenDeps());
      const check = report.checks.find((c) => c.id === "adb")!;
      expect(check.ok).toBe(true);
      expect(check.fixVi).toBeUndefined();
    });

    it("is red with a Vietnamese fix when adb is missing", async () => {
      const deps = greenDeps({
        exec: mockExec({
          "xcode-select": () => ok("/Applications/Xcode.app/Contents/Developer\n"),
          idb: () => ok("idb 1.1.7\n"),
          java: () => ok("", "openjdk version \"21.0.1\" 2023-10-17\n"),
          xcrun: () => ok(bootedSimJson),
          adb: () => fail("spawn adb ENOENT"),
        }),
      });
      const report = await runDoctor(deps);
      const check = report.checks.find((c) => c.id === "adb")!;
      expect(check.ok).toBe(false);
      expect(check.fixVi).toBeTruthy();
      expect(check.fixVi).toMatch(/platform-tools/);
      // iOS is fully green in this deps set (androidSdk isn't touched, only the exec mock lost
      // its adb handler), so the overall report is "ok" and this check is marked optional
      // (R2 platform-awareness) rather than blocking usability.
      expect(report.ok).toBe(true);
      expect(check.optional).toBe(true);
    });
  });

  describe("androidEmulatorBoot", () => {
    it("is green when `adb devices` reports at least one booted device", async () => {
      const report = await runDoctor(greenDeps());
      const check = report.checks.find((c) => c.id === "androidEmulatorBoot")!;
      expect(check.ok).toBe(true);
      expect(check.detail).toMatch(/emulator-5554/);
      expect(check.fixVi).toBeUndefined();
    });

    it("is red with a Vietnamese fix when no Android device/emulator is booted", async () => {
      const deps = greenDeps({
        exec: mockExec({
          "xcode-select": () => ok("/Applications/Xcode.app/Contents/Developer\n"),
          idb: () => ok("idb 1.1.7\n"),
          java: () => ok("", "openjdk version \"21.0.1\" 2023-10-17\n"),
          xcrun: () => ok(bootedSimJson),
          adb: (args) => (args[0] === "devices" ? ok(adbDevicesNoneBooted) : ok("Android Debug Bridge version 1.0.41\n")),
        }),
      });
      const report = await runDoctor(deps);
      const check = report.checks.find((c) => c.id === "androidEmulatorBoot")!;
      expect(check.ok).toBe(false);
      expect(check.fixVi).toBeTruthy();
      expect(check.fixVi).toMatch(/AVD|emulator/);
      // iOS is fully green here too, so overall usability isn't blocked (R2 platform-awareness).
      expect(report.ok).toBe(true);
      expect(check.optional).toBe(true);
    });

    it("is red when `adb devices` itself fails (e.g. adb not running)", async () => {
      const deps = greenDeps({
        exec: mockExec({
          "xcode-select": () => ok("/Applications/Xcode.app/Contents/Developer\n"),
          idb: () => ok("idb 1.1.7\n"),
          java: () => ok("", "openjdk version \"21.0.1\" 2023-10-17\n"),
          xcrun: () => ok(bootedSimJson),
          adb: (args) => (args[0] === "devices" ? fail("adb server not running") : ok("Android Debug Bridge version 1.0.41\n")),
        }),
      });
      const report = await runDoctor(deps);
      const check = report.checks.find((c) => c.id === "androidEmulatorBoot")!;
      expect(check.ok).toBe(false);
      expect(check.fixVi).toBeTruthy();
    });
  });

  // ─── E20: real, USB-connected Android device preflight (AC2) ─────────────────────────
  describe("androidRealDevice", () => {
    it("AC2 — is green when a real device (non-'emulator-' serial) is authorized ('device' state), and reports its model", async () => {
      const report = await runDoctor(greenDeps());
      const check = report.checks.find((c) => c.id === "androidRealDevice")!;
      expect(check.ok).toBe(true);
      expect(check.detail).toMatch(/R58N1234ABC/);
      expect(check.detail).toMatch(/Pixel 4/);
      expect(check.fixVi).toBeUndefined();
    });

    it("AC2 — is red with a Vietnamese fix when no real device is connected (emulator-only is a valid, separate state)", async () => {
      const deps = greenDeps({
        exec: mockExec({
          "xcode-select": () => ok("/Applications/Xcode.app/Contents/Developer\n"),
          idb: () => ok("idb 1.1.7\n"),
          java: () => ok("", "openjdk version \"21.0.1\" 2023-10-17\n"),
          xcrun: () => ok(bootedSimJson),
          adb: (args) => (args.includes("-l") ? ok(adbDevicesLNoRealDevice) : ok(adbDevicesBooted)),
        }),
      });
      const report = await runDoctor(deps);
      const check = report.checks.find((c) => c.id === "androidRealDevice")!;
      expect(check.ok).toBe(false);
      expect(check.fixVi).toBeTruthy();
      expect(check.fixVi).toMatch(/USB/);
      // Non-gating (E20): the rest of the machine is fully green, so this never blocks usability.
      expect(report.ok).toBe(true);
      expect(check.optional).toBe(true);
    });

    it("AC2 (test matrix #2) — reports red with a specific 'accept the RSA prompt' fix hint when the device is unauthorized", async () => {
      const deps = greenDeps({
        exec: mockExec({
          "xcode-select": () => ok("/Applications/Xcode.app/Contents/Developer\n"),
          idb: () => ok("idb 1.1.7\n"),
          java: () => ok("", "openjdk version \"21.0.1\" 2023-10-17\n"),
          xcrun: () => ok(bootedSimJson),
          adb: (args) => (args.includes("-l") ? ok(adbDevicesLUnauthorized) : ok(adbDevicesNoneBooted)),
        }),
      });
      const report = await runDoctor(deps);
      const check = report.checks.find((c) => c.id === "androidRealDevice")!;
      expect(check.ok).toBe(false);
      expect(check.detail).toMatch(/unauthorized/);
      expect(check.fixVi).toMatch(/Cho phép|Allow/);
    });

    it("is red when `adb devices -l` itself fails", async () => {
      const deps = greenDeps({
        exec: mockExec({
          "xcode-select": () => ok("/Applications/Xcode.app/Contents/Developer\n"),
          idb: () => ok("idb 1.1.7\n"),
          java: () => ok("", "openjdk version \"21.0.1\" 2023-10-17\n"),
          xcrun: () => ok(bootedSimJson),
          adb: (args) => (args.includes("-l") ? fail("adb server not running") : ok(adbDevicesBooted)),
        }),
      });
      const report = await runDoctor(deps);
      const check = report.checks.find((c) => c.id === "androidRealDevice")!;
      expect(check.ok).toBe(false);
      expect(check.fixVi).toBeTruthy();
    });

    it("a missing device-model lookup (getprop fails) still reports green — model is informational only", async () => {
      const deps = greenDeps({
        exec: mockExec({
          "xcode-select": () => ok("/Applications/Xcode.app/Contents/Developer\n"),
          idb: () => ok("idb 1.1.7\n"),
          java: () => ok("", "openjdk version \"21.0.1\" 2023-10-17\n"),
          xcrun: () => ok(bootedSimJson),
          adb: (args) => {
            if (args.includes("-l")) return ok(adbDevicesLWithRealDevice);
            if (args[0] === "-s") return fail("device offline mid-query");
            return ok(adbDevicesBooted);
          },
        }),
      });
      const report = await runDoctor(deps);
      const check = report.checks.find((c) => c.id === "androidRealDevice")!;
      expect(check.ok).toBe(true);
      expect(check.detail).toMatch(/R58N1234ABC/);
    });
  });

  it("AC6: every red result across a fully-broken machine carries a non-blank fix message", async () => {
    const deps: DoctorDeps = {
      exec: mockExec({
        "xcode-select": () => fail("not found"),
        idb: () => fail("not found"),
        which: () => fail("not found"),
        java: () => fail("not found"),
        xcrun: () => fail("not found"),
        adb: () => fail("not found"),
      }),
      fileExists: () => false,
      podiumEntryPath: "/fake/podium/dist/index.js",
      androidHome: undefined,
    };
    const report = await runDoctor(deps);
    expect(report.ok).toBe(false);
    expect(report.platforms).toEqual({ ios: false, android: false });
    const redChecks = report.checks.filter((c) => !c.ok);
    expect(redChecks.length).toBe(9);
    for (const c of redChecks) {
      expect(c.fixVi).toBeTruthy();
      expect(c.fixVi!.trim().length).toBeGreaterThan(0);
      // Neither platform is usable here, so nothing GATING is annotated "optional" — a gating
      // check is only ever optional when the OTHER platform is fully green (R2 platform-
      // awareness). androidRealDevice is the one exception: it's NON-GATING (E20) and therefore
      // ALWAYS optional when red, regardless of platform state — an unplugged real device never
      // means "broken", even on an otherwise fully-broken machine.
      if (c.id === "androidRealDevice") {
        expect(c.optional).toBe(true);
      } else {
        expect(c.optional).toBeUndefined();
      }
    }
  });

  // ─── Platform-awareness (R2 follow-up, raised during E10 AC5) ────────────────────────
  // Doctor's overall `ok` no longer means "every single check passed" — it means "the shared
  // infra works AND at least one of iOS/Android is fully usable". An iOS-only QA's machine
  // must never be reported as broken just because the Android SDK isn't installed, and vice
  // versa. Individual red checks belonging to the platform NOT relied upon are annotated
  // `optional: true` rather than dragging the whole report down.
  describe("platform-awareness", () => {
    it("an iOS-only machine (Android toolchain entirely absent) reports ok:true overall, with every Android check optional", async () => {
      const deps = greenDeps({
        androidHome: undefined,
        exec: mockExec({
          "xcode-select": () => ok("/Applications/Xcode.app/Contents/Developer\n"),
          idb: () => ok("idb 1.1.7\n"),
          java: () => ok("", "openjdk version \"21.0.1\" 2023-10-17\n"),
          xcrun: () => ok(bootedSimJson),
          adb: () => fail("spawn adb ENOENT"),
        }),
      });
      const report = await runDoctor(deps);
      expect(report.ok).toBe(true);
      expect(report.platforms).toEqual({ ios: true, android: false });
      for (const c of report.checks.filter((c) => c.platform === "android")) {
        expect(c.ok).toBe(false);
        expect(c.optional).toBe(true);
      }
      for (const c of report.checks.filter((c) => c.platform === "ios" || c.platform === "shared")) {
        expect(c.ok).toBe(true);
        expect(c.optional).toBeUndefined();
      }
    });

    it("an Android-only machine (iOS toolchain entirely absent) reports ok:true overall, with every iOS check optional", async () => {
      const deps = greenDeps({
        exec: mockExec({
          "xcode-select": () => fail("unable to get active developer directory"),
          idb: () => fail("spawn idb ENOENT"),
          which: () => fail("idb not found"),
          java: () => ok("", "openjdk version \"21.0.1\" 2023-10-17\n"),
          xcrun: () => fail("no simulator runtime"),
          adb: (args) => (args[0] === "devices" ? ok(adbDevicesBooted) : ok("Android Debug Bridge version 1.0.41\n")),
        }),
        fileExists: (p) => p !== "/fake/podium/dist/index.js", // podiumEngine (iOS) missing; androidSdk's path still exists
      });
      const report = await runDoctor(deps);
      expect(report.ok).toBe(true);
      // Android is fully usable here WITHOUT a real device plugged in (E20: androidRealDevice is
      // non-gating) — the emulator-only path is a complete, legitimate usability state on its own.
      expect(report.platforms).toEqual({ ios: false, android: true });
      for (const c of report.checks.filter((c) => c.platform === "ios")) {
        expect(c.ok).toBe(false);
        expect(c.optional).toBe(true);
      }
      for (const c of report.checks.filter((c) => (c.platform === "android" && c.id !== "androidRealDevice") || c.platform === "shared")) {
        expect(c.ok).toBe(true);
        expect(c.optional).toBeUndefined();
      }
      // No real device was reported in this scenario's mock — red, but non-gating (E20).
      const realDeviceCheck = report.checks.find((c) => c.id === "androidRealDevice")!;
      expect(realDeviceCheck.ok).toBe(false);
      expect(realDeviceCheck.optional).toBe(true);
    });

    it("a broken SHARED check (JRE) fails the overall report even when one platform is fully green — Maestro needs it on both platforms", async () => {
      const deps = greenDeps({
        exec: mockExec({
          "xcode-select": () => ok("/Applications/Xcode.app/Contents/Developer\n"),
          idb: () => ok("idb 1.1.7\n"),
          java: () => fail("spawn java ENOENT"),
          xcrun: () => ok(bootedSimJson),
          adb: (args) => (args[0] === "devices" ? ok(adbDevicesBooted) : ok("Android Debug Bridge version 1.0.41\n")),
        }),
      });
      const report = await runDoctor(deps);
      expect(report.ok).toBe(false);
      expect(report.platforms).toEqual({ ios: true, android: true }); // both platforms otherwise fine
      const jre = report.checks.find((c) => c.id === "jre")!;
      expect(jre.ok).toBe(false);
      // A shared check is never marked optional, regardless of platform state.
      expect(jre.optional).toBeUndefined();
    });
  });

  it("AC7 (code-level proxy): a mocked full run resolves in well under 30s and reports a duration", async () => {
    const start = Date.now();
    const report = await runDoctor(greenDeps());
    expect(Date.now() - start).toBeLessThan(30_000);
    expect(report.durationMs).toBeGreaterThanOrEqual(0);
    expect(report.durationMs).toBeLessThan(30_000);
  });
});
