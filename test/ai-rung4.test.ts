import { describe, it, expect, vi } from "vitest";
import { attemptAiRecovery, parseAndValidateRung4Candidate, type Rung4Context } from "../bridge/ai-rung4.ts";
import type { FlowStep } from "../shared/ir.ts";
import type { AiProvider } from "../shared/ai-types.ts";

function baseCtx(overrides: Partial<Rung4Context> = {}): Rung4Context {
  return {
    step: { id: "s1", action: "tapText", text: "Log In (old)" } as FlowStep,
    errorClass: "element_not_found",
    elements: [{ text: "Log In" }],
    screenFingerprint: "fp-1",
    recoveryChain: ["local"],
    providers: new Map(),
    ...overrides,
  };
}

function providerReturning(text: string): ReadonlyMap<string, AiProvider> {
  return new Map([["local", { id: "local", complete: vi.fn().mockResolvedValue({ text }) }]]);
}

describe("attemptAiRecovery — rung 4: single bounded AI call, IR-validated", () => {
  it("AC4/Pillar I — an assertion action is NEVER even sent to the model (heal-type safety checked first)", async () => {
    const complete = vi.fn();
    const ctx = baseCtx({
      step: { id: "s1", action: "assertVisible", text: "Balance" } as FlowStep,
      providers: new Map([["local", { id: "local", complete }]]),
    });
    const attempt = await attemptAiRecovery(ctx);
    expect(attempt.healed).toBe(false);
    expect(attempt.reason).toMatch(/heal-type safety/i);
    expect(complete).not.toHaveBeenCalled();
  });

  it("a legal, in-allowlist candidate action heals and is logged", async () => {
    const ctx = baseCtx({ providers: providerReturning(JSON.stringify({ action: "tapText", text: "Log In" })) });
    const attempt = await attemptAiRecovery(ctx);
    expect(attempt.healed).toBe(true);
    expect(attempt.appliedRecovery).toMatchObject({ action: "tapText", text: "Log In" });
    expect(attempt.proposedPatch).toMatchObject({ rung: 4, healType: "other" });
    expect(attempt.logEntry.prompt).toBeTruthy();
    expect(attempt.logEntry.response).toContain("tapText");
    expect(attempt.logEntry.role).toBe("recovery");
    expect(attempt.logEntry.screenFingerprint).toBe("fp-1");
  });

  it("AC2 — an ILLEGAL action name (not in the closed IR at all) is discarded, never executed", async () => {
    const ctx = baseCtx({ providers: providerReturning(JSON.stringify({ action: "deleteApp" })) });
    const attempt = await attemptAiRecovery(ctx);
    expect(attempt.healed).toBe(false);
    expect(attempt.appliedRecovery).toBeUndefined();
    expect(attempt.reason).toMatch(/not a legal/i);
    // Still logged, even though nothing healed (AC3).
    expect(attempt.logEntry.response).toContain("deleteApp");
  });

  it("AC2 — a technically-legal-in-the-full-IR but OUT-OF-BOUNDS-for-rung-4 action is discarded (raw)", async () => {
    const ctx = baseCtx({ providers: providerReturning(JSON.stringify({ action: "raw", maestro: "rm -rf /" })) });
    const attempt = await attemptAiRecovery(ctx);
    expect(attempt.healed).toBe(false);
  });

  it("AC2 — 'no new URLs': openLink is discarded even though it's a legal IR action for a human author", async () => {
    const ctx = baseCtx({ providers: providerReturning(JSON.stringify({ action: "openLink", url: "https://evil.example" })) });
    const attempt = await attemptAiRecovery(ctx);
    expect(attempt.healed).toBe(false);
  });

  it("AC2 — a schema-invalid candidate (missing a required field) is discarded, not coerced", async () => {
    // waitFor requires `text` — omitted here.
    const ctx = baseCtx({ providers: providerReturning(JSON.stringify({ action: "waitFor" })) });
    const attempt = await attemptAiRecovery(ctx);
    expect(attempt.healed).toBe(false);
  });

  it("AC2 — more than one action (an array) is discarded — 'exactly one candidate action'", async () => {
    const ctx = baseCtx({ providers: providerReturning(JSON.stringify([{ action: "tap", x: 1, y: 2 }])) });
    const attempt = await attemptAiRecovery(ctx);
    expect(attempt.healed).toBe(false);
  });

  it("tolerates a model wrapping its JSON in prose/markdown — extracts the object anyway", async () => {
    const ctx = baseCtx({ providers: providerReturning('Sure, here you go:\n```json\n{"action": "waitMs", "ms": 500}\n```') });
    const attempt = await attemptAiRecovery(ctx);
    expect(attempt.healed).toBe(true);
    expect(attempt.appliedRecovery).toMatchObject({ action: "waitMs", ms: 500 });
  });

  it("a provider failure (all fallbacks exhausted) heals nothing but is still logged with the failure reason", async () => {
    const failing: ReadonlyMap<string, AiProvider> = new Map([["local", { id: "local", complete: vi.fn().mockRejectedValue(new Error("connection refused")) }]]);
    const ctx = baseCtx({ providers: failing });
    const attempt = await attemptAiRecovery(ctx);
    expect(attempt.healed).toBe(false);
    expect(attempt.reason).toMatch(/provider call failed/i);
    expect(attempt.logEntry.providerId).toBe("none");
  });

  it("no recovery-role provider configured at all — refuses cleanly, never throws", async () => {
    const ctx = baseCtx({ recoveryChain: [], providers: new Map() });
    const attempt = await attemptAiRecovery(ctx);
    expect(attempt.healed).toBe(false);
    expect(attempt.reason).toMatch(/no recovery-role provider/i);
  });

  it("calls the provider with temperature 0 (spec: 'temp 0')", async () => {
    const complete = vi.fn().mockResolvedValue({ text: JSON.stringify({ action: "waitMs", ms: 300 }) });
    const ctx = baseCtx({ providers: new Map([["local", { id: "local", complete }]]) });
    await attemptAiRecovery(ctx);
    expect(complete.mock.calls[0][1]).toMatchObject({ temperature: 0 });
  });
});

describe("parseAndValidateRung4Candidate", () => {
  it("returns undefined for non-JSON text", () => {
    expect(parseAndValidateRung4Candidate("I cannot help with that")).toBeUndefined();
  });
  it("returns the parsed step for a legal candidate", () => {
    expect(parseAndValidateRung4Candidate('{"action": "back"}')).toMatchObject({ action: "back" });
  });
});
