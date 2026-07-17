import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isStepIdempotent, type FlowStep } from "../shared/ir.ts";
import { flowYamlForStep } from "../shared/maestro.ts";
import type { Driver, DriverAvailability, DriverContext, StepOutcome } from "./driver.ts";
import { isTransientError, MAX_RETRIES } from "./runner.ts";

/**
 * AndroidDriver (E10 — janus-specs/R2-desktop-android/E10-android-driver.md).
 *
 * Android is a second mobile platform behind the same `Driver` seam iOS-sim (`mobileDriver`,
 * via the Podium engine) and browser (`browserDriver`, via CloakBrowser/Playwright) already
 * implement. Unlike those two, there is no Podium/CloakBrowser SDK wrapping the tooling here
 * — this driver shells out DIRECTLY to `adb` (device-level ops with no accessibility-tree
 * need: raw-coordinate tap, key press, a timed wait, a screenshot) and the `maestro` CLI
 * (anything needing a11y resolution: tap by text, type, wait/assert by text, double-tap/
 * long-press/scroll/erase/control-flow/...). Both are the same real, external tools the
 * platform capability matrix (IR-SPEC.md §3) and Environment Doctor (E5) already treat as
 * part of the "mobile" toolchain.
 *
 * "Hybrid runner parity" (spec scope) means: the adb-fast subset above is the Android
 * equivalent of Podium's fast `run_steps` path; everything else compiles through the EXACT
 * SAME `shared/maestro.ts` YAML generator the iOS path already uses — Maestro's own command
 * set is genuinely cross-platform (IR-SPEC.md never had an iOS-only Maestro dialect), so
 * Android gets that mapping for free instead of a re-implementation that could drift from it.
 *
 * No real Android emulator is available in this environment (per the epic's own scope note,
 * mirrored from `bridge/browser-driver.ts`'s CloakBrowser precedent) — every adb/maestro CLI
 * call below is a REAL subprocess call, never faked, but only the pure mapping/dispatch layer
 * is unit-tested here (a mocked `exec`); AC1 (20-run pass rate), AC2 (retry on a REAL transient
 * failure), and AC5 (Doctor on a REAL machine missing the SDK) need a human with real hardware.
 */

export type AndroidExecFn = (
  cmd: string,
  args: string[],
  envOverrides?: Record<string, string>,
) => Promise<{ stdout: string; stderr: string }>;

