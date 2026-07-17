import { describe, it, expect, vi } from "vitest";
import type { FlowStep } from "../shared/ir.ts";
import type { Rung4Attempt } from "../shared/ai-types.ts";
import { createLiveAiRecoveryHooks } from "../bridge/ai-recovery-live-hooks.ts";
import type { PrimaryStore } from "../bridge/db/primary-store.ts";

function makeFakeStore() {
  return {
    getProviderRegistry: vi.fn().mockReturnValue({
      providers: [{ id: "local", name: "Local", kind: "openai-compatible", baseUrl: "http://localhost:11434/v1", model: "qwen2.5", enabled: true }],
      routing: { authoring: [], recovery: ["local"] },
    }),
    insertAiCallLog: vi.fn().mockResolvedValue("log-id"),
    insertLesson: vi.fn().mockResolvedValue("new-lesson-id"),
  };
}

const step: FlowStep = { id: "s1", action: "tapText", text: "Log In" } as any;

describe("createLiveAiRecoveryHooks — the real (provider registry + DB) AiRecoveryHooks implementation", () => {
  it("getRecoveryProviders reads the CURRENT registry from the store and builds real providers from routing.recovery", () => {
    const store = makeFakeStore();
    const hooks = createLiveAiRecoveryHooks(store as unknown as PrimaryStore);
    const { chain, providers } = hooks.getRecoveryProviders();
    expect(chain).toEqual(["local"]);
    expect(providers.has("local")).toBe(true);
    expect(store.getProviderRegistry).toHaveBeenCalledTimes(1);
  });

  it("getRecoveryProviders re-reads the store on EVERY call — not cached once", () => {
    const store = makeFakeStore();
    const hooks = createLiveAiRecoveryHooks(store as unknown as PrimaryStore);
    hooks.getRecoveryProviders();
    hooks.getRecoveryProviders();
    expect(store.getProviderRegistry).toHaveBeenCalledTimes(2);
  });

  describe("onAiAttempt — AC3 (always logged) + lesson persistence gated on real success", () => {
    it("AC3 — logs the call even when the attempt did NOT heal", async () => {
      const store = makeFakeStore();
      const hooks = createLiveAiRecoveryHooks(store as unknown as PrimaryStore);
      const attempt: Rung4Attempt = { healed: false, reason: "illegal output", logEntry: { role: "recovery", providerId: "local", prompt: "p", response: "r", latencyMs: 10 } };
      const returned = await hooks.onAiAttempt!({ step, errorClass: "element_not_found", attempt, succeeded: false });
      expect(store.insertAiCallLog).toHaveBeenCalledWith(attempt.logEntry);
      expect(store.insertLesson).not.toHaveBeenCalled();
      expect(returned).toBeUndefined();
    });

    it("a healed attempt whose retry SUCCEEDED logs the call AND inserts a new unpinned lesson, returning its id", async () => {
      const store = makeFakeStore();
      const hooks = createLiveAiRecoveryHooks(store as unknown as PrimaryStore, "flow-123");
      const attempt: Rung4Attempt = {
        healed: true,
        appliedRecovery: { id: "x", action: "tapText", text: "Log In" } as any,
        proposedPatch: { healType: "other", rung: 4, summary: "AI đề xuất", recovery: { action: "tapText", text: "Log In" } },
        logEntry: { role: "recovery", providerId: "local", prompt: "p", response: "r", latencyMs: 10, screenFingerprint: "fp-1" },
      };
      const returned = await hooks.onAiAttempt!({ step, errorClass: "element_not_found", attempt, succeeded: true });

      expect(store.insertAiCallLog).toHaveBeenCalledWith(attempt.logEntry);
      expect(store.insertLesson).toHaveBeenCalledTimes(1);
      const inserted = store.insertLesson.mock.calls[0][0];
      expect(inserted.rung).toBe(4);
      expect(inserted.healType).toBe("other");
      expect(inserted.errorClass).toBe("element_not_found");
      expect(inserted.screenFingerprint).toBe("fp-1");
      expect(inserted.flowId).toBe("flow-123");
      expect(inserted.pinned).toBeUndefined(); // never auto-pinned
      expect(returned).toBe("new-lesson-id");
    });

    it("a candidate was legal but its retry FAILED (succeeded=false): logs the call but NEVER inserts a lesson for a fix that didn't work", async () => {
      const store = makeFakeStore();
      const hooks = createLiveAiRecoveryHooks(store as unknown as PrimaryStore);
      const attempt: Rung4Attempt = {
        healed: true,
        appliedRecovery: { id: "x", action: "tapText", text: "Log In" } as any,
        proposedPatch: { healType: "other", rung: 4, summary: "AI đề xuất", recovery: { action: "tapText", text: "Log In" } },
        logEntry: { role: "recovery", providerId: "local", prompt: "p", response: "r", latencyMs: 10 },
      };
      const returned = await hooks.onAiAttempt!({ step, errorClass: "element_not_found", attempt, succeeded: false });
      expect(store.insertAiCallLog).toHaveBeenCalledTimes(1);
      expect(store.insertLesson).not.toHaveBeenCalled();
      expect(returned).toBeUndefined();
    });

    it("a rung-4 patch that already carries a lessonId (rare — e.g. a replayed already-approved AI fix) never inserts a duplicate", async () => {
      const store = makeFakeStore();
      const hooks = createLiveAiRecoveryHooks(store as unknown as PrimaryStore);
      const attempt: Rung4Attempt = {
        healed: true,
        appliedRecovery: { id: "x", action: "tapText", text: "Log In" } as any,
        proposedPatch: { lessonId: "existing-1", healType: "other", rung: 4, summary: "replayed", recovery: {} },
        logEntry: { role: "recovery", providerId: "local", prompt: "p", response: "r", latencyMs: 10 },
      };
      const returned = await hooks.onAiAttempt!({ step, errorClass: "element_not_found", attempt, succeeded: true });
      expect(store.insertLesson).not.toHaveBeenCalled();
      expect(returned).toBeUndefined();
    });

    it("insertAiCallLog's rejection never throws/rejects out of onAiAttempt — logged to console, run unaffected", async () => {
      const store = makeFakeStore();
      store.insertAiCallLog.mockRejectedValue(new Error("disk full"));
      const hooks = createLiveAiRecoveryHooks(store as unknown as PrimaryStore);
      const attempt: Rung4Attempt = { healed: false, reason: "x", logEntry: { role: "recovery", providerId: "local", prompt: "p", response: "r", latencyMs: 10 } };
      await expect(hooks.onAiAttempt!({ step, errorClass: "element_not_found", attempt, succeeded: false })).resolves.toBeUndefined();
    });

    it("insertLesson's rejection never throws/rejects out of onAiAttempt either", async () => {
      const store = makeFakeStore();
      store.insertLesson.mockRejectedValue(new Error("disk full"));
      const hooks = createLiveAiRecoveryHooks(store as unknown as PrimaryStore);
      const attempt: Rung4Attempt = {
        healed: true,
        appliedRecovery: { id: "x", action: "tapText", text: "Log In" } as any,
        proposedPatch: { healType: "other", rung: 4, summary: "x", recovery: {} },
        logEntry: { role: "recovery", providerId: "local", prompt: "p", response: "r", latencyMs: 10 },
      };
      await expect(hooks.onAiAttempt!({ step, errorClass: "element_not_found", attempt, succeeded: true })).resolves.toBeUndefined();
    });
  });
});
