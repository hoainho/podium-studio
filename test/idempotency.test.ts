import { describe, it, expect } from "vitest";
import { defaultIdempotent, isStepIdempotent, type FlowStep } from "../shared/ir.ts";

const s = (over: Partial<FlowStep> & { action: FlowStep["action"] }): FlowStep =>
  ({ id: "s1", ...over } as FlowStep);

describe("defaultIdempotent", () => {
  it("marks read/assert/wait/evidence/navigation actions idempotent by default", () => {
    for (const action of [
      "waitFor", "waitMs", "waitForNotVisible", "assertVisible", "assertNotVisible",
      "screenshot", "scroll", "scrollUntilVisible", "hideKeyboard", "back",
      "clearText", "deleteText",
    ] as const) {
      expect(defaultIdempotent(action)).toBe(true);
    }
  });

  it("marks mutating/one-shot actions NOT idempotent by default (never blindly re-fired)", () => {
    for (const action of [
      "tap", "tapText", "type", "key", "swipe", "doubleTap", "longPress", "tapIfVisible",
      "openLink", "launchApp", "stopApp", "copyText", "pasteText", "raw",
    ] as const) {
      expect(defaultIdempotent(action)).toBe(false);
    }
  });
});

describe("isStepIdempotent", () => {
  it("falls back to defaultIdempotent when the step has no explicit override", () => {
    expect(isStepIdempotent(s({ action: "tap", x: 1, y: 2 }))).toBe(false);
    expect(isStepIdempotent(s({ action: "assertVisible", text: "Welcome" }))).toBe(true);
  });

  it("an explicit idempotent:true override wins over a non-idempotent default", () => {
    expect(isStepIdempotent(s({ action: "tap", x: 1, y: 2, idempotent: true }))).toBe(true);
  });

  it("an explicit idempotent:false override wins over an idempotent default", () => {
    expect(isStepIdempotent(s({ action: "assertVisible", text: "Welcome", idempotent: false }))).toBe(false);
  });
});
