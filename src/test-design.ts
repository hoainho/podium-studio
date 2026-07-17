import { containerChildren, type Flow, type FlowStep, type StepAction } from "../shared/ir.ts";

/**
 * test-design.ts — Test-design intelligence (E14, janus-specs/R3-reuse-browser/E14-test-design.md).
 *
 * Pillar C/K: a non-tech Vietnamese QA is not trained in test-design vocabulary — this module
 * re-skins every concept ("did I check anything?", "what's the right value to check?") as a
 * plain Vietnamese question with a worked example, never an English testing acronym. Everything
 * here is deterministic, rule-based string/data manipulation over the Flow object itself (or,
 * for the oracle-from-screen suggester, over an already-fetched accessibility-tree snapshot) —
 * no AI call, matching the epic's own non-negotiable ("Adaptive AI" is a separate, opt-in R5
 * epic, not part of this authoring-time coaching).
 *
 * Kept entirely in src/ (never shared/ or bridge/, per this epic's scope) — it only ever reads a
 * `Flow`/`FlowStep`, never needs the runner/driver/secrets machinery.
 */

// ── Completeness meter (spec AC1/AC2) ───────────────────────────────────────────────────────

/** True assertion actions — mirrors shared/lint.ts's own ASSERTION_ACTIONS (same IR-SPEC.md §2
 * source of truth), duplicated here rather than imported because this epic's scope keeps
 * shared/ untouched and shared/lint.ts doesn't export that set. */
const ASSERTION_ACTIONS = new Set<StepAction>(["assertVisible", "assertNotVisible"]);

/** Passive/evidence actions that don't themselves need a following check — a screenshot is
 * evidence, not a behavior change; a pause or keyboard-dismiss doesn't need verifying. */
const PASSIVE_ACTIONS = new Set<StepAction>(["screenshot", "waitMs", "hideKeyboard"]);

/** Default threshold K (spec AC2) — configurable per call, this is just the shipped default. */
export const DEFAULT_COMPLETENESS_THRESHOLD = 3;

export type CompletenessFireReason = "no-assertion-anywhere" | "exceeds-threshold" | null;

export interface CompletenessResult {
  /** Whether the meter should show its (non-blocking, advisory-only) warning. */
  fires: boolean;
  reason: CompletenessFireReason;
  /** Total counted actions (excludes assertions, passive actions, disabled steps). */
  actionCount: number;
  /** Total assertion steps (assertVisible/assertNotVisible) anywhere in the flow. */
  assertionCount: number;
  /** The longest run of counted actions with no assertion in between (the "K" this rule measures). */
  maxActionsWithoutAssert: number;
  threshold: number;
}

/**
 * Evaluate the completeness-meter rule over an entire flow (recursing into if/repeat containers,
 * E4). Two-part rule, both required by the spec's own acceptance criteria:
 *
 *   1. AC1 — a flow with at least one counted action but ZERO assertions anywhere ALWAYS fires,
 *      regardless of `threshold`. This is a stronger smell than "some long unchecked stretch" —
 *      even a generous K shouldn't suppress "you never checked anything at all".
 *   2. AC2/AC3 — otherwise (at least one assertion exists), the meter fires only when the
 *      longest run of counted actions between assertions exceeds `threshold` (K, default 3).
 *
 * Disabled steps are skipped entirely (they don't run, so they can't need a check) — same
 * convention `bridge/runner.ts` uses for the enabled/disabled split.
 */
