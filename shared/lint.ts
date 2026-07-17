import type { Flow, FlowStep, StepAction } from "./ir.ts";
import { containerChildren, validateFlow } from "./ir.ts";

/**
 * Pre-run lint / dry-run (E2 in the roadmap catalog, spec `janus-specs/R1-foundations/E3-lint-dryrun.md`).
 *
 * Static analysis over a Flow's JSON, catching authoring mistakes BEFORE a run wastes device
 * time (Pillar B, non-negotiable #4's authoring-correctness half). Runtime robustness — retry,
 * idempotency, flaky-bucketing, soft-assert — is the other (runtime) half, delivered by E2's
 * `bridge/runner.ts`.
 *
 * Findings are in Vietnamese (non-negotiable #3) and reference the closed action vocabulary in
 * `IR-SPEC.md` (E1) rather than reimplementing its own notion of what a selector or an assertion
 * is — see `SELECTOR_ACTIONS` / `ASSERTION_ACTIONS` below, both sourced from IR-SPEC.md §2/§3.
 */

export type LintErrorClass = "no-match" | "ambiguous-match" | "unreachable" | "no-assertion";

export interface LintFinding {
  class: LintErrorClass;
  /** Absent for flow-level findings (currently only `no-assertion`). */
  stepIndex?: number;
  stepId?: string;
  /** Vietnamese, Unicode-safe (non-negotiable #3) — no raw English testing jargon. */
  message: string;
  /** Present only for `ambiguous-match` (IR-SPEC.md AC2: "reported match count"). */
  matchCount?: number;
}

export interface LintResult {
  ok: boolean; // true iff findings.length === 0 (AC7: a clean flow produces 0 findings)
  findings: LintFinding[];
  durationMs: number;
}

/** The minimal "what's on screen" shape the lint engine needs to check selector matches.
 * A real driver call (Podium `inspect_screen`, per IR-SPEC.md §5's mobile a11y locator field
 * set) supplies this; unit tests supply a synthetic fixture — see test/lint.test.ts. */
export interface ScreenElement {
  text?: string;
  accessibilityId?: string; // maps to IR `targetId` (IR-SPEC.md §5 MobileLocator.accessibilityId)
}

/**
 * Resolves the on-screen elements a given step's selector should be checked against. Returns
 * undefined when unknown (e.g. no device connected to lint against) — in that case the
 * no-match/ambiguous-match checks are SKIPPED for that step rather than guessing, so lint never
 * produces a false positive/negative from missing data (AC7: 0 findings on a clean flow).
 */
export type ScreenResolver = (step: FlowStep, index: number) => ScreenElement[] | undefined;

/** Actions whose primary target is a selector (text/targetId) — sourced from IR-SPEC.md §2. */
const SELECTOR_ACTIONS = new Set<StepAction>([
  "tapText", "doubleTap", "longPress", "tapIfVisible",
  "assertVisible", "assertNotVisible", "waitFor", "waitForNotVisible",
  "scrollUntilVisible", "copyText",
]);

/** Assertion-bearing actions, for the no-assertion rule (IR-SPEC.md §2). */
/** Exported (E19 follow-on use) so bridge/selfheal.ts's heal-type safety check (an assertion
 * failure must NEVER be auto-healed) shares the exact same definition as this module's own
 * no-assertion rule, rather than a second, driftable copy. */
export const ASSERTION_ACTIONS = new Set<StepAction>(["assertVisible", "assertNotVisible"]);

/**
 * Actions that unconditionally end the flow — anything after one is unreachable. `if`/`repeat`
 * (E4) are deliberately NOT in this set: a container's body runs conditionally, so an
 * unconditional exit found only INSIDE it must not mark steps AFTER the container (at the
 * parent level) as unreachable — see the recursive walk below, which tracks `exited` per
 * scope rather than globally.
 */
const UNCONDITIONAL_EXIT_ACTIONS = new Set<StepAction>(["stopApp"]);

/**
 * A container's own condition (`if.when.text` / `repeat.whileVisible`, E4) is a selector
 * too — the author is just as likely to mistype "Popup hiện" as any assertion's text, so
 * it gets the same no-match/ambiguous-match treatment as a leaf step's selector.
 */
