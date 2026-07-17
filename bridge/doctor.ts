import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DoctorCheck, DoctorCheckId, DoctorReport } from "../shared/protocol.ts";

/**
 * doctor.ts — Environment Doctor (E5): red/green preflight for the toolchain Podium
 * Studio depends on (Xcode CLT, idb, JRE for Maestro, a booted simulator, the pinned
 * Podium engine). Every check is a REAL probe against the machine — never a stub that
 * always returns green — and every red result carries an actionable Vietnamese fix
 * (spec AC6). Guide-fix only: nothing here installs or upgrades anything.
 */

/** Shell-out primitive, injected so tests can mock command output without touching the real machine. */
export type ExecFn = (cmd: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

function defaultExec(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 8000 }, (err, stdout, stderr) => {
      if (err) {
        const e: any = err;
        e.stdout = stdout;
        e.stderr = stderr;
        reject(e);
        return;
      }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

function defaultPodiumEntryPath(): string {
  if (process.env.PODIUM_ENTRY) return process.env.PODIUM_ENTRY;
  return join(homedir(), "Documents/personal/podium/dist/index.js");
}

/** ANDROID_HOME is the modern var; ANDROID_SDK_ROOT is the older/still-common alias. */
function defaultAndroidHome(): string | undefined {
  return process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || undefined;
}

export interface DoctorDeps {
  exec: ExecFn;
  fileExists: (path: string) => boolean;
  podiumEntryPath: string;
  /** ANDROID_HOME/ANDROID_SDK_ROOT, if set — undefined when neither env var is present (E10 AC5). */
  androidHome: string | undefined;
}

export function defaultDoctorDeps(): DoctorDeps {
  return {
    exec: defaultExec,
    fileExists: existsSync,
    podiumEntryPath: defaultPodiumEntryPath(),
    androidHome: defaultAndroidHome(),
  };
}

function errMessage(err: unknown): string {
  return (err as Error)?.message ?? String(err);
}

// ─── Individual checks ──────────────────────────────────────────────────────

async function checkXcodeClt(deps: DoctorDeps): Promise<DoctorCheck> {
  const start = Date.now();
  const id: DoctorCheckId = "xcodeClt";
  const label = "Xcode Command Line Tools";
  const platform = "ios" as const;
  try {
    const { stdout } = await deps.exec("xcode-select", ["-p"]);
    const path = stdout.trim();
    if (!path) throw new Error("xcode-select -p returned an empty path");
    return { id, label, platform, ok: true, detail: `Đã cài tại ${path}`, durationMs: Date.now() - start };
  } catch (err) {
    return {
      id,
      label,
      platform,
      ok: false,
      detail: `xcode-select -p thất bại: ${errMessage(err)}`,
      fixVi: "Chưa cài Xcode Command Line Tools. Mở Terminal và chạy: xcode-select --install",
      durationMs: Date.now() - start,
    };
  }
}

async function checkIdb(deps: DoctorDeps): Promise<DoctorCheck> {
  const start = Date.now();
  const id: DoctorCheckId = "idb";
  const label = "idb (iOS device bridge)";
  const platform = "ios" as const;
  try {
    const { stdout } = await deps.exec("idb", ["--version"]);
    return { id, label, platform, ok: true, detail: `idb --version: ${stdout.trim() || "OK"}`, durationMs: Date.now() - start };
  } catch (err) {
    // Older idb builds reject --version — fall back to a plain PATH check before going red.
    try {
      const { stdout } = await deps.exec("which", ["idb"]);
      const path = stdout.trim();
      if (path) {
        return { id, label, platform, ok: true, detail: `idb tìm thấy tại ${path}`, durationMs: Date.now() - start };
      }
    } catch {
      /* fall through to red below */
    }
    return {
      id,
      label,
      platform,
      ok: false,
      detail: `idb không chạy được: ${errMessage(err)}`,
      fixVi:
        "Chưa cài idb. Chạy: brew tap facebook/fb && brew install idb-companion, sau đó pip3 install fb-idb",
      durationMs: Date.now() - start,
    };
  }
}

async function checkJre(deps: DoctorDeps): Promise<DoctorCheck> {
  const start = Date.now();
  const id: DoctorCheckId = "jre";
  const label = "Java Runtime (bắt buộc cho Maestro)";
  // Maestro is a Java app used by BOTH platforms (the iOS hybrid boundary AND every
  // non-adb-fast Android action, per bridge/android-driver.ts) — so this is genuinely
  // "shared" infra, not tied to one platform (R2 follow-up).
  const platform = "shared" as const;
  const fixVi = "Chưa cài Java. Chạy: brew install openjdk, sau đó làm theo hướng dẫn của brew để thêm vào PATH.";
  try {
    const { stdout, stderr } = await deps.exec("java", ["-version"]);
    // java -version conventionally writes to stderr; some builds use stdout instead.
    const text = (stderr || stdout).trim();
    const ok = /version/i.test(text);
    return {
      id,
      label,
      platform,
      ok,
      detail: ok ? text.split("\n")[0] : `java -version không trả về thông tin phiên bản: ${text}`,
      ...(ok ? {} : { fixVi }),
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      id,
      label,
      platform,
      ok: false,
      detail: `java -version thất bại: ${errMessage(err)}`,
      fixVi,
      durationMs: Date.now() - start,
    };
  }
}

async function checkSimulatorBoot(deps: DoctorDeps): Promise<DoctorCheck> {
  const start = Date.now();
  const id: DoctorCheckId = "simulatorBoot";
  const label = "Simulator đang chạy";
  const platform = "ios" as const;
  const fixVi =
    "Chưa có simulator nào đang chạy. Bấm 'Start' cạnh một thiết bị trong Podium Studio, hoặc chạy: xcrun simctl boot <UDID>.";
  try {
    const { stdout } = await deps.exec("xcrun", ["simctl", "list", "devices", "booted", "-j"]);
    const parsed = JSON.parse(stdout);
    const devicesByRuntime: Record<string, Array<{ name?: string; state?: string }>> = parsed?.devices ?? {};
    const booted = Object.values(devicesByRuntime)
      .flat()
      .filter((d) => d?.state === "Booted");
    const ok = booted.length > 0;
    return {
      id,
      label,
      platform,
      ok,
      detail: ok
        ? `${booted.length} simulator đang Booted (vd: ${booted[0]?.name ?? "?"})`
        : "Không có simulator nào đang Booted",
      ...(ok ? {} : { fixVi }),
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      id,
      label,
      platform,
      ok: false,
      detail: `xcrun simctl list devices booted thất bại: ${errMessage(err)}`,
      fixVi,
      durationMs: Date.now() - start,
    };
  }
}

function checkPodiumEngine(deps: DoctorDeps): DoctorCheck {
  const start = Date.now();
  const id: DoctorCheckId = "podiumEngine";
  const label = "Podium engine (dist/index.js)";
  // The Android driver shells directly to adb/maestro (bridge/android-driver.ts) — it never
  // goes through the Podium engine, so this check is iOS-specific (R2 follow-up).
  const platform = "ios" as const;
  const ok = deps.fileExists(deps.podiumEntryPath);
  return {
    id,
    label,
    platform,
    ok,
    detail: ok
      ? `Tìm thấy engine tại ${deps.podiumEntryPath}`
      : `Không tìm thấy engine tại ${deps.podiumEntryPath}`,
    ...(ok
      ? {}
      : {
          fixVi: `Chưa build Podium engine. Chạy: cd ~/Documents/personal/podium && npm install && npm run build (hoặc đặt biến môi trường PODIUM_ENTRY trỏ tới dist/index.js đã build).`,
        }),
    durationMs: Date.now() - start,
  };
}

// ─── Android toolchain checks (E10 AC5) — same real-probe/never-fake-green shape as above ──

function checkAndroidSdk(deps: DoctorDeps): DoctorCheck {
  const start = Date.now();
  const id: DoctorCheckId = "androidSdk";
  const label = "Android SDK";
  const platform = "android" as const;
  const home = deps.androidHome;
  const ok = !!home && deps.fileExists(home);
  return {
    id,
    label,
    platform,
    ok,
    detail: ok
      ? `Tìm thấy Android SDK tại ${home}`
      : home
        ? `ANDROID_HOME/ANDROID_SDK_ROOT trỏ tới ${home} nhưng thư mục đó không tồn tại`
        : "Chưa đặt biến môi trường ANDROID_HOME hoặc ANDROID_SDK_ROOT",
    ...(ok
      ? {}
      : {
          fixVi:
            "Chưa cài Android SDK (hoặc thiếu biến môi trường). Cài Android Studio (đã bao gồm SDK), " +
            "sau đó đặt: export ANDROID_HOME=$HOME/Library/Android/sdk (thêm dòng này vào ~/.zshrc).",
        }),
    durationMs: Date.now() - start,
  };
}

async function checkAdb(deps: DoctorDeps): Promise<DoctorCheck> {
  const start = Date.now();
  const id: DoctorCheckId = "adb";
  const label = "adb (Android Debug Bridge)";
  const platform = "android" as const;
  try {
    const { stdout } = await deps.exec("adb", ["--version"]);
    const firstLine = stdout.trim().split("\n")[0];
    return { id, label, platform, ok: true, detail: `adb --version: ${firstLine || "OK"}`, durationMs: Date.now() - start };
  } catch (err) {
    return {
      id,
      label,
      platform,
      ok: false,
      detail: `adb --version thất bại: ${errMessage(err)}`,
      fixVi:
        "Chưa cài adb. Cài Android SDK platform-tools (đi kèm Android Studio, hoặc chạy: " +
        "brew install --cask android-platform-tools), rồi thêm vào PATH.",
      durationMs: Date.now() - start,
    };
  }
}

async function checkAndroidEmulatorBoot(deps: DoctorDeps): Promise<DoctorCheck> {
  const start = Date.now();
  const id: DoctorCheckId = "androidEmulatorBoot";
  const label = "Trình giả lập Android đang chạy";
  const platform = "android" as const;
  const fixVi =
    "Chưa có trình giả lập/thiết bị Android nào đang chạy. Mở Android Studio > Device Manager và khởi động " +
    "một AVD, hoặc chạy: emulator -avd <tên_AVD>.";
  try {
    const { stdout } = await deps.exec("adb", ["devices"]);
    // "adb devices" prints a header line then one "<serial>\t<state>" line per device;
    // "device" = booted and ready (as opposed to "offline"/"unauthorized"/"no permissions").
    const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    const devices = lines.slice(1).map((l) => {
      const [serial, state] = l.split(/\s+/);
      return { serial, state };
    });
    const booted = devices.filter((d) => d.state === "device");
    const ok = booted.length > 0;
    return {
      id,
      label,
      platform,
      ok,
      detail: ok
        ? `${booted.length} thiết bị/trình giả lập Android đang chạy (vd: ${booted[0].serial})`
        : "Không có trình giả lập hoặc thiết bị Android nào đang chạy.",
      ...(ok ? {} : { fixVi }),
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      id,
      label,
      platform,
      ok: false,
      detail: `adb devices thất bại: ${errMessage(err)}`,
      fixVi,
      durationMs: Date.now() - start,
    };
  }
}

// ─── Real-device preflight (E20 AC2) — informational, never gates Android usability ──────────
// An emulator-only setup is ALREADY fully usable (E10's own gate) — plugging in a real device is
// an additional, opt-in capability, not a baseline requirement. See NON_GATING_CHECKS below for
// how this stays visible in the report without ever making `platforms.android` false just
// because no USB device happens to be connected right now.

async function checkAndroidRealDevice(deps: DoctorDeps): Promise<DoctorCheck> {
  const start = Date.now();
  const id: DoctorCheckId = "androidRealDevice";
  const label = "Thiết bị Android thật (USB) đã sẵn sàng";
  const platform = "android" as const;
  try {
    const { stdout } = await deps.exec("adb", ["devices", "-l"]);
    const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
    const entries = lines.slice(1).map((l) => {
      const [serial, state] = l.split(/\s+/);
      return { serial, state };
    });
    // A real device's serial never starts with "emulator-" (that prefix is reserved for the
    // Android Emulator's own adb transport) — this is how this check tells "a real, USB-connected
    // device" apart from an emulator/AVD, with NO new driver code: bridge/android-driver.ts
    // already just takes an opaque `serial: string` (E20 AC1's "no per-device fork").
    const realDevices = entries.filter((d) => d.serial && !d.serial.startsWith("emulator-"));

    if (realDevices.length === 0) {
      return {
        id, label, platform, ok: false,
        detail: "Không có thiết bị Android thật nào được cắm qua USB.",
        fixVi:
          "Cắm điện thoại Android qua cáp USB, bật 'Gỡ lỗi USB' trong Tùy chọn nhà phát triển, " +
          "rồi chạy: adb devices để kiểm tra.",
        fixCode: "noDevice",
        durationMs: Date.now() - start,
      };
    }

    const ready = realDevices.filter((d) => d.state === "device");
    if (ready.length === 0) {
      const unauthorized = realDevices.some((d) => d.state === "unauthorized");
      return {
        id, label, platform, ok: false,
        detail: `Thiết bị Android thật chưa sẵn sàng: ${realDevices.map((d) => `${d.serial} (${d.state})`).join(", ")}`,
        fixVi: unauthorized
          ? "Trên điện thoại sẽ hiện hộp thoại 'Cho phép gỡ lỗi USB?' — chọn Cho phép (Allow). " +
            "Nếu không thấy hộp thoại, rút cáp và cắm lại, sau đó chạy: adb devices."
          : "Kiểm tra cáp USB và mở khóa màn hình điện thoại, sau đó chạy: adb devices để kiểm tra lại.",
        fixCode: unauthorized ? "unauthorized" : "notReady",
        durationMs: Date.now() - start,
      };
    }

    // Device model is informational only (best-effort) — never gates this check's own ok/red.
    let model = "";
    try {
      const modelResult = await deps.exec("adb", ["-s", ready[0].serial, "shell", "getprop", "ro.product.model"]);
      model = modelResult.stdout.trim();
    } catch {
      /* best-effort — a missing model string never turns a ready device red */
    }
    return {
      id, label, platform, ok: true,
      detail: `${ready.length} thiết bị Android thật sẵn sàng (vd: ${model ? `${model}, ` : ""}${ready[0].serial})`,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      id, label, platform, ok: false,
      detail: `adb devices -l thất bại: ${errMessage(err)}`,
      fixVi: "Chạy: adb devices để kiểm tra adb đã hoạt động chưa.",
      fixCode: "execFailed",
      durationMs: Date.now() - start,
    };
  }
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

/** Checks that report their platform for DISPLAY/grouping purposes but never gate that
 * platform's usability (E20): a real, USB-connected device is an optional EXTRA capability on
 * top of an already-fully-usable emulator setup, not a requirement for one. Kept as its own set
 * (rather than a new DoctorPlatform value) so the wire shape (`DoctorReport.platforms`) doesn't
 * need a third boolean just for this. */
const NON_GATING_CHECKS = new Set<DoctorCheckId>(["androidRealDevice"]);

/**
 * Roll per-check results up into the platform-aware report shape (R2 follow-up, raised during
 * E10 AC5: a machine set up for iOS-only work was reported all-red-ish just because it has no
 * Android SDK). "shared" checks (currently just JRE) always gate usability; "ios"/"android"
 * checks only gate THAT platform — a red check on a platform the OTHER platform's checks are
 * all green for is annotated `optional: true` rather than dragging the whole report red. A
 * NON_GATING check is annotated `optional: true` whenever it's red UNCONDITIONALLY (E20) — it
 * never counts toward `iosOk`/`androidOk` at all, so "no real device plugged in" can never make
 * an otherwise-fully-usable emulator-only Android setup report as broken.
 */
function withPlatformAwareness(checks: DoctorCheck[]): { checks: DoctorCheck[]; ok: boolean; platforms: { ios: boolean; android: boolean } } {
  const gating = (c: DoctorCheck) => !NON_GATING_CHECKS.has(c.id);
  const sharedOk = checks.filter((c) => c.platform === "shared" && gating(c)).every((c) => c.ok);
  const iosOk = checks.filter((c) => c.platform === "ios" && gating(c)).every((c) => c.ok);
  const androidOk = checks.filter((c) => c.platform === "android" && gating(c)).every((c) => c.ok);
  const annotated = checks.map((c) => {
    if (c.ok || c.platform === "shared") return c;
    if (!gating(c)) return { ...c, optional: true };
    const otherPlatformOk = c.platform === "ios" ? androidOk : iosOk;
    return otherPlatformOk ? { ...c, optional: true } : c;
  });
  return { checks: annotated, ok: sharedOk && (iosOk || androidOk), platforms: { ios: iosOk, android: androidOk } };
}

/** Run the full Doctor report (9 checks — 1 shared + 4 iOS + 4 Android — in parallel; target <30s wall-clock, spec AC7). */
export async function runDoctor(deps: DoctorDeps = defaultDoctorDeps()): Promise<DoctorReport> {
  const start = Date.now();
  const rawChecks = await Promise.all([
    checkXcodeClt(deps),
    checkIdb(deps),
    checkJre(deps),
    checkSimulatorBoot(deps),
    Promise.resolve(checkPodiumEngine(deps)),
    Promise.resolve(checkAndroidSdk(deps)),
    checkAdb(deps),
    checkAndroidEmulatorBoot(deps),
    checkAndroidRealDevice(deps),
  ]);
  const { checks, ok, platforms } = withPlatformAwareness(rawChecks);
  return { ok, checks, durationMs: Date.now() - start, platforms };
}