export function evaluateCompleteness(flow: Flow, threshold: number = DEFAULT_COMPLETENESS_THRESHOLD): CompletenessResult {
  let actionCount = 0;
  let assertionCount = 0;
  let maxRun = 0;
  let currentRun = 0;

  function walk(steps: FlowStep[]) {
    for (const step of steps) {
      if (step.disabled) continue;
      if (ASSERTION_ACTIONS.has(step.action)) {
        assertionCount += 1;
        currentRun = 0;
      } else if (!PASSIVE_ACTIONS.has(step.action) && step.action !== "if" && step.action !== "repeat") {
        actionCount += 1;
        currentRun += 1;
        if (currentRun > maxRun) maxRun = currentRun;
      }
      // if/repeat containers (E4) aren't themselves counted actions or assertions — only their
      // children are, walked recursively so a check inside a container still resets the run for
      // steps that follow the container at the parent level (a linear, whole-flow narrative).
      const children = containerChildren(step);
      if (children) walk(children);
    }
  }
  walk(flow.steps);

  if (actionCount > 0 && assertionCount === 0) {
    return { fires: true, reason: "no-assertion-anywhere", actionCount, assertionCount, maxActionsWithoutAssert: maxRun, threshold };
  }
  if (maxRun > threshold) {
    return { fires: true, reason: "exceeds-threshold", actionCount, assertionCount, maxActionsWithoutAssert: maxRun, threshold };
  }
  return { fires: false, reason: null, actionCount, assertionCount, maxActionsWithoutAssert: maxRun, threshold };
}

// ── Charter-first framing (spec AC3) ────────────────────────────────────────────────────────

/** Convention key in `flow.fixtures` — chosen over a shared/ir.ts schema change (this epic's
 * scope keeps shared/ untouched) mirroring E11's precedent of using `fixtures` as the place for
 * QA-context metadata that doesn't warrant a schema bump (see bridge/test-data.ts's
 * `testAccountRole` convention). Never a raw credential or anything secret — plain author intent. */
export const CHARTER_FIXTURE_KEY = "charterAnswer";

export function getCharterAnswer(flow: Flow): string | undefined {
  const v = flow.fixtures?.[CHARTER_FIXTURE_KEY];
  return typeof v === "string" && v.trim() ? v : undefined;
}

/** Pure — returns a NEW flow object with the charter answer merged into fixtures, never
 * mutating the one passed in (same discipline as shared/ir.ts's toPodiumSteps/stepToPodium). */
export function withCharterAnswer(flow: Flow, answer: string): Flow {
  return { ...flow, fixtures: { ...flow.fixtures, [CHARTER_FIXTURE_KEY]: answer } };
}

// ── Oracle suggester: coverage nudges (spec AC1 "coverage nudges" + oracle suggester copy) ───

/** Which coverage-nudge to show. The actual question/example copy lives in the i18n locales
 * (`testDesign.nudge.<key>.question` / `.example`) so it follows the user's language — this module
 * stays pure and locale-free, returning only the key. */
export type NudgeKey = "generic" | "reward" | "login" | "spin";

export interface CoverageNudge {
  /** i18n key selector; the UI resolves `testDesign.nudge.<key>.{question,example}`. */
  key: NudgeKey;
}

/** Keyword patterns (matched against a step's own already-authored text, e.g. a tapped button's
 * label) that hint at a common demo-app-style action worth a specific nudge, rather than only
 * ever showing the generic fallback. Matching is on the AUTHOR'S OWN DATA (a string they typed),
 * covering both Vietnamese and English labels so the pattern works regardless of UI language. */
const NUDGE_PATTERNS: Array<{ pattern: RegExp; key: NudgeKey }> = [
  { pattern: /nhận|nhận thưởng|claim|reward|thưởng/i, key: "reward" },
  { pattern: /đăng nhập|login|sign in/i, key: "login" },
  { pattern: /quay|spin|slot/i, key: "spin" },
];

/**
 * Suggest 1 coverage nudge for the LAST counted action in a flow when it isn't yet followed by
 * an assertion — this is what fires right as a QA finishes authoring an action, before they
 * move on, per the spec's "coverage nudges surfaced in the authoring UI". Returns undefined when
 * the flow is empty or its last counted step already has a following assertion (nothing to nudge).
 */
