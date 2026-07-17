import { describe, it, expect } from "vitest";
import { vi as viMessages } from "../src/i18n/locales/vi.ts";
import { en as enMessages } from "../src/i18n/locales/en.ts";
import { doctorCheckLabel, doctorCheckFix } from "../src/components/DoctorPanel.tsx";
import { localizedLintMessage } from "../src/components/StepEditor.tsx";
import { localizedNextAction, localizedTriageReason } from "../src/components/TriagePanel.tsx";
import { localizedSeedResetError } from "../src/components/EnvironmentPanel.tsx";
import { renderStepDescriptor, localizedStepDescription } from "../src/step-desc.ts";
import { friendlyRunError, friendlyValidation, platformLabel, friendlyApiError } from "../src/friendly.ts";
import { ApiError } from "../src/api.ts";
import { describeStepCode, type Flow, type FlowStep } from "../shared/ir.ts";
import type { DoctorCheck, SeedResetResult } from "../shared/protocol.ts";
import type { LintFinding } from "../shared/lint.ts";
import type { TriageInput } from "../shared/triage.ts";

/**
 * Task #47: flipping the locale to EN must translate every code-produced payload this app
 * renders (Doctor checks, lint findings, triage next-action/reason) — not just src/i18n's own
 * static UI copy. These payloads (bridge/doctor.ts, shared/lint.ts, shared/triage.ts) carry a
 * STABLE machine code (DoctorCheck.id, LintFinding.class, TriageClass) alongside their raw
 * Vietnamese text; the fix looks the code up in src/i18n instead of rendering the raw text.
 *
 * Mirrors the real digPath+{{var}} logic in src/i18n/index.tsx's useT() rather than a stub, so
 * this also doubles as a check that every key referenced by the mapping functions actually
 * exists in both locales.
 */
function makeT(messages: typeof viMessages) {
  function digPath(obj: unknown, path: string): string | undefined {
    const value = path
      .split(".")
      .reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), obj);
    return typeof value === "string" ? value : undefined;
  }
  return (path: string, vars?: Record<string, string | number>) => {
    const raw = digPath(messages, path) ?? digPath(enMessages, path) ?? path;
    if (!vars) return raw;
    return Object.entries(vars).reduce((acc, [key, val]) => acc.replaceAll(`{{${key}}}`, String(val)), raw);
  };
}

const tEn = makeT(enMessages);
const tVi = makeT(viMessages);

function makeDoctorCheck(overrides: Partial<DoctorCheck>): DoctorCheck {
  return {
    id: "xcodeClt",
    label: "raw bridge label",
    ok: false,
    detail: "raw detail",
    fixVi: "raw bridge fixVi",
    durationMs: 1,
    platform: "ios",
    ...overrides,
  };
}

