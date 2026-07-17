import { describe, it, expect } from "vitest";
import type { FlowStep } from "../shared/ir.ts";
import type { HealOutcome, InterstitialEntry, Lesson, SelectorMemoryEntry } from "../shared/selfheal-types.ts";
import {
  attemptSelfHeal,
  classifyFailure,
  computeScreenFingerprint,
  findKnownRecovery,
  isAssertionAction,
  matchKnownInterstitial,
  reResolveLocator,
  type SelfHealContext,
} from "../bridge/selfheal.ts";

const s = (over: Partial<FlowStep> & { action: FlowStep["action"] }): FlowStep => ({ id: "s1", ...over } as FlowStep);

describe("isAssertionAction — heal-type safety's first gate (AC5)", () => {
  it("assertVisible/assertNotVisible are assertion actions", () => {
    expect(isAssertionAction("assertVisible")).toBe(true);
    expect(isAssertionAction("assertNotVisible")).toBe(true);
  });
  it("a selector-bearing but non-assertion action (tapText, waitFor) is not", () => {
    expect(isAssertionAction("tapText")).toBe(false);
    expect(isAssertionAction("waitFor")).toBe(false);
  });
});

describe("classifyFailure — Pillar 9 §2's failure taxonomy", () => {
  it("a transient-looking message classifies as transient (reuses runner.ts's isTransientError verbatim)", () => {
    expect(classifyFailure("connection closed unexpectedly")).toBe("transient");
    expect(classifyFailure("socket hang up")).toBe("transient");
  });
  it("classifies ambiguous / unexpected_screen / app_not_foreground / crash by pattern", () => {
    expect(classifyFailure("matched 3 elements — ambiguous")).toBe("ambiguous");
    expect(classifyFailure("khớp 2 phần tử")).toBe("ambiguous");
    expect(classifyFailure("unexpected screen: a popup dialog appeared")).toBe("unexpected_screen");
    expect(classifyFailure("app is not installed on this device")).toBe("app_not_foreground");
    expect(classifyFailure("the app crashed during launch")).toBe("crash");
  });
  it("falls back to element_not_found for an unrecognized or missing message", () => {
    expect(classifyFailure("some other generic failure")).toBe("element_not_found");
    expect(classifyFailure(undefined)).toBe("element_not_found");
  });
});

describe("computeScreenFingerprint — stable, order- and case-independent", () => {
  it("the same labels in a different order fingerprint identically", () => {
    const a = computeScreenFingerprint([{ text: "Home" }, { text: "Login" }]);
    const b = computeScreenFingerprint([{ text: "Login" }, { text: "Home" }]);
    expect(a).toBe(b);
  });
  it("case/whitespace differences don't change the fingerprint", () => {
    const a = computeScreenFingerprint([{ text: "  Home  " }]);
    const b = computeScreenFingerprint([{ text: "home" }]);
    expect(a).toBe(b);
  });
  it("genuinely different screens fingerprint differently", () => {
    const a = computeScreenFingerprint([{ text: "Home" }]);
    const b = computeScreenFingerprint([{ text: "Settings" }]);
    expect(a).not.toBe(b);
  });
});

describe("reResolveLocator — rung 1: only proposes a candidate that ACTUALLY resolves live", () => {
  const memory = (over: Partial<SelectorMemoryEntry>): SelectorMemoryEntry => ({
    id: "m1", screenFingerprint: "fp", elementKey: "Login button", locatorKind: "text", locatorValue: "Log In", timesResolved: 1, ...over,
  });

  it("picks the highest-priority-kind candidate that's live on screen (targetId over text)", () => {
    const candidates = [memory({ id: "a", locatorKind: "text", locatorValue: "Log In", timesResolved: 5 }), memory({ id: "b", locatorKind: "targetId", locatorValue: "btn-login", timesResolved: 1 })];
    const elements = [{ text: "Log In" }, { accessibilityId: "btn-login" }];
    const result = reResolveLocator(elements, candidates);
    expect(result?.kind).toBe("targetId"); // targetId wins priority even with fewer timesResolved
  });

  it("never proposes a text/targetId candidate that isn't actually present on the current screen", () => {
    const candidates = [memory({ locatorKind: "text", locatorValue: "Log In" })];
    const elements = [{ text: "Something else entirely" }];
    expect(reResolveLocator(elements, candidates)).toBeUndefined();
  });

  it("among same-kind candidates, prefers the one resolved more often before", () => {
    const candidates = [memory({ id: "a", locatorValue: "Sign In", timesResolved: 1 }), memory({ id: "b", locatorValue: "Log In", timesResolved: 9 })];
    const elements = [{ text: "Sign In" }, { text: "Log In" }];
    const result = reResolveLocator(elements, candidates);
    expect(result?.value).toBe("Log In");
  });

  it("returns undefined when there are no candidates at all", () => {
    expect(reResolveLocator([{ text: "X" }], [])).toBeUndefined();
  });

  it("confidence is a bounded heuristic, never 1.0 (never absolute certainty)", () => {
    const candidates = [memory({ locatorKind: "targetId", locatorValue: "btn", timesResolved: 999 })];
    const result = reResolveLocator([{ accessibilityId: "btn" }], candidates);
    expect(result!.confidence).toBeLessThan(1);
    expect(result!.confidence).toBeGreaterThan(0);
  });
});

