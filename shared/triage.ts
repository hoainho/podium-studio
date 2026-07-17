/**
 * triage.ts — deterministic, rule-based failure classifier (E22,
 * janus-specs/R4-selfheal-collab/E22-triage-bugexport.md).
 *
 * NO AI dependency (explicit epic boundary — "this is a deterministic, rule-based classifier").
 * Every failed run step gets classified into exactly ONE of 5 fixed classes, each with a FIXED
 * next-action recommendation (AC2 — a lookup table, not a generated string).
 *
 * `classifyFailure` operates on a clean, already-derived `TriageInput` — not a raw `StepResult`
 * or its free-text `error`/`detail` string. This is a deliberate separation: the RULES (this
 * file) are exhaustively testable against 50 seeded fixtures with zero ambiguity about what
 * "attempts", "selector match count", or "value mismatch" mean. TURNING a real StepResult into a
 * TriageInput (src/triage-input.ts) is a SEPARATE, best-effort heuristic layer — real production
 * use would want live re-inspection of the failing screen (à la shared/lint.ts's own
 * ambiguity-check) to populate `selectorMatchCount`/`screenStructureChanged` with confidence;
 * this pass approximates them from the recorded error text, disclosed honestly as heuristic, not
 * hidden behind a false claim of certainty.
 */

export type TriageClass = "realAppBug" | "flake" | "badSelector" | "appChanged" | "wrongExpectedValue";

export const TRIAGE_CLASSES: readonly TriageClass[] = [
  "realAppBug",
  "flake",
  "badSelector",
  "appChanged",
  "wrongExpectedValue",
];

export interface TriageInput {
  /** The failing step's own action (e.g. "tapText", "assertVisible") — determines which rule
   * branches even apply. */
  action: string;
  /** True when a LATER retry attempt of the SAME step, within the same run, eventually passed
   * (bridge/runner.ts's E2 retry mechanism already counts `attempts`) — the strongest, least
   * ambiguous flake signal available: the step is not deterministically broken, it just didn't
   * work the first time. */
  passedOnRetry?: boolean;
  attempts?: number;
  /** How many on-screen elements matched the step's own selector at failure time — 0 (no match
   * at all), 1 (a clean single match, selector resolution was NOT the problem), or >1 (ambiguous
   * — matches shared/lint.ts's own "ambiguous-match" concept). Undefined when the action isn't
   * selector-bearing, or this signal isn't available. */
  selectorMatchCount?: number;
  /** True when the element/selector itself resolved fine (matchCount === 1) but an assertion's
   * CAPTURED value didn't equal what was expected — a value/oracle problem, not a locator
   * problem. Only meaningful on an assertion-bearing action. */
  assertionValueMismatch?: boolean;
  /** True when the screen's overall structure at failure time differs meaningfully from a
   * previously-recorded baseline for this same step (e.g. element count/layout changed) — the
   * signal that distinguishes "the whole screen changed" (app changed) from "just this one
   * locator broke, the rest of the screen is the same" (bad selector). */
  screenStructureChanged?: boolean;
}

export interface TriageResult {
  triageClass: TriageClass;
  nextAction: string;
  /** Plain-language (Vietnamese, non-negotiable #3), tied directly to the specific TriageInput
   * field(s) that decided this classification — never invented after the fact. */
  reason: string;
}

/** Selector-bearing actions — mirrors shared/lint.ts's own (non-exported) SELECTOR_ACTIONS set
 * (same IR-SPEC.md source of truth), duplicated here rather than imported since this epic's
 * scope doesn't touch shared/lint.ts — same precedent shared/library.ts and src/webview-tree.ts
 * already established for this exact set. */
const SELECTOR_ACTIONS = new Set([
  "tapText", "doubleTap", "longPress", "tapIfVisible",
  "assertVisible", "assertNotVisible", "waitFor", "waitForNotVisible",
  "scrollUntilVisible", "copyText",
]);

const ASSERTION_ACTIONS = new Set(["assertVisible", "assertNotVisible"]);