describe("doctorCheckLabel / doctorCheckFix (task #47)", () => {
  it("localizes a known check id's label/fix in both locales", () => {
    const c = makeDoctorCheck({ id: "jre", platform: "shared" });
    expect(doctorCheckLabel(tEn, c)).toBe("Java Runtime (required for Maestro)");
    expect(doctorCheckLabel(tVi, c)).toBe("Java Runtime (bắt buộc cho Maestro)");
    expect(doctorCheckFix(tEn, c)).toContain("brew install openjdk");
    expect(doctorCheckFix(tVi, c)).toContain("brew install openjdk");
    // Never the raw bridge string once localized.
    expect(doctorCheckLabel(tEn, c)).not.toBe(c.label);
    expect(doctorCheckFix(tEn, c)).not.toBe(c.fixVi);
  });

  it("covers every DoctorCheckId with a label in both locales", () => {
    const ids: DoctorCheck["id"][] = [
      "xcodeClt", "idb", "jre", "simulatorBoot", "podiumEngine",
      "androidSdk", "adb", "androidEmulatorBoot", "androidRealDevice",
    ];
    for (const id of ids) {
      const c = makeDoctorCheck({ id });
      expect(doctorCheckLabel(tEn, c)).not.toBe(`doctorPanel.checks.${id}.label`);
      expect(doctorCheckLabel(tVi, c)).not.toBe(`doctorPanel.checks.${id}.label`);
    }
  });

  it("falls back to the raw bridge label/fixVi for an unrecognized id", () => {
    const c = { ...makeDoctorCheck({}), id: "somethingBrandNew" as DoctorCheck["id"] };
    expect(doctorCheckLabel(tEn, c)).toBe("raw bridge label");
    expect(doctorCheckFix(tEn, c)).toBe("raw bridge fixVi");
  });

  it("returns undefined for fix when the check has no fixVi (a passing check)", () => {
    const c = makeDoctorCheck({ ok: true, fixVi: undefined });
    expect(doctorCheckFix(tEn, c)).toBeUndefined();
  });

  it("androidRealDevice's fix is localized per fixCode sub-state (task #48 follow-up to #47)", () => {
    const codes = ["noDevice", "unauthorized", "notReady", "execFailed"] as const;
    for (const fixCode of codes) {
      const c = makeDoctorCheck({ id: "androidRealDevice", fixVi: "raw bridge fixVi for this state", fixCode });
      expect(doctorCheckFix(tEn, c)).not.toBe(c.fixVi);
      expect(doctorCheckFix(tVi, c)).not.toBe(c.fixVi);
      expect(doctorCheckFix(tEn, c)).not.toBe(`doctorPanel.checks.androidRealDevice.fix.${fixCode}`);
    }
    // The 4 sub-states resolve to 4 DIFFERENT strings (not flattened into one generic message).
    const resolved = new Set(codes.map((fixCode) => doctorCheckFix(tEn, makeDoctorCheck({ id: "androidRealDevice", fixVi: "x", fixCode }))));
    expect(resolved.size).toBe(4);
  });

  it("androidRealDevice falls back to the raw bridge fixVi when fixCode is missing (old-bridge/new-client skew)", () => {
    const c = makeDoctorCheck({ id: "androidRealDevice", fixVi: "Cắm điện thoại Android qua cáp USB...", fixCode: undefined });
    expect(doctorCheckFix(tEn, c)).toBe(c.fixVi);
    expect(doctorCheckFix(tVi, c)).toBe(c.fixVi);
  });
});

function makeFinding(overrides: Partial<LintFinding>): LintFinding {
  return { class: "no-match", message: "raw vietnamese message", ...overrides };
}

describe("localizedLintMessage (task #47)", () => {
  it("localizes no-match, unreachable, and no-assertion with no embedded data", () => {
    expect(localizedLintMessage(tEn, makeFinding({ class: "no-match" }))).toMatch(/no element matched/i);
    expect(localizedLintMessage(tEn, makeFinding({ class: "unreachable" }))).toMatch(/will never run/i);
    expect(localizedLintMessage(tEn, makeFinding({ class: "no-assertion" }))).toMatch(/no assertion step/i);
    expect(localizedLintMessage(tVi, makeFinding({ class: "no-match" }))).toMatch(/Không tìm thấy/);
  });

  it("interpolates matchCount for ambiguous-match", () => {
    const finding = makeFinding({ class: "ambiguous-match", matchCount: 3 });
    expect(localizedLintMessage(tEn, finding)).toBe("Matched 3 elements — please choose a more specific one.");
    expect(localizedLintMessage(tVi, finding)).toBe("Khớp 3 phần tử — vui lòng chọn phần tử cụ thể hơn.");
  });

  it("never renders the raw Vietnamese message field once localized to EN", () => {
    const finding = makeFinding({ class: "no-match", message: "Không tìm thấy phần tử nào khớp với \"OK\" trên màn hình." });
    expect(localizedLintMessage(tEn, finding)).not.toBe(finding.message);
  });
});