describe("matchKnownInterstitial — rung 2: pure pass-through of an already-looked-up entry", () => {
  it("returns the dismiss action when an entry is given", () => {
    const entry: InterstitialEntry = { id: "i1", fingerprint: "fp", label: "Daily Bonus", dismissAction: { kind: "tapText", text: "Not Now" }, timesSeen: 3 };
    expect(matchKnownInterstitial(entry)).toEqual({ kind: "tapText", text: "Not Now" });
  });
  it("returns undefined when nothing was found", () => {
    expect(matchKnownInterstitial(undefined)).toBeUndefined();
  });
});

describe("findKnownRecovery — rung 3: only ever sees PINNED lessons (AC6 enforced by the caller's fetch, not here)", () => {
  const lesson = (over: Partial<Lesson>): Lesson => ({
    id: "l1", screenFingerprint: "fp", errorClass: "element_not_found", stepIntent: "tap Login",
    healType: "locator", rung: 1, recovery: { kind: "text", value: "Log In" }, topLabels: [], pinned: true, createdAt: 1, ...over,
  });

  it("returns undefined when no pinned lesson has a usable recovery", () => {
    expect(findKnownRecovery([], undefined)).toBeUndefined();
    expect(findKnownRecovery([lesson({ recovery: undefined })], undefined)).toBeUndefined();
  });

  it("prefers the lesson matching the best-known-outcome's rung when stats are available", () => {
    const lessons = [lesson({ id: "a", rung: 1 }), lesson({ id: "b", rung: 2 })];
    const outcome: HealOutcome = { id: "o1", screenFingerprint: "fp", errorClass: "element_not_found", rung: 2, strategy: "dismiss", successCount: 5, failureCount: 0 };
    const result = findKnownRecovery(lessons, outcome);
    expect(result?.lesson.id).toBe("b");
  });

  it("falls back to the first usable pinned lesson when there's no outcome stat", () => {
    const lessons = [lesson({ id: "only-one" })];
    expect(findKnownRecovery(lessons, undefined)?.lesson.id).toBe("only-one");
  });
});

