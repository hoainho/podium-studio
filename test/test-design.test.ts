import { describe, it, expect } from "vitest";
import type { Flow, FlowStep } from "../shared/ir.ts";
import {
  DEFAULT_COMPLETENESS_THRESHOLD,
  evaluateCompleteness,
  flattenInspectTree,
  getCharterAnswer,
  suggestCoverageNudge,
  suggestOracleFromScreen,
  withCharterAnswer,
} from "../src/test-design.ts";

/**
 * E14 (Test-design intelligence). Covers the completeness-meter rule (spec AC1/AC2) and the
 * oracle suggester's candidate logic (coverage nudges + from-screen suggestions, spec AC4) at
 * the code level. AC3 (charter prompt shown before authoring) and AC4's "verified against the
 * actual screen state" live-device round trip are UI/live-device concerns — see the completion
 * report for the code-verified vs. needs-human split.
 */

function makeFlow(steps: FlowStep[]): Flow {
  return {
    schemaVersion: 1,
    name: "Test flow",
    app: { bundleId: "com.example.app", platform: "ios-sim" },
    steps,
  };
}

const tap = (id: string, over: Partial<FlowStep> = {}): FlowStep => ({ id, action: "tap", x: 1, y: 1, ...over } as FlowStep);
const assertVisible = (id: string, text = "ok"): FlowStep => ({ id, action: "assertVisible", text } as FlowStep);

describe("evaluateCompleteness — completeness meter rule (spec AC1/AC2)", () => {
  it("AC1: fires when a flow has actions but zero assertions anywhere, regardless of count", () => {
    const flow = makeFlow([tap("s1"), tap("s2"), tap("s3"), tap("s4"), tap("s5")]);
    const result = evaluateCompleteness(flow);
    expect(result.fires).toBe(true);
    expect(result.reason).toBe("no-assertion-anywhere");
    expect(result.actionCount).toBe(5);
    expect(result.assertionCount).toBe(0);
  });

  it("AC1 holds even below the default threshold — 2 actions, 0 asserts still fires", () => {
    const flow = makeFlow([tap("s1"), tap("s2")]);
    const result = evaluateCompleteness(flow);
    expect(result.fires).toBe(true);
    expect(result.reason).toBe("no-assertion-anywhere");
  });

  it("AC2: does NOT fire when actions-without-a-following-assert count is exactly K (default 3)", () => {
    const flow = makeFlow([tap("s1"), tap("s2"), tap("s3"), assertVisible("s4")]);
    const result = evaluateCompleteness(flow);
    expect(result.fires).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.maxActionsWithoutAssert).toBe(3);
    expect(result.threshold).toBe(DEFAULT_COMPLETENESS_THRESHOLD);
  });

  it("AC2/AC3: fires when the count exceeds K (4 actions then 1 assert, K=3)", () => {
    const flow = makeFlow([tap("s1"), tap("s2"), tap("s3"), tap("s4"), assertVisible("s5")]);
    const result = evaluateCompleteness(flow);
    expect(result.fires).toBe(true);
    expect(result.reason).toBe("exceeds-threshold");
    expect(result.maxActionsWithoutAssert).toBe(4);
  });

  it("threshold K is genuinely configurable, not hard-coded (review-gate requirement)", () => {
    const flow = makeFlow([tap("s1"), tap("s2"), assertVisible("s3")]);
    expect(evaluateCompleteness(flow, 1).fires).toBe(true); // 2 > K=1
    expect(evaluateCompleteness(flow, 2).fires).toBe(false); // 2 <= K=2
    expect(evaluateCompleteness(flow, 5).fires).toBe(false); // 2 <= K=5
  });

  it("resets the run count after each assertion — two short runs under K never combine into one over-K run", () => {
    const flow = makeFlow([
      tap("s1"), tap("s2"), tap("s3"), assertVisible("s4"),
      tap("s5"), tap("s6"), tap("s7"), assertVisible("s8"),
    ]);
    const result = evaluateCompleteness(flow); // two runs of 3, never 6
    expect(result.fires).toBe(false);
    expect(result.maxActionsWithoutAssert).toBe(3);
  });

  it("disabled steps are excluded entirely (they don't run, so they can't need a check)", () => {
    const flow = makeFlow([
      tap("s1"), tap("s2"), tap("s3"), tap("s4", { disabled: true }), tap("s5", { disabled: true }),
      assertVisible("s6"),
    ]);
    const result = evaluateCompleteness(flow);
    expect(result.actionCount).toBe(3); // the 2 disabled taps don't count
    expect(result.fires).toBe(false);
  });

  it("passive actions (screenshot/waitMs/hideKeyboard) don't count as actions needing a check", () => {
    const flow = makeFlow([
      { id: "s1", action: "screenshot" } as FlowStep,
      { id: "s2", action: "waitMs", ms: 500 } as FlowStep,
      { id: "s3", action: "hideKeyboard" } as FlowStep,
    ]);
    const result = evaluateCompleteness(flow);
    expect(result.actionCount).toBe(0);
    expect(result.fires).toBe(false); // no counted actions at all — nothing to warn about
  });

  it("recurses into if/repeat containers (E4) — a check inside a container still counts", () => {
    const flow = makeFlow([
      tap("s1"),
      {
        id: "s2", action: "if", when: { text: "Popup" },
        then: [tap("s2a"), tap("s2b"), assertVisible("s2c")],
      } as FlowStep,
      tap("s3"),
    ]);
    const result = evaluateCompleteness(flow);
    // Run: s1(1), then container's s2a(2) s2b(3), assert resets, then s3(1) after — max stays 3.
    expect(result.assertionCount).toBe(1);
    expect(result.maxActionsWithoutAssert).toBe(3);
    expect(result.fires).toBe(false);
  });

  it("a container's own actions exceeding K still fires even though the container itself isn't counted", () => {
    const flow = makeFlow([
      {
        id: "s1", action: "repeat", times: 2,
        steps: [tap("s1a"), tap("s1b"), tap("s1c"), tap("s1d")],
      } as FlowStep,
      assertVisible("s2"),
    ]);
    const result = evaluateCompleteness(flow);
    expect(result.maxActionsWithoutAssert).toBe(4);
    expect(result.fires).toBe(true);
    expect(result.reason).toBe("exceeds-threshold");
  });
});

