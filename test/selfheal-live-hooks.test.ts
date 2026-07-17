import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FlowStep } from "../shared/ir.ts";
import type { HealAttempt } from "../shared/selfheal-types.ts";

vi.mock("../bridge/podium.ts", () => ({
  engine: { inspectScreen: vi.fn() },
}));

import { engine } from "../bridge/podium.ts";
import { createLiveSelfHealHooks } from "../bridge/selfheal-live-hooks.ts";
import type { PrimaryStore } from "../bridge/db/primary-store.ts";

const mockInspectScreen = engine.inspectScreen as unknown as ReturnType<typeof vi.fn>;

function makeFakeStore() {
  return {
    findSelectorMemory: vi.fn().mockReturnValue([]),
    findInterstitial: vi.fn().mockReturnValue(undefined),
    findLessons: vi.fn().mockReturnValue([]),
    findBestHealOutcome: vi.fn().mockReturnValue(undefined),
    recordHealOutcome: vi.fn().mockResolvedValue(undefined),
    insertLesson: vi.fn().mockResolvedValue("new-lesson-id"),
  };
}

describe("createLiveSelfHealHooks — the real (device + DB) SelfHealHooks implementation", () => {
  beforeEach(() => {
    mockInspectScreen.mockReset();
  });

  it("getScreenElements flattens a real inspect_screen-shaped tree", async () => {
    mockInspectScreen.mockResolvedValue({
      text: "Home", children: [{ label: "Log In", id: "btn-login" }, { accessibilityLabel: "Balance: 100" }],
    });
    const hooks = createLiveSelfHealHooks("udid-1", makeFakeStore() as unknown as PrimaryStore);
    const elements = await hooks.getScreenElements();
    expect(elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ text: "Home" }),
        expect.objectContaining({ text: "Log In", accessibilityId: "btn-login" }),
        expect.objectContaining({ text: "Balance: 100" }),
      ]),
    );
  });

  it("getScreenElements never throws — a device error returns an empty list instead", async () => {
    mockInspectScreen.mockRejectedValue(new Error("no simulator booted"));
    const hooks = createLiveSelfHealHooks("udid-1", makeFakeStore() as unknown as PrimaryStore);
    await expect(hooks.getScreenElements()).resolves.toEqual([]);
  });

  it("read hooks pass straight through to the store's own methods", () => {
    const store = makeFakeStore();
    const hooks = createLiveSelfHealHooks("udid-1", store as unknown as PrimaryStore);
    hooks.getSelectorCandidates("fp", "Login button");
    hooks.getInterstitial("fp");
    hooks.getPinnedLessons("fp", "element_not_found");
    hooks.getBestOutcome("fp", "element_not_found");
    expect(store.findSelectorMemory).toHaveBeenCalledWith("fp", "Login button");
    expect(store.findInterstitial).toHaveBeenCalledWith("fp");
    expect(store.findLessons).toHaveBeenCalledWith("fp", "element_not_found", { pinnedOnly: true }); // AC6
    expect(store.findBestHealOutcome).toHaveBeenCalledWith("fp", "element_not_found");
  });

  describe("onHealAttempt — persistence side effects", () => {
    const step: FlowStep = { id: "s1", action: "tapText", text: "Log In" } as any;

    it("does nothing when the attempt didn't heal", async () => {
      const store = makeFakeStore();
      const hooks = createLiveSelfHealHooks("udid-1", store as unknown as PrimaryStore);
      const attempt: HealAttempt = { healed: false, reason: "no recovery available" };
      const returned = await hooks.onHealAttempt!({ step, fingerprint: "fp", errorClass: "element_not_found", elements: [], attempt, succeeded: false });
      expect(returned).toBeUndefined();
      expect(store.recordHealOutcome).not.toHaveBeenCalled();
      expect(store.insertLesson).not.toHaveBeenCalled();
    });

    it("a BRAND NEW rung-1 heal whose retry SUCCEEDED (no lessonId yet) records a success heal outcome, inserts a new lesson, and RETURNS its id", async () => {
      const store = makeFakeStore();
      const hooks = createLiveSelfHealHooks("udid-1", store as unknown as PrimaryStore, "flow-123");
      const attempt: HealAttempt = {
        healed: true, rung: 1, appliedRecovery: { kind: "text", value: "Log In" },
        proposedPatch: { healType: "locator", rung: 1, summary: "re-resolved", recovery: { kind: "text", value: "Log In" } },
      };
      const returned = await hooks.onHealAttempt!({ step, fingerprint: "fp", errorClass: "element_not_found", elements: [{ text: "Log In" }], attempt, succeeded: true });

      expect(store.recordHealOutcome).toHaveBeenCalledWith("fp", "element_not_found", 1, "locator", true);
      expect(store.insertLesson).toHaveBeenCalledTimes(1);
      const inserted = store.insertLesson.mock.calls[0][0];
      expect(inserted.pinned).toBeUndefined(); // never auto-pinned (AC2/AC6) — pinning is a separate action
      expect(inserted.flowId).toBe("flow-123");
      expect(inserted.topLabels).toEqual(["Log In"]);
      // E19 gap-fix — this is what the run loop correlates onto StepResult.pendingHeal.lessonId.
      expect(returned).toBe("new-lesson-id");
    });

    it("MAJOR (R4 code-review gate) — a candidate was found but its retry FAILED: records a FAILURE heal outcome and never inserts a lesson for a fix that didn't work", async () => {
      const store = makeFakeStore();
      const hooks = createLiveSelfHealHooks("udid-1", store as unknown as PrimaryStore, "flow-123");
      const attempt: HealAttempt = {
        healed: true, rung: 1, appliedRecovery: { kind: "text", value: "Log In" },
        proposedPatch: { healType: "locator", rung: 1, summary: "re-resolved", recovery: { kind: "text", value: "Log In" } },
      };
      const returned = await hooks.onHealAttempt!({ step, fingerprint: "fp", errorClass: "element_not_found", elements: [{ text: "Log In" }], attempt, succeeded: false });

      // `success = false` — the previous behavior of hardcoding `true` here (whenever a candidate
      // was merely FOUND, before the retry even ran) would have corrupted rung 3's own ranking
      // stats towards a strategy that doesn't actually work.
      expect(store.recordHealOutcome).toHaveBeenCalledWith("fp", "element_not_found", 1, "locator", false);
      expect(store.insertLesson).not.toHaveBeenCalled();
      expect(returned).toBeUndefined();
    });

    it("a rung-3 replay of an ALREADY-pinned lesson whose retry succeeded (lessonId present) records a success outcome but does NOT insert a duplicate lesson", async () => {
      const store = makeFakeStore();
      const hooks = createLiveSelfHealHooks("udid-1", store as unknown as PrimaryStore);
      const attempt: HealAttempt = {
        healed: true, rung: 3, appliedRecovery: { kind: "text", value: "Log In" },
        proposedPatch: { lessonId: "existing-lesson-1", healType: "locator", rung: 3, summary: "replayed", recovery: { kind: "text", value: "Log In" } },
      };
      const returned = await hooks.onHealAttempt!({ step, fingerprint: "fp", errorClass: "element_not_found", elements: [], attempt, succeeded: true });

      expect(store.recordHealOutcome).toHaveBeenCalledWith("fp", "element_not_found", 3, "locator", true);
      expect(store.insertLesson).not.toHaveBeenCalled();
      // Nothing NEW was inserted — the run loop keeps the patch's own existing lessonId as-is.
      expect(returned).toBeUndefined();
    });

    it("insertLesson's rejection never throws/rejects out of onHealAttempt — resolves to undefined instead", async () => {
      const store = makeFakeStore();
      store.insertLesson.mockRejectedValue(new Error("disk full"));
      const hooks = createLiveSelfHealHooks("udid-1", store as unknown as PrimaryStore);
      const attempt: HealAttempt = {
        healed: true, rung: 1, appliedRecovery: { kind: "text", value: "X" },
        proposedPatch: { healType: "locator", rung: 1, summary: "x", recovery: { kind: "text", value: "X" } },
      };
      await expect(
        hooks.onHealAttempt!({ step, fingerprint: "fp", errorClass: "element_not_found", elements: [], attempt, succeeded: true }),
      ).resolves.toBeUndefined();
    });
  });
});
