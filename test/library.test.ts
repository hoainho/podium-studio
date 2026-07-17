import { describe, it, expect } from "vitest";
import type { Flow, FlowStep } from "../shared/ir.ts";
import { resolveLibraryRefs, getLibraryEntry, listLibraryEntries, type SelectorLibraryEntry } from "../shared/library.ts";

/**
 * E13 (Reuse — platform-scoped selector library). Covers `resolveLibraryRefs()`'s "define
 * once, per element, not per platform" contract (spec AC2): the SAME step resolves correctly
 * for a mobile build AND a browser build from one authored `libraryRef`, zero additional
 * per-platform authoring.
 */

function makeFlow(steps: FlowStep[]): Flow {
  return {
    schemaVersion: 1,
    name: "Test flow",
    app: { bundleId: "com.example.app", platform: "ios-sim" },
    steps,
  };
}

describe("SELECTOR_LIBRARY seed data", () => {
  it("every seeded entry resolves without error on BOTH platforms it declares (starter-pack sanity)", () => {
    for (const entry of listLibraryEntries()) {
      if (entry.mobile) expect(entry.mobile.text || entry.mobile.targetId).toBeTruthy();
      if (entry.browser) expect(entry.browser.text || entry.browser.targetId).toBeTruthy();
    }
  });

  it("getLibraryEntry finds a known entry and returns undefined for an unknown one", () => {
    expect(getLibraryEntry("loginSubmitButton")).toBeDefined();
    expect(getLibraryEntry("does-not-exist")).toBeUndefined();
  });
});

describe("resolveLibraryRefs — define once, resolves per platform (spec AC2)", () => {
  it("resolves the SAME libraryRef to a mobile locator AND a browser locator from the SAME authored step", () => {
    const flow = makeFlow([{ id: "s1", action: "tapText", libraryRef: "loginSubmitButton" } as FlowStep]);

    const { flow: mobile, errors: mobileErrors } = resolveLibraryRefs(flow, "mobile");
    const { flow: browser, errors: browserErrors } = resolveLibraryRefs(flow, "browser");

    expect(mobileErrors).toEqual([]);
    expect(browserErrors).toEqual([]);
    expect((mobile.steps[0] as any).text).toBe("Đăng nhập");
    expect((browser.steps[0] as any).targetId).toBe("login-submit-button");
    // The ORIGINAL authored step (one libraryRef, no per-platform authoring) never changes.
    expect((flow.steps[0] as any).libraryRef).toBe("loginSubmitButton");
  });

  it("a step with no libraryRef passes through completely unchanged", () => {
    const flow = makeFlow([{ id: "s1", action: "tapText", text: "Literal text" } as FlowStep]);
    const { flow: resolved, errors } = resolveLibraryRefs(flow, "mobile");
    expect(errors).toEqual([]);
    expect(resolved.steps[0]).toEqual(flow.steps[0]);
  });

  it("errors when the referenced library entry doesn't exist", () => {
    const flow = makeFlow([{ id: "s1", action: "tapText", libraryRef: "nope" } as FlowStep]);
    const { errors } = resolveLibraryRefs(flow, "mobile");
    expect(errors).toHaveLength(1);
    expect(errors[0].stepId).toBe("s1");
  });

  it("errors when the entry has no locator for the requested platform", () => {
    // No REAL seeded SELECTOR_LIBRARY entry is single-platform-only (every starter-pack entry
    // declares both mobile and browser), so this branch can't be reached against the real
    // registry. resolveLibraryRefs()'s `registry` param is injectable (same pattern as
    // bridge/doctor.ts's ExecFn) precisely so a test can supply a synthetic incomplete entry
    // and actually exercise the "missing platform locator" error path, instead of just
    // re-asserting the happy path.
    const registry: Record<string, SelectorLibraryEntry> = {
      mobileOnlyButton: { id: "mobileOnlyButton", label: "Nút chỉ có trên di động", mobile: { text: "OK" } },
    };
    const flow = makeFlow([{ id: "s1", action: "tapText", libraryRef: "mobileOnlyButton" } as FlowStep]);

    const { errors: mobileErrors } = resolveLibraryRefs(flow, "mobile", registry);
    expect(mobileErrors).toEqual([]);

    const { errors: browserErrors } = resolveLibraryRefs(flow, "browser", registry);
    expect(browserErrors).toHaveLength(1);
    expect(browserErrors[0].stepId).toBe("s1");
    expect(browserErrors[0].message).toMatch(/trình duyệt/i);
  });

  it("errors when libraryRef is set on an action that isn't selector-bearing", () => {
    const flow = makeFlow([{ id: "s1", action: "waitMs", ms: 100, libraryRef: "loginSubmitButton" } as FlowStep]);
    const { errors } = resolveLibraryRefs(flow, "mobile");
    expect(errors).toHaveLength(1);
    expect(errors[0].stepId).toBe("s1");
  });

  it("errors (never silently breaks the schema) when a text-only action references a targetId-only entry", () => {
    // assertVisible/tapIfVisible have NO targetId field in their schema at all — a library
    // entry that only defines targetId for the requested platform can never satisfy them.
    const flow = makeFlow([{ id: "s1", action: "assertVisible", text: "placeholder", libraryRef: "loginEmailField" } as FlowStep]);
    // loginEmailField only has targetId (no text) on both platforms.
    const { errors } = resolveLibraryRefs(flow, "mobile");
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/văn bản|text/i);
  });

  it("recurses into if/repeat containers to resolve a nested step's libraryRef", () => {
    const flow = makeFlow([
      {
        id: "r1", action: "repeat", times: 1,
        steps: [{ id: "r1a", action: "tapIfVisible", text: "placeholder", libraryRef: "popupDismissButton" } as FlowStep],
      } as FlowStep,
    ]);
    const { flow: resolved, errors } = resolveLibraryRefs(flow, "mobile");
    expect(errors).toEqual([]);
    const repeatStep = resolved.steps[0] as any;
    expect(repeatStep.steps[0].text).toBe("Đóng");
  });

  it("never mutates the original flow object", () => {
    const flow = makeFlow([{ id: "s1", action: "tapText", libraryRef: "loginSubmitButton" } as FlowStep]);
    const before = JSON.stringify(flow);
    resolveLibraryRefs(flow, "mobile");
    expect(JSON.stringify(flow)).toBe(before);
  });
});