function defaultExec(cmd: string, args: string[], envOverrides?: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: 15_000, env: envOverrides ? { ...process.env, ...envOverrides } : undefined },
      (err, stdout, stderr) => {
        if (err) {
          const e: any = err;
          e.stdout = stdout;
          e.stderr = stderr;
          reject(e);
          return;
        }
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

function errMessage(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

/** Is BOTH `adb` and the `maestro` CLI reachable on PATH? Never fakes a green result. */
export async function detectAndroidRuntime(exec: AndroidExecFn = defaultExec): Promise<DriverAvailability> {
  try {
    await exec("adb", ["version"]);
  } catch (err) {
    return {
      ok: false,
      reason: `adb not found on PATH — install Android SDK platform-tools (part of Android Studio, or ` +
        `\`brew install --cask android-platform-tools\`). (${errMessage(err)})`,
    };
  }
  try {
    await exec("maestro", ["--version"]);
  } catch (err) {
    return {
      ok: false,
      reason: `maestro CLI not found on PATH — install it: curl -Ls "https://get.maestro.mobile.dev" | bash. (${errMessage(err)})`,
    };
  }
  return { ok: true };
}

/** IR keys (§2 `key` action) → Android keyevent codes. "lock" has no distinct Android keyevent — same as physically pressing power. */
const ANDROID_KEYEVENT: Record<string, string> = {
  enter: "66",
  home: "3",
  lock: "26",
  backspace: "67",
  "volume up": "24",
  "volume down": "25",
  back: "4",
  power: "26",
  tab: "61",
};

async function adbTap(exec: AndroidExecFn, serial: string, x: number, y: number): Promise<void> {
  await exec("adb", ["-s", serial, "shell", "input", "tap", String(Math.round(x)), String(Math.round(y))]);
}

async function adbKeyEvent(exec: AndroidExecFn, serial: string, keycode: string): Promise<void> {
  await exec("adb", ["-s", serial, "shell", "input", "keyevent", keycode]);
}

/** Screenshot via a device-side temp file + `adb pull` — safer than piping PNG bytes through execFile's text-mode stdout. */
async function adbScreenshot(exec: AndroidExecFn, serial: string, savePath: string): Promise<void> {
  const remotePath = "/sdcard/podium-studio-shot.png";
  await exec("adb", ["-s", serial, "shell", "screencap", "-p", remotePath]);
  await exec("adb", ["-s", serial, "pull", remotePath, savePath]);
  await exec("adb", ["-s", serial, "shell", "rm", remotePath]).catch(() => {
    /* best-effort device-side cleanup */
  });
}

/**
 * Compile a step to Maestro YAML (via `shared/maestro.ts`, shared verbatim with the iOS
 * path) and run it against one emulator with `maestro test`. `ANDROID_SERIAL` is adb's own
 * device-targeting convention, which Maestro's Android support respects internally.
 */
async function runMaestroFlow(exec: AndroidExecFn, serial: string, yaml: string): Promise<{ ok: boolean; detail?: string }> {
  const dir = await mkdtemp(join(tmpdir(), "podium-studio-android-"));
  const flowPath = join(dir, "flow.yaml");
  try {
    await writeFile(flowPath, yaml, "utf8");
    const { stdout } = await exec("maestro", ["test", flowPath], { ANDROID_SERIAL: serial });
    return { ok: true, detail: stdout.trim() || undefined };
  } catch (err: any) {
    const raw = err?.stdout || err?.stderr || err?.message || String(err);
    return { ok: false, detail: String(raw).slice(0, 2000) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {
      /* best-effort temp-dir cleanup */
    });
  }
}

/** Actions dispatched straight to `adb shell` — no accessibility-tree resolution needed. Exported for tests/introspection. */
export const ADB_FAST_ACTIONS = new Set<FlowStep["action"]>(["tap", "key", "waitMs", "screenshot"]);

export function isAdbFastAction(action: FlowStep["action"]): boolean {
  return ADB_FAST_ACTIONS.has(action);
}

export interface AndroidStepContext {
  bundleId?: string;
  fixtures?: Record<string, unknown>;
  /** Captured-variable env passed across the native↔Maestro boundary (E2 AC4 / spec AC3). */
  env?: Record<string, string>;
  /** Already-resolved `${secret:name}` → value map (E12, bridge/secrets.ts) — kept as a
   * SEPARATE field from `fixtures`/`env`, mirroring `DriverContext.secrets` (bridge/driver.ts),
   * so a secret value can never travel through the same object that might get persisted. */
  secrets?: Record<string, string>;
  screenshotPath?: string;
}

/**
 * Execute ONE IR step against one already-booted Android emulator. Kept as a standalone
 * function (not a method) so it's directly unit-testable with a mocked `exec` — no real
 * emulator needed — mirroring `browser-driver.ts`'s `mapStepToBrowserAction` split between
 * "untestable without a real X" (the CLI calls) and "pure enough to unit-test" (this dispatch).
 */
export async function mapStepToAndroidAction(
  step: FlowStep,
  serial: string,
  ctx: AndroidStepContext = {},
  exec: AndroidExecFn = defaultExec,
): Promise<StepOutcome> {
  try {
    switch (step.action) {
      case "tap":
        await adbTap(exec, serial, step.x, step.y);
        return { ok: true, backend: "adb" };
      case "key": {
        const code = ANDROID_KEYEVENT[step.key];
        if (!code) return { ok: false, error: `No Android keyevent mapping for "${step.key}"`, backend: "adb" };
        await adbKeyEvent(exec, serial, code);
        return { ok: true, backend: "adb" };
      }
      case "waitMs":
        await new Promise((resolve) => setTimeout(resolve, step.ms));
        return { ok: true, backend: "adb" };
      case "screenshot": {
        if (!ctx.screenshotPath) return { ok: false, error: "screenshot needs ctx.screenshotPath", backend: "adb" };
        await adbScreenshot(exec, serial, ctx.screenshotPath);
        return { ok: true, backend: "adb" };
      }
      default:
        break; // falls through to the Maestro path below
    }

    if (!ctx.bundleId) {
      return { ok: false, error: "This action needs the flow's app bundle id (Android package name)." };
    }
    const yaml = flowYamlForStep(step, ctx.bundleId, ctx.fixtures ?? {}, ctx.env, ctx.secrets);
    const result = await runMaestroFlow(exec, serial, yaml);
    return {
      ok: result.ok,
      backend: "maestro",
      detail: result.ok ? result.detail : undefined,
      error: result.ok ? undefined : (result.detail ?? "maestro step failed"),
    };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

/**
 * Per-action retry with idempotency (E2 AC2/AC3, applied to Android per spec AC2). Reuses the
 * EXACT SAME transient-failure heuristic and retry cap `bridge/runner.ts`'s `runStepWithRetry`
 * already uses for iOS-sim (`isTransientError`/`MAX_RETRIES`, imported not reimplemented), so
 * retry behavior can't silently diverge between platforms — this is a thin platform-specific
 * loop around shared logic.
 */
export async function runAndroidStepWithRetry(
  step: FlowStep,
  serial: string,
  ctx: AndroidStepContext = {},
  exec: AndroidExecFn = defaultExec,
): Promise<{ outcome: StepOutcome; attempts: number }> {
  const canRetry = isStepIdempotent(step);
  let attempts = 0;
  let outcome: StepOutcome;
  for (;;) {
    attempts += 1;
    outcome = await mapStepToAndroidAction(step, serial, ctx, exec);
    if (outcome.ok) return { outcome, attempts };
    if (!canRetry || attempts > MAX_RETRIES || !isTransientError(outcome.error)) return { outcome, attempts };
  }
}

/**
 * The `Driver` implementation for Android (E10). Conforms to the same interface `mobileDriver`
 * (iOS-sim) and `browserDriver` already implement — same `StepOutcome` shape, so a caller that
 * only knows about the `Driver` seam gets an identical report schema regardless of platform
 * (spec AC4: "no Android-only report format"). `platform: "mobile"` (not a new platform value)
 * because IR-SPEC.md's capability matrix only ever distinguished Mobile vs Browser, never iOS
 * vs Android — both mobile platforms share one capability row; `name` is what tells them apart.
 */
export const androidDriver: Driver = {
  platform: "mobile",
  name: "maestro-adb",
  async isAvailable() {
    return detectAndroidRuntime();
  },
  async executeStep(step: FlowStep, ctx: DriverContext): Promise<StepOutcome> {
    if (!ctx.udid) {
      return { ok: false, error: 'androidDriver.executeStep requires ctx.udid (the emulator serial, e.g. "emulator-5554")' };
    }
    return mapStepToAndroidAction(step, ctx.udid, {
      bundleId: ctx.bundleId,
      fixtures: ctx.fixtures,
      env: ctx.env,
      secrets: ctx.secrets,
      screenshotPath: ctx.screenshotPath,
    });
  },
};