describe("charter fixture helpers (spec AC3)", () => {
  it("getCharterAnswer returns undefined when no charter has been recorded", () => {
    const flow = makeFlow([tap("s1")]);
    expect(getCharterAnswer(flow)).toBeUndefined();
  });

  it("getCharterAnswer returns undefined for a blank/whitespace-only answer", () => {
    const flow: Flow = { ...makeFlow([tap("s1")]), fixtures: { charterAnswer: "   " } };
    expect(getCharterAnswer(flow)).toBeUndefined();
  });

  it("withCharterAnswer is pure — returns a NEW flow, never mutates the one passed in", () => {
    const flow = makeFlow([tap("s1")]);
    const before = JSON.stringify(flow);
    const next = withCharterAnswer(flow, "Kiểm tra đăng nhập");
    expect(JSON.stringify(flow)).toBe(before); // original untouched
    expect(getCharterAnswer(next)).toBe("Kiểm tra đăng nhập");
    expect(getCharterAnswer(flow)).toBeUndefined();
  });

  it("withCharterAnswer preserves any other existing fixtures", () => {
    const flow: Flow = { ...makeFlow([tap("s1")]), fixtures: { testAccountRole: "user_low_balance" } };
    const next = withCharterAnswer(flow, "Kiểm tra nhận thưởng");
    expect(next.fixtures?.testAccountRole).toBe("user_low_balance");
    expect(getCharterAnswer(next)).toBe("Kiểm tra nhận thưởng");
  });
});

describe("suggestCoverageNudge — oracle suggester's coverage-nudge logic", () => {
  it("returns undefined when the last counted action already has a following assertion", () => {
    const flow = makeFlow([tap("s1"), assertVisible("s2")]);
    expect(suggestCoverageNudge(flow)).toBeUndefined();
  });

  it("returns the generic nudge KEY for a plain, unmatched action with no following check", () => {
    const flow = makeFlow([tap("s1")]);
    const nudge = suggestCoverageNudge(flow);
    expect(nudge).toBeDefined();
    expect(nudge!.key).toBe("generic"); // copy lives in i18n (testDesign.nudge.generic.*)
  });

  it("returns a pattern-matched nudge KEY when the action's own text hints at a common scenario", () => {
    const flow = makeFlow([{ id: "s1", action: "tapText", text: "Nhận thưởng" } as FlowStep]);
    const nudge = suggestCoverageNudge(flow);
    expect(nudge).toBeDefined();
    expect(nudge!.key).toBe("reward");
  });

  it("matches the English label too (locale-agnostic keyword patterns)", () => {
    const flow = makeFlow([{ id: "s1", action: "tapText", text: "Claim reward" } as FlowStep]);
    expect(suggestCoverageNudge(flow)!.key).toBe("reward");
  });

  it("looks past passive actions to find the real last counted action", () => {
    const flow = makeFlow([tap("s1"), assertVisible("s2"), { id: "s3", action: "screenshot" } as FlowStep]);
    // the assertion is still the most recent "real" event before the trailing screenshot
    expect(suggestCoverageNudge(flow)).toBeUndefined();
  });

  it("returns undefined for a flow with no counted actions at all", () => {
    const flow = makeFlow([{ id: "s1", action: "screenshot" } as FlowStep]);
    expect(suggestCoverageNudge(flow)).toBeUndefined();
  });
});

