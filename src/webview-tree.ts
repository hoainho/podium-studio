import type { FlowStep, StepAction } from "../shared/ir.ts";
import type { WebViewInspectorNode } from "./api.ts";

/**
 * Pure helpers for the E17 WebView inspector UI (janus-specs/R3-reuse-browser/E17-webview-
 * inspector.md) — no JSX, no fetch, so every branch here is unit-testable without a live
 * simulator/device or DOM. The component (src/components/WebViewInspector.tsx) is a thin
 * renderer over these.
 */

/** A locator picked from the inspector tree — same vocabulary bridge/webview-driver.ts's
 * `WebViewLocator`/`pickWebViewLocatorAt` already use (targetId/text), so nothing new needs
 * translating on the way into a step's own fields. */
export interface WebViewLocator {
  text?: string;
  targetId?: string;
}

/** Selector-bearing actions whose text/targetId fields a picked WebView element can fill —
 * mirrors shared/library.ts's identically-named private set (duplicated, not imported: this
 * epic's src/ half keeps shared/ untouched this round, same "duplicate the small set rather than
 * reach into another module's scope" precedent shared/library.ts itself already set for
 * shared/lint.ts's own SELECTOR_ACTIONS). */
export const SELECTOR_ACTIONS = new Set<StepAction>([
  "tapText", "doubleTap", "longPress", "tapIfVisible",
  "assertVisible", "assertNotVisible", "waitFor", "waitForNotVisible",
  "scrollUntilVisible", "copyText",
]);

/** Actions whose schema has ONLY a `text` field — no `targetId` at all (the same schema quirk
 * shared/library.ts's TEXT_ONLY_ACTIONS documents: assertVisible/tapIfVisible/etc. have no
 * targetId field whatsoever). Applying a picked locator to one of these must never introduce a
 * `targetId` key. */
const TEXT_ONLY_ACTIONS = new Set<StepAction>([
  "assertVisible", "assertNotVisible", "tapIfVisible", "waitFor", "waitForNotVisible",
  "scrollUntilVisible", "copyText",
]);

/**
 * The locator a click-to-select pick on this node should fill in — `targetId` (data-testid)
 * preferred over `text`, the SAME priority bridge/webview-driver.ts's `pickWebViewLocatorAt` and
 * bridge/browser-driver.ts's `resolveLocator` already use. Returns undefined for a node with
 * neither (e.g. a bare layout `<div>` wrapper) — nothing meaningful to select there.
 */
export function nodeLocator(node: WebViewInspectorNode): WebViewLocator | undefined {
  if (!node.testId && !node.text) return undefined;
  return { targetId: node.testId, text: node.text };
}

/**
 * Apply a picked locator to a step's own selector field(s), respecting the text-only-action
 * schema constraint above (AC1: "fills a step's locator" — never a schema-invalid one). Returns
 * the step UNCHANGED if the action isn't selector-bearing or the locator carries nothing usable
 * for it — the caller (StepEditor) never needs its own branch for that case.
 */
export function applyLocatorToStep(step: FlowStep, locator: WebViewLocator): FlowStep {
  if (!SELECTOR_ACTIONS.has(step.action)) return step;
  if (TEXT_ONLY_ACTIONS.has(step.action)) {
    return locator.text ? ({ ...step, text: locator.text } as FlowStep) : step;
  }
  if (locator.targetId === undefined && locator.text === undefined) return step;
  const patch: Record<string, unknown> = { ...step };
  if (locator.targetId !== undefined) patch.targetId = locator.targetId;
  if (locator.text !== undefined) patch.text = locator.text;
  return patch as FlowStep;
}

/**
 * Case-insensitive match against a node's OWN tag/text/testId (not its descendants) — powers the
 * inspector UI's filter box so a QA can find an element in a large WebView tree without
 * expanding every branch by hand. An empty/whitespace query matches everything.
 */
export function nodeMatchesQuery(node: WebViewInspectorNode, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    node.tag.toLowerCase().includes(q) ||
    (node.text?.toLowerCase().includes(q) ?? false) ||
    (node.testId?.toLowerCase().includes(q) ?? false)
  );
}

/**
 * True when `node` OR any descendant matches — used to decide whether a branch should stay
 * visible/expanded while a search filter is active.
 */
export function subtreeMatchesQuery(node: WebViewInspectorNode, query: string): boolean {
  if (nodeMatchesQuery(node, query)) return true;
  return node.children.some((c) => subtreeMatchesQuery(c, query));
}
