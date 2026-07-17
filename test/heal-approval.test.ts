import { describe, it, expect } from "vitest";
import type { StepResult } from "../shared/protocol.ts";
import type { ProposedPatch } from "../shared/selfheal-types.ts";
import { canPinPatch, collectApprovableHeals, healRungLabel, isApprovableHeal } from "../src/heal-approval.ts";

/**
 * E19 UI (src/ half) — "which heals are approvable" pure logic (AC2/AC5/AC6). AC5's hard
 * boundary: an assertion heal must NEVER be offered for "save this fix?" approval, even if
 * somehow a patch object claims to be one (defense-in-depth, not just trusting the backend once).
 */

function step(over: Partial<StepResult> & { pendingHeal?: ProposedPatch } = {}): StepResult {
  return { index: 0, stepId: "s1", action: "tapText", status: "passed", ok: true, ...over };
}

function patch(over: Partial<ProposedPatch> = {}): ProposedPatch {
  return { healType: "locator", rung: 1, summary: "re-resolved via text", recovery: {}, ...over };
}

describe("isApprovableHeal — AC5/E24-AC4: never assertion, everything else (incl. rung 4 AI) is fine", () => {
  it("approves a locator heal with a patch attached", () => {
    const info = { step: step({ healedRung: 1 }), patch: patch({ healType: "locator" }) };
    expect(isApprovableHeal(info)).toBe(true);
  });

  it("approves an interstitial heal with a patch attached", () => {
    const info = { step: step({ healedRung: 2 }), patch: patch({ healType: "interstitial", rung: 2 }) };
    expect(isApprovableHeal(info)).toBe(true);
  });

  it("approves an 'other'-typed heal (E24 rung 4's AI-proposed patch) with a patch attached", () => {
    const info = { step: step({ healedRung: 4 }), patch: patch({ healType: "other", rung: 4 }) };
    expect(isApprovableHeal(info)).toBe(true);
  });

  it("REFUSES an assertion heal even if a patch is somehow attached (defense-in-depth, AC5/E24-AC4)", () => {
    const info = { step: step({ healedRung: 1 }), patch: patch({ healType: "assertion" }) };
    expect(isApprovableHeal(info)).toBe(false);
  });

  it("refuses a step with no healedRung at all, even with a patch present", () => {
    const info = { step: step({ healedRung: undefined }), patch: patch() };
    expect(isApprovableHeal(info)).toBe(false);
  });

  it("refuses a healed step with NO patch attached (the current live-app gap)", () => {
    const info = { step: step({ healedRung: 1 }), patch: undefined };
    expect(isApprovableHeal(info)).toBe(false);
  });
});

describe("collectApprovableHeals — reads each step's OWN pendingHeal (the fixed contract with the backend)", () => {
  it("a StepResult carrying a pendingHeal (locator) appears as approvable", () => {
    const results = [step({ stepId: "a", healedRung: 1, pendingHeal: patch({ healType: "locator", rung: 1, lessonId: "lesson-a" }) })];
    const approvable = collectApprovableHeals(results);
    expect(approvable).toHaveLength(1);
    expect(approvable[0].step.stepId).toBe("a");
    expect(approvable[0].patch.lessonId).toBe("lesson-a");
  });

  it("a StepResult carrying a pendingHeal (interstitial) also appears as approvable", () => {
    const results = [step({ stepId: "a", healedRung: 2, pendingHeal: patch({ healType: "interstitial", rung: 2, lessonId: "lesson-b" }) })];
    expect(collectApprovableHeals(results)).toHaveLength(1);
  });

  it("returns only the healed+approvable steps, in run order, from a mixed result set", () => {
    const results = [
      step({ stepId: "a", index: 0, healedRung: 1, pendingHeal: patch({ healType: "locator", rung: 1, lessonId: "lesson-a" }) }),
      step({ stepId: "b", index: 1 }), // never healed, no pendingHeal
      step({ stepId: "c", index: 2, healedRung: 3, pendingHeal: patch({ healType: "interstitial", rung: 3, lessonId: "lesson-c" }) }),
    ];
    const approvable = collectApprovableHeals(results);
    expect(approvable.map((h) => h.step.stepId)).toEqual(["a", "c"]);
  });

  it("excludes a healed step whose pendingHeal is an assertion heal (AC5, even via the real field)", () => {
    const results = [step({ stepId: "a", healedRung: 1, pendingHeal: patch({ healType: "assertion" as ProposedPatch["healType"] }) })];
    expect(collectApprovableHeals(results)).toEqual([]);
  });

  it("excludes a healed step with NO pendingHeal attached at all (the disclosed gap, prior to the backend fix landing)", () => {
    const results = [step({ stepId: "a", healedRung: 1 }), step({ stepId: "b", healedRung: 2 })];
    expect(collectApprovableHeals(results)).toEqual([]);
  });

  it("returns an empty list for an all-passed, never-healed run", () => {
    const results = [step({ stepId: "a" }), step({ stepId: "b" })];
    expect(collectApprovableHeals(results)).toEqual([]);
  });
});

describe("canPinPatch — AC6: pinning needs a real lessonId", () => {
  it("true when lessonId is a non-empty string", () => {
    expect(canPinPatch(patch({ lessonId: "lesson-123" }))).toBe(true);
  });

  it("false when lessonId is absent (a brand-new rung 1/2 heal not yet correlated)", () => {
    expect(canPinPatch(patch({ lessonId: undefined }))).toBe(false);
  });

  it("false when lessonId is an empty string", () => {
    expect(canPinPatch(patch({ lessonId: "" }))).toBe(false);
  });
});

describe("healRungLabel", () => {
  it("returns a distinct, non-empty Vietnamese label for each of the 3 rungs", () => {
    const labels = [1, 2, 3].map((r) => healRungLabel(r as 1 | 2 | 3));
    expect(new Set(labels).size).toBe(3);
    for (const l of labels) expect(l.trim().length).toBeGreaterThan(0);
  });
});
