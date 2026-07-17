import {
  containerChildren,
  describeStep,
  interpolate,
  withContainerChildren,
  type CallSubFlowStep,
  type Flow,
  type FlowStep,
} from "./ir.ts";

/**
 * subflow.ts — parameterized sub-flow expansion (E13, janus-specs/R3-reuse-browser/E13-reuse.md).
 *
 * A `callSubFlow` step is NEVER executed directly — `expandFlow()` resolves every one of them,
 * recursively, into the referenced flow's own steps with its declared `params` substituted, all
 * BEFORE a run or an export ever sees the flow. This is deliberate macro-expansion, not a
 * runtime feature: the runner/bridge needs ZERO changes, because by the time it receives a flow,
 * every `callSubFlow` step is already gone, replaced by ordinary closed-IR steps it already
 * knows how to execute (same principle as E18's client-side trace/tag work — expand once,
 * client-side, and reuse everything downstream unmodified).
 *
 * Param substitution reuses the EXISTING `{{name}}` interpolation syntax (shared/ir.ts's
 * `interpolate()`) — inside a sub-flow's own steps, `{{email}}` is substituted with whatever the
 * CALLER supplied for its `email` param, exactly like a captured-variable reference, and any
 * OTHER `{{...}}` reference (a genuinely runtime-captured var) is left untouched (interpolate()
 * already does this — an unresolved name is left as literal text). A caller's supplied param
 * VALUE may itself be a `{{capturedVar}}` template (spec AC5's "captured-value chip") — since
 * expansion is a pure TEXT substitution, the net result is the sub-flow's steps end up
 * containing that literal `{{capturedVar}}` text, which the runner resolves at actual run time
 * exactly as it always has. No new runtime interpolation logic anywhere.
 */

export interface ExpandError {
  /** Vietnamese, plain-language (non-negotiable #3) — never a raw acronym or stack trace. */
  message: string;
  /** The `callSubFlow` step (in the ORIGINAL, unexpanded flow) this error is about, if any. */
  stepId?: string;
}

export interface ExpandResult {
  flow: Flow;
  /** Empty iff expansion fully succeeded. ANY entry here means "refuse to run" — this is the
   * pre-run lint signal spec AC5 asks for: a missing REQUIRED param, an unknown param, a
   * missing sub-flow file, or a call cycle are all caught HERE, before a run/export ever starts,
   * never as a runtime surprise. */
  errors: ExpandError[];
}

/** Loads a flow by its file name (qa/flows/*.flow.json) — sync (tests, an in-memory map) or
 * async (the real client's `loadFlow()` fetch) are both accepted; `expandFlow` awaits either. */
export type ResolveFlowFile = (file: string) => Flow | undefined | Promise<Flow | undefined>;

/** Shallow-interpolate every string field DIRECTLY on this step (never recursing into `then`/
 * `steps` — the caller's own recursion handles those) against the current param substitution
 * map. A no-op (returns the SAME object, no churn) when there's nothing to substitute. */
function interpolateStepStrings(step: FlowStep, values: Record<string, string>): FlowStep {
  if (Object.keys(values).length === 0) return step;
  const clone = { ...step } as Record<string, unknown>;
  for (const [k, v] of Object.entries(clone)) {
    if (typeof v === "string") clone[k] = interpolate(v, values);
  }
  if (clone.action === "if" && clone.when) {
    const when = clone.when as { text: string; visible?: boolean };
    clone.when = { ...when, text: interpolate(when.text, values) };
  }
  if (clone.action === "callSubFlow" && clone.params) {
    // A NESTED callSubFlow's own param values can themselves forward one of the enclosing
    // sub-flow's params (sub-flow A calling sub-flow B with one of A's own params) — substitute
    // those forwarded values too, same as any other string field.
    const params = clone.params as Record<string, string>;
    const next: Record<string, string> = {};
    for (const [k, v] of Object.entries(params)) next[k] = interpolate(v, values);
    clone.params = next;
  }
  return clone as FlowStep;
}

/** Prefix every step's `id` (recursively, through containers) with the calling step's own id —
 * guarantees globally-unique ids across multiple call sites / multiple expansions of the same
 * sub-flow, so `validateFlow`'s duplicate-id check never fires on an expanded flow as long as
 * the ORIGINAL (unexpanded) flow's own ids were already unique. */
function renameIds(steps: FlowStep[], prefix: string): FlowStep[] {
  return steps.map((s) => {
    const renamed = { ...s, id: `${prefix}::${s.id}` };
    const children = containerChildren(s);
    return children ? withContainerChildren(renamed, renameIds(children, prefix)) : renamed;
  });
}