describe("localizedNextAction / localizedTriageReason (task #47)", () => {
  it("localizes nextAction for all 5 triage classes", () => {
    expect(localizedNextAction(tEn, "realAppBug")).toMatch(/report the app bug/i);
    expect(localizedNextAction(tEn, "flake")).toMatch(/re-run/i);
    expect(localizedNextAction(tEn, "badSelector")).toMatch(/update the element selector/i);
    expect(localizedNextAction(tEn, "appChanged")).toMatch(/review the screen change/i);
    expect(localizedNextAction(tEn, "wrongExpectedValue")).toMatch(/review the expected value/i);
  });

  it("localizes flake's reason with attempts interpolated", () => {
    const input: TriageInput = { action: "tapText", passedOnRetry: true, attempts: 3 };
    expect(localizedTriageReason(tEn, "flake", input)).toBe(
      "This step failed but passed on a later retry (3 attempts) — not a deterministic failure.",
    );
  });

  it("distinguishes badSelector's no-match vs ambiguous sub-cases via selectorMatchCount", () => {
    const noMatch: TriageInput = { action: "tapText", selectorMatchCount: 0 };
    const ambiguous: TriageInput = { action: "tapText", selectorMatchCount: 4 };
    expect(localizedTriageReason(tEn, "badSelector", noMatch)).toMatch(/no element matched the selector/i);
    expect(localizedTriageReason(tEn, "badSelector", ambiguous)).toBe(
      "The selector matched 4 elements — a more specific selector is needed.",
    );
  });

  it("localizes appChanged's reason with the match count interpolated", () => {
    const input: TriageInput = { action: "assertVisible", selectorMatchCount: 2, screenStructureChanged: true };
    expect(localizedTriageReason(tEn, "appChanged", input)).toContain("matched 2 element(s)");
  });

  it("localizes wrongExpectedValue and realAppBug with no interpolation needed", () => {
    const input: TriageInput = { action: "assertVisible" };
    expect(localizedTriageReason(tEn, "wrongExpectedValue", input)).toMatch(/asserted value didn't match/i);
    expect(localizedTriageReason(tEn, "realAppBug", input)).toMatch(/most likely a real app bug/i);
    // Same in Vietnamese, matching shared/triage.ts's own literal reason strings.
    expect(localizedTriageReason(tVi, "realAppBug", input)).toBe(
      "Không khớp với bất kỳ nguyên nhân nào ở trên (không phải flake, không phải bộ chọn, không phải thay đổi màn hình, không phải sai giá trị mong đợi) — nhiều khả năng là lỗi ứng dụng thật.",
    );
  });
});

// ── describeStepCode / step-desc (task #48) ─────────────────────────────────────────────────

/** Every code shared/ir.ts's describeStepCode() can produce — used both to drive sample steps
 * below and as a standalone parity check that every one of them has an entry in BOTH locales. */
const STEP_DESC_CODES = [
  "tap", "tapText", "type", "typeSubmit", "key", "swipe", "waitFor", "waitMs", "screenshot",
  "assertVisible", "doubleTap", "longPress", "tapIfVisible", "clearText", "deleteText",
  "hideKeyboard", "scroll", "scrollUntilVisible", "back", "assertNotVisible", "waitForNotVisible",
  "openLink", "launchApp", "launchAppDefault", "stopApp", "stopAppDefault", "copyText",
  "pasteText", "raw", "ifVisible", "ifNotVisible", "repeatWhileVisible", "repeatTimes", "callSubFlow",
] as const;

function digPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), obj);
}

