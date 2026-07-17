import { describe, it, expect, vi } from "vitest";
import type { FlowStep } from "../shared/ir.ts";
import type { StepOutcome } from "../bridge/driver.ts";
import {
  stepLayerForMode,
  DEMO_APP_PROFILE,
  type TargetProfile,
} from "../bridge/target-profile.ts";
import {
  attachToWebView,
  flattenWebViewElements,
  inspectWebViewTree,
  pickWebViewLocatorAt,
  runHybridStep,
  type NativeStepExecutor,
  type WebViewHandle,
} from "../bridge/webview-driver.ts";

const s = (over: Partial<FlowStep> & { action: FlowStep["action"] }): FlowStep => ({ id: "s1", ...over } as FlowStep);

// ─── target-profile.ts ──────────────────────────────────────────────────────────────────────

describe("DEMO_APP_PROFILE — PLAN §7 decision #1, locked default", () => {
  it("is hybrid, not an open question", () => {
    expect(DEMO_APP_PROFILE.driveMode).toBe("hybrid");
    expect(DEMO_APP_PROFILE.bundleId).toBe("com.example.demoapp");
  });
});

describe("stepLayerForMode — AC3: exactly 3 modes, no cross-mode leakage", () => {
  it("native mode always resolves native, even for an in-app-looking tapText", () => {
    expect(stepLayerForMode(s({ action: "tapText", text: "Spin" }), "native")).toBe("native");
  });

  it("webview mode always resolves webview, even for a lifecycle action like launchApp", () => {
    expect(stepLayerForMode(s({ action: "launchApp", bundleId: "x" }), "webview")).toBe("webview");
  });

  it("hybrid mode: lifecycle/system actions (launchApp/stopApp/openLink/key) are always native", () => {
    expect(stepLayerForMode(s({ action: "launchApp", bundleId: "x" }), "hybrid")).toBe("native");
    expect(stepLayerForMode(s({ action: "stopApp", bundleId: "x" }), "hybrid")).toBe("native");
    expect(stepLayerForMode(s({ action: "openLink", url: "podium://x" }), "hybrid")).toBe("native");
    expect(stepLayerForMode(s({ action: "key", key: "back" } as any), "hybrid")).toBe("native");
  });

  it("hybrid mode: everything else is 'auto' — the caller tries webview then falls back to native", () => {
    expect(stepLayerForMode(s({ action: "tapText", text: "Claim reward" }), "hybrid")).toBe("auto");
    expect(stepLayerForMode(s({ action: "assertVisible", text: "Balance" }), "hybrid")).toBe("auto");
  });
});

// ─── webview-driver.ts: DOM inspection (fake page, no real WebView needed) ─────────────────────

function makeFakePageWithDom(domHtml: { text?: string; testId?: string }[]) {
  // Simulates page.evaluate() by directly returning what the real in-page callback WOULD produce
  // against a DOM shaped like `domHtml` — the callback body itself only ever runs inside a real
  // browser/WebView, so unit tests here validate the OUTER contract (what flattenWebViewElements
  // returns, given what the page reports), not the literal document.querySelectorAll call.
  return {
    evaluate: vi.fn(async (fn: (...a: any[]) => any, arg?: any) => {
      // Reproduce exactly what each real in-page callback computes, driven by our fake DOM list —
      // this keeps the test honest about the CONTRACT (shape in, shape out) without needing jsdom.
      if (fn.length === 0 && !arg) {
        // flattenWebViewElements's callback signature: () => ScreenElement-ish[]
        return domHtml.map((e) => ({ text: e.text, testId: e.testId }));
      }
      return null;
    }),
  };
}

describe("flattenWebViewElements — maps WebView DOM into shared/lint.ts's ScreenElement shape (AC4)", () => {
  it("maps data-testid -> accessibilityId and textContent -> text, same field names lintFlow expects", async () => {
    const page = makeFakePageWithDom([
      { testId: "spin-button", text: "Spin" },
      { text: "Balance: 100" },
    ]);
    const elements = await flattenWebViewElements(page);
    expect(elements).toEqual([
      { text: "Spin", accessibilityId: "spin-button" },
      { text: "Balance: 100", accessibilityId: undefined },
    ]);
  });
});