export function suggestCoverageNudge(flow: Flow): CoverageNudge | undefined {
  const flat = flattenSteps(flow.steps);
  // Walk backward from the end: if we hit an assertion before any counted action, everything's
  // already covered — no nudge needed.
  for (let i = flat.length - 1; i >= 0; i--) {
    const step = flat[i];
    if (step.disabled) continue;
    if (ASSERTION_ACTIONS.has(step.action)) return undefined;
    if (PASSIVE_ACTIONS.has(step.action) || step.action === "if" || step.action === "repeat") continue;
    // Found the most recent counted action with no assertion after it — build a nudge for it.
    const text = "text" in step && typeof (step as { text?: unknown }).text === "string" ? (step as { text: string }).text : undefined;
    const matched = text ? NUDGE_PATTERNS.find((p) => p.pattern.test(text)) : undefined;
    return { key: matched ? matched.key : "generic" };
  }
  return undefined;
}

/** Flatten a flow's steps (recursing through if/repeat, E4) into authoring order — the same
 * linear narrative `evaluateCompleteness` walks, exposed separately for the nudge's backward scan. */
function flattenSteps(steps: FlowStep[]): FlowStep[] {
  const out: FlowStep[] = [];
  for (const step of steps) {
    out.push(step);
    const children = containerChildren(step);
    if (children) out.push(...flattenSteps(children));
  }
  return out;
}

// ── Oracle suggester: from actual captured screen state (spec AC4) ─────────────────────────

/** Minimal shape of one on-screen element — deliberately the same field set as
 * shared/lint.ts's `ScreenElement` (text/accessibilityId) so a caller can pass either
 * interchangeably, without this module importing that non-exported type from shared/. */
export interface InspectedElement {
  text?: string;
  accessibilityId?: string;
}

/**
 * Flatten a raw accessibility-tree payload (Podium's `inspect_screen` shape — see
 * bridge/server.ts's `flattenScreenElements`, which this mirrors independently since this
 * epic's scope keeps bridge/ untouched) into a flat list of on-screen text/id pairs.
 */
export function flattenInspectTree(node: unknown, out: InspectedElement[] = []): InspectedElement[] {
  if (!node || typeof node !== "object") return out;
  const n = node as Record<string, unknown>;
  const text = n.text ?? n.label ?? n.accessibilityLabel ?? n.name;
  const accessibilityId = n.id ?? n.accessibilityId ?? n.resourceId;
  if (typeof text === "string" || typeof accessibilityId === "string") {
    out.push({
      text: typeof text === "string" ? text : undefined,
      accessibilityId: typeof accessibilityId === "string" ? accessibilityId : undefined,
    });
  }
  const children = n.children ?? n.elements ?? [];
  if (Array.isArray(children)) for (const c of children) flattenInspectTree(c, out);
  return out;
}

export interface OracleScreenSuggestion {
  value: string;
  /** Plain-Vietnamese reason this text was singled out, shown next to the suggestion so the
   * QA understands WHY it was proposed (spec: "proposes a correct expected value"). */
  hint: string;
}

/** Numbers, currency-like, or percentage-like text is the most common "did the result actually
 * change" signal in a coin/points/balance-driven app (Pillar C's own worked example: "the
 * captured balance text after a claim reward action") — surfaced first, before plain labels. */
const NUMERIC_LIKE = /\d/;

/**
 * Propose expected-value candidates from an ACTUAL captured screen snapshot (spec AC4:
 * "verified against the actual screen state" — never a static guess). Numeric/currency-shaped
 * text is ranked first (most likely to be a balance/score/counter worth locking down); already-
 * seen values across the same snapshot are deduped. Never calls out to an AI provider — purely a
 * deterministic filter/sort over what's really on screen right now.
 */
export function suggestOracleFromScreen(elements: readonly InspectedElement[]): OracleScreenSuggestion[] {
  const seen = new Set<string>();
  const numeric: OracleScreenSuggestion[] = [];
  const other: OracleScreenSuggestion[] = [];
  for (const el of elements) {
    const text = el.text?.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    if (NUMERIC_LIKE.test(text)) {
      numeric.push({ value: text, hint: "Có số trong đó — có thể là số dư, điểm, hoặc số lượng vừa thay đổi." });
    } else {
      other.push({ value: text, hint: "Chữ đang hiển thị trên màn hình hiện tại." });
    }
  }
  return [...numeric, ...other];
}