describe("describeStepCode / renderStepDescriptor (task #48)", () => {
  it("every stepDesc code has a string entry in both locales", () => {
    for (const code of STEP_DESC_CODES) {
      expect(typeof digPath(enMessages, `stepDesc.${code}`)).toBe("string");
      expect(typeof digPath(viMessages, `stepDesc.${code}`)).toBe("string");
    }
  });

  it("returns a custom descriptor verbatim when the step has an author label — never through t()", () => {
    const step: FlowStep = { id: "s1", label: "My custom label", action: "tap", x: 1, y: 2 };
    const d = describeStepCode(step);
    expect(d).toEqual({ custom: "My custom label" });
    expect(renderStepDescriptor(tEn, d)).toBe("My custom label");
    expect(renderStepDescriptor(tVi, d)).toBe("My custom label");
  });

  it("localizes tap/tapText/type with interpolated data, differently per locale", () => {
    expect(localizedStepDescription(tEn, { id: "s1", action: "tap", x: 10, y: 20 })).toBe("Tap at (10, 20)");
    expect(localizedStepDescription(tVi, { id: "s1", action: "tap", x: 10, y: 20 })).toBe("Chạm tại (10, 20)");

    expect(localizedStepDescription(tEn, { id: "s1", action: "tapText", text: "OK" })).toBe('Tap "OK"');
    expect(localizedStepDescription(tVi, { id: "s1", action: "tapText", text: "OK" })).toBe('Chạm "OK"');

    expect(localizedStepDescription(tEn, { id: "s1", action: "type", text: "hello" })).toBe('Type "hello"');
    expect(localizedStepDescription(tEn, { id: "s1", action: "type", text: "hello", submit: true })).toBe('Type "hello" + Enter');
  });

  it("distinguishes launchApp/stopApp with vs without an explicit bundleId", () => {
    expect(localizedStepDescription(tEn, { id: "s1", action: "launchApp", bundleId: "com.example.app" })).toBe("Launch com.example.app");
    expect(localizedStepDescription(tEn, { id: "s1", action: "launchApp" })).toBe("Launch app");
    expect(localizedStepDescription(tEn, { id: "s1", action: "stopApp" })).toBe("Stop app");
  });

  it("interpolates step counts for if/repeat containers", () => {
    const ifStep: FlowStep = { id: "s1", action: "if", when: { text: "Popup" }, then: [{ id: "c1", action: "screenshot" }] };
    expect(localizedStepDescription(tEn, ifStep)).toBe('If "Popup" is visible (1 steps)');
    const ifNotStep: FlowStep = { id: "s1", action: "if", when: { text: "Popup", visible: false }, then: [{ id: "c1", action: "screenshot" }] };
    expect(localizedStepDescription(tEn, ifNotStep)).toBe('If "Popup" is NOT visible (1 steps)');

    const repeatTimesStep: FlowStep = { id: "s1", action: "repeat", times: 3, steps: [{ id: "c1", action: "screenshot" }] };
    expect(localizedStepDescription(tEn, repeatTimesStep)).toBe("Repeat 3x (1 steps)");
    const repeatWhileStep: FlowStep = { id: "s1", action: "repeat", whileVisible: "Loading", steps: [{ id: "c1", action: "screenshot" }] };
    expect(localizedStepDescription(tEn, repeatWhileStep)).toBe('Repeat while "Loading" is visible (1 steps)');
  });

  it("callSubFlow's paramsList works whether params are present or absent", () => {
    expect(localizedStepDescription(tEn, { id: "s1", action: "callSubFlow", flowFile: "login.flow.json" })).toBe("Call login.flow.json()");
    expect(localizedStepDescription(tEn, { id: "s1", action: "callSubFlow", flowFile: "login.flow.json", params: { user: "a", pass: "b" } })).toBe(
      "Call login.flow.json(user, pass)",
    );
  });
});

// ── friendly.ts (task #48) ───────────────────────────────────────────────────────────────────