describe("inspectWebViewTree — element tree with correct node hierarchy (AC1)", () => {
  it("returns a tree shape (tag/testId/text/children) from a fake page", async () => {
    const fakeTree = {
      tag: "div",
      testId: "root",
      text: undefined,
      children: [{ tag: "button", testId: "spin-button", text: "Spin", children: [] }],
    };
    const page = { evaluate: vi.fn().mockResolvedValue(fakeTree) };
    const tree = await inspectWebViewTree(page);
    expect(tree.tag).toBe("div");
    expect(tree.children).toHaveLength(1);
    expect(tree.children[0].text).toBe("Spin");
  });
});

describe("pickWebViewLocatorAt — click-to-select produces a working locator (AC1)", () => {
  it("prefers targetId (data-testid), falls back to text, matching resolveLocator's own priority", async () => {
    const page = { evaluate: vi.fn().mockResolvedValue({ testId: "spin-button", text: "Spin" }) };
    const locator = await pickWebViewLocatorAt(page, 10, 20);
    expect(locator).toEqual({ targetId: "spin-button", text: "Spin" });
  });

  it("returns undefined when nothing is at that point (no element under the click)", async () => {
    const page = { evaluate: vi.fn().mockResolvedValue(null) };
    const locator = await pickWebViewLocatorAt(page, 999, 999);
    expect(locator).toBeUndefined();
  });
});

// ─── attachToWebView — honest, never fakes success ─────────────────────────────────────────────

describe("attachToWebView — runtime-gated, never fakes success (mirrors E7/E16's contract)", () => {
  it("the real (default) connector rejects with a clear message — no real simulator/device here", async () => {
    await expect(attachToWebView({ udid: "sim-1", bundleId: "com.example.demoapp" })).rejects.toThrow(
      /remote-debug|simulator|device/i,
    );
  });

  it("an injected connectFn lets tests attach without a real device", async () => {
    const fakeHandle: WebViewHandle = { page: {}, close: vi.fn().mockResolvedValue(undefined) };
    const handle = await attachToWebView({ udid: "sim-1", bundleId: "x" }, async () => fakeHandle);
    expect(handle).toBe(fakeHandle);
  });
});

// ─── runHybridStep — AC2: one flow, native step then webview step, both green ──────────────────