/** AC2's fixed lookup table — one next-action per class, never a generated/free-form string. */
export const NEXT_ACTIONS: Record<TriageClass, string> = {
  realAppBug: "Báo lỗi ứng dụng (file bug)",
  flake: "Chạy lại / cân nhắc cách ly (quarantine)",
  badSelector: "Cập nhật bộ chọn phần tử (locator)",
  appChanged: "Xem lại thay đổi màn hình (screen diff)",
  wrongExpectedValue: "Xem lại giá trị mong đợi (oracle)",
};

export const TRIAGE_CLASS_LABELS: Record<TriageClass, string> = {
  realAppBug: "Lỗi ứng dụng thật",
  flake: "Không ổn định (flake)",
  badSelector: "Bộ chọn phần tử sai",
  appChanged: "Ứng dụng đã thay đổi",
  wrongExpectedValue: "Giá trị mong đợi sai",
};

/**
 * Classify one failed step into exactly one of the 5 fixed classes (AC1). Priority order below
 * matters — it's evaluated top to bottom, first match wins, so a step matching more than one
 * signal (e.g. it both flaked AND had an ambiguous selector on its failing attempts) is still
 * classified unambiguously:
 *   1. Flake — eventually passed on retry. Nothing else matters once we know a later attempt
 *      of the exact same step succeeded; that's definitionally "not deterministically broken."
 *   2. Bad selector / App changed — the selector itself didn't resolve to exactly one element.
 *      `screenStructureChanged` is what tells these two apart: a broader structural shift means
 *      the APP changed, not just this one locator going stale.
 *   3. Wrong expected value — the selector was fine (exactly one match), but an assertion's
 *      captured value didn't match what was expected.
 *   4. Real app bug — the catch-all: not a flake, not a selector problem, not a structural
 *      screen change, not a value mismatch. The safest DEFAULT for a genuine, unexplained
 *      failure is to treat it as a real defect worth filing, never to silently under-classify it
 *      as something more dismissible.
 */
export function classifyFailure(input: TriageInput): TriageResult {
  if (input.passedOnRetry) {
    return {
      triageClass: "flake",
      nextAction: NEXT_ACTIONS.flake,
      reason: `Bước này thất bại nhưng đã qua ở lần thử lại (${input.attempts ?? "?"} lần) — không phải lỗi cố định.`,
    };
  }

  const isSelectorAction = SELECTOR_ACTIONS.has(input.action);
  if (isSelectorAction && input.selectorMatchCount !== undefined && input.selectorMatchCount !== 1) {
    if (input.screenStructureChanged) {
      return {
        triageClass: "appChanged",
        nextAction: NEXT_ACTIONS.appChanged,
        reason: `Bộ chọn khớp ${input.selectorMatchCount} phần tử VÀ cấu trúc màn hình đã thay đổi so với trước — có vẻ ứng dụng đã thay đổi màn hình này.`,
      };
    }
    return {
      triageClass: "badSelector",
      nextAction: NEXT_ACTIONS.badSelector,
      reason:
        input.selectorMatchCount === 0
          ? "Không tìm thấy phần tử nào khớp với bộ chọn — có thể bộ chọn đã lỗi thời."
          : `Bộ chọn khớp ${input.selectorMatchCount} phần tử — cần một bộ chọn cụ thể hơn.`,
    };
  }

  const isAssertionAction = ASSERTION_ACTIONS.has(input.action);
  if (isAssertionAction && input.assertionValueMismatch) {
    return {
      triageClass: "wrongExpectedValue",
      nextAction: NEXT_ACTIONS.wrongExpectedValue,
      reason: "Phần tử được tìm thấy bình thường, nhưng giá trị xác nhận không khớp với giá trị mong đợi.",
    };
  }

  return {
    triageClass: "realAppBug",
    nextAction: NEXT_ACTIONS.realAppBug,
    reason: "Không khớp với bất kỳ nguyên nhân nào ở trên (không phải flake, không phải bộ chọn, không phải thay đổi màn hình, không phải sai giá trị mong đợi) — nhiều khả năng là lỗi ứng dụng thật.",
  };
}