describe("friendlyRunError / friendlyValidation / platformLabel (task #48)", () => {
  it("localizes every friendlyRunError branch in both locales, never the raw input", () => {
    expect(friendlyRunError(tEn, "element is ambiguous")).toMatch(/more than one thing/i);
    expect(friendlyRunError(tEn, "could not find element")).toMatch(/couldn't find that/i);
    expect(friendlyRunError(tEn, "app is not installed")).toMatch(/isn't installed/i);
    expect(friendlyRunError(tEn, "operation timed out")).toMatch(/waited as long as it could/i);
    expect(friendlyRunError(tEn, "simulator is shutdown")).toMatch(/isn't started/i);
    expect(friendlyRunError(tEn, "econnrefused talking to maestro")).toMatch(/trouble carrying out/i);
    expect(friendlyRunError(tEn, "some unrecognized engine error")).toMatch(/didn't work/i);
    expect(friendlyRunError(tEn, null)).toMatch(/something went wrong/i);
    expect(friendlyRunError(tVi, null)).toMatch(/Đã có lỗi/);
  });

  it("localizes friendlyValidation's general + per-step messages", () => {
    const flow = { steps: [{ id: "s1", action: "tapText" }] } as unknown as Flow;
    const { general, byStep } = friendlyValidation(tEn, ["name: Required", "steps.0.text: Required"], flow);
    expect(general).toEqual(["Give this test a name at the top."]);
    expect(byStep.get(0)).toEqual(["This step needs the text of the button to tap."]);
  });

  it("localizes platformLabel for known platforms, passes through unknown ones", () => {
    expect(platformLabel(tEn, "ios-sim")).toBe("iOS Simulator");
    expect(platformLabel(tVi, "ios-sim")).toBe("iOS Simulator");
    expect(platformLabel(tEn, "android-emu")).toBe("Android Emulator");
    expect(platformLabel(tEn, "something-else")).toBe("something-else");
  });
});

// ── seed-reset (task #48) ────────────────────────────────────────────────────────────────────

describe("localizedSeedResetError (task #48)", () => {
  it("returns undefined for a successful (non-degraded) result", () => {
    const result: SeedResetResult = { ok: true, hook: "resetCoinBalance", role: "user_low_balance", degraded: false };
    expect(localizedSeedResetError(tEn, result)).toBeUndefined();
  });

  it("localizes a degraded result's errorCode + errorParams in both locales, never a hardcoded sentence on the wire", () => {
    const result: SeedResetResult = {
      ok: false,
      hook: "resetCoinBalance",
      role: "user_low_balance",
      degraded: true,
      errorCode: "resetApiUnreachable",
      errorParams: {
        hook: "resetCoinBalance",
        role: "user_low_balance",
        env: "stg",
        username: "qa-stg-low-balance",
        baseUrl: "https://stg.demoapp.example",
        message: "ECONNREFUSED",
      },
    };
    const en = localizedSeedResetError(tEn, result);
    const viText = localizedSeedResetError(tVi, result);
    expect(en).toContain("resetCoinBalance");
    expect(en).toContain("qa-stg-low-balance");
    expect(en).toContain("ECONNREFUSED");
    expect(viText).toContain("resetCoinBalance");
    expect(viText).not.toBe(en);
  });
});

// ── friendlyApiError (UI-quality pass: AI settings modal no longer leaks a raw HTTP status) ────

describe("friendlyApiError", () => {
  it("maps a 404 ApiError to the localized 'not deployed yet' sentence in both locales", () => {
    const err = new ApiError(404, "404 Not Found");
    expect(friendlyApiError(tEn, err)).toBe(enMessages.friendly.apiError.notFound);
    expect(friendlyApiError(tVi, err)).toBe(viMessages.friendly.apiError.notFound);
    // Never the raw HTTP status line, in either locale.
    expect(friendlyApiError(tEn, err)).not.toBe(err.message);
    expect(friendlyApiError(tVi, err)).not.toBe(err.message);
  });

  it("maps a status-0 ApiError (fetch() itself failed) to the localized network-unreachable sentence", () => {
    const err = new ApiError(0, "Failed to fetch");
    expect(friendlyApiError(tEn, err)).toBe(enMessages.friendly.apiError.network);
    expect(friendlyApiError(tVi, err)).toBe(viMessages.friendly.apiError.network);
  });

  it("falls back to a generic localized sentence for any other status / non-ApiError value", () => {
    expect(friendlyApiError(tEn, new ApiError(500, "500 Internal Server Error"))).toBe(enMessages.friendly.apiError.generic);
    expect(friendlyApiError(tEn, new Error("boom"))).toBe(enMessages.friendly.apiError.generic);
    expect(friendlyApiError(tEn, "not even an Error")).toBe(enMessages.friendly.apiError.generic);
  });
});

// ── Generic locale key-parity (extends the existing i18n parity coverage in this file): every
// key present in one locale must exist in the other, so flipping the toggle never silently falls
// back to the wrong language for a key someone forgot to add on one side. ─────────────────────

describe("locale key parity (vi.ts <-> en.ts)", () => {
  /** Flattens a nested messages object into dotted-path keys, e.g. { a: { b: "x" } } -> ["a.b"]. */
  function flattenKeys(obj: unknown, prefix = ""): string[] {
    if (typeof obj !== "object" || obj === null) return [prefix];
    return Object.entries(obj as Record<string, unknown>).flatMap(([key, val]) =>
      flattenKeys(val, prefix ? `${prefix}.${key}` : key),
    );
  }

  it("every key in vi.ts exists in en.ts and vice versa", () => {
    const viKeys = new Set(flattenKeys(viMessages));
    const enKeys = new Set(flattenKeys(enMessages));
    const missingFromEn = [...viKeys].filter((k) => !enKeys.has(k));
    const missingFromVi = [...enKeys].filter((k) => !viKeys.has(k));
    expect(missingFromEn, `keys present in vi.ts but missing from en.ts: ${missingFromEn.join(", ")}`).toEqual([]);
    expect(missingFromVi, `keys present in en.ts but missing from vi.ts: ${missingFromVi.join(", ")}`).toEqual([]);
  });
});