describe("flattenInspectTree — accessibility-tree flattening for the from-screen suggester", () => {
  it("extracts text/id pairs recursively from a nested tree", () => {
    const tree = {
      children: [
        { text: "Số dư: 1,234", children: [] },
        { label: "Nhận thưởng", children: [{ accessibilityId: "claim_button" }] },
      ],
    };
    const flat = flattenInspectTree(tree);
    expect(flat).toContainEqual({ text: "Số dư: 1,234", accessibilityId: undefined });
    expect(flat).toContainEqual({ text: "Nhận thưởng", accessibilityId: undefined });
    expect(flat).toContainEqual({ text: undefined, accessibilityId: "claim_button" });
  });

  it("returns an empty array for null/non-object input, never throws", () => {
    expect(flattenInspectTree(null)).toEqual([]);
    expect(flattenInspectTree(undefined)).toEqual([]);
    expect(flattenInspectTree("not an object")).toEqual([]);
  });
});

describe("suggestOracleFromScreen — expected-value candidates from an ACTUAL screen snapshot (spec AC4)", () => {
  it("ranks numeric/currency-like text first (spec's own worked example: a captured balance)", () => {
    const suggestions = suggestOracleFromScreen([
      { text: "Chào mừng" },
      { text: "Số dư: 1,234" },
      { text: "Cài đặt" },
    ]);
    expect(suggestions[0].value).toBe("Số dư: 1,234");
    expect(suggestions.map((s) => s.value)).toContain("Chào mừng");
  });

  it("dedupes repeated text across the same snapshot", () => {
    const suggestions = suggestOracleFromScreen([{ text: "Trang chủ" }, { text: "Trang chủ" }]);
    expect(suggestions).toHaveLength(1);
  });

  it("skips elements with no text at all", () => {
    const suggestions = suggestOracleFromScreen([{ accessibilityId: "icon_only" }, { text: "" }]);
    expect(suggestions).toEqual([]);
  });

  it("every suggestion carries a plain-language hint, never a bare value with no explanation", () => {
    const suggestions = suggestOracleFromScreen([{ text: "100" }]);
    expect(suggestions[0].hint.length).toBeGreaterThan(0);
  });
});

describe("AC5 — zero banned English testing acronyms in this feature's own i18n copy", () => {
  // A fixed banned-term list, matched as whole words (case-sensitive — these are real
  // acronyms; Vietnamese text doesn't naturally produce ALL-CAPS 2-3 letter English tokens).
  const BANNED = [/\bAC\b/, /\bTC\b/, /\bSUT\b/, /\bQA\b/];

  function collectStrings(obj: unknown, out: string[] = []): string[] {
    if (typeof obj === "string") {
      out.push(obj);
    } else if (obj && typeof obj === "object") {
      for (const v of Object.values(obj)) collectStrings(v, out);
    }
    return out;
  }

  it("no banned acronym appears anywhere in testDesign.* (vi or en)", async () => {
    const { vi } = await import("../src/i18n/locales/vi.ts");
    const { en } = await import("../src/i18n/locales/en.ts");
    const strings = [...collectStrings((vi as any).testDesign), ...collectStrings((en as any).testDesign)];
    expect(strings.length).toBeGreaterThan(0); // sanity: the section actually exists and isn't empty
    for (const s of strings) {
      for (const pattern of BANNED) {
        expect(s, `banned term ${pattern} found in "${s}"`).not.toMatch(pattern);
      }
    }
  });
});