/**
 * Expand every `callSubFlow` step in `flow`, recursively, using `resolveFlowFile` to load each
 * referenced sub-flow. Never throws — every failure mode (missing file, missing required param,
 * unknown param, a call cycle) is collected into `errors` instead, so a caller can show ALL of
 * them at once rather than stopping at the first one.
 *
 * KNOWN LIMITATION (disclosed, not silently swept under the rug): a sub-flow's own `captureAs`
 * names are NOT namespaced/renamed during expansion — only `id`s are. If a parent flow and a
 * sub-flow it calls happen to declare the SAME captured-variable name, the later one wins at
 * run time (ordinary variable shadowing), same as if the two names had been hand-typed into one
 * flow. This is an authoring-convention concern (pick distinct capture names), not a mechanical
 * data leak — variable VALUES never cross between unrelated sub-flow calls; only the pool of
 * declared NAMES is shared/global across one expanded flow.
 */
export async function expandFlow(flow: Flow, resolveFlowFile: ResolveFlowFile): Promise<ExpandResult> {
  const errors: ExpandError[] = [];
  const visiting = new Set<string>();

  async function resolveOne(step: CallSubFlowStep): Promise<FlowStep[]> {
    if (!step.flowFile) {
      errors.push({ message: `Bước "${describeStep(step)}" chưa chọn luồng con để gọi.`, stepId: step.id });
      return [];
    }
    if (visiting.has(step.flowFile)) {
      errors.push({
        message: `Vòng lặp gọi luồng con: "${step.flowFile}" gọi lại chính nó (trực tiếp hoặc gián tiếp) — không thể chạy.`,
        stepId: step.id,
      });
      return [];
    }
    const subFlow = await resolveFlowFile(step.flowFile);
    if (!subFlow) {
      errors.push({ message: `Không tìm thấy luồng con "${step.flowFile}" (được gọi ở bước "${describeStep(step)}").`, stepId: step.id });
      return [];
    }

    const declared = subFlow.params ?? [];
    const supplied = step.params ?? {};

    for (const name of Object.keys(supplied)) {
      if (!declared.some((p) => p.name === name)) {
        errors.push({
          message: `Luồng con "${step.flowFile}" không có tham số "${name}" (bước "${describeStep(step)}").`,
          stepId: step.id,
        });
      }
    }

    const resolvedValues: Record<string, string> = {};
    for (const p of declared) {
      const raw = supplied[p.name];
      if (raw !== undefined && raw !== "") {
        resolvedValues[p.name] = raw;
      } else if (p.default !== undefined) {
        resolvedValues[p.name] = p.default;
      } else if (p.required) {
        errors.push({
          message: `Thiếu tham số bắt buộc "${p.name}" khi gọi luồng con "${step.flowFile}" (bước "${describeStep(step)}").`,
          stepId: step.id,
        });
      }
      // Optional, no default, not supplied: left unresolved — any {{name}} reference inside the
      // sub-flow simply stays literal text, same as any other never-captured runtime variable.
    }

    visiting.add(step.flowFile);
    const expanded = await expandSteps(subFlow.steps, resolvedValues);
    visiting.delete(step.flowFile);

    return renameIds(expanded, step.id);
  }

  async function expandSteps(steps: FlowStep[], paramValues: Record<string, string>): Promise<FlowStep[]> {
    const out: FlowStep[] = [];
    for (const raw of steps) {
      const step = interpolateStepStrings(raw, paramValues);
      if (step.action === "callSubFlow") {
        out.push(...(await resolveOne(step)));
        continue;
      }
      const children = containerChildren(step);
      out.push(children ? withContainerChildren(step, await expandSteps(children, paramValues)) : step);
    }
    return out;
  }

  const expandedSteps = await expandSteps(flow.steps, {});
  return { flow: { ...flow, steps: expandedSteps }, errors };
}

/** True if `flow` calls at least one sub-flow anywhere (recursing through containers) — a cheap
 * check the UI can use to decide whether expansion is even worth attempting before a run. */
export function hasSubFlowCalls(flow: Flow): boolean {
  function walk(steps: FlowStep[]): boolean {
    for (const step of steps) {
      if (step.action === "callSubFlow") return true;
      const children = containerChildren(step);
      if (children && walk(children)) return true;
    }
    return false;
  }
  return walk(flow.steps);
}