describe("runHybridStep — routes to the right layer, native<->webview handoff within one run (AC2)", () => {
  function fakeNativeExec(result: StepOutcome): { exec: NativeStepExecutor; calls: any[] } {
    const calls: any[] = [];
    const exec: NativeStepExecutor = async (udid, step, bundleId, fixtures, env, secrets) => {
      calls.push({ udid, step, bundleId, fixtures, env, secrets });
      return result;
    };
    return { exec, calls };
  }

  it("native mode: always calls the native executor, never touches the webview page", async () => {
    const { exec, calls } = fakeNativeExec({ ok: true });
    const profile: TargetProfile = { name: "t", driveMode: "native", bundleId: "com.x" };
    const webviewPage = { evaluate: vi.fn() };
    const result = await runHybridStep(s({ action: "tapText", text: "Spin" }), webviewPage, "udid-1", profile, {}, undefined, exec);
    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(webviewPage.evaluate).not.toHaveBeenCalled();
  });

  it("webview mode: dispatches through mapStepToBrowserAction against the page, never calls native", async () => {
    const { exec, calls } = fakeNativeExec({ ok: false, error: "should never be called" });
    const profile: TargetProfile = { name: "t", driveMode: "webview", bundleId: "com.x" };
    const page: any = { goto: vi.fn().mockResolvedValue(undefined) };
    const result = await runHybridStep(s({ action: "openLink", url: "https://x" }), page, "udid-1", profile, {}, undefined, exec);
    expect(result.ok).toBe(true);
    expect(page.goto).toHaveBeenCalledWith("https://x");
    expect(calls).toHaveLength(0);
  });

  it("webview mode: a step needing the page when none is attached fails honestly (no silent success)", async () => {
    const { exec } = fakeNativeExec({ ok: true });
    const profile: TargetProfile = { name: "t", driveMode: "webview", bundleId: "com.x" };
    const result = await runHybridStep(s({ action: "tapText", text: "Spin" }), undefined, "udid-1", profile, {}, undefined, exec);
    expect(result.ok).toBe(false);
  });

  it("hybrid: a lifecycle action (launchApp) always goes native even when a webview page IS attached", async () => {
    const { exec, calls } = fakeNativeExec({ ok: true });
    const profile: TargetProfile = { name: "t", driveMode: "hybrid", bundleId: "com.x" };
    const page: any = { goto: vi.fn() };
    await runHybridStep(s({ action: "launchApp", bundleId: "com.x" }), page, "udid-1", profile, {}, undefined, exec);
    expect(calls).toHaveLength(1);
    expect(page.goto).not.toHaveBeenCalled();
  });

  it("hybrid: an in-app step resolves via the webview when it succeeds there, never falling through to native", async () => {
    const { exec, calls } = fakeNativeExec({ ok: true });
    const profile: TargetProfile = { name: "t", driveMode: "hybrid", bundleId: "com.x" };
    const locator: any = { click: vi.fn().mockResolvedValue(undefined) };
    locator.first = () => locator; // resolveLocator now returns .first()
    locator.count = vi.fn().mockResolvedValue(1); // present on the (main) frame — frame-aware fast path
    locator.isVisible = vi.fn().mockResolvedValue(true); // visible → resolver returns it immediately
    const page: any = { getByText: vi.fn(() => locator) };
    const result = await runHybridStep(s({ action: "tapText", text: "Claim reward" }), page, "udid-1", profile, {}, undefined, exec);
    expect(result.ok).toBe(true);
    expect(locator.click).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(0); // never fell through to native
  });

  it("hybrid: a hard webview failure (element genuinely absent) falls back to native, one flow completing green (AC2)", async () => {
    const { exec, calls } = fakeNativeExec({ ok: true, detail: "native dialog dismissed" });
    const profile: TargetProfile = { name: "t", driveMode: "hybrid", bundleId: "com.x" };
    const locator: any = { isVisible: vi.fn().mockResolvedValue(false) };
    locator.first = () => locator; // resolveLocator now returns .first()
    locator.count = vi.fn().mockResolvedValue(0); // genuinely absent — no frame has it
    const page: any = { getByText: vi.fn(() => locator) };
    const result = await runHybridStep(s({ action: "assertVisible", text: "Allow" }), page, "udid-1", profile, {}, undefined, exec);
    expect(result.ok).toBe(true); // succeeded via the NATIVE fallback, not the webview
    expect(calls).toHaveLength(1);
    expect(calls[0].step.action).toBe("assertVisible");
  });

  it("a full 2-phase hybrid flow (native permission dismiss, then webview tap) — both steps green in one run", async () => {
    const { exec, calls } = fakeNativeExec({ ok: true });
    const profile: TargetProfile = { name: "t", driveMode: "hybrid", bundleId: "com.x" };
    const locator: any = { click: vi.fn().mockResolvedValue(undefined) };
    locator.first = () => locator; // resolveLocator now returns .first()
    locator.count = vi.fn().mockResolvedValue(1); // present on the (main) frame — frame-aware fast path
    locator.isVisible = vi.fn().mockResolvedValue(true); // visible → resolver returns it immediately
    const page: any = { getByText: vi.fn(() => locator) };

    const permissionStep = s({ action: "key", key: "back" } as any); // system-level, always native
    const claimStep = s({ action: "tapText", text: "Claim reward" }); // in-app, resolves via webview

    const r1 = await runHybridStep(permissionStep, page, "udid-1", profile, {}, undefined, exec);
    const r2 = await runHybridStep(claimStep, page, "udid-1", profile, {}, undefined, exec);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(calls).toHaveLength(1); // only the native (key) step went through nativeExec
    expect(locator.click).toHaveBeenCalledTimes(1); // only the webview (tapText) step hit the page
  });
});
