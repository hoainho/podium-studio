import type { Flow, FlowStep } from "./ir.ts";
import { interpolate } from "./ir.ts";

/**
 * Maps Flow IR steps to Maestro commands. Rich actions (double-tap, long-press,
 * scroll, erase text, conditional tap, raw, …) are executed by running a tiny
 * per-step Maestro flow through Podium's run_flow — that's how Studio covers far
 * more than run_steps' 9 primitives while staying deterministic.
 *
 * `secrets` (E12) is an OPTIONAL, separate resolved-value map threaded alongside `fx`
 * everywhere a string field gets interpolated — kept as its own parameter, never merged
 * into `fx`, so a `${secret:...}` value can never accidentally travel through the same
 * object that a caller might persist as `flow.fixtures` (see shared/secrets.ts).
 */

const q = (s: string) => JSON.stringify(s);
const fmtKey = (k: string) => k.replace(/\b\w/g, (c) => c.toUpperCase());

function interp(v: string | undefined, fx: Record<string, unknown>, secrets?: Record<string, string>): string {
  return v === undefined ? "" : interpolate(v, fx, secrets);
}

/** Selector block lines for a tap-like command (doubleTapOn/longPressOn/tapOn). */
function selector(
  cmd: string,
  s: { text?: string; targetId?: string; x?: number; y?: number; index?: number },
  fx: Record<string, unknown>,
  secrets?: Record<string, string>,
  extra: string[] = [],
): string[] {
  const lines: string[] = [];
  if (s.text) {
    lines.push(`- ${cmd}:`, `    text: ${q(interp(s.text, fx, secrets))}`);
    if (s.index !== undefined) lines.push(`    index: ${s.index}`);
  } else if (s.targetId) {
    lines.push(`- ${cmd}:`, `    id: ${q(s.targetId)}`);
  } else if (s.x !== undefined && s.y !== undefined) {
    lines.push(`- ${cmd}:`, `    point: ${q(`${s.x},${s.y}`)} # coordinate — may be brittle`);
  } else {
    lines.push(`- ${cmd}`);
  }
  return [...lines, ...extra.map((e) => `    ${e}`)];
}

/** The Maestro command lines for a single step (no appId header). */
export function stepToMaestroLines(step: FlowStep, fx: Record<string, unknown> = {}, secrets?: Record<string, string>): string[] {
  switch (step.action) {
    case "tap": return [`- tapOn:`, `    point: ${q(`${step.x},${step.y}`)}`];
    case "tapText": return selector("tapOn", step, fx, secrets);
    case "doubleTap": return selector("doubleTapOn", step, fx, secrets);
    case "longPress": return selector("longPressOn", step, fx, secrets);
    case "tapIfVisible": return [`- tapOn:`, `    text: ${q(interp(step.text, fx, secrets))}`, `    optional: true`];
    case "type": {
      const lines = [`- inputText: ${q(interp(step.text, fx, secrets))}`];
      if (step.submit) lines.push(`- pressKey: "Enter"`);
      return lines;
    }
    case "clearText": return [`- eraseText`];
    case "deleteText": return [`- eraseText: ${step.count}`];
    case "hideKeyboard": return [`- hideKeyboard`];
    case "key": return [`- pressKey: ${q(fmtKey(step.key))}`];
    case "swipe": {
      if (step.startX !== undefined && step.startY !== undefined && step.endX !== undefined && step.endY !== undefined) {
        return [`- swipe:`, `    start: ${q(`${step.startX},${step.startY}`)}`, `    end: ${q(`${step.endX},${step.endY}`)}`];
      }
      return [`- swipe:`, `    direction: ${(step.direction ?? "up").toUpperCase()}`];
    }
    case "scroll":
      return step.direction && step.direction !== "down"
        ? [`- swipe:`, `    direction: ${step.direction.toUpperCase()}`]
        : [`- scroll`];
    case "scrollUntilVisible": return [`- scrollUntilVisible:`, `    element:`, `      text: ${q(interp(step.text, fx, secrets))}`];
    case "back": return [`- back`];
    case "waitFor": return [`- extendedWaitUntil:`, `    visible: ${q(interp(step.text, fx, secrets))}`, `    timeout: ${step.timeoutMs ?? 10000}`];
    case "waitForNotVisible": return [`- extendedWaitUntil:`, `    notVisible: ${q(interp(step.text, fx, secrets))}`, `    timeout: ${step.timeoutMs ?? 10000}`];
    case "waitMs": return [`- waitForAnimationToEnd:`, `    timeout: ${step.ms}`];
    // A timed assert compiles to `extendedWaitUntil` (the same wait-then-assert primitive
    // `waitFor`/`waitForNotVisible` use), NOT `assertVisible` + a `timeout:` property — the
    // bundled Maestro rejects the latter with "Unknown Property: timeout", which broke every
    // if/repeat container and the export (E2E dogfood C2). Untimed asserts stay a plain
    // `assertVisible`, whose default (no wait) is the intended "must be visible right now".
    case "assertVisible": return step.timeoutMs !== undefined
      ? [`- extendedWaitUntil:`, `    visible: ${q(interp(step.text, fx, secrets))}`, `    timeout: ${step.timeoutMs}`]
      : [`- assertVisible: ${q(interp(step.text, fx, secrets))}`];
    case "assertNotVisible": return step.timeoutMs !== undefined
      ? [`- extendedWaitUntil:`, `    notVisible: ${q(interp(step.text, fx, secrets))}`, `    timeout: ${step.timeoutMs}`]
      : [`- assertNotVisible: ${q(interp(step.text, fx, secrets))}`];
    case "screenshot": return [`- takeScreenshot: ${q(`shot_${step.id.slice(0, 8)}`)}`];
    case "openLink": return [`- openLink: ${q(interp(step.url, fx, secrets))}`];
    case "launchApp": return step.bundleId
      ? [`- launchApp:`, `    appId: ${q(step.bundleId)}`]
      : [`- launchApp`];
    case "stopApp": return step.bundleId
      ? [`- stopApp:`, `    appId: ${q(step.bundleId)}`]
      : [`- stopApp`];
    case "copyText": return [`- copyTextFrom:`, `    text: ${q(interp(step.text, fx, secrets))}`];
    case "pasteText": return [`- pasteText`];
    case "raw": return interp(step.maestro, fx, secrets).split(/\r?\n/).filter((l) => l.trim().length > 0);
    // ── Control-flow containers (E4) — Maestro natively supports both as nested blocks,
    // so a container compiles to real runFlow/repeat YAML, not a flattened approximation. ──
    case "if": {
      const conditionKey = step.when.visible === false ? "notVisible" : "visible";
      const header = [`- runFlow:`, `    when:`, `      ${conditionKey}: ${q(interp(step.when.text, fx, secrets))}`, `    commands:`];
      const childLines = step.then.flatMap((child) => stepToMaestroLines(child, fx, secrets));
      return [...header, ...childLines.map((l) => `      ${l}`)];
    }
    case "repeat": {
      const header = [`- repeat:`];
      if (step.whileVisible) {
        header.push(`    while:`, `      visible: ${q(interp(step.whileVisible, fx, secrets))}`);
      } else {
        header.push(`    times: ${step.times ?? 1}`);
      }
      header.push(`    commands:`);
      const childLines = step.steps.flatMap((child) => stepToMaestroLines(child, fx, secrets));
      return [...header, ...childLines.map((l) => `      ${l}`)];
    }
    case "callSubFlow":
      // A sub-flow call (E13) is expanded away by shared/subflow.ts's expandFlow() before a run
      // or export ever compiles to Maestro YAML — reaching this line means expansion was
      // skipped, an internal invariant violation, not a normal runtime condition.
      throw new Error(
        `callSubFlow step "${step.id}" (-> ${step.flowFile}) reached shared/maestro.ts unexpanded — ` +
          `call shared/subflow.ts's expandFlow() on the whole flow before compiling/exporting it.`,
      );
  }
}