function selectorOf(step: FlowStep): { text?: string; targetId?: string } | undefined {
  if (step.action === "if") return { text: step.when.text };
  if (step.action === "repeat") return step.whileVisible ? { text: step.whileVisible } : undefined;
  if (!SELECTOR_ACTIONS.has(step.action)) return undefined;
  const s = step as unknown as { text?: string; targetId?: string };
  if (!s.text && !s.targetId) return undefined;
  return { text: s.text, targetId: s.targetId };
}

function countMatches(sel: { text?: string; targetId?: string }, elements: ScreenElement[]): number {
  if (sel.targetId) return elements.filter((e) => e.accessibilityId === sel.targetId).length;
  if (sel.text) {
    const needle = sel.text.trim().toLowerCase();
    return elements.filter((e) => (e.text ?? "").trim().toLowerCase() === needle).length;
  }
  return 0;
}

const VI = {
  noMatch: (label: string) => `Không tìm thấy phần tử nào khớp với "${label}" trên màn hình.`,
  ambiguous: (label: string, n: number) => `Khớp ${n} phần tử với "${label}" — vui lòng chọn phần tử cụ thể hơn.`,
  unreachable: () =>
    `Bước này sẽ không bao giờ được thực thi vì nằm sau một hành động kết thúc luồng (ví dụ: stopApp).`,
  noAssertion: () =>
    `Luồng kiểm thử này không có bước xác nhận (assert) nào — không thể xác định kết quả kiểm thử.`,
};

/**
 * Run the full lint pass over a flow. `resolveScreen` is optional: without it, the
 * device-dependent checks (no-match / ambiguous-match) are skipped, while the purely
 * structural checks (unreachable / no-assertion) always run — see AC1–AC4.
 */
export function lintFlow(flow: Flow, resolveScreen?: ScreenResolver): LintResult {
  const start = Date.now();
  const findings: LintFinding[] = [];
  let hasAssertion = false; // flow-level — shared across every nesting depth

  /**
   * Walk one scope (the flow's top-level steps, or one container's children) in order.
   * `exited` is local to THIS scope: an unconditional exit inside an `if`/`repeat` body
   * only makes later siblings in that SAME body unreachable — it never marks steps after
   * the container, at the parent level, unreachable (the container's body is conditional,
   * so the parent-level continuation may still run). Recursing after (not instead of)
   * each step's own checks means a container step is itself checked like any other step,
   * then its children get their own nested scope.
   */
  function walkScope(steps: FlowStep[]): void {
    const enabled = steps.filter((s) => !s.disabled);
    let exited = false;

    enabled.forEach((step, i) => {
      if (exited) {
        findings.push({ class: "unreachable", stepIndex: i, stepId: step.id, message: VI.unreachable() });
      }

      if (ASSERTION_ACTIONS.has(step.action)) hasAssertion = true;

      const sel = selectorOf(step);
      if (sel && resolveScreen) {
        const elements = resolveScreen(step, i);
        if (elements) {
          const label = sel.text ?? `#${sel.targetId}`;
          const n = countMatches(sel, elements);
          if (n === 0) {
            findings.push({ class: "no-match", stepIndex: i, stepId: step.id, message: VI.noMatch(label!) });
          } else if (n > 1) {
            findings.push({
              class: "ambiguous-match", stepIndex: i, stepId: step.id,
              matchCount: n, message: VI.ambiguous(label!, n),
            });
          }
        }
      }

      if (UNCONDITIONAL_EXIT_ACTIONS.has(step.action)) exited = true;

      const children = containerChildren(step);
      if (children) walkScope(children);
    });
  }

  walkScope(flow.steps);

  if (!hasAssertion) {
    findings.push({ class: "no-assertion", message: VI.noAssertion() });
  }

  return { ok: findings.length === 0, findings, durationMs: Date.now() - start };
}

export interface DryRunResult {
  ok: boolean;
  errors: string[];
  durationMs: number;
}

/**
 * Validate a flow against the IR (E1) action/field schema with ZERO real device/app side
 * effects (AC5). This module never imports `bridge/podium.ts` or touches a device — schema
 * validation is pure (`validateFlow` is a zod `safeParse`), which is what makes the "zero side
 * effects" guarantee structural rather than merely tested-and-hoped-for.
 */
export function dryRunFlow(input: unknown): DryRunResult {
  const start = Date.now();
  const v = validateFlow(input);
  return { ok: v.ok, errors: v.errors, durationMs: Date.now() - start };
}