describe("attemptSelfHeal — the ladder (rungs 1-3), heal-type safety (AC5), one function per rung", () => {
  function ctx(over: Partial<SelfHealContext>): SelfHealContext {
    return { step: s({ action: "tapText", text: "Log In" }), errorClass: "element_not_found", elements: [], ...over };
  }

  it("AC5 — an assertion action NEVER heals, regardless of what candidates are available", () => {
    const result = attemptSelfHeal(
      ctx({
        step: s({ action: "assertVisible", text: "Balance" }),
        errorClass: "element_not_found",
        elements: [{ text: "Balance" }],
        selectorCandidates: [{ id: "m", screenFingerprint: "fp", elementKey: "Balance", locatorKind: "text", locatorValue: "Balance", timesResolved: 10 }],
      }),
    );
    expect(result.healed).toBe(false);
    expect(result.proposedPatch).toBeUndefined();
    expect(result.reason).toMatch(/heal-type safety/i);
  });

  it("AC5 control — a locator (non-assertion) failure DOES auto-suggest a patch", () => {
    const result = attemptSelfHeal(
      ctx({
        errorClass: "element_not_found",
        elements: [{ text: "Log In" }],
        selectorCandidates: [{ id: "m", screenFingerprint: "fp", elementKey: "Log In", locatorKind: "text", locatorValue: "Log In", timesResolved: 3 }],
      }),
    );
    expect(result.healed).toBe(true);
    expect(result.rung).toBe(1);
    expect(result.proposedPatch).toBeDefined();
    expect(result.proposedPatch!.healType).toBe("locator");
  });

  it("rung 2 fires for unexpected_screen before rung 1/3 are even consulted", () => {
    const result = attemptSelfHeal(
      ctx({
        errorClass: "unexpected_screen",
        interstitial: { id: "i1", fingerprint: "fp", label: "Cookie banner", dismissAction: { kind: "tapText", text: "Accept" }, timesSeen: 1 },
      }),
    );
    expect(result.healed).toBe(true);
    expect(result.rung).toBe(2);
    expect(result.appliedRecovery).toEqual({ kind: "tapText", text: "Accept" });
  });

  it("falls through to rung 3 when rung 1/2 find nothing applicable", () => {
    const result = attemptSelfHeal(
      ctx({
        errorClass: "element_not_found",
        elements: [], // nothing live -> rung 1 finds no resolvable candidate
        selectorCandidates: [],
        pinnedLessons: [
          { id: "l1", screenFingerprint: "fp", errorClass: "element_not_found", stepIntent: "tap Login", healType: "locator", rung: 1, recovery: { kind: "text", value: "Log In" }, topLabels: [], pinned: true, createdAt: 1 },
        ],
      }),
    );
    expect(result.healed).toBe(true);
    expect(result.rung).toBe(3);
    expect(result.proposedPatch?.lessonId).toBe("l1");
  });

  it("BLOCKER (R4 code-review gate) — rung 3 NEVER applies an assertion-typed pinned lesson, not just hides its patch: healed must be false, and appliedRecovery must be absent", () => {
    const result = attemptSelfHeal(
      ctx({
        errorClass: "element_not_found",
        elements: [], // nothing live -> rung 1 finds no resolvable candidate
        selectorCandidates: [],
        pinnedLessons: [
          {
            id: "l-assert", screenFingerprint: "fp", errorClass: "element_not_found", stepIntent: "assert Balance",
            healType: "assertion", rung: 1, recovery: { kind: "text", value: "Balance (renamed)" },
            topLabels: [], pinned: true, createdAt: 1,
          },
        ],
      }),
    );
    // Previously this returned `healed: true` with `appliedRecovery` set (only `proposedPatch` was
    // suppressed) — meaning the runner would still RE-TARGET the assertion's element even though
    // the UI never saw a patch to review. Heal-type safety (AC5) must hold architecturally, not
    // just at the "what does the approval prompt show" layer.
    expect(result.healed).toBe(false);
    expect(result.appliedRecovery).toBeUndefined();
    expect(result.proposedPatch).toBeUndefined();
    expect(result.reason).toMatch(/assertion/i);
  });

  it("AC6-relevant: an unpinned lesson never reaches this function at all (caller's job) — passing an empty pinnedLessons array behaves exactly like 'nothing available'", () => {
    // attemptSelfHeal has no way to distinguish "no lessons" from "lessons exist but unpinned" —
    // that filtering happens at the PrimaryStore.findLessons({pinnedOnly: true}) call site. This
    // test documents that contract: an empty pinnedLessons list (as the caller would pass when a
    // real candidate exists but is unpinned) falls through to "no recovery available", never a
    // silent heal.
    const result = attemptSelfHeal(ctx({ errorClass: "element_not_found", elements: [], selectorCandidates: [], pinnedLessons: [] }));
    expect(result.healed).toBe(false);
    expect(result.reason).toMatch(/no rung 1-3 recovery/);
  });

  it("returns healed:false with a clear reason when nothing applies at all", () => {
    const result = attemptSelfHeal(ctx({ errorClass: "crash" }));
    expect(result.healed).toBe(false);
    expect(result.reason).toBeTruthy();
  });
});

// Review-gate requirement: this file (rungs 0-3's actual logic) must contain zero AI/model-
// provider references. A literal grep, run here so a regression fails a real test, not just a
// human remembering to check before merge.
describe("review gate — zero AI in the rung 0-3 code path", () => {
  it("bridge/selfheal.ts never references an AI/model provider", async () => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL("../bridge/selfheal.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/AiProvider|openai|anthropic|gemini|ollama|\bllm\b/i);
  });
});