/** Steps that must NOT be prefixed with an attach-launchApp (they manage the app themselves). */
const SELF_APP = new Set(["launchApp", "stopApp", "openLink"]);

/**
 * `env:` block lines for variables captured on the native side of the hybrid boundary
 * (E2 AC4 / IR-SPEC.md §4) — omitted entirely when there's nothing to inject, so a plain
 * flow's YAML is unchanged from before this field existed.
 */
function envLines(env: Record<string, string> | undefined): string[] {
  const entries = Object.entries(env ?? {});
  if (entries.length === 0) return [];
  return [`env:`, ...entries.map(([k, v]) => `  ${k}: ${q(v)}`)];
}

/** A full, runnable per-step Maestro flow (appId header + optional attach + command). */
export function flowYamlForStep(
  step: FlowStep,
  bundleId: string,
  fx: Record<string, unknown> = {},
  env?: Record<string, string>,
  secrets?: Record<string, string>,
): string {
  const header = [`appId: ${bundleId}`, ...envLines(env), `---`];
  if (!SELF_APP.has(step.action)) {
    header.push(`- launchApp:`, `    stopApp: false`);
  }
  return [...header, ...stepToMaestroLines(step, fx, secrets)].join("\n");
}

/**
 * C7 (E2E dogfood): iOS has no system Back button, and Maestro's `- back` (what
 * `stepToMaestroLines` emits) does NOT reliably pop a SwiftUI `NavigationStack` — a flow's `back`
 * silently left the app on the same screen. The reliable iOS gesture is the interactive-pop
 * edge-swipe: a horizontal drag that STARTS inside the left screen edge. Percent coordinates keep
 * it device-independent (no need to query screen points). Used by the iOS driver
 * (bridge/runner.ts) ONLY — Android keeps its real `- back` keyevent via `stepToMaestroLines`.
 */
export function iosBackYaml(bundleId: string, env?: Record<string, string>): string {
  return [
    `appId: ${bundleId}`,
    ...envLines(env),
    `---`,
    `- launchApp:`,
    `    stopApp: false`,
    `- swipe:`,
    `    start: "2%, 50%"`,
    `    end: "92%, 50%"`,
    `    duration: 400`,
  ].join("\n");
}

/** A full Maestro flow for an entire flow (used by export). */
export function flowToMaestroYaml(
  flow: Flow,
  fx: Record<string, unknown> = {},
  env?: Record<string, string>,
  secrets?: Record<string, string>,
): string {
  const merged = { ...(flow.fixtures ?? {}), ...fx };
  const lines = [`appId: ${flow.app.bundleId}`, ...envLines(env), `---`, `- launchApp`];
  for (const step of flow.steps) {
    if (step.disabled) continue;
    if (step.label) lines.push(`# ${step.label}`);
    lines.push(...stepToMaestroLines(step, merged, secrets));
  }
  return lines.join("\n") + "\n";
}
